"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Select, TextField } from "@/components/ui/inputs";
import type { PrinterDto } from "@/lib/services/printing";
import { DEFAULT_PRINTER_PROFILE, PRINTER_PROFILES, PRINTER_PROFILE_KEYS, isPrinterProfileKey, type PrinterProfileKey } from "@/lib/print/profiles";
import { createPrinterAction, updatePrinterAction } from "./actions";

/**
 * Add / edit printer (SA-PRN-01, SA-PRN-02; S1-P16-T006).
 *
 * The address field explains what the server will accept before the user types: a LAN printer needs a private IPv4
 * address (SC-PRINT-06) and a USB printer needs its device or queue name. The server validates it again either way —
 * this is guidance, not authorisation — and its field errors land back on the control they belong to.
 */
export type PrinterDialogOption = { id: string; name: string };

const PURPOSES = [
  { value: "KOT", label: "Kitchen tickets (KOT)" },
  { value: "RECEIPT", label: "Receipts" },
  { value: "KOT_AND_RECEIPT", label: "Kitchen tickets and receipts" },
];

const CONNECTIONS = [
  { value: "LAN", label: "Network (LAN)" },
  { value: "USB", label: "USB" },
];

/** Capability profiles (lib/print/profiles.ts): the agent encodes by the model's capabilities. */
const MODELS = PRINTER_PROFILE_KEYS.map((key) => ({ value: key, label: PRINTER_PROFILES[key].label }));

const WIDTHS = [
  { value: "80", label: "80 mm (48 columns)" },
  { value: "58", label: "58 mm (32 columns)" },
];

type FormState = {
  name: string;
  purpose: string;
  connectionType: string;
  connectionAddress: string;
  paperWidthMm: string;
  kitchenSectionId: string;
  printAgentId: string;
  profile: string;
};

/** Values for a new printer found by a LAN scan (ADR-015): its address and the agent that found it. */
export type PrinterPreset = Partial<Pick<FormState, "name" | "connectionAddress" | "printAgentId">>;

function stateOf(printer: PrinterDto | null, preset?: PrinterPreset): FormState {
  return {
    name: printer?.name ?? preset?.name ?? "",
    purpose: printer?.purpose ?? "KOT",
    connectionType: printer?.connectionType ?? "LAN",
    connectionAddress: printer?.connectionAddress ?? preset?.connectionAddress ?? "",
    paperWidthMm: String(printer?.paperWidthMm ?? 80),
    kitchenSectionId: printer?.kitchenSectionId ?? "",
    printAgentId: printer?.printAgentId ?? preset?.printAgentId ?? "",
    profile: printer?.profile ?? DEFAULT_PRINTER_PROFILE,
  };
}

