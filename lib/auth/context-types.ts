/**
 * Request contexts (S1-P02-T005; resolution implemented in S1-P04-T001; contract in
 * knowledge/implementation/slice-01/tenant-isolation.md §2.1).
 *
 * Every tenant identifier in these types comes from the database row the server resolved for the authenticated
 * caller (USER_TENANT for staff, PRINT_AGENT for agents) — never from request input (CLAUDE.md rule 2, ADR-003).
 */
import type { TenantRole } from "@prisma/client";
import type { Permission } from "./permissions";

export type TenantContext = {
  kind: "tenant";
  requestId: string;
  /** USER.id */
  userId: string;
  /** USER_TENANT.id */
  membershipId: string;
  /** USER_TENANT.tenant_id — read from the database, never from input. */
  tenantId: string;
  /** USER_TENANT.role — read from the database. */
  role: TenantRole;
  permissions: ReadonlySet<Permission>;
  restaurant: { id: string; timezone: string; currencyCode: string };
  /** Features switched off for this restaurant by the platform owner (RASOIOS-ADR-023); their permissions are absent. */
  disabledFeatures?: ReadonlySet<string>;
};

export type PlatformContext = {
  kind: "platform";
  requestId: string;
  userId: string;
  permissions: ReadonlySet<Permission>;
};

export type AgentContext = {
  kind: "agent";
  requestId: string;
  agentId: string;
  /** PRINT_AGENT.tenant_id of the agent whose token authenticated the request. */
  tenantId: string;
  printerIds: readonly string[];
};

/** Background work with no human or agent actor (e.g. maintenance jobs). */
export type SystemContext = {
  kind: "system";
  requestId: string;
  job: string;
};

export type RequestContext = TenantContext | PlatformContext | AgentContext | SystemContext;

/** Contexts that are bound to exactly one tenant. */
export type TenantScopedContext = TenantContext | AgentContext;
