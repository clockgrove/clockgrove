import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Matches the evaluation runner's thirty-minute bound.
    testTimeout: 1_800_000,
    hookTimeout: 30_000,
    expect: { poll: { timeout: 30_000 } },
    environment: "node",
    include: ["scripts/wake-triage-eval.session.mjs"],
    reporters: ["dot"],
  },
});
