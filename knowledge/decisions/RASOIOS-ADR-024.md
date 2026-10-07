---
title: "RASOIOS-ADR-024: Book a Demo, One Footer Contact Section, and Unlimited Order/Kitchen Card Rails"
document_type: "ADR"
project: "Restaurant SaaS Platform"
project_owner: "Gopala Krishna"
slice: "SLICE-01"
status: "APPROVED"
version: "1.0"
created: "2026-10-07"
last_updated: "2026-10-07"
owner: "Gopala Krishna (Project Owner)"
planned_start: "2026-10-07"
planned_finish: "Not scheduled — execution-order plan"
dependencies: ["RASOIOS-ADR-022", "RASOIOS-ADR-023"]
related_documents: ["../implementation/slice-01/security.md"]
related_decisions: ["RASOIOS-ADR-009", "RASOIOS-ADR-011", "RASOIOS-ADR-023"]
---

# RASOIOS-ADR-024: Book a Demo, One Footer Contact Section, and Unlimited Order/Kitchen Card Rails

- **Date:** 2026-10-07 · **Owner:** Gopala Krishna · **Status:** APPROVED (owner brief 2026-10-07)

## 1. Book a Demo

`demo_requests` is platform data (no tenant). The public form (landing dialog and `/book-demo`) validates every
field, normalises Indian mobiles to E.164, rejects past dates, keeps a hidden spam-trap field and rate limits per email
(5/h) and per known address (20/h), failing closed. It stores the request and says only that it was received — there is
no calendar, so no slot is ever offered or confirmed. `platform:demo_request:read` / `:update` (SUPER_ADMIN only,
matrix rows 55–56) power Super Admin → Demo requests (status NEW/CONTACTED/SCHEDULED/COMPLETED/CANCELLED and notes,
audited `demo_request.updated`; creation audited `demo_request.created` without contact details).

## 2. Footer

The landing page has exactly one contact presentation, in the footer: KJS TECH INNOVATIONS, the address, mobile
9390038335 (`tel:+919390038335`) and the three emails. Privacy Policy and Terms are not linked until their text exists.

## 3. Card rails

`components/visual/card-rail.tsx` (`CardRail`, `RailCard`) is the shared interaction for the orders rail and the
kitchen's Queued / Preparing / Ready rails: one card per real record with no cap, native horizontal scrolling inside
the rail only, keyboard ←/→ and Enter, a CSS-mask bite on the lower edge, grayscale artwork that blooms into the status
colour on hover/focus/tap, the active card lifting while the rest recede. Order board items carry their first lines and
the first dish image for the card. Kitchen tickets keep the kitchen projection: no customer name or money.

## Database impact

Migration `0009_demo_requests` with phone, time and outlet-count CHECKs.
