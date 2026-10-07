import type { PrismaClient } from "@prisma/client";
import type { Page } from "@playwright/test";
import { hashStaffPassword } from "@/lib/auth/staff-password";

/**
 * Staff sign-in for browser tests (RASOIOS-ADR-019). Administrators need Clerk, which has no test accounts here;
 * counter and kitchen staff need only a daily password, so a test issues one exactly as the console stores it — hashed,
 * for today's business date, expiring — and signs in through the real /staff-login form.
 */
export const STAFF_PASSWORD = "E2E7-TEST";

/** Today's password for the seeded Spice Route member with this role; returns their email. */
export async function issueStaffPassword(db: PrismaClient, role: "CASHIER" | "KITCHEN" | "WAITER"): Promise<string> {
  const tenant = await db.tenant.findUniqueOrThrow({ where: { slug: "spice-route" }, include: { restaurant: true } });
  const membership = await db.userTenant.findFirstOrThrow({ where: { tenantId: tenant.id, role, status: "ACTIVE" }, include: { user: true } });
  const admin = await db.userTenant.findFirstOrThrow({ where: { tenantId: tenant.id, role: "TENANT_ADMIN", status: "ACTIVE" } });
  const today = new Date(`${new Intl.DateTimeFormat("en-CA", { timeZone: tenant.restaurant!.timezone }).format(new Date())}T00:00:00.000Z`);
  await db.staffCredential.updateMany({ where: { tenantId: tenant.id, membershipId: membership.id, status: "ACTIVE" }, data: { status: "REVOKED", revokedAt: new Date() } });
  await db.staffCredential.create({
    data: {
      tenantId: tenant.id,
      membershipId: membership.id,
      userId: membership.userId,
      passwordHash: await hashStaffPassword(STAFF_PASSWORD),
      businessDate: today,
      expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000),
      generatedByUserId: admin.userId,
    },
  });
  return membership.user.email;
}

export async function signInAsStaff(page: Page, email: string) {
  await page.goto("/staff-login");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel(/password/i).fill(STAFF_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(/\/restaurant\//, { timeout: 60_000 });
}
