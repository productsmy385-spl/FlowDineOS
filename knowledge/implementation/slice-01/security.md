---
title: "SLICE-01 Security Plan — Authentication, RBAC and Security Controls"
document_type: "SECURITY_PLAN"
project: "Restaurant SaaS Platform"
project_owner: "Gopala Krishna"
slice: "SLICE-01"
status: "PROPOSED"
version: "2.0"
created: "2026-09-15"
last_updated: "2026-09-15"
owner: "Security Engineer (UNASSIGNED) — approval: Gopala Krishna"
planned_start: "2026-09-15"
planned_finish: "Not scheduled — execution-order plan"
dependencies: ["RASOIOS-ADR-003", "RASOIOS-ADR-006", "RASOIOS-ADR-007", "RASOIOS-ADR-008", "RASOIOS-ADR-011"]
related_documents: ["tenant-isolation.md", "threat-model.md", "tenant-isolation-tests.md", "api.md", "frontend.md", "../../security/security.md"]
related_decisions: ["RASOIOS-ADR-002", "RASOIOS-ADR-003", "RASOIOS-ADR-006", "RASOIOS-ADR-007", "RASOIOS-ADR-008", "RASOIOS-ADR-009", "RASOIOS-ADR-010", "RASOIOS-ADR-011"]
---

# SLICE-01 Security Plan

**Scope:** the controls the product must implement, and how each one is verified. How tenant boundaries work
end to end is in `tenant-isolation.md`. Threat analysis is in `threat-model.md`.

Authentication (who you are) and authorization (what you may do) are separate steps and are never merged:
a valid Clerk session proves identity only.

---

## 1. Request pipeline (every protected request)

```
1. Middleware        → Clerk session present? (non-public routes)            → else 401 / redirect /sign-in
2. Session resolver  → Clerk user → local USER (ACTIVE)                        → else /account/no-access (403)
3. Context resolver  → platform context (SUPER_ADMIN) OR tenant context:
                        ACTIVE membership + ACTIVE tenant (+ active cookie)    → else /account/select-tenant | /account/suspended
4. Input validation  → Zod .strict() on params/query/body (tenant fields rejected) → else 422
5. Permission check  → requirePermission(ctx, code)  [before loading any resource] → else 403
6. Scoped data access→ lib/data/* with ctx.tenantId in WHERE                   → miss or other tenant → 404
7. Business rules    → state machines, money rules                              → else 409 / 422
8. Transaction       → change + AUDIT_LOG row in one DB transaction
9. Response          → explicit projection; safe error mapping; request id
```

Middleware (step 1) is a coarse gate only. Steps 2–6 run inside every Server Component loader, Server Action and
Route Handler (SC-AUTH-04). Print agent requests replace steps 1–3 with bearer-token agent authentication (§5, SC-PRINT-01).

---

## 2. Authentication — Clerk Email OTP

### 2.1 Configuration

