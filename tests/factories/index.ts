/**
 * Entity factories for integration tests (S1-P02-T008). Every factory takes the client (or a transaction client)
 * explicitly and sets `tenantId` on every tenant-owned row, mirroring the production rule that tenant context
 * comes from the server, never from input.
 */
import { randomUUID } from "node:crypto";
import {
  OrderStatus,
  OrderType,
  PaymentMethod,
  PlatformRole,
  Prisma,
  PrintJobStatus,
  PrintJobType,
  PrinterConnection,
  PrinterPurpose,
  TenantRole,
  TransactionType,
} from "@prisma/client";

type Db = Prisma.TransactionClient;

let sequence = 0;
const next = () => ++sequence;
const money = (value: Prisma.Decimal.Value) => new Prisma.Decimal(value).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

export async function createTenant(
  db: Db,
  overrides: { name?: string; slug?: string; timezone?: string; currencyCode?: string; countryCode?: string; status?: "ACTIVE" | "SUSPENDED" } = {},
) {
  const n = next();
  const tenant = await db.tenant.create({
    data: {
      name: overrides.name ?? `Tenant ${n}`,
      slug: overrides.slug ?? `tenant-${n}-${randomUUID().slice(0, 8)}`,
      status: overrides.status ?? "ACTIVE",
    },
  });
  const restaurant = await db.restaurant.create({
    data: {
      tenantId: tenant.id,
      name: overrides.name ?? `Restaurant ${n}`,
      countryCode: overrides.countryCode ?? "IN",
      timezone: overrides.timezone ?? "Asia/Kolkata",
      currencyCode: overrides.currencyCode ?? "INR",
    },
  });
  return { tenant, restaurant };
}

export async function createUser(db: Db, overrides: { email?: string; fullName?: string; platformRole?: PlatformRole } = {}) {
  const n = next();
  return db.user.create({
    data: {
      email: overrides.email ?? `user${n}-${randomUUID().slice(0, 8)}@example.test`,
      fullName: overrides.fullName ?? `User ${n}`,
      platformRole: overrides.platformRole ?? PlatformRole.NONE,
    },
  });
}

export async function createMembership(db: Db, tenantId: string, userId: string, role: TenantRole = TenantRole.TENANT_ADMIN) {
  return db.userTenant.create({
    data: { tenantId, userId, role, status: "ACTIVE", acceptedAt: new Date() },
  });
}

export async function createKitchenSection(db: Db, tenantId: string, overrides: { name?: string; code?: string } = {}) {
  const n = next();
  return db.kitchenSection.create({
    data: { tenantId, name: overrides.name ?? `Section ${n}`, code: overrides.code ?? `SEC_${n}` },
  });
}

export async function createCategory(db: Db, tenantId: string, overrides: { name?: string } = {}) {
  return db.menuCategory.create({ data: { tenantId, name: overrides.name ?? `Category ${next()}` } });
}

export async function createMenuItem(
  db: Db,
  tenantId: string,
  categoryId: string,
  overrides: { name?: string; basePrice?: string; taxRate?: string; kitchenSectionId?: string | null } = {},
) {
  return db.menuItem.create({
    data: {
      tenantId,
      categoryId,
      name: overrides.name ?? `Item ${next()}`,
      basePrice: new Prisma.Decimal(overrides.basePrice ?? "100.00"),
      taxRate: new Prisma.Decimal(overrides.taxRate ?? "5.00"),
      kitchenSectionId: overrides.kitchenSectionId ?? null,
      isPublished: true,
    },
  });
}

export async function createVariant(db: Db, tenantId: string, menuItemId: string, overrides: { name?: string; price?: string; isDefault?: boolean } = {}) {
  return db.menuItemVariant.create({
    data: {
      tenantId,
      menuItemId,
      name: overrides.name ?? `Variant ${next()}`,
      price: new Prisma.Decimal(overrides.price ?? "120.00"),
      isDefault: overrides.isDefault ?? false,
    },
  });
}

export async function createAddon(db: Db, tenantId: string, menuItemId: string, overrides: { name?: string; price?: string } = {}) {
  return db.menuItemAddon.create({
    data: { tenantId, menuItemId, name: overrides.name ?? `Addon ${next()}`, price: new Prisma.Decimal(overrides.price ?? "20.00") },
  });
}

export async function createCustomer(db: Db, tenantId: string, overrides: { fullName?: string; phoneE164?: string | null } = {}) {
  return db.customer.create({
    data: {
      tenantId,
      fullName: overrides.fullName ?? `Customer ${next()}`,
      phoneE164: overrides.phoneE164 === undefined ? null : overrides.phoneE164,
    },
  });
}

