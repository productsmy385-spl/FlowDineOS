import type { Metadata } from "next";
import { DemoRequestsBoard } from "@/components/admin/demo-requests-board";
import { PageHeader } from "@/components/layout/page-header";
import { ErrorState } from "@/components/states/error-state";
import { requirePlatformPage } from "@/lib/auth/guards";
import { hasPermission } from "@/lib/auth/permissions";
import { listDemoRequestsAction } from "./actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Demo requests" };

/** `/admin/demo-requests` (LD-ADM-10, RASOIOS-ADR-024): visitors who asked for a demo — the platform owner's alone. */
export default async function DemoRequestsPage() {
  const ctx = await requirePlatformPage("platform:demo_request:read");
  const result = await listDemoRequestsAction({});
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col">
      <PageHeader title="Demo requests" description="People who asked for a FlowDineOS demo from the website. Contact them, then record what happened." />
      {result.ok ? (
        <DemoRequestsBoard initial={result.data.items} counts={result.data.counts} canUpdate={hasPermission(ctx, "platform:demo_request:update")} />
      ) : (
        <ErrorState requestId={result.error.requestId} message={result.error.message} />
      )}
    </div>
  );
}
