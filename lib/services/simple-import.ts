import "server-only";
import type { TenantContext } from "@/lib/auth/context-types";
import { categoriesByName, existingCustomerPhones, existingItemKeys } from "@/lib/data/simple-import";
import { parseCsv } from "@/lib/data-portability/tabular";
import { readXlsxTable } from "@/lib/data-portability/xlsx-read";
import { ZipError } from "@/lib/data-portability/zip";
import { AppError, ConflictError, ValidationError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { createCustomerSchema } from "@/lib/validation/customers";
import { createCategorySchema, createMenuItemSchema } from "@/lib/validation/menu";
import { createCustomer } from "./customers";
import { createCategory } from "./menu-categories";
import { createItem } from "./menu-items";

/**
 * Importing customers and menu items from an ordinary spreadsheet — CSV or Excel (RASOIOS-ADR-022; owner review
 * 2026-10-06 §9). Unlike a backup restore, the file needs no ids: one row per customer or dish, with named columns.
 *
 * Every row goes through the same schema and the same create service as the console's own forms, so a phone, price or
 * tax rate the console would refuse is refused here too, and each record is audited exactly as if typed in. Preview
 * reads and checks everything without writing; import then re-reads the same file and creates the rows that are new.
 * A customer whose phone is already on file, or a dish already in its category, is skipped and reported — never
 * overwritten. Tenant, ids and audit come from the session, never from the file.
 */

export type SimpleImportKind = "customers" | "menuItems";
export type ImportRowIssue = { row: number; message: string };
export type SimpleImportPreview = { kind: SimpleImportKind; fileName: string; total: number; toCreate: number; duplicates: number; errors: ImportRowIssue[]; columns: string[]; newCategories: string[] };
export type SimpleImportResult = { kind: SimpleImportKind; created: number; duplicates: number; failed: ImportRowIssue[] };

const MAX_ROWS = 5000;
const fileError = (message: string) => new ValidationError(message, { file: [message] }, "IMPORT_INVALID");

const COLUMN_ALIASES: Record<SimpleImportKind, Record<string, string[]>> = {
  customers: {
    fullName: ["name", "fullname", "customer", "customername"],
    phone: ["phone", "mobile", "phonenumber", "mobilenumber", "phonee164", "contact"],
    email: ["email", "emailaddress", "mail"],
    notes: ["notes", "note", "remarks"],
  },
  menuItems: {
    category: ["category", "categoryname", "section", "menusection"],
    name: ["name", "item", "itemname", "dish", "dishname"],
    price: ["price", "baseprice", "rate", "amount", "mrp"],
    taxRate: ["tax", "taxrate", "gst", "gstrate", "taxpercent", "gstpercent"],
    description: ["description", "details", "desc"],
    dietary: ["dietary", "veg", "vegnonveg", "type", "foodtype", "dietarytype"],
  },
};
const REQUIRED: Record<SimpleImportKind, string[]> = { customers: ["fullName"], menuItems: ["category", "name", "price", "taxRate"] };
const COLUMN_HELP: Record<string, string> = { fullName: "Name", category: "Category", name: "Name", price: "Price", taxRate: "Tax rate (e.g. 5)" };

export function readTable(fileName: string, bytes: Buffer): { columns: string[]; rows: string[][] } {
  const lower = fileName.toLowerCase();
  try {
    if (lower.endsWith(".xlsx")) return readXlsxTable(bytes);
    if (lower.endsWith(".csv")) return parseCsv(bytes.toString("utf8"));
  } catch (error) {
    throw fileError(error instanceof ZipError ? error.message : "The file could not be read.");
  }
  throw fileError("Choose a .csv or .xlsx file.");
}

/** Maps the file's header row onto our fields by common names ("Mobile", "GST %", "Dish" …). */
function mapColumns(kind: SimpleImportKind, header: string[]): Record<string, number> {
  const normal = header.map((h) => h.toLowerCase().replace(/[^a-z0-9]/g, ""));
  const map: Record<string, number> = {};
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES[kind])) {
    const index = normal.findIndex((h) => aliases.includes(h));
    if (index >= 0) map[field] = index;
  }
  const missing = REQUIRED[kind].filter((f) => map[f] === undefined);
  if (missing.length > 0) throw fileError(`The file needs a column for: ${missing.map((f) => COLUMN_HELP[f] ?? f).join(", ")}. Found: ${header.join(", ") || "no header row"}.`);
  return map;
}

