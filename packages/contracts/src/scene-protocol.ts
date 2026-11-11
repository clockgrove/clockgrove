import type {
  BrowserScope,
  LivingEntity,
  LivingPose,
  LivingSpatialFrame,
  LivingWeather,
} from "./browser-protocol.js";
import {
  decodeBrowserScope,
  decodeLivingEntity,
  decodeLivingFrame,
  decodeLivingPose,
  decodeLivingScene,
  decodeLivingWeather,
} from "./browser-protocol.js";
import type { EventId, ObjectId, PrincipalId, SpaceId } from "./ids.js";
import { decodeOpaqueId } from "./ids.js";
import { decodeMaterialChannels } from "./material.js";
import type { InteractionSummary } from "./scene-interactions.js";
import { decodeInteractionSummary } from "./scene-interactions.js";
import {
  array,
  ContractDecodeError,
  exactKeys,
  integer,
  literal,
  nonNegativeInteger,
  record,
  string,
  unsignedDecimal,
  utcInstantKey,
  utcTimestamp,
  w3cTraceparent,
} from "./validation.js";

/** Successor freeze versions are independent of diagnostic v1 and HTTP LivingScene v1. */
export const SCENE_PROTOCOL_VERSION = 1;
/**
 * Projection version 2 adds `SceneProjection.effects` and the `set_effects` patch operation, which
 * strict version-1 decoders reject. Decoders accept the current version and the one prior version;
 * a version-1 projection carries neither.
 */
export const SCENE_PROJECTION_VERSION = 2;
export const SCENE_PRIOR_PROJECTION_VERSION = 1;
export const SCENE_ASSET_MANIFEST_VERSION = 2;
export const SCENE_CLIENT_VERSION = 1;
/**
 * Material delivery version. Version 2 delivers compressed pages as KTX2 (`ktx2-uastc`); version 1
 * delivered BC3 DDS and is refused with `unsupported_material_version`.
 */
export const SCENE_MATERIAL_VERSION = 2;
export type SceneLane = "projection" | "transient" | "operator";
export interface SceneEnvelope<T> extends BrowserScope {
  readonly protocolVersion: number;
  readonly messageId: string;
  readonly lane: SceneLane;
  readonly type: string;
  readonly projectionRevision?: bigint;
  readonly sentAt: string;
  readonly traceparent?: string;
  readonly payload: T;
}
export interface SceneCompatibility {
  readonly projectionVersion:
    | typeof SCENE_PRIOR_PROJECTION_VERSION
    | typeof SCENE_PROJECTION_VERSION;
  readonly assetManifestVersion: 2;
  readonly clientVersion: 1;
}
export type SceneCompatibilityCode =
  | "unsupported_protocol_version"
  | "unsupported_projection_version"
  | "unsupported_asset_manifest_version"
  | "unsupported_client_version"
  | "unsupported_material_version";
