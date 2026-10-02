"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/inputs";
import { staffLoginAction } from "./actions";

/**
 * The staff sign-in form (SA-STAFFAUTH-04).
 *
 * One message for a wrong email and a wrong password, because they are the same failure as far as anyone outside
 * the restaurant is concerned: saying which was wrong would confirm whether a person works here. An expired
 * password is called out separately — that one is not a secret, and the staff member needs to know to ask for
 * today's (C15).
 */
export function StaffLoginForm() {
  const router = useRouter();
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const result = await staffLoginAction({ email, password });
    setPending(false);

    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    if (result.data.outcome === "EXPIRED") {
      setError("Today's staff password has expired. Ask your administrator to generate a new one.");
      return;
    }
    if (result.data.outcome === "INVALID") {
      setError("That email and password do not match. Check today's password with your administrator.");
      return;
    }
    // The role decides the page; /restaurant resolves it from the session the cookie just established.
    router.replace("/restaurant");
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="glass-2 flex flex-col gap-4 rounded-3xl p-6">
      {error && (
        <p role="alert" className="rounded-xl border border-status-danger/30 bg-status-danger/12 px-3 py-2 text-body text-status-danger">
          {error}
        </p>
      )}
      <TextField
        name="email"
        label="Work email"
        type="email"
        required
        autoComplete="username"
        autoFocus
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        placeholder="you@restaurant.example"
      />
      <TextField
        name="password"
        label="Today's password"
        type="password"
        required
        // Not `current-password`: this changes every day, so offering to save it trains people to rely on a
        // password that will not work tomorrow.
        autoComplete="off"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        placeholder="ABCD-2345"
        inputClassName="text-numeric tracking-[0.2em]"
      />
      <Button type="submit" variant="primary" loading={pending} loadingLabel="Signing in…">
        Sign in
      </Button>
    </form>
  );
}
