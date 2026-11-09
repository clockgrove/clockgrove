import type { CommandId, SimTimeMs } from "@clockgrove/contracts";
import {
  createWorldState,
  decodeWorldScenario,
  deriveEnvironmentState,
  type NamedRandomState,
  replayWorldEvents,
  type WorldState,
} from "@clockgrove/domain";
import { createDeterministicIdSource } from "../src/deterministic-id.js";
import { type ConceptionDecision } from "../src/lifecycle/index.js";
import { PERCEIVABLE_EVENT_TYPES, resolveAudience } from "../src/perception/resolver.js";
import {
  drawNamedRandomStream,
  initializeNamedRandomStreams,
  RANDOM_ALGORITHM,
  RANDOM_CONTRACT_VERSION,
} from "../src/random.js";
import type { ScheduleQueue } from "../src/scheduler.js";
import {
  executeWorldKernel,
  type WorldCommand,
  type WorldContinuation,
  type WorldKernelInput,
  type WorldKernelOutcome,
  type WorldScheduledPayload,
  type WorldSemanticEvent,
  worldRegistryIdentity,
  worldResourceTotals,
} from "../src/world.js";
import { type EnvironmentSpec, environmentSample } from "./environment.scenario.js";
import { scenarioInput, stateHash } from "./weather-needs.scenario.js";
import { type InitialNeeds, type WellbeingSpec, wellbeingSample } from "./wellbeing.scenario.js";

// biome-ignore lint: deliberately loose, hostile inputs are built from plain data
export type Loose = Record<string, any>;

export const lifecycleSeed = { version: 1, seed: "lifecycle-v1" } as const;
export const lifecycleStreams = ["behavior", "lifecycle", "weather"] as const;
export const LIFECYCLE_EQUIVALENCE = "material-lifecycle";
export const LIFECYCLE_CHECK = "lifecycle.state-matches-policy@1";

export const LIFECYCLE_EVENT_TYPES = [
  "lifecycle.conceived",
  "lifecycle.gestation-milestone",
  "lifecycle.born",
  "lifecycle.stage-changed",
  "lifecycle.died",
  "lifecycle.successor-intended",
] as const;

/** The `material-lifecycle` event types: `material-wellbeing` plus the six lifecycle events. */
export const LIFECYCLE_MATERIAL_TYPES = [
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
  ...LIFECYCLE_EVENT_TYPES,
] as const;

/** Same-time rank (RW-0108b order through health crossings, then the lifecycle block, then routine). */
export const LIFECYCLE_RANK: Readonly<Record<string, number>> = {
  "environment.phase-changed": 0,
  "weather.transitioned": 1,
  "exposure.threshold-crossed": 2,
  "resource.spoiled": 3,
  "resource.appeared": 4,
  "growth.stage-changed": 5,
  "needs.threshold-crossed": 6,
  "comfort.changed": 7,
  "health.threshold-crossed": 8,
  "lifecycle.died": 9,
  "lifecycle.successor-intended": 9,
  "lifecycle.stage-changed": 10,
  "lifecycle.gestation-milestone": 11,
  "lifecycle.born": 12,
  "lifecycle.conceived": 13,
  "movement.region-entered": 14,
  "movement.region-exited": 14,
  "movement.completed": 15,
  "location.changed": 15,
  "routine.selected": 16,
};

const compare = (left: string, right: string): number =>
  left === right ? 0 : left < right ? -1 : 1;

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

export interface LifecycleValues {
  readonly stages: readonly (readonly [name: string, startsAtAgeMs: number])[];
  readonly lifespanMs: number;
  readonly deathHealth: number;
  readonly fertileStages: readonly string[];
  readonly conceptionIntervalMs: number;
  readonly conceptionChance: number;
  readonly coParent: "required" | "none";
  readonly gestationMs: number;
  readonly milestones: readonly (readonly [name: string, atMs: number])[];
  readonly cooldownMs: number;
  readonly maxPopulation: number;
  readonly successorRule: string | null;
  readonly seasonal?: {
    readonly yearLengthMs: number;
    readonly seasons: readonly (readonly [name: string, startMs: number])[];
    readonly conceptionSeasons: readonly string[];
  };
}

export interface LifecyclePart {
  readonly lifecycle: LifecycleValues;
  /** Optional per-actor birth times (ms, may be negative) for founders; defaults to 0. */
  readonly founderBornAt?: Readonly<Record<string, number>>;
  readonly founderHousehold?: Readonly<Record<string, string>>;
}

export type LifecycleSpec = WellbeingSpec & LifecyclePart;

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
const CALM = {
  thirstPerInterval: 1,
  healthLossPerInterval: 1500,
  healthRecoveryPerInterval: 500,
  urgentHunger: 10000,
  urgentThirst: 10000,
  criticalHealth: 5000,
} as const;
const SICK: InitialNeeds = { hunger: 10000, wetness: 0, thirst: 0, health: 10000 };

export const BASE_LIFECYCLE: LifecycleValues = {
  stages: [
    ["newborn", 0],
    ["juvenile", 1000],
    ["adult", 2000],
    ["elder", 8000],
  ],
  lifespanMs: 12000,
  deathHealth: 1000,
  fertileStages: ["adult"],
  conceptionIntervalMs: 1000,
  conceptionChance: 3000,
  coParent: "none",
  gestationMs: 3000,
  milestones: [["quickening", 1000]],
  cooldownMs: 2000,
  maxPopulation: 6,
  successorRule: "heir",
};

/** Two founders with calm needs: random conception, gestation, birth, aging and lifespan death. */
export const FOUNDERS_SPEC: LifecycleSpec = {
  ...DRY,
  ...BASE_RATES,
  actors: [
    ["a-resident", null],
    ["b-resident", null],
  ],
  wellbeing: CALM,
  lifecycle: BASE_LIFECYCLE,
};

const withLifecycle = (spec: LifecycleSpec, over: Partial<LifecycleValues>): LifecycleSpec => ({
  ...spec,
  lifecycle: { ...spec.lifecycle, ...over },
});

