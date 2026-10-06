"use client";

import * as React from "react";
import { ChevronLeft, ChevronRight, UtensilsCrossed } from "lucide-react";
import type { PublicCategoryData, PublicMenuItemData } from "@/lib/data/public-restaurant";
import { cn } from "@/lib/ui/cn";
import { formatMoney } from "@/lib/ui/format";
import { DRAG_GAIN, IDLE_SPIN, RING_CAPACITY, cardPose, frontIndex, ringRadius, rotationToFront, settleVelocity, zIndexes } from "@/lib/ui/menu-ring";
import { DietaryMark, SiteImage, menuIconFor } from "./primitives";
import type { MenuFormatting } from "./menu";

/**
 * The 3D rolodex menu (owner brief 2026-10-06 §13) — one reusable component for every restaurant's public menu.
 *
 * - Real menu items only. A category with more than 22 dishes is shown 22 at a time ("1–22", "23–44"); one with fewer
 *   spreads its real dishes evenly round the ring; one or two dishes are simply shown as cards, never padded out.
 * - One requestAnimationFrame loop drives every card through refs — no React render per frame, no loop per card — and
 *   pauses while the ring is off screen or the tab is hidden.
 * - Drag (mouse, pen, touch) spins it with momentum that eases back to a slow idle spin. `touch-action: pan-y` leaves
 *   vertical swipes to the page, so the ring never traps scrolling; a horizontal trackpad swipe turns it too.
 * - Keyboard: the ring is focusable; ← and → bring the previous/next dish to the front, and the front dish is
 *   announced. Every dish is also in a plain list for screen readers.
 * - prefers-reduced-motion: no idle spin and no throw; arrows and buttons still step through the dishes.
 */

type Group = { id: string; name: string; items: PublicMenuItemData[] };

/** Splits categories into ring-sized groups of real dishes. */
function ringGroups(categories: readonly PublicCategoryData[]): Group[] {
  return categories.flatMap((category) => {
    const items = category.items;
    if (items.length <= RING_CAPACITY) return items.length ? [{ id: category.id, name: category.name, items }] : [];
    const pages: Group[] = [];
    for (let start = 0; start < items.length; start += RING_CAPACITY) {
      const end = Math.min(start + RING_CAPACITY, items.length);
      pages.push({ id: `${category.id}:${start}`, name: `${category.name} ${start + 1}–${end}`, items: items.slice(start, end) });
    }
    return pages;
  });
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState(false);
  React.useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

export function MenuRing({ categories, formatting, title = "Menu" }: { categories: readonly PublicCategoryData[]; formatting: MenuFormatting; title?: string }) {
  const groups = React.useMemo(() => ringGroups(categories), [categories]);
  const [groupId, setGroupId] = React.useState(groups[0]?.id ?? "");
  const group = groups.find((g) => g.id === groupId) ?? groups[0];
  if (!group) return null;

  return (
    <section aria-label={`${title}: dish carousel`} className="flex min-w-0 flex-col gap-4">
      {groups.length > 1 && (
        <div role="tablist" aria-label="Menu sections" className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none]">
          {groups.map((g) => (
            <button
              key={g.id}
              type="button"
              role="tab"
              aria-selected={g.id === group.id}
              onClick={() => setGroupId(g.id)}
              className={cn(
                "h-10 shrink-0 rounded-full border px-4 text-label transition-colors",
                g.id === group.id ? "border-transparent bg-action-primary text-action-primary-fg" : "border-border-strong bg-card text-fg-primary hover:bg-raised",
              )}
            >
              {g.name}
            </button>
          ))}
        </div>
      )}
      {/* Remount per group: a fresh ring, rotation and card refs for each set of dishes. */}
      <Ring key={group.id} items={group.items} formatting={formatting} groupName={group.name} />
    </section>
  );
}