/** Local numbers become international using the restaurant's country (10-digit Indian mobile → +91…). */
export function normalisePhone(raw: string, countryCode: string): string {
  const compact = raw.replace(/[\s().-]/g, "");
  if (compact === "") return "";
  if (compact.startsWith("+")) return compact;
  if (compact.startsWith("00")) return `+${compact.slice(2)}`;
  if (countryCode === "IN") {
    if (/^0?[6-9]\d{9}$/.test(compact)) return `+91${compact.replace(/^0/, "")}`;
    if (/^91[6-9]\d{9}$/.test(compact)) return `+${compact}`;
  }
  return compact;
}

const DIETARY: Record<string, "VEG" | "NON_VEG" | "EGG"> = { veg: "VEG", vegetarian: "VEG", v: "VEG", nonveg: "NON_VEG", nonvegetarian: "NON_VEG", nv: "NON_VEG", egg: "EGG", eggetarian: "EGG" };

type Planned =
  | { kind: "customers"; row: number; data: ReturnType<typeof createCustomerSchema.parse> }
  | { kind: "menuItems"; row: number; category: string; data: Omit<ReturnType<typeof createMenuItemSchema.parse>, "categoryId"> };

async function plan(ctx: TenantContext, kind: SimpleImportKind, file: { name: string; bytes: Buffer }, countryCode: string) {
  const { columns, rows } = readTable(file.name, file.bytes);
  if (rows.length === 0) throw fileError("The file has a header row but no data.");
  if (rows.length > MAX_ROWS) throw fileError(`The file has ${rows.length} rows; at most ${MAX_ROWS} can be imported at once.`);
  const map = mapColumns(kind, columns);
  const cell = (r: string[], field: string) => (map[field] === undefined ? "" : (r[map[field]] ?? "").trim());

  const errors: ImportRowIssue[] = [];
  const planned: Planned[] = [];
  let duplicates = 0;
  const firstIssue = (issues: { message: string; path: (string | number)[] }[]) => issues.map((i) => i.message).slice(0, 2).join("; ");

  if (kind === "customers") {
    const seen = new Set<string>();
    const candidates = rows.map((r, i) => ({ row: i + 2, parsed: createCustomerSchema.safeParse({ fullName: cell(r, "fullName"), phoneE164: normalisePhone(cell(r, "phone"), countryCode) || undefined, email: cell(r, "email") || undefined, notes: cell(r, "notes") || undefined }) }));
    const phones = candidates.flatMap((c) => (c.parsed.success && c.parsed.data.phoneE164 ? [c.parsed.data.phoneE164] : []));
    const onFile = await existingCustomerPhones(ctx, phones);
    for (const c of candidates) {
      if (!c.parsed.success) {
        errors.push({ row: c.row, message: firstIssue(c.parsed.error.issues) });
        continue;
      }
      const phone = c.parsed.data.phoneE164;
      if (phone && (onFile.has(phone) || seen.has(phone))) {
        duplicates++;
        continue;
      }
      if (phone) seen.add(phone);
      planned.push({ kind: "customers", row: c.row, data: c.parsed.data });
    }
    return { columns, total: rows.length, planned, duplicates, errors, newCategories: [] as string[] };
  }

  const categories = await categoriesByName(ctx);
  const existing = await existingItemKeys(ctx);
  const seen = new Set<string>();
  const newCategories = new Set<string>();
  rows.forEach((r, i) => {
    const row = i + 2;
    const category = cell(r, "category");
    const dietaryRaw = cell(r, "dietary").toLowerCase().replace(/[^a-z]/g, "");
    const dietary = dietaryRaw === "" ? null : DIETARY[dietaryRaw];
    if (dietary === undefined) {
      errors.push({ row, message: `Dietary type "${cell(r, "dietary")}" is not veg, non-veg or egg` });
      return;
    }
    const categoryCheck = createCategorySchema.safeParse({ name: category });
    if (!categoryCheck.success) {
      errors.push({ row, message: `Category: ${firstIssue(categoryCheck.error.issues)}` });
      return;
    }
    const parsed = createMenuItemSchema.safeParse({
      categoryId: "00000000-0000-4000-8000-000000000000", // placeholder, replaced by the real category on import
      name: cell(r, "name"),
      description: cell(r, "description") || undefined,
      basePrice: cell(r, "price").replace(/[₹,\s]/g, ""),
      taxRate: cell(r, "taxRate").replace(/[%\s]/g, ""),
      dietaryType: dietary,
    });
    if (!parsed.success) {
      errors.push({ row, message: firstIssue(parsed.error.issues) });
      return;
    }
    const categoryKey = category.toLowerCase();
    const categoryId = categories.get(categoryKey);
    const key = `${categoryId ?? `new:${categoryKey}`}|${parsed.data.name.trim().toLowerCase()}`;
    if ((categoryId && existing.has(key)) || seen.has(key)) {
      duplicates++;
      return;
    }
    seen.add(key);
    if (!categoryId) newCategories.add(category);
    const { categoryId: _placeholder, ...data } = parsed.data;
    void _placeholder;
    planned.push({ kind: "menuItems", row, category, data });
  });
  return { columns, total: rows.length, planned, duplicates, errors, newCategories: [...newCategories] };
}

