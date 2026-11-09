// The one reference hall slice every candidate draws: the committed projection, the two lighting
// patches, the shared light rig and the shared camera. Candidates read only these, never their own copy.
import {
  decodeScenePatch,
  decodeSceneProjection,
  type SceneEffect,
  type ScenePatch,
  type SceneProjection,
} from "@clockgrove/contracts";
import { isNight, poseMetres, shownEffects } from "../../../../apps/web/src/world-scene-adapter.js";
import type { CameraState } from "../contract.js";
import type { AssetId } from "./materials.js";

const DAY = 86_400_000;
const HOUR = 3_600_000;
/**
 * Dusk in rain: 18:15 of day 1, just after the 18:00 night rule (`isNight`) lights the lantern and the
 * window, as the reference mockup's dusk in rain shows them lit.
 */
export const DUSK_TIME = DAY + 18.25 * HOUR;
/** Night: 22:00 of day 1, lighter rain. */
export const NIGHT_TIME = DAY + 22 * HOUR;
export const DUSK_RAIN = 8_000;
export const NIGHT_RAIN = 3_000;

const pose = (x: number, y: number, z: number) => ({
  frameId: "hall-frame",
  frameVersion: 1,
  coordinates: [String(x), String(y), String(z)],
});
const effect = (role: SceneEffect["role"], assetId: string, at: [number, number, number]) => ({
  role,
  assetId,
  animationFamily: "loop",
  pose: pose(...at),
});

/** The committed snapshot: dusk in rain, Keeper between a lantern post and a shrub before the house. */
export const SNAPSHOT: SceneProjection = decodeSceneProjection({
  tenantId: "tenant-bakeoff",
  worldId: "world-bakeoff",
  timelineId: "timeline-bakeoff",
  spaceId: "hall",
  privacyClass: "public_scene",
  compatibility: { projectionVersion: 2, assetManifestVersion: 1, clientVersion: 1 },
  revision: "1",
  simulationTime: String(DUSK_TIME),
  weather: { rainIntensity: DUSK_RAIN },
  hierarchy: [{ spaceId: "hall", label: "Hall" }],
  frames: [
    {
      frameId: "hall-frame",
      version: 1,
      dimensions: 3,
      unit: { name: "millimetre", fractionalDigits: 0 },
      axes: {
        axes: [
          { name: "x", positiveDirection: "east" },
          { name: "y", positiveDirection: "north" },
          { name: "z", positiveDirection: "up" },
        ],
      },
      origin: ["0", "0", "0"],
      gravity: { kind: "constant-vector", vector: ["0", "0", "-9800"] },
    },
  ],
  entities: [
    {
      objectId: "keeper",
      archetypeId: "resident",
      pose: pose(0, 0, 0),
      presentation: { kind: "placeholder", label: "Keeper" },
    },
    {
      objectId: "lantern-post",
      archetypeId: "lantern",
      pose: pose(1_600, 900, 0),
      presentation: { kind: "placeholder", label: "Lantern post" },
    },
    {
      objectId: "shrub",
      archetypeId: "shrub",
      pose: pose(-1_500, 600, 0),
      presentation: { kind: "placeholder", label: "Shrub" },
    },
  ],
  presentationBindings: [
    {
      objectId: "keeper",
      assetId: "keeper",
      animationFamily: "idle",
      accessibilityLabel: "Keeper",
    },
    {
      objectId: "lantern-post",
      assetId: "lantern-post",
      animationFamily: "static",
      accessibilityLabel: "Lantern post",
    },
    { objectId: "shrub", assetId: "shrub", animationFamily: "sway", accessibilityLabel: "Shrub" },
  ],
  interactions: [],
  feedCursor: "feed-1",
  audienceHash: "audience-bakeoff",
  effects: [
    effect("lantern", "lantern-glow", [1_600, 900, 1_700]),
    effect("window", "window-glow", [-400, 2_900, 1_400]),
    effect("puddle", "puddle", [700, -700, 0]),
    effect("puddle", "puddle", [-900, -300, 0]),
  ],
});

