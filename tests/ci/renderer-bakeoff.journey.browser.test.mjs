// Issue 67: the renderer bake-off's measurement page and script work end to end under software
// rendering (SwiftShader), the only GPU this CI host has. CI asserts only what is deterministic there
// (owner decision, 2026-11-08): every candidate builds, renders the fixed hall slice, the page writes
// its JSON in the declared shape, screenshots are non-empty PNGs of the canvas size, and reduced motion
// freezes the picture while the off state animates, compared on a page clock this test steps itself.
// Timing is recorded, never asserted; GPU numbers come from the maintainer step in the spike README.
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import { createServer } from "../../apps/web/node_modules/vite/dist/node/index.js";
import { neutralShell } from "../../apps/web/src/shell-input.ts";
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
// A uniformly filled 960×540 PNG deflates to a few kilobytes; a drawn, textured hall is far larger.
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
  const consoleErrors = [];
  const listen = (tab) => {
    tab.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning")
        consoleErrors.push(`${message.type()}: ${message.text()}`.slice(0, 300));
    });
    tab.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`.slice(0, 300)));
  };
  try {
    // The measurement script serves dist/ and opens its page in that browser.
    const record = await measure({
      out,
      label: "CI SwiftShader",
      frames: 6,
      warmup: 1,
      rafFrames: 2,
      panFrames: 2,
      timeoutMs: 540_000,
      launch: async (url) => {
        const tab = await browser.newPage();
        listen(tab);
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
    listen(page);
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
          (r) =>
            isNumber(r.frameMs.p50) &&
            isNumber(r.frameMs.p95) &&
            r.frameMs.count === 6 &&
            isNumber(r.panFrameMs.p95) &&
            r.panFrameMs.count === 2,
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
    // Recorded, not asserted: each candidate's API and renderer, and the pages' console errors, so a
    // failure in CI (whose logs a sandboxed worker cannot read) explains itself in its annotation.
    const context = record.candidates.map((c) => ({
      candidate: c.candidate,
      api: c.description?.api,
      renderer: c.description?.rendererString,
      webgpuAdapter: c.description?.webgpuAdapter,
    }));
    expect(
      summary,
      JSON.stringify({ context, device: record.device, consoleErrors }).slice(0, 6_000),
    ).toEqual(expected);

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

// Product content uses the actual adapter, with no world runtime, database or authentication.
// Decision: 180 s per backend bounds software shader compilation and two 120-frame tier windows
// inside the existing browser job; these are correctness checks, never hardware timing claims.
it.each(["webgpu", "webgl2"])(
  "world content shares the product look and contains failures (%s)",
  async (backend) => {
    const root = path.resolve(".");
    const [{ encodeToKTX2 }, { MeshoptEncoder }] = await Promise.all([
      import("../../spikes/renderer-bakeoff/node_modules/ktx2-encoder/dist/node/index.js"),
      import("../../spikes/renderer-bakeoff/node_modules/meshoptimizer/meshopt_encoder.js"),
    ]);
    const ktx = await encodeToKTX2(new Uint8Array(), {
      imageDecoder: async () => ({
        width: 4,
        height: 4,
        data: new Uint8Array(Array.from({ length: 16 }, () => [255, 0, 0, 255]).flat()),
      }),
      generateMipmap: false,
    });
    await MeshoptEncoder.ready;
    const vertices = new Float32Array([-1, 0, 0, 1, 0, 0, 0, 1, 0]);
    const encoded = MeshoptEncoder.encodeGltfBuffer(
      new Uint8Array(vertices.buffer),
      3,
      12,
      "ATTRIBUTES",
    );
    const gltf = {
      asset: { version: "2.0" },
      extensionsUsed: ["EXT_meshopt_compression"],
      extensionsRequired: ["EXT_meshopt_compression"],
      buffers: [
        {
          byteLength: encoded.length,
          uri: `data:application/octet-stream;base64,${Buffer.from(encoded).toString("base64")}`,
        },
      ],
      bufferViews: [
        {
          buffer: 0,
          byteLength: 36,
          byteStride: 12,
          extensions: {
            EXT_meshopt_compression: {
              buffer: 0,
              byteOffset: 0,
              byteLength: encoded.length,
              byteStride: 12,
              count: 3,
              mode: "ATTRIBUTES",
              filter: "NONE",
            },
          },
        },
      ],
      accessors: [
        {
          bufferView: 0,
          componentType: 5126,
          count: 3,
          type: "VEC3",
          min: [-1, 0, 0],
          max: [1, 1, 0],
        },
      ],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      nodes: [{ mesh: 0 }],
      scenes: [{ nodes: [0] }],
      scene: 0,
    };
    // Compose from an external world directory; every library import still resolves at the pinned checkout.
    const world = await mkdtemp(path.join(os.tmpdir(), "clockgrove-renderer-world-"));
    const pinned = `${path.relative(world, root).split(path.sep).join("/")}/`;
    await Promise.all(
      ["index.html", "main.ts", "content.ts", "snapshot.json"].map(async (file) => {
        const source = await readFile(path.join(root, "worlds/fixture/renderer", file), "utf8");
        await writeFile(path.join(world, file), source.replaceAll("../../../", pinned));
      }),
    );
    const server = await createServer({
      root: world,
      define: { __WORLD_SHELL__: JSON.stringify(neutralShell) },
      configFile: path.join(root, "apps/web/vite.config.ts"),
      server: { host: "127.0.0.1", port: 0, fs: { allow: [root, world] } },
      plugins: [
        {
          name: "force-product-backend",
          configureServer(vite) {
            vite.middlewares.use(async (request, response, next) => {
              if (request.url === "/generated.ktx2") {
                response.end(ktx);
                return;
              }
              if (request.url === "/generated.gltf") {
                response.setHeader("content-type", "application/json");
                response.end(JSON.stringify(gltf));
                return;
              }
              if (request.url?.startsWith("/decoders/")) {
                const name = path.basename(request.url);
                if (!["basis_transcoder.js", "basis_transcoder.wasm"].includes(name)) {
                  next();
                  return;
                }
                response.end(
                  await readFile(
                    path.join(root, "apps/web/node_modules/three/examples/jsm/libs/basis", name),
                  ),
                );
                return;
              }
              next();
            });
          },
          transform(code, id) {
            if (
              backend === "webgl2" &&
              id.split("?")[0] === path.join(root, "apps/web/src/renderer.ts")
            )
              return {
                code: code.replace(
                  "new THREE.WebGPURenderer({",
                  "new THREE.WebGPURenderer({ forceWebGL: true,",
                ),
                map: null,
              };
          },
        },
      ],
    });
    let browser;
    try {
      await server.listen();
      const { port } = server.httpServer.address();
      browser = await chromium.launch({
        headless: true,
        args: [
          "--enable-unsafe-webgpu",
          "--enable-unsafe-swiftshader",
          "--use-webgpu-adapter=swiftshader",
          "--use-angle=swiftshader",
          "--enable-features=Vulkan",
          "--use-vulkan=swiftshader",
        ],
      });
      const open = async (query = "") => {
        const page = await browser.newPage({ viewport: { width: 800, height: 600 } });

        await page.goto(`http://127.0.0.1:${port}/${query}`);
        await page.waitForFunction(
          () => globalThis.fixtureRenderer?.adapter.metrics.firstRenderMs !== undefined,
        );
        return page;
      };
      const page = await open();
      await page.waitForFunction(
        () => globalThis.fixtureRenderer.adapter.metrics.contentStatus !== "loading",
      );

      const capture = async () => page.evaluate(() => globalThis.fixtureRenderer.capture());
      const initial = await page.evaluate(() => {
        const f = globalThis.fixtureRenderer;
        return {
          backend: f.adapter.backend,
          ready: f.diagnostics.ready,
          frame: f.diagnostics.lastFrame,
          skinned: f.diagnostics.model.isSkinnedMesh,
          normal: !!f.diagnostics.sprite.material.normalMap,
          depth: !!f.diagnostics.sprite.material.depthNode,
          reports: f.reports,
        };
      });
      expect(initial.backend).toBe(backend);
      const software = await page.evaluate(() => {
        const adapter = globalThis.fixtureRenderer.adapter;
        if (adapter.backend === "webgpu")
          return adapter.renderer.backend.device.adapterInfo.architecture;
        const gl = adapter.renderer.getContext();
        return gl.getParameter(
          gl.getExtension("WEBGL_debug_renderer_info").UNMASKED_RENDERER_WEBGL,
        );
      });
      expect(software).toMatch(/swiftshader/i);
      await page.evaluate(() => {
        const f = globalThis.fixtureRenderer;
        f.intents = [];
        f.adapter.onIntent((intent) => f.intents.push(intent));
      });
      await page.locator("canvas").click({ position: { x: 270, y: 180 } });
      expect(await page.evaluate(() => globalThis.fixtureRenderer.intents)).toEqual([]);
      await page.locator("canvas").click({ position: { x: 320, y: 200 } });
      expect(await page.evaluate(() => globalThis.fixtureRenderer.intents)).toEqual([
        { type: "select", objectId: "object-fixture" },
      ]);
      expect([initial.ready, initial.skinned, initial.normal, initial.depth]).toEqual([
        true,
        true,
        true,
        true,
      ]);
      const angle = () => page.evaluate(() => globalThis.fixtureRenderer.diagnostics.boneAngle);
      const moving = await angle();
      await expect.poll(angle).not.toBe(moving);
      await page.evaluate(() => globalThis.fixtureRenderer.setReducedMotion(true));
      await expect.poll(angle).toBe(0);
      const held = await capture();
      // Decision: 80 ms spans multiple frames at the existing 30 fps floor for the held-picture check.
      await page.waitForTimeout(80);
      expect(await capture()).toBe(held);
      const sliderErrors = [];
      page.on("pageerror", (error) => sliderErrors.push(error.message));
      const slider = page.getByRole("slider", { name: "Time of day" });
      await slider.click({ position: { x: 39, y: 8 } });
      const inputTime = Number(await slider.inputValue());
      expect(Number.isInteger(inputTime)).toBe(false);
      await expect
        .poll(() =>
          page.evaluate(() => {
            const f = globalThis.fixtureRenderer;
            return [
              String(f.snapshot.simulationTime),
              String(f.diagnostics.lastFrame.simulationTime),
            ];
          }),
        )
        .toEqual([String(Math.round(inputTime)), String(Math.round(inputTime))]);
      expect(await capture()).not.toBe(held);
      expect(sliderErrors).toEqual([]);
      await page.evaluate(() => globalThis.fixtureRenderer.setEnvironment(79_200_000, 9000));
      await expect
        .poll(() =>
          page.evaluate(() => {
            const frame = globalThis.fixtureRenderer.diagnostics.lastFrame;
            return [
              String(frame.simulationTime),
              frame.weather.rainIntensity,
              frame.reducedMotion,
              frame.timeMs,
            ];
          }),
        )
        .toEqual(["79200000", 9000, true, 0]);
      expect(await capture()).not.toBe(held);
      for (const quality of ["medium", "high", "low"]) {
        await page.evaluate((q) => globalThis.fixtureRenderer.setQuality(q), quality);
        await expect
          .poll(() =>
            page.evaluate(() => {
              const f = globalThis.fixtureRenderer;
              return [f.diagnostics.lastFrame.qualityTier, f.diagnostics.sprite.material.type];
            }),
          )
          .toEqual([
            quality,
            quality === "low" ? "MeshLambertNodeMaterial" : "MeshStandardNodeMaterial",
          ]);
      }
      await page.evaluate(() => globalThis.fixtureRenderer.setEnvironment(43_200_000, 0));
      const mapped = await capture();
      await page.evaluate(() => globalThis.fixtureRenderer.setNormalEnabled(false));
      expect(await capture()).not.toBe(mapped);
      const sample = async (y = 194) =>
        page.evaluate(async (sampleY) => {
          const image = new Image();
          image.src = globalThis.fixtureRenderer.capture();
          await image.decode();
          const canvas = document.createElement("canvas");
          canvas.width = 640;
          canvas.height = 400;
          const context = canvas.getContext("2d");
          context.drawImage(image, 0, 0);
          return [...context.getImageData(320, sampleY, 1, 1).data];
        }, y);
      await page.evaluate(() => {
        const f = globalThis.fixtureRenderer;
        f.setDepthEnabled(false);
        f.setContentAnchor(-0.2, 0.2);
      });
      const behind = await sample();
      await page.evaluate(() => globalThis.fixtureRenderer.setContentAnchor(0.2, -0.2));
      const front = await sample();
      expect(front).not.toEqual(behind);
      await page.evaluate(() => globalThis.fixtureRenderer.setContentAnchor(-0.2, 0.2));
      await page.evaluate(() => globalThis.fixtureRenderer.setDepthEnabled(true));
      expect(await sample()).not.toEqual(behind);
      await page.evaluate(() => {
        const f = globalThis.fixtureRenderer;
        f.setDepthEnabled(false);
        f.setContentAnchor(0, 0);
        f.setModelAnchor(-0.8, 0.8);
      });
      const spriteFront = await sample(184);
      await page.evaluate(() => globalThis.fixtureRenderer.setModelAnchor(0.2, -0.2));
      const modelFront = await sample(184);
      expect(spriteFront[2]).toBeGreaterThan(spriteFront[0]);
      expect(modelFront[0]).toBeGreaterThan(modelFront[2]);
      expect(
        await page.evaluate(() => globalThis.fixtureRenderer.adapter.metrics.textureBytes),
      ).toBeLessThanOrEqual(16 * 1024 * 1024);
      await page.evaluate(() => globalThis.fixtureRenderer.setModelAnchor(-2, -2));
      const compression = await page.evaluate(async () => {
        const f = globalThis.fixtureRenderer;
        const { ktx2, gltf } = await f.diagnostics.loaders({
          basis: "/decoders/",
          draco: "/decoders/",
        });
        const texture = await ktx2.loadAsync("/generated.ktx2");
        const loaded = await gltf.loadAsync("/generated.gltf");
        const positions = [...loaded.scene.children[0].geometry.getAttribute("position").array];
        f.diagnostics.sprite.material.map = texture;
        f.diagnostics.sprite.material.needsUpdate = true;
        f.capture();
        return {
          compressed: texture.isCompressedTexture,
          size: [texture.image.width, texture.image.height],
          positions,
        };
      });
      expect(compression).toEqual({
        compressed: true,
        size: [4, 4],
        positions: [-1, 0, 0, 1, 0, 0, 0, 1, 0],
      });
      const compressedPixel = await sample(184);
      expect(compressedPixel[0]).toBeGreaterThan(compressedPixel[1]);
      expect(compressedPixel[0]).toBeGreaterThan(compressedPixel[2]);
      await page.close();
      const neutral = await open("?content=none");
      const neutralPixels = await neutral.evaluate(() => {
        globalThis.fixtureRenderer.setReducedMotion(true);
        return globalThis.fixtureRenderer.capture();
      });
      expect(
        await neutral.evaluate(() => globalThis.fixtureRenderer.adapter.metrics.contentStatus),
      ).toBe("none");
      await neutral.close();
      for (const reason of ["load", "contract", "update", "draw", "vertex", "shader"]) {
        const failure = reason === "vertex" ? "contract" : reason === "shader" ? "draw" : reason;
        const failed = await open(`?failure=${reason}`);
        await expect
          .poll(() =>
            failed.evaluate(() => {
              const f = globalThis.fixtureRenderer;
              return [
                f.adapter.metrics.contentStatus,
                f.adapter.metrics.contentFailure,
                f.adapter.metrics.contentFailures,
              ];
            }),
          )
          .toEqual(["failed", `content_${failure}`, 1]);
        expect(
          await failed.evaluate(() => {
            globalThis.fixtureRenderer.setReducedMotion(true);
            return globalThis.fixtureRenderer.capture();
          }),
        ).toBe(neutralPixels);
        expect(await failed.locator("#status").textContent()).toBe("Scene ready");
        await failed.selectOption("#clock", "79200000");
        expect(
          await failed.evaluate(() => String(globalThis.fixtureRenderer.snapshot.simulationTime)),
        ).toBe("79200000");
        expect(
          await failed.evaluate(() =>
            globalThis.fixtureRenderer.reports.filter(
              (p) => p.name === "renderer_content" && p.category.startsWith("content_"),
            ),
          ),
        ).toEqual([{ name: "renderer_content", category: `content_${failure}`, value: 1 }]);
        await failed.close();
      }
      const heavy = await open("?workMs=40");
      for (const reduced of [false, true]) {
        await heavy.evaluate((value) => {
          globalThis.fixtureRenderer.setReducedMotion(value);
          globalThis.fixtureRenderer.setQuality("high");
        }, reduced);
        await expect
          .poll(
            () =>
              heavy.evaluate(() => globalThis.fixtureRenderer.diagnostics.lastFrame.qualityTier),
            { timeout: 30_000 },
          )
          .not.toBe("high");
        expect(
          await heavy.evaluate(() => globalThis.fixtureRenderer.adapter.metrics.contentUpdateMs),
        ).toBeGreaterThanOrEqual(40);
      }
      await heavy.close();
    } finally {
      await browser?.close();
      await server.close();
      await rm(world, { recursive: true, force: true });
    }
  },
  180_000,
);
