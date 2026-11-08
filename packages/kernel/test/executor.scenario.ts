import type { CommandId, SimTimeMs } from "@clockgrove/contracts";
import { replayWorldEvents, validateWorldState } from "@clockgrove/domain";
import { canonicalSerialize } from "../src/canonical.js";
import { createDeterministicIdSource } from "../src/deterministic-id.js";
import { REFUSAL_CODES, type Refusal } from "../src/execute/refusal.js";
import { drawNamedRandomStream, initializeNamedRandomStreams } from "../src/random.js";
import {
  checkWorldInvariants,
  executeWorldKernel,
  type WorldCommand,
  type WorldCommandPayload,
  type WorldKernelInput,
  type WorldKernelOutcome,
  worldRegistryIdentity,
} from "../src/world.js";
import { containmentEvidence } from "./containment.scenario.js";
import { decisionsEvidence } from "./decisions.scenario.js";
import { ecologyEvidence } from "./ecology.scenario.js";
import { environmentEvidence } from "./environment.scenario.js";
import { lifecycleEvidence } from "./lifecycle.scenario.js";
import { perceptionEvidence } from "./perception.scenario.js";
import { schedulerEvidence } from "./scheduler.scenario.js";
import { spatialEvidence } from "./spatial.scenario.js";
import { runtimeEvidence, scenarioInput, scenarios, stateHash } from "./weather-needs.scenario.js";
import { wellbeingEvidence } from "./wellbeing.scenario.js";

export const fuzzSeed = { version: 1, seed: "executor-fuzz-v1" } as const;
export const fuzzStreams = ["behavior", "fuzz", "lifecycle", "weather"] as const;
export const fuzzSteps = 48;

async function safeHash(value: unknown): Promise<string> {
  try {
    return await stateHash(value);
  } catch {
    return "unencodable";
  }
}

type Loose = Record<string, any>; // biome-ignore lint: deliberately malformed inputs

function command(input: unknown): Loose | undefined {
  const stimulus = (input as Loose | null)?.input;
  return stimulus?.kind === "command" ? (stimulus.command as Loose) : undefined;
}

/** Asserts the stable, frozen, canonically encodable refusal envelope. */
export function assertEnvelope(error: Refusal): void {
  const keys = Object.keys(error).sort();
  if (
    !Object.isFrozen(error) ||
    !(REFUSAL_CODES as readonly string[]).includes(error.code) ||
    typeof error.path !== "string" ||
    !(keys.join() === "code,path" || keys.join() === "check,code,path") ||
    canonicalSerialize(error).length === 0
  )
    throw new Error("refusal is not a stable envelope");
}

async function describeExecution(label: string, input: unknown, outcome: WorldKernelOutcome) {
  const facts = command(input);
  const loose = input as Loose | null;
  const version: unknown = facts?.payload?.schemaVersion;
  const identity = {
    type: typeof facts?.type === "string" ? facts.type : null,
    version: typeof version === "number" && Number.isSafeInteger(version) ? version : null,
    commandId: typeof facts?.commandId === "string" ? facts.commandId : null,
    inputHash: await safeHash(
      loose === null || typeof loose !== "object" ? loose : { ...loose, ids: loose.ids?.seed },
    ),
    preStateHash: await safeHash(loose?.partition?.state),
    randomStateHash: await safeHash(loose?.randomState),
  };
  if (!outcome.ok) {
    assertEnvelope(outcome.error);
    return { label, input: identity, output: { kind: "refusal", ...outcome.error } };
  }
  const result = outcome.result;
  return {
    label,
    input: identity,
    output: {
      kind: "success",
      complete: result.complete,
      eventTypes: result.events.map((event) => event.type),
      eventIds: result.events.map((event) => event.eventId),
      postStateHash: await stateHash(result.state),
      randomStateHash: await stateHash(result.updatedRandomState),
    },
  };
}

type Entry = Awaited<ReturnType<typeof describeExecution>>;

/** Every success must satisfy all invariants and equal the replay of its emitted events. */
export function verifySuccess(input: WorldKernelInput, outcome: WorldKernelOutcome): void {
  if (!outcome.ok) return;
  const { result } = outcome;
  const initial = input.partition.state;
  const violated = checkWorldInvariants(initial, result.state, result.events);
  if (violated !== undefined) throw new Error("reduced state violated an invariant");
  validateWorldState(result.state);
  if (
    canonicalSerialize(replayWorldEvents(initial, result.events)) !==
    canonicalSerialize(result.state)
  )
    throw new Error("state is not the replay of the emitted events");
}

