import type { ObjectId } from "@clockgrove/contracts";
import { float, texture, uniform, uv } from "three/tsl";
import * as THREE from "three/webgpu";
import type { RendererContentOccluder } from "./renderer-content.js";
import { INTERPOLATION_MS, type SceneOcclusionReveal } from "./world-scene-adapter.js";

/**
 * #266: the occlusion policy. Occlusion is depth-true for every body; only the selected body is
 * tested, and after a dwell the fade occluders it stands behind (canopies, roofs) fade by alpha
 * hashing, and a faint silhouette shows where a solid occluder (trunk, post, wall) covers it.
 * Solid occluders never change. The numbers are presentation decisions (plan assumption 15).
 */
export const OCCLUSION = {
  /** Sample points on the body's drawn quad, and how many must be covered to call it hidden. */
  samples: 5,
  hiddenSamples: 3,
  dwellMs: 500,
  fadedOpacity: 0.25,
  silhouetteOpacity: 0.35,
} as const;
/**
 * The stencil bit the silhouette tests. Solid occluders set it where they draw while a silhouette
 * shows; bodies and faded occluders clear it where they draw nearer, so the silhouette shows only
 * through a solid occluder's own pixels. The puddle reflection owns bit 1.
 */
export const SILHOUETTE_STENCIL = 2;
interface Stencil {
  stencilWrite: boolean;
  stencilRef: number;
  stencilWriteMask: number;
  stencilFunc: THREE.StencilFunc;
  stencilFail: THREE.StencilOp;
  stencilZFail: THREE.StencilOp;
  stencilZPass: THREE.StencilOp;
}
function saveStencil(material: THREE.Material): Stencil {
  const {
    stencilWrite,
    stencilRef,
    stencilWriteMask,
    stencilFunc,
    stencilFail,
    stencilZFail,
    stencilZPass,
  } = material;
  return {
    stencilWrite,
    stencilRef,
    stencilWriteMask,
    stencilFunc,
    stencilFail,
    stencilZFail,
    stencilZPass,
  };
}
/** Where `material` draws nearest, set (`value` = the bit) or clear (0) the silhouette bit only. */
function writeSilhouetteBit(material: THREE.Material, value: 0 | typeof SILHOUETTE_STENCIL): void {
  Object.assign(material, {
    stencilWrite: true,
    stencilRef: value,
    stencilWriteMask: SILHOUETTE_STENCIL,
    stencilFunc: THREE.AlwaysStencilFunc,
    stencilFail: THREE.KeepStencilOp,
    stencilZFail: THREE.KeepStencilOp,
    stencilZPass: THREE.ReplaceStencilOp,
  } satisfies Stencil);
}
/** A body clears the silhouette bit where it draws, so a character in front hides the silhouette. */
export function clearsSilhouette(material: THREE.Material): void {
  if (
    material.stencilWrite &&
    material.stencilRef === 0 &&
    material.stencilWriteMask === SILHOUETTE_STENCIL &&
    material.stencilZPass === THREE.ReplaceStencilOp
  )
    return;
  writeSilhouetteBit(material, 0);
}
export interface OcclusionMetrics {
  /** Whether the selected body is behind occluders now, before any dwell. */
  hidden: boolean;
  /** Whether the reveal is on: the dwell elapsed and the body is still hidden. */
  revealed: boolean;
  behind: string | undefined;
  /** Fade occluders currently drawn below full opacity. */
  faded: number;
  /** The silhouette's current opacity; zero when none is drawn. */
  silhouette: number;
  /** Frames whose ray test ran; a frame where nothing moved reuses the last one. */
  rayTests: number;
}
interface Fade {
  level: number;
  readonly materials: ReadonlySet<THREE.Material>;
}
/** One saved original per material, however many fade occluders share it. */
interface FadedMaterial {
  readonly opacity: number;
  readonly alphaTest: number;
  readonly alphaHash: boolean;
  readonly stencil: Stencil;
  users: number;
  level: number;
}
type Body = THREE.Object3D & {
  readonly geometry: THREE.BufferGeometry;
  readonly material: THREE.Material | THREE.Material[];
};

const SAMPLE_UV = [
  [0.5, 0.5],
  [0.25, 0.25],
  [0.75, 0.25],
  [0.25, 0.75],
  [0.75, 0.75],
] as const;
const TOWARD_SCENE = new THREE.Vector3(0, 0, -1);

