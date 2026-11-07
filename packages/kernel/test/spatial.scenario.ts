import type {
  CommandId,
  ObjectId,
  SimTimeMs,
  SpaceId,
  SpatialFrameId,
} from "@clockgrove/contracts";
import {
  createWorldState,
  fixedPoint,
  type MovementCommandType,
  type MovementRecord,
  parseAnchorGraph,
  replayWorldEvents,
  type SpatialRegion,
  shapeBounds,
  type WorldEntity,
  type WorldEvent,
  type WorldState,
} from "@clockgrove/domain";
import { canonicalSerialize } from "../src/canonical.js";
import { createDeterministicIdSource } from "../src/deterministic-id.js";
import { drawNamedRandomStream, initializeNamedRandomStreams } from "../src/random.js";
import {
  parseAnchorGraphAtBoundary,
  parseSpatialRegionAtBoundary,
} from "../src/spatial/boundary.js";
import {
  classifyCell,
  compareIds,
  pointInBounds,
  SPATIAL_THRESHOLDS,
  type SpatialBinding,
  type SpatialIndexFactory,
  type SpatialIndexPort,
} from "../src/spatial/index-port.js";
import { createQuadtreeSpatialIndex } from "../src/spatial/quadtree.js";
import {
  checkWorldInvariants,
  executeWorldKernel,
  type MovementKernelInput,
  type WorldKernelInput,
  worldRegistryIdentity,
} from "../src/world.js";
import { containmentInputIdentity } from "./containment.scenario.js";
import { assertEnvelope } from "./executor.scenario.js";
import { SPATIAL_REFUSAL_CASES } from "./spatial-evidence.js";
import { scenarioInput, scenarios, stateHash } from "./weather-needs.scenario.js";

export const spatialSeed = { version: 1, seed: "spatial-movement-v1" } as const;
const streams = ["behavior", "lifecycle", "movement", "weather"];

export const GROUND = "ground-frame" as SpatialFrameId;
export const TREE = "tree-frame" as SpatialFrameId;
const f = fixedPoint;
const p2 = (x: bigint, y: bigint) => [f(x), f(y)] as const;

/** Reference 2D ground-plane anchors (metres scaled by 1000). */
export const ANCHORS: readonly (readonly [string, bigint, bigint])[] = [
  ["den-mouth", 0n, 0n],
  ["fence-gap", 4000n, 6000n],
  ["garden-edge", 8000n, 6000n],
  ["porch-step", 4000n, 0n],
  ["trash-front", 8000n, 0n],
  ["tree-base", 0n, 6000n],
];
export const EDGES: readonly (readonly [string, string, bigint])[] = [
  ["den-mouth", "porch-step", 4000n],
  ["den-mouth", "tree-base", 6000n],
  ["fence-gap", "garden-edge", 4000n],
  ["fence-gap", "porch-step", 6000n],
  ["fence-gap", "tree-base", 4000n],
  ["fence-gap", "trash-front", 7500n],
  ["garden-edge", "trash-front", 6000n],
  ["porch-step", "trash-front", 4000n],
];

