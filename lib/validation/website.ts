/**
 * Public website theme, identity and section input (S1-P07-T010; api.md SA-WEB-01…03; data-model.md E02, E02a;
 * RASOIOS-ADR-013 §6).
 *
 * Every schema is a `strictObject`, so `tenantId` or any other unknown key is rejected with 422 (SC-VAL-01, SC-TEN-01).
 * Colours are `#RRGGBB`, normalised to uppercase to match the database CHECK constraints. Contrast is *not* checked
 * here: it depends on the resolved palette (a preset supplies its own colours), so it is enforced in
 * `lib/services/website-theme.ts` and reported as field errors with the measured ratio.
 *
 * Every text field is plain text. Nothing is ever interpreted as markup: the server stores exactly what was typed and
 * React escapes it on render (SC-VAL-03). Only control characters are removed, because they are invisible and would
 * corrupt printed output and logs.
 */
import { z } from "zod";
import { strictObject } from "./core";
import { IMAGE_URL_MAX_LENGTH, imageUrlOrBlank } from "./url";

// ─── Enumerations (mirror the Prisma enums; kept as literals so this module has no Prisma import) ───

export const WEBSITE_THEME_PRESETS = ["PLATFORM", "CITRUS", "OCEAN", "BERRY", "CUSTOM"] as const;
export type WebsiteThemePresetName = (typeof WEBSITE_THEME_PRESETS)[number];

export const WEBSITE_SURFACE_MODES = ["DARK", "LIGHT"] as const;
export type WebsiteSurfaceModeName = (typeof WEBSITE_SURFACE_MODES)[number];

export const WEBSITE_SECTION_KEYS = [
  "HERO",
  "ABOUT",
  "FEATURED_MENU",
  "CATEGORIES",
  "POPULAR_ITEMS",
  "INFO",
  "HOURS",
  "GALLERY",
  "LOCATION",
  "CONTACT",
  "CTA",
] as const;
export type WebsiteSectionKeyName = (typeof WEBSITE_SECTION_KEYS)[number];

/** HERO is the page's first impression and its heading: it can be edited but never disabled (ADR-013 §6). */
export const ALWAYS_ENABLED_SECTION: WebsiteSectionKeyName = "HERO";

export const MAX_SECTION_SORT_ORDER = 999;

export type WebsiteSectionDefault = {
  /** Whether a newly provisioned restaurant shows this section before anyone edits it. */
  enabled: boolean;
  sortOrder: number;
  /** Heading used when the restaurant has not written its own. A label, never fabricated content. */
  headline: string;
};

/**
 * The layout a new restaurant gets (S1-P06-T009). Sections that need material the restaurant has not supplied yet —
 * a photo gallery, order history for "popular items" — start disabled, so nothing renders empty or invented.
 * A missing row means "use this default" (data-model E02a), so an older restaurant renders a complete site too.
 */
export const WEBSITE_SECTION_DEFAULTS: Readonly<Record<WebsiteSectionKeyName, WebsiteSectionDefault>> = {
  HERO: { enabled: true, sortOrder: 0, headline: "Welcome" },
  ABOUT: { enabled: true, sortOrder: 10, headline: "About us" },
  FEATURED_MENU: { enabled: true, sortOrder: 20, headline: "From our menu" },
  CATEGORIES: { enabled: true, sortOrder: 30, headline: "Menu" },
  POPULAR_ITEMS: { enabled: false, sortOrder: 40, headline: "Most ordered" },
  INFO: { enabled: true, sortOrder: 50, headline: "Good to know" },
  HOURS: { enabled: true, sortOrder: 60, headline: "Opening hours" },
  GALLERY: { enabled: false, sortOrder: 70, headline: "Gallery" },
  LOCATION: { enabled: true, sortOrder: 80, headline: "Find us" },
  CONTACT: { enabled: true, sortOrder: 90, headline: "Contact" },
  CTA: { enabled: true, sortOrder: 100, headline: "Order now" },
};

// ─── Colours ───

export const HEX_COLOUR = /^#[0-9A-Fa-f]{6}$/;

/** WCAG 2.1 AA for body text and for a colour used as a text/graphic colour on the page surface. */
export const MIN_THEME_CONTRAST = 4.5;

const hexColour = (label: string) =>
  z
    .string()
    .trim()
    .regex(HEX_COLOUR, `${label} must be a colour like #1F2937`)
    .transform((value) => value.toUpperCase());

const blankToNull = (value: unknown) => (typeof value === "string" && value.trim() === "" ? null : value);

/** Omitted → `undefined` (column unchanged); `""` or `null` → `null` (column cleared); otherwise validated. */
function clearable<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(blankToNull, schema.nullable().optional());
}

// ─── Links ───

/**
 * An outbound link a restaurant publishes on its own site (social profile, map). It is never fetched by the server
 * and is rendered with `rel="noopener noreferrer"`, so the rules are: `https:` only (no `javascript:`, `data:` or
 * mixed content), a real host name (no IP literal, no port, no credentials) and at most 2048 characters. Unlike an
 * image URL it is not restricted to `ALLOWED_IMAGE_HOSTS`: a restaurant's Instagram page is not an image host.
 */
