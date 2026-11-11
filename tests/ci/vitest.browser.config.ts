import { defineConfig } from "vitest/config";

if (process.env.CI !== "true")
  throw new Error(
    "real browser journey requires explicit CI invocation after pinned browser installation",
  );

export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    expect: { poll: { timeout: 30_000 } },
    environment: "node",
    // The Wave 4 §15.1 browser suites: test:e2e, test:a11y, test:visual, test:realtime:load.
    include: [
      "tests/e2e/living-hall.journey.browser.test.mjs",
      "tests/e2e/arrival-truth.journey.browser.test.mjs",
      "tests/e2e/mcp-installation.journey.browser.test.mjs",
      "tests/accessibility/text-path.journey.browser.test.mjs",
      "tests/visual/golden-states.journey.browser.test.mjs",
      "tests/load/realtime/fanout.journey.browser.test.mjs",
      // pnpm dev:world: the local checkpoint command serves and tears down.
      "tests/ci/dev-world.journey.browser.test.mjs",
      // Issue 67: the renderer bake-off measurement page and script, under SwiftShader.
      "tests/ci/renderer-bakeoff.journey.browser.test.mjs",
    ],
    // Journeys run one at a time, so neither one's measured deadline shares the host with the other.
    fileParallelism: false,
  },
});