export function PrinterDialog({
  open,
  printer,
  preset,
  sections,
  agents,
  onClose,
  onSaved,
}: {
  open: boolean;
  printer: PrinterDto | null;
  preset?: PrinterPreset;
  sections: readonly PrinterDialogOption[];
  agents: readonly PrinterDialogOption[];
  onClose: () => void;
  onSaved: (message: string, saved: PrinterDto) => void;
}) {
  const [form, setForm] = React.useState<FormState>(() => stateOf(printer, preset));
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string[]>>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setForm(stateOf(printer, preset));
      setFieldErrors({});
      setFormError(null);
    }
  }, [open, printer, preset]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((current) => ({ ...current, [key]: value }));

  async function save() {
    setPending(true);
    setFormError(null);
    setFieldErrors({});
    const shared = {
      name: form.name,
      purpose: form.purpose as PrinterDto["purpose"],
      connectionType: form.connectionType as PrinterDto["connectionType"],
      connectionAddress: form.connectionAddress,
      paperWidthMm: (form.paperWidthMm === "58" ? 58 : 80) as 58 | 80,
      kitchenSectionId: form.kitchenSectionId || null,
      printAgentId: form.printAgentId || null,
      profile: (isPrinterProfileKey(form.profile) ? form.profile : DEFAULT_PRINTER_PROFILE) as PrinterProfileKey,
    };
    const result = printer ? await updatePrinterAction({ printerId: printer.id, ...shared }) : await createPrinterAction(shared);
    setPending(false);

    if (!result.ok) {
      setFieldErrors(result.error.fieldErrors ?? {});
      if (!result.error.fieldErrors) setFormError(result.error.message);
      return;
    }
    onSaved(printer ? `${result.data.name} updated.` : `${result.data.name} added.`, result.data);
  }

  const addressHelp =
    form.connectionType === "LAN"
      ? "Private network address, e.g. 192.168.1.50:9100. Public addresses and host names are refused."
      : "The USB device or print-queue name shown by the restaurant PC, e.g. USB001.";

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={printer ? `Edit ${printer.name}` : "Add printer"}
      description="The local print agent connects to the printer; this restaurant's cloud account never does."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()} loading={pending} loadingLabel="Saving…">
            {printer ? "Save changes" : "Add printer"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {formError && (
          <p role="alert" className="rounded-xl border border-status-danger/30 bg-status-danger/12 px-3 py-2 text-body text-status-danger">
            {formError}
          </p>
        )}
        <TextField
          name="name"
          label="Name"
          required
          value={form.name}
          onChange={(event) => set("name", event.target.value)}
          error={fieldErrors.name?.[0]}
          placeholder="Kitchen Printer"
          maxLength={60}
        />
        <Select name="purpose" label="Prints" options={PURPOSES} value={form.purpose} onChange={(event) => set("purpose", event.target.value)} error={fieldErrors.purpose?.[0]} />
        <Select
          name="connectionType"
          label="Connection"
          options={CONNECTIONS}
          value={form.connectionType}
          onChange={(event) => set("connectionType", event.target.value)}
          error={fieldErrors.connectionType?.[0]}
        />
        <TextField
          name="connectionAddress"
          label="Address"
          required
          value={form.connectionAddress}
          onChange={(event) => set("connectionAddress", event.target.value)}
          error={fieldErrors.connectionAddress?.[0]}
          help={addressHelp}
          placeholder={form.connectionType === "LAN" ? "192.168.1.50:9100" : "USB001"}
          maxLength={255}
        />
        <Select
          name="profile"
          label="Model"
          options={MODELS}
          value={form.profile}
          onChange={(event) => {
            const key = event.target.value;
            set("profile", key);
            // A model that takes one paper width sets it (the TVS RP 3230 is 80 mm only).
            const widths = isPrinterProfileKey(key) ? PRINTER_PROFILES[key].paperWidthsMm : [];
            if (widths.length === 1) set("paperWidthMm", String(widths[0]));
          }}
          error={fieldErrors.profile?.[0]}
        />
        <Select
          name="paperWidthMm"
          label="Paper width"
          options={WIDTHS}
          value={form.paperWidthMm}
          onChange={(event) => set("paperWidthMm", event.target.value)}
          error={fieldErrors.paperWidthMm?.[0]}
        />
        <Select
          name="kitchenSectionId"
          label="Kitchen station"
          emptyOption="Any station (fallback printer)"
          options={sections.map((section) => ({ value: section.id, label: section.name }))}
          value={form.kitchenSectionId}
          onChange={(event) => set("kitchenSectionId", event.target.value)}
          error={fieldErrors.kitchenSectionId?.[0]}
          help="Kitchen tickets for this station print here. Leave empty to catch stations without their own printer."
        />
        <Select
          name="printAgentId"
          label="Print agent"
          emptyOption="Not assigned yet"
          options={agents.map((agent) => ({ value: agent.id, label: agent.name }))}
          value={form.printAgentId}
          onChange={(event) => set("printAgentId", event.target.value)}
          error={fieldErrors.printAgentId?.[0]}
          help="Only the assigned agent can collect this printer's jobs."
        />
      </div>
    </Dialog>
  );
}
