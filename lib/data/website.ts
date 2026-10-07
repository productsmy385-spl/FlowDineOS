import "server-only";
import type { DailyStyle, MenuStyle, Prisma, WebsiteSectionKey, WebsiteSurfaceMode, WebsiteThemePreset } from "@prisma/client";
import type { TenantContext } from "@/lib/auth/context-types";
import { audit } from "@/lib/audit/write";
import { db } from "@/lib/db/prisma";
import { NotFoundError } from "@/lib/errors";
import { SLUG_PATTERN } from "@/lib/validation/core";
import { WEBSITE_SECTION_DEFAULTS, WEBSITE_SECTION_KEYS, type WebsiteSectionKeyName } from "@/lib/validation/website";
import { instantDto } from "./dto";
import { mapErrors } from "./errors";
import { required, tenantScope } from "./scope";
import { withTx, type Tx } from "./tx";

/**
 * Public-website theme, identity and section data (S1-P07-T010; data-model.md E02, E02a; ADR-013 §6).
 *
 * Every tenant read and write goes through `tenantScope`/`tenantId = ctx.tenantId`; the tenant never comes from input
 * (SC-TEN-01/02). A change and its audit row commit in one transaction (SC-AUD-01/02), and a save that changes
 * nothing writes nothing — including no audit row.
 *
 * `getPublicWebsite(slug)` is the only unauthenticated function here: it resolves an ACTIVE tenant with a published
 * website by slug and returns published, public columns only. An unknown slug, a suspended tenant and an unpublished
 * website all raise the same `NotFoundError`, so nothing can be enumerated (ADR-012 §7).
 */

// ─── Projections ───

const THEME_SELECT = {
  id: true,
  themePreset: true,
  themeSurfaceMode: true,
  themePrimaryHex: true,
  themeSecondaryHex: true,
  brandAccentHex: true,
  gradientFromHex: true,
  gradientToHex: true,
  brandColors: true,
  menuStyle: true,
  dailyStyle: true,
  tagline: true,
  heroImageUrl: true,
  faviconUrl: true,
  logoUrl: true,
  coverImageUrl: true,
  instagramUrl: true,
  facebookUrl: true,
  whatsappE164: true,
  mapsUrl: true,
  updatedAt: true,
} satisfies Prisma.RestaurantSelect;

type ThemeRow = Prisma.RestaurantGetPayload<{ select: typeof THEME_SELECT }>;
type ThemeColumn = Exclude<keyof ThemeRow, "id" | "updatedAt">;

/** The stored theme of a restaurant. `brandAccentHex` is the theme accent (ADR-013 §6, migration 0002). */
export type WebsiteThemeRow = {
  preset: WebsiteThemePreset;
  surfaceMode: WebsiteSurfaceMode;
  primaryHex: string | null;
  secondaryHex: string | null;
  accentHex: string | null;
  gradientFromHex: string | null;
  gradientToHex: string | null;
  /** The restaurant's own named colours, in its order (RASOIOS-ADR-021 §7). */
  brandColors: BrandColour[];
  menuStyle: MenuStyle;
  dailyStyle: DailyStyle;
};

export type BrandColour = { name: string; hex: string };

/** Only well-formed entries survive a read, whatever an old or hand-edited row holds. */
function brandColoursOf(value: Prisma.JsonValue): BrandColour[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const e = entry as { name?: unknown; hex?: unknown } | null;
    return e && typeof e.name === "string" && typeof e.hex === "string" && /^#[0-9A-Fa-f]{6}$/.test(e.hex) ? [{ name: e.name, hex: e.hex.toUpperCase() }] : [];
  });
}

export type WebsiteIdentityRow = {
  tagline: string | null;
  heroImageUrl: string | null;
  faviconUrl: string | null;
  logoUrl: string | null;
  coverImageUrl: string | null;
  instagramUrl: string | null;
  facebookUrl: string | null;
  whatsappE164: string | null;
  mapsUrl: string | null;
};

export type WebsiteSectionRow = {
  key: WebsiteSectionKey;
  enabled: boolean;
  sortOrder: number;
  headline: string | null;
  body: string | null;
  imageUrl: string | null;
  ctaLabel: string | null;
  ctaHref: string | null;
};

export type WebsiteConfigDto = {
  restaurantId: string;
  theme: WebsiteThemeRow;
  identity: WebsiteIdentityRow;
  sections: WebsiteSectionRow[];
  updatedAt: string;
};

const SECTION_SELECT = {
  key: true,
  enabled: true,
  sortOrder: true,
  headline: true,
  body: true,
  imageUrl: true,
  ctaLabel: true,
  ctaHref: true,
} satisfies Prisma.WebsiteSectionSelect;

function toTheme(row: ThemeRow): WebsiteThemeRow {
  return {
    preset: row.themePreset,
    surfaceMode: row.themeSurfaceMode,
    primaryHex: row.themePrimaryHex,
    secondaryHex: row.themeSecondaryHex,
    accentHex: row.brandAccentHex,
    gradientFromHex: row.gradientFromHex,
    gradientToHex: row.gradientToHex,
    brandColors: brandColoursOf(row.brandColors),
    menuStyle: row.menuStyle,
    dailyStyle: row.dailyStyle,
  };
}

