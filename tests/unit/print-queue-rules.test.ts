import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { PrintJobStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { LEASE_MS, PRINT_JOB_TRANSITIONS, RETRY_POLICIES, assertTransition, canTransition, displayStatus, outcomeOfFailure, retryDelayMs } from "@/lib/print/state-machine";
import { connectionAddressIssue, isPrivateIpv4, isPrivateLanAddress, isValidPort } from "@/lib/validation/printing";

/**
 * TC-PRINT-002 (job state machine), TC-PRINT-006 (PRINTED is written in one place only) and TC-PRINT-007 (LAN address
 * validation) — the queue rules that do not need a database (S1-P16-T001/T004/T005).
 */
const root = path.resolve(__dirname, "../..");

describe("TC-PRINT-002 print job state machine", () => {
  it("allows exactly the documented transitions (architecture.md §6.3, printing audit 2026-10-08)", () => {
    expect(PRINT_JOB_TRANSITIONS).toEqual({
      PENDING: ["PROCESSING", "FAILED", "CANCELLED"],
      PROCESSING: ["PRINTED", "PENDING", "FAILED"],
      PRINTED: [],
      FAILED: ["PENDING", "CANCELLED"],
      CANCELLED: [],
    });
  });

  it("refuses everything else: no way out of PRINTED or CANCELLED, and a job being sent cannot be cancelled", () => {
    const all = Object.values(PrintJobStatus);
    const allowed = new Set(all.flatMap((from) => PRINT_JOB_TRANSITIONS[from].map((to) => `${from}->${to}`)));
    for (const from of all) {
      for (const to of all) {
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(allowed.has(`${from}->${to}`));
      }
    }
    expect(canTransition("PENDING", "PRINTED"), "a job may never skip the agent's acknowledgement").toBe(false);
    expect(canTransition("PRINTED", "PENDING")).toBe(false);
    expect(canTransition("FAILED", "PRINTED")).toBe(false);
    expect(canTransition("PROCESSING", "CANCELLED"), "in flight: the agent may be writing to the printer").toBe(false);
    expect(canTransition("PRINTED", "CANCELLED")).toBe(false);
    expect(canTransition("CANCELLED", "PENDING")).toBe(false);
    expect(() => assertTransition("PRINTED", "PENDING")).toThrowError(expect.objectContaining({ code: "INVALID_TRANSITION", statusCode: 409 }));
    expect(() => assertTransition("PENDING", "PROCESSING")).not.toThrow();
  });

  it("KOT backs off 5 s, 10 s, 20 s, 30 s, 1 min, 2 min, then every 5 min; leases are 60 s", () => {
    expect(LEASE_MS).toBe(60_000);
    expect([1, 2, 3, 4, 5, 6, 7, 8, 12].map((n) => retryDelayMs("KOT", n))).toEqual([5_000, 10_000, 20_000, 30_000, 60_000, 120_000, 300_000, 300_000, 300_000]);
    expect(RETRY_POLICIES.KOT.windowMs).toBe(30 * 60_000);
    expect(RETRY_POLICIES.TEST.maxAttempts).toBeLessThanOrEqual(2);
  });

  it("TC-PRINT-020 a KOT keeps retrying while the printer is unreachable for up to 30 minutes, then stops as PRINT_JOB_EXPIRED", () => {
    const createdAt = new Date("2026-10-08T08:00:00.000Z");
    const job = { jobType: "KOT" as const, maxAttempts: RETRY_POLICIES.KOT.maxAttempts, createdAt, errorCode: "CONNECTION_TIMEOUT" };
    // Simulate the printer staying off: every attempt fails and is rescheduled.
    let at = createdAt;
    let attempts = 0;
    for (;;) {
      attempts += 1;
      const outcome = outcomeOfFailure({ ...job, attemptCount: attempts }, at);
      if (outcome.status === "FAILED") {
        expect(outcome).toMatchObject({ errorCode: "PRINT_JOB_EXPIRED", gaveUp: true });
        break;
      }
      expect(outcome.errorCode).toBe("CONNECTION_TIMEOUT");
      at = outcome.nextAttemptAt!;
    }
    expect(at.getTime() - createdAt.getTime()).toBeLessThanOrEqual(30 * 60_000);
    expect(at.getTime() - createdAt.getTime()).toBeGreaterThan(25 * 60_000);
    expect(attempts).toBeGreaterThan(8);
    expect(attempts).toBeLessThanOrEqual(RETRY_POLICIES.KOT.maxAttempts);
  });

  it("an error retrying cannot fix fails at once — never a blind resend of a ticket that may be on paper", () => {
    const at = new Date("2026-10-08T08:00:00.000Z");
    for (const code of ["DELIVERY_UNKNOWN", "INVALID_PRINTER_CONFIGURATION", "ESC_POS_RENDER_FAILED", "PRINTER_NOT_FOUND"]) {
      expect(outcomeOfFailure({ jobType: "KOT", attemptCount: 1, maxAttempts: 30, createdAt: at, errorCode: code }, at), code).toMatchObject({ status: "FAILED", errorCode: code, gaveUp: false });
    }
    // An old agent's "TIMEOUT … stopped accepting data" is a delivery-unknown, not a connection timeout.
    expect(outcomeOfFailure({ jobType: "KOT", attemptCount: 1, maxAttempts: 30, createdAt: at, errorCode: "TIMEOUT", errorMessage: "Printer at 10.0.0.5:9100 stopped accepting data" }, at)).toMatchObject({ status: "FAILED", errorCode: "DELIVERY_UNKNOWN" });
  });

  it("a test page fails fast so Test print gives a timely answer", () => {
    const at = new Date("2026-10-08T08:00:00.000Z");
    expect(outcomeOfFailure({ jobType: "TEST", attemptCount: 1, maxAttempts: RETRY_POLICIES.TEST.maxAttempts, createdAt: at, errorCode: "CONNECTION_REFUSED" }, at).status).toBe("PENDING");
    expect(outcomeOfFailure({ jobType: "TEST", attemptCount: 2, maxAttempts: RETRY_POLICIES.TEST.maxAttempts, createdAt: at, errorCode: "CONNECTION_REFUSED" }, at).status).toBe("FAILED");
  });

  it("staff see Delivered (never Printed), and Retrying for a queued job that already failed", () => {
    expect(displayStatus({ status: "PRINTED", attemptCount: 1, lastErrorCode: null })).toBe("DELIVERED");
    expect(displayStatus({ status: "PENDING", attemptCount: 0, lastErrorCode: null })).toBe("QUEUED");
    expect(displayStatus({ status: "PENDING", attemptCount: 2, lastErrorCode: "CONNECTION_TIMEOUT" })).toBe("RETRYING");
    expect(displayStatus({ status: "PROCESSING", attemptCount: 1, lastErrorCode: null })).toBe("PRINTING");
    expect(displayStatus({ status: "CANCELLED", attemptCount: 0, lastErrorCode: null })).toBe("CANCELLED");
  });
});

describe("TC-PRINT-006 PRINTED is written in exactly one place", () => {
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) return sourceFiles(full);
      return /\.(ts|tsx)$/.test(name) ? [full] : [];
    });
  }

  it("no code outside lib/data/printing.ts#ackJob assigns the PRINTED status", () => {
    const files = ["app", "lib", "components"].flatMap((dir) => sourceFiles(path.join(root, dir)));
    // An assignment looks like `status: PrintJobStatus.PRINTED` or `status: "PRINTED"` — reading or comparing is fine.
    const assignment = /status:\s*(PrintJobStatus\.PRINTED|["']PRINTED["'])/;
    const offenders = files
      .filter((file) => assignment.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(root, file).split(path.sep).join("/"));
    expect(offenders).toEqual(["lib/data/printing.ts"]);

    // …and inside that file, every occurrence is within ackJob.
    const source = readFileSync(path.join(root, "lib/data/printing.ts"), "utf8");
    const start = source.indexOf("export async function ackJob");
    const end = source.indexOf("// ─── Manual retry");
    expect(start, "ackJob is still the acknowledging function").toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const global = new RegExp(assignment.source, "g");
    const inFile = source.match(global) ?? [];
    const inAckJob = source.slice(start, end).match(new RegExp(assignment.source, "g")) ?? [];
    expect(inFile.length).toBeGreaterThan(0);
    expect(inAckJob.length, "every PRINTED assignment lives inside ackJob").toBe(inFile.length);
  });
});

