---
title: "RASOIOS-ADR-016: Platform Light / Dark / System Theme"
document_type: "ADR"
project: "Restaurant SaaS Platform"
project_owner: "Gopala Krishna"
slice: "SLICE-01"
status: "APPROVED"
version: "1.0"
created: "2026-09-25"
last_updated: "2026-09-25"
owner: "Gopala Krishna (Project Owner)"
dependencies: ["RASOIOS-ADR-013"]
related_documents: ["../design/design-system.md", "../frontend/frontend.md"]
related_decisions: ["RASOIOS-ADR-013"]
---

# RASOIOS-ADR-016: Platform Light / Dark / System Theme

- **ID:** RASOIOS-ADR-016
- **Date:** 2026-09-25
- **Owner:** Gopala Krishna (Project Owner)
- **Status:** APPROVED — 2026-09-25, Gopala Krishna (Project Owner). **Supersedes ADR-013 §2's "Surfaces stay
  near-black" for the console only**; the rest of ADR-013 (palette, tokens, glass levels, navigation, tenant website
  themes) is unchanged.

## Context

ADR-013 made the whole platform dark. Restaurants asked for a light console (bright counters, daylight kitchens). The
token system already had a complete, contrast-checked light set (`[data-theme="light"]` in `app/globals.css`) used by
light restaurant websites, so the console needed plumbing, not a second design system.

## Decision

1. **Three preferences:** `LIGHT`, `DARK`, `SYSTEM` (follows the OS, live). **Default `DARK`** (ADR-013 unchanged
   for anyone who does nothing).
2. **One token system.** The console switches `data-theme` (and Tailwind's `dark` class) on the root element; every
   component already consumes semantic tokens, so no component carries its own light colours. Glass levels use the same
   tokens and work in both modes.
3. **Per person, not per restaurant.** `USER.theme_preference` (migration 0003) so the choice follows the person to any
   device; mirrored in the `rasoios-theme` cookie (not httpOnly, SameSite=Lax, 1 year) for the pre-paint script.
4. **No flash of the wrong theme.** A fixed inline script in `<head>` (`lib/ui/theme.ts THEME_BOOT_SCRIPT`, no data
   interpolated) applies the cookie before the body renders; `suppressHydrationWarning` on the root element only.
   A browser without the cookie loads the saved preference once through `getThemePreferenceAction`.
5. **One control.** `ThemeToggle` sits beside the account menu (rendered by `UserMenu`), so the tenant, kitchen and
   platform headers each have exactly one theme control.
6. **Separate from restaurant websites.** A public site sets its own `data-theme` and brand variables on its page
   wrapper (ADR-013 §6); the platform theme never changes a restaurant's website and a website theme never changes the
   console.

## Consequences

- Tests: TC-THEME-001 (WCAG AA for every text/background pair in both token sets, and identical token names),
  TC-THEME-002 (boot script, tamper-safe default), TC-THEME-004 (persistence, own row only, website themes untouched).
- Not audited: a display preference of one's own row, like `last_sign_in_at`.
- When a CSP is added (S1-P24-T001) the boot script needs a nonce or hash. **Done 2026-10-07:** the middleware's
  per-request nonce is on the script (`app/layout.tsx`); `suppressHydrationWarning` on that script because browsers
  hide a nonce from the DOM once it has run.

## Amendment 2026-10-07 — public marketing pages (owner brief "QR customer menu + landing page theme")

- [fact] `/`, `/book-demo`, `/privacy` and `/terms` (`MARKETING_PATHS`, `lib/ui/theme.ts`) default to **`SYSTEM`** for a
  visitor with no saved choice; the boot script applies it before paint. Every other page keeps decision 1's `DARK`.
- [fact] The landing and legal page headers carry `ThemeToggle saveToAccount={false}`: signed-out visitors' choice is
  kept in the `rasoios-theme` cookie only (Secure on https) and no server action is called. Decision 5's "one control"
  still holds per page.
- [fact] Switching adds `.theme-switching` to `<html>` for 300 ms: a 0.25 s colour cross-fade, none under
  `prefers-reduced-motion`.
- Tests: TC-THEME-010 (`tests/unit/table-menu.test.ts`), TC-THEME-011 (`tests/e2e/landing-theme.spec.ts`: system
  light/dark on first visit, toggle persists across reload, WCAG 2.1 AA in both themes). `tests/e2e/landing.spec.ts`
  checks the dark palette, so it runs with a dark system setting.
