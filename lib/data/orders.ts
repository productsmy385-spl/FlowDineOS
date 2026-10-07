import "server-only";
import { OrderChannel, OrderPriority, OrderStatus, type KotStatus, type OrderType, type PaymentStatus, type Prisma } from "@prisma/client";
import type { TenantContext } from "@/lib/auth/context-types";
import { audit } from "@/lib/audit/write";
import { db } from "@/lib/db/prisma";
import { ConflictError } from "@/lib/errors";
import { formatOrderNumber, nextNumber } from "./counters";
import { businessDateDto, instantDto, moneyDto, nullableInstantDto, rateDto } from "./dto";
import { mapErrors } from "./errors";
import { ACTIVE_KOT_STATUSES, printStatusFor, type KotPrintStatus } from "./kot";
import { notFoundOrConflict, required, tenantScope } from "./scope";
import { likeLiteral } from "./search";
import { withTx, type Tx } from "./tx";

/**
 * Order data access (S1-P04-T007 interim; rebuilt in S1-P12). Every query is scoped to `ctx.tenantId`; order lines and
 * the linked customer are reached through the order's composite (tenant_id, …) foreign keys, so they are always the
 * order's own tenant. Business rules (pricing, transitions, role rules) live in `lib/services/orders.ts`.
 */
const orderInclude = {
  items: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
  customer: { select: { id: true, fullName: true, phoneE164: true, email: true } },
} satisfies Prisma.OrderInclude;

type OrderRow = Prisma.OrderGetPayload<{ include: typeof orderInclude }>;

export type OrderItemDto = {
  id: string;
  menuItemId: string;
  itemNameSnapshot: string;
  variantNameSnapshot: string | null;
  quantity: number;
  specialInstructions: string | null;
  unitPriceSnapshot: string | null;
  taxRateSnapshot: string | null;
  lineSubtotal: string | null;
  lineTax: string | null;
  lineTotal: string | null;
};

export type OrderCustomerDto = { id: string; fullName: string; phoneE164: string | null; email: string | null };

/** JSON-safe order projection: money as two-decimal strings, instants as ISO strings (lib/data/dto.ts). */
export type OrderDto = {
  id: string;
  orderNumber: string;
  businessDate: string;
  orderType: OrderType;
  channel: OrderChannel;
  status: OrderStatus;
  priority: OrderPriority;
  paymentStatus: PaymentStatus | null;
  tableLabel: string | null;
  notes: string | null;
  currencyCode: string;
  subtotalAmount: string | null;
  taxAmount: string | null;
  totalAmount: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  customer: OrderCustomerDto | null;
  items: OrderItemDto[];
};

function toOrderDto(row: OrderRow): OrderDto {
  return {
    id: row.id,
    orderNumber: row.orderNumber,
    businessDate: businessDateDto(row.businessDate),
    orderType: row.orderType,
    channel: row.channel,
    status: row.status,
    priority: row.priority,
    paymentStatus: row.paymentStatus,
    tableLabel: row.tableLabel,
    notes: row.notes,
    currencyCode: row.currencyCode,
    subtotalAmount: moneyDto(row.subtotalAmount),
    taxAmount: moneyDto(row.taxAmount),
    totalAmount: moneyDto(row.totalAmount),
    version: row.version,
    createdAt: instantDto(row.createdAt),
    updatedAt: instantDto(row.updatedAt),
    customer: row.customer,
    items: row.items.map((item) => ({
      id: item.id,
      menuItemId: item.menuItemId,
      itemNameSnapshot: item.itemNameSnapshot,
      variantNameSnapshot: item.variantNameSnapshot,
      quantity: item.quantity,
      specialInstructions: item.specialInstructions,
      unitPriceSnapshot: moneyDto(item.unitPriceSnapshot),
      taxRateSnapshot: rateDto(item.taxRateSnapshot),
      lineSubtotal: moneyDto(item.lineSubtotal),
      lineTax: moneyDto(item.lineTax),
      lineTotal: moneyDto(item.lineTotal),
    })),
  };
}

// ─── Reads ───

export type OrderListQuery = {
  status?: OrderStatus;
  search?: string | null;
  /** False for the kitchen projection: customer name/phone must not be searchable (no PII oracle). */
  searchCustomers: boolean;
  limit?: number;
};

