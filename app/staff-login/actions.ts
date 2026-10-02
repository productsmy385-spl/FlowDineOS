"use server";

import { cookies, headers } from "next/headers";
import { action } from "@/lib/http/action";
import { requestMeta } from "@/lib/http/request-meta";
import { STAFF_SESSION_COOKIE, STAFF_SESSION_COOKIE_OPTIONS, parseStaffSessionCookie } from "@/lib/auth/staff-session-cookie";
import { staffLogin, staffSignOut } from "@/lib/services/staff-auth";
import { parseInput } from "@/lib/validation/core";
import { staffLoginSchema, type StaffLoginInput } from "@/lib/validation/staff";

/**
 * Staff daily-password sign-in and sign-out (RASOIOS-ADR-019, SA-STAFFAUTH-04/05).
 *
 * Separate from the Clerk pages on purpose: this is the only door a daily password opens, and it cannot
 * authenticate a TENANT_ADMIN or MANAGER — the service filters on role, and the database refuses a staff session
 * for any other role outright (C7).
 */

export type StaffLoginResult = { outcome: "OK" } | { outcome: "INVALID" } | { outcome: "EXPIRED" };

export const staffLoginAction = action(async (input: StaffLoginInput): Promise<StaffLoginResult> => {
  const parsed = parseInput(staffLoginSchema, input);
  const { ipAddress, userAgent } = await requestMeta();
  const requestId = (await headers()).get("x-request-id") ?? crypto.randomUUID();

  const result = await staffLogin({
    email: parsed.email,
    password: parsed.password,
    requestId,
    ipAddress,
    userAgent,
  });
  if (result.outcome !== "OK") return { outcome: result.outcome };

  // Expires with the shift, so a browser left open overnight holds nothing the server would still accept.
  (await cookies()).set(STAFF_SESSION_COOKIE, result.token, { ...STAFF_SESSION_COOKIE_OPTIONS, expires: result.expiresAt });
  return { outcome: "OK" };
});

export const staffSignOutAction = action(async (): Promise<{ signedOut: true }> => {
  const jar = await cookies();
  const requestId = (await headers()).get("x-request-id") ?? crypto.randomUUID();
  await staffSignOut(parseStaffSessionCookie(jar.get(STAFF_SESSION_COOKIE)?.value), requestId);
  // Clear it either way: a cookie whose session is already gone should not keep being presented.
  jar.delete(STAFF_SESSION_COOKIE);
  return { signedOut: true };
});
