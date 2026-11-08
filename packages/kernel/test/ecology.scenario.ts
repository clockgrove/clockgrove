import type { SimTimeMs } from "@clockgrove/contracts";
import {
  createWorldState,
  decodeWorldScenario,
  deriveEnvironmentState,
  type WorldBehaviorPolicy,
  type WorldNeeds,
  type WorldState,
} from "@clockgrove/domain";
import { canonicalSerialize } from "../src/canonical.js";
import { REFUSAL_CODES, type Refusal, RefusalSignal, refusal } from "../src/execute/refusal.js";
import { drawNamedRandomStream, initializeNamedRandomStreams } from "../src/random.js";
import { createCatchUpRegistry } from "../src/scheduler/catch-up.js";
import { createSpoilageSystem, holderSystemState } from "../src/systems/ecology/index.js";
import { catchUpEnvironment } from "../src/systems/environment/index.js";
import {
  checkWorldInvariants,
  executeWorldKernel,
  integrateNeedsWith,
  type WorldKernelInput,
  type WorldKernelOutcome,
  type WorldSemanticEvent,
  worldResourceTotals,
} from "../src/world.js";
import { containmentInput, containmentInputIdentity } from "./containment.scenario.js";
import {
  advanceInput,
  applyCommand,
  commandInput,
  decisionTimesOf,
  type EnvironmentSpec,
  type EnvironmentWorld,
  environmentSample,
  type Run,
  runChain,
  runLive,
  weatherInput,
} from "./environment.scenario.js";
import { scenarioInput, stateHash } from "./weather-needs.scenario.js";

// biome-ignore lint: deliberately loose, hostile inputs are built from plain data
export type Loose = Record<string, any>;

export const ecologySeed = { version: 1, seed: "ecology-resources-v1" } as const;
export const ecologyStreams = ["behavior"] as const;

/** The `material-ecology` view: these events by type, time and payload, plus the final state. */
export const ECOLOGY_MATERIAL_TYPES = [
  "environment.phase-changed",
  "weather.transitioned",
  "exposure.threshold-crossed",
  "resource.spoiled",
  "resource.appeared",
  "growth.stage-changed",
  "routine.selected",
] as const;
/** Same-time rank: phase and weather, exposure, spoilage, appearance, stage change, decision. */
export const ECOLOGY_RANK: Readonly<Record<string, number>> = {
  "environment.phase-changed": 0,
  "weather.transitioned": 1,
  "exposure.threshold-crossed": 2,
  "resource.spoiled": 3,
  "resource.appeared": 4,
  "growth.stage-changed": 5,
  "routine.selected": 6,
};

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

export type ResourceKind = "food" | "water";
export type Status = "active" | "retired" | "dead";

export interface HolderSpec {
  readonly objectId: string;
  readonly kind: ResourceKind;
  readonly quantity: number;
  /** Arrival time of the food a perishable holder starts with; defaults to 0. */
  readonly arrivedAt?: number;
  readonly status?: Status;
}

export interface PlantSpec {
  readonly objectId: string;
  readonly bands: readonly string[];
  readonly stages: readonly (readonly [name: string, thresholdMs: number])[];
  /** A number places the plant in a shelter with that rain protection. */
  readonly protection: number | null;
  readonly status?: Status;
}

export interface EcologySpec extends EnvironmentSpec {
  readonly holders: readonly HolderSpec[];
  readonly sources: readonly (readonly [
    objectId: string,
    kind: ResourceKind,
    firstAtMs: number,
    periodMs: number,
    quantity: number,
  ])[];
  readonly perishables: readonly (readonly [objectId: string, shelfLifeMs: number])[];
  readonly plants: readonly PlantSpec[];
}

/** Small dry fixture the targeted tests vary; one needs actor decides every second. */
export function baseSpec(overrides: Partial<EcologySpec> = {}): EcologySpec {
  return {
    dayLengthMs: 10000,
    phases: [
      ["night", 0, "dark"],
      ["day", 2000, "bright"],
      ["dusk", 8000, "dim"],
    ],
    segments: [[10000, 0, "mild"]],
    wetThreshold: 3000,
    discomfortThreshold: 6000,
    intervalMs: 1000,
    hungerPerInterval: 5,
    wetnessPerInterval: 1500,
    dryingPerInterval: 1000,
    actors: [["forager", null]],
    holders: [],
    sources: [],
    perishables: [],
    plants: [],
    ...overrides,
  };
}

/** One perishable food source and one water source over a dry, rain, dry series. */
export const FOOD_SPEC: EcologySpec = baseSpec({
  dayLengthMs: 10000,
  phases: [["only", 0, "all"]],
  segments: [
    [5000, 0, "mild"],
    [2500, 10000, "wet"],
    [2500, 0, "mild"],
  ],
  intervalMs: 2000,
  holders: [
    { objectId: "food-bowl", kind: "food", quantity: 0 },
    { objectId: "water-bowl", kind: "water", quantity: 0 },
  ],
  sources: [
    ["food-bowl", "food", 1000, 4000, 10],
    ["water-bowl", "water", 500, 3000, 6],
  ],
  perishables: [["food-bowl", 3000]],
});

export const CEDAR_STAGES = [
  ["seedling", 0],
  ["sapling", 2000],
  ["pole", 5000],
  ["mature", 7500],
] as const;

/** One exposed cedar and one cedar in a fully protecting shelter; rain falls in daylight. */
export const CEDAR_SPEC: EcologySpec = baseSpec({
  dayLengthMs: 8000,
  phases: [
    ["night", 0, "dark"],
    ["dawn", 1000, "dim"],
    ["day", 2000, "bright"],
    ["dusk", 6000, "dim"],
    ["evening", 7000, "dark"],
  ],
  segments: [
    [2500, 0, "dry"],
    [3000, 10000, "rain"],
    [2500, 0, "dry"],
  ],
  intervalMs: 2000,
  wetnessPerInterval: 5000,
  actors: [],
  plants: [
    { objectId: "exposed-cedar", bands: ["dim", "bright"], stages: CEDAR_STAGES, protection: null },
    {
      objectId: "sheltered-cedar",
      bands: ["dim", "bright"],
      stages: CEDAR_STAGES,
      protection: 10000,
    },
  ],
});
export const CEDAR_END = 24000n;

/** Every material kind in one fixture: food, water, plants, an actor and rain. */
export const MIXED_SPEC: EcologySpec = baseSpec({
  ...CEDAR_SPEC,
  actors: [["forager", null]],
  holders: FOOD_SPEC.holders,
  sources: [
    ["food-bowl", "food", 1000, 4000, 10],
    ["water-bowl", "water", 500, 3000, 6],
  ],
  perishables: [["food-bowl", 3000]],
});
export const MIXED_END = 24000n;

/** A perishable holder with food, an empty one, a plain holder, and a source that is a holder. */
export const BATCH_SPEC: EcologySpec = baseSpec({
  holders: [
    { objectId: "full-bowl", kind: "food", quantity: 6 },
    { objectId: "empty-bowl", kind: "food", quantity: 0 },
    { objectId: "spare-bowl", kind: "food", quantity: 0 },
    { objectId: "plain-crate", kind: "food", quantity: 5 },
  ],
  perishables: [
    ["full-bowl", 5000],
    ["empty-bowl", 5000],
    ["spare-bowl", 5000],
  ],
});

/** Most of the refusal inputs mutate this world: two of every ecology list entry. */
export const REFUSAL_SPEC: EcologySpec = baseSpec({
  holders: [
    { objectId: "food-bowl", kind: "food", quantity: 5 },
    { objectId: "water-bowl", kind: "water", quantity: 0 },
    { objectId: "keeper-bowl", kind: "food", quantity: 0 },
  ],
  sources: [
    ["food-bowl", "food", 50000, 10000, 7],
    ["water-bowl", "water", 60000, 10000, 3],
  ],
  perishables: [
    ["food-bowl", 6000],
    ["keeper-bowl", 6000],
  ],
  plants: [
    {
      objectId: "cedar-a",
      bands: ["bright"],
      stages: [
        ["seed", 0],
        ["sprout", 1000],
        ["tree", 3000],
      ],
      protection: null,
    },
    {
      objectId: "cedar-b",
      bands: ["bright"],
      stages: [
        ["seed", 0],
        ["sprout", 1000],
        ["tree", 3000],
      ],
      protection: 10000,
    },
  ],
});
export const REFUSAL_TIME = 5000n;

