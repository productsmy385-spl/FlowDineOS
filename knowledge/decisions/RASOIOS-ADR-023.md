---
title: "RASOIOS-ADR-023: Platform Renamed FlowDineOS; Per-Restaurant Feature Switches"
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
dependencies: ["RASOIOS-ADR-002", "RASOIOS-ADR-006"]
related_documents: ["../implementation/slice-01/security.md", "../../CLAUDE.md"]
related_decisions: ["RASOIOS-ADR-002", "RASOIOS-ADR-006"]
---

# RASOIOS-ADR-023: Platform Renamed FlowDineOS; Per-Restaurant Feature Switches

- **ID:** RASOIOS-ADR-023 (decision ids keep their RASOIOS prefix; they are identifiers, not branding)
- **Date:** 2026-10-06
- **Owner:** Gopala Krishna (Project Owner)
- **Status:** APPROVED — 2026-10-06. Feature switches chosen by the owner as "feature switches, no tiers".
- **Relationship:** **Supersedes only the "no commercial feature gating" clause of RASOIOS-ADR-002.** No subscription
  tiers, packages, prices or recurring billing are introduced; ADR-002 otherwise stands. Q-001 (no public ordering)
  is reaffirmed by the owner the same day: table QR menus stay browse-only.

## 1. FlowDineOS

The platform is **FlowDineOS** (company: KJS TECH INNOVATIONS; domain flowdine.in). User-visible names, titles, the
PWA manifest, sign-in pages, receipts, backups and the print agent's messages say FlowDineOS (`lib/brand.ts`).
Kept on purpose, because they live outside this repository: the print agent's program name, its Windows install folder
and scheduled task, its Linux service and `RASOIOS_AGENT_HOME`, cookie names, the backup format tag
`rasoios-backup`, the npm package name and decision ids. Restaurants' own names never change.

## 2. Feature switches

`tenant_features (tenant_id, feature_key, enabled, updated_by_user_id)`; no row = on. Thirteen features
(`lib/auth/features.ts`): Orders, Kitchen display, Printers/KOT printing, Billing, Menu management, Daily menu,
Customers, Reports, Table QR menus, Public website, Staff, Social sharing, Data import/export. Always on: dashboard,
restaurant settings, menu reading, kitchen sections, audit log.

Enforcement is in context resolution: a disabled feature's permissions are removed from every session of that
restaurant, so every guard, API route and navigation entry follows. Actions and routes answer 403
`FEATURE_DISABLED`; pages redirect to `/account/feature-disabled`. The public website and table QR pages 404 when
their feature is off. Only the platform owner changes switches (`platform:tenant:update`), at creation or on the
restaurant's page; each change is audited as `tenant.features_updated` with the changed features before and after.

## Database impact

Migration `0008_tenant_features` with `tenant_features_feature_key_check`.
