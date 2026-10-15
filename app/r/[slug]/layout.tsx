import type { Metadata } from "next";
import { loadPublicSiteForMetadata } from "./load-site";
import { imageKitSized } from "@/lib/media/purposes";

interface TenantLayoutProps {
  params: Promise<{ slug: string }>;
  children: React.ReactNode;
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const site = await loadPublicSiteForMetadata(slug);
  if (!site) return {};

  const name = site.restaurant.name;
  const favicon = site.identity.faviconUrl || site.identity.logoUrl;

  return {
    title: {
      template: `%s | ${name}`,
      default: site.seoTitle ?? name,
    },
    ...(favicon
      ? {
          icons: {
            icon: [
              { url: imageKitSized(favicon, 64), sizes: "64x64", type: "image/png" },
              { url: imageKitSized(favicon, 32), sizes: "32x32", type: "image/png" },
            ],
            apple: [
              { url: imageKitSized(favicon, 180), sizes: "180x180", type: "image/png" },
            ],
          },
        }
      : {}),
  };
}

export default function TenantPublicLayout({ children }: TenantLayoutProps) {
  return <>{children}</>;
}
