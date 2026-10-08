// Builds the self-contained Windows print agent (print-agent-windows.md). Windows only.
//
//   1. FlowDineOS.PrintAgent.exe         — the existing agent bundle injected into this Node.js binary as a Single
//                                          Executable Application (SEA): no Node.js needed on the restaurant PC.
//   2. FlowDineOS.PrintAgent.Service.exe — the Windows service host (service-host/*.cs), compiled with the .NET
//                                          Framework C# compiler that ships with Windows.
//   3. FlowDineOS-Print-Agent-Setup.exe  — the NSIS installer (installer.nsi), when makensis is available.
//
// Run after `npm run agent:build` (which produces print-agent/dist/rasoios-print-agent.cjs). Output: print-agent/dist/windows/.
// No secret is read or embedded: the agent gets its server address and token at pairing time, on the restaurant PC.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  console.error("build-windows.mjs builds Windows binaries and must run on Windows.");
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const agentRoot = path.resolve(here, "..", "..");
const repoRoot = path.resolve(agentRoot, "..");
const dist = path.join(agentRoot, "dist");
const out = path.join(dist, "windows");
const bundle = path.join(dist, "rasoios-print-agent.cjs");
const version = JSON.parse(readFileSync(path.join(agentRoot, "package.json"), "utf8")).version;

if (!existsSync(bundle)) {
  console.error("Missing print-agent/dist/rasoios-print-agent.cjs — run `npm run agent:build` first.");
  process.exit(1);
}
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// ── 1. SEA executable ──
// The SEA main script runs as CommonJS without a shebang line.
const main = path.join(out, "agent-main.cjs");
writeFileSync(main, readFileSync(bundle, "utf8").replace(/^#!.*\r?\n/, ""));
const seaConfig = path.join(out, "sea-config.json");
const blob = path.join(out, "sea-prep.blob");
writeFileSync(seaConfig, JSON.stringify({ main, output: blob, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false }, null, 2));
execFileSync(process.execPath, ["--experimental-sea-config", seaConfig], { stdio: "inherit" });

const exe = path.join(out, "FlowDineOS.PrintAgent.exe");
copyFileSync(process.execPath, exe);
const postject = path.join(repoRoot, "node_modules", "postject", "dist", "cli.js");
execFileSync(process.execPath, [postject, exe, "NODE_SEA_BLOB", blob, "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"], { stdio: "inherit" });
rmSync(main);
rmSync(blob);
rmSync(seaConfig);

// The executable must print the agent's version with no Node.js on PATH.
const reported = execFileSync(exe, ["version"], { env: { SystemRoot: process.env.SystemRoot, PATH: path.join(process.env.SystemRoot ?? "C:\\Windows", "System32") }, encoding: "utf8" }).trim();
if (reported !== version) throw new Error(`FlowDineOS.PrintAgent.exe reported "${reported}", expected "${version}"`);
console.log(`FlowDineOS.PrintAgent.exe ${reported} (runs without Node.js on PATH)`);

// ── 2. Service host ──
const windir = process.env.SystemRoot ?? "C:\\Windows";
const csc = path.join(windir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
if (!existsSync(csc)) throw new Error(`C# compiler not found at ${csc}`);
const host = path.join(out, "FlowDineOS.PrintAgent.Service.exe");
execFileSync(
  csc,
  ["/nologo", "/target:exe", "/optimize+", "/platform:x64", `/out:${host}`, "/reference:System.ServiceProcess.dll", path.join(here, "service-host", "Program.cs")],
  { stdio: "inherit" },
);
console.log("FlowDineOS.PrintAgent.Service.exe compiled");

copyFileSync(path.join(here, "README-windows.txt"), path.join(out, "README.txt"));

// ── 3. Installer ──
const candidates = [process.env.MAKENSIS, "makensis", "C:\\Program Files (x86)\\NSIS\\makensis.exe", "C:\\Program Files\\NSIS\\makensis.exe"].filter(Boolean);
let makensis = null;
for (const candidate of candidates) {
  try {
    execFileSync(candidate, ["/VERSION"], { stdio: "ignore" });
    makensis = candidate;
    break;
  } catch {
    // try the next location
  }
}
if (makensis) {
  execFileSync(makensis, ["/V2", `/DVERSION=${version}`, `/DSOURCE_DIR=${out}`, `/DOUT_FILE=${path.join(out, "FlowDineOS-Print-Agent-Setup.exe")}`, path.join(here, "installer.nsi")], { stdio: "inherit" });
  console.log("FlowDineOS-Print-Agent-Setup.exe built");
} else {
  console.warn("makensis (NSIS 3) not found: the installer was not built. Set MAKENSIS or install NSIS.");
  if (process.env.CI) process.exit(1);
}

// ── Checksums ──
const sums = ["FlowDineOS.PrintAgent.exe", "FlowDineOS.PrintAgent.Service.exe", "FlowDineOS-Print-Agent-Setup.exe"]
  .filter((name) => existsSync(path.join(out, name)))
  .map((name) => `${createHash("sha256").update(readFileSync(path.join(out, name))).digest("hex")}  ${name}`)
  .join("\n");
writeFileSync(path.join(out, "SHA256SUMS"), `${sums}\n`);
console.log(sums);
