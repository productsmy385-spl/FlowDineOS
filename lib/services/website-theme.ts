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

export {
  relativeLuminance,
  contrastRatio,
  onColourFor,
  sampleGradientHex,
  suggestedAccessibleColour,
} from "@/lib/ui/contrast";

import {
  contrastRatio,
  onColourFor,
  sampleGradientHex,
} from "@/lib/ui/contrast";

const round2 = (value: number) => Math.round(value * 100) / 100;

const BLACK = "#0B0B0F";
const WHITE = "#FFFFFF";

// ─── Contrast enforcement ───

const COLOUR_FIELDS = [
  { field: "primaryHex", key: "primary", label: "primary colour", minContrast: MIN_THEME_CONTRAST },
  { field: "secondaryHex", key: "secondary", label: "secondary colour", minContrast: 3.0 },
  { field: "accentHex", key: "accent", label: "accent colour", minContrast: 3.0 },
] as const;

/**
 * Field errors for every colour that is not legible on the chosen surface, with the ratio that was measured so the
 * restaurant can see how far off it is (api.md SA-WEB-01). An empty object means the palette is acceptable.
 */
export function themeContrastIssues(palette: Palette, surfaceMode: WebsiteSurfaceModeName): Record<string, string[]> {
  const surface = SURFACE_HEX[surfaceMode];
  const issues: Record<string, string[]> = {};
  const add = (field: string, message: string) => (issues[field] ??= []).push(message);

  for (const { field, key, label, minContrast } of COLOUR_FIELDS) {
    const colour = palette[key];
    const onSurface = contrastRatio(colour, surface);
    if (onSurface < minContrast) {
      add(
        field,
        `This ${label} (${colour}) reaches only ${round2(onSurface)}:1 on the ${surfaceMode.toLowerCase()} website background (${surface}); it needs at least ${minContrast}:1. Field to adjust: ${label}.`,
      );
      continue;
    }
    const onColour = contrastRatio(colour, onColourFor(colour));
    if (onColour < minContrast) {
      add(field, `No readable text colour fits on this ${label} (best is ${round2(onColour)}:1, needs ${minContrast}:1). Field to adjust: ${label}.`);
    }
  }

  // Validate readable text across the rendered gradient's text region (0% to 60% of the linear gradient).
  // Hero headings are WCAG Large Text (32–40px bold) needing >= 3.0:1 contrast.
  const samplePoints = [0, 0.25, 0.5];
  const samples = samplePoints.map((t) => sampleGradientHex(palette.gradientFrom, palette.gradientTo, t));
  const whiteContrast = Math.min(...samples.map((s) => contrastRatio(s, WHITE)));
  const blackContrast = Math.min(...samples.map((s) => contrastRatio(s, BLACK)));
  const bestGradientContrast = Math.max(whiteContrast, blackContrast);

  if (bestGradientContrast < 3.0) {
    const message = `No readable text colour fits across this gradient (best is ${round2(bestGradientContrast)}:1 across the text range, needs at least 3.0:1 for headings). Field to adjust: Gradient start or end colour.`;
    add("gradientFromHex", message);
    add("gradientToHex", message);
  }
  return issues;
}

// ─── Resolution ───

export type ResolvedTextColors = {
  headingColor: string;
  sectionHeadingColor: string;
  bodyTextColor: string;
  mutedTextColor: string;
  navigationTextColor: string;
  linkColor: string;
  buttonTextColor: string;
  priceColor: string;
  footerTextColor: string;
  heroHeadingColor: string;
  heroDescriptionColor: string;
};

/** Stored theme row fields needed to resolve the palette and text colours. */
export type ThemePaletteRow = Pick<
  WebsiteThemeRow,
  "preset" | "surfaceMode" | "primaryHex" | "secondaryHex" | "accentHex" | "gradientFromHex" | "gradientToHex"
> & {
  textColors?: WebsiteThemeRow["textColors"];
};

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
  textColors: ResolvedTextColors;
};

