import {
  type BrowserScope,
  decodeObservationRequest,
  decodeRecordedWhy,
  type RecordedWhy,
} from "./browser-protocol.js";
import type { CommandId, EventId, ObjectId } from "./ids.js";
import { decodeOpaqueId } from "./ids.js";
import { decodeSceneProjection, type SceneProjection } from "./scene-protocol.js";
import {
  array,
  ContractDecodeError,
  exactKeys,
  integer,
  literal,
  nonNegativeInteger,
  record,
  string,
  unsignedDecimal,
} from "./validation.js";

/**
 * The declared bounds of one flashback, echoed in every response. Decisions (issue 273):
 * `framesBefore` and `framesAfter`: eight journaled states either side, a few seconds each way at
 * the browser's frame pace; `windowEvents`: the partition read around the moment, one replay page
 * (2,000 events, `REPLAY_PAGE`), since one advance of the reference fixture journals about 70;
 * `catchUpEvents`: twice the snapshot sweep's 2,000-event cadence (`SNAPSHOT_INTERVAL_EVENTS`), so
 * every moment the sweep keeps up with is in reach. A moment farther than that from its nearest
 * compatible snapshot is never replayed from birth. `snapshotRefs`: the most snapshot refs read
 * newest-first within the catch-up bound to find the start; the sweep leaves about two there
 * (4,000 events at its 2,000-event cadence), and the rest is room for manual snapshots, so the
 * lookup's read is bounded without missing a sweep snapshot. Past the start, replay stops
 * `windowEvents` after the first frame shown (or the moment event before it), so one flashback
 * replays at most `catchUpEvents + windowEvents` events; a frame beyond that is left out as cut.
 */
export const FLASHBACK_BOUNDS = Object.freeze({
  framesBefore: 8,
  framesAfter: 8,
  windowEvents: 2_000,
  catchUpEvents: 4_000,
  snapshotRefs: 16,
});
export type FlashbackBounds = typeof FLASHBACK_BOUNDS;

/** A flashback starts at one journal event (a feed item, a recorded action) or one command (a Why link). */
export type FlashbackEntry = { readonly eventId: EventId } | { readonly commandId: CommandId };

/**
 * A command entry may name the entity the flashback follows (`objectId`), so "and before that…"
 * stays with the same actor: pass the previous flashback's `moment.objectId` with a `before` link.
 */
export type FlashbackRequest = BrowserScope & { readonly version: 1 } & (
    | { readonly eventId: EventId }
    | { readonly commandId: CommandId; readonly objectId?: ObjectId }
  );

/** The moment: the entry command's readable events in the observed space's partition. */
export interface FlashbackMoment {
  readonly commandId: CommandId;
  readonly eventIds: readonly EventId[];
  /** The moment's event: the entry event, else the command's last. Its frame shows the state after it. */
  readonly partitionSequence: string;
  readonly simulationTime: string;
  /**
   * The entity the moment concerns: the request's `objectId`, else the entry event's, else the
   * command's first event that names one.
   */
  readonly objectId: ObjectId | null;
}

/**
 * `replayed`: frames and context are rebuilt from `start` (`birth` or a snapshot ID).
 * `beyond-catch-up-bound`: the nearest compatible start is more than `catchUpEvents` before the
 * window, so nothing is replayed. `not-visible`: the observer may not read every event of the
 * window, so nothing is replayed. `truncated` is true when the window read was cut by `windowEvents`.
 */
export type FlashbackReplay =
  | {
      readonly status: "replayed";
      readonly start: string;
      readonly eventsReplayed: number;
      readonly truncated: boolean;
      /** Frames are journaled states only; nothing between them was recorded or is invented. */
      readonly positionsBetweenFrames: "not-recorded";
    }
  | { readonly status: "beyond-catch-up-bound" | "not-visible" };

/** The committed public scene after one journal command in the window. */
export interface FlashbackFrame {
  readonly partitionSequence: string;
  readonly commandId: CommandId;
  readonly eventIds: readonly EventId[];
  /** True for the moment's own frame. */
  readonly moment: boolean;
  readonly projection: SceneProjection;
}

