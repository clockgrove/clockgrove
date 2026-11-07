import type {
  CommandEnvelope,
  CommandId,
  DeterministicIdSource,
  EventId,
  PartitionId,
  ScheduleId,
  SimTimeMs,
} from "@clockgrove/contracts";
import type { NamedRandomState, RandomDrawMetadata } from "@clockgrove/domain";

export interface VersionedPartitionState<TState> {
  readonly schemaVersion: number;
  readonly partitionId: PartitionId;
  readonly revision: bigint;
  readonly state: Readonly<TState>;
}

export interface ScheduledKernelInput<TType extends string = string, TPayload = unknown> {
  readonly schemaVersion: number;
  readonly scheduleId: ScheduleId;
  readonly commandId: CommandId;
  readonly type: TType;
  readonly payload: Readonly<TPayload>;
}

export type KernelStimulus<
  TCommand extends CommandEnvelope<string, unknown> = CommandEnvelope<string, unknown>,
  TScheduled extends ScheduledKernelInput = ScheduledKernelInput,
> =
  | Readonly<{ kind: "command"; command: TCommand }>
  | Readonly<{ kind: "scheduled"; scheduled: TScheduled }>;

export interface VersionedPolicyInputs<TPolicy> {
  readonly schemaVersion: number;
  readonly policyVersions: Readonly<Record<string, string>>;
  readonly policy: Readonly<TPolicy>;
}

export interface VersionedPackInputs<TPack> {
  readonly schemaVersion: number;
  readonly packId: string;
  readonly packVersion: string;
  readonly pack: Readonly<TPack>;
}

export interface KernelTransitionInput<TState, TStimulus extends KernelStimulus, TPolicy, TPack> {
  readonly partition: VersionedPartitionState<TState>;
  readonly input: TStimulus;
  readonly simulationTime: SimTimeMs;
  readonly policies: VersionedPolicyInputs<TPolicy>;
  readonly pack: VersionedPackInputs<TPack>;
  readonly randomState: NamedRandomState;
  readonly ids: DeterministicIdSource;
}

export interface SemanticEventDraft<TType extends string = string, TPayload = unknown> {
  readonly eventId: EventId;
  readonly eventIndex: number;
  readonly commandId: CommandId;
  readonly type: TType;
  readonly simulationTime: SimTimeMs;
  readonly payload: Readonly<TPayload>;
  readonly randomDraws?: readonly RandomDrawMetadata[];
}

export type ScheduleMutation<TPayload = unknown> =
  | Readonly<{
      kind: "upsert";
      scheduleId: ScheduleId;
      dueAt: SimTimeMs;
      payload: Readonly<TPayload>;
    }>
  | Readonly<{ kind: "cancel"; scheduleId: ScheduleId }>;

export interface ProjectionDelta<TProjection = unknown> {
  readonly schemaVersion: number;
  readonly partitionId: PartitionId;
  readonly fromRevision: bigint;
  readonly toRevision: bigint;
  readonly delta: Readonly<TProjection>;
}

export interface DecisionDraft<TDecision = unknown> {
  readonly kind: string;
  readonly decision: Readonly<TDecision>;
  readonly randomDraws?: readonly RandomDrawMetadata[];
}

export interface EvidenceDraft<TEvidence = unknown> {
  readonly kind: string;
  readonly evidence: Readonly<TEvidence>;
}

export interface KernelTransitionResult<
  TEvent extends SemanticEventDraft = SemanticEventDraft,
  TSchedule extends ScheduleMutation = ScheduleMutation,
  TProjection extends ProjectionDelta = ProjectionDelta,
  TDecision extends DecisionDraft = DecisionDraft,
  TEvidence extends EvidenceDraft = EvidenceDraft,
> {
  readonly events: readonly TEvent[];
  readonly scheduleMutations: readonly TSchedule[];
  readonly projectionDelta: TProjection;
  readonly decisionDrafts: readonly TDecision[];
  readonly evidenceDrafts: readonly TEvidence[];
  readonly updatedRandomState: NamedRandomState;
}

export type PureKernelTransition<
  TInput extends KernelTransitionInput<unknown, KernelStimulus, unknown, unknown>,
  TResult extends KernelTransitionResult,
> = (input: Readonly<TInput>) => Readonly<TResult>;

/** Type-preserving declaration helper; it adds no runtime orchestration or mutation. */
export function definePureKernelTransition<
  TInput extends KernelTransitionInput<unknown, KernelStimulus, unknown, unknown>,
  TResult extends KernelTransitionResult,
>(transition: PureKernelTransition<TInput, TResult>): PureKernelTransition<TInput, TResult> {
  return transition;
}