describe("TC-PRINT-007 printer address validation (SC-PRINT-06)", () => {
  it("accepts private IPv4 addresses with or without a port", () => {
    for (const address of ["192.168.1.50:9100", "10.0.0.7", "172.16.4.9:9100", "172.31.255.254", "10.255.255.255:1", "192.168.0.1:65535"]) {
      expect(isPrivateLanAddress(address), address).toBe(true);
    }
  });

  it("rejects public addresses, loopback, link-local and host names", () => {
    for (const address of [
      "8.8.8.8",
      "1.1.1.1:9100",
      "172.32.0.1",
      "172.15.0.1",
      "169.254.1.1",
      "127.0.0.1:9100",
      "0.0.0.0",
      "localhost",
      "localhost:9100",
      "printer.local",
      "attacker.example.com",
      "192.168.1.50.evil.com",
      "http://192.168.1.50:9100",
      "192.168.1.50:9100/print",
      "192.168.01.50",
      "192.168.1",
      "192.168.1.256",
      "::1",
      "192.168.1.50:9100:9100",
    ]) {
      expect(isPrivateLanAddress(address), address).toBe(false);
    }
  });

  it("rejects ports outside 1–65535", () => {
    expect(isValidPort("1")).toBe(true);
    expect(isValidPort("65535")).toBe(true);
    for (const port of ["0", "65536", "99999", "-1", "91 00", "", "9100a"]) expect(isValidPort(port), port).toBe(false);
    expect(isPrivateLanAddress("192.168.1.50:0")).toBe(false);
    expect(isPrivateLanAddress("192.168.1.50:65536")).toBe(false);
  });

  it("checks the address against the connection type it belongs to", () => {
    expect(connectionAddressIssue("LAN", "192.168.1.50:9100")).toBeNull();
    expect(connectionAddressIssue("LAN", "8.8.8.8")).toMatch(/private LAN address/);
    expect(connectionAddressIssue("USB", "USB001")).toBeNull();
    expect(connectionAddressIssue("USB", "Star TSP100 (copy 1)")).toBeNull();
    expect(connectionAddressIssue("USB", "rm -rf /; USB001")).toMatch(/USB device/);
    expect(connectionAddressIssue("USB", "USB\u001B001")).toMatch(/USB device/);
  });

  it("classifies raw IPv4 literals", () => {
    expect(isPrivateIpv4("10.0.0.1")).toBe(true);
    expect(isPrivateIpv4("172.16.0.1")).toBe(true);
    expect(isPrivateIpv4("172.31.0.1")).toBe(true);
    expect(isPrivateIpv4("172.15.0.1")).toBe(false);
    expect(isPrivateIpv4("11.0.0.1")).toBe(false);
  });
});
