---
title: "Railway Configuration"
document_type: "REFERENCE"
project: "Restaurant SaaS Platform"
project_owner: "Gopala Krishna"
slice: "SLICE-01"
status: "PROPOSED"
version: "2.1"
created: "2026-09-15"
last_updated: "2026-09-15"
owner: "Gopala Krishna (Project Owner)"
planned_start: "2026-09-15"
planned_finish: "Not scheduled — execution-order plan"
dependencies: []
related_documents: ["../implementation/slice-01/deployment.md", "deployment.md"]
related_decisions: []
---

# Railway Configuration

| Item | Staging | Production | Status |
|---|---|---|---|
| Project / environments | Project `rasoios`, environment `staging` | Environment `production` — S1-P27-T001 | Not provisioned — S1-P01-T008 is BLOCKED on owner approval (see below) |
| Builder | Railpack, set in `railway.json` [fact: `railway.json`] | same | Committed in repo, not yet deployed |
| Services | `web`, PostgreSQL, maintenance cron (if available) | same | — |
| Build / start | `npm run prisma:gen && npm run agent:build && npm run build` / `npm run start` [fact: `railway.json`] | same | — |
| Port | `next start` reads `PORT` and binds `0.0.0.0` [fact: `node_modules/next/dist/bin/next`, `start` command] | same | — |
| Health check path | `/` for now; `/api/ready` from S1-P26-T003 | `/api/ready` | Interim value, see below |
| Pre-deploy command | none until the first migration (S1-P02-T003), then `npm run prisma:deploy` | Release pipeline (S1-P27-T003) | — |
| Domain | Railway domain | Per Q-013 | — |
| PostgreSQL version / plan / backups | Not yet documented — S1-P02-T001, Q-025 | Not yet documented — S1-P27-T006 | — |
| Replicas | 1 | Decision in S1-P27-T001 | — |

v1.0 stated "PostgreSQL plugin with automated connection pooling" and "Health Check Path /api/health". Neither was verified, and no health route existed (baseline-audit §3).

## Configuration choices (S1-P01-T008, 2026-09-15)

- **Builder: Railpack.** Railpack is Railway's current default builder and detects the Node version from `.nvmrc` (24). A Dockerfile is not needed yet; revisit if the build requires system packages. [proposed]
- **Prisma client generated in the build command.** npm 11 `allow-scripts` blocks install scripts, so `@prisma/client` postinstall cannot be relied on (same reason CI runs `npx prisma generate` explicitly).
- **Print agent packaged in the build command (2026-09-29).** `npm run agent:build` writes `print-agent/dist/rasoios-print-agent-{windows.zip,linux.tar.gz}`, which `GET /api/v1/printing/agent-download/{platform}` serves to the pairing dialog. `print-agent/dist/` is gitignored, so without this step the deployment has no package and the download answers 404 with "not built into this deployment" — which is what the restaurant sees, rather than a broken file. Building it per deploy also guarantees the agent a restaurant installs matches the server that pairs it. [fact: `railway.json`, `print-agent/build.mjs`]
- **Health check `/` until `/api/ready` exists.** The landing page renders without a session or database, so it proves the process is serving but not that the database is reachable. S1-P26-T003 switches `railway.json` to `/api/ready`.
- **No pre-deploy migration yet.** There is no `prisma/migrations` folder. S1-P02-T003 adds `"preDeployCommand": ["npm run prisma:deploy"]` to `railway.json` in the same pull request as the first migration.
- `tests/static/deploy-config.test.ts` checks that `railway.json` uses existing npm scripts, generates Prisma before building, and contains no secret values.

## ImageKit (RASOIOS-ADR-017, 2026-09-25)

Set on the `web` service to turn image uploads on (both or neither; blank = off, image-link fields keep working):
`IMAGEKIT_PRIVATE_KEY` (secret, `private_…`) and `IMAGEKIT_URL_ENDPOINT` (`https://ik.imagekit.io/<id>`), from the
ImageKit dashboard → Developer options. Never as `NEXT_PUBLIC_`. The endpoint host is allow-listed for images
automatically; redeploy after setting them (`next.config.ts` reads it at build). Migration `0004_media_assets` runs
in the pre-deploy step.

## Staging provisioning runbook (owner-approved step)

The Railway CLI on the development machine (v5.43.1) is signed in, but no `rasoios` project exists [observed 2026-09-15, `railway list`]. Creating one is outward-facing and may be billable, so it waits for the Project Owner to confirm the workspace and plan.

1. Create the project in the approved workspace: `railway init --name rasoios`, then create the `staging` environment in the dashboard.
2. Add PostgreSQL: `railway add --database postgres`. Record the major version for S1-P02-T001.
3. Add the `web` service from the GitHub repository, branch `main`, with auto-deploy on. `railway.json` supplies build, start and health check settings.
4. Set `web` variables (never commit values). Use the Clerk **development** instance:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` (private `*.railway.internal` host, so `sslmode=require` is not enforced by `lib/env.ts`)
   - `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`
   - `NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in`, `NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up`
   - `NEXT_PUBLIC_APP_URL` = the generated `https://…up.railway.app` domain
   - `TRUSTED_PROXY_HOPS=1` — the number of proxies of ours in front of `web`; the audit trail then takes the client address from that many entries from the right of `X-Forwarded-For` and discards whatever the caller prepended [fact: `lib/http/request-meta.ts:25`]. Set it too high and a client can forge an address, so raise it only when another proxy (a CDN, a load balancer) is actually added in front of Railway. Leave it unset anywhere the app is reached directly: no address is then recorded at all. Confirm the hop count against the first live deployment in S1-P27-T001 by comparing a request's recorded address with the caller's real one.
   - `LOG_LEVEL=debug`, `ALLOWED_IMAGE_HOSTS` (empty for now)
5. Generate a Railway domain for `web` and add it to the Clerk development instance's allowed origins.
6. Merge to `main` and verify TC-OPS-001: the staging URL serves the new build over HTTPS. Record the URL and deployment id in the table above.

## Known issue — migrations not applied on deploy (seen 2026-10-02 and 2026-10-07)

[observed] Twice a deploy went live with migrations pending (`/api/ready` →
`{"status":"unavailable","reason":"MIGRATIONS_PENDING",...}`) although `railway.json` sets
`preDeployCommand: npm run prisma:deploy` and `healthcheckPath: /api/ready`. Both times the fix was
`npx prisma migrate deploy` against the production `DATABASE_URL`, after which `/api/ready` returned ready.

[assumption] The Railway service's dashboard settings override or ignore `railway.json` (pre-deploy command and/or
health check). Not yet verified — check Railway → service → Settings → Deploy: the pre-deploy command should be
`npm run prisma:deploy` and the health check path `/api/ready`. Until then, after every push that adds a migration,
check `/api/ready` and apply migrations if it reports MIGRATIONS_PENDING.
