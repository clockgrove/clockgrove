import type { ObjectId } from "@clockgrove/contracts";
import { entityIsActive, type WorldEntity, type WorldState } from "@clockgrove/domain";

const NEEDED = { "seek-food": "food", "seek-water": "water" } as const;

/**
 * The actors, in object-id order, whose selected seek-food, seek-water or seek-shelter action can
 * no longer be carried out, by the scorer's own test of a target (`scoreUtility`): the target is
 * gone (retired, dead or no longer the resource kind), or it holds none of the resource. A target
 * that holds none stops an actor still walking to it and any actor in `unserved` (arrived and
 * consumed nothing); an actor settled at it keeps its action, which it has already carried out.
 */
export function impossibleSelections(
  state: WorldState,
  unserved: ReadonlySet<string> = new Set(),
): ObjectId[] {
  const seekers = state.entities.filter(
    (actor) =>
      entityIsActive(actor) &&
      actor.selectedAction?.targetObjectId !== undefined &&
      actor.selectedAction.kind.startsWith("seek-"),
  );
  if (seekers.length === 0) return [];
  const byId = new Map<string, WorldEntity>(
    state.entities.map((entity) => [entity.objectId, entity]),
  );
  const stuck: ObjectId[] = [];
  for (const actor of seekers) {
    const action = actor.selectedAction as { kind: string; targetObjectId: string };
    const target = byId.get(action.targetObjectId);
    const kind = NEEDED[action.kind as keyof typeof NEEDED];
    const gone =
      target === undefined ||
      !entityIsActive(target) ||
      (kind === undefined ? target.shelter === undefined : target.resource?.kind !== kind);
    const empty = !gone && kind !== undefined && (target.resource?.quantity ?? 0) <= 0;
    if (gone || (empty && (actor.movement?.status === "active" || unserved.has(actor.objectId))))
      stuck.push(actor.objectId as ObjectId);
  }
  return stuck;
}
