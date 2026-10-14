/**
 * Host → tenant resolution (S1-P09-T011, RASOIOS-ADR-012).
 *
 * Pure functions with **no imports**: `middleware.ts` runs on the Edge runtime, so this module must not pull in Zod,
 * Prisma, `next/navigation` or anything else. `tests/unit/hostnames.test.ts` asserts that `TENANT_HOST_LABEL` stays
 * identical to `SLUG_PATTERN` in `lib/validation/core.ts`, so the host label and the tenant slug can never drift.
 *
 * Rules (ADR-012):
 * - `PUBLIC_ROOT_DOMAIN` is OPTIONAL. Unset, only `<slug>.localhost` resolves to a tenant and every other host is the
 *   apex host, so the console, `/r/{slug}` and local development keep working with no configuration at all.
 * - A reserved label (`app`, `admin`, `api`, `www`, `static`, `assets`, `mail`, …) is never a tenant. Under the root
 *   domain it is treated as an apex (operator-controlled) host — it serves the console, never tenant data.
 * - A label that is not a well-formed slug, or a multi-label subdomain, is `invalid`: the middleware renders the same
 *   public 404 as an unknown slug, so a host cannot be used to enumerate tenants.
 * - An unrecognised host (Railway's generated host, a preview host, an IP literal) is the apex host. It never selects
 *   a tenant, so an unknown Host header can only ever reach the console's own authentication.
 */

/** Same expression as `SLUG_PATTERN` (`lib/validation/core.ts`): 3–48 chars, a–z/0–9/-, not starting or ending with -. */
export const TENANT_HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/;

/**
 * Labels that can never be a tenant: application routes (so `/admin` and `admin.example.com` cannot collide),
 * conventional infrastructure names, and mail/DNS names that must keep pointing at the operator's own services.
 * `lib/validation/platform.ts` validates new tenant slugs against this same list (ADR-012 §4).
 */
export const RESERVED_HOST_LABELS: readonly string[] = [
  // Application routes (data-model E01)
  "account",
  "accounts",
  "admin",
  "api",
  "offline",
  "r",
  "restaurant",
  "restaurants",
  "sign-in",
  "sign-up",
  "signin",
  "signup",
  // Console / platform hosts
  "app",
  "auth",
  "clerk",
  "console",
  "dashboard",
  "login",
  "logout",
  "platform",
  "portal",
  // Content and asset hosts
  "assets",
  "cdn",
  "download",
  "downloads",
  "files",
  "img",
  "images",
  "media",
  "public",
  "static",
  "www",
  // Operations
  "backup",
  "cache",
  "cron",
  "db",
  "database",
  "dev",
  "edge",
  "gateway",
  "graphql",
  "health",
  "internal",
  "jobs",
  "localhost",
  "logs",
  "metrics",
  "monitor",
  "origin",
  "preview",
  "private",
  "proxy",
  "queue",
  "ready",
  "redis",
  "root",
  "security",
  "staging",
  "status",
  "stage",
  "sys",
  "system",
  "test",
  "vpn",
  "worker",
  "workers",
  // Mail and DNS
  "autoconfig",
  "autodiscover",
  "hostmaster",
  "imap",
  "mail",
  "mx",
  "noreply",
  "no-reply",
  "ns",
  "ns1",
  "ns2",
  "pop",
  "pop3",
  "postmaster",
  "smtp",
  "webmail",
  // Well-known files and marketing
  "blog",
  "docs",
  "favicon",
  "help",
  "manifest",
  "robots",
  "sitemap",
  "support",
  "webhook",
  "webhooks",
];

const RESERVED = new Set(RESERVED_HOST_LABELS);

export function isReservedHostLabel(label: string): boolean {
  return RESERVED.has(label.trim().toLowerCase());
}

/** Host names that always mean "the apex host" regardless of configuration. */
const LOCAL_APEX = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);

const LOCAL_SUFFIX = ".localhost";

/** Only digits and dots, i.e. an IPv4 literal — never a tenant host. */
const IPV4_LIKE = /^[0-9.]+$/;

