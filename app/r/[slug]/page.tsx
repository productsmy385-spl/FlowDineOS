import type { Metadata } from "next";
import { imageKitSized } from "@/lib/media/purposes";
import { PublicSitePage } from "@/components/public/site-shell";
import { siteHomeHref, siteView } from "@/components/public/site-view";
import { canonicalPublicUrl, resolvedTenantSlug } from "@/lib/tenancy/request";
import { loadPublicSite, loadPublicSiteForMetadata } from "./load-site";

interface PublicRestaurantPageProps {
  params: Promise<{ slug: string }>;
}

/**
 * api.md §7 asks for ISR at 60 s. The host/path cross-check required by ADR-012 §1 reads request headers, which makes
 * this route dynamic, so this bounds the cached data rather than a cached HTML page; `revalidatePath` on a website
 * save (lib/services/website-theme.ts) still drops whatever is held.
 */
export const revalidate = 60;

/**
 * LD-PUB-01 public restaurant page (no authentication; S1-P09-T011/T012, ADR-012, ADR-013 §6).
 *
 * Reached two ways, both rendering the same page from the same loader:
 * - `{slug}.<PUBLIC_ROOT_DOMAIN>` / `{slug}.localhost` — the middleware rewrites the request here and the slug in the
 *   route segment *is* the resolved host label, re-validated and cross-checked against the internal header.
 * - `/r/{slug}` on the apex host — the preview and QR form, which points canonically at the sub-domain when
 *   `PUBLIC_ROOT_DOMAIN` is configured (§2). With it unset there is no canonical link and the path form is the address.
 *
 * Everything below the shell comes from this tenant's own rows: its theme, its sections in its own order, its copy,
 * its images, its hours and its menu (S1-P09-T012).
 */
export async function generateMetadata({ params }: PublicRestaurantPageProps): Promise<Metadata> {
  const site = await loadPublicSiteForMetadata((await params).slug);
  if (site === null) return { title: "Restaurant not found" };

  const canonical = canonicalPublicUrl(site.slug);
  const title = site.seoTitle ?? site.restaurant.name;
  const description = site.seoDescription ?? site.identity.tagline ?? site.restaurant.description ?? undefined;
  const image = site.identity.heroImageUrl ?? site.restaurant.coverImageUrl;
  return {
    title,
    description,
    ...(site.identity.faviconUrl ? { icons: { icon: imageKitSized(site.identity.faviconUrl, 64) } } : {}),
    ...(canonical === null ? {} : { alternates: { canonical } }),
    openGraph: {
      title,
      ...(description ? { description } : {}),
      ...(canonical === null ? {} : { url: canonical }),
      ...(image ? { images: [imageKitSized(image, 1200)] } : {}),
      type: "website",
    },
  };
}

export default async function PublicRestaurantPage({ params }: PublicRestaurantPageProps) {
  const site = await loadPublicSite((await params).slug);
  const onTenantHost = (await resolvedTenantSlug()) !== null;
  return <PublicSitePage view={siteView(site, { canonicalUrl: canonicalPublicUrl(site.slug), homeHref: siteHomeHref(site.slug, onTenantHost) })} />;
}