/** One non-perishable source whose appearances the exception sweeps drive. */
export const EXCEPTION_SPEC: EcologySpec = baseSpec({
  segments: [[100000, 0, "mild"]],
  holders: [{ objectId: "bowl", kind: "food", quantity: 0 }],
  sources: [["bowl", "food", 500, 1000, 3]],
});

/** JSON-form scenario (the historical decoder input) for a spec. */
export function ecologySample(spec: EcologySpec): Loose {
  const sample = environmentSample(spec);
  sample.pack.packId = "clockgrove.fixture.ecology";
  sample.pack.archetypes = [...sample.pack.archetypes, "reference.cedar@1", "reference.bowl@1"];
  const pose = { frameId: "zone-ground", frameVersion: 1, coordinates: ["0", "0"] };
  const present = new Set<string>(
    sample.initialState.entities.map((entity: Loose) => entity.objectId),
  );
  for (const plant of spec.plants) {
    if (plant.protection === null || present.has(`shelter-${plant.protection}`)) continue;
    present.add(`shelter-${plant.protection}`);
    sample.initialState.entities.push({
      objectId: `shelter-${plant.protection}`,
      archetypeId: "reference.shelter@1",
      pose,
      shelter: { rainProtection: plant.protection },
      spaceId: "zone",
    });
  }
  for (const holder of spec.holders)
    sample.initialState.entities.push({
      objectId: holder.objectId,
      archetypeId: "reference.bowl@1",
      pose,
      spaceId: "zone",
      resource: { kind: holder.kind, quantity: holder.quantity },
      ...(holder.status === undefined ? {} : { lifecycle: { status: holder.status } }),
    });
  for (const plant of spec.plants)
    sample.initialState.entities.push({
      objectId: plant.objectId,
      archetypeId: "reference.cedar@1",
      pose,
      spaceId: "zone",
      ...(plant.protection === null ? {} : { locationId: `shelter-${plant.protection}` }),
      ...(plant.status === undefined ? {} : { lifecycle: { status: plant.status } }),
    });
  sample.pack.policy.ecology = {
    schemaVersion: 1,
    sources: spec.sources.map(([objectId, kind, firstAtMs, periodMs, quantity]) => ({
      objectId,
      kind,
      firstAtMs: String(firstAtMs),
      periodMs: String(periodMs),
      quantity,
    })),
    perishables: spec.perishables.map(([objectId, shelfLifeMs]) => ({
      objectId,
      shelfLifeMs: String(shelfLifeMs),
    })),
    plants: spec.plants.map((plant) => ({
      objectId: plant.objectId,
      growingLightBands: [...plant.bands],
      stages: plant.stages.map(([name, thresholdMs]) => ({
        name,
        thresholdMs: String(thresholdMs),
      })),
    })),
  };
  sample.initialState.ecology = {
    perishables: spec.perishables.map(([objectId]) => {
      const holder = spec.holders.find((candidate) => candidate.objectId === objectId);
      return {
        objectId,
        arrivedAt:
          holder !== undefined && holder.quantity > 0 ? String(holder.arrivedAt ?? 0) : null,
      };
    }),
    plants: spec.plants.map((plant) => ({
      objectId: plant.objectId,
      stage: 0,
      growingMs: "0",
      wetness: 0,
      wetnessRemainder: "0",
      integratedAt: "0",
    })),
  };
  return sample;
}

