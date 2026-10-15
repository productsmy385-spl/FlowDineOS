import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { KeyRound } from "lucide-react";
import { SignIn } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";
import { AuthLayout } from "@/components/layout/auth-layout";
import { SignInAudience, SignInDoor } from "@/components/layout/sign-in-door";
import { ACTIVE_MEMBERSHIP_COOKIE } from "@/lib/auth/active-membership-cookie";
import { signInAppearance } from "@/lib/ui/clerk-appearance";
import { configuredRootDomain } from "@/lib/tenancy/request";
import { normalizeHost } from "@/lib/tenancy/hostnames";
import { ClearTenantPreference } from "../clear-tenant-preference";

export const metadata: Metadata = { title: "Sign in — FlowDineOS" };

/** Where a signed-in user goes when no (valid) redirect was requested: /admin or /restaurant (see ../landing). */
const AFTER_SIGN_IN = "/sign-in/landing";

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

export default async function SignInPage() {
  const [{ userId }, jar, reqHeaders] = await Promise.all([auth(), cookies(), headers()]);
  const currentPath = reqHeaders.get("x-pathname") || "";
  let rawRedirect: string | null = null;
  if (currentPath.includes("?")) {
    const sp = new URLSearchParams(currentPath.slice(currentPath.indexOf("?")));
    rawRedirect = sp.get("redirect_url");
  }

  const rootDomain = configuredRootDomain();
  const safeTarget = safeRedirectTarget(rawRedirect, rootDomain);
  const targetUrl = safeTarget
    ? `/sign-in/landing?redirect_url=${encodeURIComponent(safeTarget)}`
    : AFTER_SIGN_IN;

  // Already signed in: go to landing to resolve role-based home.
  if (userId) redirect(targetUrl);
  const clearStalePreference = !userId && jar.has(ACTIVE_MEMBERSHIP_COOKIE);

  return (
    <AuthLayout
      title="Sign in to your restaurant"
      description="Owners, administrators and managers sign in here with a one-time code sent to their work email."
      footer="Administrators and managers join by invitation from FlowDineOS or their restaurant administrator."
    >
      {clearStalePreference && <ClearTenantPreference />}
      {/* Two doors, each labelled for who it is for (ADR-019 section 1). This form is the account holders' one, so it
          comes first and says so; counter and kitchen staff, who have no emailed code here, get a full card to theirs. */}
      <SignInAudience>Owner, administrator or manager</SignInAudience>
      <div className="flex justify-center">
        <SignIn
          path="/sign-in"
          routing="path"
          forceRedirectUrl={targetUrl}
          fallbackRedirectUrl={targetUrl}
          signUpForceRedirectUrl={targetUrl}
          signUpFallbackRedirectUrl={targetUrl}
          appearance={signInAppearance}
        />
      </div>
      <SignInDoor
        href="/staff-login"
        icon={KeyRound}
        title="Cashier, kitchen or waiter?"
        detail="Sign in with today's password from your administrator"
      />
    </AuthLayout>
  );
}
