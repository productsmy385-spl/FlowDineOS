import type { PublicCategoryData, PublicMenuItemData, PublicRestaurantData } from "@/lib/data/public-restaurant";

/**
 * What the table QR menu shows (owner brief 2026-10-07), derived only from the restaurant's own published data:
 *
 * - `categories`: the restaurant's categories in its own order, each with the dishes available right now. Sold-out
 *   dishes are left off (owner request 2026-10-07) and a category with nothing available is not shown.
 * - `today`: the PUBLISHED daily menu for today in the restaurant's time zone (the loader decides the date on the
 *   server). A daily menu has no sections of its own, so its dishes are grouped under their real menu categories, in
 *   menu order. `state: "none"` when nothing is published for today — never filled with other dishes.
 * - `closed`: only when the restaurant has opening hours and is outside them now; no hours set means "unknown", not
 *   "closed".
 */
export type TableMenuModel = {
  categories: PublicCategoryData[];
  /** True when the restaurant has published categories at all (to tell "being prepared" from "nothing available"). */
  hasCategories: boolean;
  today:
    | { state: "none" }
    | { state: "published"; title: string | null; note: string | null; groups: Array<{ id: string; name: string; items: PublicMenuItemData[] }> };
  closed: boolean;
};

type Input = Pick<PublicRestaurantData, "categories" | "dailyMenu" | "hours" | "openNow">;

export function tableMenuModel(site: Input): TableMenuModel {
  const categories = site.categories
    .map((category) => ({ ...category, items: category.items.filter((item) => item.isAvailable) }))
    .filter((category) => category.items.length > 0);

  let today: TableMenuModel["today"] = { state: "none" };
  if (site.dailyMenu) {
    const todayIds = new Set(site.dailyMenu.items.filter((item) => item.isAvailable).map((item) => item.id));
    const groups = categories
      .map((category) => ({ id: category.id, name: category.name, items: category.items.filter((item) => todayIds.has(item.id)) }))
      .filter((group) => group.items.length > 0);
    today = { state: "published", title: site.dailyMenu.title, note: site.dailyMenu.note, groups };
  }

  const hasHours = site.hours.some((day) => !day.isClosed);
  return { categories, hasCategories: site.categories.length > 0, today, closed: hasHours && !site.openNow };
}
