// Builds the agent into one self-contained CommonJS file for Node >= 22 (S1-P17-T002/T009), plus SHA256SUMS for the
// release artifacts. esbuild resolves from the repository root's node_modules; `@/` maps to the repository root so
// the agent bundles the exact PrintDocument schema and text rules the server uses (lib/print/*).
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { tarGz, zip } from "./packaging/archive.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const outfile = path.join(here, "dist", "rasoios-print-agent.cjs");

await build({
  entryPoints: [path.join(here, "src", "main.ts")],
  outfile,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  alias: { "@": root },
  banner: { js: "#!/usr/bin/env node" },
  legalComments: "none",
  logLevel: "info",
});

const bundle = readFileSync(outfile);
const sum = createHash("sha256").update(bundle).digest("hex");
const sums = `${sum}  rasoios-print-agent.cjs\n`;
writeFileSync(path.join(here, "dist", "SHA256SUMS"), sums);
console.log(`sha256 ${sum}`);

/**
 * The two packages a restaurant actually downloads (Printing -> Agents -> Pair agent).
 *
 * Each carries the bundle, the SHA256SUMS the installer verifies it against, that platform's install/uninstall
 * scripts and a README. Without this step the pairing dialog told people to "unzip the print agent download" and
 * there was nothing to download: the bundle existed but nothing packaged or served it.
 *
 * Both packages are built on every deploy (railway.json runs `agent:build`), so the file the console serves is
 * always the same version as the server that pairs it.
 */
const packaged = (platform, extra) => [
  { name: "rasoios-print-agent.cjs", data: bundle, executable: true },
  { name: "SHA256SUMS", data: Buffer.from(sums) },
  { name: "README.txt", data: Buffer.from(readme(platform)) },
  ...extra,
];
const file = (name, relative, executable = false) => ({
  name,
  data: readFileSync(path.join(here, "packaging", relative)),
  executable,
});

writeFileSync(
  path.join(here, "dist", "rasoios-print-agent-windows.zip"),
  zip(packaged("windows", [file("install.ps1", "windows/install.ps1"), file("uninstall.ps1", "windows/uninstall.ps1")])),
);
writeFileSync(
  path.join(here, "dist", "rasoios-print-agent-linux.tar.gz"),
  tarGz(
    packaged("linux", [
      file("install.sh", "linux/install.sh", true),
      file("uninstall.sh", "linux/uninstall.sh", true),
      file("rasoios-print-agent.service", "linux/rasoios-print-agent.service"),
    ]),
  ),
);
console.log("packaged rasoios-print-agent-windows.zip and rasoios-print-agent-linux.tar.gz");

function readme(platform) {
  const install =
    platform === "windows"
      ? [
          "  1. Right-click Start -> Terminal (Administrator).",
          "  2. cd into this folder.",
          "  3. powershell -ExecutionPolicy Bypass -File install.ps1 -ServerUrl <server> -PairingCode <code>",
        ]
      : [
          "  1. Open a terminal in this folder.",
          "  2. sudo ./install.sh --server-url <server> --pairing-code <code>",
        ];
  return [
    "FlowDineOS Print Agent",
    "======================",
    "",
    "Runs on the restaurant PC and prints to the printers on your own network. The FlowDineOS",
    "servers never reach your LAN; this agent asks them for print jobs and sends them on.",
    "",
    "Requires Node.js 22 or later on this machine.",
    "",
    "Install:",
    ...install,
    "",
    "The pairing code is shown in FlowDineOS under Printing -> Agents -> Pair agent. It is valid",
    "for ten minutes and can be used once. The server URL is the address you use for FlowDineOS.",
    "",
    "install.ps1 / install.sh verify rasoios-print-agent.cjs against SHA256SUMS before installing.",
    "If that check fails, the download was damaged or tampered with: do not continue, and fetch it",
    "again from the console.",
    "",
    "To remove the agent, run uninstall.ps1 / uninstall.sh from this folder as administrator/root.",
    "",
  ].join("\n");
}
