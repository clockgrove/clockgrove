import type {
  ObjectId,
  SceneMaterialDelivery,
  ScenePatch,
  SceneProjection,
  SceneTransientCue,
  WorldObjectId,
} from "@clockgrove/contracts";
import { decodeSceneMaterialDelivery } from "@clockgrove/contracts";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { pass, vec4 } from "three/tsl";
import * as THREE from "three/webgpu";
import {
  type ContentFailure,
  contentDepth,
  contentLoaders,
  disposeContent,
  materialTextures,
  type RendererContent,
  type RendererContentInstance,
  rendererLibrary,
  rendererNodes,
  validateContent,
} from "./renderer-content.js";
import { worldShell } from "./shell.js";
import {
  applyScenePatch,
  cyclePick,
  INTERPOLATION_MS,
  isNight,
  MATERIAL_DELIVERY_BUDGET,
  movement,
  type PickCycle,
  pickOrder,
  poseMetres,
  type SceneIntent,
  type ScenePlacement,
  selectMaterialRendition,
  shownEffects,
  type WorldSceneAdapter,
} from "./world-scene-adapter.js";

interface AtlasFrame {
  /** Set when the frame continues the strip on a later page; otherwise on the listing page. */
  readonly atlasId?: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
interface AtlasAnimation {
  readonly material?: SceneMaterialDelivery;
  readonly density?: number;
  readonly assetId: string;
  readonly animationFamily: string;
  readonly anchor: { readonly x: number; readonly y: number };
  readonly footprint: { readonly width: number; readonly depth: number };
  readonly frames: readonly AtlasFrame[];
  readonly durationMs: number | null;
}
/** A reviewed animation whose frames each hold the page texture their rect indexes. */
interface AtlasEntry extends Omit<AtlasAnimation, "frames"> {
  readonly frames: readonly (AtlasFrame & { readonly texture: THREE.Texture<HTMLImageElement> })[];
}
interface AtlasPage {
  readonly image: HTMLImageElement;
  readonly animations: readonly AtlasAnimation[];
}
interface Visual {
  readonly placement: ScenePlacement;
  readonly footprint: { readonly width: number; readonly depth: number };
  readonly anchor: { readonly x: number; readonly y: number };
  readonly height: number;
  readonly label: string;
}
type LitMaterial = THREE.MeshStandardNodeMaterial | THREE.MeshLambertNodeMaterial;
type SurfaceMaterial = LitMaterial | THREE.MeshBasicNodeMaterial | THREE.LineBasicNodeMaterial;
type Native =
  | THREE.Mesh<THREE.BufferGeometry, SurfaceMaterial>
  | THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicNodeMaterial>;
interface Drawn {
  visual: Visual;
  readonly body: Native;
  readonly shadow: Native;
  readonly key: string | undefined;
}
export interface SceneMetrics {
  firstRenderMs: number | undefined;
  patchMs: number;
  readonly frameMs: number[];
  entityCount: number;
  effectCount: number;
  textureBytes: number;
  contentStatus: "none" | "loading" | "ready" | "failed";
  contentFailure: ContentFailure | undefined;
  contentFailures: number;
  contentObjects: number;
  contentUpdateMs: number;
}
export type RendererMeasurement =
  | {
      readonly name: "renderer_content";
      readonly category: "ready" | ContentFailure;
      readonly value: number;
    }
  | {
      readonly name: "scene_apply_ms";
      readonly category: "snapshot" | "patch";
      readonly value: number;
    }
  | {
      readonly name: "dropped_cues";
      readonly category: "expired" | "unknown_entity" | "duplicate";
      readonly value: number;
    }
  | { readonly name: "frame_ms"; readonly category: "p95"; readonly value: number }
  | {
      readonly name: "asset_cache";
      readonly category: "loaded" | "failed";
      readonly value: number;
      readonly assetHash?: string;
    }
  | {
      readonly name: "client_errors";
      readonly category: "asset" | "context_lost";
      readonly value: number;
    };
export type RendererReport = (point: RendererMeasurement) => void;
export type QualityTier = "low" | "medium" | "high";
/** Renderer policy, based on #67's tier split. Emission is linear RGB luminance, before grading. */
export const SCENE_QUALITY = {
  low: {
    renderScale: 0.5,
    rain: 0,
    bloomScale: 0,
    bloomStrength: 0,
    reflections: false,
    wind: false,
  },
  medium: {
    renderScale: 1,
    rain: 64,
    bloomScale: 0.5,
    bloomStrength: 0.08,
    reflections: false,
    wind: true,
  },
  high: {
    renderScale: 1,
    rain: 192,
    bloomScale: 1,
    bloomStrength: 0.12,
    reflections: true,
    wind: true,
  },
} as const;
/** Decision: warm sources stay below 0.45 linear luminance; ACES exposure 1 and modest bloom retain hue. */
export const EMISSIVE_LUMINANCE = { min: 0, max: 0.45 } as const;
const ATLASES = worldShell.scene.atlases;
/** The reviewed output's page index (packages/assets ATLAS_INDEX). */
const ATLAS_INDEX = "atlases.json";
const WIDTH = 640,
  HEIGHT = 400;
const PX_PER_METRE = 12.5; // Issue 813: reviewed sprites use 80 mm per pixel.
const ZOOM = { min: 0.75, max: 2 } as const;
const PAN_MARGIN_PX = 160; // Existing Wave 4 camera contract: twice the reviewed kit sprite.
const DRAG_PX = 4,
  PICK_PX = { mouse: 12, touch: 24 }; // docs/scene.md interaction decisions.
const CUE_KEYS = 64,
  CUE_MS = 2 * INTERPOLATION_MS;
const FRAME_SAMPLES = 120; // #67 uses 120 measured frames; telemetry stays bounded.
const FRAME_BUDGET_MS = 33.4; // scene-budgets.json's supported 30 fps floor.
const ATLAS_REFETCHES = 1; // One cache-bypassing retry, then the text path.
const SAGE = worldShell.scene.accent,
  PANEL = worldShell.scene.panel,
  TEXT = worldShell.scene.text;
const REBOUND_EVENTS = ["pointerdown", "pointerover"] as const;
/** Canvas labels draw on their own layer, so a reduced-resolution scene pass never scales their text. */
const LABEL_LAYER = 1;

/**
 * The label layer at the canvas's own resolution over a transparent clear: the scene's opaque
 * background colour is held back for this pass only, so the composite keeps every scene pixel the
 * labels do not cover.
 */
class LabelPass extends THREE.PassNode {
  override updateBefore(frame: THREE.NodeFrame): boolean | undefined {
    const scene = this.scene as THREE.Scene;
    const renderer = frame.renderer;
    const background = scene.background;
    const alpha = renderer?.getClearAlpha();
    scene.background = null;
    renderer?.setClearAlpha(0);
    try {
      return super.updateBefore(frame);
    } finally {
      scene.background = background;
      if (alpha !== undefined) renderer?.setClearAlpha(alpha);
    }
  }
}
const iso = (at: Pick<ScenePlacement, "x" | "y" | "elevation">): [number, number] => [
  (at.x + at.y) * PX_PER_METRE,
  ((at.x - at.y) * PX_PER_METRE) / 2 - at.elevation * PX_PER_METRE,
];
interface Motion {
  readonly fromX: number;
  readonly fromY: number;
  readonly x: number;
  readonly y: number;
  readonly start: number;
}
interface Cue {
  readonly mesh: Native;
  readonly end: number;
  readonly start: number;
  readonly y: number;
}

/** Lit quads in an orthographic 3D scene; canonical projection data alone determines the light rig. */
export class ThreeWorldSceneAdapter implements WorldSceneAdapter {
  readonly metrics: SceneMetrics = {
    firstRenderMs: undefined,
    patchMs: 0,
    frameMs: [],
    entityCount: 0,
    effectCount: 0,
    textureBytes: 0,
    contentStatus: "none",
    contentFailure: undefined,
    contentFailures: 0,
    contentObjects: 0,
    contentUpdateMs: 0,
  };
  private content: RendererContentInstance | undefined;
  private readonly contentAbort = new AbortController();
  private readonly contentLoaderDisposers = new Set<() => void>();
  private contentTime = 0;
  private restoreContentErrors: (() => void) | undefined;
  private readonly contentRoughness = new WeakMap<THREE.Material, number>();
  private readonly started = performance.now();
  private readonly parent: HTMLElement;
  private readonly ready: () => void;
  private readonly unavailable: (reason: "renderer_unavailable" | "assets_unavailable") => void;
  private readonly report: RendererReport;
  private renderer!: THREE.WebGPURenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.OrthographicCamera;
  private canvas: HTMLCanvasElement | undefined;
  /** One texture per reviewed page, filled only once every listed page has loaded and verified. */
  private atlasTextures: THREE.Texture<HTMLImageElement>[] = [];
  private composer: THREE.RenderPipeline | undefined;
  private scenePass: ReturnType<typeof pass> | undefined;
  private labelPass: LabelPass | undefined;
  private bloom: ReturnType<typeof bloom> | undefined;
  private initialized = false;
  get backend(): "initializing" | "webgpu" | "webgl2" {
    if (!this.initialized) return "initializing";
    return "isWebGPUBackend" in this.renderer.backend ? "webgpu" : "webgl2";
  }
  private projection: SceneProjection | undefined;
  private scope: string | undefined;
  private atlas = new Map<string, AtlasEntry>();
  private drawn = new Map<ObjectId, Drawn>();
  private order: ObjectId[] = [];
  effects: { role: string; key: string; sprite: Native; index: number }[] = [];
  private effectsKey = "";
  private handlers = new Set<(intent: SceneIntent) => void>();
  private selected: ObjectId | undefined;
  private focused: ObjectId | undefined;
  private hovered: ObjectId | undefined;
  private overlay: Native[] = [];
  private selection:
    | {
        readonly key: string;
        readonly items: readonly { readonly item: Native; readonly dy: number }[];
      }
    | undefined;
  private reducedMotion = false;
  private cycle: PickCycle | undefined;
  private down: { x: number; y: number; cx: number; cy: number; moved: boolean } | undefined;
  private cueKeys: string[] = [];
  private cues: Cue[] = [];
  private motions = new Map<Native, Motion>();
  private focusMotion: Motion | undefined;
  private bounds = {
    x: -WIDTH / 1.5,
    y: -HEIGHT / 1.5,
    width: WIDTH / 0.75,
    height: HEIGHT / 0.75,
  };
  private rect: DOMRect | undefined;
  private destroyed = false;
  private assetsFailed = false;
  private dirty = true;
  private frame = 0;
  private previousTime: number | undefined;
  private framesSinceReport = 0;
  private tier: QualityTier = "low";
  private rain!: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicNodeMaterial>;
  private night = false;
  private lights: THREE.PointLight[] = [];
  private sky: THREE.DirectionalLight[] = [];
  private materialPageTextures = new Map<string, THREE.Texture<HTMLImageElement>>();
  private materialTransferBytes = 0;
  private transferHashes = new Set<string>();
  private ambient!: THREE.AmbientLight;
  private ground!: THREE.Mesh<THREE.PlaneGeometry, LitMaterial>;
  private reflections: Native[] = [];
  private effectFades = new Map<Native, { readonly start: number; readonly alpha: number }>();
  private readonly lost = (event: Event) => {
    event.preventDefault();
    if (this.destroyed) return;
    this.report({ name: "client_errors", category: "context_lost", value: 1 });
    this.unavailable("renderer_unavailable");
  };
  private readonly rebound = () => this.refreshBounds();
  private readonly pointerdown = (event: PointerEvent) => {
    this.refreshBounds();
    const [x, y] = this.pointer(event);
    this.down = { x, y, cx: this.camera.position.x, cy: -this.camera.position.y, moved: false };
    this.canvas?.setPointerCapture(event.pointerId);
  };
  private readonly pointermove = (event: PointerEvent) => {
    const [x, y] = this.pointer(event);
    if (this.down) {
      const dx = x - this.down.x,
        dy = y - this.down.y;
      if (this.down.moved || Math.hypot(dx, dy) > DRAG_PX) {
        this.down.moved = true;
        this.focusMotion = undefined;
        this.setCamera({
          x: this.down.cx - dx / this.camera.zoom,
          y: this.down.cy - dy / this.camera.zoom,
          zoom: this.camera.zoom,
        });
      }
      return;
    }
    if (event.pointerType === "touch") return;
    const hovered = this.candidates(x, y, false)[0];
    if (hovered !== this.hovered) {
      this.hovered = hovered;
      this.drawEmphasis();
    }
  };
  private readonly pointerup = (event: PointerEvent) => {
    const down = this.down;
    this.down = undefined;
    if (this.canvas?.hasPointerCapture(event.pointerId))
      this.canvas.releasePointerCapture(event.pointerId);
    if (down?.moved) return;
    const [x, y] = this.pointer(event);
    const touch = event.pointerType === "touch";
    const candidates = this.candidates(x, y, touch);
    if (touch) this.cycle = cyclePick(this.cycle, [x, y], candidates);
    const picked = candidates[touch ? (this.cycle?.index ?? 0) : 0];
    if (picked !== undefined)
      for (const handler of this.handlers) handler({ type: "select", objectId: picked });
  };
  private readonly pointercancel = () => {
    this.down = undefined;
  };
  private readonly pointerleave = () => {
    if (!this.down && this.hovered !== undefined) {
      this.hovered = undefined;
      this.drawEmphasis();
    }
  };
  private readonly wheel = (event: WheelEvent) => {
    event.preventDefault();
    this.setCamera({
      x: this.camera.position.x,
      y: -this.camera.position.y,
      zoom: this.camera.zoom * (event.deltaY > 0 ? 0.9 : 1.1),
    });
  };
  constructor(
    parent: HTMLElement,
    ready: () => void,
    unavailable: (reason: "renderer_unavailable" | "assets_unavailable") => void,
    report: RendererReport = () => {},
    private readonly suppliedContent?: RendererContent,
  ) {
    this.parent = parent;
    this.ready = ready;
    this.unavailable = unavailable;
    this.report = report;
    try {
      const canvas = document.createElement("canvas");
      this.renderer = new THREE.WebGPURenderer({
        canvas,
        antialias: false,
        alpha: false,
        stencil: true,
      });
      this.renderer.onDeviceLost = () => this.lost(new Event("devicelost"));
      this.renderer.setPixelRatio(1);
      this.renderer.setSize(WIDTH, HEIGHT);
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1;
      this.scene = new THREE.Scene();
      this.scene.background = new THREE.Color(0x3f6b3a);
      // Decision: camera distance 1000 lies inside 900–1800 fog, a subtle 11% veil on standing quads.
      this.scene.fog = new THREE.Fog(0x43534b, 900, 1800);
      this.camera = new THREE.OrthographicCamera(
        -WIDTH / 2,
        WIDTH / 2,
        HEIGHT / 2,
        -HEIGHT / 2,
        0.1,
        3000,
      );
      this.camera.position.set(0, 0, 1000);
      this.camera.layers.enable(LABEL_LAYER);
      this.ambient = new THREE.AmbientLight(0xffffff, Math.PI);
      this.scene.add(this.ambient);
      const sky = new THREE.DirectionalLight(0xcbdcff, 0.25 * Math.PI);
      sky.position.set(-200, 400, 500);
      this.scene.add(sky);
      this.sky.push(sky);
      this.ground = new THREE.Mesh(
        new THREE.PlaneGeometry(10000, 10000),
        this.litMaterial({ color: 0x3f6b3a, roughness: 1 }),
      );
      this.ground.position.z = -100;
      this.scene.add(this.ground);
      this.canvas = canvas;
      parent.appendChild(canvas);
      canvas.style.touchAction = "none";
      canvas.addEventListener("webglcontextlost", this.lost);
      canvas.addEventListener("pointerdown", this.pointerdown);
      canvas.addEventListener("pointermove", this.pointermove);
      canvas.addEventListener("pointerup", this.pointerup);
      canvas.addEventListener("pointercancel", this.pointercancel);
      canvas.addEventListener("pointerleave", this.pointerleave);
      canvas.addEventListener("wheel", this.wheel, { passive: false });
      for (const event of REBOUND_EVENTS)
        parent.addEventListener(event, this.rebound, { capture: true });
      globalThis.addEventListener("scroll", this.rebound, { capture: true, passive: true });
      this.refreshBounds();
      void this.initialize();
    } catch {
      queueMicrotask(() => {
        if (!this.destroyed) this.unavailable("renderer_unavailable");
      });
    }
  }
  private async initialize(): Promise<void> {
    try {
      await this.renderer.init();
      if (this.destroyed) return;
      this.initialized = true;
      this.observeContentErrors();
      const context =
        this.backend === "webgl2"
          ? (this.renderer.getContext() as WebGL2RenderingContext)
          : undefined;
      const enoughTargets = context
        ? context.getParameter(context.MAX_TEXTURE_SIZE) >= 4096 &&
          Boolean(context.getExtension("EXT_color_buffer_float"))
        : true;
      const rendererInfo = context?.getExtension("WEBGL_debug_renderer_info");
      const device = (
        this.renderer.backend as {
          device?: { adapterInfo?: { architecture?: string; description?: string } };
        }
      ).device;
      const software = /SwiftShader|llvmpipe|software/i.test(
        context && rendererInfo
          ? String(context.getParameter(rendererInfo.UNMASKED_RENDERER_WEBGL))
          : `${device?.adapterInfo?.architecture ?? ""} ${device?.adapterInfo?.description ?? ""}`,
      );
      const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
      this.setQuality(
        !enoughTargets || software || (memory !== undefined && memory < 4)
          ? "low"
          : memory !== undefined && memory < 8
            ? "medium"
            : "high",
      );
      this.frame = requestAnimationFrame(this.step);
      await this.create();
      void this.initializeContent();
    } catch {
      if (!this.destroyed) this.unavailable("renderer_unavailable");
    }
  }
  private observeContentErrors(): void {
    if (!this.suppliedContent || this.backend !== "webgpu") return;
    const device = (this.renderer.backend as { device?: GPUDevice }).device;
    if (!device) return;
    const previousPop = device.popErrorScope;
    const previousError = this.renderer.onError;
    const retire = (instance: RendererContentInstance | undefined) => {
      if (instance && !this.destroyed && this.content === instance)
        this.failContent("content_draw");
    };
    // Three r187 consumes its own pipeline validation scopes asynchronously. An outer
    // scope cannot see those errors, and a frame-scoped logger has already been restored.
    const popErrorScope = () => {
      const instance = this.content;
      const result = previousPop.call(device);
      void result
        .then(
          (error) => {
            if (error) retire(instance);
          },
          () => retire(instance),
        )
        .catch(() => {});
      return result;
    };
    device.popErrorScope = popErrorScope;
    const onError: typeof previousError = (info) => {
      retire(this.content);
      previousError.call(this.renderer, info);
    };
    this.renderer.onError = onError;
    this.restoreContentErrors = () => {
      if (device.popErrorScope === popErrorScope) device.popErrorScope = previousPop;
      if (this.renderer.onError === onError) this.renderer.onError = previousError;
    };
  }
  private async initializeContent(): Promise<void> {
    const supplied = this.suppliedContent;
    if (!supplied || this.destroyed) return;
    this.metrics.contentStatus = "loading";
    if (supplied.version !== 1) {
      this.failContent("content_contract");
      return;
    }
    try {
      const instance = await supplied.create(
        Object.freeze({
          THREE: rendererLibrary,
          TSL: rendererNodes,
          backend: this.backend as "webgpu" | "webgl2",
          signal: this.contentAbort.signal,
          place: (object: THREE.Object3D, at: { x: number; y: number; elevation?: number }) => {
            const elevation = at.elevation ?? 0;
            object.position.set(
              (at.x + at.y) * PX_PER_METRE,
              (-(at.x - at.y) * PX_PER_METRE) / 2 + elevation * PX_PER_METRE,
              contentDepth(at.x, at.y, elevation),
            );
            object.scale.set(PX_PER_METRE, PX_PER_METRE, 0.01);
          },
          loaders: async (paths: { basis: string; draco: string }) => {
            const loaders = await contentLoaders(this.renderer, paths);
            if (this.contentAbort.signal.aborted) {
              loaders.dispose();
              throw new Error("content retired");
            }
            this.contentLoaderDisposers.add(loaders.dispose);
            return { gltf: loaders.gltf, ktx2: loaders.ktx2 };
          },
        }),
      );
      if (this.contentAbort.signal.aborted) {
        this.disposeInstance(instance);
        return;
      }
      this.content = instance;
      if (
        !instance ||
        !(instance.root instanceof THREE.Group) ||
        instance.root.parent ||
        typeof instance.update !== "function" ||
        !validateContent(instance.root)
      ) {
        this.failContent("content_contract");
        return;
      }
      this.scene.add(instance.root);
      this.metrics.contentStatus = "ready";
      this.setQuality(this.tier);
      this.draw();
      if (this.content === instance)
        this.report({ name: "renderer_content", category: "ready", value: 1 });
    } catch {
      if (!this.destroyed) this.failContent("content_load");
    }
  }
  private disposeInstance(instance: RendererContentInstance): void {
    try {
      instance.dispose?.();
    } catch {
      /* Scene retirement must continue. */
    }
    try {
      if (instance.root instanceof THREE.Group) disposeContent(instance.root, instance.textures);
    } catch {
      /* Invalid content is detached below. */
    }
    instance.root?.removeFromParent();
  }
  private failContent(reason: ContentFailure): void {
    if (this.metrics.contentStatus === "failed") return;
    this.contentAbort.abort();
    const instance = this.content;
    this.content = undefined;
    if (instance) this.disposeInstance(instance);
    for (const dispose of this.contentLoaderDisposers) {
      try {
        dispose();
      } catch {}
    }
    this.contentLoaderDisposers.clear();
    this.metrics.contentStatus = "failed";
    this.metrics.contentFailure = reason;
    this.metrics.contentFailures += 1;
    this.metrics.contentObjects = 0;
    this.report({ name: "renderer_content", category: reason, value: 1 });
    this.draw();
    this.dirty = true;
  }
  private updateContent(timeMs: number): boolean {
    const instance = this.content;
    const projection = this.projection;
    if (!instance || !projection) return false;
    const started = performance.now();
    try {
      instance.update(
        Object.freeze({
          backend: this.backend as "webgpu" | "webgl2",
          qualityTier: this.tier,
          reducedMotion: this.reducedMotion,
          simulationTime: projection.simulationTime,
          weather: Object.freeze({ ...projection.weather }),
          timeMs: this.reducedMotion ? 0 : timeMs,
        }),
      );
      this.applyMaterialTier(true);
      if (!this.content) return true;
      if (instance.root.parent !== this.scene || !validateContent(instance.root)) {
        this.failContent("content_contract");
        return true;
      }
      let count = 0;
      instance.root.traverse(() => {
        count += 1;
      });
      this.metrics.contentObjects = count;
      this.updateTextureBytes();
      return true;
    } catch {
      this.failContent("content_update");
      return true;
    } finally {
      this.metrics.contentUpdateMs = performance.now() - started;
    }
  }
  private refreshBounds(): void {
    this.rect = this.canvas?.getBoundingClientRect();
  }
  private pointer(event: PointerEvent): [number, number] {
    const rect = this.rect;
    return rect?.width && rect.height
      ? [
          ((event.clientX - rect.left) * WIDTH) / rect.width,
          ((event.clientY - rect.top) * HEIGHT) / rect.height,
        ]
      : [0, 0];
  }
  private failAssets(): void {
    if (this.destroyed || this.assetsFailed) return;
    this.assetsFailed = true;
    this.report({ name: "asset_cache", category: "failed", value: 1 });
    this.report({ name: "client_errors", category: "asset", value: 1 });
    this.unavailable("assets_unavailable");
  }
  private async fetchAtlas(
    page: string,
    expected: string,
    init?: RequestInit,
  ): Promise<ArrayBuffer | undefined> {
    try {
      const response = await fetch(`/${page}.png`, init);
      if (!response.ok) return;
      const bytes = await response.arrayBuffer();
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
      if (hash !== expected) return;
      if (!this.transferHashes.has(hash)) {
        this.transferHashes.add(hash);
        this.materialTransferBytes += bytes.byteLength;
      }
      return bytes;
    } catch {
      return;
    }
  }
  /** One page's animations and its digest-verified image; undefined when either is unusable. */
  private async loadPage(page: string): Promise<AtlasPage | undefined> {
    const response = await fetch(`/${page}.animations.json`);
    if (!response.ok) return;
    const source = await response.text();
    this.materialTransferBytes += new TextEncoder().encode(source).byteLength;
    const manifest = JSON.parse(source) as {
      animations: AtlasAnimation[];
      image?: { sha256?: unknown };
    };
    const expected = manifest.image?.sha256;
    if (
      !Array.isArray(manifest.animations) ||
      typeof expected !== "string" ||
      !/^[0-9a-f]{64}$/.test(expected)
    )
      return;
    let bytes = await this.fetchAtlas(page, expected);
    for (let attempt = 0; !bytes && attempt < ATLAS_REFETCHES && !this.destroyed; attempt++) {
      this.report({ name: "asset_cache", category: "failed", value: 1 });
      bytes = await this.fetchAtlas(page, expected, { cache: "reload" });
    }
    if (!bytes || this.destroyed) return;
    const url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
    const image = new Image();
    try {
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = reject;
        image.src = url;
      });
    } finally {
      URL.revokeObjectURL(url);
    }
    return { image, animations: manifest.animations };
  }
  private async materialAnimation(
    animation: AtlasAnimation,
    legacy: AtlasEntry,
  ): Promise<AtlasEntry> {
    if (!animation.material) return legacy;
    this.updateTextureBytes();
    const material = decodeSceneMaterialDelivery(animation.material);
    const rendition = selectMaterialRendition(material, globalThis.devicePixelRatio ?? 1, {
      transferBytes: Math.max(
        0,
        MATERIAL_DELIVERY_BUDGET.transferBytes - this.materialTransferBytes,
      ),
      textureBytes: Math.max(0, MATERIAL_DELIVERY_BUDGET.textureBytes - this.metrics.textureBytes),
    });
    if (!rendition) return legacy;
    const albedo = rendition.channels.albedo;
    const pages = albedo.pages ?? [{ atlasId: albedo.frames[0]?.atlasId, image: albedo.image }];
    const textures = new Map<string, THREE.Texture<HTMLImageElement>>();
    for (const page of pages) {
      if (!page.atlasId) throw new Error("material page identity missing");
      const textureKey = `${page.image.sha256}/${albedo.encoding ?? "srgb"}`;
      let texture = this.materialPageTextures.get(textureKey);
      if (!texture) {
        const bytes = await this.fetchAtlas(page.atlasId, page.image.sha256);
        if (!bytes || this.destroyed) throw new Error("material albedo unavailable");
        const url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
        const image = new Image();
        try {
          await new Promise<void>((resolve, reject) => {
            image.onload = () => resolve();
            image.onerror = reject;
            image.src = url;
          });
        } finally {
          URL.revokeObjectURL(url);
        }
        if (image.width !== page.image.width || image.height !== page.image.height)
          throw new Error("material dimensions differ");
        texture = new THREE.Texture(image);
        texture.colorSpace =
          albedo.encoding === "linear" ? THREE.NoColorSpace : THREE.SRGBColorSpace;
        texture.magFilter = THREE.NearestFilter;
        texture.minFilter = THREE.LinearFilter;
        texture.generateMipmaps = false;
        texture.needsUpdate = true;
        this.atlasTextures.push(texture);
        this.materialPageTextures.set(textureKey, texture);
      }
      textures.set(page.atlasId, texture);
    }
    const frames = albedo.frames.map((frame) => ({
      ...frame,
      texture: textures.get(frame.atlasId ?? pages[0]!.atlasId!),
    }));
    if (!frames.every((frame) => frame.texture)) throw new Error("material frame page missing");
    return { ...animation, density: rendition.density, frames: frames as AtlasEntry["frames"] };
  }

  private async create(): Promise<void> {
    if (!ATLASES) {
      this.ready();
      this.draw();
      return;
    }
    try {
      const response = await fetch(`/${ATLAS_INDEX}`);
      if (!response.ok) return this.failAssets();
      const indexSource = await response.text();
      this.materialTransferBytes += new TextEncoder().encode(indexSource).byteLength;
      const names = (JSON.parse(indexSource) as { atlases?: unknown }).atlases;
      if (
        !Array.isArray(names) ||
        names.length === 0 ||
        new Set(names).size !== names.length ||
        !names.every((name) => typeof name === "string" && /^[a-z0-9-]+$/.test(name))
      )
        return this.failAssets();
      const pages = await Promise.all(names.map((name: string) => this.loadPage(name)));
      if (this.destroyed) return;
      const keys = pages.flatMap((page) =>
        (page?.animations ?? []).map((a) => `${a.assetId}/${a.animationFamily}`),
      );
      // Every page must load, and each animation appears on exactly one page.
      if (pages.some((page) => !page) || new Set(keys).size !== keys.length)
        return this.failAssets();
      let bytes = 0;
      const textures = new Map<string, THREE.Texture<HTMLImageElement>>();
      (pages as AtlasPage[]).forEach(({ image }, n) => {
        const texture = new THREE.Texture(image);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.magFilter = THREE.NearestFilter;
        texture.minFilter = THREE.LinearFilter;
        texture.generateMipmaps = false;
        texture.needsUpdate = true;
        this.atlasTextures.push(texture);
        textures.set(names[n] as string, texture);
        bytes += image.width * image.height * 4;
      });
      // A strip that continues onto later pages names each of its frames' pages.
      for (const [n, { animations }] of (pages as AtlasPage[]).entries())
        for (const animation of animations) {
          const frames = animation.frames.map((frame) => ({
            ...frame,
            texture: textures.get(frame.atlasId ?? (names[n] as string)),
          }));
          if (!frames.every((frame) => frame.texture)) return this.failAssets();
          this.atlas.set(
            `${animation.assetId}/${animation.animationFamily}`,
            await this.materialAnimation(animation, {
              ...animation,
              frames: frames as AtlasEntry["frames"],
            }),
          );
        }
      this.updateTextureBytes();
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(
          JSON.stringify((pages as AtlasPage[]).map((page) => page.animations)),
        ),
      );
      if (this.destroyed) return;
      const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
      this.report({
        name: "asset_cache",
        category: "loaded",
        value: bytes,
        assetHash: `sha256:${hash}`,
      });
      this.ready();
      this.draw();
    } catch {
      this.failAssets();
    }
  }
  loadSnapshot(snapshot: SceneProjection, kind: "snapshot" | "patch" = "snapshot"): void {
    this.projection = snapshot;
    this.draw(kind);
  }
  applyPatch(patch: ScenePatch): void {
    if (!this.projection || patch.fromRevision !== this.projection.revision) return;
    this.loadSnapshot(applyScenePatch(this.projection, patch), "patch");
  }
  onIntent(handler: (intent: SceneIntent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  setSelection(id?: WorldObjectId): void {
    this.selected = id;
    this.drawEmphasis();
  }
  focus(id?: WorldObjectId): void {
    this.focused = id;
    const drawn = id === undefined ? undefined : this.drawn.get(id);
    if (drawn) {
      const x = drawn.body.position.x,
        y = -drawn.body.position.y;
      if (
        Math.abs(x - this.camera.position.x) > WIDTH / (2 * this.camera.zoom) ||
        Math.abs(y + this.camera.position.y) > HEIGHT / (2 * this.camera.zoom)
      ) {
        if (this.reducedMotion) this.setCamera({ x, y, zoom: this.camera.zoom });
        else
          this.focusMotion = {
            fromX: this.camera.position.x,
            fromY: -this.camera.position.y,
            x,
            y,
            start: performance.now(),
          };
      }
    }
    this.drawEmphasis();
  }
  setReducedMotion(enabled: boolean): void {
    this.reducedMotion = enabled;
    if (enabled) {
      for (const [mesh, motion] of this.motions)
        mesh.position.set(motion.x, motion.y, mesh.position.z);
      this.motions.clear();
      if (this.focusMotion)
        this.setCamera({ x: this.focusMotion.x, y: this.focusMotion.y, zoom: this.camera.zoom });
      this.focusMotion = undefined;
      for (const cue of this.cues) {
        cue.mesh.position.y = cue.y;
        cue.mesh.material.opacity = 1;
      }
    }
    this.animate(0);
    this.updateContent(this.contentTime);
    this.drawEmphasis();
    this.dirty = true;
  }
  /** Tiers are renderer-local policy; no world or material contract changes when budget drops. */
  setQuality(tier: QualityTier): void {
    if (!(tier in SCENE_QUALITY) || !this.renderer) return;
    this.tier = tier;
    this.applyMaterialTier();
    this.disposePost();
    const quality = SCENE_QUALITY[tier];
    this.scenePass = pass(this.scene, this.camera, { stencilBuffer: true });
    // Low tier shades one quarter of the fragments, then composites to the unchanged logical canvas.
    this.scenePass.setResolutionScale(quality.renderScale);
    const color = this.scenePass.getTextureNode("output");
    if (quality.bloomScale > 0) {
      this.bloom = bloom(color, quality.bloomStrength, 0.2, 0.8);
      this.bloom.setResolutionScale(quality.bloomScale);
    }
    let output = this.bloom ? color.add(this.bloom) : color;
    if (quality.renderScale < 1) {
      // Labels skip the reduced scene pass and draw at full resolution, so their text stays legible.
      this.scenePass.setLayers(new THREE.Layers());
      const layer = new THREE.Layers();
      layer.set(LABEL_LAYER);
      this.labelPass = new LabelPass(THREE.PassNode.COLOR, this.scene, this.camera, {
        depthBuffer: false,
      });
      this.labelPass.setLayers(layer);
      // The label target holds colour already weighted by coverage: draw it over the scene.
      const labels = this.labelPass.getTextureNode("output");
      output = vec4(output.rgb.mul(labels.a.oneMinus()).add(labels.rgb), output.a);
    }
    this.composer = new THREE.RenderPipeline(this.renderer, output);
    this.rebuildRain();
    if (this.projection) this.drawEnvironment(this.projection);
    this.rebuildReflections();
    this.updateTextureBytes();
    this.dirty = true;
  }
  private applyMaterialTier(contentOnly = false): void {
    const contentMeshes = new Set<THREE.Object3D>();
    this.content?.root.traverse((object) => contentMeshes.add(object));
    const replacements = new Map<THREE.Material, LitMaterial>();
    let contentFailed = false;
    const root = contentOnly ? this.content?.root : this.scene;
    const tier = this.tier;
    root?.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const owned = contentMeshes.has(object);
      if (!owned && object.userData.source) return;
      const convert = (previous: THREE.Material): THREE.Material => {
        if (
          !(
            previous instanceof THREE.MeshStandardNodeMaterial ||
            previous instanceof THREE.MeshLambertNodeMaterial
          ) ||
          previous instanceof THREE.MeshLambertNodeMaterial === (tier === "low")
        )
          return previous;
        const existing = replacements.get(previous);
        if (existing) return existing;
        const roughness =
          previous instanceof THREE.MeshStandardNodeMaterial
            ? previous.roughness
            : (this.contentRoughness.get(previous) ?? 1);
        const next =
          tier === "low"
            ? new THREE.MeshLambertNodeMaterial().copy(previous)
            : new THREE.MeshStandardNodeMaterial().copy(previous);
        if (owned) this.contentRoughness.set(next, roughness);
        if (next instanceof THREE.MeshStandardNodeMaterial)
          next.roughness = owned ? roughness : object.name === "puddle" ? 0.08 : 1;
        replacements.set(previous, next);
        return next;
      };
      try {
        object.material = Array.isArray(object.material)
          ? object.material.map(convert)
          : convert(object.material);
      } catch (error) {
        if (!owned) throw error;
        contentFailed = true;
      }
    });
    for (const previous of replacements.keys()) {
      try {
        previous.dispose();
      } catch {
        /* Continue retiring shared material resources. */
      }
    }
    if (contentFailed) this.failContent("content_contract");
  }
  private disposePost(): void {
    if (!this.composer) return;
    this.bloom?.dispose();
    this.scenePass?.dispose();
    this.scenePass = undefined;
    this.labelPass?.dispose();
    this.labelPass = undefined;
    this.composer.dispose();
    this.composer = undefined;
    this.bloom = undefined;
  }
  setCamera({ x, y, zoom }: { x: number; y: number; zoom: number }): void {
    if (!this.camera) return;
    zoom = Math.max(ZOOM.min, Math.min(ZOOM.max, zoom));
    const halfX = WIDTH / (2 * zoom),
      halfY = HEIGHT / (2 * zoom);
    x = Math.max(this.bounds.x + halfX, Math.min(this.bounds.x + this.bounds.width - halfX, x));
    y = Math.max(this.bounds.y + halfY, Math.min(this.bounds.y + this.bounds.height - halfY, y));
    this.camera.position.set(x, -y, 1000);
    this.camera.zoom = zoom;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    this.dirty = true;
  }
  private frameCamera(placements: readonly ScenePlacement[]): void {
    const points = placements.map(iso),
      xs = points.map(([x]) => x),
      ys = points.map(([, y]) => y);
    const [minX, maxX, minY, maxY] = points.length
      ? [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
      : [0, 0, 0, 0];
    const cx = ((minX ?? 0) + (maxX ?? 0)) / 2,
      cy = ((minY ?? 0) + (maxY ?? 0)) / 2;
    const width = Math.max((maxX ?? 0) - (minX ?? 0) + 2 * PAN_MARGIN_PX, WIDTH / ZOOM.min);
    const height = Math.max((maxY ?? 0) - (minY ?? 0) + 2 * PAN_MARGIN_PX, HEIGHT / ZOOM.min);
    this.bounds = { x: cx - width / 2, y: cy - height / 2, width, height };
    this.setCamera({ x: cx, y: cy, zoom: 1 });
  }
  private candidates(x: number, y: number, touch: boolean): ObjectId[] {
    const wx = this.camera.position.x + (x - WIDTH / 2) / this.camera.zoom;
    const wy = -this.camera.position.y + (y - HEIGHT / 2) / this.camera.zoom;
    const radius = (touch ? PICK_PX.touch : PICK_PX.mouse) / this.camera.zoom;
    return this.order.filter((id) => {
      const drawn = this.drawn.get(id);
      if (!drawn) return false;
      return (
        Math.hypot(
          wx - drawn.body.position.x,
          wy + drawn.body.position.y + drawn.visual.height / 2,
        ) <= Math.max(radius, drawn.visual.height / 2)
      );
    });
  }
  private visual(placement: ScenePlacement, key: string | undefined): Visual {
    const label =
      this.projection?.entities.find((entity) => entity.objectId === placement.objectId)
        ?.presentation.label ?? placement.objectId;
    const animation = key === undefined ? undefined : this.atlas.get(key);
    return {
      placement,
      footprint: animation?.footprint ?? { width: 600, depth: 600 },
      anchor: animation?.anchor ?? { x: 8, y: 8 },
      height: animation?.anchor.y ?? 0,
      label,
    };
  }
  // Low tier omits the Standard BRDF's GGX/Fresnel work; both node materials retain projected lights and fog.
  private litMaterial(parameters: {
    color?: number;
    map?: THREE.Texture;
    transparent?: boolean;
    alphaTest?: number;
    depthWrite?: boolean;
    roughness?: number;
  }): LitMaterial {
    const { roughness = 1, ...common } = parameters;
    return this.tier === "low"
      ? new THREE.MeshLambertNodeMaterial(common)
      : new THREE.MeshStandardNodeMaterial({ ...common, roughness });
  }
  private sprite(key: string, name = ""): Native {
    const animation = this.atlas.get(key);
    const frame = animation?.frames[0];
    if (!animation || !frame) return this.ellipse(16, 16, 0xe3ce8b, 1, name);
    const material = this.litMaterial({
      map: frame.texture,
      transparent: true,
      alphaTest: 0.05,
      roughness: 1,
      depthWrite: false,
    });
    const density = animation.density ?? 1;
    const logicalWidth = frame.width / density,
      logicalHeight = frame.height / density;
    const geometry = new THREE.PlaneGeometry(logicalWidth, logicalHeight, 4, 4);
    geometry.translate(
      logicalWidth / 2 - animation.anchor.x,
      animation.anchor.y - logicalHeight / 2,
      0,
    );
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.frustumCulled = false;
    mesh.userData = {
      key,
      frame: -1,
      playing: false,
      width: logicalWidth,
      height: logicalHeight,
      base: new Float32Array(geometry.getAttribute("position").array),
      baseUv: new Float32Array(geometry.getAttribute("uv").array),
    };
    this.setFrame(mesh, 0);
    return mesh;
  }
  private setFrame(mesh: Native, index: number): boolean {
    if (mesh.userData.frame === index) return false;
    const animation = this.atlas.get(mesh.userData.key);
    const frame = animation?.frames[index];
    if (!animation || !frame) return false;
    const uv = mesh.geometry.getAttribute("uv");
    const base = mesh.userData.baseUv as Float32Array | undefined;
    if (!uv || !base) return false;
    if (mesh.material.map !== frame.texture) {
      mesh.material.map = frame.texture;
      mesh.material.needsUpdate = true;
    }
    const image = frame.texture.image;
    for (let i = 0; i < uv.count; i++)
      uv.setXY(
        i,
        (frame.x + (base[i * 2] ?? 0) * frame.width) / image.width,
        1 - (frame.y + frame.height - (base[i * 2 + 1] ?? 0) * frame.height) / image.height,
      );
    uv.needsUpdate = true;
    mesh.userData.frame = index;
    return true;
  }
  private spawn(visual: Visual, x: number, y: number, key: string | undefined): Drawn {
    const span = ((visual.footprint.width + visual.footprint.depth) / 1000) * PX_PER_METRE;
    const shadow = this.ellipse(span, span / 2, 0x000000, 0.22, "shadow");
    const body = key
      ? this.sprite(key, String(visual.placement.objectId))
      : new THREE.Mesh(
          new THREE.CircleGeometry(8, 32),
          this.litMaterial({ color: 0xe3ce8b, roughness: 1 }),
        );
    body.position.set(x, -y, 0);
    shadow.position.set(x, -y, -40);
    this.scene.add(body, shadow);
    return { visual, body, shadow, key };
  }
  private draw(kind: "snapshot" | "patch" = "snapshot"): void {
    const projection = this.projection;
    if (
      !this.initialized ||
      (ATLASES && this.atlasTextures.length === 0) ||
      !projection ||
      this.destroyed
    )
      return;
    const started = performance.now();
    const scope = `${projection.tenantId}/${projection.worldId}/${projection.timelineId}/${projection.spaceId}`;
    const placements = pickOrder(projection);
    const bindings = new Map(
      projection.presentationBindings.map((binding) => [binding.objectId, binding]),
    );
    const rebuilt = scope !== this.scope;
    if (rebuilt) {
      for (const drawn of this.drawn.values()) this.release(drawn);
      this.drawn.clear();
      this.releaseEffects();
      this.scope = scope;
      this.frameCamera(placements);
    }
    const present = new Set(placements.map((at) => at.objectId));
    for (const [id, drawn] of this.drawn)
      if (!present.has(id)) {
        this.release(drawn);
        this.drawn.delete(id);
      }
    [...placements].reverse().forEach((placement, index) => {
      const binding = bindings.get(placement.objectId);
      const bound = binding && `${binding.assetId}/${binding.animationFamily}`;
      const key = bound && this.atlas.has(bound) ? bound : undefined;
      const visual = this.visual(placement, key),
        [x, y] = iso(placement);
      let drawn = this.drawn.get(placement.objectId);
      if (drawn && drawn.key !== key) {
        this.release(drawn);
        drawn = undefined;
      }
      if (!drawn) {
        drawn = this.spawn(visual, x, y, key);
        this.drawn.set(placement.objectId, drawn);
      } else {
        const move = movement(drawn.visual.placement, placement);
        for (const mesh of [drawn.body, drawn.shadow]) {
          const motion = this.motions.get(mesh);
          if (
            move === "snap" ||
            this.reducedMotion ||
            (mesh.position.x === x && mesh.position.y === -y)
          ) {
            this.motions.delete(mesh);
            mesh.position.set(x, -y, mesh.position.z);
          } else if (motion?.x !== x || motion.y !== -y) {
            this.motions.set(mesh, {
              fromX: mesh.position.x,
              fromY: mesh.position.y,
              x,
              y: -y,
              start: performance.now(),
            });
          }
        }
        drawn.visual = visual;
      }
      drawn.body.userData.wind = /(?:shrub|foliage|tree)/u.test(binding?.assetId ?? "");
      drawn.body.renderOrder = 10000 + index;
      drawn.body.position.z = this.content
        ? contentDepth(placement.x, placement.y, placement.elevation)
        : index * 0.01;
      drawn.body.material.depthWrite = this.content ? true : !drawn.key;
      drawn.shadow.renderOrder = index;
    });
    this.order = placements.map((at) => at.objectId);
    this.drawEffects(projection);
    this.drawEnvironment(projection);
    this.drawEmphasis();
    this.rebuildReflections();
    this.metrics.entityCount = this.drawn.size;
    this.updateTextureBytes();
    this.dirty = true;
    if (!rebuilt)
      this.metrics.patchMs = Math.max(this.metrics.patchMs, performance.now() - started);
    this.report({ name: "scene_apply_ms", category: kind, value: performance.now() - started });
  }
  private release(drawn: Drawn): void {
    this.motions.delete(drawn.body);
    this.motions.delete(drawn.shadow);
    this.remove(drawn.body);
    this.remove(drawn.shadow);
  }
  private remove(mesh: Native): void {
    mesh.removeFromParent();
    mesh.geometry?.dispose();
    if (
      mesh.material?.map &&
      !this.atlasTextures.includes(mesh.material.map as THREE.Texture<HTMLImageElement>) &&
      mesh.userData.ownsTexture !== false
    )
      mesh.material.map.dispose();
    mesh.material?.dispose();
  }
  private drawEnvironment(projection: SceneProjection): void {
    this.night = isNight(projection.simulationTime);
    this.scene.userData.night = this.night;
    this.ambient.intensity = Math.PI * (this.night ? 0.4 : 1);
    this.ambient.color.set(this.night ? 0x9caeca : 0xffffff);
    if (this.scene.background instanceof THREE.Color)
      this.scene.background.set(this.night ? 0x192b20 : 0x3f6b3a);
    if (this.scene.fog instanceof THREE.Fog)
      this.scene.fog.color.set(this.night ? 0x25334c : 0x43534b);
    if (this.ground.material instanceof THREE.MeshStandardNodeMaterial)
      this.ground.material.roughness = projection.weather.rainIntensity > 0 ? 0.45 : 1;
    this.rain.visible = projection.weather.rainIntensity > 0;
    if (projection.lighting) {
      projection.lighting.directional.forEach((source, index) => {
        let light = this.sky[index];
        if (!light) {
          light = new THREE.DirectionalLight();
          this.sky.push(light);
          this.scene.add(light);
        }
        light.color.set(source.colour);
        light.intensity = source.intensity;
        light.position.set(...(source.direction.map((v) => -v) as [number, number, number]));
      });
      while (this.sky.length > projection.lighting.directional.length)
        this.sky.pop()?.removeFromParent();
      this.scene.userData.gradingKey = projection.lighting.gradingKey;
      this.scene.userData.weatherIntensity = projection.lighting.weatherIntensity;
    } else {
      while (this.sky.length > 1) this.sky.pop()?.removeFromParent();
      if (!this.sky[0]) {
        const sky = new THREE.DirectionalLight();
        this.sky.push(sky);
        this.scene.add(sky);
      }
      const sky = this.sky[0];
      if (sky) {
        sky.color.set(0xcbdcff);
        sky.intensity = 0.25 * Math.PI;
        sky.position.set(-200, 400, 500);
      }
      delete this.scene.userData.gradingKey;
      delete this.scene.userData.weatherIntensity;
    }
    let lightCount = 0;
    const frames = new Map(projection.frames.map((frame) => [frame.frameId, frame]));
    const sources =
      projection.lighting?.placed ??
      shownEffects(projection).flatMap((effect) =>
        effect.role === "puddle"
          ? []
          : [{ pose: effect.pose, colour: "#ffb966", intensity: 1500, rangeMetres: 14.4 }],
      );
    for (const effect of sources) {
      if (effect.intensity === 0) continue;
      const at = poseMetres(frames, effect.pose);
      if (!at) continue;
      const [x, y] = iso(at);
      // Decision: 1500 candela at a 35 px offset warms nearby quads; 180 px bounds each source.
      let light = this.lights[lightCount++];
      if (!light) {
        light = new THREE.PointLight(0xffb966, 1500, 180, 2);
        this.lights.push(light);
        this.scene.add(light);
      }
      light.color.set(effect.colour);
      light.intensity = effect.intensity;
      light.distance = effect.rangeMetres * PX_PER_METRE;
      light.position.set(x, -y + 12, 35);
    }
    while (this.lights.length > lightCount) this.lights.pop()?.removeFromParent();
  }
  private drawEffects(projection: SceneProjection): void {
    const effects = projection.effects ?? [];
    const key = JSON.stringify(
      effects.map((effect) => [effect.role, effect.assetId, effect.animationFamily, effect.pose]),
    );
    if (key !== this.effectsKey) {
      this.releaseEffects();
      this.effectsKey = key;
      const frames = new Map(projection.frames.map((frame) => [frame.frameId, frame]));
      effects.forEach((effect, index) => {
        const key = `${effect.assetId}/${effect.animationFamily}`,
          at = poseMetres(frames, effect.pose);
        if (!this.atlas.has(key) || !at) return;
        const [x, y] = iso(at),
          sprite = this.sprite(key, effect.role);
        sprite.position.set(x, -y, effect.role === "puddle" ? -20 : 10);
        sprite.renderOrder = effect.role === "puddle" ? 5000 + index : 20000 + index;
        sprite.visible = false;
        if (effect.role !== "puddle") {
          (sprite.material as LitMaterial).emissive.set(0xffb966);
          (sprite.material as LitMaterial).emissiveIntensity = EMISSIVE_LUMINANCE.max;
        } else {
          if (sprite.material instanceof THREE.MeshStandardNodeMaterial)
            sprite.material.roughness = 0.08;
          sprite.material.stencilWrite = true;
          sprite.material.stencilRef = 1;
          sprite.material.stencilFunc = THREE.AlwaysStencilFunc;
          sprite.material.stencilZPass = THREE.ReplaceStencilOp;
        }
        this.scene.add(sprite);
        this.effects.push({ role: effect.role, key, sprite, index });
      });
    }
    const shown = new Set(shownEffects(projection));
    for (const item of this.effects) {
      const visible = shown.has(
        effects[item.index] as NonNullable<SceneProjection["effects"]>[number],
      );
      const was = item.sprite.visible && !this.effectFades.has(item.sprite);
      if (visible) {
        this.effectFades.delete(item.sprite);
        item.sprite.visible = true;
        item.sprite.material.opacity = 1;
      } else if (was && item.role === "puddle" && !this.reducedMotion)
        this.effectFades.set(item.sprite, {
          start: performance.now(),
          alpha: item.sprite.material.opacity,
        });
      else if (!this.effectFades.has(item.sprite)) item.sprite.visible = false;
      item.sprite.userData.playing =
        visible && !this.reducedMotion && (this.atlas.get(item.key)?.frames.length ?? 0) > 1;
    }
    this.metrics.effectCount = this.effects.length;
  }
  private releaseEffects(): void {
    for (const { sprite } of this.effects) this.remove(sprite);
    this.effects = [];
    this.effectsKey = "";
    this.effectFades.clear();
    this.metrics.effectCount = 0;
  }
  private rebuildRain(): void {
    if (this.rain) this.remove(this.rain);
    const count = SCENE_QUALITY[this.tier].rain;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 6), 3));
    const material = new THREE.LineBasicNodeMaterial({
      color: 0xa5bed7,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
      depthTest: false,
      fog: false,
      toneMapped: false,
    });
    this.rain = new THREE.LineSegments(geometry, material);
    this.rain.name = "rain";
    this.rain.renderOrder = 30000;
    this.rain.frustumCulled = false;
    this.rain.visible = (this.projection?.weather.rainIntensity ?? 0) > 0;
    this.scene.add(this.rain);
  }
  private rebuildReflections(): void {
    for (const mirror of this.reflections) this.remove(mirror);
    this.reflections = [];
    if (
      !SCENE_QUALITY[this.tier].reflections ||
      !this.projection ||
      !shownEffects(this.projection).some((effect) => effect.role === "puddle")
    )
      return;
    for (const drawn of this.drawn.values()) {
      const mirror = new THREE.Mesh(drawn.body.geometry.clone(), drawn.body.material.clone());
      mirror.userData.ownsTexture = false;
      mirror.material.transparent = true;
      mirror.material.opacity = 0.22;
      mirror.material.depthWrite = false;
      mirror.material.stencilWrite = true;
      mirror.material.stencilRef = 1;
      mirror.material.stencilFunc = THREE.EqualStencilFunc;
      mirror.material.stencilFail = THREE.KeepStencilOp;
      mirror.material.stencilZFail = THREE.KeepStencilOp;
      mirror.material.stencilZPass = THREE.KeepStencilOp;
      mirror.scale.y = -0.5;
      mirror.renderOrder = 9000;
      mirror.userData.source = drawn.body;
      mirror.position.copy(drawn.body.position);
      mirror.position.z = -10;
      this.scene.add(mirror);
      this.reflections.push(mirror);
    }
  }
  private ellipse(
    width: number,
    height: number,
    color: number,
    alpha: number,
    name: string,
    stroke = 0,
    fillAlpha = alpha,
  ): Native {
    const pad = stroke + 2,
      scale = 2;
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil((width + 2 * pad) * scale);
    canvas.height = Math.ceil((height + 2 * pad) * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas labels unavailable");
    ctx.scale(scale, scale);
    ctx.beginPath();
    ctx.ellipse(width / 2 + pad, height / 2 + pad, width / 2, height / 2, 0, 0, Math.PI * 2);
    const hex = `#${color.toString(16).padStart(6, "0")}`;
    if (fillAlpha > 0) {
      ctx.globalAlpha = fillAlpha;
      ctx.fillStyle = hex;
      ctx.fill();
    }
    if (stroke > 0) {
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = hex;
      ctx.lineWidth = stroke;
      ctx.stroke();
    }
    const mesh = this.canvasMesh(canvas, width + 2 * pad, height + 2 * pad, name);
    mesh.userData = {
      width,
      height,
      lineWidth: stroke,
      fillColor: color,
      fillAlpha,
      strokeAlpha: alpha,
    };
    return mesh;
  }
  private canvasMesh(
    canvas: HTMLCanvasElement,
    width: number,
    height: number,
    name: string,
  ): Native {
    const texture = new THREE.CanvasTexture(canvas);
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    texture.colorSpace = THREE.SRGBColorSpace;
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(width, height),
      new THREE.MeshBasicNodeMaterial({
        map: texture,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        toneMapped: false,
        fog: false,
      }),
    );
    mesh.name = name;
    mesh.renderOrder = 40000;
    mesh.frustumCulled = false;
    return mesh;
  }
  private label(text: string, pill: boolean, panelOnly = false): Native {
    const canvas = document.createElement("canvas"),
      ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas labels unavailable");
    ctx.font = "13px sans-serif";
    const textWidth = Math.ceil(ctx.measureText(text).width),
      textHeight = 16;
    const width = textWidth + (pill ? 20 : 0),
      height = textHeight + (pill ? 8 : 0);
    canvas.width = width * 2;
    canvas.height = height * 2;
    ctx.scale(2, 2);
    ctx.font = "13px sans-serif";
    if (pill) {
      ctx.beginPath();
      ctx.roundRect(0.5, 0.5, width - 1, height - 1, height / 2);
      ctx.fillStyle = "rgb(30 33 22 / 92%)";
      ctx.fill();
      ctx.strokeStyle = "rgb(168 195 148 / 60%)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    if (!panelOnly) {
      ctx.fillStyle = TEXT;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(text, width / 2, height / 2);
    }
    const mesh = this.canvasMesh(canvas, width, height, pill ? "selection-pill" : "hover-label");
    mesh.layers.set(LABEL_LAYER);
    mesh.userData = {
      width,
      height,
      ...(panelOnly ? {} : { text }),
      textWidth,
      textHeight,
      fillColor: PANEL,
      fillAlpha: 0.92,
      lineWidth: 1,
      strokeAlpha: 0.6,
      radius: height / 2,
      isRounded: pill,
    };
    return mesh;
  }
  private drawEmphasis(): void {
    if (!this.scene) return;
    for (const mesh of this.overlay) this.remove(mesh);
    this.overlay = [];
    const feet = (id: ObjectId | undefined) => (id === undefined ? undefined : this.drawn.get(id));
    for (const [id, name, width, color] of [
      [this.hovered, "hover-affordance", 24, 0xffffff],
      [this.focused, "focus-affordance", 40, 0x9fd3ff],
    ] as const) {
      const drawn = feet(id);
      if (!drawn) continue;
      const mesh = this.ellipse(width, width / 2, color, 1, name, 1, 0);
      mesh.position.copy(drawn.body.position);
      mesh.position.z = 30;
      this.scene.add(mesh);
      this.overlay.push(mesh);
    }
    const selected = feet(this.selected);
    const key = selected
      ? `${this.selected}\u0000${selected.visual.label}\u0000${selected.visual.height}`
      : "";
    if (key !== this.selection?.key) {
      for (const { item } of this.selection?.items ?? []) this.remove(item);
      this.selection = undefined;
    }
    if (selected) {
      if (!this.selection) {
        const items = [
          { item: this.ellipse(48, 24, SAGE, 0.15, "selection-glow", 10, 0), dy: 0 },
          { item: this.ellipse(40, 20, SAGE, 0.35, "selection-glow", 6, 0), dy: 0 },
          { item: this.ellipse(32, 16, SAGE, 1, "selection-ring", 3, 0.18), dy: 0 },
        ];
        const pill = this.label(selected.visual.label, true, true);
        const label = this.label(selected.visual.label, false);
        label.name = "selection-label";
        pill.renderOrder = 40001;
        label.renderOrder = 40002;
        const dy = -selected.visual.height - 6 - pill.userData.height / 2;
        items.push({ item: pill, dy }, { item: label, dy });
        this.selection = { key, items };
        for (const { item } of items) this.scene.add(item);
      }
      this.moveSelection(selected);
    }
    const hovered = this.hovered !== this.selected ? feet(this.hovered) : undefined;
    if (hovered) {
      const mesh = this.label(hovered.visual.label, false);
      mesh.position.set(
        hovered.body.position.x + 12 + mesh.userData.width / 2,
        hovered.body.position.y + hovered.visual.height + 10 - mesh.userData.height / 2,
        30,
      );
      this.scene.add(mesh);
      this.overlay.push(mesh);
    }
    this.updateTextureBytes();
    this.dirty = true;
  }
  private moveSelection(selected: Drawn): void {
    for (const { item, dy } of this.selection?.items ?? [])
      item.position.set(selected.body.position.x, selected.body.position.y - dy, 30);
  }
  emitCue(cue: SceneTransientCue): void {
    const drawn = this.drawn.get(cue.objectId);
    if (!drawn || !this.scene)
      return void this.report({ name: "dropped_cues", category: "unknown_entity", value: 1 });
    if (this.cueKeys.includes(cue.dedupeKey))
      return void this.report({ name: "dropped_cues", category: "duplicate", value: 1 });
    const remaining = Date.parse(cue.expiresAt) - Date.now();
    if (!(remaining > 0))
      return void this.report({ name: "dropped_cues", category: "expired", value: 1 });
    this.cueKeys.push(cue.dedupeKey);
    if (this.cueKeys.length > CUE_KEYS) this.cueKeys.shift();
    const mesh = this.ellipse(8, 8, 0xffe9a8, 1, "cue");
    mesh.position.set(drawn.body.position.x, drawn.body.position.y + drawn.visual.height, 40);
    const now = performance.now();
    this.cues.push({
      mesh,
      start: now,
      end: now + Math.min(remaining, CUE_MS),
      y: mesh.position.y,
    });
    this.scene.add(mesh);
    this.updateTextureBytes();
    this.dirty = true;
  }
  private animate(time: number): boolean {
    let changed = false;
    const t = this.reducedMotion ? 0 : time;
    for (const drawn of this.drawn.values()) {
      if (!drawn.key) continue;
      const animation = this.atlas.get(drawn.key);
      const count = animation?.frames.length ?? 1;
      const index = Math.floor(t / (animation?.durationMs ?? 250)) % count;
      drawn.body.userData.playing = !this.reducedMotion && count > 1;
      changed = this.setFrame(drawn.body, index) || changed;
      // Today's bindings identify foliage explicitly; absent #66 wind maps use a gentle uniform weight.
      const wind = SCENE_QUALITY[this.tier].wind && drawn.body.userData.wind;
      if (!wind && drawn.body.userData.base && drawn.body.userData.swayed) {
        drawn.body.geometry.getAttribute("position").array.set(drawn.body.userData.base);
        drawn.body.geometry.getAttribute("position").needsUpdate = true;
        drawn.body.userData.swayed = false;
        changed = true;
      }
      if (wind) {
        const position = drawn.body.geometry.getAttribute("position"),
          base = drawn.body.userData.base;
        if (base) {
          for (let i = 0; i < position.count; i++) {
            const y = base[i * 3 + 1] ?? 0;
            position.array[i * 3] =
              (base[i * 3] ?? 0) + Math.sin(t / 450 + y / 12) * Math.max(0, y) * 0.025;
          }
          position.needsUpdate = true;
          drawn.body.userData.swayed = true;
          changed = !this.reducedMotion || changed;
        }
      }
    }
    for (const { key, sprite } of this.effects) {
      if (!sprite.visible) continue;
      const animation = this.atlas.get(key);
      const count = animation?.frames.length ?? 1;
      sprite.userData.playing = !this.reducedMotion && !this.effectFades.has(sprite) && count > 1;
      changed =
        this.setFrame(
          sprite,
          sprite.userData.playing ? Math.floor(t / (animation?.durationMs ?? 250)) % count : 0,
        ) || changed;
    }
    if (this.rain?.visible && SCENE_QUALITY[this.tier].rain > 0) {
      const array = this.rain.geometry.getAttribute("position").array as Float32Array;
      const width = WIDTH / this.camera.zoom,
        height = HEIGHT / this.camera.zoom;
      for (let i = 0; i < array.length / 6; i++) {
        const x = this.camera.position.x + (((i * 73.17) % width) - width / 2);
        const y = this.camera.position.y + height / 2 - ((i * 41.71 + t * 0.2) % height);
        array.set([x, y, 50, x - 2, y + 9, 50], i * 6);
      }
      this.rain.geometry.getAttribute("position").needsUpdate = true;
      changed = !this.reducedMotion || changed;
    }
    for (const mirror of this.reflections) {
      const source = mirror.userData.source;
      mirror.position.set(source.position.x, source.position.y, -10);
      if (mirror.userData.frame !== source.userData.frame) {
        const uv = mirror.geometry.getAttribute("uv");
        uv.array.set(source.geometry.getAttribute("uv").array);
        uv.needsUpdate = true;
        // A frame on a continuation page swaps the source's map; the mirror borrows the same page.
        if (mirror.material.map !== source.material.map) {
          mirror.material.map = source.material.map;
          mirror.material.needsUpdate = true;
        }
        mirror.userData.frame = source.userData.frame;
        changed = true;
      }
    }
    return changed;
  }
  private renderFrame(): void {
    const previous = THREE.getConsoleFunction();
    let contentError = false;
    if (this.content)
      THREE.setConsoleFunction((level, message, ...parameters) => {
        if (level === "error") contentError = true;
        if (previous) previous(level, message, ...parameters);
        else console[level](message, ...parameters);
      });
    try {
      if (this.composer) this.composer.render();
      else this.renderer.render(this.scene, this.camera);
      // Three r187 reports some shader-building exceptions through its logger rather than throwing.
      if (contentError) throw new Error("content render failed");
    } finally {
      THREE.setConsoleFunction(previous);
    }
  }
  private readonly step = (frameTime: number) => {
    if (this.destroyed) return;
    this.frame = requestAnimationFrame(this.step);
    if (!this.initialized || (ATLASES && this.atlasTextures.length === 0) || !this.projection)
      return;
    const delta = this.previousTime === undefined ? 0 : frameTime - this.previousTime;
    this.previousTime = frameTime;
    if (delta > 0) {
      this.metrics.frameMs.push(delta);
      if (this.metrics.frameMs.length > FRAME_SAMPLES) this.metrics.frameMs.shift();
      if (++this.framesSinceReport >= FRAME_SAMPLES) {
        this.framesSinceReport = 0;
        const sorted = [...this.metrics.frameMs].sort((a, b) => a - b),
          p95 = sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0;
        this.report({ name: "frame_ms", category: "p95", value: p95 });
        if (
          p95 > FRAME_BUDGET_MS &&
          (!this.reducedMotion || this.content !== undefined) &&
          document.visibilityState === "visible" &&
          this.tier !== "low"
        )
          this.setQuality(this.tier === "high" ? "medium" : "low");
      }
    }
    // rAF timestamps precede callback execution; GPU work can delay them past a motion's start.
    const time = performance.now();
    let changed = this.dirty;
    for (const [mesh, motion] of this.motions) {
      const progress = Math.min(1, (time - motion.start) / INTERPOLATION_MS);
      mesh.position.x = motion.fromX + (motion.x - motion.fromX) * progress;
      mesh.position.y = motion.fromY + (motion.y - motion.fromY) * progress;
      if (progress >= 1) this.motions.delete(mesh);
      changed = true;
    }
    if (this.focusMotion) {
      const motion = this.focusMotion,
        progress = Math.min(1, (time - motion.start) / INTERPOLATION_MS);
      this.setCamera({
        x: motion.fromX + (motion.x - motion.fromX) * progress,
        y: motion.fromY + (motion.y - motion.fromY) * progress,
        zoom: this.camera.zoom,
      });
      if (progress >= 1) this.focusMotion = undefined;
      changed = true;
    }
    for (const [sprite, fade] of this.effectFades) {
      const progress = this.reducedMotion ? 1 : Math.min(1, (time - fade.start) / INTERPOLATION_MS);
      sprite.material.opacity = fade.alpha * (1 - progress);
      if (progress >= 1) {
        sprite.visible = false;
        this.effectFades.delete(sprite);
      }
      changed = true;
    }
    for (const cue of this.cues) {
      if (time >= cue.end) {
        this.remove(cue.mesh);
        changed = true;
      } else if (!this.reducedMotion) {
        const progress = (time - cue.start) / (cue.end - cue.start);
        cue.mesh.position.y = cue.y + progress * 12;
        cue.mesh.material.opacity = 1 - progress;
        changed = true;
      }
    }
    const cueCount = this.cues.length;
    this.cues = this.cues.filter((cue) => time < cue.end);
    if (cueCount !== this.cues.length) this.updateTextureBytes();
    this.contentTime = time;
    changed = this.updateContent(time) || changed;
    changed = this.animate(time) || changed;
    const selected = this.selected === undefined ? undefined : this.drawn.get(this.selected);
    if (selected) this.moveSelection(selected);
    if (changed) {
      try {
        this.renderFrame();
      } catch {
        if (!this.content) {
          this.unavailable("renderer_unavailable");
          return;
        }
        this.failContent("content_draw");
        try {
          this.renderFrame();
        } catch {
          this.unavailable("renderer_unavailable");
          return;
        }
      }
      this.dirty = false;
      this.metrics.firstRenderMs ??= performance.now() - this.started;
    }
  };
  private updateTextureBytes(): void {
    // WebGPURenderer allocates by Texture identity on both backends, not by shared image source.
    const textures = new Set<THREE.Texture>();
    for (const texture of this.atlasTextures) textures.add(texture);
    for (const texture of this.content?.textures ?? []) textures.add(texture);
    this.scene?.traverse((object) => {
      if (!(object instanceof THREE.Mesh || object instanceof THREE.LineSegments)) return;
      const material = object.material;
      for (const surface of Array.isArray(material) ? material : [material])
        for (const texture of materialTextures(surface)) textures.add(texture);
      if (object instanceof THREE.SkinnedMesh && object.skeleton.boneTexture)
        textures.add(object.skeleton.boneTexture);
    });
    let bytes = 0;
    for (const texture of textures) {
      const image = texture.image as { width: number; height: number } | undefined;
      if (texture instanceof THREE.CompressedTexture)
        bytes += texture.mipmaps.reduce((total, mip) => total + mip.data.byteLength, 0);
      else if (image) {
        const data = (image as { data?: ArrayBufferView }).data;
        bytes +=
          (data?.byteLength ?? image.width * image.height * 4) *
          (texture.generateMipmaps ? 4 / 3 : 1);
      }
    }
    // Three r187 Renderer output conversion retains RGBA16F + depth/stencil storage.
    // Conservatively include it even when RenderPipeline handles output conversion itself.
    bytes += WIDTH * HEIGHT * 12;
    const quality = SCENE_QUALITY[this.tier];
    bytes +=
      Math.floor(WIDTH * quality.renderScale) * Math.floor(HEIGHT * quality.renderScale) * 12;
    // A reduced tier's full-resolution label pass: one RGBA16F target without depth.
    if (this.labelPass) bytes += WIDTH * HEIGHT * 8;
    const scale = quality.bloomScale;
    if (scale > 0) {
      // BloomNode has a bright target and two five-level RGBA16F chains, starting at bloomScale.
      let width = Math.floor(WIDTH * scale),
        height = Math.floor(HEIGHT * scale);
      bytes += width * height * 8;
      for (let level = 0; level < 5; level++) {
        bytes += width * height * 16;
        width = Math.floor(width / 2);
        height = Math.floor(height / 2);
      }
    }
    this.metrics.textureBytes = bytes;
  }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.restoreContentErrors?.();
    this.restoreContentErrors = undefined;
    this.contentAbort.abort();
    if (this.content) this.disposeInstance(this.content);
    this.content = undefined;
    for (const dispose of this.contentLoaderDisposers) {
      try {
        dispose();
      } catch {}
    }
    this.contentLoaderDisposers.clear();
    cancelAnimationFrame(this.frame);
    this.canvas?.removeEventListener("webglcontextlost", this.lost);
    this.canvas?.removeEventListener("pointerdown", this.pointerdown);
    this.canvas?.removeEventListener("pointermove", this.pointermove);
    this.canvas?.removeEventListener("pointerup", this.pointerup);
    this.canvas?.removeEventListener("pointercancel", this.pointercancel);
    this.canvas?.removeEventListener("pointerleave", this.pointerleave);
    this.canvas?.removeEventListener("wheel", this.wheel);
    for (const event of REBOUND_EVENTS)
      this.parent.removeEventListener(event, this.rebound, { capture: true });
    globalThis.removeEventListener("scroll", this.rebound, { capture: true });
    this.disposePost();
    if (this.scene)
      for (const mesh of [...this.scene.children]) {
        if (mesh instanceof THREE.Mesh || mesh instanceof THREE.LineSegments)
          this.remove(mesh as Native);
        else this.scene.remove(mesh);
      }
    for (const texture of this.atlasTextures) texture.dispose();
    this.atlasTextures = [];
    this.canvas?.remove();
    // Three r187 dispose awaits init, which rejects again when both backends are unavailable.
    void this.renderer?.dispose().catch(() => {});
    this.handlers.clear();
    this.drawn.clear();
    this.atlas.clear();
    this.effects = [];
    this.overlay = [];
    this.selection = undefined;
    this.projection = undefined;
    this.order = [];
    this.cueKeys = [];
    this.cues = [];
    this.motions.clear();
    this.effectFades.clear();
    this.lights = [];
    this.reflections = [];
    this.metrics.textureBytes = 0;
  }
}
