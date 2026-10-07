"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Archive, CheckCircle2, Download, FileSpreadsheet, FileText, FileUp, History, ShieldAlert, Trash2 } from "lucide-react";
import { purgeDataAction, setBackupReminderAction } from "@/app/restaurant/settings/data/actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/ui/cn";
import { downloadExport } from "@/lib/ui/export-download";
import { DATASET_KEY_LIST, PURGE_CATEGORY_LIST } from "@/lib/validation/data";

/**
 * Data screen (RASOIOS-ADR-021, owner brief 2026-10-06 §3–8): download backups to this computer, restore missing
 * records from one, and — after a fresh backup and a typed confirmation — delete old history.
 *
 * Everything shown comes from the server; the server re-checks every step (permission, backup cover, confirmation),
 * so nothing here is the safeguard on its own.
 */

type Overview = {
  restaurantName: string;
  lastBackupAt: string | null;
  reminder: "MANUAL" | "MONTHLY" | "SIX_MONTHS";
  backupDue: boolean;
  today: string;
  counts: Record<string, number>;
  history: { id: string; action: string; at: string; by: string | null; summary: Record<string, unknown> }[];
};

type DatasetKey = (typeof DATASET_KEY_LIST)[number];
type PurgeKey = (typeof PURGE_CATEGORY_LIST)[number];

const DATASET_LABELS: Record<DatasetKey, string> = {
  restaurant: "Restaurant, website and Brand Kit",
  menu: "Menu",
  dailyMenus: "Daily menus",
  customers: "Customers",
  orders: "Orders and kitchen tickets",
  transactions: "Payments, refunds and day closes",
  reports: "Reports: daily sales summary",
  staff: "Staff and attendance",
  social: "Social posts",
  printing: "Printers and print history",
  audit: "Audit log",
};

const PURGE: Record<PurgeKey, { label: string; detail: string; needs: DatasetKey[] }> = {
  orders: { label: "Orders, bills and payments", needs: ["orders", "transactions"], detail: "Finished orders with their items, kitchen tickets, payments, refunds, receipts and day closes. Open orders are always kept." },
  customers: { label: "Customers without orders", needs: ["customers"], detail: "Customers added before the date who have no orders left." },
  printing: { label: "Print history", needs: ["printing"], detail: "Printed and failed print jobs and printer scans. Jobs still waiting are kept." },
  attendance: { label: "Staff attendance", needs: ["staff"], detail: "Finished staff sign-ins and expired daily passwords. Staff accounts are kept." },
  social: { label: "Social posts", needs: ["social"], detail: "Social post drafts and history." },
  audit: { label: "Audit log", needs: ["audit"], detail: "Activity older than the date. The record of backups, restores and deletions is always kept." },
};

const COUNT_LABELS: Record<string, string> = {
  orders: "Orders",
  payments: "Payments",
  customers: "Customers",
  menuItems: "Menu items",
  auditEntries: "Audit entries",
  printJobs: "Print jobs",
  attendance: "Staff sign-ins",
  socialPosts: "Social posts",
};

const CONFIRMATION = "DELETE MY RESTAURANT DATA";

const formatDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
const formatDateTime = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const shiftDate = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const download = (params: { datasets: DatasetKey[]; format: string; from?: string; to?: string; backupId?: string }) => downloadExport(params);

export function DataManagement({ overview, canImport, canDelete }: { overview: Overview; canImport: boolean; canDelete: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <BackupCard overview={overview} />
      <CustomExportCard />
      {canImport && <ImportCard />}
      {canImport && <ListImportCard />}
      {canDelete && <DeleteCard today={overview.today} />}
      <HistoryCard history={overview.history} />
    </div>
  );
}

