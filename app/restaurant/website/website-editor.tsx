"use client";

import * as React from "react";
import { ArrowDown, ArrowUp, ExternalLink, LayoutList, Link2, Palette, Plus, Trash2, Type } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { Tabs } from "@/components/ui/tabs";
import { SortableList } from "@/components/ui/sortable-list";
import { Form, FormField, SubmitButton } from "@/components/ui/form";
import { ImageUploader } from "@/components/ui/image-uploader";
import { RadioGroup, Switch, TextArea, TextField, TextInput } from "@/components/ui/inputs";
import { cn } from "@/lib/ui/cn";
import { contrastRatio } from "@/lib/ui/contrast";
import type { ActionResult } from "@/lib/http/action";
import {
  TEXT_COLOR_KEYS,
  type TextColorKey,
  type WebsiteSectionKeyName,
  type WebsiteSurfaceModeName,
  type WebsiteThemePresetName,
} from "@/lib/validation/website";
import { SitePreview, type PreviewPalette } from "./site-preview";
import type { ResolvedTextColors } from "@/lib/services/website-theme";
import { updateBrandingAction } from "../settings/website-actions";
import { saveWebsiteSectionsAction, updateWebsiteIdentityAction, updateWebsiteThemeAction } from "./actions";

/**
 * Website customisation (S1-P07-T011; api.md SA-WEB-01…03) — the screen a restaurant uses after handover.
 *
 * Four tabs, one live preview, and one rule: **every control is wired to a real Server Action, and nothing here
 * reports success until the server has confirmed it.** The action result replaces the on-screen state, so what the
 * form shows afterwards is what was stored. Field errors — including contrast warnings — are rendered against the
 * field they belong to by the shared form system.
 *
 * A role without `website:update` sees the same screen read-only; the server refuses the write regardless
 * (SC-RBAC-08).
 */

// ─── Props (plain data from the server page) ───

export type EditorSection = {
  key: WebsiteSectionKeyName;
  enabled: boolean;
  sortOrder: number;
  headline: string | null;
  body: string | null;
  imageUrl: string | null;
  ctaLabel: string | null;
  ctaHref: string | null;
  defaultHeadline: string;
  alwaysEnabled: boolean;
  stored: boolean;
};

export type EditorSettings = {
  theme: {
    preset: WebsiteThemePresetName;
    surfaceMode: WebsiteSurfaceModeName;
    primaryHex: string | null;
    secondaryHex: string | null;
    accentHex: string | null;
    gradientFromHex: string | null;
    gradientToHex: string | null;
    textColors?: Partial<Record<TextColorKey, string>> | null;
    brandColors: BrandColour[];
    menuStyle: "RING" | "GRID";
    dailyStyle: "STRIP" | "GRID";
  };
  resolvedTheme: {
    primary: string;
    secondary: string;
    accent: string;
    gradientFrom: string;
    gradientTo: string;
    surface: string;
    onSurface: string;
    textColors: ResolvedTextColors;
  };
  identity: {
    tagline: string | null;
    logoUrl: string | null;
    coverImageUrl: string | null;
    heroImageUrl: string | null;
    faviconUrl: string | null;
    instagramUrl: string | null;
    facebookUrl: string | null;
    whatsappE164: string | null;
    mapsUrl: string | null;
  };
  sections: EditorSection[];
  canEdit: boolean;
};

export type EditorReference = {
  /** Every preset's palette for both surface modes, so the preview is exact before anything is saved. */
  presetPalettes: Record<Exclude<WebsiteThemePresetName, "CUSTOM">, Record<WebsiteSurfaceModeName, PreviewPalette>>;
  surfaceHex: Record<WebsiteSurfaceModeName, string>;
  onSurfaceHex: Record<WebsiteSurfaceModeName, string>;
};

export type EditorSite = { name: string; slug: string; published: boolean; publicPath: string };

// ─── Draft state ───

type ColourDraft = {
  preset: WebsiteThemePresetName;
  surfaceMode: WebsiteSurfaceModeName;
  primaryHex: string;
  secondaryHex: string;
  accentHex: string;
  useGradient: boolean;
  gradientFromHex: string;
  gradientToHex: string;
  textColors: ResolvedTextColors;
  customTextColors: Record<TextColorKey, boolean>;
  brandColors: BrandColour[];
  menuStyle: "RING" | "GRID";
  dailyStyle: "STRIP" | "GRID";
};

type BrandColour = { name: string; hex: string };

export function computeDefaultTextColors(
  surfaceMode: WebsiteSurfaceModeName,
  palette: PreviewPalette,
): ResolvedTextColors {
  const isDark = surfaceMode === "DARK";
  const onGradient =
    Math.min(contrastRatio(palette.gradientFrom, "#FFFFFF"), contrastRatio(palette.gradientTo, "#FFFFFF")) >=
    Math.min(contrastRatio(palette.gradientFrom, "#0B0B0F"), contrastRatio(palette.gradientTo, "#0B0B0F"))
      ? "#FFFFFF"
      : "#0B0B0F";
  const onPrimary =
    contrastRatio(palette.primary, "#FFFFFF") >= contrastRatio(palette.primary, "#0B0B0F") ? "#FFFFFF" : "#0B0B0F";

  return {
    headingColor: isDark ? "#F5F5F7" : "#17211B",
    sectionHeadingColor: isDark ? "#DEE8E3" : "#24352B",
    bodyTextColor: isDark ? "#DEE8E3" : "#405044",
    mutedTextColor: isDark ? "#93A69D" : "#667366",
    navigationTextColor: isDark ? "#DEE8E3" : "#24352B",
    linkColor: palette.primary,
    buttonTextColor: onPrimary,
    priceColor: palette.primary,
    footerTextColor: isDark ? "#93A69D" : "#405044",
    heroHeadingColor: onGradient,
    heroDescriptionColor: onGradient,
  };
}