export interface FlashbackActorState {
  readonly objectId: ObjectId;
  readonly label: string;
  readonly needs: { readonly hunger: number; readonly wetness: number } | null;
  readonly wellbeing: {
    readonly thirst: number;
    readonly health: number;
    readonly comfort: "comfortable" | "uncomfortable";
  } | null;
  readonly selectedAction: {
    readonly kind: string;
    readonly targetObjectId: ObjectId | null;
  } | null;
}

/** Journaled state at the moment's frame; recorded, never current. */
export interface FlashbackContext {
  readonly revision: string;
  readonly simulationTime: string;
  /** Null when the world's pack declares no day length. */
  readonly day: string | null;
  readonly timeOfDayMs: string | null;
  readonly rainIntensity: number;
  readonly present: readonly { readonly objectId: ObjectId; readonly label: string }[];
  readonly actor: FlashbackActorState | null;
}

export const FLASHBACK_LINE_KINDS = ["context", "cause", "influence", "unknown", "limit"] as const;
export type FlashbackLineKind = (typeof FLASHBACK_LINE_KINDS)[number];

/**
 * One sentence of the summary, filled only from records. Each cite is `event:<id>`,
 * `command:<id>`, `draft:<commandId>#<draftIndex>` or `frame:<partitionSequence>`.
 */
export interface FlashbackLine {
  readonly kind: FlashbackLineKind;
  readonly text: string;
  readonly cites: readonly string[];
}

export interface Flashback extends BrowserScope {
  readonly version: 1;
  readonly privacyClass: "public_scene";
  readonly entry: FlashbackEntry;
  readonly moment: FlashbackMoment;
  readonly bounds: FlashbackBounds;
  readonly replay: FlashbackReplay;
  readonly frames: readonly FlashbackFrame[];
  readonly context: FlashbackContext | null;
  /** The moment's recorded Why, exactly as `POST /v1/runtime/why` answers it. */
  readonly why: RecordedWhy;
  /** "And before that…": the moment's readable cause commands, each a further flashback entry. */
  readonly before: readonly CommandId[];
  readonly summary: readonly FlashbackLine[];
}

const SCOPE_KEYS = ["version", "tenantId", "worldId", "timelineId", "spaceId"];

function decodeEntry(v: Record<string, unknown>): FlashbackEntry {
  return "eventId" in v
    ? { eventId: decodeOpaqueId(v.eventId, "EventId") }
    : { commandId: decodeOpaqueId(v.commandId, "CommandId") };
}

/** Exactly one entry: `eventId` or `commandId`. */
export function decodeFlashbackRequest(value: unknown): FlashbackRequest {
  const v = record(value, "flashback");
  const command = !("eventId" in v);
  exactKeys(
    v,
    [...SCOPE_KEYS, command ? "commandId" : "eventId"],
    command ? ["objectId"] : [],
    "flashback",
  );
  const scope = decodeObservationRequest({
    version: v.version,
    tenantId: v.tenantId,
    worldId: v.worldId,
    timelineId: v.timelineId,
    spaceId: v.spaceId,
  });
  const entry = decodeEntry(v);
  const followed = command && v.objectId !== undefined ? { objectId: objectId(v.objectId) } : {};
  // Inspector audit ID bound, as for Why (migration 0022).
  for (const id of [
    scope.tenantId,
    scope.worldId,
    scope.timelineId,
    scope.spaceId,
    ...Object.values(entry),
    ...Object.values(followed),
  ])
    if (new TextEncoder().encode(id).length > 1024)
      throw new ContractDecodeError("flashback", "inspector ID length out of range");
  return { ...scope, ...entry, ...followed };
}

const decimal = (value: unknown, path: string): string => unsignedDecimal(value, path).toString();
const nullable = <T>(value: unknown, decode: (value: unknown) => T): T | null =>
  value === null ? null : decode(value);
const objectId = (value: unknown): ObjectId => decodeOpaqueId(value, "ObjectId");

