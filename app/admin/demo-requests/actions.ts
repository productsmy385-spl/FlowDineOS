"use server";

import { requirePlatform } from "@/lib/auth/guards";
import { action } from "@/lib/http/action";
import { getDemoRequests, updateDemoRequest } from "@/lib/services/demo-requests";
import { parseInput } from "@/lib/validation/core";
import { listDemoRequestsSchema, updateDemoRequestSchema, type ListDemoRequestsInput, type UpdateDemoRequestInput } from "@/lib/validation/demo";

/** LD-ADM-10 — `platform:demo_request:read`: visitors' demo requests, newest first. */
export const listDemoRequestsAction = action(async (input: ListDemoRequestsInput = {}) => {
  const ctx = await requirePlatform("platform:demo_request:read");
  return getDemoRequests(ctx, parseInput(listDemoRequestsSchema, input));
});

/** SA-ADM-11 — `platform:demo_request:update`: status and follow-up notes. Audited. */
export const updateDemoRequestAction = action(async (input: UpdateDemoRequestInput) => {
  const ctx = await requirePlatform("platform:demo_request:update");
  return updateDemoRequest(ctx, parseInput(updateDemoRequestSchema, input));
});