function BackupCard({ overview }: { overview: Overview }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [reminder, setReminder] = React.useState(overview.reminder);

  async function run(format: string) {
    setBusy(format);
    try {
      const { filename } = await download({ datasets: [...DATASET_KEY_LIST], format });
      toast.success(`Saved ${filename} to this computer's downloads.`);
      router.refresh();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function changeReminder(value: Overview["reminder"]) {
    const previous = reminder;
    setReminder(value);
    const result = await setBackupReminderAction({ reminder: value });
    if (!result.ok) {
      setReminder(previous);
      toast.error(result.error.message);
    } else toast.success(value === "MANUAL" ? "Backup reminders are off." : `You'll be reminded ${value === "MONTHLY" ? "every month" : "every six months"}.`);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Archive className="size-5 text-fg-accent" aria-hidden /> Data backup
        </CardTitle>
        <CardDescription>Save a copy of {overview.restaurantName}&apos;s records to this computer or an external drive. Nothing is uploaded anywhere.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-2xl border border-border-subtle bg-raised p-4">
            <p className="text-caption text-fg-secondary">Last full backup</p>
            <p className="mt-1 text-subheading text-fg-primary" data-testid="last-backup">
              {overview.lastBackupAt ? formatDate(overview.lastBackupAt) : "Never"}
            </p>
            <p className={cn("mt-1 text-caption", overview.backupDue ? "text-status-warning" : "text-fg-secondary")}>
              {overview.backupDue ? "A backup is due." : overview.lastBackupAt ? "Up to date." : "Download your first backup below."}
            </p>
          </div>
          <label className="flex flex-col gap-1.5 rounded-2xl border border-border-subtle bg-raised p-4">
            <span className="text-caption text-fg-secondary">Remind me to back up</span>
            <select
              value={reminder}
              onChange={(e) => changeReminder(e.target.value as Overview["reminder"])}
              className="h-10 w-full rounded-xl border border-border-strong bg-canvas px-3 text-body text-fg-primary"
            >
              <option value="MONTHLY">Every month</option>
              <option value="SIX_MONTHS">Every 6 months</option>
              <option value="MANUAL">Manual only</option>
            </select>
          </label>
        </div>

        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {Object.entries(overview.counts).map(([key, value]) => (
            <div key={key} className="min-w-0 rounded-xl bg-raised px-3 py-2">
              <dt className="truncate text-caption text-fg-secondary">{COUNT_LABELS[key] ?? key}</dt>
              <dd className="text-label text-fg-primary tabular-nums">{value.toLocaleString()}</dd>
            </div>
          ))}
        </dl>

        <div className="flex flex-wrap gap-2">
          <Button icon={Download} onClick={() => run("zip")} loading={busy === "zip"} loadingLabel="Preparing…" disabled={busy !== null}>
            Download full backup (ZIP)
          </Button>
          <Button variant="secondary" icon={FileSpreadsheet} onClick={() => run("xlsx")} loading={busy === "xlsx"} loadingLabel="Preparing…" disabled={busy !== null}>
            Excel
          </Button>
          <Button variant="secondary" icon={FileText} onClick={() => run("csv")} loading={busy === "csv"} loadingLabel="Preparing…" disabled={busy !== null}>
            CSV
          </Button>
          <Button variant="secondary" icon={FileText} onClick={() => run("json")} loading={busy === "json"} loadingLabel="Preparing…" disabled={busy !== null}>
            JSON
          </Button>
        </div>
        <p className="text-caption text-fg-secondary">
          The ZIP holds everything: a restorable backup file, an Excel workbook and CSV files. Image addresses are included; the image files themselves stay on the
          image service. Passwords and sign-in tokens are never exported.
        </p>
      </CardContent>
    </Card>
  );
}

function CustomExportCard() {
  const toast = useToast();
  const [selected, setSelected] = React.useState<DatasetKey[]>(["orders", "transactions"]);
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");
  const [format, setFormat] = React.useState("xlsx");
  const [busy, setBusy] = React.useState(false);

  const toggle = (key: DatasetKey) => setSelected((s) => (s.includes(key) ? s.filter((k) => k !== key) : [...s, key]));

  async function run() {
    setBusy(true);
    try {
      const { filename } = await download({ datasets: selected, format, from: from || undefined, to: to || undefined });
      toast.success(`Saved ${filename}.`);
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Export selected data</CardTitle>
        <CardDescription>Pick what to export and, for orders, payments and history, which dates.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <fieldset className="grid gap-2 sm:grid-cols-2">
          <legend className="sr-only">Data to export</legend>
          {DATASET_KEY_LIST.map((key) => (
            <label key={key} className="flex min-h-10 cursor-pointer items-center gap-3 rounded-xl border border-border-subtle bg-raised px-3 text-body text-fg-primary">
              <input type="checkbox" className="size-4 accent-action-primary" checked={selected.includes(key)} onChange={() => toggle(key)} />
              {DATASET_LABELS[key]}
            </label>
          ))}
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="flex flex-col gap-1.5 text-label text-fg-primary">
            From (optional)
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-10 rounded-xl border border-border-strong bg-canvas px-3 text-body" />
          </label>
          <label className="flex flex-col gap-1.5 text-label text-fg-primary">
            To (optional)
            <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className="h-10 rounded-xl border border-border-strong bg-canvas px-3 text-body" />
          </label>
          <label className="flex flex-col gap-1.5 text-label text-fg-primary">
            Format
            <select value={format} onChange={(e) => setFormat(e.target.value)} className="h-10 rounded-xl border border-border-strong bg-canvas px-3 text-body">
              <option value="xlsx">Excel (.xlsx)</option>
              <option value="csv">CSV</option>
              <option value="json">JSON (restorable)</option>
              <option value="zip">ZIP (all formats)</option>
            </select>
          </label>
        </div>
        <div>
          <Button icon={Download} onClick={run} loading={busy} loadingLabel="Preparing…" disabled={selected.length === 0}>
            Download
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

type Preview = {
  fileName: string;
  source: { restaurant: string | null; exportedAt: string | null };
  tables: { table: string; title: string; total: number; toAdd: number; alreadyHere: number; invalid: number }[];
  ignored: string[];
  issues: string[];
  canImport: boolean;
};

async function postImport(file: File, mode: "preview" | "commit", kind: "backup" | "customers" | "menuItems" = "backup") {
  const form = new FormData();
  form.set("mode", mode);
  form.set("kind", kind);
  form.set("file", file);
  const response = await fetch("/api/v1/data/import", { method: "POST", body: form, credentials: "same-origin" });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error((body as { error?: { message?: string } } | null)?.error?.message ?? "The file could not be imported.");
  return body;
}

function ImportCard() {
  const router = useRouter();
  const toast = useToast();
  const [file, setFile] = React.useState<File | null>(null);
  const [preview, setPreview] = React.useState<Preview | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<"preview" | "commit" | null>(null);
  const [confirming, setConfirming] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  async function check(chosen: File) {
    setFile(chosen);
    setPreview(null);
    setError(null);
    setBusy("preview");
    try {
      setPreview((await postImport(chosen, "preview")) as Preview);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function commit() {
    if (!file) return;
    setBusy("commit");
    try {
      const result = (await postImport(file, "commit")) as { total: number };
      toast.success(`Imported ${result.total.toLocaleString()} records.`);
      setConfirming(false);
      setPreview(null);
      setFile(null);
      if (inputRef.current) inputRef.current.value = "";
      router.refresh();
    } catch (e) {
      setConfirming(false);
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const adding = preview?.tables.reduce((n, t) => n + t.toAdd, 0) ?? 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileUp className="size-5 text-fg-accent" aria-hidden /> Import backup
        </CardTitle>
        <CardDescription>
          Restore records from a backup of this restaurant: the ZIP, its backup.json, or CSV files from an export. Only missing records are added — nothing already
          here is changed.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5 text-label text-fg-primary">
          Backup file
          <input
            ref={inputRef}
            type="file"
            accept=".zip,.json,.csv"
            onChange={(e) => e.target.files?.[0] && check(e.target.files[0])}
            className="block w-full max-w-full text-body text-fg-primary file:mr-3 file:h-10 file:rounded-xl file:border file:border-border-strong file:bg-raised file:px-4 file:text-label file:text-fg-primary"
          />
        </label>
        {busy === "preview" && <p className="text-body text-fg-secondary">Checking the file…</p>}
        {error && (
          <p role="alert" className="rounded-xl border border-status-danger/30 bg-status-danger/12 px-3 py-2 text-body text-status-danger">
            {error}
          </p>
        )}
        {preview && (
          <div className="flex flex-col gap-3" data-testid="import-preview">
            <p className="text-body text-fg-secondary">
              {preview.fileName}
              {preview.source.exportedAt ? ` · exported ${formatDateTime(preview.source.exportedAt)}` : ""}
            </p>
            <div className="overflow-x-auto rounded-xl border border-border-subtle">
              <table className="w-full min-w-[480px] text-left text-body">
                <thead className="bg-raised text-caption text-fg-secondary">
                  <tr>
                    <th className="px-3 py-2 font-medium">Records</th>
                    <th className="px-3 py-2 text-right font-medium">In file</th>
                    <th className="px-3 py-2 text-right font-medium">Will be added</th>
                    <th className="px-3 py-2 text-right font-medium">Already here</th>
                    <th className="px-3 py-2 text-right font-medium">Problems</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.tables.map((t) => (
                    <tr key={t.table} className="border-t border-border-subtle">
                      <td className="px-3 py-2 text-fg-primary">{t.title}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{t.total.toLocaleString()}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-status-success">{t.toAdd.toLocaleString()}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-fg-secondary">{t.alreadyHere.toLocaleString()}</td>
                      <td className={cn("px-3 py-2 text-right tabular-nums", t.invalid > 0 ? "text-status-danger" : "text-fg-secondary")}>{t.invalid.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {preview.ignored.length > 0 && <p className="text-caption text-fg-secondary">Not restored from a file (export only): {preview.ignored.join(", ")}.</p>}
            {preview.issues.length > 0 && (
              <ul className="flex list-disc flex-col gap-1 rounded-xl border border-status-danger/30 bg-status-danger/12 py-2 pl-7 pr-3 text-caption text-fg-primary">
                {preview.issues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => { setPreview(null); setFile(null); if (inputRef.current) inputRef.current.value = ""; }}>
                Cancel
              </Button>
              <Button onClick={() => setConfirming(true)} disabled={!preview.canImport}>
                {preview.canImport ? `Import ${adding.toLocaleString()} records` : "Nothing to import"}
              </Button>
            </div>
          </div>
        )}
        <ConfirmDialog
          open={confirming}
          onClose={() => setConfirming(false)}
          title={`Import ${adding.toLocaleString()} records?`}
          description="They are added to this restaurant exactly as they were in the backup. Records already here are not changed."
          confirmLabel="Import"
          onConfirm={commit}
          pending={busy === "commit"}
        />
      </CardContent>
    </Card>
  );
}

function DeleteCard({ today }: { today: string }) {
  const router = useRouter();
  const toast = useToast();
  const [categories, setCategories] = React.useState<PurgeKey[]>([]);
  // Opened from a screen's "Delete old …" shortcut: start with that kind of data ticked (still nothing is deleted
  // without the backup and the typed confirmation).
  React.useEffect(() => {
    const wanted = new URLSearchParams(window.location.search).get("delete");
    if (wanted && (PURGE_CATEGORY_LIST as readonly string[]).includes(wanted)) setCategories([wanted as PurgeKey]);
  }, []);
  const [before, setBefore] = React.useState(shiftDate(today, -365));
  const [backup, setBackup] = React.useState<{ backupId: string; filename: string; key: string } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);
  const [result, setResult] = React.useState<{ deleted: Record<string, number>; keptOpenOrders: number } | null>(null);

  const needs = [...new Set(categories.flatMap((c) => PURGE[c].needs))];
  const key = `${needs.sort().join(",")}|${before}`;
  const backupReady = backup !== null && backup.key === key;
  const toggle = (c: PurgeKey) => setCategories((s) => (s.includes(c) ? s.filter((k) => k !== c) : [...s, c]));

  async function takeBackup() {
    setBusy(true);
    try {
      const backupId = crypto.randomUUID();
      const { filename } = await download({ datasets: needs, format: "zip", to: shiftDate(before, -1), backupId });
      setBackup({ backupId, filename, key });
      toast.success(`Backup saved as ${filename}. Keep it safe before deleting.`);
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function purge() {
    if (!backup) return;
    const outcome = await purgeDataAction({ categories, before, backupId: backup.backupId, confirmation: CONFIRMATION });
    setConfirming(false);
    if (!outcome.ok) {
      toast.error(outcome.error.message);
      return;
    }
    setResult(outcome.data);
    setBackup(null);
    setCategories([]);
    toast.success("Old data deleted. The deletion is recorded in the history below.");
    router.refresh();
  }

  return (
    <Card id="delete-old-data" className="scroll-mt-24 border-status-danger/40">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-status-danger">
          <ShieldAlert className="size-5" aria-hidden /> Delete old data
        </CardTitle>
        <CardDescription>
          Free up space by permanently removing history before a date. You must download a backup of exactly that data first; deleted records can only come back by
          importing that backup.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <ol className="flex flex-col gap-5">
          <li className="flex flex-col gap-3">
            <p className="text-label text-fg-primary">1. Choose what to delete</p>
            <div className="grid gap-2 md:grid-cols-2">
              {PURGE_CATEGORY_LIST.map((c) => (
                <label key={c} className="flex cursor-pointer items-start gap-3 rounded-xl border border-border-subtle bg-raised p-3">
                  <input type="checkbox" className="mt-1 size-4 shrink-0" checked={categories.includes(c)} onChange={() => toggle(c)} />
                  <span className="min-w-0">
                    <span className="block text-body text-fg-primary">{PURGE[c].label}</span>
                    <span className="block text-caption text-fg-secondary">{PURGE[c].detail}</span>
                  </span>
                </label>
              ))}
            </div>
            <label className="flex max-w-xs flex-col gap-1.5 text-label text-fg-primary">
              Delete everything before
              <input type="date" value={before} max={today} onChange={(e) => setBefore(e.target.value)} className="h-10 rounded-xl border border-border-strong bg-canvas px-3 text-body" />
            </label>
          </li>
          <li className="flex flex-col gap-2">
            <p className="text-label text-fg-primary">2. Download the backup of this data</p>
            {backupReady ? (
              <p className="flex items-center gap-2 text-body text-status-success">
                <CheckCircle2 className="size-4" aria-hidden /> Saved {backup.filename}
              </p>
            ) : (
              <div>
                <Button variant="secondary" icon={Download} onClick={takeBackup} loading={busy} loadingLabel="Preparing…" disabled={categories.length === 0 || !before}>
                  Download backup
                </Button>
              </div>
            )}
          </li>
          <li className="flex flex-col gap-2">
            <p className="text-label text-fg-primary">3. Delete</p>
            <div>
              <Button variant="destructive" icon={Trash2} onClick={() => setConfirming(true)} disabled={!backupReady}>
                Delete data before {before ? formatDate(`${before}T00:00:00`) : "…"}
              </Button>
            </div>
          </li>
        </ol>

        {result && (
          <div className="rounded-xl border border-border-subtle bg-raised p-3 text-body text-fg-primary" data-testid="purge-result">
            <p className="text-label">Deleted</p>
            <ul className="mt-1 grid grid-cols-2 gap-1 text-caption sm:grid-cols-3">
              {Object.entries(result.deleted).map(([k, v]) => (
                <li key={k}>
                  {k.replace(/([A-Z])/g, " $1").toLowerCase()}: <span className="tabular-nums">{v.toLocaleString()}</span>
                </li>
              ))}
            </ul>
            {result.keptOpenOrders > 0 && <p className="mt-2 text-caption text-fg-secondary">{result.keptOpenOrders} older orders are still open and were kept.</p>}
          </div>
        )}

        <ConfirmDialog
          open={confirming}
          onClose={() => setConfirming(false)}
          title="Permanently delete this data?"
          tone="destructive"
          confirmLabel="Delete permanently"
          confirmText={CONFIRMATION}
          onConfirm={purge}
        >
          <div className="flex gap-3 rounded-xl border border-status-danger/30 bg-status-danger/12 p-3 text-body text-fg-primary">
            <AlertTriangle className="mt-0.5 size-5 shrink-0 text-status-danger" aria-hidden />
            <div className="min-w-0">
              <p>Everything below dated before {before ? formatDate(`${before}T00:00:00`) : ""} will be removed for good:</p>
              <ul className="mt-1 list-disc pl-5">
                {categories.map((c) => (
                  <li key={c}>{PURGE[c].label}</li>
                ))}
              </ul>
              <p className="mt-2 text-caption text-fg-secondary">Reports for those dates will no longer show these records. Keep the backup you downloaded.</p>
            </div>
          </div>
        </ConfirmDialog>
      </CardContent>
    </Card>
  );
}

type ListPreview = { kind: "customers" | "menuItems"; fileName: string; total: number; toCreate: number; duplicates: number; errors: { row: number; message: string }[]; columns: string[]; newCategories: string[] };

const LIST_HELP = {
  customers: "Columns: Name (required), Phone, Email, Notes. Local 10-digit mobile numbers get your country code. A phone already on file is skipped.",
  menuItems: "Columns: Category, Name, Price, Tax rate (all required), Description, Veg/Non-veg/Egg. Missing categories are created. A dish already in its category is skipped.",
} as const;

/** Customers or dishes from an ordinary spreadsheet (RASOIOS-ADR-022): preview, then import, nothing overwritten. */
function ListImportCard() {
  const router = useRouter();
  const toast = useToast();
  const [kind, setKind] = React.useState<"customers" | "menuItems">("customers");
  const [file, setFile] = React.useState<File | null>(null);
  const [preview, setPreview] = React.useState<ListPreview | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const reset = () => {
    setPreview(null);
    setFile(null);
    setError(null);
    if (inputRef.current) inputRef.current.value = "";
  };

  async function check(chosen: File, which = kind) {
    setFile(chosen);
    setPreview(null);
    setError(null);
    setBusy(true);
    try {
      setPreview((await postImport(chosen, "preview", which)) as ListPreview);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!file) return;
    setBusy(true);
    try {
      const result = (await postImport(file, "commit", kind)) as { created: number; duplicates: number; failed: { row: number; message: string }[] };
      const noun = kind === "customers" ? "customer" : "dish";
      toast.success(`Imported ${result.created} ${noun}${result.created === 1 ? "" : kind === "customers" ? "s" : "es"}. Skipped ${result.duplicates} already here.`);
      if (result.failed.length > 0) setError(`${result.failed.length} row(s) could not be saved: ${result.failed.slice(0, 3).map((f) => `row ${f.row}: ${f.message}`).join("; ")}`);
      else reset();
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card id="import-list" className="scroll-mt-24">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileSpreadsheet className="size-5 text-fg-accent" aria-hidden /> Import a customer or menu list
        </CardTitle>
        <CardDescription>From any spreadsheet — Excel (.xlsx) or CSV. Each row is checked exactly like the console&apos;s own forms before anything is saved.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div role="radiogroup" aria-label="What the file contains" className="flex flex-wrap gap-2">
          {(["customers", "menuItems"] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={kind === k}
              onClick={() => {
                setKind(k);
                if (file) void check(file, k);
              }}
              className={cn("h-10 rounded-xl border px-4 text-label", kind === k ? "border-action-primary bg-action-primary/12 text-fg-accent" : "border-border-strong bg-raised text-fg-primary")}
            >
              {k === "customers" ? "Customers" : "Menu items"}
            </button>
          ))}
        </div>
        <p className="text-caption text-fg-secondary">{LIST_HELP[kind]}</p>
        <label className="flex flex-col gap-1.5 text-label text-fg-primary">
          Spreadsheet
          <input
            ref={inputRef}
            type="file"
            accept=".csv,.xlsx"
            onChange={(e) => e.target.files?.[0] && check(e.target.files[0])}
            className="block w-full max-w-full text-body text-fg-primary file:mr-3 file:h-10 file:rounded-xl file:border file:border-border-strong file:bg-raised file:px-4 file:text-label file:text-fg-primary"
          />
        </label>
        {busy && !preview && <p className="text-body text-fg-secondary">Checking the file…</p>}
        {error && (
          <p role="alert" className="rounded-xl border border-status-danger/30 bg-status-danger/12 px-3 py-2 text-body text-status-danger">
            {error}
          </p>
        )}
        {preview && (
          <div className="flex flex-col gap-3" data-testid="list-import-preview">
            <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[
                ["Rows", preview.total],
                ["Will be added", preview.toCreate],
                ["Already here", preview.duplicates],
                ["Problems", preview.errors.length],
              ].map(([label, value]) => (
                <div key={label} className="rounded-xl bg-raised px-3 py-2">
                  <dt className="text-caption text-fg-secondary">{label}</dt>
                  <dd className="text-label tabular-nums text-fg-primary">{Number(value).toLocaleString()}</dd>
                </div>
              ))}
            </dl>
            {preview.newCategories.length > 0 && <p className="text-caption text-fg-secondary">New menu sections will be created: {preview.newCategories.join(", ")}.</p>}
            {preview.errors.length > 0 && (
              <ul className="flex list-disc flex-col gap-1 rounded-xl border border-status-danger/30 bg-status-danger/12 py-2 pl-7 pr-3 text-caption text-fg-primary">
                {preview.errors.slice(0, 20).map((issue) => (
                  <li key={issue.row}>
                    Row {issue.row}: {issue.message}
                  </li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={reset}>
                Cancel
              </Button>
              <Button onClick={commit} loading={busy} loadingLabel="Importing…" disabled={preview.errors.length > 0 || preview.toCreate === 0}>
                {preview.errors.length > 0 ? "Fix the problem rows first" : preview.toCreate === 0 ? "Nothing new to import" : `Import ${preview.toCreate.toLocaleString()}`}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const HISTORY_LABEL: Record<string, string> = {
  "data.exported": "Backup downloaded",
  "data.imported": "Backup imported",
  "data.deleted": "Old data deleted",
  "data.backup_reminder_updated": "Backup reminder changed",
};

function HistoryCard({ history }: { history: Overview["history"] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <History className="size-5 text-fg-accent" aria-hidden /> Backup history
        </CardTitle>
        <CardDescription>Every backup, import and deletion is recorded here permanently.</CardDescription>
      </CardHeader>
      <CardContent>
        {history.length === 0 ? (
          <p className="text-body text-fg-secondary">No backups yet.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border-subtle">
            {history.map((event) => (
              <li key={event.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2">
                <span className="text-body text-fg-primary">
                  {HISTORY_LABEL[event.action] ?? event.action}
                  {event.action === "data.exported" && typeof event.summary.format === "string" ? ` · ${event.summary.format.toUpperCase()}` : ""}
                  {event.action === "data.deleted" && typeof event.summary.before === "string" ? ` · before ${formatDate(`${event.summary.before}T00:00:00`)}` : ""}
                  {event.action === "data.imported" && typeof event.summary.total === "number" ? ` · ${event.summary.total} records` : ""}
                </span>
                <span className="text-caption text-fg-secondary">
                  {formatDateTime(event.at)}
                  {event.by ? ` · ${event.by}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
