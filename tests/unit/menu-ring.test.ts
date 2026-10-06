import { describe, expect, it } from "vitest";
import { DRAG_GAIN, IDLE_SPIN, RING_CAPACITY, TAU, cardPose, frontIndex, ringRadius, rotationToFront, settleVelocity, zIndexes } from "@/lib/ui/menu-ring";

// TC-RING-001…004 — the 3D menu ring follows the owner's formulas exactly (owner brief 2026-10-06 §13).
describe("TC-RING-001 geometry", () => {
  it("has 22 positions and R = 0.62 × the smaller stage side", () => {
    expect(RING_CAPACITY).toBe(22);
    expect(ringRadius(800, 500)).toBeCloseTo(310);
    expect(ringRadius(360, 420)).toBeCloseTo(223.2);
  });

  it("places card i at a = rotation + i/n·TAU with x = sin a·R, z = cos a·R, y = −cos a·R·0.42", () => {
    const R = 300;
    const rotation = 0.37;
    for (const i of [0, 5, 11, 21]) {
      const a = rotation + (i / 22) * TAU;
      const pose = cardPose(i, 22, rotation, R);
      expect(pose.x).toBeCloseTo(Math.sin(a) * R, 9);
      expect(pose.z).toBeCloseTo(Math.cos(a) * R, 9);
      expect(pose.y).toBeCloseTo(-Math.cos(a) * R * 0.42, 9);
    }
  });

  it("front card: depth 1, full size, opaque and bright; back card: depth 0, small, dim and faint", () => {
    const front = cardPose(0, 22, 0, 300);
    expect(front.depth).toBeCloseTo(1);
    expect(front.opacity).toBeCloseTo(1);
    expect(front.filter).toBe("brightness(1.200)");
    expect(front.transform).toContain("scale(1.1000)");
    expect(front.transform.startsWith("translate(-50%, -50%) translate3d(")).toBe(true);

    const back = cardPose(11, 22, 0, 300);
    expect(back.depth).toBeCloseTo(0);
    expect(back.opacity).toBeCloseTo(0.3);
    expect(back.filter).toBe("brightness(0.500)");
    expect(back.transform).toContain("scale(0.5500)");
  });

  it("tilts each card by sin(a)·14 degrees", () => {
    expect(cardPose(0, 4, Math.PI / 2, 100).transform).toContain("rotate(14.00deg)");
  });
});

describe("TC-RING-002 depth sorting", () => {
  it("gives the nearest card the highest z-index and the farthest the lowest, every frame", () => {
    const poses = Array.from({ length: 22 }, (_, i) => cardPose(i, 22, 0.2, 300));
    const z = zIndexes(poses);
    expect(z[frontIndex(poses)]).toBe(22);
    expect(new Set(z).size).toBe(22);
    const farthest = poses.reduce((best, p, i) => (p.z < poses[best].z ? i : best), 0);
    expect(z[farthest]).toBe(1);
  });
});

describe("TC-RING-003 momentum", () => {
  it("a throw keeps spinning and eases toward the idle spin rather than stopping", () => {
    let velocity = 40 * DRAG_GAIN;
    const seen: number[] = [];
    for (let frame = 0; frame < 1000; frame++) {
      velocity = settleVelocity(velocity, IDLE_SPIN);
      seen.push(velocity);
    }
    expect(seen[10]).toBeGreaterThan(IDLE_SPIN);
    expect(seen.at(-1)).toBeCloseTo(IDLE_SPIN, 4);
  });

  it("with reduced motion the ring settles to a stop", () => {
    let velocity = 0.1;
    for (let frame = 0; frame < 600; frame++) velocity = settleVelocity(velocity, 0);
    expect(Math.abs(velocity)).toBeLessThan(1e-5);
  });
});

describe("TC-RING-004 stepping brings the chosen dish to the front", () => {
  it.each([0, 3, 7, 21])("dish %i ends up in front, the short way round", (index) => {
    const rotation = rotationToFront(index, 22, 5.1);
    expect(Math.abs(rotation - 5.1)).toBeLessThanOrEqual(Math.PI + 1e-9);
    const poses = Array.from({ length: 22 }, (_, i) => cardPose(i, 22, rotation, 300));
    expect(frontIndex(poses)).toBe(index);
  });
});
