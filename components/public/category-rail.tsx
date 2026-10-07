"use client";

import * as React from "react";
import { UtensilsCrossed } from "lucide-react";
import { SiteImage, menuIconFor } from "./primitives";

/** One card per real menu category; the photo is the first dish photo in that category, if any. */
export type RailCategory = { id: string; name: string; itemCount: number; imageUrl: string | null; iconKey: string | null };

/**
 * The table QR menu's category rail (owner brief 2026-10-07; styles `.menu-rail*` in app/globals.css). It replaces the
 * menu ring on the table page and is only a way in: every card links to its category's section below, which holds the
 * actual dishes as ordinary headed lists, so nothing is reachable only through the rail.
 *
 * - Hover or keyboard focus opens a card; arrow keys move between cards; Enter (or Space) follows the link.
 * - Touch: the first tap opens a card, a tap on the open card goes to its section. There is no auto-advance — guests
 *   scroll and tap at their own pace.
 * - Any number of categories: the rail scrolls sideways and never widens the page.
 */
export function CategoryRail({ categories, labelledBy }: { categories: readonly RailCategory[]; labelledBy: string }) {
  const [open, setOpen] = React.useState(0);
  const lastPointer = React.useRef<string>("mouse");
  const links = React.useRef<Array<HTMLAnchorElement | null>>([]);

  function moveFocus(from: number, step: number) {
    const next = (from + step + categories.length) % categories.length;
    const target = links.current[next];
    if (!target) return;
    target.focus();
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView({ block: "nearest", inline: "nearest", behavior: reduced ? "auto" : "smooth" });
  }

  return (
    <div className="menu-rail" data-testid="category-rail">
      <ul className="menu-rail__track" aria-labelledby={labelledBy}>
        {categories.map((category, index) => {
          const isOpen = index === open;
          const dishes = `${category.itemCount} ${category.itemCount === 1 ? "dish" : "dishes"}`;
          return (
            <li key={category.id} className="menu-rail__item">
              <a
                ref={(element) => {
                  links.current[index] = element;
                }}
                href={`#menu-${category.id}`}
                className="menu-rail__card"
                data-open={isOpen}
                aria-label={`${category.name}, ${dishes}`}
                onPointerDown={(event) => {
                  lastPointer.current = event.pointerType;
                }}
                onPointerEnter={(event) => {
                  if (event.pointerType === "mouse") setOpen(index);
                }}
                onFocus={() => setOpen(index)}
                onClick={(event) => {
                  // On touch the first tap only opens the card; the link is followed from an open card.
                  if (lastPointer.current !== "mouse" && !isOpen) {
                    event.preventDefault();
                    setOpen(index);
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                    event.preventDefault();
                    moveFocus(index, 1);
                  } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                    event.preventDefault();
                    moveFocus(index, -1);
                  } else if (event.key === " ") {
                    event.preventDefault();
                    event.currentTarget.click();
                  }
                }}
              >
                <SiteImage src={category.imageUrl} alt="" displayWidth={640} fallbackIcon={menuIconFor(category.iconKey) ?? UtensilsCrossed} className="menu-rail__art" />
                <span className="menu-rail__scrim" aria-hidden />
                <span className="menu-rail__closed-label text-caption" aria-hidden>
                  {category.name}
                </span>
                <span className="menu-rail__caption" aria-hidden>
                  <span className="menu-rail__caption-name text-heading">{category.name}</span>
                  <span className="block text-caption">{dishes}</span>
                </span>
              </a>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