/** One adult founder (age 2000 at time 0) that always conceives when eligible. */
export const SURE_SPEC: LifecycleSpec = {
  ...FOUNDERS_SPEC,
  actors: [["a-resident", null]],
  founderBornAt: { "a-resident": -2000 },
  lifecycle: { ...BASE_LIFECYCLE, conceptionChance: 10000 },
};
export const SURE_HORIZON = 12000n;
/** A young founder: not fertile before it is an adult. */
export const YOUNG_SPEC: LifecycleSpec = { ...SURE_SPEC, founderBornAt: {} };
/** A population of one: every eligible conception is excluded by the cap. */
export const CAP_SPEC = withLifecycle(SURE_SPEC, { maxPopulation: 1 });
/** A required co-parent that does not exist. */
export const NO_CO_PARENT_SPEC = withLifecycle(SURE_SPEC, { coParent: "required" });
/** Two adults of one household with a required co-parent. */
export const PAIR_SPEC: LifecycleSpec = {
  ...SURE_SPEC,
  actors: [
    ["a-resident", null],
    ["b-resident", null],
  ],
  founderBornAt: { "a-resident": -2000, "b-resident": -2500 },
  lifecycle: { ...BASE_LIFECYCLE, conceptionChance: 10000, coParent: "required" },
};
/** Spring (0..2000) allows conception, summer (2000..4000) does not; chance 0 keeps births away. */
export const SEASON_SPEC: LifecycleSpec = withLifecycle(SURE_SPEC, {
  conceptionChance: 0,
  seasonal: {
    yearLengthMs: 4000,
    seasons: [
      ["spring", 0],
      ["summer", 2000],
    ],
    conceptionSeasons: ["spring"],
  },
});
/** An unconditionally conceiving adult whose health collapses: it dies of health at 3000 while gestating. */
export const SICK_SPEC: LifecycleSpec = {
  ...SURE_SPEC,
  wellbeing: { ...CALM, healthLossPerInterval: 3000 },
  initial: [SICK],
};
/** Critical health, health death and lifespan death all land at 1 ms. */
export const COINCIDE_SPEC: LifecycleSpec = {
  ...SURE_SPEC,
  founderBornAt: { "a-resident": -11999 },
  wellbeing: { ...CALM, healthLossPerInterval: 10000 },
  initial: [{ hunger: 10000, wetness: 0, thirst: 0, health: 5003 }],
  lifecycle: { ...BASE_LIFECYCLE, conceptionChance: 10000, deathHealth: 4995 },
};

/**
 * The household-generations golden: an old adult, a young founder that grows up and a sick adult that
 * dies of health while gestating. Children are born, age, are excluded by the cap and the founders die.
 */
export const HOUSEHOLD_SPEC: LifecycleSpec = {
  ...DRY,
  ...BASE_RATES,
  actors: [
    ["a-resident", null],
    ["b-resident", null],
    ["c-resident", null],
  ],
  founderBornAt: { "a-resident": -2000, "c-resident": -2000 },
  founderHousehold: {
    "a-resident": "den-east",
    "b-resident": "den-east",
    "c-resident": "den-west",
  },
  wellbeing: { ...CALM, healthLossPerInterval: 3000 },
  initial: [
    { hunger: 3000, wetness: 0, thirst: 0, health: 10000 },
    { hunger: 3000, wetness: 0, thirst: 0, health: 10000 },
    SICK,
  ],
  lifecycle: { ...BASE_LIFECYCLE, conceptionChance: 10000 },
};
export const HOUSEHOLD_HORIZON = 14000n;
export const HOUSEHOLD_SEASON_SPEC: LifecycleSpec = withLifecycle(HOUSEHOLD_SPEC, {
  seasonal: { yearLengthMs: 4000, seasons: [["only", 0]], conceptionSeasons: ["only"] },
});

export function applyLifecycle(
  sample: Loose,
  part: LifecyclePart,
  actorIds: readonly string[],
): Loose {
  const values = part.lifecycle;
  sample.pack.policy.lifecycle = {
    schemaVersion: 1,
    stages: values.stages.map(([name, startsAtAgeMs]) => ({
      name,
      startsAtAgeMs: String(startsAtAgeMs),
    })),
    lifespanMs: String(values.lifespanMs),
    deathHealth: values.deathHealth,
    reproduction: {
      fertileStages: [...values.fertileStages],
      conceptionIntervalMs: String(values.conceptionIntervalMs),
      conceptionChance: values.conceptionChance,
      coParent: values.coParent,
      gestationMs: String(values.gestationMs),
      gestationMilestones: values.milestones.map(([name, atMs]) => ({ name, atMs: String(atMs) })),
      cooldownMs: String(values.cooldownMs),
      maxPopulation: values.maxPopulation,
    },
    successorRule: values.successorRule,
    ...(values.seasonal === undefined
      ? {}
      : {
          seasonal: {
            schemaVersion: 1,
            yearLengthMs: String(values.seasonal.yearLengthMs),
            seasons: values.seasonal.seasons.map(([name, startMs]) => ({
              name,
              startMs: String(startMs),
            })),
            conceptionSeasons: [...values.seasonal.conceptionSeasons],
          },
        }),
  };
  const ids = [...actorIds].sort(compare);
  const households = new Set<string>();
  for (const entity of sample.initialState.entities as Loose[])
    if (entity.needs !== undefined) entity.lifecycle = { status: "active" };
  sample.initialState.lifecycle = {
    households: [],
    entries: ids.map((objectId) => {
      const householdId = part.founderHousehold?.[objectId] ?? "den";
      households.add(householdId);
      const bornAt = part.founderBornAt?.[objectId] ?? 0;
      let stageIndex = 0;
      values.stages.forEach(([, startsAtAgeMs], index) => {
        if (-bornAt >= startsAtAgeMs) stageIndex = index;
      });
      return {
        objectId,
        householdId,
        parentIds: [],
        generation: 0,
        bornAt: String(bornAt),
        stageIndex,
        conceptions: 0,
        lastBirthAt: null,
        gestation: null,
        death: null,
      };
    }),
  };
  sample.initialState.lifecycle.households = [...households].sort(compare);
  return sample;
}

