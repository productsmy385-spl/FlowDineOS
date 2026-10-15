"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Ban, CircleCheck, Globe, Handshake, Pencil, Settings } from "lucide-react";
import { handOverTenantAction, reactivateTenantAction, suspendTenantAction, updateTenantAction } from "@/app/admin/actions";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Form, SubmitButton } from "@/components/ui/form";
import { TextArea } from "@/components/ui/inputs/text-area";
import { TextField } from "@/components/ui/inputs/text-field";
import { Menu } from "@/components/ui/menu";
import { useToast } from "@/components/ui/toast";
import type { ActionResult } from "@/lib/http/action";

export type TenantLifecycleProps = {
  tenantId: string;
  name: string;
  slug?: string;
  status: "ACTIVE" | "SUSPENDED";
  provisioningState: "PROVISIONING" | "HANDED_OVER";
  /** True when an administrator has accepted their invitation — the precondition for handover (ADR-013 §7). */
  handoverReady: boolean;
  can: { update: boolean; suspend: boolean; reactivate: boolean };
};

type OpenDialog = "rename" | "edit-slug" | "suspend" | "reactivate" | "handover" | null;

export function TenantLifecycle({ tenantId, name, slug, status, provisioningState, handoverReady, can }: TenantLifecycleProps) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = React.useState<OpenDialog>(null);

  const done = React.useCallback(
    (message: string) => {
      setOpen(null);
      toast.success(message);
      router.refresh();
    },
    [router, toast],
  );

  const menuItems = [
    ...(can.update
      ? [
          { label: "Rename restaurant", icon: Pencil, onSelect: () => setOpen("rename") },
          { label: "Edit slug / address", icon: Globe, onSelect: () => setOpen("edit-slug") },
        ]
      : []),
    ...(can.suspend && status === "ACTIVE" ? [{ label: "Suspend restaurant", icon: Ban, tone: "danger" as const, onSelect: () => setOpen("suspend") }] : []),
    ...(can.reactivate && status === "SUSPENDED" ? [{ label: "Reactivate restaurant", icon: CircleCheck, onSelect: () => setOpen("reactivate") }] : []),
    ...(can.update && provisioningState === "HANDED_OVER" ? [{ label: "Record another handover note", icon: Handshake, onSelect: () => setOpen("handover") }] : []),
  ];

  const showHandoverButton = can.update && provisioningState === "PROVISIONING";

  if (menuItems.length === 0 && !showHandoverButton) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {menuItems.length > 0 && (
        <Menu
          items={menuItems}
          trigger={(props) => (
            <Button {...props} variant="secondary" icon={Settings}>
              Manage
            </Button>
          )}
        />
      )}
      {showHandoverButton && (
        <Button onClick={() => setOpen("handover")} icon={Handshake} disabled={!handoverReady}>
          Hand over
        </Button>
      )}

      <Dialog open={open === "rename"} onClose={() => setOpen(null)} title={`Rename ${name}?`} description="Only the name inside the console changes. The public address stays the same.">
        <Form
          action={(formData: FormData): Promise<ActionResult<unknown>> => updateTenantAction({ targetTenantId: tenantId, name: String(formData.get("name") ?? "").trim() })}
          onSuccess={() => done("Restaurant renamed.")}
        >
          <TextField name="name" label="Name" required defaultValue={name} autoComplete="off" />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setOpen(null)}>
              Cancel
            </Button>
            <SubmitButton>Save name</SubmitButton>
          </div>
        </Form>
      </Dialog>

      <Dialog
        open={open === "edit-slug"}
        onClose={() => setOpen(null)}
        title={`Edit address & slug for ${name}`}
        description="Changing the slug updates the public subdomain and web address for this restaurant (e.g. <slug>.flowdine.in)."
      >
        <Form
          action={(formData: FormData): Promise<ActionResult<unknown>> => {
            const newSlug = String(formData.get("slug") ?? "").trim().toLowerCase();
            return updateTenantAction({ targetTenantId: tenantId, slug: newSlug });
          }}
          onSuccess={() => done("Restaurant slug updated.")}
        >
          <TextField
            name="slug"
            label="Subdomain / Slug"
            required
            defaultValue={slug}
            autoComplete="off"
            help="Lowercase letters, numbers, and hyphens (e.g. akshayapatra)."
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setOpen(null)}>
              Cancel
            </Button>
            <SubmitButton>Save slug</SubmitButton>
          </div>
        </Form>
      </Dialog>

      <Dialog
        open={open === "suspend"}
        onClose={() => setOpen(null)}
        title={`Suspend ${name}?`}
        description="Staff are signed out and refused on their next request, and the restaurant's public website stops answering. Nothing is deleted."
      >
        <Form
          action={(formData: FormData): Promise<ActionResult<unknown>> => suspendTenantAction({ targetTenantId: tenantId, reason: String(formData.get("reason") ?? "").trim() })}
          onSuccess={() => done("Restaurant suspended.")}
        >
          <TextArea
            name="reason"
            label="Why is it being suspended?"
            required
            minLength={10}
            maxLength={500}
            showCount
            help="Recorded in the audit trail. At least 10 characters."
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setOpen(null)}>
              Cancel
            </Button>
            <SubmitButton variant="destructive" loadingLabel="Suspending…">
              Suspend restaurant
            </SubmitButton>
          </div>
        </Form>
      </Dialog>

      <Dialog open={open === "reactivate"} onClose={() => setOpen(null)} title={`Reactivate ${name}?`} description="Staff can sign in again and the public website starts answering.">
        <Form action={(): Promise<ActionResult<unknown>> => reactivateTenantAction({ targetTenantId: tenantId })} onSuccess={() => done("Restaurant reactivated.")}>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setOpen(null)}>
              Cancel
            </Button>
            <SubmitButton loadingLabel="Reactivating…">Reactivate</SubmitButton>
          </div>
        </Form>
      </Dialog>

      <Dialog
        open={open === "handover"}
        onClose={() => setOpen(null)}
        title={`Hand ${name} over?`}
        description="From here the restaurant's own administrator runs its website, menu, staff and printers. You keep metadata access only."
      >
        <Form
          action={(formData: FormData): Promise<ActionResult<unknown>> => handOverTenantAction({ targetTenantId: tenantId, note: String(formData.get("note") ?? "").trim() })}
          onSuccess={() => done("Handover recorded.")}
        >
          {!handoverReady && (
            <Alert tone="warning" title="No administrator has signed in yet">
              Handover needs an administrator who accepted their invitation. Invite or resend below first.
            </Alert>
          )}
          <TextArea name="note" label="Handover note" maxLength={500} showCount help="Optional. What was agreed, who was trained, anything the next person should know." />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setOpen(null)}>
              Cancel
            </Button>
            <SubmitButton loadingLabel="Recording…" disabled={!handoverReady}>
              Record handover
            </SubmitButton>
          </div>
        </Form>
      </Dialog>
    </div>
  );
}
