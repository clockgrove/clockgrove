import type { CommandId, ScheduleId, SimTimeMs } from "@clockgrove/contracts";
import { canonicalBytes, canonicalSerialize } from "../canonical.js";
import { createDeterministicIdSource } from "../deterministic-id.js";
import { isRefusalSignal, type Refusal, RefusalSignal, refusal } from "../execute/refusal.js";
import { sha256Hex } from "../perception/sha256.js";
import { createScheduleQueue, type ScheduledItem, type ScheduleQueue } from "../scheduler.js";
import type { ScheduledKernelInput, ScheduleMutation } from "../transition.js";

/** Engine version carried by every request, cursor and result. */
export const CATCH_UP_ENGINE_VERSION = "clockgrove-catch-up@1";

export type CatchUpClass = ScheduledItem["catchUpClass"];

/** Continuous-system quantities are bigints or safe integers; floating point never enters. */
export type ContinuousQuantity = bigint | number;
export type ContinuousState = Readonly<Record<string, ContinuousQuantity>>;

export interface ContinuousThreshold {
  readonly name: string;
  /** Exact simulation time, strictly after the time the threshold was asked for. */
  readonly time: SimTimeMs;
}

/** Registered by `(kind, version)`; both functions must be pure and integer-only. */
export interface ContinuousSystem {
  readonly kind: string;
  readonly version: number;
  /** State at `from`, advanced across the interval `[from, to]`. */
  integrate(state: ContinuousState, from: SimTimeMs, to: SimTimeMs): ContinuousState;
  /** The next material threshold strictly after `at`, or `null` for none. */
  nextThreshold(state: ContinuousState, at: SimTimeMs): ContinuousThreshold | null;
}

/** Dispatch entry keyed by `(kind, payloadVersion)`. */
export interface CatchUpPayloadHandler {
  readonly kind: string;
  readonly payloadVersion: number;
  readonly type: string;
  readonly schemaVersion: number;
}

export interface CatchUpRegistryDefinition {
  readonly payloads: readonly CatchUpPayloadHandler[];
  readonly systems: readonly ContinuousSystem[];
}

export interface CatchUpRegistry {
  readonly payloads: ReadonlyMap<string, CatchUpPayloadHandler>;
  readonly systems: ReadonlyMap<string, ContinuousSystem>;
  readonly kinds: ReadonlySet<string>;
}

export type CatchUpRegistrationResult =
  | Readonly<{ ok: true; registry: CatchUpRegistry }>
  | Readonly<{ ok: false; error: Refusal }>;

export interface CatchUpSystemState {
  readonly systemId: string;
  readonly at: SimTimeMs;
  readonly state: ContinuousState;
}

export interface CatchUpRecordedResult {
  readonly scheduleId: ScheduleId;
  readonly idempotencyKey: string;
  readonly payload: unknown;
}

export interface CatchUpCursor {
  readonly engineVersion: string;
  readonly start: SimTimeMs;
  readonly target: SimTimeMs;
  readonly position: SimTimeMs;
  readonly queueDigest: string;
}

export interface CatchUpRequest {
  readonly engineVersion: string;
  readonly queue: ScheduleQueue;
  readonly start: SimTimeMs;
  readonly target: SimTimeMs;
  readonly budget: number;
  readonly cursor: CatchUpCursor | null;
  readonly systems: readonly CatchUpSystemState[];
  readonly results: readonly CatchUpRecordedResult[];
}

export interface CatchUpThresholdRecord {
  readonly systemId: string;
  readonly name: string;
  readonly time: SimTimeMs;
}

export interface CatchUpSkippedSummary {
  readonly kind: string;
  readonly count: number;
  readonly firstDueAt: SimTimeMs;
  readonly lastDueAt: SimTimeMs;
}

