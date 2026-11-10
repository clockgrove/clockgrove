import {
  decodeSceneProjection,
  type LivingPose,
  type LivingSpatialFrame,
  type MaterialChannel,
  type ObjectId,
  type SceneEffect,
  type SceneMaterialDelivery,
  type ScenePatch,
  type SceneProjection,
  type SceneTransientCue,
  type WorldObjectId,
} from "@clockgrove/contracts";

/** What a renderer asks the shell to do; it never mutates the world (Wave 4 plan §3.2). */
export interface SceneIntent {
  readonly type: "select";
  readonly objectId: WorldObjectId;
}
export type Unsubscribe = () => void;
/** The shell's shared selection and the entity whose control holds keyboard focus. */
export interface SceneEmphasis {
  readonly selected: ObjectId | undefined;
  readonly focused: ObjectId | undefined;
}
/**
 * The only React/renderer bridge (Wave 4 plan §9.1). It receives committed reducer output only, so a
 * renderer never draws state the projection reducer has not accepted (§8).
 */
export interface WorldSceneAdapter {
  /** Replaces the drawn scene with a committed projection; entities kept by id move, not respawn. */
  loadSnapshot(snapshot: SceneProjection): void;
  /** Applies a committed contiguous patch; a stale, duplicate or gapped patch changes nothing. */
  applyPatch(patch: ScenePatch): void;
  /** Draws a transient cue once per dedupe key until it expires; it never changes the projection. */
  emitCue(cue: SceneTransientCue): void;
  setSelection(id?: WorldObjectId): void;
  /** Draws keyboard focus on an entity and keeps it in view; no id clears the focus affordance. */
  focus(id?: WorldObjectId): void;
  setReducedMotion(enabled: boolean): void;
  onIntent(handler: (intent: SceneIntent) => void): Unsubscribe;
  destroy(): void;
}

/** Frame-local position in frame units, from the canonical fixed-point pose coordinates. */
export function framePosition(frame: LivingSpatialFrame, coordinates: readonly string[]): number[] {
  const scale = 10 ** frame.unit.fractionalDigits;
  return coordinates.map((value) => Number(value) / scale);
}
/** Metres per frame unit by unit name; an unnamed unit counts as one metre. */
const METRES_PER_UNIT: Readonly<Record<string, number>> = {
  meter: 1,
  metre: 1,
  millimeter: 0.001,
  millimetre: 0.001,
};
/** Movement within this many metres interpolates; beyond it the sprite snaps (see docs/scene.md). */
export const SNAP_THRESHOLD_METRES = 16;
/** How long one committed move is interpolated, in milliseconds (decision, docs/scene.md). */
export const INTERPOLATION_MS = 400;
/** Occlusion groups, drawn in this order: later groups always cover earlier ones. */
export const OCCLUSION_GROUPS = ["ground", "standing", "weather", "emphasis"] as const;
export type OcclusionGroup = (typeof OCCLUSION_GROUPS)[number];
/** A committed entity placed for the fixed 2.5D camera, in metres of its frame. */
export interface ScenePlacement {
  readonly objectId: ObjectId;
  readonly frame: string;
  readonly x: number;
  readonly y: number;
  readonly elevation: number;
  readonly occlusionGroup: OcclusionGroup;
  /** Occlusion group, nearness to the viewer (x − y), elevation, then object id. */
  readonly depthKey: readonly [number, number, number, ObjectId];
}
/** Larger depth keys are nearer the viewer; the camera looks from the south-east. */
function compareDepth(a: ScenePlacement, b: ScenePlacement): number {
  const [ag, an, ae, ai] = a.depthKey;
  const [bg, bn, be, bi] = b.depthKey;
  return ag - bg || an - bn || ae - be || (ai < bi ? 1 : ai > bi ? -1 : 0);
}
/**
 * Every committed entity whose frame version is present, in pick order: nearest first. Pointer,
 * touch and keyboard picking all resolve candidates in this order; drawing uses its reverse.
 */
