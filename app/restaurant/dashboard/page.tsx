import Link from "next/link";
import {
  BookOpen,
  ChartColumn,
  ChefHat,
  ClipboardList,
  CreditCard,
  Gauge,
  Printer,
  Receipt,
  Store,
  UsersRound,
} from "lucide-react";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { MetricCard } from "@/components/ui/metric-card";
import { ProgressRing } from "@/components/ui/progress-ring";
import { StatusBadge } from "@/components/ui/status-badge";
import { EmptyState } from "@/components/states/empty-state";
import {
  HardwarePanel,
  LivePill,
  OnShiftPanel,
  Panel,
  QuickOperations,
  StationRadar,
  type HardwareRow,
  type ShiftRow,
} from "@/components/dashboard/command-center";
import { requireTenantPage } from "@/lib/auth/guards";
import { hasPermission } from "@/lib/auth/permissions";
import { listKitchenSections, listKitchenTickets } from "@/lib/data/kot";
import { listOrders } from "@/lib/data/orders";
import { businessDaysEndingToday, salesSummary } from "@/lib/data/reports";
import { listStaffStanding } from "@/lib/data/staff-auth";
import { listActivePrinters, listAgents } from "@/lib/services/printing";
import { formatBusinessDate, formatInZone, formatMoney } from "@/lib/ui/format";
import { formatWaiting, isLate, minutesSince, sectionLoads } from "@/lib/ui/kitchen-load";
import { now as clockNow } from "@/lib/time/clock";

export const dynamic = "force-dynamic";

const FEED_ROWS = 6;

const ORDER_TYPE_LABEL: Record<string, string> = { DINE_IN: "Dine in", TAKEAWAY: "Takeaway", DELIVERY: "Delivery" };

/**
 * Dashboard — the restaurant's operations command center (RASOIOS-ADR-020, after the Stitch "Operations Command
 * Center"; ADR-013 §4 for the rule against a grid of equal cards).
 *
 * It answers, in order: how much have we sold, how many orders, what is happening in the kitchen and is anything late,
 * are the printers connected, who is working. Large panels carry operational weight; small ones support them.
 *
 * Every figure is a tenant-scoped query the caller is permitted to make, read when the page loads. Each panel appears
 * only for a role that may see it — money with `dashboard:read`, the kitchen with `kot:read`, printing with
 * `print_job:read`, who is on shift for a TENANT_ADMIN — so a role never sees a blank or a zero standing in for data it
 * is not allowed to read. "Today" is the restaurant's own business date, never the server's.
 */
