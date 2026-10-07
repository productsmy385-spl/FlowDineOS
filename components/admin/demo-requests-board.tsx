"use client";

import * as React from "react";
import { Mail, Phone } from "lucide-react";
import { updateDemoRequestAction } from "@/app/admin/demo-requests/actions";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import type { DemoRequestRow } from "@/lib/data/demo-requests";
import { cn } from "@/lib/ui/cn";

/** Super Admin → Demo requests (RASOIOS-ADR-024): follow up each visitor's request; every change is audited. */

const STATUSES = ["NEW", "CONTACTED", "SCHEDULED", "COMPLETED", "CANCELLED"] as const;
const LABEL: Record<(typeof STATUSES)[number], string> = { NEW: "New", CONTACTED: "Contacted", SCHEDULED: "Scheduled", COMPLETED: "Completed", CANCELLED: "Cancelled" };

export function DemoRequestsBoard({ initial, counts, canUpdate }: { initial: DemoRequestRow[]; counts: Record<string, number>; canUpdate: boolean }) {
  const [rows, setRows] = React.useState(initial);
  const [filter, setFilter] = React.useState<"ALL" | (typeof STATUSES)[number]>("ALL");
  const visible = rows.filter((r) => filter === "ALL" || r.status === filter);
  const total = Object.values(counts).reduce((n, v) => n + v, 0);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div role="tablist" aria-label="Request status" className="-mx-4 flex min-w-0 gap-2 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:px-0">
        {(["ALL", ...STATUSES] as const).map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={filter === key}
            onClick={() => setFilter(key)}
            className={cn(
              "inline-flex min-h-11 shrink-0 items-center gap-2 rounded-xl border px-3 text-label",
              filter === key ? "border-action-primary bg-action-primary/12 text-fg-accent" : "border-border-subtle bg-card text-fg-secondary",
            )}
          >
            {key === "ALL" ? "All" : LABEL[key]}
            <span className="text-numeric text-caption">{key === "ALL" ? total : (counts[key] ?? 0)}</span>
          </button>
        ))}
      </div>
      {visible.length === 0 ? (
        <Card padding="feature">
          <p className="text-body text-fg-secondary">No demo requests here yet. Requests from the website&apos;s &ldquo;Book a Demo&rdquo; form appear on this page.</p>
        </Card>
      ) : (
        <ul className="grid list-none grid-cols-[repeat(auto-fill,minmax(min(100%,22rem),1fr))] gap-4 p-0">
          {visible.map((row) => (
            <li key={row.id} className="flex min-w-0">
              <RequestCard row={row} canUpdate={canUpdate} onSaved={(next) => setRows((all) => all.map((r) => (r.id === next.id ? next : r)))} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RequestCard({ row, canUpdate, onSaved }: { row: DemoRequestRow; canUpdate: boolean; onSaved: (row: DemoRequestRow) => void }) {
  const toast = useToast();
  const [status, setStatus] = React.useState(row.status);
  const [notes, setNotes] = React.useState(row.notes ?? "");
  const [busy, setBusy] = React.useState(false);
  const dirty = status !== row.status || notes !== (row.notes ?? "");

  async function save() {
    setBusy(true);
    const result = await updateDemoRequestAction({ id: row.id, status, notes });
    setBusy(false);
    if (!result.ok) {
      toast.error(result.error.message);
      return;
    }
    onSaved(result.data);
    toast.success("Request updated.");
  }

  return (
    <Card padding="feature" className="flex w-full min-w-0 flex-col gap-3" data-testid="demo-request">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2">
        <div className="min-w-0">
          <p className="truncate text-heading text-fg-primary">{row.businessName}</p>
          <p className="truncate text-body text-fg-secondary">
            {row.name} · {row.city}
            {row.outletCount ? ` · ${row.outletCount} outlet${row.outletCount === 1 ? "" : "s"}` : ""}
          </p>
        </div>
        <span className="rounded-full bg-raised px-2.5 py-0.5 text-caption text-fg-primary">{LABEL[row.status]}</span>
      </div>
      <p className="text-label text-fg-primary">
        Prefers {row.preferredDate} at {row.preferredTime}
      </p>
      <div className="flex flex-wrap gap-2">
        <a href={`tel:${row.phone}`} className="inline-flex h-10 items-center gap-2 rounded-xl border border-border-strong px-3 text-label text-fg-primary hover:bg-raised">
          <Phone aria-hidden className="size-4" />
          {row.phone}
        </a>
        <a href={`mailto:${row.email}`} className="inline-flex h-10 min-w-0 max-w-full items-center gap-2 rounded-xl border border-border-strong px-3 text-label text-fg-primary hover:bg-raised">
          <Mail aria-hidden className="size-4 shrink-0" />
          <span className="truncate">{row.email}</span>
        </a>
      </div>
      {row.message && <p className="whitespace-pre-line break-words rounded-xl bg-raised p-3 text-body text-fg-primary">{row.message}</p>}
      <p className="text-caption text-fg-secondary">Received {new Date(row.createdAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST</p>
      {canUpdate && (
        <div className="flex flex-col gap-2 border-t border-border-subtle pt-3">
          <label className="flex flex-col gap-1 text-label text-fg-primary">
            Status
            <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} className="h-10 rounded-xl border border-border-strong bg-canvas px-3 text-body">
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {LABEL[s]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-label text-fg-primary">
            Notes
            <textarea value={notes} maxLength={2000} rows={3} onChange={(e) => setNotes(e.target.value)} placeholder="Called on…, demo set for…" className="rounded-xl border border-border-strong bg-canvas p-2 text-body" />
          </label>
          <Button size="sm" className="self-end" disabled={!dirty} loading={busy} loadingLabel="Saving…" onClick={save}>
            Save
          </Button>
        </div>
      )}
    </Card>
  );
}
