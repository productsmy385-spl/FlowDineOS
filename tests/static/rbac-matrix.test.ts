import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PERMISSIONS,
  PLATFORM_PERMISSIONS,
  PLATFORM_ROLE_PERMISSIONS,
  TENANT_PERMISSIONS,
  TENANT_ROLE_PERMISSIONS,
} from "@/lib/auth/permissions";

// TC-RBAC-001 (drift part) — lib/auth/permissions.ts equals the security.md §3.3 matrix, via a committed fixture
// (S1-P05-T001). Set UPDATE_RBAC_FIXTURE=1 to regenerate the fixture after an approved matrix change.
const root = path.resolve(__dirname, "../..");
const fixturePath = path.join(root, "tests/fixtures/rbac-matrix.json");
const ROLES = ["SUPER_ADMIN", "TENANT_ADMIN", "MANAGER", "CASHIER", "KITCHEN", "WAITER"] as const;

type Row = { row: number; permission: string; allow: Record<(typeof ROLES)[number], "allow" | "restricted" | "deny">; test: string };

function parseMatrix(): Row[] {
  const md = readFileSync(path.join(root, "knowledge/implementation/slice-01/security.md"), "utf8");
  // The matrix table only (the section continues with the ◐ restriction table, which also has numeric rows).
  const section = md.split("### 3.3")[1].split("**Public (no role):**")[0];
  const rows: Row[] = [];
  for (const line of section.split(/\r?\n/)) {
    const cells = line.split("|").map((c) => c.trim());
    if (!/^\d+$/.test(cells[1] ?? "")) continue;
    const marks = cells.slice(5, 11);
    const allow = Object.fromEntries(
      ROLES.map((role, i) => [role, marks[i] === "✅" ? "allow" : marks[i] === "◐" ? "restricted" : "deny"]),
    ) as Row["allow"];
    rows.push({ row: Number(cells[1]), permission: cells[2].replace(/`/g, ""), allow, test: cells[14] });
  }
  return rows;
}

const matrix = parseMatrix();

describe("TC-RBAC-001 permission matrix drift", () => {
  it("parses all 56 rows of the security.md matrix", () => {
    expect(matrix).toHaveLength(56);
    expect(matrix.map((r) => r.row)).toEqual(Array.from({ length: 56 }, (_, i) => i + 1));
  });

  it("the committed fixture equals the security.md matrix", () => {
    if (process.env.UPDATE_RBAC_FIXTURE === "1") writeFileSync(fixturePath, `${JSON.stringify(matrix, null, 2)}\n`);
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Row[];
    expect(fixture).toEqual(matrix);
  });

  it("every matrix permission exists in PERMISSIONS and every code in PERMISSIONS is in the matrix", () => {
    const codes = matrix.map((r) => r.permission).sort();
    expect([...PERMISSIONS].sort()).toEqual(codes);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("each role's grants equal the matrix (✅ and ◐ granted; ◐ restrictions enforced in services)", () => {
    for (const row of matrix) {
      for (const role of ROLES) {
        const granted =
          role === "SUPER_ADMIN"
            ? (PLATFORM_ROLE_PERMISSIONS.SUPER_ADMIN as readonly string[]).includes(row.permission)
            : (TENANT_ROLE_PERMISSIONS[role] as readonly string[]).includes(row.permission);
        expect(granted, `${role} × ${row.permission} (row ${row.row})`).toBe(row.allow[role] !== "deny");
      }
    }
  });

  it("platform and tenant permission lists partition the catalogue", () => {
    const platformRows = matrix.filter((r) => r.permission.startsWith("platform:")).map((r) => r.permission);
    expect([...PLATFORM_PERMISSIONS].sort()).toEqual(platformRows.sort());
    expect(TENANT_PERMISSIONS.every((p) => !p.startsWith("platform:"))).toBe(true);
  });
});
