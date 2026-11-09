import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import testkitConfig from "../../packages/testkit/vitest.config.ts";

it("keeps hosted scene qualification pending independently of local native checks", async () => {
  const manifest = JSON.parse(
    await readFile(
      new URL("../../docs/waves/clockgrove-wave-4-runtime-evidence.json", import.meta.url),
      "utf8",
    ),
  );
  expect(manifest).toEqual({
    kind: "clockgrove.wave4-runtime-evidence",
    scope: "partial-scene-runtime",
    exitDecision: "not-qualified",
    localNative: {
      environment: "local-workerd-postgresql",
      source: "apps/runtime/test/scene-delivery.postgres.test.ts",
      hostedQualification: false,
    },
    cloudflareQualification: [
      "real-cloudflare-hibernation",
      "real-cloudflare-restart",
      "real-cloudflare-redeploy",
    ].map((scenario) => ({
      scenario,
      status: "pending",
      ownerIssue: 3,
      blockedOn: [1, 2],
      evidence: null,
    })),
  });
  expect(testkitConfig.test.include).toContain("../../tests/ci/scene-evidence.test.mjs");
});
