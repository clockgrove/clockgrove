import type { SceneProjection } from "@clockgrove/contracts";
import * as TSL from "three/tsl";
import * as THREE from "three/webgpu";
import type { QualityTier } from "./renderer.js";

export { THREE, TSL };

// Keep the default composition bounded; worlds can import additional named exports from this pinned facade.
export const rendererLibrary = {
  Group: THREE.Group,
  Object3D: THREE.Object3D,
  Mesh: THREE.Mesh,
  SkinnedMesh: THREE.SkinnedMesh,
  Bone: THREE.Bone,
  Skeleton: THREE.Skeleton,
  BoxGeometry: THREE.BoxGeometry,
  PlaneGeometry: THREE.PlaneGeometry,
  CylinderGeometry: THREE.CylinderGeometry,
  SphereGeometry: THREE.SphereGeometry,
  BufferGeometry: THREE.BufferGeometry,
  BufferAttribute: THREE.BufferAttribute,
  Float32BufferAttribute: THREE.Float32BufferAttribute,
  Uint16BufferAttribute: THREE.Uint16BufferAttribute,
  DataTexture: THREE.DataTexture,
  Texture: THREE.Texture,
  TextureLoader: THREE.TextureLoader,
  MeshStandardNodeMaterial: THREE.MeshStandardNodeMaterial,
  MeshLambertNodeMaterial: THREE.MeshLambertNodeMaterial,
  AnimationMixer: THREE.AnimationMixer,
  AnimationClip: THREE.AnimationClip,
  NumberKeyframeTrack: THREE.NumberKeyframeTrack,
  QuaternionKeyframeTrack: THREE.QuaternionKeyframeTrack,
  VectorKeyframeTrack: THREE.VectorKeyframeTrack,
  LoopRepeat: THREE.LoopRepeat,
  Vector2: THREE.Vector2,
  Vector3: THREE.Vector3,
  Quaternion: THREE.Quaternion,
  Matrix4: THREE.Matrix4,
  Euler: THREE.Euler,
  Color: THREE.Color,
  RGBAFormat: THREE.RGBAFormat,
  RedFormat: THREE.RedFormat,
  UnsignedByteType: THREE.UnsignedByteType,
  FloatType: THREE.FloatType,
  NearestFilter: THREE.NearestFilter,
  LinearFilter: THREE.LinearFilter,
  SRGBColorSpace: THREE.SRGBColorSpace,
  NoColorSpace: THREE.NoColorSpace,
  DoubleSide: THREE.DoubleSide,
};
export const rendererNodes: Pick<
  typeof TSL,
  | "Fn"
  | "float"
  | "vec2"
  | "vec3"
  | "vec4"
  | "texture"
  | "uv"
  | "positionLocal"
  | "positionView"
  | "normalLocal"
  | "normalView"
  | "modelViewMatrix"
  | "cameraNear"
  | "cameraFar"
  | "depth"
  | "uniform"
> = {
  Fn: TSL.Fn,
  float: TSL.float,
  vec2: TSL.vec2,
  vec3: TSL.vec3,
  vec4: TSL.vec4,
  texture: TSL.texture,
  uv: TSL.uv,
  positionLocal: TSL.positionLocal,
  positionView: TSL.positionView,
  normalLocal: TSL.normalLocal,
  normalView: TSL.normalView,
  modelViewMatrix: TSL.modelViewMatrix,
  cameraNear: TSL.cameraNear,
  cameraFar: TSL.cameraFar,
  depth: TSL.depth,
  uniform: TSL.uniform,
};

export type ContentFailure =
  | "content_load"
  | "content_contract"
  | "content_update"
  | "content_draw";
export interface RendererContentFrame {
  readonly backend: "webgpu" | "webgl2";
  readonly qualityTier: QualityTier;
  readonly reducedMotion: boolean;
  readonly simulationTime: bigint;
  readonly weather: Readonly<SceneProjection["weather"]>;
  /** Absolute visual milliseconds; zero under reduced motion, like atlas frame zero. */
  readonly timeMs: number;
}
type GLTFLoader = import("three/addons/loaders/GLTFLoader.js").GLTFLoader;
type GLTF = import("three/addons/loaders/GLTFLoader.js").GLTF;
type GLTFParser = import("three/addons/loaders/GLTFLoader.js").GLTFParser;
type GLTFLoaderPlugin = import("three/addons/loaders/GLTFLoader.js").GLTFLoaderPlugin;
export type ModelImageSet =
  | { readonly path: string; readonly sha256?: string }
  | {
      readonly [name: string]: ModelImageSet;
    };
