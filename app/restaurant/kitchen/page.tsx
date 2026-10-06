import type { KotStatus } from "@prisma/client";
import { KitchenBoard } from "@/components/kitchen/kitchen-board";
import { requireTenantPage } from "@/lib/auth/guards";
import { hasPermission } from "@/lib/auth/permissions";
import { kitchenBoard } from "@/lib/data/kitchen";
import { listKitchenSections } from "@/lib/data/kot";

export const dynamic = "force-dynamic";

/**
 * LD-KOT-01 — `/restaurant/kitchen` (S1-P15-T002, `kot:read`). Rendered in the focus shell (FOCUS_ROUTES), so the
 * board owns the screen. The first page comes from the server; the client then polls RH-KOT-01 every 5 s (ADR-009).
 * The payload is the kitchen projection — no customer data, no amounts — for every role that opens it.
 */
export default async function KitchenPage() {
  const ctx = await requireTenantPage("kot:read");
  const [board, sections] = await Promise.all([kitchenBoard(ctx, {}), listKitchenSections(ctx)]);

  // security.md §3.4: starting and readying a ticket is `kot:update_status`, serving it is `kot:serve`.
  const allowedTargets: KotStatus[] = [
    ...(hasPermission(ctx, "kot:update_status") ? (["PREPARING", "READY"] as KotStatus[]) : []),
    ...(hasPermission(ctx, "kot:serve") ? (["SERVED"] as KotStatus[]) : []),
  ];

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-display-m text-fg-primary">Kitchen</h1>
      <KitchenBoard initial={board} sections={sections} timezone={ctx.restaurant.timezone} allowedTargets={allowedTargets} canOpenOrder={hasPermission(ctx, "order:read")} canReprint={hasPermission(ctx, "kot:reprint")} />
    </div>
  );
}
