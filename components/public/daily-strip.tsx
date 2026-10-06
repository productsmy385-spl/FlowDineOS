"use client";

import * as React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { PublicMenuItemData } from "@/lib/data/public-restaurant";
import { cn } from "@/lib/ui/cn";
import { MenuItemCard, type MenuFormatting } from "./menu";

/**
 * "Published today" as a swipe strip (owner review 2026-10-06): deliberately unlike the main menu's 3D ring, so a
 * guest can tell "the whole menu" from "what is on today" at a glance.
 *
 * A native horizontal scroller with snap points — touch swipe, trackpad and momentum come from the browser — plus
 * previous/next buttons for mouse and keyboard users. Cards rise in one after another when the strip first scrolls
 * into view, and lift on hover. Only the restaurant's real published daily-menu items are passed in; there is no
 * filler. Reduced motion: no entrance animation and no hover lift.
 */
export function DailyStrip({ items, formatting, labelledBy }: { items: readonly PublicMenuItemData[]; formatting: MenuFormatting; labelledBy?: string }) {
  const scroller = React.useRef<HTMLUListElement>(null);
  const [revealed, setRevealed] = React.useState(false);
  const [edges, setEdges] = React.useState({ start: true, end: items.length <= 1 });

  React.useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => entry.isIntersecting && setRevealed(true), { threshold: 0.2 });
    io.observe(el);
    const update = () => setEdges({ start: el.scrollLeft <= 4, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 4 });
    update();
    el.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      io.disconnect();
      el.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  const page = (direction: 1 | -1) => {
    const el = scroller.current;
    if (el) el.scrollBy({ left: direction * el.clientWidth * 0.85, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  };

  return (
    <div className="relative min-w-0" data-testid="daily-strip">
      <ul
        ref={scroller}
        aria-labelledby={labelledBy}
        className="-mx-4 flex snap-x snap-mandatory list-none gap-4 overflow-x-auto scroll-smooth px-4 pb-4 pt-2 [scrollbar-width:thin] motion-reduce:scroll-auto md:-mx-6 md:px-6"
      >
        {items.map((item, index) => (
          <li
            key={item.id}
            style={{ transitionDelay: revealed ? `${Math.min(index, 8) * 70}ms` : "0ms" }}
            className={cn(
              "flex w-[78%] shrink-0 snap-start sm:w-[45%] lg:w-[31%]",
              "transition-[transform,opacity] duration-500 ease-out motion-reduce:transition-none motion-safe:hover:-translate-y-1",
              revealed ? "translate-y-0 opacity-100" : "motion-safe:translate-y-6 motion-safe:opacity-0",
            )}
          >
            <MenuItemCard item={item} formatting={formatting} />
          </li>
        ))}
      </ul>
      {items.length > 1 && (
        <div className="mt-1 flex justify-end gap-2">
          <button type="button" onClick={() => page(-1)} disabled={edges.start} aria-label="Previous dishes" className="flex size-11 items-center justify-center rounded-full border border-border-strong bg-card text-fg-primary hover:bg-raised disabled:opacity-40">
            <ChevronLeft className="size-5" aria-hidden />
          </button>
          <button type="button" onClick={() => page(1)} disabled={edges.end} aria-label="More dishes" className="flex size-11 items-center justify-center rounded-full border border-border-strong bg-card text-fg-primary hover:bg-raised disabled:opacity-40">
            <ChevronRight className="size-5" aria-hidden />
          </button>
        </div>
      )}
    </div>
  );
}
