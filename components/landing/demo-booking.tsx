"use client";

import * as React from "react";
import { CalendarCheck, CheckCircle2 } from "lucide-react";
import { requestDemoAction } from "@/app/book-demo/actions";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { cn } from "@/lib/ui/cn";

/**
 * Book a demo (RASOIOS-ADR-024). One form, used in the landing page's dialog and on /book-demo. It never offers or
 * confirms a slot — there is no calendar behind it — only that the request was received and the team will be in touch.
 */

const FIELD = "h-12 w-full rounded-xl border-2 border-border-strong bg-canvas px-3 text-body text-fg-primary focus:border-focus-ring focus:outline-none";
const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 10);

export function DemoForm({ onDone }: { onDone?: () => void }) {
  const [errors, setErrors] = React.useState<Record<string, string[]>>({});
  const [message, setMessage] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const [done, setDone] = React.useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? "").trim();
    setPending(true);
    setErrors({});
    setMessage(null);
    const result = await requestDemoAction({
      name: text("name"),
      businessName: text("businessName"),
      phone: text("phone"),
      email: text("email"),
      city: text("city"),
      preferredDate: text("preferredDate"),
      preferredTime: text("preferredTime"),
      outletCount: text("outletCount") ? Number(text("outletCount")) : undefined,
      message: text("message") || undefined,
      website: text("website") || undefined,
    });
    setPending(false);
    if (!result.ok) {
      setErrors(result.error.fieldErrors ?? {});
      setMessage(result.error.message);
      return;
    }
    setDone(true);
  }

  if (done) {
    return (
      <div role="status" className="flex flex-col items-center gap-3 py-6 text-center" data-testid="demo-confirmation">
        <CheckCircle2 aria-hidden className="size-12 text-status-success" />
        <p className="text-heading text-fg-primary">Thank you.</p>
        <p className="max-w-sm text-body text-fg-secondary">Your FlowDineOS demo request has been received. Our team will contact you.</p>
        {onDone && (
          <Button variant="secondary" onClick={onDone}>
            Close
          </Button>
        )}
      </div>
    );
  }

  const field = (name: string, label: string, input: React.ReactNode, required = true) => (
    <label className="flex min-w-0 flex-col gap-1.5 text-label text-fg-primary">
      <span>
        {label}
        {required && <span aria-hidden className="text-status-danger"> *</span>}
      </span>
      {input}
      {errors[name]?.[0] && <span className="text-caption text-status-danger">{errors[name][0]}</span>}
    </label>
  );

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4" data-testid="demo-form">
      {message && (
        <p role="alert" className="rounded-xl border border-status-danger/40 bg-status-danger/12 px-3 py-2 text-body text-status-danger">
          {message}
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        {field("name", "Your name", <input name="name" required autoComplete="name" maxLength={120} className={FIELD} />)}
        {field("businessName", "Restaurant or business name", <input name="businessName" required autoComplete="organization" maxLength={160} className={FIELD} />)}
        {field("phone", "Mobile number", <input name="phone" type="tel" required autoComplete="tel" inputMode="tel" maxLength={20} className={FIELD} />)}
        {field("email", "Email", <input name="email" type="email" required autoComplete="email" maxLength={254} className={FIELD} />)}
        {field("city", "City", <input name="city" required autoComplete="address-level2" maxLength={80} className={FIELD} />)}
        {field("outletCount", "Number of outlets", <input name="outletCount" type="number" min={1} max={999} className={FIELD} />, false)}
        {field("preferredDate", "Preferred date", <input name="preferredDate" type="date" required min={today()} className={FIELD} />)}
        {field("preferredTime", "Preferred time", <input name="preferredTime" type="time" required className={FIELD} />)}
      </div>
      {field("message", "Message or requirements", <textarea name="message" rows={3} maxLength={1000} className={cn(FIELD, "h-auto py-2")} />, false)}
      {/* Spam trap: hidden from people and from assistive technology; only bots fill it. */}
      <input name="website" tabIndex={-1} autoComplete="off" aria-hidden className="sr-only" />
      <p className="text-caption text-fg-secondary">We use these details only to arrange your demo (see our <a href="/privacy" className="text-fg-accent underline-offset-4 hover:underline">Privacy Policy</a>). The date and time are your preference; we will confirm with you.</p>
      <Button type="submit" size="lg" icon={CalendarCheck} loading={pending} loadingLabel="Sending…" className="w-full sm:w-auto sm:self-end">
        Request demo
      </Button>
    </form>
  );
}

export function BookDemoButton({ className, label = "Book a Demo" }: { className?: string; label?: string }) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "inline-flex h-12 items-center rounded-xl bg-action-primary px-5 text-label text-action-primary-fg transition-colors duration-fast ease-standard hover:bg-action-primary-hover motion-safe:hover:shadow-glow",
          className,
        )}
      >
        {label}
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Book a FlowDineOS demo" description="Tell us about your restaurant and when suits you." size="options">
        <DemoForm onDone={() => setOpen(false)} />
      </Dialog>
    </>
  );
}