function decodeActor(value: unknown, path: string): FlashbackActorState {
  const v = record(value, path);
  exactKeys(v, ["objectId", "label", "needs", "wellbeing", "selectedAction"], [], path);
  return {
    objectId: objectId(v.objectId),
    label: string(v.label, `${path}.label`),
    needs: nullable(v.needs, (needs) => {
      const n = record(needs, `${path}.needs`);
      exactKeys(n, ["hunger", "wetness"], [], `${path}.needs`);
      return {
        hunger: integer(n.hunger, `${path}.needs.hunger`),
        wetness: integer(n.wetness, `${path}.needs.wetness`),
      };
    }),
    wellbeing: nullable(v.wellbeing, (wellbeing) => {
      const w = record(wellbeing, `${path}.wellbeing`);
      exactKeys(w, ["thirst", "health", "comfort"], [], `${path}.wellbeing`);
      return {
        thirst: integer(w.thirst, `${path}.wellbeing.thirst`),
        health: integer(w.health, `${path}.wellbeing.health`),
        comfort: literal(w.comfort, ["comfortable", "uncomfortable"], `${path}.wellbeing.comfort`),
      };
    }),
    selectedAction: nullable(v.selectedAction, (action) => {
      const a = record(action, `${path}.selectedAction`);
      exactKeys(a, ["kind", "targetObjectId"], [], `${path}.selectedAction`);
      return {
        kind: string(a.kind, `${path}.selectedAction.kind`),
        targetObjectId: nullable(a.targetObjectId, objectId),
      };
    }),
  };
}

function decodeContext(value: unknown, path: string): FlashbackContext {
  const v = record(value, path);
  exactKeys(
    v,
    ["revision", "simulationTime", "day", "timeOfDayMs", "rainIntensity", "present", "actor"],
    [],
    path,
  );
  return {
    revision: decimal(v.revision, `${path}.revision`),
    simulationTime: decimal(v.simulationTime, `${path}.simulationTime`),
    day: nullable(v.day, (day) => decimal(day, `${path}.day`)),
    timeOfDayMs: nullable(v.timeOfDayMs, (time) => decimal(time, `${path}.timeOfDayMs`)),
    rainIntensity: nonNegativeInteger(v.rainIntensity, `${path}.rainIntensity`),
    present: array(v.present, `${path}.present`, (item, itemPath) => {
      const p = record(item, itemPath);
      exactKeys(p, ["objectId", "label"], [], itemPath);
      return { objectId: objectId(p.objectId), label: string(p.label, `${itemPath}.label`) };
    }),
    actor: nullable(v.actor, (actor) => decodeActor(actor, `${path}.actor`)),
  };
}

function decodeReplay(value: unknown, path: string): FlashbackReplay {
  const v = record(value, path);
  const status = literal(
    v.status,
    ["replayed", "beyond-catch-up-bound", "not-visible"] as const,
    `${path}.status`,
  );
  if (status !== "replayed") {
    exactKeys(v, ["status"], [], path);
    return { status };
  }
  exactKeys(
    v,
    ["status", "start", "eventsReplayed", "truncated", "positionsBetweenFrames"],
    [],
    path,
  );
  if (typeof v.truncated !== "boolean")
    throw new ContractDecodeError(`${path}.truncated`, "expected a boolean");
  return {
    status,
    start: string(v.start, `${path}.start`),
    eventsReplayed: nonNegativeInteger(v.eventsReplayed, `${path}.eventsReplayed`),
    truncated: v.truncated,
    positionsBetweenFrames: literal(
      v.positionsBetweenFrames,
      ["not-recorded"] as const,
      `${path}.positionsBetweenFrames`,
    ),
  };
}

