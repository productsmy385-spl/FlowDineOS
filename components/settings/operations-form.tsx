"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { updateOperationalSettingsAction } from "@/app/restaurant/settings/actions";
import { Alert } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import { DescriptionList, type DescriptionItem } from "@/components/ui/description-list";
import { Form, SubmitButton } from "@/components/ui/form";
import { Select } from "@/components/ui/inputs/select";
import { Switch } from "@/components/ui/inputs/switch";
import { TextArea } from "@/components/ui/inputs/text-area";
import { TextField } from "@/components/ui/inputs/text-field";
import { useToast } from "@/components/ui/toast";
import type { RestaurantSettingsDto } from "@/lib/data/restaurant";
import type { ActionResult } from "@/lib/http/action";
import type { OptionGroup } from "@/lib/ui/locale-options";
import { ORDER_TYPES } from "@/lib/validation/settings";

/**
 * Operations (S1-P07-T005; api.md SA-RST-04): the settings the restaurant runs on — its time zone, its currency, its
 * country, what a new order is by default, whether a ticket prints itself, and what the bottom of a receipt says.
 *
 * The time zone decides business days, reports and opening hours, so the field shows the time it is there right now
 * rather than asking anyone to translate an offset. The currency is locked once orders exist (INV-09): the control is
 * disabled with the reason next to it, and the current value is still submitted so the rest of the form saves.
 */
const ORDER_TYPE_LABEL: Record<(typeof ORDER_TYPES)[number], string> = { DINE_IN: "Dine-in", TAKEAWAY: "Takeaway", DELIVERY: "Delivery" };

export function OperationsForm({
  restaurant,
  currencyLocked,
  canEdit,
  timeZones,
  currencies,
  countries,
}: {
  restaurant: RestaurantSettingsDto;
  currencyLocked: boolean;
  canEdit: boolean;
  timeZones: OptionGroup[];
  currencies: OptionGroup[];
  countries: OptionGroup[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [timezone, setTimezone] = React.useState(restaurant.timezone);

  if (!canEdit) {
    const items: DescriptionItem[] = [
      { term: "Time zone", value: <ZoneClock timezone={restaurant.timezone} /> },
      { term: "Currency", value: restaurant.currencyCode },
      { term: "Country", value: restaurant.countryCode },
      { term: "New orders default to", value: ORDER_TYPE_LABEL[restaurant.defaultOrderType] },
      { term: "Kitchen ticket", value: restaurant.autoPrintKot ? "Prints automatically" : "Printed by hand" },
      { term: "Simplified order workflow", value: restaurant.simplifiedWorkflow ? "On" : "Off" },
      { term: "Receipt footer", value: restaurant.receiptFooter ?? "None" },
      { term: "GSTIN", value: restaurant.gstin ?? "Not set" },
    ];
    return (
      <Card padding="feature">
        <DescriptionList items={items} />
        <p className="mt-4 text-caption text-fg-secondary">Your role can see these settings but not change them.</p>
      </Card>
    );
  }

  return (
    <Card padding="feature">
      <Form
        action={(formData: FormData): Promise<ActionResult<unknown>> => {
          const text = (name: string) => String(formData.get(name) ?? "").trim();
          return updateOperationalSettingsAction({
            timezone: text("timezone"),
            // A disabled control submits nothing, so the locked currency comes from its hidden twin.
            currencyCode: text("currencyCode") || restaurant.currencyCode,
            countryCode: text("countryCode"),
            defaultOrderType: text("defaultOrderType") as (typeof ORDER_TYPES)[number],
            autoPrintKot: formData.get("autoPrintKot") === "on",
            simplifiedWorkflow: formData.get("simplifiedWorkflow") === "on",
            receiptFooter: text("receiptFooter"),
            gstin: text("gstin"),
          });
        }}
        onSuccess={() => {
          toast.success("Settings saved.");
          router.refresh();
        }}
      >
        <Select
          name="timezone"
          label="Time zone"
          required
          defaultValue={restaurant.timezone}
          onChange={(event) => setTimezone(event.target.value)}
          help={<ZoneClock timezone={timezone} prefix="Business days, reports and opening hours follow this zone. It is " />}
        >
          {timeZones.map((group) => (
            <optgroup key={group.label} label={group.label}>
              {group.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </optgroup>
          ))}
        </Select>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Select
              name={currencyLocked ? "currencyCodeLocked" : "currencyCode"}
              label="Currency"
              required
              defaultValue={restaurant.currencyCode}
              disabled={currencyLocked}
              help={currencyLocked ? "Locked: this restaurant has taken orders, and their money is recorded in this currency." : "Every price and total is in this currency."}
            >
              {currencies.map((group) => (
                <optgroup key={group.label} label={group.label}>
                  {group.options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
          </div>

          <Select name="countryCode" label="Country" required defaultValue={restaurant.countryCode}>
            {countries.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            name="defaultOrderType"
            label="New orders default to"
            required
            defaultValue={restaurant.defaultOrderType}
            options={ORDER_TYPES.map((type) => ({ value: type, label: ORDER_TYPE_LABEL[type] }))}
          />
          <Switch
            name="autoPrintKot"
            label="Print the kitchen ticket automatically"
            defaultChecked={restaurant.autoPrintKot}
            help="When an order is accepted, its ticket is queued for the kitchen printer without anyone pressing print."
          />
        </div>

        <Switch
          name="simplifiedWorkflow"
          label="Simplified Order Workflow"
          defaultChecked={restaurant.simplifiedWorkflow}
          help="Automatically advance accepted orders after 10 minutes and simplify payment recording and receipt printing. The timer replaces the kitchen's Preparing and Ready taps: an order shows Ready 10 minutes after it is accepted, whether or not the food is."
        />

        <TextArea
          name="receiptFooter"
          label="Receipt footer"
          defaultValue={restaurant.receiptFooter ?? ""}
          maxLength={280}
          showCount
          rows={2}
          help="Printed at the bottom of every receipt, e.g. a thank-you or a return policy."
        />
        <TextField
          name="gstin"
          label="GSTIN"
          defaultValue={restaurant.gstin ?? ""}
          autoComplete="off"
          spellCheck={false}
          help="15 characters, e.g. 29ABCDE1234F1Z5. With a GSTIN, receipts show CGST and SGST separately."
        />

        {currencyLocked && (
          <Alert tone="neutral" title="Currency cannot change">
            Orders have already been recorded in {restaurant.currencyCode}. Changing it would rewrite what customers were charged, so it stays as it is.
          </Alert>
        )}

        <div className="flex justify-end">
          <SubmitButton>Save settings</SubmitButton>
        </div>
      </Form>
    </Card>
  );
}

/** The wall-clock time in a zone, updated on the client only (the server's own clock format would mismatch). */
function ZoneClock({ timezone, prefix = "" }: { timezone: string; prefix?: string }) {
  const [time, setTime] = React.useState<string | null>(null);
  React.useEffect(() => {
    const show = () => {
      try {
        setTime(new Intl.DateTimeFormat("en", { timeZone: timezone, hour: "2-digit", minute: "2-digit", weekday: "short" }).format(new Date()));
      } catch {
        setTime(null);
      }
    };
    show();
    const timer = setInterval(show, 30_000);
    return () => clearInterval(timer);
  }, [timezone]);
  if (!time) return <>{prefix ? prefix.trimEnd() : timezone}</>;
  return (
    <>
      {prefix}
      <span className="tabular-nums text-fg-primary">{time}</span> in {timezone}.
    </>
  );
}
