"use client";

import * as React from "react";
import Link from "next/link";
import { Drawer } from "@/components/ui/drawer";
import { IconTile } from "@/components/ui/icon-tile";
import { cn } from "@/lib/ui/cn";
import { ThemeToggle } from "./theme-toggle";
import { activeNavItem, groupNavItems, NAV_HUES, NAV_ICONS, NAV_ITEMS, type NavItem } from "@/lib/ui/navigation";

/**
 * Mobile side panel (below 768 px; ADR-013 §3 as amended 2026-09-25). Every feature the role may reach, grouped the
 * same way as the desktop header's overflow, in a full-height left sheet opened from the header's ☰ button or the
 * bottom bar's "Menu" slot. Desktop keeps its header navigation and never shows a sidebar.
 *
 * The list is the capability-filtered navigation — UI visibility only; every page and action still checks on the
 * server (SC-RBAC-08). The current page is marked with a tint *and* `aria-current="page"`. Focus trap, Esc and the
 * backdrop come from <Drawer>. Choosing a destination closes the panel through the pathname effect below — closing it in
 * the click itself would cancel the navigation.
 */
export function MobileNavPanel({
  open,
  onClose,
  items,
  pathname,
  title,
}: {
  open: boolean;
  onClose: () => void;
  items: readonly NavItem[];
  pathname: string;
  /** Shown at the top of the panel, e.g. the restaurant's name. */
  title: string;
}) {
  // A navigation that happens any other way (back button, a link in the page) also closes it.
  React.useEffect(() => onClose(), [pathname]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Drawer open={open} onClose={onClose} title={title} side="left" className="md:hidden">
      <nav aria-label="All features" className="flex flex-col gap-5">
        {groupNavItems(items).map(({ group, items: groupItems }) => (
          <div key={group} className="flex flex-col gap-1">
            <p className="px-2 pb-1 text-caption uppercase tracking-wide text-fg-secondary">{group}</p>
            <ul className="flex flex-col gap-1">
              {groupItems.map((item) => {
                const active = item.key === activeNavItem(NAV_ITEMS, pathname)?.key;
                return (
                  <li key={item.key}>
                    <Link
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "flex min-h-12 items-center gap-3 rounded-xl px-2 py-1.5 text-label transition-colors duration-fast ease-standard",
                        active ? "brand-underline bg-action-primary/12 text-fg-primary" : "text-fg-primary hover:bg-raised",
                      )}
                    >
                      <IconTile icon={NAV_ICONS[item.key]} size="sm" tone={NAV_HUES[item.key]} />
                      <span className="min-w-0 truncate">{item.label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
      <div className="mt-6 border-t border-border-subtle pt-4">
        <ThemeToggle showLabel />
      </div>
    </Drawer>
  );
}
