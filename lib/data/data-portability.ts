import "server-only";
import { type BackupReminder, OrderStatus, PrinterDiscoveryStatus, PrintJobStatus, Prisma, StaffSessionStatus } from "@prisma/client";
import type { TenantContext } from "@/lib/auth/context-types";
import { tenantKey, tenantScope } from "./scope";
import type { Tx } from "./tx";

/**
 * Data access for backups, restore and date-range deletion (RASOIOS-ADR-021).
 *
 * Every read, write and delete here is scoped to `ctx.tenantId`; nothing takes a tenant from a file or a request.
 * Restored rows get `tenantId` from the context, and every link a restored row makes to another tenant-owned row goes
 * through a composite `(tenant_id, id)` foreign key, so a crafted backup can neither place rows in another restaurant
 * nor point at another restaurant's rows.
 */

export type Row = Record<string, unknown>;

/** Business-date bounds, inclusive, as `@db.Date` values (UTC midnight), plus the matching UTC instants. */
export type DataRange = { fromDate?: Date; toDate?: Date; startAt?: Date; endAt?: Date };

const businessDateWhere = (r: DataRange | null) =>
  r && (r.fromDate || r.toDate) ? { businessDate: { ...(r.fromDate ? { gte: r.fromDate } : {}), ...(r.toDate ? { lte: r.toDate } : {}) } } : {};
const createdAtWhere = (r: DataRange | null) =>
  r && (r.startAt || r.endAt) ? { createdAt: { ...(r.startAt ? { gte: r.startAt } : {}), ...(r.endAt ? { lt: r.endAt } : {}) } } : {};

/**
 * One exported table: the Prisma model (which drives columns and import validation), its file/sheet name and how to
 * read it. `omit` lists columns that never leave the database — secrets and print payloads.
 */
export type TableSpec = {
  model: Prisma.ModelName;
  file: string;
  title: string;
  omit?: readonly string[];
  read: (tx: Tx, ctx: TenantContext, range: DataRange | null) => Promise<Row[]>;
};

