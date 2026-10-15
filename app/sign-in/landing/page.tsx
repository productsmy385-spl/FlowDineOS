import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getPlatformResolution, getTenantResolution } from "@/lib/auth/context";
import { accountRedirectFor } from "@/lib/auth/guards";
import { roleHomePath } from "@/lib/ui/navigation";
import { configuredRootDomain } from "@/lib/tenancy/request";
import { normalizeHost } from "@/lib/tenancy/hostnames";
import { CompletingSignIn } from "./completing-sign-in";

export const dynamic = "force-dynamic";

function safeRedirectTarget(target: string | undefined | null, rootDomain: string | null): string | null {
  if (!target) return null;
  const raw = target.trim();
  if (raw.startsWith("/") && !raw.startsWith("//")) return raw;
  try {
    const u = new URL(raw);
    const host = normalizeHost(u.host);
    const isLocal = host === "localhost" || host?.endsWith(".localhost") || host === "127.0.0.1";
    if (isLocal) return u.toString();
    const effectiveRoot = rootDomain || "flowdine.in";
    if (host === effectiveRoot || host?.endsWith(`.${effectiveRoot}`)) {
      u.port = "";
      u.protocol = "https:";
      return u.toString();
    }
  } catch {}
  return null;
}

/**
 * Post-sign-in landing (S1-P03-T005, frontend.md §5.1): the one place that decides where a person goes after Clerk
 * verifies their one-time code. Platform administrators go to the platform console; everyone else goes straight to
 * the page their role actually starts on, and a user who cannot open a console goes to the matching /account page.
 */
export default async function SignInLanding() {
  const reqHeaders = await headers();
  const currentPath = reqHeaders.get("x-pathname") || "";
  let rawRedirect: string | null = null;
  if (currentPath.includes("?")) {
    const sp = new URLSearchParams(currentPath.slice(currentPath.indexOf("?")));
    rawRedirect = sp.get("redirect_url");
  }

  const rootDomain = configuredRootDomain();
  const safeRedirect = safeRedirectTarget(rawRedirect, rootDomain);

  const platform = await getPlatformResolution();
  if (platform.outcome === "SIGNED_OUT") return <CompletingSignIn />;

  const tenant = await getTenantResolution();

  // If a specific tenant redirect was requested (e.g. from akshayapatra.flowdine.in/staff-login)
  // and the user has access to that tenant, honour it directly!
  if (safeRedirect) {
    if (safeRedirect.startsWith("https://") && tenant.outcome === "OK") {
      redirect(safeRedirect);
    }
    if (safeRedirect.startsWith("/admin") && platform.outcome === "OK") {
      redirect(safeRedirect);
    }
    if (safeRedirect.startsWith("/") && tenant.outcome === "OK") {
      redirect(safeRedirect);
    }
  }

  if (platform.outcome === "OK") redirect("/admin");

  if (tenant.outcome === "OK") {
    const rolePath = roleHomePath(tenant.ctx.role);
    const sub = tenant.ctx.subdomain || tenant.ctx.tenantSlug;
    if (sub && rootDomain && process.env.NODE_ENV !== "test") {
      redirect(`https://${sub}.${rootDomain}${rolePath}`);
    }
    redirect(rolePath);
  }
  redirect(accountRedirectFor(tenant));
}
