import "server-only";
import { randomUUID } from "node:crypto";
import type { BackupReminder, Prisma } from "@prisma/client";
import { audit } from "@/lib/audit/write";
import type { TenantContext } from "@/lib/auth/context-types";
import { columnsOf, coerceRow, flattenValue, tenantReferences, userReferences } from "@/lib/data/backup-validate";
import {
  countPurge,
  dataCounts,
  deleteAttendanceInRange,
  deleteAuditInRange,
  deleteCustomersInRange,
  deleteOrdersInRange,
  deletePrintHistoryInRange,
  deleteSocialPostsInRange,
  existingIds,
  findExportRecord,
  insertRows,
  lastFullBackupAt,
  memberUserIds,
  readDailySummary,
  readStaff,
  recentDataEvents,
  restaurantIdentity,
  RESTORE_ORDER,
  TABLES,
  updateBackupReminder,
  type DataRange,
  type PurgeCount,
  type PurgeRange,
  type RestoreKey,
  type Row,
  type TableKey,
} from "@/lib/data/data-portability";
import { withTx } from "@/lib/data/tx";
import { parseCsv, toCsv, toXlsx, type Cell, type Sheet } from "@/lib/data-portability/tabular";
import { unzip, zip, ZipError, type ZipEntry } from "@/lib/data-portability/zip";
import { RateLimitedError, ValidationError } from "@/lib/errors";
import { consumeScope } from "@/lib/security/rate-limit";
import { logger } from "@/lib/logger";
import { businessDateFor, now, parseIsoDate, toIsoDate, utcRangeForBusinessDates } from "@/lib/time";

/**
 * Backups, restore and date-range deletion (RASOIOS-ADR-021; owner brief 2026-10-06 §3–8).
 *
 * - Export: the restaurant downloads its own data to its own computer. Nothing is uploaded or kept by us; each export
 *   leaves a permanent `data.exported` audit record, which is also what "Last backup" reads.
 * - Restore: adds back records that are missing. Existing records are never overwritten; every row is validated
 *   against the schema and its links before anything is written, and the whole restore is one transaction.
 * - Delete: history before a date, only after a backup covering it was downloaded in the last 24 hours, with the typed
 *   confirmation, and only by the owner/admin. The deletion's own record is permanent.
 */

export const BACKUP_FORMAT = "rasoios-backup";
export const BACKUP_VERSION = 1;
export const DELETE_CONFIRMATION = "DELETE MY RESTAURANT DATA";
/** How long a downloaded backup counts as "just taken" for a deletion. */
const BACKUP_FRESH_MS = 24 * 60 * 60 * 1000;
const MAX_IMPORT_ROWS = 200_000;

// ───────────────────────── datasets ─────────────────────────

export const DATASETS = {
  restaurant: { label: "Restaurant, website and Brand Kit", tables: ["restaurant", "restaurantHours", "websiteSection", "kitchenSection", "diningTable"], dated: false },
  menu: { label: "Menu", tables: ["menuCategory", "menuItem", "menuItemVariant", "menuItemAddon"], dated: false },
  dailyMenus: { label: "Daily menus", tables: ["dailyMenu", "dailyMenuItem"], dated: true },
  customers: { label: "Customers", tables: ["customer"], dated: false },
  orders: { label: "Orders and kitchen tickets", tables: ["order", "orderItem", "orderItemAddon", "kotTicket", "kotItem"], dated: true },
  transactions: { label: "Payments, refunds and day closes", tables: ["transaction", "businessDayClose"], dated: true },
  staff: { label: "Staff and attendance", tables: ["staffSession"], dated: true },
  social: { label: "Social posts", tables: ["socialPost"], dated: true },
  printing: { label: "Printers and print history", tables: ["printer", "printJob"], dated: true },
  audit: { label: "Audit log", tables: ["auditLog"], dated: true },
  // Computed, not a table: one row per day of sales, tax, payments by method and refunds (owner review 2026-10-06 §7).
  reports: { label: "Reports: daily sales summary", tables: [], dated: true },
} as const satisfies Record<string, { label: string; tables: readonly TableKey[]; dated: boolean }>;

