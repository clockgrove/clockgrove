import { expect, it as vitestIt } from "vitest";
import { LONG_RUNS, longRunOf } from "./lifecycle.scenario.js";
import { LIFECYCLE_LONG_HASHES } from "./lifecycle-evidence.js";

/** Keeps failure messages short so large structural diffs never flood the report. */
export const it = (name: string, body: () => unknown, timeout?: number) =>
  vitestIt(
    name,
    async () => {
      try {
        await body();
      } catch (error) {
        const brief = new Error(String((error as Error).message).slice(0, 1200));
        brief.stack = brief.message;
        throw brief;
      }
    },
    timeout,
  );

export function longRunTests(selected: (spec: (typeof LONG_RUNS)[number]) => boolean) {
  for (const spec of LONG_RUNS.filter(selected)) {
    it(`${spec.name} keeps every invariant and the committed summary hashes`, async () => {
      const run = await longRunOf(spec.name);
      expect(run.problems).toEqual([]);
      expect(run.replayEqual).toBe(true);
      expect(run.maxLiving).toBeGreaterThan(1);
      expect(run.born).toBeGreaterThan(0);
      expect(run.died).toBeGreaterThan(0);
      expect(run.eventTotal).toBeLessThanOrEqual(run.eventBound);
      expect(run.probe.privateLeaks).toBe(0);
      expect(run.probe.lifecycleTypesPerceivable).toBe(0);
      expect(run.probe.perceivableEvents).toBeGreaterThanOrEqual(0);
      const literal = LIFECYCLE_LONG_HASHES[spec.name]!;
      if (
        run.populationHash !== literal.populationHash ||
        run.lifecycleHash !== literal.lifecycleHash ||
        run.resourceHash !== literal.resourceHash
      )
        throw new Error(
          `LONG ${spec.name} ${run.populationHash} ${run.lifecycleHash} ${run.resourceHash}`,
        );
    }, 180000);
  }
}
