import { defineConfig } from "vitest/config";

// pnpm test:long-run: full committed-scenario runs that the qualification workflow runs, not per-PR CI.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.long-run.test.ts"],
    testTimeout: 240000,
    hookTimeout: 240000,
    expect: { poll: { timeout: 30_000 } },
  },
});
