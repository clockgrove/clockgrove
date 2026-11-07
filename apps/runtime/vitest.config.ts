import { defineConfig } from "vitest/config";

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
    include: ["test/**/*.test.ts"],
    exclude: ["test/**/*.postgres.test.ts", "test/**/*.long-run.test.ts"],
  },
});
