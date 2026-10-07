import type { Metadata } from "next";
import Link from "next/link";
import {
  Archive,
  BarChart3,
  BookOpen,
  CalendarDays,
  ChefHat,
  ClipboardList,
  Globe,
  LayoutDashboard,
  Lock,
  Mail,
  Palette,
  Phone,
  Printer,
  QrCode,
  Receipt,
  Share2,
  Smartphone,
  Store,
  Users,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { BrandMark } from "@/components/layout/brand";
import { FoodBackdrop } from "@/components/layout/food-backdrop";
import { BookDemoButton } from "@/components/landing/demo-booking";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { HeroBackdrop, Metrics, Showcase } from "@/components/landing/landing-interactive";
import { IconTile } from "@/components/ui/icon-tile";
import { FEATURE_KEYS } from "@/lib/auth/features";
import { COMPANY_ADDRESS, COMPANY_EMAILS, COMPANY_NAME, COMPANY_PHONE, COMPANY_PHONE_TEL, COPYRIGHT, PLATFORM_DOMAIN, PLATFORM_NAME, PLATFORM_TAGLINE } from "@/lib/brand";
import type { DomainHue } from "@/lib/ui/icons";

const DESCRIPTION =
  "FlowDineOS brings restaurant orders, kitchen operations, KOT printing, billing, table QR menus, menus, customers, reports and restaurant websites into one modern platform.";

export const metadata: Metadata = {
  title: `${PLATFORM_NAME} — Restaurant Operations Platform`,
  description: DESCRIPTION,
  alternates: { canonical: `https://${PLATFORM_DOMAIN}/` },
  openGraph: { type: "website", url: `https://${PLATFORM_DOMAIN}/`, siteName: PLATFORM_NAME, title: `${PLATFORM_NAME} — Restaurant Operations Platform`, description: DESCRIPTION },
  twitter: { card: "summary_large_image", title: `${PLATFORM_NAME} — Restaurant Operations Platform`, description: DESCRIPTION },
};

/**
 * The FlowDineOS platform landing page (owner brief 2026-10-06 §30–45) — the platform's own page, not a restaurant's
 * website. The copy stays honest: FlowDineOS is licensed software (ADR-002), so there are no plans, prices or trials;
 * figures are facts about the software, never about customers; table QR codes open menus (guests do not order from
 * them, Q-001). TC-DS-015 checks every link resolves and that plan language never comes back.
 */
type Feature = { icon: LucideIcon; hue: DomainHue; title: string; body: string };

const FEATURES: Feature[] = [
  { icon: LayoutDashboard, hue: "primary", title: "Restaurant dashboard", body: "Today's sales, open orders, the kitchen load and staff on shift, live." },
  { icon: ClipboardList, hue: "warning", title: "Orders", body: "Dine-in, takeaway and delivery orders from the counter, followed from new to served." },
  { icon: ChefHat, hue: "secondary-soft", title: "Kitchen operations", body: "A kitchen board by station: queued, preparing and ready, with timers and urgency." },
  { icon: Printer, hue: "accent", title: "KOT printing", body: "Kitchen tickets print on your own USB or network thermal printers through a small local agent." },
  { icon: Receipt, hue: "tertiary-soft", title: "Billing and payments", body: "Cash, card and UPI, part payments, refunds and the day close, with the receipt printed on payment." },
  { icon: QrCode, hue: "accent-soft", title: "Table QR menus", body: "A QR code on each table opens your menu on the guest's phone. No app to install." },
  { icon: BookOpen, hue: "warning", title: "Menu management", body: "Categories, dishes, variants, add-ons, prices and availability in one place." },
  { icon: CalendarDays, hue: "primary", title: "Daily menu", body: "Publish today's dishes, shown on your website the moment you do." },
  { icon: UserRound, hue: "secondary", title: "Customer management", body: "A customer list linked to orders, kept to your own restaurant." },
  { icon: BarChart3, hue: "primary", title: "Reports", body: "Sales, tax and payment summaries by day, exportable to Excel." },
  { icon: Users, hue: "tertiary-soft", title: "Staff management", body: "Owners, managers, cashiers, kitchen staff and waiters, each seeing only their own work." },
  { icon: Globe, hue: "secondary-soft", title: "Restaurant website", body: "Your own site with a 3D menu, today's dishes, hours, gallery and contact details." },
  { icon: Palette, hue: "accent", title: "Brand Kit", body: "Your logo, your named colours and your fonts on your website." },
  { icon: Share2, hue: "warning", title: "Social sharing", body: "Share your restaurant and any dish to WhatsApp or Facebook, with a caption ready for Instagram." },
  { icon: Store, hue: "primary", title: "Printer management", body: "Find printers on your network, test them and see every ticket's print state." },
  { icon: Archive, hue: "secondary", title: "Data export and backup", body: "Download your records to your own computer as Excel, CSV or a full backup." },
  { icon: Lock, hue: "tertiary-soft", title: "Restaurant isolation", body: "Every restaurant's data is kept apart and checked on the server, on every request." },
  { icon: Smartphone, hue: "accent-soft", title: "Phone and tablet ready", body: "Installs to the home screen and works from a 320 px phone to a wide desktop." },
];

const SOLUTIONS = [
  { title: "Restaurants", body: "Dine-in, takeaway and delivery with tables, kitchen stations and bills." },
  { title: "Cafés", body: "Quick counter orders, a daily menu and receipts on a small printer." },
  { title: "Bakeries", body: "Counter sales, daily specials and a menu guests can browse from a QR code." },
  { title: "Cloud kitchens", body: "Orders to kitchen tickets by station, with timers and urgency." },
  { title: "Food businesses", body: "Any food business that takes orders, cooks them and bills for them." },
];

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-");
const PRODUCT_LINKS: ReadonlyArray<readonly [string, string]> = [
  [`#feature-${slug("Restaurant dashboard")}`, "Dashboard"],
  [`#feature-${slug("Orders")}`, "Orders"],
  [`#feature-${slug("Kitchen operations")}`, "Kitchen"],
  [`#feature-${slug("KOT printing")}`, "KOT printing"],
  [`#feature-${slug("Billing and payments")}`, "Billing"],
  [`#feature-${slug("Table QR menus")}`, "QR menus"],
  [`#feature-${slug("Menu management")}`, "Menu"],
  [`#feature-${slug("Reports")}`, "Reports"],
];
const SOLUTION_LINKS: ReadonlyArray<readonly [string, string]> = SOLUTIONS.map((item) => [`#solution-${slug(item.title)}`, item.title] as const);

const STEPS = [
  { title: "We set up your restaurant", body: "Your restaurant, its address and the features it uses are created for you, and you are invited by email." },
  { title: "Add your menu and team", body: "Enter or import your menu, invite managers, and give counter and kitchen staff their daily passwords." },
  { title: "Connect your printers", body: "Install the print agent on a counter PC and pick your thermal printers from the network." },
  { title: "Open for service", body: "Take orders, run the kitchen board, print tickets and receipts, and publish your website and QR menus." },
];

const WHY = [
  { title: "One flow, end to end", body: "The order a cashier takes is the ticket the kitchen sees, the bill the guest pays and the line in tonight's report." },
  { title: "Your restaurant, your data", body: "Backups download to your own computer whenever you want them. Nothing is locked in." },
  { title: "Honest by design", body: "A ticket shows as delivered only when the print agent confirms the printer took it, and sharing never claims a post you did not make." },
];

export default function Home() {
  return (
    <div className="page-wash isolate flex min-h-screen flex-col bg-canvas text-fg-primary">
      <FoodBackdrop />
      <header className="glass-1 sticky top-0 z-header border-b">
        <div className="mx-auto flex h-header w-full max-w-public items-center justify-between gap-3 px-4 sm:px-6 lg:px-10">
          <BrandMark href="/" />
          <nav aria-label="Page sections" className="hidden items-center gap-1 lg:flex">
            {[
              ["#features", "Features"],
              ["#how-it-works", "How it works"],
              ["#security", "Security"],
              ["#solutions", "Who it's for"],
              ["#contact", "Contact"],
            ].map(([href, label]) => (
              <a key={href} href={href} className="inline-flex h-10 items-center rounded-xl px-3 text-nav text-fg-secondary hover:text-fg-primary">
                {label}
              </a>
            ))}
          </nav>
          <div className="flex items-center gap-2">
            <ThemeToggle saveToAccount={false} />
            <Link href="/sign-in" className="hidden h-11 items-center rounded-xl border border-border-strong px-4 text-label text-fg-primary hover:bg-raised sm:inline-flex">
              Sign in
            </Link>
            <BookDemoButton className="h-11 px-4" />
          </div>
        </div>
      </header>

      <main id="main-content" className="flex-1">
        <HeroBackdrop>
          <div className="mx-auto grid max-w-public gap-10 px-4 pb-20 pt-14 sm:px-6 md:pt-20 lg:grid-cols-12 lg:px-10">
            <div className="flex flex-col gap-6 lg:col-span-7">
              <p className="inline-flex w-fit items-center gap-2 rounded-full border border-border-subtle bg-card/80 px-3 py-1 text-label text-fg-accent">
                Licensed restaurant software — no subscription plans
              </p>
              <h1 id="hero-title" className="text-display-xl">
                Run your restaurant. One flow.
              </h1>
              <p className="max-w-2xl text-body-public text-fg-primary">{DESCRIPTION}</p>
              <div className="flex flex-wrap items-center gap-3">
                <BookDemoButton />
                <a href="#features" className="inline-flex h-12 items-center rounded-xl border border-border-strong bg-card/70 px-5 text-label text-fg-primary transition-colors duration-fast ease-standard hover:bg-raised">
                  Explore {PLATFORM_NAME}
                </a>
              </div>
              <p className="text-body text-fg-secondary">
                Already using {PLATFORM_NAME}?{" "}
                <Link href="/sign-in" className="text-fg-accent underline-offset-4 hover:underline">
                  Sign in to your restaurant
                </Link>
              </p>
            </div>
            <div className="lg:col-span-5 lg:self-end">
              <Metrics
                items={[
                  { value: FEATURE_KEYS.length, label: "features in one console" },
                  { value: 6, label: "roles, each with its own view" },
                  { value: 5, label: "second kitchen board refresh" },
                  { value: 0, label: "subscription plans" },
                ]}
              />
            </div>
          </div>
        </HeroBackdrop>

        <section aria-labelledby="overview-title" className="mx-auto max-w-public px-4 pt-16 sm:px-6 lg:px-10">
          <h2 id="overview-title" className="text-display-l">
            Restaurant operations, simplified
          </h2>
          <p className="mt-3 max-w-3xl text-body-public text-fg-secondary">
            From the counter to the kitchen to the bill, and out to your guests&apos; phones: one platform your whole team works in, each person seeing what
            their role needs.
          </p>
          <Showcase />
        </section>

        <section id="features" aria-labelledby="features-title" className="mx-auto max-w-public scroll-mt-24 px-4 py-16 sm:px-6 lg:px-10">
          <h2 id="features-title" className="text-display-l">
            Everything in {PLATFORM_NAME}
          </h2>
          <ul className="mt-8 grid list-none grid-cols-[repeat(auto-fill,minmax(min(100%,17rem),1fr))] gap-4 p-0">
            {FEATURES.map(({ icon, hue, title, body }) => (
              <li key={title} id={`feature-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`} className="flex scroll-mt-24">
                <article className="flex w-full flex-col gap-3 rounded-2xl border border-border-subtle bg-card p-5 shadow-e1 transition-transform duration-fast motion-safe:hover:-translate-y-1">
                  <IconTile icon={icon} size="md" tone={hue} />
                  <h3 className="font-sans text-heading">{title}</h3>
                  <p className="text-body text-fg-secondary">{body}</p>
                </article>
              </li>
            ))}
          </ul>
        </section>

        <section id="solutions" aria-labelledby="solutions-title" className="mx-auto max-w-public scroll-mt-24 px-4 py-16 sm:px-6 lg:px-10">
          <h2 id="solutions-title" className="text-display-l">
            Who it&apos;s for
          </h2>
          <ul className="mt-8 grid list-none grid-cols-[repeat(auto-fill,minmax(min(100%,13rem),1fr))] gap-4 p-0">
            {SOLUTIONS.map((item) => (
              <li key={item.title} id={`solution-${item.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`} className="glass-2 flex scroll-mt-24 flex-col gap-2 rounded-2xl p-5">
                <h3 className="font-sans text-heading">{item.title}</h3>
                <p className="text-body text-fg-secondary">{item.body}</p>
              </li>
            ))}
          </ul>
        </section>

        <section id="how-it-works" aria-labelledby="how-title" className="mx-auto max-w-public scroll-mt-24 px-4 py-16 sm:px-6 lg:px-10">
          <h2 id="how-title" className="text-display-l">
            How it works
          </h2>
          <ol className="mt-8 grid list-none gap-4 p-0 md:grid-cols-2 xl:grid-cols-4">
            {STEPS.map((step, index) => (
              <li key={step.title} className="glass-2 flex flex-col gap-2 rounded-2xl p-5">
                <span className="font-display text-display-m text-fg-accent">{index + 1}</span>
                <h3 className="font-sans text-heading">{step.title}</h3>
                <p className="text-body text-fg-secondary">{step.body}</p>
              </li>
            ))}
          </ol>
        </section>

        <section id="security" aria-labelledby="security-title" className="mx-auto max-w-public scroll-mt-24 px-4 py-16 sm:px-6 lg:px-10">
          <div className="grid gap-8 rounded-3xl border border-border-subtle bg-card p-6 md:p-10 lg:grid-cols-2">
            <div>
              <h2 id="security-title" className="text-display-l">
                Data and security
              </h2>
              <p className="mt-3 text-body-public text-fg-secondary">
                Each restaurant works in its own space. Who you are and which restaurant you belong to are decided on the server for every request — never by
                anything a browser sends.
              </p>
            </div>
            <ul className="flex list-disc flex-col gap-2 pl-5 text-body text-fg-primary">
              <li>Every role sees and does only what it is allowed to, checked on the server, not just hidden on screen.</li>
              <li>Money is stored as exact decimals, and every bill keeps the prices and tax it was charged at.</li>
              <li>Sign-ins, payments, refunds, backups and deletions are recorded in an audit log.</li>
              <li>Staff daily passwords are stored only as secure hashes and expire every day.</li>
              <li>Backups download to your own computer; passwords and tokens are never in them.</li>
            </ul>
          </div>
        </section>

        <section id="about" aria-labelledby="why-title" className="mx-auto max-w-public scroll-mt-24 px-4 py-16 sm:px-6 lg:px-10">
          <h2 id="why-title" className="text-display-l">
            Why {PLATFORM_NAME}
          </h2>
          <div className="mt-8 grid gap-4 md:grid-cols-3">
            {WHY.map((item) => (
              <article key={item.title} className="glass-2 rounded-2xl p-5">
                <h3 className="font-sans text-heading">{item.title}</h3>
                <p className="mt-2 text-body text-fg-secondary">{item.body}</p>
              </article>
            ))}
          </div>
          <div className="mt-10 flex flex-col items-start gap-4 rounded-3xl border border-border-subtle bg-card p-6 md:flex-row md:items-center md:justify-between md:p-8">
            <p className="text-heading">Ready to run your restaurant in one flow?</p>
            <BookDemoButton />
          </div>
        </section>

      </main>

      <footer className="border-t border-border-subtle bg-card/70">
        <div className="mx-auto grid max-w-public gap-8 px-4 py-10 sm:grid-cols-2 sm:px-6 lg:grid-cols-[1.2fr_1fr_1fr_1fr_1.6fr] lg:px-10">
          <div className="flex flex-col gap-3">
            <BrandMark href="/" />
            <p className="text-body text-fg-secondary">{PLATFORM_TAGLINE}</p>
            <BookDemoButton className="h-11 w-fit px-4" />
          </div>
          <FooterLinks title="Product" links={PRODUCT_LINKS} />
          <FooterLinks title="Solutions" links={SOLUTION_LINKS} />
          <div className="flex flex-col gap-6">
            <FooterLinks
              title="Company"
              links={[
                ["#about", "About"],
                ["#contact", "Contact"],
                ["/book-demo", "Book a Demo"],
              ]}
            />
            <div className="flex flex-col gap-2 text-body">
              <p className="text-label text-fg-primary">Legal</p>
              <Link href="/privacy" className="inline-flex min-h-9 items-center text-fg-secondary hover:text-fg-primary">
                Privacy Policy
              </Link>
              <Link href="/terms" className="inline-flex min-h-9 items-center text-fg-secondary hover:text-fg-primary">
                Terms
              </Link>
            </div>
          </div>
          {/* The one place the company's contact details appear (owner brief 2026-10-07 §29–32). */}
          <address id="contact" className="flex min-w-0 scroll-mt-24 flex-col gap-2 text-body not-italic">
            <p className="text-label text-fg-primary">Contact</p>
            <p className="text-fg-primary">{COMPANY_NAME}</p>
            <p className="text-fg-secondary">
              {COMPANY_ADDRESS.map((line) => (
                <span key={line} className="block">
                  {line}
                </span>
              ))}
            </p>
            <a href={`tel:${COMPANY_PHONE_TEL}`} className="inline-flex min-h-11 w-fit items-center gap-2 text-fg-primary hover:text-fg-accent" data-testid="footer-phone">
              <Phone aria-hidden className="size-4 shrink-0" />
              {COMPANY_PHONE}
            </a>
            {COMPANY_EMAILS.map((email) => (
              <a key={email} href={`mailto:${email}`} className="inline-flex min-h-11 min-w-0 items-center gap-2 break-all text-fg-secondary hover:text-fg-primary">
                <Mail aria-hidden className="size-4 shrink-0" />
                <span className="min-w-0 break-all">{email}</span>
              </a>
            ))}
          </address>
        </div>
        <div className="border-t border-border-subtle">
          <p className="mx-auto max-w-public px-4 py-5 text-caption text-fg-secondary sm:px-6 lg:px-10">
            {COPYRIGHT}. {PLATFORM_NAME} is licensed restaurant software.
          </p>
        </div>
      </footer>
    </div>
  );
}

function FooterLinks({ title, links }: { title: string; links: ReadonlyArray<readonly [string, string]> }) {
  return (
    <nav aria-label={title} className="flex flex-col gap-1 text-body">
      <p className="mb-1 text-label text-fg-primary">{title}</p>
      {links.map(([href, label]) =>
        href.startsWith("/") ? (
          <Link key={href} href={href} className="inline-flex min-h-9 items-center text-fg-secondary hover:text-fg-primary">
            {label}
          </Link>
        ) : (
          <a key={href} href={href} className="inline-flex min-h-9 items-center text-fg-secondary hover:text-fg-primary">
            {label}
          </a>
        ),
      )}
    </nav>
  );
}