| Item | Setting | Control |
|---|---|---|
| Sign-in strategy | Email address + **email one-time code** only; passwords, magic links, social providers, phone **disabled** in the Clerk instance | SC-AUTH-01 |
| Sign-up mode | Restricted — invitations only (ADR-006) | SC-AUTH-05 |
| Instances | Separate Clerk **development** and **production** instances; production keys only in Railway production variables | SC-SEC-02 |
| Environment variables | `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `CLERK_WEBHOOK_SIGNING_SECRET`, `NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in`, `NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up` | validated by `lib/env.ts` (SC-SEC-01) |
| Fail closed | App startup fails if any Clerk variable is missing or contains `placeholder`/`example` — in **every** environment | SC-AUTH-02 |
| Session lifetime | Clerk session settings for shared restaurant devices — 12 h maximum lifetime, 2 h inactivity (**Q-029** answered 2026-09-15) | SC-SESS-04 |

### 2.2 Flows

| Flow | Behaviour | Tasks |
|---|---|---|
| **Login** | `/sign-in` renders Clerk `<SignIn>` styled with design tokens; user enters email; Clerk emails a code | S1-P03-T001, S1-P03-T005 |
| **OTP** | User enters code; Clerk verifies (attempt limits and code expiry are Clerk-managed); on success Clerk sets session cookie | S1-P03-T001 |
| **Session** | Every request: middleware checks session; server resolver calls `auth()`/`currentUser()`; `USER` loaded by `clerk_user_id` | S1-P03-T002 |
| **Local user mapping** | If `USER` with `clerk_user_id` exists → use it. Else if an `INVITED` USER_TENANT exists for a USER whose `email` equals the Clerk **verified primary email** (lowercased) → set `clerk_user_id`, set memberships `ACTIVE`, `accepted_at`, audit `user.linked`/`staff.activated`. Else → no local row, `/account/no-access` | S1-P03-T003 |
| **Invitation acceptance** | Invite email (Clerk invitation) → `/sign-up` with ticket → OTP → same mapping path | S1-P03-T004, S1-P07-T006 |
| **Logout** | Clerk `<UserButton>` / `signOut()`; redirect `/sign-in`; active tenant cookie cleared by `SA-AUTH-01` companion `clearActiveTenantCookie` on sign-out route | S1-P03-T005 |
| **Protected routes** | Everything except the public allowlist (`/`, `/r/(.*)`, `/sign-in(.*)`, `/sign-up(.*)`, `/offline`, `/api/health`, `/api/ready`, `/api/webhooks/clerk`, `/api/v1/print-agent/(.*)`, static assets) | S1-P03-T002 |
| **Unauthenticated** | Pages → redirect `/sign-in?redirect_url=…` (same-origin paths only); `/api/v1/*` (session) → `401 {"error":{"code":"UNAUTHENTICATED"}}` | S1-P03-T002 |
| **Authenticated, no local user / no membership** | `/account/no-access` (explains "Ask your restaurant administrator for an invitation"); no data rendered | S1-P03-T006 |
| **Suspended or inactive user** | `USER.status ≠ ACTIVE` → `/account/no-access` with reason `ACCOUNT_INACTIVE`; Clerk sessions revoked via Backend API when status changes (SC-AUTH-08) | S1-P03-T006 |
| **Suspended tenant** | Membership exists but `TENANT.status = SUSPENDED` → `/account/suspended` ("This restaurant account is suspended. Contact the platform administrator."); API → `403 TENANT_SUSPENDED`; if user has another active tenant, offer switch | S1-P04-T004 |
| **Multiple tenants** | `/account/select-tenant` lists ACTIVE memberships (tenant name + role); choosing calls `SA-AUTH-01` | S1-P04-T003 |
| **Error handling** | Clerk/DB failure during resolution → error boundary "We couldn't verify your session. Try again." + HTTP 503 for APIs; logged with `request_id`; never treated as signed-out (SC-AUTH-09) | S1-P03-T002 |

### 2.3 Authentication tests

`TC-AUTH-001` successful OTP sign-in (E2E, Clerk test mode) · `TC-AUTH-002` invalid OTP rejected (E2E) ·
`TC-AUTH-003` unauthenticated page → redirect · `TC-AUTH-004` unauthenticated `/api/v1/*` → 401 ·
`TC-AUTH-005` invited email links on first sign-in · `TC-AUTH-006` uninvited Clerk user gets no local row ·
`TC-AUTH-007` inactive user denied · `TC-AUTH-008` suspended tenant denied · `TC-AUTH-009` missing Clerk key fails startup ·
`TC-AUTH-010` DB failure during resolution → 503 not 401 · `TC-AUTH-011` logs contain no OTP/token (log capture) ·
`TC-AUTH-012` open-redirect attempt on `redirect_url` rejected. Defined in tasks S1-P03-T001…T007.

---

## 3. Authorization — RBAC

### 3.1 Roles

| Role | Level | Stored in | Scope | Rank (for role assignment) |
|---|---|---|---|---|
| `SUPER_ADMIN` | Platform | `USER.platform_role` | All tenants' **metadata and lifecycle** only | n/a |
| `TENANT_ADMIN` | Tenant | `USER_TENANT.role` | One tenant, full administration | 50 |
| `MANAGER` | Tenant | `USER_TENANT.role` | One tenant, operations + menu + money | 40 |
| `CASHIER` | Tenant | `USER_TENANT.role` | Order entry, payments | 30 |
| `WAITER` | Tenant | `USER_TENANT.role` | Order entry, serving | 20 |
| `KITCHEN` | Tenant | `USER_TENANT.role` | Kitchen board | 20 |

SUPER_ADMIN holds **no tenant permissions**. It cannot read a tenant's orders, customers, transactions or menu
through tenant routes. It has no tenant context. Access to tenant operational data for support is pending **Q-019**.

### 3.2 Permission catalogue (deny by default)

Codes are constants in `lib/auth/permissions.ts`. The same constants drive server checks and the UI capability map
(SC-RBAC-02, SC-RBAC-08).

| Baseline permission (`lib/auth/permissions.ts:9-21`) | Replaced by |
|---|---|
| `tenant:create`, `tenant:manage_all` | `platform:tenant:*` |
| `tenant:manage_own` | `restaurant:update`, `restaurant:settings:update`, `website:update`, `print_agent:manage`, `social:manage` |
| `staff:manage` | `staff:read`, `staff:invite`, `staff:update_role`, `staff:deactivate` |
| `menu:manage` | `menu:manage`, `menu:availability:update`, `daily_menu:manage`, `kitchen_section:manage` |
| `order:create` | `order:create`, `order:add_items` |
| `order:update_status` | `order:accept`, `order:kitchen_update`, `order:complete`, `order:cancel` |
| `payment:process` | `payment:record`, `transaction:read` |
| `refund:process` | `refund:create`, `transaction:void`, `day_close:perform` |
| `kitchen:view_queue` | `kot:read`, `kot:update_status`, `kot:serve`, `kot:reprint` |
| `reports:view` | `report:read`, `dashboard:read` |
| `audit:view` | `audit:read`, `platform:audit:read` |

### 3.3 Role → Resource → Action → Permission matrix

Legend: ✅ allowed · ◐ allowed with the business-rule restriction in the Notes column · — denied.
**Tenant scope:** `own` = active tenant from server context. `platform` = all tenants, metadata only.
**Test:** each row is a matrix test. For every role it calls the listed API and asserts allow/deny
(`tests/integration/rbac-matrix.test.ts`).

| # | Permission | Resource | Action | SA | TA | MGR | CASH | KIT | WAIT | Tenant scope | UI access | API access | Test |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `platform:tenant:read` | TENANT | list, inspect | ✅ | — | — | — | — | — | platform | `/admin`, `/admin/tenants`, `/admin/tenants/[tenantId]` | LD-ADM-01, LD-ADM-02, LD-ADM-03 | TC-RBAC-101 |
| 2 | `platform:tenant:create` | TENANT | create | ✅ | — | — | — | — | — | platform | `/admin/tenants/new` | SA-ADM-01 | TC-RBAC-102 |
| 3 | `platform:tenant:update` | TENANT | update name/slug | ✅ | — | — | — | — | — | platform | `/admin/tenants/[tenantId]` | SA-ADM-02 | TC-RBAC-103 |
| 4 | `platform:tenant:suspend` | TENANT | suspend | ✅ | — | — | — | — | — | platform | `/admin/tenants/[tenantId]` | SA-ADM-03 | TC-RBAC-104 |
| 5 | `platform:tenant:reactivate` | TENANT | reactivate | ✅ | — | — | — | — | — | platform | `/admin/tenants/[tenantId]` | SA-ADM-04 | TC-RBAC-105 |
| 6 | `platform:tenant_admin:invite` | USER_TENANT | invite/revoke first TENANT_ADMIN | ✅ | — | — | — | — | — | platform | `/admin/tenants/[tenantId]` | SA-ADM-05, SA-ADM-06 | TC-RBAC-106 |
| 7 | `platform:audit:read` | AUDIT_LOG | read platform events | ✅ | — | — | — | — | — | platform | `/admin/audit` | LD-ADM-04 | TC-RBAC-107 |
| 8 | `dashboard:read` | ORDER, TRANSACTION (aggregates) | view dashboard | — | ✅ | ✅ | — | — | — | own | `/restaurant/dashboard` | LD-DASH-01, RH-DASH-01 | TC-RBAC-108 |
| 9 | `restaurant:read` | RESTAURANT | read profile, hours, timezone | — | ✅ | ✅ | ✅ | ✅ | ✅ | own | header context, clock | LD-AUTH-01, LD-RST-01 (read-only projection for non-admins) | TC-RBAC-109 |
| 10 | `restaurant:update` | RESTAURANT, RESTAURANT_HOURS | update profile, branding, hours | — | ✅ | — | — | — | — | own | `/restaurant/settings`, `/restaurant/website` | SA-RST-01, SA-RST-02, SA-RST-03 | TC-RBAC-110 |
| 11 | `restaurant:settings:update` | RESTAURANT | timezone, currency, operational | — | ✅ | — | — | — | — | own | `/restaurant/settings` | SA-RST-04 | TC-RBAC-111 |
| 12 | `website:update` | RESTAURANT | website visibility, SEO, publish | — | ✅ | — | — | — | — | own | `/restaurant/website` | SA-RST-05, SA-RST-06, RH-MEDIA-01, SA-MEDIA-01 | TC-RBAC-112 |
| 13 | `kitchen_section:manage` | KITCHEN_SECTION | create/update/archive/reorder | — | ✅ | — | — | — | — | own | `/restaurant/settings` (Kitchen sections tab) | SA-KSEC-01, SA-KSEC-02, SA-KSEC-03, SA-KSEC-04 | TC-RBAC-113 |
| 14 | `staff:read` | USER_TENANT | list staff | — | ✅ | ✅ | — | — | — | own | `/restaurant/staff` | LD-STF-01 | TC-RBAC-114 |
| 15 | `staff:invite` | USER_TENANT | invite, resend, revoke | — | ✅ | ◐ | — | — | — | own | `/restaurant/staff` | SA-STF-01, SA-STF-02, SA-STF-03 | TC-RBAC-115 |
| 16 | `staff:update_role` | USER_TENANT | change role | — | ✅ | ◐ | — | — | — | own | `/restaurant/staff` | SA-STF-04 | TC-RBAC-116 |
| 17 | `staff:deactivate` | USER_TENANT | deactivate/reactivate | — | ✅ | ◐ | — | — | — | own | `/restaurant/staff` | SA-STF-05, SA-STF-06 | TC-RBAC-117 |
| 18 | `menu:read` | MENU_* | read internal menu (incl. unpublished) | — | ✅ | ✅ | ✅ | ✅ | ✅ | own | `/restaurant/menu/*` (read-only for CASH/KIT/WAIT), order entry | LD-MENU-01, LD-MENU-02, LD-MENU-03, LD-ORD-03 | TC-RBAC-118 |
| 19 | `menu:manage` | MENU_CATEGORY, MENU_ITEM, VARIANT, ADDON | create/update/archive/reorder/publish | — | ✅ | ✅ | — | — | — | own | `/restaurant/menu/*` | SA-MENU-01…SA-MENU-10, SA-MENU-12, SA-MENU-13 | TC-RBAC-119 |
| 20 | `menu:availability:update` | MENU_ITEM | toggle available (sold out) | — | ✅ | ✅ | — | — | — | own | `/restaurant/menu/items` toggle | SA-MENU-11 | TC-RBAC-120 |
| 21 | `daily_menu:read` | DAILY_MENU | read | — | ✅ | ✅ | ✅ | ✅ | ✅ | own | `/restaurant/daily-menu` (read-only for CASH/KIT/WAIT) | LD-DMENU-01, LD-DMENU-02 | TC-RBAC-121 |
| 22 | `daily_menu:manage` | DAILY_MENU, DAILY_MENU_ITEM | save/publish/unpublish/copy/delete draft | — | ✅ | ✅ | — | — | — | own | `/restaurant/daily-menu` | SA-DMENU-01…SA-DMENU-05 | TC-RBAC-122 |
| 23 | `order:read` | ORDER | list/detail (KITCHEN: kitchen projection without customer PII) | — | ✅ | ✅ | ✅ | ◐ | ✅ | own | `/restaurant/orders`, `/restaurant/orders/[orderId]` | LD-ORD-01, LD-ORD-02, RH-ORD-01 | TC-RBAC-123 |
| 24 | `order:create` | ORDER, ORDER_ITEM | create | — | ✅ | ✅ | ✅ | — | ✅ | own | `/restaurant/orders/new` | SA-ORD-01 | TC-RBAC-124 |
| 25 | `order:add_items` | ORDER_ITEM | add round (Q-003) | — | ✅ | ✅ | ✅ | — | ✅ | own | order detail "Add items" | SA-ORD-04 | TC-RBAC-125 |
| 26 | `order:accept` | ORDER | NEW→ACCEPTED | — | ✅ | ✅ | ✅ | — | ✅ | own | order board / detail | SA-ORD-02 | TC-RBAC-126 |
| 27 | `order:kitchen_update` | ORDER | ACCEPTED→PREPARING, PREPARING→READY | — | ✅ | ✅ | — | ✅ | — | own | kitchen board, order detail | SA-ORD-02 (also implied by SA-KOT-01) | TC-RBAC-127 |
| 28 | `order:complete` | ORDER | READY→COMPLETED | — | ✅ | ✅ | ✅ | — | ✅ | own | order board / detail | SA-ORD-02 | TC-RBAC-128 |
| 29 | `order:cancel` | ORDER | →CANCELLED | — | ✅ | ✅ | ◐ | — | ◐ | own | order detail (reason dialog) | SA-ORD-03 | TC-RBAC-129 |
| 30 | `order:update_meta` | ORDER | set customer, priority | — | ✅ | ✅ | ✅ | — | ◐ | own | order detail | SA-ORD-05, SA-ORD-06 | TC-RBAC-130 |
| 31 | `kot:read` | KOT_TICKET | kitchen board | — | ✅ | ✅ | ✅ | ✅ | ✅ | own | `/restaurant/kitchen` | LD-KOT-01, RH-KOT-01 | TC-RBAC-131 |
| 32 | `kot:update_status` | KOT_TICKET | QUEUED→PREPARING→READY | — | ✅ | ✅ | — | ✅ | — | own | kitchen board buttons | SA-KOT-01 | TC-RBAC-132 |
| 33 | `kot:serve` | KOT_TICKET | READY→SERVED | — | ✅ | ✅ | ✅ | ✅ | ✅ | own | kitchen board / order detail | SA-KOT-01 | TC-RBAC-133 |
| 34 | `kot:reprint` | PRINT_JOB | reprint KOT | — | ✅ | ✅ | ✅ | ✅ | — | own | kitchen card / order detail | SA-KOT-02 | TC-RBAC-134 |
| 35 | `customer:read` | CUSTOMER | list/detail/lookup | — | ✅ | ✅ | ✅ | — | ✅ | own | `/restaurant/customers`, order entry lookup | LD-CUS-01, LD-CUS-02, RH-CUS-01 | TC-RBAC-135 |
| 36 | `customer:create` | CUSTOMER | create | — | ✅ | ✅ | ✅ | — | ✅ | own | order entry, customers page | SA-CUS-01 | TC-RBAC-136 |
| 37 | `customer:update` | CUSTOMER | update | — | ✅ | ✅ | ✅ | — | — | own | `/restaurant/customers/[customerId]` | SA-CUS-02 | TC-RBAC-137 |
| 38 | `customer:archive` | CUSTOMER | archive / anonymise | — | ✅ | ◐ | — | — | — | own | customer detail | SA-CUS-03, SA-CUS-04 | TC-RBAC-138 |
| 39 | `transaction:read` | TRANSACTION | list, receipt | — | ✅ | ✅ | ✅ | — | — | own | `/restaurant/transactions`, `/restaurant/orders/[orderId]/receipt` | LD-TXN-01, LD-RCPT-01 | TC-RBAC-139 |
| 40 | `payment:record` | TRANSACTION | record payment | — | ✅ | ✅ | ✅ | — | — | own | order detail payment panel | SA-TXN-01 | TC-RBAC-140 |
| 41 | `refund:create` | TRANSACTION | refund | — | ✅ | ✅ | — | — | — | own | order detail | SA-TXN-02 | TC-RBAC-141 |
| 42 | `transaction:void` | TRANSACTION | void same-day entry | — | ✅ | ✅ | — | — | — | own | transactions list | SA-TXN-03 | TC-RBAC-142 |
| 43 | `day_close:perform` | BUSINESS_DAY_CLOSE | preview + close | — | ✅ | ✅ | — | — | — | own | `/restaurant/transactions/day-close` | LD-TXN-02, SA-TXN-04 | TC-RBAC-143 |
| 44 | `printer:manage` | PRINTER | create/update/deactivate/test | — | ✅ | ✅ | — | — | — | own | `/restaurant/printing` | SA-PRN-01, SA-PRN-02, SA-PRN-03, SA-PRN-04 | TC-RBAC-144 |
| 45 | `print_agent:manage` | PRINT_AGENT | pair/revoke | — | ✅ | — | — | — | — | own | `/restaurant/printing` (Agents tab) | SA-AGT-01, SA-AGT-02 | TC-RBAC-145 |
| 46 | `print_job:read` | PRINT_JOB | view queue | — | ✅ | ✅ | ✅ | ✅ | — | own | `/restaurant/printing`, kitchen card print badge | LD-PRN-01, RH-PRN-01 | TC-RBAC-146 |
| 47 | `print_job:retry` | PRINT_JOB | retry failed, print receipt | — | ✅ | ✅ | ✅ | ✅ | — | own | printing console, order detail | SA-PRN-05, SA-PRN-06 | TC-RBAC-147 |
| 48 | `report:read` | ORDER, ORDER_ITEM, TRANSACTION (aggregates) | reports | — | ✅ | ✅ | — | — | — | own | `/restaurant/reports` | LD-RPT-01…LD-RPT-05 | TC-RBAC-148 |
| 49 | `social:manage` | SOCIAL_POST | create/update/ready/mark posted/archive | — | ✅ | ✅ | — | — | — | own | `/restaurant/social` | LD-SOC-01, SA-SOC-01…SA-SOC-05 | TC-RBAC-149 |
| 50 | `audit:read` | AUDIT_LOG | read tenant audit | — | ✅ | — | — | — | — | own | `/restaurant/audit` | LD-AUD-01 | TC-RBAC-150 |
| 51 | `data:export` | TENANT DATA | download a backup (CSV / Excel / JSON / ZIP) | — | ✅ | — | — | — | — | own | `/restaurant/settings/data` | RH-DATA-01 (ADR-021) | TC-RBAC-151 |
| 52 | `data:import` | TENANT DATA | restore missing records from a backup, menu/customer CSV | — | ✅ | — | — | — | — | own | `/restaurant/settings/data` | RH-DATA-02 (ADR-021) | TC-RBAC-152 |
| 53 | `data:purge` | TENANT DATA | preview and delete a date range (both days included), after a matching backup | — | ✅ | — | — | — | — | own | `/restaurant/settings/data` | SA-DATA-03 (ADR-021) | TC-RBAC-153 |
| 54 | `table:manage` | DINING_TABLE | add/rename/archive tables, rotate QR codes | — | ✅ | ✅ | — | — | — | own | `/restaurant/tables` | SA-TBL-01 (ADR-021) | TC-RBAC-154 |
| 55 | `platform:demo_request:read` | DEMO_REQUEST | read visitors' demo requests | ✅ | — | — | — | — | — | platform | `/admin/demo-requests` | LD-ADM-10 (ADR-024) | TC-RBAC-155 |
| 56 | `platform:demo_request:update` | DEMO_REQUEST | change a request's status and notes | ✅ | — | — | — | — | — | platform | `/admin/demo-requests` | SA-ADM-11 (ADR-024) | TC-RBAC-156 |

**Public (no role):** read published website data (LD-PUB-01, LD-PUB-02, LD-PUB-03, RH-PUB-01, RH-PUB-02). Submit an order only if
Q-001 approves (SA-PUB-01). **Print agent (credential, not a role):** `agent:job:claim`, `agent:job:ack`, `agent:heartbeat`,
`agent:config:read` (RH-AGT-02…RH-AGT-05), within its own tenant only.

**◐ restrictions (business rules enforced in the service layer):**

| Row | Restriction |
|---|---|
| 15–17 | MANAGER may invite, change or deactivate only CASHIER, WAITER, KITCHEN, and may assign only those roles. Nobody changes their own role or deactivates themselves. The last ACTIVE TENANT_ADMIN cannot be demoted or deactivated (SC-RBAC-04, SC-RBAC-05). |
| 23 | KITCHEN receives the kitchen projection: no customer name/phone/email, no amounts, no payments. |
| 29 | CASHIER and WAITER may cancel only orders in `NEW`. TENANT_ADMIN and MANAGER may cancel `NEW`, `ACCEPTED`, `PREPARING` or `READY` (BR-ORD-05, Q-008 B answered 2026-09-22). A reason is always required. |
| 30 | WAITER may link a customer but not set priority HIGH. |
| 38 | MANAGER may archive. Only TENANT_ADMIN may anonymise (irreversible). |

### 3.4 Order and KOT transition authorization

| From → To | Permission | Additional guard | Side effects |
|---|---|---|---|
| (create) → NEW | `order:create` | items valid (BR-ORD-01) | counter, snapshots, audit `order.created` |
| NEW → ACCEPTED | `order:accept` | ≥1 item | KOT generation per section/round; print jobs if `auto_print_kot` |
| ACCEPTED → PREPARING | `order:kitchen_update` | — (also automatic when first KOT → PREPARING) | timestamps |
| PREPARING → READY | `order:kitchen_update` | all KOTs of latest round READY or SERVED (also automatic) | timestamps |
| READY → COMPLETED | `order:complete` | `payment_status = PAID` (BR-ORD-06, Q-007) | timestamps |
| NEW → CANCELLED | `order:cancel` | reason; `paid_amount − refunded_amount = 0` | KOTs → CANCELLED |
| ACCEPTED / PREPARING / READY → CANCELLED | `order:cancel`, TENANT_ADMIN or MANAGER only (row 29, Q-008 B) | reason; `paid_amount − refunded_amount = 0` | non-SERVED KOTs → CANCELLED |
| COMPLETED → REFUNDED | automatic on full refund | `refunded_amount = paid_amount` | — |
| KOT QUEUED → PREPARING → READY | `kot:update_status` | sequential only | recompute order status |
| KOT READY → SERVED | `kot:serve` | — | — |

Any other transition returns `409 INVALID_TRANSITION`. Concurrent transitions use `orders.version` (SC-API-03).

### 3.5 UI access is not authorization

`LD-AUTH-01` returns `capabilities: Permission[]`, used to hide nav items and disable controls. Every action
re-checks on the server (SC-RBAC-08). E2E test `TC-RBAC-013` calls hidden actions directly as a lower role and asserts 403.

---

## 4. Tenant isolation

See `tenant-isolation.md` (mechanism) and `tenant-isolation-tests.md` (TI-001…TI-062, ADV-001…ADV-030). The summary controls
are SC-TEN-01…SC-TEN-10 below.

---

## 5. Security control catalogue

Status for every control: **PLANNED**. "Verified by" names the test(s) that prove the control. Task mapping is in `traceability.md`.

| ID | Control | Brief §38 topic | Implemented in | Verified by |
|---|---|---|---|---|
| SC-AUTH-01 | Clerk Email OTP is the only sign-in method; no passwords stored anywhere | authentication | Clerk instance config; `app/sign-in` | TC-AUTH-001, TC-AUTH-002, deployment checklist DEP-CHK-04 |
| SC-AUTH-02 | Fail-closed auth configuration (no dev bypass) | authentication | `lib/env.ts`, `middleware.ts`, `app/layout.tsx` | TC-AUTH-009 |
| SC-AUTH-03 | Middleware public-route allowlist; everything else protected; API returns 401 JSON | authentication | `middleware.ts` | TC-AUTH-003, TC-AUTH-004 |
| SC-AUTH-04 | Session + context resolved inside every loader, action and route handler | authentication | `lib/auth/session.ts`, `lib/auth/context.ts` | TC-AUTH-013 (static test: every `actions.ts`/`route.ts` calls a `require*` guard) |
| SC-AUTH-05 | Invite-only access (restricted sign-up) | authentication | Clerk config; resolver | TC-AUTH-006 |
| SC-AUTH-06 | Link local user only by Clerk-verified email for INVITED memberships | authentication | `lib/auth/session.ts` | TC-AUTH-005, ADV-021 |
| SC-AUTH-07 | USER status checked on every request | authentication | resolver | TC-AUTH-007 |
| SC-AUTH-08 | Revoke Clerk sessions when a user is suspended or loses last membership | session security | `lib/auth/clerk-admin.ts` | TC-AUTH-014 |
| SC-AUTH-09 | Auth infrastructure errors → 503/error boundary, not "signed out" | authentication | resolver | TC-AUTH-010 |
| SC-AUTH-10 | Never persist or log OTPs, passwords, session tokens | secrets, logging | logger redaction | TC-AUTH-011, TC-OBS-002 |
| SC-AUTH-11 | Post-login redirect accepts same-origin relative paths only | authentication | sign-in page | TC-AUTH-012 |
| SC-SESS-01 | Clerk session cookies HttpOnly, Secure, SameSite=Lax in production | session security | Clerk | DEP-CHK-05 (header inspection) |
| SC-SESS-02 | Active-tenant cookie holds membership id only, HttpOnly/Secure/SameSite=Lax, re-validated per request | session security | `lib/auth/context.ts` | TC-TENANT-004, ADV-004 |
| SC-SESS-03 | Sign-out clears active-tenant cookie | session security | sign-out handler | TC-AUTH-015 |
| SC-SESS-04 | Session lifetime/inactivity configured for shared devices (Q-029) | session security | Clerk config | DEP-CHK-06 |
| SC-TEN-01 | Tenant context derived server-side only; schemas reject tenant fields | tenant isolation | `lib/auth/context.ts`, Zod schemas | TC-TENANT-001, ADV-001 |
| SC-TEN-02 | Tenant-owned data accessed only via `lib/data/*` with tenant filter | tenant isolation, IDOR | `lib/data/**` | TI-001…TI-062 |
| SC-TEN-03 | CI static guard on Prisma imports and unscoped queries | tenant isolation | `tests/static/tenant-scope.test.ts` | TC-TENANT-002 |
| SC-TEN-04 | Missing and cross-tenant resources both return 404 | IDOR | `lib/data`, error mapper | TC-TENANT-003, ADV-002 |
| SC-TEN-05 | Composite FKs make cross-tenant references impossible | database security | migration `0001_init` | TC-DB-004 |
| SC-TEN-06 | Suspended tenant blocks staff and public access | tenant isolation | resolver, public loader | TC-AUTH-008, TC-WEB-004 |
| SC-TEN-07 | Print agent tenant derived from token only | tenant isolation | `lib/auth/agent.ts` | TI-041, ADV-012 |
| SC-TEN-08 | Aggregations/reports always tenant-filtered; platform dashboard shows counts only | tenant isolation, data leakage | `lib/data/reports.ts`, `lib/data/platform.ts` | TI-048, TC-RPT-006 |
| SC-TEN-09 | No shared caching of authenticated responses; public cache keyed by slug with public data only | cache, data leakage | route config, headers | TC-SEC-006, ADV-026 |
| SC-TEN-10 | Development/test seed has ≥2 tenants; isolation suite runs in CI on every PR | tenant isolation | `prisma/seed.ts`, CI | TC-QA-001 |
| SC-RBAC-01 | `requirePermission` before any resource load | authorization | all actions/loaders | TC-RBAC-101…TC-RBAC-150 |
| SC-RBAC-02 | Permission constants; unknown/missing permission denies | authorization | `lib/auth/permissions.ts` | TC-RBAC-001 |
| SC-RBAC-03 | Platform permissions only from `USER.platform_role` | privilege escalation | `lib/auth/context.ts` | TC-RBAC-002, ADV-006 |
| SC-RBAC-04 | Role-assignment hierarchy; no self role change | privilege escalation | `lib/services/staff.ts` | TC-RBAC-010, ADV-005 |
| SC-RBAC-05 | Last active TENANT_ADMIN protected | authorization | `lib/services/staff.ts` | TC-RBAC-012 |
| SC-RBAC-06 | Transition-level authorization table (§3.4) | authorization | `lib/services/orders.ts`, `kot.ts` | TC-ORDER-006, TC-KOT-004 |
| SC-RBAC-07 | Role-based field projections (kitchen, platform inspection) | data leakage | `lib/data/*` projections | TC-RBAC-011, TC-ADMIN-006 |
| SC-RBAC-08 | UI capability map from same constants; hidden actions still enforced | authorization | `LD-AUTH-01`, nav | TC-RBAC-013 |
| SC-VAL-01 | Zod `.strict()` validation for body/form/query/params/webhook/agent input | validation | `lib/validation/*` | TC-SEC-001 |
| SC-VAL-02 | Money as validated decimal strings; client price/total/tax/discount fields rejected | validation, price manipulation | order/transaction schemas | TC-ORDER-003, ADV-007, ADV-008 |
| SC-VAL-03 | Plain-text rendering; `dangerouslySetInnerHTML` banned by lint (JSON-LD via escaped serializer only) | XSS | ESLint rule, components | TC-SEC-002, ADV-016 |
| SC-VAL-04 | Image URLs `https:` + host allowlist; server never fetches arbitrary user URLs | SSRF | `lib/validation/url.ts`, card renderer | TC-SEC-003, ADV-017 |
| SC-VAL-05 | Prisma parameterised queries only; `$queryRawUnsafe` banned | SQL injection | ESLint rule | TC-SEC-004, ADV-018 |
| SC-VAL-06 | No shell execution with request data (server and agent) | command injection | code review rule; agent uses sockets/device writes | TC-AGENT-006 |
| SC-VAL-07 | Print payload text sanitised (control characters stripped) before ESC/POS encoding | command injection (printer) | `lib/print/render.ts`, agent encoder | TC-PRINT-008, ADV-019 |
| SC-VAL-08 | Route params validated (UUID/slug/date); invalid → 404 | validation | route segment parsers | TC-SEC-005 |
| SC-API-01 | Safe error mapping; no stack traces/SQL/infra details to clients | logging, data leakage | `lib/errors.ts`, `app/error.tsx` | TC-SEC-007 |
| SC-API-02 | Idempotency keys on order create and ledger writes | integrity | `lib/services/orders.ts`, `transactions.ts` | TC-ORDER-008, TC-TXN-005 |
| SC-API-03 | Optimistic concurrency on order updates | integrity | `orders.version` | TC-ORDER-009 |
| SC-API-04 | Pagination caps (100 list, 200 poll) | DoS | loaders/handlers | TC-SEC-008 |
| SC-API-05 | Explicit response projections (never spread DB rows to client) | data leakage | `lib/data` DTO mappers | TC-SEC-009 |
| SC-CSRF-01 | Server Action origin check verified on installed Next.js | CSRF | framework + test | TC-SEC-010 |
| SC-CSRF-02 | Cookie-authenticated route handlers are GET-only; any future non-GET must `assertSameOrigin` | CSRF | `lib/security/origin.ts` | TC-SEC-011 |
| SC-CSRF-03 | No permissive CORS; app APIs same-origin only | CORS | headers | TC-SEC-012 |
| SC-RL-01 | PostgreSQL rate limiter on pairing, agent API, webhook, public order, session mutations | rate limiting | `lib/security/rate-limit.ts` | TC-SEC-013, ADV-027 |
| SC-RL-02 | 429 + `Retry-After`; security log event | rate limiting | same | TC-SEC-013 |
| SC-RL-03 | Data export/import 30 an hour, permanent deletion (`data.purge`) 5 an hour per user, fail closed (2026-10-07) | rate limiting | `lib/security/rate-limit.ts`, `lib/services/data-management.ts` | TC-DATA-011 |
| SC-HDR-01 | HSTS (production only), nosniff, Referrer-Policy, Permissions-Policy, X-Frame-Options DENY, COOP; no `X-Powered-By` — **implemented 2026-10-07**, verified on a production build | secure headers | `lib/http/security-headers.ts`, `next.config.ts` | TC-SEC-HDR-001 |
| SC-HDR-02 | Content-Security-Policy with a per-request nonce — **implemented 2026-10-07**: `script-src 'self' 'nonce-…' 'strict-dynamic'` (no `unsafe-eval` in production; `https:`/`unsafe-inline` only as fallbacks old browsers use and nonce-aware browsers ignore), `connect-src` this site + Clerk frontend API + Clerk telemetry, `frame-src` Cloudflare Turnstile, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'`, `upgrade-insecure-requests` in production. Built in `middleware.ts`; `<ClerkProvider dynamic>` and the theme script carry the nonce, so every page renders per request. Verified on a production build: no CSP violation or page error on /, /sign-in (Clerk widget renders), /staff-login, /privacy, /terms, /book-demo and a tenant website (home, daily menu); desktop e2e suite passes under the policy (39 passed, 20 skipped for missing Clerk test accounts). `style-src 'unsafe-inline'` remains (React style attributes, Clerk runtime styles) | secure headers, XSS | `lib/http/content-security-policy.ts`, `middleware.ts`, `app/layout.tsx` | TC-SEC-HDR-002 |
| SC-HDR-03 | `Cache-Control: no-store` on authenticated pages and APIs | cache | route config | TC-SEC-006 |
| SC-FILE-01 | Uploads (Q-009): ≤5 MB, magic-byte type check, jpeg/png/webp only, re-encode, strip EXIF, reject SVG | file uploads, malicious file | `lib/media/*` | TC-SEC-016, ADV-020 |
| SC-FILE-02 | Tenant-prefixed storage keys; short-lived signed URLs; private bucket. **ADR-017 (2026-09-25):** ImageKit folder `/rasoios/restaurants/{tenantId}/…` built server-side; public CDN files (public-site images only); an ImageKit URL can be saved only if it is a READY asset of the caller's tenant | file uploads | `lib/media/*`, `lib/services/media.ts` | TC-SEC-017 |
| SC-WH-01 | Clerk webhook Svix signature + 5-minute timestamp tolerance | webhook verification | `app/api/webhooks/clerk/route.ts` | TC-AUTH-016, ADV-022 |
| SC-WH-02 | Idempotent webhook handlers; unknown event types ignored | webhook | same | TC-AUTH-017 |
| SC-PRINT-01 | Per-agent bearer token, 256-bit, SHA-256 at rest, shown once | agent authentication | `lib/services/print-agents.ts` | TC-AGENT-001 |
| SC-PRINT-02 | Pairing code single-use, 10-minute expiry, rate-limited | agent authentication | same | TC-AGENT-002, ADV-015 |
| SC-PRINT-03 | Atomic lease claim (`FOR UPDATE SKIP LOCKED`) | duplicate print | `lib/data/print-jobs.ts` | TC-PRINT-004 |
| SC-PRINT-04 | Ack requires owning agent + current claim token; PRINTED only via ack | forged print | same | TC-PRINT-005, TC-PRINT-006, ADV-013 |
| SC-PRINT-05 | Unique dedupe key per logical job | duplicate print | same | TC-PRINT-003 |
| SC-PRINT-06 | Cloud server never connects to printer addresses; LAN addresses must be private ranges | SSRF | `lib/validation/printer.ts` | TC-PRINT-007 |
| SC-PRINT-07 | Print payload minimisation (no phone/email/tokens) | data leakage | `lib/print/render.ts` | TC-PRINT-009 |
| SC-PRINT-08 | Agent stores its token in OS-protected storage (Q-010) | secrets | `print-agent/src/credentials.ts` | TC-AGENT-007 |
| SC-PRINT-09 | Revoked agent rejected on next request | agent authentication | `lib/auth/agent.ts` | TC-AGENT-003 |
| SC-AUD-01 | Every action in §7 writes an AUDIT_LOG row | audit | `lib/audit/*` | TC-AUDIT-001 |
| SC-AUD-02 | Audit row written in the same DB transaction as the change | audit | `lib/audit/write.ts` | TC-AUDIT-002 |
| SC-AUD-03 | Append-only enforcement by DB trigger | audit, database security | migration | TC-AUDIT-003 |
| SC-AUD-04 | Redaction of before/after (no secrets; PII masked) | logging | `lib/audit/redact.ts` | TC-AUDIT-004 |
| SC-AUD-05 | Audit read scoped: TENANT_ADMIN own tenant; SUPER_ADMIN platform | audit | `lib/data/audit.ts` | TI-050, TC-AUDIT-005 |
| SC-LOG-01 | Structured JSON logs with `request_id`, `tenant_id`, `user_id`, route, status, latency | logging | `lib/logger.ts`, middleware | TC-OBS-001 |
| SC-LOG-02 | Extended redaction keys + email/phone masking | logging, secrets | `lib/logger.ts` | TC-OBS-002 |
| SC-LOG-03 | Security events logged (`security.*`) | logging | guards | TC-OBS-003 |
| SC-LOG-04 | No request/response bodies logged by default | logging | logger policy | TC-OBS-002 |
| SC-SEC-01 | Environment validated at startup; server secrets never `NEXT_PUBLIC_` | secrets | `lib/env.ts` | TC-FOUND-003 |
| SC-SEC-02 | Secrets only in Railway variables; `.env*` gitignored (already true: `.gitignore` [fact]) | secrets | Railway, `.gitignore` | DEP-CHK-01 |
| SC-SEC-04 | Secret scan of the tree and the full git history in CI; reports file/commit + category only, never the text; matches under `tests/` are FIXTURE (2026-10-07) | secrets | `scripts/secret-scan.mjs`, CI `audit` job | CI |
| SC-SEC-05 | Browser bundle checked after every CI build: no credential pattern and no value of any server-only variable (compared by name, never printed) | secrets | `npm run security:bundle`, CI `build` job | CI |
| SC-SEC-03 | Rotation runbook for Clerk keys, webhook secret, DB credentials, agent tokens | secrets | `deployment.md` §9 | DEP-CHK-12 (drill) |
| SC-DEP-01 | `npm audit --audit-level=high` fails CI; lockfile committed | dependency security | CI workflow | TC-FOUND-004 |
| SC-DEP-02 | Automated dependency alerts on the GitHub repository | dependency security | repository settings | DEP-CHK-02 |
| SC-DEP-03 | New runtime dependency requires a review note (purpose, maintainer, licence) in PR | dependency security | PR template | TC-FOUND-005 |
| SC-DB-01 | TLS to PostgreSQL in production | database security | `DATABASE_URL` `sslmode=require` | DEP-CHK-03 |
| SC-DB-02 | Separate migration and runtime DB credentials (runtime without DDL) — feasibility on Railway verified in S1-P27-T002 | database security | Railway Postgres | DEP-CHK-07 |
| SC-DB-03 | CHECK constraints for money invariants | database security | migration | TC-DB-005 |
| SC-DB-04 | Statement timeout for runtime role (10 s) | DoS | connection params | TC-DB-006 |
| SC-BAK-01 | Automated backups verified; restore drill before launch (Q-025) | backups | Railway | DEP-CHK-08 |
| SC-BAK-02 | Backup/snapshot before every production migration | backups | release runbook | DEP-CHK-09 |
| SC-PUB-01 | Public loaders return explicit public projections only | public boundary | `lib/data/public.ts` | TC-WEB-002, ADV-025 |
| SC-PUB-02 | Unpublished website/categories/items/daily menus and suspended tenants never public | public boundary | same | TC-WEB-003, TC-WEB-004 |
| SC-PUB-03 | Automated response-shape test: no staff, customer, transaction, audit or settings fields on public routes | data leakage | test | TC-WEB-005 |
| SC-PII-01 | Customer data minimisation; notes staff-only, never on KOT or public | privacy | schemas, projections | TC-CUST-005 |
| SC-PII-02 | Irreversible customer anonymisation (retention policy Q-020) | privacy | `lib/services/customers.ts` | TC-CUST-006 |
| SC-PII-03 | PII masked in logs and audit state | privacy, logging | logger, audit redactor | TC-AUDIT-004, TC-OBS-002 |

### 5.1 Hardening pass 2026-10-07 (owner brief "Railpack build fix + complete security hardening")

Findings only by location and category — no value is recorded anywhere.

- [fact] Secret scan: working tree 0 high (17 FIXTURE matches, all in `tests/`); git history (all refs) 0 high
  (10 FIXTURE); production client bundle (134 files) 0 findings, compared against every non-`NEXT_PUBLIC_` variable.
  No fixture equals or contains a real environment value (checked by comparison, booleans only).
- [fact] `tests/unit/env.test.ts` used the production database's public proxy host and port as a fixture (no
  credentials). Replaced with a neutral host. Host names are not secrets, but they should not be advertised.
- [fact] `npm audit --omit=dev`: 0 vulnerabilities.
- [fact] Page guards: `/restaurant/website` was guarded by `restaurant:read` (every staff role) and the client pages
  `/restaurant/social`, `/restaurant/billing`, `/restaurant/analytics` had no page guard (their actions were guarded).
  Now `dashboard:read`, `social:manage`, `transaction:read`, `report:read` via server `layout.tsx`. Found by e2e
  TC-ROLE-010. Lesson: a `"use client"` page cannot call a guard and the guard-coverage test skipped non-async pages;
  it now also requires every client page under `/restaurant` and `/admin` to sit below its own guarded layout
  (`tests/static/guard-coverage.test.ts`).
- [fact] Already in place and re-checked: request IDs on every response (middleware), same-origin checks on
  cookie-authenticated non-GET routes, env validation that refuses to boot without TLS to a public database and names
  the variable without printing it, log redaction tests, rate limits on sign-in/pairing/public order/demo/uploads.

## 6. Brief §38 coverage check

| Topic | Controls |
|---|---|
| authentication | SC-AUTH-01…11 |
| authorization | SC-RBAC-01…08 |
| tenant isolation | SC-TEN-01…10 |
| IDOR | SC-TEN-02, SC-TEN-04, SC-TEN-05 |
| privilege escalation | SC-RBAC-03, SC-RBAC-04, SC-RBAC-05 |
| validation | SC-VAL-01, SC-VAL-02, SC-VAL-08 |
| SQL injection | SC-VAL-05 |
| XSS | SC-VAL-03, SC-HDR-02 |
| CSRF | SC-CSRF-01, SC-CSRF-02 |
| SSRF | SC-VAL-04, SC-PRINT-06 |
| command injection | SC-VAL-06, SC-VAL-07 |
| file uploads | SC-FILE-01, SC-FILE-02 |
| webhook verification | SC-WH-01, SC-WH-02 |
| secrets | SC-SEC-01…05, SC-AUTH-10, SC-PRINT-08 |
| rate limiting | SC-RL-01…03 |
| secure headers | SC-HDR-01…03 |
| CORS | SC-CSRF-03 |
| session security | SC-SESS-01…04, SC-AUTH-08 |
| logging | SC-LOG-01…04, SC-API-01 |
| dependency security | SC-DEP-01…03 |
| database security | SC-DB-01…04, SC-TEN-05, SC-AUD-03 |
| backups | SC-BAK-01, SC-BAK-02 |

## 7. Audit action catalogue

`AUDIT_ACTIONS` constant. Every action lists its actor, the resource it touches, and whether before/after state is captured (B/A).

| Domain | Actions | Actor | B/A |
|---|---|---|---|
| Platform | `tenant.created`, `tenant.updated`, `tenant.suspended`, `tenant.reactivated`, `tenant_admin.invited`, `tenant_admin.invite_revoked`, `platform.tenant_inspected`, `platform.role_changed`, `tenant.handed_over` | SUPER_ADMIN / SYSTEM (seed) | A / B+A |
| Identity | `user.linked`, `user.status_changed`, `user.email_synced`, `user.profile_synced`, `session.tenant_switched` | USER / WEBHOOK | B+A |
| Staff | `staff.invited`, `staff.invite_resent`, `staff.invite_revoked`, `staff.activated`, `staff.role_changed`, `staff.deactivated`, `staff.reactivated` | TENANT_ADMIN / MANAGER / USER (activation) | B+A |
| Restaurant | `restaurant.profile_updated`, `restaurant.branding_updated`, `restaurant.hours_updated`, `restaurant.settings_updated`, `restaurant.website_updated`, `restaurant.theme_updated`, `restaurant.website_published`, `restaurant.website_unpublished` | TENANT_ADMIN | B+A |
| Kitchen sections | `kitchen_section.created`, `kitchen_section.updated`, `kitchen_section.archived`, `kitchen_section.reordered` | TENANT_ADMIN | B+A |
| Menu | `menu_category.created`, `menu_category.updated`, `menu_category.archived`, `menu_category.reordered`, `menu_category.published`, `menu_category.unpublished`, `menu_item.created`, `menu_item.updated`, `menu_item.archived`, `menu_item.reordered`, `menu_item.published`, `menu_item.unpublished`, `menu_item.price_changed`, `menu_item.availability_changed`, `menu_item.variants_updated`, `menu_item.addons_updated` | TENANT_ADMIN / MANAGER | B+A |
| Daily menu | `daily_menu.created`, `daily_menu.copied`, `daily_menu.updated`, `daily_menu.items_updated`, `daily_menu.published`, `daily_menu.unpublished`, `daily_menu.deleted` | TENANT_ADMIN / MANAGER | B+A |
| Customers | `customer.created`, `customer.updated`, `customer.archived`, `customer.anonymized` | staff | B+A (masked) |
| Orders | `order.created`, `order.status_changed`, `order.cancelled`, `order.items_added`, `order.customer_linked`, `order.priority_changed` | staff / PUBLIC (Q-001) | B+A |
| KOT | `kot.generated`, `kot.status_changed`, `kot.reprint_requested` | staff / SYSTEM | B+A |
| Money | `payment.recorded`, `refund.created`, `transaction.voided`, `day_close.performed` | CASHIER / MANAGER / TENANT_ADMIN | A (+reason) |
| Printing | `printer.created`, `printer.updated`, `printer.deactivated`, `print_agent.created`, `print_agent.paired`, `print_agent.revoked`, `print_job.created` (manual test/receipt), `print_job.reprint_requested`, `print_job.retried`, `print_job.failed` | TENANT_ADMIN / MANAGER / staff / PRINT_AGENT / SYSTEM | A |
| Social | `social_post.created`, `social_post.updated`, `social_post.marked_ready`, `social_post.marked_posted`, `social_post.archived` | TENANT_ADMIN / MANAGER | B+A |
| Media (Q-009) | `media.uploaded`, `media.deleted` | TENANT_ADMIN | A |

High-frequency operational telemetry (agent heartbeats, printer health, polling) is **logged, not audited**.