export type DatasetKey = keyof typeof DATASETS;
export const DATASET_KEYS = Object.keys(DATASETS) as DatasetKey[];
export type ExportFormat = "zip" | "xlsx" | "csv" | "json";

export type ExportRequest = { datasets: DatasetKey[]; format: ExportFormat; from?: string; to?: string; backupId?: string };
export type ExportFile = { filename: string; contentType: string; body: Buffer; backupId: string };

function rangeFor(ctx: TenantContext, from?: string, to?: string): DataRange | null {
  if (!from && !to) return null;
  if (from && to && to < from) throw new ValidationError("The end date is before the start date.", { to: ["Choose an end date on or after the start date."] });
  return {
    fromDate: from ? parseIsoDate(from) : undefined,
    toDate: to ? parseIsoDate(to) : undefined,
    startAt: from ? utcRangeForBusinessDates(from, from, ctx.restaurant.timezone).start : undefined,
    endAt: to ? utcRangeForBusinessDates(to, to, ctx.restaurant.timezone).end : undefined,
  };
}

/** A table's rows as a spreadsheet: schema columns minus omitted ones, values flattened (money as decimal text). */
function sheetFor(table: TableKey, rows: Row[]): Sheet {
  const spec = TABLES[table];
  const fields = columnsOf(spec.model, "omit" in spec ? spec.omit : []);
  return { name: spec.title, columns: fields.map((f) => f.name), rows: rows.map((row) => fields.map((f) => flattenValue(f, row[f.name]))) };
}

function reportSheet(rows: Row[]): Sheet {
  const columns = ["businessDate", "orders", "subtotal", "tax", "discounts", "sales", "cash", "card", "upi", "refunds"];
  return { name: "Daily sales summary", columns, rows: rows.map((row) => columns.map((c) => (row[c] ?? null) as Cell)) };
}

function staffSheet(rows: Row[]): Sheet {
  const columns = ["membershipId", "name", "email", "role", "status", "invitedAt", "acceptedAt", "deactivatedAt", "createdAt"];
  const cell = (v: unknown): Cell => (v instanceof Date ? v.toISOString() : v === undefined ? null : (v as Cell));
  return { name: "Staff", columns, rows: rows.map((row) => columns.map((c) => cell(row[c]))) };
}

