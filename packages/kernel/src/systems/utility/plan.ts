import { sameCoordinates, type WorldBehaviorPolicy, type WorldState } from "@clockgrove/domain";

export const PLAN_MATCHES_ACTION_CHECK = "utility.plan-matches-action";

/**
 * Under a `utility` policy every needs actor's active movement must belong to its selected seek
 * plan: the actor selected a seek with a target whose coordinates are the movement's destination.
 * Returns the offending `state.entities[i].movement` path, or undefined when all plans match.
 */
export function utilityPlanDisagreement(
  policy: Pick<WorldBehaviorPolicy, "utility"> | undefined,
  state: WorldState,
): string | undefined {
  if (policy?.utility === undefined) return undefined;
  for (const [index, entity] of state.entities.entries()) {
    const movement = entity.movement;
    if (entity.needs === undefined || movement === undefined || movement.status !== "active")
      continue;
    const action = entity.selectedAction;
    const target =
      action === undefined || action.targetObjectId === undefined
        ? undefined
        : state.entities.find((candidate) => candidate.objectId === action.targetObjectId);
    const destination = movement.segment.waypoints[movement.segment.waypoints.length - 1]!;
    if (
      action === undefined ||
      action.kind === "stay" ||
      target === undefined ||
      !sameCoordinates(destination, target.pose.coordinates)
    )
      return `state.entities[${index}].movement`;
  }
  return undefined;
}
