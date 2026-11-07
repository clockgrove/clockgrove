import { describe, expect, it } from "vitest";
import { canonicalSerialize } from "../src/canonical.js";
import { createScheduleQueue } from "../src/scheduler.js";
import {
  assertEngineOk,
  baselineRequest,
  chain,
  differentialPairs,
  exactItem,
  fixtureRegistry,
  makeRequest,
  mergeRun,
  SCHEDULER_PAIR_NAMES,
  single,
} from "./scheduler.scenario.js";

const registry = fixtureRegistry();
const canon = (value: unknown) => canonicalSerialize(value);

describe("catch-up differential pairs", () => {
  it("proves every pinned pair equal", () => {
    const pairs = differentialPairs(registry);
    expect(pairs.map((pair) => pair.name)).toEqual([...SCHEDULER_PAIR_NAMES]);
    for (const pair of pairs) expect(canon(pair.left), pair.name).toBe(canon(pair.right));
  });

  it("matches a single unbounded call when chaining with a small budget", () => {
    expect(canon(mergeRun(chain(registry, baselineRequest(), 2)))).toBe(
      canon(single(registry, baselineRequest())),
    );
  });

  // Scheduler scale (plan §9.1 Performance): 8192 exact schedules due over 8 s, drained in calls of
  // 1024 inputs, the kernel's per-call maximum (world.ts maxInputs); decision: 8 x 1024 schedules.
  // The expected counts follow from that arithmetic, not from a measured run or the host's speed.
  it("drains a declared large queue in bounded kernel calls, chunks and queue size", () => {
    const items = [...Array(8192).keys()].map((i) => exactItem(`s${i}`, 1000 * (1 + (i % 8))));
    const first = makeRequest({ queue: createScheduleQueue(items), target: 8000n, systems: [] });
    const run = chain(registry, first, 1024);
    const results = run.outcomes.map(assertEngineOk);
    const highWater = Math.max(...run.requests.map((request) => (request.queue as []).length));
    const kernelCalls = results.reduce((sum, result) => sum + result.dispatched.length, 0);
    // Kernel calls, continuation chunks, queue high-water mark and items left.
    const counts = [kernelCalls, results.length, highWater, results.at(-1)!.remaining.length];
    expect(counts.join()).toBe("8192,8,8192,0");
  });
});
