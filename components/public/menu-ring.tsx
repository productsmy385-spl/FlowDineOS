"use client";

import * as React from "react";
import { ChevronLeft, ChevronRight, UtensilsCrossed } from "lucide-react";
import type { PublicCategoryData, PublicMenuItemData } from "@/lib/data/public-restaurant";
import { cn } from "@/lib/ui/cn";
import { formatMoney } from "@/lib/ui/format";
import { DRAG_GAIN, IDLE_SPIN, cardPose, fitRing, frontIndex, rotationToFront, settleVelocity, zIndexes } from "@/lib/ui/menu-ring";
import { DietaryMark, SiteImage, menuIconFor } from "./primitives";
import type { MenuFormatting } from "./menu";
import { ShareButton } from "./share";

/**
 * The main menu as a 3D rolodex (owner brief 2026-10-06 §13; review of the cropped carousel, same day) — one reusable
 * component for every restaurant's public website and table menu. It *is* the main menu: no card grid repeats it.
 *
 * - Real dishes only, spread evenly round the ring by their real count (`i / count`). A section of more than 40 is
 *   shown 40 at a time; one or two dishes are shown as plain cards. Nothing is ever padded out.
 * - Never cropped: the stage measures its own width, sizes the cards for it and fits the radius so every card, at any
 *   angle, scale and tilt, stays inside (`fitRing`). The stage takes exactly the height the ring needs.
 * - One requestAnimationFrame loop drives every card through refs — no React render per frame — and pauses while
 *   the ring is off screen or the tab is hidden. Cards are re-stacked by depth every frame.
 * - Drag (mouse, pen, touch) spins it with momentum easing back to a slow idle spin; a tap brings a dish to the front.
 *   `touch-action: pan-y` leaves vertical swipes to the page, so the ring never traps scrolling.
 * - Keyboard: ← and → bring the previous/next dish to the front, which is announced. Every dish of every section is
 *   also in a plain list for screen readers and search engines.
 * - prefers-reduced-motion: no idle spin and no throw.
 */

/** The most dishes one ring shows; a larger section is paged rather than crowded. */
const MAX_PER_RING = 40;

type Group = { id: string; name: string; accent: string | null; items: PublicMenuItemData[] };