/** Builds the requested download and records it. Reads run in one repeatable-read snapshot, so totals agree. */
export async function buildExport(ctx: TenantContext, request: ExportRequest): Promise<ExportFile> {
  const datasets = DATASET_KEYS.filter((key) => request.datasets.includes(key));
  if (datasets.length === 0) throw new ValidationError("Choose at least one kind of data to export.", { datasets: ["Choose at least one."] });
  const range = rangeFor(ctx, request.from, request.to);
  const backupId = request.backupId ?? randomUUID();
  const exportedAt = now();
  const full = datasets.length === DATASET_KEYS.length && range === null;

  const { identity, tables, staff, reports } = await withTx(
    ctx,
    async (tx) => {
      const identity = await restaurantIdentity(tx, ctx);
      const tables: Partial<Record<TableKey, Row[]>> = {};
      for (const key of datasets) {
        for (const table of DATASETS[key].tables) {
          const spec = TABLES[table];
          tables[table] = await spec.read(tx, ctx, DATASETS[key].dated ? range : null);
          if ("omit" in spec) tables[table] = tables[table]!.map((row) => Object.fromEntries(Object.entries(row).filter(([k]) => !spec.omit.includes(k))));
        }
      }
      const staff = datasets.includes("staff") ? await readStaff(tx, ctx) : null;
      const reports = datasets.includes("reports") ? await readDailySummary(tx, ctx, range) : null;
      const counts = Object.fromEntries(Object.entries(tables).map(([k, rows]) => [k, rows!.length]));
      await audit(tx, ctx, {
        action: "data.exported",
        resourceType: "tenant_data",
        after: { backupId, format: request.format, datasets, from: request.from ?? null, to: request.to ?? null, full, counts },
      });
      return { identity, tables, staff, reports };
    },
    { isolationLevel: "RepeatableRead", timeoutMs: 120_000 },
  );

  const stamp = toIsoDate(businessDateFor(exportedAt, ctx.restaurant.timezone));
  const base = `${identity.slug}-${full ? "full-backup" : "export"}-${stamp}`;
  const sheets = [...(reports ? [reportSheet(reports)] : []), ...(staff ? [staffSheet(staff)] : []), ...(Object.keys(tables) as TableKey[]).map((t) => sheetFor(t, tables[t]!))];
  const metadata = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    backupId,
    exportedAt: exportedAt.toISOString(),
    restaurant: { tenantId: ctx.tenantId, slug: identity.slug, name: identity.name },
    range: { from: request.from ?? null, to: request.to ?? null },
    datasets,
    counts: Object.fromEntries(Object.entries(tables).map(([k, rows]) => [k, rows!.length])),
    // Honest about images: the backup carries their addresses, not the image files themselves.
    images: "Image addresses are included; the image files stay on the image service and can be downloaded separately.",
  };
  const json = () => Buffer.from(JSON.stringify({ ...metadata, reports: reports ?? undefined, staff: staff ?? undefined, tables }, null, 1), "utf8");

  logger.info("data.exported", { requestId: ctx.requestId, tenantId: ctx.tenantId, format: request.format, datasets: datasets.length, full });

  switch (request.format) {
    case "json":
      return { filename: `${base}.json`, contentType: "application/json", body: json(), backupId };
    case "xlsx":
      return { filename: `${base}.xlsx`, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", body: toXlsx(sheets, exportedAt), backupId };
    case "csv": {
      const files: ZipEntry[] = [
        ...(reports ? [{ name: "daily_sales_summary.csv", data: toCsv(reportSheet(reports)) }] : []),
        ...(staff ? [{ name: "staff.csv", data: toCsv(staffSheet(staff)) }] : []),
        ...(Object.keys(tables) as TableKey[]).map((t) => ({ name: `${TABLES[t].file}.csv`, data: toCsv(sheetFor(t, tables[t]!)) })),
      ];
      if (files.length === 1) return { filename: `${base}-${files[0].name}`, contentType: "text/csv; charset=utf-8", body: files[0].data, backupId };
      return { filename: `${base}-csv.zip`, contentType: "application/zip", body: zip([...files, { name: "metadata.json", data: Buffer.from(JSON.stringify(metadata, null, 1)) }], exportedAt), backupId };
    }
    case "zip": {
      const readme =
        `${identity.name} - FlowDineOS backup\r\nExported ${metadata.exportedAt}\r\n\r\n` +
        `backup.json      everything in this backup; import it in Settings > Data to restore missing records\r\n` +
        `${base}.xlsx  the same data as an Excel workbook, one sheet per kind of record\r\n` +
        `csv/             the same data as CSV files\r\n\r\n` +
        `Passwords, sign-in tokens and printer credentials are never included. ${metadata.images}\r\n`;
      return {
        filename: `${base}.zip`,
        contentType: "application/zip",
        body: zip(
          [
            { name: "backup.json", data: json() },
            { name: "metadata.json", data: Buffer.from(JSON.stringify(metadata, null, 1)) },
            { name: `${base}.xlsx`, data: toXlsx(sheets, exportedAt) },
            ...(reports ? [{ name: "csv/daily_sales_summary.csv", data: toCsv(reportSheet(reports)) }] : []),
            ...(staff ? [{ name: "csv/staff.csv", data: toCsv(staffSheet(staff)) }] : []),
            ...(Object.keys(tables) as TableKey[]).map((t) => ({ name: `csv/${TABLES[t].file}.csv`, data: toCsv(sheetFor(t, tables[t]!)) })),
            { name: "README.txt", data: Buffer.from(readme, "utf8") },
          ],
          exportedAt,
        ),
        backupId,
      };
    }
  }
}

// ───────────────────────── import / restore ─────────────────────────

export type ImportTablePreview = { table: RestoreKey; title: string; total: number; toAdd: number; alreadyHere: number; invalid: number };
export type ImportPreview = {
  fileName: string;
  source: { restaurant: string | null; exportedAt: string | null };
  tables: ImportTablePreview[];
  ignored: string[];
  issues: string[];
  canImport: boolean;
};
export type ImportResult = { added: Record<string, number>; skipped: Record<string, number>; total: number };

