import type { ArtifactId, PrivacyClass, StreamId } from "@clockgrove/contracts";
import {
  CANONICAL_ENCODING_VERSION,
  canonicalBytes,
  canonicalSerialize,
  RANDOM_CONTRACT_VERSION,
  sha256Hex,
  worldRegistryIdentity,
} from "@clockgrove/kernel";

import type { ArtifactScope, ArtifactStore } from "./artifacts.js";
import { CanonicalNodeError, decodeCanonicalNode } from "./canonical-node.js";
import { type RuntimeMetrics, recordMetric } from "./metrics.js";
import type {
  EncodedPartitionState,
  PartitionStateDocument,
  PartitionStateIntegrityReason,
} from "./partition-state.js";
import {
  decodePartitionState,
  PARTITION_STATE_DOCUMENT_VERSION,
  PartitionStateIntegrityError,
  plainValue,
} from "./partition-state.js";
import type { RuntimeAuthorizationContext } from "./persistence.js";
import type { WorldPartitionScope } from "./world-command.js";

export const PARTITION_SNAPSHOT_VERSION = 1;
/** Snapshot bytes are canonical JSON text. */
export const PARTITION_SNAPSHOT_MEDIA_TYPE = "application/json";
const SNAPSHOT_KIND = "clockgrove.partition-snapshot";

/**
 * What a snapshot depends on to be read as written. It is deploy-stable on purpose: no code hash, so a
 * deploy that changes none of these keeps every snapshot usable.
 */
export interface SnapshotCompatibility {
  readonly codec: 1;
  readonly documentVersion: number;
  readonly canonicalEncoding: string;
  readonly randomContract: string;
  /** Lowercase hex SHA-256 of the canonical bytes of `worldRegistryIdentity()`. */
  readonly kernelRegistryHash: string;
  /** The installed pack's content hash (rules, archetypes and policy). */
  readonly packContentHash: string;
}

/** The current compatibility set for snapshots of a world installed from this pack. */
export function snapshotCompatibility(packContentHash: string): SnapshotCompatibility {
  return {
    codec: PARTITION_SNAPSHOT_VERSION,
    documentVersion: PARTITION_STATE_DOCUMENT_VERSION,
    canonicalEncoding: CANONICAL_ENCODING_VERSION,
    randomContract: RANDOM_CONTRACT_VERSION,
    kernelRegistryHash: sha256Hex(canonicalBytes(worldRegistryIdentity())),
    packContentHash,
  };
}

/** One partition's stored projection at a committed head, as a snapshot artifact holds it. */
export interface PartitionSnapshotContent {
  readonly scope: ArtifactScope;
  readonly streamId: StreamId;
  /** The partition head the snapshot covers. */
  readonly coveredPartitionSequence: bigint;
  /** The sequence of the partition's route stream at that head. */
  readonly coveredStreamSequence: bigint;
  readonly compatibility: SnapshotCompatibility;
  readonly stored: EncodedPartitionState;
}

export type SnapshotIntegrityReason = "malformed" | "row-mismatch" | PartitionStateIntegrityReason;

/** A snapshot does not verify. It is a defect to report; callers choose full replay explicitly. */
export class SnapshotIntegrityError extends Error {
  constructor(
    readonly snapshotId: string,
    readonly reason: SnapshotIntegrityReason,
  ) {
    super(`snapshot failed verification: ${reason}`);
    this.name = "SnapshotIntegrityError";
  }
}

/** A verified snapshot was written under a different compatibility set than the current one. */
export class SnapshotIncompatibleError extends Error {
  constructor(
    readonly snapshotId: string,
    readonly field: keyof SnapshotCompatibility,
  ) {
    super(`snapshot is incompatible: ${field}`);
    this.name = "SnapshotIncompatibleError";
  }
}

/** Format v1: the canonical bytes of the snapshot record. */
export function encodePartitionSnapshot(content: PartitionSnapshotContent): Uint8Array {
  return canonicalBytes({ kind: SNAPSHOT_KIND, version: PARTITION_SNAPSHOT_VERSION, ...content });
}

