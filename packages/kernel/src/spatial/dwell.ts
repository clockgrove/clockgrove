import type { ObjectId, ScheduleId, SimTimeMs } from "@clockgrove/contracts";
import {
  isArrivalExit,
  remainsInside,
  type WorldEntity,
  type WorldState,
} from "@clockgrove/domain";
import { canonicalSerialize } from "../canonical.js";
import { fnv1a64Hex } from "../fnv1a64.js";
import type { ScheduledItem, ScheduleQueue } from "../scheduler.js";

/** The kind of a keyed remain-in-region schedule (one per object and dwell region). */
export const DWELL_SCHEDULE_KIND = "movement.region-dwell";
/** Due dwells sort after the decisions due at the same time (`world.decision` has priority 10). */
export const DWELL_PRIORITY = 20;
const MAX_TIME = (1n << 63n) - 1n;

export interface DwellPayload {
  readonly schemaVersion: 1;
  readonly objectId: ObjectId;
  readonly regionId: string;
  readonly regionVersion: number;
  readonly enteredAt: SimTimeMs;
}

/** A schedule change, in the shape of the kernel's schedule mutations. */
export type DwellMutation<T> =
  | Readonly<{
      kind: "upsert";
      scheduleId: ScheduleId;
      dueAt: SimTimeMs;
      payload: T;
      item: ScheduledItem<T>;
    }>
  | Readonly<{ kind: "cancel"; scheduleId: ScheduleId }>;

/** The schedule id of an object's dwell in a region: its key, independent of any command. */
export function dwellScheduleId(objectId: string, regionId: string): ScheduleId {
  return `dwell_${fnv1a64Hex(canonicalSerialize(["clockgrove-dwell-schedule-v1", objectId, regionId]))}` as ScheduleId;
}

export function isDwellItem(item: ScheduledItem<unknown>): boolean {
  return item.kind === DWELL_SCHEDULE_KIND;
}

/** The dwell schedule of an entry into `regionId` at `enteredAt`; undefined past the time range. */
function dwellItem(
  state: WorldState,
  objectId: ObjectId,
  regionId: string,
  enteredAt: bigint,
): ScheduledItem<DwellPayload> | undefined {
  const region = (state.spatialRegions ?? []).find((candidate) => candidate.regionId === regionId);
  if (region?.dwell === undefined) return undefined;
  const dueAt = enteredAt + region.dwell.durationMs;
  if (dueAt > MAX_TIME) return undefined;
  const id = dwellScheduleId(objectId, regionId);
  return Object.freeze({
    id,
    tenantId: state.tenantId,
    worldId: state.worldId,
    timelineId: state.timelineId,
    ownerPartitionId: state.partitionId,
    dueAt: dueAt as SimTimeMs,
    priority: DWELL_PRIORITY,
    tieBreakKey: canonicalSerialize([objectId, regionId]),
    kind: DWELL_SCHEDULE_KIND,
    payloadVersion: 1,
    payload: Object.freeze({
      schemaVersion: 1 as const,
      objectId,
      regionId,
      regionVersion: region.version,
      enteredAt: enteredAt as SimTimeMs,
    }),
    idempotencyKey: `${id}:${dueAt}`,
    catchUpClass: "exact",
  });
}

interface EventLike {
  readonly type: string;
  readonly simulationTime: bigint;
  readonly payload: unknown;
}

/**
 * The dwell schedule changes one emitted event implies: an entry into a dwell region upserts the
 * object's keyed schedule (a re-entry supersedes the pending one), and an exit, a remain-in-region
 * event, a death or a retirement cancels it. `state` is the state the event was applied to.
 */
