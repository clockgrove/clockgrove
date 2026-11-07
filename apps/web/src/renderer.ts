import type {
  ObjectId,
  SceneEffect,
  ScenePatch,
  SceneProjection,
  SceneTransientCue,
  WorldObjectId,
} from "@clockgrove/contracts";
import Phaser from "phaser";
import {
  applyScenePatch,
  cyclePick,
  INTERPOLATION_MS,
  isNight,
  movement,
  OCCLUSION_GROUPS,
  type OcclusionGroup,
  type PickCycle,
  pickOrder,
  poseMetres,
  type SceneIntent,
  type ScenePlacement,
  shownEffects,
  type WorldSceneAdapter,
} from "./world-scene-adapter.js";

/** One reviewed animation strip of the issue 813 atlas (`assets/reviewed/<atlasId>.animations.json`). */
interface AtlasAnimation {
  readonly assetId: string;
  readonly animationFamily: string;
  readonly anchor: { readonly x: number; readonly y: number };
  readonly footprint: { readonly width: number; readonly depth: number };
  readonly frames: readonly {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  }[];
  readonly durationMs: number | null;
}
/** The explicit visual geometry of one drawn entity (§9.2). */
interface Visual {
  readonly placement: ScenePlacement;
  /** Footprint on the ground in millimetres, east by north. */
  readonly footprint: { readonly width: number; readonly depth: number };
  /** The frame pixel that stands on the pose; a placeholder stands on its marker's centre. */
  readonly anchor: { readonly x: number; readonly y: number };
  readonly height: number;
  readonly label: string;
}
interface Drawn {
  visual: Visual;
  readonly body: Phaser.GameObjects.Sprite | Phaser.GameObjects.Arc;
  readonly shadow: Phaser.GameObjects.Ellipse;
  key: string | undefined;
}
export interface SceneMetrics {
  /** Milliseconds from construction to the first drawn committed scene. */
  firstRenderMs: number | undefined;
  /** The slowest committed snapshot or patch application, in milliseconds. */
  patchMs: number;
  /** The latest unsmoothed frame intervals in milliseconds, at most `FRAME_SAMPLES` of them. */
  readonly frameMs: number[];
  entityCount: number;
  /** Effect sprites (puddles, lantern and window lights) currently built. */
  effectCount: number;
  /** Bytes the loaded textures occupy at four bytes per pixel. */
  textureBytes: number;
}
/**
 * What the renderer reports about itself. The shell supplies the sink: the renderer's imports are
 * limited by the web boundary check, so these are structural copies of the client measurement
 * categories.
 */
export type RendererMeasurement =
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
      /** The atlas content hash, which is also the world pack's presentation identity. */
      readonly assetHash?: string;
    }
  | {
      readonly name: "client_errors";
      readonly category: "asset" | "context_lost";
      readonly value: number;
    };
export type RendererReport = (point: RendererMeasurement) => void;
const ATLAS = "raccoon-world";
/** One re-fetch of a refused atlas copy (decision): the issue says the client re-fetches, and a
 * second refusal falls back to the text scene rather than retrying without end. */
const ATLAS_REFETCHES = 1;
/** 12.5 px per metre is the issue 813 golden's 80 mm per pixel, so reviewed sprites draw 1:1. */
const PX_PER_METRE = 12.5;
const WIDTH = 640;
const HEIGHT = 400;
/** Zoom stays within this range (decision): far enough to see the yard, near enough to read a kit. */
const ZOOM = { min: 0.75, max: 2 } as const;
/** The camera may pan this far, in world pixels, beyond the projected entities (decision): about
 * twice the 80 px reviewed kit sprite, so an edge entity can be brought to the view's middle. */
/**
 * Screen overlays (night, rain) are scroll-fixed, but the camera still zooms them about the view's
 * centre, so they are centred and sized to cover the view at the smallest zoom.
 */
const OVERLAY = { width: WIDTH / ZOOM.min, height: HEIGHT / ZOOM.min } as const;
const PAN_MARGIN_PX = 160;
/** A pointer moving further than this while down pans instead of picking (decision). */
const DRAG_PX = 4;
/** Pick radius for a mouse, and the enlarged one for touch, in CSS pixels at zoom 1 (decision:
 * §4.4 asks for an enlarged touch target without a figure; 24 px is about a fingertip at 96 dpi,
 * and the mouse radius is half of it). */
