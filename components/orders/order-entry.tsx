"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CircleCheck, Clock, MonitorSmartphone, Plus, Printer, Trash2, TriangleAlert, type LucideIcon } from "lucide-react";
import type { OrderType } from "@prisma/client";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Drawer } from "@/components/ui/drawer";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { Checkbox, SearchField, Select, TextArea, TextField } from "@/components/ui/inputs";
import { useToast } from "@/components/ui/toast";
import { EmptyState } from "@/components/states/empty-state";
import type { OrderEntryCatalogue, OrderQuote } from "@/lib/services/orders";
import type { KitchenDispatch, KotDispatchState } from "@/lib/services/printing";
import { formatMoney, localeForCountry } from "@/lib/ui/format";
import { DOMAIN_ICONS, MENU_ICONS, isMenuIconKey } from "@/lib/ui/icons";
import { useConsoleSession } from "@/lib/ui/session-context";
import { useIdempotencyKey } from "@/lib/ui/use-idempotency-key";
import { createStaffOrderAction, quoteOrderAction } from "@/app/restaurant/orders/actions";
import { lookupTableBillAction } from "@/app/restaurant/orders/table-actions";
import { ORDER_TYPE_LABELS } from "./order-labels";
import { PosItemDialog, type ChosenLine } from "./pos-item-dialog";
import { QuantityStepper } from "./quantity-stepper";

/**
 * Order entry (S1-P12-T007; frontend.md §5.3 `/restaurant/orders/new`, api.md LD-ORD-03 / SA-ORD-01).
 *
 * Nothing about money is calculated here. The running total is `quoteOrderAction` — the server pricing the cart from
 * its own catalogue — and the confirmed totals come back with the saved order (ADR-010 §3). One idempotency key is
 * minted per submit attempt and reused on every retry, so a double tap or a lost response replays the same order
 * rather than creating a second one.
 */
type CartLine = ChosenLine & { key: string };

const ORDER_TYPES: OrderType[] = ["DINE_IN", "TAKEAWAY", "DELIVERY"];

type Saved = {
  id: string;
  orderNumber: string;
  status: string;
  totalAmount: string | null;
  currencyCode: string;
  kitchen: KitchenDispatch | null;
  printKot: boolean;
  tableBill: { id: string; billNumber: string; tableLabel: string; balance: string } | null;
};

/** The table's open bill as order entry last looked it up (RASOIOS-ADR-027). */
type TableBillLookup =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "none" }
  | { state: "open"; bill: { id: string; billNumber: string; tableLabel: string; orderCount: number; balance: string } }
  | { state: "error"; message: string };

const TABLE_BILL_CONFLICTS = new Set(["TABLE_HAS_OPEN_BILL", "TABLE_BILL_CLOSED", "TABLE_BILL_CHANGED"]);

/**
 * What the person who placed the order is told about each automatic KOT (never "printed" unless the agent said so).
 * The order is placed in every case — a printer problem is shown next to it, not instead of it.
 */
const DISPATCH_COPY: Record<KotDispatchState, { icon: LucideIcon; tone: string; text: (printer: string | null) => string }> = {
  QUEUED: { icon: Printer, tone: "text-status-success", text: (p) => `Sent to ${p ?? "the kitchen printer"}` },
  PRINTED: { icon: CircleCheck, tone: "text-status-success", text: (p) => `Printed on ${p ?? "the kitchen printer"}` },
  AGENT_OFFLINE: { icon: Clock, tone: "text-status-warning", text: (p) => `Queued — the print agent for ${p ?? "the printer"} is offline; it prints when the agent reconnects` },
  FAILED: { icon: TriangleAlert, tone: "text-status-danger", text: () => "Print failed — retry it from Printing" },
  NO_PRINTER: { icon: TriangleAlert, tone: "text-status-warning", text: () => "No printer for this station — on the kitchen screen only" },
  AUTO_PRINT_OFF: { icon: Clock, tone: "text-fg-secondary", text: () => "Automatic KOT printing is off — on the kitchen screen" },
  NOT_PRINTED: { icon: MonitorSmartphone, tone: "text-fg-secondary", text: () => "Sent to the kitchen screen only — not printed" },
};

