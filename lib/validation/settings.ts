/**
 * Restaurant settings and kitchen section input (S1-P07-T001, S1-P07-T003; api.md §5 SA-RST-01…06, SA-KSEC-01…04).
 * Lengths and formats follow data-model.md E02–E04. Every schema is a `strictObject`: `tenantId` and any other unknown
 * key is rejected with 422 (SC-VAL-01, TI-015).
 *
 * Patch fields: a key that is omitted leaves the column unchanged; `null` or an empty string clears it.
 */
import { z, type ZodTypeAny } from "zod";
import { isValidTimeZone } from "@/lib/time/zone";
import { boundedText, e164Field, emailField, strictObject, uuidParam } from "./core";
import { imageUrl } from "./url";

const blankToNull = (value: unknown) => (typeof value === "string" && value.trim() === "" ? null : value);

/** Optional column: omitted → undefined (unchanged), "" or null → null (cleared), otherwise validated by `schema`. */
function clearable<T extends ZodTypeAny>(schema: T) {
  return z.preprocess(blankToNull, schema.nullable().optional());
}

function maxText(max: number, label: string) {
  return z.string().trim().max(max, `${label} must be at most ${max} characters`);
}

// ─── SA-RST-01 profile (restaurant:update) ───

export const updateRestaurantProfileSchema = strictObject({
  name: boundedText(120, { min: 2, label: "Restaurant name" }),
  description: clearable(maxText(1000, "Description")),
  phoneE164: clearable(e164Field),
  email: clearable(emailField),
  addressLine1: clearable(maxText(160, "Address line 1")),
  addressLine2: clearable(maxText(160, "Address line 2")),
  city: clearable(maxText(80, "City")),
  region: clearable(maxText(80, "State / region")),
  postalCode: clearable(maxText(16, "Postal code")),
});

/** What the settings form sends (each optional field may be an empty string or null to clear it). */
export type UpdateRestaurantProfileInput = {
  name: string;
  description?: string | null;
  phoneE164?: string | null;
  email?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
};
export type UpdateRestaurantProfileData = z.output<typeof updateRestaurantProfileSchema>;

// ─── SA-RST-02 branding (website:update) ───

