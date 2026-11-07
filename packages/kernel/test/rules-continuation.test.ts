import type { CommandId } from "@clockgrove/contracts";
import { describe, expect, it } from "vitest";
import { canonicalSerialize } from "../src/canonical.js";
import { createDeterministicIdSource } from "../src/deterministic-id.js";
import { evaluateRules } from "../src/index.js";
import { simulationTimeMs } from "../src/time.js";
import { executeWorldKernel, type WorldCommand, type WorldKernelInput } from "../src/world.js";
import { fractionalScenario, scenarioInput } from "./weather-needs.scenario.js";

// biome-ignore lint: fixture data is built from plain objects
type Loose = Record<string, any>;

const CATALOG = [{ type: "world.notify", version: 1 }];
const canon = (value: unknown) => canonicalSerialize(value);

function rule(id: string, trigger: Loose, payload: Loose, budget: Loose = {}): Loose {
  return {
    schemaVersion: 1,
    id,
    version: 1,
    trigger,
    bindings: [],
    condition: null,
    intents: [{ commandType: "world.notify", commandVersion: 1, payload }],
    budget: { maxFanout: 64, maxDepth: 4, cooldownMs: 0n, ...budget },
  };
}

const selected = { kind: "event", eventType: "routine.selected", eventVersion: 1 };
const who = { op: "field", name: "objectId", type: "string" };
const at = { op: "variable", name: "at" };
const RULES = [
  rule("test.selected", selected, { who, at }),
  // The split group has two actors, so a maxFanout of 1 is exceeded at every decision time.
  rule("test.fan", selected, { who }, { maxFanout: 1 }),
  rule("test.cool", selected, { who }, { cooldownMs: 10n }),
  rule("test.sched", { kind: "schedule", everyMs: 7n, offsetMs: 0n }, { at }),
  rule("test.sched5", { kind: "schedule", everyMs: 5n, offsetMs: 0n }, { at }),
];

interface Call {
  readonly complete: boolean;
  readonly transition: {
    readonly from: bigint;
    readonly to: bigint;
    readonly before: unknown;
    readonly after: unknown;
    readonly events: readonly Loose[];
  };
}

/** Drives world.advance commands (one per target) to completion, keeping each call's own transition. */
async function advanceAll(
  targets: bigint[],
  maxInputs: number,
  maxEvents: number,
): Promise<Call[]> {
  // Light rain: both residents select a routine at 0 and change it once later, so the selection events
  // come in same-time pairs at two times (an unchanged decision journals nothing).
  const first = await scenarioInput(fractionalScenario(), 2000, maxInputs, {}, maxEvents);
  const weather = executeWorldKernel(first, { mode: "test" });
  if (!weather.ok || first.input.kind !== "command") throw new Error("weather setup failed");
  const origin = first.input.command;
  let state = weather.result.state;
  let schedules = weather.result.schedules;
  let randomState = first.randomState;
  const calls: Call[] = [];
  for (const [k, target] of targets.entries()) {
    const command = {
      ...origin,
      commandId: `continuation:advance:${k}` as CommandId,
      type: "world.advance",
      expected: { partitionRevision: state.revision },
      payload: { schemaVersion: 1, targetTime: simulationTimeMs(target), maxInputs, maxEvents },
    } as WorldCommand;
    let input: WorldKernelInput = {
      ...first,
      partition: { ...first.partition, revision: state.revision, state },
      simulationTime: state.simulationTime,
      input: { kind: "command", command },
      schedules,
      randomState,
      ids: createDeterministicIdSource({
        commandId: command.commandId,
        eventIndex: 0,
        randomStream: "routine",
      }),
    };
    for (let attempt = 0; ; attempt += 1) {
      if (attempt >= 64) throw new Error("continuation chain exceeded 64 calls");
      const executed = executeWorldKernel(input, { mode: "test" });
      if (!executed.ok) throw new Error(executed.error.code);
      const result = executed.result;
      calls.push({
        complete: result.complete,
        transition: {
          from: input.partition.state.simulationTime,
          to: result.state.simulationTime,
          before: input.partition.state,
          after: result.state,
          events: result.events,
        },
      });
      state = result.state;
      schedules = result.schedules;
      randomState = result.updatedRandomState;
      if (result.complete) break;
      if (result.continuation === undefined)
        throw new Error("incomplete execution omitted continuation");
      input = {
        ...input,
        partition: { ...input.partition, revision: result.state.revision, state: result.state },
        simulationTime: result.state.simulationTime,
        schedules: result.schedules,
        randomState: result.updatedRandomState,
        continuation: result.continuation,
      };
    }
  }
  return calls;
}

