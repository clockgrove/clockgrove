// The measurement page: loads each candidate bundle in turn, drives the same adapter through the fixed
// lighting, quality and camera sequence, times every frame to GPU completion and writes one JSON record
// into the DOM (for `--dump-dom` from a file:// URL) and, when served by scripts/measure.mjs, POSTs it.
import {
  type BakeoffAdapter,
  type CandidateDescription,
  QUALITY_TIERS,
  type QualityTier,
} from "./contract.js";
import {
  CAMERA_PATH,
  LIGHTING_STATES,
  type LightingState,
  SCREENSHOT_CAMERA,
  SNAPSHOT,
  TO_NIGHT,
} from "./inputs/scene.js";

const params = new URLSearchParams(location.search);
const CANDIDATES = (params.get("candidates") ?? "phaser,three-webgl2,three-webgpu").split(",");
/** Measured frames per lighting state and tier (plan assumption 7: a stable p95, short under SwiftShader). */
const FRAMES = Number(params.get("frames") ?? 120);
const WARMUP = Number(params.get("warmup") ?? 10);
/** Frames timed by requestAnimationFrame cadence, after the GPU-completion frames. */
const RAF_FRAMES = Number(params.get("rafFrames") ?? 30);
/** Canvas size in CSS pixels at device pixel ratio 1: half of 1080p (plan, design note 6). */
const WIDTH = 960;
const HEIGHT = 540;
/** Animation time of every screenshot and of the reduced-motion check; fixed so every candidate matches. */
const SCREENSHOT_TIME_MS = 1_250;
/** How far the reduced-motion check advances the clock between its two captures. */
const MOTION_STEP_MS = 1_000;
const FRAME_MS = 1_000 / 60;

/**
 * The page's injectable animation clock. Candidates never read wall time: every frame is drawn at
 * `clock.now`, which only the page (or a test driving it) moves, so captures are reproducible.
 */
class PageClock {
  now = 0;
  set(ms: number): number {
    this.now = ms;
    return ms;
  }
  advance(ms: number): number {
    this.now += ms;
    return this.now;
  }
}

interface Stats {
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
  readonly mean: number;
  readonly max: number;
}
function stats(samples: readonly number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? 0;
  const round = (v: number) => Math.round(v * 1_000) / 1_000;
  return {
    count: sorted.length,
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    mean: round(sorted.reduce((sum, v) => sum + v, 0) / Math.max(1, sorted.length)),
    max: round(sorted.at(-1) ?? 0),
  };
}
interface Run {
  readonly state: LightingState;
  readonly tier: QualityTier;
  readonly warmupFrames: number;
  /** Render start to GPU completion, per frame, in milliseconds. */
  readonly frameMs: Stats;
  /** Interval between requestAnimationFrame callbacks while rendering each frame (vsync-capped). */
  readonly rafIntervalMs: Stats | null;
}
interface CandidateResult {
  candidate: string;
  description?: CandidateDescription;
  loadMs?: number;
  initMs?: number;
  runs: Run[];
  /** `<state>/<tier>` → PNG data URL, all at SCREENSHOT_CAMERA and SCREENSHOT_TIME_MS. */
  screenshots: Record<string, string>;
  reducedMotion?: MotionCheck;
  jsHeapUsedBytes?: number | null;
  error?: string;
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`could not load ${src}`));
    document.head.append(script);
  });
}
/** The next animation frame's timestamp, or NaN when none comes (a virtual clock may never run one). */
const nextFrame = () =>
  new Promise<number>((resolve) => {
    const timer = setTimeout(() => resolve(Number.NaN), 250);
    requestAnimationFrame((now) => {
      clearTimeout(timer);
      resolve(now);
    });
  });
