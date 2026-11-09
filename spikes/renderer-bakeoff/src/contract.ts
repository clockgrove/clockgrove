// The bake-off's adapter contract: the product's WorldSceneAdapter plus the measurement hooks the
// harness needs. The product contract is imported, never changed (issue 67: a spike, not the product path).
import type { WorldSceneAdapter } from "../../../apps/web/src/world-scene-adapter.js";

export type {
  SceneIntent,
  Unsubscribe,
  WorldSceneAdapter,
} from "../../../apps/web/src/world-scene-adapter.js";

export const QUALITY_TIERS = ["low", "medium", "high"] as const;
export type QualityTier = (typeof QUALITY_TIERS)[number];

/** What each tier turns on; every candidate implements the same table (README, "Quality tiers"). */
export interface TierFeatures {
  readonly normalMaps: boolean;
  readonly fog: boolean;
  /** Emissive maps (lantern glass, lit window). */
  readonly emissive: boolean;
  /** Roughness and wetness maps darken and sharpen highlights on wet surfaces. */
  readonly wetness: boolean;
  /** Vertex or UV sway driven by the wind map. */
  readonly wind: boolean;
  /** Rain streaks drawn at full rain intensity; scaled by the projection's rain intensity. */
  readonly rainParticles: number;
  /**
   * `half` is half of `full`'s strength, at the same full resolution and the same threshold
   * (`BLOOM_THRESHOLD`), in every candidate: each multiplies its engine's full strength by `BLOOM_SCALE`.
   */
  readonly bloom: "off" | "half" | "full";
  /** Mirrored reflections of the lit scene in puddles. */
  readonly reflections: boolean;
}
/** Scene brightness above which every candidate's bloom picks a pixel up, on each engine's 0–1 scale. */
export const BLOOM_THRESHOLD = 0.75;
/** What each bloom setting multiplies the engine's full bloom strength by; resolution never changes. */
export const BLOOM_SCALE: Readonly<Record<TierFeatures["bloom"], number>> = {
  off: 0,
  half: 0.5,
  full: 1,
};

export const TIER_FEATURES: Readonly<Record<QualityTier, TierFeatures>> = {
  low: {
    normalMaps: true,
    fog: true,
    emissive: false,
    wetness: false,
    wind: false,
    rainParticles: 0,
    bloom: "off",
    reflections: false,
  },
  medium: {
    normalMaps: true,
    fog: true,
    emissive: true,
    wetness: true,
    wind: true,
    rainParticles: 400,
    bloom: "half",
    reflections: false,
  },
  high: {
    normalMaps: true,
    fog: true,
    emissive: true,
    wetness: true,
    wind: true,
    rainParticles: 1200,
    bloom: "full",
    reflections: true,
  },
};

/** The fixed 2.5D camera's pan, in metres of the hall frame, and zoom (1 = PIXELS_PER_METRE). */
export interface CameraState {
  readonly panX: number;
  readonly panY: number;
  readonly zoom: number;
}

/** How a candidate covers one look feature: natively, with a workaround it describes, or not at all. */
export type FeatureSupport = "native" | "custom-shader" | "approximated" | "missing";

export interface CandidateDescription {
  readonly candidate: string;
  /** The graphics API actually used for this run (a WebGPU candidate may fall back to WebGL2). */
  readonly api: "webgl2" | "webgpu";
  /** WebGL `UNMASKED_RENDERER_WEBGL` (or `RENDERER`), or the WebGPU adapter's description. */
  readonly rendererString: string;
  readonly vendorString: string;
  /** WebGPU adapter info (`vendor`, `architecture`, `device`, `description`); null on WebGL2. */
  readonly webgpuAdapter: Readonly<Record<string, string>> | null;
  /** Bytes of textures, render targets and buffers this candidate allocated, by its own accounting. */
  readonly estimatedGpuBytes: number;
  readonly features: Readonly<Record<LookFeature, FeatureSupport>>;
  /** One line per feature that is not `native`: what the candidate did instead. */
  readonly notes: readonly string[];
}
export const LOOK_FEATURES = [
  "normalMap",
  "heightMap",
  "emissiveMap",
  "roughnessWetness",
  "windMap",
  "pointLights",
  "puddleReflections",
  "fog",
  "rainParticles",
  "bloom",
] as const;
export type LookFeature = (typeof LOOK_FEATURES)[number];

export interface BakeoffAdapter extends WorldSceneAdapter {
  /** Creates the renderer and uploads the shared inputs; resolves when the first frame can draw. */
  init(): Promise<void>;
  setQuality(tier: QualityTier): void;
  setCamera(camera: CameraState): void;
  /**
   * Draws one frame at a fixed scene time (milliseconds of animation time: rain, wind, flicker) and
   * resolves only when the GPU has finished it, so the harness can time the whole frame.
   * With reduced motion on, `timeMs` must not change the image.
   */
  renderFrame(timeMs: number): Promise<void>;
  /** A PNG data URL of the frame just drawn by `renderFrame`. */
  capture(): string;
  describe(): CandidateDescription;
}

export interface CandidateOptions {
  /** The element the candidate appends its canvas to. */
  readonly host: HTMLElement;
  /** Canvas size in CSS pixels; device pixel ratio is fixed at 1 so every candidate draws the same pixels. */
  readonly width: number;
  readonly height: number;
}
export type CandidateFactory = (options: CandidateOptions) => BakeoffAdapter;

declare global {
  interface Window {
    bakeoffCandidates?: Record<string, CandidateFactory>;
  }
}

/** Each candidate bundle calls this once at load; the harness then looks the factory up by name. */
export function registerCandidate(name: string, factory: CandidateFactory): void {
  window.bakeoffCandidates ??= {};
  window.bakeoffCandidates[name] = factory;
}
