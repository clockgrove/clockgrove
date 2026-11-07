import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@clockgrove/contracts/trusted": new URL("../contracts/src/trusted.ts", import.meta.url)
        .pathname,
      "@clockgrove/contracts": new URL("../contracts/src/index.ts", import.meta.url).pathname,
      "@clockgrove/application": new URL("../application/src/index.ts", import.meta.url).pathname,
    },
  },
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    expect: { poll: { timeout: 30_000 } },
    environment: "node",
    include: [
      "test/**/*.test.ts",
      "test/**/*.test.mjs",
      "../../tests/infra/**/*.test.ts",
      "../../tests/infra/**/*.test.mjs",
      "../../tests/ci/regressions.test.mjs",
      "../../tests/ci/qualify-wave1-long-runs.test.mjs",
      "../../tests/ci/qualify-wave1.test.mjs",
      "../../tests/ci/qualify-wave2.test.mjs",
      "../../tests/ci/qualify-wave3.test.mjs",
      "../../tests/ci/scene-evidence.test.mjs",
    ],
  },
});