const heapUsed = () =>
  (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ??
  null;

interface MotionCheck {
  /** How far the clock moved between the two captures of each pair. */
  readonly stepMs: number;
  /** The two captures are identical with reduced motion on. */
  readonly frozen: boolean;
  /** The two captures differ with reduced motion off (the scene does animate). */
  readonly animatesWhenOff: boolean;
}

/** Draws at the clock's current time and returns the capture of that frame. */
async function frameAt(adapter: BakeoffAdapter, clock: PageClock): Promise<string> {
  await adapter.renderFrame(clock.now);
  return adapter.capture();
}

/** Reduced motion, on the current lighting state, tier and camera: two captures a fixed step apart. */
async function motionCheck(adapter: BakeoffAdapter, clock: PageClock): Promise<MotionCheck> {
  const pair = async (reduced: boolean) => {
    adapter.setReducedMotion(reduced);
    clock.set(SCREENSHOT_TIME_MS);
    const first = await frameAt(adapter, clock);
    clock.advance(MOTION_STEP_MS);
    return first === (await frameAt(adapter, clock));
  };
  const identicalOff = await pair(false);
  const identicalOn = await pair(true);
  adapter.setReducedMotion(false);
  return { stepMs: MOTION_STEP_MS, frozen: identicalOn, animatesWhenOff: !identicalOff };
}

/** The only names the page loads; `candidates` and `bakeoffDrive.open` come from outside the page. */
const KNOWN_CANDIDATES: readonly string[] = ["phaser", "three-webgl2", "three-webgpu"];

async function createAdapter(name: string, host: HTMLElement): Promise<BakeoffAdapter> {
  if (!KNOWN_CANDIDATES.includes(name))
    throw new Error(`unknown candidate ${JSON.stringify(name)}`);
  const registered = () =>
    window.bakeoffCandidates && Object.hasOwn(window.bakeoffCandidates, name)
      ? window.bakeoffCandidates[name]
      : undefined;
  if (!registered()) await loadScript(`./${name}.js`);
  const factory = registered();
  if (typeof factory !== "function")
    throw new Error(`${name}.js registered no candidate named ${name}`);
  return factory({ host, width: WIDTH, height: HEIGHT });
}

async function measureCandidate(name: string): Promise<CandidateResult> {
  const result: CandidateResult = { candidate: name, runs: [], screenshots: {} };
  const host = document.createElement("div");
  host.className = "stage";
  host.dataset.candidate = name;
  document.getElementById("stages")?.append(host);
  let adapter: BakeoffAdapter | undefined;
  try {
    let started = performance.now();
    adapter = await createAdapter(name, host);
    result.loadMs = performance.now() - started;
    started = performance.now();
    await adapter.init();
    result.initMs = performance.now() - started;
    adapter.setReducedMotion(false);
    adapter.loadSnapshot(SNAPSHOT);
    const clock = new PageClock();
    for (const state of LIGHTING_STATES) {
      // The lighting change arrives as a committed patch through the adapter contract.
      if (state === "night") adapter.applyPatch(TO_NIGHT);
      for (const tier of QUALITY_TIERS) {
        adapter.setQuality(tier);
        for (let i = 0; i < WARMUP; i++) {
          adapter.setCamera(CAMERA_PATH[0] ?? SCREENSHOT_CAMERA);
          await adapter.renderFrame(clock.advance(FRAME_MS));
        }
        const frameMs: number[] = [];
        for (let i = 0; i < FRAMES; i++) {
          adapter.setCamera(
            CAMERA_PATH[Math.floor((i * CAMERA_PATH.length) / FRAMES)] ?? SCREENSHOT_CAMERA,
          );
          const t0 = performance.now();
          await adapter.renderFrame(clock.advance(FRAME_MS));
          frameMs.push(performance.now() - t0);
        }
        const rafIntervalMs: number[] = [];
        let last = await nextFrame();
        for (let i = 0; i < RAF_FRAMES; i++) {
          await adapter.renderFrame(clock.advance(FRAME_MS));
          const now = await nextFrame();
          rafIntervalMs.push(now - last);
          last = now;
        }
        result.runs.push({
          state,
          tier,
          warmupFrames: WARMUP,
          frameMs: stats(frameMs),
          rafIntervalMs: rafIntervalMs.every(Number.isFinite) ? stats(rafIntervalMs) : null,
        });
        adapter.setCamera(SCREENSHOT_CAMERA);
        const measured = clock.now;
        clock.set(SCREENSHOT_TIME_MS);
        result.screenshots[`${state}/${tier}`] = await frameAt(adapter, clock);
        clock.set(measured);
      }
    }
    // Reduced motion, at night on the high tier (everything that moves is on).
    result.reducedMotion = await motionCheck(adapter, clock);
    result.description = adapter.describe();
    result.jsHeapUsedBytes = heapUsed();
  } catch (error) {
    result.error =
      error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
  } finally {
    try {
      adapter?.destroy();
    } catch {
      // A failing destroy must not hide the measurement already taken.
    }
    host.remove();
  }
  return result;
}

/** The page's own view of the device, independent of any candidate. */
async function probeDevice() {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2");
  const info = gl?.getExtension("WEBGL_debug_renderer_info");
  const webgl2 = gl
    ? {
        renderer: String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER)),
        vendor: String(gl.getParameter(info ? info.UNMASKED_VENDOR_WEBGL : gl.VENDOR)),
        version: String(gl.getParameter(gl.VERSION)),
      }
    : null;
  gl?.getExtension("WEBGL_lose_context")?.loseContext();
  let webgpu: Record<string, string> | null = null;
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (gpu) {
    try {
      const adapter = (await gpu.requestAdapter()) as { info?: Record<string, unknown> } | null;
      if (adapter?.info) {
        webgpu = {};
        for (const key of ["vendor", "architecture", "device", "description"])
          webgpu[key] = String(adapter.info[key] ?? "");
      }
    } catch {
      webgpu = null;
    }
  }
  return {
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
    devicePixelRatio: window.devicePixelRatio,
    webgl2,
    webgpuApi: Boolean(gpu),
    webgpuAdapter: webgpu,
  };
}

