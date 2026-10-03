/**
 * Brand v2 design tokens (RASOIOS-ADR-013, design.md §2/§4/§10). The only source of colour, radius, elevation and
 * motion values; `tailwind.config.ts` and `app/globals.css` are generated from these by hand and TC-DS-001 checks
 * they agree.
 *
 * The four owner-supplied hues in `BRAND_HUES` are the *inputs* to the ramps below — they are never painted, because
 * at full strength they fail text contrast (white on `#4FE012` is 1.75:1). What the UI paints is the contrast-checked
 * step of each scale (design.md §2.1–§2.3).
 */

/**
 * Owner-supplied brand hues (ADR-018, 2026-09-25; supersedes the ADR-013 §1 set). Reference values: not painted.
 *
 * Each scale below was re-derived from these by keeping every step's WCAG relative luminance and changing only the
 * hue, so the contrast pairs TC-THEME-001 checks hold by construction rather than by re-tuning. `secondary` came back
 * byte-identical and `tertiary` moved by one 8-bit step; the visible change is `accent`, which moves from an
 * aqua-green to a true cyan — and with it `success`, which resolves to the accent scale.
 */
export const BRAND_HUES = { primary: "#41E012", secondary: "#2015EB", tertiary: "#EF0E23", accent: "#0CD9F5" } as const;

/** design.md §2.1 tonal scales — the only colours in the platform theme. */
export const palette = {
  /** Primary green: primary actions, active navigation, success-leaning accents. */
  primary: { 50: "#E2FFDC", 100: "#BFFBB3", 200: "#91EB81", 300: "#5FD648", 400: "#38BD15", 500: "#2FA010", 600: "#248508", 700: "#1B6707", 800: "#124A04", 900: "#072D01" },
  /** Secondary blue: secondary actions, informational accents, links. */
  secondary: { 50: "#F1F5FF", 100: "#DEE8FE", 200: "#BDD0FF", 300: "#98B5FF", 400: "#7498FF", 500: "#5179FF", 600: "#3253FF", 700: "#2237D6", 800: "#1624A1", 900: "#090F6B" },
  /** Tertiary red: destructive actions, errors, urgent kitchen states. Also exposed as `danger`. */
  tertiary: { 50: "#FEF2F0", 100: "#FFDFDB", 200: "#FFBFB7", 300: "#FF968C", 400: "#FE655C", 500: "#F80F25", 600: "#D0051B", 700: "#A30112", 800: "#78010B", 900: "#4B0004" },
  /** Neutral accent cyan: highlights, live indicators, success, data emphasis. */
  accent: { 50: "#E5FBFF", 100: "#C0F4FF", 200: "#66E7FE", 300: "#00CFEA", 400: "#00B3CB", 500: "#0099AE", 600: "#007E8F", 700: "#00626F", 800: "#004751", 900: "#002A31" },
  /** Near-black, desaturated surface ramp so the saturated hues read as accents. */
  surface: {
    50: "#F1F6F4",
    100: "#DEE8E3",
    200: "#BFCEC7",
    300: "#93A69D",
    400: "#6B8077",
    500: "#4A5F57",
    600: "#33453E",
    700: "#25352F",
    750: "#1D2A26",
    800: "#16211E",
    850: "#111917",
    900: "#0B1110",
    950: "#070B0A",
  },
  /**
   * Botanical neutrals for the light theme (RASOIOS-ADR-020, from the Stitch "Culinary Operations System"): a
   * low-chroma green-tinted canvas so white operational cards and frosted bars read as layers above it, with ink text
   * and an olive secondary text tone. The dark theme keeps the near-black `surface` ramp.
   */
  botanical: {
    50: "#F4FCEE",
    100: "#EEF6E9",
    200: "#E3EBDE",
    300: "#BDCBB4",
    500: "#6E7B67",
    700: "#3E4A39",
    900: "#161D16",
  },
  /**
   * Warning gold. design.md §2.2 names `--warning` explicitly outside the four ramps because none of them carries a
   * "caution" reading: `#F5B301` measures 10.28:1 on the canvas and `#8A5A00` 5.43:1 on the light surface.
   */
  warning: { 500: "#F5B301", 700: "#8A5A00" },
} as const;

export type PaletteScale = keyof typeof palette;

/** design.md §4.4 — the only radii. */
export const radius = { none: "0px", md: "6px", xl: "12px", "2xl": "16px", "3xl": "24px", full: "9999px" } as const;

