import { createHash } from "node:crypto";
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
import { decodeLivingScene } from "../../packages/contracts/src/index.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
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
const HOUR_MS = 3_600_000n;
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
  if (!isNativeWorldOwnerChild()) {
    const previous = process.env.CLOCKGROVE_RENDERER_PROOF;
    process.env.CLOCKGROVE_RENDERER_PROOF = backend;
    try {
      await runNativeWorldOwnerProcess(FILE, "fixture/reference", {
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
    const advanceTo = async (key, hour, minute = 0n) => {
      const now = BigInt((await scene()).simulationTime);
      const day = now - (now % (24n * HOUR_MS));
      const target = day + hour * HOUR_MS + minute * 60_000n;
      if (target > now)
        await commit({
          ...advanceCommand(world, key, target, await revision(), {
            maxInputs: 1024,
            maxEvents: 4096,
          }),
        });
    };
    const evidenceRoot =
      process.env.CLOCKGROVE_WAVE4_EVIDENCE === undefined
        ? await mkdtemp(path.join(os.tmpdir(), "clockgrove-wave4-visual-"))
        : path.join(process.env.CLOCKGROVE_WAVE4_EVIDENCE, "visual");
    const out = backend === "webgpu" ? evidenceRoot : path.join(evidenceRoot, "webgl2");
    await mkdir(out, { recursive: true });
    process.env.CLOCKGROVE_WORLD_SHELL = path.join(root, "worlds/fixture/reference/shell.json");
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
    try {
      await server.listen();
      const { port } = server.httpServer.address();
      browser = await chromium.launch({ headless: true, args: GPU_FLAGS });
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
      const pages = [];
      for (const viewport of VIEWPORTS) pages.push(await open(viewport, false));
      const captures = [];
      const capture = async (state, page, check) => {
        // A check may name the region its state is about; the capture frames it, else the page top.
        const region = await check(page);
        // The HUD clock and the feed come from the world-status read, which follows the committed
        // revision on its own interval: the capture waits until that read has caught up.
        if ((await clock(page).count()) > 0)
          await expect.poll(() => clock(page).getAttribute("aria-busy")).toBe("false");
        if (region) await region.evaluate((element) => element.scrollIntoView({ block: "start" }));
        // Two animation frames let the canvas present the committed state before the capture. The
        // window scrolls the narrow layout and the scene column scrolls the desktop frame.
        await page.evaluate(
          (framed) =>
            new Promise((resolve) => {
              if (!framed)
                for (const scroller of [
                  document.scrollingElement,
                  ...document.querySelectorAll(".rw-main"),
                ])
                  scroller.scrollTo(0, 0);
              requestAnimationFrame(() => requestAnimationFrame(resolve));
            }),
          region !== undefined,
        );
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
        const bytes = await page.screenshot({ animations: "disabled", caret: "hide" });
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

      await advanceTo("visual-daylight", 12n);
      const daylight = await scene();
      await each("daylight-dry", async (page) => {
        await living(page)
          .getByText(`Canonical revision: ${daylight.revision}`, { exact: true })
          .waitFor();
        await living(page).getByText("Rain intensity: 0", { exact: true }).waitFor();
        await clock(page)
          .getByText(/^Day \d+, 12:00$/u)
          .waitFor();
      });

      const tierComparisons = [];
      const captureTiers = async (state, hour, minute = 0n) => {
        await advanceTo(`visual-${state}-tiers`, hour, minute);
        const committed = await scene();
        const time = `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`;
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
                    (sprite.position.x - animation.anchor.x - camera.position.x) * camera.zoom +
                      image.width / 2,
                  );
                  const top = Math.round(
                    (-sprite.position.y - animation.anchor.y + camera.position.y) * camera.zoom +
                      image.height / 2,
                  );
                  let warmPixels = 0;
                  for (
                    let y = Math.max(0, top);
                    y < Math.min(image.height, top + frame.height * camera.zoom);
                    y++
                  )
                    for (
                      let x = Math.max(0, left);
                      x < Math.min(image.width, left + frame.width * camera.zoom);
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
                ].every((mesh) => mesh.material.map === adapter.atlasTexture),
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
            expect(pixels.textureBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
            expect(pixels.canvasSize).toEqual([640, 400]);
            expect(pixels.renderSize).toEqual(tier === "low" ? [320, 200] : [640, 400]);
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
      await advanceTo("visual-dusk", 19n);
      const dusk = await scene();
      await each("dusk-rain", async (page) => {
        await living(page)
          .getByText(`Canonical revision: ${dusk.revision}`, { exact: true })
          .waitFor();
        await living(page).getByText("Rain intensity: 9000", { exact: true }).waitFor();
        await clock(page)
          .getByText(/^Day \d+, 19:00$/u)
          .waitFor();
      });

      await captureTiers("night", 22n);
      for (const night of tierComparisons.filter(({ state }) => state === "night")) {
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
        await living(page).getByRole("button", { name: "fixture.keeper", exact: true }).click();
        await openRail(page);
        await expect.poll(() => rail(page).innerText()).toContain("Deterministic/reactive object");
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
                size(adapter.scenePass.renderTarget),
                size(adapter.labelPass.renderTarget),
                labels.some((label) => label.layers.test(adapter.camera.layers)),
                labels.every((label) => !adapter.scenePass._layers.test(label.layers)),
                labels.every((label) => adapter.labelPass._layers.test(label.layers)),
              ];
            }),
          )
          .toEqual(["low", 2, [320, 200], [640, 400], true, true, true]);
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
        await living(page)
          .getByRole("button", { name: "fixture.den", exact: true })
          .evaluate((button) => button.click());
        await openRail(page);
        await expect.poll(() => rail(page).innerText()).toContain("Inspection from world evidence");
        await selected(page)
          .getByText(/^Selected entity at canonical revision /u)
          .waitFor();
      });
      await each("disconnected-recovering", async (page) => {
        // Every new scene socket is refused, then the live one drops: the shell keeps the committed
        // scene and says it is recovering.
        await page.routeWebSocket(/\/v1\/projection/u, (socket) => socket.close());
        await page.evaluate(() => globalThis.hallSceneSocket.close());
        await page.getByText("Observation: degraded. Recovering committed scene.").waitFor();
      });
      // A principal holds at most four scene sockets (SCENE_SOCKET_BOUNDS.perPrincipal), so each
      // canvas viewer hands in its measurements and closes before the text viewers open.
      const points = [];
      for (const page of pages.splice(0)) {
        points.push(...(await page.evaluate(() => globalThis.hallMeasurements.points())));
        await page.close();
      }
      // The missing atlas ends in the text scene with assets named, and the client reports the failure.
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
        "asset_cache",
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
      for (const hidden of [
        "principal-runtime",
        "hall-inspect",
        "fixture.keeper",
        "Keeper",
        "scripted:",
      ])
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
        viewports: VIEWPORTS,
        captures,
        rendererBackends: [backend],
        tierComparisons,
        measurements: [...names].sort(),
        webVitals: vitals,
      };
      await writeFile(path.join(out, "captures.json"), `${JSON.stringify(report, null, 2)}\n`);
      if (backend === "webgl2" && process.env.CLOCKGROVE_WAVE4_EVIDENCE !== undefined) {
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
    } finally {
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