export interface CatchUpResult {
  readonly engineVersion: string;
  readonly dispatched: readonly ScheduledKernelInput[];
  readonly thresholds: readonly CatchUpThresholdRecord[];
  readonly skipped: readonly CatchUpSkippedSummary[];
  readonly blocked: readonly ScheduleId[];
  readonly scheduleMutations: readonly ScheduleMutation[];
  readonly remaining: ScheduleQueue;
  readonly systems: readonly CatchUpSystemState[];
  readonly complete: boolean;
  readonly cursor: CatchUpCursor | null;
  readonly nextDueAt: SimTimeMs | null;
}

export type CatchUpOutcome =
  | Readonly<{ ok: true; result: CatchUpResult }>
  | Readonly<{ ok: false; error: Refusal }>;

type Loose = Record<string, unknown>;

const MAX_TIME = (1n << 63n) - 1n;
const CLASSES: readonly string[] = ["exact", "aggregate", "skippable", "externallyBlocked"];
const REQUEST_KEYS = [
  "engineVersion",
  "queue",
  "start",
  "target",
  "budget",
  "cursor",
  "systems",
  "results",
] as const;
const ITEM_KEYS = [
  "id",
  "tenantId",
  "worldId",
  "timelineId",
  "ownerPartitionId",
  "dueAt",
  "priority",
  "tieBreakKey",
  "kind",
  "payloadVersion",
  "payload",
  "idempotencyKey",
  "catchUpClass",
] as const;
const CURSOR_KEYS = ["engineVersion", "start", "target", "position", "queueDigest"] as const;
const RESULT_KEYS = ["scheduleId", "idempotencyKey", "payload"] as const;
const SYSTEM_KEYS = ["systemId", "at", "state"] as const;

const CHECK_TIME_ORDER = "catch-up.time-order@1";
const CHECK_SCOPE = "catch-up.queue-scope@1";
const CHECK_DUPLICATE = "catch-up.queue-duplicate@1";
const CHECK_ORDERING = "catch-up.queue-ordering@1";
const CHECK_DISPATCH_CLASS = "catch-up.dispatch-class@1";
const CHECK_SYSTEM_STATE = "catch-up.system-state@1";
const CHECK_SYSTEMS_DUPLICATE = "catch-up.systems-duplicate@1";
const CHECK_SYSTEMS_TIME = "catch-up.systems-time@1";
const CHECK_CURSOR = "catch-up.cursor@1";
const CHECK_RESULT_TARGET = "catch-up.result-target@1";
const CHECK_RESULT_BLOCKED = "catch-up.result-blocked@1";
const CHECK_RESULT_DUPLICATE = "catch-up.result-duplicate@1";
const CHECK_SYSTEM = "catch-up.system@1";
const CHECK_INTEGRATE = "catch-up.system-integrate@1";
const CHECK_THRESHOLD = "catch-up.system-threshold@1";
const CHECK_ENGINE = "catch-up.engine@1";

export function continuousSystemId(kind: string, version: number): string {
  return `${kind}@${version}`;
}

function dispatchKey(kind: string, version: number): string {
  return `${kind}\u0000${version}`;
}

function fail(code: Refusal["code"], path: string, check?: string): never {
  throw new RefusalSignal(refusal(code, path, check));
}

function reject(path: string, check?: string): never {
  return fail("invalid-input", path, check);
}

function isPlain(value: unknown): value is Loose {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactRecord(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Loose {
  if (!isPlain(value)) return reject(path);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) return reject(path);
  const names = keys as string[];
  for (const key of required) if (!names.includes(key)) return reject(`${path}.${key}`);
  const extra = names.filter((key) => !required.includes(key) && !optional.includes(key)).sort();
  if (extra[0] !== undefined) return reject(`${path}.${extra[0]}`);
  return value;
}

function denseArray(value: unknown, path: string): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    return reject(path);
  }
  return value as readonly unknown[];
}

function timeValue(value: unknown, path: string): SimTimeMs {
  if (typeof value !== "bigint" || value < 0n || value > MAX_TIME) return reject(path);
  return value as SimTimeMs;
}

function identity(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    return reject(path);
  }
  return value;
}

