import "server-only";
import { revalidatePath } from "next/cache";
import type { TenantContext } from "@/lib/auth/context-types";
import { hasPermission } from "@/lib/auth/permissions";
import { tenantSlug } from "@/lib/data/restaurant";
import {
  getPublicWebsite,
  getWebsiteConfig,
  saveWebsiteSections,
  updateWebsiteIdentity,
  updateWebsiteTheme,
  type PublicWebsiteData,
  type WebsiteConfigDto,
  type WebsiteIdentityRow,
  type WebsiteSectionRow,
  type WebsiteThemeRow,
} from "@/lib/data/website";
import { ConflictError, ValidationError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { assertOwnedImageUrls, imageUrlsBeforeSave, releaseUnusedImages } from "@/lib/services/media";
import { getPublicRestaurantBySlug, type PublicRestaurantData } from "@/lib/services/public-restaurant";
import {
  ALWAYS_ENABLED_SECTION,
  MIN_THEME_CONTRAST,
  WEBSITE_SECTION_DEFAULTS,
  WEBSITE_SECTION_KEYS,
  type SaveWebsiteSectionsData,
  type UpdateWebsiteIdentityData,
  type UpdateWebsiteThemeData,
  type WebsiteSectionKeyName,
  type WebsiteSurfaceModeName,
  type WebsiteThemePresetName,
} from "@/lib/validation/website";

/**
 * Website theme and section services (S1-P07-T010; api.md SA-WEB-01…03; RASOIOS-ADR-013 §6).
 *
 * A restaurant owns its public site's colours and copy, and can never make it unreadable or inject markup:
 * - a preset resolves to a fixed, contrast-checked palette for the chosen surface mode; `CUSTOM` supplies its own
 *   three colours and is checked the same way;
 * - every colour must reach WCAG 4.5:1 against the surface it is drawn on, and must itself carry readable text
 *   (its black-or-white on-colour must also reach 4.5:1). Both gradient ends must share one readable on-colour;
 * - a failing colour is rejected with a field error naming the measured ratio, and **nothing is written**;
 * - section copy is stored and returned as plain text and rendered by React, never as markup (SC-VAL-03);
 * - HERO can never be disabled.
 *
 * Nothing here touches the console: the resolved theme is returned as CSS custom properties that the public page sets
 * on its own root element (ADR-013 §6).
 */

// ─── Palette ───

export type Palette = { primary: string; secondary: string; accent: string; gradientFrom: string; gradientTo: string };

/** The page background each surface mode is drawn on. LIGHT keeps the warm canvas branding already in use (E02). */
export const SURFACE_HEX: Readonly<Record<WebsiteSurfaceModeName, string>> = { DARK: "#0B0B0F", LIGHT: "#FBF9F5" };

/**
 * Fixed preset palettes, one per surface mode. A hue that is legible on near-black is not legible on warm white, so
 * each preset carries the contrast-checked step of its own scale for each mode (ADR-013 §1). PLATFORM is the brand
 * palette; the other three are the alternatives a restaurant can pick without choosing colours itself.
 * `tests/unit/website-theme.test.ts` re-measures every entry, so a palette can never drift below AA.
 */
export const THEME_PRESETS: Readonly<Record<Exclude<WebsiteThemePresetName, "CUSTOM">, Readonly<Record<WebsiteSurfaceModeName, Palette>>>> = {
  PLATFORM: {
    // ADR-018 hues. Measured on the website surfaces, not the console's: 11.13:1 and 11.47:1 on DARK #0B0B0F;
    // 4.93:1, 8.43:1 and 6.71:1 on LIGHT #FBF9F5.
    DARK: { primary: "#41E012", secondary: "#6E6BFF", accent: "#0CD9F5", gradientFrom: "#2015EB", gradientTo: "#7A1FA2" },
    LIGHT: { primary: "#2E7D0A", secondary: "#2015EB", accent: "#00626F", gradientFrom: "#2015EB", gradientTo: "#7A1FA2" },
  },
  CITRUS: {
    DARK: { primary: "#FFB020", secondary: "#FF7A45", accent: "#FFE066", gradientFrom: "#B34700", gradientTo: "#8A2B00" },
    LIGHT: { primary: "#A3520A", secondary: "#B03A00", accent: "#7A4A00", gradientFrom: "#B34700", gradientTo: "#8A2B00" },
  },
  OCEAN: {
    DARK: { primary: "#38BDF8", secondary: "#22D3EE", accent: "#A5B4FC", gradientFrom: "#0C4A6E", gradientTo: "#134E4A" },
    LIGHT: { primary: "#0369A1", secondary: "#0E7490", accent: "#4338CA", gradientFrom: "#0C4A6E", gradientTo: "#134E4A" },
  },
  BERRY: {
    DARK: { primary: "#F472B6", secondary: "#C084FC", accent: "#FDA4AF", gradientFrom: "#831843", gradientTo: "#4C1D95" },
    LIGHT: { primary: "#9D174D", secondary: "#7E22CE", accent: "#BE123C", gradientFrom: "#831843", gradientTo: "#4C1D95" },
  },
};

const HEX = /^#[0-9A-Fa-f]{6}$/;

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.x relative luminance of `#RRGGBB`. */
export function relativeLuminance(hex: string): number {
  if (!HEX.test(hex)) throw new RangeError("Invalid colour");
  const [r, g, b] = [1, 3, 5].map((i) => channel(parseInt(hex.slice(i, i + 2), 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio between two `#RRGGBB` colours (1–21). */
export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

const BLACK = "#0B0B0F";
const WHITE = "#FFFFFF";

/** Black or white — whichever is more readable on `hex`. */
export function onColourFor(hex: string): string {
  return contrastRatio(hex, WHITE) >= contrastRatio(hex, BLACK) ? WHITE : BLACK;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

// ─── Contrast enforcement ───

const COLOUR_FIELDS = [
  { field: "primaryHex", key: "primary", label: "primary colour" },
  { field: "secondaryHex", key: "secondary", label: "secondary colour" },
  { field: "accentHex", key: "accent", label: "accent colour" },
] as const;

/**
 * Field errors for every colour that is not legible on the chosen surface, with the ratio that was measured so the
 * restaurant can see how far off it is (api.md SA-WEB-01). An empty object means the palette is acceptable.
 */
export function themeContrastIssues(palette: Palette, surfaceMode: WebsiteSurfaceModeName): Record<string, string[]> {
  const surface = SURFACE_HEX[surfaceMode];
  const issues: Record<string, string[]> = {};
  const add = (field: string, message: string) => (issues[field] ??= []).push(message);

  for (const { field, key, label } of COLOUR_FIELDS) {
    const colour = palette[key];
    const onSurface = contrastRatio(colour, surface);
    if (onSurface < MIN_THEME_CONTRAST) {
      add(field, `This ${label} reaches only ${round2(onSurface)}:1 on the ${surfaceMode.toLowerCase()} website background; it needs at least ${MIN_THEME_CONTRAST}:1.`);
      continue;
    }
    const onColour = contrastRatio(colour, onColourFor(colour));
    if (onColour < MIN_THEME_CONTRAST) {
      add(field, `No readable text colour fits on this ${label} (best is ${round2(onColour)}:1, needs ${MIN_THEME_CONTRAST}:1).`);
    }
  }

  // A gradient is a background: text sits on both ends, so one on-colour has to work for both.
  const best = Math.max(
    Math.min(contrastRatio(palette.gradientFrom, WHITE), contrastRatio(palette.gradientTo, WHITE)),
    Math.min(contrastRatio(palette.gradientFrom, BLACK), contrastRatio(palette.gradientTo, BLACK)),
  );
  if (best < MIN_THEME_CONTRAST) {
    const message = `No readable text colour fits across this gradient (best is ${round2(best)}:1, needs ${MIN_THEME_CONTRAST}:1).`;
    add("gradientFromHex", message);
    add("gradientToHex", message);
  }
  return issues;
}

// ─── Resolution ───

/** The colour part of a stored theme — all `resolveTheme` needs. */
export type ThemePaletteRow = Pick<WebsiteThemeRow, "preset" | "surfaceMode" | "primaryHex" | "secondaryHex" | "accentHex" | "gradientFromHex" | "gradientToHex">;

export type ResolvedTheme = {
  preset: WebsiteThemePresetName;
  surfaceMode: WebsiteSurfaceModeName;
  primary: string;
  secondary: string;
  accent: string;
  gradientFrom: string;
  gradientTo: string;
  surface: string;
  onSurface: string;
  onPrimary: string;
  onSecondary: string;
  onAccent: string;
  onGradient: string;
};

/**
 * Stored theme → the palette the public page renders. A preset ignores any stored colours (the preset defines them);
 * `CUSTOM` uses the stored three and falls back to PLATFORM for anything a legacy row is missing.
 */
export function resolveTheme(theme: ThemePaletteRow): ResolvedTheme {
  const surfaceMode: WebsiteSurfaceModeName = theme.surfaceMode === "LIGHT" ? "LIGHT" : "DARK";
  const preset = theme.preset as WebsiteThemePresetName;
  const fallback = THEME_PRESETS.PLATFORM[surfaceMode];
  const base = preset === "CUSTOM" ? fallback : THEME_PRESETS[preset][surfaceMode];

  const palette: Palette =
    preset === "CUSTOM"
      ? {
          primary: theme.primaryHex ?? fallback.primary,
          secondary: theme.secondaryHex ?? fallback.secondary,
          accent: theme.accentHex ?? fallback.accent,
          gradientFrom: theme.gradientFromHex ?? theme.primaryHex ?? fallback.gradientFrom,
          gradientTo: theme.gradientToHex ?? theme.secondaryHex ?? fallback.gradientTo,
        }
      : { ...base, gradientFrom: theme.gradientFromHex ?? base.gradientFrom, gradientTo: theme.gradientToHex ?? base.gradientTo };

  const onGradient =
    Math.min(contrastRatio(palette.gradientFrom, WHITE), contrastRatio(palette.gradientTo, WHITE)) >=
    Math.min(contrastRatio(palette.gradientFrom, BLACK), contrastRatio(palette.gradientTo, BLACK))
      ? WHITE
      : BLACK;

  return {
    preset,
    surfaceMode,
    ...palette,
    surface: SURFACE_HEX[surfaceMode],
    onSurface: surfaceMode === "DARK" ? "#F5F5F7" : "#17150F",
    onPrimary: onColourFor(palette.primary),
    onSecondary: onColourFor(palette.secondary),
    onAccent: onColourFor(palette.accent),
    onGradient,
  };
}

/**
 * The CSS custom properties the public page sets on its own root element. Names are prefixed `--site-` so a tenant
 * theme can never reach a console token (ADR-013 §6). Values are `#RRGGBB` literals validated above.
 */
export function themeCssVariables(theme: ResolvedTheme): Record<string, string> {
  return {
    "--site-primary": theme.primary,
    "--site-on-primary": theme.onPrimary,
    "--site-secondary": theme.secondary,
    "--site-on-secondary": theme.onSecondary,
    "--site-accent": theme.accent,
    "--site-on-accent": theme.onAccent,
    "--site-gradient-from": theme.gradientFrom,
    "--site-gradient-to": theme.gradientTo,
    "--site-on-gradient": theme.onGradient,
    "--site-surface": theme.surface,
    "--site-on-surface": theme.onSurface,
  };
}

export type ResolvedSection = {
  key: WebsiteSectionKeyName;
  sortOrder: number;
  /** The restaurant's heading, or the section's default label — never invented body copy. */
  headline: string;
  customHeadline: boolean;
  body: string | null;
  imageUrl: string | null;
  ctaLabel: string | null;
  ctaHref: string | null;
};

/**
 * Stored rows merged over the defaults, in display order. A section with no row uses its default (E02a), HERO is
 * always enabled whatever the row says, and disabled sections are dropped.
 */
export function resolveSections(rows: readonly WebsiteSectionRow[]): ResolvedSection[] {
  const stored = new Map(rows.map((row) => [row.key as WebsiteSectionKeyName, row]));
  return WEBSITE_SECTION_KEYS.map((key) => {
    const defaults = WEBSITE_SECTION_DEFAULTS[key];
    const row = stored.get(key);
    const enabled = key === ALWAYS_ENABLED_SECTION ? true : (row?.enabled ?? defaults.enabled);
    const headline = row?.headline ?? null;
    return {
      enabled,
      key,
      sortOrder: row?.sortOrder ?? defaults.sortOrder,
      headline: headline ?? defaults.headline,
      customHeadline: headline !== null,
      body: row?.body ?? null,
      imageUrl: row?.imageUrl ?? null,
      ctaLabel: row?.ctaLabel ?? null,
      ctaHref: row?.ctaHref ?? null,
    };
  })
    .filter((section) => section.enabled)
    .sort((a, b) => a.sortOrder - b.sortOrder || WEBSITE_SECTION_KEYS.indexOf(a.key) - WEBSITE_SECTION_KEYS.indexOf(b.key))
    .map(({ enabled, ...section }) => {
      void enabled;
      return section;
    });
}

// ─── Console loader and actions ───

export type WebsiteSettingsView = {
  theme: WebsiteThemeRow;
  resolvedTheme: ResolvedTheme;
  cssVariables: Record<string, string>;
  identity: WebsiteIdentityRow;
  /** Every section with its stored or default configuration — the editor shows all eleven, enabled or not. */
  sections: Array<{ key: WebsiteSectionKeyName; enabled: boolean; sortOrder: number; headline: string | null; body: string | null; imageUrl: string | null; ctaLabel: string | null; ctaHref: string | null; defaultHeadline: string; alwaysEnabled: boolean; stored: boolean }>;
  presets: Array<{ name: WebsiteThemePresetName; palette: Palette | null }>;
  canEdit: boolean;
};

function editorSections(rows: readonly WebsiteSectionRow[]): WebsiteSettingsView["sections"] {
  const stored = new Map(rows.map((row) => [row.key as WebsiteSectionKeyName, row]));
  return WEBSITE_SECTION_KEYS.map((key) => {
    const defaults = WEBSITE_SECTION_DEFAULTS[key];
    const row = stored.get(key);
    return {
      key,
      enabled: key === ALWAYS_ENABLED_SECTION ? true : (row?.enabled ?? defaults.enabled),
      sortOrder: row?.sortOrder ?? defaults.sortOrder,
      headline: row?.headline ?? null,
      body: row?.body ?? null,
      imageUrl: row?.imageUrl ?? null,
      ctaLabel: row?.ctaLabel ?? null,
      ctaHref: row?.ctaHref ?? null,
      defaultHeadline: defaults.headline,
      alwaysEnabled: key === ALWAYS_ENABLED_SECTION,
      stored: row !== undefined,
    };
  }).sort((a, b) => a.sortOrder - b.sortOrder || WEBSITE_SECTION_KEYS.indexOf(a.key) - WEBSITE_SECTION_KEYS.indexOf(b.key));
}

function toView(ctx: TenantContext, config: WebsiteConfigDto): WebsiteSettingsView {
  const resolvedTheme = resolveTheme(config.theme);
  return {
    theme: config.theme,
    resolvedTheme,
    cssVariables: themeCssVariables(resolvedTheme),
    identity: config.identity,
    sections: editorSections(config.sections),
    presets: [
      { name: "PLATFORM", palette: THEME_PRESETS.PLATFORM[resolvedTheme.surfaceMode] },
      { name: "CITRUS", palette: THEME_PRESETS.CITRUS[resolvedTheme.surfaceMode] },
      { name: "OCEAN", palette: THEME_PRESETS.OCEAN[resolvedTheme.surfaceMode] },
      { name: "BERRY", palette: THEME_PRESETS.BERRY[resolvedTheme.surfaceMode] },
      { name: "CUSTOM", palette: null },
    ],
    canEdit: hasPermission(ctx, "website:update"),
  };
}

/** LD-WEB-01 — `restaurant:read`: everything the customisation screen and its live preview need. */
export async function getWebsiteSettings(ctx: TenantContext): Promise<WebsiteSettingsView> {
  return toView(ctx, await getWebsiteConfig(ctx));
}

/** Drops the public page from the ISR cache. A failure is logged, never reported as a failed save (it committed). */
async function revalidatePublicSite(ctx: TenantContext): Promise<void> {
  try {
    revalidatePath(`/r/${await tenantSlug(ctx)}`);
  } catch (error) {
    logger.warn("website.public_revalidate_failed", { requestId: ctx.requestId, tenantId: ctx.tenantId, error: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * SA-WEB-01 — preset or custom colours and the surface mode. The palette is resolved first, then contrast-checked;
 * a failure throws before any write, so a rejected theme leaves the stored one exactly as it was.
 */
export async function updateTheme(ctx: TenantContext, input: UpdateWebsiteThemeData): Promise<WebsiteSettingsView> {
  const custom = input.preset === "CUSTOM";
  const base = custom ? null : THEME_PRESETS[input.preset as Exclude<WebsiteThemePresetName, "CUSTOM">][input.surfaceMode];

  const palette: Palette = custom
    ? {
        primary: input.primaryHex!,
        secondary: input.secondaryHex!,
        accent: input.accentHex!,
        gradientFrom: input.gradientFromHex ?? input.primaryHex!,
        gradientTo: input.gradientToHex ?? input.secondaryHex!,
      }
    : { ...base!, gradientFrom: input.gradientFromHex ?? base!.gradientFrom, gradientTo: input.gradientToHex ?? base!.gradientTo };

  const issues = themeContrastIssues(palette, input.surfaceMode);
  if (Object.keys(issues).length > 0) throw new ValidationError("Choose colours that stay readable on the website background.", issues);

  // A preset owns its colours: the custom columns are cleared so the stored row can never disagree with the preset
  // (and the database CHECK that binds CUSTOM to its three colours keeps holding).
  const stored: ThemePaletteRow = custom
    ? {
        preset: input.preset,
        surfaceMode: input.surfaceMode,
        primaryHex: palette.primary,
        secondaryHex: palette.secondary,
        accentHex: palette.accent,
        gradientFromHex: input.gradientFromHex ?? null,
        gradientToHex: input.gradientToHex ?? null,
      }
    : {
        preset: input.preset,
        surfaceMode: input.surfaceMode,
        primaryHex: null,
        secondaryHex: null,
        accentHex: null,
        gradientFromHex: input.gradientFromHex ?? null,
        gradientToHex: input.gradientToHex ?? null,
      };

  // Named brand colours and the menu presentation travel with the theme; left out, they stay as they are.
  const config = await updateWebsiteTheme(ctx, { ...stored, brandColors: input.brandColors, menuStyle: input.menuStyle, dailyStyle: input.dailyStyle });
  await revalidatePublicSite(ctx);
  return toView(ctx, config);
}

/** SA-WEB-02 — tagline, hero and site icon, social and map links (`restaurant.website_updated`). */
export async function updateIdentity(ctx: TenantContext, input: UpdateWebsiteIdentityData): Promise<WebsiteSettingsView> {
  // Uploaded images must be this tenant's own (SC-FILE-02); the ones replaced are released after the save (ADR-017 §5).
  await assertOwnedImageUrls(ctx, { heroImageUrl: input.heroImageUrl, faviconUrl: input.faviconUrl });
  const previous = await imageUrlsBeforeSave(ctx, { kind: "restaurant" });
  const config = await updateWebsiteIdentity(ctx, input as Partial<WebsiteIdentityRow>);
  await releaseUnusedImages(ctx, previous);
  await revalidatePublicSite(ctx);
  return toView(ctx, config);
}

/** 409 HERO_REQUIRED (api.md SA-WEB-03): the hero is the page's heading and cannot be switched off. */
export class HeroRequiredError extends ConflictError {
  constructor() {
    super("The hero section is always shown — it carries the restaurant's name.", "HERO_REQUIRED");
  }
}

/** SA-WEB-03 — enable, reorder and edit sections. Copy is stored verbatim as text and escaped on render. */
export async function saveSections(ctx: TenantContext, input: SaveWebsiteSectionsData): Promise<WebsiteSettingsView> {
  const hero = input.sections.find((section) => section.key === ALWAYS_ENABLED_SECTION);
  if (hero !== undefined && hero.enabled !== true) throw new HeroRequiredError();
  await assertOwnedImageUrls(ctx, Object.fromEntries(input.sections.map((section, index) => [`sections.${index}.imageUrl`, section.imageUrl])));
  const previous = await imageUrlsBeforeSave(ctx, { kind: "sections" });

  const config = await saveWebsiteSections(
    ctx,
    input.sections.map((section) => ({
      key: section.key,
      enabled: section.enabled,
      sortOrder: section.sortOrder,
      headline: section.headline ?? null,
      body: section.body ?? null,
      imageUrl: section.imageUrl ?? null,
      ctaLabel: section.ctaLabel ?? null,
      ctaHref: section.ctaHref ?? null,
    })),
  );
  await releaseUnusedImages(ctx, previous);
  await revalidatePublicSite(ctx);
  return toView(ctx, config);
}

// ─── Public site (LD-PUB-01) ───

/** How the public menu is presented, and the restaurant's own named colours (RASOIOS-ADR-021 §6–7, ADR-022). */
export type SitePresentation = { brandColors: { name: string; hex: string }[]; menuStyle: "RING" | "GRID"; dailyStyle: "STRIP" | "GRID" };

export type PublicSiteData = PublicRestaurantData & {
  presentation: SitePresentation;
  theme: ResolvedTheme;
  cssVariables: Record<string, string>;
  identity: WebsiteIdentityRow;
  sections: ResolvedSection[];
  seoTitle: string | null;
  seoDescription: string | null;
};

/**
 * Everything the public website renders: the LD-PUB-01 menu projection plus the resolved theme, identity and section
 * list. Unknown slug, suspended tenant and unpublished website all raise the same `NotFoundError`.
 */
export async function getPublicSite(slug: string): Promise<PublicSiteData> {
  const [restaurant, website]: [PublicRestaurantData, PublicWebsiteData] = await Promise.all([getPublicRestaurantBySlug(slug), getPublicWebsite(slug)]);
  const theme = resolveTheme(website.theme);
  return {
    ...restaurant,
    presentation: { brandColors: website.theme.brandColors, menuStyle: website.theme.menuStyle, dailyStyle: website.theme.dailyStyle },
    theme,
    cssVariables: themeCssVariables(theme),
    identity: website.identity,
    sections: resolveSections(website.sections),
    seoTitle: website.seoTitle,
    seoDescription: website.seoDescription,
  };
}
