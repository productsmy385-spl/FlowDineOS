import { requireTenantPage } from "@/lib/auth/guards";

/**
 * Social posts is a client page, so its server-side guard lives here: members without `social:manage` are sent to
 * /account/forbidden before the screen renders (TC-ROLE-010). Every action it calls is checked again on the server.
 */
export default async function Layout({ children }: { children: React.ReactNode }) {
  await requireTenantPage("social:manage");
  return children;
}
