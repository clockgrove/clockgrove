import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    expect: { poll: { timeout: 30_000 } },
    projects: [
      "packages/*",
      {
        test: {
          name: "infra",
          testTimeout: 30_000,
          hookTimeout: 30_000,
          expect: { poll: { timeout: 30_000 } },
          environment: "node",
          include: ["tests/infra/**/*.test.ts", "tests/infra/**/*.test.mjs"],
        },
      },
      {
        test: {
          name: "ci-controls",
          testTimeout: 30_000,
          hookTimeout: 30_000,
          expect: { poll: { timeout: 30_000 } },
          environment: "node",
          include: [
            "tests/ci/regressions.test.mjs",
            "tests/ci/qualify-wave1-long-runs.test.mjs",
            "tests/ci/qualify-wave1.test.mjs",
            "tests/ci/qualify-wave2.test.mjs",
            "tests/ci/qualify-wave3.test.mjs",
          ],
        },
      },
    ],
  },
});