function toIdentity(row: ThemeRow): WebsiteIdentityRow {
  return {
    tagline: row.tagline,
    heroImageUrl: row.heroImageUrl,
    faviconUrl: row.faviconUrl,
    logoUrl: row.logoUrl,
    coverImageUrl: row.coverImageUrl,
    instagramUrl: row.instagramUrl,
    facebookUrl: row.facebookUrl,
    whatsappE164: row.whatsappE164,
    mapsUrl: row.mapsUrl,
  };
}

async function loadThemeRow(client: Tx, ctx: TenantContext): Promise<ThemeRow> {
  return required(await client.restaurant.findUnique({ where: { tenantId: ctx.tenantId }, select: THEME_SELECT }), "Restaurant");
}

async function loadSections(client: Tx, ctx: TenantContext, restaurantId: string): Promise<WebsiteSectionRow[]> {
  return client.websiteSection.findMany({
    where: tenantScope(ctx, { restaurantId }),
    orderBy: [{ sortOrder: "asc" }, { key: "asc" }],
    select: SECTION_SELECT,
  });
}

// ─── Reads ───

/** LD-WEB-01 — the caller's own theme, identity and stored section rows. */
export async function getWebsiteConfig(ctx: TenantContext): Promise<WebsiteConfigDto> {
  return mapErrors("Restaurant", async () => {
    const row = await loadThemeRow(db, ctx);
    const sections = await loadSections(db, ctx, row.id);
    return { restaurantId: row.id, theme: toTheme(row), identity: toIdentity(row), sections, updatedAt: instantDto(row.updatedAt) };
  });
}

export type PublicWebsiteData = {
  slug: string;
  theme: WebsiteThemeRow;
  identity: WebsiteIdentityRow;
  sections: WebsiteSectionRow[];
  seoTitle: string | null;
  seoDescription: string | null;
};

const PUBLIC_NOT_FOUND = "Restaurant not found.";

/**
 * LD-PUB-01 theme and sections by public slug. No authentication, no tenant identifiers in the result, and the same
 * `NotFoundError` for an unknown slug, a SUSPENDED tenant and an unpublished website.
 */
export async function getPublicWebsite(slug: string, audience: "website" | "table" = "website"): Promise<PublicWebsiteData> {
  if (typeof slug !== "string" || !SLUG_PATTERN.test(slug)) throw new NotFoundError(PUBLIC_NOT_FOUND);

  const tenant = await mapErrors("Restaurant", () =>
    db.tenant.findFirst({
      // A table's QR menu (audience "table") is for guests already seated in the restaurant: it needs the Table QR
      // feature, not a published website (owner request 2026-10-07). The website itself still needs both.
      where: audience === "table" ? { slug, status: "ACTIVE", features: { none: { featureKey: "QR_MENU", enabled: false } } } : { slug, status: "ACTIVE", restaurant: { is: { websitePublished: true } }, features: { none: { featureKey: "WEBSITE", enabled: false } } },
      select: {
        slug: true,
        restaurant: {
          select: {
            ...THEME_SELECT,
            seoTitle: true,
            seoDescription: true,
            websitePublished: true,
            // Composite FK to (tenant_id, id): a restaurant can only ever reach its own tenant's sections.
            sections: { orderBy: [{ sortOrder: "asc" }, { key: "asc" }], select: SECTION_SELECT },
          },
        },
      },
    }),
  );

  const restaurant = tenant?.restaurant;
  if (!tenant || !restaurant || (audience === "website" && !restaurant.websitePublished)) throw new NotFoundError(PUBLIC_NOT_FOUND);

  return {
    slug: tenant.slug,
    theme: toTheme(restaurant),
    identity: toIdentity(restaurant),
    sections: restaurant.sections,
    seoTitle: restaurant.seoTitle,
    seoDescription: restaurant.seoDescription,
  };
}

// ─── Writes ───

type Patch = Partial<Record<ThemeColumn, string | boolean | null | BrandColour[]>>;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const pick = (row: ThemeRow, columns: ThemeColumn[]) => Object.fromEntries(columns.map((c) => [c, row[c]]));

/** Applies only the columns that differ and audits them with the before/after of exactly those columns. */
async function patchWebsite(ctx: TenantContext, patch: Patch, action: "restaurant.theme_updated" | "restaurant.website_updated"): Promise<WebsiteConfigDto> {
  return withTx(ctx, async (tx) => {
    const before = await loadThemeRow(tx, ctx);
    const changed = (Object.keys(patch) as ThemeColumn[]).filter((c) => patch[c] !== undefined && !same(patch[c], before[c]));
    if (changed.length === 0) {
      const sections = await loadSections(tx, ctx, before.id);
      return { restaurantId: before.id, theme: toTheme(before), identity: toIdentity(before), sections, updatedAt: instantDto(before.updatedAt) };
    }
    const data = Object.fromEntries(changed.map((c) => [c, patch[c]])) as Prisma.RestaurantUpdateInput;
    const after = await tx.restaurant.update({ where: { tenantId: ctx.tenantId }, data, select: THEME_SELECT });
    await audit(tx, ctx, { action, resourceType: "restaurant", resourceId: after.id, before: pick(before, changed), after: pick(after, changed) });
    const sections = await loadSections(tx, ctx, after.id);
    return { restaurantId: after.id, theme: toTheme(after), identity: toIdentity(after), sections, updatedAt: instantDto(after.updatedAt) };
  });
}

