import type { ObjectId, ScheduleId } from "@clockgrove/contracts";
import type { WorldBehaviorPolicy, WorldState } from "@clockgrove/domain";
import { canonicalSerialize } from "../canonical.js";
import { fnv1a64Hex } from "../fnv1a64.js";

function lifecycleId(kind: string, prefix: string, inputs: readonly unknown[]): string {
  return `${prefix}_${fnv1a64Hex(canonicalSerialize([`clockgrove-lifecycle-${kind}-v1`, ...inputs]))}`;
}

/** The child of a gestating parent's `ordinal`-th conception; independent of any command id. */
export function lifecycleChildId(gestatingParentId: ObjectId, ordinal: number): ObjectId {
  return lifecycleId("child", "child", [gestatingParentId, ordinal]) as ObjectId;
}

/** The `world.decision` schedule id of a child born by `lifecycle.born`. */
export function lifecycleScheduleId(childId: ObjectId): ScheduleId {
  return lifecycleId("schedule", "schedule", [childId]) as ScheduleId;
}

/** The identity a successor of a deceased object would take; it never names an existing entity. */
export function lifecycleSuccessorId(predecessorId: ObjectId, rule: string): ObjectId {
  return lifecycleId("successor", "successor", [predecessorId, rule]) as ObjectId;
}

export interface SuccessorIntent {
  readonly schemaVersion: 1;
  readonly kind: "lifecycle.successor";
  readonly predecessorId: ObjectId;
  readonly successorId: ObjectId;
  readonly rule: string;
}

export interface SuccessorRefusal {
  readonly code: "invalid-input" | "precondition-failed";
  readonly path: string;
}

/**
 * The successor intent primitive: a pure, total request that a deceased actor be succeeded. It
 * adds no entity and changes nothing; refusals are returned, never thrown.
 */
export function requestSuccessorIntent(
  state: WorldState,
  policy: WorldBehaviorPolicy,
  deceasedId: ObjectId,
): SuccessorIntent | SuccessorRefusal {
  const refuse = (code: SuccessorRefusal["code"], path: string): SuccessorRefusal =>
    Object.freeze({ code, path });
  try {
    const rule = policy?.lifecycle?.successorRule;
    const entry = state?.lifecycle?.entries.find((candidate) => candidate.objectId === deceasedId);
    const entity = state?.entities.find((candidate) => candidate.objectId === deceasedId);
    if (policy?.lifecycle === undefined || state?.lifecycle === undefined)
      return refuse("precondition-failed", "policy.lifecycle");
    if (entry === undefined || entity === undefined) return refuse("invalid-input", "deceasedId");
    if (entry.death === null || entity.lifecycle?.status !== "dead")
      return refuse("precondition-failed", "deceasedId");
    if (rule === null || rule === undefined)
      return refuse("precondition-failed", "policy.lifecycle.successorRule");
    const successorId = lifecycleSuccessorId(deceasedId, rule);
    if (successorId === deceasedId) return refuse("precondition-failed", "deceasedId");
    return Object.freeze({
      schemaVersion: 1,
      kind: "lifecycle.successor",
      predecessorId: deceasedId,
      successorId,
      rule,
    });
  } catch {
    return refuse("invalid-input", "input");
  }
}
