"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@clerk/nextjs";

const RETRY_MS = 600;
const MAX_SOFT_RETRIES = 8;
const RELOADED_KEY = "flowdine.signin.reloaded";

/**
 * Shown by /sign-in/landing when the server did not see a session yet, right after Clerk finished signing in (owner
 * report 2026-10-07: "after signing in it stays on the sign-in page until I refresh"). The browser already holds the
 * session; its cookie had not reached the server on the first request. So instead of bouncing back to /sign-in, ask
 * the server again until it sees the session — the landing then redirects to the person's console. Only when Clerk
 * itself says there is no session does this go back to the form.
 */
export function CompletingSignIn() {
  const { isLoaded, isSignedIn } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) {
      router.replace("/sign-in");
      return;
    }
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      if (tries <= MAX_SOFT_RETRIES) {
        router.refresh();
        return;
      }
      clearInterval(timer);
      // Last resort, once per tab: a full load sends every cookie fresh.
      let reloaded = false;
      try {
        reloaded = window.sessionStorage.getItem(RELOADED_KEY) === "1";
        window.sessionStorage.setItem(RELOADED_KEY, "1");
      } catch {
        // Storage blocked: reload once anyway; the interval is already cleared, so this cannot loop within the page.
      }
      if (!reloaded) window.location.reload();
    }, RETRY_MS);
    return () => clearInterval(timer);
  }, [isLoaded, isSignedIn, router]);

  return (
    <main className="flex min-h-dvh items-center justify-center bg-canvas p-6 text-body text-fg-secondary" role="status" aria-live="polite">
      Opening your restaurant…
    </main>
  );
}
