import type { ObjectId, SpatialFrameId } from "@clockgrove/contracts";

import type { FixedPoint } from "../spatial.js";
import { compareRational, isOne, isZero, segmentIntervals } from "./geometry.js";
import {
  ceilDiv,
  compareText,
  exactRecord,
  fail,
  fixed,
  floorDiv,
  integerSqrt,
  isPlainRecord,
  list,
  oneOf,
  point,
  positiveFixed,
  roundDiv,
  SPATIAL_MAX_TIME,
  text,
  time,
  version,
} from "./parse.js";
import { type SpatialRegion, shapeDimensions } from "./region.js";

export const MOVEMENT_STATUSES = Object.freeze(["active", "interrupted", "completed"] as const);
export type MovementStatus = (typeof MOVEMENT_STATUSES)[number];

export type MovementDestination =
  | Readonly<{ kind: "anchor"; anchorId: string; graphVersion: number }>
  | Readonly<{
      kind: "pose";
      pose: Readonly<{
        frameId: SpatialFrameId;
        frameVersion: number;
        coordinates: readonly FixedPoint[];
      }>;
    }>;

export interface SpeedPolicy {
  readonly kind: "constant-units-per-second";
  readonly unitsPerSecond: FixedPoint;
}

export interface RegionCrossingRecord {
  readonly regionId: string;
  readonly regionVersion: number;
  readonly kind: "entered" | "exited";
  readonly time: bigint;
}

/** The mover left the near endpoint of a portal step of its route, through the portal. */
export interface PortalCrossingRecord {
  readonly kind: "portal";
  readonly portalId: string;
  readonly time: bigint;
}

export type CrossingRecord = RegionCrossingRecord | PortalCrossingRecord;

export function isRegionCrossing(crossing: CrossingRecord): crossing is RegionCrossingRecord {
  return crossing.kind !== "portal";
}

/**
 * One hop of an anchor route taken through a portal (graph 3 of the spatial model), not over an
 * anchor edge: from anchor `from` to anchor `to`, arriving at segment waypoint `waypoint`.
 */
export interface PortalStep {
  readonly portalId: string;
  readonly from: string;
  readonly to: string;
  readonly waypoint: number;
}

/** The single active route segment: a piecewise-linear path walked at a constant speed. */
export interface MovementSegment {
  readonly waypoints: readonly (readonly FixedPoint[])[];
  readonly startTime: bigint;
  readonly speed: SpeedPolicy;
}

/**
 * Canonical movement state of one object. The position is never stored per step: it is derived
 * from `segment` and the simulation time. A replanned movement inherits the regions the
 * interrupted one was inside of (`initialInside`) so no crossing is emitted twice.
 */
export interface MovementRecord {
  readonly movementId: string;
  readonly priorMovementId?: string;
  readonly successorId?: string;
  readonly status: MovementStatus;
  readonly frameId: SpatialFrameId;
  readonly frameVersion: number;
  readonly destination: MovementDestination;
  readonly anchorPath: readonly string[];
  /** Present only when the route takes a portal, so portal-free records keep their encoding. */
  readonly portalSteps?: readonly PortalStep[];
  readonly segment: MovementSegment;
  readonly initialInside: readonly string[];
  readonly exitedAtStart: readonly string[];
  readonly emitted: readonly CrossingRecord[];
  readonly endedAt?: bigint;
}

export const MS_PER_SECOND = 1000n;
export const MAX_WAYPOINTS = 66;

export interface MovementLeg {
  readonly from: readonly bigint[];
  readonly to: readonly bigint[];
  readonly start: bigint;
  readonly duration: bigint;
  readonly end: bigint;
}

/**
 * Leg lengths are the floor of the Euclidean distance in fixed-point units; each leg lasts
 * ceil(length * 1000 / unitsPerSecond) milliseconds (zero for a zero-length leg).
 */
