import type { ActorAddress, ActorTargetBinding } from "./actor-address.js";
import { decodeActorAddress } from "./actor-address.js";
import type { ExecutionContextRef } from "./execution-context.js";
import { decodeExecutionContextRef } from "./execution-context.js";
import type {
  ActionId,
  AuthorityDecisionId,
  CausationId,
  CommandId,
  CorrelationId,
  DecisionTraceId,
  EffectId,
  EventId,
  PartitionId,
  PrincipalId,
  RuleFiringId,
  SessionId,
  StreamId,
  TenantId,
  TimelineId,
  WorldId,
  WorldMembershipId,
  WorldPersonaId,
} from "./ids.js";
import { decodeOpaqueId } from "./ids.js";
import { decodePrivacyCategory, type PrivacyClass } from "./privacy.js";
import {
  bigintValue,
  ContractDecodeError,
  exactKeys,
  freeze,
  integer,
  nonNegativeInteger,
  optional,
  record,
  string,
} from "./validation.js";

declare const simTimeBrand: unique symbol;
export type SimTimeMs = bigint & { readonly [simTimeBrand]: true };

export interface AttributionIntent {
  readonly principalId?: PrincipalId;
  readonly worldMembershipId?: WorldMembershipId;
  readonly personaId?: WorldPersonaId;
  readonly initiatorId?: string;
  readonly effectiveActorId: string;
  readonly causalRootActionId: ActionId;
  readonly immediateCauseId?: string;
  readonly sessionId?: SessionId;
}

export interface AttributionEnvelope extends AttributionIntent {
  readonly authorityDecisionId: AuthorityDecisionId;
}

export interface CommandEnvelope<TType extends string, TPayload> {
  readonly schemaVersion: number;
  readonly commandId: CommandId;
  readonly type: TType;
  readonly target: ActorAddress;
  readonly expected: Readonly<{
    streamSequence?: bigint;
    partitionRevision?: bigint;
    routingEpoch?: number;
  }>;
  readonly simulationTime?: SimTimeMs;
  readonly issuedAt: string;
  readonly context: ExecutionContextRef;
  readonly attribution: AttributionIntent;
  readonly payload: TPayload;
}

export type PolicyVersionSet = Readonly<Record<string, string>>;

export interface EventEnvelope<TType extends string, TPayload> {
  readonly schemaVersion: number;
  readonly eventId: EventId;
  readonly type: TType;
  readonly tenantId: TenantId;
  readonly worldId: WorldId;
  readonly timelineId: TimelineId;
  readonly partitionId: PartitionId;
  readonly streamId: StreamId;
  readonly streamSequence: bigint;
  readonly partitionSequence: bigint;
  readonly journalPosition: bigint;
  readonly simulationTime: SimTimeMs;
  readonly recordedAt: string;
  readonly commandId: CommandId;
  readonly correlationId: CorrelationId;
  readonly causationId?: CausationId;
  readonly attribution: AttributionEnvelope;
  readonly actor?: ActorAddress;
  readonly principalId?: PrincipalId;
  readonly decisionTraceId?: DecisionTraceId;
  readonly ruleFiringId?: RuleFiringId;
  readonly policyVersions: PolicyVersionSet;
  readonly privacyClass: PrivacyClass;
  readonly payloadHash: string;
  readonly payload: TPayload;
}

export const QUEUE_CHANNELS = [
  "world-reactions",
  "cognitive-indexing",
  "external-effects",
] as const;
export type QueueChannel = (typeof QUEUE_CHANNELS)[number];

export interface QueueEnvelope<T> {
  readonly schemaVersion: number;
  readonly messageId: string;
  readonly channel: QueueChannel;
  readonly tenantId: TenantId;
  readonly worldId?: WorldId;
  readonly timelineId?: TimelineId;
  readonly sourceEventId?: EventId;
  readonly effectId?: EffectId;
  readonly correlationId: CorrelationId;
  readonly causationId?: CausationId;
  readonly attemptHint: number;
  readonly availableAt?: string;
  readonly payload: T;
}

