import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { UtensilsCrossed } from "lucide-react";
import { CategoryBlock } from "@/components/public/menu";
import { DailyStrip } from "@/components/public/daily-strip";
import { MenuRing } from "@/components/public/menu-ring";
import { SectionEmpty } from "@/components/public/primitives";
import { PublicSiteFrame } from "@/components/public/site-shell";
import { siteHomeHref, siteView } from "@/components/public/site-view";
import { findPublicTable } from "@/lib/data/dining-tables";
import { canonicalPublicUrl, resolvedTenantSlug } from "@/lib/tenancy/request";
import { loadPublicSite } from "../../load-site";

interface TableMenuPageProps {
  params: Promise<{ slug: string; code: string }>;
}

export const dynamic = "force-dynamic";

/** A table's menu is for the people at that table, not for search engines. */
export const metadata: Metadata = { title: "Menu", robots: { index: false, follow: false } };

/**
 * `/t/{code}` on a restaurant's site (`/r/{slug}/t/{code}` on the apex) — what a table's QR opens (RASOIOS-ADR-021,
 * owner brief 2026-10-06 §11–13). The restaurant comes from the host/slug exactly as on every public page; the code
 * must belong to an active table of *that* restaurant. An unknown, rotated or switched-off code, or a code of another
 * restaurant, is the same 404 as an unknown restaurant. Nothing here needs an account or an app.
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
  // Only what can be ordered right now (owner request 2026-10-07): sold-out dishes are left off the table menu.
  const withItems = site.categories
    .map((category) => ({ ...category, items: category.items.filter((item) => item.isAvailable) }))
    .filter((category) => category.items.length > 0);
  const today = (site.dailyMenu?.items ?? []).filter((item) => item.isAvailable);

  return (
    <PublicSiteFrame view={view}>
      <section aria-labelledby="table-menu-title" className="mx-auto flex w-full max-w-public flex-col gap-8 px-4 py-8 md:px-6 md:py-12">
        <header className="flex flex-col gap-2">
          <p className="inline-flex w-fit items-center rounded-full border border-border-strong bg-card px-3 py-1 text-label text-fg-primary" data-testid="table-label">
            {table.label}
          </p>
          <h1 id="table-menu-title" className="break-words text-display-l">
            {site.restaurant.name}
          </h1>
          <p className="text-body-public text-fg-secondary">Browse the menu. Your server will take your order at the table.</p>
        </header>

        {today.length > 0 && (
          <section aria-labelledby="table-today-title" className="flex flex-col gap-3">
            <h2 id="table-today-title" className="text-display-m">
              {site.dailyMenu?.title ?? "Today's menu"}
            </h2>
            {site.dailyMenu?.note ? <p className="text-body-public text-fg-secondary whitespace-pre-line">{site.dailyMenu.note}</p> : null}
            <DailyStrip items={today} formatting={view.formatting} labelledBy="table-today-title" />
          </section>
        )}

        {withItems.length > 0 && <h2 className="text-display-m">Full menu</h2>}
        {withItems.length === 0 ? (
          <SectionEmpty icon={UtensilsCrossed}>{site.restaurant.name} has not published its menu yet.</SectionEmpty>
        ) : site.presentation.menuStyle === "RING" ? (
          // The ring is the menu, with a pill per section (Starters, Main course, ...); no grid repeats it.
          <MenuRing categories={withItems} formatting={view.formatting} title={site.restaurant.name} accents={site.presentation.brandColors.map((c) => c.hex)} share={{ restaurantName: site.restaurant.name, url: view.canonicalUrl }} />
        ) : (
          <>
            {withItems.length > 1 && (
              <nav aria-label="Menu sections" className="sticky top-0 z-10 -mx-4 overflow-x-auto bg-canvas/95 px-4 py-2 [scrollbar-width:none]">
                <ul className="flex list-none gap-2 p-0">
                  {withItems.map((category) => (
                    <li key={category.id} className="shrink-0">
                      <a href={`#menu-${category.id}`} className="inline-flex h-10 items-center rounded-full border border-border-strong bg-card px-4 text-label text-fg-primary hover:bg-raised">
                        {category.name}
                      </a>
                    </li>
                  ))}
                </ul>
              </nav>
            )}
            <div className="flex flex-col gap-10">
              {withItems.map((category) => (
                <CategoryBlock key={category.id} category={category} formatting={view.formatting} />
              ))}
            </div>
          </>
        )}
      </section>
    </PublicSiteFrame>
  );
}
