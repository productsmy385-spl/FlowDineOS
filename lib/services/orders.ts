import "server-only";
import { OrderPriority, OrderStatus, PaymentStatus, type OrderType, type Prisma } from "@prisma/client";
import type { TenantContext } from "@/lib/auth/context-types";
import { hasPermission, type TenantPermission } from "@/lib/auth/permissions";
import { allowedNextStatuses, assertTransitionAllowed, permissionForTarget } from "@/lib/auth/transitions";
import { listCustomers, type CustomerListItemDto } from "@/lib/data/customers";
import { listMenuCategories, listMenuItems, loadOrderCatalogue, type MenuItemListRowDto } from "@/lib/data/menu";
import {
  acceptNewOrder,
  applyOrderCustomer,
  applyOrderPriority,
  applyOrderTransition,
  findOrderByIdempotencyKey,
  findOrderDetail,
  findOrderMeta,
  insertOrder,
  isBusinessDayClosed,
  linkExistingCustomer,
  listOrders,
  orderBoard,
  orderTimeline,
  readOrder,
  type NewOrderLine,
  type OrderBoardItem,
  type OrderBoardPage,
  type OrderDetailDto,
  type OrderDto,
  type OrderTimelineEntry,
} from "@/lib/data/orders";
import { getRestaurantSettingsSnapshot } from "@/lib/data/restaurant";
import { withTx } from "@/lib/data/tx";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { priceLines, type CartLine, type CatalogueItem } from "@/lib/pricing/price-order";
import { latestRoundKotStatuses } from "@/lib/data/kot";
import { required } from "@/lib/data/scope";
import { audit } from "@/lib/audit/write";
import { publishedMenuForToday } from "@/lib/services/daily-menu";
import { cancelKotsWithOrder, generateKotsForRound } from "@/lib/services/kot";
import { placeOrderOnTableBill } from "@/lib/services/table-placement";
import { businessDateFor } from "@/lib/time/business-date";
import {
  ORDER_TRANSITION_TARGETS,
  type CreateOrderData,
  type ListCustomersData,
  type ListOrdersData,
  type OrderPollData,
  type OrderTransitionTarget,
  type QuoteOrderData,
  type SetOrderCustomerData,
  type SetOrderPriorityData,
  type UpdateOrderStatusData,
} from "@/lib/validation/orders";

/**
 * Order engine (S1-P04-T007 interim; rebuilt in S1-P12). Every function takes the server-resolved `TenantContext`
 * first — the tenant, actor, role, timezone and currency come only from it — and reaches the database only through
 * `lib/data/orders.ts` / `lib/data/customers.ts`.
 */
export type { CustomerListItemDto, OrderBoardItem, OrderBoardPage, OrderDetailDto, OrderDto, OrderTimelineEntry };

/** api.md SA-ORD-03: a cancellation reason is 5–280 characters (280 is enforced by the input schema). */
export const CANCEL_REASON_MIN_LENGTH = 5;

/**
 * The permission to check *before* loading the order for a requested target (security.md §3.4, via the shared table in
 * `lib/auth/transitions.ts`). Every user-requestable target has one; anything else is INVALID_TRANSITION.
 */
export function orderTransitionPermission(target: OrderTransitionTarget): TenantPermission {
  const permission = permissionForTarget("order", target);
  if (!permission) throw new ConflictError(`An order cannot be moved to ${target} by hand.`, "INVALID_TRANSITION");
  return permission;
}

/** security.md §3.3 row 23: KITCHEN sees no customer data, no amounts and no payment state. */
function kitchenProjection(order: OrderDto): OrderDto {
  return {
    ...order,
    paymentStatus: null,
    subtotalAmount: null,
    taxAmount: null,
    totalAmount: null,
    customer: null,
    items: order.items.map((item) => ({ ...item, unitPriceSnapshot: null, taxRateSnapshot: null, lineSubtotal: null, lineTax: null, lineTotal: null })),
  };
}

/** Roles allowed to mark an order urgent (api.md SA-ORD-01). */
const PRIORITY_ROLES = new Set(["TENANT_ADMIN", "MANAGER", "CASHIER"]);

