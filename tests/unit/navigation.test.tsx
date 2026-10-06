import { readFileSync } from "node:fs";
import path from "node:path";
import type { TenantRole } from "@prisma/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { permissionsForTenantRole } from "@/lib/auth/permissions";
import { BottomNav } from "@/components/layout/bottom-nav";
import { HeaderNav } from "@/components/layout/header-nav";
import { MobileNavPanel } from "@/components/layout/mobile-nav-panel";
import { HUE_TILE } from "@/components/ui/icon-tile";
import {
  activeAdminItem,
  activeNavItem,
  ADMIN_NAV_ITEMS,
  BOTTOM_NAV_PRESETS,
  bottomNavItemsFor,
  fitCount,
  groupNavItems,
  headerNavItems,
  isFocusRoute,
  moreNavItemsFor,
  NAV_HUES,
  NAV_ICONS,
  NAV_ITEMS,
  NAV_OVERFLOW_PRIORITY,
  navItemsFor,
  primaryActionFor,
  roleHomePath,
  roleLabel,
  splitNavOverflow,
} from "@/lib/ui/navigation";

// S1-P05-T006 — navigation shows only what the role can use (frontend.md §3.1, §3.3).
const labels = (role: TenantRole) => navItemsFor(permissionsForTenantRole(role)).map((i) => i.key);
const ROLES = ["TENANT_ADMIN", "MANAGER", "CASHIER", "KITCHEN", "WAITER"] as TenantRole[];

describe("capability-filtered navigation", () => {
  it("shows every area to TENANT_ADMIN", () => {
    expect(labels("TENANT_ADMIN")).toEqual([
      "dashboard",
      "orders",
      "kitchen",
      "transactions",
      "customers",
      "menu",
      "dailyMenu",
      "social",
      "website",
      "staff",
      "reports",
      "printing",
      "audit",
      "settings",
    ]);
  });

  it("hides management and money areas from WAITER and KITCHEN", () => {
    // Menu and daily menu are read-only for these roles (`menu:read` / `daily_menu:read`), so the links stay.
    // No Settings for staff: it is a management screen (ADR-019, owner 2026-10-02).
    expect(labels("WAITER")).toEqual(["orders", "kitchen", "customers", "menu", "dailyMenu"]);
    expect(labels("KITCHEN")).toEqual(["orders", "kitchen", "menu", "dailyMenu", "printing"]);
    expect(labels("CASHIER")).not.toContain("settings");
    expect(labels("CASHIER")).not.toContain("reports");
    expect(labels("CASHIER")).not.toContain("dashboard");
    expect(labels("MANAGER")).toContain("reports");
  });

  it("sends each role to its home page", () => {
    expect(roleHomePath("TENANT_ADMIN")).toBe("/restaurant/dashboard");
    expect(roleHomePath("MANAGER")).toBe("/restaurant/dashboard");
    expect(roleHomePath("CASHIER")).toBe("/restaurant/orders");
    expect(roleHomePath("WAITER")).toBe("/restaurant/orders");
    expect(roleHomePath("KITCHEN")).toBe("/restaurant/kitchen");
  });

  it("never offers a link the server would refuse", () => {
    for (const role of ROLES) {
      const caps = permissionsForTenantRole(role);
      for (const item of navItemsFor(caps)) expect(caps.has(item.capability)).toBe(true);
    }
  });
});

