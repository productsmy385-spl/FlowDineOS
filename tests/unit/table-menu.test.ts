import { describe, expect, it } from "vitest";
import type { PublicCategoryData, PublicMenuItemData, PublicOpeningDay } from "@/lib/data/public-restaurant";
import { defaultPreferenceFor } from "@/lib/ui/theme";
import { tableMenuModel } from "@/lib/ui/table-menu";

// TC-QRM-001…005 — the table QR menu is built only from the restaurant's own data (owner brief 2026-10-07).
const item = (id: string, isAvailable = true): PublicMenuItemData => ({
  id,
  name: `Dish ${id}`,
  description: null,
  imageUrl: null,
  iconKey: null,
  price: "100.00",
  isAvailable,
  dietaryType: null,
  variants: [],
  addOns: [],
});
const category = (id: string, items: PublicMenuItemData[], sortOrder = 0): PublicCategoryData => ({ id, name: `Category ${id}`, description: null, iconKey: null, sortOrder, items });
const week = (open: boolean): PublicOpeningDay[] => Array.from({ length: 7 }, (_, i) => ({ dayOfWeek: i + 1, isClosed: !open, shifts: open ? [{ opensAt: "09:00", closesAt: "22:00" }] : [] }));
const base = { dailyMenu: null, hours: week(true), openNow: true };

describe("TC-QRM-001 categories are exactly the restaurant's, in its order", () => {
  it.each([1, 2, 5, 10, 23])("%i categories in, %i categories out — no fixed count", (count) => {
    const categories = Array.from({ length: count }, (_, i) => category(`c${i}`, [item(`i${i}`)], i));
    const model = tableMenuModel({ ...base, categories });
    expect(model.categories.map((c) => c.id)).toEqual(categories.map((c) => c.id));
  });

  it("leaves sold-out dishes off and drops a category with nothing available", () => {
    const model = tableMenuModel({ ...base, categories: [category("a", [item("1"), item("2", false)]), category("b", [item("3", false)])] });
    expect(model.categories.map((c) => c.id)).toEqual(["a"]);
    expect(model.categories[0].items.map((i) => i.id)).toEqual(["1"]);
    expect(model.hasCategories).toBe(true);
  });

  it("tells 'menu being prepared' (no categories) from 'nothing available'", () => {
    expect(tableMenuModel({ ...base, categories: [] }).hasCategories).toBe(false);
  });
});

describe("TC-QRM-002 today's menu is the published one or nothing", () => {
  it("with no published daily menu, today is empty — never filled with other dishes", () => {
    const model = tableMenuModel({ ...base, categories: [category("a", [item("1")])] });
    expect(model.today).toEqual({ state: "none" });
  });

  it("groups today's dishes under their real categories in menu order, skipping sold-out ones", () => {
    const categories = [category("starters", [item("s1"), item("s2")]), category("mains", [item("m1"), item("m2", false)])];
    const dailyMenu = { businessDate: "2026-10-07", title: "Thursday", note: null, items: [item("m1"), item("s2"), item("m2", false)] };
    const model = tableMenuModel({ ...base, categories, dailyMenu });
    expect(model.today).toEqual({
      state: "published",
      title: "Thursday",
      note: null,
      groups: [
        { id: "starters", name: "Category starters", items: [item("s2")] },
        { id: "mains", name: "Category mains", items: [item("m1")] },
      ],
    });
  });
});

describe("TC-QRM-003 'closed' only when the restaurant set hours and is outside them", () => {
  it.each([
    [true, true, false],
    [true, false, true],
    [false, false, false], // no hours configured: unknown, not closed
  ])("hours set %s, open now %s → closed %s", (hasHours, openNow, closed) => {
    expect(tableMenuModel({ categories: [], dailyMenu: null, hours: week(hasHours), openNow }).closed).toBe(closed);
  });
});

describe("TC-THEME-010 marketing pages follow the system theme on a first visit; consoles stay dark-first", () => {
  it.each([
    ["/", "SYSTEM"],
    ["/book-demo", "SYSTEM"],
    ["/privacy", "SYSTEM"],
    ["/terms", "SYSTEM"],
    ["/restaurant/orders", "DARK"],
    ["/sign-in", "DARK"],
  ])("%s → %s", (path, expected) => {
    expect(defaultPreferenceFor(path)).toBe(expected);
  });
});