export function movementLegs(segment: MovementSegment): readonly MovementLeg[] {
  const legs: MovementLeg[] = [];
  let cursor = segment.startTime;
  for (let index = 0; index + 1 < segment.waypoints.length; index += 1) {
    const from = segment.waypoints[index]!;
    const to = segment.waypoints[index + 1]!;
    let squared = 0n;
    for (let axis = 0; axis < from.length; axis += 1) {
      const delta = to[axis]! - from[axis]!;
      squared += delta * delta;
    }
    const length = integerSqrt(squared);
    const duration =
      length === 0n ? 0n : ceilDiv(length * MS_PER_SECOND, segment.speed.unitsPerSecond);
    legs.push({ from, to, start: cursor, duration, end: cursor + duration });
    cursor += duration;
  }
  return legs;
}

export function movementCompletionTime(segment: MovementSegment): bigint {
  const legs = movementLegs(segment);
  return legs.length === 0 ? segment.startTime : legs[legs.length - 1]!.end;
}

/** Position at `at` on the segment: linear interpolation per leg, floor division per axis. */
export function positionAt(segment: MovementSegment, at: bigint): readonly FixedPoint[] {
  const first = segment.waypoints[0]!;
  if (at <= segment.startTime) return first;
  for (const leg of movementLegs(segment)) {
    if (at > leg.end) continue;
    if (leg.duration === 0n || at >= leg.end) return leg.to as readonly FixedPoint[];
    return leg.from.map(
      (value, axis) => value + floorDiv((leg.to[axis]! - value) * (at - leg.start), leg.duration),
    ) as unknown as readonly FixedPoint[];
  }
  return segment.waypoints[segment.waypoints.length - 1]!;
}

function legTime(leg: MovementLeg, n: bigint, d: bigint): bigint {
  return leg.start + roundDiv(leg.duration * n, d);
}

/**
 * The first millisecond of a leg of positive length at which `positionAt` has left `leg.from`:
 * an axis that decreases leaves at once, and one that increases by `delta` leaves once
 * `delta * elapsed >= duration`. Interpolation is monotone per axis, so the mover never returns.
 */
export function legDeparture(leg: MovementLeg): bigint {
  let first = leg.duration;
  for (let axis = 0; axis < leg.from.length; axis += 1) {
    const delta = leg.to[axis]! - leg.from[axis]!;
    const after = delta < 0n ? 1n : delta > 0n ? ceilDiv(leg.duration, delta) : first;
    if (after < first) first = after;
  }
  return leg.start + first;
}

/**
 * Every region crossing implied by the segment, in emission order (time, region id, entered
 * before exited). The crossing time of a boundary parameter s = n / d on a leg is
 * `leg.start + round_half_up(leg.duration * n / d)`. A segment that only touches a boundary
 * yields entered then exited at the same time. Regions in `initialInside` are not entered again,
 * and a degenerate touch at the start of a replanned movement is not repeated when the
 * interrupted movement already exited that region there. Each portal step is crossed when the
 * mover leaves its near waypoint through the portal (`legDeparture` of the hop), so a mover past
 * the near endpoint has always crossed and one still on it never has; at an equal time the portal
 * crossing comes before the region crossings, which then belong to the hop.
 */
