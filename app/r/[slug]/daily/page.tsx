import type { Metadata } from "next";
import { CalendarDays } from "lucide-react";
import { MenuItemGrid } from "@/components/public/menu";
import { SectionEmpty, SiteCta } from "@/components/public/primitives";
import { PublicSiteFrame } from "@/components/public/site-shell";
import { menuAnchor, siteHomeHref, siteView } from "@/components/public/site-view";
import { publicBusinessDate } from "@/lib/data/public-restaurant";
import { canonicalPublicUrl, resolvedTenantSlug } from "@/lib/tenancy/request";
import { formatBusinessDate } from "@/lib/ui/format";
import { loadPublicSite, loadPublicSiteForMetadata } from "../load-site";

interface DailyMenuPageProps {
  params: Promise<{ slug: string }>;
}

export const revalidate = 60;

/**
 * LD-PUB-02 — today's menu as its own shareable address (S1-P09-T004, REQ-SOC-002).
 *
 * "Today" is the business date in the *restaurant's* time zone, so a link shared at 23:00 in Bengaluru shows the
 * Bengaluru menu whoever opens it (TC-DMENU-005). The page is reachable only for a published website: an unknown
 * slug, a suspended tenant and an unpublished site all 404 identically through the shared loader.
 */
export async function generateMetadata({ params }: DailyMenuPageProps): Promise<Metadata> {
  const site = await loadPublicSiteForMetadata((await params).slug);
  if (site === null) return { title: "Restaurant not found" };

  const title = `${site.dailyMenu?.title ?? "Today's menu"} · ${site.restaurant.name}`;
  const description = site.dailyMenu?.note ?? site.dailyMenu?.title ?? undefined;
  const canonical = canonicalPublicUrl(site.slug);
  const image = site.identity.heroImageUrl ?? site.restaurant.coverImageUrl;
  return {
    title,
    description,
    ...(canonical === null ? {} : { alternates: { canonical: `${canonical.replace(/\/$/, "")}/daily` } }),
    openGraph: {
      title,
      ...(description ? { description } : {}),
      ...(canonical === null ? {} : { url: `${canonical.replace(/\/$/, "")}/daily` }),
      ...(image ? { images: [image] } : {}),
      type: "website",
    },
  };
}

export default async function DailyMenuPage({ params }: DailyMenuPageProps) {
  const site = await loadPublicSite((await params).slug);
  const onTenantHost = (await resolvedTenantSlug()) !== null;
  const homeHref = siteHomeHref(site.slug, onTenantHost);
  const view = siteView(site, { canonicalUrl: canonicalPublicUrl(site.slug), homeHref });
  const daily = site.dailyMenu;
  const businessDate = daily?.businessDate ?? publicBusinessDate(site.timezone);
  const fullMenu = menuAnchor(site.sections);

  return (
    <PublicSiteFrame view={view}>
      <section aria-labelledby="daily-title" className="mx-auto flex w-full max-w-public flex-col gap-6 px-4 py-10 md:px-6 md:py-14">
        <div className="flex flex-col gap-2">
          <p className="text-caption text-fg-secondary">{formatBusinessDate(businessDate, view.locale)}</p>
          <h1 id="daily-title" className="break-words text-display-l">
            {daily?.title ?? "Today's menu"}
          </h1>
          {daily?.note ? <p className="max-w-prose text-body-public text-fg-secondary whitespace-pre-line">{daily.note}</p> : null}
        </div>

        {daily && daily.items.length > 0 ? (
          <MenuItemGrid items={daily.items} formatting={view.formatting} labelledBy="daily-title" />
        ) : (
          <SectionEmpty icon={CalendarDays}>
            {daily === null ? `${site.restaurant.name} has not published a menu for today.` : `Today's menu at ${site.restaurant.name} has nothing to show right now.`}
          </SectionEmpty>
        )}

        {fullMenu ? <SiteCta label="See the full menu" href={`${homeHref}${fullMenu}`} className="self-start" /> : null}
      </section>
    </PublicSiteFrame>
  );
}