async function main() {
  const startedAt = new Date().toISOString();
  const clockStart = performance.now();
  const device = await probeDevice();
  const candidates: CandidateResult[] = [];
  for (const name of CANDIDATES) {
    setStatus(`measuring ${name}`);
    candidates.push(await measureCandidate(name));
  }
  const elapsed = performance.now() - clockStart;
  const record = {
    schema: "clockgrove.renderer-bakeoff/1",
    startedAt,
    page: {
      url: location.href.split("?")[0],
      canvas: { width: WIDTH, height: HEIGHT, devicePixelRatio: 1 },
      frames: FRAMES,
      warmupFrames: WARMUP,
      rafFrames: RAF_FRAMES,
      // A virtual clock (--virtual-time-budget) can freeze performance.now() during synchronous work.
      clock: { elapsedMs: Math.round(elapsed), suspect: elapsed < 1 },
    },
    device,
    candidates,
  };
  // `<` is escaped so the JSON can sit in a script element and survive a DOM dump intact.
  const json = JSON.stringify(record).replace(/</gu, "\\u003c");
  const out = document.getElementById("bakeoff-result");
  if (out) out.textContent = json;
  const report = params.get("report");
  if (report) await fetch(report, { method: "POST", body: json });
  document.body.dataset.state = "done";
  setStatus("done");
}
function setStatus(text: string) {
  const status = document.getElementById("status");
  if (status) status.textContent = text;
}

/**
 * `?drive=1`: the page runs no sequence and instead exposes `window.bakeoffDrive`, so a test can open one
 * candidate in a fixed lighting state and tier, step the page clock itself and compare captures.
 */
interface Drive {
  open(name: string, state: LightingState, tier: QualityTier): Promise<void>;
  setReducedMotion(enabled: boolean): void;
  /** Sets the clock to an absolute animation time and returns the capture drawn at it. */
  frameAt(ms: number): Promise<string>;
  /** Advances the clock by `ms` and returns the capture drawn at the new time. */
  step(ms: number): Promise<string>;
  describe(): CandidateDescription;
  close(): void;
}
declare global {
  interface Window {
    bakeoffDrive?: Drive;
  }
}
function exposeDrive(): void {
  const clock = new PageClock();
  let adapter: BakeoffAdapter | undefined;
  let host: HTMLElement | undefined;
  const open = () => {
    if (!adapter) throw new Error("bakeoffDrive: open() a candidate first");
    return adapter;
  };
  window.bakeoffDrive = {
    async open(name, state, tier) {
      this.close();
      host = document.createElement("div");
      host.className = "stage";
      host.dataset.candidate = name;
      document.getElementById("stages")?.append(host);
      adapter = await createAdapter(name, host);
      await adapter.init();
      adapter.setReducedMotion(false);
      adapter.loadSnapshot(SNAPSHOT);
      if (state === "night") adapter.applyPatch(TO_NIGHT);
      adapter.setQuality(tier);
      adapter.setCamera(SCREENSHOT_CAMERA);
      clock.set(SCREENSHOT_TIME_MS);
    },
    setReducedMotion: (enabled) => open().setReducedMotion(enabled),
    frameAt: (ms) => {
      clock.set(ms);
      return frameAt(open(), clock);
    },
    step: (ms) => {
      clock.advance(ms);
      return frameAt(open(), clock);
    },
    describe: () => open().describe(),
    close() {
      adapter?.destroy();
      adapter = undefined;
      host?.remove();
      host = undefined;
    },
  };
  document.body.dataset.state = "ready";
  setStatus("drive");
}

if (params.get("drive") === "1") exposeDrive();
else
  main().catch(async (error: unknown) => {
    const json = JSON.stringify({
      schema: "clockgrove.renderer-bakeoff/1",
      fatal: error instanceof Error ? error.message : String(error),
    });
    const out = document.getElementById("bakeoff-result");
    if (out) out.textContent = json;
    const report = params.get("report");
    if (report) await fetch(report, { method: "POST", body: json }).catch(() => undefined);
    document.body.dataset.state = "done";
    setStatus("failed");
  });
