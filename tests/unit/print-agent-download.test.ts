import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/v1/printing/agent-download/[platform]/route";
import * as guards from "@/lib/auth/guards";
import { ForbiddenError, UnauthenticatedError } from "@/lib/errors";

function extractZipEntry(zipBuffer: Buffer): { filename: string; bytes: Buffer } {
  if (zipBuffer.readUInt32LE(0) !== 0x04034b50) {
    throw new Error("Invalid ZIP header");
  }
  const compressionMethod = zipBuffer.readUInt16LE(8);
  const compressedSize = zipBuffer.readUInt32LE(18);
  const filenameLength = zipBuffer.readUInt16LE(26);
  const extraLength = zipBuffer.readUInt16LE(28);

  const filename = zipBuffer.subarray(30, 30 + filenameLength).toString("utf8");
  const dataStart = 30 + filenameLength + extraLength;
  const compressedData = zipBuffer.subarray(dataStart, dataStart + compressedSize);

  let uncompressedData: Buffer;
  if (compressionMethod === 0) {
    uncompressedData = compressedData;
  } else if (compressionMethod === 8) {
    uncompressedData = inflateRawSync(compressedData);
  } else {
    throw new Error(`Unsupported ZIP compression method: ${compressionMethod}`);
  }

  return { filename, bytes: uncompressedData };
}

describe("Print Agent Download route handler (RH-PRINT-08)", () => {
  it("serves FlowDineOS-Print-Agent-Setup.exe as genuine Windows PE with application/octet-stream", async () => {
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
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="FlowDineOS-Print-Agent-Setup.exe"');
    expect(response.headers.get("content-disposition")).not.toContain(".zip");

    const contentLength = Number(response.headers.get("content-length"));
    expect(contentLength).toBeGreaterThan(1_000_000); // self-contained installer ~23 MB

    const arrayBuf = await response.arrayBuffer();
    const bytes = Buffer.from(arrayBuf);
    expect(bytes.length).toBe(contentLength);

    // Check PE "MZ" header
    expect(bytes.subarray(0, 2).toString("latin1")).toBe("MZ");

    const sha256 = response.headers.get("x-package-sha256");
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
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

  it("serves FlowDineOS-Print-Agent-Setup.zip containing only the verified installer", async () => {
    vi.spyOn(guards, "requireTenant").mockResolvedValue({
      tenantId: "t1",
      userId: "u1",
      role: "TENANT_ADMIN",
      permissions: ["print_agent:manage"],
      requestId: "req-zip",
    } as never);

    const reqZip = new NextRequest("https://app.flowdineos.test/api/v1/printing/agent-download/windows?format=zip");
    const responseZip = await GET(reqZip, { params: Promise.resolve({ platform: "windows" }) });

    expect(responseZip.status).toBe(200);
    expect(responseZip.headers.get("content-type")).toBe("application/zip");
    expect(responseZip.headers.get("content-disposition")).toBe('attachment; filename="FlowDineOS-Print-Agent-Setup.zip"');

    const contentLength = Number(responseZip.headers.get("content-length"));
    expect(contentLength).toBeGreaterThan(1_000_000);

    const arrayBuf = await responseZip.arrayBuffer();
    const zipBytes = Buffer.from(arrayBuf);
    expect(zipBytes.length).toBe(contentLength);

    // Check ZIP magic bytes "PK" (0x50, 0x4B)
    expect(zipBytes.subarray(0, 2).toString("latin1")).toBe("PK");

    const zipSha256 = responseZip.headers.get("x-package-sha256");
    expect(zipSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(zipSha256).toBe(createHash("sha256").update(zipBytes).digest("hex"));

    // Also get the standalone exe
    const reqExe = new NextRequest("https://app.flowdineos.test/api/v1/printing/agent-download/windows");
    const responseExe = await GET(reqExe, { params: Promise.resolve({ platform: "windows" }) });
    const exeBytes = Buffer.from(await responseExe.arrayBuffer());
    const exeSha256 = responseExe.headers.get("x-package-sha256");

    // EXE hash and ZIP hash must be distinct files
    expect(zipSha256).not.toBe(exeSha256);

    // Extraction test: extract single entry from ZIP and verify it matches the release EXE
    const extracted = extractZipEntry(zipBytes);
    expect(extracted.filename).toBe("FlowDineOS-Print-Agent-Setup.exe");

    const extractedHash = createHash("sha256").update(extracted.bytes).digest("hex");
    expect(extractedHash).toBe(exeSha256);
    expect(extracted.bytes.length).toBe(exeBytes.length);
  });

  it("authoritative release manifest accurately documents artifacts and checksums", () => {
    const manifestPath = path.join(process.cwd(), "release", "release-manifest.json");
    expect(existsSync(manifestPath)).toBe(true);

    const rawManifest = readFileSync(manifestPath, "utf8").replace(/^\uFEFF/, "");
    const manifest = JSON.parse(rawManifest);
    expect(manifest.product).toBe("FlowDineOS Print Agent");
    expect(manifest.platform).toBe("windows");
    expect(manifest.version).toBe("0.2.0");
    expect(Array.isArray(manifest.artifacts)).toBe(true);

    const setupArtifact = manifest.artifacts.find((a: { name: string }) => a.name === "FlowDineOS-Print-Agent-Setup.exe");
    expect(setupArtifact).toBeDefined();
    expect(setupArtifact.sha256).toMatch(/^[0-9a-f]{64}$/);

    const zipArtifact = manifest.artifacts.find((a: { name: string }) => a.name === "FlowDineOS-Print-Agent-Setup.zip");
    expect(zipArtifact).toBeDefined();
    expect(zipArtifact.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(zipArtifact.sha256).not.toBe(setupArtifact.sha256);
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