/** One `models.json` entry of a reviewed model whose look-dev images sit beside its `.glb`. */
export interface ModelDeliveryEntry {
  readonly path: string;
  readonly groom?: ModelImageSet;
  readonly textures?: ModelImageSet;
  readonly eyes?: ModelImageSet;
  readonly tiers?: {
    readonly [tier: string]: {
      readonly groom?: ModelImageSet;
      readonly textures?: ModelImageSet;
      readonly eyes?: ModelImageSet;
    };
  };
  readonly uris?: { readonly [uri: string]: string };
  readonly [field: string]: unknown;
}
export interface RendererContentContext {
  /** The renderer's quality tier when `create` is called. */
  readonly qualityTier: QualityTier;
  /** Load a reviewed model, requesting only the side images the tier draws. */
  readonly loadModel: (
    gltf: GLTFLoader,
    url: string,
    entry: ModelDeliveryEntry,
    tier: string,
  ) => Promise<GLTF>;
  readonly THREE: typeof rendererLibrary;
  readonly TSL: typeof rendererNodes;
  readonly backend: "webgpu" | "webgl2";
  readonly signal: AbortSignal;
  readonly place: typeof placeContent;
  /** URLs serve decoder files from this pinned Three installation, never another library copy. */
  readonly loaders: (paths: { basis: string; draco: string }) => Promise<{
    gltf: import("three/addons/loaders/GLTFLoader.js").GLTFLoader;
    ktx2: import("three/addons/loaders/KTX2Loader.js").KTX2Loader;
  }>;
}
export interface RendererContentLight {
  /** Screen-aligned metres, XYZ, before the anchor depth compression used by place(). */
  readonly position: readonly [number, number, number];
  readonly colour: string;
  readonly intensity: number;
  readonly rangeMetres: number;
}
/** #266: a renderer-drawn contact shape on the floor under a content anchor, in frame metres. */
export interface RendererContentContact {
  readonly x: number;
  readonly y: number;
  readonly elevation?: number;
  /** The footprint the shape grounds, as an atlas footprint's width and depth. */
  readonly widthMetres: number;
  readonly depthMetres: number;
}
/**
 * #266: world presentation data for the occlusion policy. A `fade` occluder (a canopy, a roof) may
 * fade to reveal the selected character behind it; a `solid` one (a trunk, a post, a wall) never
 * changes, and the character shows as a faint silhouette through it. `label` names it on the text
 * path ("Ada is behind the cedar."), so it reads after "behind".
 */
export interface RendererContentOccluder {
  /** An object inside the content root; its meshes are tested and, for `fade`, faded. */
  readonly object: THREE.Object3D;
  readonly kind: "fade" | "solid";
  /** Plain text, 1 to 80 characters. */
  readonly label: string;
}
export interface RendererContentInstance {
  readonly root: THREE.Group;
  /** Renderer-owned, unshadowed point lights, admitted in array order within the tier cap. */
  readonly lights?: readonly RendererContentLight[];
  /** Opt into scene directional shadows; meshes still choose castShadow and receiveShadow. */
  readonly shadows?: boolean;
  /** Ground content with the projected bodies' contact shape, on every tier (#266). */
  readonly contacts?: readonly RendererContentContact[];
  /** Content a character can stand behind; others are depth-true and never fade (#266). */
  readonly occluders?: readonly RendererContentOccluder[];
  /** Register textures hidden inside deferred shader callbacks for accounting and retirement. */
  readonly textures?: readonly THREE.Texture[];
  /** Update only owned objects. Use absolute time, including zero when motion is reduced. */
  readonly update: (frame: RendererContentFrame) => void;
  /** Retire external resources; renderer disposes root geometries, materials, textures and skeletons. */
  readonly dispose?: () => void;
}
export interface RendererContent {
  readonly version: 1;
  readonly create: (
    context: RendererContentContext,
  ) => RendererContentInstance | Promise<RendererContentInstance>;
}