export class SceneCompatibilityError extends ContractDecodeError {
  constructor(
    readonly code: SceneCompatibilityCode,
    readonly actual: unknown,
    readonly expected: number,
    path: string,
  ) {
    super(
      path,
      `${code}; actual=${JSON.stringify(actual, (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item))}; expected=${expected}`,
    );
    this.name = "SceneCompatibilityError";
  }
}
export function decodeSceneCompatibility(
  value: unknown,
  path = "compatibility",
): SceneCompatibility {
  const v = record(value, path);
  // Versions are checked before shape, so a newer peer that also adds or drops fields still
  // receives its stable compatibility code. An absent version is malformed, not newer, and
  // falls through to the generic missing-field error.
  if (
    "projectionVersion" in v &&
    v.projectionVersion !== SCENE_PROJECTION_VERSION &&
    v.projectionVersion !== SCENE_PRIOR_PROJECTION_VERSION
  )
    throw new SceneCompatibilityError(
      "unsupported_projection_version",
      v.projectionVersion,
      SCENE_PROJECTION_VERSION,
      `${path}.projectionVersion`,
    );
  if ("assetManifestVersion" in v && v.assetManifestVersion !== SCENE_ASSET_MANIFEST_VERSION)
    throw new SceneCompatibilityError(
      "unsupported_asset_manifest_version",
      v.assetManifestVersion,
      SCENE_ASSET_MANIFEST_VERSION,
      `${path}.assetManifestVersion`,
    );
  if ("clientVersion" in v && v.clientVersion !== SCENE_CLIENT_VERSION)
    throw new SceneCompatibilityError(
      "unsupported_client_version",
      v.clientVersion,
      SCENE_CLIENT_VERSION,
      `${path}.clientVersion`,
    );
  exactKeys(v, ["projectionVersion", "assetManifestVersion", "clientVersion"], [], path);
  return {
    projectionVersion: v.projectionVersion === SCENE_PRIOR_PROJECTION_VERSION ? 1 : 2,
    assetManifestVersion: 2,
    clientVersion: 1,
  };
}
export interface SceneAudience {
  readonly kind: "observer";
  readonly hash: string;
  readonly spaceIds: readonly SpaceId[];
}
export function decodeSceneAudience(value: unknown, path = "audience"): SceneAudience {
  const v = record(value, path);
  exactKeys(v, ["kind", "hash", "spaceIds"], [], path);
  return {
    kind: literal(v.kind, ["observer"], `${path}.kind`),
    hash: string(v.hash, `${path}.hash`),
    spaceIds: array(v.spaceIds, `${path}.spaceIds`, (item, p) =>
      decodeOpaqueId(item, "SpaceId", p),
    ),
  };
}
export interface VisibleSpace {
  readonly spaceId: SpaceId;
  readonly label: string;
  readonly parentSpaceId?: SpaceId;
}
export interface SceneMaterialTexture {
  readonly encoding?: "srgb" | "linear";
  readonly pages?: readonly {
    readonly atlasId: string;
    readonly image: SceneMaterialTexture["image"];
    readonly compressed: SceneMaterialTexture["compressed"];
  }[];
  readonly image: {
    readonly sha256: string;
    readonly width: number;
    readonly height: number;
    readonly bytes: number;
  };
  readonly compressed: {
    readonly sha256: string;
    readonly format: "ktx2-uastc";
    readonly bytes: number;
  };
  readonly frames: readonly {
    readonly atlasId?: string;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  }[];
}
export interface SceneMaterialDelivery {
  readonly materialVersion: typeof SCENE_MATERIAL_VERSION;
  readonly renditions: readonly {
    readonly density: 1 | 2 | 4;
    readonly channels: import("./material.js").MaterialChannels<SceneMaterialTexture>;
  }[];
}
export function decodeSceneMaterialDelivery(
  value: unknown,
  path = "material",
): SceneMaterialDelivery {
  const atlasId = (value: unknown, p: string): string => {
    const id = string(value, p);
    if (!/^[a-z0-9-]+$/u.test(id)) throw new ContractDecodeError(p, "expected atlas basename");
    return id;
  };
  const v = record(value, path);
  // Checked before shape, as projection versions are, so another version gets its stable code.
  if ("materialVersion" in v && v.materialVersion !== SCENE_MATERIAL_VERSION)
    throw new SceneCompatibilityError(
      "unsupported_material_version",
      v.materialVersion,
      SCENE_MATERIAL_VERSION,
      `${path}.materialVersion`,
    );
  exactKeys(v, ["materialVersion", "renditions"], [], path);
  const renditions = array(v.renditions, `${path}.renditions`, (value, p) => {
    const r = record(value, p);
    exactKeys(r, ["density", "channels"], [], p);
    const density = integer(r.density, `${p}.density`);
    if (density !== 1 && density !== 2 && density !== 4)
      throw new ContractDecodeError(`${p}.density`, "expected density 1, 2 or 4");
    const channels = decodeMaterialChannels(
      r.channels,
      `${p}.channels`,
      (value, p): SceneMaterialTexture => {
        const t = record(value, p);
        exactKeys(t, ["image", "compressed", "frames"], ["pages", "encoding"], p);
        const image = record(t.image, `${p}.image`),
          compressed = record(t.compressed, `${p}.compressed`);
        exactKeys(image, ["sha256", "width", "height", "bytes"], [], `${p}.image`);
        exactKeys(compressed, ["sha256", "format", "bytes"], [], `${p}.compressed`);
        const hash = (value: unknown, p: string): string => {
          const h = string(value, p);
          if (!/^[0-9a-f]{64}$/u.test(h)) throw new ContractDecodeError(p, "expected SHA-256");
          return h;
        };
        const positive = (value: unknown, p: string): number => {
          const n = nonNegativeInteger(value, p);
          if (n === 0) throw new ContractDecodeError(p, "expected positive integer");
          return n;
        };
        const width = positive(image.width, `${p}.image.width`),
          height = positive(image.height, `${p}.image.height`);
        const pages =
          t.pages === undefined
            ? undefined
            : array(t.pages, `${p}.pages`, (value, p) => {
                const page = record(value, p);
                exactKeys(page, ["atlasId", "image", "compressed"], [], p);
                const image = record(page.image, `${p}.image`),
                  compressed = record(page.compressed, `${p}.compressed`);
                exactKeys(image, ["sha256", "width", "height", "bytes"], [], `${p}.image`);
                exactKeys(compressed, ["sha256", "format", "bytes"], [], `${p}.compressed`);
                return {
                  atlasId: atlasId(page.atlasId, `${p}.atlasId`),
                  image: {
                    sha256: hash(image.sha256, `${p}.image.sha256`),
                    width: positive(image.width, `${p}.image.width`),
                    height: positive(image.height, `${p}.image.height`),
                    bytes: positive(image.bytes, `${p}.image.bytes`),
                  },
                  compressed: {
                    sha256: hash(compressed.sha256, `${p}.compressed.sha256`),
                    format: literal(compressed.format, ["ktx2-uastc"], `${p}.compressed.format`),
                    bytes: positive(compressed.bytes, `${p}.compressed.bytes`),
                  },
                };
              });
        if (pages && new Set(pages.map((page) => page.atlasId)).size !== pages.length)
          throw new ContractDecodeError(p, "duplicate texture page");
        return {
          ...(pages === undefined ? {} : { pages }),
          ...(t.encoding === undefined
            ? {}
            : { encoding: literal(t.encoding, ["srgb", "linear"], `${p}.encoding`) }),
          image: {
            sha256: hash(image.sha256, `${p}.image.sha256`),
            width,
            height,
            bytes: positive(image.bytes, `${p}.image.bytes`),
          },
          compressed: {
            sha256: hash(compressed.sha256, `${p}.compressed.sha256`),
            format: literal(compressed.format, ["ktx2-uastc"], `${p}.compressed.format`),
            bytes: positive(compressed.bytes, `${p}.compressed.bytes`),
          },
          frames: array(t.frames, `${p}.frames`, (value, p) => {
            const f = record(value, p);
            exactKeys(f, ["x", "y", "width", "height"], ["atlasId"], p);
            const x = nonNegativeInteger(f.x, `${p}.x`),
              y = nonNegativeInteger(f.y, `${p}.y`);
            const fw = positive(f.width, `${p}.width`),
              fh = positive(f.height, `${p}.height`);
            if (t.pages === undefined && (x + fw > width || y + fh > height))
              throw new ContractDecodeError(p, "frame exceeds texture bounds");
            return {
              x,
              y,
              width: fw,
              height: fh,
              ...(f.atlasId === undefined ? {} : { atlasId: atlasId(f.atlasId, `${p}.atlasId`) }),
            };
          }),
        };
      },
    );
    return { density: density as 1 | 2 | 4, channels };
  });
  if (
    renditions[0]?.density !== 1 ||
    renditions[1]?.density !== 2 ||
    renditions.some((r, i) => i > 0 && r.density <= renditions[i - 1]!.density)
  )
    throw new ContractDecodeError(path, "expected sorted unique densities 1, 2 and optional 4");
  for (const rendition of renditions)
    for (const texture of Object.values(rendition.channels)) {
      if (!texture.pages) continue;
      for (const frame of texture.frames) {
        const page = texture.pages.find((page) => page.atlasId === frame.atlasId);
        if (
          !page ||
          frame.x + frame.width > page.image.width ||
          frame.y + frame.height > page.image.height
        )
          throw new ContractDecodeError(path, "frame exceeds texture page bounds");
      }
    }
  const keys = Object.keys(renditions[0]!.channels).join(",");
  const count = renditions[0]!.channels.albedo.frames.length;
  if (
    !count ||
    renditions.some(
      (r) =>
        Object.keys(r.channels).join(",") !== keys ||
        Object.values(r.channels).some((t) => t.frames.length !== count),
    )
  )
    throw new ContractDecodeError(path, "expected matching channels and frame counts");
  for (const rendition of renditions) {
    const albedo = rendition.channels.albedo;
    for (const texture of Object.values(rendition.channels))
      texture.frames.forEach((frame, index) => {
        const reference = albedo.frames[index]!;
        if (frame.width !== reference.width || frame.height !== reference.height)
          throw new ContractDecodeError(path, "channels must share frame dimensions");
        const base = renditions[0]!.channels.albedo.frames[index]!;
        if (
          frame.width !== base.width * rendition.density ||
          frame.height !== base.height * rendition.density
        )
          throw new ContractDecodeError(path, "rendition frame dimensions must scale by density");
      });
  }
  return { materialVersion: SCENE_MATERIAL_VERSION, renditions };
}
export interface SceneLighting {
  readonly directional: readonly {
    readonly kind: "sun" | "moon";
    readonly direction: readonly [number, number, number];
    readonly colour: string;
    readonly intensity: number;
  }[];
  readonly placed: readonly {
    readonly kind: "lantern" | "window";
    readonly pose: LivingPose;
    readonly colour: string;
    readonly intensity: number;
    readonly rangeMetres: number;
  }[];
  readonly weatherIntensity: number;
  readonly gradingKey: string;
  readonly environment?: {
    readonly daylight: number;
    readonly ambientColour: string;
    readonly ambientIntensity: number;
    readonly backgroundColour: string;
    readonly fogColour: string;
    readonly gradeColour: string;
  };
}
/** Default presentation policy for #184: a canonical 24-hour cycle with two-hour
 * dawn/dusk transitions centred on 06:00/18:00. No wall-clock time enters the rig. */
