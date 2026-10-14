import type { Metadata } from "next";
import { UtensilsCrossed } from "lucide-react";
import { MenuItemCard } from "@/components/public/menu";
import { CategoryNav } from "@/components/public/category-nav";
import { MenuRing } from "@/components/public/menu-ring";
import { SectionEmpty } from "@/components/public/primitives";
import { PublicSiteFrame } from "@/components/public/site-shell";
import { siteHomeHref, siteView } from "@/components/public/site-view";
import { canonicalPublicUrl, resolvedTenantSlug } from "@/lib/tenancy/request";
import { loadPublicSite, loadPublicSiteForMetadata } from "../load-site";

interface RestaurantMenuPageProps {
  params: Promise<{ slug: string }>;
}

export const revalidate = 60;

/**
 * Public restaurant full menu page (LD-PUB-01, S1-P09-T011).
 * Reached via direct /menu on tenant subdomain or /r/[slug]/menu on apex.
 */
export async function generateMetadata({ params }: RestaurantMenuPageProps): Promise<Metadata> {
  const site = await loadPublicSiteForMetadata((await params).slug);
  if (site === null) return { title: "Restaurant not found" };

  const title = `Menu · ${site.restaurant.name}`;
  const description = `Explore the full food and drink menu for ${site.restaurant.name}.`;
  const canonical = canonicalPublicUrl(site.slug);
  const image = site.identity.heroImageUrl ?? site.restaurant.coverImageUrl;
  return {
    title,
    description,
    ...(canonical === null ? {} : { alternates: { canonical: `${canonical.replace(/\/$/, "")}/menu` } }),
    openGraph: {
      title,
      description,
      ...(canonical === null ? {} : { url: `${canonical.replace(/\/$/, "")}/menu` }),
      ...(image ? { images: [image] } : {}),
      type: "website",
    },
  };
}

export default async function RestaurantMenuPage({ params }: RestaurantMenuPageProps) {
  const site = await loadPublicSite((await params).slug);
  const onTenantHost = (await resolvedTenantSlug()) !== null;
  const homeHref = siteHomeHref(site.slug, onTenantHost);
  const view = siteView(site, { canonicalUrl: canonicalPublicUrl(site.slug), homeHref });
  const withItems = site.categories.filter((category) => category.items.length > 0);

  return (
    <PublicSiteFrame view={view}>
      <section aria-labelledby="menu-title" className="mx-auto flex w-full max-w-public flex-col gap-8 px-4 py-10 md:px-6 md:py-14">
        <div className="flex flex-col gap-2">
          <h1 id="menu-title" className="break-words text-display-l" style={{ color: "var(--website-heading-color)" }}>
            Menu
          </h1>
          <p className="max-w-prose text-body-public text-fg-secondary">
            Explore our handcrafted dishes and refreshments.
          </p>
        </div>

        {site.categories.length === 0 || withItems.length === 0 ? (
          <SectionEmpty icon={UtensilsCrossed}>
            This restaurant has not published its menu yet.
          </SectionEmpty>
        ) : site.presentation.menuStyle === "RING" ? (
          <MenuRing
            categories={withItems}
            formatting={view.formatting}
            title="Menu"
            accents={site.presentation.brandColors.map((c) => c.hex)}
            share={{ restaurantName: site.restaurant.name, url: view.canonicalUrl }}
          />
        ) : (
          <div className="flex flex-col gap-10">
            {withItems.length > 1 ? (
              <CategoryNav categories={withItems.map((c) => ({ id: c.id, name: c.name }))} label="Categories" />
            ) : null}
            <div className="flex flex-col gap-12">
              {withItems.map((category) => (
                <div key={category.id} id={`category-${category.id}`} className="scroll-mt-24 flex flex-col gap-4">
                  <div className="flex flex-col gap-1">
                    <h2 className="text-display-s" style={{ color: "var(--website-heading-color)" }}>
                      {category.name}
                    </h2>
                    {category.description ? (
                      <p className="text-body text-fg-secondary">{category.description}</p>
                    ) : null}
                  </div>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {category.items.map((item) => (
                      <MenuItemCard key={item.id} item={item} formatting={view.formatting} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>
    </PublicSiteFrame>
  );
}
