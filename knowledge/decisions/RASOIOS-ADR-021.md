---
title: "RASOIOS-ADR-021: Restaurant Data Backups, Restore and Date-Range Deletion; Table QR Menus; Brand Kit"
document_type: "ADR"
project: "Restaurant SaaS Platform"
project_owner: "Gopala Krishna"
slice: "SLICE-01"
status: "APPROVED"
version: "1.0"
created: "2026-10-06"
last_updated: "2026-10-06"
owner: "Gopala Krishna (Project Owner)"
planned_start: "2026-10-06"
planned_finish: "Not scheduled — execution-order plan"
dependencies: ["RASOIOS-ADR-003", "RASOIOS-ADR-008", "RASOIOS-ADR-012", "RASOIOS-ADR-013"]
related_documents: ["../implementation/slice-01/data-model.md", "../implementation/slice-01/security.md", "../security/security.md"]
related_decisions: ["RASOIOS-ADR-008", "RASOIOS-ADR-010", "RASOIOS-ADR-012", "RASOIOS-ADR-013", "RASOIOS-ADR-017"]
---

# RASOIOS-ADR-021: Restaurant Data Backups, Restore and Date-Range Deletion; Table QR Menus; Brand Kit

- **ID:** RASOIOS-ADR-021
- **Date:** 2026-10-06
- **Owner:** Gopala Krishna (Project Owner)
- **Status:** APPROVED — 2026-10-06. The deletion rules were chosen by the owner in this session from the options
  "date range, backup first" (orders, bills, payments) and "old entries, backup first" (audit log).
- **Relationship:** **Supersedes in part** `data-model.md` §1.4 (orders and all order children, KOTs, transactions,
  print jobs and audit logs "never hard-deleted") and the unconditional append-only rule for `audit_logs`
  (`security.md` rule 4, migration 0001 trigger). Everything else in those documents stands.

## Context

The client wants to keep restaurant records on their own PC (monthly, six-monthly or whenever they like), to be able to
bring them back, and to clear old history so the hosted database stays small and cheap. The owner also asked for table
QR menus, a 3D menu ring on every public menu, and a richer Brand Kit (owner brief 2026-10-06 §1–13).

## Decision

### 1. Backups are downloads, never uploads

`GET /api/v1/data/export` (`data:export`, owner/administrator only) returns the session's own restaurant as a full ZIP
(`backup.json` + Excel workbook + CSV files + metadata) or as Excel, CSV or JSON for chosen datasets and dates. Nothing
is stored by the platform. Each export writes a `data.exported` audit row carrying a `backupId`; "Last backup" reads it.
Never exported: password hashes, staff session token hashes, print-agent token/pairing hashes, Clerk identifiers, print
payloads. Image files stay on ImageKit; the backup carries their addresses and says so. CSV/Excel cells that would run
as spreadsheet formulas are prefixed with `'`. The console can remind the admin monthly or every six months
(`restaurants.backup_reminder`).

### 2. Restore only adds what is missing

`POST /api/v1/data/import` (`data:import`) accepts our ZIP, `backup.json` or exported CSV files (not Excel — the workbook
is for reading). Preview, then commit, both validating every row against the Prisma schema (types, lengths, enum values,
decimal precision — money is decimal text, never a float), every link against rows already in this restaurant or valid
rows of the same file, and every person reference against this restaurant's members. A backup whose identity block names
another restaurant is refused. `tenant_id` is always the session's. Existing rows are never overwritten; restore is one
transaction; any invalid row blocks the whole import. Audit rows, print jobs, staff, settings and Brand Kit are not
restorable (export only).

### 3. Deletion is by date range, only after a matching backup

`purgeDataAction` (`data:purge`, owner/administrator only) deletes history in chosen categories —
finished orders with their items, KOTs, payments/refunds, receipts and day closes; customers with no orders left;
printed/failed print jobs and printer scans; ended staff sessions and expired daily passwords; social posts; audit
entries. It requires (a) the typed confirmation `DELETE MY RESTAURANT DATA`, (b) a `data.exported` record of **this**
restaurant from the last 24 hours whose datasets cover every category and whose range covers the deletion range. Open
orders are never deleted. The deletion writes `data.deleted` with the range and the real counts.

**Amended 2026-10-07 (owner bug report: "selected range deleted, records still visible").** [fact] The first version took
a single "before" date that defaulted to today − 365 days; deletions with that default matched nothing and the screen
still said "Old data deleted" (production audit: `data.deleted … deleted: {auditEntries: 0}`). Now:

- The range is **From (optional = from the beginning) → To**, both days included, in the restaurant's time zone.
  Business-dated rows use `businessDate` between them; timestamped rows use `createdAt` from the restaurant's local
  midnight of From (inclusive) to the local midnight after To (exclusive) — `utcRangeForBusinessDates`. To may not be in
  the future; From may not be after To. No default range.
- `previewPurgeAction` (`data:purge`) counts what would be deleted and what would be kept, and why (open orders,
  customers who still have orders, waiting print jobs, signed-in staff, `data.*` records). It changes nothing.
- The delete runs in one transaction and then counts the same range again in that transaction; the result carries
  `deleted`, `deletedTotal` and `remaining`, and the audit row records them. The screen reports only those numbers —
  "Nothing matched — no data was deleted" when the total is 0. `lib/services/data-management.ts` `purgeData`.
- The order and kitchen boards request a full list every 60 s (`resyncEveryMs` in `lib/ui/poller.ts`), because a
  `since` delta never carries a deleted row; a deleted card leaves the screen within a minute without a reload.
