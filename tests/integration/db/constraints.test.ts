import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createAddon,
  createCategory,
  createCustomer,
  createKitchenSection,
  createKotTicket,
  createMenuItem,
  createOrder,
  createPayment,
  createPrintAgent,
  createPrintJob,
  createPrinter,
  createTenant,
  createUser,
  createVariant,
} from "../../factories";
import { disconnectTestDb, resetDatabase, sqlState, testDb } from "../setup/db";

// TC-DB-005 — every CHECK constraint and hand-written unique index in 0001_init rejects invalid data (S1-P02-T003).
// The catalogue tests at the bottom fail when a new constraint is added without a case here.
const db = testDb();

type Fixture = Awaited<ReturnType<typeof buildFixture>>;
let f: Fixture;

async function buildFixture() {
  const { tenant, restaurant } = await createTenant(db);
  const user = await createUser(db);
  const section = await createKitchenSection(db, tenant.id);
  const category = await createCategory(db, tenant.id);
  const item = await createMenuItem(db, tenant.id, category.id, { kitchenSectionId: section.id });
  const variant = await createVariant(db, tenant.id, item.id, { isDefault: true });
  const addon = await createAddon(db, tenant.id, item.id);
  const { order, items } = await createOrder(db, tenant.id, [{ menuItem: item, quantity: 1 }]);
  const orderItemAddon = await db.orderItemAddon.create({
    data: { tenantId: tenant.id, orderItemId: items[0].id, addonId: addon.id, nameSnapshot: addon.name, priceSnapshot: addon.price },
  });
  const kot = await createKotTicket(db, tenant.id, order.id);
  const kotItem = await db.kotItem.create({
    data: { tenantId: tenant.id, kotTicketId: kot.id, orderItemId: items[0].id, quantity: 1, itemLabelSnapshot: item.name },
  });
  const payment = await createPayment(db, tenant.id, order.id, user.id, "10.00");
  const hours = await db.restaurantHours.create({
    data: {
      tenantId: tenant.id,
      restaurantId: restaurant.id,
      dayOfWeek: 1,
      sequence: 1,
      opensAt: new Date("1970-01-01T09:00:00Z"),
      closesAt: new Date("1970-01-01T23:00:00Z"),
    },
  });
  const dayClose = await db.businessDayClose.create({
    data: {
      tenantId: tenant.id,
      businessDate: new Date("2026-09-14T00:00:00Z"),
      expectedCash: new Prisma.Decimal("100.00"),
      countedCash: new Prisma.Decimal("90.00"),
      cashVariance: new Prisma.Decimal("-10.00"),
      cardTotal: new Prisma.Decimal("0.00"),
      upiTotal: new Prisma.Decimal("0.00"),
      refundTotal: new Prisma.Decimal("0.00"),
      orderCount: 3,
      openOrderCount: 0,
      closedByUserId: user.id,
    },
  });
  const agent = await createPrintAgent(db, tenant.id, user.id);
  const printer = await createPrinter(db, tenant.id, { printAgentId: agent.id });
  const printJob = await createPrintJob(db, tenant.id, printer.id);
  await db.tenantCounter.create({
    data: { tenantId: tenant.id, counterType: "ORDER", businessDate: new Date("2026-09-15T00:00:00Z"), lastValue: 1 },
  });
  const bucketKey = `test:${randomUUID()}`;
  await db.rateLimitBucket.create({
    data: { bucketKey, windowStart: new Date(), hitCount: 1, expiresAt: new Date(Date.now() + 60_000) },
  });
  const websiteSection = await db.websiteSection.create({
    data: { tenantId: tenant.id, restaurantId: restaurant.id, key: "HERO", sortOrder: 0, headline: "Welcome", ctaLabel: "See the menu", ctaHref: "/menu" },
  });
  // A valid asset for the media_assets CHECKs to be pushed against (ADR-017 §3): allowed type, within the size and
  // dimension limits, an https URL, and live — so `status` and `deleted_at` agree.
  const mediaAsset = await db.mediaAsset.create({
    data: {
      tenantId: tenant.id,
      purpose: "LOGO",
      providerFileId: randomUUID(),
      storagePath: `/rasoios/${tenant.id}/logo/mark.png`,
      url: `https://ik.imagekit.io/test/${tenant.id}/logo/mark.png`,
      contentType: "image/png",
      byteSize: 24_576,
      width: 512,
      height: 512,
      sha256: "a".repeat(64),
      uploadedByUserId: user.id,
    },
  });
  // A staff membership with today's password and an open shift, for the staff_credentials / staff_sessions CHECKs
  // (ADR-019). CASHIER because `staff_sessions_role_is_staff_check` refuses any non-staff role outright.
  const staffUser = await createUser(db);
  const staffMembership = await db.userTenant.create({
    data: { tenantId: tenant.id, userId: staffUser.id, role: "CASHIER", status: "ACTIVE", acceptedAt: new Date() },
  });
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
      role: "CASHIER",
      tokenHash: "f".repeat(64),
      businessDate: new Date("2026-09-15T00:00:00.000Z"),
      expiresAt: new Date("2126-09-15T18:30:00.000Z"),
    },
  });
  return { tenant, restaurant, user, section, category, item, variant, addon, order, orderItem: items[0], orderItemAddon, kot, kotItem, payment, hours, dayClose, agent, printer, printJob, websiteSection, mediaAsset, staffCredential, staffSession, bucketKey };
}