export default async function RestaurantDashboardPage() {
  // Owners, administrators and managers only (owner request 2026-10-07): counter and kitchen staff are refused here like
  // on every other management screen, rather than shown a trimmed copy. Their home is the kitchen board or orders.
  const ctx = await requireTenantPage("dashboard:read");
  const timezone = ctx.restaurant.timezone;
  const currency = ctx.restaurant.currencyCode;
  const now = clockNow();

  const can = {
    sales: hasPermission(ctx, "dashboard:read"),
    orders: hasPermission(ctx, "order:read"),
    newOrder: hasPermission(ctx, "order:create"),
    kitchen: hasPermission(ctx, "kot:read"),
    printing: hasPermission(ctx, "print_job:read"),
    menu: hasPermission(ctx, "menu:read"),
    money: hasPermission(ctx, "transaction:read"),
    reports: hasPermission(ctx, "report:read"),
    // Shift attendance is administrator information, the same rule as /restaurant/staff/access (ADR-019 §6).
    shifts: ctx.role === "TENANT_ADMIN",
  };
  const today = can.sales ? businessDaysEndingToday(ctx, 1) : null;

  const [sales, orders, tickets, sections, printers, agents, standing] =
    await Promise.all([
      today ? salesSummary(ctx, today) : null,
      can.orders
        ? listOrders(ctx, { searchCustomers: false, limit: FEED_ROWS })
        : [],
      can.kitchen ? listKitchenTickets(ctx, { limit: 200 }) : [],
      can.kitchen ? listKitchenSections(ctx) : [],
      can.printing ? listActivePrinters(ctx) : [],
      can.printing ? listAgents(ctx) : [],
      can.shifts ? listStaffStanding(ctx) : [],
    ]);

  const waiting = tickets.filter(
    (t) => t.status === "QUEUED" || t.status === "PREPARING",
  );
  const late = waiting.filter((t) => isLate(t, now));
  const oldest =
    waiting.length > 0
      ? Math.max(...waiting.map((t) => minutesSince(t.queuedAt, now)))
      : null;
  const loads = sectionLoads(tickets, sections, now);

  const liveAgents = agents.filter((a) => a.status === "ACTIVE");
  const onlineAgents = liveAgents.filter((a) => a.online);
  const hardware: HardwareRow[] = [
    ...printers.map((p) => ({
      id: p.id,
      name: p.name,
      detail: [
        p.purpose.replaceAll("_", " ").toLowerCase(),
        p.connectionAddress,
      ]
        .filter(Boolean)
        .join(" · "),
      state:
        p.health === "ONLINE"
          ? ("online" as const)
          : p.health === "OFFLINE"
            ? ("offline" as const)
            : p.health === "ERROR"
              ? ("attention" as const)
              : ("unknown" as const),
      stateLabel: {
        ONLINE: "Online",
        OFFLINE: "Offline",
        ERROR: "Error",
        UNKNOWN: "Not reported",
      }[p.health],
    })),
    ...liveAgents.map((a) => ({
      id: a.id,
      name: a.name,
      detail: `Agent${a.lastSeenAt ? ` · last seen ${formatInZone(a.lastSeenAt, timezone, "time")}` : ""}`,
      state: a.online ? ("online" as const) : ("offline" as const),
      stateLabel: a.online ? "Connected" : "Offline",
    })),
  ];
  const shifts: ShiftRow[] = standing
    .filter((s) => s.activeSession)
    .map((s) => ({
      membershipId: s.membershipId,
      name: s.fullName ?? s.email,
      role: s.role,
      since: s.activeSession!.loginAt.toISOString(),
    }));

  const quickLinks = [
    can.kitchen && {
      href: "/restaurant/kitchen",
      label: "Kitchen board",
      detail: `${waiting.length} waiting`,
      icon: ChefHat,
    },
    can.menu && {
      href: "/restaurant/menu",
      label: "Menu",
      detail: "Items and availability",
      icon: BookOpen,
    },
    can.money && {
      href: "/restaurant/transactions",
      label: "Payments",
      detail: "Refunds and day close",
      icon: CreditCard,
    },
    can.printing && {
      href: "/restaurant/printing",
      label: "Printing",
      detail: "Printers and queue",
      icon: Printer,
    },
    can.reports && {
      href: "/restaurant/reports",
      label: "Reports",
      detail: "Sales and top sellers",
      icon: ChartColumn,
    },
    can.shifts && {
      href: "/restaurant/staff/access",
      label: "Staff passwords",
      detail: "Today's sign-in and hours",
      icon: UsersRound,
    },
  ].filter(
    (
      l,
    ): l is {
      href: string;
      label: string;
      detail: string;
      icon: typeof ChefHat;
    } => Boolean(l),
  );

  return (
    <div className="flex flex-col gap-6">
      {/* Context strip: where and when, and whether the restaurant is running. */}
      <header className="glass-1 rise-in flex flex-col gap-3 rounded-2xl border px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <h1 className="font-display text-display-m text-fg-primary">
            Operations command center
          </h1>
          <p className="mt-1 text-caption text-fg-secondary">
            {today
              ? `Business date ${formatBusinessDate(today.to)}`
              : "Live operations"}{" "}
            · {timezone}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {can.kitchen && (
            <LivePill
              tone={
                late.length > 0
                  ? "danger"
                  : waiting.length > 0
                    ? "success"
                    : "neutral"
              }
              live={waiting.length > 0}
            >
              {waiting.length === 0
                ? "Kitchen clear"
                : late.length > 0
                  ? `${late.length} late in kitchen`
                  : `Kitchen: ${waiting.length} cooking`}
            </LivePill>
          )}
          {can.printing && (
            <LivePill
              tone={
                liveAgents.length === 0
                  ? "neutral"
                  : onlineAgents.length === liveAgents.length
                    ? "success"
                    : "danger"
              }
              live={onlineAgents.length > 0}
            >
              {liveAgents.length === 0
                ? "No print agent"
                : onlineAgents.length === liveAgents.length
                  ? "Print agent connected"
                  : "Print agent offline"}
            </LivePill>
          )}
          {can.shifts && (
            <LivePill
              tone={shifts.length > 0 ? "success" : "neutral"}
              live={shifts.length > 0}
            >
              {shifts.length === 1
                ? "1 staff on shift"
                : `${shifts.length} staff on shift`}
            </LivePill>
          )}
        </div>
      </header>

      {/* Headline figures. Money only for roles that may see it; zeros are never shown as if they were a reading. */}
      {(sales || can.kitchen) && (
        <section
          aria-label="Today's figures"
          className="grid items-stretch gap-4 sm:grid-cols-2 xl:grid-cols-4"
        >
          {/* `dashboard-sales-today` marks the money and only the money: the RBAC tests use it to prove a role without
              `dashboard:read` is never shown sales. `contents` keeps the cards on the row's grid. */}
          {sales && today && (
            <div data-testid="dashboard-sales-today" className="contents">
              {sales.orderCount === 0 && (
                <div className="rise-in rounded-2xl border border-border-subtle bg-card sm:col-span-2 xl:col-span-3">
                  <EmptyState
                    icon={Receipt}
                    title="No orders on this business date yet"
                    description={`Nothing has been recorded for ${formatBusinessDate(today.to)}. Figures appear here as orders are completed.`}
                    {...(can.orders
                      ? {
                          action: {
                            href: "/restaurant/orders",
                            label: "Open orders",
                          },
                        }
                      : {})}
                  />
                </div>
              )}
              {sales.orderCount > 0 && (
                <>
                  <MetricCard
                    label="Gross sales"
                    icon={ChartColumn}
                    hue="accent"
                    value={
                      <AnimatedNumber
                        kind="money"
                        currencyCode={currency}
                        value={sales.grossSales}
                        display={formatMoney(sales.grossSales, currency)}
                      />
                    }
                    support={`Net ${formatMoney(sales.netSales, currency)} · refunds ${formatMoney(sales.refunds, currency)}`}
                  />
                  <MetricCard
                    label="Orders fulfilled"
                    icon={ClipboardList}
                    hue="secondary"
                    aside={
                      <ProgressRing
                        part={sales.salesOrderCount}
                        whole={sales.orderCount}
                        label="Orders fulfilled"
                      />
                    }
                    value={
                      <>
                        <AnimatedNumber
                          value={String(sales.salesOrderCount)}
                          display={String(sales.salesOrderCount)}
                        />
                        <span className="text-heading text-fg-secondary">
                          {" "}
                          / {sales.orderCount}
                        </span>
                      </>
                    }
                    support={
                      sales.cancelledCount > 0
                        ? `${sales.cancelledCount} cancelled`
                        : "None cancelled"
                    }
                  />
                  <MetricCard
                    label="Average ticket"
                    icon={Receipt}
                    hue="warning"
                    value={
                      <AnimatedNumber
                        kind="money"
                        currencyCode={currency}
                        value={sales.averageOrderValue}
                        display={formatMoney(sales.averageOrderValue, currency)}
                      />
                    }
                    support={`Across ${sales.salesOrderCount} ${sales.salesOrderCount === 1 ? "order" : "orders"}`}
                  />
                </>
              )}
            </div>
          )}
          {can.kitchen && (
            <MetricCard
              label="Live kitchen queue"
              icon={Gauge}
              hue={late.length > 0 ? "danger" : "primary"}
              aside={
                late.length > 0 ? (
                  <Badge tone="danger">{late.length} late</Badge>
                ) : undefined
              }
              className={
                late.length > 0 ? "border-status-danger/40" : undefined
              }
              value={
                <>
                  <AnimatedNumber
                    value={String(waiting.length)}
                    display={String(waiting.length)}
                  />
                  <span className="text-heading text-fg-secondary">
                    {" "}
                    {waiting.length === 1 ? "ticket" : "tickets"}
                  </span>
                </>
              }
              support={
                oldest === null
                  ? "Nothing waiting on the kitchen"
                  : `Oldest waiting ${formatWaiting(oldest)}`
              }
            />
          )}
        </section>
      )}

      {/* Bento: wide operational panels on the left, supporting panels on the right. */}
      <div className="grid items-start gap-6 lg:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-6 lg:col-span-2">
          {can.kitchen && (
            <Panel
              title="Kitchen stations"
              icon={ChefHat}
              labelledBy="dashboard-stations"
              action={
                <Link
                  href="/restaurant/kitchen"
                  className="text-label text-fg-accent hover:underline"
                >
                  Kitchen board
                </Link>
              }
            >
              <StationRadar loads={loads} />
            </Panel>
          )}

          {can.orders && (
            <Panel
              title="Latest orders"
              icon={ClipboardList}
              labelledBy="dashboard-orders"
              action={
                <Link
                  href="/restaurant/orders"
                  className="text-label text-fg-accent hover:underline"
                >
                  All orders
                </Link>
              }
            >
              {orders.length === 0 ? (
                <EmptyState
                  icon={ClipboardList}
                  title="No orders yet"
                  description="Orders taken at the counter or from your public menu page appear here."
                />
              ) : (
                <ul className="flex list-none flex-col divide-y divide-border-subtle p-0">
                  {orders.map((order) => (
                    <li key={order.id}>
                      <Link
                        href={`/restaurant/orders/${order.id}`}
                        className="-mx-2 grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 rounded-xl px-2 py-3 transition-colors duration-base ease-standard hover:bg-raised md:grid-cols-[10rem_1fr_auto_auto]"
                      >
                        <span className="col-start-1 row-start-1 flex min-w-0 flex-col">
                          <span className="truncate text-label text-numeric text-fg-primary">
                            #{order.orderNumber}
                          </span>
                          <span className="flex items-center gap-1 text-caption text-fg-secondary">
                            <Icon icon={Store} size={16} />
                            {order.tableLabel
                              ? `Table ${order.tableLabel}`
                              : ORDER_TYPE_LABEL[order.orderType]}{" "}
                            ·{" "}
                            <time dateTime={order.createdAt}>
                              {formatInZone(order.createdAt, timezone, "time")}
                            </time>
                          </span>
                        </span>
                        <span className="col-start-1 row-start-2 truncate text-caption text-fg-secondary md:col-start-2 md:row-start-1">
                          {order.items.length === 0
                            ? "No items"
                            : order.items
                                .slice(0, 2)
                                .map(
                                  (i) => `${i.quantity}× ${i.itemNameSnapshot}`,
                                )
                                .join(", ") +
                              (order.items.length > 2
                                ? ` +${order.items.length - 2} more`
                                : "")}
                        </span>
                        <span className="col-start-2 row-start-1 flex flex-col items-end gap-1 md:col-start-3">
                          <StatusBadge domain="order" status={order.status} />
                          {order.paymentStatus && (
                            <StatusBadge
                              domain="payment"
                              status={order.paymentStatus}
                            />
                          )}
                        </span>
                        <span className="col-start-2 row-start-2 text-right text-label text-numeric text-fg-primary md:col-start-4 md:row-start-1">
                          {order.totalAmount
                            ? formatMoney(order.totalAmount, order.currencyCode)
                            : "—"}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          )}

          {!can.orders && !can.kitchen && (
            <div className="rounded-2xl border border-border-subtle bg-card">
              <EmptyState
                icon={Store}
                title="Nothing to show here"
                description="Your role does not include the orders or kitchen boards. Use the navigation for the areas you can reach."
              />
            </div>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-6">
          {(can.newOrder || quickLinks.length > 0) && (
            <Panel
              title="Quick operations"
              icon={Gauge}
              labelledBy="dashboard-quick"
            >
              <QuickOperations newOrder={can.newOrder} links={quickLinks} />
            </Panel>
          )}
          {can.printing && (
            <Panel
              title="Printers and agents"
              icon={Printer}
              labelledBy="dashboard-hardware"
            >
              <HardwarePanel rows={hardware} />
            </Panel>
          )}
          {can.shifts && (
            <Panel
              title="On shift now"
              icon={UsersRound}
              labelledBy="dashboard-shifts"
              action={
                <Link
                  href="/restaurant/staff/access"
                  className="text-label text-fg-accent hover:underline"
                >
                  Attendance
                </Link>
              }
            >
              <OnShiftPanel rows={shifts} timezone={timezone} now={now} />
            </Panel>
          )}
        </div>
      </div>

      <p className="flex items-center gap-2 text-caption text-fg-secondary">
        <Icon icon={Store} size={16} />
        Every figure here is read live from your restaurant when this page
        loads.
      </p>
    </div>
  );
}