// ADR-013 §3 — header navigation with runtime overflow, and the phone bottom bar. No sidebar anywhere.
describe("header navigation (ADR-013 §3)", () => {
  it("orders items so Main and Operations survive the squeeze and Settings goes into More first", () => {
    const keys = headerNavItems(navItemsFor(permissionsForTenantRole("TENANT_ADMIN"))).map((i) => i.key);
    expect(keys.slice(0, 5)).toEqual(["dashboard", "orders", "kitchen", "transactions", "customers"]);
    expect(keys.slice(-2)).toEqual(["printing", "settings"]);
    const groups = keys.map((key) => NAV_ITEMS.find((item) => item.key === key)!.group);
    const priorities = groups.map((group) => NAV_OVERFLOW_PRIORITY[group]);
    expect(priorities).toEqual([...priorities].sort((a, b) => a - b));
  });

  it("splits the header at the measured count and puts the rest in More", () => {
    const items = navItemsFor(permissionsForTenantRole("TENANT_ADMIN"));
    const { visible, overflow } = splitNavOverflow(items, 4);
    expect(visible.map((i) => i.key)).toEqual(["dashboard", "orders", "kitchen", "transactions"]);
    expect(overflow.map((i) => i.key)).toEqual(["customers", "menu", "dailyMenu", "social", "website", "staff", "reports", "audit", "printing", "settings"]);
    expect([...visible, ...overflow]).toHaveLength(items.length);
    // Degenerate counts never drop or duplicate an item.
    expect(splitNavOverflow(items, 0).overflow).toHaveLength(items.length);
    expect(splitNavOverflow(items, 99).visible).toHaveLength(items.length);
  });

  it("fitCount reserves room for the More trigger whenever anything is left over", () => {
    const widths = [100, 100, 100, 100];
    // Everything fits: no More trigger, so no reservation.
    expect(fitCount(widths, 412, 100)).toBe(4);
    // One pixel short of the whole row: the last item moves into More, and More must still fit.
    expect(fitCount(widths, 411, 100)).toBe(2);
    expect(fitCount(widths, 99, 100)).toBe(0);
    expect(fitCount([], 500, 100)).toBe(0);
  });

  it("every item has a design.md §5.1 icon and a §5.2 domain hue with a tile recipe", () => {
    for (const item of NAV_ITEMS) {
      expect(NAV_ICONS[item.key], item.key).toBeTruthy();
      expect(HUE_TILE[NAV_HUES[item.key]], item.key).toBeTruthy();
    }
  });

  it("marks the deepest matching item active, and nothing on unrelated pages", () => {
    const items = navItemsFor(permissionsForTenantRole("TENANT_ADMIN"));
    expect(activeNavItem(items, "/restaurant/orders")?.key).toBe("orders");
    expect(activeNavItem(items, "/restaurant/orders/42/receipt")?.key).toBe("orders");
    expect(activeNavItem(items, "/restaurant/ordersx")).toBeUndefined();
    expect(activeNavItem(items, "/account/select-tenant")).toBeUndefined();
  });

  it("keeps Menu active across its whole area and never confuses it with the daily menu (frontend.md §3.1)", () => {
    const items = navItemsFor(permissionsForTenantRole("TENANT_ADMIN"));
    expect(activeNavItem(items, "/restaurant/menu/items")?.key).toBe("menu");
    expect(activeNavItem(items, "/restaurant/menu/categories")?.key).toBe("menu");
    expect(activeNavItem(items, "/restaurant/menu/items/new")?.key).toBe("menu");
    expect(activeNavItem(items, "/restaurant/daily-menu")?.key).toBe("dailyMenu");
  });

  it("groups the More sheet in frontend.md §3.1 order and skips empty groups", () => {
    const groups = groupNavItems(navItemsFor(permissionsForTenantRole("TENANT_ADMIN"))).map((g) => g.group);
    expect(groups).toEqual(["Main", "Operations", "Management", "Reports", "Settings"]);
    const kitchen = groupNavItems(navItemsFor(permissionsForTenantRole("KITCHEN"))).map((g) => g.group);
    expect(kitchen).not.toContain("Main");
    expect(kitchen).not.toContain("Reports");
  });
});

