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
          hasPermission(ctx, "website:update") ? (
            <Link href="/restaurant/website" className="inline-flex h-10 items-center rounded-xl border border-border-strong bg-raised px-4 text-label text-fg-primary hover:bg-border-subtle">
              Website and branding
            </Link>
          ) : undefined
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