export function decodeAttributionIntent(value: unknown, path = "attribution"): AttributionIntent {
  const input = record(value, path);
  exactKeys(
    input,
    ["effectiveActorId", "causalRootActionId"],
    [
      "principalId",
      "worldMembershipId",
      "personaId",
      "initiatorId",
      "immediateCauseId",
      "sessionId",
    ],
    path,
  );
  return freeze({
    ...optionalId(input, "principalId", "PrincipalId", path),
    ...optionalId(input, "worldMembershipId", "WorldMembershipId", path),
    ...optionalId(input, "personaId", "WorldPersonaId", path),
    ...optionalString(input, "initiatorId", path),
    effectiveActorId: string(input.effectiveActorId, `${path}.effectiveActorId`),
    causalRootActionId: decodeOpaqueId(
      input.causalRootActionId,
      "ActionId",
      `${path}.causalRootActionId`,
    ),
    ...optionalString(input, "immediateCauseId", path),
    ...optionalId(input, "sessionId", "SessionId", path),
  });
}

export function sealAttribution(
  intent: AttributionIntent,
  authorityDecisionId: AuthorityDecisionId,
): AttributionEnvelope {
  const decodedIntent = decodeAttributionIntent(intent);
  const decision = decodeOpaqueId(
    authorityDecisionId,
    "AuthorityDecisionId",
    "authorityDecisionId",
  );
  return freeze({ ...decodedIntent, authorityDecisionId: decision });
}

export function decodeAttributionEnvelope(
  value: unknown,
  path = "attribution",
): AttributionEnvelope {
  const input = record(value, path);
  const { authorityDecisionId, ...intent } = input;
  if (!("authorityDecisionId" in input)) {
    throw new ContractDecodeError(`${path}.authorityDecisionId`, "missing field");
  }
  const allowed = [
    "principalId",
    "worldMembershipId",
    "personaId",
    "initiatorId",
    "effectiveActorId",
    "causalRootActionId",
    "immediateCauseId",
    "sessionId",
    "authorityDecisionId",
  ];
  exactKeys(
    input,
    ["effectiveActorId", "causalRootActionId", "authorityDecisionId"],
    allowed,
    path,
  );
  return sealAttribution(
    decodeAttributionIntent(intent, path),
    decodeOpaqueId(authorityDecisionId, "AuthorityDecisionId", `${path}.authorityDecisionId`),
  );
}

export function decodeCommandEnvelope<TType extends string, TPayload>(
  value: unknown,
  targetBinding: ActorTargetBinding,
  decodePayload: (payload: unknown, path: string) => TPayload,
  path = "command",
): CommandEnvelope<TType, TPayload> {
  const input = record(value, path);
  exactKeys(
    input,
    [
      "schemaVersion",
      "commandId",
      "type",
      "target",
      "expected",
      "issuedAt",
      "context",
      "attribution",
      "payload",
    ],
    ["simulationTime"],
    path,
  );
  const schemaVersion = supportedVersion(input.schemaVersion, [1, 2], `${path}.schemaVersion`);
  return freeze({
    schemaVersion,
    commandId: decodeOpaqueId(input.commandId, "CommandId", `${path}.commandId`),
    type: string(input.type, `${path}.type`) as TType,
    target: decodeActorAddress(input.target, targetBinding, `${path}.target`),
    expected: decodeExpected(input.expected, `${path}.expected`),
    ...optionalSimTime(input, "simulationTime", path),
    issuedAt: string(input.issuedAt, `${path}.issuedAt`),
    context: decodeExecutionContextRef(input.context, `${path}.context`),
    attribution: decodeAttributionIntent(input.attribution, `${path}.attribution`),
    payload: decodePayload(input.payload, `${path}.payload`),
  });
}

export interface EventDecodeOptions {
  readonly actorBinding?: ActorTargetBinding;
}

