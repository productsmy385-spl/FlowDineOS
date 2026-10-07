import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// TC-AUTH-013 — every exported Server Action, Route Handler and protected page calls a guard FIRST, or is on the
// reviewed allow-list with a justification (S1-P04-T002, SC-AUTH-04, SC-RBAC-01).
const root = path.resolve(__dirname, "../..");

const GUARDS = new Set(["requireTenant", "requirePlatform", "requireTenantPage", "requirePlatformPage", "requireSessionUser", "requireAgent"]);

/** Entry points that authenticate differently or are public by design. Each needs a reason. */
const ALLOW_LIST: Record<string, string> = {
  "app/api/webhooks/clerk/route.ts#POST": "Clerk webhook: Svix signature over the raw body + rate limit (RH-AUTH-01, ADR-011 §5)",
  "app/api/v1/print-agent/pair/route.ts#POST":
    "Print-agent pairing (RH-AGT-01, ADR-007 §1): the single-use pairing code IS the credential — there is no token yet — so the handler starts with the fail-closed `agent.pair` rate limit and the tenant comes from the PRINT_AGENT row the code hash resolves to",
  "app/r/[slug]/page.tsx#default": "Public website: published data only, selected by slug (SC-PUB-01)",
  "app/r/[slug]/daily/page.tsx#default": "Public website: today's published daily menu only, selected by slug (SC-PUB-01, LD-PUB-02)",
  "app/page.tsx#default": "Public landing page (no data)",
  "app/privacy/page.tsx#default": "Public Privacy Policy (static text, no data)",
  "app/terms/page.tsx#default": "Public Terms (static text, no data)",
  "app/book-demo/page.tsx#default": "Public Book-a-demo page (renders the form only, no data)",
  "app/book-demo/actions.ts#requestDemoAction":
    "Book a demo (RASOIOS-ADR-024): a visitor has no account; the action can only create a request — never read one — and the service checks a spam trap and fail-closed per-email/per-address rate limits before writing",
  "app/api/health/route.ts#GET": "Liveness probe for Railway/uptime monitors: static body, no data (RH-OPS-01)",
  "app/api/ready/route.ts#GET": "Readiness probe: SELECT 1 only, returns ready/unavailable without detail (RH-OPS-02)",
  "app/account/no-access/page.tsx#default": "Account state page: renders no tenant data",
  "app/account/forbidden/page.tsx#default": "Account state page: renders no tenant data",
  "app/account/suspended/page.tsx#default": "Account state page: resolves its own session state, renders no tenant data",
  "app/account/select-tenant/page.tsx#default": "Resolves the session itself and lists only the caller's own memberships",
  "app/staff-login/actions.ts#staffLoginAction":
    "Staff daily-password sign-in (RASOIOS-ADR-019 §2): the password IS the credential — there is no session yet — so the action starts with two fail-closed rate limits, and the tenant comes from whichever credential the password verifies against, never from the caller",
  "app/staff-login/actions.ts#staffSignOutAction":
    "Staff sign-out companion (ADR-019 §4): ends the session its own cookie names and deletes that cookie; reads and returns nothing, and must still work when the session has already been revoked",
  "app/sign-in/actions.ts#clearActiveTenantCookieAction":
    "Sign-out companion (SC-SESS-03): deletes the caller's own rasoi_active_membership preference cookie, reads and returns nothing; must also run after sign-out",
};

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const rel = (file: string) => path.relative(root, file).split(path.sep).join("/");
const appFiles = walk(path.join(root, "app")).map(rel);

type Entry = { file: string; name: string; body: ts.Node | undefined; kind: "action" | "route" | "page" | "layout" };

function isAsyncFn(node: ts.Node): node is ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration {
  return (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) && Boolean(node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword));
}

/** For `action(async () => …)` / `route(async () => …)` wrappers, the inner function is what runs. */
function unwrap(expr: ts.Expression | undefined): ts.Node | undefined {
  if (!expr) return undefined;
  if (ts.isCallExpression(expr)) {
    const inner = expr.arguments.find((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a));
    return inner;
  }
  return expr;
}

