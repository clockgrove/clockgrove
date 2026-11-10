import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Matches the operator runner's ten-minute bound for provisioning and eighteen decisions.
    testTimeout: 600_000,
    hookTimeout: 30_000,
    expect: { poll: { timeout: 30_000 } },
    environment: "node",
    include: ["scripts/moderation-shadow-report.session.mjs"],
    reporters: ["dot"],
  },
});
