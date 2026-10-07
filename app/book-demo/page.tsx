import type { Metadata } from "next";
import { AuthLayout } from "@/components/layout/auth-layout";
import { DemoForm } from "@/components/landing/demo-booking";
import { Card } from "@/components/ui/card";
import { PLATFORM_DOMAIN, PLATFORM_NAME } from "@/lib/brand";

export const metadata: Metadata = {
  title: `Book a demo — ${PLATFORM_NAME}`,
  description: `See ${PLATFORM_NAME} running for your restaurant: orders, kitchen, printing, billing and your website.`,
  alternates: { canonical: `https://${PLATFORM_DOMAIN}/book-demo` },
};

/** `/book-demo` (RASOIOS-ADR-024): the same form as the landing page's dialog, on its own shareable address. */
export default function BookDemoPage() {
  return (
    <AuthLayout title="Book a demo" description={`Tell us about your restaurant and when suits you. We will contact you to arrange a ${PLATFORM_NAME} demonstration.`}>
      <Card padding="feature">
        <DemoForm />
      </Card>
    </AuthLayout>
  );
}