function ringGroups(categories: readonly PublicCategoryData[], accents: readonly string[]): Group[] {
  return categories.flatMap((category, index) => {
    const accent = accents.length ? accents[index % accents.length] : null;
    const items = category.items;
    if (items.length <= MAX_PER_RING) return items.length ? [{ id: category.id, name: category.name, accent, items }] : [];
    const pages: Group[] = [];
    for (let start = 0; start < items.length; start += MAX_PER_RING) {
      const end = Math.min(start + MAX_PER_RING, items.length);
      pages.push({ id: `${category.id}:${start}`, name: `${category.name} ${start + 1}–${end}`, accent, items: items.slice(start, end) });
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

export function MenuRing({
  categories,
  formatting,
  title = "Menu",
  accents = [],
  share,
}: {
  categories: readonly PublicCategoryData[];
  formatting: MenuFormatting;
  title?: string;
  /** The restaurant's own brand colours, one per menu section in turn. */
  accents?: readonly string[];
  /** Lets a guest share the dish in front: the restaurant's name and its public address (never an internal id). */
  share?: { restaurantName: string; url: string | null };
}) {
  const groups = React.useMemo(() => ringGroups(categories, accents), [categories, accents]);
  const [groupId, setGroupId] = React.useState(groups[0]?.id ?? "");
  const group = groups.find((g) => g.id === groupId) ?? groups[0];
  if (!group) return null;

  return (
    <section aria-label={`${title}: dish carousel`} className="flex min-w-0 flex-col gap-4" data-testid="menu-ring">
      {groups.length > 1 && (
        <div role="tablist" aria-label="Menu sections" className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none]">
          {groups.map((g) => (
            <button
              key={g.id}
              type="button"
              role="tab"
              aria-selected={g.id === group.id}
              onClick={() => setGroupId(g.id)}
              style={g.accent && g.id !== group.id ? { borderColor: g.accent } : undefined}
              className={cn(
                "h-10 shrink-0 rounded-full border-2 px-4 text-label transition-colors",
                g.id === group.id ? "border-transparent bg-action-primary text-action-primary-fg" : "border-border-strong bg-card text-fg-primary hover:bg-raised",
              )}
            >
              {g.name}
            </button>
          ))}
        </div>
      )}
      {/* Remount per section: a fresh ring, rotation and card refs for each set of dishes. */}
      <Ring key={group.id} items={group.items} formatting={formatting} groupName={group.name} accent={group.accent} share={share} />

      {/* The whole menu as text, for screen readers and search engines — the ring itself is a visual. */}
      <div className="sr-only">
        {categories.map((category) => (
          <section key={category.id} aria-label={category.name}>
            <h3>{category.name}</h3>
            <ul>
              {category.items.map((item) => (
                <li key={item.id}>
                  {item.name}, {formatMoney(item.price, formatting.currencyCode, formatting.locale)}
                  {item.dietaryType ? `, ${item.dietaryType.toLowerCase().replace(/_/g, " ")}` : ""}
                  {item.isAvailable ? "" : ", unavailable today"}
                  {item.description ? `. ${item.description}` : ""}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </section>
  );
}

/** Card width for a stage width: about a third of it on a phone, never smaller than readable or larger than a card. */
const cardWidthFor = (stageWidth: number) => Math.round(Math.min(220, Math.max(112, stageWidth * 0.32)));

function Ring({
  items,
  formatting,
  groupName,
  accent,
  share,
}: {
  items: readonly PublicMenuItemData[];
  formatting: MenuFormatting;
  groupName: string;
  accent: string | null;
  share?: { restaurantName: string; url: string | null };
}) {
  const reduced = usePrefersReducedMotion();
  const outerRef = React.useRef<HTMLDivElement>(null);
  const stageRef = React.useRef<HTMLDivElement>(null);
  const cardRefs = React.useRef<(HTMLDivElement | null)[]>([]);
  const [front, setFront] = React.useState(0);
  const [layout, setLayout] = React.useState<{ cardWidth: number; height: number } | null>(null);
  const motion = React.useRef({ rotation: 0, velocity: 0, dragging: false, lastX: 0, travelled: 0, pointerId: -1, target: null as number | null, front: 0, radius: 0 });
  const slots = items.length;
  const ring = slots >= 3;

  // Measure: the stage width decides the card size, the card size and width decide the radius and stage height.
  React.useLayoutEffect(() => {
    if (!ring) return;
    const outer = outerRef.current;
    if (!outer) return;
    const measure = () => {
      const width = outer.clientWidth;
      if (width === 0) return;
      const cardWidth = cardWidthFor(width);
      const sample = cardRefs.current.find(Boolean);
      // Until a card has rendered at this width, assume the 4:3 photo plus two text lines.
      const cardHeight = sample && sample.offsetWidth === cardWidth ? sample.offsetHeight : Math.round(cardWidth * 0.75 + 76);
      const maxStageHeight = Math.max(320, Math.round(window.innerHeight * 0.7));
      const { radius, height } = fitRing(width, { width: cardWidth, height: cardHeight }, { maxStageHeight });
      motion.current.radius = radius;
      setLayout((current) => (current && current.cardWidth === cardWidth && current.height === height ? current : { cardWidth, height }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(outer);
    // Card heights settle once fonts and images have laid out.
    const settle = window.setTimeout(measure, 300);
    return () => {
      observer.disconnect();
      window.clearTimeout(settle);
    };
  }, [ring, layout?.cardWidth]);

  // The one animation loop.
  React.useEffect(() => {
    if (!ring || !layout) return;
    const stage = stageRef.current;
    if (!stage) return;
    const m = motion.current;
    m.velocity = reduced ? 0 : IDLE_SPIN;
    let frame = 0;
    let visible = true;

    const tick = () => {
      if (m.target !== null) {
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
        // Cards turned away are dimmed on purpose; marked so it is clear they are the visual, not the readable menu.
        el.toggleAttribute("data-ring-dimmed", pose.depth < 0.9);
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
      document.removeEventListener("visibilitychange", resume);
    };
  }, [items, slots, reduced, ring, layout]);

  const bringToFront = (index: number) => {
    const m = motion.current;
    m.velocity = 0;
    m.target = rotationToFront(index, slots, m.rotation);
  };
  const step = (direction: 1 | -1) => bringToFront((motion.current.front + direction + slots) % slots);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const m = motion.current;
    m.dragging = true;
    m.velocity = 0;
    m.target = null;
    m.lastX = event.clientX;
    m.travelled = 0;
    m.pointerId = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const m = motion.current;
    if (!m.dragging || event.pointerId !== m.pointerId) return;
    const dx = event.clientX - m.lastX;
    m.lastX = event.clientX;
    m.travelled += Math.abs(dx);
    m.rotation += dx * DRAG_GAIN;
    m.velocity = dx * DRAG_GAIN;
  };
  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const m = motion.current;
    if (event.pointerId !== m.pointerId) return;
    m.dragging = false;
    if (reduced) m.velocity = 0;
    // A tap, not a drag: bring the dish under the finger to the front.
    if (event.type === "pointerup" && m.travelled < 6) {
      const hit = document.elementsFromPoint(event.clientX, event.clientY).find((el) => el instanceof HTMLElement && el.dataset.ringIndex !== undefined) as HTMLElement | undefined;
      if (hit) bringToFront(Number(hit.dataset.ringIndex));
    }
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

  if (!ring) {
    return (
      <ul className="grid list-none grid-cols-1 gap-4 p-0 sm:grid-cols-2">
        {items.map((item) => (
          <li key={item.id} className="flex justify-center">
            <RingCard item={item} formatting={formatting} accent={accent} />
          </li>
        ))}
      </ul>
    );
  }

  const current = items[Math.min(front, items.length - 1)];

  return (
    <div ref={outerRef} className="flex w-full min-w-0 flex-col gap-4">
      <div
        ref={stageRef}
        tabIndex={0}
        role="group"
        aria-roledescription="carousel"
        aria-label={`${groupName}. Drag, tap a dish, or use the left and right arrow keys to turn the menu.`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onWheel={onWheel}
        onKeyDown={onKeyDown}
        style={{ height: layout?.height ?? 360 }}
        className="relative w-full cursor-grab touch-pan-y select-none overflow-hidden rounded-3xl outline-none focus-visible:ring-2 focus-visible:ring-focus-ring active:cursor-grabbing"
      >
        {items.map((item, i) => (
          <div
            key={item.id}
            ref={(el) => {
              cardRefs.current[i] = el;
            }}
            data-ring-index={i}
            aria-hidden
            className="absolute left-1/2 top-1/2 will-change-transform"
            style={{ width: layout?.cardWidth, transform: "translate(-50%, -50%) scale(0.55)", opacity: 0 }}
          >
            <RingCard item={item} formatting={formatting} accent={accent} />
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between gap-3">
        <button type="button" onClick={() => step(1)} aria-label="Previous dish" className="flex size-11 shrink-0 items-center justify-center rounded-full border border-border-strong bg-card text-fg-primary hover:bg-raised">
          <ChevronLeft className="size-5" aria-hidden />
        </button>
        <div className="min-w-0 flex-1 text-center" aria-live="polite" data-testid="ring-front">
          <p className="truncate text-subheading text-fg-primary">{current.name}</p>
          <p className="text-caption text-fg-secondary">
            {formatMoney(current.price, formatting.currencyCode, formatting.locale)}
            {current.isAvailable ? "" : " · Unavailable today"}
          </p>
          {current.description ? <p className="mx-auto mt-1 line-clamp-2 max-w-prose text-caption text-fg-secondary">{current.description}</p> : null}
          {share ? (
            <ShareButton
              className="mt-2 h-9"
              label="Share this dish"
              content={{
                title: current.name,
                text: `Try our ${current.name} at ${share.restaurantName}\n${formatMoney(current.price, formatting.currencyCode, formatting.locale)}`,
                url: share.url ? `${share.url.replace(/\/$/, "")}/#menu` : null,
                imageUrl: current.imageUrl,
              }}
            />
          ) : null}
        </div>
        <button type="button" onClick={() => step(-1)} aria-label="Next dish" className="flex size-11 shrink-0 items-center justify-center rounded-full border border-border-strong bg-card text-fg-primary hover:bg-raised">
          <ChevronRight className="size-5" aria-hidden />
        </button>
      </div>
    </div>
  );
}

function RingCard({ item, formatting, accent }: { item: PublicMenuItemData; formatting: MenuFormatting; accent: string | null }) {
  return (
    <article className="flex w-full flex-col overflow-hidden rounded-2xl border border-border-subtle bg-card" style={accent ? { borderTop: `4px solid ${accent}` } : undefined}>
      <SiteImage src={item.imageUrl} alt="" displayWidth={240} fallbackIcon={menuIconFor(item.iconKey) ?? UtensilsCrossed} className="pointer-events-none aspect-[4/3] w-full" />
      <div className="flex flex-col gap-1 p-3">
        <h3 className="line-clamp-2 break-words text-label text-fg-primary">{item.name}</h3>
        <div className="flex flex-wrap items-center justify-between gap-1">
          <span className="text-numeric text-label text-fg-accent">{formatMoney(item.price, formatting.currencyCode, formatting.locale)}</span>
          <DietaryMark dietaryType={item.dietaryType} />
        </div>
      </div>
    </article>
  );
}