export function defaultSceneLighting(
  simulationTime: bigint,
  weather: { readonly rainIntensity: number },
  effects: readonly SceneEffect[],
): SceneLighting {
  const day = 86_400_000n;
  const phase = Number(((simulationTime % day) + day) % day) / Number(day);
  const angle = phase * Math.PI * 2 - Math.PI / 2;
  const direction: [number, number, number] = [Math.cos(angle), 0, -Math.sin(angle)];
  const horizon = Math.sin(Math.PI / 12);
  const t = Math.max(0, Math.min(1, (Math.sin(angle) + horizon) / (2 * horizon)));
  const daylight = t * t * (3 - 2 * t);
  const twilight = 4 * daylight * (1 - daylight);
  const mix = (from: string, to: string, amount: number): string => {
    const channels = [1, 3, 5].map((offset) => {
      const a = Number.parseInt(from.slice(offset, offset + 2), 16);
      const b = Number.parseInt(to.slice(offset, offset + 2), 16);
      return Math.round(a + (b - a) * amount)
        .toString(16)
        .padStart(2, "0");
    });
    return `#${channels.join("")}`;
  };
  return {
    directional: [
      {
        kind: "sun",
        direction,
        colour: mix("#fff1d6", "#ff9966", twilight),
        intensity: Math.PI * daylight,
      },
      {
        kind: "moon",
        direction: direction.map((v) => -v) as [number, number, number],
        colour: "#cbdcff",
        intensity: Math.PI * 0.25 * (1 - daylight),
      },
    ],
    placed: effects.flatMap((effect) =>
      effect.role === "puddle"
        ? []
        : [
            {
              kind: effect.role,
              pose: effect.pose,
              colour: "#ffb966",
              intensity: 1500 * (1 - daylight),
              rangeMetres: 14.4,
            },
          ],
    ),
    weatherIntensity: weather.rainIntensity / 10_000,
    gradingKey:
      daylight === 0
        ? "night"
        : daylight === 1
          ? weather.rainIntensity > 0
            ? "overcast"
            : "day"
          : phase < 0.5
            ? "dawn"
            : "dusk",
    environment: {
      daylight,
      ambientColour: mix("#9caeca", "#ffffff", daylight),
      ambientIntensity: Math.PI * (0.4 + 0.6 * daylight),
      backgroundColour: mix("#192b20", "#3f6b3a", daylight),
      fogColour: mix("#25334c", "#43534b", daylight),
      gradeColour: mix(mix("#d6dfff", "#ffffff", daylight), "#ffd6b0", twilight),
    },
  };
}
export function decodeSceneLighting(value: unknown, path = "lighting"): SceneLighting {
  const v = record(value, path);
  exactKeys(v, ["directional", "placed", "weatherIntensity", "gradingKey"], ["environment"], path);
  const number = (value: unknown, p: string, min = 0, max = Number.MAX_VALUE): number => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)
      throw new ContractDecodeError(p, "expected finite number within range");
    return value;
  };
  const colour = (value: unknown, p: string): string => {
    const c = string(value, p);
    if (!/^#[0-9a-f]{6}$/u.test(c)) throw new ContractDecodeError(p, "expected RGB hex colour");
    return c;
  };
  const environment =
    v.environment === undefined ? undefined : record(v.environment, `${path}.environment`);
  if (environment)
    exactKeys(
      environment,
      [
        "daylight",
        "ambientColour",
        "ambientIntensity",
        "backgroundColour",
        "fogColour",
        "gradeColour",
      ],
      [],
      `${path}.environment`,
    );
  return {
    ...(environment === undefined
      ? {}
      : {
          environment: {
            daylight: number(environment.daylight, `${path}.environment.daylight`, 0, 1),
            ambientColour: colour(environment.ambientColour, `${path}.environment.ambientColour`),
            ambientIntensity: number(
              environment.ambientIntensity,
              `${path}.environment.ambientIntensity`,
            ),
            backgroundColour: colour(
              environment.backgroundColour,
              `${path}.environment.backgroundColour`,
            ),
            fogColour: colour(environment.fogColour, `${path}.environment.fogColour`),
            gradeColour: colour(environment.gradeColour, `${path}.environment.gradeColour`),
          },
        }),
    directional: array(v.directional, `${path}.directional`, (value, p) => {
      const l = record(value, p);
      exactKeys(l, ["kind", "direction", "colour", "intensity"], [], p);
      const direction = array(l.direction, `${p}.direction`, (v, p) => number(v, p, -1, 1));
      // Decision: 1e-6 admits Float32 unit-vector roundoff while refusing non-normalized data.
      if (direction.length !== 3 || Math.abs(Math.hypot(...direction) - 1) > 0.000001)
        throw new ContractDecodeError(p, "expected unit direction vector");
      return {
        kind: literal(l.kind, ["sun", "moon"], `${p}.kind`),
        direction: direction as [number, number, number],
        colour: colour(l.colour, `${p}.colour`),
        intensity: number(l.intensity, `${p}.intensity`),
      };
    }),
    placed: array(v.placed, `${path}.placed`, (value, p) => {
      const l = record(value, p);
      exactKeys(l, ["kind", "pose", "colour", "intensity", "rangeMetres"], [], p);
      return {
        kind: literal(l.kind, ["lantern", "window"], `${p}.kind`),
        pose: decodeLivingPose(l.pose, `${p}.pose`),
        colour: colour(l.colour, `${p}.colour`),
        intensity: number(l.intensity, `${p}.intensity`),
        rangeMetres: number(l.rangeMetres, `${p}.rangeMetres`),
      };
    }),
    weatherIntensity: number(v.weatherIntensity, `${path}.weatherIntensity`, 0, 1),
    gradingKey: string(v.gradingKey, `${path}.gradingKey`),
  };
}
export interface ScenePresentationBinding {
  readonly objectId: ObjectId;
  readonly assetId: string;
  readonly animationFamily: string;
  readonly accessibilityLabel: string;
  readonly material?: SceneMaterialDelivery;
}
export type SceneProjectedEntity = LivingEntity;
/** The placed presentation effects the live scene may show; the client decides from weather and clock. */
export type SceneEffectRole = "puddle" | "lantern" | "window";
/** One placed effect of the installed pack's presentation, at a pose in a projected frame. */
export interface SceneEffect {
  readonly role: SceneEffectRole;
  readonly assetId: string;
  readonly animationFamily: string;
  readonly pose: LivingPose;
}
export function decodeSceneEffect(value: unknown, path = "effect"): SceneEffect {
  const v = record(value, path);
  exactKeys(v, ["role", "assetId", "animationFamily", "pose"], [], path);
  return {
    role: literal(v.role, ["puddle", "lantern", "window"], `${path}.role`),
    assetId: string(v.assetId, `${path}.assetId`),
    animationFamily: string(v.animationFamily, `${path}.animationFamily`),
    pose: decodeLivingPose(v.pose, `${path}.pose`),
  };
}
/**
 * A projected actor's scripted belief or memory about another object: relationship-private, so it is
 * present only in an audience whose ceiling allows `private_cognition`.
 */
