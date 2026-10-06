/**
 * The 3D menu ring's geometry and motion (owner brief 2026-10-06 §13), as plain functions so they can be tested.
 *
 * For card i of a ring of `slots` positions turned by `rotation`:
 *   a = rotation + (i / slots) · TAU
 *   x = sin(a) · R          z = cos(a) · R          y = −cos(a) · R · 0.42   (the tilt follows z; no separate y motion)
 *   depth = (z / R + 1) / 2            0 at the back, 1 at the front
 *   transform: translate(−50%, −50%) translate3d(x, y, 0) rotate(sin(a) · 14deg) scale(0.55 + depth · 0.55)
 *   opacity 0.30 + depth · 0.70        brightness 0.5 + depth · 0.7
 * and R = 0.62 · min(stage width, stage height). One sin and one cos per card per frame — nothing more.
 */

export const RING_CAPACITY = 22;
export const TAU = Math.PI * 2;
/** Radians per pixel of horizontal drag, and the idle spin the ring settles back into (radians per frame). */
export const DRAG_GAIN = 0.0045;
export const IDLE_SPIN = 0.0045;
/** How quickly a throw eases back to the idle spin, per frame. */
export const SETTLE = 0.02;

export type CardPose = { x: number; y: number; z: number; depth: number; transform: string; opacity: number; filter: string };

export function ringRadius(width: number, height: number): number {
  return 0.62 * Math.min(width, height);
}

export function cardPose(index: number, slots: number, rotation: number, radius: number): CardPose {
  const a = rotation + (index / slots) * TAU;
  const s = Math.sin(a);
  const c = Math.cos(a);
  const x = s * radius;
  const z = c * radius;
  const y = -c * radius * 0.42;
  const depth = radius === 0 ? 1 : (z / radius + 1) / 2;
  return {
    x,
    y,
    z,
    depth,
    transform: `translate(-50%, -50%) translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0) rotate(${(s * 14).toFixed(2)}deg) scale(${(0.55 + depth * 0.55).toFixed(4)})`,
    opacity: 0.3 + depth * 0.7,
    filter: `brightness(${(0.5 + depth * 0.7).toFixed(3)})`,
  };
}

/**
 * Stacking order for this frame: cards sorted by z ascending, each given its place in that order as its z-index, so
 * the front of the ring overlaps the back — CSS transforms alone would not.
 */
export function zIndexes(poses: readonly Pick<CardPose, "z">[]): number[] {
  const order = poses.map((pose, index) => ({ index, z: pose.z })).sort((p, q) => p.z - q.z);
  const result = new Array<number>(poses.length);
  order.forEach((entry, rank) => (result[entry.index] = rank + 1));
  return result;
}

/** The card closest to the viewer. */
export function frontIndex(poses: readonly Pick<CardPose, "z">[]): number {
  let best = 0;
  for (let i = 1; i < poses.length; i++) if (poses[i].z > poses[best].z) best = i;
  return best;
}

/** One frame of free spin after a release: keep the velocity, easing it toward the resting spin. */
export function settleVelocity(velocity: number, idle: number): number {
  return velocity + (idle - velocity) * SETTLE;
}

/**
 * Sizes the ring for its stage so that no card is ever clipped (owner review 2026-10-06: the carousel was cropped).
 *
 * The radius follows R = 0.62 · min(stage width, stage height) with the stage height capped for the viewport; if a
 * card at any angle — scaled and tilted as `cardPose` draws it — would then reach past the stage's sides, R is reduced
 * to the largest value that keeps every card inside. The stage height is then exactly what the ring needs vertically,
 * so the front card is never cut off at the top and the back cards never at the bottom.
 */
export function fitRing(stageWidth: number, card: { width: number; height: number }, options: { maxStageHeight?: number; padding?: number } = {}): { radius: number; height: number } {
  const pad = options.padding ?? 12;
  const halfWidth = stageWidth / 2 - pad;
  const stageHeight = Math.min(stageWidth * 0.62, options.maxStageHeight ?? 620);
  let radius = ringRadius(stageWidth, stageHeight);
  const steps = 90;
  const extent = (a: number) => {
    const s = 0.55 + 0.55 * ((Math.cos(a) + 1) / 2);
    const tilt = Math.abs((Math.sin(a) * 14 * Math.PI) / 180);
    return {
      halfW: (s * (card.width * Math.cos(tilt) + card.height * Math.sin(tilt))) / 2,
      halfH: (s * (card.width * Math.sin(tilt) + card.height * Math.cos(tilt))) / 2,
    };
  };
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI;
    const sin = Math.abs(Math.sin(a));
    if (sin < 0.01) continue;
    radius = Math.min(radius, Math.max(0, (halfWidth - extent(a).halfW) / sin));
  }
  let halfHeight = 0;
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI;
    halfHeight = Math.max(halfHeight, Math.abs(Math.cos(a)) * radius * 0.42 + extent(a).halfH);
  }
  return { radius, height: Math.ceil(2 * (halfHeight + pad)) };
}

/** The rotation that brings card `index` to the front (a = 0 there, since z = cos(a)·R is largest at a = 0). */
export function rotationToFront(index: number, slots: number, current: number): number {
  const target = -(index / slots) * TAU;
  // Take the short way round from where the ring is now.
  const turns = Math.round((current - target) / TAU);
  return target + turns * TAU;
}