function evaluateCalls(calls: Call[], holdIncomplete: boolean) {
  let cooldowns: unknown[] = [];
  let heldGroup: unknown;
  const intents: Loose[] = [];
  const trace: Loose[] = [];
  const holdFlags: unknown[] = [];
  for (const call of calls) {
    const extra: Loose = {};
    if (holdIncomplete) extra["holdEnd"] = !call.complete;
    if (heldGroup !== undefined) extra["heldGroup"] = heldGroup;
    holdFlags.push(extra["holdEnd"]);
    const outcome = evaluateRules({
      rules: RULES,
      catalog: CATALOG,
      transition: call.transition,
      cooldowns,
      depth: 0,
      ...extra,
    }) as Loose;
    if (!outcome["ok"]) throw new Error(`refused ${JSON.stringify(outcome["error"])}`);
    const result = outcome["result"];
    expect(result["complete"]).toBe(true);
    cooldowns = result["cooldowns"];
    heldGroup = result["heldGroup"];
    intents.push(...result["intents"]);
    trace.push(...result["trace"]);
  }
  return { intents, trace, cooldowns: cooldowns as Loose[], holdFlags };
}

const forRule = (list: Loose[], ruleId: string) => list.filter((e) => e["ruleId"] === ruleId);
const TARGET = 60n;

describe("evaluateRules over world.advance continuation chains", () => {
  it("splits a same-time group across calls and matches the uninterrupted run", async () => {
    const chain = await advanceAll([TARGET], 1, 32);
    const whole = await advanceAll([TARGET], 1024, 4096);
    expect(whole).toHaveLength(1);
    expect(whole[0]!.complete).toBe(true);
    expect(chain.length).toBeGreaterThan(2);
    expect(chain.at(-1)!.complete).toBe(true);
    expect(chain.slice(0, -1).every((c) => !c.complete)).toBe(true);

    // Some continuation call holds an event at its own `from` that the previous call also emitted at.
    const split = chain.some(
      (call, i) =>
        i > 0 &&
        call.transition.events.some((e) => e["simulationTime"] === call.transition.from) &&
        chain[i - 1]!.transition.events.some((e) => e["simulationTime"] === call.transition.from),
    );
    expect(split).toBe(true);
    expect(chain.at(-1)!.transition.to).toBe(whole[0]!.transition.to);

    const held = evaluateCalls(chain, true);
    const single = evaluateCalls(whole, false);
    expect(held.holdFlags).toEqual(chain.map((c) => !c.complete));
    expect(single.intents.length).toBeGreaterThan(10);
    expect(canon(held.intents)).toBe(canon(single.intents));
    expect(canon(held.trace)).toBe(canon(single.trace));
    expect(canon(held.cooldowns)).toBe(canon(single.cooldowns));

    // Non-vacuity: the fanout and cooldown rules fire their budgets on the split groups.
    for (const ruleId of ["test.fan", "test.cool"]) {
      expect(canon(forRule(held.trace, ruleId))).toBe(canon(forRule(single.trace, ruleId)));
    }
    expect(forRule(held.trace, "test.fan").some((t) => t["outcome"] === "fanout-exceeded")).toBe(
      true,
    );
    expect(forRule(held.trace, "test.fan").every((t) => t["outcome"] === "fanout-exceeded")).toBe(
      true,
    );
    expect(forRule(held.trace, "test.cool").some((t) => t["outcome"] === "cooldown")).toBe(true);
    expect(forRule(held.trace, "test.sched").length).toBeGreaterThan(0);
    expect(canon(held.cooldowns)).toBe(canon(single.cooldowns));
  });
});
