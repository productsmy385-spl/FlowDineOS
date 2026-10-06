"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { CircleCheck, TriangleAlert } from "lucide-react";
import { createTenantAction, checkTenantSlugAction } from "@/app/admin/actions";
import { Card } from "@/components/ui/card";
import { Form, SubmitButton } from "@/components/ui/form";
import { FEATURE_KEYS, type FeatureKey } from "@/lib/auth/features";
import { FeatureChecklist } from "./feature-switches";
import { Icon } from "@/components/ui/icon";
import { Select } from "@/components/ui/inputs/select";
import { TextField } from "@/components/ui/inputs/text-field";
import type { ActionResult } from "@/lib/http/action";
import type { CreateTenantResult } from "@/lib/services/platform-tenants";
import { NEW_TENANT_DEFAULTS, type OptionGroup } from "@/lib/ui/locale-options";
import { suggestSlug } from "@/lib/ui/slug";

/**
 * Create a restaurant (S1-P06-T005; api.md SA-ADM-01). One form, three sections: the restaurant, its public address
 * and its first administrator. Time zone, currency and country are required and visible, prefilled for India and never
 * applied silently (Q-005 A, answered 2026-09-22).
 *
 * The slug is suggested from the restaurant's name and checked for availability as it is typed — a hint only: the
 * server re-validates it and a collision that races the hint still comes back as a field error (SLUG_TAKEN). It is
 * fixed once the restaurant exists (ADR-012 §4), which the form says before it is submitted, not after.
 */
export type CreateTenantFormProps = {
  timeZones: OptionGroup[];
  currencies: OptionGroup[];
  countries: OptionGroup[];
  /** `<slug>.rasoios.com` once a root domain is configured; the `/r/{slug}` path form otherwise (ADR-012 §3). */
  addressTemplate: { prefix: string; suffix: string };
};

type Availability = { state: "idle" } | { state: "checking" } | { state: "answer"; available: boolean; message: string | null; slug: string };

