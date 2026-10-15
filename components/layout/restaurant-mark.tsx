"use client";

import Link from "next/link";
import { Store } from "lucide-react";
import { Icon } from "@/components/ui/icon";
import { imageKitSized, imageKitSrcSet } from "@/lib/media/purposes";
import { cn } from "@/lib/ui/cn";

/**
 * The restaurant's own mark, worn by the tenant console header (ADR-013 §1 "Brand", white-label).
 *
 * The console belongs to the restaurant, not to the platform: staff who sign in see the name over their own door, so
 * the header carries the restaurant's logo and name where the platform console carries the RASOIOS wordmark. Only the
 * platform console (`/admin`) is RASOIOS-branded, because that one really is the platform's.
 *
 * The logo is whatever the restaurant saved — an upload or an allow-listed link (SC-VAL-04) — requested at display
 * size and twice that for high-density screens (ADR-017 §6). A restaurant that has not set one gets a monogram of its
 * own initials rather than a platform logo standing in for it, so the header is never another brand's.
 */
export function RestaurantMark({ href, name, logoUrl, className }: { href: string; name: string; logoUrl: string | null; className?: string }) {
  return (
    <Link href={href} className={cn("inline-flex min-w-0 items-center gap-3", className)}>
      {logoUrl ? (
        <span className="relative flex h-10 w-10 shrink-0 items-center justify-center">
          {/* eslint-disable-next-line @next/next/no-img-element -- remote hosts are tenant-configured, not build-time known. */}
          <img
            src={imageKitSized(logoUrl, 40)}
            srcSet={imageKitSrcSet(logoUrl, 40) ?? undefined}
            alt=""
            width={40}
            height={40}
            decoding="async"
            className="h-full w-full object-contain"
          />
        </span>
      ) : (
        <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-action-primary text-action-primary-fg">
          <Monogram name={name} />
        </span>
      )}
      <span className="min-w-0 truncate font-display text-heading text-fg-primary">{name}</span>
    </Link>
  );
}

/** Up to two initials from the restaurant's name; the shop icon when the name yields none (e.g. non-Latin scripts). */
function Monogram({ name }: { name: string }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => [...word][0] ?? "")
    .join("")
    .toUpperCase();
  if (initials === "") return <Icon icon={Store} size={20} />;
  return (
    <span aria-hidden className="text-label font-semibold leading-none">
      {initials}
    </span>
  );
}
