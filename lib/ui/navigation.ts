/**
 * Console navigation (frontend.md §3.1, ADR-013 §3). Items appear only when the role has the capability.
 * Hiding a link is a convenience, not authorization: every page and action re-checks on the server (SC-RBAC-08).
 *
 * Brand v2 has no desktop sidebar. The same item list drives three presentations:
 *   - the sticky glass header (≥ 768 px), which keeps `headerNavItems` order and overflows the tail into "More";
 *   - the glass bottom bar (< 768 px), which shows `bottomNavItemsFor` plus a centre action and a "More" sheet;
 *   - the "More" menu/sheet, which holds whatever the other two could not show.
 */
import type { LucideIcon } from "lucide-react";
import type { TenantRole } from "@prisma/client";
import type { TenantPermission } from "@/lib/auth/permissions";
import { DOMAIN_HUES, DOMAIN_ICONS, type DomainHue } from "./icons";

export type NavKey =
  | "dashboard"
  | "orders"
  | "kitchen"
  | "transactions"
  | "customers"
  | "menu"
  | "dailyMenu"
  | "reports"
  | "social"
  | "website"
  | "staff"
  | "printing"
  | "audit"
  | "settings";

export type NavGroup = "Main" | "Operations" | "Management" | "Reports" | "Settings";

export type NavItem = {
  key: NavKey;
  href: string;
  label: string;
  group: NavGroup;
  capability: TenantPermission;
  /**
   * Route prefix that keeps the item highlighted when its destination is one page of a larger area — Menu lands on
   * `/restaurant/menu/items` but owns every `/restaurant/menu/*` page (frontend.md §3.1). Defaults to `href`.
   */
  activePrefix?: string;
};

/** Routes that exist today; items from frontend.md §3.1 whose pages are not built yet are added by their feature tasks. */
export const NAV_ITEMS: readonly NavItem[] = [
  { key: "dashboard", href: "/restaurant/dashboard", label: "Dashboard", group: "Main", capability: "dashboard:read" },
  { key: "orders", href: "/restaurant/orders", label: "Orders", group: "Operations", capability: "order:read" },
  { key: "kitchen", href: "/restaurant/kitchen", label: "Kitchen", group: "Operations", capability: "kot:read" },
  { key: "transactions", href: "/restaurant/transactions", label: "Transactions", group: "Operations", capability: "transaction:read" },
  { key: "customers", href: "/restaurant/customers", label: "Customers", group: "Operations", capability: "customer:read" },
  { key: "menu", href: "/restaurant/menu/items", label: "Menu", group: "Management", capability: "menu:read", activePrefix: "/restaurant/menu" },
  { key: "dailyMenu", href: "/restaurant/daily-menu", label: "Daily menu", group: "Management", capability: "daily_menu:read" },
  { key: "social", href: "/restaurant/social", label: "Social", group: "Management", capability: "social:manage" },
  { key: "website", href: "/restaurant/website", label: "Website", group: "Management", capability: "website:update" },
  { key: "staff", href: "/restaurant/staff", label: "Staff", group: "Management", capability: "staff:read" },
  { key: "reports", href: "/restaurant/reports", label: "Reports", group: "Reports", capability: "report:read" },
  { key: "printing", href: "/restaurant/printing", label: "Printing", group: "Settings", capability: "print_job:read" },
  { key: "audit", href: "/restaurant/audit", label: "Audit log", group: "Reports", capability: "audit:read" },
  // `dashboard:read`, not `restaurant:read`: every role reads the restaurant (the console needs its name and timezone),
  // but Settings is a management screen. Counter and kitchen staff see only their own work (ADR-019, owner 2026-10-02).
  { key: "settings", href: "/restaurant/settings", label: "Settings", group: "Settings", capability: "dashboard:read" },
];

/** design.md §5.1 icon for each navigation item. */
export const NAV_ICONS: Record<NavKey, LucideIcon> = {
  dashboard: DOMAIN_ICONS.dashboard,
  orders: DOMAIN_ICONS.orders,
  kitchen: DOMAIN_ICONS.kitchen,
  transactions: DOMAIN_ICONS.transactions,
  customers: DOMAIN_ICONS.customers,
  menu: DOMAIN_ICONS.menu,
  dailyMenu: DOMAIN_ICONS.dailyMenu,
  social: DOMAIN_ICONS.social,
  website: DOMAIN_ICONS.website,
  staff: DOMAIN_ICONS.staff,
  reports: DOMAIN_ICONS.reports,
  printing: DOMAIN_ICONS.printer,
  audit: DOMAIN_ICONS.audit,
  settings: DOMAIN_ICONS.settings,
};

