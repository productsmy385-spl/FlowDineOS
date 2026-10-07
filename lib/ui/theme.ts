/**
 * Console colour scheme (RASOIOS-ADR-016). Light and dark are the two token sets in app/globals.css; SYSTEM follows
 * the operating system. This is the PLATFORM theme only: a restaurant's public website sets its own `data-theme` and
 * brand variables on its page wrapper (ADR-013 §6), and nothing here reads or writes that.
 *
 * Persistence: the person's choice is stored on their USER row (so it follows them to another device) and mirrored
 * in a first-party cookie that the boot script reads before the first paint, so there is no flash of the wrong theme.
 */
export const THEME_PREFERENCES = ["LIGHT", "DARK", "SYSTEM"] as const;
export type ThemePreferenceValue = (typeof THEME_PREFERENCES)[number];
export type ResolvedTheme = "light" | "dark";

/** ADR-013's default: the console is dark unless the person chooses otherwise. */
export const DEFAULT_THEME_PREFERENCE: ThemePreferenceValue = "DARK";
export const THEME_COOKIE = "rasoios-theme";
/**
 * The platform's public marketing pages (owner brief 2026-10-07): a first-time visitor with no saved choice gets their
 * operating system's light/dark setting. Consoles keep ADR-013's dark default.
 */
export const MARKETING_PATHS = ["/", "/book-demo", "/privacy", "/terms"] as const;
export function defaultPreferenceFor(pathname: string): ThemePreferenceValue {
  return (MARKETING_PATHS as readonly string[]).includes(pathname) ? "SYSTEM" : DEFAULT_THEME_PREFERENCE;
}
export const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function isThemePreference(value: unknown): value is ThemePreferenceValue {
  return typeof value === "string" && (THEME_PREFERENCES as readonly string[]).includes(value);
}

export function resolveThemePreference(preference: ThemePreferenceValue, systemPrefersDark: boolean): ResolvedTheme {
  if (preference === "LIGHT") return "light";
  if (preference === "DARK") return "dark";
  return systemPrefersDark ? "dark" : "light";
}

/**
 * Runs in <head> before the body is parsed. Fixed text — no user or tenant data is ever interpolated — so it is safe
 * as an inline script (SC-VAL-03). It sets `data-theme` and the Tailwind `dark` class on <html>, and records the
 * preference in `data-theme-preference` for the toggle. Any failure leaves the server-rendered dark default.
 */
export const THEME_BOOT_SCRIPT = `(function(){try{
var m=document.cookie.match(/(?:^|; )${THEME_COOKIE}=(LIGHT|DARK|SYSTEM)/);
var l=(window.location||{}).pathname;
var p=m?m[1]:(${JSON.stringify(MARKETING_PATHS)}.indexOf(l)+1?"SYSTEM":"${DEFAULT_THEME_PREFERENCE}");
var d=p==="DARK"||(p==="SYSTEM"?window.matchMedia("(prefers-color-scheme: dark)").matches:false);
var r=document.documentElement;
r.setAttribute("data-theme",d?"dark":"light");
r.setAttribute("data-theme-preference",p);
r.classList.toggle("dark",d);
r.style.colorScheme=d?"dark":"light";
}catch(e){}})();`;