export function decodeEventEnvelope<TType extends string, TPayload>(
  value: unknown,
  decodePayload: (payload: unknown, path: string) => TPayload,
  options: EventDecodeOptions = {},
  path = "event",
): EventEnvelope<TType, TPayload> {
  const input = record(value, path);
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
      "policyVersions",
      "privacyClass",
      "payloadHash",
      "payload",
    ],
    ["causationId", "actor", "principalId", "decisionTraceId", "ruleFiringId"],
    path,
  );
  const schemaVersion = supportedVersion(input.schemaVersion, [2], `${path}.schemaVersion`);
  const tenantId = decodeOpaqueId(input.tenantId, "TenantId", `${path}.tenantId`);
  const worldId = decodeOpaqueId(input.worldId, "WorldId", `${path}.worldId`);
  const timelineId = decodeOpaqueId(input.timelineId, "TimelineId", `${path}.timelineId`);
  let actor: ActorAddress | undefined;
  if (input.actor !== undefined) {
    if (options.actorBinding === undefined) {
      throw new ContractDecodeError(`${path}.actor`, "actor scope binding is required");
    }
    actor = decodeActorAddress(input.actor, options.actorBinding, `${path}.actor`);
    if (
      actor.tenantId !== tenantId ||
      actor.worldId !== worldId ||
      actor.timelineId !== timelineId
    ) {
      throw new ContractDecodeError(`${path}.actor`, "actor scope does not match event scope");
    }
  }
  return freeze({
    schemaVersion,
    eventId: decodeOpaqueId(input.eventId, "EventId", `${path}.eventId`),
    type: string(input.type, `${path}.type`) as TType,
    tenantId,
    worldId,
    timelineId,
    partitionId: decodeOpaqueId(input.partitionId, "PartitionId", `${path}.partitionId`),
    streamId: decodeOpaqueId(input.streamId, "StreamId", `${path}.streamId`),
    streamSequence: bigintValue(input.streamSequence, `${path}.streamSequence`),
    partitionSequence: bigintValue(input.partitionSequence, `${path}.partitionSequence`),
    journalPosition: bigintValue(input.journalPosition, `${path}.journalPosition`),
    simulationTime: bigintValue(input.simulationTime, `${path}.simulationTime`) as SimTimeMs,
    recordedAt: string(input.recordedAt, `${path}.recordedAt`),
    commandId: decodeOpaqueId(input.commandId, "CommandId", `${path}.commandId`),
    correlationId: decodeOpaqueId(input.correlationId, "CorrelationId", `${path}.correlationId`),
    ...optionalId(input, "causationId", "CausationId", path),
    attribution: decodeAttributionEnvelope(input.attribution, `${path}.attribution`),
    ...(actor === undefined ? {} : { actor }),
    ...optionalId(input, "principalId", "PrincipalId", path),
    ...optionalId(input, "decisionTraceId", "DecisionTraceId", path),
    ...optionalId(input, "ruleFiringId", "RuleFiringId", path),
    policyVersions: decodePolicyVersions(input.policyVersions, `${path}.policyVersions`),
    privacyClass: decodePrivacyCategory(input.privacyClass, `${path}.privacyClass`),
    payloadHash: string(input.payloadHash, `${path}.payloadHash`),
    payload: decodePayload(input.payload, `${path}.payload`),
  });
}