export class SceneOcclusion {
  readonly metrics: OcclusionMetrics = {
    hidden: false,
    revealed: false,
    behind: undefined,
    faded: 0,
    silhouette: 0,
    rayTests: 0,
  };
  private readonly raycaster = new THREE.Raycaster();
  private readonly hits: THREE.Intersection[] = [];
  private readonly point = new THREE.Vector3();
  private readonly origin = new THREE.Vector3();
  private readonly fades = new Map<THREE.Object3D, Fade>();
  private readonly faded = new Map<THREE.Material, FadedMaterial>();
  /** Solid occluders' materials marking the silhouette bit, with their own stencil state. */
  private readonly marked = new Map<THREE.Material, Stencil>();
  private readonly visible: RendererContentOccluder[] = [];
  private readonly covered: RendererContentOccluder[][] = SAMPLE_UV.map(() => []);
  /** What the last ray test saw: it runs again only when one of these changes. */
  private readonly key: unknown[] = [];
  private readonly nextKey: unknown[] = [];
  private readonly handlers = new Set<(reveal: SceneOcclusionReveal | undefined) => void>();
  private readonly silhouetteOpacity = uniform(0);
  private readonly silhouetteMap = texture(new THREE.Texture());
  private silhouette: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicNodeMaterial> | undefined;
  private objectId: ObjectId | undefined;
  private hiddenSince: number | undefined;
  private reported: string | undefined;
  private solid = false;
  private last: number | undefined;

  constructor(private readonly accent: THREE.ColorRepresentation) {}