/** design.md §5.2 domain hue for each navigation item (icon and tile wash only). */
export const NAV_HUES: Record<NavKey, DomainHue> = {
  dashboard: DOMAIN_HUES.dashboard,
  orders: DOMAIN_HUES.orders,
  kitchen: DOMAIN_HUES.kitchen,
  transactions: DOMAIN_HUES.transactions,
  customers: DOMAIN_HUES.customers,
  menu: DOMAIN_HUES.menu,
  dailyMenu: DOMAIN_HUES.menu,
  social: DOMAIN_HUES.social,
  website: DOMAIN_HUES.website,
  staff: DOMAIN_HUES.staff,
  reports: DOMAIN_HUES.reports,
  printing: DOMAIN_HUES.printing,
  audit: DOMAIN_HUES.audit,
  settings: DOMAIN_HUES.settings,
};

export const NAV_GROUP_ORDER: readonly NavGroup[] = ["Main", "Operations", "Management", "Reports", "Settings"];

export function navItemsFor(capabilities: Iterable<string>): NavItem[] {
  const allowed = new Set(capabilities);
  return NAV_ITEMS.filter((item) => allowed.has(item.capability));
}

/** Sections in frontend.md §3.1 order, skipping groups the role has nothing in. Used by the "More" sheet. */
export function groupNavItems(items: readonly NavItem[]): Array<{ group: NavGroup; items: NavItem[] }> {
  return NAV_GROUP_ORDER.map((group) => ({ group, items: items.filter((item) => item.group === group) })).filter((section) => section.items.length > 0);
}

/**
 * Header order and overflow priority (frontend.md §3.1): Main and Operations items stay in the header as long as they
 * fit; Management, Reports and Settings items move into "More" first. The header measures widths at runtime and takes
 * items off the tail of this list, so the order *is* the priority.
 */
export const NAV_OVERFLOW_PRIORITY: Readonly<Record<NavGroup, number>> = { Main: 0, Operations: 1, Management: 2, Reports: 3, Settings: 4 };

export function headerNavItems(items: readonly NavItem[]): NavItem[] {
  return [...items].sort((a, b) => NAV_OVERFLOW_PRIORITY[a.group] - NAV_OVERFLOW_PRIORITY[b.group]);
}

/** Splits the header order at `visibleCount`; everything after it belongs in the "More" menu. */
export function splitNavOverflow(items: readonly NavItem[], visibleCount: number): { visible: NavItem[]; overflow: NavItem[] } {
  const ordered = headerNavItems(items);
  const count = Math.max(0, Math.min(visibleCount, ordered.length));
  return { visible: ordered.slice(0, count), overflow: ordered.slice(count) };
}

/** Gap between header navigation items (`gap-1`), and the width assumed for "More" before it has been measured. */
export const NAV_ITEM_GAP = 4;
export const NAV_MORE_FALLBACK_WIDTH = 104;

/**
 * How many items of `widths` fit in `available`, leaving room for the "More" trigger whenever anything is left over.
 * Pure layout arithmetic so the overflow rule is testable without a browser; `HeaderNav` supplies real measurements.
 */
export function fitCount(widths: readonly number[], available: number, moreWidth: number, gap = NAV_ITEM_GAP): number {
  let used = 0;
  let count = 0;
  for (let index = 0; index < widths.length; index += 1) {
    const next = used + widths[index] + (index > 0 ? gap : 0);
    const reserve = index < widths.length - 1 ? gap + moreWidth : 0;
    if (next + reserve > available) break;
    used = next;
    count += 1;
  }
  return count;
}

/** True when `pathname` is the item's page or a page below it (or below its `activePrefix` area). */
export function isNavItemActive(item: Pick<NavItem, "href"> & { activePrefix?: string }, pathname: string): boolean {
  const base = item.activePrefix ?? item.href;
  return pathname === base || pathname.startsWith(`${base}/`);
}

/** The navigation item for the current page (longest matching href), if any. */
export function activeNavItem<T extends Pick<NavItem, "href"> & { activePrefix?: string }>(items: readonly T[], pathname: string): T | undefined {
  return items.filter((item) => isNavItemActive(item, pathname)).sort((a, b) => b.href.length - a.href.length)[0];
}