/**
 * SA-ORD-01 (S1-P12-T004) — brief §26 steps 1–12 in one transaction: idempotency lookup → tenant catalogue →
 * server pricing (ADR-010 §3 through `lib/pricing`) → daily counter → order, lines and add-on snapshots → customer
 * link or creation (never an update, BA-19) → optional acceptance with its kitchen tickets → audit.
 *
 * Nothing about money comes from the client: prices, tax and totals are read from the tenant's own menu rows. An item,
 * variant or add-on that is not this tenant's is NOT_FOUND, exactly like an unknown id (SC-TEN-04); one that exists
 * but cannot be ordered is 422 ITEM_UNAVAILABLE / VARIANT_REQUIRED / INVALID_ADDON with the offending line.
 */
export async function createOrder(ctx: TenantContext, data: CreateOrderData): Promise<OrderDto> {
  if (data.priority === OrderPriority.HIGH && !PRIORITY_ROLES.has(ctx.role)) {
    throw new ForbiddenError("Only a manager or cashier can mark an order urgent.");
  }
  if (data.customer && !hasPermission(ctx, "customer:create")) {
    throw new ForbiddenError("You can't add a new customer. Choose an existing one or ask a cashier.");
  }

  const businessDate = businessDateFor(new Date(), ctx.restaurant.timezone);

  const attempt = () =>
    createOnce(ctx, data, businessDate).catch(async (error) => {
      // Two submits with the same key raced: the loser's unique violation means the winner's order is now committed.
      if (error instanceof ConflictError && error.code === "CONFLICT") {
        const original = await withTx(ctx, (tx) => findOrderByIdempotencyKey(ctx, tx, data.idempotencyKey));
        if (original) return { order: original, replayed: true };
      }
      throw error;
    });
  const { order, replayed } = await attempt().catch((error) => {
    // Two first orders for the same empty table raced and the other one opened its bill (partial unique index,
    // RASOIOS-ADR-027): try once more, now joining that bill — or refusing, if this order expected a new one.
    if (error instanceof ConflictError && error.code === "CONFLICT" && data.orderType === "DINE_IN" && data.tableLabel) return attempt();
    throw error;
  });

  if (!replayed) {
    logger.info("order.created", {
      requestId: ctx.requestId,
      tenantId: ctx.tenantId,
      orderId: order.id,
      orderNumber: order.orderNumber,
      totalAmount: order.totalAmount,
      orderType: order.orderType,
      sentToKitchen: data.sendToKitchen,
    });
  }
  return order;
}

/** One attempt at creating the order; the caller turns a lost idempotency race into a replay. */
async function createOnce(ctx: TenantContext, data: CreateOrderData, businessDate: Date): Promise<{ order: OrderDto; replayed: boolean }> {
  return withTx(ctx, async (tx) => {
    const existing = await findOrderByIdempotencyKey(ctx, tx, data.idempotencyKey);
    if (existing) return { order: existing, replayed: true };

    if (await isBusinessDayClosed(ctx, tx, businessDate)) {
      throw new ConflictError("The business day is closed. Start a new day before taking orders.", "DAY_CLOSED");
    }

    const catalogue = await loadOrderCatalogue(ctx, { itemIds: data.items.map((line) => line.menuItemId) }, tx);
    for (const line of data.items) {
      // Absent from the tenant's catalogue: unknown id and another tenant's id are the same answer.
      if (!catalogue.has(line.menuItemId)) throw new NotFoundError("Menu item not found");
    }

    const priced = priceLines(data.items as CartLine[], catalogue as ReadonlyMap<string, CatalogueItem>);
    const lines: NewOrderLine[] = priced.lines.map((line) => ({
      menuItemId: line.menuItemId,
      variantId: line.variantId,
      kitchenSectionId: line.kitchenSectionId,
      itemNameSnapshot: line.itemName,
      variantNameSnapshot: line.variantName,
      unitPriceSnapshot: line.unitPrice,
      addonsTotalSnapshot: line.addonsTotal,
      taxRateSnapshot: line.taxRate,
      quantity: line.quantity,
      lineSubtotal: line.lineSubtotal,
      lineTax: line.lineTax,
      lineTotal: line.lineTotal,
      specialInstructions: line.specialInstructions,
      addons: line.addons.map((addon) => ({ addonId: addon.id, nameSnapshot: addon.name, priceSnapshot: addon.price })),
    }));

    const customerId = data.customerId ? await linkExistingCustomer(tx, ctx, data.customerId) : null;
    const created = await insertOrder(tx, ctx, {
      idempotencyKey: data.idempotencyKey,
      orderType: data.orderType,
      priority: data.priority,
      businessDate,
      tableLabel: data.tableLabel,
      notes: data.notes,
      subtotalAmount: priced.subtotalAmount,
      taxAmount: priced.taxAmount,
      totalAmount: priced.totalAmount,
      customerId,
      customer: data.customer
        ? { fullName: data.customer.name, phoneE164: data.customer.phone, email: data.customer.email, notes: data.customer.notes }
        : null,
      lines,
    });

    // Dine-in with a table: the order joins that table's open bill (or opens one) in this same transaction.
    await placeOrderOnTableBill(tx, ctx, { id: created.id, orderType: data.orderType, tableLabel: data.tableLabel }, data.expectedTableSessionId, businessDate);

    if (data.sendToKitchen) {
      await acceptNewOrder(tx, ctx, created.id);
      await generateKotsForRound(tx, ctx, created.id, 1, { print: data.printKot });
    }

    return { order: await readOrder(tx, ctx, created.id), replayed: false };
  });
}

