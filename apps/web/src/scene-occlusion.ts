import type { ObjectId } from "@clockgrove/contracts";
import { float, texture, uniform, uv } from "three/tsl";
import * as THREE from "three/webgpu";
import type { RendererContentOccluder } from "./renderer-content.js";
import type { SceneOcclusionReveal } from "./world-scene-adapter.js";

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
}
interface Fade {
  level: number;
  readonly materials: Map<
    THREE.Material,
    { opacity: number; alphaTest: number; alphaHash: boolean }
  >;
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
  };
  private readonly raycaster = new THREE.Raycaster();
  private readonly hits: THREE.Intersection[] = [];
  private readonly point = new THREE.Vector3();
  private readonly fades = new Map<THREE.Object3D, Fade>();
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
    const step = frame.reducedMotion || this.last === undefined ? 1 : (now - this.last) / 400;
    this.last = now;
    if (frame.objectId !== this.objectId) {
      this.objectId = frame.objectId;
      this.hiddenSince = undefined;
      this.metrics.revealed = false;
    }
    const covered = body && occluders.length > 0 ? this.cover(body, frame.camera, occluders) : [];
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
    return changed;
  }

  /** Content went or the scene is retiring: restore every faded material and drop the silhouette. */
  reset(): void {
    for (const [object, fade] of this.fades) this.restore(object, fade);
    this.fades.clear();
    this.retireSilhouette();
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

  /** For each sample point on the body's quad, the visible occluders between it and the camera. */
  private cover(
    body: Body,
    camera: THREE.OrthographicCamera,
    occluders: readonly RendererContentOccluder[],
  ): RendererContentOccluder[][] {
    body.updateMatrixWorld();
    const geometry = body.geometry;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    const visible = occluders.filter((occluder) => {
      for (let object: THREE.Object3D | null = occluder.object; object; object = object.parent)
        if (!object.visible) return false;
      return true;
    });
    for (const occluder of visible) occluder.object.updateMatrixWorld();
    const cameraZ = camera.position.z;
    return SAMPLE_UV.map(([u, v]) => {
      this.point
        .set(
          box.min.x + (box.max.x - box.min.x) * u,
          box.min.y + (box.max.y - box.min.y) * v,
          (box.min.z + box.max.z) / 2,
        )
        .applyMatrix4(body.matrixWorld);
      // An orthographic camera looking down -z: every view ray is parallel to it.
      this.raycaster.set(this.point.clone().setZ(cameraZ), TOWARD_SCENE);
      this.raycaster.near = 0;
      this.raycaster.far = Math.max(0, cameraZ - this.point.z - 1);
      return visible.filter((occluder) => {
        this.hits.length = 0;
        this.raycaster.intersectObject(occluder.object, true, this.hits);
        return this.hits.length > 0;
      });
    });
  }

  private easeFades(targets: ReadonlySet<THREE.Object3D>, step: number): boolean {
    let changed = false;
    for (const object of targets)
      if (!this.fades.has(object)) {
        const materials: Fade["materials"] = new Map();
        object.traverse((child) => {
          if (!(child instanceof THREE.Mesh)) return;
          for (const material of Array.isArray(child.material) ? child.material : [child.material])
            if (material instanceof THREE.Material && !materials.has(material)) {
              materials.set(material, {
                opacity: material.opacity,
                alphaTest: material.alphaTest,
                alphaHash: material.alphaHash,
              });
              // Alpha hashing keeps depth testing and writing on, so the faded set still sorts with the cast.
              material.alphaHash = true;
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
        this.restore(object, fade);
        this.fades.delete(object);
        changed = true;
        continue;
      }
      // Alpha test scales with opacity so a cut-out keeps its shape while it fades.
      for (const [material, original] of fade.materials) {
        material.opacity = original.opacity * level;
        if (original.alphaTest > 0) material.alphaTest = original.alphaTest * level;
      }
    }
    this.metrics.faded = this.fades.size;
    return changed;
  }

  private restore(_object: THREE.Object3D, fade: Fade): void {
    for (const [material, original] of fade.materials) {
      material.opacity = original.opacity;
      material.alphaTest = original.alphaTest;
      material.alphaHash = original.alphaHash;
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
      // Drawn only where something nearer than the body covers it.
      material.depthFunc = THREE.GreaterDepth;
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
    body.updateMatrixWorld();
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
