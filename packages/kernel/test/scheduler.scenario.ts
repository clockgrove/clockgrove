import type { SimTimeMs } from "@clockgrove/contracts";
import { canonicalSerialize } from "../src/canonical.js";
import { drawNamedRandomStream, initializeNamedRandomStreams } from "../src/random.js";
import {
  CATCH_UP_ENGINE_VERSION,
  type CatchUpOutcome,
  type CatchUpRegistry,
  type CatchUpResult,
  type ContinuousSystem,
  catchUpSchedules,
  createCatchUpRegistry,
} from "../src/scheduler/index.js";
import { cancelSchedule, createScheduleQueue, type ScheduledItem } from "../src/scheduler.js";
import { containmentInputIdentity } from "./containment.scenario.js";
import { stateHash } from "./weather-needs.scenario.js";

export const schedulerSeed = { version: 1, seed: "scheduler-catch-up-v1" } as const;
export const schedulerStreams = ["scheduler"] as const;
export const SCHEDULER_PAIR_NAMES = [
  "continuous-steps-vs-aggregate",
  "sleep-reactivation-vs-uninterrupted",
  "pause-resume-vs-uninterrupted",
  "superseded-vs-replacement",
  "retried-call-vs-first",
  "bounded-continuation-vs-unbounded",
] as const;

type Loose = Record<string, unknown>;
const big = (value: unknown): bigint => BigInt(value as bigint | number);
const time = (value: bigint | number): SimTimeMs => BigInt(value) as SimTimeMs;

// ---------------------------------------------------------------------------------------------
// Test-owned fixture continuous systems and payload handlers (no domain systems are involved).
// ---------------------------------------------------------------------------------------------

const MOISTURE_STEP = 1000n;
const TIMER_STEP = 250n;

export const moistureSystem: ContinuousSystem = {
  kind: "fixture.moisture",
  version: 1,
  integrate: (state, from, to) => ({
    level: big(state.level) + big(state.rate) * (to - from),
    rate: big(state.rate),
  }),
  nextThreshold: (state, at) => {
    const level = big(state.level);
    const rate = big(state.rate);
    if (rate <= 0n) return null;
    const goal = (level / MOISTURE_STEP + 1n) * MOISTURE_STEP;
    return { name: `level-${goal}`, time: (at + (goal - level + rate - 1n) / rate) as SimTimeMs };
  },
};

export const timerSystem: ContinuousSystem = {
  kind: "fixture.timer",
  version: 1,
  integrate: (state, from, to) => ({ elapsed: big(state.elapsed) + (to - from) }),
  nextThreshold: (state, at) => {
    const elapsed = big(state.elapsed);
    const goal = (elapsed / TIMER_STEP + 1n) * TIMER_STEP;
    return { name: `tick-${goal}`, time: (at + (goal - elapsed)) as SimTimeMs };
  },
};

const badIntegerSystem: ContinuousSystem = {
  kind: "fixture.bad-integer",
  version: 1,
  integrate: () => ({ level: 1.5 }),
  nextThreshold: () => null,
};
const badThresholdSystem: ContinuousSystem = {
  kind: "fixture.bad-threshold",
  version: 1,
  integrate: (state) => state,
  nextThreshold: (_state, at) => ({ name: "stuck", time: at }),
};
const throwingSystem: ContinuousSystem = {
  kind: "fixture.throwing",
  version: 1,
  integrate: () => {
    throw new Error("fixture failure");
  },
  nextThreshold: () => null,
};

export function fixtureRegistry(): CatchUpRegistry {
  const created = createCatchUpRegistry({
    payloads: [
      { kind: "fixture.alert", payloadVersion: 1, type: "fixture.alert.fire", schemaVersion: 1 },
      { kind: "fixture.alert", payloadVersion: 2, type: "fixture.alert.fire", schemaVersion: 2 },
      { kind: "fixture.note", payloadVersion: 1, type: "fixture.note.record", schemaVersion: 1 },
      {
        kind: "fixture.external",
        payloadVersion: 1,
        type: "fixture.external.complete",
        schemaVersion: 1,
      },
    ],
    systems: [moistureSystem, timerSystem, badIntegerSystem, badThresholdSystem, throwingSystem],
  });
  if (!created.ok) throw new Error("fixture registry rejected");
  return created.registry;
}