export function groundFrame() {
  return {
    frameId: GROUND,
    version: 1,
    dimensions: 2 as const,
    unit: { name: "metre", fractionalDigits: 3 },
    axes: {
      axes: [
        { name: "east", positiveDirection: "eastward" },
        { name: "north", positiveDirection: "northward" },
      ],
    },
    origin: p2(0n, 0n),
    gravity: { kind: "constant-vector" as const, vector: p2(0n, 0n) },
  };
}
/** Non-rendered 3D fixture with a parent transform onto the ground frame. */
export function treeFrame() {
  const z = f(0n),
    one = f(1000n);
  return {
    frameId: TREE,
    version: 1,
    dimensions: 3 as const,
    unit: { name: "metre", fractionalDigits: 3 },
    axes: {
      axes: [
        { name: "east", positiveDirection: "eastward" },
        { name: "north", positiveDirection: "northward" },
        { name: "up", positiveDirection: "skyward" },
      ],
    },
    parentFrameId: GROUND,
    parentTransform: {
      version: 1,
      translation: [f(2000n), z, z] as const,
      basis: [
        [one, z, z],
        [z, one, z],
        [z, z, one],
      ] as const,
    },
    origin: [z, z, z] as const,
    gravity: { kind: "constant-vector" as const, vector: [z, z, f(-9810n)] as const },
  };
}
export function regions() {
  return [
    {
      regionId: "garden",
      version: 1,
      frameId: GROUND,
      frameVersion: 1,
      shape: {
        kind: "polygon" as const,
        vertices: [p2(6000n, 5000n), p2(10000n, 5000n), p2(10000n, 8000n), p2(6000n, 8000n)],
      },
    },
    {
      regionId: "pond",
      version: 1,
      frameId: GROUND,
      frameVersion: 1,
      shape: { kind: "circle" as const, center: p2(-1000n, 3000n), radius: f(1000n) },
    },
    {
      regionId: "porch",
      version: 1,
      frameId: GROUND,
      frameVersion: 1,
      shape: { kind: "rectangle" as const, min: p2(3000n, -1000n), max: p2(5000n, 1000n) },
    },
    {
      regionId: "tree-box",
      version: 1,
      frameId: TREE,
      frameVersion: 1,
      shape: {
        kind: "box" as const,
        min: [f(1000n), f(-1000n), f(0n)] as const,
        max: [f(3000n), f(1000n), f(2000n)] as const,
      },
    },
  ];
}
export function anchorGraph() {
  return {
    graphId: "yard",
    version: 1,
    frameId: GROUND,
    frameVersion: 1,
    anchors: ANCHORS.map(([anchorId, x, y]) => ({ anchorId, coordinates: p2(x, y) })),
    edges: EDGES.map(([from, to, cost]) => ({ from, to, cost: f(cost) })),
  };
}
export function mover(
  objectId: string,
  at: readonly [bigint, bigint],
  extra: Partial<WorldEntity> = {},
): WorldEntity {
  return {
    objectId: objectId as ObjectId,
    spaceId: "yard" as SpaceId,
    archetypeId: "fixture.object@1",
    pose: { frameId: GROUND, frameVersion: 1, coordinates: p2(at[0], at[1]) },
    ...extra,
  } as WorldEntity;
}
/** A 3D object in the tree frame. */
export function climber(
  objectId: string,
  at: readonly [bigint, bigint, bigint] = [0n, 0n, 0n],
): WorldEntity {
  return {
    objectId: objectId as ObjectId,
    spaceId: "yard" as SpaceId,
    archetypeId: "fixture.object@1",
    pose: { frameId: TREE, frameVersion: 1, coordinates: [f(at[0]), f(at[1]), f(at[2])] },
  } as WorldEntity;
}

export async function spatialFixture(
  entities: readonly WorldEntity[] = [mover("mover", [0n, 0n])],
): Promise<WorldKernelInput> {
  const base = await scenarioInput(scenarios.raccoon);
  const state = createWorldState({
    ...base.partition.state,
    spatialFrames: [groundFrame(), treeFrame()],
    spatialRegions: regions(),
    anchorGraphs: [anchorGraph()],
    entities: [...entities],
  } as never);
  const pack = {
    ...base.pack.pack,
    archetypes: [...base.pack.pack.archetypes, "fixture.object@1"],
  };
  return {
    ...base,
    partition: { ...base.partition, state, revision: state.revision },
    simulationTime: state.simulationTime,
    schedules: [],
    pack: { ...base.pack, pack: { ...pack, contentHash: await stateHash(pack) } },
    randomState: initializeNamedRandomStreams(spatialSeed, streams),
  };
}
export function movementInput(
  base: WorldKernelInput,
  type: string,
  payload: unknown,
  id = "movement-test",
): MovementKernelInput {
  if (base.input.kind !== "command") throw new Error("command fixture required");
  const command = {
    ...base.input.command,
    type,
    commandId: id as CommandId,
    expected: { partitionRevision: base.partition.revision },
    payload,
  } as never;
  return {
    ...base,
    input: { kind: "command", command },
    simulationTime: base.partition.state.simulationTime,
    ids: createDeterministicIdSource({
      commandId: id as CommandId,
      eventIndex: 0,
      randomStream: "movement",
    }),
  } as MovementKernelInput;
}
export const toAnchor = (anchorId: string) => ({ kind: "anchor", anchorId, graphVersion: 1 });
export const toPose = (x: bigint, y: bigint, frameId: SpatialFrameId = GROUND) => ({
  kind: "pose",
  pose: {
    frameId,
    frameVersion: 1,
    coordinates: frameId === GROUND ? p2(x, y) : [f(x), f(y), f(0n)],
  },
});
export const startPayload = (
  objectId: string,
  destination: unknown,
  extra: Record<string, unknown> = {},
) => ({ schemaVersion: 1, objectId, destination, unitsPerSecond: f(2000n), ...extra });

// ---------------------------------------------------------------------------------------------
// Test-owned index implementations. None shares code with the production quadtree adapter.
// ---------------------------------------------------------------------------------------------