  onReveal(handler: (reveal: SceneOcclusionReveal | undefined) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /**
   * One frame: test the selected body against the visible occluders, then ease fades and the
   * silhouette toward their targets. Returns whether anything drawn changed.
   */
  update(frame: {
    readonly scene: THREE.Scene;
    readonly objectId: ObjectId | undefined;
    readonly body: Body | undefined;
    readonly camera: THREE.OrthographicCamera;
    readonly occluders: readonly RendererContentOccluder[];
    readonly reducedMotion: boolean;
    readonly now: number;
  }): boolean {
    const { body, occluders, now } = frame;
    const step =
      frame.reducedMotion || this.last === undefined ? 1 : (now - this.last) / INTERPOLATION_MS;
    this.last = now;
    if (frame.objectId !== this.objectId) {
      this.objectId = frame.objectId;
      this.hiddenSince = undefined;
      this.metrics.revealed = false;
    }
    const covered =
      body && occluders.length > 0 ? this.cover(body, frame.camera, occluders) : this.clear();
    const hidden = covered.filter((sample) => sample.length > 0).length >= OCCLUSION.hiddenSamples;
    this.metrics.hidden = hidden;
    if (!hidden) this.hiddenSince = undefined;
    else this.hiddenSince ??= now;
    const revealed =
      hidden && this.hiddenSince !== undefined && now - this.hiddenSince >= OCCLUSION.dwellMs;
    let behind: RendererContentOccluder | undefined;
    const fadeTargets = new Set<THREE.Object3D>();
    this.solid = false;
    if (revealed) {
      const counts = new Map<RendererContentOccluder, number>();
      for (const sample of covered)
        for (const occluder of sample) counts.set(occluder, (counts.get(occluder) ?? 0) + 1);
      let most = 0;
      for (const occluder of occluders) {
        const count = counts.get(occluder) ?? 0;
        if (count > most) [most, behind] = [count, occluder];
        if (count === 0) continue;
        if (occluder.kind === "fade") fadeTargets.add(occluder.object);
        else this.solid = true;
      }
    }
    this.metrics.revealed = revealed;
    this.metrics.behind = behind?.label;
    const sentence = revealed && behind ? `${this.objectId}\u0000${behind.label}` : undefined;
    if (sentence !== this.reported) {
      this.reported = sentence;
      const reveal =
        revealed && behind && this.objectId !== undefined
          ? { objectId: this.objectId, behind: behind.label }
          : undefined;
      for (const handler of this.handlers) handler(reveal);
    }
    let changed = this.easeFades(fadeTargets, step);
    changed = this.easeSilhouette(frame.scene, body, this.solid, step) || changed;
    if (this.silhouette) this.mark(occluders);
    return changed;
  }

  /** Content went or the scene is retiring: restore every faded material and drop the silhouette. */
  reset(): void {
    for (const fade of this.fades.values()) this.restore(fade);
    this.fades.clear();
    this.retireSilhouette();
    this.clear();
    this.objectId = undefined;
    this.hiddenSince = undefined;
    Object.assign(this.metrics, {
      hidden: false,
      revealed: false,
      behind: undefined,
      faded: 0,
      silhouette: 0,
    });
    if (this.reported !== undefined) {
      this.reported = undefined;
      for (const handler of this.handlers) handler(undefined);
    }
  }

  dispose(): void {
    this.reset();
    this.handlers.clear();
  }

  private clear(): RendererContentOccluder[][] {
    for (const sample of this.covered) sample.length = 0;
    this.key.length = 0;
    return this.covered;
  }

  /**
   * For each sample point on the body's quad, the visible occluders between it and the camera. The
   * rays walk the occluders' triangles (bounded by the content contract), so they run again only
   * when the body, the camera, or an occluder's meshes, bones, geometry or visibility change.
   */
  private cover(
    body: Body,
    camera: THREE.OrthographicCamera,
    occluders: readonly RendererContentOccluder[],
  ): RendererContentOccluder[][] {
    body.updateWorldMatrix(true, false);
    const visible = this.visible;
    visible.length = 0;
    for (const occluder of occluders) {
      let shown = true;
      for (let object: THREE.Object3D | null = occluder.object; object; object = object.parent)
        if (!object.visible) shown = false;
      if (!shown) continue;
      // Content may have moved an anchor above the occluder since the last render.
      occluder.object.updateWorldMatrix(true, true);
      visible.push(occluder);
    }
    const key = this.nextKey;
    key.length = 0;
    key.push(body, body.geometry, camera, camera.zoom, camera.left, camera.right, camera.top);
    key.push(camera.bottom, ...body.matrixWorld.elements, ...camera.matrixWorld.elements);
    for (const occluder of visible) {
      key.push(occluder);
      occluder.object.traverseVisible((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        key.push(child, child.geometry, ...child.matrixWorld.elements);
        if (child instanceof THREE.SkinnedMesh)
          for (const bone of child.skeleton.bones) key.push(...bone.matrixWorld.elements);
      });
    }
    if (key.length === this.key.length && key.every((value, at) => value === this.key[at]))
      return this.covered;
    this.key.length = 0;
    this.key.push(...key);
    this.metrics.rayTests += 1;
    const geometry = body.geometry;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    const cameraZ = camera.position.z;
    SAMPLE_UV.forEach(([u, v], index) => {
      const sample = this.covered[index]!;
      sample.length = 0;
      this.point
        .set(
          box.min.x + (box.max.x - box.min.x) * u,
          box.min.y + (box.max.y - box.min.y) * v,
          (box.min.z + box.max.z) / 2,
        )
        .applyMatrix4(body.matrixWorld);
      // An orthographic camera looking down -z: every view ray is parallel to it.
      this.raycaster.set(this.origin.copy(this.point).setZ(cameraZ), TOWARD_SCENE);
      this.raycaster.near = 0;
      this.raycaster.far = Math.max(0, cameraZ - this.point.z - 1);
      for (const occluder of visible) {
        this.hits.length = 0;
        this.raycaster.intersectObject(occluder.object, true, this.hits);
        if (this.hits.length > 0) sample.push(occluder);
      }
    });
    this.hits.length = 0;
    return this.covered;
  }

  /** While a silhouette shows, every solid occluder's material sets the silhouette bit. */
  private mark(occluders: readonly RendererContentOccluder[]): void {
    for (const occluder of occluders)
      if (occluder.kind === "solid")
        occluder.object.traverse((child) => {
          if (!(child instanceof THREE.Mesh)) return;
          for (const material of Array.isArray(child.material) ? child.material : [child.material])
            if (material instanceof THREE.Material && !this.marked.has(material)) {
              this.marked.set(material, saveStencil(material));
              writeSilhouetteBit(material, SILHOUETTE_STENCIL);
              material.needsUpdate = true;
            }
        });
  }

  private unmark(): void {
    for (const [material, stencil] of this.marked) {
      Object.assign(material, stencil);
      material.needsUpdate = true;
    }
    this.marked.clear();
  }

  private easeFades(targets: ReadonlySet<THREE.Object3D>, step: number): boolean {
    let changed = false;
    for (const object of targets)
      if (!this.fades.has(object)) {
        const materials = new Set<THREE.Material>();
        object.traverse((child) => {
          if (!(child instanceof THREE.Mesh)) return;
          for (const material of Array.isArray(child.material) ? child.material : [child.material])
            if (material instanceof THREE.Material && !materials.has(material)) {
              materials.add(material);
              const saved = this.faded.get(material);
              if (saved) {
                saved.users += 1;
                continue;
              }
              this.faded.set(material, {
                opacity: material.opacity,
                alphaTest: material.alphaTest,
                alphaHash: material.alphaHash,
                stencil: saveStencil(material),
                users: 1,
                level: 1,
              });
              // Alpha hashing keeps depth testing and writing on, so the faded set still sorts with the cast.
              material.alphaHash = true;
              // Its surviving pixels hide the silhouette, as any nearer surface does.
              writeSilhouetteBit(material, 0);
              material.needsUpdate = true;
            }
        });
        this.fades.set(object, { level: 1, materials });
      }
    const range = 1 - OCCLUSION.fadedOpacity;
    for (const [object, fade] of this.fades) {
      const target = targets.has(object) ? OCCLUSION.fadedOpacity : 1;
      const level =
        fade.level < target
          ? Math.min(target, fade.level + range * step)
          : Math.max(target, fade.level - range * step);
      if (level !== fade.level) changed = true;
      fade.level = level;
      if (level >= 1 && target === 1) {
        this.restore(fade);
        this.fades.delete(object);
        changed = true;
      }
    }
    // A material shared by several fading occluders takes the faintest of their levels.
    for (const saved of this.faded.values()) saved.level = 1;
    for (const fade of this.fades.values())
      for (const material of fade.materials) {
        const saved = this.faded.get(material)!;
        saved.level = Math.min(saved.level, fade.level);
      }
    // Alpha test scales with opacity so a cut-out keeps its shape while it fades.
    for (const [material, saved] of this.faded) {
      material.opacity = saved.opacity * saved.level;
      if (saved.alphaTest > 0) material.alphaTest = saved.alphaTest * saved.level;
    }
    this.metrics.faded = this.fades.size;
    return changed;
  }

  /** The last fade using a material puts back its one saved original. */
  private restore(fade: Fade): void {
    for (const material of fade.materials) {
      const saved = this.faded.get(material);
      if (!saved || --saved.users > 0) continue;
      this.faded.delete(material);
      material.opacity = saved.opacity;
      material.alphaTest = saved.alphaTest;
      material.alphaHash = saved.alphaHash;
      Object.assign(material, saved.stencil);
      material.needsUpdate = true;
    }
  }

  private easeSilhouette(
    scene: THREE.Scene,
    body: Body | undefined,
    show: boolean,
    step: number,
  ): boolean {
    if (this.silhouette && this.silhouette.userData.body !== body) this.retireSilhouette();
    if (!body || (!show && !this.silhouette)) return false;
    if (!this.silhouette) {
      const material = new THREE.MeshBasicNodeMaterial({
        color: this.accent,
        transparent: true,
        depthWrite: false,
        fog: false,
        toneMapped: false,
      });
      // Drawn only where something nearer than the body covers it, and only where the nearest
      // surface is a solid occluder's (the silhouette bit), never over a faded canopy's surviving
      // pixels or a character in front.
      material.depthFunc = THREE.GreaterDepth;
      Object.assign(material, {
        stencilWrite: true,
        stencilRef: SILHOUETTE_STENCIL,
        stencilFuncMask: SILHOUETTE_STENCIL,
        stencilWriteMask: 0,
        stencilFunc: THREE.EqualStencilFunc,
        stencilFail: THREE.KeepStencilOp,
        stencilZFail: THREE.KeepStencilOp,
        stencilZPass: THREE.KeepStencilOp,
      });
      const map = bodyMap(body);
      if (map) this.silhouetteMap.value = map;
      material.opacityNode = map
        ? this.silhouetteMap.sample(uv()).a.mul(this.silhouetteOpacity)
        : float(this.silhouetteOpacity);
      material.alphaTest = 0.01;
      const mesh = new THREE.Mesh(body.geometry, material);
      mesh.name = "occlusion-silhouette";
      mesh.matrixAutoUpdate = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 39000;
      mesh.userData.body = body;
      this.silhouette = mesh;
      this.silhouetteOpacity.value = 0;
      scene.add(mesh);
    }
    const mesh = this.silhouette;
    const map = bodyMap(body);
    if (map) this.silhouetteMap.value = map;
    body.updateWorldMatrix(true, false);
    mesh.matrix.copy(body.matrixWorld);
    mesh.matrixWorldNeedsUpdate = true;
    const target = show ? OCCLUSION.silhouetteOpacity : 0;
    const current = this.silhouetteOpacity.value;
    const next =
      current < target
        ? Math.min(target, current + OCCLUSION.silhouetteOpacity * step)
        : Math.max(target, current - OCCLUSION.silhouetteOpacity * step);
    this.silhouetteOpacity.value = next;
    this.metrics.silhouette = next;
    if (next === 0 && !show) {
      this.retireSilhouette();
      return true;
    }
    return next !== current;
  }

  private retireSilhouette(): void {
    this.unmark();
    if (!this.silhouette) return;
    this.silhouette.removeFromParent();
    this.silhouette.material.dispose();
    this.silhouette = undefined;
    this.silhouetteOpacity.value = 0;
    this.metrics.silhouette = 0;
  }
}

function bodyMap(body: Body): THREE.Texture | undefined {
  const material = Array.isArray(body.material) ? body.material[0] : body.material;
  const map = (material as (THREE.Material & { map?: THREE.Texture | null }) | undefined)?.map;
  return map ?? undefined;
}
