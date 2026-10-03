"use client";

import * as React from "react";

/**
 * A figure that counts up to its value (RASOIOS-ADR-020, Stitch "animated metrics").
 *
 * - **Exact at rest.** `display` is the server-formatted string (e.g. `₹18,450.00`) and is what is shown before the
 *   animation, after it, and to anyone who prefers reduced motion. The count only fills the time in between.
 * - **No floating-point money.** Money is interpolated as whole currency units parsed from the integer part of the
 *   decimal string, never via `parseFloat` (ADR-010); the paise appear only in the final, server-formatted frame.
 * - **Animates on change, not on render.** It runs on first mount and again only when `value` actually changes, from
 *   the previous figure to the new one — a re-render with the same number does nothing (Stitch §9).
 * - Tabular numerals, so the width does not wobble while it counts.
 */
export function AnimatedNumber({
  value,
  display,
  kind = "count",
  currencyCode,
  locale = "en-IN",
  durationMs = 900,
}: {
  /** Decimal string for money ("18450.00") or an integer string for counts ("42"). */
  value: string;
  /** The exact, server-formatted text to show at rest. */
  display: string;
  kind?: "money" | "count" | "percent";
  currencyCode?: string;
  locale?: string;
  durationMs?: number;
}) {
  const target = wholeUnits(value);
  const [shown, setShown] = React.useState<string>(display);
  const previous = React.useRef<number | null>(null);

  React.useEffect(() => {
    const from = previous.current ?? 0;
    previous.current = target;
    if (from === target || prefersReducedMotion()) {
      setShown(display);
      return;
    }

    const format = formatterFor(kind, currencyCode, locale);
    const started = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - started) / durationMs);
      const eased = 1 - (1 - t) ** 3; // ease-out cubic: quick start, gentle landing
      if (t < 1) {
        setShown(format(Math.round(from + (target - from) * eased)));
        frame = requestAnimationFrame(tick);
      } else {
        setShown(display); // the exact figure, paise and all
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, display, kind, currencyCode, locale, durationMs]);

  return (
    <span className="text-numeric">
      {/* Screen readers get the real figure once, not every intermediate frame. */}
      <span aria-hidden>{shown}</span>
      <span className="sr-only">{display}</span>
    </span>
  );
}

/** "18450.75" → 18450, "-12.50" → -12, "42" → 42. Integer parsing only: never a float for money. */
function wholeUnits(value: string): number {
  const integer = Number.parseInt(value.split(".")[0] ?? "0", 10);
  return Number.isFinite(integer) ? integer : 0;
}

function formatterFor(kind: "money" | "count" | "percent", currencyCode: string | undefined, locale: string): (n: number) => string {
  if (kind === "money" && currencyCode) {
    const nf = new Intl.NumberFormat(locale, { style: "currency", currency: currencyCode, maximumFractionDigits: 0 });
    return (n) => nf.format(n);
  }
  const nf = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  return kind === "percent" ? (n) => `${nf.format(n)}%` : (n) => nf.format(n);
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}
