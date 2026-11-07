import {
  ContractDecodeError,
  exactKeys,
  freeze,
  nonNegativeInteger,
  record,
  string,
} from "./validation.js";

declare const opaqueIdBrand: unique symbol;

export type OpaqueId<Name extends string> = string & {
  readonly [opaqueIdBrand]: Name;
};

export type TenantId = OpaqueId<"TenantId">;
export type WorkspaceId = OpaqueId<"WorkspaceId">;
export type PrincipalId = OpaqueId<"PrincipalId">;
export type ExternalIdentityId = OpaqueId<"ExternalIdentityId">;
export type WorkspaceMembershipId = OpaqueId<"WorkspaceMembershipId">;
export type WorldMembershipId = OpaqueId<"WorldMembershipId">;
export type WorldPersonaId = OpaqueId<"WorldPersonaId">;
export type AuthorityDecisionId = OpaqueId<"AuthorityDecisionId">;
export type ActionId = OpaqueId<"ActionId">;
export type WorldId = OpaqueId<"WorldId">;
export type TimelineId = OpaqueId<"TimelineId">;
export type PartitionId = OpaqueId<"PartitionId">;
export type SpatialFrameId = OpaqueId<"SpatialFrameId">;
export type SpatialIndexEpochId = OpaqueId<"SpatialIndexEpochId">;
export type SpatialIndexCellId = OpaqueId<"SpatialIndexCellId">;
export type RuntimeCellId = OpaqueId<"RuntimeCellId">;
export type SpaceId = OpaqueId<"SpaceId">;
export type ObjectId = OpaqueId<"ObjectId">;
export type WorldObjectId = ObjectId;
export type SubjectId = OpaqueId<"SubjectId">;
export type ActorProcessId = OpaqueId<"ActorProcessId">;
export type PresenceId = OpaqueId<"PresenceId">;
export type SessionId = OpaqueId<"SessionId">;
export type TurnId = OpaqueId<"TurnId">;
export type RunId = OpaqueId<"RunId">;
export type StepId = OpaqueId<"StepId">;
export type CommandId = OpaqueId<"CommandId">;
export type EventId = OpaqueId<"EventId">;
export type StreamId = OpaqueId<"StreamId">;
export type ScheduleId = OpaqueId<"ScheduleId">;
export type RuleId = OpaqueId<"RuleId">;
export type RuleFiringId = OpaqueId<"RuleFiringId">;
export type DecisionTraceId = OpaqueId<"DecisionTraceId">;
export type PerceptionId = OpaqueId<"PerceptionId">;
export type EpisodeId = OpaqueId<"EpisodeId">;
export type BeliefId = OpaqueId<"BeliefId">;
export type ClaimId = OpaqueId<"ClaimId">;
export type EvidenceId = OpaqueId<"EvidenceId">;
export type CapabilityId = OpaqueId<"CapabilityId">;
export type InstallationId = OpaqueId<"InstallationId">;
export type BindingId = OpaqueId<"BindingId">;
export type ToolCallId = OpaqueId<"ToolCallId">;
export type ModelCallId = OpaqueId<"ModelCallId">;
export type ArtifactId = OpaqueId<"ArtifactId">;
export type ChangesetId = OpaqueId<"ChangesetId">;
export type ChangeSetId = ChangesetId;
export type TransferId = OpaqueId<"TransferId">;
export type CorrelationId = OpaqueId<"CorrelationId">;
export type CausationId = OpaqueId<"CausationId">;
export type EffectId = OpaqueId<"EffectId">;
export type RoleId = OpaqueId<"RoleId">;
export type GrantRef = OpaqueId<"GrantRef">;

export type AnyClockgroveId = OpaqueId<string>;

export function decodeOpaqueId<Name extends string>(
  value: unknown,
  name: Name,
  path: string = name,
): OpaqueId<Name> {
  const decoded = string(value, path);
  if (decoded.trim() !== decoded)
    throw new ContractDecodeError(path, "ID must not have outer whitespace");
  return decoded as OpaqueId<Name>;
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function decodeExternallyInitiatedId<Name extends string>(
  value: unknown,
  name: Name,
  path: string = name,
): OpaqueId<Name> {
  const decoded = decodeOpaqueId(value, name, path);
  if (!UUID_V7.test(decoded)) throw new ContractDecodeError(path, "expected a UUIDv7");
  return decoded;
}

export interface DeterministicIdSeed {
  readonly commandId: CommandId;
  readonly eventIndex: number;
  readonly randomStream: string;
}

export interface DeterministicIdSource {
  readonly seed: DeterministicIdSeed;
  next<Name extends string>(name: Name): OpaqueId<Name>;
}

export type IdSource = DeterministicIdSource;

export function decodeDeterministicIdSeed(
  value: unknown,
  path = "deterministicIdSeed",
): DeterministicIdSeed {
  const input = record(value, path);
  exactKeys(input, ["commandId", "eventIndex", "randomStream"], [], path);
  return freeze({
    commandId: decodeOpaqueId(input.commandId, "CommandId", `${path}.commandId`),
    eventIndex: nonNegativeInteger(input.eventIndex, `${path}.eventIndex`),
    randomStream: string(input.randomStream, `${path}.randomStream`),
  });
}