type ParsedBackup = { tables: Partial<Record<RestoreKey, unknown[]>>; fromCsv: boolean; restaurant: { tenantId?: string; name?: string } | null; exportedAt: string | null; ignored: string[] };

const FILE_TO_TABLE = new Map((Object.keys(TABLES) as TableKey[]).map((t) => [TABLES[t].file, t]));
const isRestorable = (t: string): t is RestoreKey => (RESTORE_ORDER as readonly string[]).includes(t);
const importError = (message: string) => new ValidationError(message, { file: [message] }, "IMPORT_INVALID");

function tableForCsvName(name: string): TableKey | null {
  const stem = name.split("/").pop()!.toLowerCase().replace(/\.csv$/, "").replace(/\s*\(\d+\)$/, "");
  for (const [file, table] of FILE_TO_TABLE) if (stem === file || stem.endsWith(`-${file}`)) return table;
  return null;
}

function parseJsonBackup(text: string): ParsedBackup {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw importError("The file is not valid JSON.");
  }
  const d = doc as { format?: unknown; version?: unknown; tables?: unknown; restaurant?: unknown; exportedAt?: unknown };
  if (!d || typeof d !== "object" || d.format !== BACKUP_FORMAT) throw importError("This is not a FlowDineOS backup file.");
  if (d.version !== BACKUP_VERSION) throw importError(`This backup was made by a different version (${String(d.version)}); it cannot be imported here.`);
  if (!d.tables || typeof d.tables !== "object") throw importError("The backup has no data in it.");
  const tables: ParsedBackup["tables"] = {};
  const ignored: string[] = [];
  for (const [key, rows] of Object.entries(d.tables as Record<string, unknown>)) {
    if (!Array.isArray(rows)) throw importError(`"${key}" in the backup is not a list of records.`);
    if (isRestorable(key)) tables[key] = rows;
    else if (rows.length > 0) ignored.push(key in TABLES ? TABLES[key as TableKey].title : key);
  }
  const restaurant = d.restaurant && typeof d.restaurant === "object" ? (d.restaurant as { tenantId?: string; name?: string }) : null;
  return { tables, fromCsv: false, restaurant, exportedAt: typeof d.exportedAt === "string" ? d.exportedAt : null, ignored };
}

function parseCsvFiles(files: ZipEntry[]): ParsedBackup {
  const tables: ParsedBackup["tables"] = {};
  const ignored: string[] = [];
  for (const file of files) {
    const table = tableForCsvName(file.name);
    if (!table) {
      ignored.push(file.name);
      continue;
    }
    if (!isRestorable(table)) {
      ignored.push(TABLES[table].title);
      continue;
    }
    const { columns, rows } = parseCsv(file.data.toString("utf8"));
    tables[table] = rows.map((cells) => Object.fromEntries(columns.map((c, i) => [c, cells[i] ?? ""])));
  }
  if (Object.keys(tables).length === 0) throw importError("None of the CSV files match a kind of record that can be imported. Use the file names from an export, such as menu_items.csv.");
  return { tables, fromCsv: true, restaurant: null, exportedAt: null, ignored };
}

export function parseBackupFile(name: string, bytes: Buffer): ParsedBackup {
  const lower = name.toLowerCase();
  if (lower.endsWith(".xlsx")) throw importError("Excel files are for reading in a spreadsheet. To restore, import the backup's ZIP, backup.json or CSV files.");
  if (lower.endsWith(".json")) return parseJsonBackup(bytes.toString("utf8"));
  if (lower.endsWith(".csv")) return parseCsvFiles([{ name, data: bytes }]);
  if (lower.endsWith(".zip")) {
    let entries: ZipEntry[];
    try {
      entries = unzip(bytes, { maxEntries: 200, maxTotalBytes: 300 * 1024 * 1024 });
    } catch (error) {
      throw importError(error instanceof ZipError ? error.message : "The ZIP file could not be read.");
    }
    const backup = entries.find((e) => e.name === "backup.json");
    if (backup) return parseJsonBackup(backup.data.toString("utf8"));
    return parseCsvFiles(entries.filter((e) => e.name.toLowerCase().endsWith(".csv")));
  }
  throw importError("Choose a backup file: .zip, .json or .csv.");
}

