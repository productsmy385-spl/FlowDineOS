import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { ChevronRight, KeyRound } from "lucide-react";
import { SignIn } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";
import { AuthLayout } from "@/components/layout/auth-layout";
import { Icon } from "@/components/ui/icon";
import { ACTIVE_MEMBERSHIP_COOKIE } from "@/lib/auth/active-membership-cookie";
import { signInAppearance } from "@/lib/ui/clerk-appearance";
import { safeRedirect } from "@/lib/ui/safe-redirect";
import { ClearTenantPreference } from "../clear-tenant-preference";

export const metadata: Metadata = { title: "Sign in — RASOIOS" };

/** Where a signed-in user goes when no (valid) redirect was requested: /admin or /restaurant (see ../landing). */
const AFTER_SIGN_IN = "/sign-in/landing";

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * /sign-in (S1-P03-T005, frontend.md §5.1): Clerk Email OTP on the Brand v2 dark-glass theme (ADR-013 §1). `redirect_url` is honoured only
 * when it is a same-origin relative path (SC-AUTH-11); anything else falls back to the role landing. Clerk is told
 * to *force* that target so it never falls back to its own reading of the query string.
 * A signed-out browser that still carries the active-restaurant cookie has it cleared here (SC-SESS-03).
 */
export default async function SignInPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const target = safeRedirect(typeof params.redirect_url === "string" ? params.redirect_url : undefined, AFTER_SIGN_IN);
  const [{ userId }, jar] = await Promise.all([auth(), cookies()]);
  const clearStalePreference = !userId && jar.has(ACTIVE_MEMBERSHIP_COOKIE);

  return (
    <AuthLayout
      title="Sign in to your restaurant"
      description="Administrators and managers: enter your work email and we'll send you a one-time code."
      footer="Administrators and managers join by invitation from RASOIOS or their restaurant administrator."
    >
      {clearStalePreference && <ClearTenantPreference />}
      {/* Counter and kitchen staff never use this form: they have no emailed code and no password here, only the one
          their administrator generates each day, which /staff-login checks (ADR-019 section 1). Without this, a cashier
          types the daily password into the identity provider's own password box and is told it is wrong. */}
      <Link
        href="/staff-login"
        className="glass-2 flex items-center gap-3 rounded-2xl px-4 py-3 text-left transition-colors duration-fast ease-standard hover:bg-raised"
      >
        <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-action-primary text-action-primary-fg">
          <Icon icon={KeyRound} size={20} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-label text-fg-primary">Cashier, kitchen or waiter?</span>
          <span className="text-caption text-fg-secondary">Sign in with today&apos;s password from your administrator</span>
        </span>
        <Icon icon={ChevronRight} size={20} className="text-fg-secondary" />
      </Link>
      <div className="flex justify-center">
        <SignIn path="/sign-in" routing="path" forceRedirectUrl={target} signUpForceRedirectUrl={AFTER_SIGN_IN} appearance={signInAppearance} />
      </div>
    </AuthLayout>
  );
}
