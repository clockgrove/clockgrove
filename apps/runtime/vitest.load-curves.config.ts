import { defineConfig } from "vitest/config";

// `pnpm run qualify:wave3:load-curves` (scripts/ci/qualify-wave3-load-curves.mjs): the Wave 3 load
// curves, alone on the host, so no other suite shares the CPU or PostgreSQL while they are measured.
// `pnpm test:long-run` leaves this file out for the same reason.
export default defineConfig({
  root: import.meta.dirname,
  resolve: {
    alias: {
      "cloudflare:workers": `${import.meta.dirname}/test/cloudflare-native-fake.ts`,
      "cloudflare:workflows": `${import.meta.dirname}/test/cloudflare-native-fake.ts`,
    },
  },
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    expect: { poll: { timeout: 30_000 } },
    environment: "node",
    include: ["test/load-curves.long-run.test.ts"],
  },
});
