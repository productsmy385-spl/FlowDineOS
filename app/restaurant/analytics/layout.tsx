import { requireTenantPage } from "@/lib/auth/guards";

/**
 * Analytics is a client page, so its server-side guard lives here: members without `report:read` are sent to
 * /account/forbidden before the screen renders (TC-ROLE-010). Every action it calls is checked again on the server.
 */
export default async function Layout({ children }: { children: React.ReactNode }) {
  await requireTenantPage("report:read");
  return children;
}
