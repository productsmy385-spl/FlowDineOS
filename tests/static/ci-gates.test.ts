import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// TC-FOUND-004 / TC-FOUND-005 — CI gates and PR template exist and stay configured (S1-P01-T006).
const root = path.resolve(__dirname, "../..");
const ci = readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
const template = readFileSync(path.join(root, ".github/pull_request_template.md"), "utf8");

describe("TC-FOUND-004 CI gates", () => {
  it.each(["lint", "typecheck", "unit", "static", "integration", "e2e", "build", "audit"])(
    "defines the `%s` job",
    (job) => {
      expect(ci).toMatch(new RegExp(`^  ${job}:\\s*$`, "m"));
    },
  );

  it("fails the build on high or critical advisories", () => {
    expect(ci).toContain("npm audit --audit-level=high");
    // The audit is judged by the exception-aware gate, never skipped (SC-DEP-01).
    expect(ci).toContain("node scripts/check-audit.mjs npm-audit.json");
  });

  it("runs integration tests against a real PostgreSQL service", () => {
    expect(ci).toMatch(/image: postgres:\d+/);
    expect(ci).toContain("npm run test:integration");
  });

  it("runs on pull requests and pushes to main", () => {
    expect(ci).toMatch(/on:\s*\n\s*pull_request:/);
    expect(ci).toMatch(/push:\s*\n\s*branches: \[main\]/);
  });
});

describe("TC-FOUND-005 PR template", () => {
  it("contains the new dependency review section with required columns", () => {
    expect(template).toContain("## New dependency review");
    for (const column of ["Package", "Purpose", "Maintainer", "Licence", "Alternatives considered"]) {
      expect(template).toContain(column);
    }
  });

  it("requires task IDs and Knowledge Base updates", () => {
    expect(template).toContain("Task ID(s)");
    expect(template).toContain("tasks.md");
  });
});