/** SA-WEB-01 — preset, surface mode and colours (`restaurant.theme_updated`). Colours are already contrast-checked. */
export function updateWebsiteTheme(
  ctx: TenantContext,
  theme: Omit<WebsiteThemeRow, "brandColors" | "menuStyle" | "dailyStyle"> & Partial<Pick<WebsiteThemeRow, "brandColors" | "menuStyle" | "dailyStyle">>,
): Promise<WebsiteConfigDto> {
  return patchWebsite(
    ctx,
    {
      themePreset: theme.preset,
      themeSurfaceMode: theme.surfaceMode,
      themePrimaryHex: theme.primaryHex,
      themeSecondaryHex: theme.secondaryHex,
      brandAccentHex: theme.accentHex,
      gradientFromHex: theme.gradientFromHex,
      gradientToHex: theme.gradientToHex,
      brandColors: theme.brandColors,
      menuStyle: theme.menuStyle,
      dailyStyle: theme.dailyStyle,
    },
    "restaurant.theme_updated",
  );
}

/** SA-WEB-02 — tagline, hero/favicon images and social links (`restaurant.website_updated`). */
export function updateWebsiteIdentity(ctx: TenantContext, patch: Partial<Omit<WebsiteIdentityRow, "logoUrl" | "coverImageUrl">>): Promise<WebsiteConfigDto> {
  return patchWebsite(ctx, { ...patch }, "restaurant.website_updated");
}

export type SectionSaveInput = {
  key: WebsiteSectionKeyName;
  enabled: boolean;
  sortOrder: number;
  headline: string | null;
  body: string | null;
  imageUrl: string | null;
  ctaLabel: string | null;
  ctaHref: string | null;
};

const sectionSummary = (rows: readonly WebsiteSectionRow[]) =>
  Object.fromEntries(rows.map((r) => [r.key, { enabled: r.enabled, sortOrder: r.sortOrder, headline: r.headline, hasBody: r.body !== null && r.body !== "" }]));

/**
 * SA-WEB-03 — replaces the configuration of the sections that were sent, leaving the others as they are (a missing
 * row keeps meaning "use the default"). One transaction, one `restaurant.website_updated` audit row with the whole
 * before/after layout. Nothing is written when the layout is unchanged.
 */
export async function saveWebsiteSections(ctx: TenantContext, sections: readonly SectionSaveInput[]): Promise<WebsiteConfigDto> {
  return withTx(ctx, async (tx) => {
    const restaurant = await loadThemeRow(tx, ctx);
    const before = await loadSections(tx, ctx, restaurant.id);

    for (const section of sections) {
      const values = {
        enabled: section.enabled,
        sortOrder: section.sortOrder,
        headline: section.headline,
        body: section.body,
        imageUrl: section.imageUrl,
        ctaLabel: section.ctaLabel,
        ctaHref: section.ctaHref,
      };
      // Update-then-create rather than `upsert`, so the tenant filter is the scoped `where` the static analyzer
      // checks (SC-TEN-03). A missing row is normal: it means "this section is still on its default" (E02a).
      const updated = await tx.websiteSection.updateMany({ where: tenantScope(ctx, { restaurantId: restaurant.id, key: section.key }), data: values });
      if (updated.count === 0) {
        await tx.websiteSection.create({ data: { tenantId: ctx.tenantId, restaurantId: restaurant.id, key: section.key, ...values } });
      }
    }

    const after = await loadSections(tx, ctx, restaurant.id);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      await audit(tx, ctx, {
        action: "restaurant.website_updated",
        resourceType: "restaurant",
        resourceId: restaurant.id,
        before: { sections: sectionSummary(before) },
        after: { sections: sectionSummary(after) },
      });
    }
    return { restaurantId: restaurant.id, theme: toTheme(restaurant), identity: toIdentity(restaurant), sections: after, updatedAt: instantDto(restaurant.updatedAt) };
  });
}

// ─── Provisioning (S1-P06-T009) ───

/** The rows a newly provisioned restaurant starts with, so its public site renders before anyone edits it. */
export function defaultSectionRows(tenantId: string, restaurantId: string): Prisma.WebsiteSectionCreateManyInput[] {
  return WEBSITE_SECTION_KEYS.map((key) => ({
    tenantId,
    restaurantId,
    key: key as WebsiteSectionKey,
    enabled: WEBSITE_SECTION_DEFAULTS[key].enabled,
    sortOrder: WEBSITE_SECTION_DEFAULTS[key].sortOrder,
  }));
}