describe("bottom bar (< 768 px)", () => {
  it("shows at most four of the role's allowed areas, in preset order", () => {
    expect(bottomNavItemsFor("TENANT_ADMIN", permissionsForTenantRole("TENANT_ADMIN")).map((i) => i.key)).toEqual(["dashboard", "orders"]);
    expect(bottomNavItemsFor("WAITER", permissionsForTenantRole("WAITER")).map((i) => i.key)).toEqual(["orders", "customers"]);
    expect(bottomNavItemsFor("KITCHEN", permissionsForTenantRole("KITCHEN")).map((i) => i.key)).toEqual(["orders", "dailyMenu"]);
    expect(bottomNavItemsFor("CASHIER", permissionsForTenantRole("CASHIER")).map((i) => i.key)).toEqual(["orders", "transactions"]);
    for (const role of ROLES) {
      const caps = permissionsForTenantRole(role);
      const items = bottomNavItemsFor(role, caps);
      // Two destinations for every role; with the centre action and More, four slots (owner review 2026-10-06).
      const expected = 2;
      expect(items.length, role).toBe(expected);
      for (const item of items) expect(caps.has(item.capability), `${role} ${item.key}`).toBe(true);
      expect(BOTTOM_NAV_PRESETS[role].length).toBe(expected);
    }
    // …but a destination taken off the bar is never lost: it is still one tap away under More.
    for (const role of ["TENANT_ADMIN", "MANAGER"] as const) {
      const caps = permissionsForTenantRole(role);
      expect(bottomNavItemsFor(role, caps).map((i) => i.key), role).not.toContain("reports");
      expect(moreNavItemsFor(role, caps).map((i) => i.key), role).toContain("reports");
    }
    // A preset entry the role cannot use is dropped rather than shown.
    expect(bottomNavItemsFor("WAITER", new Set(["order:read"])).map((i) => i.key)).toEqual(["orders"]);
    expect(bottomNavItemsFor("NOT_A_ROLE", permissionsForTenantRole("TENANT_ADMIN"))).toEqual([]);
  });

  it("gives every role a centre action that is a real route the role may open, and never a duplicate destination", () => {
    for (const role of ROLES) {
      const caps = permissionsForTenantRole(role);
      const action = primaryActionFor(caps);
      expect(action, role).not.toBeNull();
      expect(caps.has(action!.capability), role).toBe(true);
      expect(NAV_ITEMS.map((i) => i.href)).toContain(action!.href);
      expect(bottomNavItemsFor(role, caps).map((i) => i.key), role).not.toContain(action!.key);
    }
    // No capabilities at all: no button rather than a button that goes nowhere.
    expect(primaryActionFor([])).toBeNull();
  });

  it("the More sheet holds exactly what the bar and its centre action are not showing", () => {
    for (const role of ROLES) {
      const caps = permissionsForTenantRole(role);
      const shown = [...bottomNavItemsFor(role, caps), primaryActionFor(caps)!].map((i) => i.key);
      const more = moreNavItemsFor(role, caps).map((i) => i.key);
      expect([...shown, ...more].sort(), role).toEqual(navItemsFor(caps).map((i) => i.key).sort());
      expect(new Set(more).size, role).toBe(more.length);
    }
  });

  it("the kitchen board uses the focus shell", () => {
    expect(isFocusRoute("/restaurant/kitchen")).toBe(true);
    expect(isFocusRoute("/restaurant/kitchen/section/1")).toBe(true);
    expect(isFocusRoute("/restaurant/kitchenette")).toBe(false);
    expect(isFocusRoute("/restaurant/orders")).toBe(false);
  });
});

// The rendered shells: what the header and the bottom bar actually put on the page.
const html = (node: React.ReactElement) => renderToStaticMarkup(node);
const adminItems = navItemsFor(permissionsForTenantRole("TENANT_ADMIN"));

