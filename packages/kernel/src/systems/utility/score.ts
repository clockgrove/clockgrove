import type { ObjectId, SimTimeMs } from "@clockgrove/contracts";
import {
  type DecisionTrace,
  deriveComfort,
  distanceFloor,
  entityIsActive,
  foodFreshnessBasisPoints,
  type MovementDestination,
  type MovementRecord,
  movementCompletionTime,
  positionAt,
  type RoutineCandidate,
  sameCoordinates,
  type WorldBehaviorPolicy,
  type WorldEntity,
  type WorldState,
} from "@clockgrove/domain";
import { planMovement } from "../../spatial/movement.js";
import { utilityPolicyVersion } from "./registry.js";

/** Where the actor is at `time`: along its active movement, else its pose. */
export function actorPosition(actor: WorldEntity, time: SimTimeMs): readonly bigint[] {
  const movement = actor.movement;
  return movement?.status === "active"
    ? positionAt(movement.segment, time)
    : actor.pose.coordinates;
}

/** The movement destination of a target: the actor-frame anchor at its coordinates, else its pose. */
export function destinationFor(
  state: WorldState,
  actor: WorldEntity,
  target: WorldEntity,
): MovementDestination {
  for (const graph of state.anchorGraphs ?? []) {
    if (graph.frameId !== actor.pose.frameId || graph.frameVersion !== actor.pose.frameVersion)
      continue;
    const anchor = graph.anchors.find((candidate) =>
      sameCoordinates(candidate.coordinates, target.pose.coordinates),
    );
    if (anchor !== undefined)
      return Object.freeze({
        kind: "anchor",
        anchorId: anchor.anchorId,
        graphVersion: graph.version,
      });
  }
  return Object.freeze({
    kind: "pose",
    pose: Object.freeze({
      frameId: target.pose.frameId,
      frameVersion: target.pose.frameVersion,
      coordinates: target.pose.coordinates,
    }),
  });
}

export function actionKey(candidate: RoutineCandidate): string {
  return `${candidate.action.kind}:${candidate.action.targetObjectId ?? ""}`;
}

