import type {
  PartitionId,
  ScheduleId,
  SimTimeMs,
  TenantId,
  TimelineId,
  WorldId,
} from "@clockgrove/contracts";

export interface ScheduledItem<T = unknown> {
  readonly id: ScheduleId;
  readonly tenantId: TenantId;
  readonly worldId: WorldId;
  readonly timelineId: TimelineId;
  readonly ownerPartitionId: PartitionId;
  readonly dueAt: SimTimeMs;
  readonly priority: number;
  readonly tieBreakKey: string;
  readonly kind: string;
  readonly payloadVersion: number;
  readonly payload: Readonly<T>;
  readonly idempotencyKey: string;
  readonly catchUpClass: "exact" | "aggregate" | "skippable" | "externallyBlocked";
  readonly supersedes?: ScheduleId;
}

export type ScheduleQueue<T = unknown> = readonly ScheduledItem<T>[];

export interface ScheduleContinuation {
  readonly through: SimTimeMs;
  readonly nextDueAt: SimTimeMs;
  readonly nextPriority: number;
  readonly nextTieBreakKey: string;
}

export interface ScheduleDrain<T = unknown> {
  readonly due: ScheduleQueue<T>;
  readonly remaining: ScheduleQueue<T>;
  readonly complete: boolean;
  readonly continuation?: ScheduleContinuation;
}

const MAX_SIMULATION_TIME = (1n << 63n) - 1n;

function validateTime(value: SimTimeMs): void {
  if (typeof value !== "bigint" || value < 0n || value > MAX_SIMULATION_TIME) {
    throw new RangeError("schedule time must be a non-negative signed 64-bit integer");
  }
}

function validateItem(item: ScheduledItem): void {
  validateTime(item.dueAt);
  if (!Number.isSafeInteger(item.priority)) throw new RangeError("invalid schedule priority");
  if (!Number.isSafeInteger(item.payloadVersion) || item.payloadVersion < 1) {
    throw new RangeError("invalid schedule payload version");
  }
  for (const value of [
    item.id,
    item.tenantId,
    item.worldId,
    item.timelineId,
    item.ownerPartitionId,
    item.tieBreakKey,
    item.kind,
    item.idempotencyKey,
  ]) {
    if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
      throw new TypeError("invalid schedule identity or dispatch metadata");
    }
  }
  if (!["exact", "aggregate", "skippable", "externallyBlocked"].includes(item.catchUpClass)) {
    throw new TypeError("invalid schedule catch-up class");
  }
  if (item.supersedes !== undefined) {
    if (
      typeof item.supersedes !== "string" ||
      item.supersedes.length === 0 ||
      item.supersedes.trim() !== item.supersedes
    ) {
      throw new TypeError("invalid superseded schedule identity");
    }
    if (item.supersedes === item.id) throw new RangeError("a schedule cannot supersede itself");
  }
}

function sameScope(left: ScheduledItem, right: ScheduledItem): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.worldId === right.worldId &&
    left.timelineId === right.timelineId &&
    left.ownerPartitionId === right.ownerPartitionId
  );
}

function compareSchedules(left: ScheduledItem, right: ScheduledItem): number {
  if (left.dueAt !== right.dueAt) return left.dueAt < right.dueAt ? -1 : 1;
  if (left.priority !== right.priority) return left.priority < right.priority ? -1 : 1;
  if (left.tieBreakKey === right.tieBreakKey) return 0;
  return left.tieBreakKey < right.tieBreakKey ? -1 : 1;
}

/** Snapshot immutable metadata; payloads remain caller-owned readonly domain values. */
export function createScheduleQueue<T>(items: ScheduleQueue<T> = []): ScheduleQueue<T> {
  const identities = new Set<ScheduleId>();
  const first = items[0];
  const ordered = items.map((item) => {
    validateItem(item);
    if (first !== undefined && !sameScope(first, item)) {
      throw new RangeError("a schedule queue must have one ownership scope");
    }
    if (identities.has(item.id)) throw new RangeError("duplicate schedule identity");
    identities.add(item.id);
    return Object.freeze({ ...item });
  });
  ordered.sort(compareSchedules);
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      compareSchedules(previous, current) === 0
    ) {
      throw new RangeError("ambiguous schedule ordering tuple");
    }
  }
  return Object.freeze(ordered);
}

export function upsertSchedule<T>(
  queue: ScheduleQueue<T>,
  item: ScheduledItem<T>,
): ScheduleQueue<T> {
  const current = createScheduleQueue(queue);
  validateItem(item);
  if (current[0] !== undefined && !sameScope(current[0], item)) {
    throw new RangeError("cannot change schedule ownership scope");
  }
  return createScheduleQueue([
    ...current.filter((entry) => entry.id !== item.id && entry.id !== item.supersedes),
    item,
  ]);
}

export function cancelSchedule<T>(queue: ScheduleQueue<T>, id: ScheduleId): ScheduleQueue<T> {
  return createScheduleQueue(createScheduleQueue(queue).filter((item) => item.id !== id));
}

/**
 * Dispatches exact scheduled inputs only. The budget counts inputs, not handler-emitted events;
 * callers must bound result adoption separately. This operation never advances world time.
 */
export function drainSchedulesThrough<T>(
  queue: ScheduleQueue<T>,
  through: SimTimeMs,
  maxItems: number,
): ScheduleDrain<T> {
  validateTime(through);
  if (!Number.isSafeInteger(maxItems) || maxItems < 1) {
    throw new RangeError("schedule input budget must be a positive safe integer");
  }
  const ordered = createScheduleQueue(queue);
  let count = 0;
  for (const item of ordered) {
    if (item.dueAt > through || count === maxItems) break;
    if (item.catchUpClass !== "exact") {
      throw new RangeError("this capability dispatches only exact scheduled inputs");
    }
    count += 1;
  }
  const next = ordered[count];
  const complete = next === undefined || next.dueAt > through;
  return Object.freeze({
    due: Object.freeze(ordered.slice(0, count)),
    remaining: Object.freeze(ordered.slice(count)),
    complete,
    ...(complete || next === undefined
      ? {}
      : {
          continuation: Object.freeze({
            through,
            nextDueAt: next.dueAt,
            nextPriority: next.priority,
            nextTieBreakKey: next.tieBreakKey,
          }),
        }),
  });
}
