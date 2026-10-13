import "server-only";
import type { KotStatus, OrderPriority, OrderStatus, OrderType, Prisma } from "@prisma/client";
import type { TenantContext } from "@/lib/auth/context-types";
import { db } from "@/lib/db/prisma";
import { instantDto, nullableInstantDto } from "./dto";
import { formatKotNumber, nextNumber } from "./counters";
import { mapErrors } from "./errors";
import { tenantKey } from "./scope";
import type { Tx } from "./tx";

/**
 * Kitchen / KOT data access (S1-P14). Every query is scoped to `ctx.tenantId`.
 *
 * Kitchen projection (security.md §3.3 row 23, SC-RBAC-07, TC-RBAC-011): tickets carry only what a kitchen card needs —
 * no customer name/phone/email, no amounts, no payments. Items are reached through the ticket's composite
 * (tenant_id, kot_ticket_id) foreign key, so they are always the ticket's own tenant.
 */
const kitchenTicketSelect = {
  id: true,
  kotNumber: true,
  roundNumber: true,
  status: true,
  priority: true,
  orderTypeSnapshot: true,
  tableLabelSnapshot: true,
  notesSnapshot: true,
  queuedAt: true,
  preparingAt: true,
  readyAt: true,
  servedAt: true,
  kitchenSection: { select: { id: true, name: true, code: true } },
  order: { select: { orderNumber: true } },
  items: {
    select: { id: true, quantity: true, itemLabelSnapshot: true, addonsSnapshot: true, instructionsSnapshot: true },
    orderBy: { createdAt: "asc" },
  },
} satisfies Prisma.KotTicketSelect;

type KitchenTicketRow = Prisma.KotTicketGetPayload<{ select: typeof kitchenTicketSelect }>;

export type KitchenSectionOption = { id: string; name: string; code: string };

export type KitchenTicketItem = {
  id: string;
  quantity: number;
  itemLabelSnapshot: string;
  addonsSnapshot: string | null;
  instructionsSnapshot: string | null;
};

export type KitchenTicket = {
  id: string;
  kotNumber: string;
  roundNumber: number;
  status: KotStatus;
  priority: OrderPriority;
  orderNumber: string;
  orderTypeSnapshot: OrderType;
  tableLabelSnapshot: string | null;
  notesSnapshot: string | null;
  queuedAt: string;
  preparingAt: string | null;
  readyAt: string | null;
  servedAt: string | null;
  kitchenSection: KitchenSectionOption | null;
  items: KitchenTicketItem[];
};

function toKitchenTicket(row: KitchenTicketRow): KitchenTicket {
  return {
    id: row.id,
    kotNumber: row.kotNumber,
    roundNumber: row.roundNumber,
    status: row.status,
    priority: row.priority,
    orderNumber: row.order.orderNumber,
    orderTypeSnapshot: row.orderTypeSnapshot,
    tableLabelSnapshot: row.tableLabelSnapshot,
    notesSnapshot: row.notesSnapshot,
    queuedAt: instantDto(row.queuedAt),
    preparingAt: nullableInstantDto(row.preparingAt),
    readyAt: nullableInstantDto(row.readyAt),
    servedAt: nullableInstantDto(row.servedAt),
    kitchenSection: row.kitchenSection,
    items: row.items.map((item) => ({
      id: item.id,
      quantity: item.quantity,
      itemLabelSnapshot: item.itemLabelSnapshot,
      addonsSnapshot: item.addonsSnapshot,
      instructionsSnapshot: item.instructionsSnapshot,
    })),
  };
}

/** The kitchen's working queue when no status filter is given. */
export const ACTIVE_KOT_STATUSES: readonly KotStatus[] = ["QUEUED", "PREPARING", "READY"];

export type KitchenTicketFilters = { status?: KotStatus; kitchenSectionId?: string; limit?: number };

/** LD-KOT-01 tickets, oldest first. A section id of another tenant simply matches nothing (TI-037). */
export async function listKitchenTickets(ctx: TenantContext, filters: KitchenTicketFilters = {}): Promise<KitchenTicket[]> {
  const rows = await mapErrors("KOT", () =>
    db.kotTicket.findMany({
      where: {
        tenantId: ctx.tenantId,
        status: filters.status ?? { in: [...ACTIVE_KOT_STATUSES] },
        ...(filters.kitchenSectionId ? { kitchenSectionId: filters.kitchenSectionId } : {}),
      },
      select: kitchenTicketSelect,
      orderBy: { queuedAt: "asc" },
      take: filters.limit ?? 50,
    }),
  );
  return rows.map(toKitchenTicket);
}

