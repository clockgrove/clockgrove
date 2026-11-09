import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The operator runner bounds its provisioning, simulated day and seven turns to ten minutes.
    testTimeout: 600_000,
    hookTimeout: 30_000,
    expect: { poll: { timeout: 30_000 } },
    environment: "node",
    include: ["scripts/wake-triage-report.session.mjs"],
    reporters: ["dot"],
  },
});