/** An order with one line per item, totals computed per line with ROUND_HALF_UP (ADR-010 §3). */
export async function createOrder(
  db: Db,
  tenantId: string,
  lines: Array<{ menuItem: { id: string; name: string; basePrice: Prisma.Decimal; taxRate: Prisma.Decimal }; quantity: number }>,
  overrides: { status?: OrderStatus; businessDate?: Date; customerId?: string | null; currencyCode?: string } = {},
) {
  const n = next();
  const businessDate = overrides.businessDate ?? new Date("2026-09-15T00:00:00.000Z");
  const priced = lines.map((line) => {
    const lineSubtotal = money(line.menuItem.basePrice.mul(line.quantity));
    const lineTax = money(lineSubtotal.mul(line.menuItem.taxRate).div(100));
    return { ...line, lineSubtotal, lineTax, lineTotal: lineSubtotal.add(lineTax) };
  });
  const subtotalAmount = priced.reduce((sum, l) => sum.add(l.lineSubtotal), new Prisma.Decimal(0));
  const taxAmount = priced.reduce((sum, l) => sum.add(l.lineTax), new Prisma.Decimal(0));

  const order = await db.order.create({
    data: {
      tenantId,
      orderNumber: `T-${n}-${randomUUID().slice(0, 6)}`,
      businessDate,
      orderType: OrderType.DINE_IN,
      status: overrides.status ?? OrderStatus.NEW,
      subtotalAmount,
      taxAmount,
      totalAmount: subtotalAmount.add(taxAmount),
      currencyCode: overrides.currencyCode ?? "INR",
      idempotencyKey: randomUUID(),
      customerId: overrides.customerId ?? null,
    },
  });
  const items = [];
  for (const line of priced) {
    items.push(
      await db.orderItem.create({
        data: {
          tenantId,
          orderId: order.id,
          menuItemId: line.menuItem.id,
          itemNameSnapshot: line.menuItem.name,
          unitPriceSnapshot: line.menuItem.basePrice,
          taxRateSnapshot: line.menuItem.taxRate,
          quantity: line.quantity,
          lineSubtotal: line.lineSubtotal,
          lineTax: line.lineTax,
          lineTotal: line.lineTotal,
        },
      }),
    );
  }
  return { order, items };
}

export async function createKotTicket(db: Db, tenantId: string, orderId: string, overrides: { kitchenSectionId?: string | null; roundNumber?: number; kotNumber?: string } = {}) {
  return db.kotTicket.create({
    data: {
      tenantId,
      orderId,
      kitchenSectionId: overrides.kitchenSectionId ?? null,
      roundNumber: overrides.roundNumber ?? 1,
      businessDate: new Date("2026-09-15T00:00:00.000Z"),
      kotNumber: overrides.kotNumber ?? `K-${next()}`,
      orderTypeSnapshot: OrderType.DINE_IN,
    },
  });
}

export async function createPayment(db: Db, tenantId: string, orderId: string, recordedByUserId: string, amount: string, method: PaymentMethod = PaymentMethod.CARD) {
  return db.transaction.create({
    data: {
      tenantId,
      orderId,
      type: TransactionType.PAYMENT,
      paymentMethod: method,
      amount: new Prisma.Decimal(amount),
      businessDate: new Date("2026-09-15T00:00:00.000Z"),
      idempotencyKey: randomUUID(),
      recordedByUserId,
    },
  });
}

export async function createPrintAgent(db: Db, tenantId: string, createdByUserId: string) {
  return db.printAgent.create({ data: { tenantId, name: `Agent ${next()}`, createdByUserId } });
}

export async function createPrinter(db: Db, tenantId: string, overrides: { printAgentId?: string | null; kitchenSectionId?: string | null } = {}) {
  return db.printer.create({
    data: {
      tenantId,
      name: `Printer ${next()}`,
      purpose: PrinterPurpose.KOT_AND_RECEIPT,
      connectionType: PrinterConnection.LAN,
      connectionAddress: "192.168.1.50:9100",
      printAgentId: overrides.printAgentId ?? null,
      kitchenSectionId: overrides.kitchenSectionId ?? null,
    },
  });
}

export async function createPrintJob(db: Db, tenantId: string, printerId: string, overrides: { status?: PrintJobStatus; jobType?: PrintJobType } = {}) {
  return db.printJob.create({
    data: {
      tenantId,
      printerId,
      jobType: overrides.jobType ?? PrintJobType.TEST,
      dedupeKey: `TEST:${randomUUID()}`,
      payload: { lines: ["Test print"] },
      status: overrides.status ?? PrintJobStatus.PENDING,
    },
  });
}

