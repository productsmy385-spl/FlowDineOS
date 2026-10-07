"use server";

import { action } from "@/lib/http/action";
import { submitDemoRequest } from "@/lib/services/demo-requests";
import { parseInput } from "@/lib/validation/core";
import { requestDemoSchema, type RequestDemoInput } from "@/lib/validation/demo";

/**
 * SA-PUB-02 — Book a demo (RASOIOS-ADR-024). Public by design: a visitor has no account. Validated, rate limited by
 * address and email and spam-trapped in the service; it can only ever create a request, never read one.
 */
export const requestDemoAction = action(async (input: RequestDemoInput) => {
  return submitDemoRequest(parseInput(requestDemoSchema, input));
});