/** Active kitchen sections for the board's station selector. */
export async function listKitchenSections(ctx: TenantContext): Promise<KitchenSectionOption[]> {
  return mapErrors("Kitchen section", () =>
    db.kitchenSection.findMany({
      where: { tenantId: ctx.tenantId, archivedAt: null },
      select: { id: true, name: true, code: true },
      orderBy: { sortOrder: "asc" },
    }),
  );
}

/** One ticket in the kitchen projection, or null when missing or another tenant's. */
export async function findKitchenTicket(client: Tx, ctx: TenantContext, kotId: string): Promise<KitchenTicket | null> {
  const row = await client.kotTicket.findUnique({ where: tenantKey(ctx, kotId), select: kitchenTicketSelect });
  return row ? toKitchenTicket(row) : null;
}

/** Outside a transaction (e.g. after losing a creation race). */
export async function findKitchenTicketById(ctx: TenantContext, kotId: string): Promise<KitchenTicket | null> {
  return mapErrors("KOT", () => findKitchenTicket(db, ctx, kotId));
}

// ─── Status transitions (SA-KOT-01) ───

export async function findKotStatus(tx: Tx, ctx: TenantContext, kotId: string): Promise<{ id: string; orderId: string; kotNumber: string; status: KotStatus } | null> {
  return tx.kotTicket.findUnique({ where: tenantKey(ctx, kotId), select: { id: true, orderId: true, kotNumber: true, status: true } });
}

/** Statuses of the order's latest KOT round (for order status derivation, BR-ORD-04). Cancelled tickets excluded. */
export async function latestRoundKotStatuses(tx: Tx, ctx: TenantContext, orderId: string): Promise<KotStatus[]> {
  const latest = await tx.kotTicket.aggregate({ where: { tenantId: ctx.tenantId, orderId }, _max: { roundNumber: true } });
  if (latest._max.roundNumber === null) return [];
  const rows = await tx.kotTicket.findMany({
    where: { tenantId: ctx.tenantId, orderId, roundNumber: latest._max.roundNumber, status: { not: "CANCELLED" } },
    select: { status: true },
  });
  return rows.map((r) => r.status);
}

/**
 * Cancels the order's open tickets (QUEUED/PREPARING/READY) with a timestamp; SERVED tickets are never altered
 * (S1-P14-T003). Returns the tickets that changed, for auditing.
 */
export async function cancelOpenKotsOfOrder(tx: Tx, ctx: TenantContext, orderId: string): Promise<Array<{ id: string; kotNumber: string; status: KotStatus }>> {
  const open = await tx.kotTicket.findMany({
    where: { tenantId: ctx.tenantId, orderId, status: { in: [...ACTIVE_KOT_STATUSES] } },
    select: { id: true, kotNumber: true, status: true },
    orderBy: { queuedAt: "asc" },
  });
  if (open.length === 0) return [];
  await tx.kotTicket.updateMany({
    where: { tenantId: ctx.tenantId, id: { in: open.map((k) => k.id) }, status: { in: [...ACTIVE_KOT_STATUSES] } },
    data: { status: "CANCELLED", cancelledAt: new Date() },
  });
  return open;
}

/**
 * Compare-and-set: moves the ticket from `from` to `to` and stamps the transition instant. Returns false when the row
 * is no longer in `from` (a concurrent change) or is not the caller's tenant's.
 */
export async function setKotStatus(tx: Tx, ctx: TenantContext, kotId: string, from: KotStatus, to: KotStatus): Promise<boolean> {
  const now = new Date();
  const { count } = await tx.kotTicket.updateMany({
    where: { id: kotId, tenantId: ctx.tenantId, status: from },
    data: {
      status: to,
      preparingAt: to === "PREPARING" ? now : undefined,
      readyAt: to === "READY" ? now : undefined,
      servedAt: to === "SERVED" ? now : undefined,
    },
  });
  return count === 1;
}

// ─── Generation (S1-P14-T001) ───

export type OrderRoundForKot = {
  id: string;
  status: OrderStatus;
  orderType: OrderType;
  priority: OrderPriority;
  tableLabel: string | null;
  notes: string | null;
  items: Array<{
    id: string;
    kitchenSectionId: string | null;
    quantity: number;
    itemNameSnapshot: string;
    variantNameSnapshot: string | null;
    specialInstructions: string | null;
    addons: Array<{ nameSnapshot: string }>;
  }>;
};

