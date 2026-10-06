/**
 * Application error model (S1-P04-T005, api.md §1.2). Every error the client can see has a stable `code`, an HTTP
 * `statusCode` and a human message that never contains SQL, stack traces, provider responses or other tenants' data.
 *
 * Tenant rule (SC-TEN-04): a resource that is missing and a resource that belongs to another tenant both produce
 * `NotFoundError`. `ForbiddenError` is only for permission checks made *before* any resource is loaded.
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  /**
   * Extra fields a contract promises the client for this error code, e.g. the existing customer's id in SA-CUS-01's
   * `PHONE_EXISTS`. It crosses the wire exactly as written, so it holds only what the contract names — never a
   * provider response, a query or another tenant's data.
   */
  public readonly details?: Readonly<Record<string, unknown>>;

  constructor(message: string, statusCode = 400, code = "BAD_REQUEST", details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    if (details) this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** 401 — no Clerk session. */
export class UnauthenticatedError extends AppError {
  constructor(message = "Sign in to continue.") {
    super(message, 401, "UNAUTHENTICATED");
  }
}

/** 403 — signed in, but no active account or membership (uninvited, deactivated, or no active restaurant). */
export class NoActiveMembershipError extends AppError {
  constructor(message = "You don't have access to a restaurant. Ask your restaurant administrator for an invitation.") {
    super(message, 403, "NO_ACTIVE_MEMBERSHIP");
  }
}

/** 403 — the active restaurant is suspended by the platform. */
export class TenantSuspendedError extends AppError {
  constructor(message = "This restaurant account is suspended. Contact the platform administrator.") {
    super(message, 403, "TENANT_SUSPENDED");
  }
}

/** 409 — the user belongs to several restaurants and has not chosen one (ADR-006 §3). */
export class TenantSelectionRequiredError extends AppError {
  constructor(message = "Choose a restaurant to continue.") {
    super(message, 409, "TENANT_SELECTION_REQUIRED");
  }
}

/** 403 — the role lacks the permission (checked before loading any resource). */
export class ForbiddenError extends AppError {
  constructor(message = "You don't have permission to do this.") {
    super(message, 403, "FORBIDDEN");
  }
}

/** 404 — missing, or owned by another tenant (indistinguishable by design). */
/** A feature the platform owner has switched off for this restaurant (RASOIOS-ADR-023). 403, not a role problem. */
export class FeatureDisabledError extends AppError {
  constructor(featureLabel: string) {
    super(`${featureLabel} is not enabled for this restaurant. Contact the platform owner to turn it on.`, 403, "FEATURE_DISABLED");
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not found.") {
    super(message, 404, "NOT_FOUND");
  }
}

/**
 * 422 — input failed validation. `fieldErrors` maps field paths to messages. `code` is VALIDATION_ERROR unless a
 * contract names a more specific 422 (e.g. ITEM_UNAVAILABLE, VARIANT_REQUIRED, INVALID_ADDON — api.md SA-ORD-01).
 */
export class ValidationError extends AppError {
  public readonly fieldErrors?: Record<string, string[]>;

  constructor(message = "Check the highlighted fields.", fieldErrors?: Record<string, string[]>, code = "VALIDATION_ERROR") {
    super(message, 422, code);
    this.fieldErrors = fieldErrors;
  }

  /** Baseline name for `fieldErrors`. */
  get errors(): Record<string, string[]> | undefined {
    return this.fieldErrors;
  }
}

export class ConflictError extends AppError {
  constructor(message = "The resource was changed or already exists", code = "CONFLICT", details?: Readonly<Record<string, unknown>>) {
    super(message, 409, code, details);
  }
}

/** 429 — rate limited (ADR-011). */
export class RateLimitedError extends AppError {
  constructor(public readonly retryAfterSec: number, message = "Too many requests. Try again shortly.") {
    super(message, 429, "RATE_LIMITED");
  }
}

/** Temporary infrastructure failure (e.g. a database statement timeout). The message never includes internals. */
export class ServiceUnavailableError extends AppError {
  constructor(message = "Service temporarily unavailable, please retry") {
    super(message, 503, "SERVICE_UNAVAILABLE");
  }
}
