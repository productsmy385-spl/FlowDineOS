import { LogIn } from "lucide-react";
import Link from "next/link";
import { ShareButton } from "./share";
import { JsonLd, restaurantJsonLd } from "@/lib/seo/json-ld";
import { OpenNowBadge } from "./hours";
import { SiteImage } from "./primitives";
import { SiteMenu } from "./site-menu";
import { SiteSections } from "./sections";
import { siteThemeStyle, surfaceThemeAttribute } from "./theme";
import { monogram, primaryNavLinks, siteNavLinks, socialLinks, type SiteView } from "./site-view";
import { appUrl } from "@/lib/env";

/**
 * The public website shell (S1-P09-T003/T012; ADR-013 §6).
 *
 * The root element carries the tenant's theme — its `--site-*` variables, the semantic tokens re-pointed to the same
 * checked colours, and `data-theme` for the surface mode it chose — so a restaurant that picked a light website gets
 * a light website instead of inheriting the dark console theme. Nothing on this page carries platform branding: the
 * header shows the restaurant's own mark, and the footer its own details.
 */

/**
 * Staff sign-in lives on the apex host only (ADR-012 §6). Linking to its absolute URL means a click on a tenant
 * sub-domain goes straight there instead of relying on the middleware redirect — which Next.js turns into a relative
 * (self-looping) `Location` when the apex is the dev server's own `localhost:<port>`.
 */
