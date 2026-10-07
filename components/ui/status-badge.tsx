import { cn } from "@/lib/ui/cn";
import { STATUS_ICONS, type StatusDomain, type StatusVisual } from "@/lib/ui/icons";
import { Badge } from "./badge";

/**
 * Status badge (S1-P08-T004, design.md §7): icon + label + tone for every status — never colour alone.
 * `PROCESSING` print jobs spin their icon only when motion is allowed.
 */
export function StatusBadge<D extends StatusDomain>({ domain, status, className }: { domain: D; status: keyof (typeof STATUS_ICONS)[D] & string; className?: string }) {
  const visual = (STATUS_ICONS[domain] as unknown as Record<string, StatusVisual>)[status];
  if (!visual) return <Badge tone="neutral">{status}</Badge>;
  return (
    <Badge
      tone={visual.tone}
      icon={visual.icon}
      className={cn(visual.muted && "opacity-80", domain === "printJob" && status === "PROCESSING" && "[&_svg]:motion-safe:animate-spin", className)}
    >
      <span title={visual.label} className={cn("min-w-0 truncate", visual.strike && "line-through")}>
        {visual.label}
      </span>
    </Badge>
  );
}
