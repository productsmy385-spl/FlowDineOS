import { existsSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { GET } from "@/app/api/v1/printing/agent-download/[platform]/route";
import { asAnonymous, asSeedUser, invokeRoute, seedOnce } from "../helpers/actors";

/**
 * RH-PRINT-08 — the print agent download (S1-P17-T009).
 *
 * The pairing dialog told people to unzip a download that nothing produced or served. These tests hold the two
 * halves of that gap shut: the packages are really built, and the route really hands them over to exactly the
 * people who may install an agent.
 */
const DIST = path.join(process.cwd(), "print-agent", "dist");
const WINDOWS_ZIP = path.join(DIST, "rasoios-print-agent-windows.zip");
const LINUX_TAR = path.join(DIST, "rasoios-print-agent-linux.tar.gz");

beforeAll(async () => {
  await seedOnce();
  // `print-agent/dist` is gitignored and built by `npm run agent:build`, which CI and Railway both run. Build it on
  // demand so a fresh clone does not fail here for a reason unrelated to the route. Imported rather than spawned:
  // `build.mjs` runs its work at module scope, and application code may not shell out (SC-VAL-06).
  if (!existsSync(WINDOWS_ZIP) || !existsSync(LINUX_TAR)) {
    await import(/* @vite-ignore */ path.join(process.cwd(), "print-agent", "build.mjs"));
  }
}, 180_000);

describe("TC-PRINT-030 the agent packages are real, installable archives", () => {
  it("builds both platforms, and each carries the bundle its installer verifies", () => {
    expect(existsSync(WINDOWS_ZIP), "windows package").toBe(true);
    expect(existsSync(LINUX_TAR), "linux package").toBe(true);
  });

  it("the zip is a valid archive whose entries a restaurant can actually extract", async () => {
    const { readFileSync } = await import("node:fs");
    const bytes = readFileSync(WINDOWS_ZIP);
    // "PK\x03\x04" — a real local file header, not a placeholder or an empty file.
    expect(bytes.subarray(0, 4).toString("latin1")).toBe("PK\u0003\u0004");
    // The central directory names every file the Windows installer needs.
    const text = bytes.toString("latin1");
    for (const name of ["rasoios-print-agent.cjs", "SHA256SUMS", "install.ps1", "uninstall.ps1", "README.txt"]) {
      expect(text, name).toContain(name);
    }
  });

  it("the linux package is gzip, as its extension promises", async () => {
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(LINUX_TAR).subarray(0, 2).toString("hex")).toBe("1f8b");
  });
});

describe("TC-PRINT-031 who may download the agent", () => {
  it("hands the Windows package to someone who manages agents", async () => {
    await asSeedUser("A", "TENANT_ADMIN");
    const response = await invokeRoute(GET, { url: "/api/v1/printing/agent-download/windows", params: { platform: "windows" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-disposition")).toContain("rasoios-print-agent-windows.zip");
    expect(Number(response.headers.get("content-length"))).toBeGreaterThan(1000);
    expect(response.headers.get("x-package-sha256")).toMatch(/^[0-9a-f]{64}$/);
    // A redeploy changes these bytes; an agent older than the server that pairs it is exactly what must not happen.
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("hands over the Linux package too", async () => {
    await asSeedUser("A", "TENANT_ADMIN");
    const response = await invokeRoute(GET, { url: "/api/v1/printing/agent-download/linux", params: { platform: "linux" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/gzip");
  });

  it("refuses a role that cannot manage print agents", async () => {
    await asSeedUser("A", "WAITER");
    const response = await invokeRoute(GET, { url: "/api/v1/printing/agent-download/windows", params: { platform: "windows" } });
    expect(response.status).toBe(403);
  });

  it("refuses a signed-out visitor — the agent binary is not public", async () => {
    asAnonymous();
    const response = await invokeRoute(GET, { url: "/api/v1/printing/agent-download/windows", params: { platform: "windows" } });
    expect(response.status).toBe(401);
  });

  it("404s an unknown platform instead of guessing a file path", async () => {
    await asSeedUser("A", "TENANT_ADMIN");
    for (const platform of ["macos", "../../.env", "windows.zip"]) {
      const response = await invokeRoute(GET, { url: `/api/v1/printing/agent-download/${platform}`, params: { platform } });
      expect(response.status, platform).toBe(404);
    }
  });
});
