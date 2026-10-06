/**
 * Platform (SUPER_ADMIN) input schemas (S1-P06-T001; api.md §3 SA-ADM-01…06, LD-ADM-02; data-model.md E01, E02, E06).
 *
 * - Every schema is a `strictObject`, so unknown keys are rejected with VALIDATION_ERROR (SC-VAL-01).
 * - The tenant a platform operation acts on is `targetTenantId`: it identifies the *target* of a SUPER_ADMIN operation
 *   and is authorised by the platform role, never by membership (api.md §3). It is deliberately not called `tenantId`,
 *   which is reserved for tenant context and rejected from every input (SC-TEN-01, TC-TENANT-006, TC-SEC-001).
 * - New tenants have no silent defaults: timezone, currency and country are required. The create form prefills them
 *   with Asia/Kolkata / INR / IN and shows them, which is what Q-005 A settled (answered 2026-09-22); the prefill is a
 *   visible starting value in the form, never a default this schema applies.
 */
import { z } from "zod";
import { FEATURE_KEYS, type FeatureKey } from "@/lib/auth/features";
import { RESERVED_HOST_LABELS, isReservedHostLabel } from "@/lib/tenancy/hostnames";
import { isValidTimeZone } from "@/lib/time/zone";
import { boundedText, emailField, optionalText, SLUG_PATTERN, strictObject, uuidParam } from "./core";

/**
 * Slugs that collide with application routes or with an operator-controlled host (data-model E01, ADR-012 §1).
 * The slug *is* the public sub-domain label, so both lists have to be the same one: `lib/tenancy/hostnames.ts`.
 */
export const RESERVED_SLUGS: readonly string[] = RESERVED_HOST_LABELS;

export const SLUG_RULE_MESSAGE = "Use 3–48 lowercase letters, numbers or hyphens, starting and ending with a letter or number";

export function isReservedSlug(slug: string): boolean {
  return isReservedHostLabel(slug);
}

/** Tenant slug: trimmed and lowercased, `^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$`, not reserved. */
export const tenantSlugField = z
  .string()
  .trim()
  .toLowerCase()
  .regex(SLUG_PATTERN, SLUG_RULE_MESSAGE)
  .refine((slug) => !isReservedSlug(slug), "This slug is reserved for the application. Choose another.");

export const timeZoneField = z
  .string()
  .trim()
  .refine((value) => isValidTimeZone(value), "Choose a valid IANA time zone, e.g. Asia/Kolkata");

const SUPPORTED_CURRENCIES: ReadonlySet<string> = new Set(Intl.supportedValuesOf("currency"));

/** ISO 4217 code supported by `Intl.NumberFormat` (data-model E02). */
export const currencyCodeField = z
  .string()
  .trim()
  .toUpperCase()
  .refine((value) => /^[A-Z]{3}$/.test(value) && SUPPORTED_CURRENCIES.has(value), "Choose a valid ISO 4217 currency code, e.g. INR");

/** Region codes Intl knows that are not ISO 3166-1 countries (unknown, pseudo-locales, groupings). */
const NON_COUNTRY_REGIONS = new Set(["ZZ", "EU", "EZ", "UN", "QO", "XA", "XB"]);
const regionNames = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" });

export function isKnownCountryCode(value: string): boolean {
  if (!/^[A-Z]{2}$/.test(value) || NON_COUNTRY_REGIONS.has(value)) return false;
  try {
    return regionNames.of(value) !== undefined;
  } catch {
    return false;
  }
}

/** ISO 3166-1 alpha-2, uppercase, known code (data-model E02). */
export const countryCodeField = z
  .string()
  .trim()
  .toUpperCase()
  .refine(isKnownCountryCode, "Choose a valid ISO 3166-1 country code, e.g. IN");

const tenantName = boundedText(120, { min: 2, label: "Tenant name" });
const restaurantName = boundedText(120, { min: 2, label: "Restaurant name" });

// ─── SA-ADM-01 createTenantAction ───

export const createTenantSchema = strictObject({
  tenantName,
  slug: tenantSlugField,
  restaurantName,
  timezone: timeZoneField,
  currencyCode: currencyCodeField,
  countryCode: countryCodeField,
  adminEmail: emailField,
  adminFullName: optionalText(120, "Full name"),
  /** The features this restaurant starts with (RASOIOS-ADR-023). Omitted: all of them. */
  enabledFeatures: z.array(z.enum(FEATURE_KEYS as [FeatureKey, ...FeatureKey[]])).max(FEATURE_KEYS.length).optional(),
});
export type CreateTenantInput = z.input<typeof createTenantSchema>;
export type CreateTenantData = z.output<typeof createTenantSchema>;

/** Slug availability hint for the create/edit forms (frontend.md §5.2 SlugField). */
export const slugAvailabilitySchema = strictObject({ slug: z.string().max(100, "Slug must be at most 100 characters") });
export type SlugAvailabilityInput = z.input<typeof slugAvailabilitySchema>;

