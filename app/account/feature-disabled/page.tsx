import { PackageX } from "lucide-react";
import { StatusPage } from "@/components/states/status-page";
import { FEATURES, isFeatureKey } from "@/lib/auth/features";

interface FeatureDisabledPageProps {
  searchParams: Promise<{ feature?: string }>;
}

/**
 * /account/feature-disabled — the page belongs to a feature the platform owner has switched off for this restaurant
 * (RASOIOS-ADR-023). The query only picks the wording; the guard has already refused the page itself.
 */
export default async function FeatureDisabledPage({ searchParams }: FeatureDisabledPageProps) {
  const { feature } = await searchParams;
  const label = isFeatureKey(feature) ? FEATURES[feature].label : "This feature";
  return (
    <StatusPage icon={PackageX} title={`${label} is not enabled`} primary={{ href: "/restaurant", label: "Go to your home page" }}>
      <p>{label} has not been turned on for your restaurant. Ask the platform owner if you need it.</p>
    </StatusPage>
  );
}