export type LinkProblem = "INVALID" | "TOO_LONG" | "NOT_HTTPS" | "CREDENTIALS" | "IP_LITERAL" | "PORT";
export type LinkCheck = { ok: true; url: string } | { ok: false; problem: LinkProblem; message: string };

const IPV4_LIKE = /^[0-9.]+$/;

function hasControlOrSpace(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

export function checkHttpsLink(raw: string): LinkCheck {
  if (raw.length > IMAGE_URL_MAX_LENGTH) return { ok: false, problem: "TOO_LONG", message: `Use a link of at most ${IMAGE_URL_MAX_LENGTH} characters` };
  if (raw === "" || hasControlOrSpace(raw)) return { ok: false, problem: "INVALID", message: "Enter a valid link" };

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, problem: "INVALID", message: "Enter a valid link" };
  }
  if (url.protocol !== "https:") return { ok: false, problem: "NOT_HTTPS", message: "Use an https:// link" };

  const authority = raw.slice(raw.indexOf("//") + 2).split(/[/?#\\]/)[0];
  if (url.username !== "" || url.password !== "" || authority.includes("@")) {
    return { ok: false, problem: "CREDENTIALS", message: "Links must not contain a user name or password" };
  }
  const host = url.hostname.toLowerCase();
  if (host.startsWith("[") || IPV4_LIKE.test(host) || !host.includes(".")) {
    return { ok: false, problem: "IP_LITERAL", message: "Use the site's name, not an IP address" };
  }
  if (url.port !== "") return { ok: false, problem: "PORT", message: "Remove the port number from the link" };
  return { ok: true, url: url.href };
}

function linkField(label: string) {
  return z
    .string()
    .trim()
    .transform((value, ctx): string => {
      const result = checkHttpsLink(value);
      if (!result.ok) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label}: ${result.message}`, params: { problem: result.problem } });
        return z.NEVER;
      }
      return result.url;
    });
}

/** A section's call to action: an https link, or an internal path (`/menu`) — never a protocol-relative `//host`. */
export function checkCtaHref(raw: string): LinkCheck {
  if (raw.startsWith("/")) {
    if (raw.startsWith("//") || raw.startsWith("/\\")) return { ok: false, problem: "INVALID", message: "Enter a valid link" };
    if (raw.length > IMAGE_URL_MAX_LENGTH) return { ok: false, problem: "TOO_LONG", message: `Use a link of at most ${IMAGE_URL_MAX_LENGTH} characters` };
    if (hasControlOrSpace(raw)) return { ok: false, problem: "INVALID", message: "Enter a valid link" };
    return { ok: true, url: raw };
  }
  return checkHttpsLink(raw);
}

const ctaHrefField = z
  .string()
  .trim()
  .transform((value, ctx): string => {
    const result = checkCtaHref(value);
    if (!result.ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Button link: ${result.message}`, params: { problem: result.problem } });
      return z.NEVER;
    }
    return result.url;
  });

// ─── Plain text ───

/** Strips control characters (keeping newlines and tabs in long copy) and trims. Markup is kept verbatim as text. */
export function plainText(value: string, allowNewlines: boolean): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code === 0x0a || code === 0x0d) {
      if (allowNewlines) out += "\n";
      else out += " ";
      continue;
    }
    if (code === 0x09) {
      out += " ";
      continue;
    }
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f) || code === 0x200b || code === 0xfeff) continue;
    out += char;
  }
  return out.trim();
}

function textField(max: number, label: string, options: { newlines?: boolean } = {}) {
  return z
    .string()
    .transform((value) => plainText(value, options.newlines === true))
    .pipe(z.string().max(max, `${label} must be at most ${max} characters`));
}

// ─── SA-WEB-01 theme (website:update) ───

export const updateWebsiteThemeSchema = strictObject({
  preset: z.enum(WEBSITE_THEME_PRESETS, { errorMap: () => ({ message: "Choose one of the available themes" }) }),
  surfaceMode: z.enum(WEBSITE_SURFACE_MODES, { errorMap: () => ({ message: "Choose a dark or light website" }) }),
  primaryHex: hexColour("Primary colour").optional(),
  secondaryHex: hexColour("Secondary colour").optional(),
  accentHex: hexColour("Accent colour").optional(),
  gradientFromHex: clearable(hexColour("Gradient start")),
  gradientToHex: clearable(hexColour("Gradient end")),
  // RASOIOS-ADR-021 §7: any number of named colours (up to 16), in the restaurant's order. #RGB is written out in full.
  brandColors: z
    .array(
      strictObject({
        name: textField(30, "Colour name").pipe(z.string().min(1, "Give the colour a name")),
        hex: z
          .string()
          .trim()
          .regex(/^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/, "Use a colour like #9D174D")
          .transform((hex) => (hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex).toUpperCase()),
      }),
    )
    .max(16, "Up to 16 brand colours")
    .refine((list) => new Set(list.map((c) => c.name.toLowerCase())).size === list.length, "Each colour needs a different name")
    .optional(),
  menuStyle: z.enum(["RING", "GRID"]).optional(),
  dailyStyle: z.enum(["STRIP", "GRID"]).optional(),
}).superRefine((value, ctx) => {
  if (value.preset === "CUSTOM") {
    for (const [field, label] of [
      ["primaryHex", "primary"],
      ["secondaryHex", "secondary"],
      ["accentHex", "accent"],
    ] as const) {
      if (value[field] === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `A custom theme needs a ${label} colour` });
      }
    }
  }
  const from = value.gradientFromHex;
  const to = value.gradientToHex;
  if ((from === null || from === undefined) !== (to === null || to === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [from === null || from === undefined ? "gradientFromHex" : "gradientToHex"], message: "Set both ends of the gradient, or neither" });
  }
});
export type UpdateWebsiteThemeInput = {
  preset: WebsiteThemePresetName;
  surfaceMode: WebsiteSurfaceModeName;
  primaryHex?: string;
  secondaryHex?: string;
  accentHex?: string;
  gradientFromHex?: string | null;
  gradientToHex?: string | null;
  brandColors?: { name: string; hex: string }[];
  menuStyle?: "RING" | "GRID";
  dailyStyle?: "STRIP" | "GRID";
};
export type UpdateWebsiteThemeData = z.output<typeof updateWebsiteThemeSchema>;

// ─── SA-WEB-02 identity and links (website:update) ───

export const WHATSAPP_PATTERN = /^\+[1-9]\d{7,14}$/;

const whatsappField = z
  .string()
  .trim()
  .transform((value) => value.replace(/[\s()-]/g, ""))
  .pipe(z.string().regex(WHATSAPP_PATTERN, "Use international format, e.g. +919876543210"));

export const updateWebsiteIdentitySchema = strictObject({
  tagline: clearable(textField(160, "Tagline")),
  heroImageUrl: clearable(imageUrlOrBlank("Hero image")),
  faviconUrl: clearable(imageUrlOrBlank("Site icon")),
  instagramUrl: clearable(linkField("Instagram link")),
  facebookUrl: clearable(linkField("Facebook link")),
  whatsappE164: clearable(whatsappField),
  mapsUrl: clearable(linkField("Map link")),
});
export type UpdateWebsiteIdentityInput = {
  tagline?: string | null;
  heroImageUrl?: string | null;
  faviconUrl?: string | null;
  instagramUrl?: string | null;
  facebookUrl?: string | null;
  whatsappE164?: string | null;
  mapsUrl?: string | null;
};
export type UpdateWebsiteIdentityData = z.output<typeof updateWebsiteIdentitySchema>;

// ─── SA-WEB-03 sections (website:update) ───

export const websiteSectionSchema = strictObject({
  key: z.enum(WEBSITE_SECTION_KEYS, { errorMap: () => ({ message: "Unknown section" }) }),
  enabled: z.boolean(),
  sortOrder: z.number().int("Use a whole number").min(0, "Use 0 or more").max(MAX_SECTION_SORT_ORDER, `Use at most ${MAX_SECTION_SORT_ORDER}`),
  headline: clearable(textField(120, "Heading")),
  body: clearable(textField(1000, "Text", { newlines: true })),
  imageUrl: clearable(imageUrlOrBlank("Section image")),
  ctaLabel: clearable(textField(40, "Button label")),
  ctaHref: clearable(ctaHrefField),
}).superRefine((value, ctx) => {
  const hasLabel = value.ctaLabel !== null && value.ctaLabel !== undefined && value.ctaLabel !== "";
  const hasHref = value.ctaHref !== null && value.ctaHref !== undefined && value.ctaHref !== "";
  if (hasLabel !== hasHref) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [hasLabel ? "ctaHref" : "ctaLabel"], message: "A button needs both a label and a link" });
  }
});

export const saveWebsiteSectionsSchema = strictObject({
  sections: z
    .array(websiteSectionSchema)
    .min(1, "Send at least one section")
    .max(WEBSITE_SECTION_KEYS.length, `Send at most ${WEBSITE_SECTION_KEYS.length} sections`),
}).superRefine((value, ctx) => {
  const keys = value.sections.map((s) => s.key);
  keys.forEach((key, index) => {
    if (keys.indexOf(key) !== index) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sections", index, "key"], message: "Each section can appear once" });
  });
  const orders = value.sections.map((s) => s.sortOrder);
  orders.forEach((order, index) => {
    if (orders.indexOf(order) !== index) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sections", index, "sortOrder"], message: "Two sections cannot share a position" });
  });
});
export type WebsiteSectionInput = {
  key: WebsiteSectionKeyName;
  enabled: boolean;
  sortOrder: number;
  headline?: string | null;
  body?: string | null;
  imageUrl?: string | null;
  ctaLabel?: string | null;
  ctaHref?: string | null;
};
export type SaveWebsiteSectionsInput = { sections: WebsiteSectionInput[] };
export type SaveWebsiteSectionsData = z.output<typeof saveWebsiteSectionsSchema>;
