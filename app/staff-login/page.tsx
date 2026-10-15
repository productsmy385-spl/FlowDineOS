import type { Metadata } from "next";
import { headers } from "next/headers";
import { Mail } from "lucide-react";
import { SignInAudience, SignInDoor } from "@/components/layout/sign-in-door";
import { AuthLayout } from "@/components/layout/auth-layout";
import { StaffLoginForm } from "./staff-login-form";
import { normalizeHost, normalizeRootDomain } from "@/lib/tenancy/hostnames";

export const metadata: Metadata = { title: "Staff sign in — FlowDineOS" };
export const dynamic = "force-dynamic";

/**
 * Staff sign-in (RASOIOS-ADR-019, C6). A separate door from `/sign-in`: staff use the password their administrator
 * generates for the day, and administrators and managers use the identity provider as they always have.
 *
 * No restaurant is named or chosen here. The password itself determines which restaurant the person is signing in
 * to, so nothing on this page can be changed to reach a different one (C19).
 */
export default async function StaffLoginPage() {
  const reqHeaders = await headers();
  const rawHost = reqHeaders.get("host") || "flowdine.in";
  const host = normalizeHost(rawHost) || "flowdine.in";
  const rootDomain = normalizeRootDomain(process.env.PUBLIC_ROOT_DOMAIN) || "flowdine.in";
  const isLocal = host.includes("localhost") || host.includes("127.0.0.1");
  const proto = isLocal ? "http" : "https";
  const apexAuthority = isLocal ? "localhost:3000" : rootDomain;
  const isSubdomain = host.endsWith(`.${rootDomain}`) && host !== rootDomain;

  // On a tenant subdomain, link directly to the apex sign-in page with the tenant dashboard return URL.
  // This bypasses intermediate subdomain redirects and any stale browser-cached 308s.
  const adminSignInHref = isSubdomain
    ? `${proto}://${apexAuthority}/sign-in?redirect_url=${encodeURIComponent(`${proto}://${host}/restaurant/dashboard`)}`
    : "/sign-in";

  return (
    <AuthLayout title="Staff sign in" description="Enter the password your restaurant administrator generated for today.">
      <SignInAudience>Cashier, kitchen or waiter</SignInAudience>
      <StaffLoginForm />
      <SignInDoor href={adminSignInHref} icon={Mail} title="Owner, administrator or manager?" detail="Sign in with a one-time code sent to your work email" />
    </AuthLayout>
  );
}

