import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import {
  advanceCommand,
  provisionTestWorld,
  truthOf,
} from "../../apps/runtime/test/world-fixture.ts";
import {
  isNativeWorldOwnerChild,
  runNativeWorldOwnerProcess,
  withNativeWorldOwner,
} from "../../apps/runtime/test/world-owner/native-harness.ts";
import { createServer } from "../../apps/web/node_modules/vite/dist/node/index.js";
import { worldRoutePath } from "../../apps/web/src/world-route.ts";
import { decodeLivingScene } from "../../packages/contracts/src/index.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const external = process.env.CLOCKGROVE_CAPTURE_PACK !== undefined;
const pack = process.env.CLOCKGROVE_CAPTURE_PACK ?? "fixture/reference";
const FILE = "tests/visual/golden-states.journey.browser.test.mjs";
/** Wave 4 plan §15.3: two desktop layouts and one narrow layout (390×844, a phone portrait). */
const VIEWPORTS = [
  { width: 1536, height: 864 },
  { width: 1280, height: 720 },
  { width: 390, height: 844 },
];
// Owner findings on #74 (2026-11-08): Vulkan and ANGLE are required for SwiftShader swap chains.
const GPU_FLAGS = [
  "--enable-unsafe-webgpu",
  "--enable-unsafe-swiftshader",
  "--use-webgpu-adapter=swiftshader",
  "--use-angle=swiftshader",
  "--enable-features=Vulkan",
  "--use-vulkan=swiftshader",
];
const BACKENDS = process.env.CLOCKGROVE_RENDERER_PROOF
  ? [process.env.CLOCKGROVE_RENDERER_PROOF]
  : ["webgpu", "webgl2"];
const TIERS = ["low", "medium", "high"];
// The shell renders each wall-clock value, such as an action's recorded-at time, in a
// `[data-wall-clock]` element; it differs on every run. The capture paints each one as a solid
// box, so a capture's hash depends only on the commit and the world. The box is as wide as its
// text in tabular numerals: a value of another length, not another time, changes the hash.
const WALL_CLOCK_MASK =
  "[data-wall-clock] { color: transparent !important; background: #ff00ff !important; font-variant-numeric: tabular-nums !important; }";
// scripts/capture-world.mjs asks a run to stop by creating this file. Vitest exits at once on a
// signal, so the run stops itself instead and tears down as it does after a failure.
const STOP_FILE = process.env.CLOCKGROVE_CAPTURE_STOP;
const throwIfStopped = () => {
  if (STOP_FILE !== undefined && existsSync(STOP_FILE)) throw new Error("Capture run stopped");
};
/** The client measurement fields (apps/web/src/measurements.ts): opaque IDs and categories only. */
const MEASUREMENT_FIELDS = [
  "name",
  "category",
  "value",
  "release",
  "worldPack",
  "worldId",
  "assetHash",
];