/**
 * SA-ORD-02 / SA-ORD-03 (S1-P12-T005): the only code that moves an order between statuses on request. One step with
 * optimistic concurrency on `orders.version`; the caller has already checked the permission for the target
 * (`orderTransitionPermission`). The shared table (`lib/auth/transitions.ts`) decides INVALID_TRANSITION (409) and the
 * row-29 cancel restriction (403) against the current status. Business guards: COMPLETED requires PAID (BR-ORD-06,
 * Q-007 A → 422 PAYMENT_REQUIRED); cancelling requires a reason and nothing paid net of refunds (409 REFUND_REQUIRED).
 * READY requires every ticket of the latest round READY/SERVED. An order already in the target status is a no-op.
 * Audits `order.status_changed` / `order.cancelled`, generates tickets on ACCEPTED and cancels open tickets on
 * CANCELLED — all in the same transaction.
 */
export async function updateOrderStatus(ctx: TenantContext, data: UpdateOrderStatusData): Promise<{ orderId: string; status: OrderStatus; version: number }> {
  const cancelling = data.status === OrderStatus.CANCELLED;
  const reason = cancelling ? data.reason : null;
  if (cancelling && (!reason || reason.length < CANCEL_REASON_MIN_LENGTH)) {
    throw new ValidationError("Check the highlighted fields.", {
      reason: [`Enter a reason of at least ${CANCEL_REASON_MIN_LENGTH} characters to cancel an order.`],
    });
  }

  const result = await applyOrderTransition(
    ctx,
    { orderId: data.orderId, to: data.status, reason, expectedVersion: data.expectedVersion },
    async (current, tx) => {
      assertTransitionAllowed(ctx, "order", current.status, data.status);
      if (data.status === OrderStatus.READY) {
        // security.md §3.4: READY only when every ticket of the latest round is READY or SERVED (normally automatic).
        const kots = await latestRoundKotStatuses(tx, ctx, current.id);
        if (kots.some((s) => s !== "READY" && s !== "SERVED")) {
          throw new ConflictError("Some kitchen tickets are still being prepared.", "INVALID_TRANSITION");
        }
      }
      if (data.status === OrderStatus.COMPLETED && current.paymentStatus !== PaymentStatus.PAID) {
        throw new ValidationError("Record the full payment before completing the order.", undefined, "PAYMENT_REQUIRED");
      }
      if (cancelling && current.paidAmount.minus(current.refundedAmount).gt(0)) {
        throw new ConflictError("Refund the payments on this order before cancelling it.", "REFUND_REQUIRED");
      }
    },
    // Same transaction (S1-P14-T001/T003): acceptance creates the round-1 tickets, cancellation cancels open tickets.
    async (tx, orderId) => {
      if (data.status === OrderStatus.ACCEPTED) await generateKotsForRound(tx, ctx, orderId, 1);
      if (cancelling) await cancelKotsWithOrder(tx, ctx, orderId);
    },
  );
  if (!result.changed) return { orderId: result.orderId, status: result.status, version: result.version };

  logger.info("order.status_changed", {
    requestId: ctx.requestId,
    tenantId: ctx.tenantId,
    orderId: result.orderId,
    orderNumber: result.orderNumber,
    from: result.from,
    to: result.status,
  });

  return { orderId: result.orderId, status: result.status, version: result.version };
}

/**
 * COMPLETED → REFUNDED happens automatically when an order's payments are refunded in full (security.md §3.4). The
 * payment service applies this inside its ledger transaction; the rule lives here with the rest of the state machine.
 */
export function statusAfterRefund(order: { status: OrderStatus; paidAmount: Prisma.Decimal }, refundedAmount: Prisma.Decimal): OrderStatus | null {
  return order.status === OrderStatus.COMPLETED && refundedAmount.gte(order.paidAmount) ? OrderStatus.REFUNDED : null;
}

