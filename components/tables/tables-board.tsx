"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Copy, Download, Pencil, Plus, Printer, RefreshCw, Trash2 } from "lucide-react";
import { addTablesAction, archiveTableAction, editTableAction, rotateTableCodeAction } from "@/app/restaurant/tables/actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/ui/cn";

/**
 * Tables and their QR codes (RASOIOS-ADR-021, owner brief 2026-10-06 §11). Every QR image is drawn on the server from
 * the table's address; this board only shows, downloads and prints it. Switching a table off or regenerating its code
 * makes printed copies stop working at once.
 */

type Table = { id: string; label: string; isActive: boolean; url: string; qr: { size: number; d: string }; qrSvg: string };

const slugify = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "table";

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Renders the QR SVG onto a canvas at print resolution and saves it as a PNG. */
async function savePng(table: Table, restaurant: string) {
  const image = new Image();
  const svgUrl = URL.createObjectURL(new Blob([table.qrSvg], { type: "image/svg+xml" }));
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("The QR image could not be drawn."));
    image.src = svgUrl;
  });
  const size = 1024;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d")!;
  context.imageSmoothingEnabled = false;
  context.drawImage(image, 0, 0, size, size);
  URL.revokeObjectURL(svgUrl);
  canvas.toBlob((blob) => blob && saveBlob(blob, `${slugify(restaurant)}-${slugify(table.label)}-qr.png`), "image/png");
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Opens a print-ready sheet: one card per table with the restaurant, the table and its QR. */
function printCards(tables: Table[], restaurant: string) {
  const win = window.open("", "_blank", "width=900,height=700");
  if (!win) return false;
  const cards = tables
    .map(
      (t) =>
        `<section class="card"><p class="name">${escapeHtml(restaurant)}</p><p class="table">${escapeHtml(t.label)}</p>${t.qrSvg}<p class="hint">Scan to see the menu</p></section>`,
    )
    .join("");
  win.document.write(
    `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(restaurant)} - table QR codes</title><style>` +
      `body{margin:0;font-family:system-ui,sans-serif;color:#000;background:#fff}` +
      `.sheet{display:grid;grid-template-columns:repeat(auto-fill,minmax(8cm,1fr));gap:1cm;padding:1cm}` +
      `.card{border:1px solid #000;border-radius:12px;padding:16px;text-align:center;break-inside:avoid}` +
      `.card svg{width:6cm;height:6cm;display:block;margin:8px auto}.name{font-size:14px;margin:0}.table{font-size:28px;font-weight:700;margin:4px 0}.hint{font-size:13px;margin:0}` +
      `</style></head><body><main class="sheet">${cards}</main><script>window.onload=function(){window.print()}</script></body></html>`,
  );
  win.document.close();
  return true;
}