export function pickOrder(projection: Pick<SceneProjection, "frames" | "entities">) {
  const frames = new Map(projection.frames.map((frame) => [frame.frameId, frame]));
  const placed: ScenePlacement[] = [];
  for (const entity of projection.entities) {
    const at = poseMetres(frames, entity.pose);
    if (!at) continue;
    placed.push({
      objectId: entity.objectId,
      frame: at.frame,
      x: at.x,
      y: at.y,
      elevation: at.elevation,
      occlusionGroup: "standing",
      depthKey: [OCCLUSION_GROUPS.indexOf("standing"), at.x - at.y, at.z, entity.objectId],
    });
  }
  return placed.sort((a, b) => compareDepth(b, a));
}
/** A pose in metres of its frame; undefined when the pose's frame version is not in the projection. */
export function poseMetres(
  frames: ReadonlyMap<string, LivingSpatialFrame>,
  pose: LivingPose,
): { frame: string; x: number; y: number; z: number; elevation: number } | undefined {
  const frame = frames.get(pose.frameId);
  if (!frame || frame.version !== pose.frameVersion) return undefined;
  const metres = METRES_PER_UNIT[frame.unit.name] ?? 1;
  const [x = 0, y = 0, z = 0] = framePosition(frame, pose.coordinates).map(
    (value) => value * metres,
  );
  return {
    frame: `${frame.frameId}@${frame.version}`,
    x,
    y,
    z,
    elevation: frame.dimensions === 3 ? z : 0,
  };
}
const DAY_MS = 86_400_000n;
const HOUR_MS = 3_600_000n;
/** The issue 813 golden's night rule: before 06:00 or from 18:00 of the canonical day. */
export function isNight(simulationTime: bigint): boolean {
  const time = simulationTime % DAY_MS;
  return time < 6n * HOUR_MS || time >= 18n * HOUR_MS;
}
/** The effects shown now, decided from the committed projection alone. */
export function shownEffects(
  projection: Pick<SceneProjection, "effects" | "weather" | "simulationTime">,
): SceneEffect[] {
  const raining = projection.weather.rainIntensity > 0;
  const night = isNight(projection.simulationTime);
  return (projection.effects ?? []).filter((effect) =>
    effect.role === "puddle" ? raining : night,
  );
}
/** The text path's description of the same conditions the canvas draws. */
export function effectsText(
  projection: Pick<SceneProjection, "effects" | "weather" | "simulationTime">,
): { puddles: string; lights: string } {
  const shown = shownEffects(projection);
  const puddles = shown.filter((effect) => effect.role === "puddle").length;
  const lit = (["lantern", "window"] as const).filter((role) =>
    shown.some((effect) => effect.role === role),
  );
  return {
    puddles: puddles > 0 ? String(puddles) : "none",
    lights: lit.length > 0 ? `${lit.join(", ")} lit` : "off",
  };
}
/** Whether a committed move is drawn as interpolation or as a snap. */
export function movement(from: ScenePlacement, to: ScenePlacement): "interpolate" | "snap" {
  if (from.frame !== to.frame) return "snap";
  const distance = Math.hypot(to.x - from.x, to.y - from.y, to.elevation - from.elevation);
  return distance > SNAP_THRESHOLD_METRES ? "snap" : "interpolate";
}
/** A repeated tap within this many CSS pixels of the last one cycles to the next candidate. */
export const TOUCH_CYCLE_PX = 8;
export interface PickCycle {
  readonly at: readonly [number, number];
  readonly candidates: readonly ObjectId[];
  readonly index: number;
}
/**
 * Touch picking among overlapping sprites (§4.4): the first tap picks the nearest candidate and each
 * repeated tap on the same spot and the same candidates picks the next one, wrapping around.
 */
export function cyclePick(
  previous: PickCycle | undefined,
  at: readonly [number, number],
  candidates: readonly ObjectId[],
): PickCycle {
  const same =
    previous !== undefined &&
    Math.hypot(at[0] - previous.at[0], at[1] - previous.at[1]) <= TOUCH_CYCLE_PX &&
    previous.candidates.length === candidates.length &&
    previous.candidates.every((id, index) => candidates[index] === id);
  return {
    at,
    candidates,
    index: same && candidates.length > 0 ? (previous.index + 1) % candidates.length : 0,
  };
}