// ---------------------------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------------------------

export interface ItemSpec {
  readonly id: string;
  readonly dueAt: bigint | number;
  readonly kind?: string;
  readonly payloadVersion?: number;
  readonly cls?: ScheduledItem["catchUpClass"];
  readonly priority?: number;
  readonly tieBreakKey?: string;
  readonly supersedes?: string;
  readonly payload?: unknown;
}

export function item(spec: ItemSpec): ScheduledItem {
  return {
    id: spec.id,
    tenantId: "tenant-a",
    worldId: "world-a",
    timelineId: "timeline-a",
    ownerPartitionId: "partition-a",
    dueAt: BigInt(spec.dueAt),
    priority: spec.priority ?? 0,
    tieBreakKey: spec.tieBreakKey ?? spec.id,
    kind: spec.kind ?? "fixture.alert",
    payloadVersion: spec.payloadVersion ?? 1,
    payload: spec.payload ?? { n: spec.id },
    idempotencyKey: `idem-${spec.id}`,
    catchUpClass: spec.cls ?? "exact",
    ...(spec.supersedes === undefined ? {} : { supersedes: spec.supersedes }),
  } as unknown as ScheduledItem;
}

export const exactItem = (id: string, dueAt: bigint | number, extra: Partial<ItemSpec> = {}) =>
  item({ id, dueAt, ...extra });
export const aggregateItem = (id: string, dueAt: bigint | number, kind = "fixture.moisture") =>
  item({ id, dueAt, kind, cls: "aggregate" });
export const skippableItem = (id: string, dueAt: bigint | number, kind = "fixture.note") =>
  item({ id, dueAt, kind, cls: "skippable" });
export const blockedItem = (id: string, dueAt: bigint | number) =>
  item({ id, dueAt, kind: "fixture.external", cls: "externallyBlocked" });

export function systemStates(at: bigint | number = 0): Loose[] {
  return [
    { systemId: "fixture.moisture@1", at: time(at), state: { level: 0n, rate: 7n } },
    { systemId: "fixture.timer@1", at: time(at), state: { elapsed: 0n } },
  ];
}

export function makeRequest(over: Loose = {}): Loose {
  return {
    engineVersion: CATCH_UP_ENGINE_VERSION,
    queue: [],
    start: time(0),
    target: time(1000),
    budget: 100,
    cursor: null,
    systems: systemStates(),
    results: [],
    ...over,
  };
}

/** One of every class, two payload versions, a tie on due time and an item beyond the target. */
export function baselineItems(): ScheduledItem[] {
  return [
    exactItem("a3", 500),
    exactItem("a2", 100, { payloadVersion: 2, priority: 1 }),
    exactItem("a1", 100),
    aggregateItem("m1", 600),
    skippableItem("n1", 200),
    skippableItem("n2", 300),
    skippableItem("n3", 250, "fixture.alert"),
    blockedItem("x1", 400),
    blockedItem("x2", 450),
    exactItem("late", 5000),
  ];
}

export const baselineResults = (): Loose[] => [
  { scheduleId: "x2", idempotencyKey: "idem-x2", payload: { answer: 42n } },
];

export function baselineRequest(over: Loose = {}): Loose {
  return makeRequest({ queue: baselineItems(), results: baselineResults(), ...over });
}

export function assertEngineOk(outcome: CatchUpOutcome): CatchUpResult {
  if (!outcome.ok) throw new Error(`catch-up refused: ${canonicalSerialize(outcome.error)}`);
  return outcome.result;
}

// ---------------------------------------------------------------------------------------------
// Chaining, merging and canonical round trips
// ---------------------------------------------------------------------------------------------

export interface ChainedRun {
  readonly requests: Loose[];
  readonly outcomes: CatchUpOutcome[];
}

/** Calls the engine repeatedly, feeding queue, systems and cursor back, until it completes. */
export function chain(registry: CatchUpRegistry, first: Loose, budget: number): ChainedRun {
  const requests: Loose[] = [];
  const outcomes: CatchUpOutcome[] = [];
  let request: Loose = { ...first, budget };
  for (let call = 0; call < 200; call += 1) {
    const outcome = catchUpSchedules(registry, request);
    requests.push(request);
    outcomes.push(outcome);
    if (!outcome.ok || outcome.result.complete) return { requests, outcomes };
    request = feedBack(request, outcome.result);
  }
  throw new Error("continuation exceeded 200 calls");
}