function quantities(value: unknown, path: string, bad: (path: string) => never): ContinuousState {
  if (!isPlain(value) || Reflect.ownKeys(value).some((key) => typeof key !== "string")) {
    return bad(path);
  }
  const copy: Record<string, ContinuousQuantity> = {};
  for (const key of Object.keys(value).sort()) {
    const quantity = value[key];
    if (
      typeof quantity === "bigint" ||
      (typeof quantity === "number" && Number.isSafeInteger(quantity) && !Object.is(quantity, -0))
    ) {
      copy[key] = quantity;
    } else {
      return bad(`${path}.${key}`);
    }
  }
  return Object.freeze(copy);
}

export function createCatchUpRegistry(
  definition: CatchUpRegistryDefinition,
): CatchUpRegistrationResult {
  const payloads = new Map<string, CatchUpPayloadHandler>();
  const systems = new Map<string, ContinuousSystem>();
  const bad = (code: Refusal["code"], path: string): CatchUpRegistrationResult =>
    Object.freeze({ ok: false, error: refusal(code, path) });
  const validKey = (kind: unknown, version: unknown): boolean =>
    typeof kind === "string" &&
    kind.length > 0 &&
    kind.trim() === kind &&
    typeof version === "number" &&
    Number.isSafeInteger(version) &&
    version >= 1;
  for (const [index, handler] of definition.payloads.entries()) {
    const at = `payloads[${index}]`;
    if (
      !validKey(handler.kind, handler.payloadVersion) ||
      typeof handler.type !== "string" ||
      handler.type.length === 0 ||
      !Number.isSafeInteger(handler.schemaVersion) ||
      handler.schemaVersion < 1
    ) {
      return bad("missing-registration-part", at);
    }
    const key = dispatchKey(handler.kind, handler.payloadVersion);
    if (payloads.has(key)) return bad("duplicate-registration", at);
    payloads.set(key, Object.freeze({ ...handler }));
  }
  for (const [index, system] of definition.systems.entries()) {
    const at = `systems[${index}]`;
    if (
      !validKey(system.kind, system.version) ||
      typeof system.integrate !== "function" ||
      typeof system.nextThreshold !== "function"
    ) {
      return bad("missing-registration-part", at);
    }
    const key = dispatchKey(system.kind, system.version);
    if (systems.has(key) || payloads.has(key)) return bad("duplicate-registration", at);
    systems.set(key, system);
  }
  const kinds = new Set<string>();
  for (const handler of payloads.values()) kinds.add(handler.kind);
  for (const system of systems.values()) kinds.add(system.kind);
  return Object.freeze({
    ok: true,
    registry: Object.freeze({ payloads, systems, kinds }),
  });
}

interface LiveSystem {
  readonly systemId: string;
  readonly index: number;
  readonly system: ContinuousSystem;
  at: SimTimeMs;
  state: ContinuousState;
}

function thresholdFor(live: LiveSystem): ContinuousThreshold | null {
  const path = `request.systems[${live.index}]`;
  let next: unknown;
  try {
    next = live.system.nextThreshold(live.state, live.at);
  } catch {
    return fail("check-error", path, CHECK_SYSTEM);
  }
  if (next === null) return null;
  if (!isPlain(next) || Reflect.ownKeys(next).length !== 2) {
    return fail("check-error", path, CHECK_THRESHOLD);
  }
  const { name, time } = next;
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    typeof time !== "bigint" ||
    time <= live.at ||
    time > MAX_TIME
  ) {
    return fail("check-error", path, CHECK_THRESHOLD);
  }
  return { name, time: time as SimTimeMs };
}

function integrate(live: LiveSystem, to: SimTimeMs): void {
  const path = `request.systems[${live.index}]`;
  let next: unknown;
  try {
    next = live.system.integrate(live.state, live.at, to);
  } catch {
    fail("check-error", path, CHECK_SYSTEM);
  }
  live.state = quantities(next, `${path}.state`, (at) => fail("check-error", at, CHECK_INTEGRATE));
  live.at = to;
}

