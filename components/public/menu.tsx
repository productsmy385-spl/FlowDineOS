import { UtensilsCrossed } from "lucide-react";
import type { PublicCategoryData, PublicMenuItemData } from "@/lib/data/public-restaurant";
import { cn } from "@/lib/ui/cn";
import { formatMoney } from "@/lib/ui/format";
import { DietaryMark, SectionEmpty, SiteImage, menuIconFor } from "./primitives";

/**
 * Menu presentation for the public website (S1-P09-T003).
 *
 * Every value comes from the LD-PUB-01 projection: a price is the restaurant's own two-decimal string formatted in its
 * currency and country locale, "from" appears only when a cheaper variant genuinely exists, and an item that is sold
 * out says so instead of disappearing. Nothing is padded out with sample dishes.
 */

export type MenuFormatting = { currencyCode: string; locale: string };

/** The lowest price a guest can actually pay for the item: its base price, or a cheaper variant when there is one. */
export function priceLabel(item: PublicMenuItemData, { currencyCode, locale }: MenuFormatting): { amount: string; from: boolean } {
  const prices = [item.price, ...item.variants.map((variant) => variant.price)];
  const lowest = prices.reduce((min, price) => (Number(price) < Number(min) ? price : min), item.price);
  return { amount: formatMoney(lowest, currencyCode, locale), from: prices.some((price) => Number(price) > Number(lowest)) };
}

export function MenuItemCard({ item, formatting }: { item: PublicMenuItemData; formatting: MenuFormatting }) {
  const price = priceLabel(item, formatting);

  return (
    <article
      className={cn(
        // w-full: the card fills its grid cell, so every card in a row is the same width however long its text is.
        "flex w-full flex-col overflow-hidden rounded-2xl border border-border-subtle bg-card",
        !item.isAvailable && "opacity-80",
      )}
    >
      <SiteImage src={item.imageUrl} alt={item.name} displayWidth={400} fallbackIcon={menuIconFor(item.iconKey) ?? UtensilsCrossed} className="aspect-[4/3] w-full" />
      <div className="flex flex-1 flex-col gap-2 p-4">
        <div className="flex items-start justify-between gap-3">
          <h3 className="min-w-0 break-words text-subheading" style={{ color: "var(--website-heading-color)" }}>{item.name}</h3>
          <p className="text-numeric text-subheading whitespace-nowrap" style={{ color: "var(--website-price-color)" }}>
            {price.from ? <span className="text-caption" style={{ color: "var(--website-muted-text-color)" }}>from </span> : null}
            {price.amount}
          </p>
        </div>
        {item.description ? <p className="break-words text-body" style={{ color: "var(--website-muted-text-color)" }}>{item.description}</p> : null}
        {item.variants.length > 0 ? (
          <p className="text-caption" style={{ color: "var(--website-muted-text-color)" }}>
            {item.variants.map((variant) => `${variant.name} ${formatMoney(variant.price, formatting.currencyCode, formatting.locale)}`).join(" · ")}
          </p>
        ) : null}
        {item.addOns.length > 0 ? (
          <p className="text-caption" style={{ color: "var(--website-muted-text-color)" }}>
            Add: {item.addOns.map((addOn) => `${addOn.name} ${formatMoney(addOn.price, formatting.currencyCode, formatting.locale)}`).join(" · ")}
          </p>
        ) : null}
        <div className="mt-auto flex flex-wrap items-center gap-2 pt-2">
          <DietaryMark dietaryType={item.dietaryType} />
          {item.isAvailable ? null : (
            <span className="inline-flex h-6 items-center rounded-full bg-status-danger/12 px-2.5 text-caption text-status-danger">Unavailable today</span>
          )}
        </div>
      </div>
    </article>
  );
}

/** design.md §6.2: one column on a phone, two from 768 px, three from 1024 px. */
export function MenuItemGrid({ items, formatting, labelledBy }: { items: readonly PublicMenuItemData[]; formatting: MenuFormatting; labelledBy?: string }) {
  return (
    <ul aria-labelledby={labelledBy} className="grid list-none grid-cols-1 gap-4 p-0 md:grid-cols-2 lg:grid-cols-3">
      {items.map((item) => (
        <li key={item.id} className="flex">
          <MenuItemCard item={item} formatting={formatting} />
        </li>
      ))}
    </ul>
  );
}

export function CategoryBlock({ category, formatting }: { category: PublicCategoryData; formatting: MenuFormatting }) {
  const headingId = `category-${category.id}`;
  return (
    <section aria-labelledby={headingId} id={`menu-${category.id}`} className="flex scroll-mt-24 flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h3 id={headingId} className="break-words text-heading" style={{ color: "var(--website-section-heading-color)" }}>
          {category.name}
        </h3>
        {category.description ? <p className="text-body" style={{ color: "var(--website-muted-text-color)" }}>{category.description}</p> : null}
      </div>
      {category.items.length === 0 ? (
        <SectionEmpty icon={UtensilsCrossed}>No dishes are published in {category.name} yet.</SectionEmpty>
      ) : (
        <MenuItemGrid items={category.items} formatting={formatting} labelledBy={headingId} />
      )}
    </section>
  );
}
