import { describe, expect, it } from "vitest";
import {
  isNativeWorldOwnerChild,
  runNativeWorldOwnerProcess,
  withNativeWorldOwner,
} from "./world-owner/native-harness.js";
import { nativeScenarioParity, reportNativeParity } from "./world-owner/native-parity.js";

// The per-PR native-owner parity subset: one residents scenario per command path, in one bounded
// native process. Every scenario, variant and the continuation-heavy 30-day runs are in
// native-parity.long-run.test.ts (pnpm test:long-run); the owner's continuation RPC is also
// exercised per PR by world-owner.postgres.test.ts.
const PER_PR = [
  "birth-and-parentage", // new commands, a restart step (replaced runtime, local storage lost), a variant
  "food-decay-and-conservation", // an exact retry answered from the stored receipt
];

describe("Wave 1 scenarios through the native owner match the pure simulator", () => {
  it.skipIf(isNativeWorldOwnerChild())(
    "runs the representative subset natively",
    async () => {
      await runNativeWorldOwnerProcess(
        "apps/runtime/test/native-parity.postgres.test.ts",
        "fixture/reference",
      );
    },
    210_000,
  );

  it.skipIf(!isNativeWorldOwnerChild())(
    "matches the golden for each run and rejects a mismatched final hash",
    async () => {
      await withNativeWorldOwner(async (owner) => {
        const runs = [];
        for (const scenario of PER_PR) runs.push(...(await nativeScenarioParity(owner, scenario)));
        expect(reportNativeParity(runs)).toEqual([]);
        expect(runs.map((run) => run.run)).toEqual(["main", "uninterrupted", "main"]);
        expect(runs.some((run) => run.restarts > 0) && runs.some((run) => run.retries > 0)).toBe(
          true,
        );
        // Negative control: a run whose final hash differs from the expected one is reported with its
        // pack, scenario, run and both hashes.
        const [first] = runs;
        if (first === undefined) throw new Error("no native run");
        const wrong = "0".repeat(64);
        expect(reportNativeParity([{ ...first, expected: wrong }])).toEqual([
          `fixture/reference/birth-and-parentage:main actual ${first.actual} != expected ${wrong}`,
        ]);
      });
    },
    120_000,
  );
});