export async function previewSimpleImport(ctx: TenantContext, kind: SimpleImportKind, file: { name: string; bytes: Buffer }, countryCode: string): Promise<SimpleImportPreview> {
  const p = await plan(ctx, kind, file, countryCode);
  return { kind, fileName: file.name, total: p.total, toCreate: p.planned.length, duplicates: p.duplicates, errors: p.errors.slice(0, 50), columns: p.columns, newCategories: p.newCategories };
}

/**
 * Creates the new rows through the console's own services, one audited record each. Rows that fail on the way in
 * (for example a phone taken a moment ago by a colleague) are reported, not hidden.
 */
export async function commitSimpleImport(ctx: TenantContext, kind: SimpleImportKind, file: { name: string; bytes: Buffer }, countryCode: string): Promise<SimpleImportResult> {
  const p = await plan(ctx, kind, file, countryCode);
  if (p.errors.length > 0) throw fileError(`${p.errors.length} row${p.errors.length === 1 ? " has" : "s have"} problems. Nothing was imported — fix them and try again.`);
  if (p.planned.length === 0) throw fileError("Everything in this file is already here. Nothing to import.");

  const failed: ImportRowIssue[] = [];
  let created = 0;
  let duplicates = p.duplicates;
  const categoryIds = await categoriesByName(ctx);
  for (const item of p.planned) {
    try {
      if (item.kind === "customers") {
        await createCustomer(ctx, item.data);
      } else {
        const key = item.category.toLowerCase();
        let categoryId = categoryIds.get(key);
        if (!categoryId) {
          categoryId = (await createCategory(ctx, createCategorySchema.parse({ name: item.category }))).id;
          categoryIds.set(key, categoryId);
        }
        await createItem(ctx, { ...item.data, categoryId });
      }
      created++;
    } catch (error) {
      if (error instanceof ConflictError) duplicates++;
      else failed.push({ row: item.row, message: error instanceof AppError ? error.message : "Could not be saved." });
    }
  }
  logger.info("data.simple_import", { requestId: ctx.requestId, tenantId: ctx.tenantId, kind, created, duplicates, failed: failed.length });
  return { kind, created, duplicates, failed };
}
