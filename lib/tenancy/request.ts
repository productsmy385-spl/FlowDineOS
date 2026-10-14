import "server-only";
import { headers } from "next/headers";
import { SLUG_PATTERN } from "@/lib/validation/core";
import { TENANT_SLUG_HEADER, isReservedHostLabel, normalizeRootDomain, publicSiteUrl } from "./hostnames";

/**
 * Server-side view of the host the middleware resolved (S1-P09-T011, ADR-012 §1).
 *
 * The middleware sets `x-rasoi-tenant-slug` on tenant hosts and deletes it everywhere else, so a client-supplied
 * header can never reach here. It is nevertheless re-validated: the value must be a well-formed, non-reserved slug,
 * and anything else is treated as "no tenant host" rather than trusted.
 */

/** The tenant slug of the current request's host, or `null` on the apex host. */
export async function resolvedTenantSlug(): Promise<string | null> {
  const value = (await headers()).get(TENANT_SLUG_HEADER);
  if (typeof value !== "string") return null;
  const slug = value.trim().toLowerCase();
  if (!SLUG_PATTERN.test(slug) || isReservedHostLabel(slug)) return null;
  return slug;
}

/** `PUBLIC_ROOT_DOMAIN`, normalised; `null` when unset or unusable (the app then runs on paths and `*.localhost`). */
export function configuredRootDomain(): string | null {
  return normalizeRootDomain(process.env.PUBLIC_ROOT_DOMAIN) ?? (process.env.NODE_ENV !== "test" ? "flowdine.in" : null);
}

/**
 * The canonical address of a restaurant's public site (ADR-012 §2). `null` when `PUBLIC_ROOT_DOMAIN` is not
 * configured — the path form `/r/{slug}` is then the only address and emits no canonical link.
 */
export function canonicalPublicUrl(slug: string): string | null {
  return publicSiteUrl(slug, configuredRootDomain());
}