export const TABLES = {
  restaurant: {
    model: "Restaurant",
    file: "restaurant",
    title: "Restaurant",
    read: (tx, ctx) => tx.restaurant.findMany({ where: tenantScope(ctx) }),
  },
  restaurantHours: {
    model: "RestaurantHours",
    file: "opening_hours",
    title: "Opening hours",
    read: (tx, ctx) => tx.restaurantHours.findMany({ where: tenantScope(ctx), orderBy: [{ dayOfWeek: "asc" }, { sequence: "asc" }] }),
  },
  websiteSection: {
    model: "WebsiteSection",
    file: "website_sections",
    title: "Website sections",
    read: (tx, ctx) => tx.websiteSection.findMany({ where: tenantScope(ctx), orderBy: { sortOrder: "asc" } }),
  },
  kitchenSection: {
    model: "KitchenSection",
    file: "kitchen_sections",
    title: "Kitchen sections",
    read: (tx, ctx) => tx.kitchenSection.findMany({ where: tenantScope(ctx), orderBy: { createdAt: "asc" } }),
  },
  menuCategory: {
    model: "MenuCategory",
    file: "menu_categories",
    title: "Menu categories",
    read: (tx, ctx) => tx.menuCategory.findMany({ where: tenantScope(ctx), orderBy: { sortOrder: "asc" } }),
  },
  menuItem: {
    model: "MenuItem",
    file: "menu_items",
    title: "Menu items",
    read: (tx, ctx) => tx.menuItem.findMany({ where: tenantScope(ctx), orderBy: [{ categoryId: "asc" }, { createdAt: "asc" }] }),
  },
  menuItemVariant: {
    model: "MenuItemVariant",
    file: "menu_item_variants",
    title: "Menu item variants",
    read: (tx, ctx) => tx.menuItemVariant.findMany({ where: tenantScope(ctx), orderBy: { createdAt: "asc" } }),
  },
  menuItemAddon: {
    model: "MenuItemAddon",
    file: "menu_item_addons",
    title: "Menu item add-ons",
    read: (tx, ctx) => tx.menuItemAddon.findMany({ where: tenantScope(ctx), orderBy: { createdAt: "asc" } }),
  },
  dailyMenu: {
    model: "DailyMenu",
    file: "daily_menus",
    title: "Daily menus",
    read: (tx, ctx, r) => tx.dailyMenu.findMany({ where: tenantScope(ctx, businessDateWhere(r)), orderBy: { businessDate: "asc" } }),
  },
  dailyMenuItem: {
    model: "DailyMenuItem",
    file: "daily_menu_items",
    title: "Daily menu items",
    read: (tx, ctx, r) => tx.dailyMenuItem.findMany({ where: tenantScope(ctx, r ? { dailyMenu: businessDateWhere(r) } : {}), orderBy: { createdAt: "asc" } }),
  },
  customer: {
    model: "Customer",
    file: "customers",
    title: "Customers",
    read: (tx, ctx) => tx.customer.findMany({ where: tenantScope(ctx), orderBy: { createdAt: "asc" } }),
  },
  diningTable: {
    model: "DiningTable",
    file: "tables",
    title: "Tables",
    read: (tx, ctx) => tx.diningTable.findMany({ where: tenantScope(ctx), orderBy: { sortOrder: "asc" } }),
  },
  order: {
    model: "Order",
    file: "orders",
    title: "Orders",
    read: (tx, ctx, r) => tx.order.findMany({ where: tenantScope(ctx, businessDateWhere(r)), orderBy: { createdAt: "asc" } }),
  },
  orderItem: {
    model: "OrderItem",
    file: "order_items",
    title: "Order items",
    read: (tx, ctx, r) => tx.orderItem.findMany({ where: tenantScope(ctx, r ? { order: businessDateWhere(r) } : {}), orderBy: { createdAt: "asc" } }),
  },
  orderItemAddon: {
    model: "OrderItemAddon",
    file: "order_item_addons",
    title: "Order item add-ons",
    read: (tx, ctx, r) => tx.orderItemAddon.findMany({ where: tenantScope(ctx, r ? { orderItem: { order: businessDateWhere(r) } } : {}), orderBy: { createdAt: "asc" } }),
  },
  kotTicket: {
    model: "KotTicket",
    file: "kot_tickets",
    title: "Kitchen tickets",
    read: (tx, ctx, r) => tx.kotTicket.findMany({ where: tenantScope(ctx, businessDateWhere(r)), orderBy: { createdAt: "asc" } }),
  },
  kotItem: {
    model: "KotItem",
    file: "kot_items",
    title: "Kitchen ticket items",
    read: (tx, ctx, r) => tx.kotItem.findMany({ where: tenantScope(ctx, r ? { kotTicket: businessDateWhere(r) } : {}), orderBy: { createdAt: "asc" } }),
  },
  transaction: {
    model: "Transaction",
    file: "transactions",
    title: "Payments and refunds",
    read: (tx, ctx, r) => tx.transaction.findMany({ where: tenantScope(ctx, businessDateWhere(r)), orderBy: { createdAt: "asc" } }),
  },
  businessDayClose: {
    model: "BusinessDayClose",
    file: "day_closes",
    title: "Day closes",
    read: (tx, ctx, r) => tx.businessDayClose.findMany({ where: tenantScope(ctx, businessDateWhere(r)), orderBy: { businessDate: "asc" } }),
  },
  staffSession: {
    model: "StaffSession",
    file: "staff_attendance",
    title: "Staff attendance",
    // The session token's hash is a live credential for an active session; it never leaves the database.
    omit: ["tokenHash"],
    read: (tx, ctx, r) => tx.staffSession.findMany({ where: tenantScope(ctx, businessDateWhere(r)), orderBy: { loginAt: "asc" } }),
  },
  socialPost: {
    model: "SocialPost",
    file: "social_posts",
    title: "Social posts",
    read: (tx, ctx, r) => tx.socialPost.findMany({ where: tenantScope(ctx, createdAtWhere(r)), orderBy: { createdAt: "asc" } }),
  },
  printer: {
    model: "Printer",
    file: "printers",
    title: "Printers",
    read: (tx, ctx) => tx.printer.findMany({ where: tenantScope(ctx), orderBy: { createdAt: "asc" } }),
  },
  printJob: {
    model: "PrintJob",
    file: "print_jobs",
    title: "Print jobs",
    // The rendered ticket is large and reproducible from the order; the claim token is the agent's lease.
    omit: ["payload", "claimToken"],
    read: (tx, ctx, r) =>
      tx.printJob.findMany({ where: tenantScope(ctx, createdAtWhere(r)), orderBy: { createdAt: "asc" }, omit: { payload: true } }) as Promise<Row[]>,
  },
  auditLog: {
    model: "AuditLog",
    file: "audit_log",
    title: "Audit log",
    read: (tx, ctx, r) => tx.auditLog.findMany({ where: tenantScope(ctx, createdAtWhere(r)), orderBy: { createdAt: "asc" } }),
  },
} satisfies Record<string, TableSpec>;

