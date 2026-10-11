import Link from "next/link";
import { Drumstick, EggFried, ImageOff, Leaf, type LucideIcon } from "lucide-react";
import { Icon } from "@/components/ui/icon";
import { imageKitSized, imageKitSrcSet } from "@/lib/media/purposes";
import { cn } from "@/lib/ui/cn";
import { MENU_ICONS, isMenuIconKey } from "@/lib/ui/icons";

/**
 * Small building blocks shared by the public website sections (S1-P09-T003/T012).
 *
 * Everything here renders tenant data as *text*: no HTML from a restaurant is ever interpreted (SC-VAL-03), and a
 * value the restaurant has not supplied is left out rather than replaced with sample copy.
 */

/** A section heading, in the restaurant's own words when it wrote some. */
export function SectionHeading({ id, title, lead }: { id?: string; title: string; lead?: string | null }) {
  return (
    <div className="flex flex-col gap-2">
      <h2 id={id} className="break-words text-display-m" style={{ color: "var(--website-section-heading-color)" }}>
        {title}
      </h2>
      {lead ? <p className="max-w-prose whitespace-pre-line break-words text-body-public text-fg-secondary" style={{ color: "var(--website-muted-text-color)" }}>{lead}</p> : null}
    </div>
  );
}

/** A section with nothing to show yet: says plainly what is missing, and never stands in for content. */
export function SectionEmpty({ icon, children }: { icon: LucideIcon; children: React.ReactNode }) {
  return (
    <p className="flex items-center gap-2 rounded-xl border border-border-subtle bg-card px-4 py-3 text-body text-fg-secondary">
      <Icon icon={icon} size={18} />
      <span>{children}</span>
    </p>
  );
}

/**
 * A remote image the restaurant configured. URLs are https and host-allow-listed when they are saved (SC-VAL-04), and
 * a missing or broken one falls back to an icon rather than a blank box. Plain `<img>` rather than `next/image`: the
 * optimiser only accepts hosts configured at build time, and a restaurant's allow-list can change afterwards.
 * Uploaded (ImageKit) images are requested at `displayWidth` and twice that for high-density screens, resized by
 * ImageKit's CDN (ADR-017 §6); pasted links are shown as they are.
 */
export function SiteImage({
  src,
  alt,
  className,
  fallbackIcon,
  priority = false,
  displayWidth = 800,
}: {
  src: string | null;
  alt: string;
  className?: string;
  fallbackIcon?: LucideIcon;
  priority?: boolean;
  /** The widest the image is shown, in CSS pixels. */
  displayWidth?: number;
}) {
  if (!src) {
    // `alt=""` marks a decorative image (a logo beside the name it repeats), so its placeholder is hidden too.
    const decorative = alt === "";
    return (
      <span
        className={cn("flex items-center justify-center bg-raised text-fg-secondary", className)}
        {...(decorative ? { "aria-hidden": true } : { role: "img", "aria-label": alt })}
      >
        <Icon icon={fallbackIcon ?? ImageOff} size={32} />
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- remote hosts are tenant-configured, not build-time known.
    <img
      src={imageKitSized(src, displayWidth)}
      srcSet={imageKitSrcSet(src, displayWidth) ?? undefined}
      alt={alt}
      loading={priority ? "eager" : "lazy"}
      decoding="async"
      fetchPriority={priority ? "high" : "auto"}
      className={cn("object-cover", className)}
    />
  );
}

const DIETARY: Record<string, { icon: LucideIcon; label: string; className: string }> = {
  VEG: { icon: Leaf, label: "Vegetarian", className: "bg-status-success/12 text-status-success" },
  NON_VEG: { icon: Drumstick, label: "Non-vegetarian", className: "bg-status-danger/12 text-status-danger" },
  EGG: { icon: EggFried, label: "Contains egg", className: "bg-status-warning/12 text-status-warning" },
};

/** Dietary mark: icon *and* label, never colour alone (design.md §7). */
export function DietaryMark({ dietaryType }: { dietaryType: string | null }) {
  const mark = dietaryType ? DIETARY[dietaryType] : undefined;
  if (!mark) return null;
  return (
    <span className={cn("inline-flex items-center gap-1.5 h-6 px-2.5 rounded-full text-caption whitespace-nowrap", mark.className)}>
      <Icon icon={mark.icon} size={16} />
      {mark.label}
    </span>
  );
}

/** The curated fallback glyph a restaurant chose for a category or item, if any. */
export function menuIconFor(iconKey: string | null): LucideIcon | undefined {
  return isMenuIconKey(iconKey) ? MENU_ICONS[iconKey] : undefined;
}

/**
 * A call to action the restaurant configured. An internal path stays a `Link`; an external https link opens in a new
 * tab with `rel="noopener noreferrer"`. There is no variant that renders without a destination, so a button on a
 * public page always goes somewhere.
 */
export function SiteCta({ label, href, className }: { label: string; href: string; className?: string }) {
  const classes = cn(
    "inline-flex items-center justify-center min-h-11 px-5 rounded-xl text-subheading font-semibold",
    "bg-action-primary text-action-primary-fg transition-shadow duration-fast ease-standard motion-safe:hover:shadow-glow",
    className,
  );
  if (href.startsWith("/") || href.startsWith("#")) {
    return (
      <Link href={href} className={classes} style={{ color: "var(--website-button-text-color)" }}>
        {label}
      </Link>
    );
  }
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={classes} style={{ color: "var(--website-button-text-color)" }}>
      {label}
    </a>
  );
}
