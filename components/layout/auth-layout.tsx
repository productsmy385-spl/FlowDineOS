import * as React from "react";
import { CheckCircle2 } from "lucide-react";
import { PLATFORM_NAME, PLATFORM_TAGLINE } from "@/lib/brand";
import { BrandMark } from "./brand";
import { FoodBackdrop } from "./food-backdrop";

/**
 * Auth page frame (ADR-013 §1, design.md §4.2; owner brief 2026-10-06 §14). The same brand impression as the landing
 * page, so signing in does not change worlds. Phones: one centred column (max 440 px, 16 px gutters) with the brand
 * mark, the page's single h1 and a short description. Desktop: a FlowDineOS panel on the left and the form on the
 * right. The form always sits on an opaque card — never on glass or blur.
 */
const POINTS = ["Orders, kitchen and billing in one flow", "Each person sees only their own work", "Your restaurant's data stays your own"];

export function AuthLayout({ title, description, children, footer }: { title: string; description?: React.ReactNode; children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <div className="page-wash isolate flex min-h-screen flex-col bg-canvas text-fg-primary">
      <FoodBackdrop />
      <div className="mx-auto flex w-full max-w-public flex-1 items-center gap-12 px-4 py-10 lg:px-10">
        <aside aria-label={PLATFORM_NAME} className="hidden flex-1 flex-col gap-6 lg:flex">
          <BrandMark href="/" />
          <p className="text-display-l text-fg-primary">{PLATFORM_TAGLINE}</p>
          <ul className="flex flex-col gap-3">
            {POINTS.map((point) => (
              <li key={point} className="flex items-center gap-3 text-body-public text-fg-secondary">
                <CheckCircle2 aria-hidden className="size-5 shrink-0 text-fg-accent" />
                {point}
              </li>
            ))}
          </ul>
        </aside>
        <main id="main-content" className="mx-auto flex w-full max-w-auth flex-col justify-center gap-6 lg:mx-0">
          <div className="flex flex-col items-center gap-4 text-center">
            <span className="lg:hidden">
              <BrandMark href="/" />
            </span>
            <div className="flex flex-col gap-2">
              <h1 className="text-display-m text-fg-primary">{title}</h1>
              {description && <p className="text-body-public text-fg-secondary">{description}</p>}
            </div>
          </div>
          {children}
          {footer && <div className="text-center text-caption text-fg-secondary">{footer}</div>}
        </main>
      </div>
    </div>
  );
}
