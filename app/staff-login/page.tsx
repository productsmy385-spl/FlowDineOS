import type { Metadata } from "next";
import { Mail } from "lucide-react";
import { SignInAudience, SignInDoor } from "@/components/layout/sign-in-door";
import { AuthLayout } from "@/components/layout/auth-layout";
import { StaffLoginForm } from "./staff-login-form";

export const metadata: Metadata = { title: "Staff sign in — RASOIOS" };
export const dynamic = "force-dynamic";

/**
 * Staff sign-in (RASOIOS-ADR-019, C6). A separate door from `/sign-in`: staff use the password their administrator
 * generates for the day, and administrators and managers use the identity provider as they always have.
 *
 * No restaurant is named or chosen here. The password itself determines which restaurant the person is signing in
 * to, so nothing on this page can be changed to reach a different one (C19).
 */
export default function StaffLoginPage() {
  return (
    <AuthLayout title="Staff sign in" description="Enter the password your restaurant administrator generated for today.">
      <SignInAudience>Cashier, kitchen or waiter</SignInAudience>
      <StaffLoginForm />
      <SignInDoor href="/sign-in" icon={Mail} title="Owner, administrator or manager?" detail="Sign in with a one-time code sent to your work email" />
    </AuthLayout>
  );
}
