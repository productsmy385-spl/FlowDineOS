import Link from "next/link";
import Image from "next/image";
import { cn } from "@/lib/ui/cn";

/**
 * FlowDineOS wordmark (frontend.md §3.1 "Brand"). The mark carries the brand gradient frame and the official FlowDineOS logo badge.
 */
export function BrandMark({ href, context, className }: { href: string; /** e.g. "Platform" in the admin console */ context?: string; className?: string }) {
  return (
    <Link href={href} className={cn("inline-flex min-w-0 items-center gap-3 rounded-xl", className)}>
      <span className="brand-gradient inline-flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-xl p-0.5 shadow-e1">
        <span className="relative flex h-full w-full items-center justify-center overflow-hidden rounded-lg bg-white">
          <Image
            src="/logo.png"
            alt="FlowDineOS logo"
            width={36}
            height={36}
            priority
            className="h-full w-full object-contain"
          />
        </span>
      </span>
      <span className="font-display text-heading text-fg-primary">
        FlowDine<span className="text-fg-accent">OS</span>
      </span>
      {context && <span className="hidden rounded-full bg-fg-secondary/12 px-2.5 py-0.5 text-caption text-fg-secondary sm:inline-flex">{context}</span>}
    </Link>
  );
}

/** "Skip to content" — the first focusable element of every shell. */
export function SkipLink() {
  return (
    <a
      href="#main-content"
      className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-xl focus:bg-card focus:px-4 focus:py-2 focus:text-label focus:text-fg-primary focus:shadow-e2"
    >
      Skip to content
    </a>
  );
}