/** Alternate, independent implementation: a flat binding list with a single cell. */
export function createLinearTestIndex(epoch: number): SpatialIndexPort {
  const bindings = new Map<string, SpatialBinding>();
  let mutations = 0;
  const guard = (value: number) => {
    if (value !== epoch) throw new RangeError("stale epoch");
  };
  return Object.freeze<SpatialIndexPort>({
    update: (at, change) => {
      guard(at);
      const id = change.binding.objectId as string;
      const existing = bindings.get(id);
      if (change.op === "remove") {
        if (existing === undefined) return [];
        bindings.delete(id);
        mutations += 1;
        return [id];
      }
      if (
        existing !== undefined &&
        canonicalSerialize(existing.pose.coordinates) ===
          canonicalSerialize(change.binding.pose.coordinates)
      )
        return [];
      bindings.set(id, change.binding);
      mutations += 1;
      return [id];
    },
    query: (at, region) => {
      guard(at);
      const [min, max] = shapeBounds(region.shape);
      return [...bindings.values()]
        .filter((binding) => pointInBounds(binding.pose.coordinates, { min, max }))
        .map((binding) => binding.objectId as string)
        .sort(compareIds);
    },
    summarize: (at, cellRef) => {
      guard(at);
      if (
        cellRef.indexKind !== "linear-test" ||
        cellRef.indexVersion !== 1 ||
        cellRef.indexEpoch !== epoch ||
        cellRef.level !== 0 ||
        cellRef.mortonCode !== "0"
      )
        throw new RangeError("foreign cell reference");
      return Object.freeze({
        cellRef: Object.freeze({ ...cellRef }),
        bounds: { min: [0n, 0n], max: [0n, 0n] },
        count: bindings.size,
        countBound: SPATIAL_THRESHOLDS.countBound,
        inputs: { objectCount: bindings.size, mutationCount: mutations },
        thresholdsVersion: SPATIAL_THRESHOLDS.version,
        classification: classifyCell(bindings.size, mutations),
      });
    },
  });
}
/** Faulty index whose query throws: the handler must fail with a returned refusal. */
export function createThrowingTestIndex(epoch: number): SpatialIndexPort {
  const fail = (): never => {
    throw new Error("index failure");
  };
  void epoch;
  return Object.freeze<SpatialIndexPort>({ update: () => [], query: fail, summarize: fail });
}
/** Faulty index that never reports a candidate: the reducer must refuse the missed crossings. */
export function createBlindTestIndex(epoch: number): SpatialIndexPort {
  void epoch;
  return Object.freeze<SpatialIndexPort>({
    update: () => [],
    query: () => [],
    summarize: () => {
      throw new RangeError("blind");
    },
  });
}

export interface IndexImplementation {
  readonly name: string;
  readonly factory: SpatialIndexFactory;
}
export const QUADTREE_IMPLEMENTATION: IndexImplementation = {
  name: "loose-quadtree",
  factory: createQuadtreeSpatialIndex,
};
export const LINEAR_IMPLEMENTATION: IndexImplementation = {
  name: "linear-test",
  factory: createLinearTestIndex,
};
export const IMPLEMENTATIONS: readonly IndexImplementation[] = [
  QUADTREE_IMPLEMENTATION,
  LINEAR_IMPLEMENTATION,
];

function equal(actual: unknown, expected: unknown): void {
  if (Object.is(actual, expected)) return;
  if (canonicalSerialize(actual) !== canonicalSerialize(expected))
    throw new Error(`spatial assertion failed: ${canonicalSerialize([actual, expected])}`);
}

export function crossingsOf(events: readonly WorldEvent[]) {
  return events
    .filter(
      (event) =>
        event.type === "movement.region-entered" || event.type === "movement.region-exited",
    )
    .map((event) => ({
      type: event.type,
      regionId: (event.payload as { regionId: string }).regionId,
      time: event.simulationTime.toString(),
    }));
}
export function movementOf(state: WorldState, objectId: string): MovementRecord | undefined {
  return state.entities.find((entity) => entity.objectId === objectId)?.movement;
}

// ---------------------------------------------------------------------------------------------
// Independent verifiers (integer arithmetic over the fixture data; no production geometry).
// ---------------------------------------------------------------------------------------------

const isqrt = (n: bigint): bigint => {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
};
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
const roundHalfUp = (num: bigint, den: bigint) => (2n * num + den) / (2n * den);

