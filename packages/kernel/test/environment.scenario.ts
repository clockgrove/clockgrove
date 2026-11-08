import type { CommandId, SimTimeMs } from "@clockgrove/contracts";
import {
  createWorldState,
  type DecisionTrace,
  decodeWorldScenario,
  deriveEnvironmentState,
  type WorldState,
} from "@clockgrove/domain";
import { canonicalSerialize } from "../src/canonical.js";
import { createDeterministicIdSource } from "../src/deterministic-id.js";
import { REFUSAL_CODES, type Refusal, RefusalSignal, refusal } from "../src/execute/refusal.js";
import { drawNamedRandomStream, initializeNamedRandomStreams } from "../src/random.js";
import { createCatchUpRegistry } from "../src/scheduler/catch-up.js";
import type { ScheduleQueue } from "../src/scheduler.js";
import { catchUpEnvironment } from "../src/systems/environment/index.js";
import {
  checkWorldInvariants,
  executeWorldKernel,
  type WorldCommand,
  type WorldContinuation,
  type WorldKernelInput,
  type WorldKernelOutcome,
  type WorldScheduledPayload,
  type WorldSemanticEvent,
} from "../src/world.js";
import { containmentInputIdentity } from "./containment.scenario.js";
import { scenarioInput, scenarios, stateHash } from "./weather-needs.scenario.js";

// biome-ignore lint: deliberately loose, hostile inputs are built from plain data
type Loose = Record<string, any>;

export const environmentSeed = { version: 1, seed: "environment-thresholds-v1" } as const;
export const environmentStreams = ["behavior"] as const;

export const MATERIAL_EVENT_TYPES = [
  "environment.phase-changed",
  "weather.transitioned",
  "exposure.threshold-crossed",
  "routine.selected",
] as const;

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

export interface EnvironmentSpec {
  readonly dayLengthMs: number;
  readonly phases: readonly (readonly [name: string, startMs: number, lightBand: string])[];
  readonly segments: readonly (readonly [
    durationMs: number,
    rainIntensity: number,
    temperatureBand: string,
  ])[];
  readonly wetThreshold: number;
  readonly discomfortThreshold: number;
  readonly intervalMs: number;
  readonly hungerPerInterval: number;
  readonly wetnessPerInterval: number;
  readonly dryingPerInterval: number;
  /** One needs actor each; a number places the actor in a shelter with that rain protection. */
  readonly actors: readonly (readonly [objectId: string, protection: number | null])[];
  readonly initialRain?: number;
}

/** One exposed and one fully sheltered actor over a day/night cycle with a dry, rain, dry series. */
export const GOLDEN_SPEC: EnvironmentSpec = {
  dayLengthMs: 24000,
  phases: [
    ["night", 0, "dark"],
    ["dawn", 5000, "dim"],
    ["day", 8000, "bright"],
    ["dusk", 18000, "dim"],
    ["evening", 20000, "dark"],
  ],
  segments: [
    [8000, 0, "mild"],
    [6000, 10000, "cool"],
    [10000, 0, "mild"],
  ],
  wetThreshold: 3000,
  discomfortThreshold: 6000,
  intervalMs: 1000,
  hungerPerInterval: 5,
  wetnessPerInterval: 1500,
  dryingPerInterval: 1000,
  actors: [
    ["exposed-weather", null],
    ["sheltered-weather", 10000],
  ],
};
export const GOLDEN_END = 24000n;

/** Small cycle whose weather boundaries cover every rain change kind. */
export const KINDS_SPEC: EnvironmentSpec = {
  dayLengthMs: 5000,
  phases: [["only", 0, "all"]],
  segments: [
    [1000, 0, "t0"],
    [1000, 5000, "t1"],
    [1000, 10000, "t2"],
    [1000, 10000, "t3"],
    [1000, 0, "t4"],
  ],
  wetThreshold: 1000,
  discomfortThreshold: 2000,
  intervalMs: 500,
  hungerPerInterval: 5,
  wetnessPerInterval: 600,
  dryingPerInterval: 300,
  actors: [["kind-weather", null]],
};

/** Tiny fixture for exception sweeps: the first weather boundary comes before the first interval. */
export const EXCEPTION_SPEC: EnvironmentSpec = {
  dayLengthMs: 100000,
  phases: [["day", 0, "bright"]],
  segments: [
    [500, 0, "mild"],
    [500, 10000, "wet"],
    [1000, 0, "mild"],
  ],
  wetThreshold: 3000,
  discomfortThreshold: 6000,
  intervalMs: 1000,
  hungerPerInterval: 5,
  wetnessPerInterval: 1500,
  dryingPerInterval: 1000,
  actors: [["solo-weather", null]],
};

