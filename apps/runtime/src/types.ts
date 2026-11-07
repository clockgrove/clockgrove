import type {
  PartitionId,
  RuntimeCellId,
  RuntimeNoOpResponse,
  SpaceId,
  StreamId,
  SubjectId,
  TenantId,
  TimelineId,
  WorldId,
} from "@clockgrove/contracts";

declare const runtimeInstanceIdBrand: unique symbol;
export type RuntimeInstanceId = string & { readonly [runtimeInstanceIdBrand]: true };

/** Canonical placement contract from architecture section 4.3. */
export interface RuntimePlacement {
  readonly worldId: WorldId;
  readonly timelineId: TimelineId;
  readonly spaceId: SpaceId;
  readonly runtimeCellId: RuntimeCellId;
  readonly runtimeInstanceId: RuntimeInstanceId;
  readonly routingEpoch: bigint;
  readonly authorityEpoch: bigint;
  readonly fidelity: "hot" | "warm" | "dormant";
}

export interface RuntimeScope {
  readonly tenantId: TenantId;
  readonly worldId: WorldId;
  readonly timelineId: TimelineId;
  readonly spaceId: SpaceId;
}

export interface CanonicalRuntimeState extends RuntimeScope {
  readonly runtimeCellId: RuntimeCellId;
  readonly routingEpoch: bigint;
  readonly authorityEpoch: bigint;
  readonly projectionRevision: bigint;
  readonly partitionId: PartitionId;
  readonly primaryStreamId: StreamId;
  readonly fidelity: RuntimePlacement["fidelity"];
  readonly lifecycleStatus: "ready";
}

export interface RuntimeLocalState {
  readonly schemaVersion: 1;
  readonly owner: "world" | "space" | "actor-agent";
  readonly routeName: string;
  readonly placement: RuntimePlacement;
  readonly projectionRevision: bigint;
  readonly partitionId: PartitionId;
  readonly primaryStreamId: StreamId;
  readonly subjectId?: SubjectId;
}

export type RuntimeInitializationDisposition = "rehydrated" | "reconciled" | "unchanged";

export interface RuntimeInitializationResult {
  readonly disposition: RuntimeInitializationDisposition;
  readonly state: RuntimeLocalState;
}

export interface RuntimeEpochs {
  readonly routingEpoch: bigint;
  readonly authorityEpoch: bigint;
}

export type NoOpResponse = RuntimeNoOpResponse;

export class RuntimeRouteNotFoundError extends Error {
  constructor() {
    super("canonical ready runtime placement was not found");
    this.name = "RuntimeRouteNotFoundError";
  }
}

export class RuntimeRouteKeyMismatchError extends Error {
  constructor() {
    super("runtime route name does not match its opaque canonical identity");
    this.name = "RuntimeRouteKeyMismatchError";
  }
}

export class RuntimeEpochConflictError extends Error {
  constructor(
    readonly kind: "routing" | "authority",
    readonly expected: bigint,
    readonly actual: bigint,
  ) {
    super(`stale ${kind} epoch: expected ${expected}, canonical ${actual}`);
    this.name = "RuntimeEpochConflictError";
  }
}