/** design.md §10 */
export const motion = {
  duration: { fast: "120ms", base: "180ms", slow: "240ms", exit: "120ms" },
  easing: { standard: "cubic-bezier(0.2, 0, 0, 1)", exit: "cubic-bezier(0.4, 0, 1, 1)" },
} as const;

/**
 * design.md §4.6 — the three glass levels. Opacity behind text is never below 0.72, blur never above 18 px, and every
 * level ships an opaque fallback. TC-DS-016 asserts `app/globals.css` implements exactly these numbers.
 */
export const glass = {
  1: { surface: "--surface", opacity: 0.72, blur: 14 },
  2: { surface: "--surface-2", opacity: 0.78, blur: 12 },
  3: { surface: "--surface-2", opacity: 0.86, blur: 18 },
} as const;

/**
 * design.md §2.2 — semantic tokens resolved for each surface mode. `app/globals.css` writes exactly these values as
 * RGB channels; TC-DS-009 re-checks every contrast pair of design.md §2.3 against this table.
 */
export const semanticTokens = {
  dark: {
    surface: palette.surface[900],
    "surface-2": palette.surface[850],
    "surface-3": palette.surface[800],
    "surface-950": palette.surface[950],
    border: palette.surface[700],
    "border-strong": palette.surface[600],
    text: palette.surface[100],
    "text-muted": palette.surface[300],
    "text-accent": palette.primary[300],
    primary: palette.primary[400],
    "on-primary": palette.surface[950],
    "primary-hover": palette.primary[300],
    secondary: palette.secondary[500],
    "on-secondary": palette.surface[950],
    "secondary-hover": palette.secondary[400],
    danger: palette.tertiary[500],
    "on-danger": palette.surface[950],
    "danger-hover": palette.tertiary[400],
    accent: palette.accent[400],
    "on-accent": palette.surface[950],
    "accent-hover": palette.accent[300],
    success: palette.accent[400],
    warning: palette.warning[500],
    "text-success": palette.accent[300],
    "text-danger": palette.tertiary[300],
    "text-warning": palette.warning[500],
    "text-info": palette.secondary[300],
    "focus-ring": palette.accent[300],
  },
  light: {
    // Botanical canvas and ink (ADR-020): cards are white on a pale green-tinted ground, as in the Stitch screens.
    surface: palette.botanical[50],
    "surface-2": "#FFFFFF",
    "surface-3": palette.botanical[100],
    "surface-950": palette.botanical[900],
    border: palette.botanical[200],
    "border-strong": palette.botanical[300],
    text: palette.botanical[900],
    "text-muted": palette.botanical[700],
    "text-accent": palette.primary[700],
    primary: palette.primary[600],
    "on-primary": "#FFFFFF",
    "primary-hover": palette.primary[700],
    secondary: palette.secondary[600],
    "on-secondary": "#FFFFFF",
    "secondary-hover": palette.secondary[700],
    danger: palette.tertiary[600],
    "on-danger": "#FFFFFF",
    "danger-hover": palette.tertiary[700],
    accent: palette.accent[600],
    "on-accent": "#FFFFFF",
    "accent-hover": palette.accent[700],
    // design.md §2.2 lists accent-600 here; as *text* on surface-50 it measures 4.39:1, below the 4.5 body threshold
    // §2.3 requires, so the token uses accent-700 (6.47:1 as text, 7.07:1 with white on the fill). See ADR-013 §1.
    success: palette.accent[700],
    warning: palette.warning[700],
    "text-success": palette.accent[700],
    "text-danger": palette.tertiary[600],
    "text-warning": palette.warning[700],
    "text-info": palette.secondary[700],
    "focus-ring": palette.secondary[600],
  },
} as const satisfies Record<"dark" | "light", Record<string, string>>;

export type SemanticToken = keyof (typeof semanticTokens)["dark"];

/** "#40BD06" → "64 189 6" — the channel form `app/globals.css` stores so Tailwind can apply opacity. */
export function rgbChannels(hex: string): string {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) throw new RangeError(`Expected #RRGGBB, got ${hex}`);
  return [match[1], match[2], match[3]].map((pair) => parseInt(pair, 16)).join(" ");
}

/** Every colour value allowed anywhere in the UI (plus white for light surfaces and text on filled buttons). */
export const ALLOWED_COLOR_VALUES: ReadonlySet<string> = new Set([
  ...Object.values(palette).flatMap((scale) => Object.values(scale)),
  "#FFFFFF",
]);
