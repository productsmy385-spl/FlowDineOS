"use client";

import * as React from "react";
import { channels } from "@/components/public/theme";
import { contrastRatio } from "@/lib/ui/contrast";
import { MIN_THEME_CONTRAST, type WebsiteSurfaceModeName, type WebsiteThemePresetName } from "@/lib/validation/website";
import type { ResolvedTextColors } from "@/lib/services/website-theme";

/**
 * Live preview of the restaurant's public website (S1-P07-T011).
 *
 * It paints the *draft* palette and text colours — currently in the form — using the same CSS custom properties
 * the real page sets, so what is shown here is what the site will look like.
 */

export type PreviewPalette = {
  primary: string;
  secondary: string;
  accent: string;
  gradientFrom: string;
  gradientTo: string;
};

const BLACK = "#0B0B0F";
const WHITE = "#FFFFFF";

/** Black or white — whichever is more readable on `hex` (the same rule as `onColourFor` on the server). */
export function onColour(hex: string): string {
  return contrastRatio(hex, WHITE) >= contrastRatio(hex, BLACK) ? WHITE : BLACK;
}

export function onGradient(from: string, to: string): string {
  const white = Math.min(contrastRatio(from, WHITE), contrastRatio(to, WHITE));
  const black = Math.min(contrastRatio(from, BLACK), contrastRatio(to, BLACK));
  return white >= black ? WHITE : BLACK;
}

export type PreviewInput = {
  preset: WebsiteThemePresetName;
  surfaceMode: WebsiteSurfaceModeName;
  palette: PreviewPalette;
  surfaceHex: string;
  onSurfaceHex: string;
  restaurantName: string;
  headline: string;
  tagline: string | null;
  ctaLabel: string | null;
  sectionLabels: string[];
  textColors: ResolvedTextColors;
  logoUrl?: string | null;
};

/** Per-colour contrast against the chosen website background — preserved for backward compatibility and tests. */
export function contrastReadout(palette: PreviewPalette, surfaceHex: string): Array<{ label: string; ratio: number; ok: boolean }> {
  return (
    [
      ["Primary", palette.primary],
      ["Secondary", palette.secondary],
      ["Accent", palette.accent],
    ] as const
  ).map(([label, hex]) => {
    const ratio = contrastRatio(hex, surfaceHex);
    return { label, ratio, ok: ratio >= MIN_THEME_CONTRAST };
  });
}

export type ContrastCheck = {
  id: string;
  label: string;
  pair: string;
  foreground: string;
  background: string;
  ratio: number;
  required: number;
  ok: boolean;
  suggestion: string;
};

const round2 = (value: number) => Math.round(value * 100) / 100;

