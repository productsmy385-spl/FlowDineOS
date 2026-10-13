import "server-only";
import { OrderType } from "@prisma/client";
import type { TenantContext } from "@/lib/auth/context-types";
import { audit } from "@/lib/audit/write";
import { tableKeyOf } from "@/lib/billing/table-bill";
import { formatBillNumber, nextNumber } from "@/lib/data/counters";
import { insertSession, joinSession, lockOpenSessionOfTable } from "@/lib/data/table-sessions";
import type { Tx } from "@/lib/data/tx";
import { ConflictError } from "@/lib/errors";

/**
 * Putting a new order on its table's bill (RASOIOS-ADR-027). Kept apart from `table-sessions.ts` because the order
 * service calls it from inside the order's own transaction.
 */
export type TablePlacement = { tableSessionId: string; billNumber: string; opened: boolean };

/**
 * Inside the order's transaction: puts a dine-in order with a table on that table's OPEN bill, opening one if the table
 * has none. Takeaway, delivery and an order without a table get no bill (null).
 *
 * `expected` is what the person placing the order was shown (`createOrderSchema.expectedTableSessionId`): the open
 * bill's id, or null for "a new bill will open". If the table's bill is no longer that one, the whole order is refused
 * (409), so it can never silently join a bill that was just settled, or start a second one beside an open bill.
 * Omitted (`undefined`) keeps the simple rule: join the open bill, or open one.
 */
export async function placeOrderOnTableBill(
  tx: Tx,
  ctx: TenantContext,
  order: { id: string; orderType: OrderType; tableLabel: string | null },
  expected: string | null | undefined,
  businessDate: Date,
): Promise<TablePlacement | null> {
  if (order.orderType !== OrderType.DINE_IN || !order.tableLabel) return null;
  const tableKey = tableKeyOf(order.tableLabel);
  const open = await lockOpenSessionOfTable(tx, ctx, tableKey);

  if (open) {
    if (expected === null) {
      throw new ConflictError(`Table ${open.tableLabel} already has an open bill (${open.billNumber}). Add this order to it, or settle it first.`, "TABLE_HAS_OPEN_BILL", {
        tableSessionId: open.id,
      });
    }
    if (expected !== undefined && expected !== open.id) {
      throw new ConflictError(`Table ${open.tableLabel}'s bill changed. Check the table and place the order again.`, "TABLE_BILL_CHANGED", { tableSessionId: open.id });
    }
    await joinSession(tx, ctx, open, order.id);
    await audit(tx, ctx, {
      action: "table_session.order_joined",
      resourceType: "table_session",
      resourceId: open.id,
      after: { orderId: order.id, billNumber: open.billNumber, tableLabel: open.tableLabel },
    });
    return { tableSessionId: open.id, billNumber: open.billNumber, opened: false };
  }

  if (typeof expected === "string") {
    throw new ConflictError(`Table ${order.tableLabel}'s bill was settled or closed. Placing this order starts a new bill — check and place it again.`, "TABLE_BILL_CLOSED");
  }

  const billNumber = formatBillNumber(businessDate, await nextNumber(tx, ctx, "TABLE_BILL", businessDate));
  // The partial unique index refuses a second OPEN bill for this table if another order opened one at this instant;
  // that error rolls this order back and `createOrder` retries it once, when it joins the winner's bill.
  const session = await insertSession(tx, ctx, { tableLabel: order.tableLabel, tableKey, billNumber, businessDate });
  await joinSession(tx, ctx, session, order.id);
  await audit(tx, ctx, {
    action: "table_session.opened",
    resourceType: "table_session",
    resourceId: session.id,
    after: { billNumber, tableLabel: order.tableLabel, firstOrderId: order.id },
  });
  return { tableSessionId: session.id, billNumber, opened: true };
}
