import type { SimTimeMs } from "@clockgrove/contracts";
import {
  createWorldState,
  decodeWorldScenario,
  deriveEnvironmentState,
  distanceFloor,
  expectedCrossings,
  isRegionCrossing,
  type MovementDestination,
  type MovementRecord,
  movementCompletionTime,
  positionAt,
  reduceWorldEvent,
  sameCoordinates,
  type WorldEntity,
  type WorldState,
} from "@clockgrove/domain";
import { canonicalSerialize } from "../src/canonical.js";
import { REFUSAL_CODES, type Refusal, RefusalSignal, refusal } from "../src/execute/refusal.js";
import { drawNamedRandomStream, initializeNamedRandomStreams } from "../src/random.js";
import { createCatchUpRegistry } from "../src/scheduler/catch-up.js";
import { planMovement } from "../src/spatial/movement.js";
import { catchUpEnvironment } from "../src/systems/environment/index.js";
import {
  checkWorldInvariants,
  executeWorldKernel,
  type WorldKernelInput,
  type WorldKernelOutcome,
  type WorldSemanticEvent,
  worldResourceTotals,
} from "../src/world.js";
import { containmentInputIdentity } from "./containment.scenario.js";
import {
  advanceInput,
  applyCommand,
  type EnvironmentWorld,
  type Run,
  runChain,
} from "./environment.scenario.js";
import { scenarioInput, stateHash } from "./weather-needs.scenario.js";
import {
  describeCall,
  firstItem,
  type InitialNeeds,
  only,
  payloadOf,
  runLiveSteps,
  runScheduledDecisions,
  scheduledInput,
  scheduledRefusalInputs,
  stateAt,
  timeOf,
  type WellbeingSpec,
  type WellbeingValues,
  wellbeingSample,
} from "./wellbeing.scenario.js";

// biome-ignore lint: deliberately loose, hostile inputs are built from plain data
type Loose = Record<string, any>;

export const decisionsSeed = { version: 1, seed: "decisions-utility-v1" } as const;
export const decisionsStreams = ["behavior"] as const;
export const DECISIONS_EQUIVALENCE = "material-decisions";

/** The `material-decisions` event types: the wellbeing set plus movement, consumption and relief. */
export const DECISIONS_MATERIAL_TYPES = [
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
  "movement.started",
  "movement.region-entered",
  "movement.region-exited",
  "movement.interrupted",
  "movement.replanned",
  "movement.completed",
  "resource.consumed",
  "location.changed",
  "needs.relieved",
] as const;

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

export interface ItemSpec {
  readonly id: string;
  readonly kind: "food" | "water" | "shelter";
  readonly at: readonly [number, number];
  readonly quantity?: number;
  readonly protection?: number;
  readonly spaceId?: string;
}

export interface UtilityValues {
  readonly thirstWeight: number;
  readonly expectationWeight: number;
  readonly travelWeight: number;
  readonly unitsPerSecond: bigint;
  readonly perceptionRange: bigint;
  readonly biteQuantity: number;
  readonly hungerReliefPerUnit: number;
  readonly thirstReliefPerUnit: number;
}

export interface ScriptedSpec {
  readonly ref: string;
  readonly kind: "belief" | "memory";
  readonly actorId: string;
  readonly targetObjectId: string;
  readonly value: number;
  readonly effectiveAt: bigint;
}

export interface GraphSpec {
  readonly anchors: readonly (readonly [string, number, number])[];
  readonly edges: readonly (readonly [string, string])[];
}

export interface UtilitySpec extends WellbeingSpec {
  readonly items: readonly ItemSpec[];
  readonly starts?: readonly (readonly [number, number])[];
  readonly located?: readonly (string | null)[];
  readonly utility: UtilityValues;
  readonly scripted?: readonly ScriptedSpec[];
  readonly graph?: "items" | "none" | GraphSpec;
  readonly regions?: readonly (readonly [string, number, number, number, number])[];
}

export const DEFAULT_UTILITY: UtilityValues = {
  thirstWeight: 1500,
  expectationWeight: 400,
  travelWeight: 100,
  unitsPerSecond: 2000n,
  perceptionRange: 3000n,
  biteQuantity: 2,
  hungerReliefPerUnit: 500,
  thirstReliefPerUnit: 500,
};

const QUIET: WellbeingValues = {
  thirstPerInterval: 1,
  healthLossPerInterval: 100,
  healthRecoveryPerInterval: 100,
  urgentHunger: 10000,
  urgentThirst: 10000,
  criticalHealth: 1,
};

const BASE: UtilitySpec = {
  dayLengthMs: 10000,
  phases: [["only", 0, "all"]],
  segments: [[10000, 0, "dry"]],
  wetThreshold: 3000,
  discomfortThreshold: 6000,
  intervalMs: 1000,
  hungerPerInterval: 5,
  wetnessPerInterval: 1500,
  dryingPerInterval: 1000,
  actors: [["t-weather", null]],
  wellbeing: QUIET,
  items: [],
  utility: DEFAULT_UTILITY,
};
export const RAIN: Pick<UtilitySpec, "segments"> = { segments: [[10000, 10000, "wet"]] };

export const food = (
  id: string,
  at: readonly [number, number],
  quantity = 4,
  spaceId?: string,
): ItemSpec => ({
  id,
  kind: "food",
  at,
  quantity,
  ...(spaceId === undefined ? {} : { spaceId }),
});
const water = (id: string, at: readonly [number, number], quantity = 6): ItemSpec => ({
  id,
  kind: "water",
  at,
  quantity,
});
export const shelter = (
  id: string,
  at: readonly [number, number],
  protection = 10000,
): ItemSpec => ({
  id,
  kind: "shelter",
  at,
  protection,
});
export const needs = (hunger: number, wetness: number, thirst: number): InitialNeeds => ({
  hunger,
  wetness,
  thirst,
  health: 10000,
});

const POSE = (x: number, y: number) => ({
  frameId: "zone-ground",
  frameVersion: 1,
  coordinates: [String(x), String(y)],
});
const compare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

export function utilitySample(spec: UtilitySpec): Loose {
  const sample = wellbeingSample(spec);
  sample.pack.packId = "clockgrove.fixture.decisions";
  sample.pack.archetypes = [...sample.pack.archetypes, "reference.bowl@1"];
  const u = spec.utility;
  sample.pack.policy.utility = {
    schemaVersion: 1,
    scorer: "clockgrove.routine-utility",
    scorerVersion: 1,
    thirstWeight: u.thirstWeight,
    expectationWeight: u.expectationWeight,
    travelWeight: u.travelWeight,
    unitsPerSecond: String(u.unitsPerSecond),
    perceptionRange: String(u.perceptionRange),
    biteQuantity: u.biteQuantity,
    hungerReliefPerUnit: u.hungerReliefPerUnit,
    thirstReliefPerUnit: u.thirstReliefPerUnit,
  };
  const actors = sample.initialState.entities as Loose[];
  actors.forEach((actor, index) => {
    const start = spec.starts?.[index] ?? [0, 0];
    actor.pose = POSE(start[0], start[1]);
    const located = spec.located?.[index];
    if (located !== undefined && located !== null) actor.locationId = located;
  });
  const items = spec.items.map((item) => ({
    objectId: item.id,
    archetypeId: item.kind === "shelter" ? "reference.shelter@1" : "reference.bowl@1",
    pose: POSE(item.at[0], item.at[1]),
    spaceId: item.spaceId ?? "zone",
    ...(item.kind === "shelter"
      ? { shelter: { rainProtection: item.protection ?? 0 } }
      : { resource: { kind: item.kind, quantity: item.quantity ?? 0 } }),
  }));
  sample.initialState.entities = [...items, ...actors].sort((left, right) =>
    compare(left.objectId, right.objectId),
  );
  if (spec.scripted !== undefined)
    sample.initialState.scriptedCognition = {
      schemaVersion: 1,
      source: "scripted",
      entries: [...spec.scripted]
        .sort((left, right) => compare(left.ref, right.ref))
        .map((entry) => ({ ...entry, effectiveAt: String(entry.effectiveAt) })),
    };
  return sample;
}

const point = (x: number, y: number) => [BigInt(x), BigInt(y)] as const;

