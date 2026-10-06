import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/page-header";
import { DataManagement } from "@/components/settings/data-management";
import { ErrorState } from "@/components/states/error-state";
import { requireTenantPage } from "@/lib/auth/guards";
import { hasPermission } from "@/lib/auth/permissions";
import { getDataOverviewAction } from "./actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Data and backups" };

/** `/restaurant/settings/data` (RASOIOS-ADR-021): backups, restore and deleting old history — owner/administrator only. */
export default async function DataPage() {
  const ctx = await requireTenantPage("data:export");
  const overview = await getDataOverviewAction();

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col">
      <PageHeader title="Data and backups" description="Download your restaurant's records, restore them, and clear out old history." />
      {overview.ok ? (
        <DataManagement overview={overview.data} canImport={hasPermission(ctx, "data:import")} canDelete={hasPermission(ctx, "data:purge")} />
      ) : (
        <ErrorState requestId={overview.error.requestId} message={overview.error.message} />
      )}
    </div>
  );
}
