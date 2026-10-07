import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { resolveThemePreference, THEME_BOOT_SCRIPT, THEME_COOKIE } from "@/lib/ui/theme";

/**
 * TC-THEME-001…004 — platform light/dark theme (RASOIOS-ADR-016).
 * Both token sets in app/globals.css meet WCAG 2.1 AA for every text/background pair the console uses; the pre-paint
 * boot script applies the stored choice, follows the OS for SYSTEM, and fails safe to dark.
 */
const css = readFileSync(path.resolve(__dirname, "../../app/globals.css"), "utf8");

function tokenBlock(selector: RegExp): Record<string, [number, number, number]> {
  const match = selector.exec(css);
  if (!match) throw new Error(`token block not found: ${selector}`);
  const body = css.slice(match.index, css.indexOf("}", match.index));
  const tokens: Record<string, [number, number, number]> = {};
  for (const [, name, r, g, b] of body.matchAll(/--([\w-]+):\s*(\d+)\s+(\d+)\s+(\d+)\s*;/g)) tokens[name] = [Number(r), Number(g), Number(b)];
  return tokens;
}

function luminance([r, g, b]: [number, number, number]): number {
  const channel = (value: number) => {
    const s = value / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const THEMES = {
  dark: tokenBlock(/:root,\s*\[data-theme="dark"\]\s*\{/),
  light: tokenBlock(/\[data-theme="light"\]\s*\{/),
};

// Body text needs 4.5:1; UI edges (focus ring) need 3:1.
const TEXT_PAIRS: Array<[string, string]> = [
  ["text", "surface"],
  ["text", "surface-2"],
  ["text", "surface-3"],
  ["text-muted", "surface"],
  ["text-muted", "surface-2"],
  ["text-accent", "surface"],
  ["text-success", "surface"],
  ["text-danger", "surface"],
  ["text-warning", "surface"],
  ["text-info", "surface"],
  ["on-primary", "primary"],
  ["on-secondary", "secondary"],
  ["on-danger", "danger"],
  ["on-accent", "accent"],
];

describe("TC-THEME-001 both token sets meet WCAG AA", () => {
  for (const [theme, tokens] of Object.entries(THEMES)) {
    it.each(TEXT_PAIRS)(`${theme}: %s on %s ≥ 4.5:1`, (fg, bg) => {
      expect(tokens[fg], fg).toBeDefined();
      expect(tokens[bg], bg).toBeDefined();
      expect(contrast(tokens[fg]!, tokens[bg]!)).toBeGreaterThanOrEqual(4.5);
    });
    it(`${theme}: focus ring ≥ 3:1 on the canvas`, () => {
      expect(contrast(tokens["focus-ring"]!, tokens.surface!)).toBeGreaterThanOrEqual(3);
    });
  }

  it("both themes define the same tokens (no token only exists in one mode)", () => {
    expect(Object.keys(THEMES.light).sort()).toEqual(Object.keys(THEMES.dark).sort());
  });
});

function runBoot(cookie: string, systemDark: boolean, pathname?: string) {
  const attributes: Record<string, string> = {};
  const classes = new Set<string>(["dark"]);
  const root = {
    setAttribute: (name: string, value: string) => (attributes[name] = value),
    classList: { toggle: (name: string, on: boolean) => (on ? classes.add(name) : classes.delete(name)) },
    style: {} as Record<string, string>,
  };
  vm.runInNewContext(THEME_BOOT_SCRIPT, {
    document: { cookie, documentElement: root },
    window: { matchMedia: () => ({ matches: systemDark }), ...(pathname ? { location: { pathname } } : {}) },
  });
  return { theme: attributes["data-theme"], preference: attributes["data-theme-preference"], dark: classes.has("dark"), colorScheme: root.style.colorScheme };
}

describe("TC-THEME-002 pre-paint boot script", () => {
  it("applies a stored LIGHT or DARK choice", () => {
    expect(runBoot(`a=1; ${THEME_COOKIE}=LIGHT`, true)).toEqual({ theme: "light", preference: "LIGHT", dark: false, colorScheme: "light" });
    expect(runBoot(`${THEME_COOKIE}=DARK`, false)).toEqual({ theme: "dark", preference: "DARK", dark: true, colorScheme: "dark" });
  });

  it("SYSTEM follows the operating system", () => {
    expect(runBoot(`${THEME_COOKIE}=SYSTEM`, true).theme).toBe("dark");
    expect(runBoot(`${THEME_COOKIE}=SYSTEM`, false).theme).toBe("light");
  });

  it("no cookie or a tampered value falls back to the dark default (ADR-013)", () => {
    expect(runBoot("", false).theme).toBe("dark");
    expect(runBoot(`${THEME_COOKIE}=<script>`, false).theme).toBe("dark");
    expect(runBoot(`x${THEME_COOKIE}=LIGHT`, false).theme).toBe("dark");
  });

  it("public marketing pages follow the system on a first visit; a saved choice and every other page are unchanged (2026-10-07)", () => {
    for (const path of ["/", "/book-demo", "/privacy", "/terms"]) {
      expect(runBoot("", false, path)).toMatchObject({ theme: "light", preference: "SYSTEM" });
      expect(runBoot("", true, path)).toMatchObject({ theme: "dark", preference: "SYSTEM" });
      expect(runBoot(`${THEME_COOKIE}=DARK`, false, path).theme).toBe("dark");
    }
    for (const path of ["/restaurant/orders", "/sign-in", "/admin", "/r/spice-route"]) {
      expect(runBoot("", false, path)).toMatchObject({ theme: "dark", preference: "DARK" });
    }
  });

  it("contains no markup-breaking characters (inline script safety)", () => {
    expect(THEME_BOOT_SCRIPT).not.toMatch(/<|>|&/);
  });
});

describe("TC-THEME-003 resolver", () => {
  it("maps preferences to a concrete theme", () => {
    expect(resolveThemePreference("LIGHT", true)).toBe("light");
    expect(resolveThemePreference("DARK", false)).toBe("dark");
    expect(resolveThemePreference("SYSTEM", true)).toBe("dark");
    expect(resolveThemePreference("SYSTEM", false)).toBe("light");
  });
});