/** Next request from a result; recorded results for items no longer queued are dropped. */
export function feedBack(request: Loose, result: CatchUpResult, over: Loose = {}): Loose {
  const queued = new Set(result.remaining.map((entry) => entry.id as string));
  return {
    ...request,
    queue: result.remaining,
    systems: result.systems,
    cursor: result.cursor,
    results: (request.results as Loose[]).filter((entry) => queued.has(entry.scheduleId as string)),
    ...over,
  };
}

export interface Comparable {
  readonly dispatched: unknown;
  readonly thresholds: unknown;
  readonly skipped: unknown;
  readonly blocked: unknown;
  readonly scheduleMutations: unknown;
  readonly remaining: unknown;
  readonly systems: unknown;
  readonly complete: boolean;
  readonly nextDueAt: SimTimeMs | null;
}

/** Folds chained results into the shape of one unbounded call. */
export function merge(results: readonly CatchUpResult[]): Comparable {
  const last = results[results.length - 1];
  if (last === undefined) throw new Error("nothing to merge");
  const skipped = new Map<string, { count: number; first: bigint; last: bigint }>();
  const blocked: string[] = [];
  for (const result of results) {
    for (const entry of result.skipped) {
      const known = skipped.get(entry.kind);
      if (known === undefined) {
        skipped.set(entry.kind, {
          count: entry.count,
          first: entry.firstDueAt,
          last: entry.lastDueAt,
        });
      } else {
        known.count += entry.count;
        known.first = known.first < entry.firstDueAt ? known.first : entry.firstDueAt;
        known.last = known.last > entry.lastDueAt ? known.last : entry.lastDueAt;
      }
    }
    for (const id of result.blocked) if (!blocked.includes(id)) blocked.push(id);
  }
  return {
    dispatched: results.flatMap((result) => result.dispatched),
    thresholds: results.flatMap((result) => result.thresholds),
    skipped: [...skipped.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([kind, entry]) => ({
        kind,
        count: entry.count,
        firstDueAt: entry.first,
        lastDueAt: entry.last,
      })),
    blocked,
    scheduleMutations: results.flatMap((result) => result.scheduleMutations),
    remaining: last.remaining,
    systems: last.systems,
    complete: last.complete,
    nextDueAt: last.nextDueAt,
  };
}

export function mergeRun(run: ChainedRun): Comparable {
  return merge(run.outcomes.map((outcome) => assertEngineOk(outcome)));
}

export function single(registry: CatchUpRegistry, request: Loose): Comparable {
  return merge([assertEngineOk(catchUpSchedules(registry, request))]);
}

/** Minimal canonical-v1 decoder, enough to round-trip engine state through canonical bytes. */
export function decodeCanonical(text: string): unknown {
  const parsed = JSON.parse(text) as [string, unknown];
  if (parsed[0] !== "clockgrove-canonical-v1") throw new Error("unknown canonical version");
  const decode = (node: unknown): unknown => {
    const [tag, value] = node as [string, unknown];
    switch (tag) {
      case "null":
        return null;
      case "boolean":
      case "string":
        return value;
      case "bigint":
        return BigInt(value as string);
      case "integer":
        return Number(value as string);
      case "array":
        return (value as unknown[]).map(decode);
      case "record":
        return Object.fromEntries(
          (value as [string, unknown][]).map(([key, entry]) => [key, decode(entry)]),
        );
      default:
        throw new Error(`unsupported canonical tag ${tag}`);
    }
  };
  return decode(parsed[1]);
}

export function roundTrip<T>(value: T): T {
  return decodeCanonical(canonicalSerialize(value)) as T;
}

// ---------------------------------------------------------------------------------------------
// Differential pairs (all declare exact equivalence)
// ---------------------------------------------------------------------------------------------

export interface DifferentialPair {
  readonly name: (typeof SCHEDULER_PAIR_NAMES)[number];
  readonly equivalence: "exact";
  readonly left: unknown;
  readonly right: unknown;
}