type Plan = { preview: Omit<ImportPreview, "fileName">; toInsert: Partial<Record<RestoreKey, Row[]>> };

/**
 * Validates a parsed backup against this restaurant: field types, then links. A row may link only to rows that are
 * in this restaurant already or valid rows of the same backup, and may name only people who belong to this
 * restaurant. Rows already here are counted and left alone.
 */
async function plan(ctx: TenantContext, parsed: ParsedBackup): Promise<Plan> {
  const issues: string[] = [];
  if (parsed.restaurant?.tenantId && parsed.restaurant.tenantId !== ctx.tenantId) {
    throw importError(`This backup belongs to another restaurant${parsed.restaurant.name ? ` (${parsed.restaurant.name})` : ""}. A backup can only be restored into the restaurant it came from.`);
  }
  const totalRows = Object.values(parsed.tables).reduce((n, rows) => n + (rows?.length ?? 0), 0);
  if (totalRows > MAX_IMPORT_ROWS) throw importError(`The backup has ${totalRows} records; at most ${MAX_IMPORT_ROWS} can be imported at once. Export a shorter date range.`);

  return withTx(ctx, async (tx) => {
    const members = await memberUserIds(tx, ctx);
    const valid = new Map<RestoreKey, Row[]>();
    const known = new Map<string, Set<string>>(); // model → ids that may be linked to
    const tables: ImportTablePreview[] = [];
    const toInsert: Plan["toInsert"] = {};

    const knownIds = async (target: Prisma.ModelName, ids: string[]): Promise<Set<string>> => {
      const key = RESTORE_ORDER.find((t) => TABLES[t].model === target);
      if (!key) throw new Error(`No restore lookup for ${target}`);
      const set = known.get(target) ?? new Set<string>();
      const missing = ids.filter((id) => !set.has(id));
      for (const id of await existingIds(tx, ctx, key, [...new Set(missing)])) set.add(id);
      known.set(target, set);
      return set;
    };

    for (const table of RESTORE_ORDER) {
      const rows = parsed.tables[table];
      if (!rows || rows.length === 0) continue;
      const { model, title } = TABLES[table];
      const refs = tenantReferences(model);
      const people = userReferences(model);
      const accepted: Row[] = [];
      let invalid = 0;

      const coerced = rows.map((raw) => coerceRow(model, raw, parsed.fromCsv));
      for (const ref of refs) {
        const ids = coerced.flatMap(({ row }) => (typeof row[ref.column] === "string" ? [row[ref.column] as string] : []));
        await knownIds(ref.target, ids);
      }
      // Rows of this same table in the file (a refund names the payment it refunds) — whatever order they come in.
      const ownIds = new Set(coerced.filter((c) => c.issues.length === 0).map((c) => c.row.id as string));
      coerced.forEach(({ row, issues: rowIssues }, index) => {
        const problems = [...rowIssues];
        for (const ref of refs) {
          const id = row[ref.column];
          // A link to a row of the same table inside this file (e.g. a refund of a payment) is fine.
          if (typeof id === "string" && !known.get(ref.target)?.has(id) && !(ref.target === model && ownIds.has(id))) problems.push(`links to a ${ref.column.replace(/Id$/, "")} that is not in this restaurant or this backup`);
        }
        for (const column of people) {
          const id = row[column];
          if (typeof id === "string" && !members.has(id)) problems.push(`names a person (${column}) who is not part of this restaurant`);
        }
        if (problems.length > 0) {
          invalid++;
          if (issues.length < 25) issues.push(`${title}, record ${index + 1}: ${problems.slice(0, 3).join("; ")}`);
          return;
        }
        accepted.push(row);
      });

      const here = await existingIds(tx, ctx, table, accepted.map((r) => r.id as string));
      const fresh = accepted.filter((r) => !here.has(r.id as string));
      // Valid rows of this table can be linked to by the tables after it.
      const set = known.get(model) ?? new Set<string>();
      for (const r of accepted) set.add(r.id as string);
      known.set(model, set);
      valid.set(table, accepted);
      // Refunds name the payment they refund; insert payments first.
      toInsert[table] = table === "transaction" ? [...fresh].sort((a, b) => Number(Boolean(a.refundOfTransactionId)) - Number(Boolean(b.refundOfTransactionId))) : fresh;
      tables.push({ table, title, total: rows.length, toAdd: fresh.length, alreadyHere: accepted.length - fresh.length, invalid });
    }

    const invalidTotal = tables.reduce((n, t) => n + t.invalid, 0);
    if (invalidTotal > issues.length) issues.push(`…and ${invalidTotal - issues.length} more records with problems.`);
    const addTotal = tables.reduce((n, t) => n + t.toAdd, 0);
    return {
      preview: {
        source: { restaurant: parsed.restaurant?.name ?? null, exportedAt: parsed.exportedAt },
        tables,
        ignored: parsed.ignored,
        issues,
        canImport: invalidTotal === 0 && addTotal > 0,
      },
      toInsert,
    };
  });
}

