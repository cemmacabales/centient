import { defineConfig } from "vitest/config";
import path from "node:path";

const testDbUrl =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5433/centient_test";

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = testDbUrl;
}

if (!process.env.LABELER_JWT_SECRET) {
  process.env.LABELER_JWT_SECRET = "test-labeler-jwt-secret-at-least-32-chars";
}

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  test: {
    environment: "node",
    include: ["**/__tests__/**/*.test.ts"],
    // `.claude/worktrees/*` holds git worktrees of other (often merged) branches;
    // without excluding them the glob runs duplicate stale copies of every suite.
    exclude: ["node_modules", ".next", "dist", ".claude/**"],
    pool: "forks",
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov", "json-summary"],
      include: ["lib/**/*.ts", "app/api/**/*.ts"],
      exclude: [
        "**/__tests__/**",
        "**/*.test.ts",
        "**/*.config.ts",
        "app/generated/**",
      ],
      thresholds: {
        "app/api/submit/route.ts": {
          lines: 90,
          functions: 85,
          branches: 85,
          statements: 90,
        },
        "lib/quality.ts": {
          lines: 40,
          functions: 50,
          statements: 40,
        },
        "lib/payout.ts": {
          lines: 10,
          functions: 0,
          statements: 10,
        },
        "lib/campaign-balance.ts": {
          lines: 85,
          functions: 85,
          branches: 75,
          statements: 85,
        },
      },
    },
  },
});
