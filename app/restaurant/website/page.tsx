import { PageHeader } from "@/components/layout/page-header";
import { requireTenantPage } from "@/lib/auth/guards";
import { getRestaurantSettingsSnapshot } from "@/lib/data/restaurant";
import { SURFACE_HEX, THEME_PRESETS, getWebsiteSettings, resolveTheme } from "@/lib/services/website-theme";
import { WEBSITE_SURFACE_MODES, type WebsiteSurfaceModeName } from "@/lib/validation/website";
import { WebsiteEditor, type EditorReference, type EditorSettings } from "./website-editor";

export const dynamic = "force-dynamic";

/**
 * Website customisation (S1-P07-T011; ADR-013 §6/§7) — what a restaurant owns about its own public site.
 *
 * Reading the settings needs `restaurant:read`, so a manager can see how the site is configured; every save needs
 * `website:update`, which the actions re-check on the server (UI visibility is not authorization, CLAUDE.md rule 3).
 *
 * The preset palettes for *both* surface modes are handed to the client so the preview is accurate before anything
 * is saved. They are fixed, contrast-checked constants of the theme service, not tenant data.
 */
function presetReference(): EditorReference {
  const presets = Object.fromEntries(
    (Object.keys(THEME_PRESETS) as Array<keyof typeof THEME_PRESETS>).map((preset) => [
      preset,
      Object.fromEntries(WEBSITE_SURFACE_MODES.map((mode) => [mode, THEME_PRESETS[preset][mode]])),
    ]),
  ) as EditorReference["presetPalettes"];

  const onSurfaceHex = Object.fromEntries(
    WEBSITE_SURFACE_MODES.map((mode: WebsiteSurfaceModeName) => [
      mode,
      resolveTheme({ preset: "PLATFORM", surfaceMode: mode, primaryHex: null, secondaryHex: null, accentHex: null, gradientFromHex: null, gradientToHex: null }).onSurface,
    ]),
  ) as Record<WebsiteSurfaceModeName, string>;

  return { presetPalettes: presets, surfaceHex: SURFACE_HEX, onSurfaceHex };
}

export default async function WebsiteSettingsPage() {
  // Management screen: owners edit, managers read (`canEdit`); cashier, kitchen and waiter staff are refused it like
  // every other management screen (TC-ROLE-010).
  const ctx = await requireTenantPage("dashboard:read");
  const [settings, snapshot] = await Promise.all([getWebsiteSettings(ctx), getRestaurantSettingsSnapshot(ctx)]);

  return (
    <>
      <PageHeader
        title="Website"
        description={`Colours, branding, details and sections of ${snapshot.restaurant.name}'s public website.`}
      />
      <WebsiteEditor
        settings={settings as unknown as EditorSettings}
        reference={presetReference()}
        site={{
          name: snapshot.restaurant.name,
          slug: snapshot.slug,
          published: snapshot.restaurant.websitePublished,
          publicPath: `/r/${snapshot.slug}`,
        }}
      />
    </>
  );
}
