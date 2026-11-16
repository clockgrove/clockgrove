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

/** Rendered-frame intervals per judged window (#67's 120 measured frames). */
export const WINDOW_FRAMES = 120;
/** Decision: intervals discarded after start, content ready, a tier change or a return to view. */
export const WARMUP_FRAMES = 30;
/** Decision: consecutive over-budget windows before stepping down; one window can be a burst. */
export const DOWN_WINDOWS = 2;
/** Decision: consecutive windows of headroom before stepping up, about 10 s at 60 Hz. */
export const UP_WINDOWS = 5;
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