export interface ScenePrivateCognition {
  readonly ref: string;
  readonly kind: "belief" | "memory";
  readonly actorId: ObjectId;
  readonly targetObjectId: ObjectId;
  readonly value: number;
}
export function decodeScenePrivateCognition(
  value: unknown,
  path = "cognition",
): ScenePrivateCognition {
  const v = record(value, path);
  exactKeys(v, ["ref", "kind", "actorId", "targetObjectId", "value"], [], path);
  return {
    ref: string(v.ref, `${path}.ref`),
    kind: literal(v.kind, ["belief", "memory"], `${path}.kind`),
    actorId: decodeOpaqueId(v.actorId, "ObjectId", `${path}.actorId`),
    targetObjectId: decodeOpaqueId(v.targetObjectId, "ObjectId", `${path}.targetObjectId`),
    value: integer(v.value, `${path}.value`),
  };
}
/** Distinct references, each held by a projected actor; never a hidden actor's cognition. */
function decodePrivateCognition(
  value: unknown,
  entities: readonly SceneProjectedEntity[],
  path: string,
): readonly ScenePrivateCognition[] {
  const projected = new Set(entities.map((entity) => entity.objectId));
  const refs = new Set<string>();
  return array(value, path, (item, p) => {
    const entry = decodeScenePrivateCognition(item, p);
    if (!projected.has(entry.actorId))
      throw new ContractDecodeError(`${p}.actorId`, "entity is not projected");
    if (refs.has(entry.ref)) throw new ContractDecodeError(`${p}.ref`, "duplicate reference");
    refs.add(entry.ref);
    return entry;
  });
}
export interface SceneProjection extends BrowserScope {
  readonly privacyClass: "public_scene";
  readonly compatibility: SceneCompatibility;
  readonly revision: bigint;
  readonly simulationTime: bigint;
  readonly weather: LivingWeather;
  readonly hierarchy: readonly VisibleSpace[];
  readonly frames: readonly LivingSpatialFrame[];
  readonly entities: readonly SceneProjectedEntity[];
  readonly presentationBindings: readonly ScenePresentationBinding[];
  readonly interactions: readonly InteractionSummary[];
  readonly feedCursor: string;
  readonly audienceHash: string;
  /** Absent unless the decided audience allows `private_cognition`. */
  readonly privateCognition?: readonly ScenePrivateCognition[];
  /** Absent when the installed pack places no effect in this scene. */
  readonly effects?: readonly SceneEffect[];
  readonly lighting?: SceneLighting;
}
export function decodeVisibleSpace(value: unknown, path = "space"): VisibleSpace {
  const v = record(value, path);
  exactKeys(v, ["spaceId", "label"], ["parentSpaceId"], path);
  return {
    spaceId: decodeOpaqueId(v.spaceId, "SpaceId", `${path}.spaceId`),
    label: string(v.label, `${path}.label`),
    ...(v.parentSpaceId === undefined
      ? {}
      : { parentSpaceId: decodeOpaqueId(v.parentSpaceId, "SpaceId", `${path}.parentSpaceId`) }),
  };
}
/** Distinct spaces whose parents all lead, without a cycle, to a root, including the projected one. */
function decodeHierarchy(value: unknown, spaceId: SpaceId, path: string): readonly VisibleSpace[] {
  const hierarchy = array(value, path, decodeVisibleSpace);
  const parents = new Map<SpaceId, SpaceId | undefined>();
  hierarchy.forEach((space, index) => {
    if (parents.has(space.spaceId))
      throw new ContractDecodeError(`${path}[${index}].spaceId`, "duplicate space");
    parents.set(space.spaceId, space.parentSpaceId);
  });
  if (!parents.has(spaceId)) throw new ContractDecodeError(path, "missing the projected space");
  const rooted = new Set<SpaceId>();
  hierarchy.forEach((space, index) => {
    const chain = new Set<SpaceId>();
    for (let id: SpaceId | undefined = space.spaceId; id !== undefined && !rooted.has(id); ) {
      if (!parents.has(id)) throw new ContractDecodeError(`${path}[${index}]`, "unknown parent");
      if (chain.has(id)) throw new ContractDecodeError(`${path}[${index}]`, "cyclic hierarchy");
      chain.add(id);
      id = parents.get(id);
    }
    for (const id of chain) rooted.add(id);
  });
  return hierarchy;
}
/** Each binding or interaction names a distinct projected entity, never a hidden one. */
function projectedOnce<T>(
  items: readonly T[],
  entityId: (item: T) => ObjectId,
  entities: readonly SceneProjectedEntity[],
  path: string,
): readonly T[] {
  const projected = new Set(entities.map((entity) => entity.objectId));
  const seen = new Set<ObjectId>();
  items.forEach((item, index) => {
    const id = entityId(item);
    if (!projected.has(id))
      throw new ContractDecodeError(`${path}[${index}]`, "entity is not projected");
    if (seen.has(id)) throw new ContractDecodeError(`${path}[${index}]`, "duplicate entity");
    seen.add(id);
  });
  return items;
}
export function decodeScenePresentationBinding(
  value: unknown,
  path = "binding",
): ScenePresentationBinding {
  const v = record(value, path);
  exactKeys(
    v,
    ["objectId", "assetId", "animationFamily", "accessibilityLabel"],
    ["material"],
    path,
  );
  return {
    objectId: decodeOpaqueId(v.objectId, "ObjectId", `${path}.objectId`),
    assetId: string(v.assetId, `${path}.assetId`),
    animationFamily: string(v.animationFamily, `${path}.animationFamily`),
    accessibilityLabel: string(v.accessibilityLabel, `${path}.accessibilityLabel`),
    ...(v.material === undefined
      ? {}
      : { material: decodeSceneMaterialDelivery(v.material, `${path}.material`) }),
  };
}
export function decodeSceneProjection(value: unknown, path = "projection"): SceneProjection {
  const v = record(value, path);
  const compatibility = decodeSceneCompatibility(v.compatibility, `${path}.compatibility`);
  exactKeys(
    v,
    [
      "tenantId",
      "worldId",
      "timelineId",
      "spaceId",
      "privacyClass",
      "compatibility",
      "revision",
      "simulationTime",
      "weather",
      "hierarchy",
      "frames",
      "entities",
      "presentationBindings",
      "interactions",
      "feedCursor",
      "audienceHash",
    ],
    ["privateCognition", "effects", "lighting"],
    path,
  );
  if (compatibility.projectionVersion === SCENE_PRIOR_PROJECTION_VERSION && v.effects !== undefined)
    throw new ContractDecodeError(`${path}.effects`, "absent from projection version 1");
  if (
    compatibility.projectionVersion === SCENE_PRIOR_PROJECTION_VERSION &&
    v.lighting !== undefined
  )
    throw new ContractDecodeError(`${path}.lighting`, "absent from projection version 1");
  const revision = unsignedDecimal(v.revision, `${path}.revision`);
  const simulationTime = unsignedDecimal(v.simulationTime, `${path}.simulationTime`);
  const living = decodeLivingScene({
    version: 1,
    privacyClass: v.privacyClass,
    tenantId: v.tenantId,
    worldId: v.worldId,
    timelineId: v.timelineId,
    spaceId: v.spaceId,
    revision: revision.toString(),
    simulationTime: simulationTime.toString(),
    weather: v.weather,
    frames: v.frames,
    entities: v.entities,
  });
  return {
    tenantId: living.tenantId,
    worldId: living.worldId,
    timelineId: living.timelineId,
    spaceId: living.spaceId,
    privacyClass: "public_scene",
    compatibility,
    revision,
    simulationTime,
    weather: living.weather,
    ...(v.lighting === undefined
      ? {}
      : { lighting: decodeSceneLighting(v.lighting, `${path}.lighting`) }),
    hierarchy: decodeHierarchy(v.hierarchy, living.spaceId, `${path}.hierarchy`),
    frames: living.frames,
    entities: living.entities,
    presentationBindings: projectedOnce(
      array(v.presentationBindings, `${path}.presentationBindings`, decodeScenePresentationBinding),
      (binding) => binding.objectId,
      living.entities,
      `${path}.presentationBindings`,
    ),
    interactions: projectedOnce(
      array(v.interactions, `${path}.interactions`, decodeInteractionSummary),
      (interaction) => interaction.entityId,
      living.entities,
      `${path}.interactions`,
    ),
    feedCursor: string(v.feedCursor, `${path}.feedCursor`),
    audienceHash: string(v.audienceHash, `${path}.audienceHash`),
    ...(v.privateCognition === undefined
      ? {}
      : {
          privateCognition: decodePrivateCognition(
            v.privateCognition,
            living.entities,
            `${path}.privateCognition`,
          ),
        }),
    ...(v.effects === undefined
      ? {}
      : { effects: array(v.effects, `${path}.effects`, decodeSceneEffect) }),
  };
}
export type ScenePatchOperation =
  | { readonly op: "upsert_entity"; readonly entity: SceneProjectedEntity }
  | { readonly op: "remove_entity"; readonly objectId: ObjectId }
  | { readonly op: "upsert_frame"; readonly frame: LivingSpatialFrame }
  | { readonly op: "remove_frame"; readonly frameId: LivingSpatialFrame["frameId"] }
  | { readonly op: "set_clock"; readonly simulationTime: bigint }
  | { readonly op: "set_weather"; readonly weather: LivingWeather }
  | { readonly op: "upsert_space"; readonly space: VisibleSpace }
  | { readonly op: "remove_space"; readonly spaceId: SpaceId }
  | { readonly op: "upsert_presentation"; readonly binding: ScenePresentationBinding }
  | { readonly op: "remove_presentation"; readonly objectId: ObjectId }
  | { readonly op: "upsert_interaction"; readonly interaction: InteractionSummary }
  | { readonly op: "remove_interaction"; readonly objectId: ObjectId }
  | { readonly op: "set_feed_cursor"; readonly feedCursor: string }
  | { readonly op: "set_compatibility"; readonly compatibility: SceneCompatibility }
  | {
      readonly op: "set_private_cognition";
      readonly entries: readonly ScenePrivateCognition[];
    }
  | { readonly op: "set_effects"; readonly effects: readonly SceneEffect[] }
  | { readonly op: "set_lighting"; readonly lighting: SceneLighting | null };
