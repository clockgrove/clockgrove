import { describe, expect, it } from "vitest";
import { SMALL_PACKS } from "../conformance/pack-source.js";
import { committedScenarios, expectCommittedScenariosMatch } from "./committed-scenarios.js";

// Long-run suite (pnpm test:long-run): the committed scenarios of the packs that scenario.test.ts
// leaves out, through the same `simulate scenario` CLI path.
describe("simulate scenario through the executable", () => {
  it("runs every committed scenario of the remaining packs in Node, matching its golden, without touching worlds/", async () => {
    const scenarios = (await committedScenarios()).filter(
      ({ pack }) => !SMALL_PACKS.includes(pack),
    );
    expect(scenarios.length).toBeGreaterThan(0);
    await expectCommittedScenariosMatch(scenarios);
  });
});
