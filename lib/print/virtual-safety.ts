import { NotFoundError } from "@/lib/errors";

/**
 * Production safety gate for Virtual Printing & Emulator (S1-P16-T008, DEV-PRINT-01).
 *
 * Rules:
 * 1. Virtual printing is NEVER silently enabled in production.
 * 2. In production (`NODE_ENV === "production"`), it requires explicit opt-in:
 *    `VIRTUAL_PRINTING_ENABLED="true"` AND `ALLOW_VIRTUAL_PRINTING_IN_PRODUCTION="true"`.
 * 3. In development / test (`NODE_ENV !== "production"`), it is enabled when:
 *    `VIRTUAL_PRINTING_ENABLED="true"` OR `NODE_ENV === "test"`.
 * 4. When disabled, all virtual printing routes, actions, and emulator endpoints fail closed (404 NotFoundError).
 */
export function isVirtualPrintingEnabled(): boolean {
  if (process.env.NODE_ENV === "test") {
    // Tests are allowed to exercise virtual printing unless explicitly turned off
    return process.env.VIRTUAL_PRINTING_ENABLED !== "false";
  }

  if (process.env.NODE_ENV === "production") {
    return (
      process.env.VIRTUAL_PRINTING_ENABLED === "true" &&
      process.env.ALLOW_VIRTUAL_PRINTING_IN_PRODUCTION === "true"
    );
  }

  // Development: enabled by default or with explicit flag
  return process.env.VIRTUAL_PRINTING_ENABLED !== "false";
}

export function assertVirtualPrintingEnabled(): void {
  if (!isVirtualPrintingEnabled()) {
    throw new NotFoundError("Virtual printing is not available in this environment.");
  }
}