export type TableKey = keyof typeof TABLES;

/** Staff are exported as people and roles — never credentials, password hashes or Clerk identifiers. */
export async function readStaff(tx: Tx, ctx: TenantContext): Promise<Row[]> {
  const memberships = await tx.userTenant.findMany({
    where: tenantScope(ctx),
    orderBy: { createdAt: "asc" },
    select: { id: true, role: true, status: true, invitedAt: true, acceptedAt: true, deactivatedAt: true, createdAt: true, user: { select: { fullName: true, email: true } } },
  });
  return memberships.map(({ user, ...m }) => ({ membershipId: m.id, name: user.fullName, email: user.email, role: m.role, status: m.status, invitedAt: m.invitedAt, acceptedAt: m.acceptedAt, deactivatedAt: m.deactivatedAt, createdAt: m.createdAt }));
}

/** The last time this restaurant downloaded a full backup, from the permanent `data.exported` audit record. */
export async function lastFullBackupAt(tx: Tx, ctx: TenantContext): Promise<Date | null> {
  const row = await tx.auditLog.findFirst({
    where: tenantScope(ctx, { action: "data.exported", afterState: { path: ["full"], equals: true } }),
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  return row?.createdAt ?? null;
}

/** The export a deletion relies on: this tenant's own `data.exported` record carrying `backupId`. */
export async function findExportRecord(tx: Tx, ctx: TenantContext, backupId: string): Promise<{ createdAt: Date; afterState: Prisma.JsonValue } | null> {
  return tx.auditLog.findFirst({
    where: tenantScope(ctx, { action: "data.exported", afterState: { path: ["backupId"], equals: backupId } }),
    select: { createdAt: true, afterState: true },
  });
}

/** The restaurant's public name and slug, for file names and the backup's identity block. */
export async function restaurantIdentity(tx: Tx, ctx: TenantContext): Promise<{ slug: string; name: string; backupReminder: BackupReminder }> {
  const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: ctx.tenantId }, select: { slug: true, name: true } });
  const restaurant = await tx.restaurant.findUniqueOrThrow({ where: tenantKey(ctx, ctx.restaurant.id), select: { backupReminder: true } });
  return { ...tenant, backupReminder: restaurant.backupReminder };
}

export async function updateBackupReminder(tx: Tx, ctx: TenantContext, value: BackupReminder): Promise<BackupReminder> {
  const before = await tx.restaurant.findUniqueOrThrow({ where: tenantKey(ctx, ctx.restaurant.id), select: { backupReminder: true } });
  await tx.restaurant.update({ where: tenantKey(ctx, ctx.restaurant.id), data: { backupReminder: value } });
  return before.backupReminder;
}

/** The latest export, restore and deletion records, newest first (the permanent `data.*` audit trail). */
export async function recentDataEvents(tx: Tx, ctx: TenantContext, take = 10) {
  return tx.auditLog.findMany({
    where: tenantScope(ctx, { action: { startsWith: "data." } }),
    orderBy: { createdAt: "desc" },
    take,
    select: { id: true, action: true, createdAt: true, afterState: true, actor: { select: { fullName: true, email: true } } },
  });
}

