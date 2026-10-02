import type { Metadata } from "next";
import Link from "next/link";
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
    <AuthLayout
      title="Staff sign in"
      description="Enter the password your restaurant administrator generated for today."
      footer={
        <>
          Administrator or manager?{" "}
          <Link href="/sign-in" className="text-fg-accent hover:underline">
            Sign in with your email
          </Link>
        </>
      }
    >
      <StaffLoginForm />
    </AuthLayout>
  );
}