/** A bare DNS domain: at least two labels, an alphabetic TLD, no scheme, port or path. */
const ROOT_DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * Lower-cases a `Host` header and strips the port, a trailing dot and IPv6 brackets.
 * Returns `null` when the header is missing or contains anything that is not a host (spaces, control characters, `/`).
 */
export function normalizeHost(hostHeader: string | null | undefined): string | null {
  if (typeof hostHeader !== "string") return null;
  const raw = hostHeader.trim().toLowerCase();
  if (raw === "") return null;
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f || raw[i] === "/" || raw[i] === "\\" || raw[i] === "@" || raw[i] === "?" || raw[i] === "#") return null;
  }
  // IPv6 literals keep their brackets; everything else drops `:port`.
  const withoutPort = raw.startsWith("[") ? raw.slice(0, raw.indexOf("]") + 1) || null : raw.split(":")[0];
  if (withoutPort === null || withoutPort === "") return null;
  const host = withoutPort.endsWith(".") ? withoutPort.slice(0, -1) : withoutPort;
  return host === "" ? null : host;
}

/** The port part of a `Host` header (`"3000"`), or `null`. IPv6 literals are handled too. */
export function hostPort(hostHeader: string | null | undefined): string | null {
  if (typeof hostHeader !== "string") return null;
  const raw = hostHeader.trim();
  const afterAuthority = raw.startsWith("[") ? raw.slice(raw.indexOf("]") + 1) : raw;
  const colon = afterAuthority.lastIndexOf(":");
  if (colon === -1) return null;
  const port = afterAuthority.slice(colon + 1);
  return /^\d{1,5}$/.test(port) ? port : null;
}

/**
 * Normalises `PUBLIC_ROOT_DOMAIN`. Accepts a bare domain (`rasoios.com`); tolerates a copied URL or a leading dot.
 * Returns `null` when unset or unusable — the app then runs with `*.localhost` and `/r/{slug}` only (ADR-012 §3).
 */
export function normalizeRootDomain(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  let candidate = value.trim().toLowerCase();
  if (candidate === "") return null;
  candidate = candidate.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  candidate = candidate.split("/")[0].split("?")[0].split("#")[0];
  candidate = candidate.split(":")[0];
  candidate = candidate.replace(/^\.+/, "").replace(/\.+$/, "");
  return ROOT_DOMAIN.test(candidate) ? candidate : null;
}

export type HostResolution =
  /** The console, the platform admin, authentication and the `/r/{slug}` path form. */
  | { kind: "apex" }
  /** A tenant's public website host. The slug still has to exist, be ACTIVE and be published. */
  | { kind: "tenant"; slug: string }
  /** Meant to be a tenant host but cannot be one: renders the same public 404 as an unknown slug. */
  | { kind: "invalid" };

function classifyLabel(label: string): HostResolution {
  if (label.includes(".")) return { kind: "invalid" }; // multi-label subdomain: never a tenant
  if (isReservedHostLabel(label)) return { kind: "apex" };
  return TENANT_HOST_LABEL.test(label) ? { kind: "tenant", slug: label } : { kind: "invalid" };
}

/**
 * Classifies a request's `Host` header. `rootDomain` comes from `normalizeRootDomain(process.env.PUBLIC_ROOT_DOMAIN)`
 * and may be `null`.
 */
export function resolveHost(hostHeader: string | null | undefined, rootDomain: string | null): HostResolution {
  const host = normalizeHost(hostHeader);
  // No Host header, an IP address or a malformed value: serve the apex host, never a tenant.
  if (host === null || LOCAL_APEX.has(host) || IPV4_LIKE.test(host) || host.startsWith("[")) return { kind: "apex" };

  if (host.endsWith(LOCAL_SUFFIX)) return classifyLabel(host.slice(0, -LOCAL_SUFFIX.length));

  const effectiveRoot = rootDomain ?? (host === "flowdine.in" || host.endsWith(".flowdine.in") ? "flowdine.in" : null);

  if (effectiveRoot !== null) {
    if (host === effectiveRoot) return { kind: "apex" };
    if (host.endsWith(`.${effectiveRoot}`)) return classifyLabel(host.slice(0, -(effectiveRoot.length + 1)));
  }
  // Railway's generated host, a preview host or a custom console domain: the apex host.
  return { kind: "apex" };
}

