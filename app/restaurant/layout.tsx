import type { Metadata } from "next";
import type { OperationalIndicator } from "@/components/layout/notifications";
import { ConsoleFrame } from "@/components/layout/console-frame";
import { getConsoleSession } from "@/lib/auth/context";
import { requireTenantPage } from "@/lib/auth/guards";
import { hasPermission } from "@/lib/auth/permissions";
import { listActivePrinters, listAgents, listPrintJobs } from "@/lib/services/printing";
import { imageKitSized } from "@/lib/media/purposes";
import { SessionProvider } from "@/lib/ui/session-context";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  try {
    const ctx = await requireTenantPage("restaurant:read");
    const session = await getConsoleSession(ctx);
    const name = session.activeTenant.name;
    const favicon = session.activeTenant.faviconUrl || session.activeTenant.logoUrl;

    return {
      title: {
        template: `%s | ${name}`,
        default: `${name} Console`,
      },
      ...(favicon
        ? {
            icons: {
              icon: [
                { url: imageKitSized(favicon, 64), sizes: "64x64", type: "image/png" },
                { url: imageKitSized(favicon, 32), sizes: "32x32", type: "image/png" },
              ],
              apple: [
                { url: imageKitSized(favicon, 180), sizes: "180x180", type: "image/png" },
              ],
            },
          }
        : {}),
    };
  } catch {
    return {
      title: "Restaurant Console",
    };
  }
}

/** How many failed jobs the header counts before it says "20+" rather than guessing a total. */
const FAILED_JOB_SAMPLE = 20;

/**
 * Header operational indicators (frontend.md §3.2, S1-P16-T009): print agents that have stopped calling in, printers
 * an agent last reported as offline, and print jobs that failed — all read from the caller's own tenant and only for
 * roles holding `print_job:read` (security.md §3.3 row 46). Nothing here is estimated: "offline" means the agent's
 * last call is older than the 90 s heartbeat window (ADR-007 §7) and a printer's health is its agent's last report.
 * When there is nothing to report the list is empty and the header says so.
 */
async function operationalIndicators(ctx: Awaited<ReturnType<typeof requireTenantPage>>): Promise<OperationalIndicator[]> {
  if (!hasPermission(ctx, "print_job:read")) return [];
  const [printers, failedJobs, agents] = await Promise.all([
    listActivePrinters(ctx),
    listPrintJobs(ctx, { status: "FAILED" }, FAILED_JOB_SAMPLE),
    listAgents(ctx),
  ]);

  const indicators: OperationalIndicator[] = [];
  const offlineAgents = agents.filter((agent) => agent.status === "ACTIVE" && !agent.online);
  if (offlineAgents.length > 0) {
    indicators.push({
      id: "agents-offline",
      label: offlineAgents.length === 1 ? `${offlineAgents[0].name} is offline` : `${offlineAgents.length} agents offline`,
      tone: "danger",
      href: "/restaurant/printing",
    });
  }
  const offline = printers.filter((printer) => printer.health === "OFFLINE");
  if (offline.length > 0) {
    indicators.push({
      id: "printers-offline",
      label: offline.length === 1 ? `${offline[0].name} is offline` : `${offline.length} printers are offline`,
      tone: "danger",
      href: "/restaurant/printing",
    });
  }
  if (failedJobs.length > 0) {
    const count = failedJobs.length === FAILED_JOB_SAMPLE ? `${FAILED_JOB_SAMPLE}+` : `${failedJobs.length}`;
    indicators.push({
      id: "print-jobs-failed",
      label: failedJobs.length === 1 ? "1 print job failed" : `${count} print jobs failed`,
      tone: "warning",
      href: "/restaurant/printing",
    });
  }
  return indicators;
}

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { hostPort, resolveHost } from "@/lib/tenancy/hostnames";
import { configuredRootDomain } from "@/lib/tenancy/request";

// Tenant console (S1-P04-T004, S1-P05-T006, ADR-013 §3). Resolves the tenant context once: signed-out, uninvited,
// suspended and multi-restaurant users are redirected before any tenant data renders. Pages still guard themselves.
// ConsoleFrame renders the header-navigation shell, or the focus shell for the kitchen board (frontend.md §2).
export default async function RestaurantLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireTenantPage("restaurant:read");
  const [session, indicators] = await Promise.all([getConsoleSession(ctx), operationalIndicators(ctx)]);

  const hostHeader = (await headers()).get("host");
  const rootDomain = configuredRootDomain();
  const host = resolveHost(hostHeader, rootDomain);

  if (host.kind === "apex" && rootDomain && process.env.NODE_ENV !== "test") {
    const sub = session.activeTenant.subdomain || session.activeTenant.slug;
    if (sub) {
      const port = hostPort(hostHeader);
      const portSuffix = port && port !== "8080" && port !== "80" && port !== "443" ? `:${port}` : "";
      const isLocal = hostHeader?.includes("localhost") || hostHeader?.includes("127.0.0.1");
      const targetHost = isLocal ? `${sub}.localhost${portSuffix}` : `${sub}.${rootDomain}`;
      const proto = isLocal ? "http" : "https";
      const pathname = (await headers()).get("x-pathname") || "/restaurant/dashboard";
      redirect(`${proto}://${targetHost}${pathname}`);
    }
  }

  return (
    <SessionProvider value={session}>
      <ConsoleFrame indicators={indicators}>{children}</ConsoleFrame>
    </SessionProvider>
  );
}