function compareThresholds(left: CatchUpThresholdRecord, right: CatchUpThresholdRecord): number {
  if (left.time !== right.time) return left.time < right.time ? -1 : 1;
  if (left.systemId !== right.systemId) return left.systemId < right.systemId ? -1 : 1;
  return left.name === right.name ? 0 : left.name < right.name ? -1 : 1;
}

/** Advances every system to `to`, emitting each material threshold at its exact time. */
function advanceSystems(
  systems: readonly LiveSystem[],
  to: SimTimeMs,
  out: CatchUpThresholdRecord[],
): void {
  const batch: CatchUpThresholdRecord[] = [];
  for (const live of systems) {
    while (live.at < to) {
      const threshold = thresholdFor(live);
      if (threshold !== null && threshold.time <= to) {
        integrate(live, threshold.time);
        batch.push({ systemId: live.systemId, name: threshold.name, time: threshold.time });
      } else {
        integrate(live, to);
      }
    }
  }
  batch.sort(compareThresholds);
  for (const record of batch) out.push(Object.freeze(record));
}

function parseItem(registry: CatchUpRegistry, raw: unknown, index: number): ScheduledItem {
  const at = `request.queue[${index}]`;
  const record = exactRecord(raw, at, ITEM_KEYS, ["supersedes"]);
  const text = (key: string): string => identity(record[key], `${at}.${key}`);
  const id = text("id");
  const tenantId = text("tenantId");
  const worldId = text("worldId");
  const timelineId = text("timelineId");
  const ownerPartitionId = text("ownerPartitionId");
  const tieBreakKey = text("tieBreakKey");
  const kind = text("kind");
  const idempotencyKey = text("idempotencyKey");
  const dueAt = timeValue(record.dueAt, `${at}.dueAt`);
  const priority = record.priority;
  if (typeof priority !== "number" || !Number.isSafeInteger(priority) || Object.is(priority, -0)) {
    reject(`${at}.priority`);
  }
  const payloadVersion = record.payloadVersion;
  if (
    typeof payloadVersion !== "number" ||
    !Number.isSafeInteger(payloadVersion) ||
    payloadVersion < 1
  ) {
    reject(`${at}.payloadVersion`);
  }
  const catchUpClass = record.catchUpClass;
  if (typeof catchUpClass !== "string") reject(`${at}.catchUpClass`);
  if (!CLASSES.includes(catchUpClass as string)) fail("unsupported-input", `${at}.catchUpClass`);
  let supersedes: string | undefined;
  if (Object.hasOwn(record, "supersedes")) {
    supersedes = identity(record.supersedes, `${at}.supersedes`);
    if (supersedes === id) reject(`${at}.supersedes`);
  }
  try {
    canonicalSerialize(record.payload);
  } catch {
    reject(`${at}.payload`);
  }
  if (!registry.kinds.has(kind)) fail("unsupported-input", `${at}.kind`);
  const key = dispatchKey(kind, payloadVersion as number);
  const hasPayload = registry.payloads.has(key);
  const hasSystem = registry.systems.has(key);
  if (!hasPayload && !hasSystem) fail("unknown-command-version", `${at}.payloadVersion`);
  const mismatch =
    catchUpClass === "aggregate" ? !hasSystem : catchUpClass === "skippable" ? false : !hasPayload;
  if (mismatch) fail("unsupported-input", `${at}.catchUpClass`, CHECK_DISPATCH_CLASS);
  return {
    id: id as ScheduleId,
    tenantId,
    worldId,
    timelineId,
    ownerPartitionId,
    dueAt,
    priority: priority as number,
    tieBreakKey,
    kind,
    payloadVersion: payloadVersion as number,
    payload: record.payload,
    idempotencyKey,
    catchUpClass: catchUpClass as CatchUpClass,
    ...(supersedes === undefined ? {} : { supersedes: supersedes as ScheduleId }),
  } as ScheduledItem;
}

