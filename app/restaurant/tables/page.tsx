import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/page-header";
import { ErrorState } from "@/components/states/error-state";
import { TablesBoard } from "@/components/tables/tables-board";
import { requireTenantPage } from "@/lib/auth/guards";
import { listTablesAction } from "./actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Tables and QR codes" };

/** `/restaurant/tables` (RASOIOS-ADR-021): each table's QR opens the restaurant's own menu — no app, no sign-in. */
export default async function TablesPage() {
  await requireTenantPage("table:manage");
  const tables = await listTablesAction();
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col">
      <PageHeader title="Tables and QR codes" description="Put a code on each table. Guests scan it to see your menu, with its sections, on their own phone." />
      {tables.ok ? <TablesBoard {...tables.data} /> : <ErrorState requestId={tables.error.requestId} message={tables.error.message} />}
    </div>
  );
}
