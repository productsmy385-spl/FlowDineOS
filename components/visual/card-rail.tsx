"use client";

import * as React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/ui/cn";

/**
 * FlowDineOS card rail (owner brief 2026-10-07 §2–24, §33) — the shared interaction for order and kitchen rails.
 *
 * A rail holds however many real records it is given: 0, 1, 25 or 200 — nothing is ever sliced to a "three-card" demo.
 * Only the rail scrolls sideways (native scroll: trackpad, wheel with Shift, drag on touch, snap); the page never
 * does. ← / → buttons appear only when there is more to see. Every card is focusable: ←/→ move between cards,
 * Enter/Space open one. Hover, keyboard focus or a tap make a card the active one: it lifts (translateY −6 %,
 * scale 1.04) while the others recede (scale .96, opacity .58). Cards that arrive after the first render — a new order,
 * a new ticket — rise in and carry a brief highlight. Reduced motion keeps every state but drops the movement.
 */

export type RailCardState = { active: boolean; receding: boolean; fresh: boolean };

const EASE = "duration-[600ms] ease-[cubic-bezier(.22,1,.36,1)] motion-reduce:transition-none";

export function CardRail<T>({
  items,
  keyOf,
  label,
  renderCard,
  onOpen,
  cardClassName,
  empty,
}: {
  items: readonly T[];
  keyOf: (item: T) => string;
  label: string;
  renderCard: (item: T, state: RailCardState) => React.ReactNode;
  /** Enter / Space on a focused card. */
  onOpen?: (item: T) => void;
  /** Width of one slot, e.g. phone 82 %, tablet 15rem, desktop 18rem. */
  cardClassName?: string;
  empty?: React.ReactNode;
}) {
  const railRef = React.useRef<HTMLUListElement>(null);
  const [active, setActive] = React.useState<string | null>(null);
  const [edges, setEdges] = React.useState({ start: true, end: true });

  // Which cards are new since the rail first rendered: they rise in and are highlighted for a few seconds.
  const seen = React.useRef<Set<string> | null>(null);
  const [fresh, setFresh] = React.useState<Set<string>>(new Set());
  React.useEffect(() => {
    const keys = items.map(keyOf);
    if (seen.current === null) {
      seen.current = new Set(keys);
      return;
    }
    const arrived = keys.filter((k) => !seen.current!.has(k));
    keys.forEach((k) => seen.current!.add(k));
    if (arrived.length === 0) return;
    setFresh((current) => new Set([...current, ...arrived]));
    const timer = window.setTimeout(() => setFresh((current) => new Set([...current].filter((k) => !arrived.includes(k)))), 4000);
    return () => window.clearTimeout(timer);
  }, [items, keyOf]);

  const measure = React.useCallback(() => {
    const el = railRef.current;
    if (el) setEdges({ start: el.scrollLeft <= 4, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 4 });
  }, []);
  React.useEffect(() => {
    measure();
    const el = railRef.current;
    if (!el) return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure, items.length]);

  const page = (direction: 1 | -1) => {
    const el = railRef.current;
    if (el) el.scrollBy({ left: direction * el.clientWidth * 0.8, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLUListElement>) => {
    const cards = [...(railRef.current?.querySelectorAll<HTMLElement>("[data-rail-card]") ?? [])];
    const index = cards.indexOf(document.activeElement as HTMLElement);
    if (index < 0) return;
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      const next = cards[Math.min(cards.length - 1, Math.max(0, index + (event.key === "ArrowRight" ? 1 : -1)))];
      next?.focus();
      next?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
    } else if ((event.key === "Enter" || event.key === " ") && onOpen && event.target === cards[index]) {
      event.preventDefault();
      onOpen(items[index]);
    }
  };

  if (items.length === 0) return <>{empty}</>;

  return (
    <div className="relative min-w-0">
      <ul
        ref={railRef}
        aria-label={label}
        onScroll={measure}
        onKeyDown={onKeyDown}
        className="-mx-4 flex snap-x snap-proximity list-none gap-4 overflow-x-auto overscroll-x-contain px-4 pb-6 pt-6 [scrollbar-width:thin] sm:mx-0 sm:px-1"
      >
        {items.map((item) => {
          const key = keyOf(item);
          const isActive = active === key;
          return (
            <li
              key={key}
              data-rail-card=""
              tabIndex={0}
              onMouseEnter={() => setActive(key)}
              onMouseLeave={() => setActive((current) => (current === key ? null : current))}
              onFocus={() => setActive(key)}
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node)) setActive((current) => (current === key ? null : current));
              }}
              onClick={() => setActive(key)}
              // Receding cards are dimmed on purpose; marked like the other decorative dimming for accessibility checks.
              data-ring-dimmed={active !== null && !isActive ? "" : undefined}
              className={cn(
                "relative shrink-0 snap-start rounded-3xl outline-none transition-[transform,opacity] focus-visible:ring-2 focus-visible:ring-focus-ring",
                EASE,
                "w-[82%] sm:w-60 lg:w-72",
                cardClassName,
                fresh.has(key) && "rise-in",
                isActive ? "z-10 motion-safe:-translate-y-[6%] motion-safe:scale-[1.04]" : active !== null ? "opacity-[.58] motion-safe:scale-[.96]" : "",
              )}
            >
              {renderCard(item, { active: isActive, receding: active !== null && !isActive, fresh: fresh.has(key) })}
            </li>
          );
        })}
      </ul>
      {!edges.start && (
        <button type="button" onClick={() => page(-1)} aria-label={`Scroll ${label} back`} className="absolute left-0 top-1/2 z-20 hidden size-11 -translate-y-1/2 items-center justify-center rounded-full border border-border-strong bg-card text-fg-primary shadow-e2 hover:bg-raised sm:flex">
          <ChevronLeft aria-hidden className="size-5" />
        </button>
      )}
      {!edges.end && (
        <button type="button" onClick={() => page(1)} aria-label={`Scroll ${label} forward`} className="absolute right-0 top-1/2 z-20 hidden size-11 -translate-y-1/2 items-center justify-center rounded-full border border-border-strong bg-card text-fg-primary shadow-e2 hover:bg-raised sm:flex">
          <ChevronRight aria-hidden className="size-5" />
        </button>
      )}
    </div>
  );
}

