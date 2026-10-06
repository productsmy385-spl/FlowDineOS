import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { UtensilsCrossed } from "lucide-react";
import { CategoryBlock } from "@/components/public/menu";
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
  const site = await loadPublicSite(slug);
  const table = await findPublicTable(site.slug, code);
  if (!table) notFound();

  const onTenantHost = (await resolvedTenantSlug()) !== null;
  const view = siteView(site, { canonicalUrl: canonicalPublicUrl(site.slug), homeHref: siteHomeHref(site.slug, onTenantHost) });
  const withItems = site.categories.filter((category) => category.items.length > 0);

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

        {withItems.length === 0 ? (
          <SectionEmpty icon={UtensilsCrossed}>{site.restaurant.name} has not published its menu yet.</SectionEmpty>
        ) : (
          <>
            <MenuRing categories={withItems} formatting={view.formatting} title={site.restaurant.name} />
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