export function TablesBoard({ restaurantName, websitePublished, tables }: { restaurantName: string; websitePublished: boolean; tables: Table[] }) {
  const router = useRouter();
  const toast = useToast();
  const [count, setCount] = React.useState(10);
  const [name, setName] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [renaming, setRenaming] = React.useState<Table | null>(null);
  const [renameTo, setRenameTo] = React.useState("");
  const [rotating, setRotating] = React.useState<Table | null>(null);
  const [archiving, setArchiving] = React.useState<Table | null>(null);

  async function run<T>(work: () => Promise<{ ok: true; data: T } | { ok: false; error: { message: string } }>, success: string) {
    setBusy(true);
    const result = await work();
    setBusy(false);
    if (!result.ok) {
      toast.error(result.error.message);
      return false;
    }
    toast.success(success);
    router.refresh();
    return true;
  }

  const print = (list: Table[]) => {
    if (!printCards(list, restaurantName)) toast.error("Allow pop-ups for this site to print the QR codes.");
  };

  return (
    <div className="flex min-w-0 flex-col gap-6">
      {!websitePublished && (
        <p role="status" className="rounded-xl border border-status-warning/30 bg-status-warning/12 px-3 py-2 text-body text-fg-primary">
          Your website is not published yet, so the QR codes will open a &ldquo;not found&rdquo; page. Publish it from Website before putting codes on tables.
        </p>
      )}

      <Card>
        <CardContent className="flex flex-col gap-4 pt-6 md:flex-row md:items-end">
          <label className="flex flex-col gap-1.5 text-label text-fg-primary">
            Add numbered tables
            <span className="flex gap-2">
              <input type="number" min={1} max={50} value={count} onChange={(e) => setCount(Math.max(1, Math.min(50, Number(e.target.value) || 1)))} className="h-10 w-24 rounded-xl border border-border-strong bg-canvas px-3 text-body" />
              <Button icon={Plus} disabled={busy} onClick={() => run(() => addTablesAction({ count }), `Added ${count} table${count === 1 ? "" : "s"}.`)}>
                Add
              </Button>
            </span>
          </label>
          <label className="flex min-w-0 flex-1 flex-col gap-1.5 text-label text-fg-primary">
            Or add one by name
            <span className="flex gap-2">
              <input value={name} maxLength={20} placeholder="e.g. Patio 3" onChange={(e) => setName(e.target.value)} className="h-10 min-w-0 flex-1 rounded-xl border border-border-strong bg-canvas px-3 text-body" />
              <Button
                variant="secondary"
                icon={Plus}
                disabled={busy || name.trim() === ""}
                onClick={async () => {
                  if (await run(() => addTablesAction({ label: name.trim() }), `Added ${name.trim()}.`)) setName("");
                }}
              >
                Add
              </Button>
            </span>
          </label>
          {tables.length > 0 && (
            <Button variant="secondary" icon={Printer} onClick={() => print(tables.filter((t) => t.isActive))}>
              Print all QR codes
            </Button>
          )}
        </CardContent>
      </Card>

      {tables.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-border-strong p-8 text-center text-body text-fg-secondary">No tables yet. Add them above to get a QR code for each one.</p>
      ) : (
        <ul className="grid list-none grid-cols-1 gap-4 p-0 sm:grid-cols-2 xl:grid-cols-3">
          {tables.map((table) => (
            <li key={table.id} className="flex min-w-0">
              <Card className={cn("flex w-full min-w-0 flex-col", !table.isActive && "opacity-70")}>
                <CardContent className="flex flex-col gap-3 pt-6">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h2 className="truncate text-subheading text-fg-primary">{table.label}</h2>
                      <p className={cn("text-caption", table.isActive ? "text-status-success" : "text-fg-secondary")}>{table.isActive ? "QR is live" : "QR switched off"}</p>
                    </div>
                    <label className="flex shrink-0 items-center gap-2 text-caption text-fg-secondary">
                      <input
                        type="checkbox"
                        className="size-4 accent-action-primary"
                        checked={table.isActive}
                        onChange={(e) => run(() => editTableAction({ id: table.id, isActive: e.target.checked }), e.target.checked ? `${table.label} QR is live.` : `${table.label} QR switched off.`)}
                      />
                      Live
                    </label>
                  </div>
                  <svg viewBox={`0 0 ${table.qr.size} ${table.qr.size}`} shapeRendering="crispEdges" role="img" aria-label={`QR code for ${table.label}`} className="mx-auto w-full max-w-[13rem] rounded-xl">
                    <rect width={table.qr.size} height={table.qr.size} fill="#ffffff" />
                    <path d={table.qr.d} fill="#000000" />
                  </svg>
                  <p className="truncate text-center text-caption text-fg-secondary" title={table.url}>
                    {table.url}
                  </p>
                  <div className="flex flex-wrap justify-center gap-2">
                    <Button size="sm" variant="secondary" icon={Download} onClick={() => savePng(table, restaurantName).catch((e: Error) => toast.error(e.message))}>
                      PNG
                    </Button>
                    <Button size="sm" variant="secondary" icon={Download} onClick={() => saveBlob(new Blob([table.qrSvg], { type: "image/svg+xml" }), `${slugify(restaurantName)}-${slugify(table.label)}-qr.svg`)}>
                      SVG
                    </Button>
                    <Button size="sm" variant="secondary" icon={Printer} onClick={() => print([table])}>
                      Print
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      icon={Copy}
                      onClick={() => navigator.clipboard.writeText(table.url).then(() => toast.success("Link copied."), () => toast.error("Could not copy the link."))}
                    >
                      Copy link
                    </Button>
                  </div>
                  <div className="flex flex-wrap justify-center gap-2 border-t border-border-subtle pt-3">
                    <Button size="sm" variant="ghost" icon={Pencil} onClick={() => { setRenaming(table); setRenameTo(table.label); }}>
                      Rename
                    </Button>
                    <Button size="sm" variant="ghost" icon={RefreshCw} onClick={() => setRotating(table)}>
                      New code
                    </Button>
                    <Button size="sm" variant="ghost" icon={Trash2} onClick={() => setArchiving(table)}>
                      Remove
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <Dialog
        open={renaming !== null}
        onClose={() => setRenaming(null)}
        title={`Rename ${renaming?.label ?? "table"}`}
        size="confirm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setRenaming(null)}>
              Cancel
            </Button>
            <Button
              loading={busy}
              disabled={renameTo.trim() === ""}
              onClick={async () => {
                if (renaming && (await run(() => editTableAction({ id: renaming.id, label: renameTo.trim() }), "Table renamed."))) setRenaming(null);
              }}
            >
              Save
            </Button>
          </>
        }
      >
        <label className="flex flex-col gap-1.5 text-label text-fg-primary">
          Table name
          <input value={renameTo} maxLength={20} onChange={(e) => setRenameTo(e.target.value)} className="h-10 rounded-xl border border-border-strong bg-canvas px-3 text-body" />
        </label>
        <p className="mt-2 text-caption text-fg-secondary">The QR code stays the same; only the name shown to guests changes.</p>
      </Dialog>

      <ConfirmDialog
        open={rotating !== null}
        onClose={() => setRotating(null)}
        title={`New QR code for ${rotating?.label ?? "this table"}?`}
        description="Printed copies of the current code will stop working straight away. Print the new one before you put it on the table."
        confirmLabel="Make new code"
        onConfirm={async () => {
          if (rotating && (await run(() => rotateTableCodeAction({ id: rotating.id }), "New QR code ready. Print it for the table."))) setRotating(null);
        }}
      />
      <ConfirmDialog
        open={archiving !== null}
        onClose={() => setArchiving(null)}
        title={`Remove ${archiving?.label ?? "this table"}?`}
        description="Its QR code stops working. Past orders are not affected."
        tone="destructive"
        confirmLabel="Remove table"
        onConfirm={async () => {
          if (archiving && (await run(() => archiveTableAction({ id: archiving.id }), "Table removed."))) setArchiving(null);
        }}
      />
    </div>
  );
}
