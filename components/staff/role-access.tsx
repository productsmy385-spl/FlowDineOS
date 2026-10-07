import { CheckCircle2, XCircle } from "lucide-react";
import type { TenantRole } from "@prisma/client";
import { Card } from "@/components/ui/card";
import { permissionsForTenantRole } from "@/lib/auth/permissions";
import { NAV_ITEMS, roleLabel } from "@/lib/ui/navigation";

/**
 * "What each role can open" (owner request 2026-10-07). Built from the same permission table the server enforces on
 * every page, action and API (`lib/auth/permissions.ts`), so this table cannot drift from what is actually allowed.
 */
const ROLES: TenantRole[] = ["TENANT_ADMIN", "MANAGER", "CASHIER", "KITCHEN", "WAITER"];

export function RoleAccess() {
  const areas = NAV_ITEMS;
  return (
    <Card padding="feature" className="flex flex-col gap-4" data-testid="role-access">
      <div>
        <h2 className="text-heading text-fg-primary">What each role can open</h2>
        <p className="mt-1 text-body text-fg-secondary">
          Enforced on the server for every page and action — hiding a menu item is never the safeguard. Owners and administrators can open everything.
        </p>
      </div>
      <div className="overflow-x-auto rounded-xl border border-border-subtle">
        <table className="w-full min-w-[40rem] text-left text-body">
          <caption className="sr-only">Areas each staff role can open</caption>
          <thead className="bg-raised text-caption text-fg-secondary">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">
                Area
              </th>
              {ROLES.map((role) => (
                <th key={role} scope="col" className="px-3 py-2 text-center font-medium">
                  {roleLabel(role)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {areas.map((area) => (
              <tr key={area.key} className="border-t border-border-subtle">
                <th scope="row" className="px-3 py-2 font-normal text-fg-primary">
                  {area.label}
                </th>
                {ROLES.map((role) => {
                  const allowed = permissionsForTenantRole(role).has(area.capability);
                  return (
                    <td key={role} className="px-3 py-2 text-center">
                      {allowed ? (
                        <CheckCircle2 aria-label="Can open" className="mx-auto size-5 text-status-success" />
                      ) : (
                        <XCircle aria-label="Cannot open" className="mx-auto size-5 text-fg-secondary" />
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