export function differentialPairs(
  registry: CatchUpRegistry = fixtureRegistry(),
): DifferentialPair[] {
  const pairs: DifferentialPair[] = [];
  const whole = baselineRequest();

  // 1. Continuous small steps versus one aggregate step over the same interval.
  const stepped: CatchUpResult[] = [];
  let carry: Loose = whole;
  for (let at = 0n; at < 1000n; at += 25n) {
    const request: Loose = { ...carry, start: time(at), target: time(at + 25n), budget: 100 };
    const result = assertEngineOk(catchUpSchedules(registry, request));
    stepped.push(result);
    carry = feedBack(request, result, { cursor: null });
  }
  pairs.push({
    name: "continuous-steps-vs-aggregate",
    equivalence: "exact",
    left: merge(stepped),
    right: single(registry, whole),
  });

  // 2. Sleep and reactivation: state, queue and cursor round-tripped through canonical bytes.
  const longGap = baselineRequest({
    queue: [
      ...baselineItems(),
      exactItem("gap1", 40000),
      aggregateItem("gap2", 70000, "fixture.timer"),
    ],
    target: time(100000),
  });
  const slept: CatchUpResult[] = [];
  let sleeping: Loose = { ...longGap, target: time(400), budget: 2 };
  for (let call = 0; call < 50; call += 1) {
    const result = assertEngineOk(catchUpSchedules(registry, sleeping));
    slept.push(result);
    const stored = roundTrip({
      queue: result.remaining,
      systems: result.systems,
      cursor: result.cursor,
      results: (sleeping.results as Loose[]).filter((entry) =>
        result.remaining.some((queued) => queued.id === entry.scheduleId),
      ),
    });
    sleeping = { ...sleeping, ...stored };
    if (result.complete) break;
  }
  const lastSlept = slept[slept.length - 1];
  if (lastSlept === undefined || !lastSlept.complete) throw new Error("sleep did not complete");
  const woken = assertEngineOk(
    catchUpSchedules(registry, {
      ...sleeping,
      start: time(400),
      target: time(100000),
      budget: 100,
      cursor: null,
    }),
  );
  pairs.push({
    name: "sleep-reactivation-vs-uninterrupted",
    equivalence: "exact",
    left: merge([...slept, woken]),
    right: single(registry, longGap),
  });

  // 3. Pause and resume, with a same-time advance while paused.
  const first = assertEngineOk(catchUpSchedules(registry, { ...whole, target: time(300) }));
  const paused = feedBack({ ...whole, target: time(300) }, first, { cursor: null });
  const idle = assertEngineOk(
    catchUpSchedules(registry, { ...paused, start: time(300), target: time(300) }),
  );
  const resumed = assertEngineOk(
    catchUpSchedules(registry, {
      ...feedBack(paused, idle, { cursor: null }),
      start: time(300),
      target: time(1000),
    }),
  );
  pairs.push({
    name: "pause-resume-vs-uninterrupted",
    equivalence: "exact",
    left: merge([first, idle, resumed]),
    right: single(registry, whole),
  });

  // 4. A superseded schedule versus a queue that only ever held the replacement.
  const replacement = exactItem("new", 700, { supersedes: "old" });
  pairs.push({
    name: "superseded-vs-replacement",
    equivalence: "exact",
    left: single(
      registry,
      baselineRequest({ queue: [...baselineItems(), exactItem("old", 150), replacement] }),
    ),
    right: single(registry, baselineRequest({ queue: [...baselineItems(), replacement] })),
  });

  // 5. A retried call with identical input; fed-back results never dispatch a key twice.
  const original = catchUpSchedules(registry, baselineRequest({ budget: 3 }));
  const retried = catchUpSchedules(registry, baselineRequest({ budget: 3 }));
  const firstResult = assertEngineOk(original);
  const fedBack = createScheduleQueue(
    firstResult.scheduleMutations.reduce(
      (queue, mutation) => cancelSchedule(queue, mutation.scheduleId),
      createScheduleQueue(baselineItems()),
    ),
  );
  const second = assertEngineOk(
    catchUpSchedules(
      registry,
      baselineRequest({
        queue: fedBack,
        budget: 100,
        results: baselineResults().filter((entry) =>
          fedBack.some((queued) => queued.id === entry.scheduleId),
        ),
      }),
    ),
  );
  const firstKeys = new Set(firstResult.dispatched.map((input) => `idem-${input.scheduleId}`));
  if (second.dispatched.some((input) => firstKeys.has(`idem-${input.scheduleId}`))) {
    throw new Error("an idempotency key was dispatched twice");
  }
  pairs.push({
    name: "retried-call-vs-first",
    equivalence: "exact",
    left: retried,
    right: original,
  });

  // 6. Bounded continuation versus one unbounded call.
  pairs.push({
    name: "bounded-continuation-vs-unbounded",
    equivalence: "exact",
    left: mergeRun(chain(registry, whole, 1)),
    right: single(registry, whole),
  });
  return pairs;
}

