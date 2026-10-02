import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import RestaurantSettingsPage from "@/app/restaurant/settings/page";
import { replaceOpeningHoursAction, updateOperationalSettingsAction, updateRestaurantProfileAction } from "@/app/restaurant/settings/actions";
import { SettingsTabs } from "@/components/settings/settings-tabs";
import type { RestaurantSettingsView } from "@/lib/services/restaurant-settings";
import { testDb } from "../setup/db";
import { asSeedUser, invokeAction, invokeLoader, seedOnce, tenantIdOf } from "../helpers/actors";
import { dataOf, errorOf, restoreRestaurant, snapshotRestaurant } from "./helpers";

/**
 * TC-REST-001 and TC-REST-007 — the settings screen (S1-P07-T005). The page is a Server Component, so it is rendered
 * through `invokeLoader` and asserted on what it hands the tabs: the restaurant as it is in the database, and which
 * parts of it this role may change.
 */
const db = testDb();
const A = tenantIdOf("A");

let snapshot: Awaited<ReturnType<typeof snapshotRestaurant>>;

beforeAll(async () => {
  await seedOnce();
  const restaurant = await db.restaurant.findUniqueOrThrow({ where: { tenantId: A }, select: { id: true } });
  snapshot = await snapshotRestaurant(restaurant.id);
}, 120_000);

afterAll(async () => {
  if (snapshot) await restoreRestaurant(snapshot);
});

function propsOf<P>(node: ReactNode, type: unknown): P | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = propsOf<P>(child, type);
      if (found) return found;
    }
    return undefined;
  }
  if (!isValidElement(node)) return undefined;
  const element = node as ReactElement<{ children?: ReactNode }>;
  if (element.type === type) return element.props as P;
  return propsOf<P>(element.props.children, type);
}

async function view(): Promise<RestaurantSettingsView> {
  const page = await invokeLoader(RestaurantSettingsPage);
  expect(isValidElement(page)).toBe(true);
  return propsOf<{ view: RestaurantSettingsView }>(page as ReactNode, SettingsTabs)!.view;
}