export interface ScenePatch {
  readonly fromRevision: bigint;
  readonly toRevision: bigint;
  readonly operations: readonly ScenePatchOperation[];
  readonly sourceEventIds: readonly EventId[];
  readonly audienceHash: string;
}
export function decodeScenePatchOperation(value: unknown, path = "operation"): ScenePatchOperation {
  const v = record(value, path);
  switch (v.op) {
    case "upsert_entity":
      exactKeys(v, ["op", "entity"], [], path);
      return { op: v.op, entity: decodeLivingEntity(v.entity, `${path}.entity`) };
    case "remove_entity":
    case "remove_presentation":
    case "remove_interaction":
      exactKeys(v, ["op", "objectId"], [], path);
      return { op: v.op, objectId: decodeOpaqueId(v.objectId, "ObjectId", `${path}.objectId`) };
    case "upsert_frame":
      exactKeys(v, ["op", "frame"], [], path);
      return { op: v.op, frame: decodeLivingFrame(v.frame, `${path}.frame`) };
    case "remove_frame":
      exactKeys(v, ["op", "frameId"], [], path);
      return { op: v.op, frameId: decodeOpaqueId(v.frameId, "SpatialFrameId", `${path}.frameId`) };
    case "set_clock":
      exactKeys(v, ["op", "simulationTime"], [], path);
      return {
        op: v.op,
        simulationTime: unsignedDecimal(v.simulationTime, `${path}.simulationTime`),
      };
    case "set_weather": {
      exactKeys(v, ["op", "weather"], [], path);
      return { op: v.op, weather: decodeLivingWeather(v.weather, `${path}.weather`) };
    }
    case "upsert_space":
      exactKeys(v, ["op", "space"], [], path);
      return { op: v.op, space: decodeVisibleSpace(v.space, `${path}.space`) };
    case "remove_space":
      exactKeys(v, ["op", "spaceId"], [], path);
      return { op: v.op, spaceId: decodeOpaqueId(v.spaceId, "SpaceId", `${path}.spaceId`) };
    case "upsert_presentation":
      exactKeys(v, ["op", "binding"], [], path);
      return { op: v.op, binding: decodeScenePresentationBinding(v.binding, `${path}.binding`) };
    case "upsert_interaction":
      exactKeys(v, ["op", "interaction"], [], path);
      return {
        op: v.op,
        interaction: decodeInteractionSummary(v.interaction, `${path}.interaction`),
      };
    case "set_feed_cursor":
      exactKeys(v, ["op", "feedCursor"], [], path);
      return { op: v.op, feedCursor: string(v.feedCursor, `${path}.feedCursor`) };
    case "set_compatibility": {
      const compatibility = decodeSceneCompatibility(v.compatibility, `${path}.compatibility`);
      exactKeys(v, ["op", "compatibility"], [], path);
      return { op: v.op, compatibility };
    }
    case "set_private_cognition":
      exactKeys(v, ["op", "entries"], [], path);
      return {
        op: v.op,
        entries: array(v.entries, `${path}.entries`, decodeScenePrivateCognition),
      };
    case "set_lighting":
      exactKeys(v, ["op", "lighting"], [], path);
      return {
        op: v.op,
        lighting: v.lighting === null ? null : decodeSceneLighting(v.lighting, `${path}.lighting`),
      };
    case "set_effects":
      exactKeys(v, ["op", "effects"], [], path);
      return { op: v.op, effects: array(v.effects, `${path}.effects`, decodeSceneEffect) };
    default:
      throw new ContractDecodeError(`${path}.op`, "unknown operation");
  }
}
export function decodeScenePatch(value: unknown, path = "patch"): ScenePatch {
  const v = record(value, path);
  // A patch's declared compatibility is checked before the patch or any operation's shape, so a
  // newer peer that also changes shape still receives its stable compatibility code.
  if (Array.isArray(v.operations))
    v.operations.forEach((operation: unknown, index) => {
      if (
        typeof operation === "object" &&
        operation !== null &&
        "op" in operation &&
        operation.op === "set_compatibility" &&
        "compatibility" in operation
      )
        decodeSceneCompatibility(
          operation.compatibility,
          `${path}.operations[${index}].compatibility`,
        );
    });
  exactKeys(
    v,
    ["fromRevision", "toRevision", "operations", "sourceEventIds", "audienceHash"],
    [],
    path,
  );
  const fromRevision = unsignedDecimal(v.fromRevision, `${path}.fromRevision`),
    toRevision = unsignedDecimal(v.toRevision, `${path}.toRevision`);
  if (toRevision <= fromRevision)
    throw new ContractDecodeError(`${path}.toRevision`, "revision must advance");
  const operations = array(v.operations, `${path}.operations`, decodeScenePatchOperation);
  // A patch built for projection version 1 cannot carry version 2's `set_effects`.
  if (
    operations.some(
      (operation) =>
        operation.op === "set_compatibility" &&
        operation.compatibility.projectionVersion === SCENE_PRIOR_PROJECTION_VERSION,
    )
  )
    operations.forEach((operation, index) => {
      if (operation.op === "set_effects" || operation.op === "set_lighting")
        throw new ContractDecodeError(
          `${path}.operations[${index}].op`,
          "absent from projection version 1",
        );
    });
  return {
    fromRevision,
    toRevision,
    operations,
    sourceEventIds: array(v.sourceEventIds, `${path}.sourceEventIds`, (id, p) =>
      decodeOpaqueId(id, "EventId", p),
    ),
    audienceHash: string(v.audienceHash, `${path}.audienceHash`),
  };
}
export type SceneCueKind =
  | "footstep"
  | "splash"
  | "particle"
  | "sound"
  | "emote"
  | "hover_hint"
  | "animation_transition";
