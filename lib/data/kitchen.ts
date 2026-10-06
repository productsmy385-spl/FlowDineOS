import "server-only";
import type { KotStatus, Prisma } from "@prisma/client";
import type { TenantContext } from "@/lib/auth/context-types";
import { db } from "@/lib/db/prisma";
import { instantDto, nullableInstantDto } from "./dto";
import { mapErrors } from "./errors";
import { tenantScope } from "./scope";
import { ACTIVE_KOT_STATUSES, printStatusFor, type KotPrintStatus } from "./kot";

/**
 * Kitchen board reads (S1-P15-T001; api.md LD-KOT-01, RH-KOT-01). The board is the kitchen projection
 * (security.md §3.3 row 23, SC-RBAC-07): ticket, items, timings and print state — never a customer name, phone or
 * amount. Everything is scoped to `ctx.tenantId`, and a section id from another tenant simply matches nothing.
 *
 * Polling (ADR-009): `since` is the last `serverTime` the client saw. A poll returns every ticket whose row changed at
 * or after it — including ones that became SERVED or CANCELLED, so a board can remove their cards.
 */
const BOARD_SELECT = {
  id: true,
  kotNumber: true,
  roundNumber: true,
  status: true,
  priority: true,
  orderTypeSnapshot: true,
  tableLabelSnapshot: true,
  notesSnapshot: true,
  kitchenSectionId: true,
  queuedAt: true,
  preparingAt: true,
  readyAt: true,
  servedAt: true,
  updatedAt: true,
  orderId: true,
  order: { select: { orderNumber: true } },
  items: {
    select: {
      id: true,
      quantity: true,
      itemLabelSnapshot: true,
      addonsSnapshot: true,
      instructionsSnapshot: true,
      orderItem: { select: { menuItem: { select: { prepTimeMinutes: true } } } },
    },
    orderBy: { createdAt: "asc" },
  },
} satisfies Prisma.KotTicketSelect;

type BoardRow = Prisma.KotTicketGetPayload<{ select: typeof BOARD_SELECT }>;

export type BoardTicketItem = { id: string; quantity: number; label: string; addons: string | null; instructions: string | null };

export type BoardTicket = {
  id: string;
  kotNumber: string;
  roundNumber: number;
  orderId: string;
  orderNumber: string;
  orderType: BoardRow["orderTypeSnapshot"];
  tableLabel: string | null;
  priority: BoardRow["priority"];
  status: KotStatus;
  sectionId: string | null;
  notes: string | null;
  queuedAt: string;
  preparingAt: string | null;
  readyAt: string | null;
  servedAt: string | null;
  items: BoardTicketItem[];
  /** Longest preparation time among the ticket's items, in minutes; null when no item declares one. */
  targetPrepMinutes: number | null;
  printStatus: KotPrintStatus;
};

export type BoardQuery = { sectionId?: string | null; status?: KotStatus; since?: Date; limit?: number };
export type BoardPage = { tickets: BoardTicket[]; serverTime: string; hasMore: boolean };

/** Cap one page so a busy service cannot pull an unbounded board (api.md §1.2). */
export const BOARD_LIMIT = 200;

function toBoardTicket(row: BoardRow, printStatus: KotPrintStatus): BoardTicket {
  const prepTimes = row.items.map((i) => i.orderItem?.menuItem?.prepTimeMinutes ?? null).filter((m): m is number => m !== null);
  return {
    id: row.id,
    kotNumber: row.kotNumber,
    roundNumber: row.roundNumber,
    orderId: row.orderId,
    orderNumber: row.order.orderNumber,
    orderType: row.orderTypeSnapshot,
    tableLabel: row.tableLabelSnapshot,
    priority: row.priority,
    status: row.status,
    sectionId: row.kitchenSectionId,
    notes: row.notesSnapshot,
    queuedAt: instantDto(row.queuedAt),
    preparingAt: nullableInstantDto(row.preparingAt),
    readyAt: nullableInstantDto(row.readyAt),
    servedAt: nullableInstantDto(row.servedAt),
    items: row.items.map((i) => ({ id: i.id, quantity: i.quantity, label: i.itemLabelSnapshot, addons: i.addonsSnapshot, instructions: i.instructionsSnapshot })),
    targetPrepMinutes: prepTimes.length > 0 ? Math.max(...prepTimes) : null,
    printStatus,
  };
}

/**
 * LD-KOT-01 / RH-KOT-01. Without `since` it is the working queue (QUEUED, PREPARING, READY) sorted by priority then
 * age; with `since` it is every ticket of this tenant that changed after that instant, whatever its status.
 */
export async function kitchenBoard(ctx: TenantContext, query: BoardQuery = {}): Promise<BoardPage> {
  const limit = Math.min(query.limit ?? BOARD_LIMIT, BOARD_LIMIT);
  const polling = query.since !== undefined;
  const filters: Prisma.KotTicketWhereInput = {
    ...(query.sectionId !== undefined && query.sectionId !== null ? { kitchenSectionId: query.sectionId } : {}),
    ...(query.status ? { status: query.status } : polling ? {} : { status: { in: [...ACTIVE_KOT_STATUSES] } }),
    ...(polling ? { updatedAt: { gte: query.since } } : {}),
  };

  const rows = await mapErrors("KOT", () =>
    db.kotTicket.findMany({
      where: tenantScope(ctx, filters),
      select: BOARD_SELECT,
      // Polling delivers changes oldest first; the board itself shows urgent and oldest work first.
      orderBy: polling ? [{ updatedAt: "asc" }, { kotNumber: "asc" }] : [{ priority: "desc" }, { queuedAt: "asc" }],
      take: limit + 1,
    }),
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const printStatuses = await printStatusFor(ctx, page.map((r) => r.id));
  return {
    tickets: page.map((row) => toBoardTicket(row, printStatuses.get(row.id) ?? "NONE")),
    // The server's clock, so a client's poll cursor never depends on the device clock.
    serverTime: instantDto(new Date()),
    hasMore,
  };
}
