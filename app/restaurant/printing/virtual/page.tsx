import Link from "next/link";
import { AlertTriangle, ArrowLeft } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { requireTenantPage } from "@/lib/auth/guards";
import { assertVirtualPrintingEnabled } from "@/lib/print/virtual-safety";
import { getOrCreateVirtualEnvironment } from "@/lib/services/virtual-printing";
import { VirtualConsoleClient } from "./virtual-console-client";

export const dynamic = "force-dynamic";

export default async function VirtualPrintingPage() {
  const ctx = await requireTenantPage("printer:manage");
  assertVirtualPrintingEnabled();

  const initial = await getOrCreateVirtualEnvironment(ctx);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-2 text-sm text-neutral-400">
        <Link href="/restaurant/printing" className="inline-flex items-center gap-1.5 hover:text-neutral-200 transition-colors">
          <ArrowLeft className="w-4 h-4" />
          <span>Back to Printing Console</span>
        </Link>
        <span>/</span>
        <span className="text-neutral-200 font-medium">Virtual Printer Emulator</span>
      </div>

      <PageHeader
        title="Virtual Printer & Agent Emulator"
        description="End-to-end development and validation environment simulating the TVS-E RP 3230 thermal printer and Windows print agent."
      />

      <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200 flex items-start gap-3">
        <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
        <div>
          <strong className="font-semibold">DEVELOPMENT / TEST ENVIRONMENT ONLY:</strong> This software emulator tests the complete FlowDineOS print queue, agent authentication, ESC/POS decoding, and retry lifecycle without physical printer hardware. Tickets generated here are marked as <strong>TEST PRINT</strong> and do not represent physical paper output.
        </div>
      </div>

      <VirtualConsoleClient initial={initial} />
    </div>
  );
}