/** The context tenant's orders, newest first. */
export async function listOrders(ctx: TenantContext, query: OrderListQuery): Promise<OrderDto[]> {
  const search = query.search?.trim() ? likeLiteral(query.search.trim()) : null;
  const rows = await mapErrors("Order", () =>
    db.order.findMany({
      where: {
        ...tenantScope(ctx),
        ...(query.status ? { status: query.status } : {}),
        ...(search
          ? {
              OR: [
                { orderNumber: { contains: search, mode: "insensitive" as const } },
                { tableLabel: { contains: search, mode: "insensitive" as const } },
                ...(query.searchCustomers
                  ? [
                      { customer: { fullName: { contains: search, mode: "insensitive" as const } } },
                      { customer: { phoneE164: { contains: search, mode: "insensitive" as const } } },
                    ]
                  : []),
              ],
            }
          : {}),
      },
      include: orderInclude,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: Math.min(Math.max(query.limit ?? 100, 1), 200),
    }),
  );
  return rows.map(toOrderDto);
}

// ─── Board (LD-ORD-01, RH-ORD-01) ───

/** Statuses an order passes through while it is still work in the restaurant. */
export const ACTIVE_ORDER_STATUSES: readonly OrderStatus[] = [OrderStatus.NEW, OrderStatus.ACCEPTED, OrderStatus.PREPARING, OrderStatus.READY];
/** Statuses that end an order; the board shows only today's. */
export const CLOSED_ORDER_STATUSES: readonly OrderStatus[] = [OrderStatus.COMPLETED, OrderStatus.CANCELLED, OrderStatus.REFUNDED];

/** ADR-009 / api.md §1.2: one board page is capped so a busy service cannot pull an unbounded list. */
export const ORDER_BOARD_LIMIT = 200;

/** api.md LD-ORD-01 projection. `customerName` and the money fields are dropped for the kitchen (security.md §3.3 row 23). */
export type OrderBoardItem = {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  paymentStatus: PaymentStatus | null;
  orderType: OrderType;
  tableLabel: string | null;
  priority: OrderPriority;
  customerName: string | null;
  currencyCode: string;
  totalAmount: string | null;
  itemCount: number;
  /** The first lines, for the rail card's details and artwork (owner brief 2026-10-07 §6, §11). */
  lines: Array<{ name: string; quantity: number }>;
  /** The first line's dish photo, if it has one — the card's artwork. */
  imageUrl: string | null;
  createdAt: string;
  updatedAt: string;
};

export type OrderBoardPage = { items: OrderBoardItem[]; serverTime: string; hasMore: boolean };

export type OrderBoardQuery = {
  status?: OrderStatus;
  type?: OrderType;
  search?: string | null;
  /** False for the kitchen projection: a customer name must not be searchable (no PII oracle). */
  searchCustomers: boolean;
  /** Present on a poll: every row of this tenant whose `updated_at` is at or after the cursor (ADR-009). */
  since?: Date;
  /** The restaurant's business date, so the initial board carries only *today's* closed orders. */
  businessDate?: Date;
  limit?: number;
};

const boardSelect = {
  id: true,
  orderNumber: true,
  status: true,
  paymentStatus: true,
  orderType: true,
  tableLabel: true,
  priority: true,
  currencyCode: true,
  totalAmount: true,
  createdAt: true,
  updatedAt: true,
  customer: { select: { fullName: true } },
  _count: { select: { items: true } },
  items: { take: 4, orderBy: { createdAt: "asc" }, select: { itemNameSnapshot: true, quantity: true, menuItem: { select: { imageUrl: true } } } },
} satisfies Prisma.OrderSelect;

type BoardRow = Prisma.OrderGetPayload<{ select: typeof boardSelect }>;

function toBoardItem(row: BoardRow): OrderBoardItem {
  return {
    id: row.id,
    orderNumber: row.orderNumber,
    status: row.status,
    paymentStatus: row.paymentStatus,
    orderType: row.orderType,
    tableLabel: row.tableLabel,
    priority: row.priority,
    customerName: row.customer?.fullName ?? null,
    currencyCode: row.currencyCode,
    totalAmount: moneyDto(row.totalAmount),
    itemCount: row._count.items,
    lines: row.items.map((item) => ({ name: item.itemNameSnapshot, quantity: item.quantity })),
    imageUrl: row.items.find((item) => item.menuItem.imageUrl)?.menuItem.imageUrl ?? null,
    createdAt: instantDto(row.createdAt),
    updatedAt: instantDto(row.updatedAt),
  };
}

