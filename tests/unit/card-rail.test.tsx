import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CardRail, RailCard } from "@/components/visual/card-rail";

// TC-RAIL-001…003 — the rail holds every record it is given, never a fixed three (owner brief 2026-10-07 §3).
const items = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `o${i}`, label: `Order ${i + 1}` }));
const render = (n: number) =>
  renderToStaticMarkup(
    <CardRail items={items(n)} keyOf={(i) => i.id} label="Orders" empty={<p>No active orders</p>} renderCard={(i) => <span>{i.label}</span>} />,
  );

describe("TC-RAIL-001 one card per record", () => {
  it.each([1, 3, 10, 100])("%i records make %i focusable cards", (n) => {
    const html = render(n);
    expect(html.match(/data-rail-card=""/g)).toHaveLength(n);
    expect(html.match(/tabindex="0"/g)).toHaveLength(n);
    expect(html).toContain(`Order ${n}`);
  });

  it("no records show the empty state, not an empty rail", () => {
    const html = render(0);
    expect(html).toContain("No active orders");
    expect(html).not.toContain("data-rail-card");
  });
});

describe("TC-RAIL-002 the bookmark card", () => {
  it("cuts the bite with a CSS mask (standard and -webkit-) and rests its artwork in grayscale", () => {
    const html = renderToStaticMarkup(
      <RailCard art={<span>art</span>} bloom="red" active={false}>
        content
      </RailCard>,
    );
    expect(html).toContain("mask-image:radial-gradient(16px at 50% 100%, transparent 15px, #000 16px)");
    expect(html).toContain("-webkit-mask-image:radial-gradient(16px at 50% 100%, transparent 15px, #000 16px)");
    expect(html).toContain("grayscale");
    expect(html).toContain("opacity-0");
  });

  it("an active card blooms: colour on the artwork and the glow at .8", () => {
    const html = renderToStaticMarkup(
      <RailCard art={<span>art</span>} bloom="red" active>
        content
      </RailCard>,
    );
    expect(html).toContain("grayscale-0");
    expect(html).toContain("saturate-[1.25]");
    expect(html).toContain("opacity-80");
    expect(html).toContain("mix-blend-screen");
  });
});
