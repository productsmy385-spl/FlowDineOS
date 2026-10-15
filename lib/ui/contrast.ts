/** WCAG 2.1 relative luminance and contrast ratio for #RRGGBB colours (design.md §2.3, S1-P08-T004/T010). */

const HEX = /^#[0-9A-Fa-f]{6}$/;

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number {
  if (!HEX.test(hex)) throw new RangeError("Invalid colour");
  const [r, g, b] = [1, 3, 5].map((i) => channel(parseInt(hex.slice(i, i + 2), 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export const luminance = relativeLuminance;

export function contrastRatio(foreground: string, background: string): number {
  const [light, dark] = [relativeLuminance(foreground), relativeLuminance(background)].sort((x, y) => y - x);
  return Math.round(((light + 0.05) / (dark + 0.05)) * 100) / 100;
}

const BLACK = "#0B0B0F";
const WHITE = "#FFFFFF";

/** Black or white — whichever is more readable on `hex`. */
export function onColourFor(hex: string): string {
  return contrastRatio(hex, WHITE) >= contrastRatio(hex, BLACK) ? WHITE : BLACK;
}

/** Interpolates between two hex colours in RGB space at fraction t (0..1). */
export function sampleGradientHex(from: string, to: string, t: number): string {
  if (!HEX.test(from) || !HEX.test(to)) return from;
  const [r1, g1, b1] = [1, 3, 5].map((i) => parseInt(from.slice(i, i + 2), 16));
  const [r2, g2, b2] = [1, 3, 5].map((i) => parseInt(to.slice(i, i + 2), 16));
  const r = Math.round((1 - t) * r1 + t * r2).toString(16).padStart(2, "0");
  const g = Math.round((1 - t) * g1 + t * g2).toString(16).padStart(2, "0");
  const b = Math.round((1 - t) * b1 + t * b2).toString(16).padStart(2, "0");
  return `#${r}${g}${b}`.toUpperCase();
}

/** Suggests an accessible alternative colour that satisfies target contrast against backgroundHex. */
export function suggestedAccessibleColour(hex: string, backgroundHex: string, targetContrast = 4.5): string {
  if (!HEX.test(hex) || !HEX.test(backgroundHex)) return onColourFor(backgroundHex);
  if (contrastRatio(hex, backgroundHex) >= targetContrast) return hex;
  const bgLum = relativeLuminance(backgroundHex);
  const shouldDarken = bgLum > 0.5;
  let [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  for (let step = 0; step < 25; step++) {
    if (shouldDarken) {
      r = Math.max(0, Math.floor(r * 0.85));
      g = Math.max(0, Math.floor(g * 0.85));
      b = Math.max(0, Math.floor(b * 0.85));
    } else {
      r = Math.min(255, Math.ceil(r + (255 - r) * 0.15));
      g = Math.min(255, Math.ceil(g + (255 - g) * 0.15));
      b = Math.min(255, Math.ceil(b + (255 - b) * 0.15));
    }
    const candidate = `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`.toUpperCase();
    if (contrastRatio(candidate, backgroundHex) >= targetContrast) {
      return candidate;
    }
  }
  return shouldDarken ? "#111827" : "#FFFFFF";
}
