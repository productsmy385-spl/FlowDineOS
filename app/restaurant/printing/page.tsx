import Link from "next/link";
import { PageHeader } from "@/components/layout/page-header";
import { requireTenantPage } from "@/lib/auth/guards";
import { hasPermission } from "@/lib/auth/permissions";
import { isVirtualPrintingEnabled } from "@/lib/print/virtual-safety";
import { getPrintingConsole, listPrintingSections } from "@/lib/services/printing";
import { PrintingConsoleView } from "./printing-console";

export const dynamic = "force-dynamic";

/**
 * LD-PRN-01 — `/restaurant/printing` (S1-P16-T006, `print_job:read`).
 *
 * The first view is rendered on the server; the queue then polls RH-PRN-01 every 10 s (ADR-009). Printer and agent
 * management need their own permissions (`printer:manage`, `print_agent:manage`, security.md §3.3 rows 44–45): the
 * capabilities passed down decide what the page *shows*, and the server re-checks each action anyway (SC-RBAC-08).
 */
export default async function PrintingPage() {
  const ctx = await requireTenantPage("print_job:read");
  const canManagePrinters = hasPermission(ctx, "printer:manage");
  const [view, sections] = await Promise.all([getPrintingConsole(ctx), canManagePrinters ? listPrintingSections(ctx) : Promise.resolve([])]);
  const virtualEnabled = isVirtualPrintingEnabled();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Printing"
        description="Kitchen tickets and receipts are queued here and collected by the print agent running in the restaurant."
        actions={
          virtualEnabled && canManagePrinters ? (
            <Link
              href="/restaurant/printing/virtual"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-300 text-xs font-medium transition-colors"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
              Virtual Printer Emulator
            </Link>
          ) : undefined
        }
      />
      <PrintingConsoleView
        initial={view}
        timezone={ctx.restaurant.timezone}
        sections={sections}
        can={{
          managePrinters: canManagePrinters,
          manageAgents: hasPermission(ctx, "print_agent:manage"),
          retryJobs: hasPermission(ctx, "print_job:retry"),
        }}
      />
    </div>
  );
}
