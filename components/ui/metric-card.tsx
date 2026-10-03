import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/ui/cn";
import type { DomainHue } from "@/lib/ui/icons";
import { IconTile } from "./icon-tile";

/**
 * Metric card (design.md §5.2 extension, Project Owner request 2026-09-25): the one card allowed to carry its domain
 * hue beyond the icon tile, as an *accent* — a tinted wash from the corner, a 4 px gradient bar along the top and a soft
 * glow behind the icon. The number itself stays in `text-fg-primary`, so it keeps full contrast on light and dark; the
 * hue never fills the card or colours body text (CLAUDE.md: raw hues are accents only).
 *
 * Classes are listed statically per hue so Tailwind generates them; every colour is a brand token.
 */
const HUE_STYLE: Record<DomainHue, { wash: string; bar: string; glow: string }> = {
  primary: { wash: "from-action-primary/16", bar: "from-action-primary to-action-primary/30", glow: "bg-action-primary/25" },
  success: { wash: "from-status-success/16", bar: "from-status-success to-status-success/30", glow: "bg-status-success/25" },
  warning: { wash: "from-status-warning/16", bar: "from-status-warning to-status-warning/30", glow: "bg-status-warning/25" },
  danger: { wash: "from-status-danger/14", bar: "from-status-danger to-status-danger/30", glow: "bg-status-danger/22" },
  neutral: { wash: "from-fg-secondary/10", bar: "from-fg-secondary/70 to-fg-secondary/20", glow: "bg-fg-secondary/15" },
  secondary: { wash: "from-secondary-500/18", bar: "from-secondary-500 to-secondary-500/30", glow: "bg-secondary-500/28" },
  "secondary-soft": { wash: "from-secondary-300/16", bar: "from-secondary-300 to-secondary-300/30", glow: "bg-secondary-300/25" },
  "tertiary-soft": { wash: "from-tertiary-300/14", bar: "from-tertiary-300 to-tertiary-300/30", glow: "bg-tertiary-300/22" },
  accent: { wash: "from-accent-400/18", bar: "from-accent-400 to-accent-400/30", glow: "bg-accent-400/28" },
  "accent-soft": { wash: "from-accent-300/16", bar: "from-accent-300 to-accent-300/30", glow: "bg-accent-300/25" },
};

/**
 * Hover (RASOIOS-ADR-020, Stitch §11): the card lifts 4 px, its shadow widens, its border firms up and the icon tile
 * nudges — about 200 ms, transform and shadow only, so it stays cheap. `aside` replaces the icon tile when the card
 * has something more telling to show there, such as a progress ring or an urgency badge.
 */
export function MetricCard({
  label,
  value,
  support,
  icon,
  hue,
  aside,
  className,
}: {
  label: string;
  value: React.ReactNode;
  support?: React.ReactNode;
  icon: LucideIcon;
  hue: DomainHue;
  aside?: React.ReactNode;
  className?: string;
}) {
  const style = HUE_STYLE[hue];
  return (
    <div
      className={cn(
        "group glass-2 rise-in relative isolate flex min-w-0 flex-col overflow-hidden rounded-2xl border border-border-subtle p-5 shadow-e1",
        "transition-[transform,box-shadow,border-color] duration-base ease-standard",
        "hover:border-border-strong hover:shadow-e2 motion-safe:hover:-translate-y-1",
        className,
      )}
    >
      <span aria-hidden className={cn("absolute inset-0 -z-10 bg-gradient-to-br via-transparent to-transparent", style.wash)} />
      <span aria-hidden className={cn("absolute inset-x-0 top-0 h-1 bg-gradient-to-r", style.bar)} />
      <span aria-hidden className={cn("absolute -right-6 -top-6 -z-10 h-28 w-28 rounded-full blur-2xl", style.glow)} />

      <div className="mb-3 flex items-start justify-between gap-3">
        <p className="min-w-0 text-label text-fg-secondary">{label}</p>
        {aside ?? (
          <span className="transition-transform duration-base ease-standard motion-safe:group-hover:-translate-y-0.5 motion-safe:group-hover:scale-105">
            <IconTile icon={icon} size="md" tone={hue} />
          </span>
        )}
      </div>
      <p className="text-display-m text-numeric text-fg-primary">{value}</p>
      {support && <p className="mt-1 text-caption text-fg-secondary">{support}</p>}
    </div>
  );
}