export function lifecycleSample(spec: LifecycleSpec): Loose {
  const sample = wellbeingSample(spec);
  sample.pack.packId = "clockgrove.fixture.lifecycle";
  return applyLifecycle(
    sample,
    spec,
    spec.actors.map(([objectId]) => objectId),
  );
}

// ---------------------------------------------------------------------------------------------
// Worlds and runs
// ---------------------------------------------------------------------------------------------

export interface LifeWorld {
  readonly template: WorldKernelInput;
  readonly state: WorldState;
  readonly schedules: ScheduleQueue<WorldScheduledPayload>;
  readonly random: NamedRandomState;
}

export interface LifeCall {
  readonly input: WorldKernelInput;
  readonly outcome: WorldKernelOutcome;
}

export interface LifeRun {
  readonly world: LifeWorld;
  readonly events: readonly WorldSemanticEvent[];
  readonly calls: readonly LifeCall[];
  readonly drafts: readonly unknown[];
}

export function lifecycleRandom(streams: readonly string[] = lifecycleStreams): NamedRandomState {
  return initializeNamedRandomStreams(lifecycleSeed, streams);
}

/** The lifecycle streams after extra draws on the `weather` and `behavior` streams. */
export function perturbedRandom(): NamedRandomState {
  let random = lifecycleRandom();
  for (let index = 0; index < 5; index += 1)
    random = drawNamedRandomStream(random, "weather").randomState;
  for (let index = 0; index < 3; index += 1)
    random = drawNamedRandomStream(random, "behavior").randomState;
  return random;
}

/** Builds a world from a loose scenario sample, with the lifecycle random streams. */
export async function lifeWorldFromSample(
  sample: Loose,
  random: NamedRandomState = lifecycleRandom(),
): Promise<LifeWorld> {
  const decoded = decodeWorldScenario(sample, await stateHash(sample));
  const environment = decoded.pack.policy.environment;
  if (environment === undefined) throw new Error("environment policy required");
  const initialState = createWorldState({
    ...decoded.initialState,
    environment: deriveEnvironmentState(environment, decoded.initialState.simulationTime),
  });
  const template = await scenarioInput(undefined, 0, 32, random, 32, {
    pack: decoded.pack,
    initialState,
  });
  return { template, state: template.partition.state, schedules: template.schedules, random };
}

export async function lifeWorld(
  spec: LifecycleSpec,
  random?: NamedRandomState,
): Promise<LifeWorld> {
  return lifeWorldFromSample(lifecycleSample(spec), random);
}

export function lifeInput(
  world: LifeWorld,
  id: string,
  target: bigint,
  maxInputs = 1024,
  maxEvents = 4096,
  continuation?: WorldContinuation,
): WorldKernelInput {
  if (world.template.input.kind !== "command") throw new Error("command template required");
  const command = {
    ...world.template.input.command,
    commandId: id as CommandId,
    type: "world.advance",
    expected: { partitionRevision: world.state.revision },
    payload: { schemaVersion: 1, targetTime: target as SimTimeMs, maxInputs, maxEvents },
  } as WorldCommand;
  return {
    ...world.template,
    partition: { ...world.template.partition, revision: world.state.revision, state: world.state },
    simulationTime: world.state.simulationTime,
    schedules: world.schedules,
    randomState: world.random,
    input: { kind: "command", command },
    ids: createDeterministicIdSource({
      commandId: command.commandId,
      eventIndex: 0,
      randomStream: "routine",
    }),
    ...(continuation === undefined ? {} : { continuation }),
  };
}

function refusalText(outcome: WorldKernelOutcome): string {
  return outcome.ok
    ? "ok"
    : `${outcome.error.code} ${outcome.error.path} ${outcome.error.check ?? ""}`;
}

/** One logical advance: chained continuation calls until it completes, threading the random state. */
export function lifeChain(
  start: LifeWorld,
  id: string,
  target: bigint,
  maxInputs = 1024,
  maxEvents = 4096,
): LifeRun {
  let input = lifeInput(start, id, target, maxInputs, maxEvents);
  let world = start;
  const events: WorldSemanticEvent[] = [];
  const calls: LifeCall[] = [];
  const drafts: unknown[] = [];
  for (let attempt = 0; attempt < 20000; attempt += 1) {
    const outcome = executeWorldKernel(input, { mode: "test" });
    calls.push({ input, outcome });
    if (!outcome.ok) throw new Error(refusalText(outcome));
    const result = outcome.result;
    events.push(...result.events);
    drafts.push(...result.decisionDrafts);
    world = {
      template: start.template,
      state: result.state,
      schedules: result.schedules,
      random: result.updatedRandomState,
    };
    if (result.complete) return { world, events, calls, drafts };
    if (result.continuation === undefined) throw new Error("incomplete call omitted continuation");
    input = {
      ...input,
      partition: { ...input.partition, revision: result.state.revision, state: result.state },
      simulationTime: result.state.simulationTime,
      schedules: result.schedules,
      randomState: result.updatedRandomState,
      continuation: result.continuation,
    };
  }
  throw new Error("bounded advance did not finish");
}

/** Live steps of at most `stepMs` each. */
export function lifeLive(start: LifeWorld, id: string, target: bigint, stepMs: bigint): LifeRun {
  let world = start;
  const events: WorldSemanticEvent[] = [];
  const calls: LifeCall[] = [];
  const drafts: unknown[] = [];
  for (let step = 0; world.state.simulationTime < target; step += 1) {
    const next = world.state.simulationTime + stepMs;
    const run = lifeChain(world, `${id}:live:${step}`, next < target ? next : target);
    events.push(...run.events);
    calls.push(...run.calls);
    drafts.push(...run.drafts);
    world = run.world;
  }
  return { world, events, calls, drafts };
}

export function lifeMaterial(
  events: readonly { type: string }[],
): { type: string; time: bigint; payload: unknown }[] {
  return (events as readonly WorldSemanticEvent[])
    .filter((event) => (LIFECYCLE_MATERIAL_TYPES as readonly string[]).includes(event.type))
    .map((event) => ({
      type: event.type,
      time: event.simulationTime as bigint,
      payload: event.payload,
    }));
}

export function lifeState(state: WorldState): unknown {
  return { ...state, revision: 0n };
}

