import Link from "next/link";
import { BrandMark } from "@/components/layout/brand";
import { FoodBackdrop } from "@/components/layout/food-backdrop";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { COMPANY_ADDRESS, COMPANY_EMAILS, COMPANY_NAME, COMPANY_PHONE, COMPANY_PHONE_TEL, COPYRIGHT } from "@/lib/brand";

/** Frame for the platform's legal pages (/privacy, /terms): readable prose on an opaque card, the company's contact. */
export function LegalPage({ title, updated, children }: { title: string; updated: string; children: React.ReactNode }) {
  return (
    <div className="page-wash isolate flex min-h-screen flex-col bg-canvas text-fg-primary">
      <FoodBackdrop />
      <header className="glass-1 sticky top-0 z-header border-b">
        <div className="mx-auto flex h-header w-full max-w-public items-center justify-between gap-3 px-4 sm:px-6 lg:px-10">
          <BrandMark href="/" />
          <div className="flex items-center gap-2">
            <ThemeToggle saveToAccount={false} />
            <Link href="/" className="inline-flex h-11 items-center rounded-xl border border-border-strong px-4 text-label text-fg-primary hover:bg-raised">
              Home
            </Link>
          </div>
        </div>
      </header>
      <main id="main-content" className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 sm:px-6">
        <article className="flex flex-col gap-5 rounded-3xl border border-border-subtle bg-card p-6 md:p-10 [&_h2]:mt-4 [&_h2]:text-heading [&_li]:ml-5 [&_li]:list-disc [&_p]:text-body-public [&_p]:text-fg-secondary [&_ul]:flex [&_ul]:flex-col [&_ul]:gap-1 [&_ul]:text-body-public [&_ul]:text-fg-secondary">
          <div>
            <h1 className="text-display-l text-fg-primary">{title}</h1>
            <p className="mt-2 text-caption">Last updated {updated}</p>
          </div>
          {children}
          <h2>Contact</h2>
          <p>
            {COMPANY_NAME}, {COMPANY_ADDRESS.join(", ")}. Phone <a href={`tel:${COMPANY_PHONE_TEL}`} className="text-fg-accent">{COMPANY_PHONE}</a>. Email{" "}
            {COMPANY_EMAILS.map((email, i) => (
              <span key={email}>
                {i > 0 ? ", " : ""}
                <a href={`mailto:${email}`} className="break-all text-fg-accent">
                  {email}
                </a>
              </span>
            ))}
            .
          </p>
        </article>
      </main>
      <footer className="border-t border-border-subtle">
        <p className="mx-auto max-w-public px-4 py-5 text-caption text-fg-secondary sm:px-6 lg:px-10">
          {COPYRIGHT}. <Link href="/privacy" className="hover:text-fg-primary">Privacy Policy</Link> · <Link href="/terms" className="hover:text-fg-primary">Terms</Link>
        </p>
      </footer>
    </div>
  );
}
