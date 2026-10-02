import { randomInt, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

/**
 * Daily staff passwords (RASOIOS-ADR-019 §3).
 *
 * A staff member reads this off a screen and types it at the counter, so it has to be short enough to be practical
 * and unambiguous when spoken. It is also only valid until the end of one business day and is rate limited, which is
 * what lets it be short: eight characters from a 31-character alphabet is about 39 bits, and an attacker gets a
 * handful of guesses before the bucket closes and the password expires anyway.
 *
 * Never derived from anything about the person — no name, phone, birthday or timestamp — and never stored in the
 * clear: the plaintext exists only in the response that generates it (C3, C5).
 */

/** No 0/O, 1/I/L or U/V: the characters people confuse reading a screen or hearing a code across a counter. */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTWXYZ";
const GROUP = 4;
const GROUPS = 2;

/** e.g. "A7K9-X2P4". `randomInt` is CSPRNG-backed and rejection-samples, so the alphabet stays uniform. */
export function generateStaffPassword(): string {
  const groups: string[] = [];
  for (let g = 0; g < GROUPS; g++) {
    let group = "";
    for (let i = 0; i < GROUP; i++) group += ALPHABET[randomInt(ALPHABET.length)];
    groups.push(group);
  }
  return groups.join("-");
}

/**
 * Typed-in passwords are compared case-insensitively and without the separator, because the alphabet has no
 * lowercase and the dash is a reading aid, not a secret. Whitespace around a paste is dropped too.
 */
export function normalizeStaffPassword(input: string): string {
  return input.trim().toUpperCase().replaceAll("-", "").replaceAll(" ", "");
}

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * N=2^14, r=8, p=5 — one of OWASP's equivalent scrypt configurations, chosen to trade memory for CPU.
 *
 * scrypt needs roughly 128·N·r bytes per hash. The first parameters here (N=2^16, p=1) needed 67 MB for every sign-in,
 * and a memory-constrained process could not always get it: on 2026-10-02 a development server answered a correct
 * password in 51 ms with "Failed to allocate memory" behind it, and because verification then treated that as a
 * mismatch, the staff member was told their password was wrong and typed it again. A Railway container signing in a
 * whole shift at once is the same situation. This needs 16 MB, and p=5 restores the CPU cost an offline attacker
 * pays for each guess.
 *
 * Existing hashes keep verifying: the parameters travel inside every stored hash, and `verifyStaffPassword` reads
 * them from there rather than from this constant.
 *
 * `maxmem` is set explicitly because Node's default ceiling is 32 MB and older hashes need up to 67 MB. It is also
 * the ceiling a tampered stored parameter cannot push past.
 */
const PARAMS = { N: 1 << 14, r: 8, p: 5, maxmem: 96 * 1024 * 1024 };
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

/** `scrypt$N$r$p$<salt base64>$<hash base64>` — the shape the `staff_credentials_password_hash_check` enforces. */
export async function hashStaffPassword(plaintext: string): Promise<string> {
  const salt = Buffer.from(Array.from({ length: SALT_LENGTH }, () => randomInt(256)));
  const derived = await scryptAsync(normalizeStaffPassword(plaintext), salt, KEY_LENGTH, PARAMS);
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString("base64")}$${derived.toString("base64")}`;
}

/**
 * Constant-time verification. A malformed or unknown-format stored value is a failure, never a pass: if the column
 * somehow held something we did not write, refusing is the only safe reading.
 */
export async function verifyStaffPassword(plaintext: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const [, n, r, p, saltB64, hashB64] = parts;
  const params = { N: Number(n), r: Number(r), p: Number(p), maxmem: PARAMS.maxmem };
  if (!Number.isInteger(params.N) || !Number.isInteger(params.r) || !Number.isInteger(params.p)) return false;
  // Refuse absurd parameters rather than letting a tampered row turn a login into a denial of service.
  // Also bounds the memory: anything needing more than `maxmem` would throw rather than verify.
  if (params.N > 1 << 17 || params.r > 16 || params.p > 16) return false;

  const expected = Buffer.from(hashB64, "base64");
  const salt = Buffer.from(saltB64, "base64");
  if (expected.length < 16 || salt.length < 8) return false;

  // Deliberately not wrapped in a catch. A failure *here* — the process could not allocate scrypt's memory, say — is
  // a server fault, not a wrong password, and reporting it as one sent staff round in circles retyping a password
  // that was correct. Let it surface as an error: the caller logs it and the person is told something went wrong.
  const derived = await scryptAsync(normalizeStaffPassword(plaintext), salt, expected.length, params);
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}