function firstStatementCallsGuard(fn: ts.Node | undefined): boolean {
  if (!fn || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn) || ts.isFunctionDeclaration(fn))) return false;
  const body = fn.body;
  if (!body) return false;
  const first: ts.Node | undefined = ts.isBlock(body) ? body.statements[0] : body;
  if (!first) return false;
  let found = false;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (ts.isAwaitExpression(node) && ts.isCallExpression(node.expression) && ts.isIdentifier(node.expression.expression) && GUARDS.has(node.expression.expression.text)) {
      found = true;
      return;
    }
    // Do not look inside nested functions.
    if (node !== fn && (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node))) return;
    ts.forEachChild(node, visit);
  };
  visit(first);
  return found;
}

function entriesOf(file: string): Entry[] {
  const code = readFileSync(path.join(root, file), "utf8");
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const useServer = source.statements.some((s) => ts.isExpressionStatement(s) && ts.isStringLiteral(s.expression) && s.expression.text === "use server");
  const useClient = source.statements.some((s) => ts.isExpressionStatement(s) && ts.isStringLiteral(s.expression) && s.expression.text === "use client");
  const base = path.basename(file);
  const kind: Entry["kind"] | null = base === "route.ts" ? "route" : base === "page.tsx" ? "page" : base === "layout.tsx" ? "layout" : useServer ? "action" : null;
  if (!kind || useClient) return [];

  const entries: Entry[] = [];
  for (const statement of source.statements) {
    const modifiers = ts.canHaveModifiers(statement) ? (ts.getModifiers(statement) ?? []) : [];
    const exported = modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) continue;
    const isDefault = modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
    if (ts.isFunctionDeclaration(statement)) {
      const name = isDefault ? "default" : (statement.name?.text ?? "default");
      if (kind === "route" && !/^(GET|POST|PUT|PATCH|DELETE)$/.test(name)) continue;
      if ((kind === "page" || kind === "layout") && name !== "default") continue;
      if (!isAsyncFn(statement) && (kind === "page" || kind === "layout")) continue; // sync components load no data
      entries.push({ file, name, body: statement, kind });
    } else if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        const name = decl.name.text;
        if (kind === "route" && !/^(GET|POST|PUT|PATCH|DELETE)$/.test(name)) continue;
        if (kind === "page" || kind === "layout") continue;
        entries.push({ file, name, body: unwrap(decl.initializer), kind });
      }
    }
  }
  return entries;
}

const candidates = appFiles.filter((f) => /(^|\/)(route\.ts|page\.tsx|layout\.tsx)$/.test(f) || /actions?\.ts$/.test(f) || /-actions\.ts$/.test(f));
const entries = candidates.flatMap(entriesOf);

function allowed(entry: Entry): boolean {
  return Boolean(ALLOW_LIST[`${entry.file}#${entry.name}`] || ALLOW_LIST[`${entry.file}#*`]);
}

describe("TC-AUTH-013 guard coverage", () => {
  it("finds the server entry points", () => {
    expect(entries.filter((e) => e.kind === "action").length).toBeGreaterThan(10);
  });

  it("every exported server action and route handler calls a guard first", () => {
    const missing = entries
      .filter((e) => e.kind === "action" || e.kind === "route")
      .filter((e) => !allowed(e) && !firstStatementCallsGuard(e.body))
      .map((e) => `${e.file}#${e.name}`);
    expect(missing).toEqual([]);
  });

  it("every async page and layout under /restaurant and /admin calls a page guard first", () => {
    const missing = entries
      .filter((e) => (e.kind === "page" || e.kind === "layout") && /^app\/(restaurant|admin)\//.test(e.file))
      .filter((e) => !allowed(e) && !firstStatementCallsGuard(e.body))
      .map((e) => `${e.file}#${e.name}`);
    expect(missing).toEqual([]);
  });

  it("allow-list entries still exist and each carries a justification", () => {
    for (const [key, reason] of Object.entries(ALLOW_LIST)) {
      expect(reason.length, key).toBeGreaterThan(20);
      expect(existsSync(path.join(root, key.split("#")[0])), key).toBe(true);
    }
  });
});