function boardFilters(query: OrderBoardQuery): Prisma.OrderWhereInput {
  const search = query.search?.trim() ? likeLiteral(query.search.trim()) : null;
  return {
    ...(query.type ? { orderType: query.type } : {}),
    ...(search
      ? {
          OR: [
            { orderNumber: { contains: search, mode: "insensitive" as const } },
            { tableLabel: { contains: search, mode: "insensitive" as const } },
            ...(query.searchCustomers
              ? [
                  { customer: { fullName: { contains: search, mode: "insensitive" as const } } },
                  { customer: { phoneE164: { contains: search, mode: "insensitive" as const } } },
                ]
              : []),
          ],
        }
      : {}),
  };
}

/**
 * LD-ORD-01 / RH-ORD-01. Without `since` it is the working board — the active queue (urgent first, then oldest)
 * followed by today's closed orders (newest first). With `since` it is every order of this tenant that changed at or
 * after that instant, whatever its status, so a client can update *and remove* cards (ADR-009).
 */
export async function orderBoard(ctx: TenantContext, query: OrderBoardQuery): Promise<OrderBoardPage> {
  const limit = Math.min(query.limit ?? ORDER_BOARD_LIMIT, ORDER_BOARD_LIMIT);
  const filters = boardFilters(query);
  const serverTime = instantDto(new Date());

  if (query.since) {
    const rows = await mapErrors("Order", () =>
      db.order.findMany({
        where: tenantScope(ctx, { ...filters, ...(query.status ? { status: query.status } : {}), updatedAt: { gte: query.since } }),
        select: boardSelect,
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        take: limit + 1,
      }),
    );
    const hasMore = rows.length > limit;
    return { items: (hasMore ? rows.slice(0, limit) : rows).map(toBoardItem), serverTime, hasMore };
  }

  const wanted = query.status ? [query.status] : null;
  const active = wanted ? wanted.filter((s) => ACTIVE_ORDER_STATUSES.includes(s)) : [...ACTIVE_ORDER_STATUSES];
  const closed = wanted ? wanted.filter((s) => CLOSED_ORDER_STATUSES.includes(s)) : [...CLOSED_ORDER_STATUSES];

  const [activeRows, closedRows] = await mapErrors("Order", () =>
    Promise.all([
      active.length === 0
        ? Promise.resolve([] as BoardRow[])
        : db.order.findMany({
            where: tenantScope(ctx, { ...filters, status: { in: active } }),
            select: boardSelect,
            orderBy: [{ priority: "desc" }, { createdAt: "asc" }, { id: "asc" }],
            take: limit + 1,
          }),
      closed.length === 0
        ? Promise.resolve([] as BoardRow[])
        : db.order.findMany({
            where: tenantScope(ctx, { ...filters, status: { in: closed }, ...(query.businessDate ? { businessDate: query.businessDate } : {}) }),
            select: boardSelect,
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: limit + 1,
          }),
    ]),
  );

  const hasMore = activeRows.length > limit || closedRows.length > limit;
  return {
    items: [...activeRows.slice(0, limit), ...closedRows.slice(0, limit)].map(toBoardItem),
    serverTime,
    hasMore,
  };
}

// ─── Detail (LD-ORD-02) ───

export type OrderLineDto = OrderItemDto & {
  variantId: string | null;
  kitchenSectionId: string | null;
  kotRound: number;
  addonsTotalSnapshot: string | null;
  addons: Array<{ id: string; name: string; price: string | null }>;
};

export type OrderKotDto = {
  id: string;
  kotNumber: string;
  roundNumber: number;
  status: KotStatus;
  sectionName: string | null;
  queuedAt: string;
  preparingAt: string | null;
  readyAt: string | null;
  servedAt: string | null;
  itemCount: number;
  printStatus: KotPrintStatus;
};

export type OrderTimelineEntry = {
  id: string;
  action: string;
  at: string;
  actorName: string | null;
  actorRole: string | null;
  reason: string | null;
  from: string | null;
  to: string | null;
};

export type OrderDetailDto = {
  id: string;
  orderNumber: string;
  businessDate: string;
  orderType: OrderType;
  channel: OrderChannel;
  status: OrderStatus;
  priority: OrderPriority;
  paymentStatus: PaymentStatus | null;
  tableLabel: string | null;
  notes: string | null;
  cancelReason: string | null;
  currencyCode: string;
  subtotalAmount: string | null;
  taxAmount: string | null;
  discountAmount: string | null;
  totalAmount: string | null;
  paidAmount: string | null;
  refundedAmount: string | null;
  balanceDue: string | null;
  version: number;
  createdAt: string;
  acceptedAt: string | null;
  preparingAt: string | null;
  readyAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  updatedAt: string;
  createdByName: string | null;
  cancelledByName: string | null;
  customer: OrderCustomerDto | null;
  lines: OrderLineDto[];
  kots: OrderKotDto[];
};