function GroupedSelect({
  name,
  label,
  groups,
  defaultValue,
  help,
  required,
}: {
  name: string;
  label: string;
  groups: OptionGroup[];
  defaultValue: string;
  help?: string;
  required?: boolean;
}) {
  return (
    <Select name={name} label={label} defaultValue={defaultValue} help={help} required={required}>
      {groups.map((group) => (
        <optgroup key={group.label} label={group.label}>
          {group.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </optgroup>
      ))}
    </Select>
  );
}

export function CreateTenantForm({ timeZones, currencies, countries, addressTemplate }: CreateTenantFormProps) {
  const router = useRouter();
  const [restaurantName, setRestaurantName] = React.useState("");
  const [tenantName, setTenantName] = React.useState("");
  const [tenantNameEdited, setTenantNameEdited] = React.useState(false);
  const [slug, setSlug] = React.useState("");
  const [slugEdited, setSlugEdited] = React.useState(false);
  const [availability, setAvailability] = React.useState<Availability>({ state: "idle" });

  /** Availability is a hint, so it is checked after the typing stops and every stale answer is discarded. */
  React.useEffect(() => {
    if (slug.trim().length < 3) {
      setAvailability({ state: "idle" });
      return;
    }
    let current = true;
    setAvailability({ state: "checking" });
    const timer = setTimeout(async () => {
      const result = await checkTenantSlugAction({ slug });
      if (!current) return;
      setAvailability(
        result.ok
          ? { state: "answer", available: result.data.available, message: result.data.message, slug: result.data.slug }
          : { state: "answer", available: false, message: result.error.message, slug },
      );
    }, 400);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [slug]);

  function onRestaurantName(value: string) {
    setRestaurantName(value);
    if (!tenantNameEdited) setTenantName(value);
    if (!slugEdited) setSlug(suggestSlug(value));
  }

  const [features, setFeatures] = React.useState<Set<FeatureKey>>(() => new Set(FEATURE_KEYS));

  async function submit(formData: FormData): Promise<ActionResult<CreateTenantResult>> {
    const text = (name: string) => String(formData.get(name) ?? "").trim();
    return createTenantAction({
      tenantName: text("tenantName"),
      slug: text("slug"),
      restaurantName: text("restaurantName"),
      timezone: text("timezone"),
      currencyCode: text("currencyCode"),
      countryCode: text("countryCode"),
      adminEmail: text("adminEmail"),
      adminFullName: text("adminFullName"),
      enabledFeatures: [...features],
    });
  }

  return (
    <Form
      action={submit}
      onSuccess={(data) => router.push(`/admin/tenants/${data.tenantId}?created=1&invitation=${data.invitation.status.toLowerCase()}`)}
      className="gap-6"
    >
      <Card className="gap-4" padding="feature">
        <div>
          <h2 className="text-heading text-fg-primary">The restaurant</h2>
          <p className="mt-1 text-body text-fg-secondary">How the restaurant is named, where it is and what it charges in.</p>
        </div>
        <TextField
          name="restaurantName"
          label="Restaurant name"
          required
          autoComplete="off"
          value={restaurantName}
          onChange={(event) => onRestaurantName(event.target.value)}
          help="The name diners see on the website and on their receipt."
        />
        <TextField
          name="tenantName"
          label="Account name"
          required
          autoComplete="off"
          value={tenantName}
          onChange={(event) => {
            setTenantNameEdited(true);
            setTenantName(event.target.value);
          }}
          help="What this restaurant is called inside the platform console. Usually the same as the restaurant."
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <GroupedSelect name="timezone" label="Time zone" groups={timeZones} defaultValue={NEW_TENANT_DEFAULTS.timezone} required help="Business days, reports and opening hours all follow this zone." />
          <GroupedSelect name="countryCode" label="Country" groups={countries} defaultValue={NEW_TENANT_DEFAULTS.countryCode} required />
          <GroupedSelect name="currencyCode" label="Currency" groups={currencies} defaultValue={NEW_TENANT_DEFAULTS.currencyCode} required help="Locked once the restaurant has taken orders." />
        </div>
      </Card>

      <Card className="gap-4" padding="feature">
        <div>
          <h2 className="text-heading text-fg-primary">Public address</h2>
          <p className="mt-1 text-body text-fg-secondary">
            This becomes the restaurant&apos;s website address and goes on its QR codes, so it cannot be changed afterwards.
          </p>
        </div>
        <TextField
          name="slug"
          label="Address"
          required
          autoComplete="off"
          spellCheck={false}
          inputMode="url"
          value={slug}
          onChange={(event) => {
            setSlugEdited(true);
            setSlug(event.target.value.trim().toLowerCase());
          }}
          help="3–48 lowercase letters, numbers or hyphens."
        />
        <p className="flex flex-wrap items-baseline gap-x-1 text-caption text-fg-secondary">
          <span>Website:</span>
          <span className="font-mono text-fg-primary">
            {addressTemplate.prefix}
            <span className="text-fg-accent">{slug || "your-restaurant"}</span>
            {addressTemplate.suffix}
          </span>
        </p>
        <SlugAvailability availability={availability} slug={slug} />
      </Card>

      <Card className="gap-4" padding="feature">
        <div>
          <h2 className="text-heading text-fg-primary">First administrator</h2>
          <p className="mt-1 text-body text-fg-secondary">
            They are invited by email and run the restaurant once you hand it over. They cannot reach any other restaurant.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField name="adminEmail" label="Email address" type="email" required autoComplete="off" placeholder="owner@example.com" />
          <TextField name="adminFullName" label="Full name" autoComplete="off" help="Optional. Shown until they sign in and set their own." />
        </div>
      </Card>

      <Card className="gap-4" padding="feature">
        <div>
          <h2 className="text-heading text-fg-primary">Access and features</h2>
          <p className="mt-1 text-body text-fg-secondary">Choose what this restaurant can use. You can change it at any time from the restaurant&apos;s page.</p>
        </div>
        <FeatureChecklist value={features} onChange={setFeatures} />
      </Card>

      <div className="flex flex-wrap justify-end gap-3">
        <SubmitButton loadingLabel="Creating…">Create restaurant</SubmitButton>
      </div>
    </Form>
  );
}

/** The availability hint under the address field. Never blocks submitting: the server decides. */
function SlugAvailability({ availability, slug }: { availability: Availability; slug: string }) {
  if (availability.state === "idle") return null;
  if (availability.state === "checking") {
    return (
      <p className="text-caption text-fg-secondary" aria-live="polite">
        Checking this address…
      </p>
    );
  }
  // An answer about a slug the person has since changed says nothing about what is in the field now.
  if (availability.slug !== slug) return null;
  return (
    <p className={`flex items-start gap-1.5 text-caption ${availability.available ? "text-status-success" : "text-status-warning"}`} aria-live="polite">
      <Icon icon={availability.available ? CircleCheck : TriangleAlert} size={16} className="mt-px" />
      <span>{availability.available ? `${slug} is available` : (availability.message ?? "This address cannot be used")}</span>
    </p>
  );
}
