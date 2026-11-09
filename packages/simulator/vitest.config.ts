import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Full reference-fixture runs in workerd and through the CLI run via vitest.long-run.config.ts.
    exclude: [...configDefaults.exclude, "test/**/*.long-run.test.ts"],
    // The conformance suite starts actual workerd (Wrangler bundling plus Miniflare) per pack.
    testTimeout: 240000,
    hookTimeout: 240000,
    expect: { poll: { timeout: 30_000 } },
  },
});
