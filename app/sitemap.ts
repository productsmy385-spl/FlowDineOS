import type { MetadataRoute } from "next";
import { listPublicSiteSlugs } from "@/lib/data/public-restaurant";
import { canonicalPublicUrl } from "@/lib/tenancy/request";
import { appUrl } from "@/lib/env";

/**
 * LD-PUB-03 sitemap (S1-P09-T005). Lists the public website of every ACTIVE tenant whose site is published, and
 * nothing else: a suspended tenant and an unpublished website are simply absent, exactly as they are absent from the
 * page itself (ADR-012 §7). No console, platform or account route is ever listed.
 *
 * Each restaurant is listed at its canonical sub-domain when `PUBLIC_ROOT_DOMAIN` is configured, and at the path form
 * otherwise, so the sitemap always matches the `<link rel="canonical">` the page emits (ADR-012 §2).
 */
/**
 * Generated per request, not at build time. `/sitemap.xml` is a static path, so with a `revalidate` export Next
 * prerenders it during `next build` — which made the build query the database, and a build that needs a live database
 * fails wherever one is not reachable yet [fact: Vercel build 6uBtE2956, 2026-09-23, "Error occurred prerendering page
 * /sitemap.xml"]. Building and running are separate concerns; only running should need the data.
 *
 * Crawlers fetch this rarely, so one query per request costs nothing worth saving, and the answer is always current.
 */
export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = (appUrl() ?? "").replace(/\/$/, "");
  const sites = await listPublicSiteSlugs();

  return sites.flatMap((site) => {
    const effectiveSlug = site.subdomain ?? site.slug;
    const home = canonicalPublicUrl(effectiveSlug) ?? (base === "" ? null : `${base}/r/${site.slug}`);
    if (home === null) return [];
    const root = home.replace(/\/$/, "");
    return [
      { url: root, lastModified: site.updatedAt, changeFrequency: "weekly" as const, priority: 1 },
      { url: `${root}/menu`, lastModified: site.updatedAt, changeFrequency: "weekly" as const, priority: 0.9 },
      { url: `${root}/daily`, lastModified: site.updatedAt, changeFrequency: "daily" as const, priority: 0.8 },
    ];
  });
}