function parseQueue(registry: CatchUpRegistry, raw: unknown): ScheduleQueue {
  const entries = denseArray(raw, "request.queue");
  const items = entries.map((entry, index) => parseItem(registry, entry, index));
  const ids = new Set<string>();
  for (const [index, item] of items.entries()) {
    const first = items[0];
    if (
      first !== undefined &&
      (item.tenantId !== first.tenantId ||
        item.worldId !== first.worldId ||
        item.timelineId !== first.timelineId ||
        item.ownerPartitionId !== first.ownerPartitionId)
    ) {
      reject(`request.queue[${index}]`, CHECK_SCOPE);
    }
    if (ids.has(item.id)) reject(`request.queue[${index}].id`, CHECK_DUPLICATE);
    ids.add(item.id);
  }
  try {
    return createScheduleQueue(items);
  } catch (error) {
    if (error instanceof RangeError && error.message === "ambiguous schedule ordering tuple") {
      return reject("request.queue", CHECK_ORDERING);
    }
    throw error;
  }
}

function parseSystems(registry: CatchUpRegistry, raw: unknown): LiveSystem[] {
  const entries = denseArray(raw, "request.systems");
  const seen = new Set<string>();
  const byId = new Map<string, ContinuousSystem>();
  for (const system of registry.systems.values()) {
    byId.set(continuousSystemId(system.kind, system.version), system);
  }
  const live = entries.map((entry, index): LiveSystem => {
    const at = `request.systems[${index}]`;
    const record = exactRecord(entry, at, SYSTEM_KEYS);
    const systemId = record.systemId;
    if (typeof systemId !== "string") reject(`${at}.systemId`);
    const system = byId.get(systemId as string);
    if (system === undefined) fail("unsupported-input", `${at}.systemId`);
    if (seen.has(systemId as string)) reject(`${at}.systemId`, CHECK_SYSTEMS_DUPLICATE);
    seen.add(systemId as string);
    return {
      systemId: systemId as string,
      index,
      system: system as ContinuousSystem,
      at: timeValue(record.at, `${at}.at`),
      state: quantities(record.state, `${at}.state`, reject),
    };
  });
  return live.sort((left, right) =>
    left.systemId === right.systemId ? 0 : left.systemId < right.systemId ? -1 : 1,
  );
}

function queueDigest(queue: ScheduleQueue): string {
  return sha256Hex(canonicalBytes(queue));
}

function parseCursor(
  raw: unknown,
  start: SimTimeMs,
  target: SimTimeMs,
  queue: ScheduleQueue,
): CatchUpCursor | null {
  if (raw === null) return null;
  const record = exactRecord(raw, "request.cursor", CURSOR_KEYS);
  const version = record.engineVersion;
  if (typeof version !== "string") reject("request.cursor.engineVersion");
  if (version !== CATCH_UP_ENGINE_VERSION) {
    fail("unknown-command-version", "request.cursor.engineVersion");
  }
  const cursorStart = timeValue(record.start, "request.cursor.start");
  const cursorTarget = timeValue(record.target, "request.cursor.target");
  const position = timeValue(record.position, "request.cursor.position");
  const digest = record.queueDigest;
  if (typeof digest !== "string") reject("request.cursor.queueDigest");
  if (cursorStart !== start) reject("request.cursor.start", CHECK_CURSOR);
  if (cursorTarget !== target) reject("request.cursor.target", CHECK_CURSOR);
  if (position < start || position > target) reject("request.cursor.position", CHECK_CURSOR);
  if (digest !== queueDigest(queue)) reject("request.cursor.queueDigest", CHECK_CURSOR);
  return Object.freeze({
    engineVersion: CATCH_UP_ENGINE_VERSION,
    start,
    target,
    position,
    queueDigest: digest as string,
  });
}

