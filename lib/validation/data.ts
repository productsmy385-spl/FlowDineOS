import { z } from "zod";
import { businessDateParam, strictObject } from "./core";

/**
 * Inputs for backups, restore and deletion (RASOIOS-ADR-021). None of them carries a tenant: the restaurant is the
 * session's, always. `lib/services/data-management.ts` holds what each key means.
 */
export const DATASET_KEY_LIST = ["restaurant", "menu", "dailyMenus", "customers", "orders", "transactions", "staff", "social", "printing", "audit"] as const;
export const PURGE_CATEGORY_LIST = ["orders", "customers", "printing", "attendance", "social", "audit"] as const;
export const EXPORT_FORMATS = ["zip", "xlsx", "csv", "json"] as const;

/** `GET /api/v1/data/export` query: `datasets` is a comma list; dates are restaurant business dates. */
export const exportQuerySchema = strictObject({
  datasets: z
    .string()
    .max(200)
    .transform((value) => value.split(",").filter(Boolean))
    .pipe(z.array(z.enum(DATASET_KEY_LIST)).min(1, "Choose at least one kind of data")),
  format: z.enum(EXPORT_FORMATS),
  from: businessDateParam.optional(),
  to: businessDateParam.optional(),
  backupId: z.string().uuid().optional(),
});

export const purgeDataSchema = strictObject({
  categories: z.array(z.enum(PURGE_CATEGORY_LIST)).min(1, "Choose what to delete").max(PURGE_CATEGORY_LIST.length),
  before: businessDateParam,
  backupId: z.string().uuid("Download the backup first"),
  confirmation: z.string().max(60),
});
export type PurgeDataInput = z.input<typeof purgeDataSchema>;

export const backupReminderSchema = strictObject({ reminder: z.enum(["MANUAL", "MONTHLY", "SIX_MONTHS"]) });
export type BackupReminderInput = z.input<typeof backupReminderSchema>;