function Ring({ items, formatting, groupName }: { items: readonly PublicMenuItemData[]; formatting: MenuFormatting; groupName: string }) {
  const reduced = usePrefersReducedMotion();
  const stageRef = React.useRef<HTMLDivElement>(null);
  const cardRefs = React.useRef<(HTMLDivElement | null)[]>([]);
  const [front, setFront] = React.useState(0);
  const motion = React.useRef({ rotation: 0, velocity: 0, dragging: false, lastX: 0, pointerId: -1, target: null as number | null, front: 0, radius: 0 });
  const slots = items.length;
  const ring = slots >= 3;

  // The one animation loop.
  React.useEffect(() => {
    if (!ring) return;
    const stage = stageRef.current;
    if (!stage) return;
    const m = motion.current;
    m.velocity = reduced ? 0 : IDLE_SPIN;
    let frame = 0;
    let visible = true;

    const measure = () => {
      m.radius = ringRadius(stage.clientWidth, stage.clientHeight);
    };
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(stage);

    const tick = () => {
      if (m.target !== null) {
        // A keyboard/button step: glide to the chosen dish (or jump, with reduced motion).
        const gap = m.target - m.rotation;
        m.rotation = reduced || Math.abs(gap) < 0.001 ? m.target : m.rotation + gap * 0.18;
        if (m.rotation === m.target) m.target = null;
      } else if (!m.dragging) {
        m.rotation += m.velocity;
        m.velocity = settleVelocity(m.velocity, reduced ? 0 : IDLE_SPIN);
      }
      const poses = items.map((_, i) => cardPose(i, slots, m.rotation, m.radius));
      const order = zIndexes(poses);
      poses.forEach((pose, i) => {
        const el = cardRefs.current[i];
        if (!el) return;
        el.style.transform = pose.transform;
        el.style.opacity = pose.opacity.toFixed(3);
        el.style.filter = pose.filter;
        el.style.zIndex = String(order[i]);
      });
      const nowFront = frontIndex(poses);
      if (nowFront !== m.front) {
        m.front = nowFront;
        setFront(nowFront);
      }
      frame = visible && !document.hidden ? requestAnimationFrame(tick) : 0;
    };

    const resume = () => {
      if (!frame && visible && !document.hidden) frame = requestAnimationFrame(tick);
    };
    const io = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      resume();
    });
    io.observe(stage);
    document.addEventListener("visibilitychange", resume);
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      io.disconnect();
      resize.disconnect();
      document.removeEventListener("visibilitychange", resume);
    };
  }, [items, slots, reduced, ring]);

  const step = (direction: 1 | -1) => {
    const m = motion.current;
    const next = (m.front + direction + slots) % slots;
    m.velocity = 0;
    m.target = rotationToFront(next, slots, m.rotation);
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const m = motion.current;
    m.dragging = true;
    m.velocity = 0;
    m.target = null;
    m.lastX = event.clientX;
    m.pointerId = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const m = motion.current;
    if (!m.dragging || event.pointerId !== m.pointerId) return;
    const dx = event.clientX - m.lastX;
    m.lastX = event.clientX;
    m.rotation += dx * DRAG_GAIN;
    m.velocity = dx * DRAG_GAIN;
  };
  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const m = motion.current;
    if (event.pointerId !== m.pointerId) return;
    m.dragging = false;
    if (reduced) m.velocity = 0;
  };
  const onWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    // Only a sideways swipe turns the ring; an ordinary vertical wheel keeps scrolling the page.
    if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
    const m = motion.current;
    m.target = null;
    m.rotation -= event.deltaX * DRAG_GAIN * 0.5;
    m.velocity = reduced ? 0 : -event.deltaX * DRAG_GAIN * 0.05;
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      step(-1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      step(1);
    }
  };

  const current = items[Math.min(front, items.length - 1)];

  if (!ring) {
    return (
      <ul className="grid list-none grid-cols-1 gap-4 p-0 sm:grid-cols-2">
        {items.map((item) => (
          <li key={item.id} className="flex justify-center">
            <RingCard item={item} formatting={formatting} className="relative" />
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div
        ref={stageRef}
        tabIndex={0}
        role="group"
        aria-roledescription="carousel"
        aria-label={`${groupName}. Drag, or use the left and right arrow keys, to turn the menu.`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onWheel={onWheel}
        onKeyDown={onKeyDown}
        className="relative h-[22rem] w-full cursor-grab touch-pan-y select-none overflow-hidden rounded-3xl outline-none focus-visible:ring-2 focus-visible:ring-focus-ring active:cursor-grabbing sm:h-[26rem] lg:h-[30rem]"
      >
        {items.map((item, i) => (
          <div
            key={item.id}
            ref={(el) => {
              cardRefs.current[i] = el;
            }}
            aria-hidden
            className="absolute left-1/2 top-1/2 will-change-transform"
            style={{ transform: "translate(-50%, -50%) scale(0.55)", opacity: 0 }}
          >
            <RingCard item={item} formatting={formatting} />
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between gap-3">
        <button type="button" onClick={() => step(1)} aria-label="Previous dish" className="flex size-11 shrink-0 items-center justify-center rounded-full border border-border-strong bg-card text-fg-primary hover:bg-raised">
          <ChevronLeft className="size-5" aria-hidden />
        </button>
        <div className="min-w-0 flex-1 text-center" aria-live="polite">
          <p className="truncate text-subheading text-fg-primary">{current.name}</p>
          <p className="text-caption text-fg-secondary">
            {formatMoney(current.price, formatting.currencyCode, formatting.locale)}
            {current.isAvailable ? "" : " · Unavailable today"}
          </p>
        </div>
        <button type="button" onClick={() => step(-1)} aria-label="Next dish" className="flex size-11 shrink-0 items-center justify-center rounded-full border border-border-strong bg-card text-fg-primary hover:bg-raised">
          <ChevronRight className="size-5" aria-hidden />
        </button>
      </div>

      <ul className="sr-only">
        {items.map((item) => (
          <li key={item.id}>
            {item.name}, {formatMoney(item.price, formatting.currencyCode, formatting.locale)}
            {item.dietaryType ? `, ${item.dietaryType.toLowerCase().replace(/_/g, " ")}` : ""}
            {item.isAvailable ? "" : ", unavailable today"}
            {item.description ? `. ${item.description}` : ""}
          </li>
        ))}
      </ul>
    </div>
  );
}

function RingCard({ item, formatting, className }: { item: PublicMenuItemData; formatting: MenuFormatting; className?: string }) {
  return (
    <article className={cn("flex w-44 flex-col overflow-hidden rounded-2xl border border-border-subtle bg-card sm:w-52", className)}>
      <SiteImage src={item.imageUrl} alt="" displayWidth={240} fallbackIcon={menuIconFor(item.iconKey) ?? UtensilsCrossed} className="pointer-events-none aspect-[4/3] w-full" />
      <div className="flex flex-col gap-1 p-3">
        <h3 className="line-clamp-2 break-words text-label text-fg-primary">{item.name}</h3>
        <div className="flex items-center justify-between gap-2">
          <span className="text-numeric text-label text-fg-accent">{formatMoney(item.price, formatting.currencyCode, formatting.locale)}</span>
          <DietaryMark dietaryType={item.dietaryType} />
        </div>
      </div>
    </article>
  );
}

