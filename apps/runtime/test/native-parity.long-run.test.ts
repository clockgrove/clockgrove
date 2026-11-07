import { describe, expect, it } from "vitest";
import { SCENARIOS } from "./journal-long-runs.js";
import {
  isNativeWorldOwnerChild,
  runNativeWorldOwnerProcess,
  withNativeWorldOwner,
} from "./world-owner/native-harness.js";
import { nativeScenarioParity, reportNativeParity } from "./world-owner/native-parity.js";

// pnpm test:long-run (qualification, not per-PR CI): every committed Wave 1 scenario and variant of
// both packs, and each pack's 30-day long run, through the native owner, one bounded native process
// per pack, the two in parallel. The per-PR subset is
// native-parity.postgres.test.ts.

const FILE = "apps/runtime/test/native-parity.long-run.test.ts";
const PACKS = [...new Set(SCENARIOS.map(([pack]) => pack))];

describe.concurrent("Wave 1 scenarios through the native owner match the pure simulator (long run)", () => {
  for (const pack of PACKS)
    it.skipIf(isNativeWorldOwnerChild())(
      `runs every ${pack} scenario natively`,
      async () => {
        await runNativeWorldOwnerProcess(FILE, pack, {
          vitestConfig: "apps/runtime/vitest.long-run.config.ts",
          timeoutMs: 1_200_000,
        });
      },
      1_320_000,
    );

  it.skipIf(!isNativeWorldOwnerChild())(
    "matches every golden run",
    async () => {
      await withNativeWorldOwner(async (owner) => {
        const scenarios = SCENARIOS.filter(([pack]) => pack === owner.packName);
        const runs = [];
        for (const [, scenario] of scenarios)
          runs.push(...(await nativeScenarioParity(owner, scenario)));
        expect(new Set(runs.map((run) => run.scenario)).size).toBe(scenarios.length);
        // The 30-day run is the one that chains continuation chunks (fixture pack).
        runs.push(...(await nativeScenarioParity(owner, "long-run-30-days", "long-runs")));
        expect(reportNativeParity(runs)).toEqual([]);
      });
    },
    1_200_000,
  );
});
