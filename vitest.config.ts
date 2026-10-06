import { defineConfig } from "vitest/config";
import path from "path";

const alias = {
  "@": path.resolve(__dirname, "./"),
  // `server-only` throws outside React Server Components; tests run server code directly in Node.
  "server-only": path.resolve(__dirname, "node_modules/server-only/empty.js"),
};

// Test layers (knowledge/implementation/slice-01/testing.md §2):
// unit — pure logic; static — repository rule checks; integration — real PostgreSQL (harness: tests/integration/setup).
export default defineConfig({
  // Tests render Server Components/pages directly; use the automatic JSX runtime (tsconfig keeps "preserve" for Next).
  // Vite 8 (Vitest 4) transforms with oxc rather than esbuild.
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    globals: true,
    environment: "node",
    alias,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["lib/**/*.ts"],
    },
    projects: [
      {
        extends: true,
        // Some unit tests import every schema/module in the app; under parallel load that is slow but not broken.
        test: { name: "unit", include: ["tests/unit/**/*.test.{ts,tsx}"], testTimeout: 60_000 },
      },
      {
        extends: true,
        // Static checks shell out to ESLint and the TypeScript compiler; give them room on a busy machine.
        test: { name: "static", include: ["tests/static/**/*.test.ts"], testTimeout: 180_000 },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          // A migrated template database per run, copied once per worker (S1-P02-T008).
          globalSetup: ["tests/integration/setup/global-setup.ts"],
          setupFiles: ["tests/integration/setup/worker-database.ts", "tests/integration/setup/clerk-boundary.ts"],
          pool: "forks",
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