/** Anchor in frame metres; local geometry is screen-aligned metres, with shallow depth in metres. */
export function placeContent(
  object: THREE.Object3D,
  at: { readonly x: number; readonly y: number; readonly elevation?: number },
): void {
  const elevation = at.elevation ?? 0;
  object.position.set(
    (at.x + at.y) * 12.5,
    -(at.x - at.y) * 6.25 + elevation * 12.5,
    sceneDepth(at.x, at.y, elevation),
  );
  // Match the existing 80 mm/pixel camera. Local axes stay screen-aligned, so depth is real and uncompressed.
  object.scale.set(12.5, 12.5, 12.5);
}
// The 2:1 isometric mapping is a 30 degree camera pitch: ground distance d spans d/2 on screen
// (sin 30) and sqrt(3)/2 d in depth, so depth = sqrt(3) * screen-vertical distance. The floor is the
// plane through the origin with normal (0, sin 60, cos 60); a metre of elevation lifts depth by 12.5/sqrt(3).
export function sceneDepth(x: number, y: number, elevation: number): number {
  return (x - y) * 6.25 * Math.sqrt(3) + (elevation * 12.5) / Math.sqrt(3);
}
/** Depth of the floor beneath scene-space vertical position `sceneY`. */
export function floorDepth(sceneY: number): number {
  return -Math.sqrt(3) * sceneY;
}

export function validateContent(root: THREE.Group): boolean {
  if (!(root instanceof THREE.Group)) return false;
  let valid = true;
  root.traverse((object) => {
    if (
      object instanceof THREE.Light ||
      object instanceof THREE.Camera ||
      object instanceof THREE.Scene ||
      object instanceof THREE.Sprite ||
      object.onBeforeRender !== THREE.Object3D.prototype.onBeforeRender ||
      object.onAfterRender !== THREE.Object3D.prototype.onAfterRender ||
      object.onBeforeShadow !== THREE.Object3D.prototype.onBeforeShadow ||
      object.onAfterShadow !== THREE.Object3D.prototype.onAfterShadow
    )
      valid = false;
    if (object instanceof THREE.Mesh) {
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials)
        if (
          !(
            material instanceof THREE.MeshStandardNodeMaterial ||
            material instanceof THREE.MeshLambertNodeMaterial
          ) ||
          !material.depthTest ||
          !material.depthWrite ||
          !material.fog ||
          !material.toneMapped ||
          !material.lights ||
          material.onBeforeRender !== THREE.Material.prototype.onBeforeRender ||
          material.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile ||
          material.lightsNode ||
          material.vertexNode ||
          material.fragmentNode ||
          material.outputNode ||
          material.backdropNode ||
          material.backdropAlphaNode
        )
          valid = false;
    } else if (
      !(
        object instanceof THREE.Group ||
        object instanceof THREE.Bone ||
        object.constructor === THREE.Object3D
      )
    ) {
      valid = false;
    }
  });
  return valid;
}

export function validateContentLighting(instance: RendererContentInstance): boolean {
  if (instance.shadows !== undefined && typeof instance.shadows !== "boolean") return false;
  if (!validContacts(instance.contacts)) return false;
  if (!validOccluders(instance)) return false;
  if (instance.lights === undefined) return true;
  // #184: bound validation work even when a content producer supplies more lights than a tier admits.
  if (!Array.isArray(instance.lights) || instance.lights.length > 64) return false;
  return Array.from(instance.lights).every(
    (light) =>
      light &&
      Array.isArray(light.position) &&
      light.position.length === 3 &&
      [0, 1, 2].every(
        (index) =>
          Number.isFinite(light.position[index]) && Math.abs(light.position[index]!) <= 1_000_000,
      ) &&
      typeof light.colour === "string" &&
      /^#[0-9a-f]{6}$/i.test(light.colour) &&
      Number.isFinite(light.intensity) &&
      light.intensity >= 0 &&
      light.intensity <= 1_000_000 &&
      Number.isFinite(light.rangeMetres) &&
      light.rangeMetres > 0 &&
      light.rangeMetres <= 100_000,
  );
}