function staffSignInHref(): string {
  const base = appUrl();
  if (!base) return "/sign-in";
  try {
    const url = new URL("/sign-in", base);
    // NEXT_PUBLIC_* is baked in at build time. A production build that was given a loopback APP_URL (e.g. a copied
    // development .env) must never send a visitor to *their own* machine — that is ERR_CONNECTION_REFUSED for everyone.
    // The same-site path is always reachable; on a tenant sub-domain the middleware forwards it to the apex host.
    if (process.env.NODE_ENV === "production" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return "/sign-in";
    return url.toString();
  } catch {
    return "/sign-in";
  }
}

/**
 * The restaurant's mark: its uploaded logo, or — when it has none — its initials on its own primary colour. Never the
 * platform's mark (ADR-013 §6: the public site is the restaurant's).
 */
function BrandMark({ name, logoUrl }: { name: string; logoUrl: string | null }) {
  if (logoUrl) return <SiteImage src={logoUrl} alt="" displayWidth={40} className="h-10 w-10 shrink-0 rounded-xl" />;
  return (
    <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-action-primary font-display text-subheading text-action-primary-fg">
      {monogram(name)}
    </span>
  );
}

/**
 * The public header: the restaurant's mark, its own sections, whether it is open, and the staff door.
 *
 * Sticky `glass-1` in the restaurant's theme, so the way back stays reachable down a long menu — the sections were
 * already written with `scroll-mt-20` for exactly this, so an anchored heading clears the bar instead of hiding under
 * it. `glass-1` falls back to an opaque surface where `backdrop-filter` is unsupported (ADR-013 §2).
 *
 * One 64 px row at every width, and nothing in it ever scrolls or wraps:
 * - `xl` and up: mark · up to five most-used sections · open/closed · Staff login · ☰. Nine section names never fit
 *   beside a long restaurant name, so the inline set is capped and the drawer always holds all of them.
 * - `md`–`lg`: mark · open/closed · Staff login · ☰.
 * - below `md`: mark · ☰ — the badge and Staff login move into the drawer, so a 320 px phone never squeezes three
 *   controls beside a long restaurant name. The name wraps to two lines before it would push the ☰ off-screen.
 */
function SiteHeader({ view }: { view: SiteView }) {
  const { site } = view;
  const links = siteNavLinks(site.sections);
  const inline = primaryNavLinks(links);
  const signIn = staffSignInHref();
  const share = {
    title: site.restaurant.name,
    text: site.identity.tagline ? `${site.restaurant.name} - ${site.identity.tagline}` : site.restaurant.name,
    url: view.canonicalUrl,
    imageUrl: site.identity.heroImageUrl ?? site.restaurant.coverImageUrl ?? site.identity.logoUrl,
  };
  return (
    <header className="glass-1 sticky top-0 z-header border-b print:static">
      <div className="mx-auto flex h-header w-full max-w-public items-center gap-3 px-4 md:px-6">
        <a href={view.homeHref} className="flex min-w-0 flex-1 items-center gap-3 xl:max-w-xs xl:flex-none">
          <BrandMark name={site.restaurant.name} logoUrl={site.identity.logoUrl} />
          <span className="line-clamp-2 min-w-0 break-words font-display text-subheading leading-tight md:text-heading">{site.restaurant.name}</span>
        </a>

        {inline.length > 0 ? (
          <nav aria-label={`${site.restaurant.name} sections`} className="hidden min-w-0 flex-1 justify-center xl:flex">
            <ul className="flex list-none items-center gap-1 p-0">
              {inline.map((link) => (
                <li key={link.href}>
                  <a
                    href={link.href}
                    className="relative inline-flex h-10 items-center whitespace-nowrap rounded-xl px-3 text-nav text-fg-secondary transition-colors duration-fast ease-standard after:absolute after:inset-x-3 after:bottom-1 after:h-0.5 after:origin-left after:scale-x-0 after:rounded-full after:bg-action-primary after:transition-transform after:duration-fast hover:text-fg-primary motion-safe:hover:after:scale-x-100"
                  >
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        ) : null}

        <div className="hidden shrink-0 items-center gap-3 md:flex">
          <OpenNowBadge openNow={site.openNow} />
          <ShareButton content={share} />
          {/* The restaurant's own staff sign in here, on the apex host (one Clerk domain); after sign-in the console
              shows only the restaurants that person is a member of. */}
          <Link
            href={signIn}
            prefetch={false}
            className="group inline-flex h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-xl border border-border-strong px-3 text-nav text-fg-primary transition-[background-color,transform,box-shadow] duration-fast ease-standard hover:bg-raised motion-safe:hover:-translate-y-px motion-safe:hover:shadow-e2"
          >
            <LogIn aria-hidden="true" className="h-4 w-4 transition-transform duration-fast ease-standard motion-safe:group-hover:translate-x-0.5" />
            Staff login
          </Link>
        </div>

        <ShareButton content={share} compact className="md:hidden" />
        <SiteMenu
          className="shrink-0"
          restaurantName={site.restaurant.name}
          links={links}
          staffSignInHref={signIn}
          status={<OpenNowBadge openNow={site.openNow} />}
        />
      </div>
    </header>
  );
}

/** A published link shown by its host name; an unparsable value (never written by the validator) shows verbatim. */
function linkLabel(href: string): string {
  try {
    return new URL(href).hostname.replace(/^www\./, "");
  } catch {
    return href;
  }
}

function SiteFooter({ view }: { view: SiteView }) {
  const { site } = view;
  const links = socialLinks(site.identity);
  return (
    <footer className="border-t border-border-subtle">
      <div className="mx-auto flex w-full max-w-public flex-col gap-3 px-4 py-8 md:px-6">
        <p className="font-display text-heading">{site.restaurant.name}</p>
        {site.identity.tagline ? <p className="text-body text-fg-secondary">{site.identity.tagline}</p> : null}
        {site.restaurant.address ? <p className="break-words text-body text-fg-secondary">{site.restaurant.address}</p> : null}
        {links.length > 0 ? (
          <ul className="flex list-none flex-wrap gap-4 p-0">
            {links.map((href) => (
              <li key={href}>
                <a href={href} target="_blank" rel="noopener noreferrer" className="text-label text-fg-accent hover:underline">
                  {linkLabel(href)}
                </a>
              </li>
            ))}
          </ul>
        ) : null}
        <p className="text-caption text-fg-secondary">
          {site.restaurant.name} · {site.timezone}
        </p>
      </div>
    </footer>
  );
}

/** schema.org data for this restaurant, built only from what it has published (LD-PUB-03). */
function SiteJsonLd({ view }: { view: SiteView }) {
  const { site } = view;
  return (
    <JsonLd
      data={restaurantJsonLd({
        name: site.restaurant.name,
        description: site.seoDescription ?? site.identity.tagline ?? site.restaurant.description,
        url: view.canonicalUrl,
        image: site.identity.heroImageUrl ?? site.restaurant.coverImageUrl ?? site.restaurant.logoUrl,
        telephone: site.restaurant.phone,
        email: site.restaurant.email,
        address: site.restaurant.address,
        currencyCode: site.currencyCode,
        sameAs: socialLinks(site.identity),
        hours: site.hours.filter((day) => !day.isClosed).map((day) => ({ dayOfWeek: day.dayOfWeek, shifts: day.shifts })),
        menu: site.categories.map((category) => ({
          name: category.name,
          description: category.description,
          items: category.items.map((item) => ({ name: item.name, description: item.description, price: item.price })),
        })),
      })}
    />
  );
}

/** The whole public page: theme root, header, the restaurant's sections in its own order, footer. */
export function PublicSitePage({ view }: { view: SiteView }) {
  const { site } = view;
  return (
    <div
      data-theme={surfaceThemeAttribute(site.theme)}
      data-site-slug={site.slug}
      style={siteThemeStyle(site.theme, site.cssVariables)}
      className="min-h-screen bg-canvas text-fg-primary"
    >
      <SiteJsonLd view={view} />
      <SiteHeader view={view} />
      <main>
        <SiteSections view={view} />
      </main>
      <SiteFooter view={view} />
    </div>
  );
}

/** A small page (today's menu) on the same theme, without the full section list. */
export function PublicSiteFrame({ view, children }: { view: SiteView; children: React.ReactNode }) {
  const { site } = view;
  return (
    <div
      data-theme={surfaceThemeAttribute(site.theme)}
      data-site-slug={site.slug}
      style={siteThemeStyle(site.theme, site.cssVariables)}
      className="min-h-screen bg-canvas text-fg-primary"
    >
      <SiteHeader view={view} />
      <main>{children}</main>
      <SiteFooter view={view} />
    </div>
  );
}