/** Minimum-cost simple path by exhaustive search; ties go to the lexicographically smallest ids. */
export function bruteForceRoute(from: string, to: string): string[] {
  const adjacent = new Map<string, [string, bigint][]>();
  for (const [a, b, cost] of EDGES) {
    adjacent.set(a, [...(adjacent.get(a) ?? []), [b, cost]]);
    adjacent.set(b, [...(adjacent.get(b) ?? []), [a, cost]]);
  }
  let best: { cost: bigint; path: string[] } | undefined;
  const less = (left: string[], right: string[]) => {
    for (let i = 0; i < Math.min(left.length, right.length); i += 1)
      if (left[i] !== right[i]) return left[i]! < right[i]!;
    return left.length < right.length;
  };
  const walk = (node: string, path: string[], cost: bigint): void => {
    if (node === to) {
      if (best === undefined || cost < best.cost || (cost === best.cost && less(path, best.path)))
        best = { cost, path };
      return;
    }
    for (const [next, step] of adjacent.get(node) ?? [])
      if (!path.includes(next)) walk(next, [...path, next], cost + step);
  };
  walk(from, [from], 0n);
  if (best === undefined) throw new Error("no brute-force route");
  return best.path;
}

type Fraction = readonly [bigint, bigint];
const cmp = (a: Fraction, b: Fraction) => {
  const d = a[0] * b[1] - b[0] * a[1];
  return d < 0n ? -1 : d > 0n ? 1 : 0;
};

function axisAlignedBounds(
  region: SpatialRegion,
): readonly [readonly bigint[], readonly bigint[]] | undefined {
  const shape = region.shape as unknown as {
    kind: string;
    min?: bigint[];
    max?: bigint[];
    vertices?: bigint[][];
  };
  if (shape.kind === "rectangle" || shape.kind === "box") return [shape.min!, shape.max!];
  if (shape.kind === "polygon" && shape.vertices!.length === 4) {
    const xs = new Set(shape.vertices!.map((v) => v[0]!));
    const ys = new Set(shape.vertices!.map((v) => v[1]!));
    if (xs.size === 2 && ys.size === 2) {
      const sx = [...xs].sort((a, b) => (a < b ? -1 : 1)),
        sy = [...ys].sort((a, b) => (a < b ? -1 : 1));
      return [
        [sx[0]!, sy[0]!],
        [sx[1]!, sy[1]!],
      ];
    }
  }
  return undefined;
}

/** Every (entered|exited) time an independent bigint interpolation allows for the region. */
export function independentCrossingTimes(
  movement: MovementRecord,
  region: SpatialRegion,
): Set<string> | undefined {
  const box = axisAlignedBounds(region);
  if (box === undefined) return undefined;
  const speed = (movement.segment.speed as unknown as { unitsPerSecond: bigint }).unitsPerSecond;
  const points = movement.segment.waypoints as readonly (readonly bigint[])[];
  const times = new Set<string>();
  let legStart = movement.segment.startTime as bigint;
  for (let leg = 1; leg < points.length; leg += 1) {
    const from = points[leg - 1]!,
      to = points[leg]!;
    const delta = to.map((value, axis) => value - from[axis]!);
    const length = isqrt(delta.reduce((sum, d) => sum + d * d, 0n));
    const duration = ceilDiv(length * 1000n, speed);
    let lo: Fraction = [0n, 1n],
      hi: Fraction = [1n, 1n],
      empty = false;
    for (let axis = 0; axis < delta.length && !empty; axis += 1) {
      const d = delta[axis]!,
        min = box[0][axis]!,
        max = box[1][axis]!,
        p0 = from[axis]!;
      if (d === 0n) {
        if (p0 < min || p0 > max) empty = true;
        continue;
      }
      const a: Fraction = d > 0n ? [min - p0, d] : [p0 - max, -d];
      const b: Fraction = d > 0n ? [max - p0, d] : [p0 - min, -d];
      if (cmp(a, lo) > 0) lo = a;
      if (cmp(b, hi) < 0) hi = b;
    }
    if (!empty && cmp(lo, hi) <= 0) {
      times.add((legStart + roundHalfUp(duration * lo[0], lo[1])).toString());
      times.add((legStart + roundHalfUp(duration * hi[0], hi[1])).toString());
    }
    legStart += duration;
  }
  return times;
}

type Draft = WorldEvent & { eventId: unknown };

