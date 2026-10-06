// SC-DEP-01 dependency audit gate. CI runs `npm audit --json > npm-audit.json` and then this script on the result.
//
// Any high or critical advisory fails the build — exactly as plain `npm audit --audit-level=high` did — except an
// advisory on the reviewed exception list below, and only until its review date. A finding counts as excepted only
// if *every* advisory it descends from is excepted, so a package that also carries a second, unreviewed advisory still
// fails. Fails closed: unreadable or errored audit output is a failure, never a pass.
//
// Reads a file rather than running npm itself: application and script code may not use child_process (SC-VAL-06).
import { readFileSync } from "node:fs";

/**
 * Reviewed exceptions. Each needs a reason a reviewer can check and a date after which it fails again, so an
 * exception is a decision with an expiry rather than a permanent blind spot.
 */
const EXCEPTIONS = {
  "GHSA-vfj7-8cjw-p6xm": {
    package: "braces",
    reviewBy: "2026-11-03",
    reason:
      "Stack-exhaustion DoS when expanding attacker-supplied brace patterns. No patched release exists (<= 3.0.3 is " +
      "affected and 3.0.3 is the latest). In this project braces is reached only through build tooling - Tailwind's " +
      "content globs and @next/eslint-plugin-next - expanding patterns from our own config, never user input, and it " +
      "is not part of the deployed server. npm's only offered fix is a breaking upgrade to Tailwind 4. Re-check by the " +
      "review date for a patched braces or a Tailwind/eslint-config-next release that drops it.",
  },
  "GHSA-rj75-hqrm-r3gf": {
    package: "postcss-selector-parser",
    reviewBy: "2026-11-03",
    reason:
      "Moderate: quadratic CPU cost parsing crafted flat selectors. Patched only in postcss-selector-parser 7.1.6, " +
      "while Tailwind 3 (via postcss-nested) requires the 6.x line, so npm's only fix is a breaking upgrade to " +
      "Tailwind 4. It parses our own stylesheets at build time only - never user input - and is not part of the " +
      "deployed server. It fails the gate only because it rolls up into tailwindcss, which audits as high. Re-check " +
      "by the review date for a 6.x backport or plan the Tailwind 4 move.",
  },
};

const FAILING = new Set(["high", "critical"]);
const today = new Date().toISOString().slice(0, 10);
const path = process.argv[2] ?? "npm-audit.json";

let report;
try {
  report = JSON.parse(readFileSync(path, "utf8"));
} catch (error) {
  console.error(`audit: could not read ${path}: ${error.message}`);
  process.exit(1);
}
if (report.error || !report.vulnerabilities) {
  console.error(`audit: npm audit did not produce a report: ${JSON.stringify(report.error ?? report).slice(0, 400)}`);
  process.exit(1);
}

const vulns = report.vulnerabilities;
const advisoryId = (via) => (via.url ?? "").split("/").pop() || String(via.source);

/** Every advisory a package's finding ultimately descends from. */
function rootsOf(name, seen = new Set()) {
  if (seen.has(name)) return new Set();
  seen.add(name);
  const roots = new Set();
  for (const via of vulns[name]?.via ?? []) {
    if (typeof via === "string") for (const r of rootsOf(via, seen)) roots.add(r);
    else roots.add(advisoryId(via));
  }
  return roots;
}

let failed = false;
for (const [id, exception] of Object.entries(EXCEPTIONS)) {
  if (exception.reviewBy < today) {
    console.error(`audit: exception ${id} (${exception.package}) expired on ${exception.reviewBy} - review it and either renew it with a reason or fix the dependency.`);
    failed = true;
  }
}

const excused = [];
for (const [name, finding] of Object.entries(vulns)) {
  if (!FAILING.has(finding.severity)) continue;
  const roots = [...rootsOf(name)];
  const unexcused = roots.filter((id) => !EXCEPTIONS[id] || EXCEPTIONS[id].reviewBy < today);
  if (roots.length > 0 && unexcused.length === 0) {
    excused.push(`${name} (${roots.join(", ")})`);
  } else {
    console.error(`audit: ${finding.severity} - ${name} via ${unexcused.join(", ") || "unknown advisory"}`);
    failed = true;
  }
}

const seen = new Set(Object.keys(vulns).flatMap((name) => [...rootsOf(name)]));
for (const id of Object.keys(EXCEPTIONS)) {
  if (!seen.has(id)) console.warn(`audit: exception ${id} no longer appears in the report - remove it from scripts/check-audit.mjs.`);
}

if (excused.length > 0) console.log(`audit: ${excused.length} high finding(s) covered by a reviewed exception: ${excused.join("; ")}`);
if (failed) process.exit(1);
console.log("audit: no unreviewed high or critical advisories.");