/** Builds a world whose environment record is the one its policy derives at time 0. */
export async function ecologyWorld(spec: EcologySpec): Promise<EnvironmentWorld> {
  const sample = ecologySample(spec);
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

export function policyOf(world: EnvironmentWorld): WorldBehaviorPolicy {
  return world.template.pack.pack.policy;
}

/** A containment or resource command against the world's current state. */
export function resourceCommand(
  world: EnvironmentWorld,
  type: "resource.consume" | "resource.offer" | "resource.transfer",
  payload: Loose,
  id: string,
): WorldKernelInput {
  const base = advanceInput(world, `${id}:base`, world.state.simulationTime);
  return containmentInput(
    base,
    type,
    { schemaVersion: 1, ...payload },
    id,
  ) as unknown as WorldKernelInput;
}

export function runResource(
  world: EnvironmentWorld,
  type: "resource.consume" | "resource.offer" | "resource.transfer",
  payload: Loose,
  id: string,
): Run {
  return applyCommand(world, resourceCommand(world, type, payload, id));
}

export function advance(
  world: EnvironmentWorld,
  id: string,
  target: bigint,
  maxInputs = 1024,
  maxEvents = 4096,
): Run {
  return runChain(world, id, target, maxInputs, maxEvents);
}

export { weatherInput };

// ---------------------------------------------------------------------------------------------
// Material views, totals and holder reads
// ---------------------------------------------------------------------------------------------

export function ecologyMaterial(
  events: readonly { type: string }[],
): { type: string; time: bigint; payload: unknown }[] {
  return (events as readonly WorldSemanticEvent[])
    .filter((event) => (ECOLOGY_MATERIAL_TYPES as readonly string[]).includes(event.type))
    .map((event) => ({
      type: event.type,
      time: event.simulationTime as bigint,
      payload: event.payload,
    }));
}

export function ecologyMaterialState(state: WorldState): unknown {
  return { ...state, revision: 0n };
}

export async function ecologyHashes(events: readonly { type: string }[], state: WorldState) {
  return {
    materialEventHash: await stateHash(ecologyMaterial(events)),
    finalStateHash: await stateHash(ecologyMaterialState(state)),
  };
}

export async function ecologyPairHash(run: Run): Promise<string> {
  return stateHash({
    events: ecologyMaterial(run.events),
    state: ecologyMaterialState(run.world.state),
  });
}

export function quantityOf(state: WorldState, objectId: string): number {
  const entity = state.entities.find((candidate) => candidate.objectId === objectId);
  if (entity?.resource === undefined) throw new Error(`no resource on ${objectId}`);
  return entity.resource.quantity;
}

export function arrivalOf(state: WorldState, objectId: string): bigint | null {
  const entry = state.ecology?.perishables.find((candidate) => candidate.objectId === objectId);
  if (entry === undefined) throw new Error(`no perishable entry for ${objectId}`);
  return entry.arrivedAt;
}

export function plantEntry(state: WorldState, objectId: string) {
  const entry = state.ecology?.plants.find((candidate) => candidate.objectId === objectId);
  if (entry === undefined) throw new Error(`no plant entry for ${objectId}`);
  return entry;
}

export function totalsOf(state: WorldState): Record<"food" | "water", bigint> {
  const totals = worldResourceTotals(state);
  return { food: totals.food ?? 0n, water: totals.water ?? 0n };
}

/** The per-kind change the events record, by the conservation rule. */
export function recordedChange(
  events: readonly { type: string; payload: unknown }[],
): Record<"food" | "water", bigint> {
  const change: Record<"food" | "water", bigint> = { food: 0n, water: 0n };
  for (const event of events) {
    const payload = event.payload as Loose;
    switch (event.type) {
      case "object.created":
        if (payload.object.resource !== undefined)
          change[payload.object.resource.kind as ResourceKind] += BigInt(payload.quantityAdded);
        break;
      case "object.retired":
        if (payload.kind !== null)
          change[payload.kind as ResourceKind] -= BigInt(payload.quantityRemoved);
        break;
      case "resource.offered":
      case "resource.appeared":
        change[payload.kind as ResourceKind] += BigInt(payload.quantity);
        break;
      case "resource.consumed":
      case "resource.spoiled":
        change[payload.kind as ResourceKind] -= BigInt(payload.quantity);
        break;
    }
  }
  return change;
}

export function only<T extends string>(
  events: readonly { type: string }[],
  type: T,
): WorldSemanticEvent[] {
  return (events as readonly WorldSemanticEvent[]).filter((event) => event.type === type);
}

// ---------------------------------------------------------------------------------------------
// Independent oracles (do not call the engine systems)
// ---------------------------------------------------------------------------------------------

function bandAt(spec: EcologySpec, time: number): string {
  const offset = time % spec.dayLengthMs;
  let band = spec.phases[0]![2];
  for (const [, start, lightBand] of spec.phases) if (start <= offset) band = lightBand;
  return band;
}

function rainAt(spec: EcologySpec, time: number): number {
  const cycle = spec.segments.reduce((total, [duration]) => total + duration, 0);
  let offset = time % cycle;
  for (const [duration, rain] of spec.segments) {
    if (offset < duration) return rain;
    offset -= duration;
  }
  return 0;
}

/**
 * Millisecond-by-millisecond growth of one plant from time 0 without weather overrides: a
 * millisecond `[t, t + 1)` counts when its light band grows and the wetness at `t` is at or above
 * `wetThreshold`. `growing[t]` is the accumulated growing time at simulation time `t`.
 */
export function growthOracle(
  spec: EcologySpec,
  policy: WorldBehaviorPolicy,
  plant: PlantSpec,
  horizon: number,
): {
  growing: number[];
  changes: { time: bigint; stageIndex: number; stageName: string }[];
  wetMs: number;
} {
  let needs: WorldNeeds = {
    hunger: 0,
    wetness: 0,
    integratedAt: 0n as SimTimeMs,
    hungerRemainder: 0n,
    wetnessRemainder: 0n,
  };
  const growing = [0];
  const changes: { time: bigint; stageIndex: number; stageName: string }[] = [];
  let stage = 0;
  let wetMs = 0;
  for (let time = 0; time < horizon; time += 1) {
    const wet = needs.wetness >= spec.wetThreshold;
    if (wet) wetMs += 1;
    const grows = wet && plant.bands.includes(bandAt(spec, time));
    const total = growing[time]! + (grows ? 1 : 0);
    growing.push(total);
    while (stage + 1 < plant.stages.length && total >= plant.stages[stage + 1]![1]) {
      stage += 1;
      changes.push({
        time: BigInt(time + 1),
        stageIndex: stage,
        stageName: plant.stages[stage]![0],
      });
    }
    needs = integrateNeedsWith(
      needs,
      plant.protection ?? 0,
      rainAt(spec, time),
      BigInt(time + 1) as SimTimeMs,
      policy,
    );
  }
  return { growing, changes, wetMs };
}

export interface ModelEvent {
  readonly time: bigint;
  readonly type: "resource.spoiled" | "resource.appeared";
  readonly objectId: string;
  readonly quantity: number;
}

/** Millisecond-by-millisecond holder contents: spoilage first, then appearances, by object id. */
export class HolderModel {
  readonly quantity = new Map<string, number>();
  readonly arrival = new Map<string, bigint | null>();
  constructor(private readonly spec: EcologySpec) {
    for (const holder of spec.holders) {
      this.quantity.set(holder.objectId, holder.quantity);
      this.arrival.set(
        holder.objectId,
        holder.quantity > 0 && spec.perishables.some(([id]) => id === holder.objectId)
          ? BigInt(holder.arrivedAt ?? 0)
          : null,
      );
    }
  }
  consume(objectId: string, quantity: number): void {
    const next = this.quantity.get(objectId)! - quantity;
    if (next < 0) throw new Error("model consume below zero");
    this.quantity.set(objectId, next);
    if (next === 0) this.arrival.set(objectId, null);
  }
  advance(from: bigint, to: bigint): ModelEvent[] {
    const events: ModelEvent[] = [];
    const ids = [...this.quantity.keys()].sort();
    for (let time = from + 1n; time <= to; time += 1n) {
      for (const id of ids) {
        const shelf = this.spec.perishables.find(([candidate]) => candidate === id)?.[1];
        const arrived = this.arrival.get(id) ?? null;
        const holder = this.spec.holders.find((candidate) => candidate.objectId === id)!;
        if (
          shelf !== undefined &&
          arrived !== null &&
          this.quantity.get(id)! > 0 &&
          (holder.status ?? "active") === "active" &&
          time === arrived + BigInt(shelf)
        ) {
          events.push({
            time,
            type: "resource.spoiled",
            objectId: id,
            quantity: this.quantity.get(id)!,
          });
          this.quantity.set(id, 0);
          this.arrival.set(id, null);
        }
      }
      for (const id of ids) {
        const source = this.spec.sources.find(([candidate]) => candidate === id);
        const holder = this.spec.holders.find((candidate) => candidate.objectId === id)!;
        if (source === undefined || (holder.status ?? "active") !== "active") continue;
        const [, , first, period, quantity] = source;
        if (
          time >= BigInt(first) &&
          (time - BigInt(first)) % BigInt(period) === 0n &&
          this.quantity.get(id) === 0
        ) {
          events.push({ time, type: "resource.appeared", objectId: id, quantity });
          this.quantity.set(id, quantity);
          this.arrival.set(
            id,
            this.spec.perishables.some(([candidate]) => candidate === id) ? time : null,
          );
        }
      }
    }
    return events;
  }
}

export function resourceEventsOf(events: readonly { type: string }[]): ModelEvent[] {
  return (events as readonly WorldSemanticEvent[])
    .filter((event) => event.type === "resource.spoiled" || event.type === "resource.appeared")
    .map((event) => ({
      time: event.simulationTime as bigint,
      type: event.type as ModelEvent["type"],
      objectId: (event.payload as Loose).objectId as string,
      quantity: (event.payload as Loose).quantity as number,
    }));
}

// ---------------------------------------------------------------------------------------------
// Goldens
// ---------------------------------------------------------------------------------------------

export interface Span {
  readonly name: string;
  readonly target: bigint;
  readonly fast: Run;
  readonly live: Run;
  readonly chained: Run;
}

export interface FoodGolden {
  readonly spans: Span[];
  readonly events: WorldSemanticEvent[];
  readonly calls: { label: string; input: WorldKernelInput; outcome: WorldKernelOutcome }[];
  readonly worlds: Record<string, EnvironmentWorld>;
  readonly retries: { name: string; outcome: WorldKernelOutcome }[];
  readonly offer: { input: WorldKernelInput; outcome: WorldKernelOutcome };
  readonly final: EnvironmentWorld;
  readonly reAdvance: Run;
}

/** Food appears, partly consumed, spoils, refills, empties; water appears and is consumed. */
export function foodDecayGolden(start: EnvironmentWorld): FoodGolden {
  let world = start;
  const spans: Span[] = [];
  const events: WorldSemanticEvent[] = [];
  const calls: FoodGolden["calls"] = [];
  const worlds: Record<string, EnvironmentWorld> = {};
  const retries: FoodGolden["retries"] = [];
  const interval = BigInt(FOOD_SPEC.intervalMs);
  const step = (name: string, target: bigint) => {
    const fast = runChain(world, `food:${name}`, target);
    const live = runLive(world, `food:${name}:live`, target, interval);
    const chained = runChain(world, `food:${name}:chain`, target, 8, 12);
    spans.push({ name, target, fast, live, chained });
    for (const [index, call] of fast.calls.entries())
      calls.push({
        label: `food-advance-${name}-${index}`,
        input: call.input,
        outcome: call.outcome,
      });
    events.push(...fast.events);
    world = fast.world;
    worlds[name] = world;
  };
  const consume = (name: string, objectId: string, kind: ResourceKind, quantity: number) => {
    const input = resourceCommand(
      world,
      "resource.consume",
      { objectId, kind, quantity },
      `food:${name}`,
    );
    const run = applyCommand(world, input);
    calls.push({ label: `food-consume-${name}`, input, outcome: run.calls[0]!.outcome });
    events.push(...run.events);
    const post = run.world.state;
    // Retrying the same command against its post-state conflicts on the expected revision.
    const stale: WorldKernelInput = {
      ...input,
      partition: { ...input.partition, revision: post.revision, state: post },
      simulationTime: post.simulationTime,
      schedules: run.world.schedules,
    };
    const outcome = executeWorldKernel(stale, { mode: "test" });
    retries.push({ name, outcome });
    calls.push({ label: `food-retry-${name}`, input: stale, outcome });
    world = run.world;
    worlds[name] = world;
  };
  step("appear", 2000n);
  consume("food-partial", "food-bowl", "food", 4);
  consume("water-all", "water-bowl", "water", 6);
  const offerInput = resourceCommand(
    world,
    "resource.offer",
    { objectId: "food-bowl", kind: "food", quantity: 5 },
    "food:offer-while-full",
  );
  const offer = { input: offerInput, outcome: executeWorldKernel(offerInput, { mode: "test" }) };
  calls.push({ label: "food-offer-refused", input: offerInput, outcome: offer.outcome });
  step("spoil", 4500n);
  step("refill", 6000n);
  consume("food-zero", "food-bowl", "food", 10);
  step("rain", 7000n);
  consume("water-again", "water-bowl", "water", 6);
  step("end", 10000n);
  const reAdvance = runChain(world, "food:re-advance", 10000n);
  calls.push({
    label: "food-re-advance",
    input: reAdvance.calls[0]!.input,
    outcome: reAdvance.calls[0]!.outcome,
  });
  return { spans, events, calls, worlds, retries, offer, final: world, reAdvance };
}

export async function foodGoldenHashes(golden: FoodGolden) {
  const advanceEvents = golden.spans.flatMap((span) => span.fast.events);
  return {
    name: "food-decay-and-conservation",
    ...(await ecologyHashes(advanceEvents, golden.final.state)),
  };
}

export interface CedarGolden {
  readonly fast: Run;
  readonly live: Run;
  readonly chained: Run;
}

export function cedarGrowthGolden(world: EnvironmentWorld): CedarGolden {
  return {
    fast: runChain(world, "cedar:fast", CEDAR_END),
    live: runLive(world, "cedar:live", CEDAR_END, BigInt(CEDAR_SPEC.intervalMs)),
    chained: runChain(world, "cedar:chain", CEDAR_END, 8, 6),
  };
}

export async function cedarGoldenHashes(golden: CedarGolden) {
  return {
    name: "cedar-growth",
    ...(await ecologyHashes(golden.fast.events, golden.fast.world.state)),
  };
}

// ---------------------------------------------------------------------------------------------
// Generated environments, holders, plants and step sequences (named stream `behavior` only)
// ---------------------------------------------------------------------------------------------

export type Operation =
  | { readonly kind: "advance"; readonly delta: number }
  | { readonly kind: "consume"; readonly holder: number; readonly quantity: number };

export interface GeneratedCase {
  readonly sequence: number;
  readonly spec: EcologySpec;
  readonly horizon: bigint;
  readonly operations: readonly Operation[];
  readonly chainEvents: number;
  readonly chainInputs: number;
}

export function generateEcologyCases(sequences = 3): GeneratedCase[] {
  let random = initializeNamedRandomStreams(ecologySeed, ecologyStreams);
  const next = (bound: number): number => {
    const drawn = drawNamedRandomStream(random, "behavior");
    random = drawn.randomState;
    // Low bits of the underlying generator are weak; use the middle bits.
    return Number((drawn.draw.rawValue + 2147483648n) >> 8n) % bound;
  };
  const protections: (number | null)[] = [null, 0, 5000, 10000];
  const bandSets = [["bright"], ["dim", "bright"], ["dark"]];
  const cases: GeneratedCase[] = [];
  for (let sequence = 0; sequence < sequences; sequence += 1) {
    const dayLengthMs = 4000 + next(3) * 1000;
    const second = 1000 + next(3) * 250;
    const third = second + 1000 + next(3) * 250;
    const phases = [
      [`night-${sequence}`, 0, "dark"],
      [`mid-${sequence}`, second, "dim"],
      [`day-${sequence}`, third, "bright"],
    ] as const;
    const rains = [0, 10000, 5000];
    const segments: (readonly [number, number, string])[] = Array.from(
      { length: 2 + next(2) },
      () => [1000 + next(4) * 500, rains[next(3)]!, `temp-${next(3)}`] as const,
    );
    segments[0] = [segments[0]![0], 0, "temp-dry"];
    segments[1] = [segments[1]![0], 10000, "temp-wet"];
    const wetThreshold = 1000 + next(3) * 500;
    const plantCount = 1 + next(2);
    const plants: PlantSpec[] = Array.from({ length: plantCount }, (_, index) => {
      const thresholds = [0];
      const stageCount = 3 + next(2);
      for (let stage = 1; stage < stageCount; stage += 1)
        thresholds.push(thresholds[stage - 1]! + 300 + next(4) * 150);
      return {
        objectId: `cedar-${sequence}-${index}`,
        bands: bandSets[next(3)]!,
        stages: thresholds.map((threshold, stage) => [`stage-${stage}`, threshold] as const),
        protection: index === 0 ? null : (protections[next(4)] ?? null),
      };
    });
    const holderCount = 2 + next(2);
    const holders: HolderSpec[] = Array.from({ length: holderCount }, (_, index) => ({
      objectId: `holder-${sequence}-${index}`,
      kind: index % 2 === 0 ? ("food" as const) : ("water" as const),
      quantity: next(3) === 0 ? 0 : 1 + next(5),
    }));
    const sources = holders.map(
      (holder) =>
        [
          holder.objectId,
          holder.kind,
          300 + next(5) * 100,
          400 + next(5) * 300,
          1 + next(5),
        ] as const,
    );
    const perishables = holders
      .filter((holder) => holder.kind === "food")
      .map((holder) => [holder.objectId, 600 + next(4) * 500] as const);
    const spec = baseSpec({
      dayLengthMs,
      phases,
      segments,
      wetThreshold,
      discomfortThreshold: wetThreshold + 1000,
      wetnessPerInterval: 1000 + next(3) * 500,
      dryingPerInterval: 200 + next(3) * 200,
      plants,
      holders,
      sources,
      perishables,
    });
    const horizon = BigInt(2 * dayLengthMs);
    const operations: Operation[] = [];
    let spent = 0;
    while (spent < 2 * dayLengthMs - 250) {
      if (next(4) === 0 && operations.length > 0)
        operations.push({ kind: "consume", holder: next(holderCount), quantity: 1 + next(3) });
      const delta = Math.min(200 + next(8) * 250, 2 * dayLengthMs - spent);
      operations.push({ kind: "advance", delta });
      spent += delta;
    }
    operations.push({ kind: "advance", delta: 2 * dayLengthMs - spent });
    cases.push({
      sequence,
      spec,
      horizon,
      operations,
      // The largest indivisible group plus slack, so every bounded call can make progress.
      chainEvents:
        3 * spec.actors.length + 2 * plantCount + perishables.length + sources.length + 2 + next(4),
      chainInputs: 1 + next(4),
    });
  }
  return cases;
}

function equal(actual: unknown, expected: unknown, what: string): void {
  if (Object.is(actual, expected)) return;
  if (canonicalSerialize(actual) !== canonicalSerialize(expected))
    throw new Error(
      `ecology assertion failed (${what}): ${canonicalSerialize([actual, expected])}`,
    );
}

function assertOrder(
  events: readonly { type: string; simulationTime: bigint }[],
  what: string,
): void {
  let time = -1n;
  let rank = -1;
  for (const event of events) {
    const next = ECOLOGY_RANK[event.type];
    if (next === undefined) continue;
    if (event.simulationTime < time) throw new Error(`${what}: events leave simulation-time order`);
    if (event.simulationTime === time && next < rank)
      throw new Error(`${what}: same-time order broken`);
    time = event.simulationTime;
    rank = next;
  }
}

/** Runs one generated sequence and throws on the first violated property. */
export async function runGeneratedCase(entry: GeneratedCase): Promise<{
  readonly calls: number;
  readonly events: number;
  readonly fingerprint: string;
}> {
  const { spec } = entry;
  const start = await ecologyWorld(spec);
  const policy = policyOf(start);
  const model = new HolderModel(spec);
  const holders = spec.holders.map((holder) => holder.objectId);
  const allEvents: WorldSemanticEvent[] = [];
  let world = start;
  let calls = 0;
  for (const [index, operation] of entry.operations.entries()) {
    const before = world.state;
    const totalsBefore = totalsOf(before);
    let run: Run;
    let expected: ModelEvent[] = [];
    if (operation.kind === "advance") {
      const target = before.simulationTime + BigInt(operation.delta);
      run = advance(world, `generated:${entry.sequence}:${index}`, target);
      expected = model.advance(before.simulationTime, target);
    } else {
      const holder = holders[operation.holder]!;
      const held = model.quantity.get(holder)!;
      if (held === 0) continue;
      const quantity = Math.min(operation.quantity, held);
      const kind = spec.holders[operation.holder]!.kind;
      run = runResource(
        world,
        "resource.consume",
        { objectId: holder, kind, quantity },
        `generated:${entry.sequence}:${index}`,
      );
      model.consume(holder, quantity);
    }
    calls += run.calls.length;
    allEvents.push(...run.events);
    assertOrder(run.events, `generated:${entry.sequence}:${index}`);
    // Appearances and spoilage are exactly the model's: at the derived times, only into empty holders.
    equal(resourceEventsOf(run.events), expected, `resource events ${entry.sequence}:${index}`);
    // Per-kind totals never go negative and change only by the recorded amounts.
    const totalsAfter = totalsOf(run.world.state);
    const change = recordedChange(run.events as readonly WorldSemanticEvent[]);
    for (const kind of ["food", "water"] as const) {
      if (totalsAfter[kind] < 0n) throw new Error("negative total");
      equal(totalsAfter[kind], totalsBefore[kind] + change[kind], `total ${kind}`);
    }
    for (const id of holders) {
      equal(quantityOf(run.world.state, id), model.quantity.get(id), `quantity ${id}`);
      if (spec.perishables.some(([candidate]) => candidate === id))
        equal(arrivalOf(run.world.state, id), model.arrival.get(id) ?? null, `arrival ${id}`);
    }
    world = run.world;
  }
  // Growth: every stage change is at the first millisecond the growing time reaches the threshold.
  const horizon = Number(entry.horizon);
  for (const plant of spec.plants) {
    const oracle = growthOracle(spec, policy, plant, horizon);
    const seen = allEvents
      .filter(
        (event) =>
          event.type === "growth.stage-changed" &&
          (event.payload as Loose).objectId === plant.objectId,
      )
      .map((event) => ({
        time: event.simulationTime as bigint,
        stageIndex: (event.payload as Loose).stageIndex as number,
        stageName: (event.payload as Loose).stageName as string,
      }));
    equal(seen, oracle.changes, `stage changes ${plant.objectId}`);
    const final = plantEntry(world.state, plant.objectId);
    equal(final.growingMs, BigInt(oracle.growing[horizon]!), `growing ${plant.objectId}`);
    equal(final.stage, oracle.changes.length, `stage ${plant.objectId}`);
    for (const change of oracle.changes) {
      const threshold = plant.stages[change.stageIndex]![1];
      const at = Number(change.time);
      if (!(oracle.growing[at]! >= threshold && oracle.growing[at - 1]! < threshold))
        throw new Error("oracle stage change is not the first millisecond");
    }
  }
  // Equivalences and one-millisecond-earlier checks over a consume-free run.
  const fast = runChain(start, `generated:${entry.sequence}:fast`, entry.horizon);
  const live = runLive(
    start,
    `generated:${entry.sequence}:live`,
    entry.horizon,
    BigInt(spec.intervalMs),
  );
  const chained = runChain(
    start,
    `generated:${entry.sequence}:chain`,
    entry.horizon,
    entry.chainInputs,
    entry.chainEvents,
  );
  const reference = await ecologyPairHash(fast);
  equal(await ecologyPairHash(live), reference, "live-steps-vs-fast-forward");
  equal(await ecologyPairHash(chained), reference, "bounded-continuation-vs-unbounded");
  assertOrder(fast.events, `generated:${entry.sequence}:fast`);
  const spoil = only(fast.events, "resource.spoiled")[0];
  if (spoil !== undefined) {
    const id = (spoil.payload as Loose).objectId as string;
    const arrival = arrivalAtSpoil(id, spoil.simulationTime as bigint, spec);
    const before = runChain(start, `generated:${entry.sequence}:before`, spoil.simulationTime - 1n);
    const at = runChain(start, `generated:${entry.sequence}:at`, spoil.simulationTime);
    if (quantityOf(before.world.state, id) === 0)
      throw new Error("food spoiled a millisecond early");
    equal(arrivalOf(before.world.state, id), arrival, "arrival before spoilage");
    equal(quantityOf(at.world.state, id), 0, "spoiled quantity");
    equal(arrivalOf(at.world.state, id), null, "arrival after spoilage");
  }
  return {
    calls,
    events: allEvents.length,
    fingerprint: canonicalSerialize([
      entry,
      allEvents.map((event) => [event.type, event.simulationTime, event.payload]),
      world.state,
    ]),
  };
}

/** The arrival time a spoilage at `spoilTime` implies: spoilage is arrival plus shelf life. */
function arrivalAtSpoil(objectId: string, spoilTime: bigint, spec: EcologySpec): bigint {
  const shelf = BigInt(spec.perishables.find(([id]) => id === objectId)![1]);
  return spoilTime - shelf;
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

function ecologyOf(base: WorldKernelInput): Loose {
  return structuredClone(base.pack.pack.policy.ecology) as Loose;
}

function mutatePolicy(
  base: WorldKernelInput,
  change: (ecology: Loose) => unknown,
): WorldKernelInput {
  const ecology = ecologyOf(base);
  const changed = change(ecology);
  return setPolicy(base, {
    ...base.pack.pack.policy,
    ecology: changed === undefined ? ecology : changed,
  });
}

function withoutPolicyKey(
  base: WorldKernelInput,
  key: "ecology" | "environment",
): WorldKernelInput {
  const { [key]: _removed, ...policy } = base.pack.pack.policy;
  return setPolicy(base, policy);
}

function setStateEcology(base: WorldKernelInput, value: unknown): WorldKernelInput {
  const { ecology: _ecology, ...rest } = base.partition.state;
  const state = value === REMOVE ? rest : { ...rest, ecology: value };
  return { ...base, partition: { ...base.partition, state: state as WorldState } };
}

function mutateState(base: WorldKernelInput, change: (record: Loose) => unknown): WorldKernelInput {
  const record = structuredClone(base.partition.state.ecology) as Loose;
  const changed = change(record);
  return setStateEcology(base, changed === undefined ? record : changed);
}

function mutateEntities(
  base: WorldKernelInput,
  change: (entities: Loose[]) => Loose[],
): WorldKernelInput {
  const entities = change(structuredClone(base.partition.state.entities) as unknown as Loose[]);
  return {
    ...base,
    partition: {
      ...base.partition,
      state: { ...base.partition.state, entities } as unknown as WorldState,
    },
  };
}

export interface RefusalCase {
  readonly name: string;
  readonly input: unknown;
}

/** Fixed named refusal inputs; the expected envelopes are pinned in `spatial-evidence.ts`. */
export function ecologyRefusalInputs(base: WorldKernelInput): RefusalCase[] {
  const policy = (name: string, change: (ecology: Loose) => unknown): RefusalCase => ({
    name,
    input: mutatePolicy(base, change),
  });
  const state = (name: string, change: (record: Loose) => unknown): RefusalCase => ({
    name,
    input: mutateState(base, change),
  });
  const entities = (name: string, change: (entities: Loose[]) => Loose[]): RefusalCase => ({
    name,
    input: mutateEntities(base, change),
  });
  const set = (key: string, value: unknown) => (ecology: Loose) => {
    ecology[key] = value;
    return ecology;
  };
  const drop = (key: string) => (ecology: Loose) => {
    delete ecology[key];
    return ecology;
  };
  const at = (list: string, index: number, key: string, value: unknown) => (ecology: Loose) => {
    if (value === REMOVE) delete ecology[list][index][key];
    else ecology[list][index][key] = value;
    return ecology;
  };
  const replace = (list: string, index: number, value: unknown) => (ecology: Loose) => {
    ecology[list][index] = value;
    return ecology;
  };
  const stage = (index: number, key: string, value: unknown) => (ecology: Loose) => {
    if (value === REMOVE) delete ecology.plants[0].stages[index][key];
    else ecology.plants[0].stages[index][key] = value;
    return ecology;
  };
  const many = (count: number, make: (index: number) => Loose) =>
    Array.from({ length: count }, (_, index) => make(index));
  const withStages = (stages: Loose[]) => (ecology: Loose) => {
    ecology.plants[0].stages = stages;
    return ecology;
  };
  const stages = (...thresholds: string[]) =>
    thresholds.map((threshold, index) => ({ name: `s${index}`, thresholdMs: BigInt(threshold) }));
  const entry = (list: string, index: number, key: string, value: unknown) => (record: Loose) => {
    if (value === REMOVE) delete record[list][index][key];
    else record[list][index][key] = value;
    return record;
  };
  const TOO_LONG = (1n << 53n) + 1n;
  const entityNamed = (id: string) => (entities: Loose[]) =>
    entities.filter((entity) => entity.objectId !== id);
  const entityEdit = (id: string, edit: (entity: Loose) => void) => (entities: Loose[]) => {
    for (const entity of entities) if (entity.objectId === id) edit(entity);
    return entities;
  };
  return [
    policy("policy-null", () => null),
    policy("policy-wrong-type", () => "ecology"),
    policy("policy-missing-field", drop("sources")),
    policy("policy-extra-field", set("extra", 1)),
    policy("unknown-version", set("schemaVersion", 2)),
    { name: "policy-without-environment", input: withoutPolicyKey(base, "environment") },
    policy("source-null", replace("sources", 0, null)),
    policy("source-missing-field", at("sources", 0, "quantity", REMOVE)),
    policy("source-extra-field", at("sources", 0, "extra", 1)),
    policy("perishable-null", replace("perishables", 0, null)),
    policy("perishable-missing-field", at("perishables", 0, "shelfLifeMs", REMOVE)),
    policy("perishable-extra-field", at("perishables", 0, "extra", 1)),
    policy("plant-null", replace("plants", 0, null)),
    policy("plant-missing-field", at("plants", 0, "stages", REMOVE)),
    policy("plant-extra-field", at("plants", 0, "extra", 1)),
    policy("stage-null", withStages([null as unknown as Loose, ...stages("0", "10")])),
    policy("stage-missing-field", stage(0, "name", REMOVE)),
    policy("stage-extra-field", stage(0, "extra", 1)),
    policy("first-time-zero", at("sources", 0, "firstAtMs", 0n)),
    policy("first-time-negative", at("sources", 0, "firstAtMs", -1n)),
    policy("first-time-wrong-type", at("sources", 0, "firstAtMs", 1000)),
    policy("first-time-out-of-range", at("sources", 0, "firstAtMs", TOO_LONG)),
    policy("period-zero", at("sources", 0, "periodMs", 0n)),
    policy("period-out-of-range", at("sources", 0, "periodMs", TOO_LONG)),
    policy("quantity-zero", at("sources", 0, "quantity", 0)),
    policy("quantity-negative", at("sources", 0, "quantity", -1)),
    policy("quantity-wrong-type", at("sources", 0, "quantity", "7")),
    policy("quantity-out-of-range", at("sources", 0, "quantity", Number.MAX_SAFE_INTEGER + 1)),
    policy("shelf-life-zero", at("perishables", 0, "shelfLifeMs", 0n)),
    policy("shelf-life-out-of-range", at("perishables", 0, "shelfLifeMs", TOO_LONG)),
    policy("threshold-negative", stage(1, "thresholdMs", -1n)),
    policy("threshold-out-of-range", stage(1, "thresholdMs", TOO_LONG)),
    policy(
      "sources-too-many",
      set(
        "sources",
        many(65, (index) => ({
          objectId: `s${index}`,
          kind: "food",
          firstAtMs: 1n,
          periodMs: 1n,
          quantity: 1,
        })),
      ),
    ),
    policy(
      "perishables-too-many",
      set(
        "perishables",
        many(65, (index) => ({ objectId: `p${index}`, shelfLifeMs: 1n })),
      ),
    ),
    policy(
      "plants-too-many",
      set(
        "plants",
        many(65, (index) => ({
          objectId: `c${index}`,
          growingLightBands: ["bright"],
          stages: stages("0", "10"),
        })),
      ),
    ),
    policy(
      "bands-too-many",
      at(
        "plants",
        0,
        "growingLightBands",
        Array.from({ length: 65 }, (_, index) => `band-${index}`),
      ),
    ),
    policy("bands-empty", at("plants", 0, "growingLightBands", [])),
    policy("stages-too-few", withStages(stages("0"))),
    policy(
      "stages-too-many",
      withStages(stages(...Array.from({ length: 17 }, (_, index) => String(index * 10)))),
    ),
    policy("first-stage-not-zero", stage(0, "thresholdMs", 5n)),
    policy("thresholds-not-increasing", stage(2, "thresholdMs", 1000n)),
    policy("duplicate-stage-name", stage(1, "name", "seed")),
    policy("duplicate-source-id", at("sources", 1, "objectId", "food-bowl")),
    policy("duplicate-perishable-id", at("perishables", 1, "objectId", "food-bowl")),
    policy("duplicate-plant-id", at("plants", 1, "objectId", "cedar-a")),
    policy("plant-also-source", at("plants", 0, "objectId", "food-bowl")),
    policy("plant-also-perishable", at("plants", 0, "objectId", "keeper-bowl")),
    policy("unknown-light-band", at("plants", 0, "growingLightBands", ["twilight"])),
    { name: "state-null", input: setStateEcology(base, null) },
    { name: "state-wrong-type", input: setStateEcology(base, "record") },
    state("state-missing-field", (record) => {
      delete record.plants;
      return record;
    }),
    state("state-extra-field", (record) => {
      record.extra = 1;
      return record;
    }),
    state("perishable-entry-null", (record) => {
      record.perishables[0] = null;
      return record;
    }),
    state("perishable-entry-missing-field", entry("perishables", 0, "arrivedAt", REMOVE)),
    state("perishable-entry-extra-field", entry("perishables", 0, "extra", 1)),
    state("perishable-entry-wrong-type", entry("perishables", 0, "arrivedAt", 5)),
    state("plant-entry-null", (record) => {
      record.plants[0] = null;
      return record;
    }),
    state("plant-entry-missing-field", entry("plants", 0, "stage", REMOVE)),
    state("plant-entry-extra-field", entry("plants", 0, "extra", 1)),
    state("plant-entry-wrong-type", entry("plants", 0, "stage", "0")),
    { name: "state-without-policy", input: withoutPolicyKey(base, "ecology") },
    { name: "policy-without-state", input: setStateEcology(base, REMOVE) },
    state("perishables-count-differs", (record) => {
      record.perishables.pop();
      return record;
    }),
    state("plants-count-differs", (record) => {
      record.plants.pop();
      return record;
    }),
    state("perishable-id-differs", entry("perishables", 0, "objectId", "keeper-bowl")),
    state("plant-id-differs", entry("plants", 0, "objectId", "cedar-b")),
    entities("source-object-missing", entityNamed("water-bowl")),
    entities(
      "source-kind-differs",
      entityEdit("water-bowl", (entity) => {
        entity.resource.kind = "food";
      }),
    ),
    entities(
      "source-without-resource",
      entityEdit("water-bowl", (entity) => {
        delete entity.resource;
      }),
    ),
    entities("perishable-object-missing", entityNamed("keeper-bowl")),
    entities(
      "perishable-not-food",
      entityEdit("keeper-bowl", (entity) => {
        entity.resource.kind = "water";
      }),
    ),
    entities("plant-object-missing", entityNamed("cedar-a")),
    state("arrival-on-empty-holder", entry("perishables", 1, "arrivedAt", 100n)),
    state("arrival-absent-with-food", entry("perishables", 0, "arrivedAt", null)),
    state("arrival-after-state-time", entry("perishables", 0, "arrivedAt", REFUSAL_TIME + 1n)),
    {
      name: "spoilage-time-passed",
      input: mutatePolicy(base, (ecology) => {
        ecology.perishables[0].shelfLifeMs = 100n;
        return ecology;
      }),
    },
    state("plant-integrated-after-time", entry("plants", 0, "integratedAt", REFUSAL_TIME + 1n)),
    state("plant-stage-disagrees", entry("plants", 0, "stage", 1)),
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

function textual(totals: Record<"food" | "water", bigint>): Record<"food" | "water", string> {
  return { food: totals.food.toString(), water: totals.water.toString() };
}

function safeTotals(state: unknown): Record<"food" | "water", bigint> {
  try {
    return totalsOf(state as WorldState);
  } catch {
    return { food: 0n, water: 0n };
  }
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
  const before = safeTotals(asRecord(loose?.partition)?.state);
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
      conservation: {
        before: textual(before),
        after: textual(before),
        change: textual({ food: 0n, water: 0n }),
      },
    };
  }
  const result = outcome.result;
  const material = result.events.filter((event) =>
    (ECOLOGY_MATERIAL_TYPES as readonly string[]).includes(event.type),
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
        })),
      ),
      eventTypes: [...new Set(result.events.map((event) => event.type as string))].sort(),
      postStateHash: await stateHash(result.state),
      complete: result.complete,
      continuationHash:
        result.continuation === undefined ? null : await hashOf(result.continuation),
    },
    conservation: {
      before: textual(before),
      after: textual(totalsOf(result.state)),
      change: textual(recordedChange(result.events as readonly WorldSemanticEvent[])),
    },
  };
}