async function execute(label: string, input: unknown, entries: Entry[]) {
  let before: string | undefined;
  try {
    const loose = input as Loose;
    before = canonicalSerialize({ ...loose, ids: loose.ids.seed });
  } catch {
    before = undefined;
  }
  const outcome = executeWorldKernel(input as WorldKernelInput, { mode: "test" });
  entries.push(await describeExecution(label, input, outcome));
  if (
    before !== undefined &&
    canonicalSerialize({ ...(input as Loose), ids: (input as Loose).ids.seed }) !== before
  )
    throw new Error("executor mutated its input");
  return outcome;
}

function baseCommand(input: WorldKernelInput): WorldCommand {
  return command(input) as unknown as WorldCommand;
}

export function withCommand(
  base: WorldKernelInput,
  type: WorldCommand["type"],
  commandId: string,
  payload: Partial<WorldCommandPayload> & Record<string, unknown>,
  expected: bigint = base.partition.revision,
): WorldKernelInput {
  const origin = baseCommand(base);
  const next = {
    ...origin,
    commandId: commandId as CommandId,
    type,
    expected: { partitionRevision: expected },
    payload:
      type === "world.weather.set"
        ? { schemaVersion: 2, rainIntensity: payload.rainIntensity, ...payload }
        : { schemaVersion: 1, maxInputs: 4, maxEvents: 32, ...payload },
  } as unknown as WorldCommand;
  const { continuation: _continuation, ...rest } = base;
  return {
    ...rest,
    input: { kind: "command", command: next },
    ids: createDeterministicIdSource({
      commandId: next.commandId,
      eventIndex: 0,
      randomStream: "routine",
    }),
  };
}

/** Runs a command (resuming bounded continuations) and returns the next base input on success. */
async function drive(
  label: string,
  first: WorldKernelInput,
  entries: Entry[],
): Promise<WorldKernelInput | undefined> {
  let input = first;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const outcome = await execute(`${label}#${attempt}`, input, entries);
    if (!outcome.ok) return undefined;
    verifySuccess(input, outcome);
    const result = outcome.result;
    const next: WorldKernelInput = {
      ...input,
      partition: { ...input.partition, revision: result.state.revision, state: result.state },
      simulationTime: result.state.simulationTime,
      schedules: result.schedules,
      randomState: result.updatedRandomState,
    };
    if (result.complete) {
      const { continuation: _continuation, ...rest } = next;
      return rest;
    }
    if (result.continuation === undefined) throw new Error("continuation required");
    input = { ...next, continuation: result.continuation };
  }
  throw new Error("continuation exceeded 16 calls");
}

async function golden(name: string, sample: unknown, entries: Entry[]) {
  const first = await scenarioInput(sample, 10000, 1);
  const afterWeather = await drive(`golden:${name}:weather`, first, entries);
  if (afterWeather === undefined) throw new Error("golden weather command refused");
  const done = await drive(
    `golden:${name}:advance`,
    withCommand(afterWeather, "world.advance", `golden:${name}:advance`, {
      targetTime: 180000n as SimTimeMs,
      maxInputs: 1,
    }),
    entries,
  );
  if (done === undefined) throw new Error("golden advance command refused");
}