/** JSON-form scenario (the historical decoder input) for a spec. */
export function environmentSample(spec: EnvironmentSpec): Loose {
  const sample = structuredClone(scenarios.weather) as Loose;
  sample.pack.packId = "clockgrove.fixture.environment";
  sample.pack.policy = {
    schemaVersion: 1,
    version: "environment-test@1",
    decisionIntervalMs: String(spec.intervalMs),
    hungerPerInterval: spec.hungerPerInterval,
    wetnessPerInterval: spec.wetnessPerInterval,
    dryingPerInterval: spec.dryingPerInterval,
    hungerWeight: 1000,
    shelterWeight: 2500,
    environment: {
      schemaVersion: 1,
      dayLengthMs: String(spec.dayLengthMs),
      phases: spec.phases.map(([name, startMs, lightBand]) => ({
        name,
        startMs: String(startMs),
        lightBand,
      })),
      weatherSegments: spec.segments.map(([durationMs, rainIntensity, temperatureBand]) => ({
        durationMs: String(durationMs),
        rainIntensity,
        temperatureBand,
      })),
      wetThreshold: spec.wetThreshold,
      discomfortThreshold: spec.discomfortThreshold,
    },
  };
  const pose = { frameId: "zone-ground", frameVersion: 1, coordinates: ["0", "0"] };
  const shelters = [
    ...new Set(spec.actors.flatMap(([, protection]) => (protection === null ? [] : [protection]))),
  ];
  sample.initialState.weather = { rainIntensity: spec.initialRain ?? spec.segments[0]![1] };
  sample.initialState.entities = [
    ...shelters.map((protection) => ({
      objectId: `shelter-${protection}`,
      archetypeId: "reference.shelter@1",
      pose,
      shelter: { rainProtection: protection },
      spaceId: "zone",
    })),
    ...spec.actors.map(([objectId, protection]) => ({
      objectId,
      archetypeId: "reference.weather@1",
      pose,
      needs: {
        hunger: 3000,
        wetness: 0,
        integratedAt: "0",
        hungerRemainder: "0",
        wetnessRemainder: "0",
      },
      spaceId: "zone",
      ...(protection === null ? {} : { locationId: `shelter-${protection}` }),
    })),
  ];
  return sample;
}

export interface EnvironmentWorld {
  readonly template: WorldKernelInput;
  readonly state: WorldState;
  readonly schedules: ScheduleQueue<WorldScheduledPayload>;
}

/** Builds a world whose environment record is the one its policy derives at time 0. */
export async function environmentWorld(spec: EnvironmentSpec): Promise<EnvironmentWorld> {
  const sample = environmentSample(spec);
  const decoded = decodeWorldScenario(sample, await stateHash(sample));
  const policy = decoded.pack.policy.environment;
  if (policy === undefined) throw new Error("environment policy required");
  const initialState = createWorldState({
    ...decoded.initialState,
    environment: deriveEnvironmentState(policy, decoded.initialState.simulationTime),
  });
  const template = await scenarioInput(undefined, 0, 32, {}, 32, {
    pack: decoded.pack,
    initialState,
  });
  return { template, state: template.partition.state, schedules: template.schedules };
}

export function commandInput(
  world: EnvironmentWorld,
  type: "world.advance" | "world.weather.set",
  id: string,
  payload: Loose,
  continuation?: WorldContinuation,
): WorldKernelInput {
  if (world.template.input.kind !== "command") throw new Error("command template required");
  const command = {
    ...world.template.input.command,
    commandId: id as CommandId,
    type,
    expected: { partitionRevision: world.state.revision },
    // Sent as given, so a stale field fails the scenario instead of being dropped here.
    payload: { schemaVersion: type === "world.weather.set" ? 2 : 1, ...payload },
  } as WorldCommand;
  return {
    ...world.template,
    partition: {
      ...world.template.partition,
      revision: world.state.revision,
      state: world.state,
    },
    simulationTime: world.state.simulationTime,
    schedules: world.schedules,
    input: { kind: "command", command },
    ids: createDeterministicIdSource({
      commandId: command.commandId,
      eventIndex: 0,
      randomStream: "routine",
    }),
    ...(continuation === undefined ? {} : { continuation }),
  };
}

export function advanceInput(
  world: EnvironmentWorld,
  id: string,
  target: bigint,
  maxInputs = 1024,
  maxEvents = 4096,
): WorldKernelInput {
  return commandInput(world, "world.advance", id, {
    targetTime: target as SimTimeMs,
    maxInputs,
    maxEvents,
  });
}

export function weatherInput(
  world: EnvironmentWorld,
  id: string,
  rainIntensity: number,
): WorldKernelInput {
  return commandInput(world, "world.weather.set", id, { rainIntensity });
}