/** LD-ORD-01 (interim): the context tenant's orders, newest first; KITCHEN gets the kitchen projection. */
export async function getTenantOrders(ctx: TenantContext, filters: ListOrdersData): Promise<OrderDto[]> {
  const kitchen = ctx.role === "KITCHEN";
  const orders = await listOrders(ctx, { status: filters.status, search: filters.search, searchCustomers: !kitchen });
  return kitchen ? orders.map(kitchenProjection) : orders;
}

/** LD-CUS-01 (interim): the context tenant's customers. */
export async function getTenantCustomers(ctx: TenantContext, filters: ListCustomersData): Promise<CustomerListItemDto[]> {
  return listCustomers(ctx, { search: filters.query });
}

// ─── Board and detail (S1-P12-T006) ───

/** security.md §3.3 row 23: the kitchen sees the work, never the customer or the money. */
function kitchenBoardProjection(item: OrderBoardItem): OrderBoardItem {
  return { ...item, customerName: null, totalAmount: null, paymentStatus: null };
}

/**
 * LD-ORD-01 / RH-ORD-01 (S1-P12-T006). One function serves the first render and every poll: without `since` it is the
 * working board (active queue urgent-first, then today's closed orders), with `since` the delta from that cursor.
 * KITCHEN receives the kitchen projection in both cases, and no search ever reaches a customer name for that role.
 */
export async function getOrderBoard(ctx: TenantContext, query: Partial<OrderPollData> = {}): Promise<OrderBoardPage> {
  const kitchen = ctx.role === "KITCHEN";
  const page = await orderBoard(ctx, {
    status: query.status,
    type: query.type,
    search: query.q,
    searchCustomers: !kitchen,
    since: query.since,
    businessDate: businessDateFor(new Date(), ctx.restaurant.timezone),
    limit: query.limit,
  });
  return kitchen ? { ...page, items: page.items.map(kitchenBoardProjection) } : page;
}

/**
 * What the caller may do with an order right now (api.md LD-ORD-02 "allowed next actions for caller"). Computed from
 * the same transition table the service enforces (`lib/auth/transitions.ts`), so a hidden button and a refused request
 * can never disagree. This is UX only: the server re-checks on every request (SC-RBAC-08).
 */
export type OrderAction = OrderTransitionTarget | "SET_PRIORITY" | "SET_HIGH_PRIORITY" | "SET_CUSTOMER";

/** Statuses after which nothing more happens to an order; its metadata is frozen with it. */
const TERMINAL_ORDER_STATUSES = new Set<OrderStatus>([OrderStatus.COMPLETED, OrderStatus.CANCELLED, OrderStatus.REFUNDED]);

export function allowedOrderActions(ctx: TenantContext, order: { status: OrderStatus }): OrderAction[] {
  const actions: OrderAction[] = allowedNextStatuses(ctx, "order", order.status).filter((target): target is OrderTransitionTarget =>
    (ORDER_TRANSITION_TARGETS as readonly string[]).includes(target),
  );
  const open = !TERMINAL_ORDER_STATUSES.has(order.status);
  if (open && hasPermission(ctx, "order:update_meta")) {
    actions.push("SET_PRIORITY");
    if (PRIORITY_ROLES.has(ctx.role)) actions.push("SET_HIGH_PRIORITY");
    if (hasPermission(ctx, "customer:read")) actions.push("SET_CUSTOMER");
  }
  return actions;
}

/**
 * The transitions this caller may request from each status, resolved once on the server so a live board can label its
 * cards without asking again and without deciding anything itself (SC-RBAC-08: the server re-checks every request).
 */
export function allowedOrderTransitions(ctx: TenantContext): Record<OrderStatus, OrderTransitionTarget[]> {
  const table = {} as Record<OrderStatus, OrderTransitionTarget[]>;
  for (const status of Object.values(OrderStatus)) {
    table[status] = allowedNextStatuses(ctx, "order", status).filter((target): target is OrderTransitionTarget =>
      (ORDER_TRANSITION_TARGETS as readonly string[]).includes(target),
    );
  }
  return table;
}

export type OrderDetailView = {
  order: OrderDetailDto;
  timeline: OrderTimelineEntry[];
  allowedActions: OrderAction[];
  /** True when the caller holds `transaction:read` and may see amounts and the payment state. */
  canSeeMoney: boolean;
};

