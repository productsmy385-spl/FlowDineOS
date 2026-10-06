"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { Menu as MenuIcon } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";
import { bottomNavItemsFor, navItemsFor, primaryActionFor, roleLabel } from "@/lib/ui/navigation";
import { useCapabilities, useConsoleSession } from "@/lib/ui/session-context";
import { BottomNav } from "./bottom-nav";
import { SkipLink } from "./brand";
import { ContextBlock } from "./context-block";
import { HeaderNav } from "./header-nav";
import { MobileNavPanel } from "./mobile-nav-panel";
import { NotificationsMenu, type OperationalIndicator } from "./notifications";
import { RestaurantMark } from "./restaurant-mark";
import { UserMenu } from "./user-menu";
import { FoodBackdrop } from "./food-backdrop";

/**
 * Console shell (ADR-013 §3, frontend.md §2–3, design.md §4.2/§6). Brand v2 has **no desktop sidebar**:
 * - ≥ 768 px: a sticky 64 px `glass-1` header carrying brand, capability-filtered navigation with runtime overflow
 *   into "More", the restaurant/clock context block, operational indicators and the profile menu.
 * - < 768 px: the header keeps ☰, brand, indicators and profile; navigation moves to a `glass-1` bottom bar with the
 *   role's four destinations, a centre action and "Menu", and every feature is one tap away in the left side panel
 *   (ADR-013 §3 as amended 2026-09-25 — a side panel on phones only; desktop still has no sidebar).
 * Content is centred at 1440 px with 16/24/32 px gutters. Navigation shows only what the role may use; the server
 * still checks every page and action (SC-RBAC-08).
 */
export type ShellSlots = {
  /** Operational indicators for the header bell (printing health), resolved on the server. */
  indicators?: readonly OperationalIndicator[];
};

export function AppShell({ children, indicators = [] }: { children: React.ReactNode } & ShellSlots) {
  const session = useConsoleSession();
  const capabilities = useCapabilities();
  const pathname = usePathname() ?? "";
  const items = navItemsFor(capabilities);
  const bottomItems = session ? bottomNavItemsFor(session.activeTenant.role, capabilities) : [];
  const action = primaryActionFor(capabilities);
  const [panelOpen, setPanelOpen] = React.useState(false);
  const closePanel = React.useCallback(() => setPanelOpen(false), []);

  return (
    <>
      <SkipLink />
      <div className="page-wash isolate flex min-h-screen flex-col bg-canvas text-fg-primary">
        <FoodBackdrop />
        <header className="glass-1 sticky top-0 z-header border-b print:hidden">
          <div className="mx-auto flex h-header w-full max-w-console items-center gap-3 px-4 sm:px-6 lg:px-8">
            <IconButton
              icon={MenuIcon}
              aria-label="Open menu"
              aria-expanded={panelOpen}
              aria-haspopup="dialog"
              onClick={() => setPanelOpen(true)}
              className="-ml-2 shrink-0 md:hidden"
            />
            {session && <RestaurantMark href="/restaurant" name={session.activeTenant.name} logoUrl={session.activeTenant.logoUrl} className="max-w-[12rem] shrink md:shrink-0 lg:max-w-xs" />}
            <HeaderNav items={items} pathname={pathname} />
            <div className="ml-auto flex shrink-0 items-center gap-2">
              {session && <ContextBlock session={session} />}
              <NotificationsMenu indicators={indicators} />
              {session && (
                <UserMenu
                  name={session.user.fullName}
                  email={session.user.email}
                  roleLabel={`${roleLabel(session.activeTenant.role)} · ${session.activeTenant.name}`}
                  switchHref={session.membershipCount > 1 ? "/account/select-tenant" : undefined}
                  themeInPanelOnMobile
                />
              )}
            </div>
          </div>
        </header>

        <main id="main-content" tabIndex={-1} className="mx-auto w-full min-w-0 max-w-console flex-1 px-4 pt-6 pb-bottom-bar focus:outline-none sm:px-6 lg:px-8 lg:py-8 md:pb-8">
          {children}
        </main>
      </div>
      <BottomNav items={bottomItems} action={action} pathname={pathname} onOpenMenu={() => setPanelOpen(true)} menuOpen={panelOpen} />
      <MobileNavPanel open={panelOpen} onClose={closePanel} items={items} pathname={pathname} title={session?.activeTenant.name ?? "Menu"} />
    </>
  );
}
