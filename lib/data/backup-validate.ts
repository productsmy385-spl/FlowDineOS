import { Prisma } from "@prisma/client";
import type { Row } from "./data-portability";

/**
 * Field-level validation of rows read from a backup file (RASOIOS-ADR-021, brief §6).
 *
 * Driven by the Prisma schema itself — column types, lengths, enum values, required columns and relations — so every
 * restorable table is checked the same way and a new column is covered without touching this file. Nothing from a
 * file is trusted: unknown keys are dropped, `tenantId` is ignored (the caller sets it from the session), and money
 * stays a decimal string from file to database, never a float.
 */

type Field = Prisma.DMMF.Field;

const models = new Map(Prisma.dmmf.datamodel.models.map((m) => [m.name, m]));
const enums = new Map(Prisma.dmmf.datamodel.enums.map((e) => [e.name, new Set(e.values.map((v) => v.name))]));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECIMAL = /^-?\d+(\.\d+)?$/;

function modelOf(name: Prisma.ModelName): Prisma.DMMF.Model {
  const model = models.get(name);
  if (!model) throw new Error(`Unknown model ${name}`);
  return model;
}

/** The columns a backup row carries for `model`, in schema order. */
export function columnsOf(name: Prisma.ModelName, omit: readonly string[] = []): Field[] {
  return modelOf(name).fields.filter((f) => (f.kind === "scalar" || f.kind === "enum") && !omit.includes(f.name));
}

/** Links to other rows of the same restaurant: relations declared over `(tenantId, <column>)`. */
export function tenantReferences(name: Prisma.ModelName): { column: string; target: Prisma.ModelName }[] {
  return modelOf(name)
    .fields.filter((f) => f.kind === "object" && f.relationFromFields?.length === 2 && f.relationFromFields[0] === "tenantId")
    .map((f) => ({ column: f.relationFromFields![1], target: f.type as Prisma.ModelName }));
}

/** Columns that name a person (a USER row). A restored row may only name someone who belongs to this restaurant. */
export function userReferences(name: Prisma.ModelName): string[] {
  return modelOf(name)
    .fields.filter((f) => f.kind === "object" && f.type === "User" && f.relationFromFields?.length === 1)
    .map((f) => f.relationFromFields![0]);
}

/** Display form of one stored value for CSV / Excel: dates as ISO, money as its decimal string, JSON as text. */
export function flattenValue(field: Field, value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return field.nativeType?.[0] === "Date" ? value.toISOString().slice(0, 10) : value.toISOString();
  if (Prisma.Decimal.isDecimal(value)) return (value as Prisma.Decimal).toFixed();
  if (field.type === "Json") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") return value;
  return String(value);
}

export type CoerceResult = { row: Row; issues: string[] };

/**
 * Turns one row from a file (JSON values, or CSV strings) into data the database accepts, or explains what is wrong.
 * `fromCsv` relaxes types the way a spreadsheet stores them: "true"/"false", numbers as text, empty cell = no value.
 */
export function coerceRow(name: Prisma.ModelName, raw: unknown, fromCsv = false): CoerceResult {
  const issues: string[] = [];
  const row: Row = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { row, issues: ["is not a record"] };
  const input = raw as Record<string, unknown>;

  for (const field of columnsOf(name)) {
    if (field.name === "tenantId") continue;
    let value = input[field.name];
    if (fromCsv && value === "") value = null;
    if (value === undefined || value === null) {
      if (field.name === "id") issues.push("has no id");
      else if (field.isRequired && !field.hasDefaultValue && !field.isUpdatedAt) issues.push(`is missing ${field.name}`);
      else if (value === null && !field.isRequired) row[field.name] = field.type === "Json" ? Prisma.DbNull : null;
      continue;
    }

    const problem = (what: string) => issues.push(`${field.name} ${what}`);
    if (field.kind === "enum") {
      if (typeof value !== "string" || !enums.get(field.type)?.has(value)) problem(`is not one of the allowed values`);
      else row[field.name] = value;
      continue;
    }
    switch (field.type) {
      case "String": {
        if (typeof value !== "string") {
          problem("must be text");
          break;
        }
        const [nativeType, args] = field.nativeType ?? [];
        if (nativeType === "Uuid" && !UUID.test(value)) problem("is not a valid id");
        else if ((nativeType === "VarChar" || nativeType === "Char") && args?.[0] && value.length > Number(args[0])) problem(`is longer than ${args[0]} characters`);
        else row[field.name] = value;
        break;
      }
      case "Int": {
        const n = typeof value === "number" ? value : fromCsv && typeof value === "string" && /^-?\d+$/.test(value) ? Number(value) : NaN;
        const small = field.nativeType?.[0] === "SmallInt";
        if (!Number.isInteger(n) || Math.abs(n) > (small ? 32767 : 2147483647)) problem("must be a whole number");
        else row[field.name] = n;
        break;
      }
      case "Boolean": {
        const b = typeof value === "boolean" ? value : fromCsv && (value === "true" || value === "false") ? value === "true" : null;
        if (b === null) problem("must be true or false");
        else row[field.name] = b;
        break;
      }
      case "DateTime": {
        const d = typeof value === "string" ? new Date(value) : null;
        if (!d || Number.isNaN(d.getTime())) problem("is not a valid date");
        else row[field.name] = d;
        break;
      }
      case "Decimal": {
        // Text only: a JSON number has already been through a float, and money must never have been.
        if (typeof value !== "string" || !DECIMAL.test(value)) {
          problem("must be a decimal amount written as text");
          break;
        }
        const [, args] = field.nativeType ?? [];
        const [precision, scale] = (args ?? []).map(Number);
        const [whole, fraction = ""] = value.replace("-", "").split(".");
        if (scale !== undefined && (fraction.length > scale || whole.replace(/^0+(?=\d)/, "").length > precision - scale)) problem(`does not fit ${precision},${scale}`);
        else row[field.name] = value;
        break;
      }
      case "Json": {
        if (typeof value === "string" && fromCsv) {
          try {
            row[field.name] = JSON.parse(value);
          } catch {
            problem("is not valid JSON");
          }
        } else row[field.name] = value;
        break;
      }
      default:
        problem(`has an unsupported type ${field.type}`);
    }
  }
  return { row, issues };
}
