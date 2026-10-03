import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import resolveConfig from "tailwindcss/resolveConfig";
import { describe, expect, it } from "vitest";
import tailwindConfig from "@/tailwind.config";
import { ALLOWED_COLOR_VALUES, glass, palette, radius, rgbChannels, semanticTokens } from "@/lib/ui/tokens";
import { DOMAIN_HUES, DOMAIN_ICONS, MENU_ICONS, MENU_ICON_KEYS, STATUS_ICONS } from "@/lib/ui/icons";

// TC-DS-001 (theme = design tokens), TC-DS-008 (icon system) and TC-DS-016 (the three-level glass contract) for
// Brand v2 (RASOIOS-ADR-013).
const root = path.resolve(__dirname, "../..");
const resolved = resolveConfig(tailwindConfig);
const globalsCss = readFileSync(path.join(root, "app/globals.css"), "utf8");

function flattenColors(value: unknown, prefix = ""): Array<[string, string]> {
  if (typeof value === "string") return [[prefix, value]];
  if (value && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => flattenColors(v, prefix ? `${prefix}-${k}` : k));
  return [];
}

describe("TC-DS-001 Tailwind theme = design tokens", () => {
  it("every colour is a design.md §2.1 value, a semantic token or transparent/currentColor", () => {
    const offenders = flattenColors(resolved.theme.colors).filter(([, value]) => {
      if (value === "transparent" || value === "currentColor") return false;
      if (/^rgb\(var\(--[a-z0-9-]+\) \/ <alpha-value>\)$/.test(value)) return false;
      return !ALLOWED_COLOR_VALUES.has(value.toUpperCase());
    });
    expect(offenders).toEqual([]);
  });

  it("the Brand v2 values are present on their design.md §2.1 steps", () => {
    const colors = resolved.theme.colors as unknown as Record<string, Record<string, string>>;
    // ADR-018 re-derived these from the new hues by holding each step's luminance; secondary came back unchanged.
    expect(colors.primary["400"]).toBe("#38BD15");
    expect(colors.secondary["500"]).toBe("#5179FF");
    expect(colors.tertiary["500"]).toBe("#F80F25");
    expect(colors.accent["400"]).toBe("#00B3CB");
    expect(colors.surface["900"]).toBe("#0B1110");
    expect(colors.surface["950"]).toBe("#070B0A");
    expect(colors.surface["750"]).toBe("#1D2A26");
    expect(colors.surface["850"]).toBe("#111917");
    // `danger` is the tertiary ramp under its semantic name, not a separate scale.
    expect(colors.danger).toEqual(colors.tertiary);
  });

  it("the Brand v1 amber/emerald palette is gone, aliases and all", () => {
    const names = Object.keys(resolved.theme.colors as object);
    for (const removed of ["amber", "emerald", "gray", "red", "neutral"]) expect(names, removed).not.toContain(removed);
    const values = flattenColors(resolved.theme.colors).map(([, value]) => value.toUpperCase());
    for (const v1 of ["#D97706", "#10B981", "#FBF9F5", "#1A1715", "#24201D", "#38322E"]) expect(values, v1).not.toContain(v1);
  });

  it("radii are only the design.md §4.4 scale", () => {
    const allowed = new Set(Object.values(radius));
    const offenders = Object.entries(resolved.theme.borderRadius as Record<string, string>).filter(([, v]) => !allowed.has(v as never));
    expect(offenders).toEqual([]);
  });

  it("drops Tailwind's default palette (no slate, blue, purple, …)", () => {
    const names = Object.keys(resolved.theme.colors as object);
    for (const removed of ["slate", "zinc", "stone", "blue", "indigo", "purple", "pink", "yellow", "orange", "green", "lime", "sky", "cyan", "teal", "rose", "fuchsia", "black"]) {
      expect(names, removed).not.toContain(removed);
    }
  });

  it("globals.css writes every semantic token of both themes, as RGB channels", () => {
    for (const [theme, tokens] of Object.entries(semanticTokens)) {
      for (const [name, hex] of Object.entries(tokens)) {
        expect(globalsCss, `${theme} --${name}`).toContain(`--${name}: ${rgbChannels(hex)};`);
      }
    }
  });

  it("loads no web fonts from Google at runtime", () => {
    expect(globalsCss).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com|@import url/);
  });

  /**
   * ...or at build time. `next/font/google` downloads from Google during `next build`, which made the build fail
   * whenever Google answered with something its parser did not expect — three times on 2026-09-25, on commits that
   * had nothing to do with fonts. The files are vendored instead, so a build needs no third party to be up.
   */
  it("builds the brand fonts from vendored files, not a download from Google", () => {
    const offenders = uiFiles.filter((f) => /from\s+["']next\/font\/google["']/.test(readFileSync(f, "utf8")));
    expect(offenders.map((f) => path.relative(root, f))).toEqual([]);
    for (const file of ["app/fonts/PlusJakartaSans-Variable.woff2", "app/fonts/Inter-Variable.woff2"]) {
      // Present, and a real woff2 ("wOF2"), so a truncated or LFS-pointer file fails here rather than in the build.
      expect(readFileSync(path.join(root, file)).subarray(0, 4).toString("latin1"), file).toBe("wOF2");
    }
  });
});

// TC-DS-016 — glass is a system, not a coating (design.md §4.6, ADR-013 §2).
describe("TC-DS-016 three-level glass system", () => {
  it("defines exactly three levels, each with the design.md §4.6 surface, opacity and blur", () => {
    for (const [level, recipe] of Object.entries(glass)) {
      const block = new RegExp(`\\.glass-${level} \\{([^}]*)\\}`).exec(globalsCss)?.[1];
      expect(block, `.glass-${level}`).toBeTruthy();
      expect(block, `.glass-${level} surface`).toContain(`rgb(var(${recipe.surface}) / ${recipe.opacity})`);
      expect(block, `.glass-${level} blur`).toContain(`blur(${recipe.blur}px)`);
    }
    expect(globalsCss).not.toMatch(/\.glass-4\b/);
  });

  it("never puts text behind less than 72 % opacity, and never blurs more than 18 px", () => {
    for (const recipe of Object.values(glass)) {
      expect(recipe.opacity).toBeGreaterThanOrEqual(0.72);
      expect(recipe.blur).toBeLessThanOrEqual(18);
    }
    for (const [, blur] of globalsCss.matchAll(/backdrop-filter: blur\((\d+)px\)/g)) expect(Number(blur)).toBeLessThanOrEqual(18);
  });

  it("ships an opaque fallback for missing backdrop-filter and for prefers-reduced-transparency", () => {
    expect(globalsCss).toContain("@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px)))");
    expect(globalsCss).toContain("@media (prefers-reduced-transparency: reduce)");
    const reduced = /@media \(prefers-reduced-transparency: reduce\) \{([\s\S]*?)\n  \}\n/.exec(globalsCss)?.[1] ?? "";
    for (const level of [1, 2, 3]) expect(reduced, `glass-${level}`).toContain(`.glass-${level}`);
    expect(reduced).toContain("backdrop-filter: none");
  });

  it("glass is never nested inside glass in the application source", () => {
    const offenders = uiFiles.filter((file) => /class(Name)?="[^"]*\bglass-[123]\b[^"]*\bglass-[123]\b/.test(readFileSync(file, "utf8")));
    expect(offenders.map((f) => path.relative(root, f))).toEqual([]);
  });

  it("the deprecated Brand v1 glass classes are gone", () => {
    for (const legacy of ["glass-panel", "glass-header", "glass-bar"]) expect(globalsCss, legacy).not.toContain(`.${legacy}`);
    // `app/restaurant/menu/**` is mid-rewrite under its own task; the classes there resolve to nothing until it lands.
    const pending = /app[\\/]restaurant[\\/]menu[\\/]/;
    const offenders = uiFiles.filter((file) => !pending.test(file) && /\bglass-(panel|header|bar)\b/.test(readFileSync(file, "utf8")));
    expect(offenders.map((f) => path.relative(root, f))).toEqual([]);
  });
});

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}
const uiFiles = ["app", "components"].flatMap((d) => walk(path.join(root, d)));

describe("TC-DS-008 icon system", () => {
  it("the icon maps resolve to components", () => {
    for (const icon of [...Object.values(DOMAIN_ICONS), ...Object.values(MENU_ICONS)]) expect(icon, "icon").toBeTruthy();
    for (const domain of Object.values(STATUS_ICONS)) for (const visual of Object.values(domain)) expect(visual.icon).toBeTruthy();
    expect(MENU_ICON_KEYS).toHaveLength(26);
  });

  it("every domain has one fixed hue (design.md §5.2)", () => {
    for (const [domain, hue] of Object.entries(DOMAIN_HUES)) expect(hue, domain).toBeTruthy();
    expect(DOMAIN_HUES.dashboard).toBe("primary");
    expect(DOMAIN_HUES.orders).toBe("secondary");
    expect(DOMAIN_HUES.customers).toBe("tertiary-soft");
    expect(DOMAIN_HUES.reports).toBe("accent");
    expect(DOMAIN_HUES.settings).toBe("neutral");
  });

  it("UI source contains no emoji", () => {
    const emoji = /\p{Extended_Pictographic}/u;
    const offenders = uiFiles.filter((f) => emoji.test(readFileSync(f, "utf8").replace(/[✓✕✗×]/g, ""))).map((f) => path.relative(root, f));
    expect(offenders).toEqual([]);
  });

  it("icons come only from lucide-react (no other icon packs or inline SVG icon sets)", () => {
    const offenders = uiFiles.filter((f) => /from\s+["'](react-icons|@heroicons|@tabler|@radix-ui\/react-icons|phosphor-react|@fortawesome)/.test(readFileSync(f, "utf8")));
    expect(offenders.map((f) => path.relative(root, f))).toEqual([]);
  });
});

describe("ADR-013 §3 no desktop sidebar", () => {
  it("the sidebar shell is gone from the source", () => {
    const offenders = uiFiles.filter((f) => /\b(SidebarNav|sidebar-nav|w-sidebar|PortalNavbar)\b/.test(readFileSync(f, "utf8")));
    expect(offenders.map((f) => path.relative(root, f))).toEqual([]);
    expect(Object.keys(resolved.theme.width as object)).not.toContain("sidebar");
  });

  it("the console shells render one sticky glass-1 header", () => {
    for (const shell of ["components/layout/app-shell.tsx", "components/layout/admin-shell.tsx"]) {
      const source = readFileSync(path.join(root, shell), "utf8");
      expect(source, shell).toContain("glass-1 sticky top-0");
      expect(source, shell).not.toContain("<aside");
    }
  });

  /**
   * White-label: a restaurant's staff sign in to *their* console, so its header carries their logo and name. Only
   * `/admin` is the platform's own console, so only that one wears the RASOIOS wordmark.
   */
  it("the tenant consoles wear the restaurant's brand and the platform console wears the platform's", () => {
    for (const shell of ["components/layout/app-shell.tsx", "components/layout/focus-shell.tsx"]) {
      const source = readFileSync(path.join(root, shell), "utf8");
      expect(source, shell).toContain("<RestaurantMark");
      expect(source, shell).not.toContain("<BrandMark");
    }
    expect(readFileSync(path.join(root, "components/layout/admin-shell.tsx"), "utf8")).toContain("<BrandMark");
  });
});

describe("palette v2 is derived, not improvised", () => {
  it("every scale step is a #RRGGBB value and every scale shares the same steps", () => {
    const brandScales = [palette.primary, palette.secondary, palette.tertiary, palette.accent];
    const steps = Object.keys(palette.primary);
    for (const scale of brandScales) {
      expect(Object.keys(scale)).toEqual(steps);
      for (const value of Object.values(scale)) expect(value).toMatch(/^#[0-9A-F]{6}$/);
    }
    for (const value of Object.values(palette.surface)) expect(value).toMatch(/^#[0-9A-F]{6}$/);
  });

  it("lightness decreases monotonically down each brand scale", () => {
    const grey = (hex: string) => [1, 3, 5].reduce((sum, at) => sum + parseInt(hex.slice(at, at + 2), 16), 0);
    for (const [name, scale] of Object.entries(palette)) {
      if (name === "warning") continue;
      const values = Object.values(scale).map(grey);
      expect(values, name).toEqual([...values].sort((a, b) => b - a));
    }
  });
});