function decodeFrame(value: unknown, path: string): FlashbackFrame {
  const v = record(value, path);
  exactKeys(v, ["partitionSequence", "commandId", "eventIds", "moment", "projection"], [], path);
  if (typeof v.moment !== "boolean")
    throw new ContractDecodeError(`${path}.moment`, "expected a boolean");
  return {
    partitionSequence: decimal(v.partitionSequence, `${path}.partitionSequence`),
    commandId: decodeOpaqueId(v.commandId, "CommandId"),
    eventIds: array(v.eventIds, `${path}.eventIds`, (id) => decodeOpaqueId(id, "EventId")),
    moment: v.moment,
    projection: decodeSceneProjection(v.projection, `${path}.projection`),
  };
}

/** Strict decoding at every level; unknown and missing fields are refused. */
export function decodeFlashback(value: unknown): Flashback {
  const v = record(value, "flashback");
  exactKeys(
    v,
    [
      ...SCOPE_KEYS,
      "privacyClass",
      "entry",
      "moment",
      "bounds",
      "replay",
      "frames",
      "context",
      "why",
      "before",
      "summary",
    ],
    [],
    "flashback",
  );
  const scope = decodeObservationRequest({
    version: v.version,
    tenantId: v.tenantId,
    worldId: v.worldId,
    timelineId: v.timelineId,
    spaceId: v.spaceId,
  });
  if (v.privacyClass !== "public_scene")
    throw new ContractDecodeError("flashback.privacyClass", "expected public_scene");
  const entry = record(v.entry, "flashback.entry");
  exactKeys(entry, ["eventId" in entry ? "eventId" : "commandId"], [], "flashback.entry");
  const moment = record(v.moment, "flashback.moment");
  exactKeys(
    moment,
    ["commandId", "eventIds", "partitionSequence", "simulationTime", "objectId"],
    [],
    "flashback.moment",
  );
  const bounds = record(v.bounds, "flashback.bounds");
  exactKeys(bounds, Object.keys(FLASHBACK_BOUNDS), [], "flashback.bounds");
  for (const [key, expected] of Object.entries(FLASHBACK_BOUNDS))
    if (bounds[key] !== expected)
      throw new ContractDecodeError(`flashback.bounds.${key}`, "expected the declared bound");
  const why = decodeRecordedWhy(v.why);
  if (
    why.tenantId !== scope.tenantId ||
    why.worldId !== scope.worldId ||
    why.timelineId !== scope.timelineId ||
    why.spaceId !== scope.spaceId
  )
    throw new ContractDecodeError("flashback.why", "Why of another scope");
  return {
    ...scope,
    privacyClass: "public_scene",
    entry: decodeEntry(entry),
    moment: {
      commandId: decodeOpaqueId(moment.commandId, "CommandId"),
      eventIds: array(moment.eventIds, "flashback.moment.eventIds", (id) =>
        decodeOpaqueId(id, "EventId"),
      ),
      partitionSequence: decimal(moment.partitionSequence, "flashback.moment.partitionSequence"),
      simulationTime: decimal(moment.simulationTime, "flashback.moment.simulationTime"),
      objectId: nullable(moment.objectId, objectId),
    },
    bounds: FLASHBACK_BOUNDS,
    replay: decodeReplay(v.replay, "flashback.replay"),
    frames: array(v.frames, "flashback.frames", decodeFrame),
    context: nullable(v.context, (context) => decodeContext(context, "flashback.context")),
    why,
    before: array(v.before, "flashback.before", (id) => decodeOpaqueId(id, "CommandId")),
    summary: array(v.summary, "flashback.summary", (item, path) => {
      const line = record(item, path);
      exactKeys(line, ["kind", "text", "cites"], [], path);
      return {
        kind: literal(line.kind, FLASHBACK_LINE_KINDS, `${path}.kind`),
        text: string(line.text, `${path}.text`),
        cites: array(line.cites, `${path}.cites`, (cite, citePath) => string(cite, citePath)),
      };
    }),
  };
}

const decimalBigints = (_key: string, item: unknown) =>
  typeof item === "bigint" ? item.toString() : item;

/** The JSON text of a flashback, checked by `decodeFlashback` first. */
export function encodeFlashback(value: Flashback): string {
  return JSON.stringify(
    decodeFlashback(JSON.parse(JSON.stringify(value, decimalBigints))),
    decimalBigints,
  );
}
