"use client";

import * as React from "react";
import { CircleCheck, Plus, Printer, Radar, TriangleAlert, WifiOff } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Select } from "@/components/ui/inputs";
import type { DiscoveredPrinterView, PrinterDiscoveryView, PrintingConsoleAgent } from "@/lib/services/printing";
import { getPrinterDiscoveryAction, startPrinterDiscoveryAction } from "./actions";

/**
 * "Find nearby printers" (RASOIOS-ADR-015). The browser cannot see the restaurant network, so the scan runs on the
 * chosen print agent: this dialog only asks for it and shows, honestly, what the agent reported. Nothing found here is
 * connected yet — "Add printer" opens the normal printer form with the address filled in, and the printer shows as
 * Online only after the agent actually reaches it and a test page prints.
 */
const POLL_MS = 1_500;
const GIVE_UP_MS = 75_000;

type Phase = { kind: "idle" } | { kind: "scanning"; scan: PrinterDiscoveryView } | { kind: "done"; scan: PrinterDiscoveryView } | { kind: "error"; message: string };

function deviceTitle(device: DiscoveredPrinterView): string {
  const makeModel = [device.manufacturer, device.model].filter(Boolean).join(" ");
  return device.name ?? (makeModel || "Network printer");
}

export function DiscoveryDialog({
  open,
  agents,
  onClose,
  onAdd,
}: {
  open: boolean;
  agents: readonly PrintingConsoleAgent[];
  onClose: () => void;
  /** Opens the printer form pre-filled for this device. */
  onAdd: (device: DiscoveredPrinterView, agentId: string) => void;
}) {
  const online = agents.filter((agent) => agent.status === "ACTIVE" && agent.online);
  const [agentId, setAgentId] = React.useState("");
  const [phase, setPhase] = React.useState<Phase>({ kind: "idle" });
  const startedAt = React.useRef(0);

  React.useEffect(() => {
    if (!open) return;
    setPhase({ kind: "idle" });
    setAgentId((current) => (online.some((a) => a.id === current) ? current : (online[0]?.id ?? "")));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset only when the dialog opens
  }, [open]);

  // Poll the scan while the agent works on it.
  React.useEffect(() => {
    if (phase.kind !== "scanning") return;
    const timer = setTimeout(async () => {
      const result = await getPrinterDiscoveryAction({ discoveryId: phase.scan.id });
      if (!result.ok) return setPhase({ kind: "error", message: result.error.message });
      const scan = result.data;
      if (scan.state === "REQUESTED" || scan.state === "RUNNING") {
        if (Date.now() - startedAt.current > GIVE_UP_MS) return setPhase({ kind: "done", scan: { ...scan, state: "FAILED" } });
        return setPhase({ kind: "scanning", scan });
      }
      setPhase({ kind: "done", scan });
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  async function start() {
    if (!agentId) return;
    startedAt.current = Date.now();
    const result = await startPrinterDiscoveryAction({ agentId });
    if (!result.ok) return setPhase({ kind: "error", message: result.error.message });
    setPhase(result.data.state === "REQUESTED" || result.data.state === "RUNNING" ? { kind: "scanning", scan: result.data } : { kind: "done", scan: result.data });
  }

  const scanning = phase.kind === "scanning";
  const agentName = agents.find((a) => a.id === agentId)?.name ?? "the print agent";

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Find nearby printers"
      description="The print agent on the restaurant PC looks for network printers on its own Wi-Fi/Ethernet network. Nothing is added or printed until you choose to."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          {online.length > 0 && (
            <Button variant="primary" loading={scanning} loadingLabel="Searching…" onClick={() => void start()} disabled={!agentId}>
              <Icon icon={Radar} size={18} />
              {phase.kind === "done" ? "Search again" : "Find nearby printers"}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {online.length === 0 ? (
          <Notice icon={WifiOff} tone="warning" title="No print agent is online">
            Start the FlowDineOS print agent on a PC connected to the same network as the printers (Printing → Agents shows its status), then try again.
          </Notice>
        ) : (
          online.length > 1 && (
            <Select
              label="Search from"
              value={agentId}
              onChange={(event) => setAgentId(event.target.value)}
              options={online.map((agent) => ({ value: agent.id, label: agent.name }))}
              disabled={scanning}
            />
          )
        )}

        {scanning && (
          <p role="status" className="flex items-center gap-3 text-body text-fg-secondary">
            <span className="relative flex h-3 w-3" aria-hidden="true">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-action-primary opacity-60 motion-reduce:animate-none" />
              <span className="relative inline-flex h-3 w-3 rounded-full bg-action-primary" />
            </span>
            {phase.scan.state === "REQUESTED" ? `Waiting for ${agentName} to start the search…` : "Searching for printers…"}
          </p>
        )}

        {phase.kind === "error" && (
          <Notice icon={TriangleAlert} tone="danger" title="Printer search failed">
            {phase.message}
          </Notice>
        )}

        {phase.kind === "done" && <Results scan={phase.scan} agentName={agentName} onAdd={(device) => onAdd(device, phase.scan.agentId)} />}
      </div>
    </Dialog>
  );
}

function Results({ scan, agentName, onAdd }: { scan: PrinterDiscoveryView; agentName: string; onAdd: (device: DiscoveredPrinterView) => void }) {
  if (scan.state === "AGENT_NOT_RESPONDING") {
    return (
      <Notice icon={WifiOff} tone="warning" title="Print agent offline">
        {agentName} did not pick up the search. Check that the PC is on and the agent is running, then search again.
      </Notice>
    );
  }
  if (scan.state === "FAILED") {
    return (
      <Notice icon={TriangleAlert} tone="danger" title="Printer search failed">
        {scan.errorCode === "NO_PRIVATE_NETWORK"
          ? `${agentName} is not connected to a local Wi-Fi or Ethernet network.`
          : "The agent could not complete the search. Try again, or add the printer manually with its IP address."}
      </Notice>
    );
  }
  if (scan.printers.length === 0) {
    return (
      <Notice icon={Printer} tone="neutral" title="No compatible printers found">
        <ul className="mt-1 list-disc pl-5">
          <li>Check the printer is switched on and has paper.</li>
          <li>Make sure it is on the same Wi-Fi/network as {agentName}.</li>
          <li>Many thermal printers print their IP address when you hold FEED while switching them on — then use Add printer and enter it.</li>
        </ul>
      </Notice>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <p role="status" className="text-label text-fg-primary">
        {scan.printers.length === 1 ? "1 printer found" : `${scan.printers.length} printers found`}
      </p>
      <ul className="flex flex-col gap-3">
        {scan.printers.map((device) => (
          <li key={`${device.address}:${device.port}`} className="flex flex-col gap-3 rounded-2xl border border-border-subtle bg-raised p-4 sm:flex-row sm:items-center">
            <Icon icon={Printer} size={24} className="shrink-0 text-fg-accent" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-subheading text-fg-primary">{deviceTitle(device)}</p>
              <p className="text-caption text-numeric text-fg-secondary">
                {device.address}:{device.port} · {device.protocol === "RAW_9100" ? "Network (raw TCP)" : "IPP"}
                {device.model && device.name ? ` · ${device.model}` : ""}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {device.rawPrinting ? (
                  <Badge tone="success" icon={CircleCheck}>
                    Compatible · ESC/POS raw printing
                  </Badge>
                ) : (
                  <Badge tone="neutral" icon={TriangleAlert}>
                    Not supported · IPP only
                  </Badge>
                )}
                {device.alreadyAddedAs && <Badge tone="neutral">Already added as {device.alreadyAddedAs}</Badge>}
              </div>
            </div>
            {device.rawPrinting && !device.alreadyAddedAs && (
              <Button size="sm" variant="primary" onClick={() => onAdd(device)}>
                <Icon icon={Plus} size={16} />
                Add printer
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Notice({ icon, tone, title, children }: { icon: typeof Printer; tone: "warning" | "danger" | "neutral"; title: string; children: React.ReactNode }) {
  const toneClass = tone === "danger" ? "border-status-danger/30 bg-status-danger/10" : tone === "warning" ? "border-status-warning/40 bg-status-warning/10" : "border-border-subtle bg-raised";
  const iconClass = tone === "danger" ? "text-status-danger" : tone === "warning" ? "text-status-warning" : "text-fg-secondary";
  return (
    <div role={tone === "neutral" ? "status" : "alert"} className={`flex gap-3 rounded-xl border px-4 py-3 ${toneClass}`}>
      <Icon icon={icon} size={20} className={`mt-0.5 shrink-0 ${iconClass}`} />
      <div className="text-body text-fg-primary">
        <p className="text-label">{title}</p>
        <div className="text-fg-secondary">{children}</div>
      </div>
    </div>
  );
}