/**
 * LD-ORD-02 (S1-P12-T006). A missing id and another tenant's id are the same NOT_FOUND (SC-TEN-04). KITCHEN gets the
 * kitchen projection — no customer, no amounts — and the activity list only for roles that may read the audit trail
 * of their own order (every role may see the status history of an order it can open; amounts are stripped instead).
 */
export async function getOrderDetail(ctx: TenantContext, orderId: string): Promise<OrderDetailView> {
  const detail = required(await findOrderDetail(ctx, orderId), "Order");
  const kitchen = ctx.role === "KITCHEN";
  const canSeeMoney = !kitchen && hasPermission(ctx, "transaction:read");
  const timeline = await orderTimeline(ctx, orderId);
  return {
    order: kitchen ? kitchenDetailProjection(detail) : detail,
    timeline,
    allowedActions: allowedOrderActions(ctx, detail),
    canSeeMoney,
  };
}

function kitchenDetailProjection(order: OrderDetailDto): OrderDetailDto {
  return {
    ...order,
    paymentStatus: null,
    subtotalAmount: null,
    taxAmount: null,
    discountAmount: null,
    totalAmount: null,
    paidAmount: null,
    refundedAmount: null,
    balanceDue: null,
    customer: null,
    lines: order.lines.map((line) => ({
      ...line,
      unitPriceSnapshot: null,
      addonsTotalSnapshot: null,
      taxRateSnapshot: null,
      lineSubtotal: null,
      lineTax: null,
      lineTotal: null,
      addons: line.addons.map((addon) => ({ ...addon, price: null })),
    })),
  };
}

// ─── Order entry catalogue and quote (S1-P12-T007) ───

export type PosCatalogueItem = {
  id: string;
  categoryId: string;
  name: string;
  priceFrom: string;
  dietaryType: MenuItemListRowDto["dietaryType"];
  iconKey: string | null;
  imageUrl: string | null;
  hasOptions: boolean;
  isDailyMenu: boolean;
};

export type OrderEntryCatalogue = {
  categories: Array<{ id: string; name: string; itemCount: number }>;
  items: PosCatalogueItem[];
  /** True when the tenant has more orderable items than one page: the POS then tells the user to search. */
  hasMore: boolean;
  defaults: { orderType: OrderType; currencyCode: string; timezone: string };
};

/** One page of the POS grid. Restaurants far beyond this search instead of scrolling. */
const CATALOGUE_PAGE = 300;

/**
 * LD-ORD-03 (S1-P12-T007): everything the POS grid needs — the tenant's published, available, non-archived items
 * grouped by category, today's published daily-menu items marked for highlighting, and the restaurant's defaults.
 * Prices are two-decimal strings for display only; the order is still priced entirely by the server (ADR-010 §3).
 */
export async function getOrderEntryCatalogue(ctx: TenantContext): Promise<OrderEntryCatalogue> {
  const [categories, page, dailyMenu, settings] = await Promise.all([
    listMenuCategories(ctx, { archived: false }),
    listMenuItems(ctx, { published: true, available: true, archived: false, limit: CATALOGUE_PAGE }),
    publishedMenuForToday(ctx),
    getRestaurantSettingsSnapshot(ctx),
  ]);

  const highlighted = new Set((dailyMenu?.items ?? []).map((item) => item.menuItemId));
  const items: PosCatalogueItem[] = page.rows.map((row) => ({
    id: row.id,
    categoryId: row.categoryId,
    name: row.name,
    priceFrom: row.priceFrom,
    dietaryType: row.dietaryType,
    iconKey: row.iconKey,
    imageUrl: row.imageUrl,
    hasOptions: row.variantCount > 0 || row.addonCount > 0,
    isDailyMenu: highlighted.has(row.id),
  }));

  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.categoryId, (counts.get(item.categoryId) ?? 0) + 1);

  return {
    categories: categories
      .filter((category) => (counts.get(category.id) ?? 0) > 0)
      .map((category) => ({ id: category.id, name: category.name, itemCount: counts.get(category.id) ?? 0 })),
    items,
    hasMore: page.hasMore,
    defaults: {
      orderType: settings.restaurant.defaultOrderType,
      currencyCode: ctx.restaurant.currencyCode,
      timezone: ctx.restaurant.timezone,
    },
  };
}

export type OrderQuote = {
  lines: Array<{ menuItemId: string; variantId: string | null; itemName: string; variantName: string | null; quantity: number; lineSubtotal: string; lineTax: string; lineTotal: string }>;
  subtotalAmount: string;
  taxAmount: string;
  totalAmount: string;
  currencyCode: string;
};

