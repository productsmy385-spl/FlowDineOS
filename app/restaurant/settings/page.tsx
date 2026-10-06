import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/layout/page-header";
import { SettingsTabs } from "@/components/settings/settings-tabs";
import { ErrorState } from "@/components/states/error-state";
import { requireTenantPage } from "@/lib/auth/guards";
import { hasPermission } from "@/lib/auth/permissions";
import { countryGroups, currencyGroups, timeZoneGroups } from "@/lib/ui/locale-options";
import { getRestaurantSettingsAction } from "./actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Settings" };

/**
 * `/restaurant/settings` (S1-P07-T005; api.md LD-RST-01). `restaurant:read` is resolved first, and the loader answers
 * for the session's own restaurant — there is no restaurant id in this URL to point somewhere else.
 *
 * The saved values are read on the server and handed to the tabs, so the page shows what is in the database from the
 * first paint; the baseline's hard-coded demo profile (BA-27) is gone. The time zone, currency and country lists are
 * built from Intl here, so the browser receives plain options and they cannot drift from what the schema accepts.
 */
/** Settings areas with their own page; each shows only to roles the server would let in. */
const SETTINGS_LINKS = [
  { href: "/restaurant/website", label: "Website and Brand Kit", permission: "website:update" },
  { href: "/restaurant/tables", label: "Tables and QR codes", permission: "table:manage" },
  { href: "/restaurant/settings/data", label: "Data and backups", permission: "data:export" },
] as const;

export default async function RestaurantSettingsPage() {
  // Management only — the same gate as its navigation entry. Staff roles are sent to /account/forbidden rather than
  // shown a read-only copy of settings they have no part in (ADR-019, owner 2026-10-02).
  const ctx = await requireTenantPage("dashboard:read");
  const settings = await getRestaurantSettingsAction();

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col">
      <PageHeader
        title="Settings"
        description="How this restaurant is described, when it is open, how it runs and where its tickets go."
        actions={
          <div className="flex flex-wrap gap-2">
            {SETTINGS_LINKS.filter((link) => hasPermission(ctx, link.permission)).map((link) => (
              <Link key={link.href} href={link.href} className="inline-flex h-10 items-center rounded-xl border border-border-strong bg-raised px-4 text-label text-fg-primary hover:bg-border-subtle">
                {link.label}
              </Link>
            ))}
          </div>
        }
      />

      {settings.ok ? (
        <SettingsTabs view={settings.data} timeZones={timeZoneGroups()} currencies={currencyGroups()} countries={countryGroups()} />
      ) : (
        <ErrorState requestId={settings.error.requestId} message={settings.error.message} />
      )}
    </div>
  );
}
