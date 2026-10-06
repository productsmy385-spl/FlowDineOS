import { AtSign, CalendarDays, CircleCheck, CircleDashed, Facebook, Flame, Images, Info, Instagram, MapPin, MessageCircle, Phone, Store, UtensilsCrossed, type LucideIcon } from "lucide-react";
import type { ResolvedSection } from "@/lib/services/website-theme";
import { Icon } from "@/components/ui/icon";
import { formatBusinessDate } from "@/lib/ui/format";
import { CategoryNav } from "./category-nav";
import { HoursTable, OpenNowBadge } from "./hours";
import { CategoryBlock, MenuItemGrid } from "./menu";
import { MenuRing } from "./menu-ring";
import { SectionEmpty, SectionHeading, SiteCta, SiteImage } from "./primitives";
import { siteGradientStyle } from "./theme";
import { SECTION_ANCHOR, galleryImages, menuAnchor, type SiteView } from "./site-view";

/**
 * The eleven website sections (S1-P09-T012; ADR-013 §6). Each one is driven entirely by the tenant's own row —
 * whether it is shown, where it sits, its heading, its copy, its image and its button — and each has a real empty
 * state that says what is missing rather than filling the space with sample content.
 *
 * All copy is rendered as text. `dangerouslySetInnerHTML` is banned repository-wide, so a restaurant that types
 * `<b>` sees `<b>` (SC-VAL-03).
 */

type SectionProps = { section: ResolvedSection; view: SiteView };

function Band({ section, children }: { section: ResolvedSection; children: React.ReactNode }) {
  const anchor = SECTION_ANCHOR[section.key] ?? section.key.toLowerCase();
  return (
    <section id={anchor} aria-labelledby={`${anchor}-title`} className="scroll-mt-20 py-10 md:py-14">
      <div className="mx-auto w-full max-w-public px-4 md:px-6">
        <div className="flex flex-col gap-6">{children}</div>
      </div>
    </section>
  );
}

/**
 * Open/closed on the hero gradient. It inherits the gradient's checked on-colour rather than a status tone, because
 * a tone token is contrast-checked against the page surface, not against a restaurant's own gradient.
 */
function HeroStatus({ openNow }: { openNow: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-caption">
      <Icon icon={openNow ? CircleCheck : CircleDashed} size={16} />
      {openNow ? "Open now" : "Closed now"}
    </span>
  );
}

/** Heading + optional body, the shape most sections share. */
function Copy({ section, anchor }: { section: ResolvedSection; anchor: string }) {
  return <SectionHeading id={`${anchor}-title`} title={section.headline} lead={section.body} />;
}

// ─── HERO ───

function Hero({ section, view }: SectionProps) {
  const { site } = view;
  const image = section.imageUrl ?? site.identity.heroImageUrl ?? site.restaurant.coverImageUrl;
  const heading = section.customHeadline ? section.headline : site.restaurant.name;
  const tagline = site.identity.tagline;
  const body = section.body ?? site.restaurant.description;
  const cta = section.ctaLabel && section.ctaHref ? { label: section.ctaLabel, href: section.ctaHref } : null;
  const fallbackCta = menuAnchor(site.sections);

  return (
    <section id="top" aria-labelledby="top-title" className="scroll-mt-20" style={siteGradientStyle(site.theme)}>
      <div className="mx-auto grid w-full max-w-public gap-8 px-4 py-14 md:px-6 md:py-20 lg:grid-cols-2 lg:items-center">
        <div className="flex flex-col items-start gap-4">
          {section.customHeadline && section.headline !== site.restaurant.name ? (
            <p className="text-label uppercase opacity-80">{site.restaurant.name}</p>
          ) : null}
          <h1 id="top-title" className="break-words text-display-xl">
            {heading}
          </h1>
          {tagline ? <p className="text-body-public opacity-90">{tagline}</p> : null}
          {body ? <p className="max-w-prose text-body-public whitespace-pre-line opacity-90">{body}</p> : null}
          <div className="flex flex-wrap items-center gap-3 pt-2">
            <HeroStatus openNow={site.openNow} />
            {cta ? <SiteCta label={cta.label} href={cta.href} /> : fallbackCta ? <SiteCta label="See the menu" href={fallbackCta} /> : null}
          </div>
        </div>
        <SiteImage
          src={image}
          alt={site.restaurant.name}
          priority
          displayWidth={720}
          fallbackIcon={Store}
          className="aspect-[4/3] w-full rounded-2xl shadow-e2 lg:aspect-[3/2]"
        />
      </div>
    </section>
  );
}

// ─── Menu-bearing sections ───

