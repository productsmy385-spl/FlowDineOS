/**
 * Downloads an export from `GET /api/v1/data/export` and saves it through the browser (RASOIOS-ADR-021). The server
 * checks the permission, the tenant and the request's origin; this only saves what it sends back. Throws with the
 * server's message when the export is refused.
 */
export async function downloadExport(params: { datasets: string[]; format: string; from?: string; to?: string; backupId?: string }): Promise<{ backupId: string; filename: string }> {
  const query = new URLSearchParams({ datasets: params.datasets.join(","), format: params.format });
  if (params.from) query.set("from", params.from);
  if (params.to) query.set("to", params.to);
  if (params.backupId) query.set("backupId", params.backupId);
  const response = await fetch(`/api/v1/data/export?${query}`, { credentials: "same-origin" });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message ?? "The export could not be downloaded. Try again.");
  }
  const filename = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "")?.[1] ?? "restaurant-export";
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return { backupId: response.headers.get("x-backup-id") ?? "", filename };
}