export interface Executed {
  readonly input: WorldKernelInput;
  readonly outcome: WorldKernelOutcome;
}

export interface Run {
  readonly world: EnvironmentWorld;
  readonly events: readonly WorldSemanticEvent[];
  readonly calls: readonly Executed[];
  readonly incomplete: number;
}

/**
 * Every routine decision trace of a run, in decision order. Since issue 629 an unchanged decision journals
 * no `routine.selected`, so a run's decisions are its traces, not its selection events.
 */
export function routineTracesOf(run: Pick<Run, "calls">): DecisionTrace[] {
  const traces: DecisionTrace[] = [];
  for (const call of run.calls)
    if (call.outcome.ok)
      for (const draft of call.outcome.result.decisionDrafts as readonly {
        kind: string;
        decision: unknown;
      }[])
        if (draft.kind === "routine") traces.push(draft.decision as DecisionTrace);
  return traces;
}

/** The simulation time of every routine decision of a run, in decision order. */
export const decisionTimesOf = (run: Pick<Run, "calls">): bigint[] =>
  routineTracesOf(run).map((trace) => trace.simulationTime as bigint);

function describeRefusal(error: Refusal): string {
  return `${error.code} ${error.path} ${error.check ?? ""}`;
}

/** Executes one command and applies its result; refusals are thrown for the caller's test. */
export function applyCommand(world: EnvironmentWorld, input: WorldKernelInput): Run {
  const outcome = executeWorldKernel(input, { mode: "test" });
  if (!outcome.ok) throw new Error(describeRefusal(outcome.error));
  return {
    world: {
      template: world.template,
      state: outcome.result.state,
      schedules: outcome.result.schedules,
    },
    events: outcome.result.events,
    calls: [{ input, outcome }],
    incomplete: outcome.result.complete ? 0 : 1,
  };
}

/** One logical advance: chained continuation calls until the advance completes. */
export function runChain(
  start: EnvironmentWorld,
  id: string,
  target: bigint,
  maxInputs = 1024,
  maxEvents = 4096,
): Run {
  let input = advanceInput(start, id, target, maxInputs, maxEvents);
  let world = start;
  const events: WorldSemanticEvent[] = [];
  const calls: Executed[] = [];
  let incomplete = 0;
  for (let attempt = 0; attempt < 4000; attempt += 1) {
    const outcome = executeWorldKernel(input, { mode: "test" });
    calls.push({ input, outcome });
    if (!outcome.ok) throw new Error(describeRefusal(outcome.error));
    const result = outcome.result;
    events.push(...result.events);
    world = { template: start.template, state: result.state, schedules: result.schedules };
    if (result.complete) return { world, events, calls, incomplete };
    if (result.continuation === undefined) throw new Error("incomplete call omitted continuation");
    incomplete += 1;
    input = {
      ...input,
      partition: { ...input.partition, revision: result.state.revision, state: result.state },
      simulationTime: result.state.simulationTime,
      schedules: result.schedules,
      continuation: result.continuation,
    };
  }
  throw new Error("bounded advance did not finish");
}

/** Live steps: advances of at most one decision interval each. */
export function runLive(
  start: EnvironmentWorld,
  id: string,
  target: bigint,
  intervalMs: bigint,
): Run {
  let world = start;
  const events: WorldSemanticEvent[] = [];
  const calls: Executed[] = [];
  let step = 0;
  while (world.state.simulationTime < target) {
    const next = world.state.simulationTime + intervalMs;
    const run = runChain(world, `${id}:live:${step}`, next < target ? next : target);
    events.push(...run.events);
    calls.push(...run.calls);
    world = run.world;
    step += 1;
  }
  return { world, events, calls, incomplete: 0 };
}

/** The `material-threshold` view: ordered material events and the final state without revision. */
export function materialEvents(
  events: readonly { type: string }[],
): { type: string; time: bigint; payload: unknown }[] {
  return (events as readonly WorldSemanticEvent[])
    .filter((event) => (MATERIAL_EVENT_TYPES as readonly string[]).includes(event.type))
    .map((event) => ({
      type: event.type,
      time: event.simulationTime as bigint,
      payload: event.payload,
    }));
}

export function materialState(state: WorldState): unknown {
  return { ...state, revision: 0n };
}

export async function materialHashes(run: Run) {
  return {
    materialEventHash: await stateHash(materialEvents(run.events)),
    finalStateHash: await stateHash(materialState(run.world.state)),
  };
}

// ---------------------------------------------------------------------------------------------
// Generated environments, shelters and step sequences (named stream `behavior` only)
// ---------------------------------------------------------------------------------------------