function parseResults(raw: unknown, queue: ScheduleQueue): Map<string, CatchUpRecordedResult> {
  const entries = denseArray(raw, "request.results");
  const byId = new Map<string, CatchUpRecordedResult>();
  for (const [index, entry] of entries.entries()) {
    const at = `request.results[${index}]`;
    const record = exactRecord(entry, at, RESULT_KEYS);
    const scheduleId = identity(record.scheduleId, `${at}.scheduleId`);
    const idempotencyKey = identity(record.idempotencyKey, `${at}.idempotencyKey`);
    try {
      canonicalSerialize(record.payload);
    } catch {
      reject(`${at}.payload`);
    }
    const item = queue.find((candidate) => candidate.id === scheduleId);
    if (item === undefined) reject(`${at}.scheduleId`, CHECK_RESULT_TARGET);
    if (item?.catchUpClass !== "externallyBlocked")
      reject(`${at}.scheduleId`, CHECK_RESULT_BLOCKED);
    if (item.idempotencyKey !== idempotencyKey) reject(`${at}.idempotencyKey`, CHECK_RESULT_TARGET);
    if (byId.has(scheduleId)) reject(`${at}.scheduleId`, CHECK_RESULT_DUPLICATE);
    byId.set(scheduleId, {
      scheduleId: scheduleId as ScheduleId,
      idempotencyKey,
      payload: record.payload,
    });
  }
  return byId;
}

function dispatchInput(
  registry: CatchUpRegistry,
  item: ScheduledItem,
  result: CatchUpRecordedResult | undefined,
): ScheduledKernelInput {
  const handler = registry.payloads.get(dispatchKey(item.kind, item.payloadVersion));
  if (handler === undefined) throw new TypeError("dispatch entry vanished");
  const ids = createDeterministicIdSource({
    commandId: `${CATCH_UP_ENGINE_VERSION}/${item.id}/${item.idempotencyKey}` as CommandId,
    eventIndex: 0,
    randomStream: "scheduler",
  });
  return Object.freeze({
    schemaVersion: handler.schemaVersion,
    scheduleId: item.id,
    commandId: ids.next("CommandId"),
    type: handler.type,
    payload:
      result === undefined ? item.payload : { payload: item.payload, result: result.payload },
  });
}