beforeAll(async () => {
  await resetDatabase(db);
  f = await buildFixture();
});
afterAll(disconnectTestDb);

/** Runs a raw UPDATE expected to violate exactly `constraint`. Identifiers are test constants, values are bound. */
async function expectCheckViolation(table: string, set: string, where: string, constraint: string) {
  const sql = Prisma.sql`UPDATE ${Prisma.raw(`"${table}"`)} SET ${Prisma.raw(set)} WHERE ${Prisma.raw(where)}`;
  let error: unknown;
  try {
    await db.$executeRaw(sql);
  } catch (e) {
    error = e;
  }
  expect(error, `${constraint} did not reject: UPDATE ${table} SET ${set}`).toBeDefined();
  expect(sqlState(error)).toBe("23514");
  expect(String((error as Error).message)).toContain(constraint);
}

const byId = (id: () => string) => () => `id = '${id()}'`;

type CheckCase = { constraint: string; table: string; set: string; where: () => string };
const CHECK_CASES: CheckCase[] = [
  // E03 RESTAURANT_HOURS
  { constraint: "restaurant_hours_day_of_week_check", table: "restaurant_hours", set: "day_of_week = 8", where: byId(() => f.hours.id) },
  { constraint: "restaurant_hours_sequence_check", table: "restaurant_hours", set: "sequence = 4", where: byId(() => f.hours.id) },
  { constraint: "restaurant_hours_times_check", table: "restaurant_hours", set: "is_closed = true", where: byId(() => f.hours.id) },
  // E04 / E07
  { constraint: "kitchen_sections_sort_order_check", table: "kitchen_sections", set: "sort_order = -1", where: byId(() => f.section.id) },
  { constraint: "menu_categories_sort_order_check", table: "menu_categories", set: "sort_order = 10000", where: byId(() => f.category.id) },
  // E08 MENU_ITEM
  { constraint: "menu_items_base_price_check", table: "menu_items", set: "base_price = -0.01", where: byId(() => f.item.id) },
  { constraint: "menu_items_tax_rate_check", table: "menu_items", set: "tax_rate = 100.01", where: byId(() => f.item.id) },
  { constraint: "menu_items_prep_time_minutes_check", table: "menu_items", set: "prep_time_minutes = 241", where: byId(() => f.item.id) },
  { constraint: "menu_items_display_order_check", table: "menu_items", set: "display_order = -1", where: byId(() => f.item.id) },
  // E09 / E10
  { constraint: "menu_item_variants_price_check", table: "menu_item_variants", set: "price = -1", where: byId(() => f.variant.id) },
  { constraint: "menu_item_variants_display_order_check", table: "menu_item_variants", set: "display_order = 1000", where: byId(() => f.variant.id) },
  { constraint: "menu_item_addons_price_check", table: "menu_item_addons", set: "price = -1", where: byId(() => f.addon.id) },
  { constraint: "menu_item_addons_display_order_check", table: "menu_item_addons", set: "display_order = -1", where: byId(() => f.addon.id) },
  // E14 ORDER (INV-02, INV-04)
  { constraint: "orders_subtotal_amount_check", table: "orders", set: "subtotal_amount = -1, total_amount = -1 + tax_amount", where: byId(() => f.order.id) },
  { constraint: "orders_tax_amount_check", table: "orders", set: "tax_amount = -1, total_amount = subtotal_amount - 1", where: byId(() => f.order.id) },
  { constraint: "orders_discount_amount_check", table: "orders", set: "discount_amount = 1, total_amount = subtotal_amount + tax_amount - 1", where: byId(() => f.order.id) },
  { constraint: "orders_total_amount_check", table: "orders", set: "total_amount = total_amount + 0.01", where: byId(() => f.order.id) },
  { constraint: "orders_paid_amount_check", table: "orders", set: "paid_amount = -1", where: byId(() => f.order.id) },
  { constraint: "orders_refunded_amount_check", table: "orders", set: "refunded_amount = paid_amount + 1", where: byId(() => f.order.id) },
  { constraint: "orders_version_check", table: "orders", set: "version = -1", where: byId(() => f.order.id) },
  { constraint: "orders_currency_code_check", table: "orders", set: "currency_code = 'inr'", where: byId(() => f.order.id) },
  // E15 ORDER_ITEM
  { constraint: "order_items_quantity_check", table: "order_items", set: "quantity = 0, line_subtotal = 0, line_total = line_tax", where: byId(() => f.orderItem.id) },
  { constraint: "order_items_kot_round_check", table: "order_items", set: "kot_round = 0", where: byId(() => f.orderItem.id) },
  { constraint: "order_items_unit_price_snapshot_check", table: "order_items", set: "unit_price_snapshot = -1, addons_total_snapshot = addons_total_snapshot + unit_price_snapshot + 1", where: byId(() => f.orderItem.id) },
  { constraint: "order_items_addons_total_snapshot_check", table: "order_items", set: "addons_total_snapshot = -1", where: byId(() => f.orderItem.id) },
  { constraint: "order_items_tax_rate_snapshot_check", table: "order_items", set: "tax_rate_snapshot = 101", where: byId(() => f.orderItem.id) },
  { constraint: "order_items_line_subtotal_check", table: "order_items", set: "line_subtotal = -1, line_total = -1 + line_tax", where: byId(() => f.orderItem.id) },
  { constraint: "order_items_line_tax_check", table: "order_items", set: "line_tax = -1, line_total = line_subtotal - 1", where: byId(() => f.orderItem.id) },
  { constraint: "order_items_line_total_check", table: "order_items", set: "line_total = line_total + 0.01", where: byId(() => f.orderItem.id) },
  { constraint: "order_items_line_subtotal_formula_check", table: "order_items", set: "quantity = quantity + 1", where: byId(() => f.orderItem.id) },
  // E16 / E17 / E18
  { constraint: "order_item_addons_price_snapshot_check", table: "order_item_addons", set: "price_snapshot = -1", where: byId(() => f.orderItemAddon.id) },
  { constraint: "kot_tickets_round_number_check", table: "kot_tickets", set: "round_number = 0", where: byId(() => f.kot.id) },
  { constraint: "kot_items_quantity_check", table: "kot_items", set: "quantity = 100", where: byId(() => f.kotItem.id) },
  // E19 TRANSACTION
  { constraint: "transactions_amount_check", table: "transactions", set: "amount = 0", where: byId(() => f.payment.id) },
  { constraint: "transactions_amount_tendered_check", table: "transactions", set: "amount_tendered = amount", where: byId(() => f.payment.id) },
  { constraint: "transactions_change_due_check", table: "transactions", set: "change_due = -1", where: byId(() => f.payment.id) },
  { constraint: "transactions_refund_reference_check", table: "transactions", set: "type = 'REFUND'", where: byId(() => f.payment.id) },
  { constraint: "transactions_void_check", table: "transactions", set: "status = 'VOIDED'", where: byId(() => f.payment.id) },
  // E20 BUSINESS_DAY_CLOSE
  { constraint: "business_day_closes_counted_cash_check", table: "business_day_closes", set: "counted_cash = -1, cash_variance = -1 - expected_cash", where: byId(() => f.dayClose.id) },
  { constraint: "business_day_closes_cash_variance_check", table: "business_day_closes", set: "cash_variance = 0", where: byId(() => f.dayClose.id) },
  { constraint: "business_day_closes_refund_total_check", table: "business_day_closes", set: "refund_total = -1", where: byId(() => f.dayClose.id) },
  { constraint: "business_day_closes_counts_check", table: "business_day_closes", set: "open_order_count = -1", where: byId(() => f.dayClose.id) },
  // E21 / E23
  { constraint: "printers_paper_width_mm_check", table: "printers", set: "paper_width_mm = 72", where: byId(() => f.printer.id) },
  { constraint: "print_jobs_printed_at_check", table: "print_jobs", set: "status = 'PRINTED'", where: byId(() => f.printJob.id) },
  { constraint: "print_jobs_attempt_count_check", table: "print_jobs", set: "attempt_count = -1", where: byId(() => f.printJob.id) },
  { constraint: "print_jobs_max_attempts_check", table: "print_jobs", set: "max_attempts = 11", where: byId(() => f.printJob.id) },
  { constraint: "print_jobs_kot_ticket_check", table: "print_jobs", set: "job_type = 'KOT'", where: byId(() => f.printJob.id) },
  // E02 RESTAURANT — website theme and identity (migration 0002, ADR-013 §6)
  { constraint: "restaurants_brand_accent_hex_check", table: "restaurants", set: "brand_accent_hex = '#12ab34'", where: byId(() => f.restaurant.id) },
  { constraint: "restaurants_theme_primary_hex_check", table: "restaurants", set: "theme_primary_hex = 'green'", where: byId(() => f.restaurant.id) },
  { constraint: "restaurants_theme_secondary_hex_check", table: "restaurants", set: "theme_secondary_hex = '#GGG'", where: byId(() => f.restaurant.id) },
  { constraint: "restaurants_gradient_from_hex_check", table: "restaurants", set: "gradient_from_hex = '#1234'", where: byId(() => f.restaurant.id) },
  { constraint: "restaurants_gradient_to_hex_check", table: "restaurants", set: "gradient_to_hex = '#abcdez'", where: byId(() => f.restaurant.id) },
  { constraint: "restaurants_theme_custom_colours_check", table: "restaurants", set: "theme_preset = 'CUSTOM'", where: byId(() => f.restaurant.id) },
  { constraint: "restaurants_whatsapp_e164_check", table: "restaurants", set: "whatsapp_e164 = '09845012345'", where: byId(() => f.restaurant.id) },
  { constraint: "restaurants_hero_image_url_https_check", table: "restaurants", set: "hero_image_url = 'http://images.example.com/hero.jpg'", where: byId(() => f.restaurant.id) },
  { constraint: "restaurants_favicon_url_https_check", table: "restaurants", set: "favicon_url = 'javascript:alert(1)'", where: byId(() => f.restaurant.id) },
  { constraint: "restaurants_instagram_url_https_check", table: "restaurants", set: "instagram_url = 'http://instagram.com/x'", where: byId(() => f.restaurant.id) },
  { constraint: "restaurants_facebook_url_https_check", table: "restaurants", set: "facebook_url = 'ftp://facebook.com/x'", where: byId(() => f.restaurant.id) },
  { constraint: "restaurants_maps_url_https_check", table: "restaurants", set: "maps_url = 'http://maps.example.com/x'", where: byId(() => f.restaurant.id) },
  // E02a WEBSITE_SECTION
  { constraint: "website_sections_sort_order_check", table: "website_sections", set: "sort_order = 1000", where: byId(() => f.websiteSection.id) },
  { constraint: "website_sections_image_url_https_check", table: "website_sections", set: "image_url = 'http://images.example.com/section.jpg'", where: byId(() => f.websiteSection.id) },
  { constraint: "website_sections_cta_href_check", table: "website_sections", set: "cta_href = 'javascript:alert(1)'", where: byId(() => f.websiteSection.id) },
  // MEDIA_ASSET (ADR-017 §3, SC-FILE-01). The application checks all of these before it uploads; the database is the
  // backstop, so each one is proven to reject rather than assumed to.
  { constraint: "media_assets_content_type_check", table: "media_assets", set: "content_type = 'image/svg+xml'", where: byId(() => f.mediaAsset.id) },
  { constraint: "media_assets_byte_size_check", table: "media_assets", set: "byte_size = 5242881", where: byId(() => f.mediaAsset.id) },
  { constraint: "media_assets_dimensions_check", table: "media_assets", set: "width = 4097", where: byId(() => f.mediaAsset.id) },
  { constraint: "media_assets_url_https_check", table: "media_assets", set: "url = 'http://ik.imagekit.io/test/logo.png'", where: byId(() => f.mediaAsset.id) },
  { constraint: "media_assets_deleted_at_check", table: "media_assets", set: "status = 'DELETED'", where: byId(() => f.mediaAsset.id) },
  // STAFF DAILY LOGIN (ADR-019). The application checks all of these first; the database is the backstop.
  { constraint: "staff_credentials_expires_after_creation_check", table: "staff_credentials", set: "expires_at = created_at", where: byId(() => f.staffCredential.id) },
  { constraint: "staff_credentials_revoked_at_check", table: "staff_credentials", set: "status = 'REVOKED'", where: byId(() => f.staffCredential.id) },
  { constraint: "staff_credentials_failed_attempts_check", table: "staff_credentials", set: "failed_attempts = -1", where: byId(() => f.staffCredential.id) },
  // A plaintext password must never reach this column, whatever else goes wrong above it.
  { constraint: "staff_credentials_password_hash_check", table: "staff_credentials", set: "password_hash = 'ABCD-2345'", where: byId(() => f.staffCredential.id) },
  { constraint: "staff_sessions_ended_at_check", table: "staff_sessions", set: "status = 'ENDED', end_reason = 'SIGNED_OUT'", where: byId(() => f.staffSession.id) },
  { constraint: "staff_sessions_end_reason_check", table: "staff_sessions", set: "end_reason = 'SIGNED_OUT'", where: byId(() => f.staffSession.id) },
  { constraint: "staff_sessions_expires_after_login_check", table: "staff_sessions", set: "expires_at = login_at", where: byId(() => f.staffSession.id) },
  { constraint: "staff_sessions_ended_after_login_check", table: "staff_sessions", set: "status = 'ENDED', end_reason = 'SIGNED_OUT', ended_at = login_at - interval '1 hour'", where: byId(() => f.staffSession.id) },
  // The database itself refuses a daily-password session for an administrator or manager (ADR-019 §1, C7).
  { constraint: "staff_sessions_role_is_staff_check", table: "staff_sessions", set: "role = 'TENANT_ADMIN'", where: byId(() => f.staffSession.id) },
  { constraint: "website_sections_cta_pair_check", table: "website_sections", set: "cta_label = NULL", where: byId(() => f.websiteSection.id) },
  // E26 / E27
  { constraint: "tenant_counters_last_value_check", table: "tenant_counters", set: "last_value = -1", where: () => `tenant_id = '${f.tenant.id}'` },
  { constraint: "rate_limit_buckets_hit_count_check", table: "rate_limit_buckets", set: "hit_count = -1", where: () => `bucket_key = '${f.bucketKey}'` },
];

