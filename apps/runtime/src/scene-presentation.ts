import {
  decodePackPresentation,
  type LivingPose,
  type LivingSpatialFrame,
  type ObjectId,
  type PackPresentation,
  type SceneEffect,
  type ScenePresentationBinding,
} from "@clockgrove/contracts";
import { presentationSchema, type WorldEntity, type WorldState } from "@clockgrove/domain";
import reviewedAtlas from "../../../assets/reviewed/raccoon-world.animations.json" with {
  type: "json",
};
import raccoonWorld from "../../../worlds/raccoons/presentation.json" with { type: "json" };

/**
 * Presentation is outside the pack source and outside world truth: the committed `presentation.json`
 * of each shipped pack, keyed by pack id. A world installed at an earlier version of a shipped pack
 * still draws that pack's shipped presentation; bindings for objects it does not project are dropped.
 * Each binding is decoded through the Presentation component (`clockgrove.presentation`, Wave 1
 * §5.2 amendment, RW-0409).
 */
const PRESENTATIONS: ReadonlyMap<string, PackPresentation> = new Map(
  [raccoonWorld].map((source) => {
    const presentation = decodePackPresentation(source);
    for (const binding of presentation.bindings)
      presentationSchema.parse({
        assetId: binding.assetId,
        animationFamily: binding.animationFamily,
        accessibilityLabel: binding.accessibilityLabel,
      });
    return [presentation.pack.id, presentation] as const;
  }),
);

/** The `assetId/animationFamily` strips the reviewed atlas holds: the families a binding may use. */
const DRAWABLE: ReadonlySet<string> = new Set(
  reviewedAtlas.animations.map((strip) => `${strip.assetId}/${strip.animationFamily}`),
);

/** Families an actor's binding replaces; `static` and `loop` bindings never follow activity. */
const ACTOR_FAMILIES: ReadonlySet<string> = new Set(["idle", "walk", "sniff", "eat", "shelter"]);

/** Whether `entity` stands on `target`'s pose: where a seek's movement ends on arrival. */
function atTarget(entity: WorldEntity, target: WorldEntity | undefined): boolean {
  if (target === undefined) return false;
  const [here, there] = [entity.pose, target.pose];
  return (
    here.frameId === there.frameId &&
    here.frameVersion === there.frameVersion &&
    here.coordinates.length === there.coordinates.length &&
    here.coordinates.every((value, axis) => value === there.coordinates[axis])
  );
}

/**
 * The family of an actor's current activity, from its committed state: moving walks, a shelter
 * routine shelters, a food or water routine eats once the actor stands at its target and otherwise
 * forages (sniffs).
 */
function activityFamily(
  entity: WorldEntity,
  byId: ReadonlyMap<ObjectId, WorldEntity>,
): string | undefined {
  if (entity.movement?.status === "active") return "walk";
  const action = entity.selectedAction;
  if (action === undefined || action.kind === "stay") return undefined;
  if (action.kind === "seek-shelter") return "shelter";
  const target = action.targetObjectId === undefined ? undefined : byId.get(action.targetObjectId);
  return atTarget(entity, target) ? "eat" : "sniff";
}

/** The installed pack's bindings for the projected entities, each actor in its activity's family. */
export function scenePresentationBindings(
  pack: { readonly packId?: string },
  entities: readonly WorldEntity[],
  projected: ReadonlySet<ObjectId>,
): ScenePresentationBinding[] {
  const presentation = pack.packId === undefined ? undefined : PRESENTATIONS.get(pack.packId);
  if (presentation === undefined) return [];
  const byId = new Map(entities.map((entity) => [entity.objectId, entity]));
  return presentation.bindings
    .filter((binding) => projected.has(binding.objectId))
    .map((binding) => {
      const entity = byId.get(binding.objectId);
      const family =
        entity === undefined || !ACTOR_FAMILIES.has(binding.animationFamily)
          ? undefined
          : activityFamily(entity, byId);
      return family !== undefined && DRAWABLE.has(`${binding.assetId}/${family}`)
        ? { ...binding, animationFamily: family }
        : binding;
    });
}

/** Floor of (a + b) / 2: the arithmetic shift floors, where bigint division truncates toward zero. */
function midpoint(a: bigint, b: bigint): bigint {
  return (a + b) >> 1n;
}

/**
 * The installed pack's placed effects for the projected scene: a puddle at the midpoint of every
 * anchor-graph edge in a projected frame, and a lantern or window at its object's pose.
 */
export function sceneEffects(
  pack: { readonly packId?: string },
  state: Pick<WorldState, "entities" | "anchorGraphs">,
  frames: readonly LivingSpatialFrame[],
  projected: ReadonlySet<ObjectId>,
): SceneEffect[] {
  const presentation = pack.packId === undefined ? undefined : PRESENTATIONS.get(pack.packId);
  if (presentation === undefined) return [];
  const shown = new Set(frames.map((frame) => `${frame.frameId}@${frame.version}`));
  const byId = new Map(state.entities.map((entity) => [entity.objectId, entity]));
  const effects: SceneEffect[] = [];
  for (const effect of presentation.effects) {
    const { assetId, animationFamily } = effect;
    if (effect.role === "puddle") {
      for (const graph of state.anchorGraphs ?? []) {
        if (!shown.has(`${graph.frameId}@${graph.frameVersion}`)) continue;
        const anchors = new Map(graph.anchors.map((anchor) => [anchor.anchorId, anchor]));
        for (const edge of graph.edges) {
          const from = anchors.get(edge.from);
          const to = anchors.get(edge.to);
          if (from === undefined || to === undefined) continue;
          const pose: LivingPose = {
            frameId: graph.frameId,
            frameVersion: graph.frameVersion,
            coordinates: from.coordinates.map((value, axis) =>
              String(midpoint(value, to.coordinates[axis] as bigint)),
            ),
          };
          effects.push({ role: "puddle", assetId, animationFamily, pose });
        }
      }
    } else if (effect.role === "lantern" || effect.role === "window") {
      if (effect.objectId === null || !projected.has(effect.objectId)) continue;
      const entity = byId.get(effect.objectId);
      if (entity === undefined) continue;
      const pose: LivingPose = {
        frameId: entity.pose.frameId,
        frameVersion: entity.pose.frameVersion,
        coordinates: entity.pose.coordinates.map(String),
      };
      effects.push({ role: effect.role, assetId, animationFamily, pose });
    }
  }
  return effects;
}