export function dwellChanges<T>(
  schedules: ScheduleQueue<T>,
  state: WorldState,
  event: EventLike,
): readonly DwellMutation<T>[] {
  const payload = event.payload as { objectId?: ObjectId; regionId?: string };
  const objectId = payload.objectId;
  if (objectId === undefined) return [];
  const pending = (regionId: string) =>
    schedules.find((item) => item.id === dwellScheduleId(objectId, regionId));
  const cancel = (item: ScheduledItem<T> | undefined): DwellMutation<T>[] =>
    item === undefined ? [] : [Object.freeze({ kind: "cancel", scheduleId: item.id })];
  switch (event.type) {
    case "movement.region-entered": {
      const item = dwellItem(state, objectId, payload.regionId!, event.simulationTime);
      if (item === undefined) return cancel(pending(payload.regionId!));
      return [
        Object.freeze({
          kind: "upsert",
          scheduleId: item.id,
          dueAt: item.dueAt,
          payload: item.payload as T,
          item: item as unknown as ScheduledItem<T>,
        }),
      ];
    }
    case "movement.region-exited": {
      // Arriving inside the region is not leaving it, though the crossing stream closes there.
      const movement = state.entities.find((entity) => entity.objectId === objectId)?.movement;
      const movementId = (event.payload as { movementId?: string }).movementId;
      if (
        movement !== undefined &&
        movement.movementId === movementId &&
        isArrivalExit(state, movement, payload.regionId!, event.simulationTime)
      )
        return [];
      return cancel(pending(payload.regionId!));
    }
    case "movement.region-remained":
      return cancel(pending(payload.regionId!));
    case "lifecycle.died":
    case "object.retired":
      return schedules
        .filter(
          (item) =>
            isDwellItem(item) && (item.payload as unknown as DwellPayload).objectId === objectId,
        )
        .flatMap((item) => cancel(item));
    default:
      return [];
  }
}

/**
 * Whether a dwell due at `at` holds: the object is active and has stayed inside since the entry
 * (`remainsInside`, read from its movement record at `at`).
 */
export function dwellHolds(state: WorldState, payload: DwellPayload, at: bigint): boolean {
  const entity: WorldEntity | undefined = state.entities.find(
    (candidate) => candidate.objectId === payload.objectId,
  );
  return (
    entity !== undefined &&
    (entity.lifecycle === undefined || entity.lifecycle.status === "active") &&
    remainsInside(state, entity, payload.regionId, payload.enteredAt, at)
  );
}

/** The `movement.region-remained` payload of a due dwell schedule. */
export function remainedPayload(payload: DwellPayload) {
  return Object.freeze({
    objectId: payload.objectId,
    regionId: payload.regionId,
    regionVersion: payload.regionVersion,
    enteredAt: payload.enteredAt,
  });
}

/**
 * Throws unless a queued dwell is well formed against the state: its key, ordering fields and
 * payload, a known object and a region that still declares the same dwell, and a due time that
 * is the entry time plus that dwell and not in the past.
 */
export function validateDwellItem(state: WorldState, item: ScheduledItem<unknown>): void {
  const payload = item.payload as Partial<DwellPayload>;
  const keys = Object.keys(payload as object)
    .sort()
    .join();
  const region = (state.spatialRegions ?? []).find(
    (candidate) => candidate.regionId === payload.regionId,
  );
  if (
    keys !== "enteredAt,objectId,regionId,regionVersion,schemaVersion" ||
    payload.schemaVersion !== 1 ||
    typeof payload.objectId !== "string" ||
    typeof payload.regionId !== "string" ||
    typeof payload.enteredAt !== "bigint" ||
    item.payloadVersion !== 1 ||
    item.catchUpClass !== "exact" ||
    item.priority !== DWELL_PRIORITY ||
    item.supersedes !== undefined ||
    item.id !== dwellScheduleId(payload.objectId, payload.regionId) ||
    item.tieBreakKey !== canonicalSerialize([payload.objectId, payload.regionId]) ||
    item.idempotencyKey !== `${item.id}:${item.dueAt}` ||
    region?.dwell === undefined ||
    region.version !== payload.regionVersion ||
    item.dueAt !== payload.enteredAt + region.dwell.durationMs ||
    item.dueAt < state.simulationTime ||
    !state.entities.some((entity) => entity.objectId === payload.objectId)
  )
    throw new RangeError("malformed remain-in-region schedule");
}
