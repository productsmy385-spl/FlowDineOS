import type { CSSProperties } from "react";

/**
 * Applying a tenant theme to its own public page (S1-P09-T012; RASOIOS-ADR-013 §6).
 *
 * `lib/services/website-theme.ts` resolves and contrast-checks the palette and hands back `cssVariables` — the
 * documented `--site-*` contract. This module turns that resolved theme into the inline style of the *page root
 * element only*, and does two things there:
 *
 * 1. sets the `--site-*` variables verbatim, so anything that wants the raw tenant colours can read them;
 * 2. re-points the semantic tokens the design system already paints with (`--primary`, `--surface`, …) to the same
 *    colours, expressed as `R G B` channels because `tailwind.config.ts` writes them as `rgb(var(--token) / alpha)`.
 *
 * Because both live in a `style` attribute on one element, the whole effect is scoped to that subtree: the console
 * shares the stylesheet but never renders inside it, and no tenant value can reach another tenant's page or the
 * platform brand. The surface mode is applied as `data-theme`, which `app/globals.css` already defines, so a
 * restaurant that chose a light website gets light surfaces, borders and muted text instead of inheriting the
 * dark console theme.
 */

/** The shape of a resolved theme — structurally the `ResolvedTheme` of `lib/services/website-theme.ts`. */
export type SiteTheme = {
  surfaceMode: "DARK" | "LIGHT";
  primary: string;
  onPrimary: string;
  secondary: string;
  onSecondary: string;
  accent: string;
  onAccent: string;
  gradientFrom: string;
  gradientTo: string;
  onGradient: string;
  surface: string;
  onSurface: string;
};

const HEX = /^#[0-9A-Fa-f]{6}$/;

/** `#RRGGBB` → `"R G B"`, the channel form every semantic token is written in. */
export function channels(hex: string): string {
  if (!HEX.test(hex)) throw new RangeError(`Expected #RRGGBB, got ${JSON.stringify(hex)}`);
  return [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)).join(" ");
}

/** `data-theme` value for a surface mode — the light/dark token sets already defined in `app/globals.css`. */
export function surfaceThemeAttribute(theme: Pick<SiteTheme, "surfaceMode">): "light" | "dark" {
  return theme.surfaceMode === "LIGHT" ? "light" : "dark";
}

/**
 * The inline style of the public page root. `cssVariables` comes from `getPublicSite`, unmodified; the channel
 * overrides below are derived from the same already-contrast-checked colours, never from anything new.
 *
 * Hover steps deliberately stay on the base colour: a derived hover shade would not have been contrast-checked, so
 * public controls signal hover with elevation and a glow built from `--primary` instead of a second colour.
 */
export function siteThemeStyle(theme: SiteTheme, cssVariables: Readonly<Record<string, string>>): CSSProperties {
  return {
    ...cssVariables,
    "--surface": channels(theme.surface),
    "--surface-2": theme.surfaceMode === "LIGHT" ? "255 255 255" : "24 24 27",
    "--surface-3": theme.surfaceMode === "LIGHT" ? "243 244 246" : "39 39 42",
    "--border": theme.surfaceMode === "LIGHT" ? "229 231 235" : "39 39 42",
    "--border-strong": theme.surfaceMode === "LIGHT" ? "209 213 219" : "63 63 70",
    "--text": channels(theme.onSurface),
    "--text-muted": theme.surfaceMode === "LIGHT" ? "107 114 128" : "156 163 175",
    "--text-accent": channels(theme.accent),
    "--primary": channels(theme.primary),
    "--on-primary": channels(theme.onPrimary),
    "--primary-hover": channels(theme.primary),
    "--secondary": channels(theme.secondary),
    "--on-secondary": channels(theme.onSecondary),
    "--secondary-hover": channels(theme.secondary),
    "--accent": channels(theme.accent),
    "--on-accent": channels(theme.onAccent),
    "--accent-hover": channels(theme.accent),
    "--focus-ring": channels(theme.accent),
  } as CSSProperties;
}

/** The hero/CTA gradient wash, built from the two contrast-checked gradient ends with one readable text colour. */
export function siteGradientStyle(theme: Pick<SiteTheme, "gradientFrom" | "gradientTo" | "onGradient">): CSSProperties {
  return {
    backgroundImage: `linear-gradient(135deg, ${theme.gradientFrom} 0%, ${theme.gradientTo} 100%)`,
    color: theme.onGradient,
  };
}
