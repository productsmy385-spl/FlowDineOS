import { z } from "zod";
import { normalizeRootDomain } from "./tenancy/hostnames";
import { imageKitHost, parseImageHostList } from "./validation/url";

/**
 * Server environment validation (S1-P01-T004, SC-SEC-01, SC-AUTH-02).
 *
 * - Fails fast at server boot (see instrumentation.ts) instead of silently weakening security.
 * - Error messages name the variable and the rule, never the value.
 * - Import only from server code. Client code reads NEXT_PUBLIC_* values via process.env directly.
 */

const PLACEHOLDER = /placeholder|example|changeme|your[_-]?(key|secret)/i;

const secretish = /SECRET|PASSWORD|TOKEN|DATABASE|PRIVATE/i;

/** Hosts that never leave the machine; exempt from the production transport-security rules below. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

const nonPlaceholder = z
  .string({ required_error: "is required" })
  .trim()
  .min(1, "is required")
  .refine((v) => !PLACEHOLDER.test(v), "contains a placeholder value");

/** `VAR=""` in a .env file or a dashboard means "not set" for optional integrations. */
const blankAsUnset = (value: unknown): unknown => (typeof value === "string" && value.trim() === "" ? undefined : value);

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    DATABASE_URL: nonPlaceholder.refine((v) => /^postgres(ql)?:\/\//.test(v), "must be a postgresql:// URL"),
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: nonPlaceholder.refine(
      (v) => /^pk_(test|live)_[A-Za-z0-9+/=_-]+$/.test(v),
      "must be a Clerk publishable key (pk_test_… or pk_live_…)",
    ),
    CLERK_SECRET_KEY: nonPlaceholder.refine(
      (v) => /^sk_(test|live)_[A-Za-z0-9+/=_-]+$/.test(v),
      "must be a Clerk secret key (sk_test_… or sk_live_…)",
    ),
    // Becomes required when the webhook endpoint ships (S1-P03-T008).
    CLERK_WEBHOOK_SIGNING_SECRET: nonPlaceholder
      .refine((v) => v.startsWith("whsec_"), "must be a Svix signing secret (whsec_…)")
      .optional(),
    NEXT_PUBLIC_CLERK_SIGN_IN_URL: z.literal("/sign-in").default("/sign-in"),
    NEXT_PUBLIC_CLERK_SIGN_UP_URL: z.literal("/sign-up").default("/sign-up"),
    NEXT_PUBLIC_APP_URL: z.string({ required_error: "is required" }).url("must be an absolute URL"),
    // Wildcard domain that serves each restaurant's public website at `<slug>.<domain>` (S1-P09-T011, ADR-012 §3).
    // OPTIONAL: when it is unset (or blank) the app still runs — `<slug>.localhost` and `/r/{slug}` keep working and
    // no canonical link is emitted. A bare domain only: no scheme, port or path, and never an IP address.
    PUBLIC_ROOT_DOMAIN: z
      .string()
      .trim()
      .transform((value) => (value === "" ? undefined : value))
      .refine((value) => value === undefined || normalizeRootDomain(value) !== null, "must be a bare domain name such as rasoios.com (no scheme, port or path)")
      .transform((value) => (value === undefined ? undefined : (normalizeRootDomain(value) ?? undefined)))
      .optional(),
    // Image hosts for logo/cover/menu image URLs (S1-P07-T002, SC-VAL-04): hostnames only — no scheme, port, path,
    // wildcard or IP address. Parsed by the same function the validators and next.config.ts use.
    ALLOWED_IMAGE_HOSTS: z
      .string()
      .default("")
      .refine((v) => parseImageHostList(v) !== null, "must be a comma-separated list of hostnames"),
    // ImageKit image uploads (RASOIOS-ADR-017 §7). OPTIONAL, both or neither: unset, uploads answer 503
    // UPLOADS_DISABLED and pasted image links keep working. The private key is a server secret — never NEXT_PUBLIC_.
    // IMAGEKIT_PUBLIC_KEY is not used: uploads are proxied through the server, so no browser-side SDK needs it.
    IMAGEKIT_PRIVATE_KEY: z.preprocess(
      blankAsUnset,
      nonPlaceholder.refine((v) => v.startsWith("private_"), "must be an ImageKit private key (private_…)").optional(),
    ),
    IMAGEKIT_URL_ENDPOINT: z.preprocess(
      blankAsUnset,
      z
        .string()
        .trim()
        .refine((v) => imageKitHost(v) !== null && /^https:\/\/[^/?#]+(\/[A-Za-z0-9_-]+)*\/?$/.test(v), "must be the ImageKit URL endpoint, e.g. https://ik.imagekit.io/your_id")
        .optional(),
    ),
    TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    SUPER_ADMIN_BOOTSTRAP_EMAIL: z.string().email("must be an email address").optional(),
  })
  .superRefine((env, ctx) => {
    if ((env.IMAGEKIT_PRIVATE_KEY === undefined) !== (env.IMAGEKIT_URL_ENDPOINT === undefined)) {
      const missing = env.IMAGEKIT_PRIVATE_KEY === undefined ? "IMAGEKIT_PRIVATE_KEY" : "IMAGEKIT_URL_ENDPOINT";
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [missing], message: "is required when the other ImageKit setting is set" });
    }
    if (env.NODE_ENV !== "production") return;
    // A production build run entirely on one machine (CI end-to-end, a local `next start`) — app URL *and* database on
    // loopback — never crosses a network, so there is nothing for TLS to protect. A deployment whose database is
    // remote but whose app URL says localhost is a copied development .env: refuse it loudly at boot, because every
    // sign-up link and Staff login would otherwise point visitors at their own machine.
    let appHost = "";
    try {
      appHost = new URL(env.NEXT_PUBLIC_APP_URL).hostname;
    } catch {
      // Malformed URLs are reported by the field's own rule.
    }
    const url = env.DATABASE_URL;
    const host = url.match(/@([^:/?]+)/)?.[1] ?? "";
    const fullyLocal = LOOPBACK_HOSTS.has(appHost) && LOOPBACK_HOSTS.has(host);
    if (!env.NEXT_PUBLIC_APP_URL.startsWith("https://") && !fullyLocal) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["NEXT_PUBLIC_APP_URL"], message: "must use https in production" });
    }
    // SC-DB-01: TLS to PostgreSQL. Railway private-network hosts (*.railway.internal) are accepted pending
    // verification of transport encryption in S1-P27-T002 [assumption]; a database on loopback needs no TLS.
    if (!/[?&]sslmode=(require|verify-ca|verify-full)\b/.test(url) && !host.endsWith(".railway.internal") && !LOOPBACK_HOSTS.has(host)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["DATABASE_URL"], message: "must set sslmode=require in production" });
    }
  });