export type EcologyEntry = Awaited<ReturnType<typeof describeCall>>;

/** A refusal that is not an `executeWorldKernel` call (invariant sweep, engine call). */
async function describeSynthetic(
  label: string,
  type: string,
  source: unknown,
  error: Refusal,
): Promise<EcologyEntry> {
  assertEnvelope(error);
  const identity = await containmentInputIdentity(source);
  const empty = textual({ food: 0n, water: 0n });
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
    output: { kind: "refusal", code: error.code, path: error.path, check: error.check ?? null },
    conservation: { before: empty, after: empty, change: empty },
  };
}

/** Wraps the first source so reads of `quantity` after `validReads` misbehave. */
function flakySource(source: Loose, validReads: number, mode: "invalid" | "throw"): Loose {
  let reads = 0;
  return new Proxy(source, {
    get(target, property, receiver) {
      if (property === "quantity") {
        reads += 1;
        if (reads > validReads) {
          if (mode === "throw") throw new Error("hostile source read");
          return -1;
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
  return mutatePolicy(base, (ecology) => {
    ecology.sources[0] = flakySource(ecology.sources[0], validReads, mode);
    return ecology;
  });
}

/** Runs the sweep: the first number of valid reads that makes the hostile source refuse. */
export function exceptionSweep(base: WorldKernelInput, mode: "invalid" | "throw", code: string) {
  for (let validReads = 0; validReads < 400; validReads += 1) {
    const input = flakyInput(base, validReads, mode);
    const outcome = executeWorldKernel(input, { mode: "test" });
    if (!outcome.ok && outcome.error.code === code) return { input, outcome };
    if (outcome.ok && validReads > 100) break;
  }
  throw new Error(`no ${code} found by the hostile source sweep`);
}

// ---------------------------------------------------------------------------------------------
// Targeted cases: shared by the vitest file and the Node/Workers evidence
// ---------------------------------------------------------------------------------------------

export interface TargetedCases {
  /** Every engine call of the targeted cases, in a fixed order, by label. */
  readonly runs: ReadonlyArray<readonly [string, Run]>;
  readonly by: Readonly<Record<string, Run>>;
  readonly due: bigint;
  readonly stageDue: bigint;
  readonly threshold: number;
  readonly grown: PlantSpec;
  readonly grownSpec: EcologySpec;
  readonly grownWorld: EnvironmentWorld;
}

async function buildTargetedCases(): Promise<TargetedCases> {
  const runs: Array<readonly [string, Run]> = [];
  const by: Record<string, Run> = {};
  const track = (label: string, run: Run): Run => {
    runs.push([label, run]);
    by[label] = run;
    return run;
  };
  const decisionTimes = async (label: string, horizon: bigint): Promise<bigint[]> => {
    const run = track(label, advance(await ecologyWorld(baseSpec()), `${label}:run`, horizon));
    return decisionTimesOf(run);
  };

  // Skipped appearance: a source into a holder that still has food queues nothing.
  const skipWorld = await ecologyWorld(
    baseSpec({
      holders: [{ objectId: "bowl", kind: "food", quantity: 5, arrivedAt: 0 }],
      sources: [["bowl", "food", 1000, 1000, 3]],
      perishables: [["bowl", 100000]],
    }),
  );
  const skip = track("skip-appearance", advance(skipWorld, "skip", 3500n));
  const emptied = track(
    "skip-appearance-eat",
    runResource(
      skip.world,
      "resource.consume",
      { objectId: "bowl", kind: "food", quantity: 5 },
      "skip:eat",
    ),
  );
  track("skip-appearance-later", advance(emptied.world, "skip:later", 4000n));

  // Consume to zero.
  const zeroWorld = await ecologyWorld(
    baseSpec({
      holders: [{ objectId: "bowl", kind: "food", quantity: 5, arrivedAt: 0 }],
      perishables: [["bowl", 100000]],
    }),
  );
  const partial = track(
    "consume-partial",
    runResource(
      zeroWorld,
      "resource.consume",
      { objectId: "bowl", kind: "food", quantity: 2 },
      "zero:partial",
    ),
  );
  track(
    "consume-to-zero",
    runResource(
      partial.world,
      "resource.consume",
      { objectId: "bowl", kind: "food", quantity: 3 },
      "zero:all",
    ),
  );

  // Transfer arrival times.
  const transferWorld = track(
    "transfer-advance",
    advance(await ecologyWorld(BATCH_SPEC), "transfer:time", 500n),
  ).world;
  track(
    "transfer-from-perishable",
    runResource(
      transferWorld,
      "resource.transfer",
      { fromObjectId: "full-bowl", toObjectId: "empty-bowl", kind: "food", quantity: 2 },
      "transfer:from-perishable",
    ),
  );
  track(
    "transfer-from-plain",
    runResource(
      transferWorld,
      "resource.transfer",
      { fromObjectId: "plain-crate", toObjectId: "spare-bowl", kind: "food", quantity: 2 },
      "transfer:from-plain",
    ),
  );

  // Growth: dry in daylight, wet only at night.
  const stages = [
    ["seed", 0],
    ["sprout", 1000],
  ] as const;
  const plant = (objectId: string, bands: string[]): PlantSpec => ({
    objectId,
    bands,
    stages,
    protection: null,
  });
  track(
    "dry-daylight",
    advance(
      await ecologyWorld(
        baseSpec({ segments: [[10000, 0, "mild"]], plants: [plant("dry-plant", ["bright"])] }),
      ),
      "dry-day",
      8000n,
    ),
  );
  track(
    "wet-at-night",
    advance(
      await ecologyWorld(
        baseSpec({
          phases: [
            ["night", 0, "dark"],
            ["day", 6000, "bright"],
            ["dusk", 8000, "dim"],
          ],
          segments: [
            [4000, 10000, "wet"],
            [6000, 0, "mild"],
          ],
          wetnessPerInterval: 5000,
          dryingPerInterval: 10000,
          plants: [plant("day-plant", ["bright"]), plant("night-plant", ["dark"])],
        }),
      ),
      "wet-night",
      9000n,
    ),
  );

  // Same-time order at a decision due time and at the target.
  const decisions = await decisionTimes("decision-probe", 9000n);
  const due = decisions[1]!;
  const orderWorld = await ecologyWorld(
    baseSpec({
      holders: [{ objectId: "bowl", kind: "food", quantity: 5, arrivedAt: 0 }],
      sources: [["bowl", "food", Number(due), 100000, 3]],
      perishables: [["bowl", Number(due)]],
    }),
  );
  track("order-through", advance(orderWorld, "order:through", due + 1n));
  track("order-target", advance(orderWorld, "order:target", due));

  const rainy = (list: PlantSpec[]): EcologySpec =>
    baseSpec({ segments: [[10000, 10000, "wet"]], plants: list });
  const bands = ["dark", "bright", "dim"];
  const probePlant: PlantSpec = {
    objectId: "cedar",
    bands,
    stages: [
      ["seed", 0],
      ["probe", 1],
    ],
    protection: null,
  };
  const probeWorld = await ecologyWorld(rainy([probePlant]));
  const probe = growthOracle(rainy([probePlant]), policyOf(probeWorld), probePlant, 6000);
  const firstWet = probe.changes[0]!.time - 1n;
  // The default actor's decision times do not depend on plants, so the first probe serves both.
  const stageDecisions = decisions;
  const stageDue = stageDecisions.find((time) => time >= firstWet + 500n)!;
  const threshold = Number(stageDue - firstWet);
  const grown: PlantSpec = {
    objectId: "cedar",
    bands,
    stages: [
      ["seed", 0],
      ["sprout", threshold],
      ["tree", threshold + 100000],
    ],
    protection: null,
  };
  const grownSpec = rainy([grown]);
  const grownWorld = await ecologyWorld(grownSpec);
  track("stage-through", advance(grownWorld, "stage:through", stageDue + 1n));
  track("stage-target", advance(grownWorld, "stage:target", stageDue));

  // world.weather.set integrates plants first, under the rain in force.
  const cedar = await ecologyWorld(CEDAR_SPEC);
  const policy = policyOf(cedar).environment!;
  const at = 3000n as SimTimeMs;
  const lagging = {
    ...cedar,
    state: {
      ...cedar.state,
      simulationTime: at,
      weather: { rainIntensity: 10000 },
      environment: deriveEnvironmentState(policy, at),
    } as WorldState,
  };
  track(
    "weather-set-plants-first",
    applyCommand(
      lagging,
      commandInput(lagging, "world.weather.set", "weather:first", { rainIntensity: 0 }),
    ),
  );
  return { runs, by, due, stageDue, threshold, grown, grownSpec, grownWorld };
}

let targetedPromise: Promise<TargetedCases> | undefined;
export function targetedCases(): Promise<TargetedCases> {
  targetedPromise ??= buildTargetedCases();
  return targetedPromise;
}

async function targetedEntries(): Promise<EcologyEntry[]> {
  const entries: EcologyEntry[] = [];
  const cases = await targetedCases();
  for (const [label, run] of cases.runs)
    for (const [index, call] of run.calls.entries())
      entries.push(await describeCall(`targeted:${label}:${index}`, call.input, call.outcome));
  return entries;
}

async function goldenEntries(): Promise<EcologyEntry[]> {
  const entries: EcologyEntry[] = [];
  const golden = foodDecayGolden(await ecologyWorld(FOOD_SPEC));
  for (const call of golden.calls)
    entries.push(await describeCall(`case:${call.label}`, call.input, call.outcome));
  const cedar = await ecologyWorld(CEDAR_SPEC);
  const fast = runChain(cedar, "cedar:evidence", CEDAR_END);
  entries.push(
    await describeCall("case:cedar-fast-forward", fast.calls[0]!.input, fast.calls[0]!.outcome),
  );
  const bounded = runChain(cedar, "cedar:bounded", CEDAR_END, 8, 6);
  // The mixed fixture is compared through the `material-ecology` pairs (equal hashes in both runtimes);
  // its calls are not repeated here to keep the section inside the 1 MiB evidence bound.
  for (const [index, call] of bounded.calls.slice(0, 2).entries())
    entries.push(await describeCall(`case:cedar-bounded-${index}`, call.input, call.outcome));
  // A held `world.weather.set` override integrates plants first.
  const held = applyCommand(cedar, weatherInput(cedar, "held:set", 10000));
  entries.push(
    await describeCall("case:weather-set", held.calls[0]!.input, held.calls[0]!.outcome),
  );
  return entries;
}

async function batchEntries(): Promise<EcologyEntry[]> {
  const entries: EcologyEntry[] = [];
  const world = await ecologyWorld(BATCH_SPEC);
  const offer = resourceCommand(
    world,
    "resource.offer",
    { objectId: "full-bowl", kind: "food", quantity: 2 },
    "batch:offer",
  );
  entries.push(
    await describeCall(
      "refusal:perishable-offer",
      offer,
      executeWorldKernel(offer, { mode: "test" }),
    ),
  );
  const transfer = resourceCommand(
    world,
    "resource.transfer",
    { fromObjectId: "plain-crate", toObjectId: "full-bowl", kind: "food", quantity: 2 },
    "batch:transfer",
  );
  entries.push(
    await describeCall(
      "refusal:perishable-transfer",
      transfer,
      executeWorldKernel(transfer, { mode: "test" }),
    ),
  );
  const fromPerishable = resourceCommand(
    world,
    "resource.transfer",
    { fromObjectId: "full-bowl", toObjectId: "empty-bowl", kind: "food", quantity: 2 },
    "batch:from-perishable",
  );
  entries.push(
    await describeCall(
      "case:transfer-from-perishable",
      fromPerishable,
      executeWorldKernel(fromPerishable, { mode: "test" }),
    ),
  );
  const fromPlain = resourceCommand(
    world,
    "resource.transfer",
    { fromObjectId: "plain-crate", toObjectId: "spare-bowl", kind: "food", quantity: 2 },
    "batch:from-plain",
  );
  entries.push(
    await describeCall(
      "case:transfer-from-plain",
      fromPlain,
      executeWorldKernel(fromPlain, { mode: "test" }),
    ),
  );
  return entries;
}

async function refusalEntries(): Promise<EcologyEntry[]> {
  const entries: EcologyEntry[] = [];
  const world = await ecologyWorld(REFUSAL_SPEC);
  const settled = runChain(world, "refusal:settle", REFUSAL_TIME).world;
  const base = advanceInput(settled, "refusal:base", 6000n);
  for (const { name, input } of ecologyRefusalInputs(base))
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
  const ecology = state.ecology!;
  const disagreeing = createWorldState({
    ...state,
    ecology: {
      ...ecology,
      plants: ecology.plants.map((plant, index) => (index === 0 ? { ...plant, stage: 1 } : plant)),
    },
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
  // Ecology system exception: the engine converts it to a returned refusal.
  const spoilage = createSpoilageSystem({ objectId: "bowl", shelfLifeMs: 100n });
  const throwing = createCatchUpRegistry({
    payloads: [],
    systems: [
      {
        ...spoilage,
        integrate: () => {
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
      [
        {
          systemId: "ecology.spoilage:bowl@1",
          at: 0n as SimTimeMs,
          state: holderSystemState(5, 0n, true),
        },
      ],
      0n as SimTimeMs,
      200n as SimTimeMs,
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
  // Ecology handler and reducer exceptions through the full executor.
  const tiny = await ecologyWorld(EXCEPTION_SPEC);
  const tinyBase = advanceInput(tiny, "refusal:exception", 1500n);
  const handler = exceptionSweep(tinyBase, "throw", "handler-failed");
  entries.push(await describeCall("refusal:handler-exception", tinyBase, handler.outcome));
  const reducer = exceptionSweep(tinyBase, "invalid", "reducer-failed");
  entries.push(await describeCall("refusal:reducer-exception", tinyBase, reducer.outcome));
  return entries;
}

async function generatedEntries(): Promise<EcologyEntry[]> {
  const entries: EcologyEntry[] = [];
  for (const entry of generateEcologyCases()) {
    const world = await ecologyWorld(entry.spec);
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

export interface EcologyPair {
  readonly name: string;
  readonly equivalence: "material-ecology";
  readonly leftHash: string;
  readonly rightHash: string;
}

/** The two `material-ecology` differential pairs over the mixed fixture. */
export async function ecologyPairs(): Promise<EcologyPair[]> {
  const mixed = await ecologyWorld(MIXED_SPEC);
  const fast = runChain(mixed, "pair:fast", MIXED_END);
  const live = runLive(mixed, "pair:live", MIXED_END, BigInt(MIXED_SPEC.intervalMs));
  const chained = runChain(mixed, "pair:chained", MIXED_END, 8, 12);
  return [
    {
      name: "live-steps-vs-fast-forward",
      equivalence: "material-ecology",
      leftHash: await ecologyPairHash(live),
      rightHash: await ecologyPairHash(fast),
    },
    {
      name: "bounded-continuation-vs-unbounded",
      equivalence: "material-ecology",
      leftHash: await ecologyPairHash(chained),
      rightHash: await ecologyPairHash(fast),
    },
  ];
}

export async function ecologyGoldens() {
  const food = await foodGoldenHashes(foodDecayGolden(await ecologyWorld(FOOD_SPEC)));
  const cedar = await cedarGoldenHashes(cedarGrowthGolden(await ecologyWorld(CEDAR_SPEC)));
  return [food, cedar];
}

export async function ecologyEvidence() {
  return {
    schemaVersion: 1,
    seed: ecologySeed,
    entries: [
      ...(await goldenEntries()),
      ...(await batchEntries()),
      ...(await targetedEntries()),
      ...(await refusalEntries()),
      ...(await generatedEntries()),
    ],
    pairs: await ecologyPairs(),
    goldens: await ecologyGoldens(),
  };
}
