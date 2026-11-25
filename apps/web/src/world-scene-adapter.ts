import {
  decodeSceneProjection,
  type LivingPose,
  type LivingSpatialFrame,
  type MaterialChannel,
  metresPerUnit,
  type ObjectId,
  type SceneEffect,
  type SceneMaterialDelivery,
  type ScenePatch,
  type SceneProjection,
  type SceneSurfaceHost,
  type SceneSurfaces,
  type SceneSurfaceZone,
  type SceneTransientCue,
  type SurfaceTier,
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
 * #266: the selected character is hidden behind world content and the reveal has started; `behind`
 * is the label of the content covering most of it, as world presentation data names it.
 */
export interface SceneOcclusionReveal {
  readonly objectId: ObjectId;
  readonly behind: string;
}
/** #266: the text path's line naming who is hidden, for example "Ada is behind the cedar." */
export function occlusionText(label: string, behind: string): string {
  return `${label} is behind ${behind}.`;
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
  /**
   * The installed pack's day length in simulation milliseconds, as the world clock reports it;
   * undefined when the pack declares none. Night follows it while no lighting environment is projected.
   */
  setDayLength(dayLengthMs: bigint | undefined): void;
  onIntent(handler: (intent: SceneIntent) => void): Unsubscribe;
  /**
   * #266: reports when the selected character's occlusion reveal starts (after the dwell), changes
   * occluder, and ends (undefined). Optional: a renderer without world content never reveals.
   */
  onOcclusion?(handler: (reveal: SceneOcclusionReveal | undefined) => void): Unsubscribe;
  /**
   * The renderer's current quality tier (quality-tier.ts's `QualityTier`; the bridge imports only
   * contracts), reported once it is known and on every change.
   */
  onQualityTier?(handler: (tier: "low" | "medium" | "high") => void): Unsubscribe;
  destroy(): void;
}

/** Frame-local position in frame units, from the canonical fixed-point pose coordinates. */
export function framePosition(frame: LivingSpatialFrame, coordinates: readonly string[]): number[] {
  const scale = 10 ** frame.unit.fractionalDigits;
  return coordinates.map((value) => Number(value) / scale);
}
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
  /** The entity's committed movement record (segment start and end), absent without one. */
  readonly movement?: string;
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
export function pickOrder(
  projection: Pick<SceneProjection, "frames" | "entities"> &
    Partial<Pick<SceneProjection, "movements">>,
) {
  const frames = new Map(projection.frames.map((frame) => [frame.frameId, frame]));
  const movements = new Map(
    (projection.movements ?? []).map((movement) => [
      movement.objectId,
      `${movement.startedAt}:${movement.endedAt ?? "active"}`,
    ]),
  );
  const placed: ScenePlacement[] = [];
  for (const entity of projection.entities) {
    const at = poseMetres(frames, entity.pose);
    if (!at) continue;
    const movement = movements.get(entity.objectId);
    placed.push({
      ...(movement === undefined ? {} : { movement }),
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
  const metres = metresPerUnit(frame.unit.name);
  if (metres === undefined) return undefined;
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
/** The canonical day, for a pack that declares no day length (as the runtime's wake triage). */
export const CANONICAL_DAY_MS = 86_400_000n;
/**
 * Night is before 06:00 or from 18:00 on the HUD's 24-hour face, which scales the pack's day
 * length: the first and the last quarter of each day.
 */
export function isNight(simulationTime: bigint, dayLengthMs = CANONICAL_DAY_MS): boolean {
  const time = simulationTime % dayLengthMs;
  return time * 4n < dayLengthMs || time * 4n >= 3n * dayLengthMs;
}
/** The effects shown now, decided from the committed projection and the pack's day length. */
export function shownEffects(
  projection: Pick<SceneProjection, "effects" | "weather" | "simulationTime" | "lighting">,
  dayLengthMs?: bigint,
): SceneEffect[] {
  const raining = projection.weather.rainIntensity > 0;
  const night = isNight(projection.simulationTime, dayLengthMs);
  return (projection.effects ?? []).filter((effect) =>
    effect.role === "puddle"
      ? raining
      : projection.lighting?.environment === undefined
        ? night
        : projection.lighting.environment.daylight < 1,
  );
}
/** The text path's description of the same conditions the canvas draws. */
export function effectsText(
  projection: Pick<SceneProjection, "effects" | "weather" | "simulationTime" | "lighting">,
  dayLengthMs?: bigint,
): { puddles: string; lights: string } {
  const shown = shownEffects(projection, dayLengthMs);
  const puddles = shown.filter((effect) => effect.role === "puddle").length;
  const lit = (["lantern", "window"] as const).filter((role) =>
    shown.some((effect) => effect.role === role),
  );
  return {
    puddles: puddles > 0 ? String(puddles) : "none",
    lights: lit.length > 0 ? `${lit.join(", ")} lit` : "off",
  };
}
/**
 * Whether a committed move is drawn walking (interpolated) or as a cut (a snap): it walks, whatever
 * its length, when the entity's movement carried it, that is when the movement is still active or
 * changed between the two projections. A teleport, a respawn or a change of frame cuts.
 */
export function movement(from: ScenePlacement, to: ScenePlacement): "interpolate" | "snap" {
  if (from.frame !== to.frame || to.movement === undefined) return "snap";
  return to.movement.endsWith(":active") || to.movement !== from.movement ? "interpolate" : "snap";
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

/**
 * A zone's sentence once its most recent marker may have left: the runtime ends a sentence naming
 * that marker with "; most recently by <label>." (its presentation binding's label, else its scene
 * label), and a client whose patch removed the marker drops that clause, as the next
 * `set_surfaces` would.
 */
function unnamedSentence(
  zone: SceneSurfaceZone,
  entities: ReadonlyMap<string, unknown>,
  before: SceneProjection,
): string | null {
  const marker = zone.marks.at(-1)?.actorId ?? null;
  if (zone.sentence === null || marker === null || entities.has(marker)) return zone.sentence;
  const labels = [
    before.presentationBindings.find((binding) => binding.objectId === marker)?.accessibilityLabel,
    before.entities.find((entity) => entity.objectId === marker)?.presentation.label,
    marker,
  ];
  for (const label of labels) {
    const clause = `; most recently by ${label}.`;
    if (label !== undefined && zone.sentence.endsWith(clause)) {
      return `${zone.sentence.slice(0, -clause.length)}.`;
    }
  }
  return zone.sentence;
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
  let movements = scene.movements;
  let surfaces = scene.surfaces;
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
      case "set_movements":
        movements = operation.movements;
        break;
      case "set_surfaces":
        surfaces = operation.surfaces ?? undefined;
        break;
    }
  }
  const {
    privateCognition: _previous,
    effects: _effects,
    lighting: _lighting,
    movements: _movements,
    surfaces: _surfaces,
    ...rest
  } = scene;
  const moving = movements?.filter((movement) => entities.has(movement.objectId));
  return decodeSceneProjection({
    ...rest,
    ...(privateCognition && {
      privateCognition: privateCognition.filter((entry) => entities.has(entry.actorId)),
    }),
    ...(effects && { effects }),
    ...(lighting && { lighting }),
    ...(moving && moving.length > 0 && { movements: moving }),
    // A zone on an object the patch removed leaves the scene with it; a removed marker is unnamed,
    // in its marks and in the sentence.
    ...(surfaces && {
      surfaces: {
        ...surfaces,
        zones: surfaces.zones
          .filter((zone) => zone.host.kind === "region" || entities.has(zone.host.objectId))
          .map((zone) => ({
            ...zone,
            marks: zone.marks.map((mark) =>
              mark.actorId === null || entities.has(mark.actorId)
                ? mark
                : { ...mark, actorId: null },
            ),
            sentence: unnamedSentence(zone, entities, scene),
          })),
      },
    }),
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

/** Decision (plan assumption 35, issue 267): decals show at camera zoom >= 1.5, between default 1 and default max 2. */
export const CLOSE_RANGE_ZOOM = 1.5;

/**
 * Issue 267: a point (u, v in 0..1) of an object-hosted zone's floor ellipse, in scene units, before
 * the renderer's decal lift. The ellipse is centred on the object's foot (x, y screen, z its depth) and
 * spans `span` across, half that down the screen. The tilted floor gains √3 of depth per unit down the
 * screen, so a point below the centre sits that much nearer the camera and stays on the floor.
 */
export function objectSurfacePoint(
  shape: { readonly x: number; readonly y: number; readonly z: number; readonly span: number },
  u: number,
  v: number,
): [number, number, number] {
  const down = (v - 0.5) * shape.span * 0.5;
  return [shape.x + (u - 0.5) * shape.span, -shape.y - down, shape.z + Math.sqrt(3) * down];
}

/** One close-range mark decal (issue 267), derived from a projected mark and never stored. */
export interface SurfaceDecal {
  readonly actorId: ObjectId | null;
  readonly at: bigint;
  readonly u: number;
  readonly v: number;
  /** Fraction of the zone's shorter side. */
  readonly length: number;
  /** Radians in [0, π), derived from the seed, zone and mark so replays draw the same scratch. */
  readonly angle: number;
  readonly opacity: number;
  readonly tint: string;
}

/** One band's tint over a zone at a tier (issue 267). */
export interface SurfaceLayer {
  readonly channel: string;
  readonly band: string;
  readonly tint: string;
  readonly opacity: number;
}

/** One zone's derived look (issue 267): its tint layers and its decals, newest mark first. */
export interface SurfaceZoneLook {
  readonly zoneId: string;
  readonly host: SceneSurfaceHost;
  readonly layers: readonly SurfaceLayer[];
  readonly decals: readonly SurfaceDecal[];
}

/** A scene's derived surface look at a tier (issue 267); withheld decals are counted, never dropped silently. */
export interface SurfaceLook {
  readonly tier: SurfaceTier;
  readonly zones: readonly SurfaceZoneLook[];
  readonly budget: number;
  readonly withheld: number;
}

/** FNV-1a 32-bit over the string's UTF-16 code units. */
function fnv1a32(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619) >>> 0;
  return hash;
}

/**
 * The look of a scene's surfaces at a tier (issue 267): derived from the projection, the tier and the
 * scope seed alone, never stored, so any renderer replaying the same projection draws the same look.
 */
export function surfaceLook(surfaces: SceneSurfaces, tier: SurfaceTier, seed: string): SurfaceLook {
  const budget = surfaces.decals[tier];
  let drawn = 0;
  let withheld = 0;
  const zones: SurfaceZoneLook[] = [];
  for (const zone of surfaces.zones) {
    const layers = zone.treatments
      .filter((t) => t.tiers[tier].opacity > 0)
      .map((t) => ({
        channel: t.channel,
        band: t.band,
        tint: t.tiers[tier].tint,
        opacity: t.tiers[tier].opacity,
      }));
    const marking = zone.treatments.filter((t) => t.tiers[tier].marks).at(-1);
    const decals: SurfaceDecal[] = [];
    if (marking) {
      const tint = marking.tiers[tier].tint;
      for (const mark of [...zone.marks].reverse()) {
        if (drawn >= budget) {
          withheld++;
          continue;
        }
        drawn++;
        const { u, v } = mark.point;
        decals.push({
          actorId: mark.actorId,
          at: mark.at,
          u: u / 10000,
          v: v / 10000,
          length: 0.04 + (0.08 * mark.intensity) / 10000,
          angle:
            (fnv1a32(`${seed}\u0000${zone.zoneId}\u0000${mark.at}\u0000${u}\u0000${v}`) / 2 ** 32) *
            Math.PI,
          opacity: 0.35 + (0.65 * mark.intensity) / 10000,
          tint,
        });
      }
    }
    if (layers.length > 0 || decals.length > 0)
      zones.push({ zoneId: zone.zoneId, host: zone.host, layers, decals });
  }
  return { tier, zones, budget, withheld };
}

/** Each zone's non-null text-path sentence (issue 267), in zone order. */
export function surfaceSentences(
  surfaces: SceneSurfaces | undefined,
): readonly { readonly zoneId: string; readonly sentence: string }[] {
  return (surfaces?.zones ?? []).flatMap((zone) =>
    zone.sentence === null ? [] : [{ zoneId: zone.zoneId, sentence: zone.sentence }],
  );
}