/** The committed patch from dusk to night, applied through the adapter's own `applyPatch`. */
export const TO_NIGHT: ScenePatch = decodeScenePatch({
  fromRevision: "1",
  toRevision: "2",
  operations: [
    { op: "set_clock", simulationTime: String(NIGHT_TIME) },
    { op: "set_weather", weather: { rainIntensity: NIGHT_RAIN } },
  ],
  sourceEventIds: ["event-nightfall"],
  audienceHash: "audience-bakeoff",
});

/** The lighting states, in the measured order. */
export const LIGHTING_STATES = ["dusk-rain", "night"] as const;
export type LightingState = (typeof LIGHTING_STATES)[number];

/** A drawn sprite: a camera-facing upright quad standing on the ground at its pose. */
export interface SpritePlacement {
  readonly objectId: string;
  readonly assetId: AssetId;
  /** Ground position in metres of the hall frame (x east, y north, z up). */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Quad size in metres; the quad's bottom centre sits on the pose. */
  readonly width: number;
  readonly height: number;
}
/** The fixed environment: a ground plane and the house wall that holds the window. */
export const GROUND = { assetId: "ground" as AssetId, centreX: 0, centreY: 0, width: 9, depth: 7 };
/** The wall faces south along y = WALL.y, spanning x from WALL.x0 to WALL.x1, WALL.height tall. */
export const WALL = { assetId: "house-wall" as AssetId, y: 3, x0: -4.5, x1: 4.5, height: 3.2 };

const SIZES: Readonly<Record<string, readonly [number, number]>> = {
  keeper: [0.9, 0.9],
  "lantern-post": [0.5, 2.0],
  shrub: [1.4, 1.3],
};

/** Every entity with a known asset, far to near (draw order); the candidates' depth order agrees. */
export function spritesOf(projection: SceneProjection): SpritePlacement[] {
  const frames = new Map(projection.frames.map((frame) => [frame.frameId, frame]));
  const bindings = new Map(projection.presentationBindings.map((b) => [b.objectId, b.assetId]));
  const sprites: SpritePlacement[] = [];
  for (const entity of projection.entities) {
    const at = poseMetres(frames, entity.pose);
    const assetId = bindings.get(entity.objectId);
    const size = assetId ? SIZES[assetId] : undefined;
    if (!at || !assetId || !size) continue;
    sprites.push({
      objectId: entity.objectId,
      assetId: assetId as AssetId,
      x: at.x,
      y: at.y,
      z: at.z,
      width: size[0],
      height: size[1],
    });
  }
  return sprites.sort((a, b) => a.x - a.y - (b.x - b.y));
}

export interface PointLightSpec {
  readonly role: "lantern" | "window";
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Linear RGB, 0..1. */
  readonly color: readonly [number, number, number];
  readonly intensity: number;
  /** Metres at which the light has faded to nothing. */
  readonly range: number;
  /** Relative flicker amplitude (0 = steady); frozen under reduced motion. */
  readonly flicker: number;
}
export interface Puddle {
  readonly x: number;
  readonly y: number;
  /** Radii in metres along x and y. */
  readonly rx: number;
  readonly ry: number;
}
/** Everything about the light and weather, decided from the committed projection alone. */
export interface LightRig {
  readonly state: LightingState;
  readonly ambient: {
    readonly color: readonly [number, number, number];
    readonly intensity: number;
  };
  /** The low sky light: direction it travels (towards the ground), colour and intensity. */
  readonly sky: {
    readonly direction: readonly [number, number, number];
    readonly color: readonly [number, number, number];
    readonly intensity: number;
  };
  readonly fog: {
    readonly color: readonly [number, number, number];
    /** Exponential fog density per metre of view depth. */
    readonly density: number;
  };
  /** 0..1, from the projection's basis points. */
  readonly rain: number;
  /** Wind strength 0..1 for foliage and rain slant. */
  readonly wind: number;
  readonly lights: readonly PointLightSpec[];
  readonly puddles: readonly Puddle[];
  /** Surface wetness 0..1 applied through the wetness maps. */
  readonly wetness: number;
  readonly clearColor: readonly [number, number, number];
}

const LIGHT_STYLE: Readonly<
  Record<"lantern" | "window", Omit<PointLightSpec, "role" | "x" | "y" | "z">>
