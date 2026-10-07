import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/ui/cn";
import type { Tone } from "@/lib/ui/icons";
import { Icon } from "./icon";

/**
 * Badge (S1-P08-T004, design.md §7): 24 px pill, caption text, tonal background at 12% with an AA text colour.
 * Sentence case (no uppercase tracking). Prefer <StatusBadge> for statuses.
 */
export const TONE_BADGE: Record<Tone, string> = {
  neutral: "bg-fg-secondary/12 text-fg-secondary",
  primary: "bg-action-primary/12 text-fg-accent",
  success: "bg-status-success/12 text-status-success",
  warning: "bg-status-warning/12 text-status-warning",
  danger: "bg-status-danger/12 text-status-danger",
};

/** Baseline variant names mapped to tones (removed as pages are rebuilt). */
const LEGACY: Record<string, Tone> = { primary: "primary", success: "success", warning: "warning", destructive: "danger", outline: "neutral" };

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
  /** @deprecated use `tone`. */
  variant?: "primary" | "success" | "warning" | "destructive" | "outline";
  icon?: LucideIcon;
}

export function Badge({ className, tone, variant, icon, children, ...props }: BadgeProps) {
  const resolved: Tone = tone ?? (variant ? LEGACY[variant] : "neutral");
  return (
    <span className={cn("inline-flex max-w-full min-w-0 items-center gap-1.5 h-6 px-2.5 rounded-full text-caption whitespace-nowrap", TONE_BADGE[resolved], className)} {...props}>
      {/* A badge never grows wider than its cell: the icon keeps its size and a long label truncates (owner review
          2026-10-06, 320 px phones). */}
      {icon && <Icon icon={icon} size={16} className="shrink-0" />}
      {children}
    </span>
  );
}