function colourDraft(settings: EditorSettings): ColourDraft {
  const { theme, resolvedTheme } = settings;
  const customTextColors: Record<TextColorKey, boolean> = {
    headingColor: Boolean(theme.textColors?.headingColor),
    sectionHeadingColor: Boolean(theme.textColors?.sectionHeadingColor),
    bodyTextColor: Boolean(theme.textColors?.bodyTextColor),
    mutedTextColor: Boolean(theme.textColors?.mutedTextColor),
    navigationTextColor: Boolean(theme.textColors?.navigationTextColor),
    linkColor: Boolean(theme.textColors?.linkColor),
    buttonTextColor: Boolean(theme.textColors?.buttonTextColor),
    priceColor: Boolean(theme.textColors?.priceColor),
    footerTextColor: Boolean(theme.textColors?.footerTextColor),
    heroHeadingColor: Boolean(theme.textColors?.heroHeadingColor),
    heroDescriptionColor: Boolean(theme.textColors?.heroDescriptionColor),
  };

  return {
    preset: theme.preset,
    surfaceMode: theme.surfaceMode,
    primaryHex: theme.primaryHex ?? resolvedTheme.primary,
    secondaryHex: theme.secondaryHex ?? resolvedTheme.secondary,
    accentHex: theme.accentHex ?? resolvedTheme.accent,
    useGradient: theme.gradientFromHex !== null && theme.gradientToHex !== null,
    gradientFromHex: theme.gradientFromHex ?? resolvedTheme.gradientFrom,
    gradientToHex: theme.gradientToHex ?? resolvedTheme.gradientTo,
    textColors: { ...resolvedTheme.textColors },
    customTextColors,
    brandColors: theme.brandColors.map((colour) => ({ ...colour })),
    menuStyle: theme.menuStyle,
    dailyStyle: theme.dailyStyle,
  };
}

/** The palette the draft would produce: a preset owns its colours, `CUSTOM` uses the three in the form. */
function draftPalette(draft: ColourDraft, reference: EditorReference): PreviewPalette {
  const base: PreviewPalette =
    draft.preset === "CUSTOM"
      ? { primary: draft.primaryHex, secondary: draft.secondaryHex, accent: draft.accentHex, gradientFrom: draft.primaryHex, gradientTo: draft.secondaryHex }
      : reference.presetPalettes[draft.preset][draft.surfaceMode];
  return draft.useGradient ? { ...base, gradientFrom: draft.gradientFromHex, gradientTo: draft.gradientToHex } : base;
}

const PRESET_LABELS: Record<WebsiteThemePresetName, string> = {
  PLATFORM: "Signature",
  CITRUS: "Citrus",
  OCEAN: "Ocean",
  BERRY: "Berry",
  CUSTOM: "Your own colours",
};

const HEX = /^#[0-9A-Fa-f]{6}$/;

/**
 * The action result, narrowed to what this screen renders. The services return more than the editor uses; keeping the
 * narrowing in one place means the forms are typed against the fields they actually read.
 */
async function saved(call: Promise<ActionResult<unknown>>): Promise<ActionResult<EditorSettings>> {
  const result = await call;
  return result.ok ? { ok: true, data: result.data as EditorSettings } : result;
}

/** A colour input pair: a swatch picker and the hex field that is actually submitted, bound to one value. */
function ColourField({
  name,
  label,
  help,
  value,
  onChange,
  disabled,
}: {
  name: string;
  label: string;
  help?: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  return (
    <FormField name={name} label={label} help={help}>
      <div className="flex items-center gap-3">
        <input
          type="color"
          aria-label={`${label} swatch`}
          value={HEX.test(value) ? value : "#000000"}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value.toUpperCase())}
          className="h-10 w-12 shrink-0 cursor-pointer rounded-xl border border-border-strong bg-canvas disabled:cursor-not-allowed disabled:opacity-40"
        />
        <TextInput value={value} disabled={disabled} inputMode="text" spellCheck={false} onChange={(event) => onChange(event.target.value.toUpperCase())} />
      </div>
    </FormField>
  );
}