/**
 * Tenant A and Tenant B with deliberately identical content names (e.g. category "Starters"), so a cross-tenant leak
 * is detectable by content as well as by id (tenant-isolation-tests.md, SC-TEN-10).
 */
export async function createTenantPair(db: Db) {
  const build = async (label: "A" | "B") => {
    const { tenant, restaurant } = await createTenant(db, {
      name: `Tenant ${label}`,
      timezone: label === "A" ? "Asia/Kolkata" : "America/New_York",
      currencyCode: label === "A" ? "INR" : "USD",
      countryCode: label === "A" ? "IN" : "US",
    });
    const admin = await createUser(db, { fullName: `Tenant ${label} Admin` });
    await createMembership(db, tenant.id, admin.id, TenantRole.TENANT_ADMIN);
    const section = await createKitchenSection(db, tenant.id, { name: "Main Kitchen", code: "MAIN" });
    const category = await createCategory(db, tenant.id, { name: "Starters" });
    const menuItem = await createMenuItem(db, tenant.id, category.id, { name: "Paneer Tikka", kitchenSectionId: section.id });
    const customer = await createCustomer(db, tenant.id, { fullName: "Asha Rao" });
    const { order, items } = await createOrder(db, tenant.id, [{ menuItem, quantity: 2 }], { customerId: customer.id });
    return { tenant, restaurant, admin, section, category, menuItem, customer, order, orderItem: items[0] };
  };
  return { tenantA: await build("A"), tenantB: await build("B") };
}

/**
 * One row in every tenant-owned table, with every optional tenant-scoped foreign key filled in.
 * Used by the composite-FK suite (S1-P02-T004) to attempt a cross-tenant reference for each FK.
 */
