import type { WorldState } from "@clockgrove/domain";
import type { ScheduledItem, ScheduleQueue, WorldScheduledPayload } from "@clockgrove/kernel";
import { canonicalBytes, createScheduleQueue, sha256Hex } from "@clockgrove/kernel";

import type { CanonicalNode } from "./canonical-node.js";
import { CanonicalNodeError, decodeCanonicalNode, encodeCanonicalNode } from "./canonical-node.js";

/**
 * Version 2 keeps the world state, the named random state and the hash of the schedule queue in the
 * document; the queue itself is stored as one row per scheduled occurrence (Wave 2 plan §7.3).
 */
export const PARTITION_STATE_DOCUMENT_VERSION = 2;
const DOCUMENT_KIND = "clockgrove.partition-state";

/**
 * The live state of one partition: everything the Wave 1 kernel reads and returns. `randomState` is
 * the kernel's serialized named random state.
 */
export interface PartitionStateDocument {
  readonly state: WorldState;
  readonly schedules: ScheduleQueue<WorldScheduledPayload>;
  readonly randomState: string;
}

/** One scheduled occurrence as stored: its indexed fields and the typed canonical node of the item. */
export interface EncodedScheduleItem {
  readonly scheduleId: string;
  readonly idempotencyKey: string;
  readonly ownerPartitionId: string;
  readonly dueAt: bigint;
  readonly priority: number;
  readonly tieBreakKey: string;
  readonly kind: string;
  readonly payloadVersion: number;
  readonly catchUpClass: string;
  readonly supersedes?: string;
  readonly item: CanonicalNode;
  /** Lowercase hex SHA-256 of the canonical bytes of the item. */
  readonly itemHash: string;
}

/** A state document as stored: its canonical node, its schedule rows and the hashes that verify them. */
export interface EncodedPartitionState {
  /** The kernel revision; the partition revision clients see. */
  readonly revision: bigint;
  readonly simulationTime: bigint;
  readonly documentVersion: number;
  readonly document: CanonicalNode;
  /** Lowercase hex SHA-256 of the canonical bytes of the whole document. */
  readonly documentHash: string;
  /** Lowercase hex SHA-256 of the canonical bytes of `state`, as the simulator reports it. */
  readonly stateHash: string;
  /** The pending schedule rows, in the kernel's queue order. */
  readonly schedules: readonly EncodedScheduleItem[];
}

export type PartitionStateIntegrityReason =
  | "malformed-document"
  | "document-hash-mismatch"
  | "state-hash-mismatch"
  | "revision-mismatch"
  | "schedule-mismatch";

/** A stored partition state does not verify. It is a defect to report, never state to run on. */
export class PartitionStateIntegrityError extends Error {
  constructor(readonly reason: PartitionStateIntegrityReason) {
    super(`partition state failed verification: ${reason}`);
    this.name = "PartitionStateIntegrityError";
  }
}

/** The state hash the simulator reports for a world state. */
export function worldStateHash(state: WorldState): string {
  return sha256Hex(canonicalBytes(state));
}

/** The hash a version-2 document records for its schedule queue. */
export function scheduleQueueHash(schedules: ScheduleQueue<WorldScheduledPayload>): string {
  return sha256Hex(canonicalBytes(schedules));
}

export function encodeScheduleItem(
  item: ScheduledItem<WorldScheduledPayload>,
): EncodedScheduleItem {
  return {
    scheduleId: item.id,
    idempotencyKey: item.idempotencyKey,
    ownerPartitionId: item.ownerPartitionId,
    dueAt: item.dueAt,
    priority: item.priority,
    tieBreakKey: item.tieBreakKey,
    kind: item.kind,
    payloadVersion: item.payloadVersion,
    catchUpClass: item.catchUpClass,
    ...(item.supersedes === undefined ? {} : { supersedes: item.supersedes }),
    item: encodeCanonicalNode(item),
    itemHash: sha256Hex(canonicalBytes(item)),
  };
}

export function encodePartitionState(document: PartitionStateDocument): EncodedPartitionState {
  const value = {
    kind: DOCUMENT_KIND,
    version: PARTITION_STATE_DOCUMENT_VERSION,
    state: document.state,
    randomState: document.randomState,
    schedulesHash: scheduleQueueHash(document.schedules),
  };
  return {
    revision: document.state.revision,
    simulationTime: document.state.simulationTime,
    documentVersion: PARTITION_STATE_DOCUMENT_VERSION,
    document: encodeCanonicalNode(value),
    documentHash: sha256Hex(canonicalBytes(value)),
    stateHash: worldStateHash(document.state),
    schedules: document.schedules.map(encodeScheduleItem),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Ordinary records and arrays, as the kernel's inputs are built (decoded records have no prototype). */
export function plainValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plainValue);
  if (isRecord(value)) {
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(value)) copy[key] = plainValue(value[key]);
    return copy;
  }
  return value;
}