/** The order fields and the lines of one KOT round that tickets snapshot — never customer or money fields. */
export async function findOrderRoundForKot(tx: Tx, ctx: TenantContext, orderId: string, round: number): Promise<OrderRoundForKot | null> {
  return tx.order.findFirst({
    where: { id: orderId, tenantId: ctx.tenantId },
    select: {
      id: true,
      status: true,
      orderType: true,
      priority: true,
      tableLabel: true,
      notes: true,
      items: {
        where: { kotRound: round },
        select: {
          id: true,
          kitchenSectionId: true,
          quantity: true,
          itemNameSnapshot: true,
          variantNameSnapshot: true,
          specialInstructions: true,
          addons: { select: { nameSnapshot: true }, orderBy: { createdAt: "asc" } },
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });
}

/** Sections (NULL = unsectioned) that already have a ticket for this order and round (U-KOT-2). */
export async function kotSectionsOfRound(tx: Tx, ctx: TenantContext, orderId: string, round: number): Promise<Set<string | null>> {
  const rows = await tx.kotTicket.findMany({ where: { tenantId: ctx.tenantId, orderId, roundNumber: round }, select: { kitchenSectionId: true } });
  return new Set(rows.map((r) => r.kitchenSectionId));
}

/** `K-NNN` from the tenant's KOT counter for the business date (S1-P12-T003, ADR-010 §6); race-free. */
export async function nextKotNumber(tx: Tx, ctx: TenantContext, businessDate: Date): Promise<string> {
  return formatKotNumber(await nextNumber(tx, ctx, "KOT", businessDate));
}

export type NewKot = {
  orderId: string;
  kitchenSectionId: string | null;
  roundNumber: number;
  businessDate: Date;
  kotNumber: string;
  priority: OrderPriority;
  orderTypeSnapshot: OrderType;
  tableLabelSnapshot: string | null;
  notesSnapshot: string | null;
  items: Array<{ orderItemId: string; quantity: number; itemLabelSnapshot: string; addonsSnapshot: string | null; instructionsSnapshot: string | null }>;
  /** False for "Send to KOT only": the ticket is not printed (default true, the existing behaviour). */
  printRequested?: boolean;
};

/** Creates a QUEUED ticket and its immutable items in the caller's tenant. */
export async function createKotWithItems(tx: Tx, ctx: TenantContext, kot: NewKot): Promise<{ id: string }> {
  const created = await tx.kotTicket.create({
    data: {
      tenantId: ctx.tenantId,
      orderId: kot.orderId,
      kitchenSectionId: kot.kitchenSectionId,
      businessDate: kot.businessDate,
      kotNumber: kot.kotNumber,
      roundNumber: kot.roundNumber,
      status: "QUEUED",
      priority: kot.priority,
      orderTypeSnapshot: kot.orderTypeSnapshot,
      tableLabelSnapshot: kot.tableLabelSnapshot,
      notesSnapshot: kot.notesSnapshot,
      printRequested: kot.printRequested ?? true,
    },
    select: { id: true },
  });
  if (kot.items.length > 0) {
    await tx.kotItem.createMany({
      data: kot.items.map((item) => ({ tenantId: ctx.tenantId, kotTicketId: created.id, ...item })),
    });
  }
  return created;
}

// ─── Print state (S1-P14-T004) ───

/**
 * What the board shows about a ticket's KOT print: no job yet, queued, being printed, printed, failed — or
 * NOT_REQUESTED when staff chose "Send to KOT only" and no job was ever wanted (RASOIOS-ADR-027).
 */
export type KotPrintStatus = "NONE" | "NOT_REQUESTED" | "PENDING" | "PROCESSING" | "PRINTED" | "FAILED";

/**
 * The print state of many tickets in one query (LD-KOT-01, RH-KOT-01): for each ticket, the newest KOT job that is not
 * a reprint. A lateral join keeps it to one index scan per ticket, so a board of 50 tickets costs one round trip.
 * A ticket sent without printing and never reprinted reads NOT_REQUESTED; other tickets without a job are absent from
 * the map and read as NONE.
 */
export async function printStatusFor(ctx: TenantContext, kotIds: readonly string[]): Promise<Map<string, KotPrintStatus>> {
  if (kotIds.length === 0) return new Map();
  const rows = await mapErrors("Print job", () =>
    db.$queryRaw<Array<{ kot_ticket_id: string; status: KotPrintStatus }>>`
      SELECT k.id AS kot_ticket_id,
             COALESCE(j.status::text, CASE WHEN k.print_requested THEN NULL ELSE 'NOT_REQUESTED' END) AS status
      FROM kot_tickets k
      LEFT JOIN LATERAL (
        SELECT p.status
        FROM print_jobs p
        WHERE p.tenant_id = ${ctx.tenantId}::uuid
          AND p.kot_ticket_id = k.id
          AND p.job_type = 'KOT'
          AND p.is_reprint = false
        ORDER BY p.created_at DESC
        LIMIT 1
      ) j ON true
      WHERE k.tenant_id = ${ctx.tenantId}::uuid
        AND k.id = ANY(${kotIds}::uuid[])
        AND (j.status IS NOT NULL OR k.print_requested = false)`,
  );
  return new Map(rows.map((r) => [r.kot_ticket_id, r.status]));
}