export async function lifePairHash(run: LifeRun): Promise<string> {
  return stateHash({ events: lifeMaterial(run.events), state: lifeState(run.world.state) });
}

export async function lifeHashes(run: LifeRun) {
  return {
    materialEventHash: await stateHash(lifeMaterial(run.events)),
    finalStateHash: await stateHash(lifeState(run.world.state)),
  };
}

export function eventsOf(events: readonly { type: string }[], type: string): WorldSemanticEvent[] {
  return (events as readonly WorldSemanticEvent[]).filter((event) => event.type === type);
}

export const payloadOf = (event: WorldSemanticEvent): Loose => event.payload as unknown as Loose;
export const timeOf = (event: WorldSemanticEvent): bigint => event.simulationTime as bigint;

export function countsByType(events: readonly { type: string }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of events) counts[event.type] = (counts[event.type] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => compare(a, b)));
}

export function conceptionDecisions(drafts: readonly unknown[]): ConceptionDecision[] {
  return (drafts as readonly { kind: string; decision?: ConceptionDecision }[])
    .filter((draft) => draft.kind === "lifecycle.conception")
    .map((draft) => draft.decision as ConceptionDecision);
}

export function successResult(call: LifeCall) {
  if (!call.outcome.ok) throw new Error("successful call required");
  return call.outcome.result;
}

export const isLiving = (entity: WorldState["entities"][number]): boolean =>
  entity.needs !== undefined && entity.lifecycle?.status !== "dead";
export const livingOf = (state: WorldState) => state.entities.filter(isLiving);

// ---------------------------------------------------------------------------------------------
// Order and liveness checks
// ---------------------------------------------------------------------------------------------

/** Violations of the RW-0109 same-time order (empty = ordered). */
export function lifecycleOrderProblems(events: readonly WorldSemanticEvent[]): string[] {
  const problems: string[] = [];
  const keyOf = (event: WorldSemanticEvent): string => {
    const payload = payloadOf(event);
    return String(payload.objectId ?? payload.gestatingParentId ?? "");
  };
  // Deaths of one time group stay in object id order even when successor intents interleave.
  let lastDied: { time: bigint; key: string } | undefined;
  events.forEach((event, index) => {
    if (event.type !== "lifecycle.died") return;
    const key = keyOf(event);
    if (lastDied !== undefined && lastDied.time === event.simulationTime && lastDied.key > key)
      problems.push(`${index}: lifecycle.died not in object id order`);
    lastDied = { time: event.simulationTime, key };
  });
  for (let index = 1; index < events.length; index += 1) {
    const previous = events[index - 1]!;
    const event = events[index]!;
    if (previous.simulationTime !== event.simulationTime) continue;
    const before = LIFECYCLE_RANK[previous.type];
    const after = LIFECYCLE_RANK[event.type];
    if (before === undefined || after === undefined) continue;
    if (before > after) problems.push(`${index}: ${previous.type} precedes ${event.type}`);
    else if (before === after && previous.type === event.type && keyOf(previous) > keyOf(event))
      problems.push(`${index}: ${event.type} not in object id order`);
  }
  events.forEach((event, index) => {
    if (event.type !== "lifecycle.died") return;
    const next = events[index + 1];
    if (
      next?.type === "lifecycle.successor-intended" &&
      payloadOf(next).objectId === payloadOf(event).objectId
    )
      return;
    problems.push(`${index}: died without an immediate successor intent`);
  });
  return problems;
}

const DEAD_SUBJECT_TYPES = new Set([
  "routine.selected",
  "needs.changed",
  "wellbeing.integrated",
  "exposure.threshold-crossed",
  "needs.threshold-crossed",
  "comfort.changed",
  "health.threshold-crossed",
  "lifecycle.stage-changed",
  "lifecycle.conceived",
]);

/** Events that name an already dead actor as their subject (empty = none). */
export function deadSubjectProblems(events: readonly WorldSemanticEvent[]): string[] {
  const dead = new Set<string>();
  const problems: string[] = [];
  events.forEach((event, index) => {
    const payload = payloadOf(event);
    const subject = String(payload.objectId ?? "");
    if (
      dead.has(subject) &&
      (DEAD_SUBJECT_TYPES.has(event.type) || event.type.startsWith("movement."))
    )
      problems.push(`${index}: ${event.type} names dead ${subject}`);
    if (event.type === "lifecycle.born" && dead.has(String(payload.gestatingParentId)))
      problems.push(
        `${index}: born names dead gestating parent ${String(payload.gestatingParentId)}`,
      );
    if (event.type === "lifecycle.died") dead.add(subject);
  });
  return problems;
}

/** Object ids named by lifecycle event payloads that are not entities of `state`. */
export function unresolvedLifecycleIds(
  events: readonly WorldSemanticEvent[],
  state: WorldState,
): string[] {
  const known = new Set(state.entities.map((entity) => entity.objectId as string));
  const born = new Set(
    eventsOf(events, "lifecycle.born").map((event) => String(payloadOf(event).childId)),
  );
  const missing: string[] = [];
  const check = (id: unknown) => {
    if (id !== null && id !== undefined && !known.has(String(id))) missing.push(String(id));
  };
  for (const event of events) {
    if (!event.type.startsWith("lifecycle.")) continue;
    const payload = payloadOf(event);
    check(payload.objectId);
    check(payload.coParentId);
    check(payload.gestatingParentId);
    if (event.type === "lifecycle.born" || born.has(String(payload.childId)))
      check(payload.childId);
  }
  for (const entry of state.lifecycle?.entries ?? [])
    for (const parent of entry.parentIds) check(parent);
  return missing;
}

// ---------------------------------------------------------------------------------------------
// Golden and pairs
// ---------------------------------------------------------------------------------------------

export interface HouseholdGolden {
  readonly start: LifeWorld;
  readonly fast: LifeRun;
  readonly live: LifeRun;
  readonly chained: LifeRun;
}

let householdPromise: Promise<HouseholdGolden> | undefined;
async function buildHousehold(): Promise<HouseholdGolden> {
  const start = await lifeWorld(HOUSEHOLD_SPEC);
  return {
    start,
    fast: lifeChain(start, "household", HOUSEHOLD_HORIZON),
    live: lifeLive(start, "household", HOUSEHOLD_HORIZON, 1000n),
    chained: lifeChain(start, "household", HOUSEHOLD_HORIZON, 8, 32),
  };
}
export function householdGolden(): Promise<HouseholdGolden> {
  householdPromise ??= buildHousehold();
  return householdPromise;
}