export interface GeneratedCase {
  readonly sequence: number;
  readonly spec: EnvironmentSpec;
  readonly horizon: bigint;
  readonly chainEvents: number;
  readonly chainInputs: number;
}

export function generateEnvironmentCases(sequences = 3): GeneratedCase[] {
  let random = initializeNamedRandomStreams(environmentSeed, environmentStreams);
  const next = (bound: number): number => {
    const drawn = drawNamedRandomStream(random, "behavior");
    random = drawn.randomState;
    // Low bits of the underlying generator are weak; use the middle bits.
    return Number((drawn.draw.rawValue + 2147483648n) >> 8n) % bound;
  };
  const rains = [0, 10000, 5000, 2500, 7500];
  const protections: (number | null)[] = [null, 0, 2500, 5000, 7500, 10000];
  const cases: GeneratedCase[] = [];
  for (let sequence = 0; sequence < sequences; sequence += 1) {
    const dayLengthMs = 3000 + next(5) * 1000;
    const phaseCount = 1 + next(3);
    const step = Math.floor(dayLengthMs / phaseCount);
    const phases = Array.from(
      { length: phaseCount },
      (_, index) =>
        [
          `phase-${sequence}-${index}`,
          index === 0 ? 0 : index * step + next(2) * 100,
          `light-${next(3)}`,
        ] as const,
    );
    const segmentCount = 1 + next(3);
    const segments: (readonly [number, number, string])[] = Array.from(
      { length: segmentCount },
      () => [1000 + next(4) * 500, rains[next(5)]!, `temp-${next(3)}`] as const,
    );
    if (segments.every(([, rain]) => rain === 0))
      segments[segmentCount - 1] = [segments[segmentCount - 1]![0], 10000, "temp-wet"];
    if (segments.every(([, rain]) => rain > 0)) segments[0] = [segments[0]![0], 0, "temp-dry"];
    const wetThreshold = 1000 + next(3) * 500;
    const discomfortThreshold = wetThreshold + 500 + next(3) * 500;
    const intervalMs = [500, 750, 1000][next(3)]!;
    const wetnessPerInterval = 500 + next(5) * 250;
    const dryingPerInterval = 100 + next(3) * 100;
    const hungerPerInterval = 5 + next(5);
    const actorCount = 2 + next(2);
    const actors = Array.from({ length: actorCount }, (_, index) => {
      const protection = protections[next(6)] ?? null;
      return [`actor-${index}`, index === 0 ? null : protection] as const;
    });
    const spec: EnvironmentSpec = {
      dayLengthMs,
      phases,
      segments,
      wetThreshold,
      discomfortThreshold,
      intervalMs,
      hungerPerInterval,
      wetnessPerInterval,
      dryingPerInterval,
      actors,
    };
    cases.push({
      sequence,
      spec,
      horizon: BigInt(2 * dayLengthMs),
      // The largest indivisible time group: every actor integrated, a phase, a weather event and two
      // crossings per actor.
      chainEvents: 3 * actorCount + 2 + next(4),
      chainInputs: 1 + next(4),
    });
  }
  return cases;
}

/** Canonical bytes of everything a generated run produced, for seed-replay comparison. */
export async function generatedFingerprint(cases = generateEnvironmentCases()): Promise<string> {
  const parts: unknown[] = [];
  for (const entry of cases) {
    const world = await environmentWorld(entry.spec);
    const unbounded = runChain(world, `fingerprint:${entry.sequence}`, entry.horizon);
    const bounded = runChain(
      world,
      `fingerprint:${entry.sequence}`,
      entry.horizon,
      entry.chainInputs,
      entry.chainEvents,
    );
    parts.push(entry, unbounded.events, unbounded.world.state, bounded.events, bounded.world.state);
  }
  return canonicalSerialize(parts);
}

// ---------------------------------------------------------------------------------------------
// Refusal inputs
// ---------------------------------------------------------------------------------------------

const REMOVE = Symbol("remove");

function setPolicy(base: WorldKernelInput, policy: unknown): WorldKernelInput {
  return {
    ...base,
    pack: { ...base.pack, pack: { ...base.pack.pack, policy } as typeof base.pack.pack },
    policies: { ...base.policies, policy } as typeof base.policies,
  };
}

function environmentOf(base: WorldKernelInput): Loose {
  return structuredClone(base.pack.pack.policy.environment) as Loose;
}

function mutatePolicy(
  base: WorldKernelInput,
  change: (environment: Loose) => unknown,
): WorldKernelInput {
  const environment = environmentOf(base);
  const changed = change(environment);
  return setPolicy(base, {
    ...base.pack.pack.policy,
    environment: changed === undefined ? environment : changed,
  });
}