/** PNG signature, then IHDR width and height (big-endian) at bytes 16 and 20. */
function pngSize(bytes) {
  expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

// issue 814: the §15.3 golden states at each matrix viewport, captured with their SHA-256 for the Wave 4
// manifest, which compares them with human approvals; the journey itself asserts state, not pixels.
const captureGoldenStates = async (backend) => {
  throwIfStopped();
  if (!isNativeWorldOwnerChild()) {
    const previous = process.env.CLOCKGROVE_RENDERER_PROOF;
    process.env.CLOCKGROVE_RENDERER_PROOF = backend;
    try {
      await runNativeWorldOwnerProcess(FILE, pack, {
        vitestConfig: "tests/ci/vitest.browser.config.ts",
        timeoutMs: 210_000,
        inheritOutput: true,
        prepare: (fixture) =>
          truthOf(fixture)(
            `UPDATE clockgrove.world_memberships SET grants=ARRAY['runtime:world-observe','runtime:world-inspect','runtime:world-command'] WHERE principal_id='principal-runtime';
          UPDATE clockgrove_auth.session SET token='hall-inspect' WHERE token='local-reader-session'`,
          ),
      });
    } finally {
      if (previous === undefined) delete process.env.CLOCKGROVE_RENDERER_PROOF;
      else process.env.CLOCKGROVE_RENDERER_PROOF = previous;
    }
    return;
  }
  await withNativeWorldOwner(async (native) => {
    const { fixture, world } = native;
    const provisioned = await provisionTestWorld(fixture, world, "principal-runtime");
    const scope = {
      ...provisioned.partition.target,
      spaceId: provisioned.partition.route.spaceId,
    };
    const truth = truthOf(fixture);
    // The HUD shows a 24-hour face scaled from the world's day length (apps/web/src/hud.tsx), so
    // each state's time is a face time on the selected world's day.
    const dayLength = world.behavior.policy.environment?.dayLengthMs;
    if (dayLength === undefined)
      throw new Error("Capture states need a world clock: the behavior policy has no environment");
    const face = (time) => {
      const minutes = ((time % dayLength) * 1440n) / dayLength;
      return `${(minutes / 60n).toString().padStart(2, "0")}:${(minutes % 60n).toString().padStart(2, "0")}`;
    };
    const revision = async () =>
      BigInt(
        await truth(
          `SELECT revision FROM clockgrove.partition_states WHERE partition_id = '${provisioned.partition.route.partitionId}'`,
        ),
      );
    const scene = async () =>
      decodeLivingScene(
        (await native.request("/v1/runtime/scene", { version: 1, ...scope }, "hall-inspect")).body,
      );
    const commit = async (command) => {
      const { status, body } = await native.submit(command, {}, "hall-inspect");
      expect(status, JSON.stringify(body)).toBe(200);
    };
    /** Advances to the next face time `hour`:`minute` and returns the face the HUD must show. */
    const advanceTo = async (key, hour, minute = 0n) => {
      throwIfStopped();
      const now = BigInt((await scene()).simulationTime);
      const day = now - (now % dayLength);
      // Rounded up, so the HUD's rounded-down face reads exactly this minute.
      let target = day + ((hour * 60n + minute) * dayLength + 1439n) / 1440n;
      if (external && target < now) target += dayLength;
      if (target > now)
        await commit({
          ...advanceCommand(world, key, target, await revision(), {
            maxInputs: 1024,
            maxEvents: 4096,
          }),
        });
      return face(target);
    };
    const evidenceRoot =
      process.env.CLOCKGROVE_CAPTURE_OUT ??
      (process.env.CLOCKGROVE_WAVE4_EVIDENCE === undefined
        ? await mkdtemp(path.join(os.tmpdir(), "clockgrove-wave4-visual-"))
        : path.join(process.env.CLOCKGROVE_WAVE4_EVIDENCE, "visual"));
    const out = backend === "webgpu" ? evidenceRoot : path.join(evidenceRoot, "webgl2");
    await mkdir(out, { recursive: true });
    if (!external)
      process.env.CLOCKGROVE_WORLD_SHELL = path.join(root, "worlds/fixture/reference/shell.json");
    const visible = new Set((await scene()).entities.map(({ objectId }) => objectId));
    const entities = world.birth.state.entities.filter(({ objectId }) => visible.has(objectId));
    const actorId = external
      ? (process.env.CLOCKGROVE_CAPTURE_ACTOR ?? entities.find((entity) => entity.needs)?.objectId)
      : "fixture.keeper";
    const objectId = external
      ? (process.env.CLOCKGROVE_CAPTURE_OBJECT ??
        entities.find((entity) => !entity.needs && entity.objectId !== actorId)?.objectId)
      : "fixture.den";
    for (const id of [actorId, objectId])
      if (!id || !entities.some((entity) => entity.objectId === id))
        throw new Error(
          `Capture selection is absent from the world: ${id ?? "supply --actor and --object"}`,
        );
    const server = await createServer({
      root: path.join(root, "apps/web"),
      configFile: path.join(root, "apps/web/vite.config.ts"),
      server: {
        host: "127.0.0.1",
        port: 0,
        proxy: { "/v1": { target: await native.origin(), ws: true } },
      },
      plugins: [
        {
          name: "expose-client-measurements",
          transform(code, id) {
            if (id.split("?")[0] === path.join(root, "apps/web/src/renderer.ts"))
              return {
                code: `${backend === "webgl2" ? code.replace("new THREE.WebGPURenderer({", "new THREE.WebGPURenderer({ forceWebGL: true,") : code}\nconst load = ThreeWorldSceneAdapter.prototype.loadSnapshot;\nThreeWorldSceneAdapter.prototype.loadSnapshot = function (...args) { globalThis.hallAdapter = this; return load.apply(this, args); };`,
                map: null,
              };
            if (id.split("?")[0] === path.join(root, "apps/web/src/measurements.ts"))
              return {
                code: `${code}\nglobalThis.hallMeasurements = clientMeasurements;`,
                map: null,
              };
          },
        },
      ],
    });
    let browser;
    let stopped = false;
    // A stop request closes the browser, so a pending page wait fails now rather than at its timeout.
    const watch = setInterval(() => {
      if (!stopped && STOP_FILE !== undefined && existsSync(STOP_FILE)) {
        stopped = true;
        browser?.close().catch(() => undefined);
      }
    }, 250);
    try {
      throwIfStopped();
      await server.listen();
      const { port } = server.httpServer.address();
      browser = await chromium.launch({ headless: true, args: GPU_FLAGS });
      throwIfStopped();
      const vitals = [];
      const open = async (viewport, text, missingAtlas = false) => {
        const page = await browser.newPage({
          viewport,
          deviceScaleFactor: 1,
          reducedMotion: "reduce",
        });
        await page.addInitScript(() => {
          globalThis.WebSocket = class extends WebSocket {
            constructor(...args) {
              super(...args);
              if (new URL(this.url).pathname === "/v1/projection")
                globalThis.hallSceneSocket = this;
            }
          };
        });
        // Text-access mode is the shell without its renderer.
        if (text)
          await page.route(
            (url) => url.pathname === "/src/renderer.ts",
            (route) => route.abort(),
          );
        // §16 asset 404: the reviewed atlas is missing behind a loaded renderer.
        if (missingAtlas)
          await page.route(
            (url) => url.pathname === "/fixture-world.png",
            (route) => route.fulfill({ status: 404 }),
          );
        await page.goto(`http://127.0.0.1:${port}/`);
        await page.getByLabel("Local session credential").fill("hall-inspect");
        await page.getByRole("button", { name: "Sign in", exact: true }).click();
        if (external) await page.locator("select#world").selectOption(worldRoutePath(scope));
        else
          await page
            .getByLabel("World", { exact: true })
            .selectOption({ label: `${scope.worldId} / ${scope.spaceId}` });
        await page
          .getByText(
            text || missingAtlas
              ? /^Arrival: text scene ready at revision /
              : /^Arrival: scene ready at revision /u,
          )
          .waitFor();
        if (!text && !missingAtlas)
          expect(await page.evaluate(() => globalThis.hallAdapter.tier)).toBe("low");
        // Web Vitals the arrival produced (§19): paint, layout shift and first byte, from the page's
        // own buffered performance entries.
        vitals.push({
          viewport,
          text,
          ...(await page.evaluate(
            () =>
              new Promise((resolve) => {
                const result = { cls: 0 };
                new PerformanceObserver((list) => {
                  for (const entry of list.getEntries()) result.lcpMs = entry.startTime;
                }).observe({ type: "largest-contentful-paint", buffered: true });
                new PerformanceObserver((list) => {
                  for (const entry of list.getEntries())
                    if (!entry.hadRecentInput) result.cls += entry.value;
                }).observe({ type: "layout-shift", buffered: true });
                result.ttfbMs = performance.getEntriesByType("navigation")[0]?.responseStart;
                result.fcpMs = performance.getEntriesByName("first-contentful-paint")[0]?.startTime;
                setTimeout(() => resolve(result), 100);
              }),
          )),
        });
        return page;
      };
      const shellInput = external
        ? JSON.parse(await readFile(process.env.CLOCKGROVE_WORLD_SHELL, "utf8"))
        : undefined;
      const pages = [];
      for (const viewport of VIEWPORTS) pages.push(await open(viewport, false));
      const browserShell = external
        ? await pages[0].evaluate(
            (tokens) => ({
              title: document.title,
              tokens: Object.fromEntries(
                Object.keys(tokens).map((name) => [
                  name,
                  getComputedStyle(document.documentElement).getPropertyValue(name).trim(),
                ]),
              ),
            }),
            shellInput.tokens,
          )
        : undefined;
      const browserAssets = external
        ? await pages[0].evaluate(() => ({
            pages: globalThis.hallAdapter.atlasTextures.length,
            animations: [...globalThis.hallAdapter.atlas.keys()].sort(),
          }))
        : undefined;
      const captures = [];
      // Pages whose clock a state holds (Playwright's page.clock); only the capture advances it.
      const held = new Set();
      const capture = async (state, page, check) => {
        throwIfStopped();
        // A check may name the region its state is about; the capture frames it, else the page top.
        const region = await check(page);
        // The HUD clock and the feed come from the world-status read, which follows the committed
        // revision on its own interval: the capture waits until a read has landed and caught up.
        // `aria-busy` is false before the first read and after a failed one too, so the clock must
        // also show a day and time, never "Clock loading", "Clock unavailable" or "…, updating".
        if ((await clock(page).count()) > 0)
          await expect
            .poll(async () => [
              await clock(page).getAttribute("aria-busy"),
              /^Day \d+, \d{2}:\d{2}$/u.test(
                await clock(page).locator(".rw-clock-time").innerText(),
              ),
            ])
            .toEqual(["false", true]);
        // The region's offset follows the content above it, such as the live changes log, whose
        // entries depend on how the run's commits fell into its announcement interval. Scrolling
        // stops on whole pixels, so a fractional offset would move the framed text by a pixel: the
        // scene column's padding first takes the region to a whole pixel, until the capture ends.
        if (region)
          expect(
            await region.evaluate((element) => {
              element.scrollIntoView({ block: "start" });
              const top = element.getBoundingClientRect().top;
              const column = element.closest(".rw-main");
              if (column && top !== Math.ceil(top)) {
                column.style.paddingTop = `calc(${getComputedStyle(column).paddingTop} + ${Math.ceil(top) - top}px)`;
                element.scrollIntoView({ block: "start" });
              }
              return element.getBoundingClientRect().top;
            }),
            `${state}: framed on a whole pixel`,
          ).toSatisfy(Number.isInteger);
        // Two animation frames let the canvas present the committed state before the capture. The
        // window scrolls the narrow layout and the scene column scrolls the desktop frame.
        await page.evaluate((framed) => {
          if (!framed)
            for (const scroller of [
              document.scrollingElement,
              ...document.querySelectorAll(".rw-main"),
            ])
              scroller.scrollTo(0, 0);
          globalThis.hallPresented = new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
        }, region !== undefined);
        // A held page clock runs only those two frames (16 ms each), so no page timer runs late.
        if (held.has(page)) await page.clock.runFor(50);
        await page.evaluate(() => globalThis.hallPresented);
        // Nothing passes under the HUD: the scene column starts below it and either clips its own
        // scrolling content (the desktop frame) or scrolls the HUD away with it (the narrow page).
        // A framed region's top edge is the region itself, never the HUD or anything over it.
        expect(
          await page.evaluate(
            (framed) => {
              const hud = document.querySelector(".rw-hud");
              const main = document.querySelector(".rw-main");
              const box = framed?.getBoundingClientRect();
              return [
                main.getBoundingClientRect().top >= hud.getBoundingClientRect().bottom,
                getComputedStyle(hud).position === "static" ||
                  getComputedStyle(main).overflowY !== "visible",
                framed === null ||
                  framed.contains(
                    document.elementFromPoint(box.left + box.width / 2, Math.max(box.top, 0) + 1),
                  ),
              ];
            },
            region ? await region.elementHandle() : null,
          ),
          `${state}: clear of the HUD`,
        ).toEqual([true, true, true]);
        const bytes = await page.screenshot({
          animations: "disabled",
          caret: "hide",
          style: WALL_CLOCK_MASK,
        });
        if (region)
          await page.evaluate(() => {
            for (const column of document.querySelectorAll(".rw-main"))
              column.style.paddingTop = "";
          });
        const viewport = page.viewportSize();
        expect(pngSize(bytes)).toEqual(viewport);
        const file = `${state}@${viewport.width}x${viewport.height}.png`;
        await writeFile(path.join(out, file), bytes);
        captures.push({
          state,
          viewport,
          file,
          sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
          bytes: bytes.length,
          announced: await page.getByText(/^Observation: /u).textContent(),
        });
      };
      const each = async (state, check) => {
        for (const page of pages) await capture(state, page, check);
      };
      const clock = (page) => page.getByRole("region", { name: "World clock" });
      const living = (page) => page.getByRole("region", { name: "Living scene" });
      const rail = (page) => page.getByRole("region", { name: "Entity rail" });
      // Below the desktop breakpoint the rail is a collapsed sheet (§4.4); the capture opens it.
      const openRail = async (page) => {
        const opener = rail(page).getByRole("button", { name: "Open entity rail" });
        if ((await opener.count()) > 0) await opener.click();
      };
      const selected = (page) => page.getByRole("region", { name: "Selected entity", exact: true });

      const externalWeather = async (key, rainIntensity) => {
        if (external && (await scene()).weather.rainIntensity !== rainIntensity) {
          await commit({
            ...advanceCommand(world, key, 0n, await revision()),
            type: "world.weather.set",
            payload: { schemaVersion: 2, rainIntensity },
          });
        }
      };
      const noon = await advanceTo("visual-daylight", 12n);
      await externalWeather("visual-dry", 0);
      const daylight = await scene();
      await each("daylight-dry", async (page) => {
        await living(page)
          .getByText(`Canonical revision: ${daylight.revision}`, { exact: true })
          .waitFor();
        await living(page).getByText("Rain intensity: 0", { exact: true }).waitFor();
        await clock(page)
          .getByText(new RegExp(`^Day \\d+, ${noon}$`, "u"))
          .waitFor();
      });

      const tierComparisons = [];
      const captureTiers = async (state, hour, minute = 0n) => {
        const time = await advanceTo(`visual-${state}-tiers`, hour, minute);
        await externalWeather(`visual-${state}-rain`, 9000);
        const committed = await scene();
        for (const tier of TIERS) {
          await each(`${state}-rain-${tier}`, async (page) => {
            await living(page)
              .getByText(`Canonical revision: ${committed.revision}`, { exact: true })
              .waitFor();
            // The clock reads the committed time, not an earlier one marked updating.
            await clock(page)
              .getByText(new RegExp(`^Day \\d+, ${time}$`, "u"))
              .waitFor();
            await page.evaluate((quality) => globalThis.hallAdapter.setQuality(quality), tier);
            return living(page);
          });
          for (const page of pages) {
            if (external) {
              const actual = await page.evaluate(() => ({
                backend: globalThis.hallAdapter.backend,
                api:
                  globalThis.hallAdapter.backend === "webgpu"
                    ? globalThis.hallAdapter.renderer.backend.isWebGPUBackend === true
                    : globalThis.hallAdapter.renderer.getContext() instanceof
                      WebGL2RenderingContext,
              }));
              expect(actual).toEqual({ backend, api: true });
              tierComparisons.push({ state, tier, viewport: page.viewportSize(), ...actual });
              continue;
            }
            // Render and read in the same task: a locator screenshot can include a fixed
            // DOM header or change hover while scrolling the canvas into view on the phone layout.
            const canvasPixels = async () =>
              Buffer.from(
                await page.evaluate(() => {
                  const adapter = globalThis.hallAdapter;
                  if (adapter.composer) adapter.composer.render();
                  else adapter.renderer.render(adapter.scene, adapter.camera);
                  return adapter.renderer.domElement.toDataURL("image/png").split(",")[1];
                }),
                "base64",
              );
            const first = await canvasPixels();
            await page.evaluate(
              () =>
                new Promise((resolve) =>
                  requestAnimationFrame(() => requestAnimationFrame(resolve)),
                ),
            );
            const held = await canvasPixels();
            // Reduced motion freezes every tier's wind, rain, sprite frames and light modulation.
            expect(held.equals(first), `${state}/${tier}: frozen pixels`).toBe(true);
            const pixels = await page.evaluate(async (encoded) => {
              const image = new Image();
              image.src = `data:image/png;base64,${encoded}`;
              await image.decode();
              const canvas = document.createElement("canvas");
              canvas.width = image.width;
              canvas.height = image.height;
              const context = canvas.getContext("2d");
              context.drawImage(image, 0, 0);
              const { data } = context.getImageData(0, 0, image.width, image.height);
              let warm = 0;
              let clipped = 0;
              let luminance = 0;
              for (let offset = 0; offset < data.length; offset += 4) {
                const [r, g, b] = data.subarray(offset, offset + 3);
                if (r > 80 && r > g * 1.1 && g > b * 1.1) warm += 1;
                if (r >= 250 && g >= 250 && b >= 250) clipped += 1;
                luminance += 0.2126 * r + 0.7152 * g + 0.0722 * b;
              }
              const adapter = globalThis.hallAdapter;
              const sources = adapter.effects
                .filter(({ role, sprite }) => role !== "puddle" && sprite.visible)
                .map(({ role, key, sprite }) => {
                  const animation = adapter.atlas.get(key);
                  const frame = animation.frames[0];
                  const camera = adapter.camera;
                  const left = Math.round(
                    ((sprite.position.x - animation.anchor.x - camera.position.x) *
                      camera.zoom *
                      image.width) /
                      (camera.right - camera.left) +
                      image.width / 2,
                  );
                  const top = Math.round(
                    ((-sprite.position.y - animation.anchor.y + camera.position.y) *
                      camera.zoom *
                      image.height) /
                      (camera.top - camera.bottom) +
                      image.height / 2,
                  );
                  let warmPixels = 0;
                  for (
                    let y = Math.max(0, top);
                    y <
                    Math.min(
                      image.height,
                      top +
                        (frame.height * camera.zoom * image.height) / (camera.top - camera.bottom),
                    );
                    y++
                  )
                    for (
                      let x = Math.max(0, left);
                      x <
                      Math.min(
                        image.width,
                        left +
                          (frame.width * camera.zoom * image.width) / (camera.right - camera.left),
                      );
                      x++
                    ) {
                      const offset = (y * image.width + x) * 4;
                      const [r, g, b] = data.subarray(offset, offset + 3);
                      if (r > 80 && r > g * 1.1 && g > b * 1.1) warmPixels += 1;
                    }
                  return { role, warmPixels };
                });
              return {
                warm,
                clipped,
                sources,
                meanLuminance: luminance / (image.width * image.height),
                lights: adapter.scene.children.filter((child) => child.isPointLight).length,
                backend: adapter.backend,
                textureBytes: adapter.metrics.textureBytes,
                renderSize: [
                  adapter.scenePass.renderTarget.width,
                  adapter.scenePass.renderTarget.height,
                ],
                canvasSize: [adapter.renderer.domElement.width, adapter.renderer.domElement.height],
                hostSize: [adapter.parent.clientWidth, adapter.parent.clientHeight],
                dpr: devicePixelRatio,
                litMaterials: [
                  ...new Set(
                    [
                      adapter.ground,
                      ...[...adapter.drawn.values()].map(({ body }) => body),
                      ...adapter.effects.map(({ sprite }) => sprite),
                    ].map((mesh) => mesh.material.type),
                  ),
                ],
                puddleRoughness: adapter.effects
                  .filter(({ role }) => role === "puddle")
                  .map(({ sprite }) => sprite.material.roughness ?? null),
                atlasShared: [
                  ...[...adapter.drawn.values()]
                    .filter((drawn) => drawn.key)
                    .map((drawn) => drawn.body),
                  ...adapter.effects.map(({ sprite }) => sprite),
                  ...adapter.reflections.filter((mirror) => mirror.userData.source.userData.key),
                ].every((mesh) => mesh.material.map === adapter.atlasTextures[0]),
                reflectionBlending: adapter.reflections.map((mirror) => [
                  mirror.material.transparent,
                  mirror.material.opacity,
                  adapter.effects
                    .filter(({ role }) => role === "puddle")
                    .every(({ sprite }) => sprite.renderOrder < mirror.renderOrder),
                ]),
                reflectionUvs: adapter.reflections.every((mirror) =>
                  mirror.geometry
                    .getAttribute("uv")
                    .array.every(
                      (value, index) =>
                        value === mirror.userData.source.geometry.getAttribute("uv").array[index],
                    ),
                ),
                adapter:
                  adapter.backend === "webgpu"
                    ? {
                        architecture: adapter.renderer.backend.device.adapterInfo.architecture,
                        vendor: adapter.renderer.backend.device.adapterInfo.vendor,
                        description: adapter.renderer.backend.device.adapterInfo.description,
                      }
                    : {
                        renderer: adapter.renderer
                          .getContext()
                          .getParameter(
                            adapter.renderer.getContext().getExtension("WEBGL_debug_renderer_info")
                              .UNMASKED_RENDERER_WEBGL,
                          ),
                      },
                api:
                  adapter.backend === "webgpu"
                    ? adapter.renderer.backend.isWebGPUBackend === true
                    : adapter.renderer.getContext() instanceof WebGL2RenderingContext,
              };
            }, first.toString("base64"));
            // Tuning decisions: warm pixels survive grading and no rendered pixel clips all channels
            // to white. This comparison reads the output PNG independently of the material uniforms.
            expect(pixels.backend).toBe(backend);
            if (backend === "webgpu") expect(pixels.adapter.architecture).toBe("swiftshader");
            else expect(pixels.adapter.renderer).toMatch(/SwiftShader/i);
            expect(pixels.meanLuminance).toBeGreaterThan(0);
            expect(pixels.textureBytes).toBeLessThanOrEqual(
              { low: 16, medium: 64, high: 192 }[tier] * 1024 * 1024,
            );
            const outputScale = Math.min(
              pixels.dpr,
              Math.sqrt(
                { low: 512000, medium: 1000000, high: 3000000 }[tier] /
                  (pixels.hostSize[0] * pixels.hostSize[1]),
              ),
            );
            const outputSize = pixels.hostSize.map((value) => Math.floor(value * outputScale));
            expect(pixels.canvasSize).toEqual(outputSize);
            expect(pixels.renderSize).toEqual(
              outputSize.map((value) => Math.floor(value * (tier === "low" ? 0.5 : 1))),
            );
            expect([pixels.atlasShared, pixels.reflectionUvs]).toEqual([true, true]);
            expect(pixels.reflectionBlending.length > 0).toBe(tier === "high");
            expect(pixels.reflectionBlending).toEqual(
              pixels.reflectionBlending.map(() => [true, 0.22, true]),
            );
            expect(pixels.litMaterials).toEqual([
              tier === "low" ? "MeshLambertNodeMaterial" : "MeshStandardNodeMaterial",
            ]);
            expect(pixels.puddleRoughness).toEqual(
              pixels.puddleRoughness.map(() => (tier === "low" ? null : 0.08)),
            );
            expect([pixels.api, pixels.clipped, pixels.lights]).toEqual([
              true,
              0,
              state === "night" ? 2 : 0,
            ]);
            if (state === "night") {
              expect(
                pixels.sources.map(({ role, warmPixels }) => [role, warmPixels > 0]).sort(),
              ).toEqual([
                ["lantern", true],
                ["window", true],
              ]);
            }
            tierComparisons.push({ state, tier, viewport: page.viewportSize(), ...pixels });
          }
        }
      };
      await commit({
        ...advanceCommand(world, "visual-rain", 0n, await revision()),
        type: "world.weather.set",
        payload: { schemaVersion: 2, rainIntensity: 9000 },
      });
      await captureTiers("dusk", 17n, 45n);
      const evening = await advanceTo("visual-dusk", 19n);
      await externalWeather("visual-dusk-rain", 9000);
      const dusk = await scene();
      await each("dusk-rain", async (page) => {
        await living(page)
          .getByText(`Canonical revision: ${dusk.revision}`, { exact: true })
          .waitFor();
        await living(page).getByText("Rain intensity: 9000", { exact: true }).waitFor();
        await clock(page)
          .getByText(new RegExp(`^Day \\d+, ${evening}$`, "u"))
          .waitFor();
      });

      await captureTiers("night", 22n);
      for (const night of tierComparisons.filter(({ state }) => !external && state === "night")) {
        const dusk = tierComparisons.find(
          (row) =>
            row.state === "dusk" &&
            row.tier === night.tier &&
            row.viewport.width === night.viewport.width,
        );
        expect(
          night.meanLuminance,
          `${night.tier}: night darkens the committed dusk projection`,
        ).toBeLessThan(dusk.meanLuminance);
      }
      for (const page of pages) await page.evaluate(() => globalThis.hallAdapter.setQuality("low"));

      // fixture-hall has no cognitive actor before Wave 5: Keeper, an actor, discloses reactive.
      await each("selected-actor-rail", async (page) => {
        if (external) {
          await living(page)
            .getByRole("button")
            .evaluateAll((buttons, id) => {
              const button = buttons.find((button) => button.dataset.focusKey === `entity:${id}`);
              if (!button) throw new Error(`Missing actor ${id}`);
              button.click();
            }, actorId);
        } else
          await living(page).getByRole("button", { name: "fixture.keeper", exact: true }).click();
        await openRail(page);
        if (!external)
          await expect
            .poll(() => rail(page).innerText())
            .toContain("Deterministic/reactive object");
        await selected(page)
          .getByText(/^Selected entity at canonical revision /u)
          .waitFor();
        // At the low arrival tier the scene pass is a quarter of the canvas, but the selection pill
        // and label draw in their own pass at the canvas's full resolution, so the text stays legible.
        await expect
          .poll(() =>
            page.evaluate(() => {
              const adapter = globalThis.hallAdapter;
              const labels = adapter.scene.children.filter((child) =>
                ["selection-pill", "selection-label"].includes(child.name),
              );
              const size = (target) => [target.width, target.height];
              return [
                adapter.tier,
                labels.length,
                size(adapter.scenePass.renderTarget).map(
                  (value, i) => value === Math.floor(size(adapter.labelPass.renderTarget)[i] / 2),
                ),
                size(adapter.labelPass.renderTarget).map(
                  (value, i) => value === [adapter.canvas.width, adapter.canvas.height][i],
                ),
                labels.some((label) => label.layers.test(adapter.camera.layers)),
                labels.every((label) => !adapter.scenePass._layers.test(label.layers)),
                labels.every((label) => adapter.labelPass._layers.test(label.layers)),
              ];
            }),
          )
          .toEqual(["low", 2, [true, true], [true, true], true, true, true]);
      });
      await each("event-why-inspector", async (page) => {
        await selected(page)
          .getByRole("button", { name: /^Why action / })
          .first()
          .click();
        const why = page.getByRole("region", { name: "Recorded Why" });
        await why.getByText("Recorded evidence loaded.", { exact: true }).waitFor();
        await why.getByText("Recorded command", { exact: true }).waitFor();
        expect(await why.getAttribute("aria-busy")).toBe("false");
        await why.getByRole("button", { name: "Close Why" }).waitFor();
        return why;
      });
      await each("selected-inspectable-object", async (page) => {
        // The DOM click reaches the control wherever the narrow layout scrolled it.
        await page.getByRole("button", { name: "Close Why" }).evaluate((button) => button.click());
        if (external) {
          await living(page)
            .getByRole("button")
            .evaluateAll((buttons, id) => {
              const button = buttons.find((button) => button.dataset.focusKey === `entity:${id}`);
              if (!button) throw new Error(`Missing object ${id}`);
              button.click();
            }, objectId);
        } else
          await living(page)
            .getByRole("button", { name: "fixture.den", exact: true })
            .evaluate((button) => button.click());
        await openRail(page);
        await expect.poll(() => rail(page).innerText()).toContain("Inspection from world evidence");
        await selected(page)
          .getByText(/^Selected entity at canonical revision /u)
          .waitFor();
      });
      // The live scene socket drops: the shell keeps the committed scene and says it is recovering.
      // After a backoff of at least 500 ms (half of SCENE_RECONNECT.firstDelayMs) it opens a new
      // socket, and that connection reports `connecting`, which drops the scene and the selection.
      // The page clock is held from before the drop until the shot, so the backoff cannot end
      // first, and the capture waits on the shell's scene status, not its text.
      const sceneStatus = (page) =>
        page.locator("#rw-observation-status").getAttribute("data-scene-status");
      await each("disconnected-recovering", async (page) => {
        // The installed clock runs from now, and pausing jumps it to a later instant; the jump runs
        // only page timers set since the install, before any drop.
        await page.clock.install();
        await page.clock.pauseAt(Date.now() + 1000);
        held.add(page);
        await page.evaluate(() => globalThis.hallSceneSocket.close());
        // The scene state reaches React through zero-delay timers (Query's notifications); they
        // run without moving the held clock.
        await expect
          .poll(async () => {
            await page.clock.runFor(0);
            return sceneStatus(page);
          })
          .toBe("degraded");
      });
      // Each shot showed the first recovery: even after every shot, each shell is still recovering
      // and its latest scene socket is the dropped one, so no reconnect has started.
      for (const page of pages)
        expect([
          await sceneStatus(page),
          await page.evaluate(() => globalThis.hallSceneSocket.readyState),
        ]).toEqual(["degraded", 3]);
      // A principal holds at most four scene sockets (SCENE_SOCKET_BOUNDS.perPrincipal), so each
      // canvas viewer hands in its measurements and closes before the text viewers open.
      const points = [];
      for (const page of pages.splice(0)) {
        points.push(...(await page.evaluate(() => globalThis.hallMeasurements.points())));
        await page.close();
      }
      // The missing atlas ends in the text scene with assets named, and the client reports the failure.
      if (!external) {
        const missing = await open(VIEWPORTS[1], false, true);
        await missing
          .getByText(/^Arrival: text scene ready at revision \d+; assets unavailable\.$/u)
          .waitFor();
        const failed = await missing.evaluate(() => globalThis.hallMeasurements.points());
        expect(
          ["asset_cache:failed", "client_errors:asset"].map((key) =>
            failed.some(({ name, category }) => `${name}:${category}` === key),
          ),
        ).toEqual([true, true]);
        points.push(...failed);
        await missing.close();
      }
      for (const viewport of VIEWPORTS) {
        const page = await open(viewport, true);
        await capture("text-access", page, async () => {
          expect(await page.locator("canvas").count()).toBe(0);
        });
        points.push(...(await page.evaluate(() => globalThis.hallMeasurements.points())));
        await page.close();
      }
      expect(captures.map(({ state, viewport }) => `${state}@${viewport.width}`)).toEqual(
        [
          "daylight-dry",
          ...TIERS.map((tier) => `dusk-rain-${tier}`),
          "dusk-rain",
          ...TIERS.map((tier) => `night-rain-${tier}`),
          "selected-actor-rail",
          "event-why-inspector",
          "selected-inspectable-object",
          "disconnected-recovering",
          "text-access",
        ].flatMap((state) => VIEWPORTS.map(({ width }) => `${state}@${width}`)),
      );

      // §17: the client recorded what this journey exercised, with opaque IDs and categories only.
      const names = new Set(points.map(({ name }) => name));
      for (const name of [
        "reducer_latency_ms",
        "scene_apply_ms",
        ...(!external || shellInput.scene.atlases ? ["asset_cache"] : []),
        "inspector_traversal",
        "accessibility_mode",
        "scene_recovery",
      ])
        expect(names.has(name), name).toBe(true);
      expect(
        new Set(
          points
            .filter(({ name }) => name === "accessibility_mode")
            .map(({ category }) => category),
        ),
      ).toEqual(new Set(["canvas", "text", "reduced_motion"]));
      for (const point of points) {
        expect(
          Object.keys(point).every((key) => MEASUREMENT_FIELDS.includes(key)),
          JSON.stringify(point),
        ).toBe(true);
        if (point.worldId !== undefined) expect(point.worldId).toBe(scope.worldId);
      }
      const serialized = JSON.stringify(points);
      for (const hidden of ["principal-runtime", "hall-inspect", actorId, "Keeper", "scripted:"])
        expect(serialized.includes(hidden), hidden).toBe(false);
      console.info(
        "Renderer tier correctness",
        JSON.stringify(
          tierComparisons.map(({ state, tier, backend, adapter, textureBytes }) => ({
            state,
            tier,
            backend,
            adapter,
            textureBytes,
          })),
        ),
      );
      const report = {
        ...(external
          ? {
              pack: world.artifact.packId,
              dayLengthMs: dayLength.toString(),
              actor: actorId,
              object: objectId,
              browserShell,
              browserAssets,
            }
          : {}),
        viewports: VIEWPORTS,
        captures,
        rendererBackends: [backend],
        tierComparisons,
        measurements: [...names].sort(),
        webVitals: vitals,
      };
      await writeFile(path.join(out, "captures.json"), `${JSON.stringify(report, null, 2)}\n`);
      if (
        backend === "webgl2" &&
        (process.env.CLOCKGROVE_WAVE4_EVIDENCE !== undefined || external)
      ) {
        const primary = JSON.parse(
          await readFile(path.join(evidenceRoot, "captures.json"), "utf8"),
        );
        primary.rendererBackends.push(backend);
        primary.tierComparisons.push(...tierComparisons);
        primary.backendCaptures = captures.map((capture) => ({
          ...capture,
          backend,
          file: `webgl2/${capture.file}`,
        }));
        await writeFile(
          path.join(evidenceRoot, "captures.json"),
          `${JSON.stringify(primary, null, 2)}\n`,
        );
      }
    } catch (error) {
      throw stopped ? new Error("Capture run stopped", { cause: error }) : error;
    } finally {
      clearInterval(watch);
      await browser?.close();
      await server.close();
    }
  });
};
it.each(BACKENDS)(
  "captures the Wave 4 golden states at each visual matrix viewport (%s)",
  captureGoldenStates,
  240_000,
);

async function withRendererProof(backend, shell, run, publicDir) {
  let server, browser;
  try {
    server = await createServer({
      root: path.join(root, "apps/web"),
      configFile: path.join(root, "apps/web/vite.config.ts"),
      publicDir,
      define: { __WORLD_SHELL__: JSON.stringify(shell) },
      server: { host: "127.0.0.1", port: 0 },
      plugins: [
        {
          name: "renderer-proof-backend",
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
    await server.listen();
    browser = await chromium.launch({ headless: true, args: GPU_FLAGS });
    await run(browser, `http://127.0.0.1:${server.httpServer.address().port}`);
  } finally {
    await browser?.close();
    await server?.close();
  }
}

async function prepareRendererProof(page, origin, shell, name, body) {
  await page.addInitScript((shell) => {
    globalThis.__WORLD_SHELL__ = shell;
    globalThis.proofFrame = () =>
      new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    globalThis.proofLoad = (module) => new Function(`return import("/src/${module}.ts")`)();
    globalThis.proofAdapter = async (wire, content) => {
      const { ThreeWorldSceneAdapter } = await proofLoad("renderer");
      let adapter;
      await new Promise((resolve, reject) => {
        adapter = new ThreeWorldSceneAdapter(
          document.querySelector("#scene"),
          resolve,
          (reason) => reject(new Error(reason)),
          () => {},
          content,
        );
      });
      adapter.setReducedMotion(true);
      adapter.loadSnapshot({
        ...wire,
        revision: BigInt(wire.revision),
        simulationTime: BigInt(wire.simulationTime),
      });
      return adapter;
    };
  }, shell);
  await page.route(`**/${name}`, (route) => route.fulfill({ contentType: "text/html", body }));
  await page.goto(`${origin}/${name}`);
}

async function rendererFixture() {
  return Promise.all(
    ["shell.json", "snapshot.json"].map(async (name) =>
      JSON.parse(await readFile(path.join(root, "worlds/fixture/renderer", name), "utf8")),
    ),
  );
}

it("draws generated material albedo at DPR 2 while retaining unsupported channels and reduced motion", async () => {
  if (isNativeWorldOwnerChild()) return;
  const { buildAtlases, encodePng, materialAtlasFiles, atlasIndex, validateSource, sha256Hex } =
    await import("../../packages/assets/src/index.ts");
  const { decodeAssetManifest, decodeAssetStyleProfile } = await import(
    "../../packages/contracts/src/index.ts"
  );
  const assets = await mkdtemp(path.join(os.tmpdir(), "clockgrove-material-renderer-"));
  const template = JSON.parse(
    await readFile(
      path.join(root, "packages/contracts/test/fixtures/asset-manifest/approved.json"),
      "utf8",
    ),
  );
  const style = JSON.parse(
    await readFile(path.join(root, "worlds/fixture/reference/asset-style.json"), "utf8"),
  );
  const policy = {
    albedo: { encoding: "linear", min: 0, max: 255, maxFrameChange: 0 },
    normal: { encoding: "linear", min: 0, max: 255, maxFrameChange: 0 },
  };
  const profile = decodeAssetStyleProfile({
    ...style,
    colour: { mode: "unrestricted" },
    material: {
      materialVersion: 1,
      roles: Object.fromEntries(
        ["actor", "object", "terrain", "effect"].map((role) => [role, policy]),
      ),
    },
  });
  const sources = {};
  const renditions = [1, 2].map((density) => ({
    density,
    channels: Object.fromEntries(
      ["albedo", "normal"].map((channel) => {
        const width = 8 * density,
          height = 4 * density,
          rgba = new Uint8Array(width * height * 4);
        for (let frame = 0; frame < 2; frame++)
          for (let y = density; y < 3 * density; y++)
            for (let x = density; x < 3 * density; x++)
              rgba.set(
                channel === "albedo" ? [128, 96, 64, 255] : [128, 128, 255, 255],
                (y * width + frame * 4 * density + x) * 4,
              );
        const source =
          density === 1 && channel === "albedo"
            ? "assets/source/material-actor/idle.png"
            : `assets/source/material-actor/idle-${density}x-${channel}.png`;
        const bytes = encodePng({ width, height, rgba });
        sources[source] = bytes;
        return [channel, { path: source, sha256: sha256Hex(bytes) }];
      }),
    ),
  }));
  const bytes = sources["assets/source/material-actor/idle.png"];
  const manifest = decodeAssetManifest({
    ...template,
    assetId: "material-actor",
    animationFamily: "idle",
    source: { ...template.source, path: "assets/source/material-actor/idle.png" },
    semantic: { ...template.semantic, role: "actor" },
    frames: { width: 4, height: 4, count: 2, durationMs: 100 },
    anchor: { x: 2, y: 3 },
    bounds: { x: 1, y: 1, width: 2, height: 2 },
    palette: ["#806040"],
    contentHash: sha256Hex(bytes),
    atlas: { atlasId: "material", x: 0, y: 0 },
    material: { materialVersion: 1, renditions },
  });
  expect(validateSource(manifest, bytes, undefined, profile, sources)).toEqual([]);
  const atlases = buildAtlases([{ manifest, bytes, materialSources: sources }], undefined, profile);
  const outputs = [
    ...materialAtlasFiles(atlases),
    ...atlases.flatMap((atlas) => [
      { name: `${atlas.atlasId}.png`, bytes: atlas.png },
      { name: `${atlas.atlasId}.animations.json`, bytes: atlas.animations },
    ]),
    { name: "atlases.json", bytes: atlasIndex(atlases) },
  ];
  for (const output of outputs) await writeFile(path.join(assets, output.name), output.bytes);
  expect(outputs.reduce((n, output) => n + Buffer.byteLength(output.bytes), 0)).toBeLessThan(
    262144,
  );
  const material = JSON.parse(atlases[0].animations).animations[0].material;
  const wire = JSON.parse(
    await readFile(
      path.join(root, "packages/contracts/test/fixtures/realtime-projection/snapshot.golden.json"),
      "utf8",
    ),
  ).payload;
  wire.entities[0].pose.coordinates = ["0", "0"];
  wire.presentationBindings = [
    {
      objectId: wire.entities[0].objectId,
      assetId: manifest.assetId,
      animationFamily: "idle",
      accessibilityLabel: "Generated actor",
      material,
    },
  ];
  wire.weather.rainIntensity = 0;
  wire.effects = [];
  const shell = JSON.parse(
    await readFile(path.join(root, "worlds/fixture/reference/shell.json"), "utf8"),
  );
  try {
    await withRendererProof(
      "webgl2",
      shell,
      async (browser, origin) => {
        const page = await browser.newPage({
          viewport: { width: 960, height: 540 },
          deviceScaleFactor: 2,
          reducedMotion: "reduce",
        });
        const requested = [];
        page.on("request", (request) => requested.push(new URL(request.url()).pathname));
        await prepareRendererProof(
          page,
          origin,
          shell,
          "material-proof",
          "<div id='scene' style='width:320px;height:200px'></div>",
        );
        const result = await page.evaluate(async (wire) => {
          const adapter = await proofAdapter(wire);
          await proofFrame();
          const animation = adapter.atlas.get("material-actor/idle");
          if (!animation) throw new Error("Missing material animation");
          const body = adapter.drawn.get(wire.entities[0].objectId).body;
          const result = {
            density: animation.density,
            image: [body.material.map.image.width, body.material.map.image.height],
            frame: [body.userData.width, body.userData.height, body.userData.frame],
            albedoDrawn: body.material.map === animation.frames[0].texture,
            colourSpace: body.material.map.colorSpace,
            normalIgnored: !body.material.normalMap,
            channels: Object.keys(
              adapter.projection.presentationBindings[0].material.renditions[1].channels,
            ),
            textureBytes: adapter.metrics.textureBytes,
            canvas: [adapter.renderer.domElement.width, adapter.renderer.domElement.height],
            entityCount: adapter.metrics.entityCount,
          };
          adapter.destroy();
          return result;
        }, wire);
        expect(result).toMatchObject({
          density: 2,
          image: [16, 8],
          frame: [4, 4, 0],
          albedoDrawn: true,
          colourSpace: "",
          normalIgnored: true,
          channels: ["albedo", "normal"],
          canvas: [640, 400],
          entityCount: 1,
        });
        expect(result.textureBytes).toBeLessThanOrEqual(16777216);
        expect(requested).toContain("/material-2x-albedo.png");
        expect(requested.some((url) => /normal|\.dds$/u.test(url))).toBe(false);
      },
      assets,
    );
  } finally {
    const { rm } = await import("node:fs/promises");
    await rm(assets, { recursive: true, force: true });
  }
}, 60_000);

it("presentation camera spans overview and half-metre close-up with picking on both backends", async () => {
  if (isNativeWorldOwnerChild()) return;
  const [shell, wire] = await rendererFixture();
  for (const backend of ["webgpu", "webgl2"]) {
    await withRendererProof(backend, shell, async (browser, origin) => {
      const page = await browser.newPage({
        viewport: { width: 800, height: 600 },
        reducedMotion: "reduce",
      });
      const pageErrors = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await prepareRendererProof(
        page,
        origin,
        shell,
        "camera-proof",
        '<div id="scene" style="width:640px;height:400px"></div>',
      );
      const result = await page.evaluate(
        async ({ wire, shell }) => {
          const { THREE } = await proofLoad("renderer-content");
          const { readWorldShell, neutralShell } = await proofLoad("shell-input");
          const legacyCamera = readWorldShell(neutralShell).scene.camera;
          const invalid = [
            ...[0, -1, NaN, Infinity, Number.MIN_VALUE, 2].map((min) => [min, 24]),
            ...[0, -1, NaN, Infinity, 0.5].map((max) => [0.1, max]),
          ].map(([minZoom, maxZoom]) => {
            try {
              readWorldShell({ ...shell, scene: { ...shell.scene, camera: { minZoom, maxZoom } } });
              return false;
            } catch {
              return true;
            }
          });
          let adapter, actualBackend, subject;
          const content = {
            version: 1,
            create({ THREE, backend, place }) {
              actualBackend = backend;
              const root = new THREE.Group();
              subject = new THREE.Mesh(
                new THREE.BoxGeometry(0.1, 0.5, 0.1).translate(0, 0.25, 0),
                new THREE.MeshStandardNodeMaterial(),
              );
              place(subject, { x: 0, y: 0 });
              root.add(subject);
              return { root, update() {} };
            },
          };
          adapter = await proofAdapter(wire, content);
          await proofFrame();
          adapter.setCamera({ x: 0, y: 0, zoom: 0 });
          const overview = adapter.camera.zoom;
          adapter.setCamera({ x: 0, y: 0, zoom: 100 });
          const closeup = adapter.camera.zoom;
          adapter.setCamera({ x: 0, y: 0, zoom: 24 });
          subject.updateMatrixWorld(true);
          const bounds = new THREE.Box3().setFromObject(subject);
          const bottom = new THREE.Vector3(0, bounds.min.y, 0).project(adapter.camera);
          const top = new THREE.Vector3(0, bounds.max.y, 0).project(adapter.camera);
          const height = (top.y - bottom.y) * 200;
          const body = adapter.drawn.get("object-fixture");
          const center = new THREE.Vector3(
            body.body.position.x,
            body.body.position.y + body.visual.height / 2,
            0,
          ).project(adapter.camera);
          const intents = [];
          adapter.onIntent((intent) => intents.push(intent));
          const rect = adapter.canvas.getBoundingClientRect();
          const pointer = {
            x: rect.left + ((center.x + 1) * rect.width) / 2,
            y: rect.top + ((1 - center.y) * rect.height) / 2,
          };
          globalThis.cameraProof = { adapter, intents, subject };
          const rotation = adapter.camera.rotation.toArray().slice(0, 3);
          return {
            invalid,
            overview,
            closeup,
            height,
            pointer,
            rotation,
            actualBackend,
            legacyCamera: legacyCamera ?? "omitted",
          };
        },
        { wire, shell },
      );
      await page.mouse.move(result.pointer.x, result.pointer.y);
      await page.mouse.wheel(0, 100);
      await page.waitForFunction(() => globalThis.cameraProof.adapter.camera.zoom === 21.6);
      const wheelZoom = await page.evaluate(() => {
        const adapter = globalThis.cameraProof.adapter;
        const value = adapter.camera.zoom;
        adapter.setCamera({ x: 0, y: 0, zoom: 24 });
        return value;
      });
      await page.mouse.click(result.pointer.x, result.pointer.y);
      const intents = await page.evaluate(() => {
        const { adapter, intents } = globalThis.cameraProof;
        return [...intents];
      });
      delete result.pointer;
      expect({ ...result, wheelZoom, intents }).toEqual({
        invalid: [true, true, true, true, true, true, true, true, true, true, true],
        overview: 0.1,
        closeup: 96,
        height: 150,
        wheelZoom: 21.6,
        intents: [{ type: "select", objectId: "object-fixture" }],
        rotation: [0, 0, 0],
        actualBackend: backend,
        legacyCamera: "omitted",
      });
      await page.setViewportSize({ width: 390, height: 844 });
      const portrait = await page.evaluate(async () => {
        const { adapter, subject } = cameraProof;
        adapter.parent.style.cssText = "width:390px;height:844px";
        await proofFrame();
        adapter.setCamera({ x: 0, y: 0, zoom: 74 });
        const { THREE } = await proofLoad("renderer-content");
        const bounds = new THREE.Box3().setFromObject(subject);
        const top = new THREE.Vector3(0, bounds.max.y, 0).project(adapter.camera);
        const bottom = new THREE.Vector3(0, bounds.min.y, 0).project(adapter.camera);
        const body = adapter.drawn.get("object-fixture");
        const center = new THREE.Vector3(
          body.body.position.x,
          body.body.position.y + body.visual.height / 2,
          0,
        ).project(adapter.camera);
        const rect = adapter.canvas.getBoundingClientRect();
        return {
          height: ((top.y - bottom.y) * rect.height) / 2,
          x: rect.left + ((center.x + 1) * rect.width) / 2,
          y: rect.top + ((1 - center.y) * rect.height) / 2,
        };
      });
      expect(portrait.height).toBeCloseTo(281.8359375, 6);
      await page.mouse.click(portrait.x, portrait.y);
      expect(await page.evaluate(() => cameraProof.intents)).toEqual([
        { type: "select", objectId: "object-fixture" },
        { type: "select", objectId: "object-fixture" },
      ]);
      await page.evaluate(() => cameraProof.adapter.destroy());
      expect(pageErrors).toEqual([]);
    });
  }
}, 120_000);

it("viewport DPR sizing stays bounded across tiers, resizes and phone profiles on both backends", async () => {
  if (isNativeWorldOwnerChild()) return;
  const [shell, wire] = await rendererFixture();
  for (const backend of ["webgpu", "webgl2"]) {
    await withRendererProof(backend, shell, async (browser, origin) => {
      for (const profile of [
        { width: 960, height: 540, dpr: 1 },
        { width: 390, height: 844, dpr: 3 },
      ]) {
        const page = await browser.newPage({
          viewport: profile,
          deviceScaleFactor: profile.dpr,
          reducedMotion: "reduce",
        });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await prepareRendererProof(
          page,
          origin,
          shell,
          "viewport-proof",
          '<style>body{margin:0}#scene{width:100vw;height:100vh}</style><div id="scene"></div>',
        );
        await page.evaluate(async (wire) => {
          const adapter = await proofAdapter(wire);
          globalThis.viewportProof = adapter;
        }, wire);
        for (const tier of TIERS) {
          const result = await page.evaluate(async (tier) => {
            const a = globalThis.viewportProof;
            a.setQuality(tier);
            await proofFrame();
            const canvas = a.canvas;
            return {
              backend: a.backend,
              tier: a.tier,
              output: [canvas.width, canvas.height],
              css: [canvas.clientWidth, canvas.clientHeight],
              scene: [a.scenePass.renderTarget.width, a.scenePass.renderTarget.height],
              bytes: a.metrics.textureBytes,
              camera: [a.camera.left, a.camera.right, a.camera.top, a.camera.bottom],
            };
          }, tier);
          const caps = { low: 512000, medium: 1000000, high: 3000000 };
          const scale = Math.min(
            profile.dpr,
            Math.sqrt(caps[tier] / (profile.width * profile.height)),
          );
          const expected = [Math.floor(profile.width * scale), Math.floor(profile.height * scale)];
          expect(result).toMatchObject({
            backend,
            tier,
            output: expected,
            css: [profile.width, profile.height],
            camera: [
              -Math.max(320, (200 * profile.width) / profile.height),
              Math.max(320, (200 * profile.width) / profile.height),
              Math.max(200, (320 * profile.height) / profile.width),
              -Math.max(200, (320 * profile.height) / profile.width),
            ],
          });
          expect(result.scene).toEqual(
            expected.map((value) => Math.floor(value * (tier === "low" ? 0.5 : 1))),
          );
          expect(result.bytes).toBeLessThanOrEqual(
            { low: 16, medium: 64, high: 192 }[tier] * 1024 * 1024,
          );
          expect(result.bytes).toBeGreaterThan(0);
        }
        const contentBudget = await page.evaluate(async (wire) => {
          viewportProof.destroy();
          const a = await proofAdapter(wire, {
            version: 1,
            create({ THREE }) {
              const texture = new THREE.DataTexture(new Uint8Array(8 * 1024 * 1024), 2048, 1024);
              return { root: new THREE.Group(), textures: [texture], update() {} };
            },
          });
          a.setQuality("low");
          await proofFrame();
          const result = {
            status: a.metrics.contentStatus,
            bytes: a.metrics.textureBytes,
            pixels: a.canvas.width * a.canvas.height,
          };
          a.setQuality("high");
          globalThis.viewportProof = a;
          return result;
        }, wire);
        expect(contentBudget.status).toBe("ready");
        expect(contentBudget.bytes).toBeLessThanOrEqual(16 * 1024 * 1024);
        expect(contentBudget.pixels).toBeLessThan(365000);
        await page.setViewportSize({ width: 800, height: 400 });
        await expect
          .poll(() =>
            page.evaluate(() => [
              viewportProof.camera.left,
              viewportProof.camera.right,
              viewportProof.camera.top,
              viewportProof.camera.bottom,
            ]),
          )
          .toEqual([-400, 400, 200, -200]);
        await page.setViewportSize({ width: 320, height: 200 });
        await expect
          .poll(() =>
            page.evaluate(() => [viewportProof.canvas.width, viewportProof.canvas.height]),
          )
          .toEqual([320 * profile.dpr, 200 * profile.dpr]);
        await page.evaluate(() => {
          const host = document.querySelector("#scene");
          host.style.height = "auto";
          host.style.width = "240px";
          host.style.padding = "20px";
        });
        await expect
          .poll(() =>
            page.evaluate(() => [
              viewportProof.canvas.clientWidth,
              viewportProof.canvas.clientHeight,
            ]),
          )
          .toEqual([240, 200]);
        await page.waitForTimeout(100);
        expect(await page.evaluate(() => document.querySelector("#scene").clientHeight)).toBe(240);
        for (const tier of TIERS) {
          const tiny = await page.evaluate(async (tier) => {
            const host = document.querySelector("#scene");
            host.style.cssText = "width:1px;height:1px;padding:0";
            viewportProof.setQuality(tier);
            await proofFrame();
            const a = viewportProof;
            return {
              output: [a.canvas.width, a.canvas.height],
              scene: [a.scenePass.renderTarget.width, a.scenePass.renderTarget.height],
              mips: a.bloom
                ? [...a.bloom._renderTargetsHorizontal, ...a.bloom._renderTargetsVertical].map(
                    (t) => [t.width, t.height],
                  )
                : [],
            };
          }, tier);
          const side = tier === "low" ? Math.max(2, profile.dpr) : tier === "medium" ? 32 : 16;
          expect(tiny.output).toEqual([side, side]);
          expect(tiny.scene).toEqual([
            Math.floor(side * (tier === "low" ? 0.5 : 1)),
            Math.floor(side * (tier === "low" ? 0.5 : 1)),
          ]);
          expect(tiny.mips).toEqual(
            tier === "low"
              ? []
              : [
                  [16, 16],
                  [8, 8],
                  [4, 4],
                  [2, 2],
                  [1, 1],
                  [16, 16],
                  [8, 8],
                  [4, 4],
                  [2, 2],
                  [1, 1],
                ],
          );
        }
        await page.evaluate(() => viewportProof.destroy());
        expect(errors).toEqual([]);
        await page.close();
      }
    });
  }
}, 120_000);
