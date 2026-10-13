import "server-only";
import { KotStatus, OrderStatus } from "@prisma/client";
import type { SystemContext } from "@/lib/auth/context-types";
import { audit } from "@/lib/audit/write";
import { db } from "@/lib/db/prisma";
import { withTx } from "./tx";

/**
 * Simplified order workflow timer (owner brief 2026-10-13). An order of a restaurant that has switched the workflow on
 * becomes READY once it has been accepted for the configured time — no kitchen taps needed.
 *
 * There is no signed-in user here, so there is no `TenantContext`: the tenant of every write is the order row's own
 * `tenant_id`, read from the database (never from input, ADR-003), and every statement is scoped by it. Changes are
 * audited with actor SYSTEM.
 *
 * Safety, in the order the checks run:
 *   - only restaurants with `simplified_workflow = true` of ACTIVE tenants, re-checked under the row lock, so switching
 *     the workflow off stops an order that was already picked up but not yet changed;
 *   - only ACCEPTED or PREPARING orders (never READY, COMPLETED, CANCELLED or REFUNDED — nothing moves backwards and
 *     nothing is paid or completed here) whose `accepted_at` is at or before the cut-off;
 *   - `FOR UPDATE SKIP LOCKED` plus a version compare-and-set, so two workers (two app replicas, or a sweep racing a
 *     chef's tap) can never advance the same order twice: the second sees it locked or already READY and skips it.
 */
export const AUTO_READY_STATUSES = [OrderStatus.ACCEPTED, OrderStatus.PREPARING] as const;

/** The audit/log trigger for every change this module makes. */
export const AUTO_READY_TRIGGER = "simplified_workflow_timer";

export type DueOrder = { tenantId: string; orderId: string };

/** Orders due for READY, oldest acceptance first. Discovery only: `autoReadyOrder` re-checks everything under a lock. */
export async function findOrdersDueForAutoReady(cutoff: Date, limit: number): Promise<DueOrder[]> {
  return db.$queryRaw<DueOrder[]>`
    SELECT o.tenant_id::text AS "tenantId", o.id::text AS "orderId"
    FROM orders o
    JOIN restaurants r ON r.tenant_id = o.tenant_id
    JOIN tenants t ON t.id = o.tenant_id
    WHERE r.simplified_workflow = true
      AND t.status = 'ACTIVE'::tenant_status
      AND o.status IN ('ACCEPTED'::order_status, 'PREPARING'::order_status)
      AND o.accepted_at IS NOT NULL
      AND o.accepted_at <= ${cutoff}
    ORDER BY o.accepted_at ASC
    LIMIT ${limit}`;
}

export type AutoReadyOutcome = { advanced: true; orderNumber: string; from: OrderStatus; ticketsReadied: number } | { advanced: false };

/**
 * Advances one order to READY in one transaction: the latest round's open kitchen tickets become READY (so the kitchen
 * board agrees with the order), then the order itself, each audited. Returns `{ advanced: false }` when the order is no
 * longer eligible or another worker holds it.
 */
export async function autoReadyOrder(ctx: SystemContext, due: DueOrder, cutoff: Date, at: Date): Promise<AutoReadyOutcome> {
  const { tenantId, orderId } = due;
  return withTx(ctx, async (tx) => {
    const locked = await tx.$queryRaw<Array<{ status: OrderStatus; version: number; orderNumber: string }>>`
      SELECT o.status AS "status", o.version AS "version", o.order_number AS "orderNumber"
      FROM orders o
      JOIN restaurants r ON r.tenant_id = o.tenant_id
      JOIN tenants t ON t.id = o.tenant_id
      WHERE o.tenant_id = ${tenantId}::uuid
        AND o.id = ${orderId}::uuid
        AND r.simplified_workflow = true
        AND t.status = 'ACTIVE'::tenant_status
        AND o.status IN ('ACCEPTED'::order_status, 'PREPARING'::order_status)
        AND o.accepted_at IS NOT NULL
        AND o.accepted_at <= ${cutoff}
      FOR UPDATE OF o SKIP LOCKED`;
    const order = locked[0];
    if (!order) return { advanced: false };

    // The latest round's tickets that are still open; earlier rounds were already finished when the round was added.
    const latest = await tx.kotTicket.aggregate({ where: { tenantId, orderId }, _max: { roundNumber: true } });
    const open =
      latest._max.roundNumber === null
        ? []
        : await tx.kotTicket.findMany({
            where: { tenantId, orderId, roundNumber: latest._max.roundNumber, status: { in: [KotStatus.QUEUED, KotStatus.PREPARING] } },
            select: { id: true, status: true, preparingAt: true, kotNumber: true },
          });

    for (const ticket of open) {
      const { count } = await tx.kotTicket.updateMany({
        where: { tenantId, id: ticket.id, status: ticket.status },
        data: { status: KotStatus.READY, readyAt: at, preparingAt: ticket.preparingAt ?? at },
      });
      if (count !== 1) continue; // A chef moved it in the same instant; their change stands.
      await audit(tx, ctx, {
        tenantId,
        action: "kot.status_changed",
        resourceType: "kot_ticket",
        resourceId: ticket.id,
        before: { status: ticket.status },
        after: { status: KotStatus.READY, trigger: AUTO_READY_TRIGGER, orderId, kotNumber: ticket.kotNumber },
      });
    }

    const { count } = await tx.order.updateMany({
      where: { tenantId, id: orderId, status: order.status, version: order.version },
      data: { status: OrderStatus.READY, readyAt: at, version: { increment: 1 } },
    });
    // Unreachable while the row lock is held; if it ever happens, roll the ticket changes back with it.
    if (count !== 1) throw new Error("auto-ready: order changed under its row lock");

    await audit(tx, ctx, {
      tenantId,
      action: "order.status_changed",
      resourceType: "order",
      resourceId: orderId,
      before: { status: order.status, version: order.version },
      after: { status: OrderStatus.READY, version: order.version + 1, trigger: AUTO_READY_TRIGGER, ticketsReadied: open.length },
    });
    return { advanced: true, orderNumber: order.orderNumber, from: order.status, ticketsReadied: open.length };
  });
}
