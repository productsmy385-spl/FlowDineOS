/**
 * Permission catalogue v2 (S1-P05-T001, security.md §3.2–3.3). The single source for server checks and the UI
 * capability map (SC-RBAC-02, SC-RBAC-08). Deny by default: anything not listed here is refused.
 *
 * SUPER_ADMIN is a platform role (USER.platform_role) with `platform:*` permissions only — no tenant permissions,
 * no tenant context (ADR-006 §1). Tenant roles never receive `platform:*`.
 * `tests/static/rbac-matrix.test.ts` fails if this file drifts from the security.md matrix (TC-RBAC-001).
 */
import type { PlatformRole, TenantRole } from "@prisma/client";

export const PLATFORM_PERMISSIONS = [
  "platform:tenant:read",
  "platform:tenant:create",
  "platform:tenant:update",
  "platform:tenant:suspend",
  "platform:tenant:reactivate",
  "platform:tenant_admin:invite",
  "platform:audit:read",
] as const;

export const TENANT_PERMISSIONS = [
  "dashboard:read",
  "restaurant:read",
  "restaurant:update",
  "restaurant:settings:update",
  "website:update",
  "kitchen_section:manage",
  "staff:read",
  "staff:invite",
  "staff:update_role",
  "staff:deactivate",
  "menu:read",
  "menu:manage",
  "menu:availability:update",
  "daily_menu:read",
  "daily_menu:manage",
  "order:read",
  "order:create",
  "order:add_items",
  "order:accept",
  "order:kitchen_update",
  "order:complete",
  "order:cancel",
  "order:update_meta",
  "kot:read",
  "kot:update_status",
  "kot:serve",
  "kot:reprint",
  "customer:read",
  "customer:create",
  "customer:update",
  "customer:archive",
  "transaction:read",
  "payment:record",
  "refund:create",
  "transaction:void",
  "day_close:perform",
  "printer:manage",
  "print_agent:manage",
  "print_job:read",
  "print_job:retry",
  "report:read",
  "social:manage",
  "audit:read",
  // RASOIOS-ADR-021: backups, restore and date-range deletion (owner only), and table QR codes.
  "data:export",
  "data:import",
  "data:purge",
  "table:manage",
] as const;

/** Print-agent credential scopes (not a role; RH-AGT-02…05, ADR-007). */
export const AGENT_SCOPES = ["agent:job:claim", "agent:job:ack", "agent:heartbeat", "agent:config:read"] as const;

export const PERMISSIONS = [...PLATFORM_PERMISSIONS, ...TENANT_PERMISSIONS] as const;

export type PlatformPermission = (typeof PLATFORM_PERMISSIONS)[number];
export type TenantPermission = (typeof TENANT_PERMISSIONS)[number];
export type Permission = PlatformPermission | TenantPermission;
export type AgentScope = (typeof AGENT_SCOPES)[number];

const ALL_TENANT_ROLES_READ: TenantPermission[] = ["restaurant:read", "menu:read", "daily_menu:read", "kot:read", "kot:serve"];

/** security.md §3.3, column by column. ◐ rows are granted here; their business-rule restriction lives in the service layer. */
export const TENANT_ROLE_PERMISSIONS: Readonly<Record<TenantRole, readonly TenantPermission[]>> = {
  TENANT_ADMIN: [...TENANT_PERMISSIONS],
  MANAGER: [
    "dashboard:read",
    ...ALL_TENANT_ROLES_READ,
    "staff:read",
    "staff:invite",
    "staff:update_role",
    "staff:deactivate",
    "menu:manage",
    "menu:availability:update",
    "daily_menu:manage",
    "order:read",
    "order:create",
    "order:add_items",
    "order:accept",
    "order:kitchen_update",
    "order:complete",
    "order:cancel",
    "order:update_meta",
    "kot:update_status",
    "kot:reprint",
    "customer:read",
    "customer:create",
    "customer:update",
    "customer:archive",
    "transaction:read",
    "payment:record",
    "refund:create",
    "transaction:void",
    "day_close:perform",
    "printer:manage",
    "print_job:read",
    "print_job:retry",
    "report:read",
    "social:manage",
    "table:manage",
  ],
  CASHIER: [
    ...ALL_TENANT_ROLES_READ,
    "order:read",
    "order:create",
    "order:add_items",
    "order:accept",
    "order:complete",
    "order:cancel",
    "order:update_meta",
    "kot:reprint",
    "customer:read",
    "customer:create",
    "customer:update",
    "transaction:read",
    "payment:record",
    "print_job:read",
    "print_job:retry",
  ],
  KITCHEN: [...ALL_TENANT_ROLES_READ, "order:read", "order:kitchen_update", "kot:update_status", "kot:reprint", "print_job:read", "print_job:retry"],
  WAITER: [
    ...ALL_TENANT_ROLES_READ,
    "order:read",
    "order:create",
    "order:add_items",
    "order:accept",
    "order:complete",
    "order:cancel",
    "order:update_meta",
    "customer:read",
    "customer:create",
  ],
};

export const PLATFORM_ROLE_PERMISSIONS: Readonly<Record<PlatformRole, readonly PlatformPermission[]>> = {
  NONE: [],
  SUPER_ADMIN: [...PLATFORM_PERMISSIONS],
};

/** Rank used for role assignment rules (security.md §3.1; enforced in S1-P05-T003). */
export const ROLE_RANK: Readonly<Record<TenantRole, number>> = {
  TENANT_ADMIN: 50,
  MANAGER: 40,
  CASHIER: 30,
  WAITER: 20,
  KITCHEN: 20,
};

const KNOWN = new Set<string>(PERMISSIONS);

export function isPermission(code: unknown): code is Permission {
  return typeof code === "string" && KNOWN.has(code);
}

export function permissionsForTenantRole(role: TenantRole | null | undefined): ReadonlySet<TenantPermission> {
  return new Set(role ? (TENANT_ROLE_PERMISSIONS[role] ?? []) : []);
}

export function permissionsForPlatformRole(role: PlatformRole | null | undefined): ReadonlySet<PlatformPermission> {
  return new Set(role ? (PLATFORM_ROLE_PERMISSIONS[role] ?? []) : []);
}

/** Deny by default: unknown codes, missing roles and missing contexts are all refused. */
export function hasPermission(holder: { permissions: ReadonlySet<string> } | null | undefined, code: string): boolean {
  if (!holder || !isPermission(code)) return false;
  return holder.permissions.has(code);
}
