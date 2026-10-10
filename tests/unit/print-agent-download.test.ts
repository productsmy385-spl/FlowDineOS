import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/v1/printing/agent-download/[platform]/route";
import * as guards from "@/lib/auth/guards";
import { ForbiddenError, UnauthenticatedError } from "@/lib/errors";

describe("Print Agent Download route handler (RH-PRINT-08)", () => {
  it("serves FlowDineOS-Print-Agent-Setup.exe as a genuine Windows PE executable", async () => {
    vi.spyOn(guards, "requireTenant").mockResolvedValueOnce({
      tenantId: "t1",
      userId: "u1",
      role: "TENANT_ADMIN",
      permissions: ["print_agent:manage"],
      requestId: "req-1",
    } as never);

    const req = new NextRequest("https://app.flowdineos.test/api/v1/printing/agent-download/windows");
    const response = await GET(req, { params: Promise.resolve({ platform: "windows" }) });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/vnd.microsoft.portable-executable");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="FlowDineOS-Print-Agent-Setup.exe"');
    expect(response.headers.get("content-disposition")).not.toContain(".zip");

    const arrayBuf = await response.arrayBuffer();
    const bytes = Buffer.from(arrayBuf);
    expect(bytes.length).toBeGreaterThan(1_000_000); // self-contained installer ~23 MB
    // Check PE "MZ" header
    expect(bytes.subarray(0, 2).toString("latin1")).toBe("MZ");

    const sha256 = response.headers.get("x-package-sha256");
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("serves flowdineos-print-agent-linux.tar.gz as a gzip archive", async () => {
    vi.spyOn(guards, "requireTenant").mockResolvedValueOnce({
      tenantId: "t1",
      userId: "u1",
      role: "TENANT_ADMIN",
      permissions: ["print_agent:manage"],
      requestId: "req-2",
    } as never);

    const req = new NextRequest("https://app.flowdineos.test/api/v1/printing/agent-download/linux");
    const response = await GET(req, { params: Promise.resolve({ platform: "linux" }) });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/gzip");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="flowdineos-print-agent-linux.tar.gz"');

    const arrayBuf = await response.arrayBuffer();
    const bytes = Buffer.from(arrayBuf);
    // Check gzip magic bytes "1f8b"
    expect(bytes.subarray(0, 2).toString("hex")).toBe("1f8b");
  });

  it("refuses unauthorized requests without valid session", async () => {
    vi.spyOn(guards, "requireTenant").mockRejectedValueOnce(new UnauthenticatedError());

    const req = new NextRequest("https://app.flowdineos.test/api/v1/printing/agent-download/windows");
    const response = await GET(req, { params: Promise.resolve({ platform: "windows" }) });
    expect(response.status).toBe(401);
  });

  it("refuses users lacking print_agent:manage permission", async () => {
    vi.spyOn(guards, "requireTenant").mockRejectedValueOnce(new ForbiddenError());

    const req = new NextRequest("https://app.flowdineos.test/api/v1/printing/agent-download/windows");
    const response = await GET(req, { params: Promise.resolve({ platform: "windows" }) });
    expect(response.status).toBe(403);
  });

  it("returns 404 for unknown platforms or path traversal", async () => {
    vi.spyOn(guards, "requireTenant").mockResolvedValue({
      tenantId: "t1",
      userId: "u1",
      role: "TENANT_ADMIN",
      permissions: ["print_agent:manage"],
      requestId: "req-3",
    } as never);

    for (const bad of ["macos", "../../etc/passwd", "windows.zip"]) {
      const req = new NextRequest(`https://app.flowdineos.test/api/v1/printing/agent-download/${bad}`);
      const response = await GET(req, { params: Promise.resolve({ platform: bad }) });
      expect(response.status).toBe(404);
    }
  });
});
