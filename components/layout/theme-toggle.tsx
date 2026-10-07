"use client";

import * as React from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { getThemePreferenceAction, setThemePreferenceAction } from "@/app/account/theme-actions";
import { Icon } from "@/components/ui/icon";
import { Menu } from "@/components/ui/menu";
import { cn } from "@/lib/ui/cn";
import {
  DEFAULT_THEME_PREFERENCE,
  defaultPreferenceFor,
  isThemePreference,
  resolveThemePreference,
  THEME_COOKIE,
  THEME_COOKIE_MAX_AGE,
  type ThemePreferenceValue,
} from "@/lib/ui/theme";

/**
 * The console's one theme control (RASOIOS-ADR-016), rendered next to the account menu in every console header.
 * Light / Dark / System. Applying is instant (attributes on <html>, the same ones the pre-paint boot script sets);
 * the choice is then saved to the person's account so it follows them to other devices. Only the platform theme
 * changes — restaurant websites keep their own theme on their own page wrapper.
 */
const OPTIONS: ReadonlyArray<{ value: ThemePreferenceValue; label: string; icon: typeof Sun }> = [
  { value: "LIGHT", label: "Light", icon: Sun },
  { value: "DARK", label: "Dark", icon: Moon },
  { value: "SYSTEM", label: "System", icon: Monitor },
];

function systemPrefersDark(): boolean {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;
}

export function applyTheme(preference: ThemePreferenceValue, { animate = false }: { animate?: boolean } = {}): void {
  const dark = resolveThemePreference(preference, systemPrefersDark()) === "dark";
  const root = document.documentElement;
  // A brief colour cross-fade when the person switches (CSS `.theme-switching`, off under reduced motion).
  if (animate) {
    root.classList.add("theme-switching");
    window.setTimeout(() => root.classList.remove("theme-switching"), 300);
  }
  root.setAttribute("data-theme", dark ? "dark" : "light");
  root.setAttribute("data-theme-preference", preference);
  root.classList.toggle("dark", dark);
  root.style.colorScheme = dark ? "dark" : "light";
}

function cookiePreference(): ThemePreferenceValue | null {
  const match = document.cookie.match(new RegExp(`(?:^|; )${THEME_COOKIE}=([A-Z]+)`));
  return match && isThemePreference(match[1]) ? match[1] : null;
}

/**
 * `saveToAccount={false}` for signed-out pages (the landing page, legal pages): the choice is kept in this browser's
 * cookie only, and nothing is asked of the server.
 */
export function ThemeToggle({ className, showLabel = false, saveToAccount = true }: { className?: string; showLabel?: boolean; saveToAccount?: boolean } = {}) {
  const [preference, setPreference] = React.useState<ThemePreferenceValue>(DEFAULT_THEME_PREFERENCE);

  React.useEffect(() => {
    const fromCookie = cookiePreference();
    if (fromCookie) {
      setPreference(fromCookie);
      return;
    }
    if (!saveToAccount) {
      // What the pre-paint script chose for this page (SYSTEM on marketing pages for a first visit).
      const booted = document.documentElement.getAttribute("data-theme-preference");
      setPreference(isThemePreference(booted) ? booted : defaultPreferenceFor(window.location.pathname));
      return;
    }
    // A browser that has never stored a choice (new device): load the one saved on the account.
    let cancelled = false;
    void getThemePreferenceAction().then((result) => {
      if (cancelled || !result.ok) return;
      setPreference(result.data.preference);
      applyTheme(result.data.preference);
    });
    return () => {
      cancelled = true;
    };
  }, [saveToAccount]);

  // SYSTEM follows the operating system live.
  React.useEffect(() => {
    if (preference !== "SYSTEM" || !window.matchMedia) return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("SYSTEM");
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [preference]);

  function choose(next: ThemePreferenceValue) {
    setPreference(next);
    applyTheme(next, { animate: true });
    // Written locally first so a reload keeps the choice even if saving to the account fails.
    document.cookie = `${THEME_COOKIE}=${next}; path=/; max-age=${THEME_COOKIE_MAX_AGE}; samesite=lax${window.location.protocol === "https:" ? "; secure" : ""}`;
    if (saveToAccount) void setThemePreferenceAction({ preference: next });
  }

  const current = OPTIONS.find((option) => option.value === preference) ?? OPTIONS[1];

  return (
    <Menu
      items={OPTIONS.map((option) => ({ label: option.label, icon: option.icon, checked: option.value === preference, onSelect: () => choose(option.value) }))}
      trigger={(props) => (
        <button
          {...props}
          aria-label={`Theme: ${current.label}. Change theme`}
          className={cn(
            "inline-flex h-11 shrink-0 items-center justify-center gap-3 rounded-xl text-fg-secondary transition-colors duration-fast ease-standard hover:bg-raised hover:text-fg-primary",
            showLabel ? "w-full justify-start px-2 text-label text-fg-primary" : "w-11",
            className,
          )}
        >
          <Icon icon={current.icon} size={20} />
          {showLabel && <span>Theme: {current.label}</span>}
        </button>
      )}
    />
  );
}
