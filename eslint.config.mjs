import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";

// S1-P01-T003 — lint rules that protect tenant isolation, security and money correctness.
// Rationale for each rule: knowledge/implementation/slice-01/security.md §5 (SC-VAL-03, SC-VAL-05, SC-VAL-06, SC-TEN-03)
// and knowledge/decisions/RASOIOS-ADR-010.md §1 (no floating-point money).

const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) });

const restrictedSyntax = [
  {
    selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
    message: "dangerouslySetInnerHTML is banned (SC-VAL-03). Use the escaped JSON-LD serializer in lib/seo/json-ld.tsx.",
  },
  {
    selector: "Property[key.name='dangerouslySetInnerHTML']",
    message: "dangerouslySetInnerHTML is banned (SC-VAL-03).",
  },
  {
    selector: "MemberExpression[property.name=/^\\$(queryRawUnsafe|executeRawUnsafe)$/]",
    message: "Unsafe raw SQL is banned (SC-VAL-05). Use tagged $queryRaw inside lib/data.",
  },
  {
    selector: "CallExpression[callee.name='parseFloat']",
    message: "parseFloat is banned: money must use Prisma.Decimal / lib/money (ADR-010).",
  },
  {
    selector: "CallExpression[callee.property.name='toNumber']",
    message: "Decimal#toNumber() is banned: keep money as Decimal or decimal strings (ADR-010).",
  },
  {
    selector: "NewExpression[callee.name='Function']",
    message: "new Function() is banned.",
  },
];

const securityAndMoneyRules = {
  "no-restricted-syntax": ["error", ...restrictedSyntax],
  "no-restricted-imports": [
    "error",
    {
      paths: [
        { name: "child_process", message: "No shell execution from application code (SC-VAL-06)." },
        { name: "node:child_process", message: "No shell execution from application code (SC-VAL-06)." },
        { name: "@/lib/db/prisma", message: "Tenant data is accessed only through lib/data (ADR-008, SC-TEN-03)." },
      ],
    },
  ],
};

const eslintConfig = [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "coverage/**",
      "playwright-report/**",
      "test-results/**",
      "next-env.d.ts",
      "tsconfig.tsbuildinfo",
      "public/sw.js",
      ".local/**",
      // Generated print-agent bundle (npm run agent:build).
      "print-agent/dist/**",
      ".next-stale-*/**",
    ],
  },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  { rules: securityAndMoneyRules },
  {
    // The only sanctioned Prisma entry points (ADR-008) and tooling.
    files: ["lib/data/**", "lib/db/**", "prisma/**", "tests/**", "scripts/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "child_process", message: "No shell execution from application code (SC-VAL-06)." },
            { name: "node:child_process", message: "No shell execution from application code (SC-VAL-06)." },
          ],
        },
      ],
    },
  },
  {
    // ImageResponse renders JSX to PNG; next/image cannot run there. (A file-level rule instead of an inline directive,
    // which is reported as "unused" in environments where the rule does not fire.)
    files: ["app/**/opengraph-image.tsx"],
    rules: { "@next/next/no-img-element": "off" },
  },
  {
    // The integration harness runs the real `prisma migrate deploy` and issues CREATE/DROP DATABASE DDL.
    // Test infrastructure only: never imported by application code (S1-P02-T008).
    files: ["tests/integration/setup/**"],
    rules: { "no-restricted-imports": "off" },
  },
  {
    // Windows packaging of the print agent (print-agent-windows.md): a build tool that runs the C# compiler, postject and
    // NSIS on the build machine. Never bundled into the app or the agent.
    files: ["print-agent/packaging/windows/build-windows.mjs"],
    rules: { "no-restricted-imports": "off" },
  },
  {
    // Tests may mock and inspect freely.
    files: ["tests/**"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      // Playwright fixtures call a parameter named `use`, which is not a React hook.
      "react-hooks/rules-of-hooks": "off",
    },
  },
  {
    // BASELINE EXCEPTION — files that still import Prisma directly (baseline-audit.md BA-07…BA-13). The S1-P04-T007
    // retrofit moved every other file onto lib/data; `lib/services/printing.ts` left this list with its S1-P16
    // rebuild, and social leaves with S1-P20. Do NOT add new files here: new code must use lib/data.
    files: ["lib/services/social.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "child_process", message: "No shell execution from application code (SC-VAL-06)." },
            { name: "node:child_process", message: "No shell execution from application code (SC-VAL-06)." },
          ],
        },
      ],
    },
  },
  {
    // BASELINE EXCEPTION — client pages at commit 18941a9 that use `any`, float money parsing (BA-24) and
    // non-memoised polling effects. Each file is rebuilt by its feature task and must then leave this list:
    // billing → S1-P18, customers → S1-P13, social → S1-P20, analytics → S1-P19.
    // `app/restaurant/printing/page.tsx` left the list with S1-P16-T006.
    // `app/restaurant/menu/page.tsx` left the list with S1-P10-T006 and `app/restaurant/orders/page.tsx` with
    // S1-P12-T008.
    files: [
      "app/restaurant/analytics/page.tsx",
      "app/restaurant/billing/page.tsx",
      "app/restaurant/customers/page.tsx",
      "app/restaurant/social/page.tsx",
    ],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "react-hooks/exhaustive-deps": "off",
      "no-restricted-syntax": [
        "error",
        ...restrictedSyntax.filter((r) => !r.selector.includes("parseFloat")),
      ],
    },
  },
];

export default eslintConfig;