// ---------------------------------------------------------------------------------------------
// Generated sequences (named random stream only; never Math.random)
// ---------------------------------------------------------------------------------------------

export interface GeneratedStep {
  readonly sequence: number;
  readonly step: number;
  readonly queue: ScheduledItem[];
  readonly cancelled: string[];
  readonly superseded: string[];
  readonly budget: number;
  readonly chained: ChainedRun;
  readonly unboundedRequest: Loose;
  readonly unbounded: CatchUpOutcome;
  readonly shuffled: CatchUpOutcome;
}

export function generateSequences(
  registry: CatchUpRegistry = fixtureRegistry(),
  sequences = 3,
  steps = 16,
): GeneratedStep[] {
  let random = initializeNamedRandomStreams(schedulerSeed, schedulerStreams);
  const next = (bound: number): number => {
    const drawn = drawNamedRandomStream(random, "scheduler");
    random = drawn.randomState;
    // Low bits of the underlying generator are weak; use the middle bits.
    return Number((drawn.draw.rawValue + 2147483648n) >> 8n) % bound;
  };
  const log: GeneratedStep[] = [];
  let counter = 0;
  for (let sequence = 0; sequence < sequences; sequence += 1) {
    let queue: ScheduledItem[] = [];
    let systems: unknown = [
      {
        systemId: "fixture.moisture@1",
        at: time(0),
        state: { level: 0n, rate: BigInt(2 + next(4)) },
      },
      { systemId: "fixture.timer@1", at: time(0), state: { elapsed: 0n } },
    ];
    let now = 0n;
    let results: Loose[] = [];
    const cancelled: string[] = [];
    const superseded: string[] = [];
    const make = (supersedes?: string): ScheduledItem => {
      counter += 1;
      const id = `g${counter}`;
      const due = BigInt(Math.max(0, Number(now) + next(1600) - 100));
      const base = {
        id,
        dueAt: due,
        priority: next(3),
        ...(supersedes === undefined ? {} : { supersedes }),
      };
      switch (next(6)) {
        case 0:
          return item({ ...base, payloadVersion: 2 });
        case 1:
          return item({
            ...base,
            kind: next(2) === 0 ? "fixture.moisture" : "fixture.timer",
            cls: "aggregate",
          });
        case 2:
          return item({ ...base, kind: "fixture.note", cls: "skippable" });
        case 3: {
          if (next(3) === 0)
            results.push({ scheduleId: id, idempotencyKey: `idem-${id}`, payload: { r: due } });
          return item({ ...base, kind: "fixture.external", cls: "externallyBlocked" });
        }
        default:
          return item(base);
      }
    };
    for (let step = 0; step < steps; step += 1) {
      const op = next(10);
      if (op <= 3 || queue.length === 0) {
        queue = [...queue, make()];
      } else if (op === 4) {
        const victim = queue[next(queue.length)];
        if (victim !== undefined) {
          queue = queue.filter((entry) => entry.id !== victim.id);
          cancelled.push(victim.id);
        }
      } else if (op === 5) {
        const old = queue[next(queue.length)];
        if (old !== undefined) {
          queue = [...queue, make(old.id)];
          superseded.push(old.id);
        }
      } else {
        const target = now + 1n + BigInt(next(2000));
        const budget = 1 + next(3);
        const base: Loose = makeRequest({
          queue,
          start: time(now),
          target: time(target),
          systems,
          results: results.filter((entry) => queue.some((q) => q.id === entry.scheduleId)),
        });
        const unboundedRequest: Loose = { ...base, budget: 1000 };
        const unbounded = catchUpSchedules(registry, unboundedRequest);
        const shuffledQueue = [...queue];
        for (let index = shuffledQueue.length - 1; index > 0; index -= 1) {
          const swap = next(index + 1);
          const held = shuffledQueue[index] as ScheduledItem;
          shuffledQueue[index] = shuffledQueue[swap] as ScheduledItem;
          shuffledQueue[swap] = held;
        }
        const shuffled = catchUpSchedules(registry, { ...unboundedRequest, queue: shuffledQueue });
        const chained = chain(registry, base, budget);
        log.push({
          sequence,
          step,
          queue,
          cancelled: [...cancelled],
          superseded: [...superseded],
          budget,
          chained,
          unboundedRequest,
          unbounded,
          shuffled,
        });
        const result = assertEngineOk(unbounded);
        queue = [...result.remaining];
        systems = result.systems;
        now = target;
        results = results.filter((entry) => queue.some((q) => q.id === entry.scheduleId));
      }
    }
  }
  return log;
}

