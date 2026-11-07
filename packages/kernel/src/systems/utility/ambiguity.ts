import type { CommandId, ObjectId, SimTimeMs } from "@clockgrove/contracts";
import type {
  AmbiguityDeclaration,
  DecisionTrace,
  RoutineAction,
  RoutineCandidate,
} from "@clockgrove/domain";
import { canonicalSerialize } from "../../canonical.js";
import { fnv1a64Hex } from "../../fnv1a64.js";
import { compareCandidates } from "./score.js";

/** The decision-draft kind of a planning request; the routine trace keeps the kind `routine`. */
export const PLANNING_REQUEST_KIND = "planning-request";

/** The declared condition that held, with the values it was decided on. */
export type PlanningRequestCondition =
  | Readonly<{ kind: "score-margin"; maxMargin: bigint; margin: bigint }>
  | Readonly<{ kind: "unperceived-target"; targetObjectId: ObjectId }>;

/**
 * A durable description of a routine choice the policy declares ambiguous or novel, for a later
 * planner (Wave 5). It is data in the kernel result: it is recorded, never executed, and the
 * decision it belongs to has already taken `fallbackAction`.
 */
export interface PlanningRequest {
  readonly schemaVersion: 1;
  /** Derived from the dispatched decision's command id only; no wall-clock or random input. */
  readonly requestId: string;
  readonly status: "recorded";
  /** The actor, decision time and dispatched command of the decision trace it belongs to. */
  readonly objectId: ObjectId;
  readonly simulationTime: SimTimeMs;
  readonly commandId: CommandId;
  /** The trace's policy version and the declaration's schema version. */
  readonly policyVersion: string;
  readonly ambiguityVersion: 1;
  readonly condition: PlanningRequestCondition;
  /** The eligible candidates in trace order, with their fixed-point features and scores. */
  readonly candidates: readonly RoutineCandidate[];
  /** The deterministic choice the routine decision already selected. */
  readonly fallbackAction: RoutineAction;
}

/** `planning_<fnv1a64>` of the dispatched decision command: one request at most per decision. */
export function planningRequestId(commandId: CommandId): string {
  return `planning_${fnv1a64Hex(canonicalSerialize(["clockgrove-planning-request-v1", commandId]))}`;
}

/**
 * The planning request of one utility-tier decision, or undefined when no declared condition holds.
 * A reflex decision never raises one: the reflex is the routine order's first tier. Conditions are
 * tried in declared (kind) order and the first that holds is recorded. Pure and total.
 */
export function planningRequestFor(
  trace: DecisionTrace,
  declaration: AmbiguityDeclaration,
  commandId: CommandId,
): PlanningRequest | undefined {
  if (trace.selectionTier !== "utility") return undefined;
  const eligible = trace.candidates.filter((candidate) => candidate.excludedReason === undefined);
  const [best, second] = [...eligible].sort(compareCandidates);
  if (best === undefined) return undefined;
  let condition: PlanningRequestCondition | undefined;
  for (const declared of declaration.conditions) {
    if (declared.kind === "score-margin") {
      const margin = second === undefined ? undefined : best.score - second.score;
      if (margin !== undefined && margin <= declared.maxMargin)
        condition = Object.freeze({ kind: "score-margin", maxMargin: declared.maxMargin, margin });
    } else if (best.action.targetObjectId !== undefined && best.features.perceived === 0n) {
      condition = Object.freeze({
        kind: "unperceived-target",
        targetObjectId: best.action.targetObjectId,
      });
    }
    if (condition !== undefined) break;
  }
  if (condition === undefined) return undefined;
  return Object.freeze({
    schemaVersion: 1,
    requestId: planningRequestId(commandId),
    status: "recorded",
    objectId: trace.objectId,
    simulationTime: trace.simulationTime,
    commandId,
    policyVersion: trace.policyVersion,
    ambiguityVersion: 1,
    condition,
    candidates: Object.freeze(eligible),
    fallbackAction: trace.selectedAction,
  });
}