/** Row counts the data screen shows next to each kind of record. */
export async function dataCounts(tx: Tx, ctx: TenantContext): Promise<Record<string, number>> {
  const [orders, payments, customers, menuItems, auditEntries, printJobs, attendance, socialPosts] = await Promise.all([
    tx.order.count({ where: tenantScope(ctx) }),
    tx.transaction.count({ where: tenantScope(ctx) }),
    tx.customer.count({ where: tenantScope(ctx) }),
    tx.menuItem.count({ where: tenantScope(ctx) }),
    tx.auditLog.count({ where: tenantScope(ctx) }),
    tx.printJob.count({ where: tenantScope(ctx) }),
    tx.staffSession.count({ where: tenantScope(ctx) }),
    tx.socialPost.count({ where: tenantScope(ctx) }),
  ]);
  return { orders, payments, customers, menuItems, auditEntries, printJobs, attendance, socialPosts };
}

export async function memberUserIds(tx: Tx, ctx: TenantContext): Promise<Set<string>> {
  const rows = await tx.userTenant.findMany({ where: tenantScope(ctx), select: { userId: true } });
  return new Set(rows.map((r) => r.userId));
}

// ───────────────────────── restore ─────────────────────────

/** Tables a backup can put back, parents before children. Audit, print jobs, staff and settings are never restored. */
export const RESTORE_ORDER = [
  "kitchenSection",
  "menuCategory",
  "menuItem",
  "menuItemVariant",
  "menuItemAddon",
  "dailyMenu",
  "dailyMenuItem",
  "customer",
  "diningTable",
  "order",
  "orderItem",
  "orderItemAddon",
  "kotTicket",
  "kotItem",
  "transaction",
  "businessDayClose",
] as const satisfies readonly TableKey[];

export type RestoreKey = (typeof RESTORE_ORDER)[number];

/** Which of `ids` already exist in this restaurant. */
export async function existingIds(tx: Tx, ctx: TenantContext, table: RestoreKey, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const select = { id: true } as const;
  let rows: { id: string }[];
  switch (table) {
    case "kitchenSection": rows = await tx.kitchenSection.findMany({ where: tenantScope(ctx, { id: { in: ids } }), select }); break;
    case "menuCategory": rows = await tx.menuCategory.findMany({ where: tenantScope(ctx, { id: { in: ids } }), select }); break;
    case "menuItem": rows = await tx.menuItem.findMany({ where: tenantScope(ctx, { id: { in: ids } }), select }); break;
    case "menuItemVariant": rows = await tx.menuItemVariant.findMany({ where: tenantScope(ctx, { id: { in: ids } }), select }); break;
    case "menuItemAddon": rows = await tx.menuItemAddon.findMany({ where: tenantScope(ctx, { id: { in: ids } }), select }); break;
    case "dailyMenu": rows = await tx.dailyMenu.findMany({ where: tenantScope(ctx, { id: { in: ids } }), select }); break;
    case "dailyMenuItem": rows = await tx.dailyMenuItem.findMany({ where: tenantScope(ctx, { id: { in: ids } }), select }); break;
    case "customer": rows = await tx.customer.findMany({ where: tenantScope(ctx, { id: { in: ids } }), select }); break;
    case "diningTable": rows = await tx.diningTable.findMany({ where: tenantScope(ctx, { id: { in: ids } }), select }); break;
    case "order": rows = await tx.order.findMany({ where: tenantScope(ctx, { id: { in: ids } }), select }); break;
    case "orderItem": rows = await tx.orderItem.findMany({ where: tenantScope(ctx, { id: { in: ids } }), select }); break;
    case "orderItemAddon": rows = await tx.orderItemAddon.findMany({ where: tenantScope(ctx, { id: { in: ids } }), select }); break;
    case "kotTicket": rows = await tx.kotTicket.findMany({ where: tenantScope(ctx, { id: { in: ids } }), select }); break;
    case "kotItem": rows = await tx.kotItem.findMany({ where: tenantScope(ctx, { id: { in: ids } }), select }); break;
    case "transaction": rows = await tx.transaction.findMany({ where: tenantScope(ctx, { id: { in: ids } }), select }); break;
    case "businessDayClose": rows = await tx.businessDayClose.findMany({ where: tenantScope(ctx, { id: { in: ids } }), select }); break;
  }
  return new Set(rows.map((r) => r.id));
}

/**
 * Inserts validated rows. `tenantId` is set here from the context, whatever the row carried. Rows whose id is already
 * taken (in this restaurant, or anywhere) are skipped by ON CONFLICT DO NOTHING; the count says how many went in.
 */
