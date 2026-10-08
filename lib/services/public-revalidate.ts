import "server-only";
import { revalidatePath } from "next/cache";
import type { TenantContext } from "@/lib/auth/context-types";
import { tenantSlug } from "@/lib/data/restaurant";
import { logger } from "@/lib/logger";

/**
 * Public-site cache invalidation (api.md §7: ISR `revalidate: 60` plus `revalidatePath` on publishing mutations).
 *
 * Called *after* the transaction that changed something the public page shows (a published category, item, price or
 * daily menu). The write has already committed, so a revalidation failure — outside a request scope, for instance —
 * is logged and swallowed: it must never turn a successful save into a failed one. The ISR window then bounds the
 * staleness at 60 seconds.
 */
/**
 * The console layout shows the restaurant's logo (`session.activeTenant.logoUrl`). After a branding save, re-render it
 * so the header updates without a reload — Next.js refreshes the calling page when a server action revalidates.
 */
export function revalidateConsoleShell(ctx: TenantContext): void {
  try {
    revalidatePath("/restaurant", "layout");
  } catch (error) {
    logger.warn("console.revalidate_failed", { requestId: ctx.requestId, tenantId: ctx.tenantId, error: error instanceof Error ? error.message : String(error) });
  }
}

export async function revalidatePublicSite(ctx: TenantContext): Promise<void> {
  try {
    revalidatePath(`/r/${await tenantSlug(ctx)}`);
  } catch (error) {
    logger.warn("public.revalidate_failed", {
      requestId: ctx.requestId,
      tenantId: ctx.tenantId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