function FeaturedMenu({ section, view }: SectionProps) {
  const { site } = view;
  const anchor = SECTION_ANCHOR.FEATURED_MENU;
  const daily = site.dailyMenu;
  const fullMenu = site.sections.some((s) => s.key === "CATEGORIES");
  return (
    <Band section={section}>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <Copy section={section} anchor={anchor} />
        {daily ? (
          <p className="text-caption text-fg-secondary">
            {formatBusinessDate(daily.businessDate, view.locale)}
            {daily.title ? ` · ${daily.title}` : ""}
          </p>
        ) : null}
      </div>
      {daily?.note ? <p className="text-body text-fg-secondary whitespace-pre-line">{daily.note}</p> : null}
      {daily && daily.items.length > 0 ? (
        <MenuItemGrid items={daily.items} formatting={view.formatting} labelledBy={`${anchor}-title`} />
      ) : (
        <SectionEmpty icon={CalendarDays}>
          {daily === null ? "No menu has been published for today yet." : "Today's menu has nothing to show right now."}
          {fullMenu ? " The full menu is below." : ""}
        </SectionEmpty>
      )}
    </Band>
  );
}

function Categories({ section, view }: SectionProps) {
  const { site } = view;
  const anchor = SECTION_ANCHOR.CATEGORIES;
  const withItems = site.categories.filter((category) => category.items.length > 0);
  return (
    <Band section={section}>
      <Copy section={section} anchor={anchor} />
      {site.categories.length === 0 ? (
        <SectionEmpty icon={UtensilsCrossed}>This restaurant has not published its menu yet.</SectionEmpty>
      ) : (
        <>
          {/* The 3D ring of real dishes (owner brief 2026-10-06 §13), with the full readable list below it. */}
          {withItems.length > 0 ? <MenuRing categories={withItems} formatting={view.formatting} title={section.headline ?? "Menu"} /> : null}
          {withItems.length > 1 ? <CategoryNav categories={withItems.map((c) => ({ id: c.id, name: c.name }))} label={section.headline} /> : null}
          <div className="flex flex-col gap-10">
            {site.categories.map((category) => (
              <CategoryBlock key={category.id} category={category} formatting={view.formatting} />
            ))}
          </div>
        </>
      )}
    </Band>
  );
}

function PopularItems({ section, view }: SectionProps) {
  const { site } = view;
  const anchor = SECTION_ANCHOR.POPULAR_ITEMS;
  return (
    <Band section={section}>
      <Copy section={section} anchor={anchor} />
      {site.popularItems.length > 0 ? (
        <MenuItemGrid items={site.popularItems} formatting={view.formatting} labelledBy={`${anchor}-title`} />
      ) : (
        <SectionEmpty icon={Flame}>There are no orders yet to rank dishes by.</SectionEmpty>
      )}
    </Band>
  );
}

// ─── Copy sections ───

function About({ section, view }: SectionProps) {
  const anchor = SECTION_ANCHOR.ABOUT;
  const body = section.body ?? view.site.restaurant.description;
  return (
    <Band section={section}>
      <div className="grid gap-6 lg:grid-cols-2 lg:items-center">
        <div className="flex flex-col gap-4">
          <SectionHeading id={`${anchor}-title`} title={section.headline} />
          {body ? (
            <p className="max-w-prose text-body-public text-fg-secondary whitespace-pre-line">{body}</p>
          ) : (
            <SectionEmpty icon={Info}>This restaurant has not written an introduction yet.</SectionEmpty>
          )}
          {section.ctaLabel && section.ctaHref ? <SiteCta label={section.ctaLabel} href={section.ctaHref} className="self-start" /> : null}
        </div>
        {section.imageUrl ? <SiteImage src={section.imageUrl} alt={view.site.restaurant.name} displayWidth={640} className="aspect-[4/3] w-full rounded-2xl" /> : null}
      </div>
    </Band>
  );
}

function InfoSection({ section, view }: SectionProps) {
  const anchor = SECTION_ANCHOR.INFO;
  return (
    <Band section={section}>
      <SectionHeading id={`${anchor}-title`} title={section.headline} />
      {section.body ? (
        <p className="max-w-prose text-body-public text-fg-secondary whitespace-pre-line">{section.body}</p>
      ) : (
        <SectionEmpty icon={Info}>{view.site.restaurant.name} has not added anything here yet.</SectionEmpty>
      )}
      {section.ctaLabel && section.ctaHref ? <SiteCta label={section.ctaLabel} href={section.ctaHref} className="self-start" /> : null}
    </Band>
  );
}

// ─── Practical sections ───

function Hours({ section, view }: SectionProps) {
  const anchor = SECTION_ANCHOR.HOURS;
  return (
    <Band section={section}>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <Copy section={section} anchor={anchor} />
        <OpenNowBadge openNow={view.site.openNow} />
      </div>
      <HoursTable hours={view.site.hours} timezone={view.site.timezone} locale={view.locale} todayWeekday={view.todayWeekday} />
    </Band>
  );
}

function Gallery({ section, view }: SectionProps) {
  const anchor = SECTION_ANCHOR.GALLERY;
  const images = galleryImages(view, section.imageUrl);
  return (
    <Band section={section}>
      <Copy section={section} anchor={anchor} />
      {images.length === 0 ? (
        <SectionEmpty icon={Images}>There are no photographs on this website yet.</SectionEmpty>
      ) : (
        <ul className="grid list-none grid-cols-2 gap-3 p-0 md:grid-cols-3 lg:grid-cols-4">
          {images.map((image) => (
            <li key={image.src}>
              <SiteImage src={image.src} alt={image.alt} displayWidth={360} className="aspect-square w-full rounded-xl" />
            </li>
          ))}
        </ul>
      )}
    </Band>
  );
}

