import type {
  ActorProcessId,
  ArtifactId,
  OpaqueId,
  RunId,
  SimTimeMs,
  SubjectId,
} from "@clockgrove/contracts";

export type ObjectiveRef = OpaqueId<"ObjectiveRef">;
export type EventCursorRef = OpaqueId<"EventCursorRef">;
export type BudgetPolicyRef = OpaqueId<"BudgetPolicyRef">;
export type ArtifactRef = ArtifactId;

export interface SubjectRef {
  subjectId: SubjectId;
}

export const ACTOR_PROCESS_MODES = ["reactive", "scheduled", "continuously_eligible"] as const;
export type ActorProcessMode = (typeof ACTOR_PROCESS_MODES)[number];

export const ACTOR_PROCESS_STATUSES = [
  "waiting",
  "runnable",
  "running",
  "paused",
  "completed",
  "failed",
] as const;
export type ActorProcessStatus = (typeof ACTOR_PROCESS_STATUSES)[number];

/** The durable contract is state only; it does not imply a resident worker or provider session. */
export interface ActorProcess {
  processId: ActorProcessId;
  subject: SubjectRef;
  mode: "reactive" | "scheduled" | "continuously_eligible";
  status: "waiting" | "runnable" | "running" | "paused" | "completed" | "failed";
  objectiveRef: ObjectiveRef;
  subscriptionCursorRefs: EventCursorRef[];
  checkpointRef?: ArtifactRef;
  leaseEpoch: bigint;
  budgetPolicyRef: BudgetPolicyRef;
  lastRunSegmentId?: RunId;
}

export interface ActorProcessSegment {
  readonly processId: ActorProcessId;
  readonly runSegmentId: RunId;
  readonly leaseEpoch: bigint;
  readonly startedAt: SimTimeMs;
  readonly endedAt: SimTimeMs;
  readonly budgetLimit: bigint;
  readonly budgetConsumed: bigint;
}

export function validateActorProcess(process: ActorProcess): void {
  if (!ACTOR_PROCESS_MODES.includes(process.mode)) {
    throw new DomainValidationError("actorProcess.mode", "unsupported mode");
  }
  if (!ACTOR_PROCESS_STATUSES.includes(process.status)) {
    throw new DomainValidationError("actorProcess.status", "unsupported status");
  }
  if (process.leaseEpoch < 0n) {
    throw new DomainValidationError("actorProcess.leaseEpoch", "must not be negative");
  }
}

export function validateActorProcessSegment(
  process: ActorProcess,
  segment: ActorProcessSegment,
): void {
  validateActorProcess(process);
  if (segment.processId !== process.processId) {
    throw new DomainValidationError("segment.processId", "does not match durable process");
  }
  if (segment.leaseEpoch !== process.leaseEpoch) {
    throw new DomainValidationError("segment.leaseEpoch", "does not match durable process lease");
  }
  if (segment.startedAt > segment.endedAt) {
    throw new DomainValidationError("segment.endedAt", "must not precede segment start");
  }
  if (segment.budgetLimit < 0n || segment.budgetConsumed < 0n) {
    throw new DomainValidationError("segment.budget", "must not be negative");
  }
  if (segment.budgetConsumed > segment.budgetLimit) {
    throw new DomainValidationError("segment.budgetConsumed", "exceeds the bounded segment budget");
  }
}

/** A validation refusal. `path` is the canonical path of the offending field; the message embeds it for people only. */
export class DomainValidationError extends TypeError {
  readonly path: string;
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "DomainValidationError";
    this.path = path;
  }
}