describe("TC-REST-001 the settings screen shows and saves real data", () => {
  it("shows the seeded restaurant, not a demo profile (BA-27)", async () => {
    await asSeedUser("A", "TENANT_ADMIN");
    const data = await view();

    const stored = await db.restaurant.findUniqueOrThrow({ where: { tenantId: A } });
    expect(data.restaurant.name).toBe(stored.name);
    expect(data.restaurant.timezone).toBe("Asia/Kolkata");
    expect(data.restaurant.currencyCode).toBe("INR");
    expect(JSON.stringify(data)).not.toMatch(/demo|lorem|example restaurant|placeholder/i);

    // Seven days, Monday first, in the shape SA-RST-03 accepts, so the editor round-trips.
    expect(data.hours.map((day) => day.dayOfWeek)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(data.kitchenSections.length).toBeGreaterThan(0);
    expect(data.canEdit).toEqual({ profile: true, settings: true, website: true, sections: true });
  });

  it("offers the choices the schema accepts, so nothing on screen can be refused for being unknown", async () => {
    await asSeedUser("A", "TENANT_ADMIN");
    const page = await invokeLoader(RestaurantSettingsPage);
    const tabs = propsOf<{ timeZones: { options: { value: string }[] }[]; currencies: { options: { value: string }[] }[]; countries: { options: { value: string }[] }[] }>(
      page as ReactNode,
      SettingsTabs,
    )!;
    const values = (groups: { options: { value: string }[] }[]) => groups.flatMap((group) => group.options.map((option) => option.value));
    expect(values(tabs.timeZones)).toContain("Asia/Kolkata");
    // Intl's canonical spelling is never offered on its own; the modern name replaces it.
    expect(values(tabs.timeZones)).not.toContain("Asia/Calcutta");
    expect(values(tabs.currencies)).toContain("INR");
    expect(values(tabs.countries)).toContain("IN");
  });

  it("saves an edit and shows it again on the next load", async () => {
    await asSeedUser("A", "TENANT_ADMIN");
    const before = await view();

    dataOf(
      await invokeAction(updateRestaurantProfileAction, {
        name: "Spice Route Kitchen",
        description: before.restaurant.description ?? "",
        phoneE164: "+918041234500",
        email: before.restaurant.email ?? "",
        addressLine1: before.restaurant.addressLine1 ?? "",
        addressLine2: "",
        city: "Bengaluru",
        region: before.restaurant.region ?? "",
        postalCode: before.restaurant.postalCode ?? "",
      }),
    );

    const after = await view();
    expect(after.restaurant.name).toBe("Spice Route Kitchen");
    expect(after.restaurant.phoneE164).toBe("+918041234500");
    expect(after.restaurant.city).toBe("Bengaluru");
  });

  it("keeps the currency locked once the restaurant has taken orders (INV-09)", async () => {
    await asSeedUser("A", "TENANT_ADMIN");
    const data = await view();
    expect(await db.order.count({ where: { tenantId: A } })).toBeGreaterThan(0);
    expect(data.currencyLocked).toBe(true);

    const refused = errorOf(
      await invokeAction(updateOperationalSettingsAction, {
        timezone: data.restaurant.timezone,
        currencyCode: "USD",
        countryCode: data.restaurant.countryCode,
        defaultOrderType: data.restaurant.defaultOrderType,
        autoPrintKot: data.restaurant.autoPrintKot,
        receiptFooter: data.restaurant.receiptFooter ?? "",
        gstin: data.restaurant.gstin ?? "",
      }),
    );
    expect(refused.code).toBe("CURRENCY_LOCKED");
  });

  it("refuses a week the editor would also refuse, on the shift that causes it", async () => {
    await asSeedUser("A", "TENANT_ADMIN");
    const days = Array.from({ length: 7 }, (_, index) => ({ dayOfWeek: index + 1, isClosed: true, shifts: [] as { opensAt: string; closesAt: string }[] }));
    days[0] = { dayOfWeek: 1, isClosed: false, shifts: [{ opensAt: "09:00", closesAt: "15:00" }, { opensAt: "14:00", closesAt: "22:00" }] };

    const overlapping = errorOf(await invokeAction(replaceOpeningHoursAction, { days }));
    expect(Object.keys(overlapping.fieldErrors ?? {}).some((key) => key.startsWith("days.0.shifts.1"))).toBe(true);

    // The same week without the overlap saves, and comes back in the shape the editor sent.
    days[0] = { dayOfWeek: 1, isClosed: false, shifts: [{ opensAt: "09:00", closesAt: "15:00" }, { opensAt: "19:00", closesAt: "01:00" }] };
    dataOf(await invokeAction(replaceOpeningHoursAction, { days }));
    const monday = (await view()).hours.find((day) => day.dayOfWeek === 1);
    expect(monday).toEqual({ dayOfWeek: 1, isClosed: false, shifts: [{ opensAt: "09:00", closesAt: "15:00" }, { opensAt: "19:00", closesAt: "01:00" }] });
  });
});

describe("TC-REST-007 roles that cannot change settings see them read-only", () => {
  it("MANAGER may read everything and change nothing here", async () => {
    await asSeedUser("A", "MANAGER");
    const data = await view();
    expect(data.restaurant.name).toBeTruthy();
    expect(data.canEdit).toEqual({ profile: false, settings: false, website: false, sections: false });
  });

  it("counter and kitchen staff are not shown settings at all (ADR-019, owner 2026-10-02)", async () => {
    // Staff see only their own work. A read-only copy of the restaurant's settings is not part of it, so the page
    // refuses them outright rather than rendering something they have no use for.
    for (const role of ["CASHIER", "KITCHEN", "WAITER"] as const) {
      await asSeedUser("A", role);
      expect(await invokeLoader(RestaurantSettingsPage), role).toEqual({ redirect: "/account/forbidden" });
    }
  });

  it("the server refuses a save from a read-only role, whatever the page showed", async () => {
    await asSeedUser("A", "MANAGER");
    const refused = errorOf(await invokeAction(updateRestaurantProfileAction, { name: "Manager's rename" }));
    expect(refused.code).toBe("FORBIDDEN");
    expect(await db.restaurant.count({ where: { tenantId: A, name: "Manager's rename" } })).toBe(0);
  });
});
