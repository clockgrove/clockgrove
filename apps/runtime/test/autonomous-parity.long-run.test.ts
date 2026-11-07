import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../../packages/simulator/cli/repo.js";
import { SCENARIOS } from "./journal-long-runs.js";
import { scenarioDocument } from "./journal-parity.js";
import {
  AUTONOMOUS_MODES,
  autonomousScenarioParity,
  reportAutonomousParity,
} from "./world-owner/autonomous-parity.js";
import {
  isNativeWorldOwnerChild,
  runNativeWorldOwnerProcess,
  withNativeWorldOwner,
} from "./world-owner/native-harness.js";

const FILE = "apps/runtime/test/autonomous-parity.long-run.test.ts";
// Decision: 26 min per pack. The raccoons pack took 875 s in Qualification run 39604752325
// and 953 s locally once fence-gap-portal and street-dwell joined (785 s before), near the former
// 20 min; its parent test, 2 min longer, still ends before the evidence wrapper's 30 min deadline
// (scripts/ci/evidence.mjs), so an overrun names its pack.
const PACK_TIMEOUT_MS = 26 * 60_000;

describe.concurrent("autonomous native complete scenario parity", () => {
  for (const pack of [...new Set(SCENARIOS.map(([pack]) => pack))]) {
    it.skipIf(isNativeWorldOwnerChild())(
      `owns bounded ${pack} native process and disposable PostgreSQL`,
      async () => {
        await runNativeWorldOwnerProcess(FILE, pack, {
          vitestConfig: "apps/runtime/vitest.long-run.config.ts",
          timeoutMs: PACK_TIMEOUT_MS,
          inheritOutput: true,
        });
      },
      PACK_TIMEOUT_MS + 120_000,
    );
  }
  it.skipIf(!isNativeWorldOwnerChild())(
    "compares every scenario and variant in all execution modes",
    async () => {
      expect(AUTONOMOUS_MODES).toEqual([
        "headless",
        "frequent-alarms",
        "long-sleep",
        "workflow-catch-up",
        "redelivery",
        "restart",
        "replacement",
      ]);
      await withNativeWorldOwner(async (owner) => {
        for (const [, scenario] of SCENARIOS.filter(([pack]) => pack === owner.packName)) {
          const runs = await autonomousScenarioParity(owner, scenario);
          expect(reportAutonomousParity(runs)).toEqual([]);
          const { runs: variants } = await scenarioDocument(
            join(REPO_ROOT, "worlds", owner.packName, "scenarios", `${scenario}.json`),
          );
          expect(runs.map((run) => `${run.mode}:${run.run}`)).toEqual(
            AUTONOMOUS_MODES.flatMap((mode) => variants.map((run) => `${mode}:${run}`)),
          );
          expect(runs.map((run) => run.continuation)).toEqual(runs.map(() => "none"));
        }
      });
    },
    PACK_TIMEOUT_MS,
  );
});
