import "server-only";
import type { KotStatus } from "@prisma/client";
import type { TenantContext } from "@/lib/auth/context-types";
import { audit } from "@/lib/audit/write";
import { assertTransitionAllowed } from "@/lib/auth/transitions";
import {
  cancelOpenKotsOfOrder,
  createKotWithItems,
  findKitchenTicketById,
  findKotStatus,
  findOrderRoundForKot,
  kotSectionsOfRound,
  listKitchenSections,
  listKitchenTickets,
  nextKotNumber,
  setKotStatus,
  type KitchenSectionOption,
  type KitchenTicket,
  type KitchenTicketFilters,
  type OrderRoundForKot,
} from "@/lib/data/kot";
import { required } from "@/lib/data/scope";
import { withTx, type Tx } from "@/lib/data/tx";
import { ConflictError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { syncOrderWithKitchen } from "@/lib/services/order-derivation";
import { enqueueKotPrintJobs } from "@/lib/services/printing";
import { businessDateFor } from "@/lib/time/business-date";

/**
 * KOT engine (S1-P14). The tenant always comes from `ctx` and every read/write goes through `lib/data/kot.ts`.
 * Payloads use the kitchen projection (SC-RBAC-07). Tickets are generated inside the order's acceptance transaction
 * (security.md §3.4) — one per kitchen section per round — and cancelled with the order.
 */
export type { KitchenSectionOption, KitchenTicket, KitchenTicketFilters };

/** LD-KOT-01: the context tenant's tickets (active queue unless a status is given). */
export async function getTenantKOTTickets(ctx: TenantContext, filters: KitchenTicketFilters = {}): Promise<KitchenTicket[]> {
  return listKitchenTickets(ctx, filters);
}

/** The context tenant's active kitchen sections. */
export async function getTenantKitchenSections(ctx: TenantContext): Promise<KitchenSectionOption[]> {
  return listKitchenSections(ctx);
}

type OrderLine = OrderRoundForKot["items"][number];

/**
 * S1-P14-T001: creates the tickets of one round of an order inside the caller's transaction — one per kitchen section
 * of the round's lines (lines without a section share one ticket), each with its K-NNN number from the counter and
 * immutable item snapshots. Idempotent per (order, section, round) (U-KOT-2): sections that already have a ticket are
 * skipped, so a retried acceptance creates nothing. Audits `kot.generated` per ticket. Returns the new ticket ids.
 *
 * `print: false` is "Send to KOT only" (RASOIOS-ADR-027): the tickets are created and reach the kitchen screen exactly
 * as usual, but no print job is queued for them now or by any later retry — there is no job to retry.
 */
export async function generateKotsForRound(tx: Tx, ctx: TenantContext, orderId: string, round = 1, options: { print?: boolean } = {}): Promise<string[]> {
  const print = options.print ?? true;
  const order = required(await findOrderRoundForKot(tx, ctx, orderId, round), "Order");
  const existing = await kotSectionsOfRound(tx, ctx, orderId, round);

  const groups = new Map<string | null, OrderLine[]>();
  for (const line of order.items) {
    if (existing.has(line.kitchenSectionId)) continue;
    groups.set(line.kitchenSectionId, [...(groups.get(line.kitchenSectionId) ?? []), line]);
  }

  const businessDate = businessDateFor(new Date(), ctx.restaurant.timezone);
  const created: string[] = [];
  for (const [kitchenSectionId, lines] of groups) {
    const kotNumber = await nextKotNumber(tx, ctx, businessDate);
    const { id } = await createKotWithItems(tx, ctx, {
      orderId: order.id,
      kitchenSectionId,
      roundNumber: round,
      businessDate,
      kotNumber,
      priority: order.priority,
      orderTypeSnapshot: order.orderType,
      tableLabelSnapshot: order.tableLabel,
      notesSnapshot: order.notes,
      items: lines.map((line) => ({
        orderItemId: line.id,
        quantity: line.quantity,
        itemLabelSnapshot: line.variantNameSnapshot ? `${line.itemNameSnapshot} (${line.variantNameSnapshot})` : line.itemNameSnapshot,
        addonsSnapshot: line.addons.length ? line.addons.map((a) => a.nameSnapshot).join(", ").slice(0, 280) : null,
        instructionsSnapshot: line.specialInstructions,
      })),
      printRequested: print,
    });
    await audit(tx, ctx, {
      action: "kot.generated",
      resourceType: "kot_ticket",
      resourceId: id,
      after: { orderId: order.id, kitchenSectionId, kotNumber, roundNumber: round, status: "QUEUED", itemCount: lines.length, printRequested: print },
    });
    created.push(id);
  }
  if (created.length > 0) {
    logger.info("kot.generated", { requestId: ctx.requestId, tenantId: ctx.tenantId, orderId, round, count: created.length, printRequested: print });
    // S1-P16-T003: KOT print jobs are queued in this same transaction, so a ticket and its job commit together
    // (ADR-007 §6). Honours RESTAURANT.auto_print_kot and creates nothing when no printer serves the section.
    if (print) await enqueueKotPrintJobs(tx, ctx, created);
  }
  return created;
}

/**
 * S1-P14-T003: cancels the order's open tickets inside the order-cancellation transaction and audits each
 * (`kot.status_changed` → CANCELLED). SERVED tickets are never altered. Returns how many changed.
 */
export async function cancelKotsWithOrder(tx: Tx, ctx: TenantContext, orderId: string): Promise<number> {
  const cancelled = await cancelOpenKotsOfOrder(tx, ctx, orderId);
  for (const kot of cancelled) {
    await audit(tx, ctx, {
      action: "kot.status_changed",
      resourceType: "kot_ticket",
      resourceId: kot.id,
      before: { status: kot.status },
      after: { status: "CANCELLED", trigger: "order_cancelled", orderId },
    });
  }
  return cancelled.length;
}

/**
 * SA-KOT-01 (S1-P14-T002): moves a ticket one step along the shared transition table (security.md §3.4), stamps the
 * step, audits `kot.status_changed`, and derives the order's status (first ticket started → PREPARING; every ticket of
 * the latest round READY/SERVED → READY) — all in one transaction. Missing and other-tenant tickets are NOT_FOUND; a
 * repeated target is a no-op (api.md SA-KOT-01 idempotency). The caller has checked the target's permission.
 */
export async function updateKOTStatus(ctx: TenantContext, kotId: string, toStatus: KotStatus): Promise<KitchenTicket> {
  const result = await withTx(ctx, async (tx) => {
    const current = required(await findKotStatus(tx, ctx, kotId), "KOT");
    if (current.status === toStatus) return { changed: false as const };
    assertTransitionAllowed(ctx, "kot", current.status, toStatus);

    if (!(await setKotStatus(tx, ctx, kotId, current.status, toStatus))) {
      // Changed concurrently between the read and the compare-and-set.
      const latest = required(await findKotStatus(tx, ctx, kotId), "KOT");
      if (latest.status === toStatus) return { changed: false as const };
      assertTransitionAllowed(ctx, "kot", latest.status, toStatus);
      throw new ConflictError("The ticket was changed by someone else. Refresh and try again.", "STALE_VERSION");
    }

    await audit(tx, ctx, {
      action: "kot.status_changed",
      resourceType: "kot_ticket",
      resourceId: kotId,
      before: { status: current.status },
      after: { status: toStatus },
    });
    const derived = await syncOrderWithKitchen(tx, ctx, current.orderId, { kotId, kotStatus: toStatus });
    return { changed: true as const, from: current.status, derived };
  });

  if (result.changed) {
    logger.info("kot.status_changed", { requestId: ctx.requestId, tenantId: ctx.tenantId, kotId, from: result.from, to: toStatus, orderStatus: result.derived.at(-1) ?? null });
  }
  return required(await findKitchenTicketById(ctx, kotId), "KOT");
}