/** Canonical bytes of everything a generated run produced, for seed-replay comparison. */
export function generatedFingerprint(log: readonly GeneratedStep[]): string {
  return canonicalSerialize(
    log.map((entry) => [entry.chained.outcomes, entry.unbounded, entry.shuffled]),
  );
}

// ---------------------------------------------------------------------------------------------
// Refusal cases (the catalogue of expected codes/paths/checks lives in spatial-evidence.ts)
// ---------------------------------------------------------------------------------------------

function withItem(index: number, change: (entry: Loose) => Loose): Loose {
  const queue = [exactItem("a1", 100), exactItem("a2", 200)].map((entry, at) =>
    at === index ? change({ ...entry }) : { ...entry },
  );
  return makeRequest({ queue });
}

function omit(record: Loose, key: string): Loose {
  const { [key]: _removed, ...rest } = record;
  return rest;
}

/** A real, incomplete cursor and its request, used to build cursor refusal inputs. */
function cursorFixture(registry: CatchUpRegistry): { request: Loose; cursor: Loose } {
  const request = baselineRequest({ budget: 1 });
  const result = assertEngineOk(catchUpSchedules(registry, request));
  if (result.cursor === null) throw new Error("fixture expected an incomplete call");
  return {
    request: feedBack(request, result),
    cursor: { ...result.cursor },
  };
}

