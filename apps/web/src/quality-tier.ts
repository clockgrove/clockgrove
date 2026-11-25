/**
 * Issue #356: the renderer's quality tier, chosen from what the device reports and changed from
 * sustained frame time. Renderer-local presentation policy; see apps/web/docs/scene.md.
 */
export type QualityTier = "low" | "medium" | "high";
export const TIERS: readonly QualityTier[] = ["low", "medium", "high"];

/** What the device reports, read once the backend has started. */
export interface DeviceProfile {
  /** A software or fallback adapter (SwiftShader, llvmpipe, WebGPU's fallback adapter). */
  readonly software: boolean;
  /** Renderable floating-point colour targets (always on WebGPU; EXT_color_buffer_float on WebGL2). */
  readonly floatTargets: boolean;
  /** The largest 2D texture, render-target and viewport side the device accepts. */
  readonly maxDimension: number;
  /** `navigator.deviceMemory` in GiB, absent where the browser does not report it. */
  readonly memoryGiB?: number;
}

/** The renderer's existing render-target floor: medium and high targets need 4096-pixel sides. */
export const TARGET_FLOOR = 4096;
const SOFTWARE = /swiftshader|llvmpipe|lavapipe|softpipe|software|microsoft basic render/i;
export const softwareIdentity = (identity: string): boolean => SOFTWARE.test(identity);

/** The highest tier the device's reported capabilities allow. */
export function tierCeiling(device: DeviceProfile): QualityTier {
  if (device.software || !device.floatTargets || device.maxDimension < TARGET_FLOOR) return "low";
  if (device.memoryGiB !== undefined && device.memoryGiB < 4) return "low";
  if (device.memoryGiB !== undefined && device.memoryGiB < 8) return "medium";
  return "high";
}

/** The ceiling, except that unreported memory starts at medium and must earn high from frame time. */
export function startingTier(device: DeviceProfile): QualityTier {
  const ceiling = tierCeiling(device);
  return device.memoryGiB === undefined && ceiling === "high" ? "medium" : ceiling;
}

/**
 * Decision: rendered-frame intervals per judged window. A quarter of #67's 120 measured frames, so
 * a sustained step down needs more than #67's 120 intervals while a short window keeps a burst from
 * overlapping the whole run of windows a step down needs. p95 of 30 is over budget from 2 slow.
 */
export const WINDOW_FRAMES = 30;
/** Decision: intervals discarded after start, content ready, a tier change or a return to view. */
export const WARMUP_FRAMES = 30;
/**
 * Decision: consecutive over-budget windows before stepping down (150 intervals). A contiguous
 * burst can make five consecutive windows over budget only by covering the middle three and 2
 * intervals on each side: so any burst shorter than 94 intervals never steps down, wherever it
 * falls in the windows and whether or not a restart came before it.
 */
export const DOWN_WINDOWS = 5;
/** Decision: consecutive windows of headroom before stepping up (600 intervals, 10 s at 60 Hz). */
export const UP_WINDOWS = 20;
/** Decision: headroom means p95 at or below 60% of the frame budget (steady 50 fps or better). */
export const HEADROOM = 0.6;

/**
 * Judges windows of rendered-frame intervals. `sample` returns the tier to change to, if any;
 * `fits` says whether loaded content's resources fit a tier, so a change never retires content.
 */
export class TierGovernor {
  private samples: number[] = [];
  private skip = WARMUP_FRAMES;
  private over = 0;
  private under = 0;
  private upWindows = UP_WINDOWS;
  private raisedTo: QualityTier | undefined;
  constructor(
    private readonly ceiling: QualityTier,
    private readonly budgetMs: number,
  ) {}
  /** One-time work follows (start, content ready, tier change, visible again): restart judging. */
  restart(): void {
    this.samples = [];
    this.skip = WARMUP_FRAMES;
    this.over = 0;
    this.under = 0;
  }
  sample(
    intervalMs: number,
    tier: QualityTier,
    fits: (tier: QualityTier) => boolean,
  ): QualityTier | undefined {
    if (this.skip > 0) {
      this.skip -= 1;
      return undefined;
    }
    this.samples.push(intervalMs);
    if (this.samples.length < WINDOW_FRAMES) return undefined;
    const sorted = this.samples.sort((a, b) => a - b);
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0;
    this.samples = [];
    const index = TIERS.indexOf(tier);
    if (p95 > this.budgetMs) {
      this.under = 0;
      if (++this.over < DOWN_WINDOWS) return undefined;
      this.over = 0;
      for (let lower = index - 1; lower >= 0; lower--) {
        const next = TIERS[lower] as QualityTier;
        if (!fits(next)) continue;
        // An up-step that could not hold doubles the headroom the next one needs.
        if (this.raisedTo === tier) this.upWindows *= 2;
        this.raisedTo = undefined;
        return next;
      }
      return undefined;
    }
    this.over = 0;
    if (p95 > this.budgetMs * HEADROOM || index >= TIERS.indexOf(this.ceiling)) {
      this.under = 0;
      return undefined;
    }
    if (++this.under < this.upWindows) return undefined;
    this.under = 0;
    const next = TIERS[index + 1] as QualityTier;
    if (!fits(next)) return undefined;
    this.raisedTo = next;
    return next;
  }
}

/**
 * Decision (issue 273): one journaled frame per the live scene's INTERPOLATION_MS, so a frame lasts
 * as long as one committed move draws live; 17 frames play in under 7 s.
 */
export const FLASHBACK_FRAME_MS = 400;

/**
 * Decision (issue 273): the PiP's CSS size per live tier. Low has no PiP canvas (the tier a device
 * or a struggling frame rate drops to, where a second renderer would cost the live view); the text
 * summary is the floor. The sizes are a half and three-quarters of the renderer's 640 x 400 logical
 * view. The PiP keeps the lowest live tier seen while it is open, so a live step down that removes
 * it is not undone mid-replay. What the PiP itself renders at is FLASHBACK_PIP_LIMITS.
 */
export const FLASHBACK_PIP_BUDGET: Readonly<
  Record<QualityTier, { readonly width: number; readonly height: number } | null>
> = {
  low: null,
  medium: { width: 320, height: 200 },
  high: { width: 480, height: 300 },
};

/**
 * Decision (issue 273): what the PiP's own renderer adds while a flashback is open. Its governor's
 * ceiling is low, so it renders at low quality (no bloom, a quarter of its fragments shaded) with
 * low's 512,000-pixel output cap and 16 MiB render-target ceiling, whatever the live tier, and at a
 * pixel ratio of 1, so its output is its CSS size (at most 480 x 300). It loads its own copy of the
 * content's atlas and material textures, which the material delivery budget holds to 32 MiB
 * (MATERIAL_DELIVERY_BUDGET), and runs one more animation-frame loop that draws only when its
 * journaled frame, size, tier or content changes, never every animation frame while it holds still.
 */
export const FLASHBACK_PIP_LIMITS = {
  tierCeiling: "low",
  maxPixelRatio: 1,
  stillFrames: true,
} as const satisfies {
  readonly tierCeiling: QualityTier;
  readonly maxPixelRatio: number;
  readonly stillFrames: boolean;
};