// ─── SA-ADM-02 updateTenantAction ───

/**
 * Only the display name is editable. The slug is the restaurant's public address and is immutable after provisioning
 * (ADR-012 §4): changing it would break printed QR codes and shared links, so a rename is a platform operation with a
 * redirect and is Future Scope. `slug` is still accepted by the schema so that sending the *current* slug is a no-op
 * and sending a different one gets a clear 422 SLUG_IMMUTABLE from the service rather than "unknown field".
 */
export const updateTenantSchema = strictObject({
  targetTenantId: uuidParam,
  name: tenantName.optional(),
  slug: tenantSlugField.optional(),
}).refine((input) => input.name !== undefined || input.slug !== undefined, { message: "Change the name or the slug", path: ["_"] });
export type UpdateTenantInput = z.input<typeof updateTenantSchema>;
export type UpdateTenantData = z.output<typeof updateTenantSchema>;

// ─── SA-ADM-07 handOverTenantAction (S1-P06-T009) ───

export const handOverTenantSchema = strictObject({
  targetTenantId: uuidParam,
  note: optionalText(500, "Handover note"),
});
export type HandOverTenantInput = z.input<typeof handOverTenantSchema>;
export type HandOverTenantData = z.output<typeof handOverTenantSchema>;

// ─── SA-ADM-03 / SA-ADM-04 suspend and reactivate ───

export const suspendTenantSchema = strictObject({
  targetTenantId: uuidParam,
  reason: boundedText(500, { min: 10, label: "Reason" }),
});
export type SuspendTenantInput = z.input<typeof suspendTenantSchema>;
export type SuspendTenantData = z.output<typeof suspendTenantSchema>;

export const reactivateTenantSchema = strictObject({ targetTenantId: uuidParam });
export type ReactivateTenantInput = z.input<typeof reactivateTenantSchema>;

// ─── SA-ADM-05 / SA-ADM-06 tenant administrator invitations ───

export const inviteTenantAdminSchema = strictObject({
  targetTenantId: uuidParam,
  email: emailField,
  fullName: optionalText(120, "Full name"),
});
export type InviteTenantAdminInput = z.input<typeof inviteTenantAdminSchema>;
export type InviteTenantAdminData = z.output<typeof inviteTenantAdminSchema>;

export const revokeTenantAdminInviteSchema = strictObject({
  targetTenantId: uuidParam,
  membershipId: uuidParam,
});
export type RevokeTenantAdminInviteInput = z.input<typeof revokeTenantAdminInviteSchema>;

// ─── LD-ADM-02 tenant list ───

export const TENANT_LIST_DEFAULT_LIMIT = 25;
export const TENANT_LIST_MAX_LIMIT = 100;

export const tenantListQuerySchema = strictObject({
  q: z.string().trim().max(80, "Search must be at most 80 characters").optional(),
  status: z.enum(["ACTIVE", "SUSPENDED"]).optional(),
  sort: z.enum(["name", "createdAt"]).default("name"),
  cursor: z.string().max(200, "Invalid cursor").optional(),
  limit: z.coerce.number().int("Use a whole number").min(1, "Use at least 1").max(TENANT_LIST_MAX_LIMIT, `Use at most ${TENANT_LIST_MAX_LIMIT}`).default(TENANT_LIST_DEFAULT_LIMIT),
});
export type TenantListQueryInput = z.input<typeof tenantListQuerySchema>;
export type TenantListQuery = z.output<typeof tenantListQuerySchema>;

/**
 * Picks the LD-ADM-02 keys out of a Next.js `searchParams` object (first value of repeated keys; unrelated keys such as
 * tracking parameters are ignored) so a page can pass the result straight to `tenantListQuerySchema`.
 */
export function tenantListQueryFromSearchParams(searchParams: Record<string, string | string[] | undefined>): TenantListQueryInput {
  const pick = (key: string): string | undefined => {
    const value = searchParams[key];
    const first = Array.isArray(value) ? value[0] : value;
    return first === undefined || first === "" ? undefined : first;
  };
  const input: Record<string, string> = {};
  for (const key of ["q", "status", "sort", "cursor", "limit"]) {
    const value = pick(key);
    if (value !== undefined) input[key] = value;
  }
  return input as TenantListQueryInput;
}

/** A target tenant id from a route segment (`/admin/tenants/[tenantId]`); invalid ids render not-found. */
export const targetTenantIdParam = uuidParam;

// ─── SA-ADM-10 updateTenantFeaturesAction (RASOIOS-ADR-023) ───

export const updateTenantFeaturesSchema = strictObject({
  targetTenantId: uuidParam,
  enabled: z.array(z.enum(FEATURE_KEYS as [FeatureKey, ...FeatureKey[]])).max(FEATURE_KEYS.length),
});
export type UpdateTenantFeaturesInput = z.input<typeof updateTenantFeaturesSchema>;