export function refusalRequests(
  registry: CatchUpRegistry = fixtureRegistry(),
): Record<string, unknown> {
  const { request: resumed, cursor } = cursorFixture(registry);
  const withBadSystem = (kind: string, state: Loose): Loose =>
    makeRequest({
      queue: [item({ id: "bad", dueAt: 100, kind, cls: "aggregate" })],
      systems: [...systemStates(), { systemId: `${kind}@1`, at: time(0), state }],
    });
  const throwing: Loose = makeRequest();
  Object.defineProperty(throwing, "budget", {
    enumerable: true,
    get() {
      throw new Error("hostile getter");
    },
  });
  return {
    "null-request": null,
    "missing-field": omit(makeRequest(), "budget"),
    "extra-field": makeRequest({ extra: 1 }),
    "wrong-type": makeRequest({ start: 5 }),
    "item-null": makeRequest({ queue: [null] }),
    "item-missing-field": withItem(0, (entry) => omit(entry, "kind")),
    "item-extra-field": withItem(0, (entry) => ({ ...entry, extra: 1 })),
    "item-wrong-type": withItem(0, (entry) => ({ ...entry, dueAt: 5 })),
    "duplicate-system": makeRequest({ systems: [systemStates()[0], systemStates()[0]] }),
    "result-duplicate": makeRequest({
      queue: [blockedItem("x1", 100)],
      results: [
        { scheduleId: "x1", idempotencyKey: "idem-x1", payload: null },
        { scheduleId: "x1", idempotencyKey: "idem-x1", payload: null },
      ],
    }),
    "cursor-wrong-type": makeRequest({ cursor: 5 }),
    "cursor-missing-field": { ...resumed, cursor: omit(cursor, "position") },
    "cursor-extra-field": { ...resumed, cursor: { ...cursor, extra: 1 } },
    "result-null": makeRequest({ results: [null] }),
    "result-missing-field": makeRequest({
      queue: [blockedItem("x1", 100)],
      results: [{ scheduleId: "x1", idempotencyKey: "idem-x1" }],
    }),
    "result-extra-field": makeRequest({
      queue: [blockedItem("x1", 100)],
      results: [{ scheduleId: "x1", idempotencyKey: "idem-x1", payload: null, extra: 1 }],
    }),
    "unknown-engine-version": makeRequest({ engineVersion: "clockgrove-catch-up@0" }),
    "unknown-cursor-engine-version": {
      ...resumed,
      cursor: { ...cursor, engineVersion: "other@9" },
    },
    "unknown-class": withItem(0, (entry) => ({ ...entry, catchUpClass: "eventually" })),
    "unknown-kind": withItem(0, (entry) => ({ ...entry, kind: "fixture.unknown" })),
    "unknown-payload-version": withItem(0, (entry) => ({ ...entry, payloadVersion: 9 })),
    "class-dispatch-mismatch": withItem(0, (entry) => ({ ...entry, catchUpClass: "aggregate" })),
    "negative-time": makeRequest({ start: time(-1) }),
    "non-bigint-time": makeRequest({ target: "1000" }),
    "out-of-range-time": makeRequest({ target: 1n << 63n }),
    "target-before-start": makeRequest({ start: time(500), target: time(400) }),
    "budget-non-integer": makeRequest({ budget: 1.5 }),
    "budget-non-positive": makeRequest({ budget: 0 }),
    "scope-violation": withItem(1, (entry) => ({ ...entry, tenantId: "tenant-b" })),
    "duplicate-id": withItem(1, (entry) => ({ ...entry, id: "a1" })),
    "ambiguous-ordering": withItem(1, (entry) => ({ ...entry, dueAt: 100n, tieBreakKey: "a1" })),
    "cursor-queue-mismatch": {
      ...resumed,
      cursor,
      queue: [...(resumed.queue as unknown[]), exactItem("extra", 900)],
    },
    "cursor-time-mismatch": { ...resumed, cursor: { ...cursor, target: time(999) } },
    "result-unknown-item": makeRequest({
      results: [{ scheduleId: "ghost", idempotencyKey: "idem-ghost", payload: null }],
    }),
    "result-non-blocked": makeRequest({
      queue: [exactItem("a1", 100)],
      results: [{ scheduleId: "a1", idempotencyKey: "idem-a1", payload: null }],
    }),
    "unknown-system": makeRequest({
      systems: [{ systemId: "fixture.ghost@1", at: time(0), state: {} }],
    }),
    "aggregate-without-system": makeRequest({ queue: [aggregateItem("m1", 100)], systems: [] }),
    "systems-time-mismatch": makeRequest({ systems: systemStates(5) }),
    "system-non-integer": withBadSystem("fixture.bad-integer", { level: 0n }),
    "system-threshold-not-forward": withBadSystem("fixture.bad-threshold", { level: 0n }),
    "system-exception": withBadSystem("fixture.throwing", { level: 0n }),
    "engine-exception": throwing,
  };
}

// ---------------------------------------------------------------------------------------------
// Evidence section
// ---------------------------------------------------------------------------------------------

function record(value: unknown): Loose | null {
  return typeof value === "object" && value !== null ? (value as Loose) : null;
}

async function hashOf(value: unknown): Promise<string> {
  return (await containmentInputIdentity(value)).inputHash;
}