export async function insertRows(tx: Tx, ctx: TenantContext, table: RestoreKey, rows: Row[]): Promise<number> {
  if (rows.length === 0) return 0;
  const data = rows.map((row) => ({ ...row, tenantId: ctx.tenantId }));
  const opts = { skipDuplicates: true } as const;
  switch (table) {
    case "kitchenSection": return (await tx.kitchenSection.createMany({ data: data as Prisma.KitchenSectionCreateManyInput[], ...opts })).count;
    case "menuCategory": return (await tx.menuCategory.createMany({ data: data as Prisma.MenuCategoryCreateManyInput[], ...opts })).count;
    case "menuItem": return (await tx.menuItem.createMany({ data: data as Prisma.MenuItemCreateManyInput[], ...opts })).count;
    case "menuItemVariant": return (await tx.menuItemVariant.createMany({ data: data as Prisma.MenuItemVariantCreateManyInput[], ...opts })).count;
    case "menuItemAddon": return (await tx.menuItemAddon.createMany({ data: data as Prisma.MenuItemAddonCreateManyInput[], ...opts })).count;
    case "dailyMenu": return (await tx.dailyMenu.createMany({ data: data as Prisma.DailyMenuCreateManyInput[], ...opts })).count;
    case "dailyMenuItem": return (await tx.dailyMenuItem.createMany({ data: data as Prisma.DailyMenuItemCreateManyInput[], ...opts })).count;
    case "customer": return (await tx.customer.createMany({ data: data as Prisma.CustomerCreateManyInput[], ...opts })).count;
    case "diningTable": return (await tx.diningTable.createMany({ data: data as Prisma.DiningTableCreateManyInput[], ...opts })).count;
    case "order": return (await tx.order.createMany({ data: data as Prisma.OrderCreateManyInput[], ...opts })).count;
    case "orderItem": return (await tx.orderItem.createMany({ data: data as Prisma.OrderItemCreateManyInput[], ...opts })).count;
    case "orderItemAddon": return (await tx.orderItemAddon.createMany({ data: data as Prisma.OrderItemAddonCreateManyInput[], ...opts })).count;
    case "kotTicket": return (await tx.kotTicket.createMany({ data: data as Prisma.KotTicketCreateManyInput[], ...opts })).count;
    case "kotItem": return (await tx.kotItem.createMany({ data: data as Prisma.KotItemCreateManyInput[], ...opts })).count;
    case "transaction": return (await tx.transaction.createMany({ data: data as Prisma.TransactionCreateManyInput[], ...opts })).count;
    case "businessDayClose": return (await tx.businessDayClose.createMany({ data: data as Prisma.BusinessDayCloseCreateManyInput[], ...opts })).count;
  }
}

// ───────────────────────── date-range deletion ─────────────────────────

/** Only finished orders are ever deleted; anything still open stays, whatever its date. */
const FINISHED_ORDERS = [OrderStatus.COMPLETED, OrderStatus.CANCELLED, OrderStatus.REFUNDED];
const CHUNK = 500;

export async function countOpenOrdersBefore(tx: Tx, ctx: TenantContext, before: Date): Promise<number> {
  return tx.order.count({ where: tenantScope(ctx, { businessDate: { lt: before }, status: { notIn: FINISHED_ORDERS } }) });
}

