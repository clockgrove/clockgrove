import type {
  CausationId,
  CorrelationId,
  ExternalIdentityId,
  GrantRef,
  PrincipalId,
  RoleId,
  SessionId,
  SpaceId,
  SubjectId,
  TenantId,
  TimelineId,
  WorkspaceMembershipId,
  WorldId,
  WorldMembershipId,
  WorldPersonaId,
} from "./ids.js";
import { decodeOpaqueId } from "./ids.js";
import { decodePrivacyCeiling, type PrivacyCeiling } from "./privacy.js";
import {
  array,
  ContractDecodeError,
  exactKeys,
  freeze,
  literalVersion,
  nonNegativeInteger,
  optional,
  record,
  string,
} from "./validation.js";

export interface ExecutionContext {
  readonly version: 1;
  readonly tenantId: TenantId;
  readonly principalId: PrincipalId;
  readonly externalIdentityId?: ExternalIdentityId;
  readonly workspaceMembershipId?: WorkspaceMembershipId;
  readonly worldMembershipId?: WorldMembershipId;
  readonly personaId?: WorldPersonaId;
  readonly worldId?: WorldId;
  readonly timelineId?: TimelineId;
  readonly spaceId?: SpaceId;
  readonly sessionId?: SessionId;
  readonly subjectId?: SubjectId;
  readonly roles: readonly RoleId[];
  readonly grants: readonly GrantRef[];
  readonly privacyCeiling: PrivacyCeiling;
  readonly correlationId: CorrelationId;
  readonly causationId?: CausationId;
  readonly requestId: string;
  readonly codeVersion: string;
  readonly protocolVersion: number;
}

declare const trustedExecutionContextBrand: unique symbol;
export type TrustedExecutionContext = ExecutionContext & {
  readonly [trustedExecutionContextBrand]: true;
};

export interface ExecutionContextRef {
  readonly version: 1;
  readonly correlationId: CorrelationId;
  readonly requestId: string;
}

const requiredKeys = [
  "version",
  "tenantId",
  "principalId",
  "roles",
  "grants",
  "privacyCeiling",
  "correlationId",
  "requestId",
  "codeVersion",
  "protocolVersion",
] as const;

const optionalKeys = [
  "externalIdentityId",
  "workspaceMembershipId",
  "worldMembershipId",
  "personaId",
  "worldId",
  "timelineId",
  "spaceId",
  "sessionId",
  "subjectId",
  "causationId",
] as const;

export function decodeExecutionContext(
  value: unknown,
  path = "executionContext",
): ExecutionContext {
  const input = record(value, path);
  exactKeys(input, requiredKeys, optionalKeys, path);
  literalVersion(input.version, 1, `${path}.version`);
  const protocolVersion = nonNegativeInteger(input.protocolVersion, `${path}.protocolVersion`);
  if (protocolVersion !== 1) {
    throw new ContractDecodeError(`${path}.protocolVersion`, "unsupported protocol version");
  }

  const decoded: ExecutionContext = freeze({
    version: 1,
    tenantId: decodeOpaqueId(input.tenantId, "TenantId", `${path}.tenantId`),
    principalId: decodeOpaqueId(input.principalId, "PrincipalId", `${path}.principalId`),
    ...optionalId(input, "externalIdentityId", "ExternalIdentityId", path),
    ...optionalId(input, "workspaceMembershipId", "WorkspaceMembershipId", path),
    ...optionalId(input, "worldMembershipId", "WorldMembershipId", path),
    ...optionalId(input, "personaId", "WorldPersonaId", path),
    ...optionalId(input, "worldId", "WorldId", path),
    ...optionalId(input, "timelineId", "TimelineId", path),
    ...optionalId(input, "spaceId", "SpaceId", path),
    ...optionalId(input, "sessionId", "SessionId", path),
    ...optionalId(input, "subjectId", "SubjectId", path),
    roles: uniqueIds(input.roles, "RoleId", `${path}.roles`),
    grants: uniqueIds(input.grants, "GrantRef", `${path}.grants`),
    privacyCeiling: decodePrivacyCeiling(input.privacyCeiling, `${path}.privacyCeiling`),
    correlationId: decodeOpaqueId(input.correlationId, "CorrelationId", `${path}.correlationId`),
    ...optionalId(input, "causationId", "CausationId", path),
    requestId: string(input.requestId, `${path}.requestId`),
    codeVersion: string(input.codeVersion, `${path}.codeVersion`),
    protocolVersion,
  });
  assertScopeCombination(decoded, path);
  return decoded;
}

export function decodeExecutionContextRef(value: unknown, path = "context"): ExecutionContextRef {
  const input = record(value, path);
  exactKeys(input, ["version", "correlationId", "requestId"], [], path);
  literalVersion(input.version, 1, `${path}.version`);
  return freeze({
    version: 1,
    correlationId: decodeOpaqueId(input.correlationId, "CorrelationId", `${path}.correlationId`),
    requestId: string(input.requestId, `${path}.requestId`),
  });
}

export function asTrustedExecutionContext(context: ExecutionContext): TrustedExecutionContext {
  return context as TrustedExecutionContext;
}

function assertScopeCombination(context: ExecutionContext, path: string): void {
  const requiresWorld = [
    context.worldMembershipId,
    context.personaId,
    context.timelineId,
    context.spaceId,
    context.sessionId,
    context.subjectId,
  ];
  if (requiresWorld.some((value) => value !== undefined) && context.worldId === undefined) {
    throw new ContractDecodeError(`${path}.worldId`, "required by world-scoped fields");
  }
  if (
    [context.spaceId, context.sessionId, context.subjectId].some((value) => value !== undefined) &&
    context.timelineId === undefined
  ) {
    throw new ContractDecodeError(`${path}.timelineId`, "required by timeline-scoped fields");
  }
  if (context.personaId !== undefined && context.worldMembershipId === undefined) {
    throw new ContractDecodeError(`${path}.worldMembershipId`, "required by personaId");
  }
}

export function uniqueIds<Name extends string>(value: unknown, name: Name, path: string) {
  const ids = array(value, path, (item, itemPath) => decodeOpaqueId(item, name, itemPath));
  if (new Set(ids).size !== ids.length) throw new ContractDecodeError(path, "duplicate entry");
  return ids;
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
