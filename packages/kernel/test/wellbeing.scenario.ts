import type { SimTimeMs } from "@clockgrove/contracts";
import {
  createWorldState,
  decodeWorldScenario,
  deriveEnvironmentState,
  type WorldState,
} from "@clockgrove/domain";
import { canonicalSerialize } from "../src/canonical.js";
import { createDeterministicIdSource } from "../src/deterministic-id.js";
import { REFUSAL_CODES, type Refusal, RefusalSignal, refusal } from "../src/execute/refusal.js";
import { drawNamedRandomStream, initializeNamedRandomStreams } from "../src/random.js";
import { createCatchUpRegistry } from "../src/scheduler/catch-up.js";
import { createScheduleQueue, type ScheduledItem } from "../src/scheduler.js";
import { catchUpEnvironment } from "../src/systems/environment/index.js";
import {
  checkWorldInvariants,
  dispatchWorldDecision,
  executeWorldKernel,
  type WorldKernelInput,
  type WorldKernelOutcome,
  type WorldScheduledPayload,
  type WorldSemanticEvent,
} from "../src/world.js";
import { containmentInputIdentity } from "./containment.scenario.js";
import {
  advanceInput,
  applyCommand,
  commandInput,
  type EnvironmentSpec,
  type EnvironmentWorld,
  environmentSample,
  GOLDEN_SPEC,
  type Run,
  routineTracesOf,
  runChain,
  runLive,
} from "./environment.scenario.js";
import { scenarioInput, stateHash } from "./weather-needs.scenario.js";

// biome-ignore lint: deliberately loose, hostile inputs are built from plain data
type Loose = Record<string, any>;

export const wellbeingSeed = { version: 1, seed: "wellbeing-thresholds-v1" } as const;
export const wellbeingStreams = ["behavior"] as const;
export const WELLBEING_EQUIVALENCE = "material-wellbeing";

/** The `material-wellbeing` event types; everything else is incidental. */
export const WELLBEING_MATERIAL_TYPES = [
  "environment.phase-changed",
  "weather.transitioned",
  "exposure.threshold-crossed",
  "resource.spoiled",
  "resource.appeared",
  "growth.stage-changed",
  "needs.threshold-crossed",
  "comfort.changed",
  "health.threshold-crossed",
  "routine.selected",
] as const;

/** Same-time order: RW-0107b order up to stage changes, then needs, comfort, health, the decision. */
export const WELLBEING_RANK: Readonly<Record<string, number>> = {
  "environment.phase-changed": 0,
  "weather.transitioned": 1,
  "exposure.threshold-crossed": 2,
  "resource.spoiled": 3,
  "resource.appeared": 4,
  "growth.stage-changed": 5,
  "needs.threshold-crossed": 6,
  "comfort.changed": 7,
  "health.threshold-crossed": 8,
  "routine.selected": 9,
};

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

export interface WellbeingValues {
  readonly thirstPerInterval: number;
  readonly healthLossPerInterval: number;
  readonly healthRecoveryPerInterval: number;
  readonly urgentHunger: number;
  readonly urgentThirst: number;
  readonly criticalHealth: number;
}

export interface WellbeingSpec extends EnvironmentSpec {
  readonly wellbeing: WellbeingValues;
  readonly hunger?: number;
  /** Optional drawn initial values, one per actor in `actors` order. */
  readonly initial?: readonly InitialNeeds[];
}

export interface InitialNeeds {
  readonly hunger: number;
  readonly wetness: number;
  readonly thirst: number;
  readonly health: number;
}

/** One exposed and one fully sheltered actor, dry then rain then dry, then hunger becomes urgent. */
export const COMFORT_SPEC: WellbeingSpec = {
  ...GOLDEN_SPEC,
  wellbeing: {
    thirstPerInterval: 5,
    healthLossPerInterval: 1500,
    healthRecoveryPerInterval: 1000,
    urgentHunger: 3125,
    urgentThirst: 125,
    criticalHealth: 5000,
  },
};
export const COMFORT_END = 28000n;

const DRY: Pick<EnvironmentSpec, "dayLengthMs" | "phases" | "segments"> = {
  dayLengthMs: 10000,
  phases: [["only", 0, "all"]],
  segments: [[10000, 0, "dry"]],
};
const BASE_RATES = {
  wetThreshold: 3000,
  discomfortThreshold: 6000,
  intervalMs: 1000,
  hungerPerInterval: 5,
  wetnessPerInterval: 1500,
  dryingPerInterval: 1000,
} as const;
const QUIET_VALUES: WellbeingValues = {
  thirstPerInterval: 1,
  healthLossPerInterval: 100,
  healthRecoveryPerInterval: 100,
  urgentHunger: 10000,
  urgentThirst: 10000,
  criticalHealth: 1,
};

/** Hunger and thirst become urgent together at 2000; health enters critical at 2201. */
export const SAME_SPEC: WellbeingSpec = {
  ...DRY,
  ...BASE_RATES,
  actors: [["solo-weather", null]],
  wellbeing: {
    thirstPerInterval: 5,
    healthLossPerInterval: 5000,
    healthRecoveryPerInterval: 1000,
    urgentHunger: 3010,
    urgentThirst: 10,
    criticalHealth: 9000,
  },
};
/** Thirst becomes urgent between two decisions, hunger later, so a need crossing needs no comfort change. */
export const THIRST_SPEC: WellbeingSpec = {
  ...DRY,
  ...BASE_RATES,
  actors: [["solo-weather", null]],
  wellbeing: { ...QUIET_VALUES, thirstPerInterval: 3, urgentThirst: 4, urgentHunger: 3010 },
};
/** No threshold is reachable: two actors whose decisions only come from their own schedules. */
export const QUIET_SPEC: WellbeingSpec = {
  ...DRY,
  ...BASE_RATES,
  actors: [
    ["a-weather", null],
    ["b-weather", 10000],
  ],
  wellbeing: QUIET_VALUES,
};
/** Hunger becomes urgent at 200, before the second decision at 1000. */
export const EARLY_SPEC: WellbeingSpec = {
  ...DRY,
  ...BASE_RATES,
  actors: [["early-weather", null]],
  wellbeing: { ...QUIET_VALUES, urgentHunger: 3001 },
};