export function decodeQueueEnvelope<T>(
  value: unknown,
  decodePayload: (payload: unknown, path: string) => T,
  path = "queue",
): QueueEnvelope<T> {
  const input = record(value, path);
  exactKeys(
    input,
    [
      "schemaVersion",
      "messageId",
      "channel",
      "tenantId",
      "correlationId",
      "attemptHint",
      "payload",
    ],
    ["worldId", "timelineId", "sourceEventId", "effectId", "causationId", "availableAt"],
    path,
  );
  const schemaVersion = supportedVersion(input.schemaVersion, [1, 2], `${path}.schemaVersion`);
  if (
    typeof input.channel !== "string" ||
    !(QUEUE_CHANNELS as readonly string[]).includes(input.channel)
  ) {
    throw new ContractDecodeError(`${path}.channel`, "unknown queue channel");
  }
  const worldId = optional(
    input,
    "worldId",
    (item, itemPath) => decodeOpaqueId(item, "WorldId", itemPath),
    path,
  );
  const timelineId = optional(
    input,
    "timelineId",
    (item, itemPath) => decodeOpaqueId(item, "TimelineId", itemPath),
    path,
  );
  if (timelineId !== undefined && worldId === undefined) {
    throw new ContractDecodeError(`${path}.worldId`, "required by timelineId");
  }
  return freeze({
    schemaVersion,
    messageId: string(input.messageId, `${path}.messageId`),
    channel: input.channel as QueueChannel,
    tenantId: decodeOpaqueId(input.tenantId, "TenantId", `${path}.tenantId`),
    ...(worldId === undefined ? {} : { worldId }),
    ...(timelineId === undefined ? {} : { timelineId }),
    ...optionalId(input, "sourceEventId", "EventId", path),
    ...optionalId(input, "effectId", "EffectId", path),
    correlationId: decodeOpaqueId(input.correlationId, "CorrelationId", `${path}.correlationId`),
    ...optionalId(input, "causationId", "CausationId", path),
    attemptHint: nonNegativeInteger(input.attemptHint, `${path}.attemptHint`),
    ...optionalString(input, "availableAt", path),
    payload: decodePayload(input.payload, `${path}.payload`),
  });
}

export function decodeExpected(
  value: unknown,
  path: string,
): CommandEnvelope<string, unknown>["expected"] {
  const input = record(value, path);
  exactKeys(input, [], ["streamSequence", "partitionRevision", "routingEpoch"], path);
  return freeze({
    ...optionalBigint(input, "streamSequence", path),
    ...optionalBigint(input, "partitionRevision", path),
    ...optionalNumber(input, "routingEpoch", path),
  });
}

function decodePolicyVersions(value: unknown, path: string): PolicyVersionSet {
  const input = record(value, path);
  const decoded: Record<string, string> = {};
  for (const [key, item] of Object.entries(input)) {
    if (key.length === 0) throw new ContractDecodeError(path, "empty policy version key");
    decoded[key] = string(item, `${path}.${key}`);
  }
  return freeze(decoded);
}

function supportedVersion(value: unknown, versions: readonly number[], path: string): number {
  const decoded = integer(value, path);
  if (!versions.includes(decoded))
    throw new ContractDecodeError(path, "unsupported schema version");
  return decoded;
}

function optionalId<Name extends string, Key extends string>(
  input: Record<string, unknown>,
  key: Key,
  name: Name,
  path: string,
): Partial<Record<Key, import("./ids.js").OpaqueId<Name>>> {
  const value = optional(
    input,
    key,
    (item, itemPath) => decodeOpaqueId(item, name, itemPath),
    path,
  );
  return value === undefined
    ? {}
    : ({ [key]: value } as Record<Key, import("./ids.js").OpaqueId<Name>>);
}

function optionalString<Key extends string>(
  input: Record<string, unknown>,
  key: Key,
  path: string,
): Partial<Record<Key, string>> {
  const value = optional(input, key, string, path);
  return value === undefined ? {} : ({ [key]: value } as Record<Key, string>);
}

function optionalBigint<Key extends string>(
  input: Record<string, unknown>,
  key: Key,
  path: string,
): Partial<Record<Key, bigint>> {
  const value = optional(input, key, bigintValue, path);
  return value === undefined ? {} : ({ [key]: value } as Record<Key, bigint>);
}

function optionalNumber<Key extends string>(
  input: Record<string, unknown>,
  key: Key,
  path: string,
): Partial<Record<Key, number>> {
  const value = optional(input, key, nonNegativeInteger, path);
  return value === undefined ? {} : ({ [key]: value } as Record<Key, number>);
}

function optionalSimTime<Key extends string>(
  input: Record<string, unknown>,
  key: Key,
  path: string,
): Partial<Record<Key, SimTimeMs>> {
  const value = optional(input, key, bigintValue, path);
  return value === undefined ? {} : ({ [key]: value as SimTimeMs } as Record<Key, SimTimeMs>);
}