> = {
  lantern: { color: [1.0, 0.62, 0.28], intensity: 2.4, range: 5.5, flicker: 0.08 },
  window: { color: [1.0, 0.78, 0.45], intensity: 1.6, range: 4.5, flicker: 0 },
};

/** The spike's own sky rule: a dusk sky until 20:00, a night sky from then until 06:00. */
const DARK_FROM_HOUR = 20;

export function lightRigOf(projection: SceneProjection): LightRig {
  const frames = new Map(projection.frames.map((frame) => [frame.frameId, frame]));
  // Lanterns and windows follow the product's night rule (from 18:00, through shownEffects); the sky
  // stays a dusk sky until DARK_FROM_HOUR, so dusk in rain is lit as the reference mockup shows it.
  const hour = Number(projection.simulationTime % BigInt(DAY)) / HOUR;
  const night = isNight(projection.simulationTime) && (hour >= DARK_FROM_HOUR || hour < 6);
  const rain = projection.weather.rainIntensity / 10_000;
  const lights: PointLightSpec[] = [];
  const puddles: Puddle[] = [];
  for (const shown of shownEffects(projection)) {
    const at = poseMetres(frames, shown.pose);
    if (!at) continue;
    if (shown.role === "puddle") puddles.push({ x: at.x, y: at.y, rx: 0.9, ry: 0.55 });
    else lights.push({ role: shown.role, x: at.x, y: at.y, z: at.z, ...LIGHT_STYLE[shown.role] });
  }
  return night
    ? {
        state: "night",
        ambient: { color: [0.32, 0.38, 0.62], intensity: 0.22 },
        sky: { direction: [-0.3, 0.5, -0.8], color: [0.55, 0.62, 0.9], intensity: 0.25 },
        fog: { color: [0.06, 0.07, 0.12], density: 0.05 },
        rain,
        wind: 0.35,
        lights,
        puddles,
        wetness: Math.min(1, 0.4 + rain),
        clearColor: [0.03, 0.035, 0.07],
      }
    : {
        state: "dusk-rain",
        ambient: { color: [0.55, 0.52, 0.62], intensity: 0.45 },
        sky: { direction: [0.6, 0.4, -0.45], color: [1.0, 0.6, 0.42], intensity: 0.75 },
        fog: { color: [0.42, 0.4, 0.46], density: 0.08 },
        rain,
        wind: 0.6,
        lights,
        puddles,
        wetness: Math.min(1, 0.4 + rain),
        clearColor: [0.36, 0.33, 0.4],
      };
}

/** Pixels per metre at zoom 1. */
export const PIXELS_PER_METRE = 96;
/** The camera's elevation above the ground plane; it looks from the south-east (x − y is nearer). */
export const CAMERA_ELEVATION_DEGREES = 30;
/** The fixed camera sequence: a start, a pan east and a closer zoom (shared by every candidate). */
export const CAMERA_PATH: readonly CameraState[] = [
  { panX: 0, panY: 0.5, zoom: 1 },
  { panX: 0.8, panY: 0.5, zoom: 1 },
  { panX: 0.3, panY: 0.3, zoom: 1.35 },
];
export const SCREENSHOT_CAMERA: CameraState = { panX: 0, panY: 0.5, zoom: 1 };

/**
 * The shared projection from hall metres to canvas pixels. A 3D candidate's orthographic camera
 * reproduces it: right = (x + y)/√2, up = z·cos(e) + (y − x)/√2·sin(e), depth = x − y (nearer is larger).
 */
export function isoProject(
  x: number,
  y: number,
  z: number,
  camera: CameraState,
  width: number,
  height: number,
): { sx: number; sy: number; depth: number } {
  const e = (CAMERA_ELEVATION_DEGREES * Math.PI) / 180;
  const scale = PIXELS_PER_METRE * camera.zoom;
  const right = (x - camera.panX + (y - camera.panY)) / Math.SQRT2;
  const up = z * Math.cos(e) + ((y - camera.panY - (x - camera.panX)) / Math.SQRT2) * Math.sin(e);
  return { sx: width / 2 + right * scale, sy: height / 2 - up * scale, depth: x - y };
}
