"use client";

import * as React from "react";
import { Download, Monitor, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { TextField } from "@/components/ui/inputs";
import { createPrintAgentPairingAction } from "./actions";

/**
 * Pair a print agent (SA-AGT-01; S1-P16-T006).
 *
 * Offers the self-contained FlowDineOS Windows installer (FlowDineOS-Print-Agent-Setup.exe)
 * which bundles Node.js, the agent SEA, and the Windows service host — requiring no PowerShell,
 * manual ZIP extraction, or Node.js runtime installation.
 */
export type IssuedPairing = { agentId: string; name: string; pairingCode: string; expiresAt: string };

function remainingLabel(expiresAt: string, nowMs: number): string {
  const seconds = Math.max(0, Math.round((Date.parse(expiresAt) - nowMs) / 1000));
  if (seconds === 0) return "This code has expired. Create another one.";
  const minutes = Math.floor(seconds / 60);
  return `Expires in ${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

export function PairAgentDialog({ open, onClose, onPaired }: { open: boolean; onClose: () => void; onPaired: () => void }) {
  const [name, setName] = React.useState("");
  const [issued, setIssued] = React.useState<IssuedPairing | null>(null);
  const [fieldError, setFieldError] = React.useState<string | undefined>(undefined);
  const [formError, setFormError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const [nowMs, setNowMs] = React.useState(() => Date.now());
  const [showLinux, setShowLinux] = React.useState(false);

  // The agent talks to this same site; read on the client so the command shows the address the admin is using.
  const serverOrigin = typeof window === "undefined" ? "https://<this-site>" : window.location.origin;

  React.useEffect(() => {
    if (!open) return;
    setName("");
    setIssued(null);
    setFieldError(undefined);
    setFormError(null);
    setShowLinux(false);
  }, [open]);

  React.useEffect(() => {
    if (!issued) return;
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [issued]);

  async function create() {
    setPending(true);
    setFieldError(undefined);
    setFormError(null);
    const result = await createPrintAgentPairingAction({ name });
    setPending(false);
    if (!result.ok) {
      if (result.error.fieldErrors?.name) setFieldError(result.error.fieldErrors.name[0]);
      else setFormError(result.error.message);
      return;
    }
    setIssued(result.data);
    setNowMs(Date.now());
    onPaired();
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={issued ? `Pairing code for ${issued.name}` : "Pair a print agent"}
      description={
        issued
          ? "Type this code into the print agent on the restaurant PC. It is shown once and works for ten minutes."
          : "Give the restaurant PC a name you will recognise. You will get a one-time code to type into the agent."
      }
      footer={
        issued ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void create()} loading={pending} loadingLabel="Creating…">
              Create code
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-4">
        {formError && (
          <p role="alert" className="rounded-xl border border-status-danger/30 bg-status-danger/12 px-3 py-2 text-body text-status-danger">
            {formError}
          </p>
        )}
        {issued ? (
          <div className="flex flex-col gap-3">
            <p
              aria-label={`Pairing code ${issued.pairingCode.split("").join(" ")}`}
              className="rounded-2xl border border-border-strong bg-raised px-4 py-6 text-center text-display-m text-numeric tracking-[0.3em] text-fg-primary"
            >
              {issued.pairingCode}
            </p>
            <p className="text-caption text-fg-secondary" aria-live="polite">
              {remainingLabel(issued.expiresAt, nowMs)}
            </p>

            {/* Windows installer recommendation */}
            <div className="rounded-xl border border-border-subtle bg-raised p-4 flex flex-col gap-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Icon icon={Monitor} size={18} className="text-fg-primary" />
                  <span className="font-semibold text-fg-primary text-body">Windows Print Agent</span>
                </div>
                <span className="rounded-full bg-surface-muted px-2 py-0.5 text-caption text-fg-secondary">
                  v0.2.0 · 64-bit
                </span>
              </div>
              <p className="text-caption text-fg-secondary">
                Self-contained Windows installer. Automatically installs the FlowDineOS Print Agent service with auto-recovery on PC restart. No Node.js required.
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <a
                  href="/api/v1/printing/agent-download/windows"
                  download="FlowDineOS-Print-Agent-Setup.exe"
                  className="inline-flex h-10 items-center gap-2 rounded-xl bg-action-primary px-4 text-label font-medium text-action-primary-fg transition-colors duration-fast ease-standard hover:bg-action-primary-hover motion-safe:hover:shadow-glow"
                >
                  <Icon icon={Download} size={16} />
                  Download for Windows (.exe)
                </a>
                <a
                  href="/api/v1/printing/agent-download/windows?format=zip"
                  download="FlowDineOS-Print-Agent-Setup.zip"
                  className="inline-flex h-10 items-center gap-2 rounded-xl border border-border-strong bg-card px-4 text-label font-medium text-fg-primary transition-colors duration-fast ease-standard hover:bg-raised"
                >
                  <Icon icon={Download} size={16} />
                  Download as .ZIP
                </a>
                <span className="text-caption text-fg-secondary font-mono">~23 MB</span>
              </div>
            </div>

            <ol className="flex list-decimal flex-col gap-2 pl-5 text-body text-fg-secondary">
              <li>
                Run <strong>FlowDineOS-Print-Agent-Setup.exe</strong> (or extract the <strong>.zip</strong>) as Administrator on the restaurant PC.
              </li>
              <li>
                When prompted, paste the pairing code: <strong className="text-fg-primary font-mono">{issued.pairingCode}</strong>.
              </li>
              <li>
                The installer registers and starts the background Windows service automatically.
              </li>
              <li>
                Assign this agent to your printers on the <strong>Printers</strong> tab, then send a test print.
              </li>
            </ol>

            <div className="flex flex-col gap-2 rounded-xl border border-border-subtle bg-surface-muted/40 p-3 text-caption text-fg-secondary">
              <span className="font-semibold text-fg-primary">Browser &amp; Windows Download Tips:</span>
              <ul className="flex list-disc flex-col gap-1 pl-4">
                <li>
                  <strong className="text-fg-primary">Chrome &ldquo;Suspicious file blocked&rdquo;:</strong> Chrome may pause new unsigned <code>.exe</code> downloads. In Chrome&rsquo;s top bar, click the Downloads icon &rarr; select <em>&ldquo;Download suspicious file&rdquo;</em> (or <em>&ldquo;Keep anyway&rdquo;</em>) to let it finish. Alternatively, use the <strong>Download as .ZIP</strong> button above, which Chrome downloads without blocking.
                </li>
                <li>
                  <strong className="text-fg-primary">File Explorer &ldquo;Cannot open file&rdquo;:</strong> If the file shows with a <code>.crdownload</code> extension, Chrome paused it before finishing. Resume or keep it in Chrome first, or use the <code>.ZIP</code> download.
                </li>
                <li>
                  <strong className="text-fg-primary">Windows SmartScreen:</strong> If Windows displays <em>&ldquo;Windows protected your PC&rdquo;</em>, click <em>&ldquo;More info&rdquo;</em> &rarr; <em>&ldquo;Run anyway&rdquo;</em>.
                </li>
              </ul>
            </div>

            {/* Linux alternative */}
            <div className="mt-1 border-t border-border-subtle pt-2">
              <button
                type="button"
                onClick={() => setShowLinux(!showLinux)}
                className="text-caption text-fg-muted hover:text-fg-primary transition-colors flex items-center gap-1"
              >
                <Icon icon={Terminal} size={16} />
                {showLinux ? "Hide Linux instructions" : "Need Linux / Raspberry Pi instead?"}
              </button>

              {showLinux && (
                <div className="mt-2 flex flex-col gap-2 rounded-lg border border-border-subtle bg-surface-muted/30 p-3 text-caption text-fg-secondary">
                  <div className="flex items-center justify-between">
                    <span>Linux package (systemd service)</span>
                    <a
                      href="/api/v1/printing/agent-download/linux"
                      download="flowdineos-print-agent-linux.tar.gz"
                      className="inline-flex items-center gap-1 text-fg-primary underline hover:text-fg-secondary"
                    >
                      <Icon icon={Download} size={16} />
                      flowdineos-print-agent-linux.tar.gz
                    </a>
                  </div>
                  <p>Extract and run the installer as root:</p>
                  <code className="block overflow-x-auto whitespace-pre rounded border border-border-subtle bg-raised p-2 text-fg-primary">
                    {`sudo sh install.sh ${serverOrigin} ${issued.pairingCode}`}
                  </code>
                </div>
              )}
            </div>
          </div>
        ) : (
          <TextField
            name="name"
            label="Device name"
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
            error={fieldError}
            placeholder="Counter PC"
            maxLength={60}
          />
        )}
      </div>
    </Dialog>
  );
}
