import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { PublicAddress } from "@/components/admin/public-address";
import { TenantLifecycle } from "@/components/admin/tenant-lifecycle";
import { TenantMembers } from "@/components/admin/tenant-members";
import { Alert } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import { DescriptionList, type DescriptionItem } from "@/components/ui/description-list";
import { Icon } from "@/components/ui/icon";
import { StatusBadge } from "@/components/ui/status-badge";
import { Badge } from "@/components/ui/badge";
import { requirePlatformPage } from "@/lib/auth/guards";
import { hasPermission } from "@/lib/auth/permissions";
import { NotFoundError } from "@/lib/errors";
import { getTenantFeatures, inspectTenant, type TenantFeatureView } from "@/lib/services/platform-tenants";
import { TenantFeaturesCard } from "@/components/admin/feature-switches";
import { normalizeRootDomain } from "@/lib/tenancy/hostnames";
import { formatInZone } from "@/lib/ui/format";
import { DOMAIN_ICONS } from "@/lib/ui/icons";
import { IconTile } from "@/components/ui/icon-tile";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Restaurant" };

type SearchParams = Record<string, string | string[] | undefined>;

const utc = (iso: string) => `${formatInZone(iso, "UTC", "datetime")} UTC`;

/**
 * `/admin/tenants/[tenantId]` (S1-P06-T006; api.md LD-ADM-03, SA-ADM-02…07).
 *
 * Metadata, members, counts and lifecycle history of one restaurant. The loader returns *counts* for operational data
 * and never a single order, customer, transaction or menu row, so there is nothing on this page for the platform to
 * read out of a restaurant's business (SC-RBAC-07, TC-ADMIN-006). An unknown or malformed id renders the ordinary
 * not-found page — the same response either way, so the URL cannot be used to discover which ids exist.
 *
 * Times are UTC with the zone named: a platform page has no one restaurant's time zone to speak in.
 */