- Tests: TC-DATA-011 (`tests/integration/data/data-management.test.ts`) — inclusive ends, month crossing, Asia/Kolkata and
  America/New_York midnight/23:59 boundaries, another tenant untouched, injected `tenantId` rejected, zero matches,
  future/reversed ranges, preview refused to a manager.

### 4. The audit log stays append-only, with one scoped exception

The `audit_logs_immutable` trigger (migration 0006) still refuses every UPDATE and TRUNCATE. It allows a DELETE only
when the transaction has set `rasoi.audit_purge_tenant` to the row's tenant and `rasoi.audit_purge_before` after the
row's `created_at`, and never for a `data.*` row — so the record of every export, import and deletion is permanent. Only
the deletion service sets those settings, after the checks in §3.

### 5. Table QR menus

`dining_tables` holds each table's label and a random 10-character `public_code` (unique, rotatable). The QR encodes
`https://{slug}.{root}/t/{code}` (or `/r/{slug}/t/{code}`); no tenant or row id is ever in it. The public page resolves
the restaurant from the host/slug as every public page does, then requires the code to belong to an active, live table
of that restaurant; anything else is the same 404. `table:manage` = owner/administrator and manager. QR images are
generated with `qrcode-generator` (MIT, no dependencies), always black on white.

**Amended 2026-10-07 (owner brief "QR customer menu"): the table page is a section-wise menu, not the ring.**
[fact] `app/r/[slug]/t/[code]/page.tsx` + `lib/ui/table-menu.ts` + `components/public/category-rail.tsx`:

- Header: restaurant name and logo, the table's label; "Restaurant is currently closed." only when opening hours are
  set and it is outside them (no hours = unknown, not closed).
- Sticky section links generated from the data: Today, then each category in the restaurant's `sort_order`.
- Category rail: one card per category with available dishes, any number, scrolling sideways (no page overflow from
  320 to 1920 px). Hover/focus opens a card by widening its frame (15% → 40% of the rail; 26% → 68% on phones,
  container query units, 0.6 s `cubic-bezier(.22,1,.36,1)`); the photo is an `<img>` with `object-fit: cover` at a
  fixed height, so it re-crops and keeps the same scale (measured: identical open and closed) — never stretched or
  enlarged. The caption is laid out at the open width, rises in after 0.14 s over a dark scrim, and wraps to two
  lines. The card's photo is the first dish photo in that category, else the category's icon. No auto-advance;
  touch: first tap opens, second follows; arrow keys move between cards. The rail is only a way in: the dishes are in
  ordinary headed sections below.
- "Today's published menu": the PUBLISHED daily menu whose business date is today in the restaurant's time zone
  (server-side, `loadPublishedDailyMenu`), its dishes grouped under their real categories (a daily menu has no sections
  of its own). None published: "Today's menu hasn't been published yet." Nothing is substituted.
- "Our menu": every category with its available dishes (photo, description, price or variants, add-ons, dietary
  mark). Sold-out dishes stay off the table menu (owner request 2026-10-07). Empty states: "Menu is being prepared."
  (no categories) and "No menu items are currently available."
- Browse only (Q-001): no cart or ordering from the QR — guests order with their server.
- Tests: TC-TBL-006 (`tests/integration/tables/table-qr.test.ts`), TC-QRM-001…003 (`tests/unit/table-menu.test.ts`),
  TC-QRM-010 (`tests/e2e/table-menu.spec.ts`: nine widths, re-crop scale, keyboard, WCAG 2.1 AA).

### 6. 3D menu ring

A reusable client component on every public menu (`components/public/menu-ring.tsx`) using the owner's formulas exactly
(22 positions, R = 0.62·min(w,h), depth sorting every frame, momentum easing to an idle spin, one rAF loop). Real dishes
only: categories of more than 22 are paged; fewer are spread evenly; one or two are shown as plain cards.
`prefers-reduced-motion` removes the spin and the throw. **Since 2026-10-07 the ring is on restaurant websites only**;
the table QR page uses the category rail (§5).

### 7. Brand Kit

`restaurants` gains `brand_colors` (JSONB list of `{name, hex}` in the tenant's order), `heading_font`/`body_font`/
`accent_font` from an allow-list of self-hosted or system families with safe fallbacks, `logo_light_url`,
`logo_dark_url` and `brand_voice`. The public site consumes them through the existing per-tenant theme variables.

## Alternatives considered

- Keep "never delete" and only export — rejected by the owner (storage cost).
- Tick-box deletion of individual paid bills — rejected: breaks report totals and GST history.
- Never delete audit entries — rejected by the owner; the scoped trigger keeps the trail of data operations instead.
- Server-side scheduled backups to our storage — rejected: the client wants copies on their own disk, and storing
  backups would add cost and a new store of personal data.

## Consequences

- Reports for deleted dates no longer include those records; the backup is the record. The UI says so before deleting.
- Indian GST rules generally require bills and payment records to be kept for about six years. The restaurant keeps
  them in its downloaded backups; the confirmation text and this ADR make that the owner's responsibility.
- A restore re-creates rows with their original ids and timestamps; counters are not touched (order numbers already
  embed their business date).

## Security impact

New permissions `data:export`, `data:import`, `data:purge` (TENANT_ADMIN) and `table:manage` (TENANT_ADMIN, MANAGER),
security.md §3.3 rows 51–54. Export refuses cross-site requests (Sec-Fetch-Site); import requires same-origin; both are
rate limited (`data.export`, `data.import`). No input accepts a tenant id.

## Database impact

Migration `0006_brand_kit_tables_data_management`: `backup_reminder` enum and column, Brand Kit columns, `dining_tables`
(+ partial unique live label per tenant, code format check), and the replaced audit trigger function.