type FieldType = "string" | "number" | "bigint" | "record" | "array";

function typeOf(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value === "object" ? "record" : typeof value;
}

/** Exactly these fields, of these types. */
function hasShape(
  value: unknown,
  fields: Readonly<Record<string, FieldType>>,
): value is Record<string, unknown> {
  if (typeOf(value) !== "record") return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).every((key) => Object.hasOwn(fields, key)) &&
    Object.entries(fields).every(([key, type]) => typeOf(record[key]) === type)
  );
}

const CONTENT = {
  kind: "string",
  version: "number",
  scope: "record",
  streamId: "string",
  coveredPartitionSequence: "bigint",
  coveredStreamSequence: "bigint",
  compatibility: "record",
  stored: "record",
} as const;
const SCOPE = {
  tenantId: "string",
  worldId: "string",
  timelineId: "string",
  partitionId: "string",
  spaceId: "string",
} as const;
const COMPATIBILITY = {
  codec: "number",
  documentVersion: "number",
  canonicalEncoding: "string",
  randomContract: "string",
  kernelRegistryHash: "string",
  packContentHash: "string",
} as const;
const COMPATIBILITY_FIELDS = Object.keys(COMPATIBILITY) as (keyof SnapshotCompatibility)[];
const STORED = {
  revision: "bigint",
  simulationTime: "bigint",
  documentVersion: "number",
  document: "array",
  documentHash: "string",
  stateHash: "string",
  schedules: "array",
} as const;

/** The snapshot record in canonical bytes, or `undefined` when the bytes are not format v1. */
function parseContent(bytes: Uint8Array): PartitionSnapshotContent | undefined {
  let value: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const wrapper: unknown = JSON.parse(text);
    if (
      !Array.isArray(wrapper) ||
      wrapper.length !== 2 ||
      wrapper[0] !== CANONICAL_ENCODING_VERSION
    )
      return undefined;
    value = plainValue(decodeCanonicalNode(wrapper[1]));
    if (canonicalSerialize(value) !== text) return undefined;
  } catch (error) {
    if (
      error instanceof TypeError ||
      error instanceof SyntaxError ||
      error instanceof CanonicalNodeError
    )
      return undefined;
    throw error;
  }
  if (
    !hasShape(value, CONTENT) ||
    value.kind !== SNAPSHOT_KIND ||
    value.version !== PARTITION_SNAPSHOT_VERSION ||
    !hasShape(value.scope, SCOPE) ||
    !hasShape(value.compatibility, COMPATIBILITY) ||
    !hasShape(value.stored, STORED) ||
    !(value.stored.schedules as unknown[]).every((row) => typeOf(row) === "record")
  ) {
    return undefined;
  }
  const { kind: _kind, version: _version, ...content } = value;
  const covered = content as unknown as PartitionSnapshotContent;
  if (
    covered.coveredStreamSequence < 0n ||
    covered.coveredStreamSequence > covered.coveredPartitionSequence
  )
    return undefined;
  return covered;
}

/**
 * Decodes snapshot bytes and verifies them: format v1 in canonical form, then every hash of the stored
 * document (`decodePartitionState`). Compatibility is checked separately, against the current set.
 */
export function decodePartitionSnapshot(
  snapshotId: string,
  bytes: Uint8Array,
): { readonly content: PartitionSnapshotContent; readonly document: PartitionStateDocument } {
  const content = parseContent(bytes);
  if (content === undefined) throw new SnapshotIntegrityError(snapshotId, "malformed");
  try {
    return { content, document: decodePartitionState(content.stored) };
  } catch (error) {
    if (error instanceof PartitionStateIntegrityError)
      throw new SnapshotIntegrityError(snapshotId, error.reason);
    throw error;
  }
}

/** Whether a snapshot written under `recorded` can be restored under `current`. */
export function isSnapshotCompatible(
  recorded: SnapshotCompatibility,
  current: SnapshotCompatibility,
): boolean {
  return COMPATIBILITY_FIELDS.every((key) => recorded[key] === current[key]);
}

