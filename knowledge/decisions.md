---
title: "Architecture Decision Records — Index"
document_type: "ADR_INDEX"
project: "Restaurant SaaS Platform"
project_owner: "Gopala Krishna"
slice: "SLICE-01"
status: "PROPOSED"
version: "2.0"
created: "2026-09-15"
last_updated: "2026-09-15"
owner: "Gopala Krishna (Project Owner)"
planned_start: "2026-09-15"
planned_finish: "Not scheduled — execution-order plan"
dependencies: []
related_documents: ["decisions/README.md", "implementation/slice-01/open-questions.md"]
related_decisions: ["RASOIOS-ADR-001", "RASOIOS-ADR-002", "RASOIOS-ADR-003", "RASOIOS-ADR-004", "RASOIOS-ADR-005", "RASOIOS-ADR-006", "RASOIOS-ADR-007", "RASOIOS-ADR-008", "RASOIOS-ADR-009", "RASOIOS-ADR-010", "RASOIOS-ADR-011", "RASOIOS-ADR-012", "RASOIOS-ADR-013"]
---

# Architecture Decision Records — Index

Decisions are never silently replaced. A new decision that changes an older one marks the old one *superseded* or *refined* and links both.
Architecture changes during implementation require a new ADR (brief §56).

| ID | Title | Date | Status | Relationship |
|---|---|---|---|---|
| [RASOIOS-ADR-001](decisions/RASOIOS-ADR-001.md) | Technical stack selection (Next.js, TypeScript, PostgreSQL, Prisma, Clerk, Tailwind, Vitest, Railway) | 2026-09-15 | APPROVED | — |
| [RASOIOS-ADR-002](decisions/RASOIOS-ADR-002.md) | Commercial licence model — no subscription tiers or recurring tenant billing | 2026-09-15 | APPROVED | Locked by owner brief |
| [RASOIOS-ADR-003](decisions/RASOIOS-ADR-003.md) | Server-side context-derived tenant isolation | 2026-09-15 | APPROVED | Implemented by ADR-006, ADR-008 |
| [RASOIOS-ADR-004](decisions/RASOIOS-ADR-004.md) | Cloud thermal printing: PostgreSQL queue + polling local agent | 2026-09-15 | APPROVED | Refined by ADR-007 |
| [RASOIOS-ADR-005](decisions/RASOIOS-ADR-005.md) | Single master implementation slice (SLICE-01) | 2026-09-15 | ACCEPTED | Supersedes eight-slice structure (v1.0 KNOWLEDGE-BASE.md §5) |
| [RASOIOS-ADR-006](decisions/RASOIOS-ADR-006.md) | Identity, platform role, invite-only membership and active tenant resolution | 2026-09-15 | APPROVED | Implements ADR-003 |
| [RASOIOS-ADR-007](decisions/RASOIOS-ADR-007.md) | Print agent authentication, job leasing and delivery semantics | 2026-09-15 | APPROVED | Refines ADR-004 |
| [RASOIOS-ADR-008](decisions/RASOIOS-ADR-008.md) | Tenant-scoped data access layer and database-enforced tenant integrity | 2026-09-15 | APPROVED | Implements ADR-003 |
| [RASOIOS-ADR-009](decisions/RASOIOS-ADR-009.md) | Operational screen refresh via cursor-based polling | 2026-09-15 | APPROVED | — |
| [RASOIOS-ADR-010](decisions/RASOIOS-ADR-010.md) | Money, tax calculation, menu modifiers, business day and sequential numbering | 2026-09-15 | APPROVED | — |
| [RASOIOS-ADR-011](decisions/RASOIOS-ADR-011.md) | Rate limiting, request integrity and webhook verification without new infrastructure | 2026-09-15 | APPROVED | — |
| [RASOIOS-ADR-012](decisions/RASOIOS-ADR-012.md) | Tenant subdomain routing for public restaurant websites (`slug.<domain>`, `/r/[slug]` kept) | 2026-09-23 | APPROVED | Answers Q-013; refines ADR-003 |
| [RASOIOS-ADR-013](decisions/RASOIOS-ADR-013.md) | Brand v2 — vibrant glass design language, header navigation, per-tenant theming | 2026-09-23 | APPROVED | Supersedes the palette and console shell of design.md §2.1–2.3/§6 and CLAUDE.md v1 |
| [RASOIOS-ADR-014](decisions/RASOIOS-ADR-014.md) | Render as the deployment target (`render.yaml` Blueprint) | 2026-09-23 | PROPOSED | Would supersede the Railway clause of ADR-001 |
| [RASOIOS-ADR-017](decisions/RASOIOS-ADR-017.md) | ImageKit for image upload, storage and delivery (proxied uploads, `media_assets`) | 2026-09-25 | APPROVED | Supersedes Q-009 A and ADR-013 §6 "no uploads" |
| [RASOIOS-ADR-021](decisions/RASOIOS-ADR-021.md) | Data backups, restore and date-range deletion; table QR menus; 3D menu ring; Brand Kit | 2026-10-06 | APPROVED | Supersedes in part data-model.md §1.4 and the unconditional audit append-only rule |
| [RASOIOS-ADR-022](decisions/RASOIOS-ADR-022.md) | One main menu (ring), today strip, brand colours, spreadsheet imports, sharing, print-history archive | 2026-10-06 | APPROVED | Refines ADR-021 §6–7 |

ADR-006…011 were approved by the Project Owner on 2026-09-15 in decision gate S1-P01-T010. The same gate answered Q-004, which added GST receipt presentation to ADR-010 §3.