/** Finished orders with a business date before `before`, with everything that hangs off them, plus old day closes. */
export async function deleteOrdersBefore(tx: Tx, ctx: TenantContext, before: Date): Promise<Record<string, number>> {
  const ids = (await tx.order.findMany({ where: tenantScope(ctx, { businessDate: { lt: before }, status: { in: FINISHED_ORDERS } }), select: { id: true } })).map((o) => o.id);
  const counts = { orders: 0, orderItems: 0, kitchenTickets: 0, payments: 0, printJobs: 0, dayCloses: 0 };
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    await tx.kotItem.deleteMany({ where: tenantScope(ctx, { kotTicket: { orderId: { in: chunk } } }) });
    counts.printJobs += (await tx.printJob.deleteMany({ where: tenantScope(ctx, { OR: [{ orderId: { in: chunk } }, { kotTicket: { orderId: { in: chunk } } }] }) })).count;
    counts.kitchenTickets += (await tx.kotTicket.deleteMany({ where: tenantScope(ctx, { orderId: { in: chunk } }) })).count;
    await tx.orderItemAddon.deleteMany({ where: tenantScope(ctx, { orderItem: { orderId: { in: chunk } } }) });
    counts.orderItems += (await tx.orderItem.deleteMany({ where: tenantScope(ctx, { orderId: { in: chunk } }) })).count;
    // Refunds point at the payment they refund, so they go first.
    counts.payments += (await tx.transaction.deleteMany({ where: tenantScope(ctx, { orderId: { in: chunk }, refundOfTransactionId: { not: null } }) })).count;
    counts.payments += (await tx.transaction.deleteMany({ where: tenantScope(ctx, { orderId: { in: chunk } }) })).count;
    counts.orders += (await tx.order.deleteMany({ where: tenantScope(ctx, { id: { in: chunk } }) })).count;
  }
  counts.dayCloses = (await tx.businessDayClose.deleteMany({ where: tenantScope(ctx, { businessDate: { lt: before } }) })).count;
  return counts;
}

/** Customers added before the cutoff who have no orders left. A customer with any order is kept. */
export async function deleteCustomersBefore(tx: Tx, ctx: TenantContext, beforeAt: Date): Promise<Record<string, number>> {
  const { count } = await tx.customer.deleteMany({ where: tenantScope(ctx, { createdAt: { lt: beforeAt }, orders: { none: {} } }) });
  return { customers: count };
}

/** Finished print jobs and printer scans. A job still waiting for the printer is never removed. */
export async function deletePrintHistoryBefore(tx: Tx, ctx: TenantContext, beforeAt: Date): Promise<Record<string, number>> {
  const jobs = await tx.printJob.deleteMany({ where: tenantScope(ctx, { createdAt: { lt: beforeAt }, status: { in: [PrintJobStatus.PRINTED, PrintJobStatus.FAILED] } }) });
  const scans = await tx.printerDiscovery.deleteMany({
    where: tenantScope(ctx, { createdAt: { lt: beforeAt }, status: { in: [PrinterDiscoveryStatus.COMPLETED, PrinterDiscoveryStatus.FAILED] } }),
  });
  return { printJobs: jobs.count, printerScans: scans.count };
}

/** Ended staff sessions (attendance) and the expired daily passwords they used. Live sessions are untouched. */
export async function deleteAttendanceBefore(tx: Tx, ctx: TenantContext, before: Date): Promise<Record<string, number>> {
  const sessions = await tx.staffSession.deleteMany({ where: tenantScope(ctx, { businessDate: { lt: before }, status: StaffSessionStatus.ENDED }) });
  const credentials = await tx.staffCredential.deleteMany({ where: tenantScope(ctx, { businessDate: { lt: before }, sessions: { none: {} } }) });
  return { attendance: sessions.count, expiredPasswords: credentials.count };
}

export async function deleteSocialPostsBefore(tx: Tx, ctx: TenantContext, beforeAt: Date): Promise<Record<string, number>> {
  const { count } = await tx.socialPost.deleteMany({ where: tenantScope(ctx, { createdAt: { lt: beforeAt } }) });
  return { socialPosts: count };
}

/**
 * Audit entries older than the cutoff. The table's trigger refuses every DELETE unless this transaction has scoped
 * itself to this tenant and cutoff (migration 0006), and it never deletes a `data.*` entry — the record of backups,
 * restores and deletions, including the one this deletion writes, is permanent.
 */
export async function deleteAuditBefore(tx: Tx, ctx: TenantContext, beforeAt: Date): Promise<Record<string, number>> {
  await tx.$queryRaw`SELECT set_config('rasoi.audit_purge_tenant', ${ctx.tenantId}, true), set_config('rasoi.audit_purge_before', ${beforeAt.toISOString()}, true)`;
  const { count } = await tx.auditLog.deleteMany({ where: tenantScope(ctx, { createdAt: { lt: beforeAt }, NOT: { action: { startsWith: "data." } } }) });
  await tx.$queryRaw`SELECT set_config('rasoi.audit_purge_tenant', '', true), set_config('rasoi.audit_purge_before', '', true)`;
  return { auditEntries: count };
}
