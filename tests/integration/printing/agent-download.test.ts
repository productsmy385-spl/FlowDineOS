import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { GET } from "@/app/api/v1/printing/agent-download/[platform]/route";
import { asAnonymous, asSeedUser, invokeRoute, seedOnce } from "../helpers/actors";

/**
 * RH-PRINT-08 — the print agent download (S1-P17-T009).
 *
 * Serves the self-contained Windows installer (FlowDineOS-Print-Agent-Setup.exe)
 * and the Linux archive (flowdineos-print-agent-linux.tar.gz) to authenticated users with
 * print_agent:manage permission.
 */
const DIST = path.join(process.cwd(), "print-agent", "dist");
const WINDOWS_EXE = path.join(DIST, "windows", "FlowDineOS-Print-Agent-Setup.exe");
const LINUX_TAR = path.join(DIST, "flowdineos-print-agent-linux.tar.gz");

beforeAll(async () => {
  await seedOnce();
  if (!existsSync(WINDOWS_EXE) || !existsSync(LINUX_TAR)) {
    await import(/* @vite-ignore */ path.join(process.cwd(), "print-agent", "build.mjs"));
  }
}, 180_000);

describe("TC-PRINT-030 the agent packages are real, installable binaries", () => {
  it("builds both platforms, and Windows is a real PE executable while Linux is gzip", () => {
    expect(existsSync(WINDOWS_EXE), "windows installer").toBe(true);
    expect(existsSync(LINUX_TAR), "linux package").toBe(true);
  });

  it("the windows installer is a valid Windows PE binary (MZ header), not a renamed zip", () => {
    const bytes = readFileSync(WINDOWS_EXE);
    // "MZ" — Portable Executable signature
    expect(bytes.subarray(0, 2).toString("latin1")).toBe("MZ");
    expect(bytes.length).toBeGreaterThan(1_000_000); // self-contained SEA installer is ~23 MB
  });

  it("the linux package is gzip, as its extension promises", () => {
    expect(readFileSync(LINUX_TAR).subarray(0, 2).toString("hex")).toBe("1f8b");
  });
});

describe("TC-PRINT-031 who may download the agent", () => {
  it("hands the Windows installer to someone who manages agents", async () => {
    await asSeedUser("A", "TENANT_ADMIN");
    const response = await invokeRoute(GET, { url: "/api/v1/printing/agent-download/windows", params: { platform: "windows" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-disposition")).toContain("FlowDineOS-Print-Agent-Setup.exe");
    expect(response.headers.get("content-disposition")).not.toContain(".zip");
    expect(Number(response.headers.get("content-length"))).toBeGreaterThan(1_000_000);
    expect(response.headers.get("x-package-sha256")).toMatch(/^[0-9a-f]{64}$/);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("hands over the Linux package too", async () => {
    await asSeedUser("A", "TENANT_ADMIN");
    const response = await invokeRoute(GET, { url: "/api/v1/printing/agent-download/linux", params: { platform: "linux" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/gzip");
    expect(response.headers.get("content-disposition")).toContain("flowdineos-print-agent-linux.tar.gz");
    expect(response.headers.get("x-package-sha256")).toMatch(/^[0-9a-f]{64}$/);
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
