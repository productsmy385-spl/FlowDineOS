"use client";

import * as React from "react";
import { updateTenantFeaturesAction } from "@/app/admin/actions";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import { FEATURES, FEATURE_KEYS, type FeatureKey } from "@/lib/auth/features";
import { cn } from "@/lib/ui/cn";

/**
 * Feature switches for one restaurant (RASOIOS-ADR-023). The platform owner chooses features, not plans: there are no
 * packages or prices here. The two shortcuts only tick boxes; the server stores exactly the boxes that are ticked.
 */

const CORE: FeatureKey[] = ["ORDERS", "KITCHEN", "PRINTING", "BILLING", "MENU", "DAILY_MENU"];

export function FeatureChecklist({ value, onChange, disabled }: { value: ReadonlySet<FeatureKey>; onChange: (next: Set<FeatureKey>) => void; disabled?: boolean }) {
  const toggle = (key: FeatureKey) => {
    const next = new Set(value);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onChange(next);
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" disabled={disabled} onClick={() => onChange(new Set(FEATURE_KEYS))}>
          Turn everything on
        </Button>
        <Button size="sm" variant="secondary" disabled={disabled} onClick={() => onChange(new Set(CORE))}>
          Core operations only
        </Button>
      </div>
      <ul className="grid list-none gap-2 p-0 sm:grid-cols-2">
        {FEATURE_KEYS.map((key) => (
          <li key={key}>
            <label className={cn("flex h-full cursor-pointer items-start gap-3 rounded-xl border p-3", value.has(key) ? "border-action-primary/50 bg-action-primary/12" : "border-border-subtle bg-raised")}>
              <input type="checkbox" className="mt-1 size-4 shrink-0 accent-action-primary" checked={value.has(key)} disabled={disabled} onChange={() => toggle(key)} />
              <span className="min-w-0">
                <span className="block text-label text-fg-primary">{FEATURES[key].label}</span>
                <span className="block text-caption text-fg-secondary">{FEATURES[key].description}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      <p className="text-caption text-fg-secondary">Always on: dashboard, restaurant settings, kitchen sections and the audit log.</p>
    </div>
  );
}

export function TenantFeaturesCard({ tenantId, initial, canEdit }: { tenantId: string; initial: FeatureKey[]; canEdit: boolean }) {
  const toast = useToast();
  const [saved, setSaved] = React.useState(() => new Set(initial));
  const [value, setValue] = React.useState(() => new Set(initial));
  const [busy, setBusy] = React.useState(false);
  const dirty = saved.size !== value.size || [...value].some((k) => !saved.has(k));

  async function save() {
    setBusy(true);
    const result = await updateTenantFeaturesAction({ targetTenantId: tenantId, enabled: [...value] });
    setBusy(false);
    if (!result.ok) {
      toast.error(result.error.message);
      return;
    }
    const enabled = new Set(result.data.filter((f) => f.enabled).map((f) => f.key));
    setSaved(enabled);
    setValue(new Set(enabled));
    toast.success("Features saved. The restaurant sees the change on its next page load.");
  }

  return (
    <Card padding="feature" className="gap-4" data-testid="tenant-features">
      <FeatureChecklist value={value} onChange={setValue} disabled={!canEdit || busy} />
      {canEdit && (
        <div className="flex justify-end gap-2">
          <Button variant="secondary" disabled={!dirty || busy} onClick={() => setValue(new Set(saved))}>
            Undo changes
          </Button>
          <Button loading={busy} loadingLabel="Saving…" disabled={!dirty} onClick={save}>
            Save features
          </Button>
        </div>
      )}
    </Card>
  );
}