function dispatchHeadline(kitchen: KitchenDispatch | null): string {
  if (!kitchen || kitchen.tickets.length === 0) return "";
  const states = kitchen.tickets.map((t) => t.state);
  if (states.every((s) => s === "QUEUED" || s === "PRINTED")) return " KOT sent to the kitchen.";
  if (states.some((s) => s === "AGENT_OFFLINE")) return " KOT queued — the print agent is offline.";
  return " KOT is on the kitchen screen.";
}

export function OrderEntry({
  catalogue,
  canSendToKitchen,
  canSetPriority,
  canCreateCustomer,
  initialTable = "",
  initialType,
  addToBill,
}: {
  catalogue: OrderEntryCatalogue;
  canSendToKitchen: boolean;
  canSetPriority: boolean;
  canCreateCustomer: boolean;
  /** Table to start with ("Start Order" on a table card). */
  initialTable?: string;
  /** Order type to start with (e.g. New order from the Takeaway view). */
  initialType?: OrderType;
  /**
   * "+ Add Items" to an open table bill (RASOIOS-ADR-027): the order is fixed to this table and this bill. It is placed
   * only on this bill — if the bill was settled or closed meanwhile the server refuses it, and nothing else is opened.
   */
  addToBill?: { id: string; billNumber: string; tableLabel: string; canViewBill: boolean };
}) {
  const router = useRouter();
  const toast = useToast();
  const session = useConsoleSession();
  const locale = localeForCountry(session?.activeTenant.countryCode);
  const currency = catalogue.defaults.currencyCode;
  const idempotency = useIdempotencyKey();

  const [categoryId, setCategoryId] = React.useState<string>("ALL");
  const [search, setSearch] = React.useState("");
  const [optionsFor, setOptionsFor] = React.useState<string | null>(null);
  const [lines, setLines] = React.useState<CartLine[]>([]);
  const [orderType, setOrderType] = React.useState<OrderType>(addToBill || initialTable ? "DINE_IN" : (initialType ?? catalogue.defaults.orderType));
  const [tableLabel, setTableLabel] = React.useState(addToBill?.tableLabel ?? initialTable);
  /** Add-items mode only: the server said this bill can no longer take orders. */
  const [billClosed, setBillClosed] = React.useState<string | null>(null);
  const [tableBill, setTableBill] = React.useState<TableBillLookup>({ state: "idle" });
  const [lookupNonce, setLookupNonce] = React.useState(0);
  const [notes, setNotes] = React.useState("");
  const [urgent, setUrgent] = React.useState(false);
  const [customerName, setCustomerName] = React.useState("");
  const [customerPhone, setCustomerPhone] = React.useState("");
  const [sendToKitchen, setSendToKitchen] = React.useState(canSendToKitchen);
  const [quote, setQuote] = React.useState<OrderQuote | null>(null);
  const [quoting, setQuoting] = React.useState(false);
  const [quoteError, setQuoteError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);
  const [lineErrors, setLineErrors] = React.useState<Record<number, string>>({});
  const [saved, setSaved] = React.useState<Saved | null>(null);
  const [panelOpen, setPanelOpen] = React.useState(false);

  const itemsById = React.useMemo(() => new Map(catalogue.items.map((item) => [item.id, item])), [catalogue.items]);
  const needle = search.trim().toLowerCase();
  const visibleItems = catalogue.items.filter(
    (item) => (categoryId === "ALL" || item.categoryId === categoryId) && (needle === "" || item.name.toLowerCase().includes(needle)),
  );

  // The running total is always the server's answer to the current cart.
  React.useEffect(() => {
    if (lines.length === 0) {
      setQuote(null);
      setQuoteError(null);
      return;
    }
    let live = true;
    setQuoting(true);
    const timer = setTimeout(async () => {
      const result = await quoteOrderAction({
        items: lines.map((line) => ({
          menuItemId: line.menuItemId,
          ...(line.variantId ? { variantId: line.variantId } : {}),
          addonIds: line.addonIds,
          quantity: line.quantity,
          ...(line.specialInstructions ? { specialInstructions: line.specialInstructions } : {}),
        })),
      });
      if (!live) return;
      setQuoting(false);
      if (result.ok) {
        setQuote(result.data);
        setQuoteError(null);
      } else {
        setQuote(null);
        setQuoteError(result.error.message);
      }
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [lines]);

  // Which bill a dine-in order for this table would join — shown before placing it, and sent with it, so the server can
  // refuse instead of silently joining a bill that was settled in the meantime (RASOIOS-ADR-027).
  const table = orderType === "DINE_IN" ? tableLabel.trim() : "";
  React.useEffect(() => {
    // Adding items to a known bill needs no lookup: the bill is fixed and the server checks it on placing.
    if (!table || addToBill) {
      setTableBill({ state: "idle" });
      return;
    }
    let live = true;
    setTableBill({ state: "loading" });
    const timer = setTimeout(async () => {
      const result = await lookupTableBillAction({ tableLabel: table });
      if (!live) return;
      if (!result.ok) setTableBill({ state: "error", message: result.error.message });
      else setTableBill(result.data ? { state: "open", bill: result.data } : { state: "none" });
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [table, lookupNonce, addToBill]);

  function addLine(line: ChosenLine) {
    setLines((current) => [...current, { ...line, key: crypto.randomUUID() }]);
    setOptionsFor(null);
    // A changed cart is a different order: the next submit needs its own key.
    idempotency.reset();
    setLineErrors({});
    setFormError(null);
  }

  function addSimple(itemId: string) {
    const item = itemsById.get(itemId);
    if (!item) return;
    addLine({ menuItemId: item.id, variantId: null, addonIds: [], quantity: 1, specialInstructions: null, label: item.name });
  }

  function setQuantity(key: string, quantity: number) {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, quantity } : line)));
    idempotency.reset();
  }

  function removeLine(key: string) {
    setLines((current) => current.filter((line) => line.key !== key));
    idempotency.reset();
    setLineErrors({});
  }

  function resetForNextOrder() {
    setLines([]);
    setTableLabel("");
    setNotes("");
    setUrgent(false);
    setCustomerName("");
    setCustomerPhone("");
    setQuote(null);
    setLineErrors({});
    setFormError(null);
    idempotency.reset();
  }

  async function submit(printKot: boolean) {
    if (lines.length === 0 || billClosed) return;
    if (!addToBill && table && (tableBill.state === "loading" || tableBill.state === "idle")) return;
    setSubmitting(true);
    setFormError(null);
    setLineErrors({});
    const expectedTableSessionId = addToBill
      ? addToBill.id
      : !table
        ? undefined
        : tableBill.state === "open"
          ? tableBill.bill.id
          : tableBill.state === "none"
            ? null
            : undefined;
    const result = await createStaffOrderAction({
      idempotencyKey: idempotency.current(),
      orderType,
      ...(table ? { tableLabel: table } : {}),
      ...(expectedTableSessionId === undefined ? {} : { expectedTableSessionId }),
      printKot,
      ...(notes.trim() ? { notes: notes.trim() } : {}),
      ...(urgent && canSetPriority ? { priority: "HIGH" as const } : {}),
      ...(!addToBill && canCreateCustomer && customerName.trim()
        ? { customer: { name: customerName.trim(), ...(customerPhone.trim() ? { phone: customerPhone.trim() } : {}) } }
        : {}),
      sendToKitchen: sendToKitchen && canSendToKitchen,
      items: lines.map((line) => ({
        menuItemId: line.menuItemId,
        ...(line.variantId ? { variantId: line.variantId } : {}),
        addonIds: line.addonIds,
        quantity: line.quantity,
        ...(line.specialInstructions ? { specialInstructions: line.specialInstructions } : {}),
      })),
    });
    setSubmitting(false);

    if (!result.ok && addToBill && TABLE_BILL_CONFLICTS.has(result.error.code)) {
      // The bill these items were for was settled or closed while the screen was open: nothing was saved, and no other
      // bill is opened from here. Staff go back to Dine-in and choose the table again.
      setBillClosed(result.error.message);
      idempotency.reset();
      return;
    }
    if (!result.ok && TABLE_BILL_CONFLICTS.has(result.error.code)) {
      // The table's bill changed since it was shown (settled, or opened by someone else): show the new state and let
      // the person decide; nothing was saved. The same cart is a new attempt, so it gets a new key.
      setFormError(result.error.message);
      idempotency.reset();
      setLookupNonce((n) => n + 1);
      return;
    }
    if (!result.ok) {
      // `items.<index>.<field>` from the pricing engine points at the offending line (api.md SA-ORD-01).
      const perLine: Record<number, string> = {};
      for (const [field, messages] of Object.entries(result.error.fieldErrors ?? {})) {
        const match = /^items\.(\d+)/.exec(field);
        if (match) perLine[Number(match[1])] = messages[0];
      }
      setLineErrors(perLine);
      setFormError(result.error.message);
      return;
    }

    const { order, kitchen } = result.data;
    // The bill the order is now on, as the server has it (its balance includes this order).
    const bill = table ? await lookupTableBillAction({ tableLabel: table }) : null;
    setSaved({
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      totalAmount: order.totalAmount,
      currencyCode: order.currencyCode,
      kitchen,
      printKot,
      tableBill: bill?.ok && bill.data ? { id: bill.data.id, billNumber: bill.data.billNumber, tableLabel: bill.data.tableLabel, balance: bill.data.balance } : null,
    });
    setPanelOpen(false);
    toast.success(
      order.status === "ACCEPTED"
        ? `Order ${order.orderNumber} placed.${printKot ? dispatchHeadline(kitchen) : " KOT sent to the kitchen screen — not printed."}`
        : `Order ${order.orderNumber} saved.`,
    );
    // The key has done its job; the next order is a new one.
    idempotency.reset();
    router.refresh();
  }

  if (saved) {
    return (
      <Card className="mx-auto max-w-dialog-form gap-4">
        <div className="flex items-center gap-3">
          <Icon icon={CircleCheck} size={32} className="text-status-success" />
          <div>
            <h2 className="text-heading text-fg-primary">Order {saved.orderNumber} {saved.status === "ACCEPTED" ? "placed" : "saved"}</h2>
            <p className="text-body text-fg-secondary">
              {saved.status === "ACCEPTED" ? (saved.printKot ? "Sent to the kitchen." : "Sent to the kitchen screen — not printed.") : "Waiting to be accepted."}
              {saved.totalAmount ? ` Total ${formatMoney(saved.totalAmount, saved.currencyCode, locale)}.` : ""}
            </p>
          </div>
        </div>
        {saved.tableBill && (
          <Alert tone="neutral" title={`On table ${saved.tableBill.tableLabel}'s bill ${saved.tableBill.billNumber}`}>
            The table now owes {formatMoney(saved.tableBill.balance, saved.currencyCode, locale)} in total. Take payment on the table bill.
          </Alert>
        )}
        {saved.kitchen && saved.kitchen.tickets.length > 0 && (
          <ul aria-label="Kitchen tickets" className="flex flex-col gap-2 rounded-xl border border-border-subtle p-3">
            {saved.kitchen.tickets.map((ticket) => {
              const copy = DISPATCH_COPY[ticket.state];
              return (
                <li key={ticket.kotNumber} className="flex items-start gap-3">
                  <Icon icon={copy.icon} size={20} className={`mt-0.5 shrink-0 ${copy.tone}`} />
                  <p className="text-body text-fg-primary">
                    <span className="text-label">KOT {ticket.kotNumber}</span>
                    {ticket.sectionName ? ` · ${ticket.sectionName}` : ""} — {copy.text(ticket.printerName)}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
        {addToBill ? (
          <div className="flex flex-wrap gap-3">
            {addToBill.canViewBill ? (
              <Link
                href={`/restaurant/orders/tables/${addToBill.id}`}
                className="inline-flex h-12 items-center rounded-xl bg-action-primary px-5 text-subheading text-action-primary-fg hover:bg-action-primary-hover"
              >
                View table bill
              </Link>
            ) : (
              <Link
                href="/restaurant/dine-in"
                className="inline-flex h-12 items-center rounded-xl bg-action-primary px-5 text-subheading text-action-primary-fg hover:bg-action-primary-hover"
              >
                Back to Dine-in
              </Link>
            )}
            <Button
              variant="secondary"
              size="lg"
              icon={Plus}
              onClick={() => {
                setSaved(null);
                resetForNextOrder();
                setOrderType("DINE_IN");
                setTableLabel(addToBill.tableLabel);
              }}
            >
              Add more items
            </Button>
          </div>
        ) : (
        <div className="flex flex-wrap gap-3">
          {saved.tableBill ? (
            <Link
              href={`/restaurant/orders/tables/${saved.tableBill.id}`}
              className="inline-flex h-12 items-center rounded-xl bg-action-primary px-5 text-subheading text-action-primary-fg hover:bg-action-primary-hover"
            >
              Open table bill
            </Link>
          ) : (
            <Link
              href={`/restaurant/orders/${saved.id}`}
              className="inline-flex h-12 items-center rounded-xl bg-action-primary px-5 text-subheading text-action-primary-fg hover:bg-action-primary-hover"
            >
              View order
            </Link>
          )}
          {saved.tableBill && (
            <Button
              variant="secondary"
              size="lg"
              onClick={() => {
                const keepTable = saved.tableBill!.tableLabel;
                setSaved(null);
                resetForNextOrder();
                setOrderType("DINE_IN");
                setTableLabel(keepTable);
              }}
            >
              Add another order to this table
            </Button>
          )}
          <Button
            variant="secondary"
            size="lg"
            onClick={() => {
              setSaved(null);
              resetForNextOrder();
            }}
          >
            New order
          </Button>
          <Link href="/restaurant/orders" className="inline-flex h-12 items-center text-label text-fg-accent hover:underline">
            Back to the board
          </Link>
        </div>
        )}
      </Card>
    );
  }

  if (catalogue.items.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={DOMAIN_ICONS.menu}
          title="No items available to order"
          description="Publish at least one available menu item before taking orders."
          action={{ href: "/restaurant/menu", label: "Open the menu" }}
        />
      </Card>
    );
  }

  // A dine-in order waits for the table lookup, so it is always placed knowing which bill it joins. Adding to a known
  // bill needs no lookup; a bill the server reported closed takes nothing more from this screen.
  const tableBusy = Boolean(billClosed) || (!addToBill && Boolean(table) && (tableBill.state === "loading" || tableBill.state === "idle"));

  const orderPanel = (
    <div className="flex flex-col gap-4">
      {addToBill ? (
        <div className="rounded-xl border border-action-primary/40 bg-action-primary/8 p-3">
          <p className="text-subheading text-fg-primary">Table {addToBill.tableLabel}</p>
          <p className="text-caption text-fg-secondary">
            Adding to bill <span className="text-numeric">{addToBill.billNumber}</span> — a new order with its own KOT.
          </p>
        </div>
      ) : (
        <Select
          label="Order type"
          size="touch"
          value={orderType}
          onChange={(event) => setOrderType(event.target.value as OrderType)}
          options={ORDER_TYPES.map((type) => ({ value: type, label: ORDER_TYPE_LABELS[type] }))}
        />
      )}
      {billClosed && (
        <Alert tone="warning" title="This bill can't take more items">
          <span className="block">{billClosed}</span>
          <Link href="/restaurant/dine-in" className="mt-2 inline-flex text-label text-fg-accent hover:underline">
            Back to Dine-in
          </Link>
        </Alert>
      )}
      {!addToBill && orderType === "DINE_IN" && (
        <TextField
          label="Table"
          size="touch"
          maxLength={20}
          value={tableLabel}
          onChange={(event) => {
            setTableLabel(event.target.value);
            setFormError(null);
          }}
          help="Letters, digits, spaces and dashes."
        />
      )}
      {!addToBill && table && (
        <p role="status" aria-live="polite" className="-mt-2 text-caption">
          {tableBill.state === "loading" || tableBill.state === "idle" ? (
            <span className="text-fg-secondary">Checking table {table}…</span>
          ) : tableBill.state === "open" ? (
            <span className="text-fg-primary">
              Adds to table {tableBill.bill.tableLabel}&apos;s open bill {tableBill.bill.billNumber} ({tableBill.bill.orderCount}{" "}
              {tableBill.bill.orderCount === 1 ? "order" : "orders"}, {formatMoney(tableBill.bill.balance, currency, locale)} due).
            </span>
          ) : tableBill.state === "none" ? (
            <span className="text-fg-secondary">Starts a new bill for table {table}.</span>
          ) : (
            <span className="text-status-danger">{tableBill.message}</span>
          )}
        </p>
      )}

      {lines.length === 0 ? (
        <p className="text-body text-fg-secondary">No items yet. Tap a tile to start the order.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border-subtle">
          {lines.map((line, index) => (
            <li key={line.key} className="flex flex-col gap-2 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-label text-fg-primary">{line.label}</p>
                  {line.addonIds.length > 0 && <p className="text-caption text-fg-secondary">{line.addonIds.length} add-on(s)</p>}
                  {line.specialInstructions && <p className="text-caption text-status-warning">{line.specialInstructions}</p>}
                  {lineErrors[index] && (
                    <p role="alert" className="text-caption text-status-danger">
                      {lineErrors[index]}
                    </p>
                  )}
                </div>
                <span className="shrink-0 text-label text-numeric text-fg-primary">
                  {quote?.lines[index] ? formatMoney(quote.lines[index].lineTotal, quote.currencyCode, locale) : "—"}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <QuantityStepper label={line.label} value={line.quantity} onChange={(next) => setQuantity(line.key, next)} />
                <IconButton icon={Trash2} size="lg" variant="ghost" aria-label={`Remove ${line.label}`} onClick={() => removeLine(line.key)} />
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-col gap-2 border-t border-border-subtle pt-4">
        <p className="text-caption text-fg-secondary">{addToBill ? "This new order — priced by the server; the table bill adds it" : "Running total — priced by the server"}</p>
        {quoteError && <Alert tone="danger">{quoteError}</Alert>}
        <dl className="flex flex-col gap-1">
          <div className="flex justify-between gap-4">
            <dt className="text-body text-fg-secondary">Subtotal</dt>
            <dd className="text-body text-numeric text-fg-primary">{quote ? formatMoney(quote.subtotalAmount, quote.currencyCode, locale) : "—"}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-body text-fg-secondary">Tax</dt>
            <dd className="text-body text-numeric text-fg-primary">{quote ? formatMoney(quote.taxAmount, quote.currencyCode, locale) : "—"}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-subheading text-fg-primary">Total</dt>
            <dd className="text-subheading text-numeric text-fg-primary">
              {quote ? formatMoney(quote.totalAmount, quote.currencyCode, locale) : quoting ? "Pricing…" : "—"}
            </dd>
          </div>
        </dl>
      </div>

      {canCreateCustomer && !addToBill && (
        <div className="flex flex-col gap-3 border-t border-border-subtle pt-4">
          <TextField label="Customer name" size="touch" maxLength={120} value={customerName} onChange={(event) => setCustomerName(event.target.value)} help="Optional." />
          <TextField
            label="Customer phone"
            size="touch"
            inputMode="tel"
            value={customerPhone}
            onChange={(event) => setCustomerPhone(event.target.value)}
            help="International format, e.g. +919876543210."
          />
        </div>
      )}

      <TextArea label="Note for this order" rows={2} maxLength={500} showCount value={notes} onChange={(event) => setNotes(event.target.value)} />

      {canSetPriority && (
        <Checkbox size="touch" label="Mark urgent for the kitchen" checked={urgent} onChange={(event) => setUrgent(event.target.checked)} />
      )}
      {canSendToKitchen && (
        <Checkbox size="touch" label="Send the KOT to the kitchen now" checked={sendToKitchen} onChange={(event) => setSendToKitchen(event.target.checked)} />
      )}

      {formError && <Alert tone="danger">{formError}</Alert>}

      {sendToKitchen && canSendToKitchen ? (
        // The print choice (RASOIOS-ADR-027): both save the order and put its KOT on the kitchen screen; only the first
        // sends it to the kitchen printer. Printing is the default, as before.
        <div className="flex flex-col gap-2">
          <Button
            variant="primary"
            size="touch"
            className="w-full"
            icon={Printer}
            loading={submitting}
            loadingLabel="Placing order…"
            disabled={lines.length === 0 || tableBusy}
            onClick={() => void submit(true)}
          >
            Send to KOT + Print
          </Button>
          <Button
            variant="secondary"
            size="touch"
            className="w-full"
            icon={MonitorSmartphone}
            disabled={lines.length === 0 || tableBusy || submitting}
            onClick={() => void submit(false)}
          >
            Send to KOT only (don&apos;t print)
          </Button>
          <p className="text-caption text-fg-secondary">&ldquo;KOT only&rdquo; shows the ticket on the kitchen screen without printing it.</p>
        </div>
      ) : (
        <Button
          variant="primary"
          size="touch"
          className="w-full"
          loading={submitting}
          loadingLabel="Saving…"
          disabled={lines.length === 0 || tableBusy}
          onClick={() => void submit(true)}
        >
          Save order
        </Button>
      )}
    </div>
  );

  return (
    <>
      {/* The sticky order bar below lg floats over the grid, so the grid keeps room for it. */}
      <div className="grid gap-4 pb-20 lg:grid-cols-[minmax(0,1fr)_380px] lg:gap-6 lg:pb-0">
        <div className="flex min-w-0 flex-col gap-4">
          <SearchField label="Search the menu" placeholder="Item name" value={search} onChange={(event) => setSearch(event.target.value)} />
          {catalogue.hasMore && <p className="text-caption text-fg-secondary">Showing the first {catalogue.items.length} items — search to find the rest.</p>}

          <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
            <CategoryButton label="All" count={catalogue.items.length} active={categoryId === "ALL"} onClick={() => setCategoryId("ALL")} />
            {catalogue.categories.map((category) => (
              <CategoryButton
                key={category.id}
                label={category.name}
                count={category.itemCount}
                active={categoryId === category.id}
                onClick={() => setCategoryId(category.id)}
              />
            ))}
          </div>

          {visibleItems.length === 0 ? (
            <Card>
              <EmptyState icon={DOMAIN_ICONS.menu} title="No items match" description="Try another category or clear the search." />
            </Card>
          ) : (
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
              {visibleItems.map((item) => {
                const Glyph = isMenuIconKey(item.iconKey) ? MENU_ICONS[item.iconKey] : DOMAIN_ICONS.dineIn;
                return (
                  <li key={item.id} className="flex">
                    <button
                      type="button"
                      onClick={() => (item.hasOptions ? setOptionsFor(item.id) : addSimple(item.id))}
                      className="flex min-h-24 w-full flex-col justify-between gap-2 rounded-2xl border border-border-subtle bg-card p-4 text-left transition-colors duration-fast ease-standard hover:border-border-strong hover:bg-raised"
                    >
                      <span className="flex items-start justify-between gap-2">
                        <Icon icon={Glyph} size={20} className="text-fg-secondary" />
                        {item.isDailyMenu && (
                          <span className="rounded-full bg-action-primary/12 px-2 py-0.5 text-caption text-fg-accent">Today</span>
                        )}
                      </span>
                      <span className="block text-label text-fg-primary">{item.name}</span>
                      <span className="block text-caption text-numeric text-fg-secondary">
                        {item.hasOptions ? "from " : ""}
                        {formatMoney(item.priceFrom, currency, locale)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <Card className="hidden lg:sticky lg:top-20 lg:flex lg:max-h-screen lg:overflow-y-auto">{orderPanel}</Card>
      </div>

      {/* Below lg the grid owns the screen and the order lives in a sheet behind a sticky bar. Below md the console's
          own bottom navigation is on screen too, so the bar sits directly above it rather than on top of it. */}
      <div className="glass-1 fixed inset-x-0 bottom-16 z-bottom-bar border-t px-4 py-3 md:bottom-0 lg:hidden">
        <Button variant="primary" size="touch" className="w-full" onClick={() => setPanelOpen(true)}>
          <span className="flex w-full items-center justify-between gap-3">
            <span>
              View order ({lines.length})
              {urgent ? " · urgent" : ""}
            </span>
            <span className="text-numeric">{quote ? formatMoney(quote.totalAmount, quote.currencyCode, locale) : "—"}</span>
          </span>
        </Button>
      </div>
      <Drawer open={panelOpen} onClose={() => setPanelOpen(false)} title="This order" side="bottom">
        {orderPanel}
      </Drawer>

      <PosItemDialog itemId={optionsFor} currencyCode={currency} locale={locale} onClose={() => setOptionsFor(null)} onAdd={addLine} />
    </>
  );
}

function CategoryButton({ label, count, active, onClick }: { label: string; count: number; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex min-h-12 shrink-0 items-center gap-2 rounded-xl border px-4 text-label transition-colors duration-fast ease-standard ${
        active ? "border-action-primary bg-action-primary/12 text-fg-accent" : "border-border-subtle bg-card text-fg-secondary hover:text-fg-primary"
      }`}
    >
      {label}
      <span className="text-numeric text-caption">{count}</span>
    </button>
  );
}
