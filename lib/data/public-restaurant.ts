import "server-only";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db/prisma";
import { NotFoundError } from "@/lib/errors";
import { businessDateFor, isOpenAt, toIsoDate, type Shift } from "@/lib/time";
import { SLUG_PATTERN } from "@/lib/validation/core";
import { businessDateDto, moneyDto } from "./dto";
import { mapErrors } from "./errors";

/**
 * Public website projection (LD-PUB-01 / LD-PUB-02; S1-P09-T002). No authentication: the tenant is resolved by its
 * public slug for this read-only projection only (api.md §7, security.md SC-PUB-01/SC-PUB-02).
 *
 * - Visible only when TENANT.status = ACTIVE and RESTAURANT.website_published = true. An unknown slug, a suspended tenant
 *   and an unpublished website all throw the same NotFoundError (TC-WEB-004, no oracle).
 * - Only published, non-archived categories and items; only available, non-archived variants and add-ons. An item that
 *   is sold out is shown with `isAvailable: false` and nothing more.
 * - Opening hours are the restaurant's own week, and `openNow` is evaluated in the restaurant's IANA time zone, never
 *   the server's or the viewer's (TC-TZ-002).
 * - `dailyMenu` is the PUBLISHED daily menu whose business date is *today in the restaurant's time zone* — a
 *   restaurant in Asia/Kolkata and one in America/New_York flip at their own midnight (TC-DMENU-005, TC-TZ-003).
 * - An explicit `select` means private columns (GSTIN, receipt footer, SEO/operational settings, tenant id) are never
 *   even read. Contact fields are included only when their show flag is true.
 *
 * Two queries per page render (the restaurant and its menu, then today's daily menu, which needs the time zone the
 * first query returns): within the ≤ 3 budget of S1-P09-T002.
 */

export interface PublicMenuItemData {
  id: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  /** Curated Lucide key for the icon fallback when there is no photo (design.md §5.1). */
  iconKey: string | null;
  /** Two-decimal string (ADR-010). */
  price: string;
  isAvailable: boolean;
  dietaryType: string | null;
  variants: Array<{ id: string; name: string; price: string; isDefault: boolean }>;
  addOns: Array<{ id: string; name: string; price: string }>;
}

export interface PublicCategoryData {
  id: string;
  name: string;
  description: string | null;
  iconKey: string | null;
  sortOrder: number;
  items: PublicMenuItemData[];
}

export interface PublicOpeningDay {
  /** ISO weekday, 1 = Monday. */
  dayOfWeek: number;
  isClosed: boolean;
  shifts: Array<{ opensAt: string; closesAt: string }>;
}

export interface PublicDailyMenuData {
  /** `YYYY-MM-DD` in the restaurant's time zone. */
  businessDate: string;
  title: string | null;
  note: string | null;
  items: PublicMenuItemData[];
}

export interface PublicRestaurantData {
  slug: string;
  timezone: string;
  currencyCode: string;
  countryCode: string;
  restaurant: {
    name: string;
    logoUrl: string | null;
    coverImageUrl: string | null;
    description: string | null;
    address: string | null;
    email: string | null;
    phone: string | null;
  };
  hours: PublicOpeningDay[];
  openNow: boolean;
  dailyMenu: PublicDailyMenuData | null;
  categories: PublicCategoryData[];
  /** Items ordered most often in the last {@link POPULAR_WINDOW_DAYS} days, measured — never curated by hand. */
  popularItems: PublicMenuItemData[];
}

const NOT_FOUND_MESSAGE = "Restaurant not found.";

/** How far back "most ordered" looks, and how many items it returns. */
export const POPULAR_WINDOW_DAYS = 60;
const POPULAR_LIMIT = 6;

/** The one item shape every public surface uses: the menu, today's menu and the share page. */
const ITEM_SELECT = {
  id: true,
  name: true,
  description: true,
  imageUrl: true,
  iconKey: true,
  basePrice: true,
  isAvailable: true,
  dietaryType: true,
  variants: {
    where: { archivedAt: null, isAvailable: true },
    orderBy: [{ displayOrder: "asc" }, { name: "asc" }],
    select: { id: true, name: true, price: true, isDefault: true },
  },
  addons: {
    where: { archivedAt: null, isAvailable: true },
    orderBy: [{ displayOrder: "asc" }, { name: "asc" }],
    select: { id: true, name: true, price: true },
  },
} satisfies Prisma.MenuItemSelect;

type ItemRow = Prisma.MenuItemGetPayload<{ select: typeof ITEM_SELECT }>;

function itemDto(item: ItemRow): PublicMenuItemData {
  return {
    id: item.id,
    name: item.name,
    description: item.description,
    imageUrl: item.imageUrl,
    iconKey: item.iconKey,
    price: moneyDto(item.basePrice),
    isAvailable: item.isAvailable,
    dietaryType: item.dietaryType,
    variants: item.variants.map((variant) => ({
      id: variant.id,
      name: variant.name,
      price: moneyDto(variant.price),
      isDefault: variant.isDefault,
    })),
    addOns: item.addons.map((addon) => ({ id: addon.id, name: addon.name, price: moneyDto(addon.price) })),
  };
}

