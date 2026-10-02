"use client";

import * as React from "react";
import { useAuth, useClerk } from "@clerk/nextjs";
import { LogOut } from "lucide-react";
import { clearActiveTenantCookieAction } from "@/app/sign-in/actions";
import { staffSignOutAction } from "@/app/staff-login/actions";
import { Button, type ButtonProps } from "@/components/ui/button";

/**
 * Sign-out flow (S1-P03-T005, SC-SESS-03): clear the active-restaurant preference cookie on the server, then end the
 * Clerk session and land on /sign-in. If clearing fails (e.g. offline), Clerk still signs out and /sign-in clears
 * the leftover cookie on arrival.
 */
/**
 * Signs out whoever this browser is holding, by whichever credential they used.
 *
 * Counter staff sign in with a daily password, not Clerk (ADR-019), so a Clerk-only sign-out did nothing for them:
 * their shift stayed open, the hours kept counting, and the cookie still opened the console. The staff session is
 * now ended server-side first — which is also what records the end of the shift — and Clerk second, for anyone
 * signed in that way.
 */
export function useSignOut(): { signOut: () => Promise<void>; pending: boolean } {
  const clerk = useClerk();
  const { isSignedIn } = useAuth();
  const [pending, setPending] = React.useState(false);
  const signOut = React.useCallback(async () => {
    setPending(true);
    try {
      await clearActiveTenantCookieAction();
    } catch {
      // Cleared on arrival at /sign-in instead.
    }
    try {
      await staffSignOutAction();
    } catch {
      // The cookie, if any, is still checked against the database on every request; a failed sign-out here leaves
      // nothing that outlives the session's own expiry.
    }
    if (isSignedIn) {
      await clerk.signOut({ redirectUrl: "/sign-in" });
      return;
    }
    window.location.assign("/staff-login");
  }, [clerk, isSignedIn]);
  return { signOut, pending };
}

export function SignOutButton({ variant = "secondary", className, children = "Sign out" }: Pick<ButtonProps, "variant" | "className" | "children">) {
  const { signOut, pending } = useSignOut();
  return (
    <Button variant={variant} icon={LogOut} loading={pending} loadingLabel="Signing out…" onClick={() => void signOut()} className={className}>
      {children}
    </Button>
  );
}