export function expectedCrossings(
  movement: Pick<
    MovementRecord,
    "segment" | "frameId" | "frameVersion" | "initialInside" | "exitedAtStart" | "portalSteps"
  >,
  regions: readonly SpatialRegion[],
): readonly CrossingRecord[] {
  const { segment } = movement;
  const legs = movementLegs(segment);
  const raw: RegionCrossingRecord[] = [];
  const dimensions = segment.waypoints[0]!.length;
  for (const region of regions) {
    if (
      region.frameId !== movement.frameId ||
      region.frameVersion !== movement.frameVersion ||
      shapeDimensions(region.shape) !== dimensions
    )
      continue;
    const make = (kind: RegionCrossingRecord["kind"], at: bigint): RegionCrossingRecord => ({
      regionId: region.regionId,
      regionVersion: region.version,
      kind,
      time: at,
    });
    legs.forEach((leg, index) => {
      const intervals = leg.duration === 0n ? [] : segmentIntervals(region.shape, leg.from, leg.to);
      for (const [low, high] of intervals) {
        const entered = legTime(leg, low.n, low.d);
        const exited = legTime(leg, high.n, high.d);
        const joined = index > 0 && isZero(low);
        const continues = index < legs.length - 1 && isOne(high);
        const degenerateAtStart =
          index === 0 &&
          isZero(low) &&
          compareRational(low, high) === 0 &&
          movement.exitedAtStart.includes(region.regionId);
        if (degenerateAtStart) continue;
        if (!joined) raw.push(make("entered", entered));
        if (!continues) raw.push(make("exited", exited));
      }
    });
  }
  raw.sort(
    (left, right) =>
      (left.time < right.time ? -1 : left.time > right.time ? 1 : 0) ||
      compareText(left.regionId, right.regionId),
  ); // Array#sort is stable: one region's crossings at one time keep their generated order.
  const inside = new Set(movement.initialInside);
  const result: RegionCrossingRecord[] = [];
  for (const crossing of raw) {
    if (crossing.kind === "entered") {
      if (inside.has(crossing.regionId)) continue;
      inside.add(crossing.regionId);
    } else {
      if (!inside.has(crossing.regionId)) continue;
      inside.delete(crossing.regionId);
    }
    result.push(crossing);
  }
  const steps = movement.portalSteps ?? [];
  if (steps.length === 0) return result;
  const portals: PortalCrossingRecord[] = steps.map((step) => ({
    kind: "portal",
    portalId: step.portalId,
    time: legDeparture(legs[step.waypoint - 1]!),
  }));
  const merged: CrossingRecord[] = [];
  let region = 0;
  for (const portal of portals) {
    while (region < result.length && result[region]!.time < portal.time)
      merged.push(result[region++]!);
    merged.push(portal);
  }
  while (region < result.length) merged.push(result[region++]!);
  return merged;
}

/** Region ids the object is inside of after the crossings emitted so far. */
export function currentInside(movement: MovementRecord): readonly string[] {
  const inside = new Set(movement.initialInside);
  for (const crossing of movement.emitted) {
    if (crossing.kind === "entered") inside.add(crossing.regionId);
    else if (crossing.kind === "exited") inside.delete(crossing.regionId);
  }
  return [...inside].sort(compareText);
}