/** Independent per-step checks: anchor routes against brute force, crossing times by interpolation. */
function verifyStep(before: WorldState, events: readonly Draft[]): void {
  const known = new Map<string, MovementRecord>();
  for (const entity of before.entities)
    if (entity.movement !== undefined) known.set(entity.movement.movementId, entity.movement);
  for (const event of events) {
    const record = (event.payload as { movement?: MovementRecord }).movement;
    if (record === undefined) continue;
    known.set(record.movementId, record);
    const destination = record.destination as unknown as { kind: string; anchorId?: string };
    if (destination.kind !== "anchor") continue;
    const start = record.segment.waypoints[0] as readonly bigint[];
    const origin = ANCHORS.find(([, x, y]) => start[0] === x && start[1] === y);
    equal(
      record.anchorPath,
      origin === undefined
        ? [destination.anchorId]
        : bruteForceRoute(origin[0], destination.anchorId!),
    );
  }
  for (const event of events) {
    if (event.type !== "movement.region-entered" && event.type !== "movement.region-exited")
      continue;
    const payload = event.payload as { movementId: string; regionId: string };
    const movement = known.get(payload.movementId);
    const region = (before.spatialRegions ?? []).find(
      (candidate) => candidate.regionId === payload.regionId,
    );
    if (movement === undefined || region === undefined)
      throw new Error("crossing without a known movement or region");
    const allowed = independentCrossingTimes(movement, region);
    if (allowed !== undefined && !allowed.has(event.simulationTime.toString()))
      throw new Error(
        `crossing time ${event.simulationTime} of ${payload.regionId} is not an interpolated time`,
      );
  }
}

// ---------------------------------------------------------------------------------------------
// Evidence entries
// ---------------------------------------------------------------------------------------------

export interface SpatialEntry {
  label: string;
  input: {
    type: string;
    version: number;
    commandId: string;
    encoding: string;
    inputHash: string;
    preStateHash: string;
    randomStateHash: string;
    indexImplementation: string;
  };
  output: { kind: string; postStateHash: string; [key: string]: unknown };
}

interface StepRun {
  readonly entry: SpatialEntry;
  readonly signature: string;
  readonly outcome: ReturnType<typeof executeWorldKernel>;
  readonly before: WorldState;
}

async function execStep(
  current: WorldKernelInput,
  label: string,
  type: string,
  payload: unknown,
  impl: IndexImplementation,
): Promise<StepRun> {
  const plain = movementInput(current, type, payload, label);
  const identity = await containmentInputIdentity({ ...plain, ids: plain.ids.seed });
  const input = { ...plain, spatialIndexFactory: impl.factory } as MovementKernelInput;
  const before = input.partition.state;
  const outcome = executeWorldKernel(input, { mode: "test" });
  const state = outcome.ok ? outcome.result.state : before;
  if (!outcome.ok) assertEnvelope(outcome.error);
  else {
    equal(
      checkWorldInvariants(before, state, outcome.result.events, type as MovementCommandType),
      undefined,
    );
    equal(replayWorldEvents(before, outcome.result.events), state);
    verifyStep(before, outcome.result.events as readonly Draft[]);
  }
  const postStateHash = await stateHash(state);
  const output = outcome.ok
    ? {
        kind: "success",
        eventTypes: outcome.result.events.map((e) => e.type),
        eventIds: outcome.result.events.map((e) => String(e.eventId)),
        crossings: crossingsOf(outcome.result.events),
        postStateHash,
      }
    : { kind: "refusal", ...outcome.error, postStateHash };
  const entry: SpatialEntry = {
    label,
    input: {
      type,
      version: 1,
      commandId: label,
      encoding: identity.encoding,
      inputHash: identity.inputHash,
      preStateHash: await stateHash(before),
      randomStateHash: await stateHash(input.randomState),
      indexImplementation: impl.name,
    },
    output,
  };
  const signature = canonicalSerialize(
    outcome.ok
      ? {
          events: outcome.result.events.map((e) => [
            e.type,
            String(e.eventId),
            e.simulationTime,
            e.payload,
          ]),
          postStateHash,
        }
      : { error: outcome.error },
  );
  return { entry, signature, outcome, before };
}

/** Runs one command under every index implementation and requires identical outcomes. */
export async function runSpatialStep(
  current: WorldKernelInput,
  entries: SpatialEntry[],
  label: string,
  type: string,
  payload: unknown,
  expected?: string,
) {
  const runs: StepRun[] = [];
  for (const impl of IMPLEMENTATIONS)
    runs.push(await execStep(current, label, type, payload, impl));
  for (const run of runs) equal(run.signature, runs[0]!.signature);
  for (const run of runs) entries.push(run.entry);
  const { outcome } = runs[0]!;
  if (expected !== undefined) equal(outcome.ok ? "success" : outcome.error.code, expected);
  if (!outcome.ok)
    return {
      current,
      ok: false as const,
      error: outcome.error,
      events: [] as readonly WorldEvent[],
    };
  const state = outcome.result.state;
  return {
    current: {
      ...current,
      partition: { ...current.partition, state, revision: state.revision },
      schedules: outcome.result.schedules,
      simulationTime: state.simulationTime,
    } as WorldKernelInput,
    ok: true as const,
    events: outcome.result.events as readonly WorldEvent[],
  };
}

