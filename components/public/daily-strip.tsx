"use client";

import { UtensilsCrossed } from "lucide-react";
import type { PublicMenuItemData } from "@/lib/data/public-restaurant";
import { formatMoney } from "@/lib/ui/format";
import { FolderCard, FolderRail } from "@/components/visual/folder-card";
import type { MenuFormatting } from "./menu";
import { DietaryMark, SiteImage, menuIconFor } from "./primitives";

/**
 * "Published today" as a rail of folder cards (owner brief 2026-10-06 §49) — deliberately unlike the main menu's 3D
 * ring, so a guest tells "the whole menu" from "what is on today" at a glance. Only the restaurant's real published
 * daily-menu items are passed in; there is no filler. Each card's gradient is the restaurant's own theme colours, and
 * its object is the dish's own photo (or its chosen icon when it has none).
 */
const GRADIENT = "linear-gradient(140deg, var(--site-primary) 0%, var(--site-secondary) 55%, var(--site-accent) 100%)";

export function DailyStrip({ items, formatting, labelledBy }: { items: readonly PublicMenuItemData[]; formatting: MenuFormatting; labelledBy?: string }) {
  return (
    <div data-testid="daily-strip" aria-labelledby={labelledBy} className="min-w-0">
      <FolderRail
        items={items}
        label="Today's dishes"
        keyOf={(item) => item.id}
        render={(item, state) => (
          <FolderCard
            gradient={GRADIENT}
            title={item.name}
            label={item.isAvailable ? "Today" : "Sold out"}
            detail={
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-numeric">{formatMoney(item.price, formatting.currencyCode, formatting.locale)}</span>
                <DietaryMark dietaryType={item.dietaryType} />
              </span>
            }
            active={state.active}
            dimmed={state.dimmed}
            onActivate={state.activate}
            onDeactivate={state.deactivate}
            object={
              <SiteImage
                src={item.imageUrl}
                alt=""
                displayWidth={320}
                fallbackIcon={menuIconFor(item.iconKey) ?? UtensilsCrossed}
                className="aspect-square w-full rounded-full border-4 border-white/70 object-cover shadow-e2"
              />
            }
          />
        )}
      />
    </div>
  );
}