export async function previewImport(ctx: TenantContext, file: { name: string; bytes: Buffer }): Promise<ImportPreview> {
  const { preview } = await plan(ctx, parseBackupFile(file.name, file.bytes));
  return { fileName: file.name, ...preview };
}

/** Re-validates the same file and adds the missing records in one transaction, with its permanent audit record. */
export async function commitImport(ctx: TenantContext, file: { name: string; bytes: Buffer }): Promise<ImportResult> {
  const parsed = parseBackupFile(file.name, file.bytes);
  const { preview, toInsert } = await plan(ctx, parsed);
  if (preview.tables.some((t) => t.invalid > 0)) throw importError("Some records in the file have problems. Nothing was imported. Fix them or use another backup.");
  if (!preview.canImport) throw importError("Everything in this file is already in the restaurant. Nothing to import.");

  const result = await withTx(
    ctx,
    async (tx) => {
      const added: Record<string, number> = {};
      const skipped: Record<string, number> = {};
      for (const table of RESTORE_ORDER) {
        const rows = toInsert[table];
        if (!rows || rows.length === 0) continue;
        added[table] = await insertRows(tx, ctx, table, rows);
        skipped[table] = rows.length - added[table];
      }
      const total = Object.values(added).reduce((n, v) => n + v, 0);
      await audit(tx, ctx, { action: "data.imported", resourceType: "tenant_data", after: { fileName: file.name.slice(0, 120), added, skipped, total } });
      return { added, skipped, total };
    },
    { timeoutMs: 180_000 },
  );
  logger.info("data.imported", { requestId: ctx.requestId, tenantId: ctx.tenantId, total: result.total });
  return result;
}

// ───────────────────────── deletion ─────────────────────────

export const PURGE_CATEGORIES = {
  orders: { label: "Orders, bills and payments", needs: ["orders", "transactions"], detail: "Finished orders in the range with their items, kitchen tickets, payments, refunds, receipts and day closes. Open orders are always kept." },
  customers: { label: "Customers", needs: ["customers"], detail: "Customers added in the range who have no orders left. A customer with an order outside this deletion is kept." },
  printing: { label: "Print history", needs: ["printing"], detail: "Printed and failed print jobs and printer scans. Jobs still waiting to print are kept." },
  attendance: { label: "Staff attendance", needs: ["staff"], detail: "Finished staff sign-ins and expired daily passwords. Staff accounts are kept." },
  social: { label: "Social posts", needs: ["social"], detail: "Social post drafts and history." },
  audit: { label: "Audit log", needs: ["audit"], detail: "Activity entries in the range. The record of every backup, restore and deletion is always kept." },
} as const satisfies Record<string, { label: string; needs: readonly DatasetKey[]; detail: string }>;

export type PurgeCategory = keyof typeof PURGE_CATEGORIES;
/** `from` absent = from the beginning; both ends are restaurant business dates and both are included. */
export type PurgeRangeInput = { from?: string; to: string };
export type PurgeRequest = PurgeRangeInput & { categories: PurgeCategory[]; backupId: string; confirmation: string };
export type PurgePreview = { from: string | null; to: string; counts: Record<string, PurgeCount>; total: number };
export type PurgeResult = PurgePreview & {
  /** What was actually removed, per table. */
  deleted: Record<string, number>;
  deletedTotal: number;
  /** Deletable records still found in the range afterwards: 0 unless something was added during the deletion. */
  remaining: number;
};

