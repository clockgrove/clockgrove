import { describe, expect, it } from "vitest";
import { canonicalSerialize } from "../src/canonical.js";
import { drawNamedRandomStream } from "../src/random.js";
import { executeWorldKernel } from "../src/world.js";
import {
  eventsOf,
  HOUSEHOLD_HORIZON,
  HOUSEHOLD_SPEC,
  type LifeRun,
  lifeChain,
  lifecycleStreamHash,
  lifePairHash,
  lifeWorld,
  payloadOf,
} from "./lifecycle.scenario.js";

const TEST = { mode: "test" } as const;

/** A stopped call that moved the lifecycle stream, and the real continuation input after it. */
async function movedFixture() {
  const world = await lifeWorld(HOUSEHOLD_SPEC);
  const run = lifeChain(world, "ident", HOUSEHOLD_HORIZON, 8, 32);
  const index = run.calls.findIndex(
    (call) =>
      call.outcome.ok &&
      !call.outcome.result.complete &&
      canonicalSerialize(call.outcome.result.updatedRandomState.lifecycle) !==
        canonicalSerialize(call.input.randomState.lifecycle),
  );
  expect(index).toBeGreaterThanOrEqual(0);
  return { stopped: run.calls[index]!, next: run.calls[index + 1]!.input };
}

function expectContinuationRefused(outcome: ReturnType<typeof executeWorldKernel>) {
  expect(outcome.ok).toBe(false);
  if (!outcome.ok)
    expect(outcome.error).toMatchObject({ code: "invalid-input", path: "continuation" });
}

describe("bounded continuation", () => {
  it("refuses a continuation whose lifecycle stream was re-rolled or drawn ahead", async () => {
    const { stopped, next } = await movedFixture();
    const preCall = stopped.input.randomState.lifecycle;
    expect(preCall).toBeDefined();
    expectContinuationRefused(
      executeWorldKernel(
        { ...next, randomState: { ...next.randomState, lifecycle: preCall! } },
        TEST,
      ),
    );
    const ahead = drawNamedRandomStream(next.randomState, "lifecycle").randomState;
    expectContinuationRefused(executeWorldKernel({ ...next, randomState: ahead }, TEST));
    expect(executeWorldKernel(next, TEST).ok).toBe(true);
  });

  it("chains under a tight budget to the single unbounded call, with each child born once", async () => {
    const world = await lifeWorld(HOUSEHOLD_SPEC);
    const single = lifeChain(world, "household", HOUSEHOLD_HORIZON);
    const chained = lifeChain(world, "household", HOUSEHOLD_HORIZON, 8, 32);
    const stopped = (run: LifeRun) =>
      run.calls.filter((call) => call.outcome.ok && !call.outcome.result.complete);
    expect(stopped(chained).length).toBeGreaterThan(0);
    expect(await lifePairHash(chained)).toBe(await lifePairHash(single));
    expect(await lifecycleStreamHash(chained)).toBe(await lifecycleStreamHash(single));
    const ids = eventsOf(chained.events, "lifecycle.born").map(
      (event) => payloadOf(event).childId as string,
    );
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
