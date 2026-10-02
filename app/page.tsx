import type { Metadata } from "next";
import Link from "next/link";
import { BookOpen, ChefHat, Printer, Receipt, Store, Users } from "lucide-react";
import { Icon } from "@/components/ui/icon";
import { IconTile } from "@/components/ui/icon-tile";
import { BrandMark } from "@/components/layout/brand";
import type { DomainHue } from "@/lib/ui/icons";
import { FoodBackdrop } from "@/components/layout/food-backdrop";

export const metadata: Metadata = {
  title: "RASOIOS — Restaurant Operations",
  description: "Licensed restaurant software: menu, counter ordering, kitchen tickets and thermal printing in one console.",
};

/**
 * Landing page (ADR-013 §1–§2): the Brand v2 dark-glass impression that carries straight into the console. The copy
 * stays honest — RASOIOS is licensed software (ADR-002), so there are no plans, tiers, trials or prices anywhere on
 * this page, no demo links and no status claims. TC-DS-015 checks every link resolves and that none of that language
 * comes back.
 */
const CAPABILITIES: Array<{ icon: typeof BookOpen; hue: DomainHue; title: string; body: string }> = [
  {
    icon: BookOpen,
    hue: "warning",
    title: "Menus that stay in sync",
    body: "Manage categories, items, variants and add-ons in one place, publish a daily menu, and show it on your restaurant's own web page.",
  },
  {
    icon: ChefHat,
    hue: "secondary-soft",
    title: "Counter to kitchen",
    body: "Take dine-in, takeaway and delivery orders, send kitchen tickets to the right station, and follow every order from new to served.",
  },
  {
    icon: Printer,
    hue: "accent",
    title: "Thermal printing",
    body: "Kitchen tickets and receipts are queued in the cloud and printed by a small agent on your USB or network thermal printers.",
  },
];

const DETAILS: Array<{ icon: typeof Receipt; hue: DomainHue; text: string }> = [
  { icon: Receipt, hue: "warning", text: "Payments, refunds and day close recorded against each order" },
  { icon: Users, hue: "tertiary-soft", text: "Separate access for owners, managers, cashiers, kitchen staff and waiters" },
  { icon: Store, hue: "primary", text: "Each restaurant works in its own space; staff join by invitation" },
];

export default function Home() {
  return (
    <div className="page-wash isolate flex min-h-screen flex-col bg-canvas text-fg-primary">
      <FoodBackdrop />
      <header className="glass-1 sticky top-0 z-header border-b">
        <div className="mx-auto flex h-header w-full max-w-public items-center justify-between gap-3 px-4 sm:px-6 lg:px-10">
          <BrandMark href="/" />
          <Link
            href="/sign-in"
            className="inline-flex h-11 items-center rounded-xl bg-action-primary px-4 text-label text-action-primary-fg transition-colors duration-fast ease-standard hover:bg-action-primary-hover motion-safe:hover:shadow-glow"
          >
            Sign in
          </Link>
        </div>
      </header>

      <main id="main-content" className="flex-1">
        <section className="mx-auto grid max-w-public items-center gap-8 px-4 py-12 sm:px-6 md:py-16 lg:grid-cols-12 lg:px-10">
          <div className="space-y-6 lg:col-span-7">
            <p className="inline-flex items-center gap-2 rounded-full border border-border-subtle bg-action-primary/12 px-3 py-1 text-label text-fg-accent">
              Licensed restaurant software — no subscription plans
            </p>
            <h1 className="text-display-xl">Run your restaurant&apos;s menu, orders, kitchen and printing from one place.</h1>
            <p className="max-w-2xl text-body-public text-fg-secondary">
              RASOIOS is software your restaurant licenses and uses on its own terms: a web console for your team, a kitchen board, cloud
              thermal printing and a public menu page for your guests.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Link
                href="/sign-in"
                className="inline-flex h-12 items-center rounded-xl bg-action-primary px-5 text-label text-action-primary-fg transition-colors duration-fast ease-standard hover:bg-action-primary-hover motion-safe:hover:shadow-glow"
              >
                Sign in to your restaurant
              </Link>
              <a
                href="#capabilities"
                className="inline-flex h-12 items-center rounded-xl border border-border-strong px-5 text-label text-fg-primary transition-colors duration-fast ease-standard hover:bg-raised"
              >
                See what it does
              </a>
            </div>
          </div>

          <ul className="space-y-3 lg:col-span-5" aria-label="Highlights">
            {DETAILS.map(({ icon, hue, text }) => (
              <li key={text} className="glass-2 flex items-center gap-3 rounded-2xl p-4">
                <IconTile icon={icon} size="sm" tone={hue} />
                <span className="text-body text-fg-primary">{text}</span>
              </li>
            ))}
          </ul>
        </section>

        <section id="capabilities" className="mx-auto max-w-public px-4 py-12 sm:px-6 md:py-16 lg:px-10">
          <h2 className="mb-8 text-display-l">What your team gets</h2>
          <div className="grid items-stretch gap-4 md:grid-cols-3 md:gap-6">
            {CAPABILITIES.map(({ icon, hue, title, body }) => (
              <article key={title} className="flex flex-col gap-3 rounded-2xl border border-border-subtle bg-card p-6 shadow-e1">
                <IconTile icon={icon} size="md" tone={hue} />
                <h3 className="font-sans text-heading">{title}</h3>
                <p className="text-body-public text-fg-secondary">{body}</p>
              </article>
            ))}
          </div>
        </section>
      </main>

      <footer className="border-t border-border-subtle">
        <div className="mx-auto flex max-w-public flex-col items-center justify-between gap-2 px-4 py-6 text-caption text-fg-secondary sm:flex-row sm:px-6 lg:px-10">
          <span className="inline-flex items-center gap-2">
            <Icon icon={Store} size={16} />
            RASOIOS — licensed restaurant software
          </span>
          <Link href="/sign-in" className="hover:text-fg-primary">
            Sign in
          </Link>
        </div>
      </footer>
    </div>
  );
}