const PICK_PX = { mouse: 12, touch: 24 } as const;
/** Placeholder footprint in millimetres (decision): about a raccoon's length. */
const PLACEHOLDER_FOOTPRINT = { width: 600, depth: 600 } as const;
/** Placeholder marker radius in pixels (decision); its anchor is the circle's centre. */
const PLACEHOLDER_RADIUS = 8;
/** Ground-shadow opacity (decision): visible on day and night grass without hiding it. */
const SHADOW_ALPHA = 0.22;
/** The issue 813 golden draws night grass at 2/5 brightness, which a black overlay at 0.6 matches. */
const NIGHT_ALPHA = 0.6;
/** At most this many cue dedupe keys are remembered; the oldest is forgotten first (decision). */
const CUE_KEYS = 64;
/** A cue marker lives at most this long (decision): two interpolated moves, then it fades. */
const CUE_MS = 2 * INTERPOLATION_MS;
/** `--rw-v1-accent` of raccoon-world-ui@1. */
const SELECTION_SAGE = 0xa8c394;
const PILL_PAD_X = 10;
const PILL_PAD_Y = 4;
const FRAME_SAMPLES = 120;
const REBOUND_EVENTS = ["pointerdown", "pointerover"] as const;
const labelColor = "#ffffff";
const depthOf = (group: OcclusionGroup, index = 0) =>
  OCCLUSION_GROUPS.indexOf(group) * 10_000 + index;

/** Isometric 2:1 screen position in world pixels: east runs down-right, north up-right. */
function iso(placement: Pick<ScenePlacement, "x" | "y" | "elevation">): [number, number] {
  return [
    (placement.x + placement.y) * PX_PER_METRE,
    ((placement.x - placement.y) * PX_PER_METRE) / 2 - placement.elevation * PX_PER_METRE,
  ];
}