/** Sensible theme-derived text defaults for a given background surface mode and palette. */
export function defaultTextColors(
  surfaceMode: WebsiteSurfaceModeName,
  palette: Palette,
  onGradient: string,
  preset?: WebsiteThemePresetName,
): ResolvedTextColors {
  const isDark = surfaceMode === "DARK";
  // Preserve PLATFORM Signature botanical branding defaults
  if (preset === "PLATFORM" || (!preset && palette.primary === THEME_PRESETS.PLATFORM[surfaceMode].primary)) {
    return {
      headingColor: isDark ? "#F5F5F7" : "#17211B",
      sectionHeadingColor: isDark ? "#DEE8E3" : "#24352B",
      bodyTextColor: isDark ? "#DEE8E3" : "#405044",
      mutedTextColor: isDark ? "#93A69D" : "#667366",
      navigationTextColor: isDark ? "#DEE8E3" : "#24352B",
      linkColor: palette.primary,
      buttonTextColor: onColourFor(palette.primary),
      priceColor: palette.primary,
      footerTextColor: isDark ? "#93A69D" : "#405044",
      heroHeadingColor: onGradient,
      heroDescriptionColor: onGradient,
    };
  }

  // Modern, high-contrast, neutral accessible tones for CITRUS, OCEAN, BERRY, and CUSTOM palettes
  return {
    headingColor: isDark ? "#F9FAFB" : "#111827",
    sectionHeadingColor: isDark ? "#F3F4F6" : "#1F2937",
    bodyTextColor: isDark ? "#E5E7EB" : "#374151",
    mutedTextColor: isDark ? "#9CA3AF" : "#6B7280",
    navigationTextColor: isDark ? "#F3F4F6" : "#1F2937",
    linkColor: palette.primary,
    buttonTextColor: onColourFor(palette.primary),
    priceColor: palette.primary,
    footerTextColor: isDark ? "#9CA3AF" : "#4B5563",
    heroHeadingColor: onGradient,
    heroDescriptionColor: onGradient,
  };
}

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

  // Calculate best onGradient across the text region of the gradient
  const midPoint = sampleGradientHex(palette.gradientFrom, palette.gradientTo, 0.3);
  const onGradient =
    Math.min(contrastRatio(palette.gradientFrom, WHITE), contrastRatio(midPoint, WHITE)) >=
    Math.min(contrastRatio(palette.gradientFrom, BLACK), contrastRatio(midPoint, BLACK))
      ? WHITE
      : BLACK;

  const defaultTexts = defaultTextColors(surfaceMode, palette, onGradient, preset);
  const textColors: ResolvedTextColors = {
    headingColor: theme.textColors?.headingColor ?? defaultTexts.headingColor,
    sectionHeadingColor: theme.textColors?.sectionHeadingColor ?? defaultTexts.sectionHeadingColor,
    bodyTextColor: theme.textColors?.bodyTextColor ?? defaultTexts.bodyTextColor,
    mutedTextColor: theme.textColors?.mutedTextColor ?? defaultTexts.mutedTextColor,
    navigationTextColor: theme.textColors?.navigationTextColor ?? defaultTexts.navigationTextColor,
    linkColor: theme.textColors?.linkColor ?? defaultTexts.linkColor,
    buttonTextColor: theme.textColors?.buttonTextColor ?? defaultTexts.buttonTextColor,
    priceColor: theme.textColors?.priceColor ?? defaultTexts.priceColor,
    footerTextColor: theme.textColors?.footerTextColor ?? defaultTexts.footerTextColor,
    heroHeadingColor: theme.textColors?.heroHeadingColor ?? defaultTexts.heroHeadingColor,
    heroDescriptionColor: theme.textColors?.heroDescriptionColor ?? defaultTexts.heroDescriptionColor,
  };

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
    textColors,
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
    "--website-heading-color": theme.textColors.headingColor,
    "--website-section-heading-color": theme.textColors.sectionHeadingColor,
    "--website-body-text-color": theme.textColors.bodyTextColor,
    "--website-muted-text-color": theme.textColors.mutedTextColor,
    "--website-navigation-text-color": theme.textColors.navigationTextColor,
    "--website-link-color": theme.textColors.linkColor,
    "--website-button-text-color": theme.textColors.buttonTextColor,
    "--website-price-color": theme.textColors.priceColor,
    "--website-footer-text-color": theme.textColors.footerTextColor,
    "--website-hero-heading-color": theme.textColors.heroHeadingColor,
    "--website-hero-description-color": theme.textColors.heroDescriptionColor,
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
  contrastIssues: Record<string, string[]>;
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
  const palette: Palette = {
    primary: resolvedTheme.primary,
    secondary: resolvedTheme.secondary,
    accent: resolvedTheme.accent,
    gradientFrom: resolvedTheme.gradientFrom,
    gradientTo: resolvedTheme.gradientTo,
  };
  const contrastIssues = themeContrastIssues(palette, resolvedTheme.surfaceMode);
  return {
    theme: config.theme,
    resolvedTheme,
    contrastIssues,
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
 * SA-WEB-01 — preset or custom colours and the surface mode.
 * Contrast warnings are computed and reported to the view, but valid colours are not rejected.
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
        textColors: input.textColors,
      }
    : {
        preset: input.preset,
        surfaceMode: input.surfaceMode,
        primaryHex: null,
        secondaryHex: null,
        accentHex: null,
        gradientFromHex: input.gradientFromHex ?? null,
        gradientToHex: input.gradientToHex ?? null,
        textColors: input.textColors,
      };

  // Named brand colours and the menu presentation travel with the theme; left out, they stay as they are.
  const config = await updateWebsiteTheme(ctx, {
    ...stored,
    brandColors: input.brandColors,
    textColors: input.textColors,
    menuStyle: input.menuStyle,
    dailyStyle: input.dailyStyle,
  });
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
export async function getPublicSite(slug: string, audience: "website" | "table" = "website"): Promise<PublicSiteData> {
  const [restaurant, website]: [PublicRestaurantData, PublicWebsiteData] = await Promise.all([getPublicRestaurantBySlug(slug, audience), getPublicWebsite(slug, audience)]);
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
