"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { CalendarClock, Check, Copy, KeyRound, LogOut, RefreshCw, ShieldOff, UserRound } from "lucide-react";
import { forceLogoutStaffAction, generateStaffPasswordAction, revokeStaffPasswordAction } from "@/app/restaurant/staff/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { Tabs, type TabItem } from "@/components/ui/tabs";
import { EmptyState } from "@/components/states/empty-state";
import { formatDuration, shiftDurationMs, standingOf, totalDurationMs, STANDING_LABEL, type StaffStanding } from "@/lib/ui/attendance";
import { formatBusinessDate, formatInZone } from "@/lib/ui/format";
import { roleLabel } from "@/lib/ui/navigation";

/**
 * Daily passwords, who is on shift, and attendance (RASOIOS-ADR-019; C11, C12, C13, C14, C16).
 *
 * Cards at every width rather than a table that collapses: each staff member is one unit of information an
 * administrator acts on, and three of them on a phone at the start of a shift is the common case, not the edge one.
 *
 * A generated password is shown exactly once, here, and never again — the server keeps only a scrypt hash. The card
 * says so plainly rather than offering a "show again" that could not work.
 */

export type StandingRow = {
  membershipId: string;
  name: string;
  email: string;
  role: string;
  credentialExpiresAt: string | null;
  credentialGeneratedAt: string | null;
  activeSince: string | null;
};

export type SessionRow = {
  sessionId: string;
  membershipId: string;
  name: string;
  role: string;
  businessDate: string;
  loginAt: string;
  endedAt: string | null;
  endReason: string | null;
  open: boolean;
};

const STANDING_TONE: Record<StaffStanding, "success" | "neutral" | "warning"> = {
  ONLINE: "success",
  OFFLINE: "neutral",
  PASSWORD_EXPIRED: "warning",
  NO_PASSWORD: "warning",
};

const END_REASON_LABEL: Record<string, string> = {
  SIGNED_OUT: "Signed out",
  ADMIN_FORCE_LOGOUT: "Signed out by an administrator",
  CREDENTIAL_REVOKED: "Password revoked",
  EXPIRED: "Password expired",
};

