import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import { provisionTestWorld, truthOf } from "../../apps/runtime/test/world-fixture.ts";
import {
  isNativeWorldOwnerChild,
  runNativeWorldOwnerProcess,
  withNativeWorldOwner,
} from "../../apps/runtime/test/world-owner/native-harness.ts";
import { createServer } from "../../apps/web/node_modules/vite/dist/node/index.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
process.env.CLOCKGROVE_WORLD_SHELL = path.join(
  root,
  `worlds/${process.env.CLOCKGROVE_FIXTURE_SHELL ? "fixture" : "fixture/reference"}/shell.json`,
);
const FILE = "tests/e2e/arrival-truth.journey.browser.test.mjs";

// issue 22: Wave 4 §15.2 S10 and S9, §16 F10. Arrival tells the truth about an unready world and a
// damaged atlas: a status screen instead of a blank or false scene_ready, and a refused atlas copy.
it("shows provisioning, failed and ready arrival, and refuses a hash-mismatched atlas", async () => {
  if (!isNativeWorldOwnerChild()) {
    await runNativeWorldOwnerProcess(FILE, "fixture/reference", {
      vitestConfig: "tests/ci/vitest.browser.config.ts",
      timeoutMs: 150_000,
      inheritOutput: true,
      prepare: (fixture) =>
        truthOf(fixture)(
          `UPDATE clockgrove.world_memberships SET grants=ARRAY['runtime:world-observe'] WHERE principal_id='principal-runtime';
          UPDATE clockgrove_auth.session SET token='hall-inspect' WHERE token='local-reader-session'`,
        ),
    });
    process.env.CLOCKGROVE_FIXTURE_SHELL = "1";
    try {
      await runNativeWorldOwnerProcess(FILE, "fixture", {
        vitestConfig: "tests/ci/vitest.browser.config.ts",
        timeoutMs: 150_000,
        inheritOutput: true,
        prepare: (fixture) =>
          truthOf(fixture)(
            "UPDATE clockgrove.world_memberships SET grants=ARRAY['runtime:world-observe'] WHERE principal_id='principal-runtime'",
          ),
      });
    } finally {
      delete process.env.CLOCKGROVE_FIXTURE_SHELL;
    }
    return;
  }
  if (process.env.CLOCKGROVE_FIXTURE_SHELL) return fixtureShellJourney();
  await withNativeWorldOwner(async (native) => {
    const { fixture, world } = native;
    const provisioned = await provisionTestWorld(fixture, world, "principal-runtime");
    const scope = { ...provisioned.partition.target, spaceId: provisioned.partition.route.spaceId };
    const truth = truthOf(fixture);
    const where = `tenant_id='${scope.tenantId}' AND world_id='${scope.worldId}'`;
    const lifecycle = (status) =>
      truth(`UPDATE clockgrove.worlds SET lifecycle_status='${status}' WHERE ${where}`);
    // A later birth case of the same world: the readiness read follows the most recent one.
    const birthCase = (caseId, status) =>
      truth(`INSERT INTO clockgrove_birth.provisioning_cases
        (tenant_id,case_id,request_hash,pack_id,pack_version,content_hash,status,world_id,failure)
        SELECT tenant_id,'${caseId}',request_hash,pack_id,pack_version,content_hash,'${status}',world_id,
        ${status === "failed" ? `'{"code":"journey_fault"}'::jsonb` : "NULL"}
        FROM clockgrove_birth.provisioning_cases WHERE ${where} ORDER BY updated_at DESC LIMIT 1`);
    const atlas = await readFile(
      path.join(root, "worlds/fixture/assets/reviewed/fixture-world.png"),
    );
    const manifest = JSON.parse(
      await readFile(
        path.join(root, "worlds/fixture/assets/reviewed/fixture-world.animations.json"),
        "utf8",
      ),
    );
    // The expected side is the committed manifest; one flipped byte is a corrupt copy.
    expect(manifest.image.sha256).toMatch(/^[0-9a-f]{64}$/u);
    const damaged = Buffer.from(atlas);
    damaged[damaged.length - 1] ^= 0xff;
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
      browser = await chromium.launch({ headless: true });
      const route = `/worlds/${[scope.tenantId, scope.worldId, scope.timelineId, scope.spaceId].map(encodeURIComponent).join("/")}`;
      // Opens the shared world route and signs in; `damagedCopies` atlas responses are corrupt.
      const open = async (damagedCopies) => {
        const page = await browser.newPage();
        let served = 0;
        // The directory may supply a display name independently of the scope's opaque id.
        await page.route("**/v1/runtime/world-directory", async (request) => {
          const response = await request.fetch();
          const directory = await response.json();
          if (Array.isArray(directory.entries))
            directory.entries = directory.entries.map((entry) => ({
              ...entry,
              worldLabel: "Fixture Hall",
            }));
          await request.fulfill({ response, json: directory });
        });
        await page.route(
          (url) => url.pathname === "/fixture-world.png",
          (request) =>
            served++ < damagedCopies
              ? request.fulfill({ status: 200, contentType: "image/png", body: damaged })
              : request.continue(),
        );
        await page.goto(`http://127.0.0.1:${port}${route}`);
        await page.getByLabel("Local session credential").fill("hall-inspect");
        await page.getByRole("button", { name: "Sign in", exact: true }).click();
        return page;
      };
      const screen = (page, name) => page.getByRole("region", { name, exact: true });
      const focused = (page) =>
        page.evaluate(() => document.activeElement?.querySelector("h2")?.textContent);
      const counts = async (page) => {
        const points = await page.evaluate(() => globalThis.hallMeasurements.points());
        const count = (key) =>
          points.filter(({ name, category }) => `${name}:${category}` === key).length;
        return ["asset_cache:failed", "asset_cache:loaded", "client_errors:asset"].map(count);
      };

      // S10: a world still being born shows a focused provisioning status, never a scene.
      await lifecycle("provisioning");
      const arriving = await open(0);
      await screen(arriving, "World provisioning").waitFor();
      expect(await focused(arriving)).toBe("World provisioning");
      expect(await arriving.getByText(/^Arrival: resolving world route /u).count()).toBe(1);
      // Its birth fails: the polled read turns the screen into a focused failure with Retry.
      await birthCase("case-journey-failed", "failed");
      await screen(arriving, "World provisioning failed").waitFor();
      expect(await focused(arriving)).toBe("World provisioning failed");
      expect(await arriving.getByRole("alert").textContent()).toBe(
        "Provisioning this world failed, so no scene is shown. Retry once its provisioning has been retried.",
      );
      // The birth is retried; Retry reads the provisioning state again.
      await birthCase("case-journey-retried", "seeding");
      await arriving.getByRole("button", { name: "Retry", exact: true }).click();
      await screen(arriving, "World provisioning").waitFor();
      expect(await arriving.locator("canvas").count()).toBe(0);
      // WorldReady commits: the polled read opens the hall through the ordinary arrival.
      await lifecycle("ready");
      await arriving.getByText(/^Arrival: scene ready at revision \d+\.$/u).waitFor();
      expect(await arriving.locator("canvas").count()).toBe(1);
      expect(
        await screen(arriving, "Living scene").getByRole("heading", { level: 2 }).textContent(),
      ).toBe("Fixture Hall");
      expect(await counts(arriving)).toEqual([0, 1, 0]);
      await arriving.close();

      // S9/F10: a corrupt copy is discarded and fetched again; the verified copy is drawn.
      const recovered = await open(1);
      await recovered.getByText(/^Arrival: scene ready at revision \d+\.$/u).waitFor();
      expect(await counts(recovered)).toEqual([1, 1, 0]);
      await recovered.close();
      // A re-fetched copy that is corrupt too is refused: the text scene, never the atlas.
      const refused = await open(2);
      await refused
        .getByText(/^Arrival: text scene ready at revision \d+; assets unavailable\.$/u)
        .waitFor();
      await refused
        .getByText("Canvas unavailable. The complete scene is available below.")
        .waitFor();
      expect(await counts(refused)).toEqual([2, 0, 1]);
      await refused.close();
    } finally {
      await browser?.close();
      await server.close();
    }
  });
}, 180_000);

