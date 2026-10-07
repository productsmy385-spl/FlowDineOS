import "server-only";
import { randomUUID } from "node:crypto";
import type { DemoRequestStatus } from "@prisma/client";
import { audit } from "@/lib/audit/write";
import type { PlatformContext, SystemContext } from "@/lib/auth/context-types";
import { countDemoRequestsByStatus, findDemoRequest, insertDemoRequest, listDemoRequests, updateDemoRequestRow, type DemoRequestRow } from "@/lib/data/demo-requests";
import { assertPlatform } from "@/lib/data/platform-tenants";
import { withTx } from "@/lib/data/tx";
import { NotFoundError, RateLimitedError, ValidationError } from "@/lib/errors";
import { requestMeta } from "@/lib/http/request-meta";
import { logger } from "@/lib/logger";
import { consumeScope } from "@/lib/security/rate-limit";
import { now, parseIsoDate } from "@/lib/time";

/**
 * Book a demo (RASOIOS-ADR-024; owner brief 2026-10-07 §25–28).
 *
 * The public form stores the request and says so — nothing more: there is no calendar behind it, so it never offers or
 * confirms a time, only "our team will contact you". Spam is held back three ways: a hidden trap field, a limit per
 * address and a limit per email, all checked before anything is written. Only the platform owner reads requests.
 */

export type DemoSubmission = {
  name: string;
  businessName: string;
  phone: string;
  email: string;
  city: string;
  preferredDate: string;
  preferredTime: string;
  outletCount?: number;
  message: string | null;
  website?: string;
};

export async function submitDemoRequest(data: DemoSubmission): Promise<{ received: true }> {
  const ctx: SystemContext = { kind: "system", requestId: randomUUID(), job: "demo-request" };
  // A bot that filled the hidden field gets the same answer as everyone else, and nothing is stored.
  if (data.website) {
    logger.warn("demo_request.trap_filled", { requestId: ctx.requestId });
    return { received: true };
  }
  const today = now().toISOString().slice(0, 10);
  if (data.preferredDate < today) throw new ValidationError("Choose today or a later date.", { preferredDate: ["Choose today or a later date."] });
  const latest = new Date(now().getTime() + 366 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (data.preferredDate > latest) throw new ValidationError("Choose a date within the next year.", { preferredDate: ["Choose a date within the next year."] });

  // An unknown address (no trusted proxy header) is not counted: otherwise every such visitor would share one bucket.
  const { ipAddress } = await requestMeta();
  const checks: Array<[Parameters<typeof consumeScope>[0], string]> = [["public.demo_request.email", data.email]];
  if (ipAddress) checks.push(["public.demo_request.ip", ipAddress]);
  for (const [scope, identifier] of checks) {
    const limit = await consumeScope(scope, identifier);
    if (!limit.allowed) throw new RateLimitedError(limit.retryAfterSec, "Too many demo requests. Please try again later.");
  }

  await withTx(ctx, async (tx) => {
    const row = await insertDemoRequest(tx, {
      name: data.name,
      businessName: data.businessName,
      phone: data.phone,
      email: data.email,
      city: data.city,
      preferredDate: parseIsoDate(data.preferredDate),
      preferredTime: data.preferredTime,
      outletCount: data.outletCount ?? null,
      message: data.message,
    });
    // The audit row names the request, not the person: contact details stay in the request itself.
    await audit(tx, ctx, { action: "demo_request.created", resourceType: "demo_request", resourceId: row.id, after: { city: data.city, outletCount: data.outletCount ?? null } });
  });
  logger.info("demo_request.created", { requestId: ctx.requestId });
  return { received: true };
}

export async function getDemoRequests(ctx: PlatformContext, filter: { status?: DemoRequestStatus }): Promise<{ items: DemoRequestRow[]; counts: Record<string, number> }> {
  assertPlatform(ctx, "platform:demo_request:read");
  const [items, counts] = await Promise.all([listDemoRequests(filter), countDemoRequestsByStatus()]);
  return { items, counts };
}

export async function updateDemoRequest(ctx: PlatformContext, input: { id: string; status?: DemoRequestStatus; notes?: string | null }): Promise<DemoRequestRow> {
  assertPlatform(ctx, "platform:demo_request:update");
  return withTx(ctx, async (tx) => {
    const before = await findDemoRequest(tx, input.id);
    if (!before) throw new NotFoundError("Demo request not found");
    const after = await updateDemoRequestRow(tx, input.id, { status: input.status, notes: input.notes === undefined ? undefined : input.notes, updatedByUserId: ctx.userId });
    await audit(tx, ctx, {
      action: "demo_request.updated",
      resourceType: "demo_request",
      resourceId: input.id,
      before: { status: before.status, notesChanged: false },
      after: { status: after.status, notesChanged: input.notes !== undefined && input.notes !== before.notes },
    });
    return after;
  });
}