export async function householdGoldenHashes(golden: HouseholdGolden) {
  return { name: "household-generations", ...(await lifeHashes(golden.fast)) };
}

export interface LifecyclePair {
  readonly name: string;
  readonly equivalence: typeof LIFECYCLE_EQUIVALENCE;
  readonly leftHash: string;
  readonly rightHash: string;
}

/** The lifecycle events, conception drafts and `lifecycle` stream state, independent of other streams. */
export async function lifecycleStreamHash(run: LifeRun): Promise<string> {
  return stateHash({
    events: (run.events as readonly WorldSemanticEvent[])
      .filter((event) => event.type.startsWith("lifecycle."))
      .map((event) => ({
        type: event.type,
        time: event.simulationTime as bigint,
        payload: event.payload,
      })),
    drafts: conceptionDecisions(run.drafts),
    stream: run.world.random.lifecycle,
  });
}

export async function lifecyclePairs(): Promise<LifecyclePair[]> {
  const golden = await householdGolden();
  const fast = await lifePairHash(golden.fast);
  const hooked = await lifeWorld(HOUSEHOLD_SEASON_SPEC);
  const perturbed = await lifeWorld(HOUSEHOLD_SPEC, perturbedRandom());
  return [
    {
      name: "live-steps-vs-fast-forward",
      equivalence: LIFECYCLE_EQUIVALENCE,
      leftHash: await lifePairHash(golden.live),
      rightHash: fast,
    },
    {
      name: "bounded-continuation-vs-unbounded",
      equivalence: LIFECYCLE_EQUIVALENCE,
      leftHash: await lifePairHash(golden.chained),
      rightHash: fast,
    },
    {
      name: "single-season-vs-no-hook",
      equivalence: LIFECYCLE_EQUIVALENCE,
      leftHash: await lifePairHash(lifeChain(hooked, "household", HOUSEHOLD_HORIZON)),
      rightHash: fast,
    },
    {
      name: "weather-perturbed-vs-baseline",
      equivalence: LIFECYCLE_EQUIVALENCE,
      leftHash: await lifecycleStreamHash(lifeChain(perturbed, "household", HOUSEHOLD_HORIZON)),
      rightHash: await lifecycleStreamHash(golden.fast),
    },
  ];
}
export const POLICY_PATH = "pack.pack.policy.lifecycle";
export const STATE_PATH = "partition.state.lifecycle";

// ---------------------------------------------------------------------------------------------
// Long runs
// ---------------------------------------------------------------------------------------------

export const DAY_MS = 86_400_000;
const DAY = BigInt(DAY_MS);

export const LONG_SPEC: LifecycleSpec = {
  dayLengthMs: DAY_MS,
  phases: [["only", 0, "all"]],
  segments: [[DAY_MS, 0, "dry"]],
  wetThreshold: 3000,
  discomfortThreshold: 6000,
  intervalMs: DAY_MS / 2,
  hungerPerInterval: 5,
  wetnessPerInterval: 1500,
  dryingPerInterval: 1000,
  actors: [
    ["a-resident", null],
    ["b-resident", null],
    ["c-resident", null],
    ["d-resident", null],
  ],
  founderBornAt: {
    "a-resident": 0,
    "b-resident": -3 * DAY_MS,
    "c-resident": -10 * DAY_MS,
    "d-resident": -21 * DAY_MS,
  },
  founderHousehold: {
    "a-resident": "den-east",
    "b-resident": "den-east",
    "c-resident": "den-west",
    "d-resident": "den-west",
  },
  wellbeing: CALM,
  lifecycle: {
    stages: [
      ["newborn", 0],
      ["juvenile", DAY_MS],
      ["adult", 3 * DAY_MS],
      ["elder", 20 * DAY_MS],
    ],
    lifespanMs: 28 * DAY_MS,
    deathHealth: 1000,
    fertileStages: ["adult"],
    conceptionIntervalMs: DAY_MS,
    conceptionChance: 1500,
    coParent: "none",
    gestationMs: 5 * DAY_MS,
    milestones: [["mid", 2 * DAY_MS]],
    cooldownMs: 4 * DAY_MS,
    maxPopulation: 6,
    successorRule: "heir",
  },
};

export const LONG_RUNS = [
  { name: "lifecycle-30-day", days: 30, stepDays: 1 },
  { name: "lifecycle-one-year", days: 365, stepDays: 5 },
] as const;

/** `events <= calls + 4 * decisions + 2 * material` (docs/lifecycle.md's declared event-volume bound). */
export function lifecycleEventBound(calls: number, decisions: number, material: number): number {
  return calls + 4 * decisions + 2 * material;
}

const isActive = (entity: WorldState["entities"][number]): boolean =>
  (entity.lifecycle?.status ?? "active") === "active";

function containmentProblems(state: WorldState): boolean {
  const byId = new Map(state.entities.map((entity) => [entity.objectId as string, entity]));
  for (const entity of state.entities) {
    const seen = new Set<string>([entity.objectId as string]);
    let current = entity;
    for (;;) {
      const containerId = current.containment?.containerId;
      if (containerId === undefined) break;
      const container = byId.get(containerId as string);
      if (container === undefined || seen.has(container.objectId as string)) return true;
      if (isActive(entity) && !isActive(container)) return true;
      seen.add(container.objectId as string);
      current = container;
    }
  }
  return false;
}

const RESOURCE_KINDS = ["food", "water"] as const;
function resourceChanges(events: readonly WorldSemanticEvent[]): Record<string, bigint> {
  const changes: Record<string, bigint> = { food: 0n, water: 0n };
  for (const event of events as readonly Loose[]) {
    const payload = event.payload;
    switch (event.type) {
      case "object.created":
        if (payload.object.resource !== undefined)
          changes[payload.object.resource.kind]! += BigInt(payload.quantityAdded);
        break;
      case "object.retired":
        if (payload.kind !== null) changes[payload.kind]! -= BigInt(payload.quantityRemoved);
        break;
      case "resource.offered":
      case "resource.appeared":
        changes[payload.kind]! += BigInt(payload.quantity);
        break;
      case "resource.consumed":
      case "resource.spoiled":
        changes[payload.kind]! -= BigInt(payload.quantity);
        break;
    }
  }
  return changes;
}