/** Throws `SnapshotIncompatibleError` for the first field where `recorded` differs from `current`. */
export function requireSnapshotCompatibility(
  snapshotId: string,
  recorded: SnapshotCompatibility,
  current: SnapshotCompatibility,
): void {
  const field = COMPATIBILITY_FIELDS.find((key) => recorded[key] !== current[key]);
  if (field !== undefined) throw new SnapshotIncompatibleError(snapshotId, field);
}

/** The `snapshots` row that indexes one snapshot artifact. */
export interface SnapshotRef {
  readonly snapshotId: string;
  readonly scope: ArtifactScope;
  readonly streamId: StreamId;
  readonly coveredPartitionSequence: bigint;
  readonly coveredStreamSequence: bigint;
  readonly stateHash: string;
  readonly artifactId: ArtifactId;
  readonly privacyClass: PrivacyClass;
  readonly compatibility: SnapshotCompatibility;
}

/** One partition's stored projection, read in one repeatable-read transaction. */
export interface CommittedPartitionState {
  readonly scope: ArtifactScope;
  readonly streamId: StreamId;
  readonly coveredPartitionSequence: bigint;
  readonly coveredStreamSequence: bigint;
  /** The installed pack's content hash. */
  readonly packContentHash: string;
  readonly stored: EncodedPartitionState;
  readonly continuationOpen: boolean;
}

export interface PartitionSnapshotStore {
  /** The committed projection, or `undefined` when the partition has none the principal can read. */
  readCommitted(
    authorization: RuntimeAuthorizationContext,
    scope: WorldPartitionScope,
  ): Promise<CommittedPartitionState | undefined>;
  /** Appends the row; an equal existing row is returned, any other is `SnapshotConflictError`. */
  record(authorization: RuntimeAuthorizationContext, ref: SnapshotRef): Promise<SnapshotRef>;
  /** The readable snapshots of the partition, by covered head ascending, up to `through` when given. */
  list(
    authorization: RuntimeAuthorizationContext,
    scope: WorldPartitionScope,
    through?: bigint,
  ): Promise<readonly SnapshotRef[]>;
}

export interface PartitionSnapshotPorts {
  readonly snapshots: PartitionSnapshotStore;
  readonly artifacts: ArtifactStore;
  /** Receives `snapshot_bytes` and `snapshot_create_ms` once per created snapshot. */
  readonly metrics?: RuntimeMetrics;
}

/** A continuation is open, so the partition head is not a resumable state; retry later. */
export class SnapshotNotQuiescentError extends Error {
  constructor(readonly partitionId: string) {
    super("partition has an open continuation");
    this.name = "SnapshotNotQuiescentError";
  }
}

/** A snapshot row with this ID or covered head exists and differs, or is not readable. */
export class SnapshotConflictError extends Error {
  constructor(readonly snapshotId: string) {
    super("snapshot conflicts with a stored snapshot");
    this.name = "SnapshotConflictError";
  }
}

/** Derived from the covered head, so creation at one head is idempotent. */
export function partitionSnapshotId(scope: WorldPartitionScope, covered: bigint): string {
  return `snapshot:${encodeURIComponent(scope.timelineId)}:${encodeURIComponent(scope.partitionId)}:${covered}`;
}

/**
 * Snapshots the committed head of a partition: reads it (or takes the read a caller already verified,
 * so the snapshot covers exactly that head), verifies it, stores it as one public artifact and appends
 * its row. Never inside a journal transaction, and never writes canonical state. A crash between the
 * artifact and the row is repaired by a retry, which reuses both derived IDs.
 */
