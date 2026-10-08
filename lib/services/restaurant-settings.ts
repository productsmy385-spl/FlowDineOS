import "server-only";
import { revalidatePath } from "next/cache";
import type { TenantContext } from "@/lib/auth/context-types";
import { hasPermission } from "@/lib/auth/permissions";
import { listKitchenSections, type KitchenSectionDto } from "@/lib/data/kitchen-sections";
import {
  getRestaurantSettingsSnapshot,
  replaceOpeningHours,
  setWebsitePublished,
  tenantSlug,
  updateOperationalSettings,
  updateRestaurantBranding,
  updateRestaurantProfile,
  updateWebsiteSettings,
  type OpeningDayDto,
  type RestaurantSettingsDto,
  type WebsiteReadinessItem,
} from "@/lib/data/restaurant";
import { ValidationError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { assertOwnedImageUrls, imageUrlsBeforeSave, releaseUnusedImages } from "@/lib/services/media";
import { revalidateConsoleShell } from "@/lib/services/public-revalidate";
import type {
  ReplaceOpeningHoursData,
  UpdateBrandingData,
  UpdateOperationalSettingsData,
  UpdateRestaurantProfileData,
  UpdateWebsiteSettingsData,
} from "@/lib/validation/settings";

/**
 * Restaurant settings services (S1-P07-T001; api.md LD-RST-01, SA-RST-01…06). Callers are Server Actions that have
 * already passed `requireTenant(<permission>)` and validated input with the strict schemas in
 * `lib/validation/settings.ts`; the tenant is always `ctx.tenantId`.
 *
 * Changes that are visible on the public website (`/r/{slug}`) revalidate that page after they commit, so the ISR
 * cache does not serve the old profile, branding, hours or publication state.
 */

export type RestaurantSettingsView = {
  restaurant: RestaurantSettingsDto;
  hours: OpeningDayDto[];
  kitchenSections: KitchenSectionDto[];
  website: { slug: string; publicPath: string; published: boolean; readiness: WebsiteReadinessItem[] };
  /** INV-09: the currency can no longer change (the tenant has orders). */
  currencyLocked: boolean;
  /** What the caller may edit — UI only; every action re-checks on the server (SC-RBAC-08). */
  canEdit: { profile: boolean; settings: boolean; website: boolean; sections: boolean };
};

/** LD-RST-01 — `restaurant:read` (every tenant role); edit flags follow the caller's permissions. */
export async function getRestaurantSettings(ctx: TenantContext): Promise<RestaurantSettingsView> {
  const [snapshot, kitchenSections] = await Promise.all([getRestaurantSettingsSnapshot(ctx), listKitchenSections(ctx)]);
  return {
    restaurant: snapshot.restaurant,
    hours: snapshot.hours,
    kitchenSections,
    website: {
      slug: snapshot.slug,
      publicPath: `/r/${snapshot.slug}`,
      published: snapshot.restaurant.websitePublished,
      readiness: snapshot.websiteReadiness,
    },
    currencyLocked: snapshot.currencyLocked,
    canEdit: {
      profile: hasPermission(ctx, "restaurant:update"),
      settings: hasPermission(ctx, "restaurant:settings:update"),
      website: hasPermission(ctx, "website:update"),
      sections: hasPermission(ctx, "kitchen_section:manage"),
    },
  };
}

/** Drops the public page from the ISR cache. A failure is logged, never reported as a failed save (it committed). */
async function revalidatePublicSite(ctx: TenantContext): Promise<void> {
  try {
    revalidatePath(`/r/${await tenantSlug(ctx)}`);
  } catch (error) {
    logger.warn("restaurant.public_revalidate_failed", { requestId: ctx.requestId, tenantId: ctx.tenantId, error: error instanceof Error ? error.message : String(error) });
  }
}

/** SA-RST-01. */
export async function updateProfile(ctx: TenantContext, input: UpdateRestaurantProfileData): Promise<RestaurantSettingsDto> {
  const restaurant = await updateRestaurantProfile(ctx, input);
  await revalidatePublicSite(ctx);
  return restaurant;
}

/** SA-RST-02 — image URLs are already allowlisted and the accent contrast-checked by the schema (SC-VAL-04). */
export async function updateBranding(ctx: TenantContext, input: UpdateBrandingData): Promise<RestaurantSettingsDto> {
  // Uploaded images must be this tenant's own (SC-FILE-02); the ones replaced are released after the save (ADR-017 §5).
  await assertOwnedImageUrls(ctx, { logoUrl: input.logoUrl, coverImageUrl: input.coverImageUrl });
  const previous = await imageUrlsBeforeSave(ctx, { kind: "restaurant" });
  const restaurant = await updateRestaurantBranding(ctx, input);
  await releaseUnusedImages(ctx, previous);
  await revalidatePublicSite(ctx);
  revalidateConsoleShell(ctx);
  return restaurant;
}

/** SA-RST-03. */
export async function replaceHours(ctx: TenantContext, input: ReplaceOpeningHoursData): Promise<OpeningDayDto[]> {
  const hours = await replaceOpeningHours(ctx, input.days);
  await revalidatePublicSite(ctx);
  return hours;
}

/** SA-RST-04 — 409 CURRENCY_LOCKED once the tenant has an order (INV-09). */
export async function updateOperations(ctx: TenantContext, input: UpdateOperationalSettingsData): Promise<RestaurantSettingsDto> {
  return updateOperationalSettings(ctx, input);
}

/** SA-RST-05. */
export async function updateWebsite(ctx: TenantContext, input: UpdateWebsiteSettingsData): Promise<RestaurantSettingsDto> {
  const restaurant = await updateWebsiteSettings(ctx, input);
  await revalidatePublicSite(ctx);
  return restaurant;
}

/** 422 WEBSITE_NOT_READY (api.md SA-RST-06): lists every missing prerequisite. */
export class WebsiteNotReadyError extends ValidationError {
  override readonly code: string = "WEBSITE_NOT_READY";
  readonly missing: WebsiteReadinessItem[];
  constructor(missing: WebsiteReadinessItem[]) {
    super(`The website can't be published yet: ${missing.map((m) => m.message).join(" ")}`, { published: missing.map((m) => m.message) });
    this.missing = missing;
  }
}

/** SA-RST-06. */
export async function publishWebsite(ctx: TenantContext, published: boolean): Promise<RestaurantSettingsDto> {
  const result = await setWebsitePublished(ctx, published);
  if (result.outcome === "NOT_READY") throw new WebsiteNotReadyError(result.missing);
  if (result.outcome === "UPDATED") await revalidatePublicSite(ctx);
  return result.restaurant;
}
