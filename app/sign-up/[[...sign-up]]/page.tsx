import type { Metadata } from "next";
import { SignUp } from "@clerk/nextjs";
import { MailCheck } from "lucide-react";
import { AuthLayout } from "@/components/layout/auth-layout";
import { EmptyState } from "@/components/states/empty-state";
import { signUpAppearance } from "@/lib/ui/clerk-appearance";

export const metadata: Metadata = { title: "Accept your invitation — FlowDineOS" };

/** After accepting an invitation the new user lands on their role home (see /sign-in/landing). */
const AFTER_SIGN_UP = "/sign-in/landing";

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * /sign-up (S1-P03-T005, ADR-006, SC-AUTH-05): accounts are created only from a Clerk invitation. The invitation email
 * links here with a `__clerk_ticket`; without one, a visitor sees "Access is by invitation" and no sign-up form.
 * Clerk's own follow-up steps (/sign-up/verify-email-address, /sign-up/continue) keep rendering the form. The Clerk
 * instance is also set to restricted sign-up, so this page is guidance, not the security boundary.
 */
export default async function SignUpPage({ params, searchParams }: { params: Promise<{ "sign-up"?: string[] }>; searchParams: Promise<SearchParams> }) {
  const [{ "sign-up": step = [] }, query] = await Promise.all([params, searchParams]);
  const ticket = typeof query.__clerk_ticket === "string" && query.__clerk_ticket.length > 0;
  const continuingSignUp = step.length > 0;

  if (!ticket && !continuingSignUp) {
    return (
      <AuthLayout title="Join your restaurant on FlowDineOS">
        <div className="rounded-2xl border border-border-subtle bg-card shadow-e1">
          <EmptyState
            icon={MailCheck}
            title="Access is by invitation"
            description="Your restaurant administrator sends you an invitation email. Open the link in that email to set up your account."
            action={{ href: "/sign-in", label: "Sign in" }}
          />
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Accept your invitation" description="Confirm your email to join your restaurant on RASOIOS.">
      <div className="flex justify-center">
        <SignUp path="/sign-up" routing="path" forceRedirectUrl={AFTER_SIGN_UP} signInForceRedirectUrl={AFTER_SIGN_UP} appearance={signUpAppearance} />
      </div>
    </AuthLayout>
  );
}