export function StaffAccessBoard({
  standing,
  sessions,
  from,
  to,
  timezone,
}: {
  standing: readonly StandingRow[];
  sessions: readonly SessionRow[];
  from: string;
  to: string;
  timezone: string;
}) {
  const router = useRouter();
  // One clock for the whole board, ticking each minute: every open shift must read the same "now", and a duration
  // shown to the minute has nothing to say more often than that.
  const [nowMs, setNowMs] = React.useState(() => Date.now());
  React.useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  const asOf = new Date(nowMs);

  const [issued, setIssued] = React.useState<{ membershipId: string; password: string } | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [failure, setFailure] = React.useState<string | null>(null);

  async function run(membershipId: string, key: string, fn: () => Promise<{ ok: boolean; error?: { message: string } }>) {
    setBusy(`${membershipId}:${key}`);
    setFailure(null);
    const result = await fn();
    setBusy(null);
    if (!result.ok) {
      setFailure(result.error?.message ?? "That did not work. Try again.");
      return false;
    }
    router.refresh();
    return true;
  }

  async function generate(membershipId: string) {
    setBusy(`${membershipId}:generate`);
    setFailure(null);
    const result = await generateStaffPasswordAction({ membershipId });
    setBusy(null);
    if (!result.ok) {
      setFailure(result.error.message);
      return;
    }
    setIssued({ membershipId, password: result.data.password });
    router.refresh();
  }

  const onShift = standing.filter((row) => row.activeSince !== null);

  const tabs: TabItem[] = [
    {
      id: "passwords",
      label: `Today's passwords (${standing.length})`,
      icon: KeyRound,
      content: (
        <div className="flex flex-col gap-3">
          {standing.length === 0 ? (
            <EmptyState
              icon={UserRound}
              title="No staff to issue passwords for"
              description="Cashiers, kitchen staff and waiters sign in with a daily password. Invite them on the Staff page first."
            />
          ) : (
            standing.map((row) => (
              <StaffCard
                key={row.membershipId}
                row={row}
                asOf={asOf}
                timezone={timezone}
                issuedPassword={issued?.membershipId === row.membershipId ? issued.password : null}
                busy={busy}
                onGenerate={() => generate(row.membershipId)}
                onRevoke={() => run(row.membershipId, "revoke", () => revokeStaffPasswordAction({ membershipId: row.membershipId }))}
                onForceLogout={() => run(row.membershipId, "logout", () => forceLogoutStaffAction({ membershipId: row.membershipId }))}
              />
            ))
          )}
        </div>
      ),
    },
    {
      id: "on-shift",
      label: `On shift now (${onShift.length})`,
      icon: UserRound,
      content:
        onShift.length === 0 ? (
          <EmptyState icon={UserRound} title="Nobody is signed in" description="Staff appear here as soon as they sign in with today's password." />
        ) : (
          <div className="flex flex-col gap-3">
            {onShift.map((row) => (
              <Card key={row.membershipId}>
                <CardContent className="flex flex-wrap items-center gap-3 py-4">
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-label text-fg-primary">{row.name}</span>
                    <span className="text-caption text-fg-secondary">
                      {roleLabel(row.role)} · since {formatInZone(row.activeSince!, timezone, "time")}
                    </span>
                  </span>
                  <Badge tone="success">{formatDuration(shiftDurationMs({ loginAt: new Date(row.activeSince!), endedAt: null }, asOf))}</Badge>
                  <Button
                    variant="destructive"
                    size="sm"
                    icon={LogOut}
                    loading={busy === `${row.membershipId}:logout`}
                    loadingLabel="Signing out…"
                    onClick={() => run(row.membershipId, "logout", () => forceLogoutStaffAction({ membershipId: row.membershipId }))}
                  >
                    Force sign out
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        ),
    },
    {
      id: "attendance",
      label: "Attendance",
      icon: CalendarClock,
      content: <Attendance sessions={sessions} from={from} to={to} timezone={timezone} asOf={asOf} />,
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      {failure && (
        <p role="alert" className="rounded-xl border border-status-danger/30 bg-status-danger/12 px-3 py-2 text-body text-status-danger">
          {failure}
        </p>
      )}
      <Tabs items={tabs} label="Staff access" />
    </div>
  );
}

function StaffCard({
  row,
  asOf,
  timezone,
  issuedPassword,
  busy,
  onGenerate,
  onRevoke,
  onForceLogout,
}: {
  row: StandingRow;
  asOf: Date;
  timezone: string;
  issuedPassword: string | null;
  busy: string | null;
  onGenerate: () => void;
  onRevoke: () => void;
  onForceLogout: () => void;
}) {
  const expiresAt = row.credentialExpiresAt ? new Date(row.credentialExpiresAt) : null;
  const state = standingOf({ hasActiveSession: row.activeSince !== null, credentialExpiresAt: expiresAt }, asOf);
  const hasLivePassword = expiresAt !== null && expiresAt > asOf;

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 py-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-label text-fg-primary">{row.name}</span>
            <span className="truncate text-caption text-fg-secondary">
              {roleLabel(row.role)} · {row.email}
            </span>
          </span>
          <Badge tone={STANDING_TONE[state]}>{STANDING_LABEL[state]}</Badge>
        </div>

        {issuedPassword && <IssuedPassword password={issuedPassword} expiresAt={expiresAt} timezone={timezone} />}

        {!issuedPassword && hasLivePassword && (
          <p className="text-caption text-fg-secondary">
            Password issued {row.credentialGeneratedAt ? formatInZone(row.credentialGeneratedAt, timezone, "time") : ""}, valid until{" "}
            {formatInZone(expiresAt!, timezone, "time")}. It is shown only once, when generated.
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          <Button
            variant={hasLivePassword ? "secondary" : "primary"}
            size="sm"
            icon={hasLivePassword ? RefreshCw : KeyRound}
            loading={busy === `${row.membershipId}:generate`}
            loadingLabel="Generating…"
            onClick={onGenerate}
          >
            {hasLivePassword ? "Regenerate" : "Generate today's password"}
          </Button>
          {hasLivePassword && (
            <Button variant="ghost" size="sm" icon={ShieldOff} loading={busy === `${row.membershipId}:revoke`} loadingLabel="Revoking…" onClick={onRevoke}>
              Revoke
            </Button>
          )}
          {row.activeSince && (
            <Button variant="ghost" size="sm" icon={LogOut} loading={busy === `${row.membershipId}:logout`} loadingLabel="Signing out…" onClick={onForceLogout}>
              Force sign out
            </Button>
          )}
        </div>

        {hasLivePassword && <p className="text-caption text-fg-secondary">Regenerating makes the previous password stop working immediately.</p>}
      </CardContent>
    </Card>
  );
}

/** The one moment the password exists outside the server. */
function IssuedPassword({ password, expiresAt, timezone }: { password: string; expiresAt: Date | null; timezone: string }) {
  const [copied, setCopied] = React.useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be refused; the password is on screen to read either way, so this needs no error.
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-action-primary/30 bg-action-primary/8 p-3">
      <div className="flex flex-wrap items-center gap-3">
        <p aria-label={`Today's password ${password.split("").join(" ")}`} className="flex-1 text-display-s text-numeric tracking-[0.25em] text-fg-primary">
          {password}
        </p>
        <Button variant="secondary" size="sm" icon={copied ? Check : Copy} onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <p className="text-caption text-fg-secondary">
        Give this to the staff member now — it is not stored and cannot be shown again.
        {expiresAt && ` It stops working at ${formatInZone(expiresAt, timezone, "time")}.`}
      </p>
    </div>
  );
}

function Attendance({ sessions, from, to, timezone, asOf }: { sessions: readonly SessionRow[]; from: string; to: string; timezone: string; asOf: Date }) {
  // Grouped by business date then person, so a day reads as a day — and someone who signed in twice shows both
  // shifts with one total, which is the thing the client asked not to be approximated from dates (C9).
  const byDate = new Map<string, Map<string, SessionRow[]>>();
  for (const session of sessions) {
    const people = byDate.get(session.businessDate) ?? new Map<string, SessionRow[]>();
    people.set(session.membershipId, [...(people.get(session.membershipId) ?? []), session]);
    byDate.set(session.businessDate, people);
  }

  if (sessions.length === 0) {
    return (
      <EmptyState
        icon={CalendarClock}
        title="No shifts recorded yet"
        description={`Nothing between ${formatBusinessDate(from)} and ${formatBusinessDate(to)}. Shifts appear here once staff sign in.`}
      />
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <p className="text-caption text-fg-secondary">
        {formatBusinessDate(from)} – {formatBusinessDate(to)}, in the restaurant&apos;s own time.
      </p>
      {[...byDate.entries()].map(([businessDate, people]) => (
        <section key={businessDate} className="flex flex-col gap-2">
          <h3 className="text-label text-fg-primary">{formatBusinessDate(businessDate)}</h3>
          {[...people.values()].map((shifts) => {
            const toShift = (s: SessionRow) => ({ loginAt: new Date(s.loginAt), endedAt: s.endedAt ? new Date(s.endedAt) : null });
            const total = totalDurationMs(shifts.map(toShift), asOf);
            return (
              <Card key={`${businessDate}:${shifts[0].membershipId}`}>
                <CardContent className="flex flex-col gap-2 py-4">
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-label text-fg-primary">{shifts[0].name}</span>
                      <span className="text-caption text-fg-secondary">
                        {roleLabel(shifts[0].role)} · {shifts.length === 1 ? "1 shift" : `${shifts.length} shifts`}
                      </span>
                    </span>
                    <Badge tone={shifts.some((s) => s.open) ? "success" : "neutral"}>{formatDuration(total)}</Badge>
                  </div>
                  <ul className="flex list-none flex-col gap-1 p-0">
                    {shifts.map((shift) => (
                      <li key={shift.sessionId} className="flex flex-wrap items-center gap-x-2 text-caption text-fg-secondary">
                        <Icon icon={CalendarClock} size={16} />
                        <span className="text-numeric">
                          {formatInZone(shift.loginAt, timezone, "time")} – {shift.endedAt ? formatInZone(shift.endedAt, timezone, "time") : "on shift"}
                        </span>
                        <span>({formatDuration(shiftDurationMs(toShift(shift), asOf))})</span>
                        {shift.endReason && END_REASON_LABEL[shift.endReason] && <span>· {END_REASON_LABEL[shift.endReason]}</span>}
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            );
          })}
        </section>
      ))}
    </div>
  );
}