export function wellbeingSample(spec: WellbeingSpec): Loose {
  const sample = environmentSample(spec);
  sample.pack.packId = "clockgrove.fixture.wellbeing";
  sample.pack.policy.wellbeing = { schemaVersion: 1, ...spec.wellbeing };
  const hunger = spec.hunger ?? 3000;
  for (const entity of sample.initialState.entities as Loose[])
    if (entity.needs !== undefined) entity.needs.hunger = hunger;
  const initialOf = new Map<string, InitialNeeds>();
  spec.actors.forEach(([objectId], index) => {
    const drawn = spec.initial?.[index];
    if (drawn !== undefined) initialOf.set(objectId, drawn);
  });
  for (const entity of sample.initialState.entities as Loose[]) {
    const drawn = initialOf.get(entity.objectId);
    if (drawn !== undefined && entity.needs !== undefined) {
      entity.needs.hunger = drawn.hunger;
      entity.needs.wetness = drawn.wetness;
    }
  }
  const ids = spec.actors.map(([objectId]) => objectId).sort();
  sample.initialState.wellbeing = {
    entries: ids.map((objectId) => {
      const drawn = initialOf.get(objectId);
      const h = drawn?.hunger ?? hunger;
      const uncomfortable =
        (drawn !== undefined && drawn.wetness >= spec.discomfortThreshold) ||
        h >= spec.wellbeing.urgentHunger ||
        (drawn !== undefined && drawn.thirst >= spec.wellbeing.urgentThirst);
      return {
        objectId,
        thirst: drawn?.thirst ?? 0,
        thirstRemainder: "0",
        health: drawn?.health ?? 10000,
        healthRemainder: "0",
        comfort: uncomfortable ? "uncomfortable" : "comfortable",
        integratedAt: "0",
      };
    }),
  };
  return sample;
}