async function describeCall(
  label: string,
  request: unknown,
  outcome: CatchUpOutcome,
  identitySource: unknown = request,
) {
  const loose = record(identitySource);
  const identity = await containmentInputIdentity(identitySource);
  const cursor = loose?.cursor;
  const start = loose?.start;
  const target = loose?.target;
  const budget = loose?.budget;
  const input = {
    engineVersion: typeof loose?.engineVersion === "string" ? loose.engineVersion : null,
    encoding: identity.encoding,
    inputHash: identity.inputHash,
    queueHash: await hashOf(loose?.queue),
    systemsHash: await hashOf(loose?.systems),
    cursorHash: cursor === null || cursor === undefined ? null : await hashOf(cursor),
    start: typeof start === "bigint" ? start.toString() : null,
    target: typeof target === "bigint" ? target.toString() : null,
    budget: typeof budget === "number" && Number.isSafeInteger(budget) ? budget : null,
  };
  if (!outcome.ok) {
    if (!Object.isFrozen(outcome.error)) throw new Error("refusal is not frozen");
    return {
      label,
      input,
      output: {
        kind: "refusal",
        code: outcome.error.code,
        path: outcome.error.path,
        check: outcome.error.check ?? null,
      },
    };
  }
  const result = outcome.result;
  return {
    label,
    input,
    output: {
      kind: "success",
      dispatched: result.dispatched.map((entry) => entry.scheduleId as string),
      thresholds: result.thresholds.map((entry) => ({
        systemId: entry.systemId,
        name: entry.name,
        time: entry.time.toString(),
      })),
      skipped: result.skipped.map((entry) => ({
        kind: entry.kind,
        count: entry.count,
        firstDueAt: entry.firstDueAt.toString(),
        lastDueAt: entry.lastDueAt.toString(),
      })),
      blocked: result.blocked.map((id) => id as string),
      remainingQueueHash: await hashOf(result.remaining),
      nextSystemsHash: await hashOf(result.systems),
      complete: result.complete,
      nextCursorHash: result.cursor === null ? null : await hashOf(result.cursor),
      nextDueAt: result.nextDueAt === null ? null : result.nextDueAt.toString(),
    },
  };
}

export type SchedulerEntry = Awaited<ReturnType<typeof describeCall>>;

/** Targeted calls over the baseline fixture, one per class and continuation shape. */
async function targetedEntries(registry: CatchUpRegistry): Promise<SchedulerEntry[]> {
  const entries: SchedulerEntry[] = [];
  const call = async (label: string, request: Loose) => {
    entries.push(await describeCall(label, request, catchUpSchedules(registry, request)));
  };
  await call("case:all-classes", baselineRequest());
  await call("case:blocked-without-result", baselineRequest({ results: [] }));
  await call(
    "case:superseded",
    baselineRequest({
      queue: [
        ...baselineItems(),
        exactItem("old", 150),
        exactItem("new", 700, { supersedes: "old" }),
      ],
    }),
  );
  await call("case:budget-one", baselineRequest({ budget: 1 }));
  const bounded = chain(registry, baselineRequest(), 2);
  for (const [index, request] of bounded.requests.entries()) {
    const outcome = bounded.outcomes[index] as CatchUpOutcome;
    entries.push(await describeCall(`case:chained-${index}`, request, outcome));
  }
  await call("case:empty-queue", makeRequest());
  await call("case:same-time", makeRequest({ queue: [exactItem("a1", 0)], target: time(0) }));
  return entries;
}

async function refusalEntries(registry: CatchUpRegistry): Promise<SchedulerEntry[]> {
  const entries: SchedulerEntry[] = [];
  const requests = refusalRequests(registry);
  for (const [name, request] of Object.entries(requests)) {
    // The hostile getter cannot be hashed; its identity is that of the request it was derived from.
    const source = name === "engine-exception" ? makeRequest() : request;
    entries.push(
      await describeCall(`refusal:${name}`, request, catchUpSchedules(registry, request), source),
    );
  }
  return entries;
}

async function generatedEntries(registry: CatchUpRegistry): Promise<SchedulerEntry[]> {
  const entries: SchedulerEntry[] = [];
  for (const step of generateSequences(registry)) {
    const label = `generated:${step.sequence}:${step.step}`;
    entries.push(await describeCall(`${label}:unbounded`, step.unboundedRequest, step.unbounded));
    const request = step.chained.requests[0] as Loose;
    entries.push(
      await describeCall(`${label}:bounded`, request, step.chained.outcomes[0] as CatchUpOutcome),
    );
  }
  return entries;
}

export async function schedulerEvidence() {
  const registry = fixtureRegistry();
  const pairs = [];
  for (const pair of differentialPairs(registry)) {
    pairs.push({
      name: pair.name,
      equivalence: pair.equivalence,
      leftHash: await stateHash(pair.left),
      rightHash: await stateHash(pair.right),
    });
  }
  return {
    schemaVersion: 1,
    engineVersion: CATCH_UP_ENGINE_VERSION,
    seed: schedulerSeed,
    entries: [
      ...(await targetedEntries(registry)),
      ...(await refusalEntries(registry)),
      ...(await generatedEntries(registry)),
    ],
    pairs,
  };
}
