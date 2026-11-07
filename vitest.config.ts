import { defineConfig } from "vitest/config";

// `pnpm test:replay` runs tests/replay from the root without --config, so this file is its config;
// without it the run would keep Vitest's 5 s default timeout.
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    expect: { poll: { timeout: 30_000 } },
    environment: "node",
  },
});