const detailSelect = {
  id: true,
  orderNumber: true,
  businessDate: true,
  orderType: true,
  channel: true,
  status: true,
  priority: true,
  paymentStatus: true,
  tableLabel: true,
  notes: true,
  cancelReason: true,
  currencyCode: true,
  subtotalAmount: true,
  taxAmount: true,
  discountAmount: true,
  totalAmount: true,
  paidAmount: true,
  refundedAmount: true,
  version: true,
  createdAt: true,
  acceptedAt: true,
  preparingAt: true,
  readyAt: true,
  completedAt: true,
  cancelledAt: true,
  updatedAt: true,
  createdBy: { select: { fullName: true, email: true } },
  cancelledBy: { select: { fullName: true, email: true } },
  customer: { select: { id: true, fullName: true, phoneE164: true, email: true } },
  items: {
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      menuItemId: true,
      variantId: true,
      kitchenSectionId: true,
      kotRound: true,
      itemNameSnapshot: true,
      variantNameSnapshot: true,
      quantity: true,
      specialInstructions: true,
      unitPriceSnapshot: true,
      addonsTotalSnapshot: true,
      taxRateSnapshot: true,
      lineSubtotal: true,
      lineTax: true,
      lineTotal: true,
      addons: { orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true, nameSnapshot: true, priceSnapshot: true } },
    },
  },
  kotTickets: {
    orderBy: [{ roundNumber: "asc" }, { kotNumber: "asc" }],
    select: {
      id: true,
      kotNumber: true,
      roundNumber: true,
      status: true,
      queuedAt: true,
      preparingAt: true,
      readyAt: true,
      servedAt: true,
      kitchenSection: { select: { name: true } },
      _count: { select: { items: true } },
    },
  },
} satisfies Prisma.OrderSelect;

type DetailRow = Prisma.OrderGetPayload<{ select: typeof detailSelect }>;

const displayName = (user: { fullName: string | null; email: string } | null) => user?.fullName ?? user?.email ?? null;

function toDetailDto(row: DetailRow, printStatuses: Map<string, KotPrintStatus>): OrderDetailDto {
  return {
    id: row.id,
    orderNumber: row.orderNumber,
    businessDate: businessDateDto(row.businessDate),
    orderType: row.orderType,
    channel: row.channel,
    status: row.status,
    priority: row.priority,
    paymentStatus: row.paymentStatus,
    tableLabel: row.tableLabel,
    notes: row.notes,
    cancelReason: row.cancelReason,
    currencyCode: row.currencyCode,
    subtotalAmount: moneyDto(row.subtotalAmount),
    taxAmount: moneyDto(row.taxAmount),
    discountAmount: moneyDto(row.discountAmount),
    totalAmount: moneyDto(row.totalAmount),
    paidAmount: moneyDto(row.paidAmount),
    refundedAmount: moneyDto(row.refundedAmount),
    // Decimal arithmetic only — never a float (ADR-010 §1).
    balanceDue: moneyDto(row.totalAmount.minus(row.paidAmount).plus(row.refundedAmount)),
    version: row.version,
    createdAt: instantDto(row.createdAt),
    acceptedAt: nullableInstantDto(row.acceptedAt),
    preparingAt: nullableInstantDto(row.preparingAt),
    readyAt: nullableInstantDto(row.readyAt),
    completedAt: nullableInstantDto(row.completedAt),
    cancelledAt: nullableInstantDto(row.cancelledAt),
    updatedAt: instantDto(row.updatedAt),
    createdByName: displayName(row.createdBy),
    cancelledByName: displayName(row.cancelledBy),
    customer: row.customer,
    lines: row.items.map((item) => ({
      id: item.id,
      menuItemId: item.menuItemId,
      variantId: item.variantId,
      kitchenSectionId: item.kitchenSectionId,
      kotRound: item.kotRound,
      itemNameSnapshot: item.itemNameSnapshot,
      variantNameSnapshot: item.variantNameSnapshot,
      quantity: item.quantity,
      specialInstructions: item.specialInstructions,
      unitPriceSnapshot: moneyDto(item.unitPriceSnapshot),
      addonsTotalSnapshot: moneyDto(item.addonsTotalSnapshot),
      taxRateSnapshot: rateDto(item.taxRateSnapshot),
      lineSubtotal: moneyDto(item.lineSubtotal),
      lineTax: moneyDto(item.lineTax),
      lineTotal: moneyDto(item.lineTotal),
      addons: item.addons.map((addon) => ({ id: addon.id, name: addon.nameSnapshot, price: moneyDto(addon.priceSnapshot) })),
    })),
    kots: row.kotTickets.map((kot) => ({
      id: kot.id,
      kotNumber: kot.kotNumber,
      roundNumber: kot.roundNumber,
      status: kot.status,
      sectionName: kot.kitchenSection?.name ?? null,
      queuedAt: instantDto(kot.queuedAt),
      preparingAt: nullableInstantDto(kot.preparingAt),
      readyAt: nullableInstantDto(kot.readyAt),
      servedAt: nullableInstantDto(kot.servedAt),
      itemCount: kot._count.items,
      printStatus: printStatuses.get(kot.id) ?? "NONE",
    })),
  };
}

