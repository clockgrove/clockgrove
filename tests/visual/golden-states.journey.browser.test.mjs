import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
it("captures the Wave 4 golden states at each visual matrix viewport", async () => {
  if (!isNativeWorldOwnerChild()) {
    await runNativeWorldOwnerProcess(FILE, "raccoons", {
      vitestConfig: "tests/ci/vitest.browser.config.ts",
      timeoutMs: 210_000,
      inheritOutput: true,
      prepare: (fixture) =>
        truthOf(fixture)(
          `UPDATE clockgrove.world_memberships SET grants=ARRAY['runtime:world-observe','runtime:world-inspect','runtime:world-command'] WHERE principal_id='principal-runtime';
          UPDATE clockgrove_auth.session SET token='yard-inspect' WHERE token='local-reader-session'`,
        ),
    });
    return;
  }
  await withNativeWorldOwner(async (native) => {
    const { fixture, world } = native;
    const provisioned = await provisionTestWorld(fixture, world, "principal-runtime");
    const scope = { ...provisioned.partition.target, spaceId: provisioned.partition.route.spaceId };
    const truth = truthOf(fixture);
    const revision = async () =>
      BigInt(
        await truth(
          `SELECT revision FROM clockgrove.partition_states WHERE partition_id = '${provisioned.partition.route.partitionId}'`,
        ),
      );
    const scene = async () =>
      decodeLivingScene(
        (await native.request("/v1/runtime/scene", { version: 1, ...scope }, "yard-inspect")).body,
      );
    const commit = async (command) => {
      const { status, body } = await native.submit(command, {}, "yard-inspect");
      expect(status, JSON.stringify(body)).toBe(200);
    };
    const advanceTo = async (key, hour) => {
      const now = BigInt((await scene()).simulationTime);
      const day = now - (now % (24n * HOUR_MS));
      const target = day + hour * HOUR_MS;
      if (target > now)
        await commit({
          ...advanceCommand(world, key, target, await revision(), {
            maxInputs: 1024,
            maxEvents: 4096,
          }),
        });
    };
    const out =
      process.env.CLOCKGROVE_WAVE4_EVIDENCE === undefined
        ? await mkdtemp(path.join(os.tmpdir(), "clockgrove-wave4-visual-"))
        : path.join(process.env.CLOCKGROVE_WAVE4_EVIDENCE, "visual");
    await mkdir(out, { recursive: true });
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
            if (id.split("?")[0] === path.join(root, "apps/web/src/measurements.ts"))
              return {
                code: `${code}\nglobalThis.yardMeasurements = clientMeasurements;`,
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
      browser = await chromium.launch({ headless: true });
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
                globalThis.yardSceneSocket = this;
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
            (url) => url.pathname === "/raccoon-world.png",
            (route) => route.fulfill({ status: 404 }),
          );
        await page.goto(`http://127.0.0.1:${port}/`);
        await page.getByLabel("Local session credential").fill("yard-inspect");
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
        if (region) await region.evaluate((element) => element.scrollIntoView({ block: "start" }));
        // Two animation frames let the canvas present the committed state before the capture.
        await page.evaluate(
          (framed) =>
            new Promise((resolve) => {
              if (!framed) window.scrollTo(0, 0);
              requestAnimationFrame(() => requestAnimationFrame(resolve));
            }),
          region !== undefined,
        );
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

      await advanceTo("visual-dusk", 19n);
      await commit({
        ...advanceCommand(world, "visual-rain", 0n, await revision()),
        type: "world.weather.set",
        payload: { schemaVersion: 2, rainIntensity: 9000 },
      });
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

      // green-lake-yard has no cognitive actor before Wave 5: Stevie, an actor, discloses reactive.
      await each("selected-actor-rail", async (page) => {
        await living(page).getByRole("button", { name: "grove.stevie", exact: true }).click();
        await openRail(page);
        await expect.poll(() => rail(page).innerText()).toContain("Deterministic/reactive object");
        await selected(page)
          .getByText(/^Selected entity at canonical revision /u)
          .waitFor();
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
          .getByRole("button", { name: "grove.den", exact: true })
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
        await page.evaluate(() => globalThis.yardSceneSocket.close());
        await page.getByText("Observation: degraded. Recovering committed scene.").waitFor();
      });
      // A principal holds at most four scene sockets (SCENE_SOCKET_BOUNDS.perPrincipal), so each
      // canvas viewer hands in its measurements and closes before the text viewers open.
      const points = [];
      for (const page of pages.splice(0)) {
        points.push(...(await page.evaluate(() => globalThis.yardMeasurements.points())));
        await page.close();
      }
      // The missing atlas ends in the text scene with assets named, and the client reports the failure.
      const missing = await open(VIEWPORTS[1], false, true);
      await missing
        .getByText(/^Arrival: text scene ready at revision \d+; assets unavailable\.$/u)
        .waitFor();
      const failed = await missing.evaluate(() => globalThis.yardMeasurements.points());
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
        points.push(...(await page.evaluate(() => globalThis.yardMeasurements.points())));
        await page.close();
      }
      expect(captures.map(({ state, viewport }) => `${state}@${viewport.width}`)).toEqual(
        [
          "daylight-dry",
          "dusk-rain",
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
        "yard-inspect",
        "grove.stevie",
        "Stevie",
        "scripted:",
      ])
        expect(serialized.includes(hidden), hidden).toBe(false);
      await writeFile(
        path.join(out, "captures.json"),
        `${JSON.stringify({ viewports: VIEWPORTS, captures, measurements: [...names].sort(), webVitals: vitals }, null, 2)}\n`,
      );
    } finally {
      await browser?.close();
      await server.close();
    }
  });
}, 240_000);