/** Builds a world whose environment record is the one its policy derives at time 0. */
export async function wellbeingWorld(spec: WellbeingSpec): Promise<EnvironmentWorld> {
  const sample = wellbeingSample(spec);
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

export { advanceInput, applyCommand, commandInput, runChain, runLive };

type Item = ScheduledItem<WorldScheduledPayload>;

/** The scheduled `world.decision` input for one queued item against the world's current state. */
export function scheduledInput(world: EnvironmentWorld, item: Item): WorldKernelInput {
  const scheduled = dispatchWorldDecision(item);
  return {
    ...world.template,
    partition: { ...world.template.partition, revision: world.state.revision, state: world.state },
    simulationTime: world.state.simulationTime,
    schedules: world.schedules,
    input: { kind: "scheduled", scheduled },
    ids: createDeterministicIdSource({
      commandId: scheduled.commandId,
      eventIndex: 0,
      randomStream: "routine",
    }),
  } as WorldKernelInput;
}

export function firstItem(world: EnvironmentWorld, index = 0): Item {
  const item = createScheduleQueue(world.schedules)[index];
  if (item === undefined) throw new Error("schedule item required");
  return item;
}

/**
 * Drives the world only through scheduled `world.decision` inputs up to the horizon. A decision the
 * engine brought forward is refused as not first-due; one `world.advance` step with one input
 * dispatches it instead. Time then advances to the horizon with a plain advance.
 */
export function runScheduledDecisions(start: EnvironmentWorld, id: string, horizon: bigint): Run {
  let world = start;
  const events: WorldSemanticEvent[] = [];
  const calls: Run["calls"][number][] = [];
  for (let step = 0; step < 20000; step += 1) {
    const first = createScheduleQueue(world.schedules)[0];
    if (first === undefined || first.dueAt > horizon) break;
    const input = scheduledInput(world, first);
    const outcome = executeWorldKernel(input, { mode: "test" });
    let run: Run;
    if (outcome.ok) {
      run = {
        world: {
          template: start.template,
          state: outcome.result.state,
          schedules: outcome.result.schedules,
        },
        events: outcome.result.events,
        calls: [{ input, outcome }],
        incomplete: 0,
      };
    } else {
      if (outcome.error.check !== "world.decision.first-due@1")
        throw new Error(`scheduled decision refused: ${outcome.error.code} ${outcome.error.path}`);
      run = applyCommand(world, advanceInput(world, `${id}:step:${step}`, first.dueAt, 1, 4096));
    }
    events.push(...run.events);
    calls.push(...run.calls);
    world = run.world;
  }
  const rest = runChain(world, `${id}:final`, horizon);
  return {
    world: rest.world,
    events: [...events, ...rest.events],
    calls: [...calls, ...rest.calls],
    incomplete: 0,
  };
}

// ---------------------------------------------------------------------------------------------
// Material views and hashes
// ---------------------------------------------------------------------------------------------

export function wellbeingMaterial(
  events: readonly { type: string }[],
): { type: string; time: bigint; payload: unknown }[] {
  return (events as readonly WorldSemanticEvent[])
    .filter((event) => (WELLBEING_MATERIAL_TYPES as readonly string[]).includes(event.type))
    .map((event) => ({
      type: event.type,
      time: event.simulationTime as bigint,
      payload: event.payload,
    }));
}

export function wellbeingState(state: WorldState): unknown {
  return { ...state, revision: 0n };
}

export async function wellbeingHashes(run: Run) {
  return {
    materialEventHash: await stateHash(wellbeingMaterial(run.events)),
    finalStateHash: await stateHash(wellbeingState(run.world.state)),
  };
}

/** Hash of the whole `material-wellbeing` view of a run (events and final state). */
export async function wellbeingPairHash(run: Run): Promise<string> {
  return stateHash({
    events: wellbeingMaterial(run.events),
    state: wellbeingState(run.world.state),
  });
}

export function only(events: readonly { type: string }[], type: string): WorldSemanticEvent[] {
  return (events as readonly WorldSemanticEvent[]).filter((event) => event.type === type);
}

export const payloadOf = (event: WorldSemanticEvent): Loose => event.payload as unknown as Loose;
export const timeOf = (event: WorldSemanticEvent): bigint => event.simulationTime as bigint;

// ---------------------------------------------------------------------------------------------
// Generated sequences
// ---------------------------------------------------------------------------------------------

export interface GeneratedCase {
  readonly sequence: number;
  readonly spec: WellbeingSpec;
  readonly horizon: bigint;
  readonly chainEvents: number;
  readonly chainInputs: number;
  /** Live step lengths in ms, each 1..intervalMs, drawn from the `behavior` stream. */
  readonly liveSteps: readonly number[];
}

/** Live advances by the drawn step lengths (cycled, clamped to the horizon). */
export function runLiveSteps(
  start: EnvironmentWorld,
  id: string,
  target: bigint,
  steps: readonly number[],
): Run {
  let world = start;
  const events: WorldSemanticEvent[] = [];
  const calls: Run["calls"][number][] = [];
  for (let step = 0; world.state.simulationTime < target; step += 1) {
    const length = BigInt(steps[step % steps.length]!);
    const next = world.state.simulationTime + length;
    const run = runChain(world, `${id}:live:${step}`, next < target ? next : target);
    events.push(...run.events);
    calls.push(...run.calls);
    world = run.world;
  }
  return { world, events, calls, incomplete: 0 };
}

export function generateWellbeingCases(sequences = 3): GeneratedCase[] {
  let random = initializeNamedRandomStreams(wellbeingSeed, wellbeingStreams);
  const next = (bound: number): number => {
    const drawn = drawNamedRandomStream(random, "behavior");
    random = drawn.randomState;
    // Low bits of the underlying generator are weak; use the middle bits.
    return Number((drawn.draw.rawValue + 2147483648n) >> 8n) % bound;
  };
  const protections: (number | null)[] = [null, 0, 5000, 10000];
  const intervals = [400, 500, 1000];
  const cases: GeneratedCase[] = [];
  for (let sequence = 0; sequence < sequences; sequence += 1) {
    const dayLengthMs = 4000 + next(3) * 1000;
    const intervalMs = intervals[next(3)]!;
    const segments: (readonly [number, number, string])[] = [
      [1000 + next(3) * 500, 0, "temp-dry"],
      [1000 + next(4) * 500, 10000, "temp-wet"],
      [1000 + next(3) * 500, next(2) === 0 ? 0 : 5000, "temp-mixed"],
    ];
    const wetThreshold = 1000 + next(3) * 500;
    const actorCount = 1 + next(2);
    const actors = Array.from(
      { length: actorCount },
      (_, index) =>
        [
          `weather-${sequence}-${index}`,
          index === 0 ? null : (protections[next(4)] ?? null),
        ] as const,
    );
    const hungerPerInterval = 4 + next(8);
    const thirstPerInterval = 4 + next(8);
    const spec0: WellbeingSpec = {
      dayLengthMs,
      phases: [[`only-${sequence}`, 0, "all"]],
      segments,
      wetThreshold,
      discomfortThreshold: wetThreshold + 1000,
      intervalMs,
      hungerPerInterval,
      wetnessPerInterval: 800 + next(4) * 400,
      dryingPerInterval: 200 + next(3) * 200,
      actors,
      wellbeing: {
        thirstPerInterval,
        healthLossPerInterval: 500 + next(4) * 500,
        healthRecoveryPerInterval: 200 + next(3) * 300,
        urgentHunger: 3000 + hungerPerInterval * (3 + next(8)),
        urgentThirst: thirstPerInterval * (3 + next(8)),
        criticalHealth: 6000 + next(4) * 1000,
      },
    };
    const initial: InitialNeeds[] = actors.map(() => ({
      hunger: next(10001),
      wetness: next(10001),
      thirst: next(10001),
      health: next(10001),
    }));
    const spec: WellbeingSpec = { ...spec0, initial };
    cases.push({
      sequence,
      spec,
      horizon: BigInt(dayLengthMs + dayLengthMs / 2),
      // Largest indivisible group (two need crossings, comfort, health, integrations per actor) plus slack.
      chainEvents: 12 * actorCount + 6 + next(4),
      chainInputs: 1 + next(4),
      liveSteps: Array.from({ length: 6 }, () => 1 + next(intervalMs)),
    });
  }
  return cases;
}

function fail(what: string, detail?: unknown): never {
  throw new Error(
    `wellbeing assertion failed (${what})${detail === undefined ? "" : `: ${canonicalSerialize(detail)}`}`,
  );
}

export function assertWellbeingOrder(events: readonly WorldSemanticEvent[], what: string): void {
  let time = -1n;
  let rank = -1;
  let object = "";
  for (const event of events) {
    const next = WELLBEING_RANK[event.type];
    if (next === undefined) continue;
    const payload = payloadOf(event);
    // Need crossings: hunger before thirst, then object id order within each need.
    const id = `${event.type === "needs.threshold-crossed" ? (payload.need === "hunger" ? "0" : "1") : ""}${String(payload.objectId ?? "")}`;
    if (event.simulationTime < time) fail(`${what}: events leave simulation-time order`);
    if (event.simulationTime === time && next < rank)
      fail(`${what}: same-time order broken`, event.type);
    if (event.simulationTime === time && next === rank && id < object)
      fail(`${what}: objects within a kind must be in id order`, event.type);
    time = event.simulationTime;
    rank = next;
    object = id;
  }
}

/** The state an advance from `start` reaches exactly at `time`. */
export function stateAt(start: EnvironmentWorld, id: string, time: bigint): WorldState {
  return runChain(start, id, time).world.state;
}

export function needsOf(state: WorldState, objectId: string) {
  const needs = state.entities.find((entity) => entity.objectId === objectId)?.needs;
  if (needs === undefined) fail("needs actor missing", objectId);
  return needs;
}

export function entryOf(state: WorldState, objectId: string) {
  const entry = state.wellbeing?.entries.find((item) => item.objectId === objectId);
  if (entry === undefined) fail("wellbeing entry missing", objectId);
  return entry;
}

/** A trigger brings that actor's decision to the crossing time: comfort to uncomfortable, need, health entered. */
export function isTrigger(event: WorldSemanticEvent): boolean {
  const payload = payloadOf(event);
  return (
    event.type === "needs.threshold-crossed" ||
    (event.type === "comfort.changed" && payload.comfort === "uncomfortable") ||
    (event.type === "health.threshold-crossed" && payload.direction === "entered")
  );
}

export interface GeneratedSummary {
  readonly calls: number;
  readonly events: number;
  readonly triggers: number;
  readonly crossings: number;
  readonly fingerprint: string;
}

/** Runs one generated sequence and throws on the first violated property. */
export async function runGeneratedCase(entry: GeneratedCase): Promise<GeneratedSummary> {
  const { spec } = entry;
  const start = await wellbeingWorld(spec);
  const label = `wellbeing:${entry.sequence}`;
  const fast = runChain(start, `${label}:fast`, entry.horizon);
  assertWellbeingOrder(fast.events, label);

  // Replay determinism: the same inputs produce the same bytes.
  const replay = runChain(start, `${label}:fast`, entry.horizon);
  if (
    canonicalSerialize([fast.events, fast.world.state]) !==
    canonicalSerialize([replay.events, replay.world.state])
  )
    fail(`${label}: replay differs`);

  // Every trigger brings that actor's decision to the crossing time. Decisions are the run's
  // traces: an unchanged decision journals no routine.selected.
  const routines = routineTracesOf(fast);
  const triggers = fast.events.filter(isTrigger);
  for (const trigger of triggers) {
    const at = timeOf(trigger);
    const id = payloadOf(trigger).objectId;
    if (!routines.some((routine) => routine.simulationTime === at && routine.objectId === id))
      fail(`${label}: no decision at the crossing time`, { type: trigger.type, at, id });
  }
  // The next decision of an actor is never more than one interval after its previous one.
  const interval = BigInt(spec.intervalMs);
  for (const [objectId] of spec.actors) {
    const times = routines
      .filter((routine) => routine.objectId === objectId)
      .map((routine) => routine.simulationTime as bigint);
    for (let index = 1; index < times.length; index += 1) {
      const gap = times[index]! - times[index - 1]!;
      if (gap <= 0n || gap > interval) fail(`${label}: decision gap`, { objectId, gap });
    }
  }

  // Crossings happen at their first millisecond: one millisecond earlier they have not happened.
  const crossings = fast.events.filter((event) =>
    ["needs.threshold-crossed", "comfort.changed", "health.threshold-crossed"].includes(event.type),
  );
  const urgent = (need: string) =>
    need === "hunger" ? spec.wellbeing.urgentHunger : spec.wellbeing.urgentThirst;
  for (const [index, crossing] of crossings.entries()) {
    const at = timeOf(crossing);
    if (at < 1n) continue;
    const payload = payloadOf(crossing);
    const before = stateAt(start, `${label}:before:${index}`, at - 1n);
    const after = stateAt(start, `${label}:after:${index}`, at);
    const id = String(payload.objectId);
    if (crossing.type === "needs.threshold-crossed") {
      const read = (state: WorldState) =>
        payload.need === "hunger" ? needsOf(state, id).hunger : entryOf(state, id).thirst;
      if (
        !(
          read(before) < urgent(String(payload.need)) &&
          read(after) >= urgent(String(payload.need)) &&
          read(after) === payload.value
        )
      )
        fail(`${label}: need crossing is not at its first millisecond`, { at, payload });
    } else if (crossing.type === "comfort.changed") {
      if (
        entryOf(before, id).comfort === payload.comfort ||
        entryOf(after, id).comfort !== payload.comfort
      )
        fail(`${label}: comfort change is not at its first millisecond`, { at, payload });
    } else {
      const critical = spec.wellbeing.criticalHealth;
      const was = entryOf(before, id).health < critical;
      const now = entryOf(after, id).health < critical;
      if (
        was === now ||
        now !== (payload.direction === "entered") ||
        entryOf(after, id).health !== payload.health
      )
        fail(`${label}: health crossing is not at its first millisecond`, { at, payload });
    }
  }

  // Differential pairs under `material-wellbeing`.
  const fastHash = await wellbeingPairHash(fast);
  const live = runLiveSteps(start, `${label}:live`, entry.horizon, entry.liveSteps);
  if ((await wellbeingPairHash(live)) !== fastHash)
    fail(`${label}: live steps differ from fast-forward`);
  const bounded = runChain(
    start,
    `${label}:bounded`,
    entry.horizon,
    entry.chainInputs,
    entry.chainEvents,
  );
  if ((await wellbeingPairHash(bounded)) !== fastHash)
    fail(`${label}: bounded continuation differs`);
  const scheduled = runScheduledDecisions(start, `${label}:scheduled`, entry.horizon);
  if ((await wellbeingPairHash(scheduled)) !== fastHash)
    fail(`${label}: scheduled decisions differ`);

  return {
    calls: fast.calls.length + live.calls.length + bounded.calls.length + scheduled.calls.length,
    events: fast.events.length,
    triggers: triggers.length,
    crossings: crossings.length,
    fingerprint: canonicalSerialize([
      entry,
      fast.events.map((event) => [event.type, event.simulationTime, event.payload]),
      fast.world.state,
    ]),
  };
}

// ---------------------------------------------------------------------------------------------
// Golden
// ---------------------------------------------------------------------------------------------

export interface WellbeingGolden {
  readonly fast: Run;
  readonly live: Run;
  readonly chained: Run;
  readonly scheduled: Run;
}

export async function comfortAndHealthGolden(world?: EnvironmentWorld): Promise<WellbeingGolden> {
  const start = world ?? (await wellbeingWorld(COMFORT_SPEC));
  return {
    fast: runChain(start, "comfort:fast", COMFORT_END),
    live: runLive(start, "comfort:live", COMFORT_END, BigInt(COMFORT_SPEC.intervalMs)),
    chained: runChain(start, "comfort:chained", COMFORT_END, 8, 16),
    scheduled: runScheduledDecisions(start, "comfort:scheduled", COMFORT_END),
  };
}

export async function wellbeingGoldenHashes(golden: WellbeingGolden) {
  return { name: "comfort-and-health", ...(await wellbeingHashes(golden.fast)) };
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

function mutatePolicy(
  base: WorldKernelInput,
  change: (wellbeing: Loose) => unknown,
): WorldKernelInput {
  const wellbeing = structuredClone(base.pack.pack.policy.wellbeing) as Loose;
  const changed = change(wellbeing);
  return setPolicy(base, {
    ...base.pack.pack.policy,
    wellbeing: changed === undefined ? wellbeing : changed,
  });
}

function withoutPolicyKey(
  base: WorldKernelInput,
  key: "wellbeing" | "environment",
): WorldKernelInput {
  const { [key]: _removed, ...policy } = base.pack.pack.policy;
  return setPolicy(base, policy);
}

function setStateWellbeing(base: WorldKernelInput, value: unknown): WorldKernelInput {
  const { wellbeing: _wellbeing, ...rest } = base.partition.state;
  const state = value === REMOVE ? rest : { ...rest, wellbeing: value };
  return { ...base, partition: { ...base.partition, state: state as WorldState } };
}

function mutateState(base: WorldKernelInput, change: (record: Loose) => unknown): WorldKernelInput {
  const record = structuredClone(base.partition.state.wellbeing) as Loose;
  const changed = change(record);
  return setStateWellbeing(base, changed === undefined ? record : changed);
}

export interface RefusalCase {
  readonly name: string;
  readonly input: unknown;
}

/** Fixed named refusal inputs; the expected envelopes are pinned in `spatial-evidence.ts`. */
export function wellbeingRefusalInputs(base: WorldKernelInput): RefusalCase[] {
  const policy = (name: string, change: (wellbeing: Loose) => unknown): RefusalCase => ({
    name,
    input: mutatePolicy(base, change),
  });
  const state = (name: string, change: (record: Loose) => unknown): RefusalCase => ({
    name,
    input: mutateState(base, change),
  });
  const set = (key: string, value: unknown) => (record: Loose) => {
    record[key] = value;
    return record;
  };
  const drop = (key: string) => (record: Loose) => {
    delete record[key];
    return record;
  };
  const entry = (index: number, key: string, value: unknown) => (record: Loose) => {
    if (value === REMOVE) delete record.entries[index][key];
    else record.entries[index][key] = value;
    return record;
  };
  return [
    policy("policy-null", () => null),
    policy("policy-wrong-type", () => "wellbeing"),
    policy("policy-missing-field", drop("thirstPerInterval")),
    policy("policy-extra-field", set("extra", 1)),
    policy("unknown-version", set("schemaVersion", 2)),
    { name: "policy-without-environment", input: withoutPolicyKey(base, "environment") },
    policy("thirst-rate-negative", set("thirstPerInterval", -1)),
    policy("thirst-rate-out-of-range", set("thirstPerInterval", 10001)),
    policy("thirst-rate-non-integer", set("thirstPerInterval", 1.5)),
    policy("thirst-rate-wrong-type", set("thirstPerInterval", "1")),
    policy("loss-out-of-range", set("healthLossPerInterval", 10001)),
    policy("recovery-out-of-range", set("healthRecoveryPerInterval", 10001)),
    policy("urgent-hunger-zero", set("urgentHunger", 0)),
    policy("urgent-hunger-out-of-range", set("urgentHunger", 10001)),
    policy("urgent-thirst-zero", set("urgentThirst", 0)),
    policy("critical-health-zero", set("criticalHealth", 0)),
    policy("critical-health-out-of-range", set("criticalHealth", 10001)),
    { name: "state-null", input: setStateWellbeing(base, null) },
    { name: "state-wrong-type", input: setStateWellbeing(base, "record") },
    state("state-missing-field", drop("entries")),
    state("state-extra-field", set("extra", 1)),
    state("entry-null", (record) => {
      record.entries[0] = null;
      return record;
    }),
    state("entry-missing-field", entry(0, "health", REMOVE)),
    state("entry-extra-field", entry(0, "extra", 1)),
    state("entry-wrong-type", entry(0, "thirst", "0")),
    state("entry-health-out-of-range", entry(0, "health", 10001)),
    state("entry-remainder-negative", entry(0, "thirstRemainder", -1n)),
    state("entry-remainder-wrong-type", entry(0, "healthRemainder", 0)),
    state("entry-unsupported-comfort", entry(0, "comfort", "cozy")),
    state("entry-time-wrong-type", entry(0, "integratedAt", 0)),
    state("entries-out-of-order", (record) => {
      record.entries.reverse();
      return record;
    }),
    { name: "state-without-policy", input: withoutPolicyKey(base, "wellbeing") },
    { name: "policy-without-state", input: setStateWellbeing(base, REMOVE) },
    state("entries-count-differs", (record) => {
      record.entries.pop();
      return record;
    }),
    state("entry-id-differs", entry(0, "objectId", "aa-weather")),
    state("entry-integrated-at-differs", entry(0, "integratedAt", 5n)),
    state("entry-thirst-remainder-too-large", entry(0, "thirstRemainder", 1000n)),
    state("entry-health-remainder-too-large", entry(0, "healthRemainder", 1000n)),
    state("entry-comfort-disagrees", entry(0, "comfort", "uncomfortable")),
  ];
}

export interface ScheduledRefusalCase {
  readonly name: string;
  readonly input: WorldKernelInput;
}

/** Hostile scheduled inputs built from a valid one (`first` is the first queued item, `second` the other actor's). */
export function scheduledRefusalInputs(world: EnvironmentWorld): ScheduledRefusalCase[] {
  const first = scheduledInput(world, firstItem(world, 0));
  const scheduledOf = (input: WorldKernelInput) =>
    (input.input as unknown as { scheduled: Loose }).scheduled;
  const edit = (name: string, change: (scheduled: Loose) => Loose): ScheduledRefusalCase => ({
    name,
    input: {
      ...first,
      input: { kind: "scheduled", scheduled: change(structuredClone(scheduledOf(first))) },
    } as unknown as WorldKernelInput,
  });
  return [
    edit("scheduled-null", () => null as unknown as Loose),
    edit("scheduled-missing-key", (scheduled) => {
      delete scheduled.payload;
      return scheduled;
    }),
    edit("scheduled-extra-key", (scheduled) => ({ ...scheduled, extra: 1 })),
    edit("scheduled-unknown-type", (scheduled) => ({ ...scheduled, type: "world.dream" })),
    edit("scheduled-unknown-version", (scheduled) => ({ ...scheduled, schemaVersion: 2 })),
    edit("unknown-schedule", (scheduled) => ({
      ...scheduled,
      scheduleId: "schedule-that-is-not-queued",
    })),
    edit("payload-null", (scheduled) => ({ ...scheduled, payload: null })),
    edit("payload-extra-key", (scheduled) => ({
      ...scheduled,
      payload: { ...scheduled.payload, extra: 1 },
    })),
    edit("payload-missing-field", (scheduled) => ({ ...scheduled, payload: { schemaVersion: 1 } })),
    edit("payload-version", (scheduled) => ({
      ...scheduled,
      payload: { ...scheduled.payload, schemaVersion: 2 },
    })),
    edit("payload-wrong-object", (scheduled) => ({
      ...scheduled,
      payload: { ...scheduled.payload, objectId: "b-weather" },
    })),
    edit("foreign-command-id", (scheduled) => ({
      ...scheduled,
      commandId: "not-the-engine-command-id",
    })),
    {
      name: "seed-command-id",
      input: {
        ...first,
        ids: createDeterministicIdSource({
          commandId: "not-the-engine-command-id" as never,
          eventIndex: 0,
          randomStream: "routine",
        }),
      } as WorldKernelInput,
    },
    {
      name: "continuation",
      input: {
        ...first,
        continuation: {
          schemaVersion: 1,
          tenantId: world.state.tenantId,
          worldId: world.state.worldId,
          timelineId: world.state.timelineId,
          partitionId: world.state.partitionId,
          inputIdentity: "",
          stateIdentity: "",
          commandId: scheduledOf(first).commandId,
          targetTime: world.state.simulationTime,
          packHash: "",
          policyVersion: "",
          expectedRevision: world.state.revision,
          stage: "scheduled",
        },
      } as WorldKernelInput,
    },
    { name: "not-first-due", input: scheduledInput(world, firstItem(world, 1)) },
    {
      name: "unsupported-stimulus",
      input: { ...first, input: { kind: "reminder" } } as unknown as WorldKernelInput,
    },
  ];
}

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

function detailOf(event: WorldSemanticEvent): string | null {
  const payload = payloadOf(event);
  if (event.type === "health.threshold-crossed") return String(payload.direction);
  if (event.type === "comfort.changed") return String(payload.comfort);
  if (event.type === "needs.threshold-crossed") return String(payload.need);
  return null;
}

export async function describeCall(label: string, input: unknown, outcome: WorldKernelOutcome) {
  const loose = asRecord(input);
  const stimulus = asRecord(loose?.input);
  const command = stimulus?.kind === "command" ? asRecord(stimulus.command) : null;
  const scheduled = stimulus?.kind === "scheduled" ? asRecord(stimulus.scheduled) : null;
  const payload = asRecord(command?.payload);
  const identity = await containmentInputIdentity(
    loose === null ? input : { ...loose, ids: loose.ids?.seed },
  );
  const safe = async (value: unknown) => (value === undefined ? hashOf(null) : hashOf(value));
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  const safeInteger = (value: unknown) =>
    typeof value === "number" && Number.isSafeInteger(value) ? value : null;
  const target = payload?.targetTime;
  const version = scheduled === null ? payload?.schemaVersion : scheduled.schemaVersion;
  const identityFields = {
    stimulus: typeof stimulus?.kind === "string" ? stimulus.kind : null,
    type: text(command?.type) ?? text(scheduled?.type),
    version: safeInteger(version),
    commandId: text(command?.commandId) ?? text(scheduled?.commandId),
    scheduleId: text(scheduled?.scheduleId),
    encoding: identity.encoding,
    inputHash: identity.inputHash,
    preStateHash: await safe(asRecord(loose?.partition)?.state),
    schedulesHash: await safe(loose?.schedules),
    policyHash: await safe(asRecord(asRecord(loose?.pack)?.pack)?.policy),
    targetTime: typeof target === "bigint" ? target.toString() : null,
    maxInputs: safeInteger(payload?.maxInputs),
    maxEvents: safeInteger(payload?.maxEvents),
  };
  if (!outcome.ok) {
    assertEnvelope(outcome.error);
    return {
      label,
      input: identityFields,
      output: {
        kind: "refusal" as const,
        code: outcome.error.code as string,
        path: outcome.error.path,
        check: outcome.error.check ?? null,
      },
    };
  }
  const result = outcome.result;
  const queued = new Map<string, bigint>();
  const schedules = Array.isArray(loose?.schedules) ? (loose?.schedules as readonly Loose[]) : [];
  for (const item of schedules) queued.set(String(item.id), item.dueAt as bigint);
  const upserts = (result.scheduleMutations as readonly Loose[])
    .filter((mutation) => mutation.kind === "upsert")
    .map((mutation) => {
      const was = queued.get(String(mutation.scheduleId));
      return [
        String(mutation.scheduleId),
        (mutation.dueAt as bigint).toString(),
        was === undefined ? null : was.toString(),
      ] as const;
    });
  const material = result.events.filter((event) =>
    (WELLBEING_MATERIAL_TYPES as readonly string[]).includes(event.type),
  );
  return {
    label,
    input: identityFields,
    output: {
      kind: "success" as const,
      events: await Promise.all(
        material.map(async (event) => ({
          type: event.type as string,
          time: event.simulationTime.toString(),
          eventId: event.eventId as string,
          payloadHash: await hashOf(event.payload),
          detail: detailOf(event),
        })),
      ),
      eventTypes: [...new Set(result.events.map((event) => event.type as string))].sort(),
      upserts,
      postStateHash: await stateHash(result.state),
      complete: result.complete,
      continuationHash:
        result.continuation === undefined ? null : await hashOf(result.continuation),
    },
  };
}

export type WellbeingEntry = Awaited<ReturnType<typeof describeCall>>;

/** A refusal that is not an `executeWorldKernel` call (invariant sweep, engine call). */
async function describeSynthetic(
  label: string,
  type: string,
  source: unknown,
  error: Refusal,
): Promise<WellbeingEntry> {
  assertEnvelope(error);
  const identity = await containmentInputIdentity(source);
  return {
    label,
    input: {
      stimulus: null,
      type,
      version: 1,
      commandId: label,
      scheduleId: null,
      encoding: identity.encoding,
      inputHash: identity.inputHash,
      preStateHash: await hashOf(asRecord(source)?.initial ?? null),
      schedulesHash: await hashOf([]),
      policyHash: await hashOf(asRecord(source)?.policy ?? null),
      targetTime: null,
      maxInputs: null,
      maxEvents: null,
    },
    output: { kind: "refusal", code: error.code, path: error.path, check: error.check ?? null },
  };
}

const WELLBEING_FIELDS = [
  "thirstPerInterval",
  "healthLossPerInterval",
  "urgentHunger",
  "urgentThirst",
  "criticalHealth",
  "healthRecoveryPerInterval",
] as const;

/** Wraps the wellbeing policy so reads of `field` after `validReads` misbehave. */
export function flakyInput(
  base: WorldKernelInput,
  field: string,
  validReads: number,
  mode: "invalid" | "throw",
): WorldKernelInput {
  const wellbeing = structuredClone(base.pack.pack.policy.wellbeing) as Loose;
  let reads = 0;
  const hostile = new Proxy(wellbeing, {
    get(target, property, receiver) {
      if (property === field) {
        reads += 1;
        if (reads > validReads) {
          if (mode === "throw") throw new Error("hostile wellbeing read");
          return -1;
        }
      }
      return Reflect.get(target, property, receiver);
    },
  });
  return setPolicy(base, { ...base.pack.pack.policy, wellbeing: hostile });
}

/** Runs the sweep: the first hostile read that makes the engine refuse with `code`. */
export function exceptionSweep(base: WorldKernelInput, mode: "invalid" | "throw", code: string) {
  for (const field of WELLBEING_FIELDS)
    for (let validReads = 0; validReads < 300; validReads += 1) {
      const input = flakyInput(base, field, validReads, mode);
      const outcome = executeWorldKernel(input, { mode: "test" });
      if (!outcome.ok && outcome.error.code === code) return { input, outcome };
      if (outcome.ok && validReads > 120) break;
    }
  throw new Error(`no ${code} found by the hostile wellbeing sweep`);
}

// ---------------------------------------------------------------------------------------------
// Targeted cases: shared by the vitest file and the Node/Workers evidence
// ---------------------------------------------------------------------------------------------

export interface TargetedCases {
  /** Every successful engine call of the targeted cases, in a fixed order, by label. */
  readonly runs: ReadonlyArray<readonly [string, Run]>;
  readonly by: Readonly<Record<string, Run>>;
  /** Refused scheduled calls: label, input and outcome. */
  readonly refused: ReadonlyArray<readonly [string, WorldKernelInput, WorldKernelOutcome]>;
}

async function buildTargetedCases(): Promise<TargetedCases> {
  const runs: Array<readonly [string, Run]> = [];
  const by: Record<string, Run> = {};
  const refused: Array<readonly [string, WorldKernelInput, WorldKernelOutcome]> = [];
  const track = (label: string, run: Run): Run => {
    runs.push([label, run]);
    by[label] = run;
    return run;
  };
  const refuse = (label: string, input: WorldKernelInput): WorldKernelOutcome => {
    const outcome = executeWorldKernel(input, { mode: "test" });
    refused.push([label, input, outcome]);
    return outcome;
  };

  // Needs crossing together at 2000 (a decision time), health at 2201, one millisecond before and at.
  const same = await wellbeingWorld(SAME_SPEC);
  track("same-before", runChain(same, "same:before", 1999n));
  track("same-target", runChain(same, "same:target", 2000n));
  track("health-before", runChain(same, "health:before", 2200n));
  track("health-target", runChain(same, "health:target", 2201n));
  track("same-through", runChain(same, "same:through", 4500n));
  // A tight event budget ends calls between a brought-forward upsert and its decision.
  track("same-tight-8", runChain(same, "same:tight8", 4500n, 1024, 8));

  // A thirst crossing between decisions needs no comfort change beyond the first.
  track("thirst-through", runChain(await wellbeingWorld(THIRST_SPEC), "thirst:through", 4000n));

  // world.weather.set integrates wellbeing first, under the rain in force.
  const comfort = await wellbeingWorld(COMFORT_SPEC);
  const at = 3000n as SimTimeMs;
  const environment = comfort.template.pack.pack.policy.environment!;
  const lagging = {
    ...comfort,
    // Decisions are due now; the actors' needs, wellbeing and plants still lag at time 0.
    schedules: comfort.schedules.map((item) => ({ ...item, dueAt: at })),
    state: {
      ...comfort.state,
      simulationTime: at,
      weather: { rainIntensity: 10000 },
      environment: deriveEnvironmentState(environment, at),
    } as WorldState,
  };
  track(
    "weather-set-wellbeing-first",
    applyCommand(
      lagging,
      commandInput(lagging, "world.weather.set", "weather:first", { rainIntensity: 0 }),
    ),
  );

  // Scheduled decisions: accepted, retried (stale), not first due, brought forward.
  const quiet = await wellbeingWorld(QUIET_SPEC);
  const accepted = track(
    "scheduled-accepted",
    applyCommand(quiet, scheduledInput(quiet, firstItem(quiet))),
  );
  const stale = scheduledInput(quiet, firstItem(quiet));
  refuse("scheduled-stale-retry", {
    ...stale,
    partition: {
      ...stale.partition,
      revision: accepted.world.state.revision,
      state: accepted.world.state,
    },
    simulationTime: accepted.world.state.simulationTime,
    schedules: accepted.world.schedules,
  });
  refuse("scheduled-not-first", scheduledInput(quiet, firstItem(quiet, 1)));
  const early = await wellbeingWorld(EARLY_SPEC);
  const decided = track(
    "scheduled-early-first",
    applyCommand(early, scheduledInput(early, firstItem(early))),
  );
  refuse("scheduled-brought-forward", scheduledInput(decided.world, firstItem(decided.world)));
  track(
    "scheduled-early-advance",
    applyCommand(decided.world, advanceInput(decided.world, "early:step", 1000n, 1, 4096)),
  );
  return { runs, by, refused };
}

let targetedPromise: Promise<TargetedCases> | undefined;
export function targetedCases(): Promise<TargetedCases> {
  targetedPromise ??= buildTargetedCases();
  return targetedPromise;
}

async function targetedEntries(): Promise<WellbeingEntry[]> {
  const entries: WellbeingEntry[] = [];
  const cases = await targetedCases();
  for (const [label, run] of cases.runs)
    for (const [index, call] of run.calls.entries())
      entries.push(await describeCall(`targeted:${label}:${index}`, call.input, call.outcome));
  for (const [label, input, outcome] of cases.refused)
    entries.push(await describeCall(`refusal:${label}`, input, outcome));
  return entries;
}

async function refusalEntries(): Promise<WellbeingEntry[]> {
  const entries: WellbeingEntry[] = [];
  const world = await wellbeingWorld(QUIET_SPEC);
  const settled = runChain(world, "refusal:settle", 3500n).world;
  const base = advanceInput(settled, "refusal:base", 6000n);
  for (const { name, input } of wellbeingRefusalInputs(base))
    entries.push(
      await describeCall(
        `refusal:${name}`,
        input,
        executeWorldKernel(input as WorldKernelInput, { mode: "test" }),
      ),
    );
  for (const { name, input } of scheduledRefusalInputs(settled))
    entries.push(
      await describeCall(`refusal:${name}`, input, executeWorldKernel(input, { mode: "test" })),
    );
  // Post-state invariant for every command: a final state whose record disagrees with the policy.
  const policy = base.pack.pack.policy;
  const state = base.partition.state;
  const record = state.wellbeing!;
  const disagreeing = createWorldState({
    ...state,
    wellbeing: {
      entries: record.entries.map((item, index) =>
        index === 0
          ? { ...item, comfort: item.comfort === "comfortable" ? "uncomfortable" : "comfortable" }
          : item,
      ),
    },
  });
  for (const [name, type] of [
    ["invariant-advance", "world.advance"],
    ["invariant-weather-set", "world.weather.set"],
    ["invariant-containment", "resource.offer"],
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
  // Wellbeing system exception: the engine converts it to a returned refusal.
  const throwing = createCatchUpRegistry({
    payloads: [],
    systems: [
      {
        kind: "wellbeing.throwing",
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
      [{ systemId: "wellbeing.throwing@1", at: 0n as SimTimeMs, state: {} }],
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
  // Handler and reducer exceptions through the full executor.
  const tiny = await wellbeingWorld(SAME_SPEC);
  const tinyBase = advanceInput(tiny, "refusal:exception", 2500n);
  const handler = exceptionSweep(tinyBase, "throw", "handler-failed");
  entries.push(await describeCall("refusal:handler-exception", tinyBase, handler.outcome));
  const reducer = exceptionSweep(tinyBase, "invalid", "reducer-failed");
  entries.push(await describeCall("refusal:reducer-exception", tinyBase, reducer.outcome));
  return entries;
}

async function goldenEntries(): Promise<WellbeingEntry[]> {
  const entries: WellbeingEntry[] = [];
  const golden = await comfortAndHealthGolden();
  for (const [name, run] of [
    ["fast", golden.fast],
    ["live", golden.live],
    ["chained", golden.chained],
    ["scheduled", golden.scheduled],
  ] as const)
    for (const [index, call] of run.calls.entries())
      entries.push(await describeCall(`case:comfort-${name}-${index}`, call.input, call.outcome));
  return entries;
}

async function generatedEntries(): Promise<WellbeingEntry[]> {
  const entries: WellbeingEntry[] = [];
  for (const entry of generateWellbeingCases()) {
    const world = await wellbeingWorld(entry.spec);
    // The same four runs, with the same ids, that `runGeneratedCase` makes (replay and probes excluded).
    const label = `wellbeing:${entry.sequence}`;
    const runs = [
      ["fast", runChain(world, `${label}:fast`, entry.horizon)],
      ["live", runLiveSteps(world, `${label}:live`, entry.horizon, entry.liveSteps)],
      [
        "bounded",
        runChain(world, `${label}:bounded`, entry.horizon, entry.chainInputs, entry.chainEvents),
      ],
      ["scheduled", runScheduledDecisions(world, `${label}:scheduled`, entry.horizon)],
    ] as const;
    for (const [name, run] of runs)
      for (const [index, call] of run.calls.entries())
        entries.push(
          await describeCall(
            `generated:${entry.sequence}:${name}:${index}`,
            call.input,
            call.outcome,
          ),
        );
  }
  return entries;
}

export interface WellbeingPair {
  readonly name: string;
  readonly equivalence: typeof WELLBEING_EQUIVALENCE;
  readonly leftHash: string;
  readonly rightHash: string;
}

/** The three `material-wellbeing` differential pairs over the golden fixture. */
export async function wellbeingPairs(): Promise<WellbeingPair[]> {
  const golden = await comfortAndHealthGolden();
  const fast = await wellbeingPairHash(golden.fast);
  return [
    {
      name: "live-steps-vs-fast-forward",
      equivalence: WELLBEING_EQUIVALENCE,
      leftHash: await wellbeingPairHash(golden.live),
      rightHash: fast,
    },
    {
      name: "bounded-continuation-vs-unbounded",
      equivalence: WELLBEING_EQUIVALENCE,
      leftHash: await wellbeingPairHash(golden.chained),
      rightHash: fast,
    },
    {
      name: "scheduled-decisions-vs-advance",
      equivalence: WELLBEING_EQUIVALENCE,
      leftHash: await wellbeingPairHash(golden.scheduled),
      rightHash: fast,
    },
  ];
}

export async function wellbeingEvidence() {
  const golden = await comfortAndHealthGolden();
  return {
    schemaVersion: 1,
    seed: wellbeingSeed,
    entries: [
      ...(await goldenEntries()),
      ...(await targetedEntries()),
      ...(await refusalEntries()),
      ...(await generatedEntries()),
    ],
    pairs: await wellbeingPairs(),
    golden: await wellbeingGoldenHashes(golden),
  };
}
