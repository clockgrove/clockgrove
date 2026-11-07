import { defineConfig } from "vitest/config";

// pnpm test:long-run: long-horizon simulations that the qualification workflow runs, not per-PR CI.
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    expect: { poll: { timeout: 30_000 } },
    environment: "node",
    include: ["test/**/*.long-run.test.ts"],
  },
});