/** Selection order of `clockgrove.routine-utility@1`: higher score first, then the action key. */
export function compareCandidates(left: RoutineCandidate, right: RoutineCandidate): number {
  if (left.score !== right.score) return left.score > right.score ? -1 : 1;
  const leftKey = actionKey(left);
  const rightKey = actionKey(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

/** The exact plan a seek starts from `start` at `time`, or undefined when none can be planned. */
export function planFor(
  state: WorldState,
  actor: WorldEntity,
  target: WorldEntity,
  start: readonly bigint[],
  unitsPerSecond: bigint,
  time: SimTimeMs,
  commandId: string,
  lineage: {
    readonly priorMovementId?: string;
    readonly initialInside: readonly string[];
    readonly exitedAtStart: readonly string[];
  },
): MovementRecord | undefined {
  const plan = planMovement(
    state,
    actor,
    start,
    destinationFor(state, actor, target),
    unitsPerSecond,
    time,
    commandId,
    lineage,
  );
  return plan.ok ? plan.record : undefined;
}

export interface UtilityScoring {
  readonly trace: DecisionTrace;
  /** The selected candidate's target entity, absent for `stay`. */
  readonly target: WorldEntity | undefined;
}

/**
 * Whether attributed evidence may take effect: the attributing actor had not died before
 * `effectiveAt`. Unattributed evidence, and a world without lifecycle state, always holds.
 */
function attributionHolds(
  state: WorldState,
  attributedTo: ObjectId | undefined,
  effectiveAt: SimTimeMs,
): boolean {
  if (attributedTo === undefined) return true;
  const death = state.lifecycle?.entries.find((entry) => entry.objectId === attributedTo)?.death;
  return death === null || death === undefined || effectiveAt <= death.diedAt;
}

const EMPTY_LINEAGE = Object.freeze({ initialInside: [], exitedAtStart: [] });

function isActiveFood(entity: WorldEntity): boolean {
  return entityIsActive(entity) && entity.resource?.kind === "food";
}
function isActiveWater(entity: WorldEntity): boolean {
  return entityIsActive(entity) && entity.resource?.kind === "water";
}

/**
 * `clockgrove.routine-utility@1`: scores `stay` and one seek per active food holder, water holder
 * and shelter in object id order, then selects like `chooseRoutine` (reflex, best score, action
 * key). Pure and total over validated state; it draws no random numbers.
 */
export function scoreUtility(
  state: WorldState,
  actor: WorldEntity,
  time: SimTimeMs,
  policy: WorldBehaviorPolicy,
  commandId: string,
): UtilityScoring {
  const utility = policy.utility;
  const wellbeing = policy.wellbeing;
  const environment = policy.environment;
  if (utility === undefined || wellbeing === undefined || environment === undefined)
    throw new RangeError("utility scoring needs utility, wellbeing and environment policies");
  const needs = actor.needs;
  const entry = state.wellbeing?.entries.find((candidate) => candidate.objectId === actor.objectId);
  if (needs === undefined || entry === undefined)
    throw new RangeError("utility actor has no needs or wellbeing");
  const hunger = BigInt(needs.hunger);
  const thirst = BigInt(entry.thirst);
  const wetness = BigInt(needs.wetness);
  const rain = BigInt(state.weather.rainIntensity);
  const health = BigInt(entry.health);
  const comfort = deriveComfort(environment, wellbeing, {
    hunger: needs.hunger,
    thirst: entry.thirst,
    wetness: needs.wetness,
  }).comfort;
  const uncomfortable = comfort === "uncomfortable" ? 10000n : 0n;
  const urgency = comfort === "comfortable" ? 10000n : 20000n - health;
  const base = { hunger, thirst, wetness, rain, health, uncomfortable, U: urgency };
  const position = actorPosition(actor, time);
  const interval = policy.decisionIntervalMs;
  const scripted = (state.scriptedCognition?.entries ?? []).filter(
    (item) =>
      item.actorId === actor.objectId &&
      item.effectiveAt <= time &&
      attributionHolds(state, item.attributedTo, item.effectiveAt),
  );
  const used = new Map<string, "belief" | "memory">();
  const perceptionRefs: string[] = [];

  const candidates: RoutineCandidate[] = [
    Object.freeze({
      action: Object.freeze({ kind: "stay" as const }),
      features: Object.freeze({ ...base }),
      score: 0n,
    }),
  ];
  const targets = state.entities.filter(
    (entity) =>
      entity.objectId !== actor.objectId &&
      (isActiveFood(entity) ||
        isActiveWater(entity) ||
        (entityIsActive(entity) && entity.shelter !== undefined)),
  );
  const byTarget = new Map<string, WorldEntity>();
  for (const target of targets) {
    const kind = isActiveFood(target)
      ? ("seek-food" as const)
      : isActiveWater(target)
        ? ("seek-water" as const)
        : ("seek-shelter" as const);
    byTarget.set(`${kind}:${target.objectId}`, target);
    const sameFrame =
      target.spaceId === actor.spaceId &&
      target.pose.frameId === actor.pose.frameId &&
      target.pose.frameVersion === actor.pose.frameVersion &&
      target.pose.coordinates.length === position.length;
    const effective = scripted.filter((item) => item.targetObjectId === target.objectId);
    let expectation = 0n;
    for (const item of effective) expectation += BigInt(item.value);
    if (expectation > 10000n) expectation = 10000n;
    const perceived =
      sameFrame && distanceFloor(position, target.pose.coordinates) <= utility.perceptionRange;
    let travelMs = 0n;
    let planned = true;
    if (sameFrame && !sameCoordinates(position, target.pose.coordinates)) {
      const record = planFor(
        state,
        actor,
        target,
        position,
        utility.unitsPerSecond,
        time,
        commandId,
        EMPTY_LINEAGE,
      );
      if (record === undefined) planned = false;
      else travelMs = movementCompletionTime(record.segment) - time;
    }
    const features: Record<string, bigint> = {
      ...base,
      travelMs,
      perceived: perceived ? 10000n : 0n,
      expectation,
    };
    let need: bigint;
    let excluded: string | undefined;
    if (kind === "seek-food") {
      const perishable = policy.ecology?.perishables.find(
        (holder) => holder.objectId === target.objectId,
      );
      const arrived = state.ecology?.perishables.find(
        (holder) => holder.objectId === target.objectId,
      );
      const quantity = target.resource?.quantity ?? 0;
      const freshness =
        perishable === undefined
          ? 10000n
          : BigInt(
              foodFreshnessBasisPoints(
                {
                  shelfLifeMs: perishable.shelfLifeMs,
                  arrivedAt: arrived?.arrivedAt ?? null,
                  quantity,
                },
                time,
              ) ?? 0,
            );
      features.freshness = freshness;
      need = (hunger * BigInt(policy.hungerWeight) * freshness) / 10000n;
    } else if (kind === "seek-water") {
      need = thirst * BigInt(utility.thirstWeight);
    } else {
      const protection = BigInt(target.shelter?.rainProtection ?? 0);
      features.protection = protection;
      need = ((wetness + rain) * protection * BigInt(policy.shelterWeight)) / 10000n;
    }
    const score =
      (need * urgency) / 10000n +
      expectation * BigInt(utility.expectationWeight) -
      (travelMs * BigInt(utility.travelWeight) * 10000n) / interval;
    if (!sameFrame) excluded = "outside-current-space-or-frame";
    else if (!perceived && effective.length === 0) excluded = "not-perceived";
    else if (kind !== "seek-shelter" && (target.resource?.quantity ?? 0) <= 0)
      excluded = "unavailable";
    else if (kind === "seek-shelter" && features.protection === 0n) excluded = "no-rain-protection";
    else if (!planned) excluded = "unreachable";
    if (excluded === undefined) {
      if (perceived) perceptionRefs.push(`perceived:${target.objectId}@${time}`);
      for (const item of effective) used.set(item.ref, item.kind);
    } else if (perceived) {
      perceptionRefs.push(`perceived:${target.objectId}@${time}`);
    }
    candidates.push(
      Object.freeze({
        action: Object.freeze({ kind, targetObjectId: target.objectId as ObjectId }),
        features: Object.freeze(features),
        score,
        ...(excluded === undefined ? {} : { excludedReason: excluded }),
      }),
    );
  }
  const eligible = candidates.filter((candidate) => candidate.excludedReason === undefined);
  const reflex =
    wetness >= 9000n
      ? eligible.filter((candidate) => candidate.action.kind === "seek-shelter")
      : [];
  const pool = reflex.length > 0 ? reflex : eligible;
  const selected = [...pool].sort(compareCandidates)[0];
  if (selected === undefined) throw new RangeError("routine has no eligible invariant-safe action");
  const refs = (kind: "belief" | "memory") =>
    Object.freeze(
      [...used.entries()]
        .filter(([, itemKind]) => itemKind === kind)
        .map(([ref]) => ref)
        .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
    );
  const targetId = selected.action.targetObjectId;
  const trace: DecisionTrace = Object.freeze({
    schemaVersion: 1,
    objectId: actor.objectId,
    inputRevision: state.revision,
    simulationTime: time,
    policyVersion: utilityPolicyVersion(policy.version),
    selectionTier: reflex.length > 0 ? ("reflex" as const) : ("utility" as const),
    candidates: Object.freeze(candidates),
    selectedAction: selected.action,
    perceptionRefs: Object.freeze(perceptionRefs),
    beliefRefs: refs("belief"),
    memoryRefs: refs("memory"),
    randomDraws: Object.freeze([]),
    outcomeLinks: Object.freeze([]),
  });
  return Object.freeze({
    trace,
    target:
      targetId === undefined ? undefined : byTarget.get(`${selected.action.kind}:${targetId}`),
  });
}
