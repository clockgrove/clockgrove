import type { AttributionEnvelope, CommandEnvelope, CommandId } from "@clockgrove/contracts";
import { decodeOpaqueId } from "@clockgrove/contracts";
import type { WorldContinuation } from "@clockgrove/kernel";
import { canonicalBytes, sha256Hex } from "@clockgrove/kernel";

import { TRUSTED_ID_PREFIX } from "./authority-decision.js";
import type { CanonicalNode } from "./canonical-node.js";
import { CanonicalNodeError, decodeCanonicalNode, encodeCanonicalNode } from "./canonical-node.js";
import { PartitionStateIntegrityError, plainValue } from "./partition-state.js";

const CONTINUATION_KIND = "clockgrove.world-continuation";
const CONTINUATION_VERSION = 1;

/**
 * The open continuation of an incomplete kernel result. The kernel binds a continuation to the
 * command and attribution of the call that stopped, so the record keeps both: each chunk calls the
 * kernel with the origin command and its kernel attribution, and journals under its own trusted ID.
 */
export interface WorldContinuationRecord {
  /** The command whose kernel call stopped (a client command or a trusted advance). */
  readonly originCommand: CommandEnvelope<string, unknown>;
  /** The kernel attribution of the origin call, sealed with the origin's decision. */
  readonly attribution: AttributionEnvelope;
  /** The number of the next chunk, from 1. */
  readonly chunk: number;
  readonly continuation: WorldContinuation;
}

/** A continuation as stored on the partition state, keyed by the trusted ID of its next chunk. */
export interface EncodedWorldContinuation {
  readonly commandId: CommandId;
  readonly document: CanonicalNode;
  /** Lowercase hex SHA-256 of the canonical bytes of the record. */
  readonly documentHash: string;
}

/** The trusted command ID of chunk `chunk` of the origin command. A retry derives the same ID. */
export function continuationCommandId(originCommandId: string, chunk: number): CommandId {
  return decodeOpaqueId(`${continuationIdPrefix(originCommandId)}${chunk}`, "CommandId");
}

/** The origin's chunk IDs are this prefix and the chunk number, from 1 without gaps. */
export function continuationIdPrefix(originCommandId: string): string {
  return `${TRUSTED_ID_PREFIX}continue:${originCommandId}:`;
}

export function encodeWorldContinuation(record: WorldContinuationRecord): EncodedWorldContinuation {
  const value = { kind: CONTINUATION_KIND, version: CONTINUATION_VERSION, ...record };
  return {
    commandId: continuationCommandId(record.originCommand.commandId, record.chunk),
    document: encodeCanonicalNode(value),
    documentHash: sha256Hex(canonicalBytes(value)),
  };
}

/** Decodes a stored continuation and verifies its hash and next-chunk ID. */
export function decodeWorldContinuation(stored: EncodedWorldContinuation): WorldContinuationRecord {
  let value: unknown;
  try {
    value = plainValue(decodeCanonicalNode(stored.document));
  } catch (error) {
    if (error instanceof CanonicalNodeError)
      throw new PartitionStateIntegrityError("malformed-document");
    throw error;
  }
  if (sha256Hex(canonicalBytes(value)) !== stored.documentHash) {
    throw new PartitionStateIntegrityError("document-hash-mismatch");
  }
  const record = value as Partial<WorldContinuationRecord> & { kind?: unknown; version?: unknown };
  if (
    record.kind !== CONTINUATION_KIND ||
    record.version !== CONTINUATION_VERSION ||
    typeof record.originCommand !== "object" ||
    typeof record.attribution !== "object" ||
    typeof record.continuation !== "object" ||
    typeof record.chunk !== "number" ||
    continuationCommandId(String(record.originCommand?.commandId), record.chunk) !==
      stored.commandId
  ) {
    throw new PartitionStateIntegrityError("malformed-document");
  }
  const { originCommand, attribution, chunk, continuation } = record as WorldContinuationRecord;
  return { originCommand, attribution, chunk, continuation };
}
