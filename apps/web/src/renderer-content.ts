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
export interface RendererContentContext {
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
export interface RendererContentInstance {
  readonly root: THREE.Group;
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
    contentDepth(at.x, at.y, elevation),
  );
  // Match the existing 80 mm/pixel camera. Compress local depth to coexist with atlas billboards.
  object.scale.set(12.5, 12.5, 0.01);
}
export function contentDepth(x: number, y: number, elevation: number): number {
  return (x - y) * 0.01 + elevation * 0.005;
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

export function materialTextures(material: THREE.Material): Set<THREE.Texture> {
  const textures = new Set<THREE.Texture>();
  for (const value of Object.values(material)) {
    if (value instanceof THREE.Texture) textures.add(value);
    const node = value as {
      isNode?: boolean;
      traverse?: (callback: (child: { value?: unknown }) => void) => void;
    } | null;
    if (node?.isNode && node.traverse)
      node.traverse((child) => {
        if (child.value instanceof THREE.Texture) textures.add(child.value);
      });
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

export async function contentLoaders(
  renderer: THREE.WebGPURenderer,
  paths: { basis: string; draco: string },
) {
  const [{ GLTFLoader }, { KTX2Loader }, { DRACOLoader }, { MeshoptDecoder }] = await Promise.all([
    import("three/addons/loaders/GLTFLoader.js"),
    import("three/addons/loaders/KTX2Loader.js"),
    import("three/addons/loaders/DRACOLoader.js"),
    import("three/addons/libs/meshopt_decoder.module.js"),
  ]);
  const ktx2 = new KTX2Loader().setTranscoderPath(paths.basis).detectSupport(renderer);
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
  return {
    gltf,
    ktx2,
    dispose: () => {
      ktx2.dispose();
      draco.dispose();
    },
  };
}
