import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CalendarDays, Clock, UtensilsCrossed } from "lucide-react";
import { CategoryRail, type RailCategory } from "@/components/public/category-rail";
import { CategoryBlock, MenuItemGrid } from "@/components/public/menu";
import { SectionEmpty, SiteImage } from "@/components/public/primitives";
import { PublicSiteFrame } from "@/components/public/site-shell";
import { siteHomeHref, siteView } from "@/components/public/site-view";
import { findPublicTable } from "@/lib/data/dining-tables";
import { canonicalPublicUrl, resolvedTenantSlug } from "@/lib/tenancy/request";
import { tableMenuModel } from "@/lib/ui/table-menu";
import { loadPublicSite } from "../../load-site";

interface TableMenuPageProps {
  params: Promise<{ slug: string; code: string }>;
}

export const dynamic = "force-dynamic";

/** A table's menu is for the people at that table, not for search engines. */
export const metadata: Metadata = { title: "Menu", robots: { index: false, follow: false } };

/**
 * `/t/{code}` on a restaurant's site (`/r/{slug}/t/{code}` on the apex) — what a table's QR opens (RASOIOS-ADR-021,
 * owner briefs 2026-10-06 §11–13 and 2026-10-07). The restaurant comes from the host/slug exactly as on every public
 * page; the code must belong to an active table of *that* restaurant. An unknown, rotated or switched-off code, or a
 * code of another restaurant, is the same 404 as an unknown restaurant. Nothing here needs an account or an app.
 *
 * Browse only (Q-001): guests read the menu; the server takes the order at the table. Everything shown is the
 * restaurant's own data — its categories in its own order, today's PUBLISHED daily menu for today in the restaurant's
 * time zone (decided on the server), and nothing invented when any of it is missing (`lib/ui/table-menu.ts`).
 */
export default async function TableMenuPage({ params }: TableMenuPageProps) {
  const { slug, code } = await params;
  // The table code is checked first, so an unknown code learns nothing about the restaurant.
  const table = await findPublicTable(String(slug).toLowerCase(), code);
  if (!table) notFound();
  // Audience "table": a seated guest sees the menu even when the restaurant has not published its website.
  const site = await loadPublicSite(slug, "table");

  const onTenantHost = (await resolvedTenantSlug()) !== null;
  const view = siteView(site, { canonicalUrl: canonicalPublicUrl(site.slug), homeHref: siteHomeHref(site.slug, onTenantHost) });
  const model = tableMenuModel(site);
  const rail: RailCategory[] = model.categories.map((category) => ({
    id: category.id,
    name: category.name,
    itemCount: category.items.length,
    imageUrl: category.items.find((item) => item.imageUrl)?.imageUrl ?? null,
    iconKey: category.iconKey,
  }));
  const sections = [{ id: "today", name: "Today", href: "#today" }, ...model.categories.map((c) => ({ id: c.id, name: c.name, href: `#menu-${c.id}` }))];

  return (
    <PublicSiteFrame view={view}>
      <div className="mx-auto flex w-full max-w-public flex-col gap-8 px-4 pb-12 pt-6 md:px-6 md:pt-10" data-testid="table-menu">
        <header className="flex items-center gap-4">
          {site.restaurant.logoUrl ? <SiteImage src={site.restaurant.logoUrl} alt="" displayWidth={64} className="size-14 shrink-0 rounded-2xl border border-border-subtle" /> : null}
          <div className="flex min-w-0 flex-col gap-1">
            <h1 id="table-menu-title" className="break-words text-display-l">
              {site.restaurant.name}
            </h1>
            <p className="flex flex-wrap items-center gap-2 text-body text-fg-secondary">
              <span className="inline-flex items-center rounded-full border border-border-strong bg-card px-3 py-0.5 text-label text-fg-primary" data-testid="table-label">
                {table.label}
              </span>
              <span>Browse the menu. Your server will take your order at the table.</span>
            </p>
          </div>
        </header>

        {model.closed ? (
          <p role="status" className="flex items-center gap-2 rounded-xl border border-status-warning/40 bg-status-warning/12 px-4 py-3 text-body text-fg-primary">
            <Clock className="size-5 shrink-0 text-status-warning" aria-hidden /> Restaurant is currently closed.
          </p>
        ) : null}

        <nav aria-label="Menu sections" className="sticky top-0 z-10 -mx-4 overflow-x-auto bg-canvas/95 px-4 py-2 [scrollbar-width:none] md:-mx-6 md:px-6">
          <ul className="flex list-none gap-2 p-0">
            {sections.map((entry) => (
              <li key={entry.id} className="shrink-0">
                <a href={entry.href} className="inline-flex h-11 items-center rounded-full border border-border-strong bg-card px-4 text-label text-fg-primary hover:bg-raised">
                  {entry.name}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        {rail.length > 0 ? (
          <section aria-labelledby="rail-title" className="flex flex-col gap-3">
            <h2 id="rail-title" className="sr-only">
              Menu sections
            </h2>
            <CategoryRail categories={rail} labelledBy="rail-title" />
          </section>
        ) : null}

        <section id="today" aria-labelledby="today-title" className="flex scroll-mt-24 flex-col gap-4 rounded-3xl border border-border-subtle bg-card p-4 md:p-6" data-testid="today-menu">
          <div className="flex flex-col gap-1">
            <h2 id="today-title" className="flex items-center gap-2 text-display-m">
              <CalendarDays className="size-6 shrink-0 text-fg-accent" aria-hidden />
              {model.today.state === "published" && model.today.title ? model.today.title : "Today's published menu"}
            </h2>
            {model.today.state === "published" && model.today.note ? <p className="whitespace-pre-line text-body-public text-fg-secondary">{model.today.note}</p> : null}
          </div>
          {model.today.state === "none" ? (
            <SectionEmpty icon={CalendarDays}>Today&apos;s menu hasn&apos;t been published yet.</SectionEmpty>
          ) : model.today.groups.length === 0 ? (
            <SectionEmpty icon={CalendarDays}>Nothing on today&apos;s menu is available right now.</SectionEmpty>
          ) : (
            <div className="flex flex-col gap-6">
              {model.today.groups.map((group) => (
                <div key={group.id} className="flex flex-col gap-3">
                  <h3 id={`today-${group.id}`} className="text-heading">
                    {group.name}
                  </h3>
                  <MenuItemGrid items={group.items} formatting={view.formatting} labelledBy={`today-${group.id}`} />
                </div>
              ))}
            </div>
          )}
        </section>

        <section aria-labelledby="full-menu-title" className="flex flex-col gap-6">
          <h2 id="full-menu-title" className="text-display-m">
            Our menu
          </h2>
          {model.categories.length > 0 ? (
            <div className="flex flex-col gap-10">
              {model.categories.map((category) => (
                <CategoryBlock key={category.id} category={category} formatting={view.formatting} />
              ))}
            </div>
          ) : (
            <SectionEmpty icon={UtensilsCrossed}>{model.hasCategories ? "No menu items are currently available." : "Menu is being prepared."}</SectionEmpty>
          )}
        </section>
      </div>
    </PublicSiteFrame>
  );
}
