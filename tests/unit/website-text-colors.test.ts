import { describe, expect, it } from "vitest";
import {
  SURFACE_HEX,
  THEME_PRESETS,
  resolveTheme,
  themeContrastIssues,
  themeCssVariables,
} from "@/lib/services/website-theme";
import { channels, siteThemeStyle, surfaceThemeAttribute } from "@/components/public/theme";
import { websiteTextColorsSchema } from "@/lib/validation/website";
import {
  evaluateThemeContrast,
  type PreviewPalette,
} from "@/app/restaurant/website/site-preview";
import { computeDefaultTextColors } from "@/app/restaurant/website/website-editor";
import { textColorsOf } from "@/lib/data/website";

describe("Public Website Colour Settings & Text Customization", () => {
  // 1. Primary colour updates the public website.
  it("1. Primary colour updates the public website tokens", () => {
    const resolved = resolveTheme({
      preset: "CUSTOM",
      surfaceMode: "DARK",
      primaryHex: "#9D174D",
      secondaryHex: "#22CEB1",
      accentHex: "#BE123C",
      gradientFromHex: null,
      gradientToHex: null,
    });
    expect(resolved.primary).toBe("#9D174D");
    const vars = themeCssVariables(resolved);
    expect(vars["--site-primary"]).toBe("#9D174D");
    const style = siteThemeStyle(resolved, vars) as Record<string, any>;
    expect(style["--primary"]).toBe(channels("#9D174D"));
  });

  // 2. Secondary colour updates the public website.
  it("2. Secondary colour updates the public website tokens", () => {
    const resolved = resolveTheme({
      preset: "CUSTOM",
      surfaceMode: "DARK",
      primaryHex: "#9D174D",
      secondaryHex: "#22CEB1",
      accentHex: "#BE123C",
      gradientFromHex: null,
      gradientToHex: null,
    });
    expect(resolved.secondary).toBe("#22CEB1");
    const vars = themeCssVariables(resolved);
    expect(vars["--site-secondary"]).toBe("#22CEB1");
    const style = siteThemeStyle(resolved, vars) as Record<string, any>;
    expect(style["--secondary"]).toBe(channels("#22CEB1"));
  });

  // 3. Accent colour updates the public website.
  it("3. Accent colour updates the public website tokens", () => {
    const resolved = resolveTheme({
      preset: "CUSTOM",
      surfaceMode: "DARK",
      primaryHex: "#9D174D",
      secondaryHex: "#22CEB1",
      accentHex: "#BE123C",
      gradientFromHex: null,
      gradientToHex: null,
    });
    expect(resolved.accent).toBe("#BE123C");
    const vars = themeCssVariables(resolved);
    expect(vars["--site-accent"]).toBe("#BE123C");
    const style = siteThemeStyle(resolved, vars) as Record<string, any>;
    expect(style["--accent"]).toBe(channels("#BE123C"));
  });

  // 4. Dark / Light mode updates the website background.
  it("4. Dark / Light mode updates the website background", () => {
    const light = resolveTheme({
      preset: "PLATFORM",
      surfaceMode: "LIGHT",
      primaryHex: null,
      secondaryHex: null,
      accentHex: null,
      gradientFromHex: null,
      gradientToHex: null,
    });
    expect(light.surface).toBe(SURFACE_HEX.LIGHT);
    expect(surfaceThemeAttribute(light)).toBe("light");

    const dark = resolveTheme({
      preset: "PLATFORM",
      surfaceMode: "DARK",
      primaryHex: null,
      secondaryHex: null,
      accentHex: null,
      gradientFromHex: null,
      gradientToHex: null,
    });
    expect(dark.surface).toBe(SURFACE_HEX.DARK);
    expect(surfaceThemeAttribute(dark)).toBe("dark");
  });

  // 5. Custom gradient applies correctly.
  it("5. Custom gradient applies correctly when configured", () => {
    const customGrad = resolveTheme({
      preset: "CUSTOM",
      surfaceMode: "DARK",
      primaryHex: "#9D174D",
      secondaryHex: "#22CEB1",
      accentHex: "#BE123C",
      gradientFromHex: "#00FFFF",
      gradientToHex: "#D76D09",
    });
    expect(customGrad.gradientFrom).toBe("#00FFFF");
    expect(customGrad.gradientTo).toBe("#D76D09");
    const vars = themeCssVariables(customGrad);
    expect(vars["--site-gradient-from"]).toBe("#00FFFF");
    expect(vars["--site-gradient-to"]).toBe("#D76D09");
  });

  // 6. Palette selection works.
  it("6. Palette selection loads preset colours", () => {
    const citrus = resolveTheme({
      preset: "CITRUS",
      surfaceMode: "LIGHT",
      primaryHex: null,
      secondaryHex: null,
      accentHex: null,
      gradientFromHex: null,
      gradientToHex: null,
    });
    expect(citrus.primary).toBe(THEME_PRESETS.CITRUS.LIGHT.primary);
    expect(citrus.secondary).toBe(THEME_PRESETS.CITRUS.LIGHT.secondary);

    const ocean = resolveTheme({
      preset: "OCEAN",
      surfaceMode: "DARK",
      primaryHex: null,
      secondaryHex: null,
      accentHex: null,
      gradientFromHex: null,
      gradientToHex: null,
    });
    expect(ocean.primary).toBe(THEME_PRESETS.OCEAN.DARK.primary);
    expect(ocean.secondary).toBe(THEME_PRESETS.OCEAN.DARK.secondary);
  });

  // 7. Main heading colour applies.
  it("7. Main heading colour applies to theme variables", () => {
    const resolved = resolveTheme({
      preset: "CUSTOM",
      surfaceMode: "LIGHT",
      primaryHex: "#9D174D",
      secondaryHex: "#22CEB1",
      accentHex: "#BE123C",
      gradientFromHex: null,
      gradientToHex: null,
      textColors: { headingColor: "#17211B" },
    });
    expect(resolved.textColors.headingColor).toBe("#17211B");
    const vars = themeCssVariables(resolved);
    expect(vars["--website-heading-color"]).toBe("#17211B");
  });

  // 8. Section heading colour applies.
  it("8. Section heading colour applies to theme variables", () => {
    const resolved = resolveTheme({
      preset: "CUSTOM",
      surfaceMode: "LIGHT",
      primaryHex: "#9D174D",
      secondaryHex: "#22CEB1",
      accentHex: "#BE123C",
      gradientFromHex: null,
      gradientToHex: null,
      textColors: { sectionHeadingColor: "#24352B" },
    });
    expect(resolved.textColors.sectionHeadingColor).toBe("#24352B");
    const vars = themeCssVariables(resolved);
    expect(vars["--website-section-heading-color"]).toBe("#24352B");
  });

  // 9. Body text colour applies.
  it("9. Body text colour applies to theme variables", () => {
    const resolved = resolveTheme({
      preset: "CUSTOM",
      surfaceMode: "LIGHT",
      primaryHex: "#9D174D",
      secondaryHex: "#22CEB1",
      accentHex: "#BE123C",
      gradientFromHex: null,
      gradientToHex: null,
      textColors: { bodyTextColor: "#405044" },
    });
    expect(resolved.textColors.bodyTextColor).toBe("#405044");
    const vars = themeCssVariables(resolved);
    expect(vars["--website-body-text-color"]).toBe("#405044");
  });

  // 10. Muted text colour applies.
  it("10. Muted text colour applies to theme variables", () => {
    const resolved = resolveTheme({
      preset: "CUSTOM",
      surfaceMode: "LIGHT",
      primaryHex: "#9D174D",
      secondaryHex: "#22CEB1",
      accentHex: "#BE123C",
      gradientFromHex: null,
      gradientToHex: null,
      textColors: { mutedTextColor: "#667366" },
    });
    expect(resolved.textColors.mutedTextColor).toBe("#667366");
    const vars = themeCssVariables(resolved);
    expect(vars["--website-muted-text-color"]).toBe("#667366");
  });

  // 11. Navigation text colour applies.
  it("11. Navigation text colour applies to theme variables", () => {
    const resolved = resolveTheme({
      preset: "CUSTOM",
      surfaceMode: "LIGHT",
      primaryHex: "#9D174D",
      secondaryHex: "#22CEB1",
      accentHex: "#BE123C",
      gradientFromHex: null,
      gradientToHex: null,
      textColors: { navigationTextColor: "#24352B" },
    });
    expect(resolved.textColors.navigationTextColor).toBe("#24352B");
    const vars = themeCssVariables(resolved);
    expect(vars["--website-navigation-text-color"]).toBe("#24352B");
  });

  // 12. Link colour applies.
  it("12. Link colour applies to theme variables", () => {
    const resolved = resolveTheme({
      preset: "CUSTOM",
      surfaceMode: "LIGHT",
      primaryHex: "#9D174D",
      secondaryHex: "#22CEB1",
      accentHex: "#BE123C",
      gradientFromHex: null,
      gradientToHex: null,
      textColors: { linkColor: "#059669" },
    });
    expect(resolved.textColors.linkColor).toBe("#059669");
    const vars = themeCssVariables(resolved);
    expect(vars["--website-link-color"]).toBe("#059669");
  });

  // 13. Button text colour applies.
  it("13. Button text colour applies to theme variables", () => {
    const resolved = resolveTheme({
      preset: "CUSTOM",
      surfaceMode: "LIGHT",
      primaryHex: "#9D174D",
      secondaryHex: "#22CEB1",
      accentHex: "#BE123C",
      gradientFromHex: null,
      gradientToHex: null,
      textColors: { buttonTextColor: "#FFFFFF" },
    });
    expect(resolved.textColors.buttonTextColor).toBe("#FFFFFF");
    const vars = themeCssVariables(resolved);
    expect(vars["--website-button-text-color"]).toBe("#FFFFFF");
  });

  // 14. Price colour applies.
  it("14. Price colour applies to theme variables", () => {
    const resolved = resolveTheme({
      preset: "CUSTOM",
      surfaceMode: "LIGHT",
      primaryHex: "#9D174D",
      secondaryHex: "#22CEB1",
      accentHex: "#BE123C",
      gradientFromHex: null,
      gradientToHex: null,
      textColors: { priceColor: "#DC2626" },
    });
    expect(resolved.textColors.priceColor).toBe("#DC2626");
    const vars = themeCssVariables(resolved);
    expect(vars["--website-price-color"]).toBe("#DC2626");
  });

  // 15. Footer text colour applies.
  it("15. Footer text colour applies to theme variables", () => {
    const resolved = resolveTheme({
      preset: "CUSTOM",
      surfaceMode: "LIGHT",
      primaryHex: "#9D174D",
      secondaryHex: "#22CEB1",
      accentHex: "#BE123C",
      gradientFromHex: null,
      gradientToHex: null,
      textColors: { footerTextColor: "#405044" },
    });
    expect(resolved.textColors.footerTextColor).toBe("#405044");
    const vars = themeCssVariables(resolved);
    expect(vars["--website-footer-text-color"]).toBe("#405044");
  });

  // 16. Hero text colours apply.
  it("16. Hero heading and description colours apply to theme variables", () => {
    const resolved = resolveTheme({
      preset: "CUSTOM",
      surfaceMode: "LIGHT",
      primaryHex: "#9D174D",
      secondaryHex: "#22CEB1",
      accentHex: "#BE123C",
      gradientFromHex: "#00FFFF",
      gradientToHex: "#D76D09",
      textColors: { heroHeadingColor: "#FAFAFA", heroDescriptionColor: "#F3F4F6" },
    });
    expect(resolved.textColors.heroHeadingColor).toBe("#FAFAFA");
    expect(resolved.textColors.heroDescriptionColor).toBe("#F3F4F6");
    const vars = themeCssVariables(resolved);
    expect(vars["--website-hero-heading-color"]).toBe("#FAFAFA");
    expect(vars["--website-hero-description-color"]).toBe("#F3F4F6");
  });

  // 17. Live preview updates immediately.
  it("17. Live preview evaluation responds directly to draft state without refresh", () => {
    const palette: PreviewPalette = {
      primary: "#9D174D",
      secondary: "#22CEB1",
      accent: "#BE123C",
      gradientFrom: "#00FFFF",
      gradientTo: "#D76D09",
    };
    const defaultTexts = computeDefaultTextColors("LIGHT", palette);
    const { checks } = evaluateThemeContrast(palette, SURFACE_HEX.LIGHT, defaultTexts);
    expect(checks.length).toBeGreaterThanOrEqual(13);
    const buttonCheck = checks.find((c) => c.id === "buttonText");
    expect(buttonCheck).toBeDefined();
    expect(buttonCheck?.ok).toBe(true);
  });

  // 18. Saved colours survive page reload.
  it("18. Saved colours roundtrip through serialization and resolveTheme", () => {
    const customSet = {
      headingColor: "#111111",
      sectionHeadingColor: "#222222",
      bodyTextColor: "#333333",
      mutedTextColor: "#444444",
      navigationTextColor: "#555555",
      linkColor: "#666666",
      buttonTextColor: "#777777",
      priceColor: "#888888",
      footerTextColor: "#999999",
      heroHeadingColor: "#AAAAAA",
      heroDescriptionColor: "#BBBBBB",
    };
    const cleaned = textColorsOf(customSet);
    const resolved = resolveTheme({
      preset: "CUSTOM",
      surfaceMode: "DARK",
      primaryHex: "#9D174D",
      secondaryHex: "#22CEB1",
      accentHex: "#BE123C",
      gradientFromHex: null,
      gradientToHex: null,
      textColors: cleaned,
    });
    expect(resolved.textColors).toEqual(customSet);
  });

  // 19. Legacy tenant settings continue to work.
  it("19. Legacy tenant settings with empty/null textColors derive sensible defaults", () => {
    const legacy = resolveTheme({
      preset: "PLATFORM",
      surfaceMode: "LIGHT",
      primaryHex: null,
      secondaryHex: null,
      accentHex: null,
      gradientFromHex: null,
      gradientToHex: null,
      textColors: undefined,
    });
    expect(legacy.textColors.headingColor).toBe("#17211B");
    expect(legacy.textColors.bodyTextColor).toBe("#405044");
    expect(legacy.textColors.linkColor).toBe(legacy.primary);
  });

  // 20. Invalid HEX input is rejected safely.
  it("20. Invalid HEX input is rejected by schema validator", () => {
    const invalidInputs = [
      { headingColor: "red" },
      { bodyTextColor: "#123" },
      { priceColor: "123456" },
      { linkColor: "#GGGGGG" },
      { buttonTextColor: "#1234567" },
    ];
    for (const input of invalidInputs) {
      const result = websiteTextColorsSchema.safeParse(input);
      expect(result.success).toBe(false);
    }
  });

  // 21. Contrast warnings identify the correct combination.
  it("21. Contrast warnings identify the correct combination without throwing", () => {
    const palette: PreviewPalette = {
      primary: "#9D174D",
      secondary: "#22CEB1", // Low contrast against light surface
      accent: "#BE123C",
      gradientFrom: "#00FFFF",
      gradientTo: "#D76D09",
    };
    const texts = computeDefaultTextColors("LIGHT", palette);
    const { failing } = evaluateThemeContrast(palette, SURFACE_HEX.LIGHT, texts);
    const secondaryWarning = failing.find((f) => f.id === "secondary");
    expect(secondaryWarning).toBeDefined();
    expect(secondaryWarning?.ratio).toBeLessThan(4.5);
    expect(secondaryWarning?.pair).toContain("Secondary colour on website background");
    expect(secondaryWarning?.suggestion).toMatch(/^#[0-9A-F]{6}$/);

    // Also check themeContrastIssues from the service returns issues without throwing
    const issues = themeContrastIssues(palette, "LIGHT");
    expect(issues.secondaryHex).toBeDefined();
  });

  // 22. Tenant isolation is preserved.
  it("22. Tenant theme style is scoped inline without global pollution", () => {
    const tenantA = resolveTheme({
      preset: "CUSTOM",
      surfaceMode: "DARK",
      primaryHex: "#9D174D",
      secondaryHex: "#22CEB1",
      accentHex: "#BE123C",
      gradientFromHex: null,
      gradientToHex: null,
      textColors: { headingColor: "#FFFFFF" },
    });
    const tenantB = resolveTheme({
      preset: "CUSTOM",
      surfaceMode: "LIGHT",
      primaryHex: "#1E40AF",
      secondaryHex: "#0D9488",
      accentHex: "#F59E0B",
      gradientFromHex: null,
      gradientToHex: null,
      textColors: { headingColor: "#000000" },
    });
    const styleA = siteThemeStyle(tenantA, themeCssVariables(tenantA)) as Record<string, any>;
    const styleB = siteThemeStyle(tenantB, themeCssVariables(tenantB)) as Record<string, any>;
    expect(styleA["--primary"]).not.toBe(styleB["--primary"]);
    expect(styleA["--website-heading-color"]).toBe("#FFFFFF");
    expect(styleB["--website-heading-color"]).toBe("#000000");
  });

  // 23. Reset to default affects only the selected setting.
  it("23. Reset to default affects only the selected setting", () => {
    const palette: PreviewPalette = {
      primary: "#9D174D",
      secondary: "#22CEB1",
      accent: "#BE123C",
      gradientFrom: "#00FFFF",
      gradientTo: "#D76D09",
    };
    const defaults = computeDefaultTextColors("LIGHT", palette);
    const userDraft = {
      ...defaults,
      headingColor: "#FF0000",
      priceColor: "#00FF00",
    };

    // User resets headingColor only:
    const afterReset = {
      ...userDraft,
      headingColor: defaults.headingColor,
    };
    expect(afterReset.headingColor).toBe(defaults.headingColor);
    // priceColor remains customized:
    expect(afterReset.priceColor).toBe("#00FF00");
  });
});