/** Structural validation of untrusted canonical movement state; throws DomainValidationError. */
export function parseMovementRecord(
  value: unknown,
  dimensions: 2 | 3,
  path: string,
): MovementRecord {
  const record = exactRecord(
    value,
    path,
    [
      "movementId",
      "status",
      "frameId",
      "frameVersion",
      "destination",
      "anchorPath",
      "segment",
      "initialInside",
      "exitedAtStart",
      "emitted",
    ],
    ["priorMovementId", "successorId", "endedAt", "portalSteps"],
  );
  const status = oneOf(record.status, `${path}.status`, MOVEMENT_STATUSES);
  const segmentBody = exactRecord(record.segment, `${path}.segment`, [
    "waypoints",
    "startTime",
    "speed",
  ]);
  const speed = exactRecord(segmentBody.speed, `${path}.segment.speed`, ["kind", "unitsPerSecond"]);
  const waypoints = list(segmentBody.waypoints, `${path}.segment.waypoints`, 1, MAX_WAYPOINTS).map(
    (item, index) => point(item, `${path}.segment.waypoints[${index}]`, dimensions),
  );
  for (let index = 1; index < waypoints.length; index += 1) {
    if (waypoints[index]!.every((value, axis) => value === waypoints[index - 1]![axis]))
      fail(`${path}.segment.waypoints[${index}]`, "consecutive waypoints must differ");
  }
  const destination = parseDestination(record.destination, `${path}.destination`, dimensions);
  const ids = (key: "anchorPath" | "initialInside" | "exitedAtStart", maximum: number) =>
    list(record[key], `${path}.${key}`, 0, maximum).map((item, index) =>
      text(item, `${path}.${key}[${index}]`),
    );
  const emitted = list(record.emitted, `${path}.emitted`, 0, 4096).map(
    (item, index): CrossingRecord => {
      const at = `${path}.emitted[${index}]`;
      if (isPlainRecord(item) && item.kind === "portal") {
        const body = exactRecord(item, at, ["kind", "portalId", "time"]);
        return {
          kind: "portal",
          portalId: text(body.portalId, `${at}.portalId`),
          time: time(body.time, `${at}.time`),
        };
      }
      const body = exactRecord(item, at, ["regionId", "regionVersion", "kind", "time"]);
      return {
        regionId: text(body.regionId, `${at}.regionId`),
        regionVersion: version(body.regionVersion, `${at}.regionVersion`),
        kind: oneOf(body.kind, `${at}.kind`, ["entered", "exited"] as const),
        time: time(body.time, `${at}.time`),
      };
    },
  );
  let previousStep = 0;
  const portalSteps =
    record.portalSteps === undefined
      ? undefined
      : list(record.portalSteps, `${path}.portalSteps`, 1, MAX_WAYPOINTS).map(
          (item, index): PortalStep => {
            const at = `${path}.portalSteps[${index}]`;
            const body = exactRecord(item, at, ["portalId", "from", "to", "waypoint"]);
            const waypoint = version(body.waypoint, `${at}.waypoint`);
            if (waypoint <= previousStep || waypoint >= waypoints.length)
              fail(`${at}.waypoint`, "must increase within the segment waypoints");
            previousStep = waypoint;
            const from = text(body.from, `${at}.from`);
            const to = text(body.to, `${at}.to`);
            if (from === to) fail(`${at}.to`, "a portal step joins two distinct anchors");
            return { portalId: text(body.portalId, `${at}.portalId`), from, to, waypoint };
          },
        );
  const startTime = time(segmentBody.startTime, `${path}.segment.startTime`);
  const result: MovementRecord = {
    movementId: text(record.movementId, `${path}.movementId`),
    ...(record.priorMovementId === undefined
      ? {}
      : { priorMovementId: text(record.priorMovementId, `${path}.priorMovementId`) }),
    ...(record.successorId === undefined
      ? {}
      : { successorId: text(record.successorId, `${path}.successorId`) }),
    status,
    frameId: text(record.frameId, `${path}.frameId`) as SpatialFrameId,
    frameVersion: version(record.frameVersion, `${path}.frameVersion`),
    destination,
    anchorPath: ids("anchorPath", MAX_WAYPOINTS),
    ...(portalSteps === undefined ? {} : { portalSteps }),
    segment: {
      waypoints: waypoints as unknown as readonly (readonly FixedPoint[])[],
      startTime,
      speed: {
        kind: oneOf(speed.kind, `${path}.segment.speed.kind`, [
          "constant-units-per-second",
        ] as const),
        unitsPerSecond: positiveFixed(speed.unitsPerSecond, `${path}.segment.speed.unitsPerSecond`),
      },
    },
    initialInside: ids("initialInside", 128),
    exitedAtStart: ids("exitedAtStart", 128),
    emitted,
    ...(record.endedAt === undefined ? {} : { endedAt: time(record.endedAt, `${path}.endedAt`) }),
  };
  if ((status === "active") !== (result.endedAt === undefined))
    fail(`${path}.endedAt`, "is present exactly when the movement is not active");
  const completion = movementCompletionTime(result.segment);
  if (completion > SPATIAL_MAX_TIME) fail(`${path}.segment`, "completion exceeds the time range");
  let last = startTime;
  for (const [index, crossing] of emitted.entries()) {
    if (crossing.time < last || crossing.time > completion)
      fail(`${path}.emitted[${index}].time`, "must be ordered within the segment");
    last = crossing.time;
  }
  if (status === "completed" && result.endedAt !== completion)
    fail(`${path}.endedAt`, "must equal the completion time");
  if (status === "interrupted" && (result.endedAt! < startTime || result.endedAt! >= completion))
    fail(`${path}.endedAt`, "must fall within the segment");
  return result;
}

