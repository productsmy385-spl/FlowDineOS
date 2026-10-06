import type { PublicRestaurantData } from "@/lib/data/public-restaurant";
import type { WebsiteIdentityRow } from "@/lib/data/website";
import type { ResolvedSection, ResolvedTheme, SitePresentation } from "@/lib/services/website-theme";
import { localParts } from "@/lib/time";
import { localeForCountry } from "@/lib/ui/format";

/**
 * The view model of one restaurant's public website (S1-P09-T012).
 *
 * Everything the sections render is on this object, and all of it came from that tenant's own rows: the LD-PUB-01
 * projection, the resolved theme, the identity block and the enabled sections in their stored order. There is no
 * fallback restaurant, no sample menu and no platform copy — two tenants necessarily produce two different pages.
 */

/** Structural view of `PublicSiteData` from `lib/services/website-theme.ts`, without depending on the module. */
export type PublicSite = PublicRestaurantData & {
  presentation: SitePresentation;
  theme: ResolvedTheme;
  cssVariables: Record<string, string>;
  identity: WebsiteIdentityRow;
  sections: ResolvedSection[];
  seoTitle: string | null;
  seoDescription: string | null;
};

export type SiteView = {
  site: PublicSite;
  /** Display locale derived from the restaurant's country, so prices and times read the way its guests expect. */
  locale: string;
  formatting: { currencyCode: string; locale: string };
  /** ISO weekday (1 = Monday) of "now" in the restaurant's time zone. */
  todayWeekday: number;
  /** Canonical absolute URL, or null when `PUBLIC_ROOT_DOMAIN` is unset (ADR-012 §3). */
  canonicalUrl: string | null;
  /**
   * The site's own home path for the host this request arrived on: `/` on `{slug}.<domain>`, `/r/{slug}` on the apex
   * host. Links inside the site use it so a visitor is never bounced between hosts mid-visit (ADR-012 §6).
   */
  homeHref: string;
};

export function siteView(site: PublicSite, options: { canonicalUrl: string | null; homeHref: string; now?: Date }): SiteView {
  const locale = localeForCountry(site.countryCode);
  return {
    site,
    locale,
    formatting: { currencyCode: site.currencyCode, locale },
    todayWeekday: localParts(options.now ?? new Date(), site.timezone).weekday,
    canonicalUrl: options.canonicalUrl,
    homeHref: options.homeHref,
  };
}

/** `/` on a tenant host, `/r/{slug}` on the apex host. */
export function siteHomeHref(slug: string, onTenantHost: boolean): string {
  return onTenantHost ? "/" : `/r/${slug}`;
}

/** In-page anchor of each section, so the header navigation and CTAs link to real targets on the page. */
export const SECTION_ANCHOR: Readonly<Record<string, string>> = {
  HERO: "top",
  ABOUT: "about",
  FEATURED_MENU: "today",
  CATEGORIES: "menu",
  POPULAR_ITEMS: "popular",
  INFO: "info",
  HOURS: "hours",
  GALLERY: "gallery",
  LOCATION: "location",
  CONTACT: "contact",
  CTA: "visit",
};

/** Sections worth offering in the header navigation, in the restaurant's own order and wording. */
const NAVIGABLE = new Set(["ABOUT", "FEATURED_MENU", "CATEGORIES", "POPULAR_ITEMS", "INFO", "HOURS", "GALLERY", "LOCATION", "CONTACT"]);

export type SiteNavLink = { key: string; href: string; label: string };

export function siteNavLinks(sections: readonly ResolvedSection[]): SiteNavLink[] {
  return sections
    .filter((section) => NAVIGABLE.has(section.key))
    .map((section) => ({ key: section.key, href: `#${SECTION_ANCHOR[section.key]}`, label: section.headline }));
}

/** The sections a guest reaches for most, shown inline in a desktop header; the ☰ drawer always lists every one. */
const PRIMARY_NAV = ["CATEGORIES", "FEATURED_MENU", "ABOUT", "GALLERY", "HOURS", "CONTACT"];

export function primaryNavLinks(links: readonly SiteNavLink[], max = 5): SiteNavLink[] {
  return PRIMARY_NAV.flatMap((key) => links.filter((link) => link.key === key)).slice(0, max);
}

/** Up to two initials for a restaurant without a logo, e.g. "Akshayapatra-Devarapalli" → "AD". */
export function monogram(name: string): string {
  const words = name.split(/[\s\-–·&]+/).filter((word) => /[\p{L}\p{N}]/u.test(word));
  const letters = words.slice(0, 2).map((word) => Array.from(word.replace(/^[^\p{L}\p{N}]+/u, ""))[0] ?? "");
  return letters.join("").toLocaleUpperCase() || "·";
}

/** The first in-page menu anchor that actually exists, for CTAs that should lead to the food. */
export function menuAnchor(sections: readonly ResolvedSection[]): string | null {
  const target = sections.find((section) => section.key === "CATEGORIES") ?? sections.find((section) => section.key === "FEATURED_MENU");
  return target ? `#${SECTION_ANCHOR[target.key]}` : null;
}

/** Outbound links the restaurant published, for structured data and the contact section. */
export function socialLinks(identity: WebsiteIdentityRow): string[] {
  return [identity.instagramUrl, identity.facebookUrl, identity.mapsUrl].filter((url): url is string => typeof url === "string" && url.length > 0);
}

/**
 * Photographs this restaurant has actually published — the section's own image first, then its cover and hero, then
 * its menu photographs. No stock imagery is ever substituted; an empty result renders the gallery's empty state.
 */
export function galleryImages(view: SiteView, sectionImageUrl: string | null): Array<{ src: string; alt: string }> {
  const { site } = view;
  const candidates: Array<{ src: string | null; alt: string }> = [
    { src: sectionImageUrl, alt: site.restaurant.name },
    { src: site.identity.heroImageUrl, alt: site.restaurant.name },
    { src: site.restaurant.coverImageUrl, alt: site.restaurant.name },
    ...site.categories.flatMap((category) => category.items.map((item) => ({ src: item.imageUrl, alt: item.name }))),
  ];
  const seen = new Set<string>();
  const images: Array<{ src: string; alt: string }> = [];
  for (const candidate of candidates) {
    if (!candidate.src || seen.has(candidate.src)) continue;
    seen.add(candidate.src);
    images.push({ src: candidate.src, alt: candidate.alt });
    if (images.length === 12) break;
  }
  return images;
}
