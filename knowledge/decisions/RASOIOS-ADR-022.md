---
title: "RASOIOS-ADR-022: One Main Menu (the Ring), a Separate Today Strip, Brand Colours, Spreadsheet Imports, Sharing and Print-History Archive"
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
dependencies: ["RASOIOS-ADR-013", "RASOIOS-ADR-021"]
related_documents: ["../implementation/slice-01/data-model.md", "../design/design.md"]
related_decisions: ["RASOIOS-ADR-004", "RASOIOS-ADR-007", "RASOIOS-ADR-013", "RASOIOS-ADR-021"]
---

# RASOIOS-ADR-022: One Main Menu (the Ring), a Separate Today Strip, Brand Colours, Spreadsheet Imports, Sharing and Print-History Archive

- **ID:** RASOIOS-ADR-022
- **Date:** 2026-10-06
- **Owner:** Gopala Krishna (Project Owner)
- **Status:** APPROVED — 2026-10-06, from the owner's review of the public website video and screenshots.
- **Relationship:** Refines RASOIOS-ADR-021 §6 (menu ring) and §7 (Brand Kit).

## Decision

1. **The ring is the main menu.** With `restaurants.menu_style = RING` (default) the public menu section renders only the
   3D ring with a pill per menu section; the category card grid is not rendered beside it. `GRID` restores the grid.
   Every dish stays in the ring's screen-reader list. The same rule applies to table QR menus.
2. **No cropping.** The ring's stage measures its width, sizes cards for it and fits R so every card, at every angle,
   scale and tilt, stays inside; R = 0.62 · min(stage width, stage height) wherever that fits. Slots are the real dish
   count (`i / count`); a section of more than 40 dishes is paged.
3. **Today's menu looks different.** `daily_style = STRIP` (default) shows published daily-menu items as a horizontal
   snap-scroll strip with a staggered reveal; `GRID` shows cards.
4. **Brand colours.** Up to 16 named colours (`brand_colors`), `#RGB` stored as `#RRGGBB`, unique names. The editor
   shows contrast against the site background as advice and never changes a chosen colour. The public menu uses them as
   section accents. Readable text colours stay the contrast-checked primary/secondary/accent.
5. **Spreadsheet imports.** Customers and menu items from CSV or `.xlsx` with named columns go through the console's own
   create services (same validation, same audit). Duplicates (phone; dish in its section) are skipped; a menu list
   without a tax-rate column is refused rather than defaulted.
6. **Reports export.** A computed daily summary (orders, sales, tax, cash/card/UPI, refunds) per business date.
7. **Sharing.** Public share dialog: Web Share, WhatsApp, Facebook, copy link; Instagram offers copy-caption and save-picture,
   because a website cannot post to Instagram for a guest. Nothing claims a post was published.
8. **Print history.** Finished jobs (PRINTED/FAILED) can be archived from the history (`archived_at`, `archived_by_user_id`),
   individually or older than N days, by owner/administrator and managers (`printer:manage`), audited as
   `print_job.archived`. A CHECK forbids archiving any other status.
9. **Print status wording.** PRINTED means the agent delivered every byte to the printer and the transport accepted
   them (TCP/USB write completed). The console now says "Delivered to printer", "Sending to printer" and "Queued".
   Physical paper-out confirmation would need printer status queries (DLE EOT) — not implemented.

## Database impact

Migration `0007_menu_display_print_history`: enums `menu_style`, `daily_style`; `restaurants.menu_style`,
`restaurants.daily_style`; `print_jobs.archived_at`, `print_jobs.archived_by_user_id` (FK users) and
`print_jobs_archive_finished_only_check`.