type ValueNode = { value?: unknown };
/**
 * A node graph's value-holding nodes, found by one traversal per graph. The scene counts texture
 * bytes on every draw, and #266 gives every body and contact shape a node graph, so walking each
 * graph per draw put patches over their budget. Values are read fresh, so a swapped texture counts.
 */
const graphValueNodes = new WeakMap<object, readonly ValueNode[]>();
function valueNodes(node: {
  traverse: (callback: (child: ValueNode) => void) => void;
}): readonly ValueNode[] {
  let found = graphValueNodes.get(node);
  if (!found) {
    const nodes: ValueNode[] = [];
    node.traverse((child) => {
      if ("value" in child) nodes.push(child);
    });
    graphValueNodes.set(node, (found = nodes));
  }
  return found;
}
export function materialTextures(material: THREE.Material): Set<THREE.Texture> {
  const textures = new Set<THREE.Texture>();
  for (const value of Object.values(material)) {
    if (value instanceof THREE.Texture) textures.add(value);
    const node = value as {
      isNode?: boolean;
      traverse?: (callback: (child: ValueNode) => void) => void;
    } | null;
    if (node?.isNode && node.traverse)
      for (const child of valueNodes(node as Parameters<typeof valueNodes>[0]))
        if (child.value instanceof THREE.Texture) textures.add(child.value);
  }
  return textures;
}

export function disposeContent(root: THREE.Group, registered: readonly THREE.Texture[] = []): void {
  root.removeFromParent();
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>(registered);
  const skeletons = new Set<THREE.Skeleton>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      materials.add(material);
      for (const texture of materialTextures(material)) textures.add(texture);
    }
    if (object instanceof THREE.SkinnedMesh) skeletons.add(object.skeleton);
  });
  for (const resource of [...geometries, ...materials, ...textures, ...skeletons]) {
    try {
      resource.dispose();
    } catch {
      /* Retire every resource even if a user disposal listener fails. */
    }
  }
}

function leafPaths(set: ModelImageSet | undefined, into: Set<string>): void {
  if (!set || typeof set !== "object") return;
  if (typeof set.path === "string") into.add(set.path);
  else for (const child of Object.values(set)) leafPaths(child as ModelImageSet, into);
}

function drawnPaths(entry: ModelDeliveryEntry, tier: string): Set<string> {
  const source = Object.hasOwn(entry.tiers ?? {}, tier) ? entry.tiers![tier]! : entry;
  const paths = new Set<string>();
  leafPaths(source.groom, paths);
  leafPaths(source.textures, paths);
  leafPaths(source.eyes, paths);
  return paths;
}

interface PendingModel {
  readonly uris: { readonly [uri: string]: string };
  readonly drawn: ReadonlySet<string>;
  readonly base: string;
}
let pendingModel: PendingModel | undefined;

/** Fetch a model's `.glb` and parse it so that images the tier does not draw are never requested. */
export async function loadModel(
  gltf: GLTFLoader,
  url: string,
  entry: ModelDeliveryEntry,
  tier: string,
  signal?: AbortSignal,
): Promise<GLTF> {
  const response = await fetch(url, signal ? { signal } : {});
  if (!response.ok) throw new Error(`model ${url} failed with ${response.status}`);
  const buffer = await response.arrayBuffer();
  const absolute = new URL(url, globalThis.location?.href).href;
  const directory = absolute.slice(0, absolute.lastIndexOf("/") + 1);
  if (!entry.uris) return gltf.parseAsync(buffer, directory);
  // GLTFLoader creates its plugins synchronously inside parse, so only this parse sees the config.
  pendingModel = { uris: entry.uris, drawn: drawnPaths(entry, tier), base: absolute };
  let parsed: Promise<GLTF>;
  try {
    parsed = gltf.parseAsync(buffer, directory);
  } finally {
    pendingModel = undefined;
  }
  return parsed;
}

