import Link from "next/link";
import { ChevronRight, type LucideIcon } from "lucide-react";
import { Icon } from "@/components/ui/icon";

/**
 * The way to the *other* sign-in page (RASOIOS-ADR-019 §1).
 *
 * RASOIOS has two doors: administrators and managers use an emailed one-time code at `/sign-in`, and counter and
 * kitchen staff use the password their administrator generates each day at `/staff-login`. Each page shows its own
 * form and, as a full-width card rather than a line of footer text, the door to the other one. Earlier the way back
 * from the staff page was small grey text, and owners who landed there concluded they had no way to sign in at all.
 */
export function SignInDoor({ href, icon, title, detail }: { href: string; icon: LucideIcon; title: string; detail: string }) {
  return (
    <Link
      href={href}
      className="glass-2 flex items-center gap-3 rounded-2xl px-4 py-3 text-left transition-colors duration-fast ease-standard hover:bg-raised"
    >
      <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-action-primary text-action-primary-fg">
        <Icon icon={icon} size={20} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-label text-fg-primary">{title}</span>
        <span className="text-caption text-fg-secondary">{detail}</span>
      </span>
      <Icon icon={ChevronRight} size={20} className="text-fg-secondary" />
    </Link>
  );
}

/** Small heading above a sign-in form, so each door says who it is for before anyone types into it. */
export function SignInAudience({ children }: { children: React.ReactNode }) {
  return <p className="text-center text-label uppercase tracking-wide text-fg-secondary">{children}</p>;
}
