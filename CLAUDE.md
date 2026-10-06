# CLAUDE.md - RESTAURANT SaaS PLATFORM (FlowDineOS, formerly RASOIOS)

## Master Guidance & Source of Truth

This repository is governed by the **Knowledge Base** in `knowledge/`. The Knowledge Base is the authoritative source of truth.

### Primary Guidelines
1. **Commercial Model**: Sold strictly as a restaurant software product/license. **NO subscription tiers (Starter/Pro/Enterprise)** and **NO recurring tenant billing**. The platform owner may switch individual features on/off per restaurant (RASOIOS-ADR-023) — switches, never packages or prices. `USER_TENANT` is purely authorization/membership context.
2. **Multi-Tenancy**: Every tenant-owned record MUST be associated with a tenant. Tenant context is resolved **strictly server-side** from authenticated context. Never trust client-provided `tenantId` in URLs, request bodies, headers, or query parameters.
3. **Authorization**: Strict Role-Based Access Control (RBAC) enforced on the server. Roles: `SUPER_ADMIN`, `TENANT_ADMIN`, `MANAGER`, `CASHIER`, `KITCHEN`, `WAITER`. UI visibility is NOT authorization.
4. **Data Integrity**: Monetary values MUST use `Decimal`/`NUMERIC` persistence. NEVER use floating-point numbers for money. `ORDER_ITEM` must snapshot historical names, prices, and tax rates at order creation time.
5. **Print Architecture**: Cloud application queues print jobs -> Local Print Agent polling queue -> Local Thermal Printer (USB/LAN). Print jobs are strictly tenant-isolated.

---

## Technical Stack
- **Framework**: Next.js (App Router, Server Components, Server Actions)
- **Language**: TypeScript (Strict Mode)
- **Authentication**: Clerk (Email OTP)
- **Database**: PostgreSQL
- **ORM**: Prisma ORM
- **Deployment**: Railway
- **Styling**: Tailwind CSS, CSS Custom Variables
- **Brand Tokens** (v2 — RASOIOS-ADR-013, 2026-09-23; hues revised by RASOIOS-ADR-018, 2026-09-25):
  - Primary: `#41E012` · Secondary: `#2015EB` · Tertiary / Danger: `#EF0E23` · Neutral accent: `#0CD9F5`
  - Each hue is a 50–900 tonal scale; raw hues are accents only, never page-wide fills. Surfaces are near-black and
    desaturated. Every colour is a semantic token; WCAG 2.1 AA contrast is enforced by tests.
  - Visual language: vibrant glassmorphism in three levels (navigation, cards/panels, overlays) — never nested,
    never behind long text, always with an opaque fallback.
  - Heading Font: Plus Jakarta Sans · UI / Body Font: Inter (RASOIOS-ADR-020, 2026-10-03; light theme uses Stitch's botanical neutrals)
- **Navigation**: glass header navigation on desktop for both consoles — **no persistent desktop sidebar** — and a
  glass bottom bar below 768 px (ADR-013 §3).
- **Tenant websites**: each tenant is served at `{slug}.<PUBLIC_ROOT_DOMAIN>` (`{slug}.localhost:3000` in dev), with
  `/r/{slug}` kept as a fallback; tenants theme their own public site only (ADR-012, ADR-013 §6).
- **Testing**: Vitest (Unit/Auth/Tenant Isolation), Playwright (E2E)

---

## Development Commands
```bash
npm run dev           # Run development server
npm run build         # Build production application
npm run start         # Start production server
npm run lint          # Run ESLint validation
npm run typecheck     # Run TypeScript type check (tsc --noEmit)
npm run test          # Run unit & integration tests (Vitest)
npm run test:unit     # Run unit tests only
npm run test:e2e      # Run E2E tests (Playwright)
npm run prisma:gen    # Generate Prisma Client
npm run prisma:migrate # Run Prisma migrations
npm run db:local      # Run embedded PostgreSQL 16 locally (no Docker needed)
npm run db:seed       # Seed the local database
npm run agent:build   # Build the local print agent bundle (print-agent/dist)
npm run printer:simulator # ESC/POS printer simulator for development (tools/printer-simulator)
```

---

## Architectural Principles
- **Server-First**: Keep business logic, data access, and authorization server-side.
- **Slice-Based Implementation**: Incremental controlled slices with verification at every slice.
- **No Mocking / Fake Features**: Build real database schemas, real authorization checks, real APIs.
- **Auditing**: Log security-sensitive and transactional changes to append-only `AuditLog`.