const sumDelete = (counts: Record<string, PurgeCount>) => Object.values(counts).reduce((n, c) => n + Object.values(c.delete).reduce((a, b) => a + b, 0), 0);

/** Validates the range and turns it into the restaurant's local-midnight boundaries. */
function purgeRange(ctx: TenantContext, input: PurgeRangeInput): PurgeRange {
  const today = toIsoDate(businessDateFor(now(), ctx.restaurant.timezone));
  if (input.to > today) throw new ValidationError("Choose today or an earlier date.", { to: ["The end date cannot be in the future."] });
  if (input.from && input.from > input.to) throw new ValidationError("The start date is after the end date.", { from: ["Choose a start on or before the end."] });
  const tz = ctx.restaurant.timezone;
  return {
    fromDate: input.from ? parseIsoDate(input.from) : undefined,
    toDate: parseIsoDate(input.to),
    startAt: input.from ? utcRangeForBusinessDates(input.from, input.from, tz).start : undefined,
    endAt: utcRangeForBusinessDates(input.to, input.to, tz).end,
  };
}

const orderedCategories = (requested: readonly PurgeCategory[]) => (Object.keys(PURGE_CATEGORIES) as PurgeCategory[]).filter((c) => requested.includes(c));

/** SA-DATA-05 — exactly what a deletion of this range would remove and keep, before anything is touched. */
export async function previewPurge(ctx: TenantContext, input: PurgeRangeInput & { categories: PurgeCategory[] }): Promise<PurgePreview> {
  const range = purgeRange(ctx, input);
  const counts = await withTx(ctx, (tx) => countPurge(tx, ctx, orderedCategories(input.categories), range));
  return { from: input.from ?? null, to: input.to, counts, total: sumDelete(counts) };
}

/** The backup a deletion relies on must be this restaurant's, recent, and cover the range and the data. */
async function assertBackupCovers(ctx: TenantContext, request: PurgeRequest): Promise<void> {
  const record = await withTx(ctx, (tx) => findExportRecord(tx, ctx, request.backupId));
  const after = (record?.afterState ?? {}) as { datasets?: string[]; from?: string | null; to?: string | null };
  const needs = request.categories.flatMap((c) => PURGE_CATEGORIES[c].needs);
  const fresh = record !== null && now().getTime() - record.createdAt.getTime() <= BACKUP_FRESH_MS;
  const startsEarlyEnough = after.from === null || after.from === undefined || (request.from !== undefined && after.from <= request.from);
  const endsLateEnough = after.to === null || after.to === undefined || after.to >= request.to;
  const covers = startsEarlyEnough && endsLateEnough && needs.every((d) => after.datasets?.includes(d));
  if (!fresh || !covers) {
    throw new ValidationError("Download a backup of this data first. Deleting is only possible within 24 hours of downloading a backup that covers everything being deleted.", { backupId: ["Download the backup first."] }, "BACKUP_REQUIRED");
  }
}

/**
 * SA-DATA-03 — deletes the range in one transaction, then counts the same range again and reports both. The result
 * carries the real numbers, so the screen never says "deleted" when nothing matched (owner bug report 2026-10-07: a
 * deletion with the default cutoff matched no records and still reported success).
 */