/** Rewrites drawn side images to their reviewed files and skips images the tier does not draw. */
export function sideImagesPlugin(parser: GLTFParser): GLTFLoaderPlugin {
  const config = pendingModel;
  if (!config) return { name: "CLOCKGROVE_side_images" };
  type Json = { images?: { uri?: string }[]; textures?: { source?: number }[] };
  const original: (string | undefined)[] = [];
  const reviewed = (uri: string | undefined): string | undefined =>
    uri !== undefined && Object.hasOwn(config.uris, uri) ? config.uris[uri] : undefined;
  return {
    name: "CLOCKGROVE_side_images",
    beforeRoot: () => {
      const json = parser.json as Json;
      json.images?.forEach((image, index) => {
        original[index] = image.uri;
        const name = reviewed(image.uri);
        if (name !== undefined && config.drawn.has(name))
          image.uri = new URL(name, config.base).href;
      });
      return null;
    },
    loadTexture: (textureIndex: number) => {
      const source = (parser.json as Json).textures?.[textureIndex]?.source;
      const name = source === undefined ? undefined : reviewed(original[source]);
      return name !== undefined && !config.drawn.has(name)
        ? (Promise.resolve(null) as unknown as Promise<THREE.Texture>)
        : null;
    },
  };
}

export async function contentLoaders(
  renderer: THREE.WebGPURenderer,
  paths: { basis: string; draco: string },
) {
  const [{ GLTFLoader }, { DRACOLoader }, { MeshoptDecoder }] = await Promise.all([
    import("three/addons/loaders/GLTFLoader.js"),
    import("three/addons/loaders/DRACOLoader.js"),
    import("three/addons/libs/meshopt_decoder.module.js"),
  ]);
  // The renderer's shared loader with the app's pinned transcoder; `paths.basis` is not used.
  const { ktx2, release } = await acquireKtx2(renderer);
  const draco = new DRACOLoader().setDecoderPath(paths.draco);
  draco.setDecoderConfig({ type: "wasm" });
  const gltf = new GLTFLoader()
    .setKTX2Loader(ktx2)
    .setDRACOLoader(draco)
    .setMeshoptDecoder(MeshoptDecoder);
  gltf.register(() => ({
    name: "CLOCKGROVE_lit_node_materials",
    afterRoot: async (result) => {
      const converted = new Map<THREE.Material, THREE.MeshStandardNodeMaterial>();
      result.scene.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        const convert = (material: THREE.Material) => {
          let next = converted.get(material);
          if (!next) {
            next = new THREE.MeshStandardNodeMaterial().copy(material);
            converted.set(material, next);
            material.dispose();
          }
          return next;
        };
        object.material = Array.isArray(object.material)
          ? object.material.map(convert)
          : convert(object.material);
      });
    },
  }));
  gltf.register(sideImagesPlugin);
  return {
    gltf,
    ktx2,
    dispose: () => {
      release();
      draco.dispose();
    },
  };
}

/** The compressed formats a device samples that UASTC transcodes to with alpha, best first. */
export type AtlasTextureFormat = "astc" | "bc7" | "etc2" | "bc3";
type KTX2Loader = import("three/addons/loaders/KTX2Loader.js").KTX2Loader;

/**
 * One KTX2 loader per renderer, shared by the platform's atlas pages and world content, so a world
 * with both loads the Basis transcoder and its workers once. The transcoder comes from this pinned
 * Three installation as built assets of the app, fetched from the app's own origin when the first
 * KTX2 texture parses, never from a CDN. Each acquire returns its own release; the loader is
 * disposed when the last holder releases it.
 */
const sharedKtx2 = new WeakMap<
  THREE.WebGPURenderer,
  { loader: Promise<KTX2Loader>; holders: number }