export interface SceneTransientCue {
  readonly kind: SceneCueKind;
  readonly objectId: ObjectId;
  readonly reference: string;
  readonly expiresAt: string;
  readonly dedupeKey: string;
}
export function decodeSceneTransientCue(value: unknown, path = "cue"): SceneTransientCue {
  const v = record(value, path);
  exactKeys(v, ["kind", "objectId", "reference", "expiresAt", "dedupeKey"], [], path);
  return {
    kind: literal(
      v.kind,
      ["footstep", "splash", "particle", "sound", "emote", "hover_hint", "animation_transition"],
      `${path}.kind`,
    ),
    objectId: decodeOpaqueId(v.objectId, "ObjectId", `${path}.objectId`),
    reference: string(v.reference, `${path}.reference`),
    expiresAt: utcTimestamp(v.expiresAt, `${path}.expiresAt`),
    dedupeKey: string(v.dedupeKey, `${path}.dedupeKey`),
  };
}
export type ObserverSceneMessage =
  | (SceneEnvelope<SceneProjection> & { readonly lane: "projection"; readonly type: "snapshot" })
  | (SceneEnvelope<ScenePatch> & { readonly lane: "projection"; readonly type: "patch" })
  | (SceneEnvelope<SceneTransientCue> & { readonly lane: "transient"; readonly type: "cue" });
