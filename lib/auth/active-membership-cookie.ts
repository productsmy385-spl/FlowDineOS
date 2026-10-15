/**
 * `rasoi_active_membership` cookie (ADR-006 §3, SC-SESS-02). It holds a USER_TENANT id the user *prefers*; it is
 * never authorization. The resolver re-validates it against the user's ACTIVE memberships on every request and
 * ignores anything else (another user's membership id, a tenant id, garbage).
 */
export const ACTIVE_MEMBERSHIP_COOKIE = "rasoi_active_membership";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The cookie value if it is shaped like a membership id; otherwise null. */
export function parseActiveMembershipCookie(value: string | undefined | null): string | null {
  return value && UUID.test(value) ? value.toLowerCase() : null;
}

export const ACTIVE_MEMBERSHIP_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  domain: process.env.NODE_ENV === "production" ? "flowdine.in" : undefined,
  maxAge: 60 * 60 * 24 * 30, // 30 days
};
