import Link from "next/link";
import { hasPermission } from "@/lib/auth/permissions";
import { DataShortcuts } from "@/components/settings/data-shortcuts";
import { AuditEntryRow } from "@/components/audit/audit-entry";
import { PageHeader } from "@/components/layout/page-header";
import { EmptyState } from "@/components/states/empty-state";
import { Card } from "@/components/ui/card";
import { requireTenantPage } from "@/lib/auth/guards";
import { auditFilterOptions, listTenantAudit } from "@/lib/data/audit";
import { DOMAIN_ICONS } from "@/lib/ui/icons";
import { formatInZone } from "@/lib/ui/format";
import { parseIsoDate } from "@/lib/time/business-date";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;
const single = (value: string | string[] | undefined) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
const isoDate = (value: string | undefined) => (value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined);

/**
 * Tenant audit log (S1-P23-T002; api.md LD-AUD-01). `audit:read` is checked before anything is read, and every row
 * comes from the caller's own tenant — platform actions live on the Super Admin console and are never shown here.
 * Times are the restaurant's, and each entry expands to the redacted before/after of the fields that changed.
 * Only `action`, `resourceType`, `from` and `to` are read from the URL; anything else in the query is ignored.
 */
export default async function AuditPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const ctx = await requireTenantPage("audit:read");
  const params = await searchParams;
  const action = single(params.action);
  const resourceType = single(params.resourceType);
  const from = isoDate(single(params.from));
  const to = isoDate(single(params.to));

  const [{ items, nextCursor }, options] = await Promise.all([
    listTenantAudit(ctx, {
      action,
      resourceType,
      from: from ? parseIsoDate(from) : undefined,
      // `to` is a date the person picked, so it means the whole of that day in the restaurant's zone.
      to: to ? new Date(parseIsoDate(to).getTime() + 24 * 60 * 60 * 1000 - 1) : undefined,
      cursor: single(params.cursor),
    }),
    auditFilterOptions(ctx),
  ]);

  const query = (next: Record<string, string | undefined>) => {
    const search = new URLSearchParams();
    for (const [k, v] of Object.entries({ action, resourceType, from, to, ...next })) if (v) search.set(k, v);
    const qs = search.toString();
    return qs ? `/restaurant/audit?${qs}` : "/restaurant/audit";
  };

  return (
    <div className="mx-auto w-full max-w-5xl">
      <PageHeader
        title="Audit log"
        description={`Who changed what in this restaurant. Times are shown in ${ctx.restaurant.timezone}.`}
        actions={hasPermission(ctx, "data:export") ? <DataShortcuts datasets={["audit"]} label="Audit entries" deleteCategory={hasPermission(ctx, "data:purge") ? "audit" : undefined} /> : undefined}
      />

      <Card className="p-4">
        <form method="get" className="flex flex-wrap items-end gap-3" data-testid="audit-filters">
          <label className="flex min-w-[10rem] flex-1 flex-col gap-1 text-caption text-fg-secondary">
            Action
            <select name="action" defaultValue={action ?? ""} className="h-10 rounded-xl border border-border-subtle bg-surface-raised px-3 text-body text-fg-primary">
              <option value="">All actions</option>
              {options.actions.map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </select>
          </label>
          <label className="flex min-w-[10rem] flex-1 flex-col gap-1 text-caption text-fg-secondary">
            Resource
            <select name="resourceType" defaultValue={resourceType ?? ""} className="h-10 rounded-xl border border-border-subtle bg-surface-raised px-3 text-body text-fg-primary">
              <option value="">All resources</option>
              {options.resourceTypes.map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-caption text-fg-secondary">
            From
            <input type="date" name="from" defaultValue={from ?? ""} className="h-10 rounded-xl border border-border-subtle bg-surface-raised px-3 text-body text-fg-primary" />
          </label>
          <label className="flex flex-col gap-1 text-caption text-fg-secondary">
            To
            <input type="date" name="to" defaultValue={to ?? ""} className="h-10 rounded-xl border border-border-subtle bg-surface-raised px-3 text-body text-fg-primary" />
          </label>
          <button type="submit" className="h-10 rounded-xl bg-action-primary px-4 text-label text-action-primary-fg">Apply</button>
          {(action || resourceType || from || to) && (
            <Link href="/restaurant/audit" className="h-10 px-2 text-label text-fg-secondary underline-offset-4 hover:underline">Clear</Link>
          )}
        </form>
      </Card>

      <Card className="mt-4 p-2" data-testid="audit-entries">
        {items.length === 0 ? (
          <EmptyState
            icon={DOMAIN_ICONS.audit}
            title="Nothing recorded yet"
            description={
              action || resourceType || from || to
                ? "No entries match these filters. Widen the dates or clear the filters."
                : "Changes to the menu, orders, staff and settings will appear here as they happen."
            }
          />
        ) : (
          items.map((entry) => (
            <AuditEntryRow key={entry.id} entry={entry} timestamp={formatInZone(entry.createdAt, ctx.restaurant.timezone, "datetime")} />
          ))
        )}
      </Card>

      {nextCursor && (
        <div className="flex justify-center py-4">
          <Link href={query({ cursor: nextCursor })} className="h-10 rounded-xl border border-border-subtle px-4 text-label text-fg-primary leading-10">
            Show older entries
          </Link>
        </div>
      )}
    </div>
  );
}