function Location({ section, view }: SectionProps) {
  const anchor = SECTION_ANCHOR.LOCATION;
  const { restaurant, identity } = view.site;
  const nothing = !restaurant.address && !identity.mapsUrl;
  return (
    <Band section={section}>
      <Copy section={section} anchor={anchor} />
      {nothing ? (
        <SectionEmpty icon={MapPin}>This restaurant has not published an address.</SectionEmpty>
      ) : (
        <div className="flex flex-col items-start gap-4 rounded-2xl border border-border-subtle bg-card p-5">
          {restaurant.address ? (
            <p className="flex min-w-0 items-start gap-2 text-body-public">
              <Icon icon={MapPin} size={20} className="mt-0.5 text-fg-accent" />
              <span className="min-w-0 break-words">{restaurant.address}</span>
            </p>
          ) : null}
          {identity.mapsUrl ? <SiteCta label="Open in maps" href={identity.mapsUrl} /> : null}
        </div>
      )}
    </Band>
  );
}

function Contact({ section, view }: SectionProps) {
  const anchor = SECTION_ANCHOR.CONTACT;
  const { restaurant, identity } = view.site;
  const rows = [
    restaurant.phone ? { icon: Phone, label: restaurant.phone, href: `tel:${restaurant.phone}`, external: false } : null,
    restaurant.email ? { icon: AtSign, label: restaurant.email, href: `mailto:${restaurant.email}`, external: false } : null,
    identity.whatsappE164 ? { icon: MessageCircle, label: `WhatsApp ${identity.whatsappE164}`, href: `https://wa.me/${identity.whatsappE164.replace(/\D/g, "")}`, external: true } : null,
    identity.instagramUrl ? { icon: Instagram, label: "Instagram", href: identity.instagramUrl, external: true } : null,
    identity.facebookUrl ? { icon: Facebook, label: "Facebook", href: identity.facebookUrl, external: true } : null,
  ].filter((row): row is { icon: LucideIcon; label: string; href: string; external: boolean } => row !== null);

  return (
    <Band section={section}>
      <Copy section={section} anchor={anchor} />
      {rows.length === 0 ? (
        <SectionEmpty icon={Phone}>This restaurant has not published contact details.</SectionEmpty>
      ) : (
        <ul className="grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2">
          {rows.map((row) => (
            <li key={row.href}>
              <a
                href={row.href}
                {...(row.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                className="flex min-h-11 min-w-0 items-center gap-3 rounded-xl border border-border-subtle bg-card px-4 py-3 text-body-public hover:border-border-strong"
              >
                <Icon icon={row.icon} size={20} className="text-fg-accent" />
                {/* An email address or a long URL has no spaces to wrap at: break it rather than widen the page. */}
                <span className="min-w-0 break-words">{row.label}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </Band>
  );
}

function CallToAction({ section, view }: SectionProps) {
  const { site } = view;
  const anchor = SECTION_ANCHOR.CTA;
  const configured = section.ctaLabel && section.ctaHref ? { label: section.ctaLabel, href: section.ctaHref } : null;
  const phone = site.restaurant.phone ? { label: `Call ${site.restaurant.phone}`, href: `tel:${site.restaurant.phone}` } : null;
  const menu = menuAnchor(site.sections);
  const action = configured ?? phone ?? (menu ? { label: "See the menu", href: menu } : null);

  return (
    <section id={anchor} aria-labelledby={`${anchor}-title`} className="scroll-mt-20 py-10 md:py-14">
      <div className="mx-auto w-full max-w-public px-4 md:px-6">
        <div className="flex flex-col items-start gap-4 rounded-2xl p-6 md:p-8" style={siteGradientStyle(site.theme)}>
          <h2 id={`${anchor}-title`} className="break-words text-display-m">
            {section.headline}
          </h2>
          {section.body ? <p className="max-w-prose text-body-public whitespace-pre-line opacity-90">{section.body}</p> : null}
          {action ? (
            <SiteCta label={action.label} href={action.href} />
          ) : (
            <p className="text-body opacity-90">Visit us at the restaurant — there is nothing to book online.</p>
          )}
        </div>
      </div>
    </section>
  );
}

// ─── Dispatch ───

const RENDERERS: Record<string, (props: SectionProps) => React.ReactElement> = {
  HERO: Hero,
  ABOUT: About,
  FEATURED_MENU: FeaturedMenu,
  CATEGORIES: Categories,
  POPULAR_ITEMS: PopularItems,
  INFO: InfoSection,
  HOURS: Hours,
  GALLERY: Gallery,
  LOCATION: Location,
  CONTACT: Contact,
  CTA: CallToAction,
};

/** Renders the restaurant's enabled sections in its stored order. An unknown key is skipped, never guessed at. */
export function SiteSections({ view }: { view: SiteView }) {
  return (
    <>
      {view.site.sections.map((section) => {
        const Renderer = RENDERERS[section.key];
        return Renderer ? <Renderer key={section.key} section={section} view={view} /> : null;
      })}
    </>
  );
}