/** The safe connection metadata an operator inspector shows, and nothing else. */
export interface SceneConnectionMetadata {
  readonly principalId: PrincipalId;
  readonly acknowledgedRevision: bigint | null;
  readonly connectionVersion: number;
}
export interface SceneOperatorConnections {
  readonly connections: readonly SceneConnectionMetadata[];
}
/** Operator-lane diagnostics require the inspection grant and never enter an observer stream. */
export type OperatorSceneMessage = SceneEnvelope<SceneOperatorConnections> & {
  readonly lane: "operator";
  readonly type: "connections";
};
export function decodeSceneConnectionMetadata(
  value: unknown,
  path = "connection",
): SceneConnectionMetadata {
  const v = record(value, path);
  exactKeys(v, ["principalId", "acknowledgedRevision", "connectionVersion"], [], path);
  return {
    principalId: decodeOpaqueId(v.principalId, "PrincipalId", `${path}.principalId`),
    acknowledgedRevision:
      v.acknowledgedRevision === null
        ? null
        : unsignedDecimal(v.acknowledgedRevision, `${path}.acknowledgedRevision`),
    connectionVersion: nonNegativeInteger(v.connectionVersion, `${path}.connectionVersion`),
  };
}
/** Every lane's envelope, version first; the caller decodes and cross-checks the lane payload. */
function decodeSceneEnvelope(value: unknown) {
  const v = record(value, "message");
  if ("protocolVersion" in v && v.protocolVersion !== SCENE_PROTOCOL_VERSION)
    throw new SceneCompatibilityError(
      "unsupported_protocol_version",
      v.protocolVersion,
      SCENE_PROTOCOL_VERSION,
      "message.protocolVersion",
    );
  exactKeys(
    v,
    [
      "protocolVersion",
      "messageId",
      "lane",
      "type",
      "tenantId",
      "worldId",
      "timelineId",
      "spaceId",
      "sentAt",
      "payload",
    ],
    ["projectionRevision", "traceparent"],
    "message",
  );
  const common = {
    ...decodeBrowserScope({
      tenantId: v.tenantId,
      worldId: v.worldId,
      timelineId: v.timelineId,
      spaceId: v.spaceId,
    }),
    protocolVersion: SCENE_PROTOCOL_VERSION,
    messageId: string(v.messageId, "message.messageId"),
    sentAt: utcTimestamp(v.sentAt, "message.sentAt"),
    ...(v.traceparent === undefined
      ? {}
      : { traceparent: w3cTraceparent(v.traceparent, "message.traceparent") }),
    ...(v.projectionRevision === undefined
      ? {}
      : {
          projectionRevision: unsignedDecimal(v.projectionRevision, "message.projectionRevision"),
        }),
  };
  return { v, common };
}
export function decodeObserverSceneMessage(value: unknown): ObserverSceneMessage {
  const { v, common } = decodeSceneEnvelope(value);
  if (v.lane === "projection" && v.type === "snapshot") {
    const payload = decodeSceneProjection(v.payload);
    if (
      payload.tenantId !== common.tenantId ||
      payload.worldId !== common.worldId ||
      payload.timelineId !== common.timelineId ||
      payload.spaceId !== common.spaceId ||
      common.projectionRevision !== payload.revision
    )
      throw new ContractDecodeError("message", "snapshot identity or revision mismatch");
    return { ...common, lane: "projection", type: "snapshot", payload };
  }
  if (v.lane === "projection" && v.type === "patch") {
    const payload = decodeScenePatch(v.payload);
    if (common.projectionRevision !== payload.toRevision)
      throw new ContractDecodeError("message.projectionRevision", "patch revision mismatch");
    return { ...common, lane: "projection", type: "patch", payload };
  }
  if (v.lane === "transient" && v.type === "cue") {
    const payload = decodeSceneTransientCue(v.payload);
    if (utcInstantKey(payload.expiresAt) <= utcInstantKey(common.sentAt))
      throw new ContractDecodeError("cue.expiresAt", "cue must expire after it is sent");
    return { ...common, lane: "transient", type: "cue", payload };
  }
  throw new ContractDecodeError(
    "message.lane",
    "message is not an observer projection or transient cue",
  );
}
const decimalBigints = (_key: string, item: unknown) =>
  typeof item === "bigint" ? item.toString() : item;
