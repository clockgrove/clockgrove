import type { ActionId, CausationId, CommandId, EventId, PartitionId } from "./ids.js";
import { decodeOpaqueId } from "./ids.js";
import type { EventEnvelope, QueueEnvelope, SimTimeMs } from "./protocol.js";
import { decodeEventEnvelope, type EventDecodeOptions } from "./protocol.js";
import {
  array,
  bigintValue,
  ContractDecodeError,
  exactKeys,
  freeze,
  record,
  string,
} from "./validation.js";

export class CommandIdempotencyInvariantError extends Error {
  readonly commandId: CommandId;

  constructor(commandId: CommandId) {
    super(`command ${commandId} was reused with different bytes`);
    this.name = "CommandIdempotencyInvariantError";
    this.commandId = commandId;
  }
}

export type CommandIdempotencyDecision<TResult> =
  | Readonly<{ kind: "execute" }>
  | Readonly<{ kind: "stored"; result: TResult }>;

export interface StoredCommandResult<TResult> {
  readonly commandId: CommandId;
  readonly commandBytes: Uint8Array;
  readonly result: TResult;
}

export function evaluateCommandIdempotency<TResult>(
  commandId: CommandId,
  commandBytes: Uint8Array,
  stored?: StoredCommandResult<TResult>,
): CommandIdempotencyDecision<TResult> {
  if (stored === undefined) return freeze({ kind: "execute" });
  if (stored.commandId !== commandId || !equalBytes(stored.commandBytes, commandBytes)) {
    throw new CommandIdempotencyInvariantError(commandId);
  }
  return freeze({ kind: "stored", result: stored.result });
}

export interface StreamOrderPoint {
  readonly streamId: import("./ids.js").StreamId;
  readonly streamSequence: bigint;
}

export interface PartitionOrderPoint {
  readonly partitionId: PartitionId;
  readonly partitionSequence: bigint;
}

export interface JournalOrderPoint {
  readonly journalPosition: bigint;
}

export interface SimulationOrderPoint {
  readonly simulationTime: SimTimeMs;
  readonly tieBreakKey: string;
}

export interface ExplicitCausalLink {
  readonly eventId: EventId;
  readonly causationId: CausationId;
}

export interface PartitionHead {
  readonly partitionId: PartitionId;
  readonly partitionSequence: bigint;
}

export interface PartitionHeadVector {
  readonly version: 1;
  readonly heads: readonly PartitionHead[];
}

export function compareStreamOrder(left: StreamOrderPoint, right: StreamOrderPoint): number {
  if (left.streamId !== right.streamId) {
    throw new ContractDecodeError("streamOrder", "cannot compare different streams");
  }
  return compareBigint(left.streamSequence, right.streamSequence);
}

export function comparePartitionOrder(
  left: PartitionOrderPoint,
  right: PartitionOrderPoint,
): number {
  if (left.partitionId !== right.partitionId) {
    throw new ContractDecodeError("partitionOrder", "cannot compare different partitions");
  }
  return compareBigint(left.partitionSequence, right.partitionSequence);
}

export function compareJournalIngestionOrder(
  left: JournalOrderPoint,
  right: JournalOrderPoint,
): number {
  return compareBigint(left.journalPosition, right.journalPosition);
}

export function compareSimulationOrder(
  left: SimulationOrderPoint,
  right: SimulationOrderPoint,
): number {
  const time = compareBigint(left.simulationTime, right.simulationTime);
  if (time !== 0) return time;
  return left.tieBreakKey < right.tieBreakKey ? -1 : left.tieBreakKey > right.tieBreakKey ? 1 : 0;
}

export function hasExplicitCausality(cause: CausationId, effect: ExplicitCausalLink): boolean {
  return effect.causationId === cause;
}

export function decodePartitionHeadVector(
  value: unknown,
  path = "partitionHeadVector",
): PartitionHeadVector {
  const input = record(value, path);
  exactKeys(input, ["version", "heads"], [], path);
  if (input.version !== 1) throw new ContractDecodeError(`${path}.version`, "unsupported version");
  const heads = array(input.heads, `${path}.heads`, (item, itemPath) => {
    const head = record(item, itemPath);
    exactKeys(head, ["partitionId", "partitionSequence"], [], itemPath);
    return freeze({
      partitionId: decodeOpaqueId(head.partitionId, "PartitionId", `${itemPath}.partitionId`),
      partitionSequence: bigintValue(head.partitionSequence, `${itemPath}.partitionSequence`),
    });
  });
  if (new Set(heads.map((head) => head.partitionId)).size !== heads.length) {
    throw new ContractDecodeError(`${path}.heads`, "duplicate partition head");
  }
  return freeze({ version: 1, heads });
}

export function queueSemanticDeduplicationKey<T>(
  _message: QueueEnvelope<T>,
  semanticActionId: ActionId,
): ActionId {
  return semanticActionId;
}

export function upcastEventBytes(
  bytes: Uint8Array | string,
  options: EventDecodeOptions = {},
): EventEnvelope<string, unknown> {
  const text =
    typeof bytes === "string" ? bytes : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ContractDecodeError("eventBytes", `invalid JSON: ${errorMessage(error)}`);
  }
  const input = record(parsed, "event");
  if (input.schemaVersion === 1) return upcastVersion1(input, options);
  if (input.schemaVersion === 2) return decodeEventEnvelope(input, (payload) => payload, options);
  throw new ContractDecodeError("event.schemaVersion", "unsupported schema version");
}

function upcastVersion1(
  input: Record<string, unknown>,
  options: EventDecodeOptions,
): EventEnvelope<string, unknown> {
  exactKeys(
    input,
    [
      "schemaVersion",
      "eventId",
      "type",
      "tenantId",
      "worldId",
      "timelineId",
      "partitionId",
      "streamId",
      "streamSequence",
      "partitionSequence",
      "journalPosition",
      "simulationTime",
      "recordedAt",
      "commandId",
      "correlationId",
      "attribution",
      "policyVersion",
      "privacyClass",
      "payloadHash",
      "payload",
    ],
    ["causationId", "actor", "principalId", "decisionTraceId", "ruleFiringId"],
    "event",
  );
  const { policyVersion, ...rest } = input;
  return decodeEventEnvelope(
    {
      ...rest,
      schemaVersion: 2,
      policyVersions: { default: string(policyVersion, "event.policyVersion") },
    },
    (payload) => payload,
    options,
  );
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function compareBigint(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown parse error";
}
