---
title: "RASOIOS-ADR-019: Staff Daily-Password Login, Sessions and Attendance"
document_type: "ADR"
project: "Restaurant SaaS Platform"
project_owner: "Gopala Krishna"
slice: "SLICE-01"
status: "APPROVED"
version: "1.0"
created: "2026-09-29"
last_updated: "2026-09-29"
owner: "Gopala Krishna (Project Owner)"
planned_start: "2026-09-29"
planned_finish: "Not scheduled — execution-order plan"
dependencies: ["RASOIOS-ADR-006"]
related_documents: ["../implementation/slice-01/security.md", "../implementation/slice-01/data-model.md", "../../CLAUDE.md"]
related_decisions: ["RASOIOS-ADR-006"]
---

# RASOIOS-ADR-019: Staff Daily-Password Login, Sessions and Attendance

- **ID:** RASOIOS-ADR-019
- **Date:** 2026-09-29
- **Owner:** Gopala Krishna (Project Owner)
- **Status:** APPROVED — 2026-09-29, from the client feedback brief of 2026-09-29.
- **Relationship:** Extends RASOIOS-ADR-006 (invite-only Clerk identity). ADR-006 is unchanged for every role it
  already covered; this adds a second credential type for staff roles only.

## Context

Counter and kitchen staff share devices, turn over often, and do not reliably have work email they check. Putting
them through the same email-OTP flow as an administrator is friction at the start of every shift, and it leaves the
restaurant with no way to see who is actually working or to get someone off a till immediately.

The client asked for a daily temporary password the administrator issues, plus working-hours tracking and a force
logout — and was explicit that this must **not** change how SUPER_ADMIN, TENANT_ADMIN or MANAGER sign in.

## Decision

### 1. Two credential types, never mixed

| Role | Credential |
|---|---|
| SUPER_ADMIN, TENANT_ADMIN, MANAGER | Clerk email OTP, exactly as before |
| CASHIER, KITCHEN, WAITER | A daily password their TENANT_ADMIN generates |

A daily password cannot authenticate a non-staff role, and this is enforced three times over: the candidate query
filters on role, `staffLogin` re-checks it, and `staff_sessions_role_is_staff_check` refuses the row outright. The
last one is the only guarantee that survives a future bug in the first two.

`getSessionUser()` tries Clerk first and only falls through to a staff cookie when Clerk has no session at all, so
the two paths can never be combined to widen anyone's access.

### 2. Staff resolve into the *same* session shape

The staff path returns the same `SessionState` the Clerk path does. `resolveTenant`, every guard, every permission
check and every `tenantScope` then work on a staff session without knowing one exists.

This is the core of the design: there is **one** authorization path, not two to keep in step. A staff session gets
exactly the permissions its `TenantRole` already grants — no new grant table, no parallel RBAC.

### 3. The password

Eight characters in two groups (`ABCD-2345`) from a 29-character alphabet with no `0/O`, `1/I/L` or `U/V` — read off
a screen and spoken across a counter. About 39 bits, which is enough *because* it is valid for one business day and
rate limited; it would not be enough for a standing password.

Stored as scrypt (N=2^16, r=8, p=1) and nothing else. The plaintext exists only in the response that generates it.
`maxmem` is set explicitly: scrypt needs ~67 MB here and Node's default ceiling is 32 MB, so without it every hash
throws. A partial unique index allows one ACTIVE credential per membership, so regenerating *cannot* leave the
previous password alive — that is a database property, not a thing the service must remember.

Expiry is the end of the restaurant's business day in its own IANA timezone, via `zonedTimeToUtc`, never a UTC
calendar boundary. For Asia/Kolkata that is 18:30Z, which the tests assert directly.

### 4. Sessions are the attendance record

One `StaffSession` row is both the server-side session and the shift. The cookie carries an opaque 256-bit token;
only its SHA-256 is stored, so a copy of the table cannot be replayed. SHA-256 rather than a slow hash because the
token is CSPRNG output, not a human secret — there is no dictionary to stretch against.

Every request re-reads the row. That is what makes force logout immediate, and it also ends access when a membership
is suspended or moved off a staff role, with nobody having to hunt down the session. A partial unique index allows
one open shift per membership, so signing in on a second device moves the shift rather than forking it, and
attendance stays a clean sequence.

Duration is computed from these rows, never from a date change. Multiple shifts in a day sum to the day's total.

### 5. Limits and isolation

Two fail-closed rate-limit buckets: per email so a colleague's typos cannot lock someone out, and per address so a
spray across many emails from one machine is still stopped.

The restaurant is **derived** from whichever credential the password verifies against. Nothing in the request names
a tenant, so there is no field to change to reach another one. A wrong email and a wrong password produce the same
answer, and the same work, so neither reveals whether a person works here.

### 6. Administration is TENANT_ADMIN only

MANAGER already holds every `staff:*` permission including `staff:invite`, so a new permission in that group would
have been granted to MANAGER by the role table's own conventions. The actions therefore take `staff:read` as the
coarse gate and call `assertStaffAdmin`, which is the honest way to say "administrator only" without widening the
group. **Revisit if the owner later wants managers to run shifts.**

Audited: password generated, regenerated, revoked; login, logout, force logout. Never the password, never its hash.

## Alternatives considered

- **Reuse Clerk with a per-day password.** Rejected: Clerk is the identity provider for people with email, and
  bending it into a shared daily credential would put staff and administrators on one code path — the opposite of
  what the client asked for, and the place a mistake becomes a privilege escalation.
- **A separate staff user table.** Rejected: it would duplicate USER and USER_TENANT and leave two notions of who
  works here. Staff are already memberships; this adds a credential, not a person.
- **A signed stateless cookie (JWT).** Rejected: force logout is a headline requirement, and a stateless token
  cannot be revoked without a server-side list — which is the session table, minus its usefulness as attendance.

## Verification

`tests/integration/staff/daily-login.test.ts` (TC-STAFF-101…106): hashing, expiry in the restaurant's timezone,
regeneration invalidating the old password, expired and revoked passwords, cross-tenant refusal, MANAGER and CASHIER
refused administration, force logout ending access on the next request, multi-shift attendance, and the Clerk path
left untouched. `tests/integration/db/constraints.test.ts` covers all nine new CHECK constraints;
`composite-fk.test.ts` covers the three new composite foreign keys.

## The administrator's screens

`/restaurant/staff/access` — three tabs over one bounded read: today's passwords, who is on shift now, and the last
seven business days of attendance. Linked from the Staff page for a TENANT_ADMIN only, and deliberately *not* added
to the navigation: MANAGER holds `staff:read`, so a capability-filtered nav entry would show managers a door the
loader refuses.

Cards at every width rather than a table that collapses, because each staff member is one unit an administrator acts
on and three of them on a phone at the start of a shift is the common case. A generated password appears once, in
place, with a copy button and a plain statement that it cannot be shown again. Durations come from
`lib/ui/attendance.ts`, which is pure and shared so an open shift reads the same on the server and in the browser;
a day with two shifts totals the shifts, not the span between them.

## Not yet built

- Staff cannot yet sign themselves out from inside the console — `staffSignOutAction` exists and is tested, but no
  console control calls it. Administrators can force a sign-out, and sessions expire with the business day.
- Attendance is read-only and capped at 31 days; there is no CSV export and no payroll period.
- No hardware or browser test of the staff sign-in page has been run: everything above is verified by the
  integration and unit suites only.