/** Apply an already decoded contiguous patch, then validate the complete projected state. */
export function applyScenePatch(scene: SceneProjection, patch: ScenePatch): SceneProjection {
  const entities = new Map(scene.entities.map((entity) => [entity.objectId, entity]));
  const frames = new Map(scene.frames.map((frame) => [frame.frameId, frame]));
  const hierarchy = new Map(scene.hierarchy.map((space) => [space.spaceId, space]));
  const bindings = new Map(
    scene.presentationBindings.map((binding) => [binding.objectId, binding]),
  );
  const interactions = new Map(
    scene.interactions.map((interaction) => [interaction.entityId, interaction]),
  );
  let simulationTime = scene.simulationTime;
  let weather = scene.weather;
  let feedCursor = scene.feedCursor;
  let compatibility = scene.compatibility;
  let privateCognition = scene.privateCognition;
  let effects = scene.effects;
  let lighting = scene.lighting;
  for (const operation of patch.operations) {
    switch (operation.op) {
      case "upsert_entity":
        entities.set(operation.entity.objectId, operation.entity);
        break;
      case "remove_entity":
        entities.delete(operation.objectId);
        break;
      case "upsert_frame":
        frames.set(operation.frame.frameId, operation.frame);
        break;
      case "remove_frame":
        frames.delete(operation.frameId);
        break;
      case "upsert_space":
        hierarchy.set(operation.space.spaceId, operation.space);
        break;
      case "remove_space":
        hierarchy.delete(operation.spaceId);
        break;
      case "upsert_presentation":
        bindings.set(operation.binding.objectId, operation.binding);
        break;
      case "remove_presentation":
        bindings.delete(operation.objectId);
        break;
      case "upsert_interaction":
        interactions.set(operation.interaction.entityId, operation.interaction);
        break;
      case "remove_interaction":
        interactions.delete(operation.objectId);
        break;
      case "set_clock":
        simulationTime = operation.simulationTime;
        break;
      case "set_weather":
        weather = operation.weather;
        break;
      case "set_feed_cursor":
        feedCursor = operation.feedCursor;
        break;
      case "set_compatibility":
        compatibility = operation.compatibility;
        break;
      case "set_private_cognition":
        privateCognition = operation.entries;
        break;
      case "set_lighting":
        lighting = operation.lighting ?? undefined;
        break;
      case "set_effects":
        effects = operation.effects;
        break;
    }
  }
  const { privateCognition: _previous, effects: _effects, lighting: _lighting, ...rest } = scene;
  return decodeSceneProjection({
    ...rest,
    ...(privateCognition && {
      privateCognition: privateCognition.filter((entry) => entities.has(entry.actorId)),
    }),
    ...(effects && { effects }),
    ...(lighting && { lighting }),
    revision: patch.toRevision,
    simulationTime,
    weather,
    feedCursor,
    compatibility,
    entities: [...entities.values()],
    frames: [...frames.values()],
    hierarchy: [...hierarchy.values()],
    presentationBindings: [...bindings.values()],
    interactions: [...interactions.values()],
  });
}

/** apps/web/scene-budgets.json: the 256 KiB asset transfer and 32 MiB atlas page texture ceilings. */
export const MATERIAL_DELIVERY_BUDGET = {
  transferBytes: 262_144,
  textureBytes: 33_554_432,
} as const;

/**
 * What one material page costs a client: the file it fetches and the texture it uploads. A client
 * with a compressed format fetches the KTX2 file and uploads 16 bytes per 4×4 block, the size of
 * every target UASTC transcodes to (ASTC 4×4, BC7, ETC2 RGBA8, BC3); otherwise it fetches the PNG
 * and uploads RGBA8.
 */
export function materialPageCost(
  page: {
    readonly image: { readonly width: number; readonly height: number; readonly bytes: number };
    readonly compressed: { readonly bytes: number };
  },
  compressed: boolean,
): { readonly transferBytes: number; readonly textureBytes: number } {
  const { width, height } = page.image;
  return compressed
    ? {
        transferBytes: page.compressed.bytes,
        textureBytes: Math.ceil(width / 4) * Math.ceil(height / 4) * 16,
      }
    : { transferBytes: page.image.bytes, textureBytes: width * height * 4 };
}

/** Highest useful density whose pages, as this client fetches and uploads them, fit both budgets. */
export function selectMaterialRendition(
  material: SceneMaterialDelivery,
  devicePixelRatio: number,
  budget: { readonly transferBytes: number; readonly textureBytes: number },
  supported: readonly MaterialChannel[] = ["albedo"],
  compressed = false,
): SceneMaterialDelivery["renditions"][number] | undefined {
  const target = Number.isFinite(devicePixelRatio) ? Math.max(1, devicePixelRatio) : 1;
  const useful =
    material.renditions.find((r) => r.density >= target)?.density ??
    material.renditions.at(-1)?.density ??
    1;
  return [...material.renditions].reverse().find((r) => {
    if (r.density > useful) return false;
    const pages = new Map(
      supported.flatMap((channel) => {
        const texture = r.channels[channel];
        return texture
          ? (texture.pages ?? [texture]).map(
              (page) => [page.image.sha256, materialPageCost(page, compressed)] as const,
            )
          : [];
      }),
    );
    return (
      [...pages.values()].reduce((n, cost) => n + cost.transferBytes, 0) <= budget.transferBytes &&
      [...pages.values()].reduce((n, cost) => n + cost.textureBytes, 0) <= budget.textureBytes
    );
  });
}
