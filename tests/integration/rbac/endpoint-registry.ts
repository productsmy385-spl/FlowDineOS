import { randomUUID } from "node:crypto";
import {
  createTenantAction,
  inviteTenantAdminAction,
  reactivateTenantAction,
  suspendTenantAction,
  updateTenantAction,
} from "@/app/admin/actions";
import AdminAuditPage from "@/app/admin/audit/page";
import AdminTenantsPage from "@/app/admin/tenants/page";
import AuditPage from "@/app/restaurant/audit/page";
import { getAnalyticsAction } from "@/app/restaurant/analytics/actions";
import { createRefundAction, getDayClosePreviewAction, listTransactionsAction, recordPaymentAction, voidTransactionAction } from "@/app/restaurant/transactions/actions";
import { archiveCustomerAction, createCustomerAction, getCustomersAction, updateCustomerAction } from "@/app/restaurant/customers/actions";
import RestaurantDashboardPage from "@/app/restaurant/dashboard/page";
import { getKOTTicketsAction, updateKOTStatusAction } from "@/app/restaurant/kds/actions";
import { archiveCategoryAction, listMenuCategoriesAction } from "@/app/restaurant/menu/categories-actions";
import { deleteDraftDailyMenuAction, getDailyMenuAction } from "@/app/restaurant/menu/daily-actions";
import { setMenuItemAvailabilityAction } from "@/app/restaurant/menu/items-actions";
import { createStaffOrderAction, getOrdersAction, setOrderPriorityAction, updateOrderStatusAction } from "@/app/restaurant/orders/actions";
import { createTestPrintJobAction, getPrintAgentsAction, getPrintJobsAction, reprintKotAction, retryPrintJobAction } from "@/app/restaurant/printing/actions";
import { updateOperationalSettingsAction, updateRestaurantProfileAction } from "@/app/restaurant/settings/actions";
import { createKitchenSectionAction } from "@/app/restaurant/settings/sections-actions";
import { updateWebsiteSettingsAction } from "@/app/restaurant/settings/website-actions";
import { changeStaffRoleAction, deactivateStaffAction, inviteStaffAction, listStaffAction } from "@/app/restaurant/staff/actions";
import { getSocialPostsAction } from "@/app/restaurant/social/actions";
import { NextRequest } from "next/server";
import { POST as importRoute } from "@/app/api/v1/data/import/route";
import { getDataOverviewAction, purgeDataAction } from "@/app/restaurant/settings/data/actions";
import { editTableAction } from "@/app/restaurant/tables/actions";
import { listDemoRequestsAction, updateDemoRequestAction } from "@/app/admin/demo-requests/actions";
import type { Permission } from "@/lib/auth/permissions";
import { invokeAction, invokeLoader } from "../helpers/actors";

/**
 * RBAC matrix endpoint registry (S1-P05-T002, TC-RBAC-101…150). Each matrix row maps to one representative endpoint
 * whose FIRST check is that permission. Probes are side-effect free: mutations target a random UUID (an allowed role
 * reaches the service and gets NOT_FOUND) or send an extra key (an allowed role reaches validation and gets
 * VALIDATION_ERROR), so the driver can run against the shared seed without changing it.
 *
 * Rows whose endpoint does not exist yet carry the task that builds it (`todo`). TC-RBAC-014 fails once that task is
 * COMPLETED and the row still has no probe.
 */
export type Probe = { endpoint: string; invoke: () => Promise<unknown> };
export type RegistryEntry = Probe | { todo: string };

const RANDOM_UUID = "7f3e2b1a-9c4d-4e8f-a1b2-c3d4e5f60718";

