import { describe, expect, it } from "vitest";
import { toXlsx } from "@/lib/data-portability/tabular";
import { readXlsxTable } from "@/lib/data-portability/xlsx-read";
import { cardPose, fitRing } from "@/lib/ui/menu-ring";

// TC-ADR22-020…022 — the no-crop ring stage and the spreadsheet reader (RASOIOS-ADR-022).

describe("TC-ADR22-020 the ring never crops a card", () => {
  it.each([320, 375, 390, 414, 768, 1024, 1280, 1440, 1920])("at %ipx every card, at every angle, stays inside the stage", (width) => {
    const card = { width: Math.round(Math.min(220, Math.max(112, width * 0.32))), height: Math.round(Math.min(220, Math.max(112, width * 0.32)) * 0.75 + 76) };
    const { radius, height } = fitRing(width, card, { maxStageHeight: 630 });
    expect(radius).toBeGreaterThan(0);
    for (let i = 0; i < 22; i++) {
      for (const rotation of [0, 0.07, 0.31, 1.2, 2.9]) {
        const pose = cardPose(i, 22, rotation, radius);
        const scale = 0.55 + pose.depth * 0.55;
        const tilt = Math.abs((Math.sin(rotation + (i / 22) * Math.PI * 2) * 14 * Math.PI) / 180);
        const halfW = (scale * (card.width * Math.cos(tilt) + card.height * Math.sin(tilt))) / 2;
        const halfH = (scale * (card.width * Math.sin(tilt) + card.height * Math.cos(tilt))) / 2;
        expect(Math.abs(pose.x) + halfW).toBeLessThanOrEqual(width / 2 + 0.5);
        expect(Math.abs(pose.y) + halfH).toBeLessThanOrEqual(height / 2 + 0.5);
      }
    }
  });

  it("keeps the owner's formula where it fits: R = 0.62 · min(stage width, stage height)", () => {
    const { radius } = fitRing(4000, { width: 100, height: 140 }, { maxStageHeight: 400 });
    expect(radius).toBeCloseTo(0.62 * 400);
  });
});

describe("TC-ADR22-021 Excel files read back as text", () => {
  it("reads our own workbook: header, numbers as written, and text with entities", () => {
    const book = toXlsx([{ name: "Menu", columns: ["Name", "Price"], rows: [["Fish & Chips <large>", "240.50"], ["=bad", "0"]] }]);
    expect(readXlsxTable(book)).toEqual({ columns: ["Name", "Price"], rows: [["Fish & Chips <large>", "240.50"], ["=bad", "0"]] });
  });
});
