import "server-only";
import type { NextRequest } from "next/server";
import { ForbiddenError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { appUrl } from "@/lib/env";
import { normalizeHost, normalizeRootDomain, resolveHost } from "@/lib/tenancy/hostnames";

/**
 * Checks whether an Origin header represents a legitimate FlowDineOS console origin:
 * - The configured platform apex origin (e.g. https://flowdine.in or http://localhost:3000)
 * - The NextRequest's own origin
 * - A legitimate tenant subdomain under the configured root domain (e.g. https://akshayapatra.flowdine.in)
 * - In development, tenant subdomains on localhost (e.g. http://akshayapatra.localhost:3000)
 */
export function isAllowedConsoleOrigin(origin: string, request: NextRequest): boolean {
  try {
    const originUrl = new URL(origin);
    const host = normalizeHost(originUrl.host);
    if (!host) return false;

    const isLocal = host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "0.0.0.0";
    if (!isLocal && originUrl.protocol !== "https:") return false;

    // 1. Configured app URL origin (NEXT_PUBLIC_APP_URL, e.g. https://flowdine.in)
    const configured = configuredOrigin();
    if (configured && origin === configured) return true;

    // 2. Request's own nextUrl origin
    if (origin === request.nextUrl.origin) return true;

    // 3. Request's forwarded host/origin
    const rawForwarded = request.headers.get("x-forwarded-host") || request.headers.get("host");
    const forwardedHost = normalizeHost(rawForwarded);
    if (forwardedHost && host === forwardedHost) {
      const rootDomain = normalizeRootDomain(process.env.PUBLIC_ROOT_DOMAIN) ?? (forwardedHost.endsWith(".flowdine.in") || forwardedHost === "flowdine.in" ? "flowdine.in" : null);
      if (rootDomain) {
        if (forwardedHost === rootDomain) return true;
        if (forwardedHost.endsWith(`.${rootDomain}`)) {
          const res = resolveHost(forwardedHost, rootDomain);
          if (res.kind === "tenant" || res.kind === "apex") return true;
        }
      }
      if (isLocal) return true;
    }

    // 4. Check root domain resolution for tenant subdomains (e.g. akshayapatra.flowdine.in)
    const rootDomain = normalizeRootDomain(process.env.PUBLIC_ROOT_DOMAIN) ?? (host.endsWith(".flowdine.in") || host === "flowdine.in" ? "flowdine.in" : null);
    if (rootDomain) {
      if (host === rootDomain) return true;
      if (host.endsWith(`.${rootDomain}`)) {
        const resolution = resolveHost(host, rootDomain);
        if (resolution.kind === "tenant" || resolution.kind === "apex") return true;
      }
    }

    // 5. Localhost tenant subdomains in development
    if (isLocal) {
      if (host === "localhost" || host === "127.0.0.1") return true;
      if (host.endsWith(".localhost")) {
        const resolution = resolveHost(host, null);
        if (resolution.kind === "tenant" || resolution.kind === "apex") return true;
      }
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * SC-CSRF-02 / RASOIOS-ADR-011 §4 — cookie-authenticated, state-changing Route Handlers must prove the request came
 * from this application's own pages. Server Actions get this from Next.js; Route Handlers call `assertSameOrigin`.
 *
 * - `Sec-Fetch-Site`, when the browser sends it, must not be `cross-site` (`same-origin` and `same-site` are accepted).
 * - `Origin` is required and must be this app: its configured apex URL, the request host, or an authorized tenant subdomain.
 */
export function assertSameOrigin(request: NextRequest, requestId: string): void {
  const site = request.headers.get("sec-fetch-site");
  const origin = request.headers.get("origin");

  if ((site !== null && site !== "same-origin" && site !== "same-site") || origin === null || !isAllowedConsoleOrigin(origin, request)) {
    logger.warn("security.cross_origin_refused", { requestId, site, originPresent: origin !== null, origin });
    throw new ForbiddenError("This request must come from the FlowDineOS console.");
  }
}

function configuredOrigin(): string | null {
  try {
    const configured = appUrl();
    return configured ? new URL(configured).origin : null;
  } catch {
    return null;
  }
}