/** TIME(0) columns come back as 1970-01-01 UTC instants (mirrors `lib/data/restaurant.ts`). */
const hhmm = (value: Date | null) => (value ? value.toISOString().slice(11, 16) : null);

type HoursRow = { dayOfWeek: number; sequence: number; isClosed: boolean; opensAt: Date | null; closesAt: Date | null };

/** Seven days, Monday first. A day with no open shift is closed — nothing is invented for a missing row. */
function toWeek(rows: readonly HoursRow[]): PublicOpeningDay[] {
  return Array.from({ length: 7 }, (_, index) => {
    const dayOfWeek = index + 1;
    const shifts = rows
      .filter((row) => row.dayOfWeek === dayOfWeek && !row.isClosed && row.opensAt !== null && row.closesAt !== null)
      .sort((a, b) => a.sequence - b.sequence)
      .map((row) => ({ opensAt: hhmm(row.opensAt)!, closesAt: hhmm(row.closesAt)! }));
    return { dayOfWeek, isClosed: shifts.length === 0, shifts };
  });
}

/** The flat shift list `lib/time/opening-hours` evaluates (overnight shifts included). */
export function shiftsOf(week: readonly PublicOpeningDay[]): Shift[] {
  return week.flatMap((day): Shift[] =>
    day.isClosed
      ? [{ dayOfWeek: day.dayOfWeek, isClosed: true, opensAt: null, closesAt: null }]
      : day.shifts.map((shift) => ({ dayOfWeek: day.dayOfWeek, isClosed: false, opensAt: shift.opensAt, closesAt: shift.closesAt })),
  );
}

/**
 * LD-PUB-01 — everything the public website of `slug` may show, plus LD-PUB-02's daily menu for today.
 * `now` is injectable so the business-date and open-now boundaries are testable; it defaults to the wall clock.
 */
export type PublicAudience = "website" | "table";

export async function getPublicRestaurant(slug: string, now: Date = new Date(), audience: PublicAudience = "website"): Promise<PublicRestaurantData> {
  if (typeof slug !== "string" || !SLUG_PATTERN.test(slug)) throw new NotFoundError(NOT_FOUND_MESSAGE);

  const tenant = await mapErrors("Restaurant", () =>
    db.tenant.findFirst({
      // A table's QR menu (audience "table") is for guests already seated in the restaurant: it needs the Table QR
      // feature, not a published website (owner request 2026-10-07). The website itself still needs both.
      where: audience === "table" ? { slug, status: "ACTIVE", features: { none: { featureKey: "QR_MENU", enabled: false } } } : { slug, status: "ACTIVE", restaurant: { is: { websitePublished: true } }, features: { none: { featureKey: "WEBSITE", enabled: false } } },
      select: {
        id: true,
        slug: true,
        restaurant: {
          select: {
            name: true,
            description: true,
            logoUrl: true,
            coverImageUrl: true,
            phoneE164: true,
            email: true,
            addressLine1: true,
            addressLine2: true,
            city: true,
            region: true,
            postalCode: true,
            countryCode: true,
            timezone: true,
            currencyCode: true,
            showPhone: true,
            showEmail: true,
            showAddress: true,
            websitePublished: true,
            // Composite FK to (tenant_id, id): a restaurant can only ever reach its own tenant's hours.
            hours: { select: { dayOfWeek: true, sequence: true, isClosed: true, opensAt: true, closesAt: true } },
          },
        },
        menuCategories: {
          where: { isPublished: true, archivedAt: null },
          orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
          select: {
            id: true,
            name: true,
            description: true,
            iconKey: true,
            sortOrder: true,
            items: {
              where: { isPublished: true, archivedAt: null },
              orderBy: [{ displayOrder: "asc" }, { name: "asc" }],
              select: ITEM_SELECT,
            },
          },
        },
      },
    }),
  );

  const restaurant = tenant?.restaurant;
  if (!tenant || !restaurant || (audience === "website" && !restaurant.websitePublished)) throw new NotFoundError(NOT_FOUND_MESSAGE);

  const address = restaurant.showAddress
    ? [restaurant.addressLine1, restaurant.addressLine2, restaurant.city, restaurant.region, restaurant.postalCode]
        .filter((part): part is string => Boolean(part))
        .join(", ") || null
    : null;

  const hours = toWeek(restaurant.hours);
  const categories: PublicCategoryData[] = tenant.menuCategories.map((category) => ({
    id: category.id,
    name: category.name,
    description: category.description,
    iconKey: category.iconKey,
    sortOrder: category.sortOrder,
    items: category.items.map(itemDto),
  }));

  // Both extras are drawn from the menu already projected above, so nothing can appear on the page that the published
  // menu itself hides (TC-WEB-003, ADV-025).
  const visible = new Map(categories.flatMap((category) => category.items.map((item) => [item.id, item] as const)));
  const [dailyMenu, popularItems] = await Promise.all([
    loadPublishedDailyMenu(tenant.id, restaurant.timezone, now, visible),
    loadPopularItems(tenant.id, visible, now),
  ]);

  return {
    slug: tenant.slug,
    timezone: restaurant.timezone,
    currencyCode: restaurant.currencyCode,
    countryCode: restaurant.countryCode,
    restaurant: {
      name: restaurant.name,
      logoUrl: restaurant.logoUrl,
      coverImageUrl: restaurant.coverImageUrl,
      description: restaurant.description,
      address,
      email: restaurant.showEmail ? restaurant.email : null,
      phone: restaurant.showPhone ? restaurant.phoneE164 : null,
    },
    hours,
    openNow: isOpenAt(shiftsOf(hours), now, restaurant.timezone),
    dailyMenu,
    categories,
    popularItems,
  };
}