function withoutPolicyEnvironment(base: WorldKernelInput): WorldKernelInput {
  const { environment: _environment, ...policy } = base.pack.pack.policy;
  return setPolicy(base, policy);
}

function setStateEnvironment(base: WorldKernelInput, value: unknown): WorldKernelInput {
  const { environment: _environment, ...rest } = base.partition.state;
  const state = value === REMOVE ? rest : { ...rest, environment: value };
  return { ...base, partition: { ...base.partition, state: state as WorldState } };
}

function mutateState(base: WorldKernelInput, change: (record: Loose) => unknown): WorldKernelInput {
  const record = structuredClone(base.partition.state.environment) as Loose;
  const changed = change(record);
  return setStateEnvironment(base, changed === undefined ? record : changed);
}

/** Wraps one weather segment so reads of `rainIntensity` after `validReads` misbehave. */
function flakySegment(segment: Loose, validReads: number, mode: "invalid" | "throw"): Loose {
  let reads = 0;
  return new Proxy(segment, {
    get(target, property, receiver) {
      if (property === "rainIntensity") {
        reads += 1;
        if (reads > validReads) {
          if (mode === "throw") throw new Error("hostile segment read");
          return 10001;
        }
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

export function flakyInput(
  base: WorldKernelInput,
  validReads: number,
  mode: "invalid" | "throw",
): WorldKernelInput {
  return mutatePolicy(base, (environment) => {
    environment.weatherSegments[1] = flakySegment(environment.weatherSegments[1], validReads, mode);
    return environment;
  });
}

export interface RefusalCase {
  readonly name: string;
  readonly input: unknown;
}

const POLICY = "pack.pack.policy.environment";
const STATE = "partition.state.environment";

/** Fixed named refusal inputs; the expected envelopes are pinned in `spatial-evidence.ts`. */
export function environmentRefusalInputs(base: WorldKernelInput): RefusalCase[] {
  const policy = (name: string, change: (environment: Loose) => unknown): RefusalCase => ({
    name,
    input: mutatePolicy(base, change),
  });
  const state = (name: string, change: (record: Loose) => unknown): RefusalCase => ({
    name,
    input: mutateState(base, change),
  });
  const set = (key: string, value: unknown) => (environment: Loose) => {
    environment[key] = value;
    return environment;
  };
  const drop = (key: string) => (environment: Loose) => {
    delete environment[key];
    return environment;
  };
  const phase = (index: number, key: string, value: unknown) => (environment: Loose) => {
    if (value === REMOVE) delete environment.phases[index][key];
    else environment.phases[index][key] = value;
    return environment;
  };
  const segment = (index: number, key: string, value: unknown) => (environment: Loose) => {
    if (value === REMOVE) delete environment.weatherSegments[index][key];
    else environment.weatherSegments[index][key] = value;
    return environment;
  };
  const record = (key: string, value: unknown) => (entry: Loose) => {
    if (value === REMOVE) delete entry[key];
    else entry[key] = value;
    return entry;
  };
  const many = (count: number, make: (index: number) => Loose) =>
    Array.from({ length: count }, (_, index) => make(index));
  return [
    policy("policy-null", () => null),
    policy("policy-wrong-type", () => "environment"),
    policy("policy-missing-field", drop("dayLengthMs")),
    policy("policy-extra-field", set("extra", 1)),
    policy("unknown-version", set("schemaVersion", 2)),
    policy("phase-null", (environment) => {
      environment.phases[0] = null;
      return environment;
    }),
    policy("phase-missing-field", phase(0, "lightBand", REMOVE)),
    policy("phase-extra-field", phase(0, "extra", 1)),
    policy("segment-null", (environment) => {
      environment.weatherSegments[0] = null;
      return environment;
    }),
    policy("segment-missing-field", segment(0, "durationMs", REMOVE)),
    policy("segment-extra-field", segment(0, "extra", 1)),
    policy("threshold-missing", drop("wetThreshold")),
    policy("threshold-wrong-type", set("discomfortThreshold", "6000")),
    policy("day-length-zero", set("dayLengthMs", 0n)),
    policy("day-length-negative", set("dayLengthMs", -1n)),
    policy("day-length-wrong-type", set("dayLengthMs", 24000)),
    policy("day-length-out-of-range", set("dayLengthMs", (1n << 53n) + 1n)),
    policy("duration-zero", segment(0, "durationMs", 0n)),
    policy("duration-out-of-range", segment(0, "durationMs", (1n << 53n) + 1n)),
    policy("phases-empty", set("phases", [])),
    policy("phases-too-many", (environment) => {
      environment.dayLengthMs = 1000n;
      environment.phases = many(65, (index) => ({
        name: `p${index}`,
        startMs: BigInt(index),
        lightBand: "l",
      }));
      return environment;
    }),
    policy("segments-empty", set("weatherSegments", [])),
    policy(
      "segments-too-many",
      set(
        "weatherSegments",
        many(65, () => ({ durationMs: 1n, rainIntensity: 0, temperatureBand: "t" })),
      ),
    ),
    policy("first-phase-not-zero", phase(0, "startMs", 1n)),
    policy("phase-starts-not-increasing", phase(2, "startMs", 5000n)),
    policy("phase-start-beyond-day", phase(4, "startMs", 24000n)),
    policy("duplicate-phase-name", phase(1, "name", "night")),
    policy("rain-negative", segment(0, "rainIntensity", -1)),
    policy("rain-over-range", segment(0, "rainIntensity", 10001)),
    policy("threshold-zero", set("wetThreshold", 0)),
    policy("threshold-over-range", set("discomfortThreshold", 10001)),
    { name: "state-null", input: setStateEnvironment(base, null) },
    { name: "state-wrong-type", input: setStateEnvironment(base, "record") },
    state("state-missing-field", record("phase", REMOVE)),
    state("state-extra-field", record("extra", 1)),
    state("state-field-wrong-type", record("segmentIndex", "0")),
    state("state-boundary-wrong-type", record("nextPhaseBoundary", 5000)),
    { name: "state-without-policy", input: withoutPolicyEnvironment(base) },
    { name: "policy-without-state", input: setStateEnvironment(base, REMOVE) },
    state("phase-differs", record("phase", "other")),
    state("light-band-differs", record("lightBand", "other")),
    state("segment-differs", record("segmentIndex", 1)),
    state("temperature-differs", record("temperatureBand", "other")),
    state("phase-boundary-differs", (entry) => {
      entry.nextPhaseBoundary += 1n;
      return entry;
    }),
    state("weather-boundary-differs", (entry) => {
      entry.nextWeatherBoundary += 1n;
      return entry;
    }),
  ];
}

export const POLICY_PATH = POLICY;
export const STATE_PATH = STATE;

// ---------------------------------------------------------------------------------------------
// Evidence section
// ---------------------------------------------------------------------------------------------

function asRecord(value: unknown): Loose | null {
  return typeof value === "object" && value !== null ? (value as Loose) : null;
}

async function hashOf(value: unknown): Promise<string> {
  return (await containmentInputIdentity(value)).inputHash;
}

function assertEnvelope(error: Refusal): void {
  const keys = Object.keys(error).sort().join();
  if (
    !Object.isFrozen(error) ||
    !(REFUSAL_CODES as readonly string[]).includes(error.code) ||
    typeof error.path !== "string" ||
    !(keys === "code,path" || keys === "check,code,path")
  )
    throw new Error("refusal is not a stable envelope");
}

async function describeCall(label: string, input: unknown, outcome: WorldKernelOutcome) {
  const loose = asRecord(input);
  const stimulus = asRecord(loose?.input);
  const command = stimulus?.kind === "command" ? asRecord(stimulus.command) : null;
  const payload = asRecord(command?.payload);
  const identity = await containmentInputIdentity(
    loose === null ? input : { ...loose, ids: loose.ids?.seed },
  );
  const safe = async (value: unknown) => (value === undefined ? hashOf(null) : hashOf(value));
  const target = payload?.targetTime;
  const maxInputs = payload?.maxInputs;
  const maxEvents = payload?.maxEvents;
  const version = payload?.schemaVersion;
  const identityFields = {
    type: typeof command?.type === "string" ? command.type : null,
    version: typeof version === "number" && Number.isSafeInteger(version) ? version : null,
    commandId: typeof command?.commandId === "string" ? command.commandId : null,
    encoding: identity.encoding,
    inputHash: identity.inputHash,
    preStateHash: await safe(asRecord(loose?.partition)?.state),
    schedulesHash: await safe(loose?.schedules),
    policyHash: await safe(asRecord(asRecord(loose?.pack)?.pack)?.policy),
    targetTime: typeof target === "bigint" ? target.toString() : null,
    maxInputs: typeof maxInputs === "number" && Number.isSafeInteger(maxInputs) ? maxInputs : null,
    maxEvents: typeof maxEvents === "number" && Number.isSafeInteger(maxEvents) ? maxEvents : null,
  };
  if (!outcome.ok) {
    assertEnvelope(outcome.error);
    return {
      label,
      input: identityFields,
      output: {
        kind: "refusal",
        code: outcome.error.code,
        path: outcome.error.path,
        check: outcome.error.check ?? null,
      },
    };
  }
  const result = outcome.result;
  const material = result.events.filter((event) =>
    (MATERIAL_EVENT_TYPES as readonly string[]).includes(event.type),
  );
  return {
    label,
    input: identityFields,
    output: {
      kind: "success",
      events: await Promise.all(
        material.map(async (event) => ({
          type: event.type as string,
          time: event.simulationTime.toString(),
          eventId: event.eventId as string,
          payloadHash: await hashOf(event.payload),
        })),
      ),
      rainChanges: result.events.flatMap((event) =>
        event.type === "weather.transitioned" ? [event.payload.rainChange as string] : [],
      ),
      crossings: result.events.flatMap((event) =>
        event.type === "exposure.threshold-crossed"
          ? [`${event.payload.threshold}.${event.payload.direction}`]
          : [],
      ),
      postStateHash: await stateHash(result.state),
      complete: result.complete,
      continuationHash:
        result.continuation === undefined ? null : await hashOf(result.continuation),
    },
  };
}

export type EnvironmentEntry = Awaited<ReturnType<typeof describeCall>>;

/** A refusal that is not an `executeWorldKernel` call (invariant sweep, engine call). */
async function describeSynthetic(label: string, type: string, source: unknown, error: Refusal) {
  assertEnvelope(error);
  const identity = await containmentInputIdentity(source);
  return {
    label,
    input: {
      type,
      version: 1,
      commandId: label,
      encoding: identity.encoding,
      inputHash: identity.inputHash,
      preStateHash: await hashOf(asRecord(source)?.initial ?? null),
      schedulesHash: await hashOf([]),
      policyHash: await hashOf(asRecord(source)?.policy ?? null),
      targetTime: null,
      maxInputs: null,
      maxEvents: null,
    },
    output: {
      kind: "refusal",
      code: error.code,
      path: error.path,
      check: error.check ?? null,
    },
  };
}

/** Runs the sweep: the first number of valid reads that makes the hostile segment refuse. */
export function exceptionSweep(base: WorldKernelInput, mode: "invalid" | "throw", code: string) {
  for (let validReads = 0; validReads < 400; validReads += 1) {
    const input = flakyInput(base, validReads, mode);
    const outcome = executeWorldKernel(input, { mode: "test" });
    if (!outcome.ok && outcome.error.code === code) return { input, outcome };
    if (outcome.ok && validReads > 100) break;
  }
  throw new Error(`no ${code} found by the hostile segment sweep`);
}

export async function exceptionWorld() {
  return environmentWorld(EXCEPTION_SPEC);
}

async function targetedEntries(): Promise<EnvironmentEntry[]> {
  const entries: EnvironmentEntry[] = [];
  const golden = await environmentWorld(GOLDEN_SPEC);
  const full = runChain(golden, "golden:advance", GOLDEN_END);
  entries.push(
    await describeCall("case:golden-fast-forward", full.calls[0]!.input, full.calls[0]!.outcome),
  );
  const bounded = runChain(golden, "golden:bounded", GOLDEN_END, 8, 12);
  for (const [index, call] of bounded.calls.slice(0, 3).entries())
    entries.push(await describeCall(`case:golden-bounded-${index}`, call.input, call.outcome));
  const kinds = await environmentWorld(KINDS_SPEC);
  const kindRun = runChain(kinds, "kinds:advance", 5000n);
  entries.push(
    await describeCall(
      "case:rain-change-kinds",
      kindRun.calls[0]!.input,
      kindRun.calls[0]!.outcome,
    ),
  );
  // A held `world.weather.set` override, then the boundary that ends it.
  const held = applyCommand(kinds, weatherInput(kinds, "held:set", 7000));
  entries.push(
    await describeCall("case:weather-set", held.calls[0]!.input, held.calls[0]!.outcome),
  );
  const afterHold = runChain(held.world, "held:advance", 2500n);
  entries.push(
    await describeCall(
      "case:held-override",
      afterHold.calls[0]!.input,
      afterHold.calls[0]!.outcome,
    ),
  );
  return entries;
}

async function refusalEntries(): Promise<EnvironmentEntry[]> {
  const entries: EnvironmentEntry[] = [];
  const world = await environmentWorld(GOLDEN_SPEC);
  const base = advanceInput(world, "refusal:base", 5000n);
  for (const { name, input } of environmentRefusalInputs(base))
    entries.push(
      await describeCall(
        `refusal:${name}`,
        input,
        executeWorldKernel(input as WorldKernelInput, { mode: "test" }),
      ),
    );
  // Post-state invariant for every command: a final state whose record disagrees with the policy.
  const policy = base.pack.pack.policy;
  const state = base.partition.state;
  const disagreeing = createWorldState({
    ...state,
    environment: { ...state.environment!, phase: "other" },
  });
  for (const [name, type] of [
    ["invariant-advance", "world.advance"],
    ["invariant-weather-set", "world.weather.set"],
    ["invariant-containment", "resource.offer"],
    ["invariant-movement", "movement.start"],
  ] as const) {
    const error = checkWorldInvariants(state, disagreeing, [], type, policy);
    if (error === undefined) throw new Error("invariant did not refuse a disagreeing record");
    entries.push(
      await describeSynthetic(
        `refusal:${name}`,
        type,
        { initial: state, final: disagreeing, policy, type },
        error,
      ),
    );
  }
  // Environment system exception: the engine converts it to a returned refusal.
  const throwing = createCatchUpRegistry({
    payloads: [],
    systems: [
      {
        kind: "environment.throwing",
        version: 1,
        integrate: () => {
          throw new Error("hostile system");
        },
        nextThreshold: () => {
          throw new Error("hostile system");
        },
      },
    ],
  });
  if (!throwing.ok) throw new Error("registry required");
  let systemError: Refusal | undefined;
  try {
    catchUpEnvironment(
      throwing.registry,
      [{ systemId: "environment.throwing@1", at: 0n as SimTimeMs, state: {} }],
      0n as SimTimeMs,
      10n as SimTimeMs,
    );
  } catch (error) {
    systemError =
      error instanceof RefusalSignal ? error.refusal : refusal("handler-failed", "engine");
  }
  if (systemError === undefined) throw new Error("system exception was not refused");
  entries.push(
    await describeSynthetic(
      "refusal:system-exception",
      "world.advance",
      { initial: null, policy: null, request: "hostile-system" },
      systemError,
    ),
  );
  // Environment handler and reducer exceptions through the full executor.
  const tiny = await exceptionWorld();
  const tinyBase = advanceInput(tiny, "refusal:exception", 1500n);
  const handler = exceptionSweep(tinyBase, "throw", "handler-failed");
  entries.push(await describeCall("refusal:handler-exception", tinyBase, handler.outcome));
  const reducer = exceptionSweep(tinyBase, "invalid", "reducer-failed");
  entries.push(await describeCall("refusal:reducer-exception", tinyBase, reducer.outcome));
  return entries;
}

async function generatedEntries(): Promise<EnvironmentEntry[]> {
  const entries: EnvironmentEntry[] = [];
  for (const entry of generateEnvironmentCases()) {
    const world = await environmentWorld(entry.spec);
    const label = `generated:${entry.sequence}`;
    const unbounded = runChain(world, `${label}:unbounded`, entry.horizon);
    entries.push(
      await describeCall(
        `${label}:unbounded`,
        unbounded.calls[0]!.input,
        unbounded.calls[0]!.outcome,
      ),
    );
    const bounded = runChain(
      world,
      `${label}:bounded`,
      entry.horizon,
      entry.chainInputs,
      entry.chainEvents,
    );
    entries.push(
      await describeCall(`${label}:bounded`, bounded.calls[0]!.input, bounded.calls[0]!.outcome),
    );
  }
  return entries;
}

export interface EnvironmentPair {
  readonly name: string;
  readonly equivalence: "material-threshold";
  readonly leftHash: string;
  readonly rightHash: string;
}

async function pairHash(run: Run): Promise<string> {
  return stateHash({ events: materialEvents(run.events), state: materialState(run.world.state) });
}

/** The two `material-threshold` differential pairs over the golden fixture. */
export async function environmentPairs(): Promise<EnvironmentPair[]> {
  const golden = await environmentWorld(GOLDEN_SPEC);
  const fast = runChain(golden, "pair:fast", GOLDEN_END);
  const live = runLive(golden, "pair:live", GOLDEN_END, BigInt(GOLDEN_SPEC.intervalMs));
  const chained = runChain(golden, "pair:chained", GOLDEN_END, 8, 12);
  return [
    {
      name: "live-steps-vs-fast-forward",
      equivalence: "material-threshold",
      leftHash: await pairHash(live),
      rightHash: await pairHash(fast),
    },
    {
      name: "bounded-continuation-vs-unbounded",
      equivalence: "material-threshold",
      leftHash: await pairHash(chained),
      rightHash: await pairHash(fast),
    },
  ];
}

export async function environmentGolden() {
  const golden = await environmentWorld(GOLDEN_SPEC);
  const fast = runChain(golden, "golden:fast", GOLDEN_END);
  return { name: "rain-shelter-comfort", ...(await materialHashes(fast)) };
}

export async function environmentEvidence() {
  return {
    schemaVersion: 1,
    seed: environmentSeed,
    entries: [
      ...(await targetedEntries()),
      ...(await refusalEntries()),
      ...(await generatedEntries()),
    ],
    pairs: await environmentPairs(),
    golden: await environmentGolden(),
  };
}
