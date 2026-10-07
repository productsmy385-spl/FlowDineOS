import { redirect } from "next/navigation";
import { getPlatformResolution, getTenantResolution } from "@/lib/auth/context";
import { accountRedirectFor } from "@/lib/auth/guards";
import { roleHomePath } from "@/lib/ui/navigation";
import { CompletingSignIn } from "./completing-sign-in";

export const dynamic = "force-dynamic";

/**
 * Post-sign-in landing (S1-P03-T005, frontend.md §5.1): the one place that decides where a person goes after Clerk
 * verifies their one-time code. Platform administrators go to the platform console; everyone else goes straight to
 * the page their role actually starts on, and a user who cannot open a console goes to the matching /account page.
 *
 * It resolves the destination *in full* rather than handing off to `/restaurant`: that second page repeated the same
 * session and membership lookups only to redirect again, so every sign-in cost an extra server round-trip before
 * anything was drawn. `getPlatformResolution` and `getTenantResolution` share one request-memoised session read, so
 * deciding here costs one membership query instead.
 *
 * Renders nothing, reads no tenant data, and never trusts a client-supplied destination: the role, not the request,
 * chooses the page, and every page it can send someone to checks the session and permissions again itself.
 */
export default async function SignInLanding() {
  const platform = await getPlatformResolution();
  if (platform.outcome === "OK") redirect("/admin");
  // Straight after Clerk signs someone in, this request can arrive before the session cookie does. Bouncing to
  // /sign-in then left the form on screen until a manual reload (owner report 2026-10-07); instead the browser asks
  // again until the server sees the session, and goes back to the form only if Clerk has none.
  if (platform.outcome === "SIGNED_OUT") return <CompletingSignIn />;

  const tenant = await getTenantResolution();
  redirect(tenant.outcome === "OK" ? roleHomePath(tenant.ctx.role) : accountRedirectFor(tenant));
}