function run(registry: CatchUpRegistry, request: unknown): CatchUpResult {
  const req = exactRecord(request, "request", REQUEST_KEYS);
  const version = req.engineVersion;
  if (typeof version !== "string") reject("request.engineVersion");
  if (version !== CATCH_UP_ENGINE_VERSION) fail("unknown-command-version", "request.engineVersion");
  const start = timeValue(req.start, "request.start");
  const target = timeValue(req.target, "request.target");
  if (target < start) reject("request.target", CHECK_TIME_ORDER);
  const budget = req.budget;
  if (typeof budget !== "number" || !Number.isSafeInteger(budget) || budget < 1) {
    reject("request.budget");
  }
  const queue = parseQueue(registry, req.queue);
  const systems = parseSystems(registry, req.systems);
  const covered = new Set(systems.map((live) => live.systemId));
  for (const [index, item] of queue.entries()) {
    if (
      item.catchUpClass === "aggregate" &&
      !covered.has(continuousSystemId(item.kind, item.payloadVersion))
    ) {
      reject(`request.queue[${index}].kind`, CHECK_SYSTEM_STATE);
    }
  }
  const cursor = parseCursor(req.cursor, start, target, queue);
  let position = cursor === null ? start : cursor.position;
  for (const live of systems) {
    if (live.at !== position) reject(`request.systems[${live.index}].at`, CHECK_SYSTEMS_TIME);
  }
  const results = parseResults(req.results, queue);

  // Supersession is applied as upsertSchedule applies it: the superseded item is dropped.
  const superseded = new Set<string>();
  for (const item of queue) if (item.supersedes !== undefined) superseded.add(item.supersedes);
  const live = queue.filter((item) => !superseded.has(item.id));

  const dispatched: ScheduledKernelInput[] = [];
  const thresholds: CatchUpThresholdRecord[] = [];
  const blocked: ScheduleId[] = [];
  const mutations: ScheduleMutation[] = [];
  const skipped = new Map<string, { count: number; first: SimTimeMs; last: SimTimeMs }>();
  const consumed = new Set<string>();
  let used = 0;
  let complete = true;
  const reach = (item: ScheduledItem): void => {
    const to = (item.dueAt > target ? target : item.dueAt) as SimTimeMs;
    if (to > position) {
      advanceSystems(systems, to, thresholds);
      position = to;
    }
  };
  for (const item of live) {
    if (item.dueAt > target) break;
    if (item.catchUpClass === "skippable") {
      reach(item);
      const entry = skipped.get(item.kind);
      if (entry === undefined)
        skipped.set(item.kind, { count: 1, first: item.dueAt, last: item.dueAt });
      else {
        entry.count += 1;
        entry.last = item.dueAt;
      }
      consumed.add(item.id);
      mutations.push(Object.freeze({ kind: "cancel", scheduleId: item.id }));
      continue;
    }
    const recorded = results.get(item.id);
    if (item.catchUpClass === "externallyBlocked" && recorded === undefined) {
      reach(item);
      blocked.push(item.id);
      continue;
    }
    if (used === budget) {
      complete = false;
      break;
    }
    used += 1;
    reach(item);
    if (item.catchUpClass !== "aggregate") dispatched.push(dispatchInput(registry, item, recorded));
    consumed.add(item.id);
    mutations.push(Object.freeze({ kind: "cancel", scheduleId: item.id }));
  }
  if (complete && target > position) {
    advanceSystems(systems, target, thresholds);
    position = target;
  }
  const remaining = Object.freeze(live.filter((item) => !consumed.has(item.id)));
  const next = remaining[0];
  return Object.freeze({
    engineVersion: CATCH_UP_ENGINE_VERSION,
    dispatched: Object.freeze(dispatched),
    thresholds: Object.freeze(thresholds),
    skipped: Object.freeze(
      [...skipped.entries()]
        .sort(([left], [right]) => (left === right ? 0 : left < right ? -1 : 1))
        .map(([kind, entry]) =>
          Object.freeze({
            kind,
            count: entry.count,
            firstDueAt: entry.first,
            lastDueAt: entry.last,
          }),
        ),
    ),
    blocked: Object.freeze(blocked),
    scheduleMutations: Object.freeze(mutations),
    remaining,
    systems: Object.freeze(
      systems.map((entry) =>
        Object.freeze({ systemId: entry.systemId, at: entry.at, state: entry.state }),
      ),
    ),
    complete,
    cursor: complete
      ? null
      : Object.freeze({
          engineVersion: CATCH_UP_ENGINE_VERSION,
          start,
          target,
          position,
          queueDigest: queueDigest(remaining),
        }),
    nextDueAt: next === undefined ? null : next.dueAt,
  });
}

/** Caps lookahead by each system's threshold count, preserving its independent integration path. */
export function boundedCatchUpTarget(
  registry: CatchUpRegistry,
  states: readonly CatchUpSystemState[],
  target: SimTimeMs,
  thresholdBudget: number,
): SimTimeMs {
  let through = target;
  for (const live of parseSystems(registry, states)) {
    if (live.at >= through) continue;
    for (let count = 1; count <= thresholdBudget; count += 1) {
      const next = thresholdFor(live);
      if (next === null || next.time >= through) break;
      if (count === thresholdBudget) {
        through = next.time;
        break;
      }
      integrate(live, next.time);
    }
  }
  return through;
}

/**
 * Pure, deterministic catch-up. It reads only its arguments, never recurses into its own output
 * and never throws: malformed input and engine failures are returned as frozen refusals.
 */
export function catchUpSchedules(registry: CatchUpRegistry, request: unknown): CatchUpOutcome {
  try {
    return Object.freeze({ ok: true, result: run(registry, request) });
  } catch (error) {
    if (isRefusalSignal(error)) return Object.freeze({ ok: false, error: error.refusal });
    return Object.freeze({ ok: false, error: refusal("handler-failed", "engine", CHECK_ENGINE) });
  }
}
