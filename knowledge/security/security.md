---
title: "Security Policy (Domain Reference)"
document_type: "REFERENCE"
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
related_documents: ["../implementation/slice-01/security.md","../implementation/slice-01/threat-model.md"]
related_decisions: ["RASOIOS-ADR-003","RASOIOS-ADR-006","RASOIOS-ADR-008","RASOIOS-ADR-011"]
---

# Security Policy
> **Canonical source:** [`../implementation/slice-01/security.md`](../implementation/slice-01/security.md). This domain file keeps only the durable summary for authentication, RBAC and the security control catalogue. Detail lives in the canonical
> file and is not repeated here (knowledge/README.md §Document responsibilities).


## Non-negotiable rules (v1.0 rules retained, extended)
1. Never trust client-supplied tenant identifiers. Tenant context is derived server-side (ADR-003, ADR-006).
2. Enforce authorization on the server at every entry point, before loading resources.
3. Never log or persist secrets, passwords, OTPs, session tokens or agent tokens. Mask personal data in logs.
4. Audit security-sensitive and financial changes to the append-only audit log, in the same transaction. The only deletion is the owner's date-range purge after a verified backup, and never of a `data.*` entry (RASOIOS-ADR-021 §4).
5. Authentication fails closed. Misconfiguration never disables it.
6. Cross-tenant and missing resources are indistinguishable (404).
