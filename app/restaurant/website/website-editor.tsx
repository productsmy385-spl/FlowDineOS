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
import type { ActionResult } from "@/lib/http/action";
import type { WebsiteSectionKeyName, WebsiteSurfaceModeName, WebsiteThemePresetName } from "@/lib/validation/website";
import { SitePreview, type PreviewPalette } from "./site-preview";
import { updateBrandingAction } from "../settings/website-actions";
import { saveWebsiteSectionsAction, updateWebsiteIdentityAction, updateWebsiteThemeAction } from "./actions";

/**
 * Website customisation (S1-P07-T011; api.md SA-WEB-01…03) — the screen a restaurant uses after handover.
 *
 * Four tabs, one live preview, and one rule: **every control is wired to a real Server Action, and nothing here
 * reports success until the server has confirmed it.** The action result replaces the on-screen state, so what the
 * form shows afterwards is what was stored. Field errors — including the contrast rejection, which names the measured
 * ratio — are rendered against the field they belong to by the shared form system.
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
    brandColors: BrandColour[];
    menuStyle: "RING" | "GRID";
    dailyStyle: "STRIP" | "GRID";
  };
  resolvedTheme: { primary: string; secondary: string; accent: string; gradientFrom: string; gradientTo: string; surface: string; onSurface: string };
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
  brandColors: BrandColour[];
  menuStyle: "RING" | "GRID";
  dailyStyle: "STRIP" | "GRID";
};

type BrandColour = { name: string; hex: string };

function colourDraft(settings: EditorSettings): ColourDraft {
  const { theme, resolvedTheme } = settings;
  return {
    preset: theme.preset,
    surfaceMode: theme.surfaceMode,
    primaryHex: theme.primaryHex ?? resolvedTheme.primary,
    secondaryHex: theme.secondaryHex ?? resolvedTheme.secondary,
    accentHex: theme.accentHex ?? resolvedTheme.accent,
    useGradient: theme.gradientFromHex !== null && theme.gradientToHex !== null,
    gradientFromHex: theme.gradientFromHex ?? resolvedTheme.gradientFrom,
    gradientToHex: theme.gradientToHex ?? resolvedTheme.gradientTo,
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

// ─── Editor ───

export function WebsiteEditor({ settings, reference, site }: { settings: EditorSettings; reference: EditorReference; site: EditorSite }) {
  const [view, setView] = React.useState(settings);
  const [colours, setColours] = React.useState(() => colourDraft(settings));
  const [identity, setIdentity] = React.useState(() => ({ ...settings.identity }));
  const [sections, setSections] = React.useState<EditorSection[]>(settings.sections);

  // The forms submit what is on screen, not what the browser serialised, because the section order lives in state.
  const latest = React.useRef({ colours, identity, sections, view });
  latest.current = { colours, identity, sections, view };

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
    return saved(
      updateWebsiteThemeAction(
        draft.preset === "CUSTOM"
          ? { preset: draft.preset, surfaceMode: draft.surfaceMode, primaryHex: draft.primaryHex, secondaryHex: draft.secondaryHex, accentHex: draft.accentHex, ...gradient }
          : { preset: draft.preset, surfaceMode: draft.surfaceMode, ...gradient },
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
              <CardDescription>Pick a ready-made palette or choose your own. Colours that would be unreadable on your website background are refused.</CardDescription>
            </CardHeader>
            <CardContent>
              <RadioGroup
                name="preset"
                label="Palette"
                disabled={disabled}
                value={colours.preset}
                onValueChange={(value) => setColours((current) => ({ ...current, preset: value as WebsiteThemePresetName }))}
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
                onValueChange={(value) => setColours((current) => ({ ...current, surfaceMode: value as WebsiteSurfaceModeName }))}
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
                    onChange={(value) => setColours((current) => ({ ...current, primaryHex: value }))}
                  />
                  <ColourField
                    name="secondaryHex"
                    label="Secondary colour"
                    value={colours.secondaryHex}
                    disabled={disabled}
                    onChange={(value) => setColours((current) => ({ ...current, secondaryHex: value }))}
                  />
                  <ColourField
                    name="accentHex"
                    label="Accent colour"
                    value={colours.accentHex}
                    disabled={disabled}
                    onChange={(value) => setColours((current) => ({ ...current, accentHex: value }))}
                  />
                </div>
              )}
              <Switch
                name="useGradient"
                label="Use my own hero gradient"
                help="Off keeps the gradient that comes with the palette."
                checked={colours.useGradient}
                disabled={disabled}
                onChange={(event) => setColours((current) => ({ ...current, useGradient: event.target.checked }))}
              />
              {colours.useGradient && (
                <div className="grid gap-4 md:grid-cols-2">
                  <ColourField
                    name="gradientFromHex"
                    label="Gradient start"
                    value={colours.gradientFromHex}
                    disabled={disabled}
                    onChange={(value) => setColours((current) => ({ ...current, gradientFromHex: value }))}
                  />
                  <ColourField
                    name="gradientToHex"
                    label="Gradient end"
                    value={colours.gradientToHex}
                    disabled={disabled}
                    onChange={(value) => setColours((current) => ({ ...current, gradientToHex: value }))}
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
                  { value: "STRIP", label: "Swipe strip", description: "A row of today's dishes guests swipe through." },
                  { value: "GRID", label: "Cards", description: "Today's dishes as a grid." },
                ]}
              />
              {!disabled && (
                <div className="flex justify-end">
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
                <CardDescription>Your logo appears in the website header; the cover photo is used when no hero image is set.</CardDescription>
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
                    help="A square image works best, at least 256 × 256 pixels."
                  />
                  <ImageUploader
                    name="coverImageUrl"
                    label="Cover photo"
                    purpose="COVER"
                    disabled={disabled}
                    value={identity.coverImageUrl ?? ""}
                    onChange={(url) => setIdentity((current) => ({ ...current, coverImageUrl: url }))}
                    help="A wide photo of your food or dining room, at least 1600 pixels across."
                  />
                </div>
                {!disabled && (
                  <div className="flex justify-end">
                    <SubmitButton>Save logo and cover</SubmitButton>
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