>();
async function acquireKtx2(
  renderer: THREE.WebGPURenderer,
): Promise<{ readonly ktx2: KTX2Loader; readonly release: () => void }> {
  let entry = sharedKtx2.get(renderer);
  if (!entry) {
    const created = {
      holders: 0,
      loader: Promise.all([
        import("three/addons/loaders/KTX2Loader.js"),
        import("three/addons/libs/basis/basis_transcoder.js?url"),
        import("three/addons/libs/basis/basis_transcoder.wasm?url"),
      ]).then(([{ KTX2Loader }, { default: script }, { default: binary }]) => {
        const manager = new THREE.LoadingManager();
        manager.setURLModifier((url) =>
          url.endsWith("basis_transcoder.js")
            ? script
            : url.endsWith("basis_transcoder.wasm")
              ? binary
              : url,
        );
        return new KTX2Loader(manager).setTranscoderPath("basis/").detectSupport(renderer);
      }),
    };
    created.loader.catch(() => sharedKtx2.delete(renderer));
    sharedKtx2.set(renderer, created);
    entry = created;
  }
  const held = entry;
  held.holders += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    held.holders -= 1;
    if (held.holders > 0) return;
    if (sharedKtx2.get(renderer) === held) sharedKtx2.delete(renderer);
    void held.loader
      .then((ktx2) => {
        // Three decrements its module-wide loader count on every dispose but counts a loader only
        // once its transcoder initialises; dispose only such a loader, so the count never drops
        // below zero, and otherwise retire just its (empty) worker pool.
        if (ktx2.transcoderPending) ktx2.dispose();
        else ktx2.workerPool.dispose();
      })
      .catch(() => {});
  };
  try {
    return { ktx2: await held.loader, release };
  } catch (error) {
    release();
    throw error;
  }
}

/**
 * The shared KTX2 loader for the platform's own atlas pages, or undefined when the device samples
 * none of the formats UASTC transcodes to with alpha (the caller then loads PNG pages). Three's
 * KTX2Loader makes the per-device choice: ASTC 4×4, then BC7, then ETC2 RGBA8, then BC3.
 */
export async function atlasTextureLoader(
  renderer: THREE.WebGPURenderer,
): Promise<{ ktx2: KTX2Loader; format: AtlasTextureFormat; release: () => void } | undefined> {
  const { ktx2, release } = await acquireKtx2(renderer);
  const config = ktx2.workerConfig;
  const format: AtlasTextureFormat | undefined = config.astcSupported
    ? "astc"
    : config.bptcSupported
      ? "bc7"
      : config.etc2Supported
        ? "etc2"
        : config.dxtSupported
          ? "bc3"
          : undefined;
  if (!format) {
    release();
    return undefined;
  }
  return { ktx2, format, release };
}

/** #266: at most 64 contact shapes, bounded like light descriptors; a footprint side is at most 1 km. */
function validContacts(contacts: RendererContentInstance["contacts"]): boolean {
  if (contacts === undefined) return true;
  if (!Array.isArray(contacts) || contacts.length > 64) return false;
  const bounded = (value: unknown, limit: number) =>
    typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= limit;
  return Array.from(contacts).every(
    (contact) =>
      contact &&
      bounded(contact.x, 1_000_000) &&
      bounded(contact.y, 1_000_000) &&
      (contact.elevation === undefined || bounded(contact.elevation, 1_000_000)) &&
      bounded(contact.widthMetres, 1000) &&
      contact.widthMetres > 0 &&
      bounded(contact.depthMetres, 1000) &&
      contact.depthMetres > 0,
  );
}

/**
 * #266: at most 64 occluders, each an object inside the content root with a plain-text label, and
 * no material shared between a fade and a solid occluder, so fading a canopy never fades a trunk.
 */
function validOccluders(instance: RendererContentInstance): boolean {
  const occluders = instance.occluders;
  if (occluders === undefined) return true;
  if (!Array.isArray(occluders) || occluders.length > 64) return false;
  const kinds = new Map<THREE.Material, "fade" | "solid">();
  for (const occluder of Array.from(occluders)) {
    if (
      !occluder ||
      !(occluder.object instanceof THREE.Object3D) ||
      (occluder.kind !== "fade" && occluder.kind !== "solid") ||
      typeof occluder.label !== "string" ||
      occluder.label.trim().length === 0 ||
      occluder.label.length > 80 ||
      // biome-ignore lint/suspicious/noControlCharactersInRegex: labels are plain text.
      /[\u0000-\u001f\u007f<>]/u.test(occluder.label)
    )
      return false;
    let inside = false;
    for (let object: THREE.Object3D | null = occluder.object; object; object = object.parent)
      if (object === instance.root) inside = true;
    if (!inside) return false;
    let shared = false;
    occluder.object.traverse((child: THREE.Object3D) => {
      if (!(child instanceof THREE.Mesh)) return;
      for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
        const kind = kinds.get(material);
        if (kind !== undefined && kind !== occluder.kind) shared = true;
        kinds.set(material, occluder.kind);
      }
    });
    if (shared) return false;
  }
  return true;
}