/**
 * Bottom navigation below 768 px (frontend.md §3.1, ADR-013 §3): up to four of the role's most-used areas, in order.
 * Only items the role can use are shown, so a preset can never offer a link the server would refuse. The role's
 * centre action (`primaryActionFor`) is deliberately not in the presets — it gets its own raised button.
 */
export const BOTTOM_NAV_PRESETS: Readonly<Record<TenantRole, readonly NavKey[]>> = {
  // Four slots for every role (owner review 2026-10-06: "Dashboard, Orders, Kitchen, More" — not every feature at the
  // bottom): two destinations here, the role's centre action (the kitchen board for every role that has it) and More.
  // Everything else, Menu and Reports included, stays one tap away under More.
  TENANT_ADMIN: ["dashboard", "orders"],
  MANAGER: ["dashboard", "orders"],
  CASHIER: ["orders", "transactions"],
  WAITER: ["orders", "customers"],
  KITCHEN: ["orders", "dailyMenu"],
};

export function bottomNavItemsFor(role: string, capabilities: Iterable<string>): NavItem[] {
  const preset = BOTTOM_NAV_PRESETS[role as TenantRole] ?? [];
  const allowed = navItemsFor(capabilities);
  return preset.map((key) => allowed.find((item) => item.key === key)).filter((item): item is NavItem => Boolean(item)).slice(0, 4);
}

/**
 * The centre action of the bottom bar (ADR-013 §3) — the role's main live action, as a raised button.
 *
 * frontend.md §3.1 names "New order / Start ticket" (`/restaurant/orders/new`), a screen that is not part of this
 * slice. Rather than render a button that goes nowhere, the action resolves against routes that exist, first match
 * wins; when `/restaurant/orders/new` lands it is added at the top of this list and the button follows.
 */
const PRIMARY_ACTION_ORDER: readonly NavKey[] = ["kitchen", "orders", "dashboard"];

export function primaryActionFor(capabilities: Iterable<string>): NavItem | null {
  const allowed = navItemsFor(capabilities);
  for (const key of PRIMARY_ACTION_ORDER) {
    const item = allowed.find((candidate) => candidate.key === key);
    if (item) return item;
  }
  return null;
}

/** Everything the role may reach that the bottom bar and its centre action are not already showing. */
export function moreNavItemsFor(role: string, capabilities: Iterable<string>): NavItem[] {
  const shown = new Set([...bottomNavItemsFor(role, capabilities).map((item) => item.key), primaryActionFor(capabilities)?.key].filter(Boolean));
  return navItemsFor(capabilities).filter((item) => !shown.has(item.key));
}

/** Routes rendered in the focus shell (compact top bar, full width) instead of the console shell (frontend.md §2). */
export const FOCUS_ROUTES: readonly string[] = ["/restaurant/kitchen"];

export function isFocusRoute(pathname: string): boolean {
  return FOCUS_ROUTES.some((route) => pathname === route || pathname.startsWith(`${route}/`));
}

/** Where `/restaurant` sends each role (frontend.md §3.3). */
export function roleHomePath(role: TenantRole): string {
  switch (role) {
    case "TENANT_ADMIN":
    case "MANAGER":
      return "/restaurant/dashboard";
    case "KITCHEN":
      return "/restaurant/kitchen";
    default:
      return "/restaurant/orders";
  }
}

/** Sentence-case role name for display ("TENANT_ADMIN" → "Tenant admin"). */
export function roleLabel(role: string): string {
  const words = role.toLowerCase().split("_").join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Platform console navigation (frontend.md §5.2) — routes that exist today. */
export type AdminNavItem = { href: string; label: string; icon: LucideIcon; hue: DomainHue };

export const ADMIN_NAV_ITEMS: readonly AdminNavItem[] = [
  { href: "/admin", label: "Overview", icon: DOMAIN_ICONS.dashboard, hue: DOMAIN_HUES.dashboard },
  { href: "/admin/tenants", label: "Restaurants", icon: DOMAIN_ICONS.restaurant, hue: DOMAIN_HUES.restaurant },
  { href: "/admin/audit", label: "Audit", icon: DOMAIN_ICONS.audit, hue: DOMAIN_HUES.audit },
];

/** The admin item for the current page: `/admin` only matches exactly so it is not active on every admin page. */
export function activeAdminItem(pathname: string): AdminNavItem | undefined {
  return activeNavItem(
    ADMIN_NAV_ITEMS.filter((item) => item.href !== "/admin" || pathname === "/admin"),
    pathname,
  );
}