const CLIENT_KEYS = ["detailLevel", "eventId", "modality", "sourceRevision", "spaceId", "viewerId"];

export interface PerceptionProbe {
  readonly perceivableEvents: number;
  readonly privateLeaks: number;
  readonly lifecycleTypesPerceivable: number;
  readonly lifecycleRefused: number;
}

/** Runs every perceivable event and one event of each lifecycle type through the perception resolver. */
export function perceptionProbe(
  events: readonly WorldSemanticEvent[],
  state: WorldState,
): PerceptionProbe {
  const actor = state.entities.find((entity) => entity.needs !== undefined);
  const policy = {
    version: 2,
    modalities: [{ modality: "sight", range: 3000 }],
    occlusions: [],
    access: [],
    subscribers: [],
    viewers: [{ viewerId: "viewer:ui", subscribed: true }],
  };
  const eventFor = (event: WorldSemanticEvent) => ({
    version: 1,
    type: event.type,
    eventId: String(event.eventId),
    modality: "sight",
    sourceRevision: state.revision,
    spaceId: actor?.spaceId,
    actorId: actor?.objectId,
    targetId: null,
    regionIds: [],
  });
  let perceivableEvents = 0;
  let privateLeaks = 0;
  let lifecycleRefused = 0;
  const seenLifecycle = new Set<string>();
  for (const event of events) {
    if ((PERCEIVABLE_EVENT_TYPES as readonly string[]).includes(event.type)) {
      perceivableEvents += 1;
      const outcome = resolveAudience(eventFor(event), state, policy);
      if (outcome.ok) {
        const private_ = new Set(
          outcome.value.perceptions.map((perception) => perception.observerId),
        );
        for (const input of outcome.value.clientInterest.inputs) {
          if (
            Object.keys(input).some((key) => !CLIENT_KEYS.includes(key)) ||
            private_.has(input.viewerId)
          )
            privateLeaks += 1;
        }
      }
    } else if (event.type.startsWith("lifecycle.") && !seenLifecycle.has(event.type)) {
      seenLifecycle.add(event.type);
      const outcome = resolveAudience(eventFor(event), state, policy);
      if (!outcome.ok && outcome.error.code === "unsupported-input") lifecycleRefused += 1;
    }
  }
  return {
    perceivableEvents,
    privateLeaks,
    lifecycleTypesPerceivable: LIFECYCLE_EVENT_TYPES.filter((type) =>
      (PERCEIVABLE_EVENT_TYPES as readonly string[]).includes(type),
    ).length,
    lifecycleRefused,
  };
}

export interface LongRun {
  readonly name: string;
  readonly days: number;
  readonly stepDays: number;
  readonly logicalCalls: number;
  readonly kernelCalls: number;
  readonly eventTotal: number;
  readonly decisions: number;
  readonly material: number;
  readonly eventBound: number;
  readonly counts: Record<string, number>;
  readonly maxLiving: number;
  readonly finalLiving: number;
  readonly finalDead: number;
  readonly born: number;
  readonly died: number;
  readonly problems: readonly string[];
  readonly populationHash: string;
  readonly lifecycleHash: string;
  readonly resourceHash: string;
  readonly finalStateHash: string;
  readonly replayEqual: boolean;
  readonly probe: PerceptionProbe;
  readonly start: LifeWorld;
  readonly world: LifeWorld;
  readonly events: readonly WorldSemanticEvent[];
}

