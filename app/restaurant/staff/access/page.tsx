import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/page-header";
import { ErrorState } from "@/components/states/error-state";
import { StaffAccessBoard } from "@/components/staff/staff-access-board";
import { requireTenantPage } from "@/lib/auth/guards";
import { listStaffAccessAction } from "../actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Daily passwords & attendance" };

/**
 * `/restaurant/staff/access` (RASOIOS-ADR-019, C12/C13/C16).
 *
 * Today's passwords, who is on shift right now, and the recent attendance — the three things an administrator
 * actually does with staff sign-in, on one page rather than three.
 *
 * The page guard resolves `staff:read`, and the loader additionally refuses anyone who is not a TENANT_ADMIN, so a
 * MANAGER reaching this URL gets the error state rather than the data. The restaurant comes from the session; there
 * is nothing in the URL to change.
 */
export default async function StaffAccessPage() {
  const ctx = await requireTenantPage("staff:read");
  const access = await listStaffAccessAction({ days: 7 });

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col">
      <PageHeader
        title="Daily passwords & attendance"
        description="Generate the password your counter and kitchen staff sign in with today, see who is on shift, and review hours worked."
      />

      {access.ok ? (
        <StaffAccessBoard
          standing={access.data.standing}
          sessions={access.data.sessions}
          from={access.data.from}
          to={access.data.to}
          timezone={ctx.restaurant.timezone}
        />
      ) : (
        <ErrorState requestId={access.error.requestId} message={access.error.message} />
      )}
    </div>
  );
}
