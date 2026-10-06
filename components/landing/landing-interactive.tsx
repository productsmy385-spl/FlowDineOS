"use client";

import * as React from "react";
import { ChefHat, Globe, Receipt } from "lucide-react";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { FolderCard, FolderRail } from "@/components/visual/folder-card";
import { MESH_PALETTES, MeshGradient, type MeshPaletteName } from "@/components/visual/mesh-gradient";
import { cn } from "@/lib/ui/cn";

/**
 * The interactive parts of the FlowDineOS landing page (owner brief 2026-10-06 §30–45). Everything a visitor reads is
 * also plain text in the server-rendered page; these add motion on top and nothing below depends on them.
 */

const STORAGE_KEY = "flowdine.landing.palette";
const PALETTE_NAMES = Object.keys(MESH_PALETTES) as MeshPaletteName[];
const PALETTE_LABELS: Record<MeshPaletteName, string> = { FLOW: "Flow", NOIR: "Noir", MINT: "Mint", PLUM: "Plum", NEON: "Neon" };

/** The hero's moving background with its colour-mode switch. Text sits on a scrim so it stays readable on every mode. */
export function HeroBackdrop({ children }: { children: React.ReactNode }) {
  const [name, setName] = React.useState<MeshPaletteName>("FLOW");
  React.useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored && stored in MESH_PALETTES) setName(stored as MeshPaletteName);
    } catch {
      // Storage blocked: the default mode stays.
    }
  }, []);
  const choose = (next: MeshPaletteName) => {
    setName(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Nothing to keep.
    }
  };
  return (
    <section className="relative isolate overflow-hidden" aria-labelledby="hero-title">
      <MeshGradient palette={MESH_PALETTES[name]} className="absolute inset-0 -z-10" />
      {/* Light modes need a heavier scrim behind white text than dark ones. */}
      <div aria-hidden className={cn("absolute inset-0 -z-10 bg-canvas", name === "MINT" ? "opacity-80" : "opacity-55")} />
      {children}
      <div role="radiogroup" aria-label="Background colours" className="absolute bottom-4 right-4 flex gap-1.5 rounded-full bg-card/80 p-1.5">
        {PALETTE_NAMES.map((key) => (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={name === key}
            aria-label={`${PALETTE_LABELS[key]} background`}
            title={PALETTE_LABELS[key]}
            onClick={() => choose(key)}
            className={cn("size-6 rounded-full border-2", name === key ? "border-fg-primary" : "border-transparent")}
            style={{ background: `linear-gradient(135deg, ${MESH_PALETTES[key][1]}, ${MESH_PALETTES[key][3]})` }}
          />
        ))}
      </div>
    </section>
  );
}

/** Product facts that count up — counts of what the software has, never claims about customers. */
export function Metrics({ items }: { items: ReadonlyArray<{ value: number; label: string }> }) {
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {items.map((item) => (
        <div key={item.label} className="glass-2 rounded-2xl p-4">
          <dd className="font-display text-display-m text-fg-primary">
            <AnimatedNumber value={String(item.value)} display={String(item.value)} />
          </dd>
          <dt className="text-caption text-fg-secondary">{item.label}</dt>
        </div>
      ))}
    </dl>
  );
}

const SHOWCASE = [
  { key: "ops", label: "Operations", title: "Orders to kitchen in one flow", detail: "Counter orders, kitchen tickets and printers", icon: ChefHat, gradient: "linear-gradient(140deg,#123d2a,#41e012 60%,#0cd9f5)" },
  { key: "money", label: "Billing", title: "Bills, payments and receipts", detail: "Cash, card and UPI, refunds and day close", icon: Receipt, gradient: "linear-gradient(140deg,#1a1150,#2015eb 55%,#0cd9f5)" },
  { key: "web", label: "Guests", title: "Your website and table QR menus", detail: "A 3D menu, today's dishes and sharing", icon: Globe, gradient: "linear-gradient(140deg,#3a0a12,#ef0e23 55%,#f59e0b)" },
] as const;

/** Three folder cards on the landing page: the same component as the restaurants' "Published today" rail. */
export function Showcase() {
  return (
    <FolderRail
      items={SHOWCASE}
      label="What FlowDineOS covers"
      keyOf={(item) => item.key}
      render={(item, state) => {
        const IconComponent = item.icon;
        return (
          <FolderCard
            gradient={item.gradient}
            label={item.label}
            title={item.title}
            detail={<span className="text-fg-secondary">{item.detail}</span>}
            active={state.active}
            dimmed={state.dimmed}
            onActivate={state.activate}
            onDeactivate={state.deactivate}
            object={
              <span className="flex aspect-square w-full items-center justify-center rounded-full bg-white/15 text-white">
                <IconComponent aria-hidden className="size-1/2" strokeWidth={1.4} />
              </span>
            }
          />
        );
      }}
    />
  );
}