export type ServerEnv = z.infer<typeof envSchema>;

export class EnvValidationError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid server environment:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "EnvValidationError";
  }
}

/** Pure parser — safe to unit test. Never includes values in errors. */
export function parseEnv(source: Record<string, string | undefined>): ServerEnv {
  const problems: string[] = [];

  // Server secrets must never be exposed through NEXT_PUBLIC_* (SC-SEC-01).
  for (const [key, value] of Object.entries(source)) {
    if (!key.startsWith("NEXT_PUBLIC_")) continue;
    if (secretish.test(key.slice("NEXT_PUBLIC_".length)) || /^(sk_|whsec_)/.test(value ?? "")) {
      problems.push(`${key}: server secret must not use the NEXT_PUBLIC_ prefix`);
    }
  }

  const result = envSchema.safeParse(source);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const name = issue.path.join(".") || "(environment)";
      const rule = issue.code === z.ZodIssueCode.custom || issue.code === "too_small" ? issue.message : describeIssue(issue);
      problems.push(`${name}: ${rule}`);
    }
  }

  if (problems.length > 0) throw new EnvValidationError(problems);
  return result.success ? result.data : (undefined as never);
}

function describeIssue(issue: z.ZodIssue): string {
  switch (issue.code) {
    case z.ZodIssueCode.invalid_type:
      return issue.received === "undefined" ? "is required" : "has an invalid type";
    case z.ZodIssueCode.invalid_enum_value:
      return `must be one of ${issue.options.join(", ")}`;
    case z.ZodIssueCode.invalid_literal:
      return `must equal ${String(issue.expected)}`;
    default:
      // Refinement messages are authored above and contain no values.
      return issue.message;
  }
}

