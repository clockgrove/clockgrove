import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    expect: { poll: { timeout: 30_000 } },
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Long-horizon simulations run through vitest.long-run.config.ts (pnpm test:long-run).
    exclude: [...configDefaults.exclude, "test/**/*.long-run.test.ts"],
  },
});
