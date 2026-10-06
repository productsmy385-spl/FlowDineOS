/**
 * Audit action catalogue (S1-P04-T010, security.md §7). `audit()` accepts only these names, so an unknown action is
 * a type error. High-frequency telemetry (heartbeats, printer health, polling) is logged, not audited.
 */
export const AUDIT_ACTIONS = [
  // Platform
  "tenant.created",
  "tenant.updated",
  "tenant.suspended",
  "tenant.reactivated",
  "tenant_admin.invited",
  "tenant_admin.invite_revoked",
  "platform.tenant_inspected",
  "platform.role_changed",
  "tenant.handed_over",
  // Identity
  "user.linked",
  "user.status_changed",
  "user.email_synced",
  "user.profile_synced",
  "session.tenant_switched",
  // Staff
  "staff.invited",
  // Staff roles join without an invitation: no email is sent, so saying "invited" would be untrue (ADR-019 §1).
  "staff.added",
  "staff.invite_resent",
  "staff.invite_revoked",
  "staff.activated",
  "staff.role_changed",
  "staff.deactivated",
  "staff.reactivated",
  // Staff daily-password login (ADR-019 §6). Never carries the password or its hash.
  "staff.password_generated",
  "staff.password_regenerated",
  "staff.password_revoked",
  "staff.login",
  "staff.login_failed",
  "staff.logout",
  "staff.force_logout",
  // Restaurant
  "restaurant.profile_updated",
  "restaurant.branding_updated",
  "restaurant.hours_updated",
  "restaurant.settings_updated",
  "restaurant.website_updated",
  "restaurant.theme_updated",
  "restaurant.website_published",
  "restaurant.website_unpublished",
  // Kitchen sections
  "kitchen_section.created",
  "kitchen_section.updated",
  "kitchen_section.archived",
  "kitchen_section.reordered",
  // Menu
  "menu_category.created",
  "menu_category.updated",
  "menu_category.archived",
  "menu_category.reordered",
  "menu_category.published",
  "menu_category.unpublished",
  "menu_item.created",
  "menu_item.updated",
  "menu_item.archived",
  "menu_item.reordered",
  "menu_item.published",
  "menu_item.unpublished",
  "menu_item.price_changed",
  "menu_item.availability_changed",
  "menu_item.variants_updated",
  "menu_item.addons_updated",
  // Daily menu
  "daily_menu.created",
  "daily_menu.copied",
  "daily_menu.updated",
  "daily_menu.items_updated",
  "daily_menu.published",
  "daily_menu.unpublished",
  "daily_menu.deleted",
  // Customers
  "customer.created",
  "customer.updated",
  "customer.archived",
  "customer.anonymized",
  // Orders
  "order.created",
  "order.status_changed",
  "order.cancelled",
  "order.items_added",
  "order.customer_linked",
  "order.priority_changed",
  // KOT
  "kot.generated",
  "kot.status_changed",
  "kot.reprint_requested",
  // Money
  "payment.recorded",
  "refund.created",
  "transaction.voided",
  "day_close.performed",
  // Printing
  "printer.created",
  "printer.updated",
  "printer.deactivated",
  "printer.discovery_requested",
  "print_agent.created",
  "print_agent.paired",
  "print_agent.revoked",
  "print_job.created",
  "print_job.reprint_requested",
  "print_job.retried",
  "print_job.failed",
  "print_job.archived",
  // Social
  "social_post.created",
  "social_post.updated",
  "social_post.marked_ready",
  "social_post.marked_posted",
  "social_post.archived",
  // Media (Q-009)
  "media.uploaded",
  "media.deleted",
  // Brand Kit and table QR codes (RASOIOS-ADR-021)
  "restaurant.brand_kit_updated",
  "dining_table.created",
  "dining_table.updated",
  "dining_table.archived",
  "dining_table.code_rotated",
  // Data management (RASOIOS-ADR-021). The audit log never deletes a `data.*` row, so this record is permanent.
  "data.exported",
  "data.imported",
  "data.deleted",
  "data.backup_reminder_updated",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export function isAuditAction(value: string): value is AuditAction {
  return (AUDIT_ACTIONS as readonly string[]).includes(value);
}