/** A text colour setting pair with colour picker, HEX input, and Reset to default option. */
function TextColourField({
  name,
  label,
  help,
  value,
  defaultHex,
  isCustom,
  onChange,
  onReset,
  disabled,
}: {
  name: string;
  label: string;
  help?: string;
  value: string;
  defaultHex: string;
  isCustom: boolean;
  onChange: (value: string) => void;
  onReset: () => void;
  disabled: boolean;
}) {
  return (
    <FormField name={name} label={label} help={help}>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <input
            type="color"
            aria-label={`${label} swatch`}
            value={HEX.test(value) ? value : "#000000"}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value.toUpperCase())}
            className="h-10 w-12 shrink-0 cursor-pointer rounded-xl border border-border-strong bg-canvas disabled:cursor-not-allowed disabled:opacity-40"
          />
          <TextInput
            value={value}
            disabled={disabled}
            inputMode="text"
            spellCheck={false}
            onChange={(event) => onChange(event.target.value.toUpperCase())}
          />
        </div>
        <div className="flex items-center justify-between text-caption">
          <span className="text-fg-secondary">
            {isCustom ? "Custom" : `Default: ${defaultHex}`}
          </span>
          {isCustom && !disabled && (
            <button
              type="button"
              onClick={onReset}
              className="text-label text-fg-accent hover:underline"
              aria-label={`Reset ${label} to default`}
            >
              Reset to default
            </button>
          )}
        </div>
      </div>
    </FormField>
  );
}

const TEXT_COLOUR_FIELDS: Array<{
  key: TextColorKey;
  label: string;
  help?: string;
}> = [
  { key: "headingColor", label: "Main heading", help: "Restaurant name and main headlines." },
  { key: "sectionHeadingColor", label: "Section headings", help: "Headings for categories, hours, and about." },
  { key: "bodyTextColor", label: "Body text", help: "Descriptions and general paragraph copy." },
  { key: "mutedTextColor", label: "Secondary text", help: "Muted subtitles, dietary notes, and hours details." },
  { key: "navigationTextColor", label: "Navigation text", help: "Header menu links." },
  { key: "linkColor", label: "Links", help: "Hyperlinks and map links." },
  { key: "buttonTextColor", label: "Button text", help: "Text on buttons and calls to action." },
  { key: "priceColor", label: "Prices", help: "Menu item price tags." },
  { key: "footerTextColor", label: "Footer text", help: "Footer information and copyright text." },
  { key: "heroHeadingColor", label: "Hero heading", help: "Heading displayed on the hero banner." },
  { key: "heroDescriptionColor", label: "Hero description", help: "Tagline and text on the hero banner." },
];

// ─── Editor ───

