// Issue 67: the renderer bake-off's measurement page and script work end to end under software
// rendering (SwiftShader), the only GPU this CI host has. CI asserts only what is deterministic there
// (owner decision, 2026-11-08): every candidate builds, renders the fixed yard slice, the page writes
// its JSON in the declared shape, screenshots are non-empty PNGs of the canvas size, and reduced motion
// freezes the picture while the off state animates, compared on a page clock this test steps itself.
// Timing is recorded, never asserted; GPU numbers come from the maintainer step in the spike README.
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import { measure } from "../../spikes/renderer-bakeoff/scripts/measure.mjs";

const spike = path.resolve("spikes/renderer-bakeoff");
const CANDIDATES = ["phaser", "three-webgl2", "three-webgpu"];
const STATES = ["dusk-rain", "night"];
const TIERS = ["low", "medium", "high"];
/** The page's canvas size (src/harness.ts). */
const SIZE = { width: 960, height: 540 };
// SwiftShader through ANGLE; Playwright's launcher adds its own --no-sandbox on Linux.
const SWIFTSHADER = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"];
const SOFTWARE = /swiftshader|llvmpipe|lavapipe|softpipe|software|microsoft basic render/iu;
// A uniformly filled 960×540 PNG deflates to a few kilobytes; a drawn, textured yard is far larger.
const DRAWN_PNG_BYTES = 20_000;
/** Fixed page-clock times for the reduced-motion comparison. */
const MOTION_AT_MS = 1_250;
const MOTION_STEP_MS = 1_000;

/** Width and height from a PNG's IHDR chunk, or null when the bytes are not a PNG. */
function pngSize(bytes) {
  const signature = "89504e470d0a1a0a";
  if (bytes.length < 24 || bytes.subarray(0, 8).toString("hex") !== signature) return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}
const fromDataUrl = (url) => Buffer.from(url.split(",")[1] ?? "", "base64");
const isNumber = (value) => typeof value === "number" && !Number.isNaN(value);

