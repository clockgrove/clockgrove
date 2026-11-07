import {
  decodePackPresentation,
  type ObjectId,
  type PackPresentation,
  type ScenePresentationBinding,
} from "@clockgrove/contracts";
import { presentationSchema, type WorldEntity } from "@clockgrove/domain";
import reviewedAtlas from "../../../assets/reviewed/raccoon-world.animations.json" with {
  type: "json",
};
import raccoonWorld from "../../../worlds/raccoons/presentation.json" with { type: "json" };

/**
 * Presentation is outside the pack source and outside world truth: the committed `presentation.json`
 * of each shipped pack, keyed by the installed pack's id and version. Each binding is decoded through
 * the Presentation component (`clockgrove.presentation`, Wave 1 §5.2 amendment, RW-0409).
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
    return [`${presentation.pack.id}@${presentation.pack.version}`, presentation] as const;
  }),
);

/** The `assetId/animationFamily` strips the reviewed atlas holds: the families a binding may use. */
const DRAWABLE: ReadonlySet<string> = new Set(
  reviewedAtlas.animations.map((strip) => `${strip.assetId}/${strip.animationFamily}`),
);

/** Families an actor's binding replaces; `static` and `loop` bindings never follow activity. */
const ACTOR_FAMILIES: ReadonlySet<string> = new Set(["idle", "walk", "sniff", "eat", "shelter"]);

/**
 * The family of an actor's current activity, from its committed state: moving walks, a shelter
 * routine shelters, a food or water routine with a target eats and one without forages (sniffs).
 */
function activityFamily(entity: WorldEntity): string | undefined {
  if (entity.movement?.status === "active") return "walk";
  const action = entity.selectedAction;
  if (action === undefined || action.kind === "stay") return undefined;
  if (action.kind === "seek-shelter") return "shelter";
  return action.targetObjectId === undefined ? "sniff" : "eat";
}

/** The installed pack's bindings for the projected entities, each actor in its activity's family. */
export function scenePresentationBindings(
  pack: { readonly packId?: string; readonly packVersion?: string },
  entities: readonly WorldEntity[],
  projected: ReadonlySet<ObjectId>,
): ScenePresentationBinding[] {
  const presentation = PRESENTATIONS.get(`${pack.packId}@${pack.packVersion}`);
  if (presentation === undefined) return [];
  const byId = new Map(entities.map((entity) => [entity.objectId, entity]));
  return presentation.bindings
    .filter((binding) => projected.has(binding.objectId))
    .map((binding) => {
      const entity = byId.get(binding.objectId);
      const family =
        entity === undefined || !ACTOR_FAMILIES.has(binding.animationFamily)
          ? undefined
          : activityFamily(entity);
      return family !== undefined && DRAWABLE.has(`${binding.assetId}/${family}`)
        ? { ...binding, animationFamily: family }
        : binding;
    });
}