export async function createFullTenant(db: Db, label: string) {
  const { tenant, restaurant } = await createTenant(db, { name: `Full ${label}` });
  const user = await createUser(db, { fullName: `Owner ${label}` });
  const membership = await createMembership(db, tenant.id, user.id, TenantRole.TENANT_ADMIN);
  const hours = await db.restaurantHours.create({
    data: { tenantId: tenant.id, restaurantId: restaurant.id, dayOfWeek: 1, opensAt: new Date("1970-01-01T09:00:00Z"), closesAt: new Date("1970-01-01T22:00:00Z") },
  });
  const section = await createKitchenSection(db, tenant.id);
  const category = await createCategory(db, tenant.id);
  const menuItem = await createMenuItem(db, tenant.id, category.id, { kitchenSectionId: section.id });
  const variant = await createVariant(db, tenant.id, menuItem.id, { isDefault: true });
  const addon = await createAddon(db, tenant.id, menuItem.id);
  const dailyMenu = await db.dailyMenu.create({
    data: { tenantId: tenant.id, businessDate: new Date("2026-09-14T00:00:00Z"), createdByUserId: user.id },
  });
  const copiedDailyMenu = await db.dailyMenu.create({
    data: { tenantId: tenant.id, businessDate: new Date("2026-09-15T00:00:00Z"), createdByUserId: user.id, copiedFromDailyMenuId: dailyMenu.id },
  });
  const dailyMenuItem = await db.dailyMenuItem.create({ data: { tenantId: tenant.id, dailyMenuId: dailyMenu.id, menuItemId: menuItem.id } });
  const customer = await createCustomer(db, tenant.id, { phoneE164: null });
  const { order, items } = await createOrder(db, tenant.id, [{ menuItem, quantity: 1 }], { customerId: customer.id });
  const orderItem = await db.orderItem.update({ where: { id: items[0].id }, data: { variantId: variant.id, kitchenSectionId: section.id } });
  const orderItemAddon = await db.orderItemAddon.create({
    data: { tenantId: tenant.id, orderItemId: orderItem.id, addonId: addon.id, nameSnapshot: addon.name, priceSnapshot: addon.price },
  });
  const kot = await createKotTicket(db, tenant.id, order.id, { kitchenSectionId: section.id });
  const kotItem = await db.kotItem.create({
    data: { tenantId: tenant.id, kotTicketId: kot.id, orderItemId: orderItem.id, quantity: 1, itemLabelSnapshot: menuItem.name },
  });
  const payment = await createPayment(db, tenant.id, order.id, user.id, "10.00");
  const refund = await db.transaction.create({
    data: {
      tenantId: tenant.id,
      orderId: order.id,
      type: TransactionType.REFUND,
      paymentMethod: PaymentMethod.CARD,
      amount: new Prisma.Decimal("1.00"),
      refundOfTransactionId: payment.id,
      reason: "Fixture refund",
      businessDate: new Date("2026-09-15T00:00:00.000Z"),
      idempotencyKey: randomUUID(),
      recordedByUserId: user.id,
    },
  });
  const agent = await createPrintAgent(db, tenant.id, user.id);
  // TC-DB-004 walks every composite foreign key and needs a row on each child side to push across the tenant
  // boundary. Without this, `printer_discoveries(tenant_id, print_agent_id)` has nothing to test and the key goes
  // unchecked — which is what that test reports rather than passing quietly.
  const printerDiscovery = await db.printerDiscovery.create({
    data: { tenantId: tenant.id, printAgentId: agent.id, requestedByUserId: user.id },
  });
  // TC-DB-004 walks every composite foreign key and needs a row on each child side; staff_credentials and
  // staff_sessions each carry (tenant_id, membership_id), and staff_sessions also (tenant_id, credential_id).
  // A staff-role membership, because `staff_sessions_role_is_staff_check` refuses any other (ADR-019 §1).
  const staffUser = await createUser(db, { fullName: `Cashier ${label}` });
  const staffMembership = await createMembership(db, tenant.id, staffUser.id, TenantRole.CASHIER);
  const staffCredential = await db.staffCredential.create({
    data: {
      tenantId: tenant.id,
      membershipId: staffMembership.id,
      userId: staffUser.id,
      passwordHash: "scrypt$65536$8$1$c2FsdHNhbHRzYWx0c2E=$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g=",
      businessDate: new Date("2026-09-15T00:00:00.000Z"),
      expiresAt: new Date("2126-09-15T18:30:00.000Z"),
      generatedByUserId: user.id,
    },
  });
  const staffSession = await db.staffSession.create({
    data: {
      tenantId: tenant.id,
      membershipId: staffMembership.id,
      userId: staffUser.id,
      credentialId: staffCredential.id,
      role: TenantRole.CASHIER,
      tokenHash: randomUUID().replace(/-/g, "").padEnd(64, "0").slice(0, 64),
      businessDate: new Date("2026-09-15T00:00:00.000Z"),
      expiresAt: new Date("2126-09-15T18:30:00.000Z"),
    },
  });
  const printer = await createPrinter(db, tenant.id, { printAgentId: agent.id, kitchenSectionId: section.id });
  const printJob = await db.printJob.create({
    data: {
      tenantId: tenant.id,
      printerId: printer.id,
      printAgentId: agent.id,
      jobType: PrintJobType.KOT,
      orderId: order.id,
      kotTicketId: kot.id,
      dedupeKey: `KOT:${kot.id}:v1`,
      payload: { lines: ["KOT"] },
    },
  });
  const socialPost = await db.socialPost.create({
    data: {
      tenantId: tenant.id,
      channel: "WHATSAPP",
      cardType: "MENU_ITEM",
      dailyMenuId: dailyMenu.id,
      menuItemId: menuItem.id,
      caption: "Fixture caption",
      shareUrl: "https://example.test/r/fixture",
      createdByUserId: user.id,
    },
  });
  const dayClose = await db.businessDayClose.create({
    data: {
      tenantId: tenant.id,
      businessDate: new Date("2026-09-14T00:00:00Z"),
      expectedCash: new Prisma.Decimal("0.00"),
      countedCash: new Prisma.Decimal("0.00"),
      cashVariance: new Prisma.Decimal("0.00"),
      cardTotal: new Prisma.Decimal("0.00"),
      upiTotal: new Prisma.Decimal("0.00"),
      refundTotal: new Prisma.Decimal("0.00"),
      orderCount: 0,
      openOrderCount: 0,
      closedByUserId: user.id,
    },
  });
  const audit = await db.auditLog.create({
    data: { tenantId: tenant.id, actorType: "USER", actorUserId: user.id, action: "fixture.created", resourceType: "tenant", resourceId: tenant.id },
  });
  await db.tenantCounter.create({ data: { tenantId: tenant.id, counterType: "ORDER", businessDate: new Date("2026-09-15T00:00:00Z"), lastValue: 1 } });
  const websiteSection = await db.websiteSection.create({
    data: {
      tenantId: tenant.id,
      restaurantId: restaurant.id,
      key: "HERO",
      sortOrder: 0,
      headline: "Welcome",
      ctaLabel: "See the menu",
      ctaHref: "/menu",
    },
  });

  return { tenant, restaurant, user, membership, hours, section, category, menuItem, variant, addon, dailyMenu, copiedDailyMenu, dailyMenuItem, customer, order, orderItem, orderItemAddon, kot, kotItem, payment, refund, agent, printerDiscovery, staffUser, staffMembership, staffCredential, staffSession, printer, printJob, socialPost, dayClose, websiteSection, audit };
}