/** Runs a command against a faulty index; the refusal must have the expected code. */
async function runFaulty(
  current: WorldKernelInput,
  entries: SpatialEntry[],
  label: string,
  payload: unknown,
  impl: IndexImplementation,
  code: string,
): Promise<void> {
  const run = await execStep(current, label, "movement.start", payload, impl);
  equal(run.outcome.ok ? "success" : run.outcome.error.code, code);
  entries.push(run.entry);
}

async function boundaryEntry(
  entries: SpatialEntry[],
  label: string,
  type: string,
  value: unknown,
  state: WorldState,
  random: unknown,
  outcome: { ok: true } | { ok: false; error: { code: string; path: string } },
) {
  const identity = await containmentInputIdentity(value);
  entries.push({
    label,
    input: {
      type,
      version: 1,
      commandId: label,
      encoding: identity.encoding,
      inputHash: identity.inputHash,
      preStateHash: await stateHash(state),
      randomStateHash: await stateHash(random),
      indexImplementation: "none",
    },
    output: {
      ...(outcome.ok
        ? { kind: "success", eventTypes: [], eventIds: [], crossings: [] }
        : { kind: "refusal", code: outcome.error.code, path: outcome.error.path }),
      postStateHash: await stateHash(state),
    },
  });
}

async function queryEntries(
  entries: SpatialEntry[],
  label: string,
  state: WorldState,
  random: unknown,
  regionId: string,
) {
  const region = (state.spatialRegions ?? []).find((candidate) => candidate.regionId === regionId)!;
  const dims = shapeBounds(region.shape)[0].length;
  const epoch = Number(state.revision);
  const identity = await containmentInputIdentity({
    region,
    objects: state.entities.map((e) => [e.objectId, e.pose]),
  });
  const results: string[] = [];
  for (const impl of IMPLEMENTATIONS) {
    const index = impl.factory(epoch);
    for (const entity of state.entities)
      if (entity.pose.frameId === region.frameId && entity.pose.coordinates.length === dims)
        index.update(epoch, {
          op: "insert",
          binding: { objectId: entity.objectId, pose: entity.pose },
        });
    const candidates = [...index.query(epoch, region)];
    results.push(canonicalSerialize(candidates));
    entries.push({
      label,
      input: {
        type: "spatial.query",
        version: 1,
        commandId: label,
        encoding: identity.encoding,
        inputHash: identity.inputHash,
        preStateHash: await stateHash(state),
        randomStateHash: await stateHash(random),
        indexImplementation: impl.name,
      },
      output: { kind: "query", candidates, postStateHash: await stateHash(state) },
    });
  }
  equal(results[1], results[0]);
}

const ring = (...points: [bigint, bigint][]) => points.map(([x, y]) => p2(x, y));
const regionWith = (shape: unknown, version = 1) => ({
  regionId: "case",
  version,
  frameId: GROUND,
  frameVersion: 1,
  shape,
});