let cached: ServerEnv | undefined;

/** Validated environment for server code. Throws EnvValidationError on first use if invalid. */
/**
 * Hosting-platform defaults, applied to the real environment before validation. On Railway, NEXT_PUBLIC_APP_URL
 * falls back to the public domain Railway assigns the service (`RAILWAY_PUBLIC_DOMAIN`, always served over https).
 * An explicit NEXT_PUBLIC_APP_URL always wins — set it once a custom domain is attached. Server code reads
 * process.env at request time, so the default reaches every consumer.
 */
export function applyPlatformDefaults(env: Record<string, string | undefined>): void {
  const railwayDomain = env.RAILWAY_PUBLIC_DOMAIN?.trim();
  if (!railwayDomain || !/^[a-z0-9.-]+$/i.test(railwayDomain)) return;

  // On Railway a missing or loopback app URL is always a mistake (a copied development .env): the service's own
  // public https domain is the only correct value.
  const current = env.NEXT_PUBLIC_APP_URL?.trim();
  let loopback = false;
  try {
    loopback = current ? LOOPBACK_HOSTS.has(new URL(current).hostname) : false;
  } catch {
    // An unparsable value is reported by validation.
  }
  // A Railway-generated address (`*.up.railway.app`) that is not the one Railway says this service is served on is
  // stale — the domain was renamed (owner report 2026-10-07: QR codes kept the old rasoios-production address and
  // stopped working). Railway's live domain wins. A custom domain is never overridden.
  let staleRailwayDomain = false;
  try {
    const host = current ? new URL(current).hostname.toLowerCase() : "";
    const live = railwayDomain.toLowerCase();
    staleRailwayDomain = host.endsWith(".up.railway.app") && live.endsWith(".up.railway.app") && host !== live;
  } catch {
    // An unparsable value is reported by validation.
  }
  if (!current || loopback || staleRailwayDomain) env.NEXT_PUBLIC_APP_URL = `https://${railwayDomain}`;

  // Railway's public Postgres proxy (*.proxy.rlwy.net) speaks TLS: require it instead of refusing to boot (SC-DB-01).
  // This only ever makes the connection stricter.
  const db = env.DATABASE_URL?.trim();
  if (db && /@[^/?#]*\.proxy\.rlwy\.net(?::\d+)?\//i.test(db) && !/[?&]sslmode=/i.test(db)) {
    env.DATABASE_URL = `${db}${db.includes("?") ? "&" : "?"}sslmode=require`;
  }
}

/**
 * This app's public URL at *runtime*. Always use this on the server instead of `process.env.NEXT_PUBLIC_APP_URL`:
 * Next.js replaces that literal with its build-time value, so a correction made when the server starts (platform
 * defaults, or a variable changed without a rebuild) would never reach the code. The key is assembled so the
 * bundler cannot inline it.
 */
const APP_URL_KEY = ["NEXT_PUBLIC", "APP_URL"].join("_");
export function appUrl(): string | undefined {
  applyPlatformDefaults(process.env);
  return process.env[APP_URL_KEY]?.trim() || undefined;
}

export function getEnv(): ServerEnv {
  if (!cached) {
    applyPlatformDefaults(process.env);
    cached = parseEnv(process.env);
  }
  return cached;
}

/** Called once at server boot from instrumentation.ts. */
export function assertEnv(): void {
  getEnv();
}