function anchorGraphsOf(spec: UtilitySpec): unknown[] {
  if (spec.graph === "none") return [];
  let anchors: (readonly [string, number, number])[];
  let edges: (readonly [string, string])[];
  if (typeof spec.graph === "object") {
    anchors = [...spec.graph.anchors];
    edges = [...spec.graph.edges];
  } else {
    anchors = [];
    const seen = new Set<string>();
    for (const item of [...spec.items].sort((left, right) => compare(left.id, right.id))) {
      const key = `${item.at[0]},${item.at[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      anchors.push([item.id, item.at[0], item.at[1]]);
    }
    edges = [];
    for (const left of anchors)
      for (const right of anchors) if (left[0] < right[0]) edges.push([left[0], right[0]]);
  }
  if (anchors.length < 2) return [];
  anchors.sort((left, right) => compare(left[0], right[0]));
  const at = new Map(anchors.map(([id, x, y]) => [id, point(x, y)] as const));
  return [
    {
      graphId: "zone",
      version: 1,
      frameId: "zone-ground",
      frameVersion: 1,
      anchors: anchors.map(([anchorId, x, y]) => ({ anchorId, coordinates: point(x, y) })),
      edges: edges
        .map(([from, to]) => (from < to ? [from, to] : [to, from]) as [string, string])
        .sort((left, right) => compare(left.join("|"), right.join("|")))
        .map(([from, to]) => ({
          from,
          to,
          cost: distanceFloor(at.get(from) as readonly bigint[], at.get(to) as readonly bigint[]),
        })),
    },
  ];
}

function regionsOf(spec: UtilitySpec): unknown[] {
  return [...(spec.regions ?? [])]
    .sort((left, right) => compare(left[0], right[0]))
    .map(([regionId, minx, miny, maxx, maxy]) => ({
      regionId,
      version: 1,
      frameId: "zone-ground",
      frameVersion: 1,
      shape: { kind: "rectangle", min: point(minx, miny), max: point(maxx, maxy) },
    }));
}

/** Builds a world whose environment record is the one its policy derives at time 0. */
export async function utilityWorld(spec: UtilitySpec): Promise<EnvironmentWorld> {
  const sample = utilitySample(spec);
  const decoded = decodeWorldScenario(sample, await stateHash(sample));
  const policy = decoded.pack.policy.environment;
  if (policy === undefined) throw new Error("environment policy required");
  const graphs = anchorGraphsOf(spec);
  const regions = regionsOf(spec);
  const initialState = createWorldState({
    ...decoded.initialState,
    environment: deriveEnvironmentState(policy, decoded.initialState.simulationTime),
    ...(graphs.length === 0 ? {} : { anchorGraphs: graphs }),
    ...(regions.length === 0 ? {} : { spatialRegions: regions }),
  } as never);
  const template = await scenarioInput(undefined, 0, 32, {}, 32, {
    pack: decoded.pack,
    initialState,
  });
  return { template, state: template.partition.state, schedules: template.schedules };
}

// ---------------------------------------------------------------------------------------------
// Views and hashes
// ---------------------------------------------------------------------------------------------

export function decisionsMaterial(
  events: readonly { type: string }[],
): { type: string; time: bigint; payload: unknown }[] {
  return (events as readonly WorldSemanticEvent[])
    .filter((event) => (DECISIONS_MATERIAL_TYPES as readonly string[]).includes(event.type))
    .map((event) => ({
      type: event.type,
      time: event.simulationTime as bigint,
      payload: event.payload,
    }));
}

export function decisionsState(state: WorldState): unknown {
  return { ...state, revision: 0n };
}

/** Every decision trace of a run, in call order. */
export function tracesOf(run: Run): Loose[] {
  const traces: Loose[] = [];
  for (const call of run.calls)
    if (call.outcome.ok)
      for (const draft of call.outcome.result.decisionDrafts)
        traces.push(draft.decision as unknown as Loose);
  return traces;
}

export const traceView = (traces: readonly Loose[]): Loose[] =>
  traces.map((trace) => ({ ...trace, inputRevision: 0n }));

export async function decisionsHashes(run: Run) {
  return {
    materialEventHash: await stateHash(decisionsMaterial(run.events)),
    traceHash: await stateHash(traceView(tracesOf(run))),
    finalStateHash: await stateHash(decisionsState(run.world.state)),
  };
}

/** Hash of the whole `material-decisions` view of a run: events, traces and final state. */
export async function decisionsPairHash(run: Run): Promise<string> {
  return stateHash({
    events: decisionsMaterial(run.events),
    traces: traceView(tracesOf(run)),
    state: decisionsState(run.world.state),
  });
}

/** JSON-safe copy: bigints become decimal strings. */
export function plain(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(plain);
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]));
  return value;
}

function fail(what: string, detail?: unknown): never {
  throw new Error(
    `decisions assertion failed (${what})${detail === undefined ? "" : `: ${canonicalSerialize(detail)}`}`,
  );
}

// ---------------------------------------------------------------------------------------------
// Property checks shared by the generated sequences and the targeted cases
// ---------------------------------------------------------------------------------------------

/** Same-time ranks: RW-0108a's order through health, region crossings, arrivals, then decisions. */
const DECISION_RANK: Readonly<Record<string, number>> = {
  "environment.phase-changed": 0,
  "weather.transitioned": 1,
  "exposure.threshold-crossed": 2,
  "resource.spoiled": 3,
  "resource.appeared": 4,
  "growth.stage-changed": 5,
  "needs.threshold-crossed": 6,
  "health.threshold-crossed": 8,
  "movement.region-entered": 9,
  "movement.region-exited": 9,
  "movement.completed": 10,
  "routine.selected": 11,
};

export function assertDecisionsOrder(events: readonly WorldSemanticEvent[], what: string): void {
  let time = -1n;
  let rank = -1;
  let object = "";
  let decided = false;
  for (const event of events) {
    const next = DECISION_RANK[event.type];
    if (next === undefined) continue;
    if (event.simulationTime !== time) {
      time = event.simulationTime as bigint;
      rank = -1;
      object = "";
      decided = false;
    } else if (decided && next < 11) {
      // Region crossings inside a decision group belong to that decision.
      if (next === 9) continue;
      fail(`${what}: event after the decisions of its time`, event.type);
    }
    const payload = payloadOf(event);
    const id = `${event.type === "needs.threshold-crossed" ? (payload.need === "hunger" ? "0" : "1") : ""}${String(payload.objectId ?? "")}`;
    if (next < rank) fail(`${what}: same-time order broken`, { type: event.type, time });
    if (next === rank && id < object)
      fail(`${what}: objects within a kind must be in id order`, event.type);
    rank = next;
    object = id;
    if (next === 11) decided = true;
  }
}

export function recomputeScore(candidate: Loose, policy: Loose): bigint {
  const f = candidate.features as Record<string, bigint>;
  const kind = candidate.action.kind as string;
  if (kind === "stay") return 0n;
  const u = policy.utility as Loose;
  let need: bigint;
  if (kind === "seek-food")
    need = (f.hunger! * BigInt(policy.hungerWeight) * f.freshness!) / 10000n;
  else if (kind === "seek-water") need = f.thirst! * BigInt(u.thirstWeight);
  else need = ((f.wetness! + f.rain!) * f.protection! * BigInt(policy.shelterWeight)) / 10000n;
  return (
    (need * f.U!) / 10000n +
    f.expectation! * BigInt(u.expectationWeight) -
    (f.travelMs! * BigInt(u.travelWeight) * 10000n) / (policy.decisionIntervalMs as bigint)
  );
}

const keyOf = (action: Loose): string => `${action.kind}:${action.targetObjectId ?? ""}`;

/** Re-derives one trace from its own features and the policy; throws on the first disagreement. */
export interface VerifiedCounts {
  /** Exclusions verified against world facts, per reason. */
  readonly exclusions: Record<string, number>;
  /** Seek candidates verified as having no applicable reason. */
  eligible: number;
  /** Reliefs verified by exact arithmetic, per need. */
  readonly reliefs: { hunger: number; thirst: number };
}

export const EXCLUSION_REASONS = [
  "outside-current-space-or-frame",
  "not-perceived",
  "unavailable",
  "no-rain-protection",
  "unreachable",
] as const;

export function emptyVerified(): VerifiedCounts {
  return {
    exclusions: Object.fromEntries(EXCLUSION_REASONS.map((reason) => [reason, 0])),
    eligible: 0,
    reliefs: { hunger: 0, thirst: 0 },
  };
}

export interface TraceFacts {
  /** The world state immediately before the decision ran. */
  readonly state: WorldState;
  readonly tally: VerifiedCounts;
}

/** The anchor-at-target destination rule of a seek, restated independently of the kernel. */
function seekDestination(
  state: WorldState,
  actor: WorldEntity,
  target: WorldEntity,
): MovementDestination {
  for (const graph of state.anchorGraphs ?? []) {
    if (graph.frameId !== actor.pose.frameId || graph.frameVersion !== actor.pose.frameVersion)
      continue;
    const anchor = graph.anchors.find((item) =>
      sameCoordinates(item.coordinates, target.pose.coordinates),
    );
    if (anchor !== undefined)
      return { kind: "anchor", anchorId: anchor.anchorId, graphVersion: graph.version };
  }
  return {
    kind: "pose",
    pose: {
      frameId: target.pose.frameId,
      frameVersion: target.pose.frameVersion,
      coordinates: target.pose.coordinates,
    },
  };
}

/**
 * The first applicable exclusion that the world state at decision time and the policy imply, or
 * undefined when none applies. Reads nothing from the candidate's recorded features.
 */
function expectedExclusion(
  candidate: Loose,
  trace: Loose,
  state: WorldState,
  policy: Loose,
  scripted: readonly Loose[],
): string | undefined {
  const entities = state.entities;
  const actor = entities.find((entity) => entity.objectId === trace.objectId);
  const target = entities.find((entity) => entity.objectId === candidate.action.targetObjectId);
  if (actor === undefined || target === undefined) return "missing-entity";
  const time = trace.simulationTime as bigint;
  const position =
    actor.movement?.status === "active"
      ? positionAt(actor.movement.segment, time)
      : actor.pose.coordinates;
  const sameFrame =
    target.spaceId === actor.spaceId &&
    target.pose.frameId === actor.pose.frameId &&
    target.pose.frameVersion === actor.pose.frameVersion &&
    target.pose.coordinates.length === actor.pose.coordinates.length;
  if (!sameFrame) return "outside-current-space-or-frame";
  const utility = policy.utility as Loose;
  const effective = scripted.filter(
    (item) =>
      item.actorId === trace.objectId &&
      item.targetObjectId === target.objectId &&
      (item.effectiveAt as bigint) <= time,
  );
  if (
    distanceFloor(position, target.pose.coordinates) > (utility.perceptionRange as bigint) &&
    effective.length === 0
  )
    return "not-perceived";
  const shelter = candidate.action.kind === "seek-shelter";
  if (!shelter && (target.resource?.quantity ?? 0) <= 0) return "unavailable";
  if (shelter && (target.shelter?.rainProtection ?? 0) === 0) return "no-rain-protection";
  if (!sameCoordinates(position, target.pose.coordinates)) {
    const plan = planMovement(
      state,
      actor,
      position,
      seekDestination(state, actor, target),
      utility.unitsPerSecond as bigint,
      time,
      `check:${trace.objectId}:${time}`,
      { initialInside: [], exitedAtStart: [] },
    );
    if (!plan.ok) return "unreachable";
  }
  return undefined;
}

export function assertTrace(
  trace: Loose,
  policy: Loose,
  scripted: readonly Loose[],
  what: string,
  facts?: TraceFacts,
): void {
  if (trace.policyVersion !== `${policy.version}/clockgrove.routine-utility@1`)
    fail(`${what}: policy version`, trace.policyVersion);
  if (trace.randomDraws.length !== 0) fail(`${what}: random draws`);
  const candidates = trace.candidates as Loose[];
  const first = candidates[0]!;
  if (first.action.kind !== "stay" || first.score !== 0n || first.excludedReason !== undefined)
    fail(`${what}: stay candidate`);
  let previous = "";
  for (const candidate of candidates.slice(1)) {
    const target = String(candidate.action.targetObjectId);
    if (target < previous) fail(`${what}: seeks out of object id order`);
    previous = target;
  }
  const refs: string[] = [];
  for (const candidate of candidates) {
    if (candidate.score !== recomputeScore(candidate, policy))
      fail(`${what}: score does not recompute`, candidate);
    const f = candidate.features as Record<string, bigint>;
    const expected = f.uncomfortable === 0n ? 10000n : 20000n - f.health!;
    if (f.U !== expected) fail(`${what}: urgency`, f);
    if (candidate.action.kind === "stay") continue;
    const reason = candidate.excludedReason as string | undefined;
    if (f.perceived === 10000n)
      refs.push(`perceived:${candidate.action.targetObjectId}@${trace.simulationTime}`);
    if (reason === "not-perceived" && (f.perceived !== 0n || f.expectation !== 0n))
      fail(`${what}: not-perceived`, candidate);
    if (reason === undefined && f.perceived === 0n && f.expectation === 0n)
      fail(`${what}: eligible but not perceived`, candidate);
    if (
      reason === "no-rain-protection" &&
      !(candidate.action.kind === "seek-shelter" && f.protection === 0n)
    )
      fail(`${what}: no-rain-protection`, candidate);
    if (reason === "unavailable" && candidate.action.kind === "seek-shelter")
      fail(`${what}: unavailable shelter`, candidate);
    if (facts !== undefined) {
      // The recorded reason is the first applicable one; "unreachable" only follows when no earlier reason applies.
      const expected = expectedExclusion(candidate, trace, facts.state, policy, scripted);
      if (reason !== expected)
        fail(`${what}: exclusion is not the first applicable reason`, {
          candidate,
          expected: expected ?? "none",
        });
      if (expected === undefined) facts.tally.eligible += 1;
      else facts.tally.exclusions[expected] = (facts.tally.exclusions[expected] ?? 0) + 1;
      if (reason === "unreachable" && f.travelMs !== 0n)
        fail(`${what}: unreachable with a travel time`, candidate);
    }
    if (reason === undefined && candidate.action.kind === "seek-shelter" && f.protection === 0n)
      fail(`${what}: eligible shelter without protection`, candidate);
  }
  if (canonicalSerialize(refs) !== canonicalSerialize(trace.perceptionRefs))
    fail(`${what}: perception refs`, trace.perceptionRefs);
  const eligible = candidates.filter((candidate) => candidate.excludedReason === undefined);
  const wet = (candidates[0]!.features as Record<string, bigint>).wetness!;
  const reflex =
    wet >= 9000n ? eligible.filter((candidate) => candidate.action.kind === "seek-shelter") : [];
  const pool = reflex.length > 0 ? reflex : eligible;
  const best = [...pool].sort((left, right) =>
    left.score === right.score
      ? compare(keyOf(left.action), keyOf(right.action))
      : left.score > right.score
        ? -1
        : 1,
  )[0]!;
  if (keyOf(best.action) !== keyOf(trace.selectedAction))
    fail(`${what}: selection is not the best eligible candidate`, trace.selectedAction);
  if (trace.selectionTier !== (reflex.length > 0 ? "reflex" : "utility"))
    fail(`${what}: tier`, trace.selectionTier);
  for (const [name, kind] of [
    ["beliefRefs", "belief"],
    ["memoryRefs", "memory"],
  ] as const) {
    const list = trace[name] as string[];
    if (canonicalSerialize(list) !== canonicalSerialize([...list].sort(compare)))
      fail(`${what}: ${name} unsorted`);
    for (const ref of list) {
      const entry = scripted.find((item) => item.ref === ref);
      if (
        entry === undefined ||
        entry.kind !== kind ||
        entry.actorId !== trace.objectId ||
        (entry.effectiveAt as bigint) > (trace.simulationTime as bigint) ||
        !ref.startsWith("scripted:")
      )
        fail(`${what}: ${name} entry`, ref);
    }
  }
  const links = trace.outcomeLinks as string[];
  const plan = `plan:${trace.objectId}@${trace.simulationTime}`;
  if (
    trace.selectedAction.kind === "stay"
      ? links.length !== 0
      : links.length > 2 || (links.length > 0 && links[0] !== plan)
  )
    fail(`${what}: outcome links`, links);
}

export interface DecisionSummary {
  readonly calls: number;
  readonly events: number;
  readonly traces: number;
  readonly completions: number;
  readonly consumed: number;
  readonly relocations: number;
  readonly crossings: number;
  readonly reasons: readonly string[];
  readonly fingerprint: string;
  /** What the exclusion and relief checks verified in this run. */
  readonly verified: VerifiedCounts;
}

/** Checks one run: order, traces, exact arrival and crossing times, arithmetic and conservation. */
export function checkDecisionRun(
  start: EnvironmentWorld,
  run: Run,
  label: string,
  negatives = Number.POSITIVE_INFINITY,
): DecisionSummary {
  assertDecisionsOrder(run.events, label);
  const policy = start.template.pack.pack.policy as unknown as Loose;
  const scripted = (start.state.scriptedCognition?.entries ?? []) as unknown as Loose[];
  const traces = tracesOf(run);
  const reasons = new Set<string>();
  const verified = emptyVerified();
  // The world state immediately before each decision, and each actor's need immediately before
  // each consumption: the start state reduced through the run's preceding events.
  // A changed decision sits at its routine.selected. An unchanged one journals nothing: it
  // sits after every event up to its time and before the next selection.
  const all = run.events as readonly WorldSemanticEvent[];
  const selections = all.flatMap((event, index) =>
    event.type === "routine.selected" ? [index] : [],
  );
  const cuts: number[] = [];
  const unchanged = new Set<number>();
  {
    let next = 0;
    for (const [index, trace] of traces.entries()) {
      const at = selections[next];
      const selection = at === undefined ? undefined : all[at]!;
      if (
        selection !== undefined &&
        timeOf(selection) === trace.simulationTime &&
        payloadOf(selection).objectId === trace.objectId
      ) {
        if (keyOf(payloadOf(selection).action) !== keyOf(trace.selectedAction))
          fail(`${label}: routine.selected differs from its trace`, index);
        cuts.push(at!);
        next += 1;
        continue;
      }
      const later = all.findIndex((event) => timeOf(event) > (trace.simulationTime as bigint));
      cuts.push(Math.min(later < 0 ? all.length : later, at ?? all.length));
      unchanged.add(index);
    }
    if (next !== selections.length) fail(`${label}: routine.selected without a trace`, next);
    if (cuts.some((cut, index) => index > 0 && cut < cuts[index - 1]!))
      fail(`${label}: decisions out of order`);
  }
  const decisionStates: WorldState[] = [];
  const priorNeed = new Map<number, number>();
  {
    let live = start.state;
    for (const [index, event] of all.entries()) {
      while (decisionStates.length < cuts.length && cuts[decisionStates.length] === index)
        decisionStates.push(live);
      if (event.type === "resource.consumed") {
        const next = all[index + 1];
        const actorId = next === undefined ? undefined : String(payloadOf(next).objectId);
        const actor = live.entities.find((entity) => entity.objectId === actorId);
        const entry = live.wellbeing?.entries.find((item) => item.objectId === actorId);
        const value = payloadOf(event).kind === "food" ? actor?.needs?.hunger : entry?.thirst;
        if (value !== undefined) priorNeed.set(index, value);
      }
      live = reduceWorldEvent(live, event);
    }
    while (decisionStates.length < cuts.length) decisionStates.push(live);
  }
  const cache = new Map<bigint, WorldState>();
  const at = (time: bigint, what: string): WorldState => {
    const known = cache.get(time);
    if (known !== undefined) return known;
    const state = stateAt(start, what, time);
    cache.set(time, state);
    return state;
  };
  for (const [index, trace] of traces.entries()) {
    const state = decisionStates[index];
    if (state === undefined) fail(`${label}: trace without a decision state`, index);
    assertTrace(trace, policy, scripted, `${label}:trace:${index}`, { state, tally: verified });
    for (const candidate of trace.candidates as Loose[])
      if (candidate.excludedReason) reasons.add(candidate.excludedReason);
    // An unchanged decision repeats the actor's current action and plans nothing.
    if (unchanged.has(index)) {
      const current = state.entities.find(
        (entity) => entity.objectId === trace.objectId,
      )?.selectedAction;
      if (current === undefined || keyOf(current) !== keyOf(trace.selectedAction))
        fail(`${label}: decision journaled nothing but changed the routine`, index);
      if ((trace.outcomeLinks as string[]).some((link) => !link.startsWith("plan:")))
        fail(`${label}: unjournaled decision with a movement`, index);
    }
  }

  const records = new Map<string, MovementRecord>();
  for (const event of run.events) {
    if (event.type === "movement.started")
      records.set(payloadOf(event).movement.movementId, payloadOf(event).movement);
    if (event.type === "movement.replanned")
      records.set(payloadOf(event).movement.movementId, payloadOf(event).movement);
  }
  const regions = start.state.spatialRegions ?? [];
  const completed = only(run.events, "movement.completed");
  let crossings = 0;
  for (const [index, event] of completed.entries()) {
    const id = String(payloadOf(event).movementId);
    const record = records.get(id);
    if (record === undefined) fail(`${label}: completed movement was never started`, id);
    const done = timeOf(event);
    if (done !== movementCompletionTime(record.segment))
      fail(`${label}: completion time`, { id, at: done });
    const observed = run.events
      .filter(
        (item) => item.type.startsWith("movement.region-") && payloadOf(item).movementId === id,
      )
      .map((item) => [
        item.type === "movement.region-entered" ? "entered" : "exited",
        payloadOf(item).regionId,
        timeOf(item),
      ]);
    const expected = expectedCrossings(record, regions)
      .filter(isRegionCrossing)
      .map((crossing) => [crossing.kind, crossing.regionId, crossing.time]);
    if (canonicalSerialize(observed) !== canonicalSerialize(expected))
      fail(`${label}: region crossings`, { id, observed, expected });
    crossings += observed.length;
    if (index < negatives && done > 0n) {
      const actor = String(payloadOf(event).objectId);
      const movementOf = (state: WorldState) =>
        state.entities.find((entity) => entity.objectId === actor)?.movement;
      const before = movementOf(at(done - 1n, `${label}:state:${done - 1n}`));
      const after = movementOf(at(done, `${label}:state:${done}`));
      if (before?.movementId !== id || before.status !== "active")
        fail(`${label}: movement ended before its completion time`, { id, at: done });
      if (after?.movementId === id && after.status === "active")
        fail(`${label}: movement still active at its completion time`, { id, at: done });
    }
  }
  // Every region crossing: not yet emitted one millisecond earlier, emitted at its exact time.
  const seen = new Map<string, number>();
  for (const event of run.events as readonly WorldSemanticEvent[]) {
    if (!event.type.startsWith("movement.region-")) continue;
    const payload = payloadOf(event);
    const id = String(payload.movementId);
    const record = records.get(id);
    if (record === undefined) fail(`${label}: crossing of an unknown movement`, id);
    const when = timeOf(event);
    const ordinal = seen.get(id) ?? 0;
    seen.set(id, ordinal + 1);
    const earlier = expectedCrossings(record, regions).filter(
      (crossing) => crossing.time < when,
    ).length;
    if (when > 0n) {
      const actor = String(payload.objectId);
      const before = at(when - 1n, `${label}:state:${when - 1n}`).entities.find(
        (entity) => entity.objectId === actor,
      )?.movement;
      if (before?.movementId !== id || before.emitted.length !== earlier)
        fail(`${label}: crossing emitted before its time`, { id, when, ordinal });
    }
    const afterMovement = at(when, `${label}:state:${when}`).entities.find(
      (entity) => entity.objectId === String(payload.objectId),
    )?.movement;
    if (afterMovement?.movementId === id && afterMovement.emitted.length < ordinal + 1)
      fail(`${label}: crossing not emitted at its time`, { id, when, ordinal });
  }

  // Consumption and relief arithmetic, and conservation.
  const bite = (policy.utility as Loose).biteQuantity as number;
  const running = new Map<string, number>();
  for (const entity of start.state.entities)
    if (entity.resource !== undefined) running.set(entity.objectId, entity.resource.quantity);
  const initialTotals = worldResourceTotals(start.state);
  const consumedTotals: Record<string, bigint> = {};
  let consumed = 0;
  const events = run.events as readonly WorldSemanticEvent[];
  for (const [index, event] of events.entries()) {
    if (event.type === "resource.consumed") {
      const payload = payloadOf(event);
      const left = running.get(String(payload.objectId));
      if (left === undefined || payload.quantity !== Math.min(bite, left) || payload.quantity < 1)
        fail(`${label}: consumption quantity`, payload);
      running.set(String(payload.objectId), left - payload.quantity);
      consumedTotals[payload.kind] =
        (consumedTotals[payload.kind] ?? 0n) + BigInt(payload.quantity);
      consumed += 1;
      const next = events[index + 1];
      const relieved = next === undefined ? undefined : payloadOf(next);
      if (
        next?.type !== "needs.relieved" ||
        relieved === undefined ||
        relieved.sourceObjectId !== payload.objectId ||
        relieved.quantity !== payload.quantity ||
        relieved.need !== (payload.kind === "food" ? "hunger" : "thirst") ||
        timeOf(next) !== timeOf(event)
      )
        fail(`${label}: relief follows consumption`, { payload, relieved });
      // Exact relief: max(0, prior - quantity x reliefPerUnit), prior taken from the reduced state.
      const prior = priorNeed.get(index);
      const perUnit = (policy.utility as Loose)[
        payload.kind === "food" ? "hungerReliefPerUnit" : "thirstReliefPerUnit"
      ] as number;
      if (prior === undefined) fail(`${label}: no prior need for the consumption`, payload);
      const wanted = Math.max(0, prior - payload.quantity * perUnit);
      if (relieved.value !== wanted)
        fail(`${label}: relief arithmetic`, { prior, payload, value: relieved.value, wanted });
      verified.reliefs[payload.kind === "food" ? "hunger" : "thirst"] += 1;
    }
    if (event.type === "needs.relieved" && events[index - 1]?.type !== "resource.consumed")
      fail(`${label}: relief without consumption`);
  }
  const finalTotals = worldResourceTotals(run.world.state);
  for (const kind of Object.keys(initialTotals))
    if (finalTotals[kind] !== initialTotals[kind]! - (consumedTotals[kind] ?? 0n))
      fail(`${label}: ${kind} is not conserved`);

  // Shelter location follows the last location change.
  const relocations = only(run.events, "location.changed");
  for (const entity of run.world.state.entities) {
    if (entity.needs === undefined) continue;
    const last = relocations.filter((item) => payloadOf(item).objectId === entity.objectId).at(-1);
    const initial =
      start.state.entities.find((item) => item.objectId === entity.objectId)?.locationId ?? null;
    const expected = last === undefined ? initial : payloadOf(last).locationId;
    if ((entity.locationId ?? null) !== expected)
      fail(`${label}: final location`, { id: entity.objectId, expected });
  }
  return {
    calls: run.calls.length,
    events: run.events.length,
    traces: traces.length,
    completions: completed.length,
    consumed,
    relocations: relocations.length,
    crossings,
    verified,
    reasons: [...reasons].sort(),
    fingerprint: canonicalSerialize([
      run.events.map((event) => [event.type, event.simulationTime, event.payload]),
      traceView(traces),
      run.world.state,
    ]),
  };
}

// ---------------------------------------------------------------------------------------------
// Differential runs and generated sequences
// ---------------------------------------------------------------------------------------------

export interface DecisionRuns {
  readonly fast: Run;
  readonly live: Run;
  readonly bounded: Run;
  readonly scheduled: Run;
}

export interface RunPlan {
  readonly horizon: bigint;
  readonly chainInputs: number;
  readonly chainEvents: number;
  readonly liveSteps: readonly number[];
}

export function decisionRuns(world: EnvironmentWorld, label: string, plan: RunPlan): DecisionRuns {
  return {
    fast: runChain(world, `${label}:fast`, plan.horizon),
    live: runLiveSteps(world, `${label}:live`, plan.horizon, plan.liveSteps),
    bounded: runChain(world, `${label}:bounded`, plan.horizon, plan.chainInputs, plan.chainEvents),
    scheduled: runScheduledDecisions(world, `${label}:scheduled`, plan.horizon),
  };
}

export async function decisionPairs(runs: DecisionRuns) {
  const fast = await decisionsPairHash(runs.fast);
  return [
    {
      name: "live-steps-vs-fast-forward",
      equivalence: DECISIONS_EQUIVALENCE,
      leftHash: await decisionsPairHash(runs.live),
      rightHash: fast,
    },
    {
      name: "bounded-continuation-vs-unbounded",
      equivalence: DECISIONS_EQUIVALENCE,
      leftHash: await decisionsPairHash(runs.bounded),
      rightHash: fast,
    },
    {
      name: "scheduled-decisions-vs-advance",
      equivalence: DECISIONS_EQUIVALENCE,
      leftHash: await decisionsPairHash(runs.scheduled),
      rightHash: fast,
    },
  ];
}

export interface GeneratedCase extends RunPlan {
  readonly sequence: number;
  readonly spec: UtilitySpec;
}

export function generateDecisionCases(sequences = 3): GeneratedCase[] {
  let random = initializeNamedRandomStreams(decisionsSeed, decisionsStreams);
  const next = (bound: number): number => {
    const drawn = drawNamedRandomStream(random, "behavior");
    random = drawn.randomState;
    return Number((drawn.draw.rawValue + 2147483648n) >> 8n) % bound;
  };
  const cases: GeneratedCase[] = [];
  for (let sequence = 0; sequence < sequences; sequence += 1) {
    const dry = 1500 + next(3) * 500;
    const wet = 1500 + next(3) * 500;
    const intervalMs = next(2) === 0 ? 500 : 1000;
    const actorCount = 1 + next(2);
    const actors = Array.from(
      { length: actorCount },
      (_, index) => [`weather-${sequence}-${index}`, null] as const,
    );
    const itemCount = 2 + next(4);
    const kinds = ["food", "water", "shelter"] as const;
    const items: ItemSpec[] = Array.from({ length: itemCount }, (_, index) => {
      const kind = kinds[next(3)]!;
      const at = [next(9) * 1000, next(5) * 1000] as const;
      const id = `item-${sequence}-${index}`;
      return kind === "shelter"
        ? shelter(id, at, [0, 3000, 10000][next(3)]!)
        : { id, kind, at, quantity: 1 + next(8) };
    });
    const initial: InitialNeeds[] = actors.map(() => ({
      hunger: next(10001),
      wetness: next(10001),
      thirst: next(10001),
      health: 5000 + next(5001),
    }));
    const starts = actors.map(() => [next(9) * 1000, next(5) * 1000] as const);
    const scripted: ScriptedSpec[] = Array.from({ length: next(4) }, (_, index) => ({
      ref: `scripted:${sequence}:${index}`,
      kind: next(2) === 0 ? ("belief" as const) : ("memory" as const),
      actorId: actors[next(actorCount)]![0],
      targetObjectId: items[next(itemCount)]!.id,
      value: next(10001),
      effectiveAt: BigInt(next(4000)),
    }));
    const useRegion = next(2) === 0;
    const regionBox = [
      1000 + next(3) * 1000,
      next(2) * 1000,
      4000 + next(4) * 1000,
      2000 + next(3) * 1000,
    ] as const;
    const graph = next(2) === 0 ? ("items" as const) : ("none" as const);
    const thirstPerInterval = 100 + next(300);
    const spec: UtilitySpec = {
      dayLengthMs: dry + wet,
      phases: [[`only-${sequence}`, 0, "all"]],
      segments: [
        [dry, 0, "temp-dry"],
        [wet, 10000, "temp-wet"],
      ],
      wetThreshold: 2000,
      discomfortThreshold: 4000,
      intervalMs,
      hungerPerInterval: 100 + next(300),
      wetnessPerInterval: 800 + next(4) * 400,
      dryingPerInterval: 200 + next(3) * 200,
      actors,
      wellbeing: {
        thirstPerInterval,
        healthLossPerInterval: 200 + next(4) * 200,
        healthRecoveryPerInterval: 200 + next(3) * 300,
        urgentHunger: 6000 + next(3000),
        urgentThirst: 6000 + next(3000),
        criticalHealth: 3000 + next(3) * 1000,
      },
      initial,
      starts,
      items,
      scripted,
      graph,
      ...(useRegion
        ? { regions: [["box", regionBox[0], regionBox[1], regionBox[2], regionBox[3]] as const] }
        : {}),
      utility: {
        thirstWeight: 500 + next(3001),
        expectationWeight: next(1001),
        travelWeight: next(501),
        unitsPerSecond: BigInt(1000 + next(4) * 1000),
        perceptionRange: BigInt(2000 + next(8) * 1000),
        biteQuantity: 1 + next(3),
        hungerReliefPerUnit: 500 + next(4) * 500,
        thirstReliefPerUnit: 500 + next(4) * 500,
      },
    };
    const horizon = BigInt(dry + wet + Math.floor((dry + wet) / 2));
    cases.push({
      sequence,
      spec,
      horizon,
      chainEvents: 24 * actorCount + 8 + next(4),
      chainInputs: 1 + next(4),
      liveSteps: Array.from({ length: 6 }, () => 1 + next(intervalMs)),
    });
  }
  return cases;
}

export async function runGeneratedCase(entry: GeneratedCase): Promise<DecisionSummary> {
  const start = await utilityWorld(entry.spec);
  const label = `decisions:${entry.sequence}`;
  const runs = decisionRuns(start, label, entry);
  const summary = checkDecisionRun(start, runs.fast, label);
  const replay = runChain(start, `${label}:fast`, entry.horizon);
  if (
    canonicalSerialize([runs.fast.events, runs.fast.world.state]) !==
    canonicalSerialize([replay.events, replay.world.state])
  )
    fail(`${label}: replay differs`);
  const pairs = await decisionPairs(runs);
  for (const pair of pairs) if (pair.leftHash !== pair.rightHash) fail(`${label}: ${pair.name}`);
  return {
    ...summary,
    calls:
      runs.fast.calls.length +
      runs.live.calls.length +
      runs.bounded.calls.length +
      runs.scheduled.calls.length,
  };
}

// ---------------------------------------------------------------------------------------------
// Golden: favorite-snack-house
// ---------------------------------------------------------------------------------------------

export const SNACK_SPEC: UtilitySpec = {
  dayLengthMs: 20000,
  phases: [["only", 0, "all"]],
  segments: [
    [9000, 0, "dry"],
    [11000, 10000, "wet"],
  ],
  wetThreshold: 3000,
  discomfortThreshold: 6000,
  intervalMs: 1000,
  hungerPerInterval: 400,
  wetnessPerInterval: 1500,
  dryingPerInterval: 1000,
  actors: [["resident-x", null]],
  wellbeing: {
    thirstPerInterval: 300,
    healthLossPerInterval: 500,
    healthRecoveryPerInterval: 500,
    urgentHunger: 8000,
    urgentThirst: 8000,
    criticalHealth: 5000,
  },
  items: [
    food("trash-bin", [2000, 0], 20),
    food("snack-house", [8000, 0], 6),
    water("water-bowl", [8000, 2000], 20),
    shelter("den", [8000, 3000], 10000),
  ],
  utility: DEFAULT_UTILITY,
  scripted: [
    {
      ref: "scripted:memory:snack-house",
      kind: "memory",
      actorId: "resident-x",
      targetObjectId: "snack-house",
      value: 6000,
      effectiveAt: 2500n,
    },
    {
      ref: "scripted:belief:snack-house",
      kind: "belief",
      actorId: "resident-x",
      targetObjectId: "snack-house",
      value: 4000,
      effectiveAt: 3000n,
    },
  ],
};
export const SNACK_CONTROL_SPEC: UtilitySpec = (() => {
  const { scripted: _scripted, ...rest } = SNACK_SPEC;
  return rest;
})();
export const SNACK_PLAN: RunPlan = {
  horizon: 14000n,
  chainInputs: 8,
  chainEvents: 24,
  liveSteps: [700],
};

export interface SnackGolden extends DecisionRuns {
  readonly control: Run;
  readonly start: EnvironmentWorld;
  readonly controlStart: EnvironmentWorld;
}

export async function snackGolden(): Promise<SnackGolden> {
  const start = await utilityWorld(SNACK_SPEC);
  const controlStart = await utilityWorld(SNACK_CONTROL_SPEC);
  return {
    ...decisionRuns(start, "snack", SNACK_PLAN),
    control: runChain(controlStart, "snack:control", SNACK_PLAN.horizon),
    start,
    controlStart,
  };
}

export async function snackGoldenHashes(golden: SnackGolden) {
  return { name: "favorite-snack-house", ...(await decisionsHashes(golden.fast)) };
}

// ---------------------------------------------------------------------------------------------
// Targeted cases
// ---------------------------------------------------------------------------------------------

export const WITH = (over: Partial<UtilitySpec>): UtilitySpec => ({ ...BASE, ...over });

/** Far bin with scripted entries: also the base world of the refusal inputs. */
export const SCRIPTED_SPEC: UtilitySpec = WITH({
  actors: [
    ["a-weather", null],
    ["b-weather", null],
  ],
  items: [food("far-bin", [8000, 0]), water("far-bowl", [9000, 0], 3)],
  scripted: [
    {
      ref: "scripted:belief:far-bin",
      kind: "belief",
      actorId: "a-weather",
      targetObjectId: "far-bin",
      value: 10000,
      effectiveAt: 2000n,
    },
    {
      ref: "scripted:memory:far-bowl",
      kind: "memory",
      actorId: "a-weather",
      targetObjectId: "far-bowl",
      value: 500,
      effectiveAt: 5000n,
    },
  ],
});

export const EXCLUSION_SPEC: UtilitySpec = WITH({
  items: [
    food("a-near-bin", [1000, 0]),
    food("b-far-bin", [9000, 0]),
    food("c-empty-bin", [500, 0], 0),
    shelter("d-dry-shelter", [500, 500], 0),
    food("e-island-bin", [2000, 0]),
    food("f-other-bin", [1000, 0], 4, "other-zone"),
  ],
  graph: {
    anchors: [
      ["start", 0, 0],
      ["a-near-bin", 1000, 0],
      ["e-island-bin", 2000, 0],
    ],
    edges: [["a-near-bin", "start"]],
  },
});

interface TargetedSpec {
  readonly label: string;
  readonly spec: UtilitySpec;
  readonly horizon: bigint;
}

export const TARGETED_SPECS: readonly TargetedSpec[] = [
  { label: "seek-food", spec: WITH({ items: [food("bin", [2000, 0])] }), horizon: 3000n },
  {
    label: "seek-water",
    spec: WITH({ items: [water("bowl", [2000, 0])], initial: [needs(0, 0, 6000)] }),
    horizon: 2500n,
  },
  {
    label: "seek-shelter",
    spec: WITH({ ...RAIN, hunger: 0, items: [shelter("den", [2000, 0])] }),
    horizon: 2500n,
  },
  { label: "stay", spec: WITH({}), horizon: 2500n },
  { label: "immediate", spec: WITH({ items: [food("bin", [0, 0])] }), horizon: 1500n },
  {
    label: "emptied-before-arrival",
    spec: WITH({
      actors: [
        ["a-weather", null],
        ["b-weather", null],
      ],
      starts: [
        [0, 0],
        [1000, 0],
      ],
      items: [food("bin", [2000, 0], 2)],
    }),
    horizon: 2000n,
  },
  {
    label: "continued",
    spec: WITH({
      items: [food("bin", [6000, 0])],
      utility: { ...DEFAULT_UTILITY, perceptionRange: 7000n },
    }),
    horizon: 3500n,
  },
  {
    label: "replan",
    spec: WITH({
      wellbeing: { ...QUIET, thirstPerInterval: 3000 },
      items: [food("f-bin", [4000, 0]), water("w-bowl", [2000, 1000])],
      utility: { ...DEFAULT_UTILITY, perceptionRange: 5000n },
    }),
    horizon: 2500n,
  },
  {
    label: "interrupt",
    spec: WITH({
      actors: [
        ["a-weather", null],
        ["b-weather", null],
      ],
      starts: [
        [0, 0],
        [3000, 0],
      ],
      items: [food("bin", [4000, 0], 2)],
      utility: { ...DEFAULT_UTILITY, perceptionRange: 5000n },
    }),
    horizon: 2500n,
  },
  {
    label: "leave-shelter",
    spec: WITH({ items: [shelter("den", [0, 0]), food("bin", [2000, 0])], located: ["den"] }),
    horizon: 1500n,
  },
  {
    label: "shelter-exposure",
    spec: WITH({
      ...RAIN,
      hunger: 0,
      initial: [needs(0, 1500, 0)],
      items: [shelter("den", [1000, 0])],
    }),
    horizon: 2000n,
  },
  {
    label: "shelter-absent",
    spec: WITH({ ...RAIN, hunger: 0, initial: [needs(0, 1500, 0)] }),
    horizon: 2000n,
  },
  {
    label: "region",
    spec: WITH({
      items: [food("bin", [4000, 0])],
      utility: { ...DEFAULT_UTILITY, perceptionRange: 5000n },
      regions: [["r1", 1000, -500, 3000, 500]],
    }),
    horizon: 3000n,
  },
  { label: "scripted-timing", spec: SCRIPTED_SPEC, horizon: 2500n },
  {
    label: "reflex",
    spec: WITH({
      ...RAIN,
      initial: [needs(9000, 9500, 0)],
      items: [shelter("den", [4000, 0], 1000), food("bin", [1000, 0])],
      utility: { ...DEFAULT_UTILITY, perceptionRange: 5000n },
    }),
    horizon: 1500n,
  },
];

/** A near-saturated hunger: a hostile negative relief rate then yields a value the reducer rejects. */
export const REDUCER_SPEC: UtilitySpec = WITH({
  items: [food("bin", [2000, 0])],
  initial: [needs(9999, 0, 0)],
});

/** An urgent-hunger crossing at 200 ms brings a decision forward of the queued one. */
export const BROUGHT_SPEC: UtilitySpec = WITH({
  items: [food("bin", [2000, 0])],
  wellbeing: { ...QUIET, urgentHunger: 3001 },
});

export interface TargetedCases {
  readonly worlds: Readonly<Record<string, EnvironmentWorld>>;
  readonly specs: Readonly<Record<string, UtilitySpec>>;
  readonly runs: ReadonlyArray<readonly [string, Run]>;
  readonly by: Readonly<Record<string, Run>>;
  readonly refused: ReadonlyArray<readonly [string, WorldKernelInput, WorldKernelOutcome]>;
}

async function buildTargetedCases(): Promise<TargetedCases> {
  const runs: Array<readonly [string, Run]> = [];
  const by: Record<string, Run> = {};
  const worlds: Record<string, EnvironmentWorld> = {};
  const specs: Record<string, UtilitySpec> = {};
  const track = (label: string, run: Run): Run => {
    runs.push([label, run]);
    by[label] = run;
    return run;
  };
  for (const { label, spec, horizon } of TARGETED_SPECS) {
    const world = await utilityWorld(spec);
    worlds[label] = world;
    specs[label] = spec;
    track(label, runChain(world, `targeted:${label}`, horizon));
  }
  // A scheduled seek: the first queued decision starts a movement without advancing time.
  const seek = worlds["seek-food"]!;
  worlds["scheduled-seek"] = seek;
  specs["scheduled-seek"] = specs["seek-food"]!;
  track("scheduled-seek", applyCommand(seek, scheduledInput(seek, firstItem(seek))));
  // The exclusion reasons in one decision.
  const exclusion = await utilityWorld(EXCLUSION_SPEC);
  worlds.exclusions = exclusion;
  specs.exclusions = EXCLUSION_SPEC;
  track("exclusions", applyCommand(exclusion, scheduledInput(exclusion, firstItem(exclusion))));
  // A tight event budget splits a decision-time group into continuation calls.
  const tight = worlds["seek-food"]!;
  worlds["seek-food-tight"] = tight;
  specs["seek-food-tight"] = specs["seek-food"]!;
  track("seek-food-tight", runChain(tight, "targeted:seek-food-tight", 3000n, 1024, 8));
  return { worlds, specs, runs, by, refused: [] };
}

let targetedPromise: Promise<TargetedCases> | undefined;
export function targetedCases(): Promise<TargetedCases> {
  targetedPromise ??= buildTargetedCases();
  return targetedPromise;
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

function withUtility(base: WorldKernelInput, value: unknown): WorldKernelInput {
  const { utility: _removed, ...rest } = base.pack.pack.policy as Loose;
  return setPolicy(base, value === REMOVE ? rest : { ...rest, utility: value });
}

function mutateUtility(
  base: WorldKernelInput,
  change: (record: Loose) => unknown,
): WorldKernelInput {
  const record = structuredClone((base.pack.pack.policy as Loose).utility) as Loose;
  const changed = change(record);
  return withUtility(base, changed === undefined ? record : changed);
}

function withScripted(base: WorldKernelInput, value: unknown): WorldKernelInput {
  const { scriptedCognition: _removed, ...rest } = base.partition.state as Loose;
  const state = value === REMOVE ? rest : { ...rest, scriptedCognition: value };
  return { ...base, partition: { ...base.partition, state: state as WorldState } };
}

function mutateScripted(
  base: WorldKernelInput,
  change: (record: Loose) => unknown,
): WorldKernelInput {
  const record = structuredClone(base.partition.state.scriptedCognition) as Loose;
  const changed = change(record);
  return withScripted(base, changed === undefined ? record : changed);
}

export interface RefusalCase {
  readonly name: string;
  readonly input: unknown;
}

const MARGIN = { kind: "score-margin", maxMargin: 0n };
const UNPERCEIVED = { kind: "unperceived-target" };
const ambiguity = (schemaVersion: number, conditions: unknown[]) => ({ schemaVersion, conditions });

/** Fixed named refusal inputs; the expected envelopes are pinned in `spatial-evidence.ts`. */
export function decisionsRefusalInputs(base: WorldKernelInput): RefusalCase[] {
  const policy = (name: string, change: (record: Loose) => unknown): RefusalCase => ({
    name,
    input: mutateUtility(base, change),
  });
  const state = (name: string, change: (record: Loose) => unknown): RefusalCase => ({
    name,
    input: mutateScripted(base, change),
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
    { name: "utility-null", input: withUtility(base, null) },
    { name: "utility-wrong-type", input: withUtility(base, "utility") },
    policy("missing-field", drop("travelWeight")),
    policy("extra-field", set("extra", 1)),
    policy("unknown-version", set("schemaVersion", 2)),
    policy("unknown-scorer", set("scorer", "clockgrove.other")),
    policy("unknown-scorer-version", set("scorerVersion", 2)),
    {
      name: "utility-without-wellbeing",
      input: setPolicy(
        base,
        (({ wellbeing: _w, ...rest }) => rest)(base.pack.pack.policy as Loose),
      ),
    },
    policy("thirst-weight-out-of-range", set("thirstWeight", 10001)),
    policy("expectation-weight-negative", set("expectationWeight", -1)),
    policy("travel-weight-non-integer", set("travelWeight", 1.5)),
    policy("speed-zero", set("unitsPerSecond", 0n)),
    policy("speed-wrong-type", set("unitsPerSecond", 2000)),
    policy("range-negative", set("perceptionRange", -1n)),
    policy("range-wrong-type", set("perceptionRange", 3000)),
    policy("bite-zero", set("biteQuantity", 0)),
    policy("bite-non-integer", set("biteQuantity", 1.5)),
    policy("hunger-relief-zero", set("hungerReliefPerUnit", 0)),
    policy("hunger-relief-out-of-range", set("hungerReliefPerUnit", 10001)),
    policy("thirst-relief-zero", set("thirstReliefPerUnit", 0)),
    policy("thirst-relief-out-of-range", set("thirstReliefPerUnit", 10001)),
    policy("ambiguity-null", set("ambiguity", null)),
    policy("ambiguity-unknown-version", set("ambiguity", ambiguity(2, [MARGIN]))),
    policy("ambiguity-no-conditions", set("ambiguity", ambiguity(1, []))),
    policy("ambiguity-unknown-condition", set("ambiguity", ambiguity(1, [{ kind: "novel" }]))),
    policy("ambiguity-out-of-order", set("ambiguity", ambiguity(1, [UNPERCEIVED, MARGIN]))),
    policy("ambiguity-duplicate", set("ambiguity", ambiguity(1, [MARGIN, MARGIN]))),
    policy(
      "ambiguity-margin-negative",
      set("ambiguity", ambiguity(1, [{ kind: "score-margin", maxMargin: -1n }])),
    ),
    policy(
      "ambiguity-margin-wrong-type",
      set("ambiguity", ambiguity(1, [{ kind: "score-margin", maxMargin: 5 }])),
    ),
    policy(
      "ambiguity-condition-extra-field",
      set("ambiguity", ambiguity(1, [{ ...UNPERCEIVED, maxMargin: 0n }])),
    ),
    { name: "state-null", input: withScripted(base, null) },
    { name: "state-wrong-type", input: withScripted(base, "record") },
    state("state-missing-field", drop("entries")),
    state("state-extra-field", set("extra", 1)),
    state("state-unknown-version", set("schemaVersion", 2)),
    state("source-not-scripted", set("source", "observed")),
    state("entries-wrong-type", set("entries", "none")),
    state("entries-over-bound", (record) => {
      record.entries = Array.from({ length: 65 }, (_, index) => ({
        ...record.entries[0],
        ref: `scripted:over:${String(index).padStart(3, "0")}`,
      }));
      return record;
    }),
    state("entry-null", (record) => {
      record.entries[0] = null;
      return record;
    }),
    state("entry-missing-field", entry(0, "value", REMOVE)),
    state("entry-extra-field", entry(0, "extra", 1)),
    state("entry-ref-prefix", entry(0, "ref", "belief:far-bin")),
    state("entries-out-of-order", (record) => {
      record.entries.reverse();
      return record;
    }),
    state("entries-duplicate-ref", (record) => {
      record.entries[1].ref = record.entries[0].ref;
      return record;
    }),
    state("entry-kind-unsupported", entry(0, "kind", "rumor")),
    state("entry-actor-wrong-type", entry(0, "actorId", 5)),
    state("entry-value-out-of-range", entry(0, "value", 10001)),
    state("entry-effective-at-negative", entry(0, "effectiveAt", -1n)),
    state("entry-effective-at-wrong-type", entry(0, "effectiveAt", 5)),
    { name: "state-without-policy", input: withUtility(base, REMOVE) },
    state("entry-actor-unknown", entry(0, "actorId", "ghost")),
    state("entry-actor-not-needs", entry(0, "actorId", "far-bin")),
    state("entry-target-unknown", entry(0, "targetObjectId", "ghost")),
    state("entry-target-not-seekable", entry(0, "targetObjectId", "a-weather")),
    {
      name: "plan-mismatch",
      input: {
        ...base,
        partition: {
          ...base.partition,
          state: {
            ...base.partition.state,
            entities: base.partition.state.entities.map((entity) =>
              entity.objectId === "a-weather"
                ? { ...entity, selectedAction: { kind: "stay" } }
                : entity,
            ),
          } as unknown as WorldState,
        },
      } as WorldKernelInput,
    },
  ];
}

// ---------------------------------------------------------------------------------------------
// Hostile reads
// ---------------------------------------------------------------------------------------------

const UTILITY_FIELDS = [
  "unitsPerSecond",
  "perceptionRange",
  "biteQuantity",
  "hungerReliefPerUnit",
  "thirstReliefPerUnit",
  "thirstWeight",
  "expectationWeight",
  "travelWeight",
] as const;

/** Wraps the utility policy so reads of `field` after `validReads` misbehave. */
export function flakyUtility(
  base: WorldKernelInput,
  field: string,
  validReads: number,
  mode: "invalid" | "throw",
): WorldKernelInput {
  const utility = structuredClone((base.pack.pack.policy as Loose).utility) as Loose;
  let reads = 0;
  const hostile = new Proxy(utility, {
    get(target, property, receiver) {
      if (property === field) {
        reads += 1;
        if (reads > validReads) {
          if (mode === "throw") throw new Error("hostile utility read");
          return typeof Reflect.get(target, property, receiver) === "bigint" ? -1n : -1;
        }
      }
      return Reflect.get(target, property, receiver);
    },
  });
  return withUtility(base, hostile);
}

export function utilitySweep(base: WorldKernelInput, mode: "invalid" | "throw", code: string) {
  for (const field of UTILITY_FIELDS)
    for (let validReads = 0; validReads < 300; validReads += 1) {
      const input = flakyUtility(base, field, validReads, mode);
      const outcome = executeWorldKernel(input, { mode: "test" });
      if (!outcome.ok && outcome.error.code === code) return { input, outcome };
      if (outcome.ok && validReads > 120) break;
    }
  throw new Error(`no ${code} found by the hostile utility sweep`);
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

export async function describeDecision(label: string, input: unknown, outcome: WorldKernelOutcome) {
  const entry = await describeCall(label, input, outcome);
  const decisions = [];
  if (outcome.ok)
    for (const draft of outcome.result.decisionDrafts) {
      const trace = draft.decision as unknown as Loose;
      const candidates = trace.candidates as Loose[];
      decisions.push({
        objectId: String(trace.objectId),
        time: String(trace.simulationTime),
        policyVersion: String(trace.policyVersion),
        tier: String(trace.selectionTier),
        action: {
          kind: String(trace.selectedAction.kind),
          targetObjectId: (trace.selectedAction.targetObjectId as string | undefined) ?? null,
        },
        candidateCount: candidates.length,
        excludedCount: candidates.filter((candidate) => candidate.excludedReason !== undefined)
          .length,
        exclusionReasons: [
          ...new Set(
            candidates.flatMap((candidate) =>
              candidate.excludedReason === undefined ? [] : [String(candidate.excludedReason)],
            ),
          ),
        ].sort(),
        outcomeLinks: [...(trace.outcomeLinks as string[])],
        traceHash: await hashOf(trace),
      });
    }
  return { ...entry, decisions };
}

export type DecisionsEntry = Awaited<ReturnType<typeof describeDecision>>;

async function describeSynthetic(
  label: string,
  type: string,
  source: unknown,
  error: Refusal,
): Promise<DecisionsEntry> {
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
    decisions: [],
  };
}

async function runEntries(prefix: string, run: Run): Promise<DecisionsEntry[]> {
  const entries: DecisionsEntry[] = [];
  for (const [index, call] of run.calls.entries())
    entries.push(await describeDecision(`${prefix}${index}`, call.input, call.outcome));
  return entries;
}

async function generatedEntries(): Promise<DecisionsEntry[]> {
  const entries: DecisionsEntry[] = [];
  for (const entry of generateDecisionCases()) {
    const world = await utilityWorld(entry.spec);
    const scheduled = runScheduledDecisions(
      world,
      `decisions:${entry.sequence}:scheduled`,
      entry.horizon,
    );
    entries.push(...(await runEntries(`generated:${entry.sequence}:scheduled:`, scheduled)));
  }
  return entries;
}

async function goldenEntries(): Promise<DecisionsEntry[]> {
  const golden = await snackGolden();
  return [
    ...(await runEntries("case:snack-scheduled-", golden.scheduled)),
    ...(await runEntries("case:snack-control-", golden.control)),
  ];
}

async function targetedEntries(): Promise<DecisionsEntry[]> {
  const entries: DecisionsEntry[] = [];
  const cases = await targetedCases();
  for (const [label, run] of cases.runs)
    entries.push(...(await runEntries(`targeted:${label}:`, run)));
  return entries;
}

export interface RefusalBase {
  readonly settled: EnvironmentWorld;
  readonly base: WorldKernelInput;
}

export async function reducerBaseInput(): Promise<WorldKernelInput> {
  return advanceInput(await utilityWorld(REDUCER_SPEC), "refusal:reducer", 1500n);
}

export async function refusalBase(): Promise<RefusalBase> {
  const world = await utilityWorld(SCRIPTED_SPEC);
  const settled = runChain(world, "refusal:settle", 2500n).world;
  return { settled, base: advanceInput(settled, "refusal:base", 6000n) };
}

async function refusalEntries(): Promise<DecisionsEntry[]> {
  const entries: DecisionsEntry[] = [];
  const { settled, base } = await refusalBase();
  for (const { name, input } of decisionsRefusalInputs(base))
    entries.push(
      await describeDecision(
        `refusal:${name}`,
        input,
        executeWorldKernel(input as WorldKernelInput, { mode: "test" }),
      ),
    );
  for (const { name, input } of scheduledRefusalInputs(settled))
    entries.push(
      await describeDecision(`refusal:${name}`, input, executeWorldKernel(input, { mode: "test" })),
    );
  // Scheduled decisions: stale retry, not first due, brought forward.
  const early = await utilityWorld(BROUGHT_SPEC);
  const decided = applyCommand(early, scheduledInput(early, firstItem(early)));
  const accepted = applyCommand(settled, scheduledInput(settled, firstItem(settled)));
  const stale = scheduledInput(settled, firstItem(settled));
  const scheduledRefusals: Array<readonly [string, WorldKernelInput]> = [
    [
      "scheduled-stale-retry",
      {
        ...stale,
        partition: {
          ...stale.partition,
          revision: accepted.world.state.revision,
          state: accepted.world.state,
        },
        simulationTime: accepted.world.state.simulationTime,
        schedules: accepted.world.schedules,
      },
    ],
    ["scheduled-not-first", scheduledInput(settled, firstItem(settled, 1))],
    ["scheduled-brought-forward", scheduledInput(decided.world, firstItem(decided.world))],
  ];
  for (const [name, input] of scheduledRefusals)
    entries.push(
      await describeDecision(`refusal:${name}`, input, executeWorldKernel(input, { mode: "test" })),
    );
  // Post-state invariant for every command: a final state whose movement disagrees with the action.
  const policy = base.pack.pack.policy;
  const state = base.partition.state;
  const disagreeing = createWorldState({
    ...state,
    entities: state.entities.map((entity) =>
      entity.objectId === "a-weather" ? { ...entity, selectedAction: { kind: "stay" } } : entity,
    ),
  } as never);
  for (const [name, type] of [
    ["invariant-advance", "world.advance"],
    ["invariant-weather-set", "world.weather.set"],
    ["invariant-containment", "resource.offer"],
  ] as const) {
    const error = checkWorldInvariants(state, disagreeing, [], type, policy);
    if (error === undefined) throw new Error("invariant did not refuse a disagreeing movement");
    entries.push(
      await describeSynthetic(
        `refusal:${name}`,
        type,
        { initial: state, final: disagreeing, policy, type },
        error,
      ),
    );
  }
  // Movement-system exception: the engine converts it to a returned refusal.
  const throwing = createCatchUpRegistry({
    payloads: [],
    systems: [
      {
        kind: "movement:throwing",
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
      [{ systemId: "movement:throwing@1", at: 0n as SimTimeMs, state: {} }],
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
  // Candidate, scorer and reducer exceptions through the full executor.
  const cases = await targetedCases();
  const tiny = cases.worlds["seek-food"]!;
  const tinyBase = advanceInput(tiny, "refusal:exception", 1500n);
  const handler = utilitySweep(tinyBase, "throw", "handler-failed");
  entries.push(await describeDecision("refusal:handler-exception", tinyBase, handler.outcome));
  const reducerBase = await reducerBaseInput();
  const reducer = utilitySweep(reducerBase, "invalid", "reducer-failed");
  entries.push(await describeDecision("refusal:reducer-exception", reducerBase, reducer.outcome));
  return entries;
}

export async function decisionsEvidence() {
  const golden = await snackGolden();
  const traces = tracesOf(golden.fast);
  return {
    schemaVersion: 1,
    seed: decisionsSeed,
    entries: [
      ...(await generatedEntries()),
      ...(await goldenEntries()),
      ...(await targetedEntries()),
      ...(await refusalEntries()),
    ],
    pairs: await decisionPairs(golden),
    golden: await snackGoldenHashes(golden),
    traces: plain(traceView(traces)),
  };
}

export { only, payloadOf, timeOf };
