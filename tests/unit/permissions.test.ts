import type { TenantRole } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  AGENT_SCOPES,
  hasPermission,
  isPermission,
  permissionsForPlatformRole,
  permissionsForTenantRole,
  ROLE_RANK,
  TENANT_ROLE_PERMISSIONS,
} from "@/lib/auth/permissions";

// TC-RBAC-001 / TC-RBAC-002 — deny by default; platform and tenant permissions never mix (S1-P05-T001).
const tenantRoles = Object.keys(TENANT_ROLE_PERMISSIONS) as TenantRole[];
const holder = (permissions: Iterable<string>) => ({ permissions: new Set(permissions) });

describe("TC-RBAC-001 deny by default", () => {
  it("denies unknown permission codes even if a holder somehow carries them", () => {
    expect(hasPermission(holder(["order:read", "order:delete_everything"]), "order:delete_everything")).toBe(false);
    expect(isPermission("order:delete_everything")).toBe(false);
    expect(isPermission("order:read")).toBe(true);
  });

  it("denies when there is no holder, no role or an empty set", () => {
    expect(hasPermission(null, "order:read")).toBe(false);
    expect(hasPermission(undefined, "order:read")).toBe(false);
    expect(hasPermission(holder([]), "order:read")).toBe(false);
    expect(permissionsForTenantRole(null).size).toBe(0);
    expect(permissionsForPlatformRole("NONE").size).toBe(0);
  });

  it("grants exactly what the role lists", () => {
    const cashier = holder(permissionsForTenantRole("CASHIER"));
    expect(hasPermission(cashier, "payment:record")).toBe(true);
    expect(hasPermission(cashier, "refund:create")).toBe(false);
    const kitchen = holder(permissionsForTenantRole("KITCHEN"));
    expect(hasPermission(kitchen, "kot:update_status")).toBe(true);
    expect(hasPermission(kitchen, "customer:read")).toBe(false);
    expect(hasPermission(kitchen, "order:create")).toBe(false);
  });
});

describe("TC-RBAC-002 platform and tenant permissions never mix", () => {
  it("no tenant role grants any platform:* permission", () => {
    for (const role of tenantRoles) {
      expect([...permissionsForTenantRole(role)].filter((p) => p.startsWith("platform:")), role).toEqual([]);
    }
  });

  it("SUPER_ADMIN has only platform:* permissions and no tenant permission", () => {
    const sa = [...permissionsForPlatformRole("SUPER_ADMIN")];
    expect(sa.length).toBe(9); // + platform:demo_request:read and :update (ADR-024)
    expect(sa.every((p) => p.startsWith("platform:"))).toBe(true);
    expect(hasPermission(holder(sa), "order:read")).toBe(false);
  });

  it("agent scopes are not permissions of any role", () => {
    for (const role of tenantRoles) for (const scope of AGENT_SCOPES) expect(permissionsForTenantRole(role).has(scope as never)).toBe(false);
  });

  it("ranks TENANT_ADMIN above MANAGER above CASHIER above WAITER/KITCHEN", () => {
    expect(ROLE_RANK.TENANT_ADMIN).toBeGreaterThan(ROLE_RANK.MANAGER);
    expect(ROLE_RANK.MANAGER).toBeGreaterThan(ROLE_RANK.CASHIER);
    expect(ROLE_RANK.CASHIER).toBeGreaterThan(ROLE_RANK.WAITER);
    expect(ROLE_RANK.WAITER).toBe(ROLE_RANK.KITCHEN);
  });
});