export function evaluateThemeContrast(
  palette: PreviewPalette,
  surfaceHex: string,
  textColors: ResolvedTextColors,
): { checks: ContrastCheck[]; failing: ContrastCheck[] } {
  const gradientEffective = (fg: string) =>
    round2(Math.min(contrastRatio(fg, palette.gradientFrom), contrastRatio(fg, palette.gradientTo)));

  const checks: ContrastCheck[] = [
    {
      id: "secondary",
      label: "Secondary colour",
      pair: "Secondary colour on website background",
      foreground: palette.secondary,
      background: surfaceHex,
      ratio: round2(contrastRatio(palette.secondary, surfaceHex)),
      required: MIN_THEME_CONTRAST,
      ok: contrastRatio(palette.secondary, surfaceHex) >= MIN_THEME_CONTRAST,
      suggestion: onColour(surfaceHex),
    },
    {
      id: "primary",
      label: "Primary colour",
      pair: "Primary colour on website background",
      foreground: palette.primary,
      background: surfaceHex,
      ratio: round2(contrastRatio(palette.primary, surfaceHex)),
      required: 3.0,
      ok: contrastRatio(palette.primary, surfaceHex) >= 3.0,
      suggestion: onColour(surfaceHex),
    },
    {
      id: "accent",
      label: "Accent colour",
      pair: "Accent colour on website background",
      foreground: palette.accent,
      background: surfaceHex,
      ratio: round2(contrastRatio(palette.accent, surfaceHex)),
      required: 3.0,
      ok: contrastRatio(palette.accent, surfaceHex) >= 3.0,
      suggestion: onColour(surfaceHex),
    },
    {
      id: "heading",
      label: "Main heading",
      pair: "Main heading on website background",
      foreground: textColors.headingColor,
      background: surfaceHex,
      ratio: round2(contrastRatio(textColors.headingColor, surfaceHex)),
      required: 3.0,
      ok: contrastRatio(textColors.headingColor, surfaceHex) >= 3.0,
      suggestion: onColour(surfaceHex),
    },
    {
      id: "sectionHeading",
      label: "Section headings",
      pair: "Section headings on website background",
      foreground: textColors.sectionHeadingColor,
      background: surfaceHex,
      ratio: round2(contrastRatio(textColors.sectionHeadingColor, surfaceHex)),
      required: 3.0,
      ok: contrastRatio(textColors.sectionHeadingColor, surfaceHex) >= 3.0,
      suggestion: onColour(surfaceHex),
    },
    {
      id: "bodyText",
      label: "Body text",
      pair: "Body text on website background",
      foreground: textColors.bodyTextColor,
      background: surfaceHex,
      ratio: round2(contrastRatio(textColors.bodyTextColor, surfaceHex)),
      required: MIN_THEME_CONTRAST,
      ok: contrastRatio(textColors.bodyTextColor, surfaceHex) >= MIN_THEME_CONTRAST,
      suggestion: onColour(surfaceHex),
    },
    {
      id: "mutedText",
      label: "Secondary/muted text",
      pair: "Secondary/muted text on website background",
      foreground: textColors.mutedTextColor,
      background: surfaceHex,
      ratio: round2(contrastRatio(textColors.mutedTextColor, surfaceHex)),
      required: MIN_THEME_CONTRAST,
      ok: contrastRatio(textColors.mutedTextColor, surfaceHex) >= MIN_THEME_CONTRAST,
      suggestion: onColour(surfaceHex),
    },
    {
      id: "navigationText",
      label: "Navigation text",
      pair: "Navigation text on header background",
      foreground: textColors.navigationTextColor,
      background: surfaceHex,
      ratio: round2(contrastRatio(textColors.navigationTextColor, surfaceHex)),
      required: MIN_THEME_CONTRAST,
      ok: contrastRatio(textColors.navigationTextColor, surfaceHex) >= MIN_THEME_CONTRAST,
      suggestion: onColour(surfaceHex),
    },
    {
      id: "link",
      label: "Link text",
      pair: "Link text on website background",
      foreground: textColors.linkColor,
      background: surfaceHex,
      ratio: round2(contrastRatio(textColors.linkColor, surfaceHex)),
      required: MIN_THEME_CONTRAST,
      ok: contrastRatio(textColors.linkColor, surfaceHex) >= MIN_THEME_CONTRAST,
      suggestion: onColour(surfaceHex),
    },
    {
      id: "buttonText",
      label: "Button text",
      pair: "Button text on primary button",
      foreground: textColors.buttonTextColor,
      background: palette.primary,
      ratio: round2(contrastRatio(textColors.buttonTextColor, palette.primary)),
      required: MIN_THEME_CONTRAST,
      ok: contrastRatio(textColors.buttonTextColor, palette.primary) >= MIN_THEME_CONTRAST,
      suggestion: onColour(palette.primary),
    },
    {
      id: "price",
      label: "Price text",
      pair: "Price text on website background",
      foreground: textColors.priceColor,
      background: surfaceHex,
      ratio: round2(contrastRatio(textColors.priceColor, surfaceHex)),
      required: MIN_THEME_CONTRAST,
      ok: contrastRatio(textColors.priceColor, surfaceHex) >= MIN_THEME_CONTRAST,
      suggestion: onColour(surfaceHex),
    },
    {
      id: "footerText",
      label: "Footer text",
      pair: "Footer text on website background",
      foreground: textColors.footerTextColor,
      background: surfaceHex,
      ratio: round2(contrastRatio(textColors.footerTextColor, surfaceHex)),
      required: MIN_THEME_CONTRAST,
      ok: contrastRatio(textColors.footerTextColor, surfaceHex) >= MIN_THEME_CONTRAST,
      suggestion: onColour(surfaceHex),
    },
    {
      id: "heroHeading",
      label: "Hero heading",
      pair: "Hero heading across hero gradient",
      foreground: textColors.heroHeadingColor,
      background: `${palette.gradientFrom} → ${palette.gradientTo}`,
      ratio: gradientEffective(textColors.heroHeadingColor),
      required: 3.0,
      ok: gradientEffective(textColors.heroHeadingColor) >= 3.0,
      suggestion: onGradient(palette.gradientFrom, palette.gradientTo),
    },
    {
      id: "heroDescription",
      label: "Hero description",
      pair: "Hero description across hero gradient",
      foreground: textColors.heroDescriptionColor,
      background: `${palette.gradientFrom} → ${palette.gradientTo}`,
      ratio: gradientEffective(textColors.heroDescriptionColor),
      required: MIN_THEME_CONTRAST,
      ok: gradientEffective(textColors.heroDescriptionColor) >= MIN_THEME_CONTRAST,
      suggestion: onGradient(palette.gradientFrom, palette.gradientTo),
    },
  ];

  return { checks, failing: checks.filter((c) => !c.ok) };
}

