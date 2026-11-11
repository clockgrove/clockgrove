import {
  decodePackPresentation,
  decodeSceneMaterialDelivery,
  defaultSceneLighting,
  type LivingPose,
  type LivingSpatialFrame,
  type ObjectId,
  type PackPresentation,
  type SceneEffect,
  type SceneLighting,
  type SceneMaterialDelivery,
  type ScenePresentationBinding,
} from "@clockgrove/contracts";
import { presentationSchema, type WorldEntity, type WorldState } from "@clockgrove/domain";
export interface ScenePresentationInput {
  readonly presentation: PackPresentation;
  readonly drawable: readonly string[];
  readonly materials?: Readonly<Record<string, SceneMaterialDelivery>>;
  readonly activity: {
    readonly families: readonly string[];
    readonly moving: string;
    readonly shelter: string;
    readonly arrived: string;
    readonly seeking: string;
  };
}

export function decodeScenePresentations(
  source: string | undefined,
): readonly ScenePresentationInput[] {
  if (source === undefined) return [];
  const values: unknown = JSON.parse(source);
  if (!Array.isArray(values)) throw new Error("world presentations must be an array");
  return values.map((value) => {
    const presentation = decodePackPresentation(value.presentation);
    for (const binding of presentation.bindings)
      presentationSchema.parse({
        assetId: binding.assetId,
        animationFamily: binding.animationFamily,
        accessibilityLabel: binding.accessibilityLabel,
      });
    const { drawable, activity } = value;
    if (
      !Array.isArray(drawable) ||
      !drawable.every((item) => typeof item === "string") ||
      !activity ||
      !Array.isArray(activity.families) ||
      !activity.families.every((item: unknown) => typeof item === "string") ||
      ![activity.moving, activity.shelter, activity.arrived, activity.seeking].every(
        (item) => typeof item === "string",
      )
    )
      throw new Error("invalid world presentation activity or drawable families");
    return {
      presentation,
      drawable,
      activity,
      ...(value.materials === undefined
        ? {}
        : {
            materials: Object.fromEntries(
              Object.entries(value.materials).map(([key, material]) => [
                key,
                decodeSceneMaterialDelivery(material),
              ]),
            ),
          }),
    };
  });
}

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
  activity: ScenePresentationInput["activity"],
): string | undefined {
  if (entity.movement?.status === "active") return activity.moving;
  const action = entity.selectedAction;
  if (action === undefined || action.kind === "stay") return undefined;
  if (action.kind === "seek-shelter") return activity.shelter;
  const target = action.targetObjectId === undefined ? undefined : byId.get(action.targetObjectId);
  return atTarget(entity, target) ? activity.arrived : activity.seeking;
}

/** The installed pack's bindings for the projected entities, each actor in its activity's family. */
export function scenePresentationBindings(
  pack: { readonly packId?: string },
  entities: readonly WorldEntity[],
  projected: ReadonlySet<ObjectId>,
  inputs: readonly ScenePresentationInput[] = [],
): ScenePresentationBinding[] {
  const input = inputs.find((item) => item.presentation.pack.id === pack.packId);
  const presentation = input?.presentation;
  if (presentation === undefined) return [];
  const byId = new Map(entities.map((entity) => [entity.objectId, entity]));
  return presentation.bindings
    .filter((binding) => projected.has(binding.objectId))
    .map((binding) => {
      const entity = byId.get(binding.objectId);
      const family =
        entity === undefined || !input?.activity.families.includes(binding.animationFamily)
          ? undefined
          : activityFamily(entity, byId, input.activity);
      const animationFamily =
        family !== undefined && input?.drawable.includes(`${binding.assetId}/${family}`)
          ? family
          : binding.animationFamily;
      const material =
        input?.materials?.[`${binding.assetId}/${animationFamily}`] ??
        (animationFamily === binding.animationFamily ? binding.material : undefined);
      const { material: _defaultMaterial, ...base } = binding;
      return { ...base, animationFamily, ...(material === undefined ? {} : { material }) };
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
  inputs: readonly ScenePresentationInput[] = [],
): SceneEffect[] {
  const input = inputs.find((item) => item.presentation.pack.id === pack.packId);
  const presentation = input?.presentation;
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

/** Compatibility export: the default presentation rig is shared with offline compositions. */
export const sceneLighting = defaultSceneLighting;

/** Material worlds opt into explicit lighting; legacy flat worlds retain their wire shape. */
export function materialSceneLighting(
  pack: { readonly packId?: string },
  inputs: readonly ScenePresentationInput[],
  simulationTime: bigint,
  weather: { readonly rainIntensity: number },
  effects: readonly SceneEffect[],
): SceneLighting | undefined {
  const input = inputs.find((item) => item.presentation.pack.id === pack.packId);
  return input &&
    (input.materials !== undefined ||
      input.presentation.bindings.some((binding) => binding.material !== undefined))
    ? sceneLighting(simulationTime, weather, effects)
    : undefined;
}
