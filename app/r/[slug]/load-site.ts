import "server-only";
import { notFound } from "next/navigation";
import { NotFoundError } from "@/lib/errors";
import { getPublicSite, type PublicSiteData } from "@/lib/services/website-theme";
import { resolvedTenantSlug } from "@/lib/tenancy/request";
import { parseParamOrNotFound, slugParam } from "@/lib/validation/core";

/**
 * The one way a public page resolves its restaurant (S1-P09-T011, ADR-012). Shared by `/r/[slug]` and
 * `/r/[slug]/daily` so both apply exactly the same checks.
 *
 * An invalid slug, an unknown slug, a suspended tenant and an unpublished website all render the same not-found page
 * with HTTP 404 — the host can never be used to tell them apart (ADR-012 §7; TC-SEC-005, TC-WEB-004, TC-WEB-018).
 */
export async function loadPublicSite(rawSlug: unknown, audience: "website" | "table" = "website"): Promise<PublicSiteData> {
  const slug = parseParamOrNotFound(slugParam, rawSlug);
  const hostSlug = await resolvedTenantSlug();
  // On a tenant host the path is the middleware's own rewrite; anything else is a forged request.
  if (hostSlug !== null && hostSlug !== slug) notFound();
  try {
    return await getPublicSite(slug, audience);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
}

/** Metadata loader: the same projection, but a failure yields `null` instead of a 404 (Next renders that later). */
export async function loadPublicSiteForMetadata(rawSlug: unknown): Promise<PublicSiteData | null> {
  const slug = slugParam.safeParse(rawSlug);
  if (!slug.success) return null;
  try {
    return await getPublicSite(slug.data);
  } catch {
    return null;
  }
}