/** Whether a Server Component tree contains an element carrying this `data-testid`. */
function hasTestId(node: unknown, testId: string): boolean {
  if (!node || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some((child) => hasTestId(child, testId));
  const props = (node as { props?: Record<string, unknown> }).props;
  if (!props) return false;
  if (props["data-testid"] === testId) return true;
  return Object.values(props).some((value) => hasTestId(value, testId));
}
const orderTransition = (status: string, extra: Record<string, unknown> = {}): Probe => ({
  endpoint: `updateOrderStatusAction → ${status}`,
  invoke: () => invokeAction(updateOrderStatusAction, { orderId: RANDOM_UUID, status, ...extra } as never),
});
const kotTransition = (toStatus: "PREPARING" | "SERVED"): Probe => ({
  endpoint: `updateKOTStatusAction → ${toStatus}`,
  invoke: () => invokeAction(updateKOTStatusAction, { kotId: RANDOM_UUID, toStatus }),
});

export const ENDPOINT_REGISTRY: Readonly<Record<Permission, RegistryEntry>> = {
  "platform:tenant:read": { endpoint: "AdminTenantsPage (LD-ADM-02)", invoke: () => invokeLoader(AdminTenantsPage, { searchParams: Promise.resolve({}) }) },
  "platform:tenant:create": {
    endpoint: "createTenantAction (SA-ADM-01)",
    invoke: () => invokeAction(createTenantAction, { rbacProbe: true } as never),
  },
  "platform:tenant:update": {
    endpoint: "updateTenantAction (SA-ADM-02)",
    invoke: () => invokeAction(updateTenantAction, { targetTenantId: RANDOM_UUID, name: "RBAC matrix probe" }),
  },
  "platform:tenant:suspend": {
    endpoint: "suspendTenantAction (SA-ADM-03)",
    invoke: () => invokeAction(suspendTenantAction, { targetTenantId: RANDOM_UUID, reason: "RBAC matrix probe reason" }),
  },
  "platform:tenant:reactivate": {
    endpoint: "reactivateTenantAction (SA-ADM-04)",
    invoke: () => invokeAction(reactivateTenantAction, { targetTenantId: RANDOM_UUID }),
  },
  "platform:tenant_admin:invite": {
    endpoint: "inviteTenantAdminAction (SA-ADM-05)",
    invoke: () => invokeAction(inviteTenantAdminAction, { targetTenantId: RANDOM_UUID, email: "rbac.probe+clerk_test@example.com" }),
  },
  "platform:audit:read": { endpoint: "AdminAuditPage (LD-ADM-04)", invoke: () => invokeLoader(AdminAuditPage, { searchParams: Promise.resolve({}) }) },

  // The dashboard page itself only needs `restaurant:read`; `dashboard:read` decides whether the sales figures are
  // rendered at all, so the probe asks the rendered tree rather than the HTTP status.
  "dashboard:read": {
    endpoint: "RestaurantDashboardPage → today's sales section",
    invoke: async () => {
      const page = await invokeLoader(RestaurantDashboardPage);
      if (page && typeof page === "object" && "redirect" in page) return page;
      return hasTestId(page, "dashboard-sales-today")
        ? { ok: true, data: null }
        : { ok: false, error: { code: "FORBIDDEN", message: "No sales figures for this role", requestId: "rbac-probe" } };
    },
  },
  "restaurant:read": { endpoint: "RestaurantDashboardPage", invoke: () => invokeLoader(RestaurantDashboardPage) },
  "restaurant:update": {
    endpoint: "updateRestaurantProfileAction (SA-RST-01)",
    invoke: () => invokeAction(updateRestaurantProfileAction, { rbacProbe: true } as never),
  },
  "restaurant:settings:update": {
    endpoint: "updateOperationalSettingsAction (SA-RST-04)",
    invoke: () => invokeAction(updateOperationalSettingsAction, { rbacProbe: true } as never),
  },
  "website:update": {
    endpoint: "updateWebsiteSettingsAction (SA-RST-05)",
    invoke: () => invokeAction(updateWebsiteSettingsAction, { rbacProbe: true } as never),
  },
  "kitchen_section:manage": {
    endpoint: "createKitchenSectionAction (SA-KSEC-01)",
    invoke: () => invokeAction(createKitchenSectionAction, { rbacProbe: true } as never),
  },
  "staff:read": { endpoint: "listStaffAction (LD-STF-01)", invoke: () => invokeAction(listStaffAction, {}) },
  "staff:invite": {
    endpoint: "inviteStaffAction (SA-STF-01)",
    invoke: () => invokeAction(inviteStaffAction, { rbacProbe: true } as never),
  },
  "staff:update_role": {
    endpoint: "changeStaffRoleAction (SA-STF-04)",
    invoke: () => invokeAction(changeStaffRoleAction, { membershipId: RANDOM_UUID, role: "WAITER" }),
  },
  "staff:deactivate": {
    endpoint: "deactivateStaffAction (SA-STF-05)",
    invoke: () => invokeAction(deactivateStaffAction, { membershipId: RANDOM_UUID }),
  },

  "menu:read": { endpoint: "listMenuCategoriesAction (LD-MENU-01)", invoke: () => invokeAction(listMenuCategoriesAction) },
  "menu:manage": { endpoint: "archiveCategoryAction", invoke: () => invokeAction(archiveCategoryAction, { categoryId: RANDOM_UUID }) },
  "menu:availability:update": {
    endpoint: "setMenuItemAvailabilityAction",
    invoke: () => invokeAction(setMenuItemAvailabilityAction, { itemId: RANDOM_UUID, available: true }),
  },
  "daily_menu:read": { endpoint: "getDailyMenuAction", invoke: () => invokeAction(getDailyMenuAction, { businessDate: "2026-09-15" }) },
  "daily_menu:manage": { endpoint: "deleteDraftDailyMenuAction", invoke: () => invokeAction(deleteDraftDailyMenuAction, { dailyMenuId: RANDOM_UUID }) },

  "order:read": { endpoint: "getOrdersAction (LD-ORD-01)", invoke: () => invokeAction(getOrdersAction, {}) },
  "order:create": {
    endpoint: "createStaffOrderAction (SA-ORD-01)",
    invoke: () => invokeAction(createStaffOrderAction, { orderType: "TAKEAWAY", items: [] } as never),
  },
  "order:add_items": { todo: "S1-P12-T010" },
  "order:accept": orderTransition("ACCEPTED"),
  "order:kitchen_update": orderTransition("PREPARING"),
  "order:complete": orderTransition("COMPLETED"),
  "order:cancel": orderTransition("CANCELLED", { reason: "RBAC matrix probe" }),
  "order:update_meta": {
    endpoint: "setOrderPriorityAction (SA-ORD-06)",
    invoke: () => invokeAction(setOrderPriorityAction, { orderId: RANDOM_UUID, priority: "NORMAL" }),
  },

  "kot:read": { endpoint: "getKOTTicketsAction (LD-KOT-01)", invoke: () => invokeAction(getKOTTicketsAction, {}) },
  "kot:update_status": kotTransition("PREPARING"),
  "kot:serve": kotTransition("SERVED"),
  "kot:reprint": { endpoint: "reprintKotAction (SA-KOT-02)", invoke: () => invokeAction(reprintKotAction, { kotId: RANDOM_UUID }) },

  "customer:read": { endpoint: "getCustomersAction (LD-CUS-01)", invoke: () => invokeAction(getCustomersAction, {}) },
  "customer:create": {
    endpoint: "createCustomerAction (SA-CUS-01)",
    invoke: () => invokeAction(createCustomerAction, { rbacProbe: true } as never),
  },
  "customer:update": {
    endpoint: "updateCustomerAction (SA-CUS-02)",
    invoke: () => invokeAction(updateCustomerAction, { customerId: RANDOM_UUID, fullName: "RBAC matrix probe" }),
  },
  "customer:archive": {
    endpoint: "archiveCustomerAction (SA-CUS-03)",
    invoke: () => invokeAction(archiveCustomerAction, { customerId: RANDOM_UUID }),
  },

  "transaction:read": { endpoint: "listTransactionsAction (LD-TXN-01)", invoke: () => invokeAction(listTransactionsAction, {}) },
  "payment:record": {
    endpoint: "recordPaymentAction (SA-TXN-01)",
    invoke: () => invokeAction(recordPaymentAction, { orderId: RANDOM_UUID, idempotencyKey: randomUUID(), method: "CASH", amount: "1.00", amountTendered: "1.00" }),
  },
  "refund:create": {
    endpoint: "createRefundAction (SA-TXN-02)",
    invoke: () => invokeAction(createRefundAction, { paymentTransactionId: RANDOM_UUID, idempotencyKey: randomUUID(), amount: "1.00", reason: "RBAC matrix probe" }),
  },
  "transaction:void": {
    endpoint: "voidTransactionAction (SA-TXN-03)",
    invoke: () => invokeAction(voidTransactionAction, { transactionId: RANDOM_UUID, reason: "RBAC matrix probe" }),
  },
  "day_close:perform": {
    endpoint: "getDayClosePreviewAction (LD-TXN-02)",
    invoke: () => invokeAction(getDayClosePreviewAction, {}),
  },

  "printer:manage": { endpoint: "createTestPrintJobAction", invoke: () => invokeAction(createTestPrintJobAction, { printerId: RANDOM_UUID }) },
  "print_agent:manage": { endpoint: "getPrintAgentsAction (LD-PRN-03)", invoke: () => invokeAction(getPrintAgentsAction) },
  "print_job:read": { endpoint: "getPrintJobsAction (LD-PRN-02)", invoke: () => invokeAction(getPrintJobsAction, {}) },
  "print_job:retry": { endpoint: "retryPrintJobAction (SA-PRN-05)", invoke: () => invokeAction(retryPrintJobAction, { jobId: RANDOM_UUID }) },

  "report:read": { endpoint: "getAnalyticsAction (LD-RPT-01)", invoke: () => invokeAction(getAnalyticsAction, { timeframe: "today" }) },
  "social:manage": { endpoint: "getSocialPostsAction", invoke: () => invokeAction(getSocialPostsAction, {}) },
  "audit:read": {
    endpoint: "AuditPage (LD-AUD-01)",
    invoke: () => invokeLoader(AuditPage, { searchParams: Promise.resolve({}) }),
  },
  "data:export": { endpoint: "getDataOverviewAction (LD-DATA-01)", invoke: () => invokeAction(getDataOverviewAction) },
  "data:import": {
    endpoint: "POST /api/v1/data/import (RH-DATA-02)",
    // A body that is not a form: an allowed role gets past the guard to validation (422); a denied one is refused first.
    invoke: async () => {
      const response = await importRoute(
        new NextRequest("http://localhost:3000/api/v1/data/import", { method: "POST", headers: { origin: "http://localhost:3000", "sec-fetch-site": "same-origin", "content-type": "text/plain" }, body: "probe" }),
        undefined as never,
      );
      const body = (await response.json()) as { error: { code: string } };
      return { ok: false, error: { code: response.status === 422 ? "VALIDATION_ERROR" : body.error.code } };
    },
  },
  "data:purge": {
    endpoint: "purgeDataAction (SA-DATA-03)",
    invoke: () => invokeAction(purgeDataAction, { categories: ["orders"], before: "2026-01-01", backupId: RANDOM_UUID, confirmation: "probe", rbacProbe: true } as never),
  },
  "table:manage": { endpoint: "editTableAction (SA-TBL-02)", invoke: () => invokeAction(editTableAction, { id: RANDOM_UUID, label: "Probe" }) },
  "platform:demo_request:read": { endpoint: "listDemoRequestsAction (LD-ADM-10)", invoke: () => invokeAction(listDemoRequestsAction, {}) },
  "platform:demo_request:update": { endpoint: "updateDemoRequestAction (SA-ADM-11)", invoke: () => invokeAction(updateDemoRequestAction, { id: RANDOM_UUID, status: "CONTACTED" }) },
};