function decodeNode(node: CanonicalNode): unknown {
  try {
    return plainValue(decodeCanonicalNode(node));
  } catch (error) {
    if (error instanceof CanonicalNodeError)
      throw new PartitionStateIntegrityError("malformed-document");
    throw error;
  }
}

/** A stored schedule row's item, checked against its hash and its indexed fields. */
function decodeScheduleItem(row: EncodedScheduleItem): ScheduledItem<WorldScheduledPayload> {
  const value = decodeNode(row.item);
  if (!isRecord(value)) throw new PartitionStateIntegrityError("schedule-mismatch");
  if (sha256Hex(canonicalBytes(value)) !== row.itemHash) {
    throw new PartitionStateIntegrityError("schedule-mismatch");
  }
  if (
    value.id !== row.scheduleId ||
    value.idempotencyKey !== row.idempotencyKey ||
    value.ownerPartitionId !== row.ownerPartitionId ||
    value.dueAt !== row.dueAt ||
    value.priority !== row.priority ||
    value.tieBreakKey !== row.tieBreakKey ||
    value.kind !== row.kind ||
    value.payloadVersion !== row.payloadVersion ||
    value.catchUpClass !== row.catchUpClass ||
    value.supersedes !== row.supersedes
  ) {
    throw new PartitionStateIntegrityError("schedule-mismatch");
  }
  return value as unknown as ScheduledItem<WorldScheduledPayload>;
}

/**
 * Decodes a stored state document and its schedule rows and verifies them: the document hash over the
 * decoded value, the state hash, the stored revision, each row against its item, and the rebuilt queue
 * against the document's schedule hash (so a dropped, added or changed row is reported). Any
 * difference throws `PartitionStateIntegrityError`.
 */
export function decodePartitionState(stored: EncodedPartitionState): PartitionStateDocument {
  if (stored.documentVersion !== PARTITION_STATE_DOCUMENT_VERSION) {
    throw new PartitionStateIntegrityError("malformed-document");
  }
  const value = decodeNode(stored.document);
  if (
    !isRecord(value) ||
    value.kind !== DOCUMENT_KIND ||
    value.version !== PARTITION_STATE_DOCUMENT_VERSION ||
    !isRecord(value.state) ||
    typeof value.randomState !== "string" ||
    typeof value.schedulesHash !== "string"
  ) {
    throw new PartitionStateIntegrityError("malformed-document");
  }
  if (sha256Hex(canonicalBytes(value)) !== stored.documentHash) {
    throw new PartitionStateIntegrityError("document-hash-mismatch");
  }
  const state = value.state as unknown as WorldState;
  if (worldStateHash(state) !== stored.stateHash) {
    throw new PartitionStateIntegrityError("state-hash-mismatch");
  }
  if (state.revision !== stored.revision || state.simulationTime !== stored.simulationTime) {
    throw new PartitionStateIntegrityError("revision-mismatch");
  }
  let schedules: ScheduleQueue<WorldScheduledPayload>;
  try {
    schedules = createScheduleQueue(stored.schedules.map(decodeScheduleItem));
  } catch (error) {
    if (error instanceof PartitionStateIntegrityError) throw error;
    throw new PartitionStateIntegrityError("schedule-mismatch");
  }
  if (scheduleQueueHash(schedules) !== value.schedulesHash) {
    throw new PartitionStateIntegrityError("schedule-mismatch");
  }
  return {
    state,
    schedules: plainValue(schedules) as ScheduleQueue<WorldScheduledPayload>,
    randomState: value.randomState,
  };
}

/** One scheduled occurrence that left the queue. */
export interface ScheduleOccurrence {
  readonly scheduleId: string;
  readonly idempotencyKey: string;
}

/**
 * The schedule mutations that turn the stored queue into the kernel's new queue: occurrences that
 * left it or changed are `done`, new or changed occurrences are `put`. Applying `done` before `put`
 * keeps one pending entry per ID and ordering tuple at every step.
 */
export interface ScheduleChanges {
  readonly done: readonly ScheduleOccurrence[];
  readonly put: readonly EncodedScheduleItem[];
}

export function scheduleChanges(
  before: readonly EncodedScheduleItem[],
  after: readonly EncodedScheduleItem[],
): ScheduleChanges {
  const key = (item: ScheduleOccurrence) => `${item.scheduleId}\u0000${item.idempotencyKey}`;
  const previous = new Map(before.map((item) => [key(item), item.itemHash]));
  const next = new Map(after.map((item) => [key(item), item.itemHash]));
  return {
    done: before
      .filter((item) => next.get(key(item)) !== item.itemHash)
      .map(({ scheduleId, idempotencyKey }) => ({ scheduleId, idempotencyKey })),
    put: after.filter((item) => previous.get(key(item)) !== item.itemHash),
  };
}