describe("rendered navigation", () => {
  it("the header renders one nav, every allowed item, and marks the current page with more than colour", () => {
    const out = html(<HeaderNav items={adminItems} pathname="/restaurant/orders" />);
    expect(out.match(/<nav /g)).toHaveLength(1);
    for (const item of adminItems) expect(out, item.key).toContain(`href="${item.href}"`);
    // Active: aria-current, the tinted pill and the brand-gradient underline — three signals.
    expect(out).toMatch(/aria-current="page"[^>]*class="[^"]*brand-underline[^"]*bg-action-primary\/12/);
    expect(out.match(/aria-current="page"/g)).toHaveLength(1);
    // The ruler is measurement scaffolding: hidden from readers and holding nothing focusable.
    expect(out).toContain('aria-hidden="true"');
    const ruler = out.slice(out.indexOf('aria-hidden="true"'), out.indexOf("<nav "));
    expect(ruler).not.toContain("<a ");
    // Desktop only: below 768 px the bottom bar takes over.
    expect(out).toContain("md:block");
  });

  it("the bottom bar renders four destinations, the centre action and Menu in equal, aligned slots", () => {
    const caps = permissionsForTenantRole("TENANT_ADMIN");
    const items = bottomNavItemsFor("TENANT_ADMIN", caps);
    const out = html(<BottomNav items={items} action={primaryActionFor(caps)} pathname="/restaurant/orders" onOpenMenu={() => undefined} menuOpen={false} />);
    expect(out).toContain("glass-1 fixed inset-x-0 bottom-0");
    expect(out).toContain("md:hidden");
    for (const item of items) expect(out, item.key).toContain(`href="${item.href}"`);
    expect(out).toContain(`href="${primaryActionFor(caps)!.href}"`);
    expect(out).toContain(">More<");
    // Equal columns: the role's destinations + centre action + Menu.
    const slots = items.length + 2;
    expect(out).toContain(`repeat(${slots}, minmax(0, 1fr))`);
    // Every slot has the same structure: 64 px tall, a 32 px icon pill, a one-line label — nothing raised out of the row.
    expect(out.match(/h-16 min-w-0 flex-col/g)).toHaveLength(slots);
    expect(out.match(/inline-flex h-8 w-12 shrink-0/g)).toHaveLength(slots);
    expect(out).not.toContain("-mt-5");
    // The restaurant's Menu destination keeps its own icon; only the More slot shows ☰ (lucide "menu").
    expect(out.match(/lucide-menu\b/g) ?? []).toHaveLength(1);
    expect(out).toMatch(/aria-current="page"/);
  });

  it("the More slot opens the side panel (and says so to assistive tech)", () => {
    const caps = permissionsForTenantRole("WAITER");
    const out = html(<BottomNav items={bottomNavItemsFor("WAITER", caps)} action={primaryActionFor(caps)} pathname="/restaurant/orders" onOpenMenu={() => undefined} menuOpen={true} />);
    expect(out).toMatch(/aria-haspopup="dialog"[^>]*>|aria-expanded="true"/);
    expect(out).toContain('aria-expanded="true"');
  });

  it("no destination can disappear on phones: everything not in the bar is in the side panel, for every role", () => {
    for (const role of ROLES) {
      const caps = permissionsForTenantRole(role);
      const all = navItemsFor(caps);
      const inBar = new Set([...bottomNavItemsFor(role, caps), primaryActionFor(caps)!].map((i) => i.key));
      const panel = html(<MobileNavPanel open onClose={() => undefined} items={all} pathname="/restaurant/dashboard" title="Test" />);
      for (const item of all.filter((i) => !inBar.has(i.key))) expect(panel, `${role} ${item.key}`).toContain(`href="${item.href}"`);
    }
    // …and the shell hands the panel the full capability-filtered list, not a subset.
    const shell = readFileSync(path.resolve(__dirname, "../../components/layout/app-shell.tsx"), "utf8");
    expect(shell).toContain("const items = navItemsFor(capabilities);");
    expect(shell).toMatch(/<MobileNavPanel[^>]*items=[{]items[}]/);
  });

  it("no desktop sidebar: the only side panel is the mobile one, hidden from 768 px (ADR-013 §3, amended 2026-09-25)", () => {
    const shells = [
      html(<HeaderNav items={adminItems} pathname="/restaurant/dashboard" />),
      html(<BottomNav items={adminItems.slice(0, 4)} action={primaryActionFor(permissionsForTenantRole("TENANT_ADMIN"))} pathname="/restaurant/dashboard" onOpenMenu={() => undefined} menuOpen={false} />),
    ];
    for (const out of shells) {
      expect(out).not.toContain("<aside");
      expect(out).not.toContain("w-sidebar");
    }
    const panel = readFileSync(path.resolve(__dirname, "../../components/layout/mobile-nav-panel.tsx"), "utf8");
    expect(panel).toContain('className="md:hidden"');
  });
});

describe("platform console", () => {
  it("Overview is active only on /admin itself", () => {
    expect(activeAdminItem("/admin")?.href).toBe("/admin");
    expect(activeAdminItem("/admin/tenants")?.href).toBe("/admin/tenants");
    expect(activeAdminItem("/admin/tenants/123")?.href).toBe("/admin/tenants");
    expect(activeAdminItem("/admin/audit")?.href).toBe("/admin/audit");
    expect(ADMIN_NAV_ITEMS.map((i) => i.label)).toEqual(["Overview", "Restaurants", "Audit"]);
  });

  it("every platform item carries an icon and a domain hue", () => {
    for (const item of ADMIN_NAV_ITEMS) {
      expect(item.icon, item.label).toBeTruthy();
      expect(HUE_TILE[item.hue], item.label).toBeTruthy();
    }
  });

  it("role labels are sentence case", () => {
    expect(roleLabel("TENANT_ADMIN")).toBe("Tenant admin");
    expect(roleLabel("KITCHEN")).toBe("Kitchen");
  });
});
