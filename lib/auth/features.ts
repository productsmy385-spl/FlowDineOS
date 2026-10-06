import type { TenantPermission } from "./permissions";

/**
 * Per-restaurant feature switches (RASOIOS-ADR-023; owner decision 2026-10-06: "feature switches, no tiers").
 *
 * The platform owner turns whole features on or off for a restaurant. A feature that is off removes its permissions
 * from every session in that restaurant when the context is resolved, so every page, action, API route and navigation
 * entry that checks a permission follows automatically — hiding a button is never the safeguard. There are no named
 * packages and no prices: ADR-002's licence model stands; only its "no feature gating" clause is superseded.
 *
 * Not switchable — the restaurant cannot run without them: the dashboard, restaurant settings, menu reading (orders
 * and the kitchen need it), kitchen sections and the audit log.
 */
export const FEATURES = {
  ORDERS: {
    label: "Orders",
    description: "Take and manage orders at the counter and tables.",
    permissions: ["order:read", "order:create", "order:add_items", "order:accept", "order:kitchen_update", "order:complete", "order:cancel", "order:update_meta"],
  },
  KITCHEN: { label: "Kitchen display", description: "The kitchen ticket board.", permissions: ["kot:read", "kot:update_status", "kot:serve"] },
  PRINTING: {
    label: "Printers and KOT printing",
    description: "Thermal printers, the print agent, kitchen tickets and receipts on paper.",
    permissions: ["printer:manage", "print_agent:manage", "print_job:read", "print_job:retry", "kot:reprint"],
  },
  BILLING: {
    label: "Billing and payments",
    description: "Record payments and refunds, transactions and the day close.",
    permissions: ["transaction:read", "payment:record", "refund:create", "transaction:void", "day_close:perform"],
  },
  MENU: { label: "Menu management", description: "Edit categories, dishes, prices and availability.", permissions: ["menu:manage", "menu:availability:update"] },
  DAILY_MENU: { label: "Daily menu", description: "Publish today's menu.", permissions: ["daily_menu:read", "daily_menu:manage"] },
  CUSTOMERS: { label: "Customers", description: "The customer list.", permissions: ["customer:read", "customer:create", "customer:update", "customer:archive"] },
  REPORTS: { label: "Reports", description: "Sales and operations reports.", permissions: ["report:read"] },
  QR_MENU: { label: "Table QR menus", description: "QR codes on tables that open the menu.", permissions: ["table:manage"] },
  WEBSITE: { label: "Public website", description: "The restaurant's own website, theme and Brand Kit.", permissions: ["website:update"] },
  STAFF: { label: "Staff management", description: "Invite staff, roles and daily passwords.", permissions: ["staff:read", "staff:invite", "staff:update_role", "staff:deactivate"] },
  SOCIAL: { label: "Social sharing", description: "Social post drafts and sharing.", permissions: ["social:manage"] },
  DATA: { label: "Data import and export", description: "Backups, restore, list imports and clearing old data.", permissions: ["data:export", "data:import", "data:purge"] },
} as const satisfies Record<string, { label: string; description: string; permissions: readonly TenantPermission[] }>;

export type FeatureKey = keyof typeof FEATURES;
export const FEATURE_KEYS = Object.keys(FEATURES) as FeatureKey[];

export function isFeatureKey(value: unknown): value is FeatureKey {
  return typeof value === "string" && value in FEATURES;
}

/** The feature a permission belongs to, if it is switchable. */
export function featureOfPermission(permission: string): FeatureKey | null {
  for (const key of FEATURE_KEYS) if ((FEATURES[key].permissions as readonly string[]).includes(permission)) return key;
  return null;
}

/** A role's permissions with every permission of a disabled feature removed. */
export function withoutDisabledFeatures<P extends string>(permissions: ReadonlySet<P>, disabled: Iterable<string>): ReadonlySet<P> {
  const removed = new Set<string>();
  for (const key of disabled) if (isFeatureKey(key)) for (const p of FEATURES[key].permissions) removed.add(p);
  if (removed.size === 0) return permissions;
  return new Set([...permissions].filter((p) => !removed.has(p)));
}
