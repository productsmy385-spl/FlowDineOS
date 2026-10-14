"use client";

import Link from "next/link";
import { Menu as MenuIcon } from "lucide-react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/ui/cn";
import { activeNavItem, NAV_ICONS, NAV_ITEMS, type NavItem } from "@/lib/ui/navigation";

/**
 * Glass bottom bar below 768 px (ADR-013 §3, amended 2026-09-25). The role's four most relevant destinations, the
 * role's main live action in the centre, and **More** (☰), which opens the side panel with every feature. ("More",
 * not "Menu": the restaurant's own Menu is a destination in the same bar.)
 *
 * Alignment: the bar is a grid of equal columns, and every slot — links, the centre action and Menu — has the same
 * structure (a 32 px icon pill on one baseline, a one-line label under it), so icons and labels line up exactly at
 * every width. The centre action is set apart by its filled brand pill, not by breaking out of the row.
 *
 * Every slot is at least 44 px wide and 64 px tall, the bar clears the home indicator with
 * `env(safe-area-inset-bottom)`, and the current page is marked with a tint plus `aria-current="page"`.
 */
/** Shorter names for the phone bar only; the side panel and the desktop header keep the full labels. */
const BAR_LABELS: Partial<Record<NavItem["key"], string>> = { dashboard: "Home", transactions: "Payments", dailyMenu: "Today" };

const SLOT = "flex h-16 min-w-0 flex-col items-center justify-center gap-1 px-0.5 text-caption leading-none transition-colors duration-fast ease-standard";
const PILL = "inline-flex h-8 w-12 shrink-0 items-center justify-center rounded-full";

// "more" is the side-panel slot; it must not share a name with the "menu" destination (the restaurant's Menu).
function Slot({ icon, label, active, emphasis }: { icon: NavItem["key"] | "more"; label: string; active?: boolean; emphasis?: boolean }) {
  return (
    <>
      <span className={cn(PILL, emphasis ? "brand-gradient text-action-primary-fg shadow-e1" : active && "bg-action-primary/12")}>
        <Icon icon={icon === "more" ? MenuIcon : NAV_ICONS[icon]} size={20} className={!emphasis && active ? "text-fg-accent" : undefined} />
      </span>
      <span className="block w-full truncate text-center">{label}</span>
    </>
  );
}

export function BottomNav({
  items,
  action,
  pathname,
  onOpenMenu,
  menuOpen,
}: {
  items: readonly NavItem[];
  action: NavItem | null;
  pathname: string;
  onOpenMenu: () => void;
  menuOpen: boolean;
}) {
  if (items.length === 0 && !action) return null;
  const left = items.slice(0, 2);
  const right = items.slice(2, 4);
  const columns = left.length + right.length + (action ? 1 : 0) + 1;

  // One active item for the page, judged against every item — a table bill under /restaurant/orders belongs to Dine-in.
  const current = activeNavItem(NAV_ITEMS, pathname)?.key;
  const link = (item: NavItem, emphasis = false) => {
    const active = item.key === current;
    return (
      <Link
        key={item.key}
        href={item.href}
        aria-current={active ? "page" : undefined}
        className={cn(SLOT, active || emphasis ? "text-fg-primary" : "text-fg-secondary hover:text-fg-primary")}
      >
        <Slot icon={item.key} label={BAR_LABELS[item.key] ?? item.label} active={active} emphasis={emphasis} />
      </Link>
    );
  };

  return (
    <nav aria-label="Primary" className="glass-1 fixed inset-x-0 bottom-0 z-header border-t md:hidden print:hidden" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
      <div className="mx-auto grid max-w-lg" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
        {left.map((item) => link(item))}
        {action && link(action, true)}
        {right.map((item) => link(item))}
        <button type="button" onClick={onOpenMenu} aria-expanded={menuOpen} aria-haspopup="dialog" className={cn(SLOT, "text-fg-secondary hover:text-fg-primary")}>
          <Slot icon="more" label="More" active={menuOpen} />
        </button>
      </div>
    </nav>
  );
}