export async function spatialEvidence(steps = 40) {
  const entities = [
    mover("mover", [0n, 0n]),
    mover("walker", [8000n, 0n]),
    mover("ghost", [0n, 0n], { lifecycle: { status: "dead" } } as never),
    mover("old", [0n, 0n], { lifecycle: { status: "retired" } } as never),
    climber("climber"),
  ];
  let current = await spatialFixture(entities);
  const entries: SpatialEntry[] = [];
  const run = async (label: string, type: string, payload: unknown, expected?: string) => {
    const result = await runSpatialStep(current, entries, label, type, payload, expected);
    current = result.current;
    return result;
  };
  await run(
    "start:porch-route",
    "movement.start",
    startPayload("mover", toAnchor("trash-front")),
    "success",
  );
  await run(
    "start:completed-restart",
    "movement.start",
    startPayload("mover", toAnchor("tree-base")),
    "success",
  );
  await run(
    "start:walker-west",
    "movement.start",
    startPayload("walker", toAnchor("den-mouth"), { observeUntil: 99999n }),
    "success",
  );
  await run(
    "unknown-graph-version",
    "movement.start",
    startPayload("mover", { kind: "anchor", anchorId: "den-mouth", graphVersion: 9 }),
    "precondition-failed",
  );
  await run(
    "unknown-object",
    "movement.start",
    startPayload("missing", toAnchor("den-mouth")),
    "precondition-failed",
  );
  await run(
    "interrupt-idle",
    "movement.interrupt",
    { schemaVersion: 1, objectId: "mover", at: current.partition.state.simulationTime },
    "precondition-failed",
  );
  await run(
    "replan-unknown",
    "movement.replan",
    { ...startPayload("missing", toAnchor("den-mouth")), at: 0n },
    "precondition-failed",
  );
  await run(
    "bad-speed",
    "movement.start",
    startPayload("mover", toAnchor("den-mouth"), { unitsPerSecond: f(0n) }),
    "invalid-input",
  );
  await run(
    "bad-time",
    "movement.start",
    startPayload("mover", toAnchor("den-mouth"), { observeUntil: -1n }),
    "invalid-input",
  );
  await run(
    "bad-version",
    "movement.start",
    { ...startPayload("mover", toAnchor("den-mouth")), schemaVersion: 2 },
    "unknown-command-version",
  );
  await run(
    "anchor-tie",
    "movement.start",
    startPayload("walker", toAnchor("garden-edge")),
    "success",
  );

  // 3D: the climber crosses the tree-box through the production handlers and reducers.
  const t0 = current.partition.state.simulationTime;
  const climb = await run(
    "3d:climb",
    "movement.start",
    startPayload("climber", toPose(4000n, 0n, TREE)),
    "success",
  );
  equal(crossingsOf(climb.events!), [
    { type: "movement.region-entered", regionId: "tree-box", time: (t0 + 500n).toString() },
    { type: "movement.region-exited", regionId: "tree-box", time: (t0 + 1500n).toString() },
  ]);
  equal(movementOf(current.partition.state, "climber")?.status, "completed");

  // Interruption then replan lineage (observation windows end before completion).
  const l0 = current.partition.state.simulationTime;
  await run(
    "lineage:start",
    "movement.start",
    startPayload("mover", toAnchor("garden-edge"), { observeUntil: l0 + 1000n }),
    "success",
  );
  await run(
    "lineage:interrupt",
    "movement.interrupt",
    { schemaVersion: 1, objectId: "mover", at: l0 + 1500n },
    "success",
  );
  await run(
    "lineage:replan",
    "movement.replan",
    { ...startPayload("mover", toAnchor("den-mouth")), at: l0 + 1500n },
    "success",
  );

  // Fixed named refusal cases against a pristine fixture.
  const base = await spatialFixture(entities);
  const split = {
    ...base,
    partition: {
      ...base.partition,
      state: {
        ...base.partition.state,
        anchorGraphs: [parseAnchorGraph({ ...anchorGraph(), edges: [] })],
      },
    },
  } as WorldKernelInput;
  const dest = toAnchor("den-mouth");
  const poseTo = (frameId: string, frameVersion: number, coordinates: readonly bigint[]) => ({
    kind: "pose",
    pose: { frameId, frameVersion, coordinates },
  });
  const commandCases: Record<string, [WorldKernelInput, unknown]> = {
    "unknown-anchor": [base, startPayload("mover", toAnchor("nowhere"))],
    "unknown-frame": [base, startPayload("mover", poseTo("no-frame", 1, p2(0n, 0n)))],
    "unknown-frame-version": [base, startPayload("mover", poseTo(GROUND, 7, p2(0n, 0n)))],
    unreachable: [split, startPayload("mover", toAnchor("trash-front"))],
    "retired-object": [base, startPayload("old", dest)],
    "dead-object": [base, startPayload("ghost", dest)],
    "frame-mismatch": [base, startPayload("mover", toPose(0n, 0n, TREE))],
    "null-payload": [base, null],
    "wrong-type": [base, startPayload(5 as never, dest)],
    "missing-field": [base, { schemaVersion: 1, objectId: "mover" }],
    "extra-field": [base, startPayload("mover", dest, { extra: 1 })],
    "non-integer": [base, startPayload("mover", dest, { unitsPerSecond: 1.5 })],
    "negative-value": [base, startPayload("mover", dest, { unitsPerSecond: -5n })],
    "out-of-range": [base, startPayload("mover", poseTo(GROUND, 1, [1n << 60n, 0n]))],
  };
  const boundaryCases: Record<string, [string, unknown]> = {
    "clockwise-polygon": [
      "region",
      regionWith({
        kind: "polygon",
        vertices: ring([0n, 0n], [0n, 1000n], [1000n, 1000n], [1000n, 0n]),
      }),
    ],
    "self-intersecting-polygon": [
      "region",
      regionWith({
        kind: "polygon",
        vertices: ring([0n, 0n], [1000n, 1000n], [1000n, 0n], [0n, 1000n]),
      }),
    ],
    "few-vertices": [
      "region",
      regionWith({ kind: "polygon", vertices: ring([0n, 0n], [1000n, 0n]) }),
    ],
    "zero-area-region": [
      "region",
      regionWith({ kind: "polygon", vertices: ring([0n, 0n], [1000n, 0n], [2000n, 0n]) }),
    ],
    "unknown-region-version": [
      "region",
      regionWith({ kind: "circle", center: p2(0n, 0n), radius: f(1000n) }, 0),
    ],
    "unknown-anchor-version": ["graph", { ...anchorGraph(), version: 0 }],
  };
  for (const refusalCase of SPATIAL_REFUSAL_CASES) {
    const label = `case:${refusalCase.name}`;
    if (refusalCase.name === "handler-failed") {
      await runFaulty(
        base,
        entries,
        label,
        startPayload("mover", toAnchor("trash-front")),
        { name: "throwing-test", factory: createThrowingTestIndex },
        "handler-failed",
      );
    } else if (refusalCase.name === "reducer-failed") {
      await runFaulty(
        base,
        entries,
        label,
        startPayload("mover", toAnchor("trash-front")),
        { name: "blind-test", factory: createBlindTestIndex },
        "reducer-failed",
      );
    } else if (commandCases[refusalCase.name] !== undefined) {
      const [input, payload] = commandCases[refusalCase.name]!;
      await runSpatialStep(input, entries, label, "movement.start", payload, refusalCase.code);
    } else {
      const [kind, value] = boundaryCases[refusalCase.name]!;
      const parsed =
        kind === "region" ? parseSpatialRegionAtBoundary(value) : parseAnchorGraphAtBoundary(value);
      equal(parsed.ok ? "success" : parsed.error.code, refusalCase.code);
      await boundaryEntry(
        entries,
        label,
        kind === "region" ? "spatial.region.validate" : "spatial.anchor-graph.validate",
        value,
        base.partition.state,
        base.randomState,
        parsed.ok ? { ok: true } : { ok: false, error: parsed.error },
      );
    }
  }
  // Accepted boundary values (2D polygon, circle, rectangle and the 3D box) and the anchor graph.
  for (const region of regions()) {
    const parsed = parseSpatialRegionAtBoundary(region);
    equal(parsed.ok, true);
    await boundaryEntry(
      entries,
      `valid:region:${region.regionId}`,
      "spatial.region.validate",
      region,
      base.partition.state,
      base.randomState,
      { ok: true },
    );
  }
  equal(parseAnchorGraphAtBoundary(anchorGraph()).ok, true);
  await boundaryEntry(
    entries,
    "valid:anchor-graph",
    "spatial.anchor-graph.validate",
    anchorGraph(),
    base.partition.state,
    base.randomState,
    { ok: true },
  );

  let driver = initializeNamedRandomStreams(spatialSeed, streams);
  const next = () => {
    const result = drawNamedRandomStream(driver, "movement");
    driver = result.randomState;
    return Number(result.draw.rawValue + 2147483648n);
  };
  const targets = ANCHORS.map(([id]) => id);
  for (let index = 0; index < steps; index++) {
    const action = next() % 5;
    const target = targets[next() % targets.length]!;
    const now = current.partition.state.simulationTime;
    current = { ...current, randomState: driver };
    const record = movementOf(current.partition.state, "walker");
    if (action < 2 && record?.status !== "active")
      await run(
        `generated:${index}`,
        "movement.start",
        startPayload("walker", toAnchor(target), { observeUntil: now + BigInt(next() % 6000) }),
      );
    else if (action === 2 && record?.status === "active")
      await run(`generated:${index}`, "movement.interrupt", {
        schemaVersion: 1,
        objectId: "walker",
        at: now + BigInt(next() % 800),
      });
    else if (action === 3 && record !== undefined && record.status !== "completed")
      await run(`generated:${index}`, "movement.replan", {
        ...startPayload("walker", toAnchor(target), { observeUntil: now + BigInt(next() % 6000) }),
        at: now,
      });
    else
      await run(
        `generated:${index}`,
        "movement.start",
        startPayload("walker", toAnchor("nowhere")),
        "precondition-failed",
      );
  }
  for (const regionId of ["garden", "pond", "porch", "tree-box"])
    await queryEntries(
      entries,
      `query:${regionId}`,
      current.partition.state,
      current.randomState,
      regionId,
    );
  const identity = worldRegistryIdentity();
  return {
    schemaVersion: 1,
    seed: spatialSeed,
    steps,
    registry: { ...identity, hash: await stateHash(identity) },
    entries,
    finalStateHash: await stateHash(current.partition.state),
  };
}
export type { SimTimeMs };
