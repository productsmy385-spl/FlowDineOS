import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SitePreview, type PreviewInput } from "@/app/restaurant/website/site-preview";
import { computeDefaultTextColors, draftPalette, previewTextColors } from "@/app/restaurant/website/website-editor";

/**
 * Brand Kit colour fields (owner report 2026-10-13): pressing Backspace in a hex field took the user off the editor.
 * Root cause: the field's half-typed value (e.g. "#9D174") reached the live preview's contrast maths, which throws on
 * anything but #RRGGBB during render, so React tore the editor down. The editor now previews the saved colour until
 * the field holds a complete one again.
 */

const PALETTE = { primary: "#9D174D", secondary: "#22CEB1", accent: "#BE123C", gradientFrom: "#9D174D", gradientTo: "#22CEB1" };
const TEXT = computeDefaultTextColors("DARK", PALETTE);

type Draft = Parameters<typeof draftPalette>[0];
type Reference = Parameters<typeof draftPalette>[1];

const saved: Draft = {
  preset: "CUSTOM",
  surfaceMode: "DARK",
  primaryHex: "#9D174D",
  secondaryHex: "#22CEB1",
  accentHex: "#BE123C",
  useGradient: false,
  gradientFromHex: "#9D174D",
  gradientToHex: "#22CEB1",
  textColors: TEXT,
  customTextColors: Object.fromEntries(Object.keys(TEXT).map((k) => [k, false])) as Draft["customTextColors"],
  brandColors: [],
  menuStyle: "RING",
  dailyStyle: "STRIP",
};
const reference = { presetPalettes: {} } as unknown as Reference;

function input(palette: PreviewInput["palette"], textColors = TEXT): PreviewInput {
  return {
    preset: "CUSTOM",
    surfaceMode: "DARK",
    palette,
    surfaceHex: "#0B0B0F",
    onSurfaceHex: "#F5F5F7",
    restaurantName: "Spice Route",
    headline: "Spice Route",
    tagline: null,
    ctaLabel: null,
    sectionLabels: [],
    textColors,
  };
}

// Every intermediate value a person produces while editing: Backspace, Delete, select-all + delete, a paste in progress.
const PARTIAL = ["#9D174", "#9D17", "#", "", "9D174D", "#9D174DX", "#GGGGGG", " #9D174D"];

describe("Brand Kit colour input — root cause", () => {
  it("the live preview throws when handed a half-typed hex, which is why the editor crashed", () => {
    expect(() => renderToStaticMarkup(<SitePreview input={input({ ...PALETTE, primary: "#9D174" })} dirty />)).toThrow(RangeError);
  });
});

describe("Brand Kit colour input — fix", () => {
  it.each(PARTIAL)("previews the saved colour while a theme field holds %j, and renders", (value) => {
    for (const key of ["primaryHex", "secondaryHex", "accentHex"] as const) {
      const palette = draftPalette({ ...saved, [key]: value }, reference, saved);
      expect(Object.values(palette).every((hex) => /^#[0-9A-F]{6}$/i.test(hex))).toBe(true);
      expect(() => renderToStaticMarkup(<SitePreview input={input(palette)} dirty />)).not.toThrow();
      expect(() => computeDefaultTextColors("DARK", palette)).not.toThrow();
    }
  });

  it.each(PARTIAL)("keeps the custom gradient previewable while a gradient field holds %j", (value) => {
    const palette = draftPalette({ ...saved, useGradient: true, gradientFromHex: value, gradientToHex: "#123456" }, reference, saved);
    expect(palette.gradientFrom).toBe(saved.gradientFromHex);
    expect(palette.gradientTo).toBe("#123456");
  });

  it.each(PARTIAL)("previews the saved text colour while a text colour field holds %j", (value) => {
    const text = previewTextColors({ ...TEXT, headingColor: value }, TEXT);
    expect(text.headingColor).toBe(TEXT.headingColor);
    expect(() => renderToStaticMarkup(<SitePreview input={input(PALETTE, text)} dirty />)).not.toThrow();
  });

  it("uses a complete colour as soon as it is typed", () => {
    expect(draftPalette({ ...saved, primaryHex: "#123ABC" }, reference, saved).primary).toBe("#123ABC");
    expect(previewTextColors({ ...TEXT, linkColor: "#ABCDEF" }, TEXT).linkColor).toBe("#ABCDEF");
  });
});