/** LD-ORD-02: one order with its snapshot lines, add-ons and kitchen tickets. Null for a missing or foreign id. */
export async function findOrderDetail(ctx: TenantContext, orderId: string): Promise<OrderDetailDto | null> {
  const row = await mapErrors("Order", () => db.order.findFirst({ where: tenantScope(ctx, { id: orderId }), select: detailSelect }));
  if (!row) return null;
  const printStatuses = await printStatusFor(ctx, row.kotTickets.map((kot) => kot.id));
  return toDetailDto(row, printStatuses);
}

/** LD-ORD-02 activity: this order's own audit rows, newest first (security.md §7 — the log is append-only). */
export async function orderTimeline(ctx: TenantContext, orderId: string, limit = 50): Promise<OrderTimelineEntry[]> {
  const rows = await mapErrors("Audit log", () =>
    db.auditLog.findMany({
      where: { tenantId: ctx.tenantId, resourceType: "order", resourceId: orderId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: Math.min(Math.max(limit, 1), 100),
      select: { id: true, action: true, createdAt: true, actorRole: true, reason: true, beforeState: true, afterState: true, actor: { select: { fullName: true, email: true } } },
    }),
  );
  const statusOf = (state: Prisma.JsonValue | null): string | null => {
    if (!state || typeof state !== "object" || Array.isArray(state)) return null;
    const value = (state as Record<string, unknown>).status;
    return typeof value === "string" ? value : null;
  };
  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    at: instantDto(row.createdAt),
    actorName: displayName(row.actor),
    actorRole: row.actorRole,
    reason: row.reason,
    from: statusOf(row.beforeState),
    to: statusOf(row.afterState),
  }));
}

// ─── Order metadata (SA-ORD-05, SA-ORD-06) ───

export type OrderMetaState = { id: string; orderNumber: string; status: OrderStatus; priority: OrderPriority; customerId: string | null; version: number };

/** The fields SA-ORD-05/06 change, tenant-scoped; NOT_FOUND covers both a missing and another tenant's id. */
export async function findOrderMeta(tx: Tx, ctx: TenantContext, orderId: string): Promise<OrderMetaState | null> {
  return tx.order.findFirst({
    where: tenantScope(ctx, { id: orderId }),
    select: { id: true, orderNumber: true, status: true, priority: true, customerId: true, version: true },
  });
}

/**
 * SA-ORD-06 effect: the order and every ticket of it still open take the new priority, so the kitchen board reorders
 * on its next poll. Returns how many tickets changed.
 */
export async function applyOrderPriority(tx: Tx, ctx: TenantContext, orderId: string, priority: OrderPriority): Promise<number> {
  await tx.order.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id: orderId } }, data: { priority, version: { increment: 1 } } });
  const { count } = await tx.kotTicket.updateMany({
    where: tenantScope(ctx, { orderId, status: { in: [...ACTIVE_KOT_STATUSES] } }),
    data: { priority },
  });
  return count;
}

/** SA-ORD-05 effect: link or unlink the order's customer. */
export async function applyOrderCustomer(tx: Tx, ctx: TenantContext, orderId: string, customerId: string | null): Promise<void> {
  await tx.order.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id: orderId } }, data: { customerId, version: { increment: 1 } } });
}

export type OrderableMenuItem = {
  id: string;
  name: string;
  kitchenSectionId: string | null;
  basePrice: Prisma.Decimal;
  taxRate: Prisma.Decimal;
  isAvailable: boolean;
  isPublished: boolean;
};

