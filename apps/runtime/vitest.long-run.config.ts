import { defineConfig } from "vitest/config";

// pnpm test:long-run: the Journal parity of every committed Wave 1 scenario, the 30-day long runs
// and the raccoons one-year run against real PostgreSQL. The qualification workflow runs it, not
// per-PR CI. The files run in parallel, each on disposable PostgreSQL clusters of its own; the
// global setup joins their results into the Wave 2 evidence. The Wave 3 load curves run alone,
// under vitest.load-curves.config.ts.
export default defineConfig({
  root: import.meta.dirname,
  resolve: {
    alias: {
      "cloudflare:workers": `${import.meta.dirname}/test/cloudflare-native-fake.ts`,
      "cloudflare:workflows": `${import.meta.dirname}/test/cloudflare-native-fake.ts`,
      // The Agents SDK needs the Workers runtime; node-side tests never run its owner.
      agents: `${import.meta.dirname}/test/cloudflare-native-fake.ts`,
    },
  },
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    expect: { poll: { timeout: 30_000 } },
    environment: "node",
    include: ["test/**/*.long-run.test.ts"],
    exclude: ["test/load-curves.long-run.test.ts"],
    globalSetup: ["test/journal-long-runs.ts"],
  },
});