describe("TC-DB-005 CHECK constraints reject invalid rows", () => {
  it.each(CHECK_CASES)("$constraint rejects: $set", async ({ table, set, where, constraint }) => {
    await expectCheckViolation(table, set, where(), constraint);
  });

  it("accepts valid boundary values", async () => {
    await db.menuItem.update({ where: { id: f.item.id }, data: { taxRate: new Prisma.Decimal("100.00"), prepTimeMinutes: 240 } });
    await db.menuItem.update({ where: { id: f.item.id }, data: { taxRate: new Prisma.Decimal("0.00") } });
    await db.restaurantHours.update({ where: { id: f.hours.id }, data: { isClosed: true, opensAt: null, closesAt: null } });
    // Overnight shift: closes before it opens (next day).
    await db.restaurantHours.update({
      where: { id: f.hours.id },
      data: { isClosed: false, opensAt: new Date("1970-01-01T18:00:00Z"), closesAt: new Date("1970-01-01T02:00:00Z") },
    });
    await db.printer.update({ where: { id: f.printer.id }, data: { paperWidthMm: 58 } });
    await db.printJob.update({ where: { id: f.printJob.id }, data: { status: "PRINTED", printedAt: new Date() } });
  });

  it("accepts a CASH payment with change, a referenced refund, and a documented void", async () => {
    const cash = await db.transaction.create({
      data: {
        tenantId: f.tenant.id,
        orderId: f.order.id,
        type: "PAYMENT",
        paymentMethod: "CASH",
        amount: new Prisma.Decimal("50.00"),
        amountTendered: new Prisma.Decimal("100.00"),
        changeDue: new Prisma.Decimal("50.00"),
        businessDate: new Date("2026-09-15T00:00:00Z"),
        idempotencyKey: randomUUID(),
        recordedByUserId: f.user.id,
      },
    });
    await db.transaction.create({
      data: {
        tenantId: f.tenant.id,
        orderId: f.order.id,
        type: "REFUND",
        paymentMethod: "CASH",
        amount: new Prisma.Decimal("5.00"),
        refundOfTransactionId: cash.id,
        reason: "Wrong item",
        businessDate: new Date("2026-09-15T00:00:00Z"),
        idempotencyKey: randomUUID(),
        recordedByUserId: f.user.id,
      },
    });
    await db.transaction.update({
      where: { id: cash.id },
      data: { status: "VOIDED", voidedAt: new Date(), voidedByUserId: f.user.id, voidReason: "Recorded twice" },
    });
  });

  it("rejects a cash tender below the amount", async () => {
    await expectCheckViolation("transactions", "payment_method = 'CASH', amount_tendered = amount - 1", `id = '${f.payment.id}'`, "transactions_amount_tendered_check");
  });

  it("covers every CHECK constraint defined in the database", async () => {
    const rows = await db.$queryRaw<{ conname: string }[]>`
      SELECT c.conname FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = 'public' AND c.contype = 'c' ORDER BY c.conname`;
    const covered = new Set(CHECK_CASES.map((c) => c.constraint));
    expect(rows.map((r) => r.conname).filter((name) => !covered.has(name))).toEqual([]);
    expect(rows.length).toBe(covered.size);
  });
});

