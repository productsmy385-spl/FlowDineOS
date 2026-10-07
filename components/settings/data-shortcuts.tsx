"use client";

import * as React from "react";
import Link from "next/link";
import { Download, FileUp, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { downloadExport } from "@/lib/ui/export-download";

/**
 * Export / import / delete shortcuts on the screens that hold the data (owner request 2026-10-07): Reports, Payments,
 * Audit log, Customers. Downloads go straight to the export endpoint; import and delete open the Data screen at the
 * right step, where the server-side checks (permission, backup-first, typed confirmation) apply exactly as there.
 * Shown only to roles with `data:export`; the server re-checks every request.
 */
export function DataShortcuts({
  datasets,
  label,
  importHref,
  deleteCategory,
  from,
  to,
}: {
  datasets: string[];
  /** Business-date range of what is on screen, e.g. the report's dates. */
  from?: string;
  to?: string;
  label: string;
  importHref?: string;
  deleteCategory?: string;
}) {
  const toast = useToast();
  const [busy, setBusy] = React.useState<string | null>(null);

  async function run(format: string) {
    setBusy(format);
    try {
      const { filename } = await downloadExport({ datasets, format, from, to });
      toast.success(`Saved ${filename}.`);
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const link = "inline-flex h-10 items-center gap-2 rounded-xl border border-border-strong bg-raised px-3 text-label text-fg-primary hover:bg-border-subtle";
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label={`${label}: export, import and delete`} data-testid="data-shortcuts">
      <Button size="sm" variant="secondary" icon={Download} loading={busy === "xlsx"} loadingLabel="Preparing…" disabled={busy !== null} onClick={() => run("xlsx")}>
        Excel
      </Button>
      <Button size="sm" variant="secondary" icon={Download} loading={busy === "csv"} loadingLabel="Preparing…" disabled={busy !== null} onClick={() => run("csv")}>
        CSV
      </Button>
      {importHref && (
        <Link href={importHref} className={link}>
          <FileUp aria-hidden className="size-4" />
          Import
        </Link>
      )}
      {deleteCategory && (
        <Link href={`/restaurant/settings/data?delete=${deleteCategory}#delete-old-data`} className={link}>
          <Trash2 aria-hidden className="size-4" />
          Delete old {label.toLowerCase()}
        </Link>
      )}
    </div>
  );
}