/** Deterministic fuzzed valid/invalid command sequence driven only by named random streams. */
async function fuzz(entries: Entry[], steps: number) {
  let driver = initializeNamedRandomStreams(fuzzSeed, fuzzStreams);
  const next = (): number => {
    const draw = drawNamedRandomStream(driver, "fuzz");
    driver = draw.randomState;
    return Number(draw.draw.rawValue + 2147483648n);
  };
  let current = await scenarioInput(
    scenarios.weather,
    10000,
    4,
    initializeNamedRandomStreams(fuzzSeed, fuzzStreams),
  );
  for (let step = 0; step < steps; step += 1) {
    const label = `fuzz:${step}`;
    const kind = next() % 19;
    const time = current.simulationTime;
    const advance = (payload: Record<string, unknown> = {}, expected?: bigint) =>
      withCommand(
        current,
        "world.advance",
        label,
        {
          targetTime: (time + BigInt(next() % 200000)) as SimTimeMs,
          maxInputs: 1 + (next() % 4),
          ...payload,
        },
        expected,
      );
    // world.weather.set v2 carries only the intensity and applies at the command's own time.
    const weather = (payload: Record<string, unknown> = {}) =>
      withCommand(current, "world.weather.set", label, {
        rainIntensity: next() % 10001,
        ...payload,
      });
    const cmd = baseCommand(current) as unknown as Loose;
    const malformed: Record<number, unknown> = {
      10: null,
      11: undefined,
      12: { ...current, input: { kind: "command", command: { ...cmd, payload: null } } },
      13: advance({ schemaVersion: 1.5 }),
      14: advance({ targetTime: 1n << 64n }),
      15: { ...current, input: { kind: "command", command: { ...cmd, type: 7 } } },
      16: { ...current, partition: undefined },
      17: { ...current, input: { kind: "scheduled", scheduled: { schemaVersion: 1 } } },
    };
    let input: unknown;
    // The refusal a weather payload sent to be refused must get (world.ts precondition and v2 shape).
    let refusedAs: { code: string; path: string } | undefined;
    switch (kind) {
      case 0:
      case 1:
        input = weather();
        break;
      case 2:
      case 3:
      case 4:
        input = advance();
        break;
      case 5:
        input = advance({}, current.partition.revision + 1n);
        break;
      case 6:
        input = advance({ schemaVersion: 2 });
        break;
      case 7:
        input = withCommand(current, "world.explode" as WorldCommand["type"], label, {
          targetTime: time,
        });
        break;
      case 8:
        // Out of range: refused by the bounded-intensity precondition.
        input = weather({ rainIntensity: 10001 });
        refusedAs = { code: "precondition-failed", path: "payload.rainIntensity" };
        break;
      case 9:
        input =
          time === 0n
            ? advance({ maxInputs: 0 })
            : advance({ targetTime: (time - 1n) as SimTimeMs });
        break;
      case 18:
        // A version 1 `targetTime` in a version 2 payload: refused by its exact shape.
        input = weather({ targetTime: time });
        refusedAs = { code: "invalid-input", path: "payload" };
        break;
      default:
        input = malformed[kind];
    }
    const isValidKind = kind <= 4;
    const advanced = isValidKind
      ? await drive(label, input as WorldKernelInput, entries)
      : undefined;
    if (isValidKind) {
      if (advanced === undefined) throw new Error(`${label}: valid fuzz command refused`);
      current = advanced;
    } else {
      const outcome = await execute(label, input, entries);
      if (outcome.ok) {
        verifySuccess(input as WorldKernelInput, outcome);
        throw new Error("invalid fuzz command was accepted");
      }
      if (
        refusedAs !== undefined &&
        (outcome.error.code !== refusedAs.code || outcome.error.path !== refusedAs.path)
      )
        throw new Error(`${label} refused as ${outcome.error.code} at ${outcome.error.path}`);
    }
  }
}

/** Executor identities for golden and fuzzed commands plus the production registry identity. */
export async function executorEvidence(steps = fuzzSteps) {
  const goldenEntries: Entry[] = [];
  await golden("weather", scenarios.weather, goldenEntries);
  await golden("garden", scenarios.garden, goldenEntries);
  const fuzzEntries: Entry[] = [];
  await fuzz(fuzzEntries, steps);
  const identity = worldRegistryIdentity();
  return {
    schemaVersion: 1,
    mode: "test",
    registry: {
      commands: identity.commands,
      events: identity.events,
      reducers: identity.reducers,
      preconditions: identity.preconditions,
      invariants: identity.invariants,
      hash: await stateHash({ commands: identity.commands, events: identity.events }),
    },
    golden: goldenEntries,
    fuzz: { seed: fuzzSeed.seed, steps, entries: fuzzEntries },
  };
}

export async function fullRuntimeEvidence() {
  return {
    ...(await runtimeEvidence()),
    executor: await executorEvidence(),
    containment: await containmentEvidence(),
    spatial: await spatialEvidence(),
    perception: await perceptionEvidence(),
    scheduler: await schedulerEvidence(),
    environment: await environmentEvidence(),
    ecology: await ecologyEvidence(),
    wellbeing: await wellbeingEvidence(),
    decisions: await decisionsEvidence(),
    lifecycle: await lifecycleEvidence(),
  };
}
