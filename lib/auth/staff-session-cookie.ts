import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * `rasoi_staff_session` cookie (RASOIOS-ADR-019 §4).
 *
 * Unlike `rasoi_active_membership`, which is only a preference, this cookie *is* the staff credential for the
 * request. It carries an opaque random token and nothing else — no user id, tenant id or role — so there is nothing
 * in it to tamper with and nothing to leak. The database stores only the token's SHA-256, so a copy of the table
 * cannot be replayed as a login.
 *
 * SHA-256 rather than a slow hash on purpose: the token is 256 bits of CSPRNG output, not a human-chosen secret, so
 * there is no dictionary to stretch against — only a constant-time lookup to do on every request.
 */
export const STAFF_SESSION_COOKIE = "rasoi_staff_session";

/** 32 bytes, base64url: no padding or separators to trip over in a Set-Cookie header. */
export function issueStaffSessionToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashStaffSessionToken(token) };
}

export function hashStaffSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** The cookie value if it is shaped like one of our tokens; otherwise null, with no database round trip. */
export function parseStaffSessionCookie(value: string | undefined | null): string | null {
  return value && TOKEN_SHAPE.test(value) ? value : null;
}

/** Constant-time comparison of two hex digests, for callers comparing a computed hash with a stored one. */
export function tokenHashesMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

export const STAFF_SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  // `strict`, not `lax`: nothing should ever navigate into a staff session from another site. The console is not
  // linked to from anywhere public, so there is no cross-site entry point to preserve.
  sameSite: "strict" as const,
  path: "/",
};