export default async function TenantDetailPage({ params, searchParams }: { params: Promise<{ tenantId: string }>; searchParams: Promise<SearchParams> }) {
  const ctx = await requirePlatformPage("platform:tenant:read");
  const { tenantId } = await params;
  const query = await searchParams;

  let inspection;
  let features: TenantFeatureView[] = [];
  try {
    inspection = await inspectTenant(ctx, tenantId);
    features = await getTenantFeatures(ctx, tenantId);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const { tenant, restaurant, members, counts, lifecycle } = inspection;

  const rootDomain = normalizeRootDomain(process.env.PUBLIC_ROOT_DOMAIN);
  const canInvite = hasPermission(ctx, "platform:tenant_admin:invite");
  const justCreated = query.created === "1";
  const invitation = typeof query.invitation === "string" ? query.invitation : undefined;
  const firstAdminEmail = members[0]?.email;

  const details: DescriptionItem[] = [
    { term: "Public address", value: <PublicAddress slug={tenant.slug} rootDomain={rootDomain} /> },
    { term: "Created", value: utc(tenant.createdAt) },
    { term: "Time zone", value: restaurant?.timezone ?? "—" },
    { term: "Currency", value: restaurant?.currencyCode ?? "—" },
    { term: "Country", value: restaurant?.countryCode ?? "—" },
    { term: "City", value: restaurant?.city ?? "Not set" },
    { term: "Website", value: restaurant?.websitePublished ? "Published" : "Not published" },
    {
      term: "Handover",
      value: tenant.handedOverAt ? `Handed over ${utc(tenant.handedOverAt)}` : "Still being provisioned by the platform",
    },
  ];

  return (
    <div className="flex flex-col">
      <Link href="/admin/tenants" className="mb-4 inline-flex items-center gap-2 text-label text-fg-secondary hover:text-fg-primary">
        <Icon icon={ArrowLeft} size={18} />
        All restaurants
      </Link>

      {justCreated && (
        <Alert
          tone={invitation === "sent" ? "success" : "warning"}
          title={invitation === "sent" ? "Restaurant created" : "Restaurant created, invitation not sent"}
          className="mb-6"
        >
          {invitation === "sent"
            ? `An invitation is on its way to ${firstAdminEmail ?? "the administrator"}.`
            : "The restaurant exists and is ready. The invitation email could not be sent — resend it below."}
        </Alert>
      )}

      <div className="flex flex-col gap-4 pb-6 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-4">
          <IconTile icon={DOMAIN_ICONS.restaurant} size="lg" tone="primary" />
          <div className="min-w-0">
            <h1 className="text-display-m text-fg-primary">{tenant.name}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <StatusBadge domain="tenant" status={tenant.status} />
              <Badge tone={tenant.provisioningState === "HANDED_OVER" ? "success" : "warning"}>
                {tenant.provisioningState === "HANDED_OVER" ? "Handed over" : "Provisioning"}
              </Badge>
              {restaurant && restaurant.name !== tenant.name && <span className="text-body text-fg-secondary">Trading as {restaurant.name}</span>}
            </div>
          </div>
        </div>
        <TenantLifecycle
          tenantId={tenant.id}
          name={tenant.name}
          status={tenant.status}
          provisioningState={tenant.provisioningState}
          handoverReady={members.some((member) => member.role === "TENANT_ADMIN" && member.status === "ACTIVE")}
          can={{
            update: hasPermission(ctx, "platform:tenant:update"),
            suspend: hasPermission(ctx, "platform:tenant:suspend"),
            reactivate: hasPermission(ctx, "platform:tenant:reactivate"),
          }}
        />
      </div>

      {tenant.status === "SUSPENDED" && (
        <Alert tone="danger" title={`Suspended ${tenant.suspendedAt ? utc(tenant.suspendedAt) : ""}`.trim()} className="mb-6">
          {tenant.suspensionReason ?? "No reason was recorded."}
        </Alert>
      )}

      <section aria-labelledby="tenant-details" className="flex flex-col gap-4">
        <h2 id="tenant-details" className="text-heading text-fg-primary">
          Details
        </h2>
        <Card padding="feature">
          <DescriptionList items={details} />
        </Card>
      </section>

      <section aria-labelledby="tenant-usage" className="mt-8 flex flex-col gap-4">
        <h2 id="tenant-usage" className="text-heading text-fg-primary">
          How much is in it
        </h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <CountTile label="Menu items" value={counts.menuItems} />
          <CountTile label="Orders in the last 30 days" value={counts.ordersLast30Days} />
          <CountTile label="Print agents online" value={counts.printAgentsActive} />
        </div>
        <p className="text-caption text-fg-secondary">
          Counts only. The platform console cannot open this restaurant&apos;s orders, customers, transactions or menu.
        </p>
      </section>

      <section aria-labelledby="tenant-features-title" className="mt-8 flex flex-col gap-4">
        <h2 id="tenant-features-title" className="text-heading text-fg-primary">
          Access and features
        </h2>
        <TenantFeaturesCard tenantId={tenant.id} initial={features.filter((f) => f.enabled).map((f) => f.key)} canEdit={hasPermission(ctx, "platform:tenant:update")} />
      </section>

      <section className="mt-8">
        <TenantMembers tenantId={tenant.id} members={members} canInvite={canInvite} />
      </section>

      <section aria-labelledby="tenant-lifecycle" className="mt-8 flex flex-col gap-4">
        <h2 id="tenant-lifecycle" className="text-heading text-fg-primary">
          Lifecycle history
        </h2>
        <Card padding="compact">
          {lifecycle.length === 0 ? (
            <p className="px-1 py-3 text-body text-fg-secondary">Nothing recorded yet.</p>
          ) : (
            <ul className="flex flex-col">
              {lifecycle.map((event) => (
                <li key={event.id} className="flex flex-col gap-1 border-b border-border-subtle px-1 py-3 last:border-b-0">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-mono text-label text-fg-primary">{event.action}</span>
                    <span className="text-caption text-fg-secondary">
                      {event.actorRole ? `${event.actorRole} · ` : ""}
                      {utc(event.createdAt)}
                    </span>
                  </div>
                  {event.reason && <p className="text-body text-fg-secondary">“{event.reason}”</p>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>
    </div>
  );
}

function CountTile({ label, value }: { label: string; value: number }) {
  return (
    <Card padding="feature">
      <p className="text-caption text-fg-secondary">{label}</p>
      <p className="text-display-m tabular-nums text-fg-primary">{value}</p>
    </Card>
  );
}
