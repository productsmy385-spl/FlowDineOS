import type { Metadata } from "next";
import localFont from "next/font/local";
import { headers } from "next/headers";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";
import { PwaRegister } from "@/components/pwa-register";
import { THEME_BOOT_SCRIPT } from "@/lib/ui/theme";

/**
 * Brand fonts (S1-P08-T002, SC-HDR-02): served from our own origin, never Google, at build time *or* runtime.
 *
 * `next/font/google` self-hosts the files it ships, but it downloads them from Google during `next build`, so every
 * build depended on fonts.googleapis.com answering with exactly the CSS shape its parser expects. When it did not,
 * the build died with `Cannot read properties of null (reading '1')` inside the font loader — three times on
 * 2026-09-25 alone, on unrelated commits [fact: CI runs 36122364595, 36125556735]. A build that needs a third party
 * to be up is a build that fails for reasons that have nothing to do with the change being built.
 *
 * The two latin variable files are vendored in `app/fonts/` instead. One file per family covers every weight used
 * (Inter 400–700, Plus Jakarta Sans 400–700), the bytes are identical to what the loader fetched, and the
 * build is now reproducible offline. Re-download from Google Fonts only to pick up a new font version.
 */
// Typography (RASOIOS-ADR-020, owner 2026-10-03, from the Stitch "Culinary Operations System"): Plus Jakarta Sans
// carries headings and system anchors, Inter carries body text, tables, order lines and figures. Supersedes ADR-013's
// Playfair Display + Plus Jakarta Sans pairing.
const display = localFont({
  src: "./fonts/PlusJakartaSans-Variable.woff2",
  weight: "400 700",
  style: "normal",
  display: "swap",
  variable: "--font-display",
  fallback: ["system-ui", "sans-serif"],
});
const sans = localFont({
  src: "./fonts/Inter-Variable.woff2",
  weight: "400 700",
  style: "normal",
  display: "swap",
  variable: "--font-sans",
  fallback: ["system-ui", "sans-serif"],
});

export const metadata: Metadata = {
  title: "FlowDineOS — Restaurant Operations Platform",
  description: "Menu management, counter ordering, kitchen tickets and thermal printing for restaurants.",
  manifest: "/manifest.json",
};

// ClerkProvider always wraps the app (S1-P03-T002). Keys are validated at server start (lib/env.ts), so there is
// no unauthenticated fallback rendering path. The platform renders dark by default; THEME_BOOT_SCRIPT switches the
// root element to the person's saved light/dark/system choice before the first paint (ADR-016). A restaurant's public
// page sets its own theme on its page wrapper and is unaffected (ADR-013 §6). The script changes the root element's
// attributes before React hydrates, hence suppressHydrationWarning on that one element.
export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // The per-request script nonce set by the middleware (Content-Security-Policy). `dynamic` makes Clerk read it too;
  // every page is rendered per request so each one carries its own nonce.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <ClerkProvider afterSignOutUrl="/sign-in" dynamic>
      <html lang="en" className={`dark ${display.variable} ${sans.variable}`} data-theme="dark" suppressHydrationWarning>
        <head>
          {/* Browsers hide a script's nonce from the DOM once it has run (nonce=""), so React would report a mismatch. */}
          <script id="theme-boot" nonce={nonce} suppressHydrationWarning>
            {THEME_BOOT_SCRIPT}
          </script>
        </head>
        <body className="bg-canvas text-fg-primary antialiased selection:bg-action-primary selection:text-action-primary-fg">
          <PwaRegister />
          {children}
        </body>
      </html>
    </ClerkProvider>
  );
}
