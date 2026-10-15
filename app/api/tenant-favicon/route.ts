import { type NextRequest, NextResponse } from "next/server";
import { getTenantFaviconAndLogoBySlug } from "@/lib/data/website";
import { imageKitSized } from "@/lib/media/purposes";

export const dynamic = "force-dynamic";

/**
 * Serves or redirects to the tenant-specific favicon.
 * When requested on a tenant subdomain (rewritten by middleware), it securely resolves
 * the tenant's custom favicon, falling back to the tenant's logo, or falling back to the platform favicon.
 */
export async function GET(req: NextRequest) {
  const hostSlug = req.headers.get("x-rasoi-tenant-slug") || req.nextUrl.searchParams.get("slug");
  if (!hostSlug) {
    return NextResponse.redirect(new URL("/favicon.ico", req.url), 307);
  }

  const branding = await getTenantFaviconAndLogoBySlug(hostSlug);
  const iconUrl = branding?.faviconUrl || branding?.logoUrl;

  if (iconUrl) {
    const sizedUrl = imageKitSized(iconUrl, 64);
    return NextResponse.redirect(sizedUrl, {
      status: 307,
      headers: {
        "cache-control": "public, max-age=300, stale-while-revalidate=86400",
      },
    });
  }

  return NextResponse.redirect(new URL("/favicon.ico", req.url), 307);
}