/** The context tenant's non-archived menu items among `ids` (other tenants' ids simply do not match). */
export async function findMenuItemsForOrder(ctx: TenantContext, ids: readonly string[]): Promise<OrderableMenuItem[]> {
  return mapErrors("Menu item", () =>
    db.menuItem.findMany({
      where: tenantScope(ctx, { id: { in: [...ids] }, archivedAt: null }),
      select: { id: true, name: true, kitchenSectionId: true, basePrice: true, taxRate: true, isAvailable: true, isPublished: true },
    }),
  );
}

// ─── Create ───

export type NewOrderAddon = { addonId: string; nameSnapshot: string; priceSnapshot: Prisma.Decimal };

export type NewOrderLine = {
  menuItemId: string;
  variantId: string | null;
  kitchenSectionId: string | null;
  itemNameSnapshot: string;
  variantNameSnapshot: string | null;
  unitPriceSnapshot: Prisma.Decimal;
  addonsTotalSnapshot: Prisma.Decimal;
  taxRateSnapshot: Prisma.Decimal;
  quantity: number;
  lineSubtotal: Prisma.Decimal;
  lineTax: Prisma.Decimal;
  lineTotal: Prisma.Decimal;
  specialInstructions: string | null;
  addons: NewOrderAddon[];
};

export type NewOrder = {
  idempotencyKey: string;
  orderType: OrderType;
  channel?: OrderChannel;
  priority?: OrderPriority;
  businessDate: Date;
  tableLabel: string | null;
  notes: string | null;
  subtotalAmount: Prisma.Decimal;
  taxAmount: Prisma.Decimal;
  totalAmount: Prisma.Decimal;
  /** Either an existing customer of this tenant … */
  customerId?: string | null;
  /** … or a new one. Linking by phone/email never overwrites the stored profile (BA-19). */
  customer: { fullName: string; phoneE164: string | null; email: string | null; notes: string | null } | null;
  lines: NewOrderLine[];
};

/** `YYYYMMDD-NNNN` from the tenant's ORDER counter for the business date (S1-P12-T003, ADR-010 §6); race-free. */
async function nextOrderNumber(tx: Tx, ctx: TenantContext, businessDate: Date): Promise<string> {
  return formatOrderNumber(businessDate, await nextNumber(tx, ctx, "ORDER", businessDate));
}

/** Links an existing customer of this tenant (by phone, else email) or creates one. Never overwrites a profile (BA-19). */
async function linkOrCreateCustomer(tx: Tx, ctx: TenantContext, customer: NonNullable<NewOrder["customer"]>): Promise<string> {
  let existing: { id: string } | null = null;
  if (customer.phoneE164) {
    existing = await tx.customer.findFirst({ where: tenantScope(ctx, { phoneE164: customer.phoneE164, archivedAt: null }), select: { id: true } });
  } else if (customer.email) {
    existing = await tx.customer.findFirst({ where: tenantScope(ctx, { email: customer.email, archivedAt: null }), select: { id: true } });
  }
  if (existing) return existing.id;

  const created = await tx.customer.create({
    data: {
      tenantId: ctx.tenantId,
      fullName: customer.fullName,
      phoneE164: customer.phoneE164,
      email: customer.email,
      notes: customer.notes,
      createdByUserId: ctx.userId,
    },
    select: { id: true },
  });
  await audit(tx, ctx, {
    action: "customer.created",
    resourceType: "customer",
    resourceId: created.id,
    after: { fullName: customer.fullName, phoneE164: customer.phoneE164, email: customer.email, source: "order" },
  });
  return created.id;
}

/**
 * Persists a priced order in one transaction: customer link/create → order number → order → lines → audit
 * `order.created`. The tenant, currency and actor come from `ctx`; nothing here is taken from client input.
 */
/** An order previously created with this idempotency key, for replaying a repeated submit (ADR-010 §7). */
export async function findOrderByIdempotencyKey(ctx: TenantContext, client: Tx, idempotencyKey: string): Promise<OrderDto | null> {
  const row = await client.order.findFirst({ where: tenantScope(ctx, { idempotencyKey }), include: orderInclude });
  return row ? toOrderDto(row) : null;
}

/** True when the tenant's business day has been closed, so no new order may be recorded against it (SA-TXN-04). */
export async function isBusinessDayClosed(ctx: TenantContext, client: Tx, businessDate: Date): Promise<boolean> {
  const close = await client.businessDayClose.findFirst({
    where: tenantScope(ctx, { businessDate }),
    select: { id: true },
  });
  return close !== null;
}