/**
 * The apex authority (host and port) a tenant-host request must be redirected to: the same host with the tenant label
 * removed, so `spice-route.localhost:3000` → `localhost:3000` and `spice-route.rasoios.com` → `rasoios.com`.
 * Returns `null` when the host is not a tenant host.
 */
export function apexAuthorityFor(hostHeader: string | null | undefined, rootDomain: string | null): string | null {
  const host = normalizeHost(hostHeader);
  if (host === null) return null;
  const port = hostPort(hostHeader);
  const suffix = port === null ? "" : `:${port}`;

  if (host.endsWith(LOCAL_SUFFIX) && host !== LOCAL_SUFFIX.slice(1)) return `localhost${suffix}`;
  const effectiveRoot = rootDomain ?? (host === "flowdine.in" || host.endsWith(".flowdine.in") ? "flowdine.in" : null);
  if (effectiveRoot !== null && host !== effectiveRoot && host.endsWith(`.${effectiveRoot}`)) {
    if (effectiveRoot === "flowdine.in" || port === "8080" || port === "80" || port === "443") {
      return effectiveRoot;
    }
    return `${effectiveRoot}${suffix}`;
  }
  return null;
}

/** The canonical public host of a tenant, or `null` when `PUBLIC_ROOT_DOMAIN` is not configured (ADR-012 §2). */
export function tenantHostFor(slug: string, rootDomain: string | null): string | null {
  if (rootDomain === null || !TENANT_HOST_LABEL.test(slug) || isReservedHostLabel(slug)) return null;
  return `${slug}.${rootDomain}`;
}

/** The canonical public URL of a tenant (`https://{slug}.{root}/`), or `null` when no root domain is configured. */
export function publicSiteUrl(slug: string, rootDomain: string | null): string | null {
  const host = tenantHostFor(slug, rootDomain);
  return host === null ? null : `https://${host}/`;
}

/** Paths that are served only from the apex host and redirect there when requested on a tenant host (ADR-012 §6). */
const APEX_ONLY_PREFIXES = ["/restaurant", "/admin", "/account", "/sign-in", "/sign-up", "/r"];

function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function isApexOnlyPath(pathname: string): boolean {
  return APEX_ONLY_PREFIXES.some((prefix) => matchesPrefix(pathname, prefix));
}

/**
 * Paths that are handled identically on every host: APIs (the print agent, the Clerk webhook, health probes) and
 * framework/static assets. Rewriting them to the public site would break the page they belong to.
 */
export function isHostNeutralPath(pathname: string): boolean {
  if (pathname === "/favicon.ico" || pathname === "/robots.txt" || pathname === "/manifest.json" || pathname === "/sw.js") return true;
  return matchesPrefix(pathname, "/api") || pathname.startsWith("/_next/") || pathname.startsWith("/icons/");
}

/** Where a tenant-host request is rewritten: `/` → `/r/{slug}`, `/anything` → `/r/{slug}/anything`. */
export function publicRewritePath(slug: string, pathname: string): string {
  const rest = pathname === "/" ? "" : pathname;
  return `/r/${slug}${rest}`;
}

/**
 * The path a host that cannot be a tenant is rewritten to. `_` fails `SLUG_PATTERN`, so the public page renders its
 * ordinary 404 — the same response as an unknown slug, a suspended tenant and an unpublished website (ADR-012 §7).
 */
export const UNRESOLVABLE_PUBLIC_PATH = "/r/_";

/** The internal header the middleware uses to hand the resolved slug to the app. Never read from the client. */
export const TENANT_SLUG_HEADER = "x-rasoi-tenant-slug";
