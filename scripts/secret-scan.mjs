#!/usr/bin/env node
/**
 * Defensive secret scan of THIS repository (security hardening brief 2026-10-07). Reports only where a credential-shaped
 * string is and what kind it looks like — file, line (or commit), category, severity — and never the matched text.
 *
 *   node scripts/secret-scan.mjs tree      files in the working tree (no node_modules, .next, .git or real .env files)
 *   git log --all -p --no-color --unified=0 --format="@@commit %h" | node scripts/secret-scan.mjs history
 *                                          every patch in the git history, read from stdin — scripts never start other
 *                                          programs (SC-VAL-06)
 *   node scripts/secret-scan.mjs bundle    the built browser bundle (.next/static) — run after `npm run build`.
 *                                          Also checks that no server-only environment value present in this process
 *                                          appears in it (reported by variable name only).
 *
 * Exits 1 when a HIGH finding exists. Local development database URLs (localhost / 127.0.0.1) are not findings; matches
 * under tests/ are reported as FIXTURE and do not fail the scan.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const RULES = [
  { category: "Private key block", severity: "HIGH", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/ },
  { category: "Clerk secret key", severity: "HIGH", re: /\bsk_(?:live|test)_[A-Za-z0-9]{20,}/ },
  { category: "Database URL with password (non-local)", severity: "HIGH", re: /\bpostgres(?:ql)?:\/\/[^:\s"'`/]+:[^@\s"'`]+@(?!localhost|127\.0\.0\.1|\[::1\]|db:|postgres:)[^\s"'`]+/ },
  { category: "AWS access key id", severity: "HIGH", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { category: "GitHub token", severity: "HIGH", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { category: "Google API key", severity: "HIGH", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { category: "Slack token", severity: "HIGH", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { category: "ImageKit private key", severity: "HIGH", re: /\bprivate_[A-Za-z0-9+/=]{20,}/ },
  { category: "Meta access token", severity: "HIGH", re: /\bEAA[A-Za-z0-9]{60,}/ },
  { category: "Railway / generic bearer token in URL", severity: "MEDIUM", re: /[?&](?:access_token|token|api_key)=[A-Za-z0-9._-]{24,}/ },
  { category: "JSON Web Token", severity: "MEDIUM", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
];

/**
 * Server-only variables whose values must never reach the browser bundle: every variable documented in .env.example
 * that is not NEXT_PUBLIC_*.
 */
function serverOnlyEnvNames() {
  const names = new Set();
  // Names only — from the documented list and, when present, the local .env, so an undocumented secret is compared too.
  for (const file of [".env.example", ".env"]) {
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*#?\s*([A-Z][A-Z0-9_]+)\s*=/.exec(line);
      if (m && !m[1].startsWith("NEXT_PUBLIC_")) names.add(m[1]);
    }
  }
  return [...names];
}

const SKIP = [/^node_modules\//, /^\.next\//, /package-lock\.json$/, /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|pdf|zip|xlsx)$/i, /^scripts\/secret-scan\.mjs$/];
const findings = [];
// Test fixtures are credential-shaped on purpose (validators, redaction tests). They are listed, not failed; a fixture that
// equals a real value is caught by comparing against the environment in `bundle` mode and by review.
const report = (where, category, severity) => findings.push({ where, category, severity: /(^|\s)tests\//.test(where) && severity === "HIGH" ? "FIXTURE" : severity });

function scanText(text, label) {
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const rule of RULES) if (rule.re.test(line)) report(`${label}:${i + 1}`, rule.category, rule.severity);
  });
}

const TREE_SKIP_DIRS = new Set(["node_modules", ".next", ".git", "dist", "coverage", "playwright-report", "test-results"]);

function* treeFiles(dir = ".") {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = dir === "." ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      // Git-ignored local artefacts (lint reports, stale Next.js build folders) are not part of the repository.
      if (!TREE_SKIP_DIRS.has(entry.name) && !/^\.next/.test(entry.name) && entry.name !== ".local") yield* treeFiles(path);
    } else if (!/^\.env(?!\.example$)/.test(entry.name)) {
      // Real .env files are git-ignored and hold the real values: the source of truth, not a leak.
      yield path;
    }
  }
}

function scanTree() {
  for (const file of treeFiles()) {
    if (SKIP.some((re) => re.test(file))) continue;
    try {
      if (statSync(file).size > 2_000_000) continue;
      scanText(readFileSync(file, "utf8"), file);
    } catch {
      // Deleted in the working tree or unreadable: nothing to scan.
    }
  }
}

function scanHistory() {
  const log = readFileSync(0, "utf8");
  let commit = "?";
  let file = "?";
  for (const line of log.split("\n")) {
    if (line.startsWith("@@commit ")) commit = line.slice(9);
    else if (line.startsWith("+++ b/")) file = line.slice(6);
    else if (line.startsWith("+") && !line.startsWith("+++") && !SKIP.some((re) => re.test(file))) {
      for (const rule of RULES) if (rule.re.test(line)) report(`${commit} ${file}`, rule.category, rule.severity);
    }
  }
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else yield path;
  }
}

function scanBundle() {
  const root = join(".next", "static");
  let files;
  try {
    files = [...walk(root)].filter((f) => /\.(js|css|html|json)$/.test(f));
  } catch {
    console.error("No .next/static — run `npm run build` first.");
    process.exit(2);
  }
  const SERVER_ONLY_ENV = serverOnlyEnvNames();
  const values = SERVER_ONLY_ENV.map((name) => ({ name, value: process.env[name] })).filter((v) => typeof v.value === "string" && v.value.length >= 12 && !/^(true|false|production|development|https?:\/\/localhost)/i.test(v.value));
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    scanText(text, file);
    for (const { name, value } of values) if (text.includes(value)) report(file, `Value of server-only ${name}`, "HIGH");
    for (const name of SERVER_ONLY_ENV) if (text.includes(`process.env.${name}`)) report(file, `Reference to server-only ${name}`, "MEDIUM");
  }
  console.log(`Checked ${files.length} bundle files against ${SERVER_ONLY_ENV.length} server-only variable names; ${values.length} had values to compare.`);
}

const mode = process.argv[2] ?? "tree";
if (mode === "tree") scanTree();
else if (mode === "history") scanHistory();
else if (mode === "bundle") scanBundle();
else {
  console.error("Usage: node scripts/secret-scan.mjs tree|history|bundle");
  process.exit(2);
}

const unique = [...new Map(findings.map((f) => [`${f.where}|${f.category}`, f])).values()];
for (const f of unique) console.log(`${f.severity.padEnd(6)} ${f.category} — ${f.where}`);
const high = unique.filter((f) => f.severity === "HIGH").length;
console.log(`${mode}: ${unique.length} finding(s), ${high} high.`);
process.exit(high > 0 ? 1 : 0);