export function WebsiteEditor({ settings, reference, site }: { settings: EditorSettings; reference: EditorReference; site: EditorSite }) {
  const [view, setView] = React.useState(settings);
  const [colours, setColours] = React.useState(() => colourDraft(settings));
  const [identity, setIdentity] = React.useState(() => ({ ...settings.identity }));
  const [sections, setSections] = React.useState<EditorSection[]>(settings.sections);

  // The forms submit what is on screen, not what the browser serialised, because the section order lives in state.
  const latest = React.useRef({ colours, identity, sections, view });
  latest.current = { colours, identity, sections, view };

  const [brandingNote, setBrandingNote] = React.useState<{ ok: boolean; text: string } | null>(null);
  const disabled = !view.canEdit;
  const palette = draftPalette(colours, reference);
  const savedColours = colourDraft(view);
  const dirty =
    JSON.stringify(colours) !== JSON.stringify(savedColours) ||
    JSON.stringify(identity) !== JSON.stringify(view.identity) ||
    JSON.stringify(sections) !== JSON.stringify(view.sections);

  function applySaved(next: EditorSettings) {
    setView(next);
    setColours(colourDraft(next));
    setIdentity({ ...next.identity });
    setSections(next.sections);
  }

  const themeAction = (): Promise<ActionResult<EditorSettings>> => {
    const draft = latest.current.colours;
    const gradient = {
      ...(draft.useGradient ? { gradientFromHex: draft.gradientFromHex, gradientToHex: draft.gradientToHex } : { gradientFromHex: null, gradientToHex: null }),
      brandColors: draft.brandColors,
      menuStyle: draft.menuStyle,
      dailyStyle: draft.dailyStyle,
    };
    const textColorsToSave: Partial<Record<TextColorKey, string>> = {};
    for (const key of TEXT_COLOR_KEYS) {
      if (draft.customTextColors[key]) {
        textColorsToSave[key] = draft.textColors[key];
      }
    }
    return saved(
      updateWebsiteThemeAction(
        draft.preset === "CUSTOM"
          ? {
              preset: draft.preset,
              surfaceMode: draft.surfaceMode,
              primaryHex: draft.primaryHex,
              secondaryHex: draft.secondaryHex,
              accentHex: draft.accentHex,
              textColors: textColorsToSave,
              ...gradient,
            }
          : {
              preset: draft.preset,
              surfaceMode: draft.surfaceMode,
              textColors: textColorsToSave,
              ...gradient,
            },
      ),
    );
  };

  const identityAction = (fields: Array<keyof EditorSettings["identity"]>) => (): Promise<ActionResult<EditorSettings>> => {
    const draft = latest.current.identity;
    return saved(updateWebsiteIdentityAction(Object.fromEntries(fields.map((field) => [field, draft[field] ?? ""]))));
  };

  // Logo and cover belong to the restaurant's branding (SA-RST-02), saved by their own action; the result is merged
  // into the editor's saved state so the preview and the dirty check see what was stored.
  const brandingAction = async (): Promise<ActionResult<EditorSettings>> => {
    const draft = latest.current.identity;
    const result = await updateBrandingAction({ logoUrl: draft.logoUrl ?? "", coverImageUrl: draft.coverImageUrl ?? "" });
    if (!result.ok) return result;
    const stored = result.data as { logoUrl: string | null; coverImageUrl: string | null };
    const base = latest.current.view;
    return { ok: true, data: { ...base, identity: { ...base.identity, logoUrl: stored.logoUrl, coverImageUrl: stored.coverImageUrl } } };
  };

  // Owner report 2026-10-07: uploading, replacing or removing the logo seemed to do nothing, because the change waited
  // for a separate Save button and the console header kept the old logo. A finished upload or a removal is now saved
  // at once. Only the field that changed is sent with the other field's SAVED value, so nothing half-typed elsewhere is
  // saved with it; the server still checks the image is this restaurant's own (SC-FILE-02) and refreshes the console
  // layout, so the header shows the new logo.
  async function commitBrandingImage(field: "logoUrl" | "coverImageUrl", url: string) {
    const saved = latest.current.view.identity;
    const label = field === "logoUrl" ? "Logo" : "Cover photo";
    const result = await updateBrandingAction({
      logoUrl: field === "logoUrl" ? url : (saved.logoUrl ?? ""),
      coverImageUrl: field === "coverImageUrl" ? url : (saved.coverImageUrl ?? ""),
    });
    if (!result.ok) {
      setBrandingNote({ ok: false, text: `${label} not saved. ${result.error.fieldErrors?.[field]?.[0] ?? result.error.message}` });
      return;
    }
    const stored = result.data as { logoUrl: string | null; coverImageUrl: string | null };
    setView((current) => ({ ...current, identity: { ...current.identity, logoUrl: stored.logoUrl, coverImageUrl: stored.coverImageUrl } }));
    setIdentity((current) => ({ ...current, [field]: stored[field] }));
    setBrandingNote({ ok: true, text: url ? `${label} saved.` : `${label} removed.` });
  }

  const sectionsAction = (): Promise<ActionResult<EditorSettings>> =>
    saved(
      saveWebsiteSectionsAction({
        sections: latest.current.sections.map((section, index) => ({
          key: section.key,
          enabled: section.alwaysEnabled ? true : section.enabled,
          sortOrder: index * 10,
          headline: section.headline ?? "",
          body: section.body ?? "",
          imageUrl: section.imageUrl ?? "",
          ctaLabel: section.ctaLabel ?? "",
          ctaHref: section.ctaHref ?? "",
        })),
      }),
    );

  const updateSection = (key: WebsiteSectionKeyName, patch: Partial<EditorSection>) =>
    setSections((current) => current.map((section) => (section.key === key ? { ...section, ...patch } : section)));

  function updateCustomPalette(patch: Partial<Pick<ColourDraft, "primaryHex" | "secondaryHex" | "accentHex" | "gradientFromHex" | "gradientToHex">>) {
    setColours((current) => {
      const updated = { ...current, ...patch };
      const nextPalette = draftPalette(updated, reference);
      const defaults = computeDefaultTextColors(updated.surfaceMode, nextPalette);
      const nextTextColors = { ...updated.textColors };
      for (const k of TEXT_COLOR_KEYS) {
        if (!updated.customTextColors[k]) {
          nextTextColors[k] = defaults[k];
        }
      }
      return {
        ...updated,
        textColors: nextTextColors,
      };
    });
  }

  function updateTextColor(key: TextColorKey, hex: string) {
    setColours((current) => ({
      ...current,
      customTextColors: {
        ...current.customTextColors,
        [key]: true,
      },
      textColors: {
        ...current.textColors,
        [key]: hex,
      },
    }));
  }

  function resetTextColor(key: TextColorKey) {
    const currentPalette = draftPalette(colours, reference);
    const defaults = computeDefaultTextColors(colours.surfaceMode, currentPalette);
    setColours((current) => ({
      ...current,
      customTextColors: {
        ...current.customTextColors,
        [key]: false,
      },
      textColors: {
        ...current.textColors,
        [key]: defaults[key],
      },
    }));
  }

  const previewInput = {
    preset: colours.preset,
    surfaceMode: colours.surfaceMode,
    palette,
    surfaceHex: reference.surfaceHex[colours.surfaceMode],
    onSurfaceHex: reference.onSurfaceHex[colours.surfaceMode],
    restaurantName: site.name,
    headline: sections.find((section) => section.key === "HERO")?.headline || site.name,
    tagline: identity.tagline,
    ctaLabel: sections.find((section) => section.key === "HERO")?.ctaLabel ?? null,
    sectionLabels: sections.filter((section) => section.enabled || section.alwaysEnabled).map((section) => section.headline || section.defaultHeadline),
    textColors: colours.textColors,
  };

  const tabs = [
    {
      id: "colours",
      label: "Colours",
      icon: Palette,
      content: (
        <Form action={themeAction} onSuccess={applySaved}>
          <Card>
            <CardHeader>
              <CardTitle>Colours</CardTitle>
              <CardDescription>Pick a ready-made palette or choose your own. Check contrast and customize individual text colours below.</CardDescription>
            </CardHeader>
            <CardContent>
              <RadioGroup
                name="preset"
                label="Palette"
                disabled={disabled}
                value={colours.preset}
                onValueChange={(value) => {
                  const nextPreset = value as WebsiteThemePresetName;
                  setColours((current) => {
                    const nextBase =
                      nextPreset === "CUSTOM"
                        ? { primary: current.primaryHex, secondary: current.secondaryHex, accent: current.accentHex, gradientFrom: current.primaryHex, gradientTo: current.secondaryHex }
                        : reference.presetPalettes[nextPreset][current.surfaceMode];
                    const nextPalette = current.useGradient
                      ? { ...nextBase, gradientFrom: current.gradientFromHex, gradientTo: current.gradientToHex }
                      : nextBase;
                    const defaults = computeDefaultTextColors(current.surfaceMode, nextPalette);
                    const nextTextColors = { ...current.textColors };
                    for (const k of TEXT_COLOR_KEYS) {
                      if (!current.customTextColors[k]) {
                        nextTextColors[k] = defaults[k];
                      }
                    }
                    return {
                      ...current,
                      preset: nextPreset,
                      textColors: nextTextColors,
                    };
                  });
                }}
                options={(Object.keys(PRESET_LABELS) as WebsiteThemePresetName[]).map((preset) => ({
                  value: preset,
                  label: PRESET_LABELS[preset],
                  description:
                    preset === "CUSTOM"
                      ? "Three colours of your own, checked for readability before they are saved."
                      : `${reference.presetPalettes[preset][colours.surfaceMode].primary} · ${reference.presetPalettes[preset][colours.surfaceMode].secondary}`,
                }))}
              />
              <RadioGroup
                name="surfaceMode"
                label="Website background"
                orientation="horizontal"
                disabled={disabled}
                value={colours.surfaceMode}
                onValueChange={(value) => {
                  const nextMode = value as WebsiteSurfaceModeName;
                  setColours((current) => {
                    const nextBase =
                      current.preset === "CUSTOM"
                        ? { primary: current.primaryHex, secondary: current.secondaryHex, accent: current.accentHex, gradientFrom: current.primaryHex, gradientTo: current.secondaryHex }
                        : reference.presetPalettes[current.preset][nextMode];
                    const nextPalette = current.useGradient
                      ? { ...nextBase, gradientFrom: current.gradientFromHex, gradientTo: current.gradientToHex }
                      : nextBase;
                    const defaults = computeDefaultTextColors(nextMode, nextPalette);
                    const nextTextColors = { ...current.textColors };
                    for (const k of TEXT_COLOR_KEYS) {
                      if (!current.customTextColors[k]) {
                        nextTextColors[k] = defaults[k];
                      }
                    }
                    return {
                      ...current,
                      surfaceMode: nextMode,
                      textColors: nextTextColors,
                    };
                  });
                }}
                options={[
                  { value: "DARK", label: "Dark" },
                  { value: "LIGHT", label: "Light" },
                ]}
              />
              {colours.preset === "CUSTOM" && (
                <div className="grid gap-4 md:grid-cols-3">
                  <ColourField
                    name="primaryHex"
                    label="Primary colour"
                    help="Buttons, prices and links."
                    value={colours.primaryHex}
                    disabled={disabled}
                    onChange={(value) => updateCustomPalette({ primaryHex: value })}
                  />
                  <ColourField
                    name="secondaryHex"
                    label="Secondary colour"
                    value={colours.secondaryHex}
                    disabled={disabled}
                    onChange={(value) => updateCustomPalette({ secondaryHex: value })}
                  />
                  <ColourField
                    name="accentHex"
                    label="Accent colour"
                    value={colours.accentHex}
                    disabled={disabled}
                    onChange={(value) => updateCustomPalette({ accentHex: value })}
                  />
                </div>
              )}
              <Switch
                name="useGradient"
                label="Use my own hero gradient"
                help="Off keeps the gradient that comes with the palette."
                checked={colours.useGradient}
                disabled={disabled}
                onChange={(event) =>
                  setColours((current) => {
                    const nextUse = event.target.checked;
                    const updated = { ...current, useGradient: nextUse };
                    const nextPalette = draftPalette(updated, reference);
                    const defaults = computeDefaultTextColors(updated.surfaceMode, nextPalette);
                    const nextTextColors = { ...updated.textColors };
                    for (const k of TEXT_COLOR_KEYS) {
                      if (!updated.customTextColors[k]) {
                        nextTextColors[k] = defaults[k];
                      }
                    }
                    return { ...updated, textColors: nextTextColors };
                  })
                }
              />
              {colours.useGradient && (
                <div className="grid gap-4 md:grid-cols-2">
                  <ColourField
                    name="gradientFromHex"
                    label="Gradient start"
                    value={colours.gradientFromHex}
                    disabled={disabled}
                    onChange={(value) => updateCustomPalette({ gradientFromHex: value })}
                  />
                  <ColourField
                    name="gradientToHex"
                    label="Gradient end"
                    value={colours.gradientToHex}
                    disabled={disabled}
                    onChange={(value) => updateCustomPalette({ gradientToHex: value })}
                  />
                </div>
              )}
              <BrandColoursEditor
                colours={colours.brandColors}
                surfaceHex={reference.surfaceHex[colours.surfaceMode]}
                disabled={disabled}
                onChange={(brandColors) => setColours((current) => ({ ...current, brandColors }))}
              />
              <RadioGroup
                name="menuStyle"
                label="Main menu on your website"
                disabled={disabled}
                value={colours.menuStyle}
                onValueChange={(value) => setColours((current) => ({ ...current, menuStyle: value as "RING" | "GRID" }))}
                options={[
                  { value: "RING", label: "3D carousel", description: "Guests spin through your dishes, with a pill for each menu section." },
                  { value: "GRID", label: "Cards", description: "Every section listed as a grid of dish cards." },
                ]}
              />
              <RadioGroup
                name="dailyStyle"
                label="Today's menu on your website"
                disabled={disabled}
                value={colours.dailyStyle}
                onValueChange={(value) => setColours((current) => ({ ...current, dailyStyle: value as "STRIP" | "GRID" }))}
                options={[
                  { value: "STRIP", label: "Folder cards", description: "Today's dishes as cards that lift out of a folder as guests swipe or hover." },
                  { value: "GRID", label: "Cards", description: "Today's dishes as a grid." },
                ]}
              />

              {/* Text Colours Section */}
              <div className="flex flex-col gap-4 border-t border-border-subtle pt-6">
                <div>
                  <h3 className="text-subheading font-semibold text-fg-primary">Text Colours</h3>
                  <p className="text-caption text-fg-secondary">Customize text colours throughout your public restaurant website.</p>
                </div>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {TEXT_COLOUR_FIELDS.map(({ key, label, help }) => {
                    const defaults = computeDefaultTextColors(colours.surfaceMode, palette);
                    const defaultHex = defaults[key];
                    const isCustom = colours.customTextColors[key];
                    return (
                      <TextColourField
                        key={key}
                        name={`textColors.${key}`}
                        label={label}
                        help={help}
                        value={colours.textColors[key]}
                        defaultHex={defaultHex}
                        isCustom={isCustom}
                        disabled={disabled}
                        onChange={(hex) => updateTextColor(key, hex)}
                        onReset={() => resetTextColor(key)}
                      />
                    );
                  })}
                </div>
              </div>

              {!disabled && (
                <div className="flex justify-end pt-4">
                  <SubmitButton>Save colours</SubmitButton>
                </div>
              )}
            </CardContent>
          </Card>
        </Form>
      ),
    },
    {
      id: "branding",
      label: "Branding",
      icon: Type,
      content: (
        <div className="flex flex-col gap-4">
          <Form action={brandingAction} onSuccess={applySaved}>
            <Card>
              <CardHeader>
                <CardTitle>Logo and cover</CardTitle>
                <CardDescription>Your logo appears in the website header and the console; the cover photo is used when no hero image is set. Uploading or removing an image saves it straight away.</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
                  <ImageUploader
                    name="logoUrl"
                    label="Logo"
                    purpose="LOGO"
                    shape="square"
                    disabled={disabled}
                    value={identity.logoUrl ?? ""}
                    onChange={(url) => setIdentity((current) => ({ ...current, logoUrl: url }))}
                    onCommit={(url) => commitBrandingImage("logoUrl", url)}
                    help="A square image works best, at least 256 × 256 pixels."
                  />
                  <ImageUploader
                    name="coverImageUrl"
                    label="Cover photo"
                    purpose="COVER"
                    disabled={disabled}
                    value={identity.coverImageUrl ?? ""}
                    onChange={(url) => setIdentity((current) => ({ ...current, coverImageUrl: url }))}
                    onCommit={(url) => commitBrandingImage("coverImageUrl", url)}
                    help="A wide photo of your food or dining room, at least 1600 pixels across."
                  />
                </div>
                <p role="status" aria-live="polite" className={cn("text-body", brandingNote?.ok === false ? "text-status-danger" : "text-status-success")} data-testid="branding-status">
                  {brandingNote?.text}
                </p>
                {!disabled && (
                  <div className="flex justify-end">
                    <SubmitButton>Save image links</SubmitButton>
                  </div>
                )}
              </CardContent>
            </Card>
          </Form>
          <Form action={identityAction(["tagline", "heroImageUrl", "faviconUrl"])} onSuccess={applySaved}>
            <Card>
              <CardHeader>
                <CardTitle>Branding</CardTitle>
                <CardDescription>The line under your name, the photograph at the top of your site and the icon browsers show in the tab.</CardDescription>
              </CardHeader>
              <CardContent>
                <TextField
                  name="tagline"
                  label="Tagline"
                  maxLength={160}
                  disabled={disabled}
                  value={identity.tagline ?? ""}
                  onChange={(event) => setIdentity((current) => ({ ...current, tagline: event.target.value }))}
                />
                <ImageUploader
                  name="heroImageUrl"
                  label="Hero image"
                  purpose="HERO"
                  help="The large photograph at the top of your website. Leave empty to use your cover photo."
                  disabled={disabled}
                  value={identity.heroImageUrl ?? ""}
                  onChange={(url) => setIdentity((current) => ({ ...current, heroImageUrl: url }))}
                />
                <ImageUploader
                  name="faviconUrl"
                  label="Site icon"
                  purpose="FAVICON"
                  shape="square"
                  help="The small icon browsers show in the tab. A square image, at least 64 × 64 pixels."
                  disabled={disabled}
                  value={identity.faviconUrl ?? ""}
                  onChange={(url) => setIdentity((current) => ({ ...current, faviconUrl: url }))}
                />
                {!disabled && (
                  <div className="flex justify-end">
                    <SubmitButton>Save branding</SubmitButton>
                  </div>
                )}
              </CardContent>
            </Card>
          </Form>
        </div>
      ),
    },
    {
      id: "details",
      label: "Details",
      icon: Link2,
      content: (
        <Form action={identityAction(["instagramUrl", "facebookUrl", "whatsappE164", "mapsUrl"])} onSuccess={applySaved}>
          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
              <CardDescription>Links your guests can follow. Each one is shown only when you fill it in.</CardDescription>
            </CardHeader>
            <CardContent>
              <TextField
                name="instagramUrl"
                label="Instagram link"
                disabled={disabled}
                value={identity.instagramUrl ?? ""}
                onChange={(event) => setIdentity((current) => ({ ...current, instagramUrl: event.target.value }))}
              />
              <TextField
                name="facebookUrl"
                label="Facebook link"
                disabled={disabled}
                value={identity.facebookUrl ?? ""}
                onChange={(event) => setIdentity((current) => ({ ...current, facebookUrl: event.target.value }))}
              />
              <TextField
                name="whatsappE164"
                label="WhatsApp number"
                help="International format, for example +919876543210."
                disabled={disabled}
                value={identity.whatsappE164 ?? ""}
                onChange={(event) => setIdentity((current) => ({ ...current, whatsappE164: event.target.value }))}
              />
              <TextField
                name="mapsUrl"
                label="Map link"
                disabled={disabled}
                value={identity.mapsUrl ?? ""}
                onChange={(event) => setIdentity((current) => ({ ...current, mapsUrl: event.target.value }))}
              />
              {!disabled && (
                <div className="flex justify-end">
                  <SubmitButton>Save details</SubmitButton>
                </div>
              )}
            </CardContent>
          </Card>
        </Form>
      ),
    },
    {
      id: "sections",
      label: "Sections",
      icon: LayoutList,
      content: (
        <Form action={sectionsAction} onSuccess={applySaved}>
          <Card>
            <CardHeader>
              <CardTitle>Sections</CardTitle>
              <CardDescription>Choose what appears on your website and in which order. Text is shown exactly as you type it.</CardDescription>
            </CardHeader>
            <CardContent>
              <SortableList
                items={sections}
                getKey={(section) => section.key}
                getLabel={(section) => section.headline || section.defaultHeadline}
                label="Website sections"
                disabled={disabled}
                onReorder={(next) => setSections(next)}
                renderItem={(section, index) => (
                  <SectionEditor section={section} index={index} disabled={disabled} onChange={(patch) => updateSection(section.key, patch)} />
                )}
              />
              {!disabled && (
                <div className="flex justify-end">
                  <SubmitButton>Save sections</SubmitButton>
                </div>
              )}
            </CardContent>
          </Card>
        </Form>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
      <div className="min-w-0 flex-1">
        {disabled && (
          <p className="mb-4 rounded-xl border border-border-subtle bg-card px-4 py-3 text-body text-fg-secondary">
            You can see this restaurant&apos;s website settings but not change them.
          </p>
        )}
        <Tabs items={tabs} label="Website settings" />
      </div>
      <div className="w-full lg:max-w-dialog-confirm">
        <SitePreview input={previewInput} dirty={dirty} />
        <a
          href={site.publicPath}
          target="_blank"
          rel="noopener noreferrer"
          className={cn("mt-3 inline-flex items-center gap-2 text-label", site.published ? "text-fg-accent hover:underline" : "text-fg-secondary")}
        >
          <Icon icon={ExternalLink} size={16} />
          {site.published ? "Open the published website" : "Your website is not published yet"}
        </a>
      </div>
    </div>
  );
}

/** One section's controls. `sections.<index>.<field>` matches the server's field-error paths exactly. */
function SectionEditor({
  section,
  index,
  disabled,
  onChange,
}: {
  section: EditorSection;
  index: number;
  disabled: boolean;
  onChange: (patch: Partial<EditorSection>) => void;
}) {
  const field = (name: string) => `sections.${index}.${name}`;
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-subheading text-fg-primary">{section.headline || section.defaultHeadline}</p>
        {section.alwaysEnabled ? (
          <span className="text-caption text-fg-secondary">Always shown</span>
        ) : (
          <Switch
            name={field("enabled")}
            label="Show on the website"
            checked={section.enabled}
            disabled={disabled}
            onChange={(event) => onChange({ enabled: event.target.checked })}
            className="w-auto"
          />
        )}
      </div>
      <TextField
        name={field("headline")}
        label="Heading"
        placeholder={section.defaultHeadline}
        maxLength={120}
        disabled={disabled}
        value={section.headline ?? ""}
        onChange={(event) => onChange({ headline: event.target.value })}
      />
      <TextArea
        name={field("body")}
        label="Text"
        rows={3}
        maxLength={1000}
        showCount
        disabled={disabled}
        value={section.body ?? ""}
        onChange={(event) => onChange({ body: event.target.value })}
      />
      <div className="grid gap-3 md:grid-cols-2">
        <TextField
          name={field("ctaLabel")}
          label="Button label"
          maxLength={40}
          disabled={disabled}
          value={section.ctaLabel ?? ""}
          onChange={(event) => onChange({ ctaLabel: event.target.value })}
        />
        <TextField
          name={field("ctaHref")}
          label="Button link"
          help="An https link, or a path on your own site such as /menu."
          disabled={disabled}
          value={section.ctaHref ?? ""}
          onChange={(event) => onChange({ ctaHref: event.target.value })}
        />
      </div>
      <ImageUploader
        name={field("imageUrl")}
        label="Section image"
        purpose="WEBSITE_SECTION"
        disabled={disabled}
        value={section.imageUrl ?? ""}
        onChange={(url) => onChange({ imageUrl: url })}
      />
    </div>
  );
}

// ─── Brand colours (RASOIOS-ADR-021 §7) ───

function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** WCAG contrast of a colour against the website background, as advice — the restaurant's choice is never changed. */
function contrastAdvice(hex: string, surfaceHex: string): { label: string; good: boolean } {
  if (!HEX.test(hex) || !HEX.test(surfaceHex)) return { label: "Enter a colour like #9D174D", good: false };
  const [a, b] = [luminance(hex), luminance(surfaceHex)].sort((x, y) => y - x);
  const ratio = (a + 0.05) / (b + 0.05);
  if (ratio >= 4.5) return { label: `Good contrast for text (${ratio.toFixed(1)}:1)`, good: true };
  if (ratio >= 3) return { label: `Large text and accents only (${ratio.toFixed(1)}:1)`, good: true };
  return { label: `Needs better contrast for text (${ratio.toFixed(1)}:1) - fine for decoration`, good: false };
}

function BrandColoursEditor({ colours, surfaceHex, disabled, onChange }: { colours: BrandColour[]; surfaceHex: string; disabled: boolean; onChange: (next: BrandColour[]) => void }) {
  const update = (index: number, patch: Partial<BrandColour>) => onChange(colours.map((colour, i) => (i === index ? { ...colour, ...patch } : colour)));
  const move = (index: number, by: number) => {
    const next = [...colours];
    const [item] = next.splice(index, 1);
    next.splice(index + by, 0, item);
    onChange(next);
  };
  return (
    <fieldset className="flex flex-col gap-3" disabled={disabled}>
      <legend className="text-label text-fg-primary">Brand colours</legend>
      <p className="text-caption text-fg-secondary">Name as many colours as your brand uses. Your website uses them for menu section accents; contrast is shown against your website background.</p>
      {colours.length === 0 && <p className="text-body text-fg-secondary">No extra colours yet.</p>}
      <ul className="flex list-none flex-col gap-2 p-0">
        {colours.map((colour, index) => {
          const advice = contrastAdvice(colour.hex, surfaceHex);
          const name = colour.name || "colour";
          return (
            <li key={index} className="flex flex-wrap items-center gap-2 rounded-xl border border-border-subtle bg-raised p-2" data-testid="brand-colour-row">
              <input
                type="color"
                aria-label={`${name} swatch`}
                value={HEX.test(colour.hex) ? colour.hex : "#000000"}
                onChange={(event) => update(index, { hex: event.target.value.toUpperCase() })}
                className="h-10 w-12 shrink-0 cursor-pointer rounded-xl border border-border-strong bg-canvas"
              />
              <input
                aria-label="Colour name"
                value={colour.name}
                maxLength={30}
                placeholder="e.g. Gold"
                onChange={(event) => update(index, { name: event.target.value })}
                className="h-10 min-w-0 flex-1 basis-32 rounded-xl border border-border-strong bg-canvas px-3 text-body text-fg-primary"
              />
              <input
                aria-label={`${name} hex value`}
                value={colour.hex}
                maxLength={7}
                spellCheck={false}
                onChange={(event) => update(index, { hex: event.target.value.toUpperCase() })}
                className="h-10 w-28 rounded-xl border border-border-strong bg-canvas px-3 font-mono text-body text-fg-primary"
              />
              <span className="flex shrink-0 gap-1">
                <IconButton icon={ArrowUp} aria-label={`Move ${name} up`} variant="ghost" disabled={index === 0} onClick={() => move(index, -1)} />
                <IconButton icon={ArrowDown} aria-label={`Move ${name} down`} variant="ghost" disabled={index === colours.length - 1} onClick={() => move(index, 1)} />
                <IconButton icon={Trash2} aria-label={`Delete ${name}`} variant="ghost" onClick={() => onChange(colours.filter((_, i) => i !== index))} />
              </span>
              <span className={advice.good ? "w-full text-caption text-status-success" : "w-full text-caption text-status-warning"}>{advice.label}</span>
            </li>
          );
        })}
      </ul>
      {colours.length < 16 && (
        <div>
          <Button variant="secondary" icon={Plus} onClick={() => onChange([...colours, { name: "", hex: "#F59E0B" }])}>
            Add colour
          </Button>
        </div>
      )}
    </fieldset>
  );
}