export async function purgeData(ctx: TenantContext, request: PurgeRequest): Promise<PurgeResult> {
  if (request.confirmation !== DELETE_CONFIRMATION) throw new ValidationError(`Type ${DELETE_CONFIRMATION} to confirm.`, { confirmation: [`Type ${DELETE_CONFIRMATION} exactly.`] }, "CONFIRMATION_REQUIRED");
  const range = purgeRange(ctx, request);
  const limit = await consumeScope("data.purge", ctx.userId);
  if (!limit.allowed) throw new RateLimitedError(limit.retryAfterSec, "Too many deletions in the last hour. Try again later.");
  await assertBackupCovers(ctx, request);
  const categories = orderedCategories(request.categories);

  const result = await withTx(
    ctx,
    async (tx) => {
      const counts = await countPurge(tx, ctx, categories, range);
      const deleted: Record<string, number> = {};
      // Orders first: customers become deletable only once their orders are gone.
      if (categories.includes("orders")) Object.assign(deleted, await deleteOrdersInRange(tx, ctx, range));
      if (categories.includes("customers")) Object.assign(deleted, await deleteCustomersInRange(tx, ctx, range));
      if (categories.includes("printing")) Object.assign(deleted, await deletePrintHistoryInRange(tx, ctx, range));
      if (categories.includes("attendance")) Object.assign(deleted, await deleteAttendanceInRange(tx, ctx, range));
      if (categories.includes("social")) Object.assign(deleted, await deleteSocialPostsInRange(tx, ctx, range));
      if (categories.includes("audit")) Object.assign(deleted, await deleteAuditInRange(tx, ctx, range));
      // Verify inside the same transaction: what is still deletable in the range must now be nothing.
      const remaining = sumDelete(await countPurge(tx, ctx, categories, range));
      const deletedTotal = Object.values(deleted).reduce((a, b) => a + b, 0);
      await audit(tx, ctx, {
        action: "data.deleted",
        resourceType: "tenant_data",
        after: { categories, from: request.from ?? null, to: request.to, backupId: request.backupId, deleted, deletedTotal, remaining },
        reason: "Owner-requested deletion of a date range after a verified backup",
      });
      return { from: request.from ?? null, to: request.to, counts, total: sumDelete(counts), deleted, deletedTotal, remaining };
    },
    { timeoutMs: 300_000 },
  );
  logger.info("data.deleted", { requestId: ctx.requestId, tenantId: ctx.tenantId, categories, deletedTotal: result.deletedTotal, remaining: result.remaining });
  return result;
}

// ───────────────────────── overview and reminder ─────────────────────────

const REMINDER_DAYS: Record<BackupReminder, number | null> = { MANUAL: null, MONTHLY: 30, SIX_MONTHS: 182 };

export type DataOverview = {
  restaurantName: string;
  lastBackupAt: string | null;
  reminder: BackupReminder;
  backupDue: boolean;
  today: string;
  counts: Record<string, number>;
  history: { id: string; action: string; at: string; by: string | null; summary: Record<string, unknown> }[];
};

export function isBackupDue(reminder: BackupReminder, lastBackupAt: Date | null, at: Date): boolean {
  const days = REMINDER_DAYS[reminder];
  if (days === null) return false;
  return lastBackupAt === null || at.getTime() - lastBackupAt.getTime() > days * 24 * 60 * 60 * 1000;
}

export async function getDataOverview(ctx: TenantContext): Promise<DataOverview> {
  return withTx(ctx, async (tx) => {
    const [identity, last, counts, events] = await Promise.all([restaurantIdentity(tx, ctx), lastFullBackupAt(tx, ctx), dataCounts(tx, ctx), recentDataEvents(tx, ctx)]);
    return {
      restaurantName: identity.name,
      lastBackupAt: last?.toISOString() ?? null,
      reminder: identity.backupReminder,
      backupDue: isBackupDue(identity.backupReminder, last, now()),
      today: toIsoDate(businessDateFor(now(), ctx.restaurant.timezone)),
      counts,
      history: events.map((e) => ({ id: e.id, action: e.action, at: e.createdAt.toISOString(), by: e.actor?.fullName ?? e.actor?.email ?? null, summary: (e.afterState ?? {}) as Record<string, unknown> })),
    };
  });
}

/** Whether the console should nudge the admin about a backup — cheap enough for the dashboard. */
export async function backupReminderDue(ctx: TenantContext): Promise<boolean> {
  return withTx(ctx, async (tx) => {
    const [identity, last] = await Promise.all([restaurantIdentity(tx, ctx), lastFullBackupAt(tx, ctx)]);
    return isBackupDue(identity.backupReminder, last, now());
  });
}

export async function setBackupReminder(ctx: TenantContext, value: BackupReminder): Promise<{ reminder: BackupReminder }> {
  await withTx(ctx, async (tx) => {
    const previous = await updateBackupReminder(tx, ctx, value);
    await audit(tx, ctx, { action: "data.backup_reminder_updated", resourceType: "restaurant", resourceId: ctx.restaurant.id, before: { reminder: previous }, after: { reminder: value } });
  });
  return { reminder: value };
}