export async function createPartitionSnapshot(
  authorization: RuntimeAuthorizationContext,
  scope: WorldPartitionScope,
  ports: PartitionSnapshotPorts,
  read?: CommittedPartitionState,
): Promise<SnapshotRef> {
  // Workers clocks advance only across I/O: the duration spans the artifact put and the row write.
  const started = Date.now();
  const committed = read ?? (await ports.snapshots.readCommitted(authorization, scope));
  if (committed === undefined) throw new RangeError("the partition has no committed state");
  if (committed.continuationOpen) throw new SnapshotNotQuiescentError(scope.partitionId);
  const { packContentHash: _pack, continuationOpen: _open, ...covered } = committed;
  const snapshotId = partitionSnapshotId(scope, committed.coveredPartitionSequence);
  const compatibility = snapshotCompatibility(committed.packContentHash);
  const bytes = encodePartitionSnapshot({ ...covered, compatibility });
  // Verify before storing: a torn or corrupt read is never snapshotted.
  decodePartitionSnapshot(snapshotId, bytes);
  // The artifact ID also names the compatibility: after a registry change (migration 0029) the same
  // head encodes differently, and the old artifact at that head stays (artifacts are append-only).
  // Decision: 16 hex digits (64 bits); only a few compatibility sets ever meet at one head.
  const compatible = sha256Hex(canonicalBytes(compatibility)).slice(0, 16);
  const artifact = await ports.artifacts.put(authorization, {
    ...committed.scope,
    artifactId: `${snapshotId}:artifact:${compatible}` as ArtifactId,
    bytes,
    mediaType: PARTITION_SNAPSHOT_MEDIA_TYPE,
    privacyClass: "public_scene",
    retentionClass: "durable",
  });
  const ref = await ports.snapshots.record(authorization, {
    snapshotId,
    scope: committed.scope,
    streamId: committed.streamId,
    coveredPartitionSequence: committed.coveredPartitionSequence,
    coveredStreamSequence: committed.coveredStreamSequence,
    stateHash: committed.stored.stateHash,
    artifactId: artifact.artifactId,
    privacyClass: artifact.privacyClass,
    compatibility,
  });
  const point = { tenantId: scope.tenantId, worldId: scope.worldId, label: "written" } as const;
  recordMetric(ports.metrics, {
    ...point,
    name: "snapshot_bytes",
    value: bytes.byteLength,
    count: Number(committed.coveredPartitionSequence),
  });
  recordMetric(ports.metrics, {
    ...point,
    name: "snapshot_create_ms",
    value: Date.now() - started,
  });
  return ref;
}

/** The fields a row and its content must agree on, in canonical form. */
function rowView(ref: Omit<SnapshotRef, "snapshotId" | "artifactId" | "privacyClass">): string {
  const {
    scope,
    streamId,
    coveredPartitionSequence,
    coveredStreamSequence,
    stateHash,
    compatibility,
  } = ref;
  return canonicalSerialize({
    scope,
    streamId,
    coveredPartitionSequence,
    coveredStreamSequence,
    stateHash,
    compatibility,
  });
}

/**
 * Restores a snapshot, verified in order: the artifact's length and hash (`get`), the format and every
 * document hash (decode), the row against the content, then compatibility with the current pack. On any
 * failure nothing is returned and no other snapshot is tried; callers choose full replay explicitly.
 * The document is returned only; it never replaces the live projection.
 */
export async function loadPartitionSnapshot(
  authorization: RuntimeAuthorizationContext,
  ref: SnapshotRef,
  packContentHash: string,
  ports: Pick<PartitionSnapshotPorts, "artifacts">,
): Promise<{ readonly ref: SnapshotRef; readonly document: PartitionStateDocument }> {
  const { bytes } = await ports.artifacts.get(authorization, {
    ...ref.scope,
    artifactId: ref.artifactId,
  });
  const { content, document } = decodePartitionSnapshot(ref.snapshotId, bytes);
  if (rowView(ref) !== rowView({ ...content, stateHash: content.stored.stateHash })) {
    throw new SnapshotIntegrityError(ref.snapshotId, "row-mismatch");
  }
  requireSnapshotCompatibility(
    ref.snapshotId,
    ref.compatibility,
    snapshotCompatibility(packContentHash),
  );
  return { ref, document };
}
