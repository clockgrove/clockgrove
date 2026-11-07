import { defineConfig } from "vitest/config";
export default defineConfig({
  root: import.meta.dirname,
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    expect: { poll: { timeout: 30_000 } },
    environment: "node",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx", "test/**/*.test.mjs"],
  },
});
