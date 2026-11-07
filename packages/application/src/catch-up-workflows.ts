import {
  ContractDecodeError,
  decodeOpaqueId,
  type RunId,
  type SpaceId,
  type TenantId,
  type TimelineId,
  type WorldId,
} from "@clockgrove/contracts";
import type { RuntimeAuthorizationScope } from "./authentication.js";
import { lifecycleRecord } from "./lifecycle-workflows.js";
import type { RuntimeAuthorizationContext } from "./persistence.js";

/** Strict reference to an accepted operation, never physical state or caller authority. */
export interface CatchUpWorkflowEnvelope {
  readonly version: 1;
  readonly tenantId: TenantId;
  readonly worldId: WorldId;
  readonly timelineId: TimelineId;
  readonly spaceId: SpaceId;
  readonly applicationRunId: RunId;
}

/** Project an accepted operation to the only fields allowed across the Workflow boundary. */
export function catchUpWorkflowReference(
  operation: CatchUpWorkflowEnvelope,
): CatchUpWorkflowEnvelope {
  return {
    version: 1,
    tenantId: operation.tenantId,
    worldId: operation.worldId,
    timelineId: operation.timelineId,
    spaceId: operation.spaceId,
    applicationRunId: operation.applicationRunId,
  };
}

export function decodeCatchUpWorkflowEnvelope(value: unknown): CatchUpWorkflowEnvelope {
  const input = lifecycleRecord(value, "catchUpWorkflow");
  const fields = ["version", "tenantId", "worldId", "timelineId", "spaceId", "applicationRunId"];
  if (
    input.version !== 1 ||
    Object.keys(input).length !== fields.length ||
    Object.keys(input).some((key) => !fields.includes(key))
  ) {
    throw new ContractDecodeError("catchUpWorkflow", "expected exact version-1 reference");
  }
  return {
    version: 1,
    tenantId: decodeOpaqueId(input.tenantId, "TenantId"),
    worldId: decodeOpaqueId(input.worldId, "WorldId"),
    timelineId: decodeOpaqueId(input.timelineId, "TimelineId"),
    spaceId: decodeOpaqueId(input.spaceId, "SpaceId"),
    applicationRunId: decodeOpaqueId(input.applicationRunId, "RunId"),
  };
}

export interface CatchUpWorkflowOperation extends CatchUpWorkflowEnvelope {
  readonly ownerGeneration: bigint;
  readonly policyVersion: bigint;
  readonly wallTime: bigint;
  readonly step: bigint;
}

export interface CatchUpWorkflowStore {
  register(
    authorization: RuntimeAuthorizationContext,
    scope: RuntimeAuthorizationScope,
    activation: Readonly<{
      ownerGeneration: bigint;
      policyVersion: bigint;
      wallTime: bigint;
      applicationRunId?: RunId;
    }>,
  ): Promise<CatchUpWorkflowOperation | undefined>;
  current(
    authorization: RuntimeAuthorizationContext,
    scope: RuntimeAuthorizationScope,
  ): Promise<CatchUpWorkflowOperation | undefined>;
  read(envelope: CatchUpWorkflowEnvelope): Promise<CatchUpWorkflowOperation | undefined>;
  advance(
    authorization: RuntimeAuthorizationContext,
    envelope: CatchUpWorkflowEnvelope,
    activation: Readonly<{
      ownerGeneration: bigint;
      policyVersion: bigint;
      step: bigint;
      complete: boolean;
    }>,
  ): Promise<boolean>;
  openCases(limit: number): Promise<readonly CatchUpWorkflowEnvelope[]>;
}