/** An active customer of this tenant, or NOT_FOUND — another tenant's id looks exactly like an unknown one. */
export async function linkExistingCustomer(tx: Tx, ctx: TenantContext, customerId: string): Promise<string> {
  const customer = await tx.customer.findFirst({ where: tenantScope(ctx, { id: customerId, archivedAt: null }), select: { id: true } });
  return required(customer, "Customer").id;
}

/**
 * Persists a priced order inside the caller's transaction: customer link/create → order number from the tenant
 * counter → order → lines → add-on snapshots → audit `order.created`. The tenant, currency, channel and actor come
 * from `ctx`; every amount comes from the pricing engine, never from input.
 */
export async function insertOrder(tx: Tx, ctx: TenantContext, order: NewOrder): Promise<{ id: string; orderNumber: string }> {
  const customerId = order.customerId ?? (order.customer ? await linkOrCreateCustomer(tx, ctx, order.customer) : null);
  const orderNumber = await nextOrderNumber(tx, ctx, order.businessDate);

  const created = await tx.order.create({
    data: {
      tenantId: ctx.tenantId,
      orderNumber,
      businessDate: order.businessDate,
      orderType: order.orderType,
      channel: order.channel ?? OrderChannel.STAFF,
      status: OrderStatus.NEW,
      priority: order.priority ?? OrderPriority.NORMAL,
      tableLabel: order.tableLabel,
      notes: order.notes,
      subtotalAmount: order.subtotalAmount,
      taxAmount: order.taxAmount,
      totalAmount: order.totalAmount,
      currencyCode: ctx.restaurant.currencyCode,
      idempotencyKey: order.idempotencyKey,
      customerId,
      createdByUserId: ctx.userId,
    },
    select: { id: true },
  });

  for (const line of order.lines) {
    const { addons, ...item } = line;
    const orderItem = await tx.orderItem.create({
      data: { ...item, tenantId: ctx.tenantId, orderId: created.id, kotRound: 1 },
      select: { id: true },
    });
    if (addons.length > 0) {
      await tx.orderItemAddon.createMany({
        data: addons.map((addon) => ({
          tenantId: ctx.tenantId,
          orderItemId: orderItem.id,
          addonId: addon.addonId,
          nameSnapshot: addon.nameSnapshot,
          priceSnapshot: addon.priceSnapshot,
        })),
      });
    }
  }

  await audit(tx, ctx, {
    action: "order.created",
    resourceType: "order",
    resourceId: created.id,
    after: {
      orderNumber,
      status: OrderStatus.NEW,
      orderType: order.orderType,
      channel: order.channel ?? OrderChannel.STAFF,
      customerId,
      itemCount: order.lines.length,
      subtotalAmount: moneyDto(order.subtotalAmount),
      taxAmount: moneyDto(order.taxAmount),
      totalAmount: moneyDto(order.totalAmount),
    },
  });

  return { id: created.id, orderNumber };
}

/** The full order DTO inside a transaction (used right after creating or accepting one). */
export async function readOrder(tx: Tx, ctx: TenantContext, orderId: string): Promise<OrderDto> {
  return toOrderDto(required(await tx.order.findFirst({ where: tenantScope(ctx, { id: orderId }), include: orderInclude }), "Order"));
}

/** Marks a just-created order ACCEPTED in the same transaction (SA-ORD-01 `sendToKitchen`). */
export async function acceptNewOrder(tx: Tx, ctx: TenantContext, orderId: string): Promise<void> {
  await tx.order.update({
    where: { tenantId_id: { tenantId: ctx.tenantId, id: orderId } },
    data: { status: OrderStatus.ACCEPTED, acceptedAt: new Date(), version: { increment: 1 } },
  });
  await audit(tx, ctx, {
    action: "order.status_changed",
    resourceType: "order",
    resourceId: orderId,
    before: { status: OrderStatus.NEW, version: 0 },
    after: { status: OrderStatus.ACCEPTED, version: 1, trigger: "send_to_kitchen" },
  });
}

// ─── Status transitions ───

export type OrderTransitionState = {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  version: number;
  paymentStatus: PaymentStatus;
  paidAmount: Prisma.Decimal;
  refundedAmount: Prisma.Decimal;
};