/**
 * "Most ordered" measured from the restaurant's own order lines, so the section is real data or nothing. Cancelled
 * and refunded orders do not count, and the result is intersected with the menu already projected above — an item the
 * restaurant has since unpublished, archived or deleted can never reappear here, and no second item query is issued.
 * Nothing about an order, a customer or a time of sale leaves this function: only the menu items, in rank order.
 */
async function loadPopularItems(tenantId: string, visible: ReadonlyMap<string, PublicMenuItemData>, now: Date): Promise<PublicMenuItemData[]> {
  if (visible.size === 0) return [];

  const since = new Date(now.getTime() - POPULAR_WINDOW_DAYS * 86_400_000);
  const rows = await mapErrors("Menu", () =>
    db.orderItem.groupBy({
      by: ["menuItemId"],
      where: { tenantId, createdAt: { gte: since }, menuItemId: { in: [...visible.keys()] }, order: { is: { status: { notIn: ["CANCELLED", "REFUNDED"] } } } },
      _sum: { quantity: true },
    }),
  );

  return rows
    .map((row) => ({ item: visible.get(row.menuItemId)!, quantity: row._sum.quantity ?? 0 }))
    .filter((row) => row.quantity > 0)
    .sort((a, b) => b.quantity - a.quantity || a.item.name.localeCompare(b.item.name))
    .slice(0, POPULAR_LIMIT)
    .map((row) => row.item);
}

/**
 * LD-PUB-02 — the PUBLISHED daily menu whose business date is today in `timezone`, or null. A DRAFT or UNPUBLISHED
 * menu, yesterday's menu and tomorrow's menu are all invisible.
 *
 * The listed items are resolved against `visible`, the menu this page is already showing, so an item that has since
 * been unpublished or archived — or whose category has — drops out of today's menu too, instead of reappearing here
 * with a price the restaurant has withdrawn (TC-WEB-003, ADV-025). The menu row itself is still returned, so the page
 * can say "today's menu has nothing left on it" rather than pretend no menu was published.
 */
async function loadPublishedDailyMenu(
  tenantId: string,
  timezone: string,
  now: Date,
  visible: ReadonlyMap<string, PublicMenuItemData>,
): Promise<PublicDailyMenuData | null> {
  const businessDate = businessDateFor(now, timezone);
  const menu = await mapErrors("Daily menu", () =>
    db.dailyMenu.findFirst({
      where: { tenantId, status: "PUBLISHED", businessDate },
      select: {
        businessDate: true,
        title: true,
        note: true,
        items: { orderBy: [{ displayOrder: "asc" }], select: { menuItemId: true } },
      },
    }),
  );
  if (!menu) return null;
  return {
    businessDate: businessDateDto(menu.businessDate),
    title: menu.title,
    note: menu.note,
    items: menu.items.map((row) => visible.get(row.menuItemId)).filter((item): item is PublicMenuItemData => item !== undefined),
  };
}

/** The business date of `now` in `timezone`, as `YYYY-MM-DD` — what the daily-menu page labels itself with. */
export function publicBusinessDate(timezone: string, now: Date = new Date()): string {
  return toIsoDate(businessDateFor(now, timezone));
}

/**
 * LD-PUB-03 — every slug whose public website is visible right now (ACTIVE tenant, published website), for the
 * sitemap. Slugs only: the sitemap is a list of addresses, not a projection of restaurant data.
 */
export async function listPublicSiteSlugs(): Promise<Array<{ slug: string; updatedAt: Date }>> {
  const tenants = await mapErrors("Restaurant", () =>
    db.tenant.findMany({
      where: { status: "ACTIVE", restaurant: { is: { websitePublished: true } }, features: { none: { featureKey: "WEBSITE", enabled: false } } },
      orderBy: { slug: "asc" },
      select: { slug: true, restaurant: { select: { updatedAt: true } } },
    }),
  );
  return tenants.map((tenant) => ({ slug: tenant.slug, updatedAt: tenant.restaurant?.updatedAt ?? new Date(0) }));
}
