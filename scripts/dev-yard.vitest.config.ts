import { defineConfig } from "vitest/config";

// The session of `pnpm dev:yard` (scripts/dev-yard.mjs) is interactive, not a test. Vitest runs it
// only because the browser-journey harness it reuses is TypeScript and asserts with Vitest's
// `expect`. One session lasts at most 4 hours (issue 1002 decision: covers a pilot session; restart for
// more) or CLOCKGROVE_DEV_YARD_HOURS, plus the harness's own 60 s parent margin and 60 s for teardown.
export default defineConfig({
  test: {
    testTimeout: Number(process.env.CLOCKGROVE_DEV_YARD_HOURS ?? 4) * 60 * 60_000 + 120_000,
    hookTimeout: 30_000,
    expect: { poll: { timeout: 30_000 } },
    environment: "node",
    include: ["scripts/dev-yard.session.mjs"],
    disableConsoleIntercept: true,
    reporters: ["dot"],
  },
});