/** Advances the long-run fixture through `days` environment days in calls of `stepDays` days. */
export async function lifeLongRun(name: string, days: number, stepDays: number): Promise<LongRun> {
  const start = await lifeWorld(LONG_SPEC);
  const lifecycle = start.template.pack.pack.policy.lifecycle!;
  const maxPopulation = lifecycle.reproduction.maxPopulation;
  const problems = new Set<string>();
  const flag = (what: string, bad: boolean): void => {
    if (bad) problems.add(what);
  };
  let world = start;
  const events: WorldSemanticEvent[] = [];
  const population: unknown[] = [];
  const resourceTrail: unknown[] = [];
  let kernelCalls = 0;
  /** Routine decisions run, journaled or not (an unchanged one journals nothing, issue 629). */
  let decisions = 0;
  let maxLiving = 0;
  let logicalCalls = 0;
  const initialTotals = worldResourceTotals(start.state);
  for (let day = 0; day < days; day += stepDays) {
    const target = BigInt(Math.min(days, day + stepDays)) * DAY;
    const run = lifeChain(world, `${name}:${logicalCalls}`, target);
    logicalCalls += 1;
    for (const call of run.calls) {
      kernelCalls += 1;
      const result = successResult(call);
      decisions += result.decisionDrafts.filter((draft) => draft.kind === "routine").length;
      const living = livingOf(result.state);
      maxLiving = Math.max(maxLiving, living.length);
      flag("population-cap", living.length > maxPopulation);
      const ids = result.schedules.map((item) => item.id as string);
      flag("schedule-ids-unique", new Set(ids).size !== ids.length);
      flag("queue-matches-living", ids.length !== living.length || ids.length > maxPopulation);
      flag(
        "resources-non-negative",
        result.state.entities.some((entity) => (entity.resource?.quantity ?? 0) < 0),
      );
      flag("containment", containmentProblems(result.state));
    }
    events.push(...run.events);
    world = run.world;
    const living = livingOf(world.state).length;
    population.push([
      String(world.state.simulationTime),
      living,
      world.state.entities.filter((e) => e.needs !== undefined).length - living,
    ]);
    const totals = worldResourceTotals(world.state);
    resourceTrail.push([
      String(world.state.simulationTime),
      ...RESOURCE_KINDS.map((kind) => String(totals[kind] ?? 0n)),
    ]);
  }
  const bornEvents = eventsOf(events, "lifecycle.born");
  const diedEvents = eventsOf(events, "lifecycle.died");
  flag(
    "born-unique",
    new Set(bornEvents.map((event) => payloadOf(event).childId)).size !== bornEvents.length,
  );
  flag(
    "died-unique",
    new Set(diedEvents.map((event) => payloadOf(event).objectId)).size !== diedEvents.length,
  );
  const known = new Set(world.state.entities.map((entity) => entity.objectId as string));
  flag(
    "routine-selected-resolves",
    eventsOf(events, "routine.selected").some((event) => {
      const payload = payloadOf(event);
      return (
        !known.has(String(payload.objectId)) ||
        (payload.targetObjectId != null && !known.has(String(payload.targetObjectId)))
      );
    }),
  );
  flag("order", lifecycleOrderProblems(events).length > 0);
  flag("dead-subjects", deadSubjectProblems(events).length > 0);
  flag("ids-resolve", unresolvedLifecycleIds(events, world.state).length > 0);
  const finalTotals = worldResourceTotals(world.state);
  const changes = resourceChanges(events);
  for (const kind of RESOURCE_KINDS)
    flag(
      "resource-conservation",
      (finalTotals[kind] ?? 0n) - (initialTotals[kind] ?? 0n) !== changes[kind],
    );
  const counts = countsByType(events);
  const material = lifeMaterial(events).length;
  const eventBound = lifecycleEventBound(kernelCalls, decisions, material);
  flag("event-bound", events.length > eventBound);
  const replayed = replayWorldEvents(start.state, events as never);
  const finalStateHash = await stateHash(lifeState(world.state));
  const lifecycleCounts = Object.fromEntries(
    Object.entries(counts).filter(([type]) => type.startsWith("lifecycle.")),
  );
  const probe = perceptionProbe(events, world.state);
  flag("perception", probe.privateLeaks !== 0 || probe.lifecycleTypesPerceivable !== 0);
  return {
    name,
    days,
    stepDays,
    logicalCalls,
    kernelCalls,
    eventTotal: events.length,
    decisions,
    material,
    eventBound,
    counts,
    maxLiving,
    finalLiving: livingOf(world.state).length,
    finalDead: world.state.entities.filter(
      (entity) => entity.needs !== undefined && !isLiving(entity),
    ).length,
    born: bornEvents.length,
    died: diedEvents.length,
    problems: [...problems].sort(compare),
    populationHash: await stateHash(population),
    lifecycleHash: await stateHash({
      counts: lifecycleCounts,
      births: bornEvents.map((event) => [String(payloadOf(event).childId), String(timeOf(event))]),
      deaths: diedEvents.map((event) => [
        String(payloadOf(event).objectId),
        String(timeOf(event)),
        String(payloadOf(event).cause),
      ]),
      generations: (world.state.lifecycle?.entries ?? []).map((entry) => [
        entry.objectId,
        entry.generation,
      ]),
    }),
    resourceHash: await stateHash({
      trail: resourceTrail,
      initial: RESOURCE_KINDS.map((kind) => String(initialTotals[kind] ?? 0n)),
      final: RESOURCE_KINDS.map((kind) => String(finalTotals[kind] ?? 0n)),
      changes: RESOURCE_KINDS.map((kind) => String(changes[kind])),
    }),
    finalStateHash,
    replayEqual: (await stateHash(replayed)) === (await stateHash(world.state)),
    probe,
    start,
    world,
    events,
  };
}

const longPromises = new Map<string, Promise<LongRun>>();
export function longRunOf(name: string): Promise<LongRun> {
  const spec = LONG_RUNS.find((candidate) => candidate.name === name);
  if (spec === undefined) throw new Error(`unknown long run ${name}`);
  let promise = longPromises.get(name);
  if (promise === undefined) {
    promise = lifeLongRun(spec.name, spec.days, spec.stepDays);
    longPromises.set(name, promise);
  }
  return promise;
}

// ---------------------------------------------------------------------------------------------
// Evidence section
// ---------------------------------------------------------------------------------------------

const lifecycleTypes = (events: readonly WorldSemanticEvent[]) =>
  events.filter((event) => event.type.startsWith("lifecycle."));

/** A compact canonical projection of a final state: time, entities, lifecycle entries and households. */
function finalProjection(state: WorldState): Loose {
  const lifecycle = state.lifecycle;
  return {
    simulationTime: String(state.simulationTime),
    entities: [...state.entities]
      .map((entity) => [
        String(entity.objectId),
        String(entity.archetypeId),
        String((entity as unknown as Loose).lifecycle?.status ?? "none"),
      ])
      .sort((left, right) => compare(left[0]!, right[0]!)),
    households: lifecycle === undefined ? [] : [...lifecycle.households].map(String),
    entries: (lifecycle?.entries ?? []).map((entry) => [
      String(entry.objectId),
      String(entry.householdId),
      entry.parentIds.map(String),
      entry.generation,
      String(entry.bornAt),
      entry.stageIndex,
      entry.conceptions,
      entry.lastBirthAt === null ? null : String(entry.lastBirthAt),
      entry.gestation === null
        ? null
        : [
            String(entry.gestation.conceivedAt),
            String(entry.gestation.dueAt),
            entry.gestation.coParentId === null ? null : String(entry.gestation.coParentId),
            String(entry.gestation.childId),
            entry.gestation.milestoneIndex,
          ],
      entry.death === null ? null : [String(entry.death.diedAt), entry.death.cause],
    ]),
  };
}

