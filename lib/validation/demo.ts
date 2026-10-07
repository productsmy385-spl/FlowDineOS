import { z } from "zod";
import { boundedText, businessDateParam, emailField, optionalText, strictObject, uuidParam } from "./core";

/** Book-a-demo inputs (RASOIOS-ADR-024). Public form: every field bounded, nothing free-form beyond the message. */

/** Indian mobiles may be typed as 10 digits; anything else must already be international (+…). */
export const demoPhoneField = z
  .string()
  .trim()
  .transform((value) => value.replace(/[\s()-]/g, ""))
  .transform((value) => (/^[6-9]\d{9}$/.test(value) ? `+91${value}` : /^0[6-9]\d{9}$/.test(value) ? `+91${value.slice(1)}` : value))
  .pipe(z.string().regex(/^\+[1-9]\d{7,14}$/, "Enter a mobile number, e.g. 9390038335 or +91 93900 38335"));

export const DEMO_STATUSES = ["NEW", "CONTACTED", "SCHEDULED", "COMPLETED", "CANCELLED"] as const;

export const requestDemoSchema = strictObject({
  name: boundedText(120, { min: 2, label: "Your name" }),
  businessName: boundedText(160, { min: 2, label: "Restaurant or business name" }),
  phone: demoPhoneField,
  email: emailField,
  city: boundedText(80, { min: 2, label: "City" }),
  preferredDate: businessDateParam,
  preferredTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Choose a time"),
  outletCount: z.coerce.number().int().min(1, "At least 1").max(999).optional(),
  message: optionalText(1000, "Message"),
  /** Spam trap: a field people never see. Anything in it means a bot filled the form. */
  website: z.string().max(200).optional(),
});
export type RequestDemoInput = z.input<typeof requestDemoSchema>;

export const listDemoRequestsSchema = strictObject({ status: z.enum(DEMO_STATUSES).optional() });
export type ListDemoRequestsInput = z.input<typeof listDemoRequestsSchema>;

export const updateDemoRequestSchema = strictObject({
  id: uuidParam,
  status: z.enum(DEMO_STATUSES).optional(),
  notes: optionalText(2000, "Notes"),
});
export type UpdateDemoRequestInput = z.input<typeof updateDemoRequestSchema>;