async function expectUniqueViolation(action: () => Promise<unknown>, index: string) {
  let error: unknown;
  try {
    await action();
  } catch (e) {
    error = e;
  }
  expect(error, `${index} did not reject the duplicate`).toBeDefined();
  expect(sqlState(error)).toBe("23505");
}

const HAND_WRITTEN_UNIQUE_INDEXES = [
  "menu_categories_tenant_id_lower_name_active_key",
  "menu_item_variants_menu_item_id_lower_name_active_key",
  "menu_item_variants_menu_item_id_default_key",
  "menu_item_addons_menu_item_id_lower_name_active_key",
  "customers_tenant_id_phone_e164_key",
  "printers_tenant_id_lower_name_key",
  "print_agents_tenant_id_lower_name_key",
  "kot_tickets_order_section_round_key",
];

describe("TC-DB-005 partial and expression unique indexes", () => {
  it("category names are unique per tenant, case-insensitively, among non-archived rows", async () => {
    const name = `Desserts ${randomUUID().slice(0, 6)}`;
    const first = await createCategory(db, f.tenant.id, { name });
    await expectUniqueViolation(() => createCategory(db, f.tenant.id, { name: name.toUpperCase() }), "menu_categories_tenant_id_lower_name_active_key");
    const other = await createTenant(db);
    await createCategory(db, other.tenant.id, { name }); // same name in another tenant is allowed
    await db.menuCategory.update({ where: { id: first.id }, data: { archivedAt: new Date() } });
    await createCategory(db, f.tenant.id, { name }); // name is reusable once the old one is archived
  });

  it("variant names are unique per item, and an item has at most one default variant", async () => {
    await expectUniqueViolation(() => createVariant(db, f.tenant.id, f.item.id, { name: f.variant.name.toLowerCase() }), "menu_item_variants_menu_item_id_lower_name_active_key");
    await expectUniqueViolation(() => createVariant(db, f.tenant.id, f.item.id, { isDefault: true }), "menu_item_variants_menu_item_id_default_key");
    await createVariant(db, f.tenant.id, f.item.id, { isDefault: false });
  });

  it("add-on names are unique per item among non-archived rows", async () => {
    await expectUniqueViolation(() => createAddon(db, f.tenant.id, f.item.id, { name: f.addon.name.toUpperCase() }), "menu_item_addons_menu_item_id_lower_name_active_key");
    await db.menuItemAddon.update({ where: { id: f.addon.id }, data: { archivedAt: new Date() } });
    await createAddon(db, f.tenant.id, f.item.id, { name: f.addon.name });
  });

  it("a phone number identifies at most one customer per tenant; customers without phones are unrestricted", async () => {
    await createCustomer(db, f.tenant.id, { phoneE164: "+919876500001" });
    await expectUniqueViolation(() => createCustomer(db, f.tenant.id, { phoneE164: "+919876500001" }), "customers_tenant_id_phone_e164_key");
    await createCustomer(db, f.tenant.id, { phoneE164: null });
    await createCustomer(db, f.tenant.id, { phoneE164: null });
  });

  it("printer and agent names are unique per tenant, case-insensitively", async () => {
    await expectUniqueViolation(
      () => db.printer.create({ data: { tenantId: f.tenant.id, name: f.printer.name.toUpperCase(), purpose: "KOT", connectionType: "USB", connectionAddress: "USB001" } }),
      "printers_tenant_id_lower_name_key",
    );
    await expectUniqueViolation(
      () => db.printAgent.create({ data: { tenantId: f.tenant.id, name: f.agent.name.toLowerCase(), createdByUserId: f.user.id } }),
      "print_agents_tenant_id_lower_name_key",
    );
  });

  it("one KOT per order, section and round — including unsectioned KOTs (NULLS NOT DISTINCT)", async () => {
    await expectUniqueViolation(() => createKotTicket(db, f.tenant.id, f.order.id, { kitchenSectionId: null, roundNumber: 1 }), "kot_tickets_order_section_round_key");
    await createKotTicket(db, f.tenant.id, f.order.id, { kitchenSectionId: f.section.id, roundNumber: 1 });
    await expectUniqueViolation(() => createKotTicket(db, f.tenant.id, f.order.id, { kitchenSectionId: f.section.id, roundNumber: 1 }), "kot_tickets_order_section_round_key");
    await createKotTicket(db, f.tenant.id, f.order.id, { kitchenSectionId: null, roundNumber: 2 });
  });

  it("every hand-written unique index exists (and the KOT index treats NULLs as equal)", async () => {
    const rows = await db.$queryRaw<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexdef LIKE 'CREATE UNIQUE INDEX%'`;
    const names = rows.map((r) => r.indexname);
    expect(HAND_WRITTEN_UNIQUE_INDEXES.filter((n) => !names.includes(n))).toEqual([]);
    expect(rows.find((r) => r.indexname === "kot_tickets_order_section_round_key")?.indexdef).toContain("NULLS NOT DISTINCT");
  });
});
