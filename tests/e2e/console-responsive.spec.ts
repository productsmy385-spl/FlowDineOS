import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { hashStaffPassword } from "@/lib/auth/staff-password";

/**
 * TC-RESP-010 — the console fits every width (owner brief 2026-10-06 §22): no horizontal page scroll and no visible
 * element past the right edge, from a 320 px phone to a 1920 px desktop.
 *
 * Console pages need a session. Administrators sign in through Clerk, which this environment has no test accounts
 * for; counter and kitchen staff sign in with a daily password (ADR-019), which needs nothing outside the app. So each
 * staff role is given today's password here — hashed, exactly as the console stores one — and signs in through the
 * real /staff-login form, then every screen that role can open is checked at every width.
 */
const WIDTHS = [320, 360, 375, 390, 414, 480, 768, 834, 1024, 1280, 1440, 1920];
const PASSWORD = "E2E7-TEST";

const ONLY = process.env.RESP_ONLY; // e.g. "CASHIER:/restaurant/printing" while debugging one screen
const ROLES = {
  CASHIER: ["/restaurant/orders", "/restaurant/orders/new", "/restaurant/transactions", "/restaurant/customers", "/restaurant/kitchen", "/restaurant/printing"],
  KITCHEN: ["/restaurant/kitchen", "/restaurant/orders", "/restaurant/menu/items", "/restaurant/daily-menu"],
  WAITER: ["/restaurant/orders", "/restaurant/customers", "/restaurant/menu/items", "/restaurant/daily-menu"],
} as const;

const db = new PrismaClient();
test.afterAll(() => db.$disconnect());

/** Today's password for the seeded Spice Route member with this role; returns their email. */
async function issuePassword(role: keyof typeof ROLES): Promise<string> {
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
      passwordHash: await hashStaffPassword(PASSWORD),
      businessDate: today,
      expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000),
      generatedByUserId: admin.userId,
    },
  });
  return membership.user.email;
}

async function signIn(page: Page, email: string) {
  await page.goto("/staff-login");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel(/password/i).fill(PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(/\/restaurant\//, { timeout: 60_000 });
}

/** Horizontal page scroll, plus any visible element whose right edge passes the viewport (ignoring inner scrollers). */
async function overflowAt(page: Page) {
  return page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const scroll = document.documentElement.scrollWidth - width;
    const insideScroller = (el: Element) => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        const style = getComputedStyle(p);
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) return true;
      }
      return false;
    };
    const offenders = [...document.querySelectorAll("body *")]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0 || getComputedStyle(el).visibility === "hidden") return false;
        return r.right > width + 1 && !insideScroller(el);
      })
      .slice(0, 3)
      .map((el) => `${el.tagName.toLowerCase()}.${String((el as HTMLElement).className).slice(0, 60)}`);
    return { scroll, offenders };
  });
}

const selected = (Object.entries(ROLES) as Array<[keyof typeof ROLES, readonly string[]]>)
  .map(([role, paths]) => [role, paths.filter((p) => !ONLY || ONLY === `${role}:${p}`)] as const)
  .filter(([, paths]) => paths.length > 0);

for (const [role, paths] of selected) {
  test(`TC-RESP-010 ${role} screens fit 320–1920 px`, async ({ page }) => {
    test.setTimeout(15 * 60_000);
    await signIn(page, await issuePassword(role));
    for (const path of paths) {
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(path);
        await page.waitForLoadState("domcontentloaded");
        const { scroll, offenders } = await overflowAt(page);
        expect({ scroll: scroll <= 1 ? 0 : scroll, offenders }, `${role} ${path} at ${width}px`).toEqual({ scroll: 0, offenders: [] });
      }
    }
  });
}
