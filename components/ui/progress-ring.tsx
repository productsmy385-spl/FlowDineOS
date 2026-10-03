import { cn } from "@/lib/ui/cn";

/**
 * A ring that fills to a share of a whole (RASOIOS-ADR-020, Stitch "orders fulfilled 91%").
 *
 * Pure SVG and CSS: the stroke draws from empty to its value once, on mount, with the `ring-fill` keyframes in
 * globals.css, and the global reduced-motion rule stills it. The percentage is rounded here, from two integers the
 * server already counted, so nothing is invented or estimated on the client.
 */
export function ProgressRing({ part, whole, label, size = 56, className }: { part: number; whole: number; label: string; size?: number; className?: string }) {
  const pct = whole > 0 ? Math.max(0, Math.min(100, Math.round((part / whole) * 100))) : 0;
  const stroke = 5;
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const offset = circumference * (1 - pct / 100);
  return (
    <span className={cn("relative inline-flex shrink-0 items-center justify-center", className)} style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${label}: ${pct}%`} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} className="stroke-border-subtle" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          className="ring-fill stroke-action-primary"
          style={{ strokeDasharray: circumference, strokeDashoffset: offset, ["--ring-from" as string]: circumference }}
        />
      </svg>
      <span aria-hidden className="absolute text-caption font-semibold text-numeric text-fg-primary">
        {pct}%
      </span>
    </span>
  );
}