/**
 * One bookmark-tab card: a semicircular bite out of its lower edge (a CSS mask, so artwork and content are clipped by
 * it too), artwork that rests in grayscale and blooms into colour when the card is active — a blurred, screen-blended
 * glow that lights the artwork from within rather than a panel laid over it.
 */
const BITE = "radial-gradient(16px at 50% 100%, transparent 15px, #000 16px)";

export function RailCard({
  art,
  bloom,
  active,
  fresh = false,
  accent = "neutral",
  children,
}: {
  /** The artwork: a dish photo or an icon illustration. */
  art: React.ReactNode;
  /** The bloom's colour, as a CSS colour or gradient. */
  bloom: string;
  active: boolean;
  fresh?: boolean;
  accent?: "neutral" | "danger" | "success" | "warning";
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex h-full flex-col overflow-hidden rounded-3xl border bg-card pb-6",
        accent === "danger" ? "border-status-danger/60" : accent === "success" ? "border-status-success/50" : accent === "warning" ? "border-status-warning/50" : "border-border-subtle",
        fresh && "ring-2 ring-action-primary/70",
      )}
      style={{ maskImage: BITE, WebkitMaskImage: BITE }}
    >
      <div className="relative h-28 overflow-hidden sm:h-32">
        <div aria-hidden className={cn("absolute inset-0 transition-[filter]", EASE, active ? "grayscale-0 saturate-[1.25]" : "grayscale contrast-[1.05]")}>
          {art}
        </div>
        <div
          aria-hidden
          className={cn("absolute -inset-4 mix-blend-screen blur-[7px] saturate-[1.3] transition-opacity", EASE, active ? "opacity-80" : "opacity-0")}
          style={{ background: bloom }}
        />
      </div>
      <div className="flex flex-1 flex-col gap-3 p-4">{children}</div>
    </div>
  );
}