async function fixtureShellJourney() {
  await withNativeWorldOwner(async (native) => {
    const provisioned = await provisionTestWorld(native.fixture, native.world, "principal-runtime");
    const scope = { ...provisioned.partition.target, spaceId: provisioned.partition.route.spaceId };
    const route = `/worlds/${scope.tenantId}/${scope.worldId}/${scope.timelineId}/${scope.spaceId}`;
    const server = await createServer({
      root: path.join(root, "apps/web"),
      configFile: path.join(root, "apps/web/vite.config.ts"),
      plugins: [
        {
          name: "fixture-renderer-proof",
          transform(code, id) {
            if (id.split("?")[0] !== path.join(root, "apps/web/src/renderer.ts")) return;
            return {
              code: `${code}
const presentFixture = ThreeWorldSceneAdapter.prototype.loadSnapshot;
ThreeWorldSceneAdapter.prototype.loadSnapshot = function (...args) {
  globalThis.fixtureAdapter = this;
  return presentFixture.apply(this, args);
};`,
              map: null,
            };
          },
        },
      ],
      server: {
        host: "127.0.0.1",
        port: 0,
        proxy: { "/v1": { target: await native.origin(), ws: true } },
      },
    });
    let browser;
    try {
      await server.listen();
      browser = await chromium.launch({
        headless: true,
        args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"],
      });
      const page = await browser.newPage();
      const assets = [];
      page.on("request", (request) => {
        if (/\.(png|animations\.json)$/.test(new URL(request.url()).pathname))
          assets.push(request.url());
      });
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}${route}`);
      expect(await page.title()).toBe("Fixture World");
      await page.getByRole("heading", { name: "Fixture World", exact: true }).waitFor();
      expect(
        await page
          .locator(".rw-shell")
          .evaluate((shell) => getComputedStyle(shell).getPropertyValue("--cg-v1-bg").trim()),
      ).toBe("#14181e");
      await page.getByLabel("Local session credential").fill("local-reader-session");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page.getByText(/^Arrival: scene ready at revision \d+/u).waitFor();
      expect(
        await page
          .getByLabel("Fixture world", { exact: true })
          .locator("option")
          .first()
          .textContent(),
      ).toBe("Choose a fixture world");
      const entity = page.locator('button[data-focus-key="entity:beacon.lamp"]');
      await entity.waitFor({ state: "attached" });
      await page.waitForFunction(
        () =>
          globalThis.fixtureAdapter?.metrics.firstRenderMs !== undefined &&
          globalThis.fixtureAdapter.metrics.frameMs.length > 0,
      );
      expect(await page.evaluate(() => globalThis.fixtureAdapter.metrics.entityCount)).toBe(4);
      const canvas = page.locator("canvas").first();
      const before = await canvas.screenshot();
      const point = await page.evaluate(() => {
        const adapter = globalThis.fixtureAdapter;
        const body = adapter.drawn.get("beacon.lamp").body;
        return {
          x:
            0.5 +
            ((body.position.x - adapter.camera.position.x) * adapter.camera.zoom) /
              (adapter.camera.right - adapter.camera.left),
          y:
            0.5 -
            ((body.position.y - adapter.camera.position.y) * adapter.camera.zoom) /
              (adapter.camera.top - adapter.camera.bottom),
        };
      });
      const bounds = await canvas.boundingBox();
      await canvas.click({
        position: { x: point.x * bounds.width, y: point.y * bounds.height },
      });
      expect(await entity.getAttribute("aria-pressed")).toBe("true");
      expect(await canvas.screenshot()).not.toEqual(before);
      expect(assets).toEqual([]);
    } finally {
      await browser?.close();
      await server.close();
    }
  });
}
