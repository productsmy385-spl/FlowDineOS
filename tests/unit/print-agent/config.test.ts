import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseAgentConfig, saveAgentConfig, serverUrlIssue } from "@/print-agent/src/config";
import { CredentialError, FileCredentialStore } from "@/print-agent/src/credentials";
import { createLogger, REDACTED } from "@/print-agent/src/logger";
import { agentPaths } from "@/print-agent/src/paths";

/** TC-AGENT-011 (config and logger) and TC-AGENT-007 (credential storage) — S1-P17-T002/T003. */
const TOKEN = `rsa_${"A".repeat(43)}`;
const dirs: string[] = [];
async function tempHome() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rasoios-agent-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("TC-AGENT-011 config.json", () => {
  it("accepts an https origin and normalises it", () => {
    expect(parseAgentConfig({ serverUrl: "https://app.rasoios.in/" })).toEqual({ serverUrl: "https://app.rasoios.in", logLevel: "info" });
  });

  it("rejects plain http except on loopback", () => {
    expect(serverUrlIssue("http://app.rasoios.in")).toMatch(/https/);
    expect(serverUrlIssue("http://192.168.1.10:3000")).toMatch(/https/);
    expect(serverUrlIssue("http://localhost:3000")).toBeNull();
    expect(serverUrlIssue("http://127.0.0.1:3000")).toBeNull();
  });

  it("rejects credentials, paths, queries and non-URLs", () => {
    expect(serverUrlIssue("https://user:pw@app.rasoios.in")).toMatch(/credentials/);
    expect(serverUrlIssue("https://app.rasoios.in/api")).toMatch(/origin/);
    expect(serverUrlIssue("https://app.rasoios.in/?x=1")).toMatch(/query/);
    expect(serverUrlIssue("app.rasoios.in")).toMatch(/valid URL/);
    expect(serverUrlIssue("ftp://app.rasoios.in")).toMatch(/https/);
  });

  it("rejects unknown keys, including a token or tenant placed in config", () => {
    expect(() => parseAgentConfig({ serverUrl: "https://a.example", token: TOKEN })).toThrow(/Unrecognized key/);
    expect(() => parseAgentConfig({ serverUrl: "https://a.example", tenantId: "x" })).toThrow(/Unrecognized key/);
  });

  it("per-OS data directory, overridable for development", () => {
    // FlowDineOS folders for a new install; an existing RasoiOS folder keeps being used so a paired agent keeps its
    // pairing and printed-job journal (branding 2026-10-08).
    const none = () => false;
    const legacyOnly = (dir: string) => /RasoiOS|rasoios/.test(dir);
    expect(agentPaths({ ProgramData: "C:\\ProgramData" }, "win32", none).credentials).toBe("C:\\ProgramData\\FlowDineOS\\PrintAgent\\credentials.json");
    expect(agentPaths({}, "linux", none).journal).toBe("/var/lib/flowdineos-print-agent/journal.json");
    expect(agentPaths({ ProgramData: "C:\\ProgramData" }, "win32", legacyOnly).credentials).toBe("C:\\ProgramData\\RasoiOS\\PrintAgent\\credentials.json");
    expect(agentPaths({}, "linux", legacyOnly).journal).toBe("/var/lib/rasoios-print-agent/journal.json");
    expect(agentPaths({}, "linux", () => true).home).toBe("/var/lib/flowdineos-print-agent");
    expect(agentPaths({ RASOIOS_AGENT_HOME: "/tmp/agent" }, "linux").home).toBe(path.resolve("/tmp/agent"));
    expect(agentPaths({ FLOWDINEOS_AGENT_HOME: "/tmp/fd" }, "linux").home).toBe(path.resolve("/tmp/fd"));
  });
});

describe("TC-AGENT-011 logger redaction (SC-LOG-04)", () => {
  it("never writes a token, claim token, pairing code or payload", () => {
    const lines: string[] = [];
    const logger = createLogger("debug", (line) => lines.push(line));
    logger.info("x", {
      token: TOKEN,
      claimToken: "5f0c3a52-8a44-4a4b-9d56-1d0e1c6d8a11",
      pairingCode: "ABCD2345",
      payload: { blocks: [{ text: "2 x Masala Dosa" }] },
      nested: { authorization: `Bearer ${TOKEN}` },
      message: `request failed with Bearer ${TOKEN}`,
      code: "PRINTER_OFFLINE",
    });
    const out = lines.join("\n");
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain("ABCD2345");
    expect(out).not.toContain("Masala");
    expect(out).not.toContain("5f0c3a52");
    expect(out).toContain(REDACTED);
    // Operational fields stay readable.
    expect(out).toContain("PRINTER_OFFLINE");
  });

  it("respects the level", () => {
    const lines: string[] = [];
    const logger = createLogger("warn", (line) => lines.push(line));
    logger.info("quiet");
    logger.warn("loud");
    expect(lines).toHaveLength(1);
  });
});

describe("TC-AGENT-007 credential storage (SC-PRINT-08)", () => {
  const credential = {
    version: 1 as const,
    agentId: "8a1a4c32-5d6e-4f70-8a91-b2c3d4e5f601",
    token: TOKEN,
    serverOrigin: "https://app.rasoios.in",
    pairedAt: "2026-09-23T10:00:00.000Z",
  };

  it("stores the token in credentials.json only, never in config.json", async () => {
    const paths = agentPaths({ RASOIOS_AGENT_HOME: await tempHome() });
    await saveAgentConfig(paths.config, parseAgentConfig({ serverUrl: "https://app.rasoios.in" }));
    const store = new FileCredentialStore(paths.credentials);
    await store.save(credential);

    expect(await store.load()).toEqual(credential);
    expect(await readFile(paths.config, "utf8")).not.toContain("rsa_");
  });

  it.skipIf(process.platform === "win32")("creates the file 0600 and refuses one other users can read", async () => {
    const paths = agentPaths({ RASOIOS_AGENT_HOME: await tempHome() });
    const store = new FileCredentialStore(paths.credentials);
    await store.save(credential);
    expect((await stat(paths.credentials)).mode & 0o777).toBe(0o600);

    const { chmod } = await import("node:fs/promises");
    await chmod(paths.credentials, 0o644);
    await expect(store.load()).rejects.toBeInstanceOf(CredentialError);
  });

  it("re-pairing replaces the credential; clear removes it", async () => {
    const paths = agentPaths({ RASOIOS_AGENT_HOME: await tempHome() });
    const store = new FileCredentialStore(paths.credentials);
    await store.save(credential);
    await store.save({ ...credential, token: `rsa_${"B".repeat(43)}` });
    expect((await store.load())?.token).toBe(`rsa_${"B".repeat(43)}`);
    await store.clear();
    expect(await store.load()).toBeNull();
  });

  it("a tampered file is an error, not a crash", async () => {
    const paths = agentPaths({ RASOIOS_AGENT_HOME: await tempHome() });
    const store = new FileCredentialStore(paths.credentials);
    await store.save(credential);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(paths.credentials, JSON.stringify({ ...credential, tenantId: "x" }), { mode: 0o600 });
    await expect(store.load()).rejects.toBeInstanceOf(CredentialError);
  });
});
