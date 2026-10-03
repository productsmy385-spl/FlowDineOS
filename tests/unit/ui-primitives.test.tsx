import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChefHat, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/ui/status-badge";
import { Card, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { HUE_TILE, IconTile } from "@/components/ui/icon-tile";
import { Alert } from "@/components/ui/alert";
import { contrastRatio } from "@/lib/ui/contrast";
import { BRAND_HUES, palette, semanticTokens } from "@/lib/ui/tokens";
import { DOMAIN_HUES, STATUS_ICONS } from "@/lib/ui/icons";

// TC-DS-009 — core primitives render token classes and accessible states, and every contrast pair of design.md §2.3
// is recomputed from the Brand v2 scales rather than taken on trust (RASOIOS-ADR-013).
const html = (node: React.ReactElement) => renderToStaticMarkup(node);
const dark = semanticTokens.dark;
const light = semanticTokens.light;

describe("TC-DS-009 Button", () => {
  it("renders token classes per variant", () => {
    expect(html(<Button>Save</Button>)).toContain("bg-action-primary");
    expect(html(<Button variant="secondary">Cancel</Button>)).toContain("bg-raised");
    expect(html(<Button variant="destructive">Delete</Button>)).toContain("bg-action-danger");
    expect(html(<Button variant="success">Ready</Button>)).toContain("bg-action-success");
    expect(html(<Button variant="ghost">More</Button>)).toContain("bg-transparent");
    expect(html(<Button variant="outline">Legacy</Button>)).toContain("bg-raised");
  });

  it("filled variants carry their checked foreground token, never a bare colour", () => {
    expect(html(<Button>Save</Button>)).toContain("text-action-primary-fg");
    expect(html(<Button variant="destructive">Delete</Button>)).toContain("text-action-danger-fg");
    expect(html(<Button variant="success">Ready</Button>)).toContain("text-action-success-fg");
  });

  it("loading sets aria-busy, disables, shows the loading label and keeps the original label for width", () => {
    const out = html(<Button loading>Save order</Button>);
    expect(out).toContain('aria-busy="true"');
    expect(out).toContain("disabled");
    expect(out).toContain("Saving…");
    expect(out).toMatch(/class="[^"]*invisible[^"]*"[^>]*>(<svg[^>]*>.*<\/svg>)?Save order/);
  });

  it("puts the icon before the label and marks it decorative", () => {
    const out = html(<Button icon={Plus}>New order</Button>);
    expect(out.indexOf("<svg")).toBeLessThan(out.indexOf("New order"));
    expect(out).toContain('aria-hidden="true"');
  });

  it("IconButton requires an aria-label and uses it as the tooltip", () => {
    const out = html(<IconButton icon={ChefHat} aria-label="Open kitchen" />);
    expect(out).toContain('aria-label="Open kitchen"');
    expect(out).toContain('title="Open kitchen"');
    // @ts-expect-error — an icon-only button without a label must not type-check.
    const unlabeled = <IconButton icon={ChefHat} />;
    expect(unlabeled).toBeTruthy();
  });
});

describe("TC-DS-009 badges, cards, tiles and alerts", () => {
  it("StatusBadge renders an icon and a text label for every status in design.md §7", () => {
    for (const [domain, statuses] of Object.entries(STATUS_ICONS)) {
      for (const [status, visual] of Object.entries(statuses)) {
        const out = html(<StatusBadge domain={domain as keyof typeof STATUS_ICONS} status={status as never} />);
        expect(out, `${domain}.${status}`).toContain("<svg");
        expect(out, `${domain}.${status}`).toContain(visual.label);
      }
    }
  });

  it("legacy badge variants map onto tones", () => {
    expect(html(<Badge variant="destructive">x</Badge>)).toContain("text-status-danger");
    expect(html(<Badge variant="outline">x</Badge>)).toContain("text-fg-secondary");
  });

  it("Card uses the surface token, e1 and rounded-2xl; the footer is pinned; glass is opt-in", () => {
    const out = html(
      <Card>
        <CardHeader action={<span>act</span>}>
          <CardTitle>Title</CardTitle>
        </CardHeader>
        <CardFooter>f</CardFooter>
      </Card>,
    );
    expect(out).toContain("bg-card");
    expect(out).toContain("shadow-e1");
    expect(out).toContain("rounded-2xl");
    expect(out).toContain("mt-auto");
    expect(out).not.toContain("glass");
    // Metric tiles and contextual panels opt into glass-2 (design.md §4.6) and then drop the opaque skin.
    const glassed = html(<Card surface="glass">metric</Card>);
    expect(glassed).toContain("glass-2");
    expect(glassed).not.toContain("bg-card");
  });

  it("every design.md §5.2 domain hue has a tile recipe, and hues never leak into text utilities", () => {
    for (const hue of Object.values(DOMAIN_HUES)) expect(HUE_TILE[hue], hue).toBeTruthy();
    const out = html(<IconTile icon={ChefHat} tone={DOMAIN_HUES.kitchen} />);
    expect(out).toContain("bg-secondary-300/12");
    expect(out).toContain("text-secondary-200");
    // The wash is a tint, never a full-strength fill.
    for (const recipe of Object.values(HUE_TILE)) expect(recipe, recipe).toMatch(/bg-[a-z0-9-]+\/12\b/);
  });

  it("danger alerts are announced as alerts", () => {
    expect(html(<Alert tone="danger" title="Payment failed" />)).toContain('role="alert"');
    expect(html(<Alert tone="success" title="Saved" />)).toContain('role="status"');
  });
});

// design.md §2.3 — every published pair, recomputed. The table is the contract; these numbers are the evidence.
describe("TC-DS-009 contrast (design.md §2.3)", () => {
  it.each([
    ["body text on canvas", dark.text, dark.surface, 15.21],
    ["muted text on canvas", dark["text-muted"], dark.surface, 7.43],
    ["console primary button", dark["on-primary"], dark.primary, 7.97],
    ["public primary button", light["on-primary"], light.primary, 4.74],
    ["console secondary button", dark["on-secondary"], dark.secondary, 5.21],
    ["public secondary button", light["on-secondary"], light.secondary, 5.5],
    ["console destructive button", dark["on-danger"], dark.danger, 4.79],
    ["public destructive button", light["on-danger"], light.danger, 5.65],
    ["console accent fill", dark["on-accent"], dark.accent, 7.83],
    ["public accent fill", light["on-accent"], light.accent, 4.79],
    ["accent text on canvas", dark["text-accent"], dark.surface, 10.16],
    ["info text on canvas", dark["text-info"], dark.surface, 9.43],
    ["danger text on canvas", dark["text-danger"], dark.surface, 9.07],
    ["success text on canvas", dark["text-success"], dark.surface, 10.09],
    ["light body text on canvas", light.text, light.surface, 16.38], // botanical canvas and ink (ADR-020)
  ])("%s is %s on %s = %d:1", (_name, foreground, background, expected) => {
    expect(contrastRatio(foreground, background)).toBe(expected);
  });

  it("every text token clears AA (4.5:1) on its own surface, in both themes", () => {
    for (const theme of [dark, light]) {
      for (const token of ["text", "text-muted", "text-accent", "text-success", "text-danger", "text-warning", "text-info"] as const) {
        for (const surface of ["surface", "surface-2", "surface-3"] as const) {
          expect(contrastRatio(theme[token], theme[surface]), `${token} on ${surface}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it("every filled control clears AA with its on-colour, including the hover step", () => {
    for (const theme of [dark, light]) {
      for (const [fill, on, hover] of [
        ["primary", "on-primary", "primary-hover"],
        ["secondary", "on-secondary", "secondary-hover"],
        ["danger", "on-danger", "danger-hover"],
        ["accent", "on-accent", "accent-hover"],
      ] as const) {
        expect(contrastRatio(theme[on], theme[fill]), fill).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(theme[on], theme[hover]), hover).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("the focus ring is visible against every surface it is drawn on (3:1 for UI edges)", () => {
    for (const theme of [dark, light]) {
      for (const surface of ["surface", "surface-2", "surface-3"] as const) {
        expect(contrastRatio(theme["focus-ring"], theme[surface]), surface).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("the raw brand hues are never a text background — which is why the UI paints the ramp instead", () => {
    // design.md §2.3 records 2.06:1 for the ADR-013 hue; the ADR-018 hue recomputes to 1.77:1. Either fails AA widely.
    expect(contrastRatio("#FFFFFF", BRAND_HUES.primary)).toBe(1.77);
    expect(contrastRatio("#FFFFFF", BRAND_HUES.primary)).toBeLessThan(4.5);
    expect(contrastRatio(dark["on-primary"], BRAND_HUES.accent)).toBeGreaterThanOrEqual(4.5);
  });

  it("the subtle border is decorative only — interactive edges use border-strong or a fill", () => {
    expect(contrastRatio(dark.border, dark.surface)).toBe(1.48);
    expect(contrastRatio(dark.border, dark.surface)).toBeLessThan(3);
  });

  it("the warning token clears AA as text on the canvas in both themes", () => {
    expect(contrastRatio(palette.warning[500], dark.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(palette.warning[700], light.surface)).toBeGreaterThanOrEqual(4.5);
  });
});