/** The public site canvas (brand token Warm Light); accents must reach WCAG AA 4.5:1 against it (E02). */
export const PUBLIC_CANVAS_HEX = "#FBF9F5";
export const MIN_ACCENT_CONTRAST = 4.5;
const HEX_COLOUR = /^#[0-9A-Fa-f]{6}$/;

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.x relative luminance of `#RRGGBB`. */
export function relativeLuminance(hex: string): number {
  if (!HEX_COLOUR.test(hex)) throw new RangeError(`Invalid colour ${hex}`);
  const [r, g, b] = [1, 3, 5].map((i) => channel(parseInt(hex.slice(i, i + 2), 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio between two `#RRGGBB` colours (1–21). */
export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

const brandAccentField = z
  .string()
  .trim()
  .regex(HEX_COLOUR, "Use a colour like #7C2D12")
  .transform((value) => value.toUpperCase())
  .refine(
    (value) => contrastRatio(value, PUBLIC_CANVAS_HEX) >= MIN_ACCENT_CONTRAST,
    `This colour is too light to read on the website background; choose one with at least ${MIN_ACCENT_CONTRAST}:1 contrast`,
  );

export const updateBrandingSchema = strictObject({
  logoUrl: clearable(imageUrl("Logo")),
  coverImageUrl: clearable(imageUrl("Cover image")),
  brandAccentHex: clearable(brandAccentField),
});
export type UpdateBrandingInput = { logoUrl?: string | null; coverImageUrl?: string | null; brandAccentHex?: string | null };
export type UpdateBrandingData = z.output<typeof updateBrandingSchema>;

// ─── SA-RST-03 opening hours (restaurant:update) ───

export const DAYS_PER_WEEK = 7;
export const MAX_SHIFTS_PER_DAY = 3;
const MINUTES_PER_DAY = 24 * 60;
const MINUTES_PER_WEEK = DAYS_PER_WEEK * MINUTES_PER_DAY;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;

const timeOfDay = z.string().trim().regex(HHMM, "Use 24-hour time, e.g. 09:30");

export const shiftSchema = strictObject({ opensAt: timeOfDay, closesAt: timeOfDay });

export const openingDaySchema = strictObject({
  dayOfWeek: z.number().int().min(1, "Use 1 (Monday) to 7 (Sunday)").max(7, "Use 1 (Monday) to 7 (Sunday)"),
  isClosed: z.boolean(),
  shifts: z.array(shiftSchema).max(MAX_SHIFTS_PER_DAY, `At most ${MAX_SHIFTS_PER_DAY} shifts per day`),
});

export type OpeningShift = { opensAt: string; closesAt: string };
export type OpeningDay = { dayOfWeek: number; isClosed: boolean; shifts: OpeningShift[] };

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

export type HoursIssue = { path: (string | number)[]; message: string };

/**
 * Rules for a full week (E03): exactly one entry per ISO weekday; a closed day has no shifts; an open day has 1–3
 * shifts; a shift never opens and closes at the same minute; `closesAt < opensAt` closes after midnight; no two shifts
 * overlap anywhere in the week — including an overnight shift running into the next day's first shift, and Sunday
 * night into Monday. Touching shifts (15:00–18:00 then 18:00–22:00) are allowed.
 */
export function openingHoursIssues(days: readonly OpeningDay[]): HoursIssue[] {
  // Malformed days or times are reported by the field schemas; week-level rules need well-formed input.
  const wellFormed = days.every(
    (day) => Number.isInteger(day.dayOfWeek) && day.dayOfWeek >= 1 && day.dayOfWeek <= 7 && day.shifts.every((s) => HHMM.test(s.opensAt) && HHMM.test(s.closesAt)),
  );
  if (!wellFormed) return [];

  const issues: HoursIssue[] = [];
  const seen = new Set<number>();
  days.forEach((day, i) => {
    if (seen.has(day.dayOfWeek)) issues.push({ path: ["days", i, "dayOfWeek"], message: `${DAY_NAMES[day.dayOfWeek - 1]} is listed twice` });
    seen.add(day.dayOfWeek);
    if (day.isClosed && day.shifts.length > 0) issues.push({ path: ["days", i, "shifts"], message: "A closed day has no shifts" });
    if (!day.isClosed && day.shifts.length === 0) issues.push({ path: ["days", i, "shifts"], message: "Add a shift or mark the day closed" });
    day.shifts.forEach((shift, j) => {
      if (shift.opensAt === shift.closesAt) issues.push({ path: ["days", i, "shifts", j, "closesAt"], message: "Closing time must differ from opening time" });
    });
  });
  if (days.length !== DAYS_PER_WEEK || seen.size !== DAYS_PER_WEEK) {
    issues.push({ path: ["days"], message: "Send all seven days, Monday to Sunday" });
  }
  if (issues.length > 0) return issues;

  // Every open shift as an interval on a cyclic week timeline (minutes from Monday 00:00).
  type Interval = { start: number; end: number; path: (string | number)[] };
  const intervals: Interval[] = [];
  days.forEach((day, i) => {
    if (day.isClosed) return;
    day.shifts.forEach((shift, j) => {
      const opens = minutesOf(shift.opensAt);
      const closes = minutesOf(shift.closesAt);
      const start = (day.dayOfWeek - 1) * MINUTES_PER_DAY + opens;
      const end = start + (closes > opens ? closes - opens : closes + MINUTES_PER_DAY - opens);
      const path = ["days", i, "shifts", j];
      if (end <= MINUTES_PER_WEEK) intervals.push({ start, end, path });
      else intervals.push({ start, end: MINUTES_PER_WEEK, path }, { start: 0, end: end - MINUTES_PER_WEEK, path });
    });
  });
  intervals.sort((a, b) => a.start - b.start || a.end - b.end);
  const reported = new Set<string>();
  let reach = intervals[0];
  for (const current of intervals.slice(1)) {
    if (current.start < reach.end) {
      const key = current.path.join(".");
      if (!reported.has(key)) issues.push({ path: current.path, message: "This shift overlaps another shift" });
      reported.add(key);
    }
    if (current.end > reach.end) reach = current;
  }
  return issues;
}

export const replaceOpeningHoursSchema = strictObject({
  days: z.array(openingDaySchema).max(DAYS_PER_WEEK * 2, "Send all seven days, Monday to Sunday"),
}).superRefine((value, ctx) => {
  for (const issue of openingHoursIssues(value.days)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: issue.path, message: issue.message });
});
export type ReplaceOpeningHoursInput = { days: OpeningDay[] };
export type ReplaceOpeningHoursData = z.output<typeof replaceOpeningHoursSchema>;

// ─── SA-RST-04 operational settings (restaurant:settings:update) ───

/** ISO 3166-1 alpha-2 country codes (officially assigned). */
const ISO_COUNTRY_CODES = new Set(
  (
    "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ " +
    "CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR " +
    "GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP " +
    "KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT " +
    "MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW " +
    "SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG " +
    "UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW"
  ).split(" "),
);

export function isCountryCode(value: string): boolean {
  return ISO_COUNTRY_CODES.has(value);
}

/** ISO 4217 codes the runtime can format (`Intl.supportedValuesOf("currency")`), e.g. INR, USD, EUR. */
export function isSupportedCurrency(value: string): boolean {
  return /^[A-Z]{3}$/.test(value) && Intl.supportedValuesOf("currency").includes(value);
}

/** E02 `gstin`: 15-character GSTIN, stored uppercase (Q-004). */
export const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export const timeZoneField = z
  .string()
  .trim()
  .refine((value) => isValidTimeZone(value), "Use a time zone name such as Asia/Kolkata (abbreviations like IST are ambiguous)");
export const currencyCodeField = z
  .string()
  .trim()
  .toUpperCase()
  .refine(isSupportedCurrency, "Use a three-letter ISO 4217 currency code, e.g. INR");
export const countryCodeField = z
  .string()
  .trim()
  .toUpperCase()
  .refine(isCountryCode, "Use a two-letter ISO 3166 country code, e.g. IN");
const gstinField = z
  .string()
  .trim()
  .toUpperCase()
  .regex(GSTIN_PATTERN, "Enter a 15-character GSTIN, e.g. 29ABCDE1234F1Z5");

export const ORDER_TYPES = ["DINE_IN", "TAKEAWAY", "DELIVERY"] as const;

export const updateOperationalSettingsSchema = strictObject({
  timezone: timeZoneField,
  currencyCode: currencyCodeField,
  countryCode: countryCodeField,
  defaultOrderType: z.enum(ORDER_TYPES, { errorMap: () => ({ message: "Choose dine-in, takeaway or delivery" }) }),
  autoPrintKot: z.boolean(),
  /** Optional so a caller that does not show the switch never changes it (absent = keep the stored value). */
  simplifiedWorkflow: z.boolean().optional(),
  receiptFooter: clearable(maxText(280, "Receipt footer")),
  gstin: clearable(gstinField),
});
export type UpdateOperationalSettingsInput = {
  timezone: string;
  currencyCode: string;
  countryCode: string;
  defaultOrderType: (typeof ORDER_TYPES)[number];
  autoPrintKot: boolean;
  simplifiedWorkflow?: boolean;
  receiptFooter?: string | null;
  gstin?: string | null;
};
export type UpdateOperationalSettingsData = z.output<typeof updateOperationalSettingsSchema>;

// ─── SA-RST-05 website settings, SA-RST-06 publish (website:update) ───

export const updateWebsiteSettingsSchema = strictObject({
  showPhone: z.boolean(),
  showEmail: z.boolean(),
  showAddress: z.boolean(),
  seoTitle: clearable(maxText(60, "SEO title")),
  seoDescription: clearable(maxText(160, "SEO description")),
});
export type UpdateWebsiteSettingsInput = {
  showPhone: boolean;
  showEmail: boolean;
  showAddress: boolean;
  seoTitle?: string | null;
  seoDescription?: string | null;
};
export type UpdateWebsiteSettingsData = z.output<typeof updateWebsiteSettingsSchema>;

export const setWebsitePublishedSchema = strictObject({ published: z.boolean() });
export type SetWebsitePublishedInput = z.input<typeof setWebsitePublishedSchema>;

// ─── SA-KSEC-01…04 kitchen sections (kitchen_section:manage) ───

const sectionName = boundedText(60, { min: 2, label: "Section name" });
const sectionCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9_]{2,24}$/, "Use 2–24 letters, digits or underscores, e.g. TANDOOR");

export const createKitchenSectionSchema = strictObject({ name: sectionName, code: sectionCode });
export type CreateKitchenSectionInput = z.input<typeof createKitchenSectionSchema>;
export type CreateKitchenSectionData = z.output<typeof createKitchenSectionSchema>;

export const updateKitchenSectionSchema = strictObject({
  sectionId: uuidParam,
  name: sectionName.optional(),
  code: sectionCode.optional(),
});
export type UpdateKitchenSectionInput = z.input<typeof updateKitchenSectionSchema>;
export type UpdateKitchenSectionData = z.output<typeof updateKitchenSectionSchema>;

export const kitchenSectionIdSchema = strictObject({ sectionId: uuidParam });
export type KitchenSectionIdInput = z.input<typeof kitchenSectionIdSchema>;

export const reorderKitchenSectionsSchema = strictObject({
  orderedIds: z
    .array(uuidParam)
    .min(1, "Send the sections in their new order")
    .max(200, "Too many sections")
    .refine((ids) => new Set(ids).size === ids.length, "Each section can appear once"),
});
export type ReorderKitchenSectionsInput = z.input<typeof reorderKitchenSectionsSchema>;
