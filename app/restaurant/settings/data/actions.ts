"use server";

import { requireTenant } from "@/lib/auth/guards";
import { action } from "@/lib/http/action";
import { getDataOverview, previewPurge, purgeData, setBackupReminder } from "@/lib/services/data-management";
import { parseInput } from "@/lib/validation/core";
import { backupReminderSchema, previewPurgeSchema, purgeDataSchema, type BackupReminderInput, type PreviewPurgeInput, type PurgeDataInput } from "@/lib/validation/data";

/**
 * Data management (RASOIOS-ADR-021). Downloads and uploads go through `/api/v1/data/*`; these actions read the
 * overview, set the backup reminder and run a deletion. All of them are the owner's/administrator's alone.
 */

/** LD-DATA-01 — `data:export`: last backup, reminder, record counts and the permanent backup/restore/delete history. */
export const getDataOverviewAction = action(async () => {
  const ctx = await requireTenant("data:export");
  return getDataOverview(ctx);
});

/** SA-DATA-04 — `data:export`: how often the console reminds the admin to download a backup. */
export const setBackupReminderAction = action(async (input: BackupReminderInput) => {
  const ctx = await requireTenant("data:export");
  const { reminder } = parseInput(backupReminderSchema, input);
  return setBackupReminder(ctx, reminder);
});

/** SA-DATA-03 — `data:purge`: deletes history before a date, after the backup check and typed confirmation. */
export const purgeDataAction = action(async (input: PurgeDataInput) => {
  const ctx = await requireTenant("data:purge");
  const data = parseInput(purgeDataSchema, input);
  return purgeData(ctx, data);
});

/** SA-DATA-05 — `data:purge`: counts exactly what deleting this range would remove and keep. Changes nothing. */
export const previewPurgeAction = action(async (input: PreviewPurgeInput) => {
  const ctx = await requireTenant("data:purge");
  return previewPurge(ctx, parseInput(previewPurgeSchema, input));
});
