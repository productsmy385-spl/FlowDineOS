"use client";

import * as React from "react";
import { cn } from "@/lib/ui/cn";

/**
 * The folder card (owner brief 2026-10-06 §38–40, §49): four stacked layers —
 *   1. an iridescent gradient,
 *   2. a cut-out object (a dish photo, or an illustration on the landing page),
 *   3. a folder face shaped by a real SVG mask: a white rectangle with a black path cutting the tab notch,
 *   4. a small label.
 * Active (hover, keyboard focus, or tap): the card lifts (translateY −7 %, scale 1.07), the face slides down 52 %, the
 * object rises and tilts (translate −50 % / −4 %, rotate 3°) and the label fades. Its neighbours recede (scale .93,
 * opacity .6, saturate .6) — set by the rail through `dimmed`. 0.6 s on cubic-bezier(.22,1,.36,1); none at all under
 * prefers-reduced-motion. Content never depends on the motion: the title and detail are always on the face.
 */
export type FolderCardProps = {
  /** Background of layer 1 (any CSS background). */
  gradient: string;
  /** Layer 2: the object that lifts out of the folder. */
  object: React.ReactNode;
  /** Layer 4: a short tag on the face that fades when the card opens. */
  label?: string;
  title: string;
  detail?: React.ReactNode;
  active: boolean;
  dimmed: boolean;
  onActivate: () => void;
  onDeactivate?: () => void;
  className?: string;
};

const EASE = "transition-[transform,opacity,filter] duration-[600ms] ease-[cubic-bezier(.22,1,.36,1)] motion-reduce:transition-none";

export function FolderCard({ gradient, object, label, title, detail, active, dimmed, onActivate, onDeactivate, className }: FolderCardProps) {
  const maskId = React.useId().replace(/:/g, "");
  return (
    <div
      role="group"
      tabIndex={0}
      aria-label={title}
      onMouseEnter={onActivate}
      onMouseLeave={onDeactivate}
      onFocus={onActivate}
      onBlur={onDeactivate}
      onClick={onActivate}
      data-active={active || undefined}
      // Receding cards are dimmed on purpose; marked like the menu ring's back cards so the readable state is the one checked.
      data-ring-dimmed={dimmed && !active ? "" : undefined}
      className={cn(
        "relative aspect-[4/5] w-full cursor-pointer rounded-3xl outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
        EASE,
        active ? "z-10 motion-safe:-translate-y-[7%] motion-safe:scale-[1.07]" : dimmed ? "motion-safe:scale-[.93] opacity-60 saturate-[.6]" : "",
        className,
      )}
    >
      {/* 1. iridescent gradient */}
      <div aria-hidden className="absolute inset-0 overflow-hidden rounded-3xl" style={{ background: gradient }}>
        <div className="absolute inset-0 bg-[conic-gradient(from_200deg_at_70%_20%,rgb(255_255_255/0.35),transparent_30%,rgb(255_255_255/0.18)_55%,transparent_75%)] mix-blend-overlay" />
      </div>

      {/* 2. the object, above the gradient and behind the face */}
      <div
        aria-hidden
        className={cn("absolute left-1/2 top-6 w-[72%] -translate-x-1/2", EASE, active && "motion-safe:-translate-y-[4%] motion-safe:rotate-[3deg]")}
      >
        {object}
      </div>

      {/* 3. the folder face: an SVG mask cuts the tab notch out of a plain rectangle */}
      <div className={cn("absolute inset-x-0 bottom-0 h-[58%] overflow-hidden rounded-b-3xl", EASE, active && "motion-safe:translate-y-[52%]")}>
        <svg aria-hidden className="absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none">
          <defs>
            <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">
              <rect x="0" y="0" width="100" height="100" fill="white" />
              {/* The notch: everything right of the tab, above its shoulder, is cut away. */}
              <path d="M44 0 C 48 0 49 9 54 9 L 100 9 L 100 0 Z" fill="black" />
            </mask>
          </defs>
          <rect x="0" y="0" width="100" height="100" className="fill-card" mask={`url(#${maskId})`} />
        </svg>
        <div className="relative flex h-full flex-col justify-start gap-1 px-4 pt-10">
          <p className="line-clamp-2 break-words text-subheading text-fg-primary">{title}</p>
          {detail ? <div className="text-label text-fg-accent">{detail}</div> : null}
        </div>
      </div>

      {/* 4. the label */}
      {label ? (
        <span className={cn("absolute left-4 top-4 rounded-full bg-card/90 px-2.5 py-0.5 text-caption text-fg-primary", EASE, active && "opacity-0")}>{label}</span>
      ) : null}
    </div>
  );
}

/**
 * A rail of folder cards: three across on a desktop, two on a tablet, one with its neighbour peeking on a phone —
 * a native snap scroller, so swipe and momentum come from the browser. Exactly one card is active at a time; on a
 * touch screen the card in the middle of the rail is the active one, so nothing depends on hover.
 */
export function FolderRail<T>({ items, keyOf, render, label }: { items: readonly T[]; keyOf: (item: T) => string; render: (item: T, state: { active: boolean; dimmed: boolean; activate: () => void; deactivate: () => void }) => React.ReactNode; label: string }) {
  const [active, setActive] = React.useState<string | null>(null);
  const railRef = React.useRef<HTMLUListElement>(null);

  // Touch: the most visible card is the active one.
  React.useEffect(() => {
    const rail = railRef.current;
    if (!rail || !window.matchMedia("(hover: none)").matches) return;
    const io = new IntersectionObserver(
      (entries) => {
        const best = entries.filter((e) => e.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (best) setActive((best.target as HTMLElement).dataset.key ?? null);
      },
      { root: rail, threshold: [0.6, 0.9] },
    );
    rail.querySelectorAll("[data-key]").forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [items]);

  return (
    <ul
      ref={railRef}
      aria-label={label}
      tabIndex={-1}
      className="-mx-4 flex snap-x snap-mandatory list-none gap-5 overflow-x-auto px-4 pb-10 pt-8 [scrollbar-width:none] md:-mx-6 md:px-6 [&::-webkit-scrollbar]:hidden"
    >
      {items.map((item) => {
        const key = keyOf(item);
        return (
          <li key={key} data-key={key} className="w-[72%] shrink-0 snap-center sm:w-[44%] lg:w-[31%]">
            {render(item, {
              active: active === key,
              dimmed: active !== null && active !== key,
              activate: () => setActive(key),
              deactivate: () => setActive((current) => (current === key && !window.matchMedia("(hover: none)").matches ? null : current)),
            })}
          </li>
        );
      })}
    </ul>
  );
}