/** The Phaser isometric yard (Wave 4 plan §9); it reads committed projections and emits intents. */
export class PhaserWorldSceneAdapter implements WorldSceneAdapter {
  private readonly game: Phaser.Game;
  private readonly started = performance.now();
  readonly metrics: SceneMetrics = {
    firstRenderMs: undefined,
    patchMs: 0,
    frameMs: [],
    entityCount: 0,
    effectCount: 0,
    textureBytes: 0,
  };
  private projection: SceneProjection | undefined;
  private scope: string | undefined;
  private stage: Phaser.Scene | undefined;
  private atlas = new Map<string, AtlasAnimation>();
  private drawn = new Map<ObjectId, Drawn>();
  private order: ObjectId[] = [];
  /** Exposed for the browser journey. */
  effects: { role: string; key: string; sprite: Phaser.GameObjects.Sprite; index: number }[] = [];
  private effectsKey = "";
  private shownSprites = new Set<Phaser.GameObjects.Sprite>();
  private handlers = new Set<(intent: SceneIntent) => void>();
  private selected: ObjectId | undefined;
  private focused: ObjectId | undefined;
  // Pointer hover is picked by the canvas itself, so it stays renderer-local.
  private hovered: ObjectId | undefined;
  private overlay: Phaser.GameObjects.GameObject[] = [];
  private reducedMotion = false;
  private cycle: PickCycle | undefined;
  private down: { x: number; y: number; scrollX: number; scrollY: number; moved: boolean } | null =
    null;
  private cues: string[] = [];
  private framesSinceReport = 0;
  private night: Phaser.GameObjects.Rectangle | undefined;
  private rain: Phaser.GameObjects.TileSprite | undefined;
  private canvas: HTMLCanvasElement | undefined;
  private destroyed = false;
  private assetsFailed = false;
  private readonly parent: HTMLElement;
  // The scene is drawn only on a step where something visible may have changed; see `step`.
  private dirty = true;
  private view = "";
  private readonly invalidate = () => {
    this.dirty = true;
  };
  // The shell's layout can move the canvas after boot, so pointer mapping refreshes the canvas
  // bounds when a pointer enters the canvas or presses on it, or the page scrolls; not on every
  // pointer move, since each refresh is a layout read.
  private readonly rebound = () => this.game.scale.updateBounds();
  private readonly lost = (event: Event) => {
    event.preventDefault();
    this.report({ name: "client_errors", category: "context_lost", value: 1 });
    this.unavailable("renderer_unavailable");
  };
  constructor(
    parent: HTMLElement,
    /** Called once the reviewed atlas is ready, so the shell can advance boot. */
    private readonly ready: () => void,
    /** Called when the renderer can no longer draw: context loss or missing reviewed assets. */
    private readonly unavailable: (reason: "renderer_unavailable" | "assets_unavailable") => void,
    private readonly report: RendererReport = () => {},
  ) {
    const owner = this;
    this.parent = parent;
    for (const type of REBOUND_EVENTS)
      parent.addEventListener(type, this.rebound, { capture: true });
    // Scrolling moves the canvas under a resting pointer without a new pointerover.
    globalThis.addEventListener("scroll", this.rebound, { capture: true, passive: true });
    this.game = new Phaser.Game({
      type: Phaser.AUTO,
      parent,
      width: WIDTH,
      height: HEIGHT,
      backgroundColor: "#3f6b3a",
      // The adapter refreshes the canvas bounds itself (see `rebound`), so Phaser's 500 ms bounds
      // poll is off: on a scrolled page its position check compares a page offset with a viewport
      // offset, never matches, and reads layout on every poll, including after a context loss.
      scale: { resizeInterval: Number.POSITIVE_INFINITY },
      // No multisampled drawing buffer (decision): reviewed sprites draw 1:1, and on a software
      // WebGL context the per-frame multisample resolve about doubled the cost of a rain frame.
      render: { antialiasGL: false },
      audio: { noAudio: true },
      scene: {
        preload() {
          this.load.json(`${ATLAS}.animations`, `/${ATLAS}.animations.json`);
          this.load.once("loaderror", () => {
            owner.failAssets();
          });
        },
        create() {
          void owner.create(this);
        },
      },
    });
  }
  /** The final asset failure, reported once: a failed manifest also leaves `create` without one. */
  private failAssets(): void {
    if (this.destroyed || this.assetsFailed) return;
    this.assetsFailed = true;
    this.report({ name: "asset_cache", category: "failed", value: 1 });
    this.report({ name: "client_errors", category: "asset", value: 1 });
    this.unavailable("assets_unavailable");
  }
  /** Fetches the atlas image and returns its bytes only when they hash to the manifest's value. */
  private async fetchAtlas(expected: string, init?: RequestInit): Promise<ArrayBuffer | undefined> {
    try {
      const response = await fetch(`/${ATLAS}.png`, init);
      if (!response.ok) return undefined;
      const bytes = await response.arrayBuffer();
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
      return hash === expected ? bytes : undefined;
    } catch {
      return undefined;
    }
  }
  /** The atlas image is drawn only after its bytes match the manifest's `image.sha256`. */
  private async create(stage: Phaser.Scene): Promise<void> {
    const animations = stage.cache.json.get(`${ATLAS}.animations`) as
      | { animations: AtlasAnimation[]; image?: { sha256?: unknown } }
      | undefined;
    const expected = animations?.image?.sha256;
    if (!animations || typeof expected !== "string" || !/^[0-9a-f]{64}$/.test(expected))
      return this.failAssets();
    let bytes = await this.fetchAtlas(expected);
    for (let attempt = 0; !bytes && attempt < ATLAS_REFETCHES && !this.destroyed; attempt++) {
      this.report({ name: "asset_cache", category: "failed", value: 1 });
      bytes = await this.fetchAtlas(expected, { cache: "reload" });
    }
    if (this.destroyed) return;
    if (!bytes) return this.failAssets();
    const url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
    stage.load.once("loaderror", () => {
      URL.revokeObjectURL(url);
      this.failAssets();
    });
    stage.load.once("complete", () => {
      URL.revokeObjectURL(url);
      if (!this.destroyed && stage.textures.exists(ATLAS)) this.build(stage, animations);
    });
    stage.load.image(ATLAS, url);
    stage.load.start();
  }
  private build(stage: Phaser.Scene, animations: { animations: AtlasAnimation[] }): void {
    this.stage = stage;
    const texture = stage.textures.get(ATLAS);
    for (const animation of animations.animations) {
      const key = `${animation.assetId}/${animation.animationFamily}`;
      this.atlas.set(key, animation);
      animation.frames.forEach((frame, index) =>
        texture.add(`${key}/${index}`, 0, frame.x, frame.y, frame.width, frame.height),
      );
      if (animation.frames.length > 1)
        stage.anims.create({
          key,
          frames: animation.frames.map((_, index) => ({ key: ATLAS, frame: `${key}/${index}` })),
          frameRate: 1000 / (animation.durationMs ?? 250),
          repeat: -1,
        });
    }
    const source = texture.getSourceImage() as { width: number; height: number };
    this.metrics.textureBytes = source.width * source.height * 4;
    void this.announceAtlas(animations, this.metrics.textureBytes);
    this.canvas = this.game.canvas;
    this.canvas.addEventListener("webglcontextlost", this.lost);
    const camera = stage.cameras.main;
    camera.setZoom(1);
    this.night = stage.add
      .rectangle(WIDTH / 2, HEIGHT / 2, OVERLAY.width, OVERLAY.height, 0x000000, NIGHT_ALPHA)
      .setScrollFactor(0)
      .setDepth(depthOf("weather", 1));
    if (this.atlas.has("rain/loop"))
      this.rain = stage.add
        .tileSprite(WIDTH / 2, HEIGHT / 2, OVERLAY.width, OVERLAY.height, ATLAS, "rain/loop/0")
        .setScrollFactor(0)
        .setDepth(depthOf("weather", 3));
    let rainFrame = 0;
    stage.time.addEvent({
      delay: this.atlas.get("rain/loop")?.durationMs ?? 100,
      loop: true,
      callback: () => {
        if (this.reducedMotion || !this.rain) return;
        rainFrame = (rainFrame + 1) % (this.atlas.get("rain/loop")?.frames.length ?? 1);
        this.rain.setFrame(`rain/loop/${rainFrame}`);
        this.invalidate();
      },
    });
    stage.input.on("pointermove", (pointer: Phaser.Input.Pointer) => this.pointerMove(pointer));
    stage.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      const { scrollX, scrollY } = stage.cameras.main;
      this.down = { x: pointer.x, y: pointer.y, scrollX, scrollY, moved: false };
    });
    stage.input.on("pointerup", (pointer: Phaser.Input.Pointer) => this.pointerUp(pointer));
    stage.input.on("wheel", (_p: unknown, _o: unknown, _dx: number, dy: number) => {
      const next = camera.zoom * (dy > 0 ? 0.9 : 1.1);
      camera.setZoom(Math.min(ZOOM.max, Math.max(ZOOM.min, next)));
    });
    stage.events.on("postupdate", () => {
      // The raw interval: Phaser's smoothed delta averages ten frames and clamps slow ones.
      this.metrics.frameMs.push(this.game.loop.rawDelta);
      if (this.metrics.frameMs.length > FRAME_SAMPLES) this.metrics.frameMs.shift();
      if (++this.framesSinceReport >= FRAME_SAMPLES) {
        this.framesSinceReport = 0;
        const sorted = [...this.metrics.frameMs].sort((a, b) => a - b);
        this.report({
          name: "frame_ms",
          category: "p95",
          value: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0,
        });
      }
    });
    this.game.loop.callback = (time, delta) => this.step(time, delta);
    this.ready();
    this.draw();
  }
  /**
   * One game step: Phaser's update always runs (input, timers, tweens, animations), but the scene
   * is drawn only when something visible may have changed since the last draw. A WebGL canvas
   * keeps showing its last drawn frame, so an unchanged yard costs no fill: with rain, the
   * full-view rain layer changes ten times a second rather than on every frame.
   */
  private step(time: number, delta: number): void {
    const game = this.game;
    game.headlessStep(time, delta);
    const stage = this.stage;
    const renderer = game.renderer;
    if (!stage || game.isPaused || ("contextLost" in renderer && renderer.contextLost)) return;
    const camera = stage.cameras.main;
    const view = `${camera.scrollX},${camera.scrollY},${camera.zoom}`;
    if (!this.dirty && view === this.view && stage.tweens.getTweens().length === 0) return;
    this.dirty = false;
    this.view = view;
    renderer.preRender();
    game.scene.render(renderer);
    renderer.postRender();
  }
  /** The atlas's content hash is the world pack's presentation identity for every later point. */
  private async announceAtlas(atlas: unknown, bytes: number): Promise<void> {
    try {
      const data = new TextEncoder().encode(JSON.stringify(atlas));
      const digest = await crypto.subtle.digest("SHA-256", data);
      const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
      this.report({
        name: "asset_cache",
        category: "loaded",
        value: bytes,
        assetHash: `sha256:${hash}`,
      });
    } catch {
      this.report({ name: "asset_cache", category: "loaded", value: bytes });
    }
  }
  loadSnapshot(snapshot: SceneProjection, kind: "snapshot" | "patch" = "snapshot"): void {
    this.projection = snapshot;
    this.draw(kind);
  }
  applyPatch(patch: ScenePatch): void {
    const current = this.projection;
    // Recovery is the reducer's: an adapter applies only the next contiguous committed patch.
    if (!current || patch.fromRevision !== current.revision) return;
    this.loadSnapshot(applyScenePatch(current, patch), "patch");
  }
  emitCue(cue: SceneTransientCue): void {
    const stage = this.stage;
    const drawn = this.drawn.get(cue.objectId);
    if (!stage || !drawn)
      return void this.report({ name: "dropped_cues", category: "unknown_entity", value: 1 });
    if (this.cues.includes(cue.dedupeKey))
      return void this.report({ name: "dropped_cues", category: "duplicate", value: 1 });
    const remaining = Date.parse(cue.expiresAt) - Date.now();
    if (!(remaining > 0))
      return void this.report({ name: "dropped_cues", category: "expired", value: 1 });
    this.cues.push(cue.dedupeKey);
    if (this.cues.length > CUE_KEYS) this.cues.shift();
    const marker = stage.add
      .circle(drawn.body.x, drawn.body.y - drawn.visual.height, 4, 0xffe9a8)
      .setName("cue")
      .setDepth(depthOf("emphasis", 9));
    const lifetime = Math.min(remaining, CUE_MS);
    if (!this.reducedMotion)
      stage.tweens.add({ targets: marker, y: marker.y - 12, alpha: 0, duration: lifetime });
    stage.time.delayedCall(lifetime, () => {
      marker.destroy();
      this.invalidate();
    });
    this.invalidate();
  }
  setSelection(id?: WorldObjectId): void {
    const changed = id !== this.selected;
    this.selected = id;
    const drawn = id === undefined ? undefined : this.drawn.get(id);
    if (changed && drawn) this.reveal(drawn);
    this.drawEmphasis();
  }
  focus(id?: WorldObjectId): void {
    this.focused = id;
    const drawn = id === undefined ? undefined : this.drawn.get(id);
    if (drawn) this.reveal(drawn);
    this.drawEmphasis();
  }
  /** Keeps an emphasized entity in view, within the camera's pan bounds. */
  private reveal(drawn: Drawn): void {
    const camera = this.stage?.cameras.main;
    if (!camera || camera.worldView.contains(drawn.body.x, drawn.body.y)) return;
    if (this.reducedMotion) camera.centerOn(drawn.body.x, drawn.body.y);
    else camera.pan(drawn.body.x, drawn.body.y, INTERPOLATION_MS);
  }
  setReducedMotion(enabled: boolean): void {
    this.reducedMotion = enabled;
    for (const drawn of this.drawn.values()) this.animate(drawn);
    for (const effect of this.effects) this.animateEffect(effect.sprite, effect.key);
  }
  onIntent(handler: (intent: SceneIntent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  private intend(objectId: ObjectId): void {
    for (const handler of this.handlers) handler({ type: "select", objectId });
  }
  /** Candidates under a canvas point, in pick order. */
  private candidates(pointer: Phaser.Input.Pointer): ObjectId[] {
    const camera = this.stage?.cameras.main;
    if (!camera) return [];
    const at = camera.getWorldPoint(pointer.x, pointer.y);
    const radius = (pointer.wasTouch ? PICK_PX.touch : PICK_PX.mouse) / camera.zoom;
    return this.order.filter((objectId) => {
      const drawn = this.drawn.get(objectId);
      if (!drawn) return false;
      const centre = drawn.body.y - drawn.visual.height / 2;
      const reach = Math.max(radius, drawn.visual.height / 2);
      return Math.hypot(at.x - drawn.body.x, at.y - centre) <= reach;
    });
  }
  private pointerMove(pointer: Phaser.Input.Pointer): void {
    const camera = this.stage?.cameras.main;
    const down = this.down;
    if (camera && down && pointer.isDown) {
      const dx = pointer.x - down.x;
      const dy = pointer.y - down.y;
      if (down.moved || Math.hypot(dx, dy) > DRAG_PX) {
        down.moved = true;
        camera.setScroll(down.scrollX - dx / camera.zoom, down.scrollY - dy / camera.zoom);
      }
      return;
    }
    if (pointer.wasTouch) return;
    const hovered = this.candidates(pointer)[0];
    if (hovered === this.hovered) return;
    this.hovered = hovered;
    this.drawEmphasis();
  }
  private pointerUp(pointer: Phaser.Input.Pointer): void {
    const down = this.down;
    this.down = null;
    if (down?.moved) return;
    const candidates = this.candidates(pointer);
    if (!pointer.wasTouch) {
      const picked = candidates[0];
      if (picked !== undefined) this.intend(picked);
      return;
    }
    // Touch cycles deterministically through overlapping sprites on repeated taps (§4.4).
    this.cycle = cyclePick(this.cycle, [pointer.x, pointer.y], candidates);
    const picked = candidates[this.cycle.index];
    if (picked !== undefined) this.intend(picked);
  }
  private visual(placement: ScenePlacement, key: string | undefined): Visual {
    const label =
      this.projection?.entities.find((entity) => entity.objectId === placement.objectId)
        ?.presentation.label ?? placement.objectId;
    const animation = key === undefined ? undefined : this.atlas.get(key);
    // An unbound entity, or one bound to an asset this atlas lacks, draws as a placeholder marker.
    if (!animation)
      return {
        placement,
        footprint: PLACEHOLDER_FOOTPRINT,
        anchor: { x: PLACEHOLDER_RADIUS, y: PLACEHOLDER_RADIUS },
        height: 0,
        label,
      };
    return {
      placement,
      footprint: animation.footprint,
      anchor: animation.anchor,
      height: animation.anchor.y,
      label,
    };
  }
  private draw(kind: "snapshot" | "patch" = "snapshot"): void {
    const stage = this.stage;
    const projection = this.projection;
    if (!stage || !projection) return;
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
      this.frameCamera(stage, placements);
    }
    const present = new Set(placements.map((placement) => placement.objectId));
    for (const [objectId, drawn] of this.drawn)
      if (!present.has(objectId)) {
        this.release(drawn);
        this.drawn.delete(objectId);
      }
    // Drawing runs back to front, the reverse of pick order.
    placements.reverse().forEach((placement, index) => {
      const binding = bindings.get(placement.objectId);
      const bound = binding && `${binding.assetId}/${binding.animationFamily}`;
      const key = bound !== undefined && this.atlas.has(bound) ? bound : undefined;
      const visual = this.visual(placement, key);
      const [x, y] = iso(placement);
      let drawn = this.drawn.get(placement.objectId);
      if (drawn && drawn.key !== key) {
        this.release(drawn);
        drawn = undefined;
      }
      if (!drawn) {
        drawn = this.spawn(stage, visual, x, y, key);
        this.drawn.set(placement.objectId, drawn);
      } else {
        const kind = movement(drawn.visual.placement, placement);
        stage.tweens.killTweensOf([drawn.body, drawn.shadow]);
        if (kind === "snap" || this.reducedMotion) {
          drawn.body.setPosition(x, y);
          drawn.shadow.setPosition(x, y);
        } else
          stage.tweens.add({
            targets: [drawn.body, drawn.shadow],
            x,
            y,
            duration: INTERPOLATION_MS,
          });
        drawn.visual = visual;
      }
      drawn.body.setDepth(depthOf(placement.occlusionGroup, 2 * index + 1));
      drawn.shadow.setDepth(depthOf("ground", index));
    });
    this.order = placements.reverse().map((placement) => placement.objectId);
    this.drawEffects(stage, projection);
    this.drawEnvironment(projection);
    this.drawEmphasis();
    this.metrics.entityCount = this.drawn.size;
    this.invalidate();
    // A scope's first draw is the first render; later draws apply committed changes.
    if (!rebuilt)
      this.metrics.patchMs = Math.max(this.metrics.patchMs, performance.now() - started);
    this.report({ name: "scene_apply_ms", category: kind, value: performance.now() - started });
    this.metrics.firstRenderMs ??= performance.now() - this.started;
  }
  /** Centres the fixed camera on the projected entities and bounds its pan around them. */
  private frameCamera(stage: Phaser.Scene, placements: readonly ScenePlacement[]): void {
    const points = placements.map(iso);
    const xs = points.map(([x]) => x);
    const ys = points.map(([, y]) => y);
    const [minX, maxX, minY, maxY] = xs.length
      ? [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
      : [0, 0, 0, 0];
    const centre = [(minX + maxX) / 2, (minY + maxY) / 2] as const;
    const width = Math.max(maxX - minX + 2 * PAN_MARGIN_PX, WIDTH / ZOOM.min);
    const height = Math.max(maxY - minY + 2 * PAN_MARGIN_PX, HEIGHT / ZOOM.min);
    const camera = stage.cameras.main;
    camera.setZoom(1);
    camera.setBounds(centre[0] - width / 2, centre[1] - height / 2, width, height);
    camera.centerOn(centre[0], centre[1]);
  }
  private spawn(
    stage: Phaser.Scene,
    visual: Visual,
    x: number,
    y: number,
    key: string | undefined,
  ): Drawn {
    const { width, depth } = visual.footprint;
    const span = ((width + depth) / 1000) * PX_PER_METRE;
    const shadow = stage.add.ellipse(x, y, span, span / 2, 0x000000, SHADOW_ALPHA);
    const animation = key === undefined ? undefined : this.atlas.get(key);
    const body = animation
      ? stage.add
          .sprite(x, y, ATLAS, `${key}/0`)
          .setOrigin(
            animation.anchor.x / (animation.frames[0]?.width ?? 1),
            animation.anchor.y / (animation.frames[0]?.height ?? 1),
          )
      : stage.add.circle(x, y, PLACEHOLDER_RADIUS, 0xe3ce8b);
    const drawn: Drawn = { visual, body, shadow, key };
    // A playing animation needs a draw only when its frame changes.
    if (animation) body.on(Phaser.Animations.Events.ANIMATION_UPDATE, this.invalidate);
    this.animate(drawn);
    return drawn;
  }
  private animate(drawn: Drawn): void {
    const stage = this.stage;
    if (!stage || !drawn.key || !stage.anims.exists(drawn.key)) return;
    if (!(drawn.body instanceof Phaser.GameObjects.Sprite)) return;
    if (this.reducedMotion) drawn.body.stop().setFrame(`${drawn.key}/0`);
    else drawn.body.play(drawn.key, true);
    this.invalidate();
  }
  private release(drawn: Drawn): void {
    this.stage?.tweens.killTweensOf([drawn.body, drawn.shadow]);
    drawn.body.destroy();
    drawn.shadow.destroy();
  }
  /** Day/night and rain are drawn from the canonical clock and weather only (§9.2). */
  private drawEnvironment(projection: SceneProjection): void {
    this.night?.setVisible(isNight(projection.simulationTime));
    this.rain?.setVisible(projection.weather.rainIntensity > 0);
  }
  /** Rebuilds the effect sprites when the effects list changes, then applies what is shown now. */
  private drawEffects(stage: Phaser.Scene, projection: SceneProjection): void {
    const effects = projection.effects ?? [];
    const key = JSON.stringify(
      effects.map((effect) => [effect.role, effect.assetId, effect.animationFamily, effect.pose]),
    );
    if (key !== this.effectsKey) {
      this.releaseEffects();
      this.effectsKey = key;
      const frames = new Map(projection.frames.map((frame) => [frame.frameId, frame]));
      effects.forEach((effect, index) => {
        const atlasKey = `${effect.assetId}/${effect.animationFamily}`;
        const animation = this.atlas.get(atlasKey);
        const at = poseMetres(frames, effect.pose);
        if (!animation || !at) return;
        const [x, y] = iso(at);
        const sprite = stage.add
          .sprite(x, y, ATLAS, `${atlasKey}/0`)
          .setOrigin(
            animation.anchor.x / (animation.frames[0]?.width ?? 1),
            animation.anchor.y / (animation.frames[0]?.height ?? 1),
          )
          .setDepth(
            effect.role === "puddle" ? depthOf("ground", 5_000 + index) : depthOf("weather", 2),
          )
          .setVisible(false);
        if (animation.frames.length > 1)
          sprite.on(Phaser.Animations.Events.ANIMATION_UPDATE, this.invalidate);
        this.effects.push({ role: effect.role, key: atlasKey, sprite, index });
      });
    }
    const shown = new Set(shownEffects(projection));
    for (const item of this.effects) {
      const sprite = item.sprite;
      const visible = shown.has(effects[item.index] as SceneEffect);
      const was = this.shownSprites.has(sprite);
      if (visible === was) continue;
      stage.tweens.killTweensOf(sprite);
      if (visible) {
        this.shownSprites.add(sprite);
        sprite.setAlpha(1).setVisible(true);
        this.animateEffect(sprite, item.key);
      } else {
        this.shownSprites.delete(sprite);
        this.stopEffect(sprite, item.key);
        if (item.role === "puddle" && was && !this.reducedMotion)
          stage.tweens.add({
            targets: sprite,
            alpha: 0,
            duration: INTERPOLATION_MS,
            onComplete: () => sprite.setVisible(false),
          });
        else sprite.setVisible(false);
      }
    }
    this.metrics.effectCount = this.effects.length;
    this.invalidate();
  }
  private animateEffect(sprite: Phaser.GameObjects.Sprite, key: string): void {
    if (!this.shownSprites.has(sprite)) return;
    if (!this.stage?.anims.exists(key)) return;
    if (this.reducedMotion) this.stopEffect(sprite, key);
    else sprite.play(key, true);
    this.invalidate();
  }
  private stopEffect(sprite: Phaser.GameObjects.Sprite, key: string): void {
    sprite.stop().setFrame(`${key}/0`);
    this.invalidate();
  }
  private releaseEffects(): void {
    for (const { sprite } of this.effects) {
      this.stage?.tweens.killTweensOf(sprite);
      sprite.destroy();
    }
    this.effects = [];
    this.shownSprites.clear();
    this.effectsKey = "";
    this.metrics.effectCount = 0;
  }
  /** Redraws only the emphasis overlay, by lookup of the emphasized sprites. */
  private drawEmphasis(): void {
    const stage = this.stage;
    if (!stage) return;
    for (const item of this.overlay) item.destroy();
    this.overlay = [];
    // Hover and focus are 1 px ellipses at the feet; selection is a glowing ring and a pill.
    const feet = (objectId: ObjectId | undefined) =>
      objectId === undefined ? undefined : this.drawn.get(objectId);
    const thin = (objectId: ObjectId | undefined, name: string, radius: number, color: number) => {
      const drawn = feet(objectId);
      if (!drawn) return;
      this.overlay.push(
        stage.add
          .ellipse(drawn.body.x, drawn.body.y, 2 * radius, radius)
          .setStrokeStyle(1, color)
          .setName(name)
          .setDepth(depthOf("emphasis")),
      );
    };
    thin(this.hovered, "hover-affordance", 12, 0xffffff);
    thin(this.focused, "focus-affordance", 20, 0x9fd3ff);
    const selected = feet(this.selected);
    if (selected) {
      const { x, y } = selected.body;
      for (const [grow, width, alpha] of [
        [16, 10, 0.15],
        [8, 6, 0.35],
      ] as const)
        this.overlay.push(
          stage.add
            .ellipse(x, y, 32 + grow, (32 + grow) / 2)
            .setStrokeStyle(width, SELECTION_SAGE, alpha)
            .setName("selection-glow")
            .setDepth(depthOf("emphasis")),
        );
      this.overlay.push(
        stage.add
          .ellipse(x, y, 32, 16, SELECTION_SAGE, 0.18)
          .setStrokeStyle(3, SELECTION_SAGE)
          .setName("selection-ring")
          .setDepth(depthOf("emphasis")),
      );
      const text = stage.add
        .text(x, y - selected.visual.height - 6 - PILL_PAD_Y, selected.visual.label, {
          color: "#ece9d8",
          fontSize: "13px",
        })
        .setOrigin(0.5, 1)
        .setName("selection-label")
        .setDepth(depthOf("emphasis", 2));
      const width = text.width + 2 * PILL_PAD_X;
      const height = text.height + 2 * PILL_PAD_Y;
      const top = y - selected.visual.height - 6 - height;
      const pill = stage.add
        // Declared as the pill's default styles, so its fill is readable from the game object.
        .graphics({
          fillStyle: { color: 0x1e2116, alpha: 0.92 },
          lineStyle: { width: 1, color: SELECTION_SAGE, alpha: 0.6 },
        })
        .fillRoundedRect(x - width / 2, top, width, height, height / 2)
        .strokeRoundedRect(x - width / 2, top, width, height, height / 2)
        .setName("selection-pill")
        .setDepth(depthOf("emphasis", 1));
      this.overlay.push(pill, text);
    }
    // Hovered labels are plain text, so hover stays lighter than selection.
    const hovered = this.hovered !== this.selected ? feet(this.hovered) : undefined;
    if (hovered)
      this.overlay.push(
        stage.add
          .text(
            hovered.body.x + 12,
            hovered.body.y - hovered.visual.height - 10,
            hovered.visual.label,
            {
              color: labelColor,
            },
          )
          .setName("hover-label")
          .setDepth(depthOf("emphasis", 1)),
      );
    this.invalidate();
  }
  destroy(): void {
    this.destroyed = true;
    this.canvas?.removeEventListener("webglcontextlost", this.lost);
    for (const type of REBOUND_EVENTS)
      this.parent.removeEventListener(type, this.rebound, { capture: true });
    globalThis.removeEventListener("scroll", this.rebound, { capture: true });
    // Phaser's scene plugins release themselves on the scene's DESTROY event, which
    // `game.destroy` emits before clearing the scene's emitters, so they are not stripped here.
    if (this.game.textures.exists(ATLAS)) this.game.textures.remove(ATLAS);
    this.releaseEffects();
    this.handlers.clear();
    this.projection = undefined;
    this.drawn.clear();
    this.order = [];
    this.overlay = [];
    this.cues = [];
    this.stage = undefined;
    this.metrics.textureBytes = 0;
    this.game.destroy(true);
  }
}
