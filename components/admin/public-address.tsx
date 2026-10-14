import { publicSiteUrl } from "@/lib/tenancy/hostnames";

/**
 * A restaurant's public address as the platform console shows it (S1-P06-T004, ADR-012 §2–3).
 *
 * With `PUBLIC_ROOT_DOMAIN` configured the canonical address is the sub-domain; without one the only address that
 * resolves is the `/r/{slug}` path, so that is what is shown — never an invented host. The link opens the site itself,
 * which is public: it exposes nothing the console is not already showing.
 */
export function PublicAddress({ slug, rootDomain, className }: { slug: string; rootDomain: string | null; className?: string }) {
  const effectiveRoot = rootDomain || "flowdine.in";
  const url = publicSiteUrl(slug, effectiveRoot) ?? `https://${slug}.${effectiveRoot}/`;
  const label = `${slug}.${effectiveRoot}`;
  return (
    <a
      href={url}
      className={className ?? "font-mono text-body text-fg-accent hover:underline"}
      target="_blank"
      rel="noreferrer noopener"
    >
      {label}
    </a>
  );
}