/**
 * The running total of a cart, priced by the server from the tenant's own catalogue and returned as decimal strings
 * (S1-P12-T007). Nothing is written and no counter moves: it is `createOrder`'s pricing step on its own, so the POS
 * never multiplies a price in the browser. The same 404/422 answers as SA-ORD-01 apply to a bad line.
 */
export async function quoteOrder(ctx: TenantContext, data: QuoteOrderData): Promise<OrderQuote> {
  const catalogue = await loadOrderCatalogue(ctx, { itemIds: data.items.map((line) => line.menuItemId) });
  for (const line of data.items) {
    if (!catalogue.has(line.menuItemId)) throw new NotFoundError("Menu item not found");
  }
  const priced = priceLines(data.items as CartLine[], catalogue as ReadonlyMap<string, CatalogueItem>);
  return {
    lines: priced.lines.map((line) => ({
      menuItemId: line.menuItemId,
      variantId: line.variantId,
      itemName: line.itemName,
      variantName: line.variantName,
      quantity: line.quantity,
      lineSubtotal: line.lineSubtotal.toFixed(2),
      lineTax: line.lineTax.toFixed(2),
      lineTotal: line.lineTotal.toFixed(2),
    })),
    subtotalAmount: priced.subtotalAmount.toFixed(2),
    taxAmount: priced.taxAmount.toFixed(2),
    totalAmount: priced.totalAmount.toFixed(2),
    currencyCode: ctx.restaurant.currencyCode,
  };
}

// ─── Order metadata (S1-P15-T003) ───

/**
 * SA-ORD-06 (S1-P15-T003) — flag an order urgent for the kitchen. `order:update_meta` is checked by the caller;
 * marking an order HIGH additionally needs a role that may do it (api.md SA-ORD-06: a WAITER may not), which is the
 * same rule `createOrder` applies. The order and every ticket still open take the new priority in one transaction, so
 * the kitchen board reorders on its next poll, and `order.priority_changed` is audited with it.
 */
export async function setOrderPriority(ctx: TenantContext, data: SetOrderPriorityData): Promise<{ orderId: string; priority: OrderPriority; ticketsUpdated: number }> {
  if (data.priority === OrderPriority.HIGH && !PRIORITY_ROLES.has(ctx.role)) {
    throw new ForbiddenError("Only a manager or cashier can mark an order urgent.");
  }

  return withTx(ctx, async (tx) => {
    const order = required(await findOrderMeta(tx, ctx, data.orderId), "Order");
    if (TERMINAL_ORDER_STATUSES.has(order.status)) {
      throw new ConflictError("This order is closed, so its priority can no longer change.", "INVALID_TRANSITION");
    }
    if (order.priority === data.priority) return { orderId: order.id, priority: order.priority, ticketsUpdated: 0 };

    const ticketsUpdated = await applyOrderPriority(tx, ctx, order.id, data.priority);
    await audit(tx, ctx, {
      action: "order.priority_changed",
      resourceType: "order",
      resourceId: order.id,
      before: { priority: order.priority },
      after: { priority: data.priority, ticketsUpdated },
    });
    logger.info("order.priority_changed", { requestId: ctx.requestId, tenantId: ctx.tenantId, orderId: order.id, from: order.priority, to: data.priority, ticketsUpdated });
    return { orderId: order.id, priority: data.priority, ticketsUpdated };
  });
}

/**
 * SA-ORD-05 (S1-P15-T003) — link the order to one of the caller's own customers, or unlink it. A customer of another
 * tenant is NOT_FOUND, exactly like an unknown id (SC-TEN-04), and the customer's own profile is never written
 * (BR-CUST-02). Audits `order.customer_linked`.
 */
export async function setOrderCustomer(ctx: TenantContext, data: SetOrderCustomerData): Promise<{ orderId: string; customerId: string | null }> {
  return withTx(ctx, async (tx) => {
    const order = required(await findOrderMeta(tx, ctx, data.orderId), "Order");
    const customerId = data.customerId === null ? null : await linkExistingCustomer(tx, ctx, data.customerId);
    if (order.customerId === customerId) return { orderId: order.id, customerId };

    await applyOrderCustomer(tx, ctx, order.id, customerId);
    await audit(tx, ctx, {
      action: "order.customer_linked",
      resourceType: "order",
      resourceId: order.id,
      before: { customerId: order.customerId },
      after: { customerId },
    });
    return { orderId: order.id, customerId };
  });
}