export function SitePreview({ input, dirty }: { input: PreviewInput; dirty: boolean }) {
  const { palette, surfaceHex, onSurfaceHex, textColors } = input;
  const legacyReadout = contrastReadout(palette, surfaceHex);
  const { failing } = evaluateThemeContrast(palette, surfaceHex, textColors);

  const containerStyle: React.CSSProperties = {
    backgroundColor: surfaceHex,
    color: textColors.bodyTextColor,
    "--surface": channels(surfaceHex),
    "--text": channels(onSurfaceHex),
    "--text-accent": channels(palette.primary),
    "--primary": channels(palette.primary),
    "--on-primary": channels(onColour(palette.primary)),
    "--secondary": channels(palette.secondary),
    "--accent": channels(palette.accent),
    "--website-heading-color": textColors.headingColor,
    "--website-section-heading-color": textColors.sectionHeadingColor,
    "--website-body-text-color": textColors.bodyTextColor,
    "--website-muted-text-color": textColors.mutedTextColor,
    "--website-navigation-text-color": textColors.navigationTextColor,
    "--website-link-color": textColors.linkColor,
    "--website-button-text-color": textColors.buttonTextColor,
    "--website-price-color": textColors.priceColor,
    "--website-footer-text-color": textColors.footerTextColor,
    "--website-hero-heading-color": textColors.heroHeadingColor,
    "--website-hero-description-color": textColors.heroDescriptionColor,
  } as React.CSSProperties;

  return (
    <aside aria-label="Website preview" className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-label text-fg-primary">Live website preview</h2>
        <span className="text-caption text-fg-secondary">{dirty ? "Unsaved changes" : "Matches the published site"}</span>
      </div>

      <div
        data-theme={input.surfaceMode === "LIGHT" ? "light" : "dark"}
        data-preview-preset={input.preset}
        style={containerStyle}
        className="overflow-hidden rounded-2xl border border-border-subtle shadow-e1"
      >
        {/* Public Header Bar */}
        <header
          className="flex items-center justify-between border-b border-border-subtle px-4 py-3"
          style={{ backgroundColor: surfaceHex }}
        >
          <div className="flex items-center gap-2">
            {input.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={input.logoUrl} alt="" className="h-7 w-7 object-contain" />
            ) : (
              <span
                className="flex h-7 w-7 items-center justify-center rounded-lg font-display text-caption font-bold"
                style={{ backgroundColor: palette.primary, color: textColors.buttonTextColor }}
              >
                {input.restaurantName.charAt(0) || "R"}
              </span>
            )}
            <span className="font-display text-subheading font-semibold" style={{ color: textColors.headingColor }}>
              {input.restaurantName}
            </span>
          </div>
          <nav className="flex items-center gap-3">
            <span className="text-caption font-medium" style={{ color: textColors.navigationTextColor }}>
              Menu
            </span>
            <span className="text-caption font-medium" style={{ color: textColors.navigationTextColor }}>
              About
            </span>
            <span className="text-caption font-medium" style={{ color: textColors.navigationTextColor }}>
              Contact
            </span>
          </nav>
        </header>

        {/* Hero Section with Gradient */}
        <div
          className="flex flex-col gap-2 p-5"
          style={{
            backgroundImage: `linear-gradient(135deg, ${palette.gradientFrom} 0%, ${palette.gradientTo} 100%)`,
          }}
        >
          <p className="text-caption opacity-80" style={{ color: textColors.heroDescriptionColor }}>
            {input.restaurantName}
          </p>
          <h1 className="font-display text-display-m font-bold" style={{ color: textColors.heroHeadingColor }}>
            {input.headline}
          </h1>
          {input.tagline ? (
            <p className="text-body opacity-95" style={{ color: textColors.heroDescriptionColor }}>
              {input.tagline}
            </p>
          ) : null}
          {input.ctaLabel ? (
            <span
              className="mt-2 inline-flex h-10 w-fit items-center rounded-xl px-4 text-label font-semibold shadow-e1"
              style={{ backgroundColor: palette.primary, color: textColors.buttonTextColor }}
            >
              {input.ctaLabel}
            </span>
          ) : null}
        </div>

        {/* Content Section */}
        <div className="flex flex-col gap-4 p-5">
          <div className="flex flex-col gap-1">
            <h2 className="font-display text-subheading font-bold" style={{ color: textColors.sectionHeadingColor }}>
              Section headings
            </h2>
            <p className="text-caption" style={{ color: textColors.mutedTextColor }}>
              Secondary and muted descriptions under headings
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            {input.sectionLabels.slice(0, 4).map((label) => (
              <span
                key={label}
                className="inline-flex h-6 items-center rounded-full px-2.5 text-caption font-medium"
                style={{ backgroundColor: `${palette.secondary}22`, color: textColors.bodyTextColor, border: `1px solid ${palette.secondary}44` }}
              >
                {label}
              </span>
            ))}
          </div>

          {/* Sample Dish Card */}
          <div
            className="flex flex-col gap-2 rounded-xl border border-border-subtle p-3"
            style={{ backgroundColor: `${surfaceHex}ee` }}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: palette.accent }} />
                <h3 className="font-display text-label font-semibold" style={{ color: textColors.headingColor }}>
                  Signature Dish
                </h3>
                <span
                  className="rounded px-1.5 py-0.5 text-caption font-medium"
                  style={{ backgroundColor: palette.secondary, color: onColour(palette.secondary) }}
                >
                  Featured
                </span>
              </div>
              <span className="font-numeric text-label font-bold" style={{ color: textColors.priceColor }}>
                $18.50
              </span>
            </div>
            <p className="text-body" style={{ color: textColors.bodyTextColor }}>
              Crispy seasoned seasonal selection prepared fresh with our chef&apos;s signature sauce.
            </p>
            <p className="text-caption" style={{ color: textColors.mutedTextColor }}>
              Served with roasted garlic greens and herb dressing.
            </p>
          </div>

          <div className="flex items-center justify-between pt-1">
            <p className="text-body font-medium" style={{ color: textColors.linkColor }}>
              Explore full menu &rarr;
            </p>
            <span
              className="inline-flex h-8 items-center rounded-lg px-3 text-caption font-semibold"
              style={{ backgroundColor: palette.primary, color: textColors.buttonTextColor }}
            >
              Order online
            </span>
          </div>
        </div>

        {/* Footer */}
        <footer
          className="border-t border-border-subtle px-5 py-3 text-caption"
          style={{ backgroundColor: surfaceHex, color: textColors.footerTextColor }}
        >
          <div className="flex items-center justify-between">
            <span>&copy; {input.restaurantName} · All rights reserved</span>
            <span style={{ color: textColors.linkColor }}>Privacy &amp; Terms</span>
          </div>
        </footer>
      </div>

      {/* Accessibility & Contrast Readout */}
      <div className="flex flex-col gap-3 rounded-xl border border-border-subtle bg-card p-4">
        <div className="flex items-center justify-between">
          <h3 className="text-label text-fg-primary">Accessibility &amp; contrast validation</h3>
          {failing.length > 0 ? (
            <span className="inline-flex items-center rounded-full bg-status-warning/15 px-2.5 py-0.5 text-caption font-semibold text-status-warning">
              {failing.length} warning{failing.length > 1 ? "s" : ""}
            </span>
          ) : (
            <span className="inline-flex items-center rounded-full bg-status-success/15 px-2.5 py-0.5 text-caption font-semibold text-status-success">
              All contrast checks pass
            </span>
          )}
        </div>

        {/* Existing Secondary Colour warning notice if secondary fails */}
        {failing.some((f) => f.id === "secondary") && (
          <div className="rounded-lg border border-status-warning/30 bg-status-warning/10 p-3 text-caption text-fg-primary">
            <p className="font-semibold text-status-warning">Secondary colour contrast warning</p>
            <p className="mt-1 text-fg-secondary">
              Secondary colour ({palette.secondary}) reaches{" "}
              {round2(contrastRatio(palette.secondary, surfaceHex))}:1 on the website background (WCAG AA target:{" "}
              {MIN_THEME_CONTRAST}:1).
            </p>
            <p className="mt-1 text-fg-secondary">
              Suggested accessible alternative: <span className="font-mono font-bold text-fg-primary">{onColour(surfaceHex)}</span>
            </p>
          </div>
        )}

        {/* Other failing checks breakdown */}
        {failing
          .filter((f) => f.id !== "secondary")
          .map((fail) => (
            <div key={fail.id} className="rounded-lg border border-status-warning/30 bg-status-warning/10 p-3 text-caption text-fg-primary">
              <p className="font-semibold text-status-warning">
                {fail.label} contrast warning
              </p>
              <p className="mt-1 text-fg-secondary">
                {fail.pair}: measured ratio is{" "}
                <span className="font-bold text-status-danger">{fail.ratio}:1</span> (needs at least {fail.required}:1).
              </p>
              <p className="mt-1 text-fg-secondary">
                Suggested accessible colour: <span className="font-mono font-bold text-fg-primary">{fail.suggestion}</span>
              </p>
            </div>
          ))}

        {/* Summary Table of all 3 base palette colours (legacy readout) */}
        <dl className="flex flex-col gap-1 border-t border-border-subtle pt-2">
          {legacyReadout.map((row) => (
            <div key={row.label} className="flex items-center justify-between gap-3 text-caption">
              <dt className="text-fg-secondary">{row.label} on the website background</dt>
              <dd className={row.ok ? "tabular-nums text-status-success" : "tabular-nums text-status-warning"}>
                {row.ratio.toFixed(2)}:1 {row.ok ? "passes" : `warning (${MIN_THEME_CONTRAST}:1 target)`}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </aside>
  );
}
