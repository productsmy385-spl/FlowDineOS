import { z } from "zod";
import { boundedText, strictObject, uuidParam } from "./core";

/** Table QR inputs (RASOIOS-ADR-021). The restaurant is always the session's. */
const tableLabel = boundedText(20, { label: "Table name" }).regex(/^[\p{L}\p{N} ._#-]+$/u, "Use letters, numbers, spaces and . _ # -");

export const addTablesSchema = strictObject({ label: tableLabel.optional(), count: z.number().int().min(1).max(50).optional() }).refine(
  (value) => (value.label === undefined) !== (value.count === undefined),
  { message: "Give a table name or a number of tables", path: ["label"] },
);
export type AddTablesInput = z.input<typeof addTablesSchema>;

export const editTableSchema = strictObject({ id: uuidParam, label: tableLabel.optional(), isActive: z.boolean().optional() });
export type EditTableInput = z.input<typeof editTableSchema>;

export const tableIdSchema = strictObject({ id: uuidParam });
export type TableIdInput = z.input<typeof tableIdSchema>;
