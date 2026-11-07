import { writeFile } from "node:fs/promises";
import path from "node:path";
import { WORLD_COMMAND_TIMEOUTS } from "@clockgrove/persistence";
import { afterAll, describe, expect, inject, it } from "vitest";
import {
  withDisposableDatabase,
  // @ts-expect-error -- repository-local JavaScript helper has no declaration file.
} from "../../../scripts/database/lib.mjs";
import { type FinishedRun, SCENARIOS } from "./journal-long-runs.js";
import { failedChecks, ParityCluster, type RunParity } from "./journal-parity.js";
import type { DatabaseFixture } from "./world-fixture.js";

// The journal parity long runs of one test file, through the Journal against real PostgreSQL. Each
// file runs its runs serially on clusters of its own; the files run in parallel. The global setup
// (journal-long-runs.ts) writes the evidence from every file's part.

/** A scenario's kernel budgets are its author's, so one kernel call can outlast production's bounds. */
const TIMEOUTS = {
  ...WORLD_COMMAND_TIMEOUTS,
  statementTimeoutMs: 600_000,
  idleInTransactionTimeoutMs: 600_000,
};

/**
 * The cluster's command deadline: wider than the per-PR default, since these files run in parallel
 * with the other long runs and a 4-vCPU runner can push the one-year run past five minutes.
 */
const DATABASE = { deadlineMs: 15 * 60_000 };

function report(runs: readonly RunParity[]): void {
  for (const run of runs) {
    console.log(
      `journal parity ${run.pack}/${run.scenario}:${run.run} against the ${run.reference}: ${run.passed ? "match" : `MISMATCH ${failedChecks([run]).join(",")}`} (${run.kernelCalls} kernel calls, ${run.events} events, ${run.snapshots} snapshots, ${run.suffixEvents} suffix events, kernel ${run.kernelMs} ms, journal ${run.journalMs} ms, journal p95 ${run.journalLatencyMs.p95} ms per call, replay ${run.replay.events} events in ${run.replay.ms} ms)`,
    );
  }
}

/**
 * Registers this file's journal parity tests: every committed scenario and variant when `scenarios`
 * is set, then each named long run. `part` names the file's part of the evidence.
 */
export function journalParityLongRuns(
  part: string,
  { scenarios, longRuns }: { scenarios: boolean; longRuns: readonly (readonly [string, string])[] },
): void {
  /** Every finished run of this file, by set, for the evidence. */
  const finished: FinishedRun[] = [];

  describe("Wave 1 scenarios through the Journal match the pure simulator (long run)", () => {
    afterAll(async () => {
      const parts = inject("journalLongRunParts");
      if (parts) await writeFile(path.join(parts, `${part}.json`), JSON.stringify(finished));
    });

    if (scenarios)
      it("matches the golden for every committed scenario and variant", async () => {
        await withDisposableDatabase(async (fixture: DatabaseFixture) => {
          const cluster = await ParityCluster.create(fixture, TIMEOUTS);
          const runs: RunParity[] = [];
          for (const [pack, scenario] of SCENARIOS) {
            const ran = (await cluster.scenario(pack, scenario)).runs;
            report(ran);
            runs.push(...ran);
            finished.push(...ran.map((run) => ({ set: "scenarios" as const, run })));
          }
          expect(failedChecks(runs)).toEqual([]);
          expect(new Set(runs.map((run) => run.scenario)).size).toBe(SCENARIOS.length);
        }, DATABASE);
      }, 1_200_000);

    for (const [pack, scenario] of longRuns) {
      it(`matches the pure run for ${pack} ${scenario}`, async () => {
        await withDisposableDatabase(async (fixture: DatabaseFixture) => {
          const cluster = await ParityCluster.create(fixture, TIMEOUTS);
          const { runs } = await cluster.scenario(pack, scenario, { directory: "long-runs" });
          report(runs);
          finished.push(...runs.map((run) => ({ set: "long-runs" as const, run })));
          expect(failedChecks(runs)).toEqual([]);
          expect(runs.map((run) => run.run)).toEqual(["main", "aggregate"]);
        }, DATABASE);
      }, 3_600_000);
    }
  });
}