async function describeRun(name: string, run: LifeRun, start: LifeWorld) {
  const mutations: unknown[] = [];
  const commands: unknown[] = [];
  for (const call of run.calls) {
    const stimulus = call.input.input;
    if (stimulus.kind === "command")
      commands.push([
        "command",
        stimulus.command.type,
        String(stimulus.command.commandId),
        String((stimulus.command.payload as unknown as Loose).targetTime),
      ]);
    else
      commands.push(["scheduled", stimulus.scheduled.type, String(stimulus.scheduled.scheduleId)]);
    for (const mutation of successResult(call).scheduleMutations as readonly Loose[])
      mutations.push([
        mutation.kind,
        String(mutation.scheduleId),
        mutation.dueAt === undefined ? null : String(mutation.dueAt),
      ]);
  }
  const hashes = await lifeHashes(run);
  const streamHash = async (world: LifeWorld) => ({
    draws: String(world.random.lifecycle?.draws ?? 0n),
    hash: await stateHash(world.random.lifecycle ?? null),
  });
  return {
    name,
    engine: "clockgrove-world-kernel",
    commands,
    events: run.events.map((event) => [event.type, 1, String(event.simulationTime)]),
    scheduleMutations: mutations,
    remainingDeadlines: run.world.schedules.map((item) => [String(item.id), String(item.dueAt)]),
    conception: conceptionDecisions(run.drafts).map((decision) => [
      String(decision.objectId),
      String(decision.simulationTime),
      decision.exclusion,
      decision.draw === null
        ? null
        : [String(decision.draw.drawIndex), String(decision.draw.rawValue), decision.draw.value],
      decision.outcome,
      decision.childId === null ? null : String(decision.childId),
      [decision.stageIndex, decision.stageName, decision.conceptionChance],
    ]),
    finalProjection: finalProjection(run.world.state),
    streamBefore: await streamHash(start),
    streamAfter: await streamHash(run.world),
    finalStateHash: hashes.finalStateHash,
    materialEventHash: hashes.materialEventHash,
    eventCounts: countsByType(run.events),
  };
}

export const EVIDENCE_RUNS: ReadonlyArray<readonly [string, LifecycleSpec, bigint]> = [
  ["sure", SURE_SPEC, SURE_HORIZON],
  ["young", YOUNG_SPEC, 4000n],
  ["cap", CAP_SPEC, 4000n],
  ["no-co-parent", NO_CO_PARENT_SPEC, 4000n],
  ["pair", PAIR_SPEC, 8000n],
  ["season", SEASON_SPEC, 8000n],
  ["sick", SICK_SPEC, 6000n],
  ["coincide", COINCIDE_SPEC, 3000n],
];

export async function lifecycleAssertions(
  golden: HouseholdGolden,
  pairs: readonly LifecyclePair[],
  longRuns: readonly LongRun[],
): Promise<{ name: string; ok: boolean }[]> {
  const events = golden.fast.events;
  const final = golden.fast.world.state;
  const replayed = replayWorldEvents(golden.start.state, events as never);
  const assertions: { name: string; ok: boolean }[] = [
    {
      name: "golden-replay-equals-final-state",
      ok: (await stateHash(replayed)) === (await stateHash(final)),
    },
    { name: "golden-order", ok: lifecycleOrderProblems(events).length === 0 },
    { name: "golden-dead-subjects", ok: deadSubjectProblems(events).length === 0 },
    { name: "golden-ids-resolve", ok: unresolvedLifecycleIds(events, final).length === 0 },
    {
      name: "golden-dead-retained",
      ok: eventsOf(events, "lifecycle.died").every((event) =>
        final.lifecycle!.entries.some(
          (entry) => entry.objectId === payloadOf(event).objectId && entry.death !== null,
        ),
      ),
    },
    {
      name: "golden-queue-matches-living",
      ok: golden.fast.world.schedules.length === livingOf(final).length,
    },
    { name: "pairs-equal", ok: pairs.every((pair) => pair.leftHash === pair.rightHash) },
  ];
  for (const run of longRuns) {
    assertions.push({ name: `${run.name}-invariants`, ok: run.problems.length === 0 });
    assertions.push({
      name: `${run.name}-population-cap`,
      ok: run.maxLiving <= LONG_SPEC.lifecycle.maxPopulation,
    });
    assertions.push({ name: `${run.name}-replay`, ok: run.replayEqual });
    assertions.push({ name: `${run.name}-event-bound`, ok: run.eventTotal <= run.eventBound });
  }
  return assertions;
}

export async function lifecycleEvidence() {
  const golden = await householdGolden();
  const identity = worldRegistryIdentity();
  const pack = golden.start.template.pack.pack;
  const runs = [await describeRun("household-generations", golden.fast, golden.start)];
  for (const [name, spec, horizon] of EVIDENCE_RUNS) {
    const start = await lifeWorld(spec);
    runs.push(await describeRun(name, lifeChain(start, `evidence:${name}`, horizon), start));
  }
  const pairs = await lifecyclePairs();
  const longRuns = [];
  const longs: LongRun[] = [];
  for (const spec of LONG_RUNS) {
    const run = await longRunOf(spec.name);
    longs.push(run);
    longRuns.push({
      name: run.name,
      days: run.days,
      stepDays: run.stepDays,
      logicalCalls: run.logicalCalls,
      kernelCalls: run.kernelCalls,
      eventTotal: run.eventTotal,
      decisions: run.decisions,
      material: run.material,
      eventBound: run.eventBound,
      counts: run.counts,
      maxLiving: run.maxLiving,
      finalLiving: run.finalLiving,
      finalDead: run.finalDead,
      born: run.born,
      died: run.died,
      problems: [...run.problems],
      populationHash: run.populationHash,
      lifecycleHash: run.lifecycleHash,
      resourceHash: run.resourceHash,
      finalStateHash: run.finalStateHash,
      streamBefore: await stateHash(lifecycleRandom().lifecycle ?? null),
      streamAfter: await stateHash(run.world.random.lifecycle ?? null),
    });
  }
  return {
    schemaVersion: 1,
    seed: lifecycleSeed,
    versions: {
      kernelRegistryHash: await stateHash({ commands: identity.commands, events: identity.events }),
      lifecycleReducers: identity.reducers.filter(([type]) => type.startsWith("lifecycle.")),
      prng: { contract: RANDOM_CONTRACT_VERSION, algorithm: RANDOM_ALGORITHM },
      pack: { packId: pack.packId, packVersion: pack.packVersion, contentHash: pack.contentHash },
      policy: { version: pack.policy.version, contentHash: await stateHash(pack.policy) },
    },
    runs,
    longRuns,
    pairs,
    assertions: await lifecycleAssertions(golden, pairs, longs),
    golden: await householdGoldenHashes(golden),
  };
}

export type { InitialNeeds, WorldSemanticEvent };
export { environmentSample, lifecycleTypes };
