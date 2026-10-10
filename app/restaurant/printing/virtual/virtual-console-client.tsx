"use client";

import { useEffect, useState, useTransition } from "react";
import { ChevronLeft, ChevronRight, Receipt, X } from "lucide-react";
import {
  clearTicketsAction,
  executeCycleAction,
  getVirtualEnvironmentAction,
  setSimulationModeAction,
  simulateDuplicatePrintAction,
  triggerSimulatedKotAction,
  triggerTestConnectionAction,
  triggerTestPrintAction,
} from "./actions";
import type { VirtualEnvironmentSummary } from "@/lib/services/virtual-printing";
import type { VirtualPrinterSimulationMode, VirtualPrintedTicket } from "@/lib/print/virtual-printer";

export function VirtualConsoleClient({ initial }: { initial: VirtualEnvironmentSummary }) {
  const [env, setEnv] = useState<VirtualEnvironmentSummary>(initial);
  const [isPending, startTransition] = useTransition();
  const [selectedTicketIndex, setSelectedTicketIndex] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [rawInspector, setRawInspector] = useState(false);

  // Poll for queue & ticket updates every 3 seconds
  useEffect(() => {
    const timer = setInterval(() => {
      startTransition(async () => {
        const res = await getVirtualEnvironmentAction();
        if (res.ok) setEnv(res.data);
      });
    }, 3000);
    return () => clearInterval(timer);
  }, []);

  const refreshNow = () => {
    startTransition(async () => {
      const res = await getVirtualEnvironmentAction();
      if (res.ok) setEnv(res.data);
    });
  };

  const handleSetSimulation = (mode: VirtualPrinterSimulationMode) => {
    const printer = env.printer;
    if (!printer) return;
    const printerId = printer.id;
    startTransition(async () => {
      setMessage(`Setting simulation mode: ${mode}...`);
      const res = await setSimulationModeAction({ printerId, mode });
      if (res.ok) {
        setMessage(`Simulation mode set to ${mode}`);
        refreshNow();
      } else {
        setMessage(`Error: ${res.error}`);
      }
    });
  };

  const handleTestConnection = () => {
    const printer = env.printer;
    if (!printer) return;
    const printerId = printer.id;
    startTransition(async () => {
      setMessage("Running connection test (probe)...");
      const res = await triggerTestConnectionAction({ printerId });
      if (res.ok) {
        setMessage("Connection test dispatched to agent. Awaiting check report...");
        setTimeout(refreshNow, 1000);
      } else {
        setMessage(`Connection test error: ${res.error}`);
      }
    });
  };

  const handleTestPrint = () => {
    const printer = env.printer;
    const agent = env.agent;
    if (!printer) return;
    const printerId = printer.id;
    startTransition(async () => {
      setMessage("Dispatching test print job to queue...");
      const res = await triggerTestPrintAction({ printerId });
      if (res.ok) {
        setMessage("Test print job queued (jobType: TEST). Running claim cycle...");
        if (agent) await executeCycleAction({ agentId: agent.id });
        refreshNow();
      } else {
        setMessage(`Test print error: ${res.error}`);
      }
    });
  };

  const handleSendKot = () => {
    const printer = env.printer;
    const agent = env.agent;
    if (!printer) return;
    const printerId = printer.id;
    startTransition(async () => {
      setMessage("Creating realistic KOT ticket in print queue...");
      const res = await triggerSimulatedKotAction({ printerId });
      if (res.ok) {
        setMessage(`KOT queued with dedupeKey: ${res.data.dedupeKey}. Processing claim...`);
        if (agent) await executeCycleAction({ agentId: agent.id });
        refreshNow();
      } else {
        setMessage(`KOT dispatch error: ${res.error}`);
      }
    });
  };

  const handleExecuteCycle = () => {
    const agent = env.agent;
    if (!agent) return;
    const agentId = agent.id;
    startTransition(async () => {
      setMessage("Running virtual agent claim & print cycle...");
      const res = await executeCycleAction({ agentId });
      if (res.ok) {
        setMessage("Claim cycle completed.");
        refreshNow();
      } else {
        setMessage(`Cycle error: ${res.error}`);
      }
    });
  };

  const handleClearTickets = () => {
    const printer = env.printer;
    if (!printer) return;
    const printerId = printer.id;
    startTransition(async () => {
      await clearTicketsAction({ printerId });
      setMessage("Virtual printed tickets cleared.");
      setSelectedTicketIndex(0);
      refreshNow();
    });
  };

  const handleDuplicateTest = () => {
    const printer = env.printer;
    if (!printer) return;
    const printerId = printer.id;
    startTransition(async () => {
      setMessage("Submitting duplicate KOT to test deduplication idempotency...");
      const res = await simulateDuplicatePrintAction({ printerId });
      if (res.ok) {
        setMessage("Duplicate print protection verified: duplicate attempt rejected by dedupeKey.");
        refreshNow();
      } else {
        setMessage(`Duplicate test failed: ${res.error}`);
      }
    });
  };

  const activeTicket: VirtualPrintedTicket | undefined = env.tickets[selectedTicketIndex];

  return (
    <div className="flex flex-col gap-8">
      {message && (
        <div className="rounded-md bg-neutral-800 border border-neutral-700 px-4 py-2.5 text-sm text-neutral-200 flex items-center justify-between">
          <span>{message}</span>
          <button onClick={() => setMessage(null)} className="text-neutral-400 hover:text-white" aria-label="Close notification">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Grid: Status Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Agent Card */}
        <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-5 shadow-sm">
          <div className="flex items-center justify-between pb-3 border-b border-neutral-800">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-400">Agent Status</h3>
            <span
              className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium ${
                env.agent?.status === "ONLINE"
                  ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30"
                  : env.agent?.status === "RECONNECTING"
                  ? "bg-amber-500/10 text-amber-400 border border-amber-500/30"
                  : "bg-rose-500/10 text-rose-400 border border-rose-500/30"
              }`}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-current" />
              {env.agent?.status ?? "OFFLINE"}
            </span>
          </div>
          <div className="mt-4 space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-neutral-400">Agent:</span>
              <span className="text-neutral-200 font-medium">{env.agent?.name ?? "None"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-neutral-400">Version:</span>
              <span className="text-neutral-300 font-mono text-xs">{env.agent?.version ?? "0.2.1-virtual"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-neutral-400">Last Heartbeat:</span>
              <span className="text-neutral-300 text-xs">
                {env.agent?.lastSeenAt ? new Date(env.agent.lastSeenAt).toLocaleTimeString() : "Never"}
              </span>
            </div>
          </div>
        </div>

        {/* Printer Card */}
        <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-5 shadow-sm">
          <div className="flex items-center justify-between pb-3 border-b border-neutral-800">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-400">Virtual Printer</h3>
            <span
              className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium ${
                env.emulatorState.status === "READY"
                  ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30"
                  : "bg-rose-500/10 text-rose-400 border border-rose-500/30"
              }`}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-current" />
              {env.emulatorState.status}
            </span>
          </div>
          <div className="mt-4 space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-neutral-400">Printer:</span>
              <span className="text-neutral-200 font-medium">{env.printer?.name ?? "Virtual Kitchen"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-neutral-400">Model:</span>
              <span className="text-neutral-300">Virtual ESC/POS 80mm</span>
            </div>
            <div className="flex justify-between">
              <span className="text-neutral-400">Station / Paper:</span>
              <span className="text-neutral-300">Kitchen · 80 mm (48 col)</span>
            </div>
          </div>
        </div>

        {/* Emulator Counters */}
        <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-5 shadow-sm">
          <div className="flex items-center justify-between pb-3 border-b border-neutral-800">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-400">Print Metrics</h3>
            <span className="text-xs text-neutral-400 font-mono">
              Mode: {env.emulatorState.simulationMode}
            </span>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-4 text-center">
            <div className="p-2.5 rounded-lg bg-neutral-800/50">
              <div className="text-2xl font-bold text-emerald-400">{env.emulatorState.jobsPrintedCount}</div>
              <div className="text-xs text-neutral-400 mt-0.5">Tickets Printed</div>
            </div>
            <div className="p-2.5 rounded-lg bg-neutral-800/50">
              <div className="text-2xl font-bold text-rose-400">{env.emulatorState.jobsFailedCount}</div>
              <div className="text-xs text-neutral-400 mt-0.5">Failed Attempts</div>
            </div>
          </div>
          <div className="mt-3 text-xs text-center text-neutral-400">
            Last Print: {env.emulatorState.lastPrintAt ? new Date(env.emulatorState.lastPrintAt).toLocaleTimeString() : "None"}
          </div>
        </div>
      </div>

      {/* Queue Counters Bar */}
      <div className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-4">
        <div className="text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-3">
          Print Queue Status (Server State)
        </div>
        <div className="grid grid-cols-6 gap-3 text-center">
          <div className="p-2 rounded-lg bg-neutral-800/30">
            <div className="text-lg font-semibold text-neutral-200">{env.queue.queued}</div>
            <div className="text-xs text-neutral-400">Queued</div>
          </div>
          <div className="p-2 rounded-lg bg-neutral-800/30">
            <div className="text-lg font-semibold text-sky-400">{env.queue.sending}</div>
            <div className="text-xs text-neutral-400">Sending</div>
          </div>
          <div className="p-2 rounded-lg bg-neutral-800/30">
            <div className="text-lg font-semibold text-amber-400">{env.queue.retrying}</div>
            <div className="text-xs text-neutral-400">Retrying</div>
          </div>
          <div className="p-2 rounded-lg bg-neutral-800/30">
            <div className="text-lg font-semibold text-emerald-400">{env.queue.delivered}</div>
            <div className="text-xs text-neutral-400">Delivered</div>
          </div>
          <div className="p-2 rounded-lg bg-neutral-800/30">
            <div className="text-lg font-semibold text-rose-400">{env.queue.failed}</div>
            <div className="text-xs text-neutral-400">Failed</div>
          </div>
          <div className="p-2 rounded-lg bg-neutral-800/30">
            <div className="text-lg font-semibold text-neutral-400">{env.queue.cancelled}</div>
            <div className="text-xs text-neutral-400">Cancelled</div>
          </div>
        </div>
      </div>

      {/* Actions and Failure Simulations */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Actions Box */}
        <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-5 flex flex-col justify-between">
          <div>
            <h3 className="text-sm font-semibold text-neutral-200 mb-1">Queue & Print Actions</h3>
            <p className="text-xs text-neutral-400 mb-4">
              Trigger real print jobs through the authenticated queue and agent.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                disabled={isPending}
                onClick={handleTestConnection}
                className="px-3.5 py-2.5 rounded-lg border border-neutral-700 bg-neutral-800 hover:bg-neutral-700 text-neutral-100 text-sm font-medium transition-colors"
              >
                Test Connection
              </button>
              <button
                type="button"
                disabled={isPending}
                onClick={handleTestPrint}
                className="px-3.5 py-2.5 rounded-lg border border-neutral-700 bg-neutral-800 hover:bg-neutral-700 text-neutral-100 text-sm font-medium transition-colors"
              >
                Print Test Ticket
              </button>
              <button
                type="button"
                disabled={isPending}
                onClick={handleSendKot}
                className="px-3.5 py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold transition-colors shadow-sm"
              >
                Send KOT Order
              </button>
              <button
                type="button"
                disabled={isPending}
                onClick={handleExecuteCycle}
                className="px-3.5 py-2.5 rounded-lg border border-sky-500/30 bg-sky-500/10 hover:bg-sky-500/20 text-sky-300 text-sm font-medium transition-colors"
              >
                Run Claim Cycle
              </button>
            </div>
          </div>
          <div className="mt-4 pt-3 border-t border-neutral-800 flex justify-between items-center">
            <button
              type="button"
              disabled={isPending}
              onClick={handleDuplicateTest}
              className="text-xs text-neutral-400 hover:text-neutral-200 underline"
            >
              Test Duplicate Protection
            </button>
            <button
              type="button"
              disabled={isPending}
              onClick={handleClearTickets}
              className="text-xs text-rose-400 hover:text-rose-300"
            >
              Clear Printed Output
            </button>
          </div>
        </div>

        {/* Failure Simulation Box */}
        <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-5">
          <h3 className="text-sm font-semibold text-neutral-200 mb-1">Failure Simulation Controls</h3>
          <p className="text-xs text-neutral-400 mb-3">
            Inject real network and hardware fault modes to verify server retry policies.
          </p>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <button
              type="button"
              disabled={isPending}
              onClick={() => handleSetSimulation("NORMAL")}
              className={`px-3 py-2 rounded-lg border text-left transition-colors ${
                env.emulatorState.simulationMode === "NORMAL"
                  ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-300 font-semibold"
                  : "border-neutral-800 bg-neutral-950/40 text-neutral-400 hover:bg-neutral-800"
              }`}
            >
              Restore Normal
            </button>
            <button
              type="button"
              disabled={isPending}
              onClick={() => handleSetSimulation("OFFLINE")}
              className={`px-3 py-2 rounded-lg border text-left transition-colors ${
                env.emulatorState.simulationMode === "OFFLINE"
                  ? "border-rose-500/50 bg-rose-500/10 text-rose-300 font-semibold"
                  : "border-neutral-800 bg-neutral-950/40 text-neutral-400 hover:bg-neutral-800"
              }`}
            >
              Simulate Offline
            </button>
            <button
              type="button"
              disabled={isPending}
              onClick={() => handleSetSimulation("TIMEOUT")}
              className={`px-3 py-2 rounded-lg border text-left transition-colors ${
                env.emulatorState.simulationMode === "TIMEOUT"
                  ? "border-amber-500/50 bg-amber-500/10 text-amber-300 font-semibold"
                  : "border-neutral-800 bg-neutral-950/40 text-neutral-400 hover:bg-neutral-800"
              }`}
            >
              Simulate Timeout
            </button>
            <button
              type="button"
              disabled={isPending}
              onClick={() => handleSetSimulation("REFUSED")}
              className={`px-3 py-2 rounded-lg border text-left transition-colors ${
                env.emulatorState.simulationMode === "REFUSED"
                  ? "border-amber-500/50 bg-amber-500/10 text-amber-300 font-semibold"
                  : "border-neutral-800 bg-neutral-950/40 text-neutral-400 hover:bg-neutral-800"
              }`}
            >
              Connection Refused
            </button>
            <button
              type="button"
              disabled={isPending}
              onClick={() => handleSetSimulation("SLOW")}
              className={`px-3 py-2 rounded-lg border text-left transition-colors ${
                env.emulatorState.simulationMode === "SLOW"
                  ? "border-sky-500/50 bg-sky-500/10 text-sky-300 font-semibold"
                  : "border-neutral-800 bg-neutral-950/40 text-neutral-400 hover:bg-neutral-800"
              }`}
            >
              Slow Printer (Latency)
            </button>
            <button
              type="button"
              disabled={isPending}
              onClick={() => handleSetSimulation("PRINT_FAILED")}
              className={`px-3 py-2 rounded-lg border text-left transition-colors ${
                env.emulatorState.simulationMode === "PRINT_FAILED"
                  ? "border-rose-500/50 bg-rose-500/10 text-rose-300 font-semibold"
                  : "border-neutral-800 bg-neutral-950/40 text-neutral-400 hover:bg-neutral-800"
              }`}
            >
              Print Failure (Jam)
            </button>
          </div>
          <div className="mt-3 text-xs text-neutral-400 bg-neutral-950/40 p-2.5 rounded-lg border border-neutral-800">
            <strong>Retry Policy In Effect:</strong> When offline, KOT jobs enter <code>RETRYING</code> with exponential delays (5s, 10s, 20s, 30s...). When restored, the agent automatically completes delivery on the next poll attempt.
          </div>
        </div>
      </div>

      {/* Realistic 80mm Thermal Paper Preview */}
      <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-4 border-b border-neutral-800 gap-3">
          <div>
            <h2 className="text-base font-semibold text-neutral-100 flex items-center gap-2">
              <span>80mm Thermal Receipt Preview</span>
              <span className="text-xs bg-neutral-800 text-neutral-300 px-2 py-0.5 rounded font-mono">
                {env.tickets.length} Ticket(s) Received
              </span>
            </h2>
            <p className="text-xs text-neutral-400 mt-0.5">
              Decoded from actual ESC/POS byte commands emitted by the print agent encoder.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {env.tickets.length > 1 && (
              <div className="flex items-center gap-1.5 text-xs">
                <button
                  type="button"
                  disabled={selectedTicketIndex <= 0}
                  onClick={() => setSelectedTicketIndex((i) => Math.max(0, i - 1))}
                  className="px-2 py-1 rounded bg-neutral-800 hover:bg-neutral-700 disabled:opacity-40 text-neutral-200 inline-flex items-center gap-1"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                  <span>Newer</span>
                </button>
                <span className="text-neutral-400 font-mono px-1">
                  {selectedTicketIndex + 1} / {env.tickets.length}
                </span>
                <button
                  type="button"
                  disabled={selectedTicketIndex >= env.tickets.length - 1}
                  onClick={() => setSelectedTicketIndex((i) => Math.min(env.tickets.length - 1, i + 1))}
                  className="px-2 py-1 rounded bg-neutral-800 hover:bg-neutral-700 disabled:opacity-40 text-neutral-200 inline-flex items-center gap-1"
                >
                  <span>Older</span>
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
            <button
              type="button"
              onClick={() => setRawInspector((r) => !r)}
              className="text-xs text-neutral-400 hover:text-neutral-200 border border-neutral-700 px-2 py-1 rounded"
            >
              {rawInspector ? "Hide Commands" : "Inspect Commands"}
            </button>
          </div>
        </div>

        <div className="mt-6 flex flex-col md:flex-row items-start justify-center gap-8">
          {activeTicket ? (
            <div className="w-full flex flex-col items-center">
              {/* Thermal paper container styled like real 80mm roll */}
              <div className="w-full max-w-[390px] shadow-2xl relative bg-amber-50 text-neutral-900 rounded-t-sm rounded-b-sm border-t-2 border-b-2 border-neutral-300">
                {/* Paper header banner */}
                <div className="bg-amber-100/80 border-b border-amber-300/50 text-xs text-amber-900 py-1 px-3 text-center uppercase tracking-widest font-mono">
                  [ TEST PRINT · VIRTUAL ESC/POS EMULATOR ]
                </div>

                {/* Ticket Body */}
                <div className="p-6 font-mono text-xs leading-relaxed select-text space-y-1">
                  {activeTicket.lines.map((line, idx) => {
                    const isBold = activeTicket.bold[idx];
                    const align = activeTicket.align[idx] ?? "left";
                    const isCutMarker = line.includes("---") || line.includes("CUT");

                    return (
                      <div
                        key={idx}
                        className={`${isBold ? "font-bold text-black" : "text-neutral-800"} ${
                          align === "center"
                            ? "text-center"
                            : align === "right"
                            ? "text-right"
                            : "text-left"
                        } ${isCutMarker ? "text-neutral-400" : ""}`}
                      >
                        {line || "\u00A0"}
                      </div>
                    );
                  })}
                </div>

                {/* Bottom paper cut edge indicator */}
                <div className="border-t border-dashed border-neutral-400/60 py-2 px-4 text-center text-xs font-mono text-neutral-500 bg-neutral-100/50">
                  - - - - - - [ 80mm ROLL CUT ] - - - - - -
                </div>
              </div>

              {/* Ticket metadata bar */}
              <div className="mt-3 text-xs text-neutral-400 flex items-center gap-4">
                <span>Received: {new Date(activeTicket.printedAt).toLocaleTimeString()}</span>
                <span>Size: {activeTicket.byteLength} bytes</span>
                <span>Cuts: {activeTicket.cuts}</span>
              </div>
            </div>
          ) : (
            <div className="w-full max-w-md py-16 text-center text-neutral-500 border border-dashed border-neutral-800 rounded-xl">
              <Receipt className="w-8 h-8 text-neutral-500 mx-auto mb-2" />
              <div className="text-sm font-medium text-neutral-300">No Tickets Printed Yet</div>
              <p className="text-xs text-neutral-500 mt-1">
                Click <strong>[ Send KOT Order ]</strong> or <strong>[ Print Test Ticket ]</strong> above to simulate a ticket.
              </p>
            </div>
          )}

          {/* Optional Raw ESC/POS inspector */}
          {rawInspector && activeTicket && (
            <div className="w-full md:w-80 rounded-lg bg-neutral-950 p-4 border border-neutral-800 text-xs font-mono text-neutral-300 overflow-x-auto">
              <div className="text-xs font-semibold text-neutral-400 uppercase tracking-wider mb-2">
                ESC/POS Command Stream
              </div>
              <div className="space-y-1 text-xs">
                <div>• Ticket ID: {activeTicket.id}</div>
                <div>• Base64 Size: {activeTicket.rawBytesBase64.length} chars</div>
                <div>• Total Lines: {activeTicket.lines.length}</div>
                <div>• Total Cuts: {activeTicket.cuts}</div>
                <div className="mt-3 text-neutral-400 font-semibold">Decoded Line Alignments:</div>
                <div className="max-h-48 overflow-y-auto space-y-0.5 bg-neutral-900/60 p-2 rounded">
                  {activeTicket.lines.map((l, i) => (
                    <div key={i} className="truncate">
                      [{activeTicket.align[i]}]{activeTicket.bold[i] ? "[B]" : ""} {l}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