it("builds every candidate, renders the fixed slice, writes the declared record and honours reduced motion", async () => {
  execFileSync(process.execPath, ["scripts/build.mjs"], { cwd: spike, stdio: "inherit" });
  const out = await mkdtemp(path.join(os.tmpdir(), "bakeoff-"));
  // The pinned Chromium (scripts/ci/toolchain.sh browser), launched as the other browser journeys
  // launch it; a browser that cannot start fails here with Playwright's own error.
  const browser = await chromium.launch({ headless: true, args: SWIFTSHADER });
  try {
    // The measurement script serves dist/ and opens its page in that browser.
    const record = await measure({
      out,
      label: "CI SwiftShader",
      frames: 6,
      warmup: 1,
      rafFrames: 2,
      timeoutMs: 540_000,
      launch: async (url) => {
        const tab = await browser.newPage();
        const failed = new Promise((resolve) => {
          tab.on("crash", () => resolve("the page crashed"));
          browser.on("disconnected", () => resolve("the browser disconnected"));
        });
        await tab.goto(url);
        return {
          failed,
          close: () => tab.close(),
          executable: `Playwright Chromium ${browser.version()}`,
          browserArgs: SWIFTSHADER,
        };
      },
    });
    expect(record.schema).toBe("clockgrove.renderer-bakeoff/1");
    expect(record.candidates.map((c) => c.candidate)).toEqual(CANDIDATES);

    const page = await browser.newPage();
    // The page from a file:// URL, the owner's Edge path, with the clock driven from here.
    const index = pathToFileURL(path.join(spike, "dist", "index.html"));
    await page.goto(`${index}?drive=1`);
    await page.waitForSelector('body[data-state="ready"]');

    const summary = {};
    const expected = {};
    for (const candidate of record.candidates) {
      const name = candidate.candidate;
      const shots = {};
      // A missing screenshot reads as empty, so the summary below names it instead of throwing.
      for (const state of STATES)
        for (const tier of TIERS)
          shots[`${state}/${tier}`] = await readFile(
            path.join(out, `${name}-${state}-${tier}.png`),
          ).catch(() => Buffer.alloc(0));
      const built = await stat(path.join(spike, "dist", `${name}.js`));
      const renderer = candidate.description?.rendererString;

      const motion = await page
        .evaluate(
          async ({ name, at, step }) => {
            const drive = window.bakeoffDrive;
            await drive.open(name, "night", "high");
            drive.setReducedMotion(false);
            const moving = [await drive.frameAt(at), await drive.step(step)];
            drive.setReducedMotion(true);
            const still = [await drive.frameAt(at), await drive.step(step)];
            drive.close();
            return { moving, still };
          },
          { name, at: MOTION_AT_MS, step: MOTION_STEP_MS },
        )
        .catch((error) => ({ moving: [], still: [], error: String(error) }));
      const captures = [...motion.moving, ...motion.still].map(fromDataUrl);

      summary[name] = {
        error: candidate.error ?? motion.error ?? null,
        runs: candidate.runs.map((r) => `${r.state}/${r.tier}`),
        frameFieldsAreNumbers: candidate.runs.every(
          (r) => isNumber(r.frameMs.p50) && isNumber(r.frameMs.p95) && r.frameMs.count === 6,
        ),
        rendererRecorded: typeof renderer === "string" && renderer.length > 0,
        softwareIsNeverPerformance: SOFTWARE.test(renderer ?? "")
          ? candidate.performance === false
          : typeof candidate.performance === "boolean",
        host: candidate.host.label,
        bundleBytesMatchBuild: candidate.bundle.candidate?.bytes === built.size,
        screenshotsAreCanvasPngs: Object.values(shots).every(
          (png) => png.length > 0 && JSON.stringify(pngSize(png)) === JSON.stringify(SIZE),
        ),
        screenshotsAreDrawn: Object.values(shots).every((png) => png.length > DRAWN_PNG_BYTES),
        lightingChangesThePicture: !shots["dusk-rain/high"].equals(shots["night/high"]),
        drivenCapturesAreCanvasPngs:
          captures.length === 4 &&
          captures.every((png) => JSON.stringify(pngSize(png)) === JSON.stringify(SIZE)),
        reducedMotionFreezes: captures.length === 4 && motion.still[0] === motion.still[1],
        animatesWhenReducedMotionIsOff:
          captures.length === 4 && motion.moving[0] !== motion.moving[1],
      };
      expected[name] = {
        error: null,
        runs: STATES.flatMap((s) => TIERS.map((t) => `${s}/${t}`)),
        frameFieldsAreNumbers: true,
        rendererRecorded: true,
        softwareIsNeverPerformance: true,
        host: "CI SwiftShader",
        bundleBytesMatchBuild: true,
        screenshotsAreCanvasPngs: true,
        screenshotsAreDrawn: true,
        lightingChangesThePicture: true,
        drivenCapturesAreCanvasPngs: true,
        reducedMotionFreezes: true,
        animatesWhenReducedMotionIsOff: true,
      };
    }
    // One comparison, so a failure shows every candidate's every property at once.
    expect(summary).toEqual(expected);

    // The same page from file://, its record read back from the DOM and through the script.
    await page.goto(`${index}?candidates=phaser&frames=2&warmup=1&rafFrames=1`);
    await page.waitForSelector('body[data-state="done"]', { timeout: 240_000 });
    const dump = path.join(out, "dump.html");
    await writeFile(dump, await page.content());
    const dumped = await measure({ fromDom: dump, out: path.join(out, "from-dom") });
    expect(dumped.candidates.map((c) => [c.candidate, c.error ?? null, c.runs.length])).toEqual([
      ["phaser", null, 6],
    ]);
  } finally {
    await browser.close();
  }
}, 900_000);
