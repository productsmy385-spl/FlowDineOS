import { OrderStatus, Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { allocatePayment, billTotals, groupBillLines, tableKeyOf, type BillOrderInput } from "@/lib/billing/table-bill";

/** RASOIOS-ADR-027 — table bill arithmetic: sums of stored snapshots, never re-priced. */
const d = (value: string) => new Prisma.Decimal(value);

function order(id: string, minutes: number, items: Array<[string, number, string]>, overrides: Partial<BillOrderInput> = {}): BillOrderInput {
  const lines = items.map(([name, quantity, unit], index) => {
    const lineSubtotal = d(unit).times(quantity);
    const lineTax = lineSubtotal.times("0.05").toDecimalPlaces(2);
    return {
      id: `${id}-l${index}`,
      name,
      kotRound: 1,
      quantity,
      unitPrice: d(unit),
      addonsTotal: d("0"),
      taxRate: d("5.00"),
      lineSubtotal,
      lineTax,
      lineTotal: lineSubtotal.plus(lineTax),
    };
  });
  const subtotal = lines.reduce((a, l) => a.plus(l.lineSubtotal), d("0"));
  const tax = lines.reduce((a, l) => a.plus(l.lineTax), d("0"));
  return {
    id,
    orderNumber: `20261013-${id}`,
    status: OrderStatus.ACCEPTED,
    createdAt: new Date(Date.UTC(2026, 9, 13, 12, minutes)),
    subtotalAmount: subtotal,
    taxAmount: tax,
    discountAmount: d("0"),
    totalAmount: subtotal.plus(tax),
    paidAmount: d("0"),
    refundedAmount: d("0"),
    items: lines,
    ...overrides,
  };
}

// The brief's example: 2 × biryani (₹400), then 1 × biryani + 2 × cool drink (₹260).
const first = order("0001", 0, [["Chicken Biryani", 2, "200.00"]]);
const second = order("0002", 15, [["Chicken Biryani", 1, "200.00"], ["Cool Drink", 2, "30.00"]]);

describe("billTotals", () => {
  it("adds the orders' own snapshots", () => {
    const totals = billTotals([first, second]);
    expect(totals.subtotal.toFixed(2)).toBe("660.00");
    expect(totals.tax.toFixed(2)).toBe("33.00");
    expect(totals.total.toFixed(2)).toBe("693.00");
    expect(totals.balance.toFixed(2)).toBe("693.00");
  });

  it("counts an order once however many times it is passed in", () => {
    expect(billTotals([first, second, first, second]).total.toFixed(2)).toBe("693.00");
  });

  it("leaves cancelled and refunded orders out of what is owed", () => {
    const cancelled = { ...second, status: OrderStatus.CANCELLED };
    const refunded = order("0003", 20, [["Cool Drink", 1, "30.00"]], { status: OrderStatus.REFUNDED, paidAmount: d("31.50"), refundedAmount: d("31.50") });
    expect(billTotals([first, cancelled, refunded]).balance.toFixed(2)).toBe("420.00");
  });

  it("subtracts what has been paid and adds back what was refunded", () => {
    const part = { ...first, paidAmount: d("100.00"), refundedAmount: d("20.00") };
    expect(billTotals([part, second]).balance.toFixed(2)).toBe("613.00");
  });
});

describe("groupBillLines", () => {
  it("shows identical items at the same price as one line, keeping each source order", () => {
    const lines = groupBillLines([first, second]);
    const biryani = lines.find((l) => l.name === "Chicken Biryani")!;
    expect(biryani.quantity).toBe(3);
    expect(biryani.lineSubtotal.toFixed(2)).toBe("600.00");
    expect(biryani.sources.map((s) => s.orderNumber)).toEqual(["20261013-0001", "20261013-0002"]);
    expect(lines.find((l) => l.name === "Cool Drink")!.quantity).toBe(2);
  });

  it("keeps an item sold at a different price on its own line (historical price)", () => {
    const repriced = order("0004", 30, [["Chicken Biryani", 1, "220.00"]]);
    const lines = groupBillLines([first, repriced]).filter((l) => l.name === "Chicken Biryani");
    expect(lines.map((l) => l.unitPrice.toFixed(2)).sort()).toEqual(["200.00", "220.00"]);
  });

  it("line totals add up to the bill's subtotal plus tax", () => {
    const sum = groupBillLines([first, second]).reduce((a, l) => a.plus(l.lineTotal), d("0"));
    const totals = billTotals([first, second]);
    expect(sum.toFixed(2)).toBe(totals.subtotal.plus(totals.tax).toFixed(2));
  });
});

describe("allocatePayment", () => {
  it("pays the oldest order first, each up to what it owes, exactly the amount", () => {
    const parts = allocatePayment([second, first], d("500.00"));
    expect(parts.map((p) => [p.orderId, p.amount.toFixed(2)])).toEqual([
      ["0001", "420.00"],
      ["0002", "80.00"],
    ]);
  });

  it("skips orders that owe nothing and refuses more than the bill owes", () => {
    const paid = { ...first, paidAmount: first.totalAmount };
    expect(allocatePayment([paid, second], d("50.00")).map((p) => p.orderId)).toEqual(["0002"]);
    expect(() => allocatePayment([first], d("1000.00"))).toThrow(RangeError);
  });
});

describe("tableKeyOf", () => {
  it("treats case and spacing as the same table", () => {
    expect(tableKeyOf("  table   1 ")).toBe("TABLE 1");
    expect(tableKeyOf("Table 1")).toBe(tableKeyOf("TABLE 1"));
    expect(tableKeyOf("T1")).not.toBe(tableKeyOf("T 1"));
  });
});