export function encodeObserverSceneMessage(value: ObserverSceneMessage): string {
  return JSON.stringify(decodeObserverSceneMessage(value), decimalBigints);
}
/** Strict operator-lane decoding; it describes, and never grants, the inspection authority. */
export function decodeOperatorSceneMessage(value: unknown): OperatorSceneMessage {
  const { v, common } = decodeSceneEnvelope(value);
  if (v.lane !== "operator" || v.type !== "connections")
    throw new ContractDecodeError("message.lane", "message is not an operator diagnostic");
  const payload = record(v.payload, "connections");
  exactKeys(payload, ["connections"], [], "connections");
  return {
    ...common,
    lane: "operator",
    type: "connections",
    payload: {
      connections: array(payload.connections, "connections", decodeSceneConnectionMetadata),
    },
  };
}
export function encodeOperatorSceneMessage(value: OperatorSceneMessage): string {
  return JSON.stringify(decodeOperatorSceneMessage(value), decimalBigints);
}
export interface SceneAssetProvenance {
  readonly source: string;
  readonly creator: string;
  readonly tool?: string;
  readonly license: string;
  readonly generated?: { readonly prompt: string; readonly references: readonly string[] };
}
export interface SceneAsset {
  readonly assetId: string;
  readonly provenance: SceneAssetProvenance;
  readonly reviewStatus: "pending" | "approved" | "rejected";
  readonly semanticEntityId?: ObjectId;
  readonly semanticArchetypeId: string;
  readonly animationFamily: string;
  readonly anchor: readonly string[];
  readonly footprint: readonly string[];
  readonly bounds: readonly string[];
  readonly palette: readonly string[];
  readonly contentHash: string;
  readonly atlasLocation: string;
  readonly accessibilityLabel: string;
}
export interface SceneAssetManifest {
  readonly version: 2;
  readonly contentHash: string;
  readonly assets: readonly SceneAsset[];
}
export function decodeSceneAsset(value: unknown, path = "asset"): SceneAsset {
  const v = record(value, path);
  exactKeys(
    v,
    [
      "assetId",
      "provenance",
      "reviewStatus",
      "semanticArchetypeId",
      "animationFamily",
      "anchor",
      "footprint",
      "bounds",
      "palette",
      "contentHash",
      "atlasLocation",
      "accessibilityLabel",
    ],
    ["semanticEntityId"],
    path,
  );
  const p = record(v.provenance, `${path}.provenance`);
  exactKeys(p, ["source", "creator", "license"], ["tool", "generated"], `${path}.provenance`);
  let generated: SceneAssetProvenance["generated"];
  if (p.generated !== undefined) {
    const g = record(p.generated, `${path}.provenance.generated`);
    exactKeys(g, ["prompt", "references"], [], `${path}.provenance.generated`);
    generated = {
      prompt: string(g.prompt, `${path}.provenance.generated.prompt`),
      references: array(g.references, `${path}.provenance.generated.references`, string),
    };
  }
  return {
    assetId: string(v.assetId, `${path}.assetId`),
    provenance: {
      source: string(p.source, `${path}.provenance.source`),
      creator: string(p.creator, `${path}.provenance.creator`),
      license: string(p.license, `${path}.provenance.license`),
      ...(p.tool === undefined ? {} : { tool: string(p.tool, `${path}.provenance.tool`) }),
      ...(generated === undefined ? {} : { generated }),
    },
    reviewStatus: literal(
      v.reviewStatus,
      ["pending", "approved", "rejected"],
      `${path}.reviewStatus`,
    ),
    ...(v.semanticEntityId === undefined
      ? {}
      : {
          semanticEntityId: decodeOpaqueId(
            v.semanticEntityId,
            "ObjectId",
            `${path}.semanticEntityId`,
          ),
        }),
    semanticArchetypeId: string(v.semanticArchetypeId, `${path}.semanticArchetypeId`),
    animationFamily: string(v.animationFamily, `${path}.animationFamily`),
    anchor: array(v.anchor, `${path}.anchor`, string),
    footprint: array(v.footprint, `${path}.footprint`, string),
    bounds: array(v.bounds, `${path}.bounds`, string),
    palette: array(v.palette, `${path}.palette`, string),
    contentHash: string(v.contentHash, `${path}.contentHash`),
    atlasLocation: string(v.atlasLocation, `${path}.atlasLocation`),
    accessibilityLabel: string(v.accessibilityLabel, `${path}.accessibilityLabel`),
  };
}
export function decodeSceneAssetManifest(value: unknown, path = "manifest"): SceneAssetManifest {
  const v = record(value, path);
  if ("version" in v && v.version !== SCENE_ASSET_MANIFEST_VERSION)
    throw new SceneCompatibilityError(
      "unsupported_asset_manifest_version",
      v.version,
      SCENE_ASSET_MANIFEST_VERSION,
      `${path}.version`,
    );
  exactKeys(v, ["version", "contentHash", "assets"], [], path);
  return {
    version: 2,
    contentHash: string(v.contentHash, `${path}.contentHash`),
    assets: array(v.assets, `${path}.assets`, decodeSceneAsset),
  };
}
