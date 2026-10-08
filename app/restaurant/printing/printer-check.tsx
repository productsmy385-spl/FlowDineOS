"use client";

import * as React from "react";
import { CircleCheck, CircleX, PlugZap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import type { PrinterCheckView } from "@/lib/services/printing";
import { getPrinterCheckAction, startPrinterCheckAction } from "./actions";

/**
 * "Test connection" for one printer (printing audit 2026-10-08 P0). The printer's own agent opens and closes a TCP
 * connection to it and reports back; the cloud never connects to the printer, and nothing is printed. The result says
 * plainly whether the printer answered, with the technical reason underneath for whoever is fixing the network.
 */
const POLL_MS = 1_500;
const GIVE_UP_MS = 60_000;

export function PrinterCheck({ printerId }: { printerId: string }) {
  const [view, setView] = React.useState<PrinterCheckView | null>(null);
  const [running, setRunning] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  async function start() {
    setRunning(true);
    setProblem(null);
    setView(null);
    const result = await startPrinterCheckAction({ printerId });
    if (!result.ok) {
      setRunning(false);
      setProblem(result.error.message);
      return;
    }
    setView(result.data);
    if (result.data.state === "DONE" || !result.data.checkId) {
      setRunning(false);
      return;
    }
    const checkId = result.data.checkId;
    const startedAt = Date.now();
    const poll = async () => {
      const next = await getPrinterCheckAction({ checkId });
      if (!next.ok) {
        setRunning(false);
        setProblem(next.error.message);
        return;
      }
      setView(next.data);
      if (next.data.state === "DONE" || Date.now() - startedAt > GIVE_UP_MS) {
        setRunning(false);
        return;
      }
      timer.current = setTimeout(() => void poll(), POLL_MS);
    };
    timer.current = setTimeout(() => void poll(), POLL_MS);
  }

  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button size="sm" variant="secondary" loading={running} loadingLabel={view?.state === "RUNNING" ? "Testing…" : "Asking the agent…"} onClick={() => void start()}>
          <Icon icon={PlugZap} size={16} />
          Test connection
        </Button>
      </div>
      {problem ? (
        <p role="status" className="text-caption text-status-danger">
          {problem}
        </p>
      ) : null}
      {view && view.state === "DONE" ? (
        <div role="status" className={`rounded-xl border p-3 text-body ${view.ok ? "border-status-success/40 bg-status-success/12" : "border-status-danger/40 bg-status-danger/12"}`} data-testid="printer-check-result">
          <p className={`flex items-center gap-2 text-label ${view.ok ? "text-status-success" : "text-status-danger"}`}>
            <Icon icon={view.ok ? CircleCheck : CircleX} size={18} />
            {view.ok ? "Printer reachable" : view.error?.code === "AGENT_OFFLINE" || view.error?.code === "AGENT_NOT_RESPONDING" ? "Print agent not available" : "Printer unreachable"}
          </p>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-caption">
            {view.address ? (
              <>
                <dt className="text-fg-secondary">Address</dt>
                <dd className="text-numeric text-fg-primary">{view.address}</dd>
              </>
            ) : null}
            <dt className="text-fg-secondary">Agent</dt>
            <dd className="text-fg-primary">
              {view.agentName ?? "Not assigned"} · {view.agentOnline ? "Online" : "Offline"}
            </dd>
            <dt className="text-fg-secondary">Protocol</dt>
            <dd className="text-fg-primary">{view.protocol}</dd>
            <dt className="text-fg-secondary">Connection</dt>
            <dd className="text-fg-primary">{view.ok ? `Opened and closed in ${view.elapsedMs ?? 0} ms — nothing was printed` : "Failed"}</dd>
          </dl>
          {view.error ? (
            <>
              <p className="mt-2 text-body text-fg-primary">{view.error.user}</p>
              <p className="mt-1 text-caption text-fg-secondary">
                {view.error.code}: {view.error.detail ?? view.error.technical}
              </p>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
