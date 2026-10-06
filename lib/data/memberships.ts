import "server-only";
import type { TenantRole, TenantStatus } from "@prisma/client";
import { db } from "@/lib/db/prisma";
import { mapErrors } from "./errors";

/**
 * Memberships of one user (S1-P04-T001). Identity-level reads: a user's own memberships span tenants by definition,
 * so these queries filter by `userId`, never by a caller-supplied tenant.
 */
export type MembershipRow = {
  membershipId: string;
  tenantId: string;
  role: TenantRole;
  tenantName: string;
  tenantSlug: string;
  tenantStatus: TenantStatus;
  /** Features the platform owner has switched off for this restaurant (RASOIOS-ADR-023). */
  disabledFeatures: string[];
  restaurant: { id: string; name: string; timezone: string; currencyCode: string; countryCode: string; logoUrl: string | null } | null;
};

export async function activeMembershipsOfUser(userId: string): Promise<MembershipRow[]> {
  const rows = await mapErrors("Membership", () =>
    // tenant-scope-exempt: the signed-in user's own ACTIVE memberships across tenants (ADR-006 §3)
    db.userTenant.findMany({
      where: { userId, status: "ACTIVE" },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        tenantId: true,
        role: true,
        tenant: {
          select: {
            name: true,
            slug: true,
            status: true,
            features: { where: { enabled: false }, select: { featureKey: true } },
            // `logoUrl` so the console can wear the restaurant's own brand rather than the platform's (ADR-013 §1).
            restaurant: { select: { id: true, name: true, timezone: true, currencyCode: true, countryCode: true, logoUrl: true } },
          },
        },
      },
    }),
  );
  return rows.map((m) => ({
    membershipId: m.id,
    tenantId: m.tenantId,
    role: m.role,
    tenantName: m.tenant.name,
    tenantSlug: m.tenant.slug,
    tenantStatus: m.tenant.status,
    disabledFeatures: m.tenant.features.map((f) => f.featureKey),
    restaurant: m.tenant.restaurant,
  }));
}
