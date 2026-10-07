import type { NextConfig } from "next";
import { securityHeaders } from "./lib/http/security-headers";
import { normalizeRootDomain } from "./lib/tenancy/hostnames";
import { allowedImageHosts as configuredImageHosts, imageRemotePatterns } from "./lib/validation/url";

// `next/image` may load remote images only from the hosts staff are allowed to use for logo/cover/menu images
// (ALLOWED_IMAGE_HOSTS, S1-P07-T002, SC-VAL-04, plus the ImageKit endpoint host, ADR-017) — the same list the
// server-side validators check. Clerk's avatar host serves signed-in users' profile pictures, which are not
// user-entered URLs.
const allowedImageHosts = configuredImageHosts();

// Restaurant websites are served from tenant sub-domains (S1-P09-T011, ADR-012), so the development server has to
// accept `/_next/*` requests from `<slug>.localhost` and from `<slug>.<PUBLIC_ROOT_DOMAIN>`. Development only.
const publicRootDomain = normalizeRootDomain(process.env.PUBLIC_ROOT_DOMAIN);
const allowedDevOrigins = ["*.localhost", ...(publicRootDomain === null ? [] : [publicRootDomain, `*.${publicRootDomain}`])];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  allowedDevOrigins,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders(process.env.NODE_ENV === "production") }];
  },
  images: {
    remotePatterns: [
      ...imageRemotePatterns(allowedImageHosts),
      {
        protocol: "https",
        hostname: "img.clerk.com",
      },
    ],
  },
  // Duplicate baseline routes (frontend.md §2, BA-34). `/restaurant/billing` keeps working until payments move to the
  // order detail and transactions pages (S1-P18); its redirect is added then.
  async redirects() {
    return [
      { source: "/restaurant/kds", destination: "/restaurant/kitchen", permanent: true },
      { source: "/restaurant/analytics", destination: "/restaurant/reports", permanent: true },
    ];
  },
};

export default nextConfig;