export function parseDestination(
  value: unknown,
  path: string,
  dimensions?: 2 | 3,
): MovementDestination {
  const record = exactRecord(value, path, ["kind"], ["anchorId", "graphVersion", "pose"]);
  const kind = oneOf(record.kind, `${path}.kind`, ["anchor", "pose"] as const);
  if (kind === "anchor") {
    const body = exactRecord(record, path, ["kind", "anchorId", "graphVersion"]);
    return {
      kind,
      anchorId: text(body.anchorId, `${path}.anchorId`),
      graphVersion: version(body.graphVersion, `${path}.graphVersion`),
    };
  }
  const body = exactRecord(record, path, ["kind", "pose"]);
  const pose = exactRecord(body.pose, `${path}.pose`, ["frameId", "frameVersion", "coordinates"]);
  const length = Array.isArray(pose.coordinates) ? pose.coordinates.length : 0;
  const coordinates = point(
    pose.coordinates,
    `${path}.pose.coordinates`,
    dimensions ?? (length === 3 ? 3 : 2),
  );
  return {
    kind,
    pose: {
      frameId: text(pose.frameId, `${path}.pose.frameId`) as SpatialFrameId,
      frameVersion: version(pose.frameVersion, `${path}.pose.frameVersion`),
      coordinates,
    },
  };
}

/** Command payload shapes (all version 1). Fixed-point and time fields are bigints. */
export interface MovementStartPayload {
  readonly schemaVersion: 1;
  readonly objectId: ObjectId;
  readonly destination: MovementDestination;
  readonly unitsPerSecond: FixedPoint;
  readonly observeUntil?: bigint;
}
export interface MovementInterruptPayload {
  readonly schemaVersion: 1;
  readonly objectId: ObjectId;
  readonly at: bigint;
}
export interface MovementReplanPayload {
  readonly schemaVersion: 1;
  readonly objectId: ObjectId;
  readonly at: bigint;
  readonly destination: MovementDestination;
  readonly unitsPerSecond: FixedPoint;
  readonly observeUntil?: bigint;
}

export const MOVEMENT_COMMAND_TYPES = Object.freeze([
  "movement.interrupt",
  "movement.replan",
  "movement.start",
] as const);
export type MovementCommandType = (typeof MOVEMENT_COMMAND_TYPES)[number];
export type MovementPayloadFor<T extends MovementCommandType> = T extends "movement.start"
  ? MovementStartPayload
  : T extends "movement.interrupt"
    ? MovementInterruptPayload
    : MovementReplanPayload;

/** Validates an untrusted movement command payload; throws DomainValidationError. */
export function parseMovementPayload(
  type: MovementCommandType,
  value: unknown,
): MovementStartPayload | MovementInterruptPayload | MovementReplanPayload {
  switch (type) {
    case "movement.start": {
      const body = exactRecord(
        value,
        "payload",
        ["schemaVersion", "objectId", "destination", "unitsPerSecond"],
        ["observeUntil"],
      );
      return {
        schemaVersion: 1,
        objectId: text(body.objectId, "payload.objectId") as ObjectId,
        destination: parseDestination(body.destination, "payload.destination"),
        unitsPerSecond: positiveFixed(body.unitsPerSecond, "payload.unitsPerSecond"),
        ...(body.observeUntil === undefined
          ? {}
          : { observeUntil: time(body.observeUntil, "payload.observeUntil") }),
      };
    }
    case "movement.interrupt": {
      const body = exactRecord(value, "payload", ["schemaVersion", "objectId", "at"]);
      return {
        schemaVersion: 1,
        objectId: text(body.objectId, "payload.objectId") as ObjectId,
        at: time(body.at, "payload.at"),
      };
    }
    case "movement.replan": {
      const body = exactRecord(
        value,
        "payload",
        ["schemaVersion", "objectId", "at", "destination", "unitsPerSecond"],
        ["observeUntil"],
      );
      return {
        schemaVersion: 1,
        objectId: text(body.objectId, "payload.objectId") as ObjectId,
        at: time(body.at, "payload.at"),
        destination: parseDestination(body.destination, "payload.destination"),
        unitsPerSecond: positiveFixed(body.unitsPerSecond, "payload.unitsPerSecond"),
        ...(body.observeUntil === undefined
          ? {}
          : { observeUntil: time(body.observeUntil, "payload.observeUntil") }),
      };
    }
  }
}

/** Fixed-point, range-checked scalar for external callers (e.g. fixtures and tests). */
export function movementFixed(value: unknown, path: string): FixedPoint {
  return fixed(value, path);
}
