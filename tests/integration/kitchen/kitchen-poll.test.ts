import { beforeAll, describe, expect, it } from "vitest";
import { GET } from "@/app/api/v1/kitchen/tickets/route";
import { updateKOTStatusAction } from "@/app/restaurant/kds/actions";
import { testDb } from "../setup/db";
import { asAnonymous, asSeedUser, invokeAction, invokeRoute, seedOnce, tenantIdOf } from "../helpers/actors";
import { dataOf } from "../orders/helpers";

// TC-KITCH-001 / TC-KITCH-002 — LD-KOT-01 and RH-KOT-01 (S1-P15-T001): the kitchen board carries tickets, timings and
// print state but no customer or money data (SC-RBAC-07), sorts urgent-then-oldest, filters by section, and a poll
// with `since` returns exactly what changed — including tickets that left the queue.
const db = testDb();
const A = tenantIdOf("A");

beforeAll(seedOnce, 120_000);

type Board = { tickets: Array<Record<string, unknown>>; serverTime: string; hasMore: boolean };
const poll = (query: Record<string, string> = {}) =>
  invokeRoute(GET as never, { url: `/api/v1/kitchen/tickets?${new URLSearchParams(query).toString()}` });

describe("TC-KITCH-001 kitchen board", () => {
  it("returns this tenant's active tickets, urgent first then oldest, with no customer or money fields", async () => {
    await asSeedUser("A", "KITCHEN");
    const response = await poll();
    expect(response.status).toBe(200);
    const board = response.body as Board;

    const active = await db.kotTicket.count({ where: { tenantId: A, status: { in: ["QUEUED", "PREPARING", "READY"] } } });
    expect(board.tickets).toHaveLength(active);
    expect(board.hasMore).toBe(false);
    expect(Date.parse(board.serverTime)).toBeGreaterThan(0);

    const first = board.tickets[0];
    // `orderId` lets the opened ticket link to its order (owner review 2026-10-06); still no customer or money.
    expect(Object.keys(first).sort()).toEqual(
      [
        "id", "kotNumber", "roundNumber", "orderId", "orderNumber", "orderType", "tableLabel", "priority", "status", "sectionId",
        "notes", "queuedAt", "preparingAt", "readyAt", "servedAt", "items", "targetPrepMinutes", "printStatus",
      ].sort(),
    );
    const payload = JSON.stringify(board);
    expect(payload).not.toMatch(/customer|phone|email|amount|price|total|paid/i);
    expect(payload).not.toContain(tenantIdOf("B"));

    // Priority desc, then queued_at asc.
    const keys = board.tickets.map((t) => [t.priority === "HIGH" ? 0 : 1, Date.parse(String(t.queuedAt))] as const);
    expect(keys).toEqual([...keys].sort((x, y) => x[0] - y[0] || x[1] - y[1]));
  });

  it("filters by kitchen section and ignores another tenant's section id (TI-037)", async () => {
    await asSeedUser("A", "KITCHEN");
    const section = await db.kitchenSection.findFirstOrThrow({ where: { tenantId: A, code: "MAIN" } });
    const filtered = (await poll({ section: section.id })).body as Board;
    expect(filtered.tickets.length).toBeGreaterThan(0);
    expect(filtered.tickets.every((t) => t.sectionId === section.id)).toBe(true);

    const foreign = await db.kitchenSection.findFirstOrThrow({ where: { tenantId: tenantIdOf("B") } });
    expect(((await poll({ section: foreign.id })).body as Board).tickets).toEqual([]);
  });

  it("requires kot:read: an anonymous request is 401 and a rejected filter is 422", async () => {
    asAnonymous();
    expect((await poll()).status).toBe(401);

    await asSeedUser("A", "KITCHEN");
    expect((await poll({ section: "not-a-uuid" })).status).toBe(422);
    expect((await poll({ tenantId: tenantIdOf("B") })).status).toBe(422);
  });
});

describe("TC-KITCH-002 polling", () => {
  it("delivers tickets that changed after the cursor, including ones that left the queue", async () => {
    await asSeedUser("A", "KITCHEN");
    const initial = (await poll()).body as Board;
    const target = initial.tickets.find((t) => t.status === "QUEUED");
    expect(target, "the seed has a queued ticket").toBeTruthy();

    // Nothing changed yet: a poll from the cursor is empty.
    expect(((await poll({ since: initial.serverTime })).body as Board).tickets).toEqual([]);

    dataOf(await invokeAction(updateKOTStatusAction, { kotId: String(target!.id), toStatus: "PREPARING" }));
    const delta = (await poll({ since: initial.serverTime })).body as Board;
    expect(delta.tickets.map((t) => t.id)).toContain(target!.id);
    expect(delta.tickets.find((t) => t.id === target!.id)).toMatchObject({ status: "PREPARING", preparingAt: expect.any(String) });

    // A ticket that is served leaves the queue but is still delivered, so the board can remove its card.
    dataOf(await invokeAction(updateKOTStatusAction, { kotId: String(target!.id), toStatus: "READY" }));
    await asSeedUser("A", "WAITER");
    dataOf(await invokeAction(updateKOTStatusAction, { kotId: String(target!.id), toStatus: "SERVED" }));
    await asSeedUser("A", "KITCHEN");
    const afterServe = (await poll({ since: delta.serverTime })).body as Board;
    expect(afterServe.tickets.find((t) => t.id === target!.id)).toMatchObject({ status: "SERVED" });
    expect(((await poll()).body as Board).tickets.map((t) => t.id)).not.toContain(target!.id);
  });

  it("caps a page and reports hasMore", async () => {
    await asSeedUser("A", "KITCHEN");
    const page = (await poll({ limit: "1" })).body as Board;
    expect(page.tickets).toHaveLength(1);
    expect(page.hasMore).toBe(true);
    expect((await poll({ limit: "500" })).status).toBe(422);
  });
});
