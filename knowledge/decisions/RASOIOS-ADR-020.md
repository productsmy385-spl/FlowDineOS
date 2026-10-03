---
title: "RASOIOS-ADR-020: Stitch Redesign — Typography, Botanical Light Theme, Motion and the Command-Center Dashboard"
document_type: "ADR"
project: "Restaurant SaaS Platform"
project_owner: "Gopala Krishna"
slice: "SLICE-01"
status: "APPROVED"
version: "1.0"
created: "2026-10-03"
last_updated: "2026-10-03"
owner: "Gopala Krishna (Project Owner)"
planned_start: "2026-10-03"
planned_finish: "Not scheduled — execution-order plan"
dependencies: ["RASOIOS-ADR-013", "RASOIOS-ADR-018"]
related_documents: ["../design/design.md", "../implementation/slice-01/frontend.md", "../../CLAUDE.md"]
related_decisions: ["RASOIOS-ADR-013", "RASOIOS-ADR-016", "RASOIOS-ADR-018"]
---

# RASOIOS-ADR-020: Stitch Redesign — Typography, Botanical Light Theme, Motion and the Command-Center Dashboard

- **ID:** RASOIOS-ADR-020
- **Date:** 2026-10-03
- **Owner:** Gopala Krishna (Project Owner)
- **Status:** APPROVED — 2026-10-03, from the owner's Stitch export (`stitch_rasoios_restaurant_platform_redesign.zip`)
  and its implementation brief.
- **Relationship:** Supersedes **RASOIOS-ADR-013 §1's typography** (Playfair Display + Plus Jakarta Sans) and **the
  light theme's neutral surfaces**. ADR-013's glass levels, header navigation with no desktop sidebar, per-tenant
  theming and dark theme stand. ADR-018's brand hues stand unchanged.

## Context

The owner supplied a Stitch export: eight screens (command-center dashboard, live orders, kitchen/KOT display,
POS/billing — desktop and mobile each) and a `DESIGN.md` describing the "Culinary Operations System". The brief asks
for that design language across the existing platform, rebuilt through the real components rather than pasted HTML,
on real data only, screen by screen, with the existing restaurant background artwork kept.

ADR-018 had left fonts and light surfaces as an open question for the owner. This answers it.

## Decision

### 1. Typography

Plus Jakarta Sans for headings and system anchors (`--font-display`), Inter for body text, tables, order lines and
figures (`--font-sans`). Both are vendored latin variable files in `app/fonts/`, so a build never fetches from Google.
The Playfair Display file is removed.

### 2. Light theme surfaces

Stitch's botanical neutrals become a `botanical` token scale and the light theme points at it: canvas `#F4FCEE`, white
cards, `#EEF6E9` raised surfaces, ink `#161D16`, olive secondary text `#3E4A39`. Brand hues, the dark theme and the
restaurant background artwork are unchanged. Every light text pair still meets AA; the lowest is 5.1:1.

### 3. Motion

Motion communicates state, change, hierarchy or feedback — never decoration.

- **Animated figures** (`AnimatedNumber`) count up on first load and on a real change of value, not on a re-render,
  and come to rest on the server's exact formatted value. Money is interpolated as whole currency units parsed from the
  integer part of the decimal string — never `parseFloat` (ADR-010); the paise appear only in the final frame.
- **Progress ring** and **load bars** fill once with CSS keyframes (`ring-fill`, `bar-fill`); panels and new tickets
  enter with `rise-in` (opacity + 8 px, 280 ms).
- **Hover**: metric cards lift 4 px, firm their border, widen their shadow and nudge the icon — about 180 ms,
  transform and shadow only.
- **Live pulse** only on something genuinely live: a kitchen with tickets, an agent calling in.
- Everything is stilled by the existing `prefers-reduced-motion` rule.

### 4. Dashboard as a command center

A context strip (business date, timezone, live pills for kitchen, print agent and staff on shift), four headline figures
(gross sales, orders fulfilled with a ring, average ticket, live kitchen queue with a late badge) and a bento: kitchen
stations and latest orders on the left; quick operations, printers and agents, and who is on shift on the right.

Every figure is an existing tenant-scoped query, and each panel appears only for a role that may read it. Stitch panels
the platform holds no data for — delivery-aggregator channels, table occupancy, a chef per station, outlet numbers — are
**left out rather than invented**.

A ticket counts as **late** after `LATE_AFTER_MINUTES = 15` minutes queued or preparing. **This is a product default
that has not been confirmed by the owner**; it lives in one constant so a per-restaurant setting can replace it.

## Not yet done

The brief's screen order continues, as separate commits: orders board, kitchen/KOT display, POS/billing, menu, staff,
printers, reports, website settings and brand kit, public website refinements, super admin, then mobile and dark-theme
refinement. Shared page transitions, toasts and skeletons arrive with the screens that need them.

## Verification

`tests/unit/kitchen-load.test.ts` (TC-DASH-010/011), the existing dashboard RBAC tests (TC-RBAC-108 and the reports
dashboard suite: `dashboard-sales-today` now wraps the money only), TC-THEME-001 and TC-DS-009 for contrast, and a
browser check of the dashboard at 1440, 390 and 320 px: no horizontal overflow, light theme and both fonts applied.
