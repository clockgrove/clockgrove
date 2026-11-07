import {
  asTrustedExecutionContext,
  decodeExecutionContext,
  type ExecutionContext,
  type ExecutionContextRef,
  type TrustedExecutionContext,
} from "./execution-context.js";
import { isPrivacySubset } from "./privacy.js";
import { ContractDecodeError, freeze } from "./validation.js";

export function constructTrustedExecutionContext(value: unknown): TrustedExecutionContext {
  return asTrustedExecutionContext(decodeExecutionContext(value, "trustedExecutionContext"));
}

export function narrowTrustedExecutionContext(
  source: TrustedExecutionContext,
  candidate: unknown,
): TrustedExecutionContext {
  const target = decodeExecutionContext(candidate, "executionContextNarrowing");
  assertSame(target.tenantId, source.tenantId, "tenantId");
  assertSame(target.principalId, source.principalId, "principalId");
  assertSame(target.externalIdentityId, source.externalIdentityId, "externalIdentityId");
  assertSame(target.workspaceMembershipId, source.workspaceMembershipId, "workspaceMembershipId");
  assertSame(target.correlationId, source.correlationId, "correlationId");
  assertSame(target.causationId, source.causationId, "causationId");
  assertSame(target.requestId, source.requestId, "requestId");
  assertSame(target.codeVersion, source.codeVersion, "codeVersion");
  assertSame(target.protocolVersion, source.protocolVersion, "protocolVersion");

  for (const field of [
    "worldMembershipId",
    "personaId",
    "worldId",
    "timelineId",
    "spaceId",
    "sessionId",
    "subjectId",
  ] as const) {
    assertRemovedOrSame(target[field], source[field], field);
  }
  assertSubset(target.roles, source.roles, "roles");
  assertSubset(target.grants, source.grants, "grants");
  if (!isPrivacySubset(target.privacyCeiling, source.privacyCeiling)) {
    throw new ContractDecodeError(
      "executionContextNarrowing.privacyCeiling",
      "cannot broaden privacy authority",
    );
  }
  return asTrustedExecutionContext(target);
}

export function referenceTrustedExecutionContext(
  context: TrustedExecutionContext,
): ExecutionContextRef {
  return freeze({
    version: 1,
    correlationId: context.correlationId,
    requestId: context.requestId,
  });
}

function assertSubset<T>(candidate: readonly T[], source: readonly T[], field: string): void {
  const allowed = new Set(source);
  if (!candidate.every((item) => allowed.has(item))) {
    throw new ContractDecodeError(`executionContextNarrowing.${field}`, "cannot add authority");
  }
}

function assertRemovedOrSame<T>(
  candidate: T | undefined,
  source: T | undefined,
  field: string,
): void {
  if (candidate !== undefined && candidate !== source) {
    throw new ContractDecodeError(
      `executionContextNarrowing.${field}`,
      "cannot change or add scope",
    );
  }
}

function assertSame<T>(candidate: T, source: T, field: string): void {
  if (!sameValue(candidate, source)) {
    throw new ContractDecodeError(`executionContextNarrowing.${field}`, "immutable field changed");
  }
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) {
    return false;
  }
  return JSON.stringify(left) === JSON.stringify(right);
}

export type { ExecutionContext, ExecutionContextRef, TrustedExecutionContext };