export type OrderTransitionRequest = {
  orderId: string;
  to: OrderStatus;
  /** Stored as cancel_reason and on the audit row when `to` is CANCELLED. */
  reason: string | null;
  expectedVersion?: number;
};

export type OrderTransitionResult = { orderId: string; orderNumber: string; from: OrderStatus; status: OrderStatus; version: number; changed: boolean };

const TRANSITION_TIMESTAMP: Partial<Record<OrderStatus, "acceptedAt" | "preparingAt" | "readyAt" | "completedAt" | "cancelledAt">> = {
  ACCEPTED: "acceptedAt",
  PREPARING: "preparingAt",
  READY: "readyAt",
  COMPLETED: "completedAt",
  CANCELLED: "cancelledAt",
};

/**
 * Loads the order (tenant-scoped; missing and other-tenant are both NOT_FOUND), lets `assertAllowed` apply the
 * business rules to the current state, then compare-and-sets status + version and audits — all in one transaction.
 * An order already in the target status is a no-op (api.md SA-ORD-02 idempotency: a retried request succeeds without a
 * second change). A concurrent change (version moved) is 409 CONFLICT.
 */
export async function applyOrderTransition(
  ctx: TenantContext,
  request: OrderTransitionRequest,
  assertAllowed: (current: OrderTransitionState, tx: Tx) => void | Promise<void>,
  /** Runs inside the same transaction after the status change and its audit (KOT generation/cancellation, S1-P14). */
  sideEffects?: (tx: Tx, orderId: string) => Promise<void>,
): Promise<OrderTransitionResult> {
  return withTx(ctx, async (tx) => {
    const current = required(
      await tx.order.findFirst({
        where: tenantScope(ctx, { id: request.orderId }),
        select: { id: true, orderNumber: true, status: true, version: true, paymentStatus: true, paidAmount: true, refundedAmount: true },
      }),
      "Order",
    );
    if (current.status === request.to) {
      return { orderId: current.id, orderNumber: current.orderNumber, from: current.status, status: current.status, version: current.version, changed: false };
    }
    if (request.expectedVersion !== undefined && request.expectedVersion !== current.version) {
      throw new ConflictError("Order was changed by someone else. Reload and try again.");
    }
    await assertAllowed(current, tx);

    const cancelling = request.to === OrderStatus.CANCELLED;
    const stamp = TRANSITION_TIMESTAMP[request.to];
    const { count } = await tx.order.updateMany({
      where: { id: current.id, tenantId: ctx.tenantId, version: current.version },
      data: {
        status: request.to,
        version: { increment: 1 },
        ...(stamp ? { [stamp]: new Date() } : {}),
        ...(cancelling ? { cancelledByUserId: ctx.userId, cancelReason: request.reason } : {}),
      },
    });
    if (count === 0) {
      throw await notFoundOrConflict(async () => (await tx.order.count({ where: tenantScope(ctx, { id: current.id }) })) > 0, "Order");
    }

    await audit(tx, ctx, {
      action: cancelling ? "order.cancelled" : "order.status_changed",
      resourceType: "order",
      resourceId: current.id,
      before: { status: current.status, version: current.version },
      after: { status: request.to, version: current.version + 1 },
      reason: cancelling ? request.reason : null,
    });
    if (sideEffects) await sideEffects(tx, current.id);

    return { orderId: current.id, orderNumber: current.orderNumber, from: current.status, status: request.to, version: current.version + 1, changed: true };
  });
}

/** The order's status and version inside a transaction, for status derivation (S1-P14-T002). */
export async function findOrderStatus(tx: Tx, ctx: TenantContext, orderId: string): Promise<{ id: string; status: OrderStatus; version: number } | null> {
  return tx.order.findFirst({ where: tenantScope(ctx, { id: orderId }), select: { id: true, status: true, version: true } });
}

/**
 * Compare-and-set for an automatic (derived) transition, e.g. ACCEPTED → PREPARING when the first KOT starts. Returns
 * false when the order moved on concurrently; the caller decides whether that matters.
 */
export async function setDerivedOrderStatus(
  tx: Tx,
  ctx: TenantContext,
  order: { id: string; status: OrderStatus; version: number },
  to: OrderStatus,
): Promise<boolean> {
  const stamp = TRANSITION_TIMESTAMP[to];
  const { count } = await tx.order.updateMany({
    where: { id: order.id, tenantId: ctx.tenantId, status: order.status, version: order.version },
    data: { status: to, version: { increment: 1 }, ...(stamp ? { [stamp]: new Date() } : {}) },
  });
  return count === 1;
}
