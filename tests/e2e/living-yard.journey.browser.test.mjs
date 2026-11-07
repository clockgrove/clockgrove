import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import { PostgreSqlCausalInspector } from "../../apps/runtime/src/inspector.ts";
import {
  PostgreSqlEntitySelectionReader,
  PostgreSqlLivingSceneReader,
  PostgreSqlViewedSpaceReader,
  PostgreSqlWorldStatusReader,
  readWorldDirectory,
  readWorldReadiness,
} from "../../apps/runtime/src/observation.ts";
import { RuntimeWorker } from "../../apps/runtime/src/worker.ts";
import { PostgreSqlCommandOwner } from "../../apps/runtime/src/world-commands.ts";
import { livingYardAuthentication } from "../../apps/runtime/test/living-yard-fixture.ts";
import {
  advanceCommand,
  commandRequest,
  provisionTestWorld,
  testWorld,
  truthOf,
  withClient,
} from "../../apps/runtime/test/world-fixture.ts";
import {
  isNativeWorldOwnerChild,
  runNativeWorldOwnerProcess,
  withNativeWorldOwner,
} from "../../apps/runtime/test/world-owner/native-harness.ts";
import { createServer } from "../../apps/web/node_modules/vite/dist/node/index.js";
import { decodeCanonicalNode, executeWorldCommand } from "../../packages/application/src/index.ts";
import {
  decodeEntitySelection,
  decodeLivingScene,
  decodeRecordedWhy,
  decodeWorldBootState,
  decodeWorldDirectory,
  SCENE_CREDENTIAL_PREFIX,
  SCENE_PROTOCOL,
} from "../../packages/contracts/src/index.ts";
import { executeWorldKernel } from "../../packages/kernel/src/index.ts";
import {
  PostgreSqlWorldCommandJournal,
  PostgreSqlWorldOwnerReader,
} from "../../packages/persistence/src/index.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(import.meta.url);
function createWorkerServer(worker, nativeOrigin) {
  return createServer({
    root: path.join(root, "apps/web"),
    configFile: path.join(root, "apps/web/vite.config.ts"),
    server: {
      host: "127.0.0.1",
      port: 0,
      proxy: { "/v1/projection": { target: nativeOrigin, ws: true } },
    },
    plugins: [
      {
        name: "local-worker-http-surface",
        transform(code, id) {
          if (id.split("?")[0] === path.join(root, "apps/web/src/yard-api.ts"))
            return {
              code: `${code}
const replaceYard = YardSession.prototype.replace;
YardSession.prototype.replace = function (...args) {
  if (globalThis.yardSession !== this) {
    globalThis.yardTransitions = [];
    this.queries.getQueryCache().subscribe(({ type, query }) => {
      if (query.state.error) globalThis.yardQueryError = query.state.error.message;
      if (type === "updated" && query.queryKey[1] === "projection" && query.state.data)
        globalThis.yardTransitions.push([query.state.data.status, query.state.data.scene?.revision ?? null]);
    });
  }
  globalThis.yardSession = this;
  return replaceYard.apply(this, args);
};`,
              map: null,
            };
          // Records each boot value in wire form with the presented revision and open scene sockets.
          if (id.split("?")[0] === path.join(root, "apps/web/src/yard-state.ts"))
            return {
              code: `${code}
const yardSockets = [];
// While a step names a version field in yardSkew, each received snapshot carries version 3.
globalThis.yardSkewed = (data) => {
  const message = JSON.parse(data);
  if (message.type !== "snapshot") return data;
  (globalThis.yardSkew === "protocolVersion" ? message : message.payload.compatibility)[globalThis.yardSkew] = 3;
  return JSON.stringify(message);
};
globalThis.WebSocket = class extends globalThis.WebSocket {
  constructor(...args) {
    super(...args);
    yardSockets.push(this);
  }
  addEventListener(type, listener, options) {
    super.addEventListener(
      type,
      type === "message"
        ? (event) => listener(globalThis.yardSkew ? { data: globalThis.yardSkewed(event.data) } : event)
        : listener,
      options,
    );
  }
};
globalThis.yardBoots = [];
useWorldBoot.subscribe(({ boot }) => globalThis.yardBoots.push([
  JSON.parse(JSON.stringify(boot, (_, value) => (typeof value === "bigint" ? String(value) : value))),
  globalThis.yardPresentedRevision ?? null,
  yardSockets.filter((socket) => new URL(socket.url).pathname === "/v1/projection" && socket.readyState !== WebSocket.CLOSED).length,
]));`,
              map: null,
            };
          // §17: the bounded client measurement ring, read to assert the points this journey drives.
          if (id.split("?")[0] === path.join(root, "apps/web/src/measurements.ts"))
            return {
              code: `${code}\nglobalThis.yardMeasurements = clientMeasurements;`,
              map: null,
            };
          // §16: while yardThrowRender is set, the yard's entity list throws as it renders.
          if (id.split("?")[0] === path.join(root, "apps/web/src/text-scene.tsx"))
            return {
              code: `${code}
const renderEntities = TextSceneEntities;
TextSceneEntities = (props) => {
  if (globalThis.yardThrowRender) throw new Error("injected yard component fault");
  return renderEntities(props);
};`,
              map: null,
            };
          if (id.split("?")[0] !== path.join(root, "apps/web/src/renderer.ts")) return;
          return {
            code: `${code}
const { loadSnapshot: originalPresent, draw: originalDraw } = PhaserWorldSceneAdapter.prototype;
PhaserWorldSceneAdapter.prototype.draw = function (...args) {
  originalDraw.apply(this, args);
  if (this.stage && this.projection) globalThis.yardDrawnRevision = String(this.projection.revision);
};
globalThis.yardRendererHookRegistered = true;
globalThis.yardRendererPresentInvoked = false;
PhaserWorldSceneAdapter.prototype.loadSnapshot = function (...args) {
  globalThis.yardRendererPresentInvoked = true;
  globalThis.yardGame = this.game;
  globalThis.yardAdapter = this;
  if (globalThis.yardFailPresent) throw new Error("presentation assets unavailable");
  originalPresent.apply(this, args);
  globalThis.yardPresentedRevision = String(args[0].revision);
};
`,
            map: null,
          };
        },
        configureServer(vite) {
          for (const endpoint of [
            "/v1/runtime/scene",
            "/v1/runtime/entity",
            "/v1/runtime/why",
            "/v1/runtime/world-directory",
            "/v1/runtime/world-readiness",
            "/v1/runtime/viewed-space",
            "/v1/runtime/world-status",
          ])
            vite.middlewares.use(endpoint, async (request, response, next) => {
              try {
                const chunks = [];
                for await (const chunk of request) chunks.push(chunk);
                const result = await worker.fetch(
                  new Request(new URL(endpoint, "http://local.test"), {
                    method: request.method,
                    headers: request.headers,
                    body: Buffer.concat(chunks),
                  }),
                );
                response.writeHead(result.status, Object.fromEntries(result.headers));
                response.end(await result.text());
              } catch (error) {
                next(error);
              }
            });
        },
      },
    ],
  });
}

// The scene's isometric geometry by the test's own formula (apps/web/docs/scene.md): metres from
// fixed-point poses, 2:1 at 12.5 px per metre, camera centred on the projected entities.
const metresPerUnit = { meter: 1, metre: 1, millimeter: 0.001, millimetre: 0.001 };
function grounded(scene) {
  return scene.entities.flatMap((entity) => {
    const frame = scene.frames.find((candidate) => candidate.frameId === entity.pose.frameId);
    if (frame?.version !== entity.pose.frameVersion) return [];
    const [x, y, z = 0] = entity.pose.coordinates.map(
      (value) =>
        (Number(value) / 10 ** frame.unit.fractionalDigits) * (metresPerUnit[frame.unit.name] ?? 1),
    );
    return [{ entity, x, y, z: frame.dimensions === 3 ? z : 0 }];
  });
}
function isoPoint(scene, objectId) {
  const at = grounded(scene).find(({ entity }) => entity.objectId === objectId);
  if (!at) throw new Error(`missing ${objectId}`);
  return { x: (at.x + at.y) * 12.5, y: (at.x - at.y) * 6.25 - at.z * 12.5 };
}
function isoCentre(scene) {
  const points = grounded(scene).map(({ entity }) => isoPoint(scene, entity.objectId));
  const middle = (values) => (Math.min(...values) + Math.max(...values)) / 2;
  return [middle(points.map(({ x }) => x)), middle(points.map(({ y }) => y))];
}
// issue 21: the golden's puddle sites (packages/assets/src/scene.ts), by the test's own reading of
// the pack's path graph: one per edge, at its integer midpoint, in isometric world pixels.
async function puddleSites() {
  const { anchorGraph } = JSON.parse(
    await readFile(path.join(root, "worlds/raccoons/resources/spaces/neighborhood.json"), "utf8"),
  );
  const at = new Map(
    anchorGraph.anchors.map(({ anchorId, coordinates }) => [
      anchorId,
      coordinates.map(({ $bigint }) => Number($bigint)),
    ]),
  );
  return anchorGraph.edges
    .map(({ from, to }) => {
      const [x, y] = at.get(from).map((value, axis) => Math.floor((value + at.get(to)[axis]) / 2));
      return [(x + y) / 80, (x - y) / 160];
    })
    .sort(([a, b], [c, d]) => a - c || b - d);
}
// Each drawn effect's role, place and whether it shows and animates.
const effectState = (viewer) =>
  viewer.evaluate(() =>
    globalThis.yardAdapter.effects.map(({ role, sprite }) => ({
      role,
      at: [sprite.x, sprite.y],
      shown: sprite.visible && sprite.alpha === 1,
      playing: sprite.anims.isPlaying,
    })),
  );
const shownRoles = async (viewer) =>
  [...new Set((await effectState(viewer)).filter(({ shown }) => shown).map(({ role }) => role))]
    .sort()
    .join();
// issue 20: each raccoon's drawn atlas strip (`assetId/animationFamily`), beside its committed
// routine and movement read from PostgreSQL.
async function raccoonActivity(viewer, environment, authorization, scope) {
  const drawn = await viewer.evaluate(() =>
    Object.fromEntries([...globalThis.yardAdapter.drawn].map(([id, { key }]) => [id, key])),
  );
  const { document } = await withClient(environment, (client) =>
    new PostgreSqlCommandOwner(client).reader.hydrate(authorization, scope),
  );
  return ["grove.gracie", "grove.kit", "grove.stevie"].map((objectId) => {
    const entity = document.state.entities.find((candidate) => candidate.objectId === objectId);
    return [
      drawn[objectId],
      entity?.selectedAction?.kind ?? null,
      entity?.movement?.status ?? null,
    ];
  });
}
/** Nearest the south-east viewer first, then elevation, then object id; unplaced entities last. */
function pickOrdered(scene) {
  const placed = grounded(scene)
    .sort(
      (a, b) =>
        b.x - b.y - (a.x - a.y) || b.z - a.z || (a.entity.objectId < b.entity.objectId ? -1 : 1),
    )
    .map(({ entity }) => entity);
  return [...placed, ...scene.entities.filter((entity) => !placed.includes(entity))];
}

it("observes native authorized socket updates and recovery in Chromium", async () => {
  if (!isNativeWorldOwnerChild()) {
    await runNativeWorldOwnerProcess("tests/e2e/living-yard.journey.browser.test.mjs", "raccoons", {
      vitestConfig: "tests/ci/vitest.browser.config.ts",
      // The journey measured 106 s against the former 120 s deadline; with issue 816's navigation
      // scenario it measured 140 s alone on the Factory host (2026-11-05), so 210 s keeps the same
      // margin and stays within the test's 240 s timeout.
      timeoutMs: 210_000,
      inheritOutput: true,
      prepare: async (fixture) => {
        await truthOf(fixture)(
          `INSERT INTO clockgrove.tenant_principals (tenant_id,principal_id) SELECT DISTINCT tenant_id,'principal-outsider' FROM clockgrove.world_memberships;
          INSERT INTO clockgrove.world_memberships
          (tenant_id,world_id,timeline_id,space_id,principal_id,membership_id,persona_id,roles,grants,privacy_ceiling,committed_at)
          SELECT tenant_id,world_id,timeline_id,space_id,'principal-outsider','membership-browser-operator','persona-browser-operator',roles,
          ARRAY['runtime:world-command','runtime:world-clock'],privacy_ceiling,committed_at FROM clockgrove.world_memberships;
          UPDATE clockgrove.world_memberships SET grants=ARRAY['runtime:world-observe'] WHERE principal_id='principal-runtime';
          UPDATE clockgrove_auth.session SET token='yard-inspect' WHERE token='local-reader-session'`,
        );
      },
    });
    return;
  }
  await withNativeWorldOwner(async (native) => {
    const { fixture, world } = native;
    const provisioned = await provisionTestWorld(fixture, world, "principal-runtime");
    const auth = livingYardAuthentication(provisioned);
    const attachments = async (scope) =>
      (
        await native.request(
          `/scene/attachments?${new URLSearchParams(scope)}`,
          null,
          "yard-inspect",
        )
      ).body;
    expect(
      (
        await native.request(
          "/autonomous/configure",
          { scope: auth.scope, wallTime: "0", commandLimit: 4, enabled: false, schedule: false },
          "outsider-session-token",
        )
      ).status,
    ).toBe(200);
    const commit = async (command) => {
      const { status, body } = await native.submit(command, {}, "outsider-session-token");
      expect(status, JSON.stringify(body)).toBe(200);
    };
    const truth = truthOf(fixture);
    const membershipGrants =
      "SELECT array_to_json(ARRAY(SELECT unnest(grants) ORDER BY 1))::text FROM clockgrove.world_memberships WHERE principal_id='principal-runtime'";
    expect(JSON.parse(await truth(membershipGrants))).toEqual(["runtime:world-observe"]);
    const partitionId = provisioned.partition.route.partitionId;
    const durable = () =>
      truth(
        `SELECT revision || '|' || simulation_time FROM clockgrove.partition_states WHERE partition_id = '${partitionId}'`,
      );
    const commands = () => truth("SELECT count(*) FROM clockgrove.command_receipts");
    const before = await durable();
    await withClient(fixture.environment, async (client) => {
      const bindings = {
        inspector: {
          recordedWhy: (...args) =>
            withClient(fixture.environment, (requestClient) =>
              new PostgreSqlCausalInspector(requestClient).recordedWhy(...args),
            ),
          deny: (input, principalId, denial) =>
            withClient(fixture.environment, (requestClient) =>
              new PostgreSqlCausalInspector(requestClient).deny(input, principalId, denial),
            ),
        },
        getSpace: () => {
          throw new Error("observation must not create a command owner");
        },
        changeViewedSpace: (request, authorize) =>
          withClient(fixture.environment, (requestClient) =>
            new PostgreSqlViewedSpaceReader(requestClient).change(request, authorize),
          ),
        worldDirectory: (principalId) =>
          withClient(
            fixture.environment,
            (requestClient) => readWorldDirectory(requestClient, principalId),
            "clockgrove",
            "clockgrove_world_reader",
          ),
        worldReadiness: (principalId, scope) =>
          withClient(
            fixture.environment,
            (requestClient) => readWorldReadiness(requestClient, principalId, scope),
            "clockgrove",
            "clockgrove_world_reader",
          ),
        observation: {
          observe: (scope, context) =>
            withClient(fixture.environment, (requestClient) =>
              new PostgreSqlLivingSceneReader(
                new PostgreSqlWorldOwnerReader(requestClient),
              ).observe(scope, context),
            ),
          select: (input, context) =>
            withClient(fixture.environment, (requestClient) =>
              new PostgreSqlEntitySelectionReader(requestClient).select(input, context, 100n),
            ),
          status: (scope, context) =>
            withClient(fixture.environment, (requestClient) =>
              new PostgreSqlWorldStatusReader(requestClient).read(scope, context),
            ),
        },
      };
      const observerTelemetry = [];
      const observerLogger = { log: (record) => observerTelemetry.push(record) };
      let worker = new RuntimeWorker(auth.authenticator, bindings, observerLogger);
      const resume = {
        ...advanceCommand(world, "browser-clock-resume", 0n, null),
        type: "ResumeWorld",
        payload: { schemaVersion: 1 },
      };
      expect(
        (
          await executeWorldCommand(
            { ...commandRequest(provisioned, resume), trustedWallTime: () => 0n },
            {
              journal: new PostgreSqlWorldCommandJournal(client),
              behavior: provisioned.behavior,
            },
          )
        ).outcome,
      ).toBe("committed");
      let beforeCommands = await commands();
      let sceneRequests = 0;
      const server = await createWorkerServer(
        {
          fetch(request) {
            if (new URL(request.url).pathname === "/v1/runtime/scene") sceneRequests += 1;
            return worker.fetch(request);
          },
        },
        await native.origin(),
      );
      let browser;
      try {
        await server.listen();
        const address = server.httpServer.address();
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage();
        page.on("console", (message) => observerTelemetry.push(message.text()));
        page.on("pageerror", (error) => observerTelemetry.push(error.message));
        const publicState = () =>
          page.evaluate(() => {
            const session = globalThis.yardSession;
            const selection = session.getSelectionSnapshot();
            const why = session.getWhySnapshot();
            return [
              session.queries.getQueryData(["living-yard", "projection"])?.scene,
              selection.objectId,
              selection.value,
              why.commandId,
              why.value,
            ];
          });
        const emptyDetails = [undefined, undefined, undefined, undefined];
        await page.addInitScript(() => {
          globalThis.WebSocket = class extends WebSocket {
            constructor(...args) {
              super(...args);
              globalThis.yardCurrentSocket = this;
            }
          };
        });
        // Turning Chromium interception on races the next request, which then bypasses the
        // route and its request event; this route keeps it on so later routes only swap handlers.
        await page.route("**/v1/runtime/**", (route) => route.continue());
        let navigations = 0;
        page.on("framenavigated", (frame) => {
          if (frame === page.mainFrame()) navigations += 1;
        });
        const origin = `http://127.0.0.1:${address.port}`;
        const routeOf = (scope) =>
          `/worlds/${scope.tenantId}/${scope.worldId}/${scope.timelineId}/${scope.spaceId}`;
        // Each boot value the shell held since the last call, decoded by the contract.
        const bootsOf = async (target) =>
          (await target.evaluate(() => globalThis.yardBoots.splice(0))).map(
            ([value, presented, openSockets]) => {
              const boot = decodeWorldBootState(value);
              return [
                boot.state,
                boot.route ?? routeOf(boot.scope),
                boot.projectionRevision?.toString() ?? null,
                boot.reason ?? null,
                presented,
                openSockets,
              ];
            },
          );
        // Expected order is the literal milestone list of wave plan §6.5; joining_space follows
        // retirement of every earlier scene socket.
        const progression = (where, revision, openBefore, ending) => [
          ["route_resolving", where, null, null, null, openBefore],
          ["identity_resolved", where, null, null, null, openBefore],
          ["membership_authorized", where, null, null, null, openBefore],
          ["joining_space", where, null, null, null, 0],
          ["snapshot_ready", where, revision, null, null, 1],
          ...ending,
        ];
        // Expected selector labels come from PostgreSQL memberships, in byte order.
        const observableLabels = async () => [
          "Choose a world",
          ...(
            await truth(`SELECT string_agg(world_id || ' / ' || space_id, '|' ORDER BY tenant_id COLLATE "C",
            world_id COLLATE "C", timeline_id COLLATE "C", space_id COLLATE "C") FROM clockgrove.world_memberships
            WHERE principal_id='principal-runtime' AND revoked_at IS NULL AND 'runtime:world-observe'=ANY(grants)`)
          ).split("|"),
        ];
        const arrival = await browser.newPage();
        let arrivalSockets = 0;
        arrival.on("websocket", (socket) => {
          if (new URL(socket.url()).pathname === "/v1/projection") arrivalSockets += 1;
        });
        const absentRoute = routeOf({ ...auth.scope, worldId: "world-absent" });
        await arrival.goto(`${origin}${absentRoute}`);
        await arrival.getByRole("heading", { name: "Raccoon World", level: 1 }).waitFor();
        expect(await arrival.title()).toBe("Raccoon World");
        await arrival.addScriptTag({
          content: await readFile(require.resolve("axe-core/axe.min.js"), "utf8"),
        });
        expect((await arrival.evaluate(() => globalThis.axe.run())).violations).toEqual([]);
        const directoryResponse = (status) =>
          arrival.waitForResponse(
            (response) =>
              response.url() === `${origin}/v1/runtime/world-directory` &&
              response.status() === status,
          );
        const refusedSignIn = directoryResponse(401);
        await arrival.getByLabel("Local session credential").fill("invalid");
        await arrival.getByRole("button", { name: "Sign in", exact: true }).click();
        expect(await (await refusedSignIn).json()).toEqual({ error: "authentication_refused" });
        await arrival.getByRole("alert").getByText("Sign-in refused.", { exact: true }).waitFor();
        expect(await arrival.getByLabel("World", { exact: true }).count()).toBe(0);
        const listed = directoryResponse(200);
        await arrival.getByLabel("Local session credential").fill("yard-inspect");
        await arrival.getByRole("button", { name: "Sign in", exact: true }).click();
        const directory = decodeWorldDirectory(await (await listed).json());
        expect((await listed).request().headers().authorization).toBe("Bearer yard-inspect");
        expect(JSON.parse((await listed).request().postData())).toEqual({ version: 1 });
        await arrival
          .getByRole("alert")
          .getByText("World not available.", { exact: true })
          .waitFor();
        const observable = await observableLabels();
        expect([
          "Choose a world",
          ...directory.entries.map((entry) => `${entry.worldLabel} / ${entry.spaceLabel}`),
        ]).toEqual(observable);
        expect(
          await arrival.getByLabel("World", { exact: true }).locator("option").allTextContents(),
        ).toEqual(observable);
        // The credential reaches no URL, cookie or web storage; an unlisted route opens no scene.
        expect([
          arrival.url(),
          await arrival.context().cookies(),
          await arrival.evaluate(() => [
            document.cookie,
            localStorage.length,
            sessionStorage.length,
          ]),
          await arrival.getByRole("region", { name: "Living scene" }).count(),
          await arrival.locator("canvas, img").count(),
          arrivalSockets,
        ]).toEqual([`${origin}${absentRoute}`, [], ["", 0, 0], 0, 0, 0]);
        // With no world route boot holds route_resolving until a scope is chosen; a renderer that
        // fails to load after snapshot_ready ends at text_ready with the semantic scene usable.
        const arrivalScene = decodeLivingScene(
          (await native.request("/v1/runtime/scene", { version: 1, ...auth.scope }, "yard-inspect"))
            .body,
        );
        const arrived = routeOf(auth.scope);
        await arrival.route(
          (url) => url.pathname === "/src/renderer.ts",
          (route) => route.abort(),
        );
        await arrival.goto(`${origin}/`);
        await arrival.getByLabel("Local session credential").fill("yard-inspect");
        await arrival.getByRole("button", { name: "Sign in", exact: true }).click();
        await arrival.getByText("Choose a world from the selector.", { exact: true }).waitFor();
        expect([
          await bootsOf(arrival),
          (await arrival.getByRole("status").allTextContents()).map((text) =>
            text.replace(/^World arrival:/u, "Arrival:"),
          ),
        ]).toEqual([
          [["route_resolving", "/", null, null, null, 0]],
          ["Scene: signed out. ", "Arrival: resolving world route /."],
        ]);
        // Every arrival mutation shows only the boot announcement as progress.
        await arrival.evaluate(() => {
          globalThis.yardAnnounced = [];
          new MutationObserver(() => {
            // The Places navigation notice is a status of its own, not arrival progress.
            const statuses = [
              ...document.querySelectorAll('[role="status"]:not(nav[aria-label="Places"] *)'),
            ].map((status) => status.textContent.replace(/^World arrival:/u, "Arrival:"));
            const busy = document.querySelectorAll(
              'progress, [role="progressbar"], [aria-busy="true"]',
            ).length;
            globalThis.yardAnnounced.push([
              busy > 0 || statuses.length !== 2 || statuses[0].includes("connecting"),
              statuses[1],
            ]);
          }).observe(document.body, { subtree: true, childList: true, characterData: true });
        });
        await arrival
          .getByLabel("World", { exact: true })
          .selectOption({ label: `${auth.scope.worldId} / ${auth.scope.spaceId}` });
        const textScene = arrival.getByRole("region", { name: "Living scene" });
        await textScene
          .getByText("Canvas unavailable. The complete scene is available below.", { exact: true })
          .waitFor();
        const textReady = `Arrival: text scene ready at revision ${arrivalScene.revision}; renderer unavailable.`;
        const announced = await arrival.evaluate(() => globalThis.yardAnnounced);
        expect([
          await bootsOf(arrival),
          announced.filter(([independent]) => independent),
          announced.at(-1)[1],
          (await arrival.getByRole("status").allTextContents())[1].replace(
            /^World arrival:/u,
            "Arrival:",
          ),
          await textScene.getByRole("listitem").getByRole("button").allTextContents(),
          await arrival.locator("canvas").count(),
          arrivalSockets,
        ]).toEqual([
          progression(arrived, arrivalScene.revision, 0, [
            ["text_ready", arrived, arrivalScene.revision, "renderer_unavailable", null, 1],
          ]),
          [],
          textReady,
          textReady,
          pickOrdered(arrivalScene).map((entity) => entity.presentation.label),
          0,
          1,
        ]);
        await textScene.getByRole("listitem").getByRole("button").first().press("Enter");
        await arrival
          .getByRole("region", { name: "Selected entity", exact: true })
          .getByText(
            `Selected entity at canonical revision ${arrivalScene.revision}, canonical time ${arrivalScene.simulationTime}.`,
          )
          .waitFor();
        await arrival.close();
        await expect.poll(() => attachments(auth.scope)).toEqual([]);
        await page.goto(`${origin}${routeOf(auth.scope)}`);
        await page.getByRole("heading", { name: "Raccoon World", level: 1 }).waitFor();
        const visualText = () =>
          page.evaluate(() => {
            const texts = [];
            for (const stage of globalThis.yardGame?.scene.getScenes(true) ?? [])
              for (const child of stage.children.list)
                if (child.type === "Text") texts.push(child.text);
            return texts;
          });
        // Named emphasis the renderer draws: ellipses as x, y, width, height, line width; the hover
        // label as text, x, y. The pill is measured against the selection label it holds: its centre
        // x, its bottom edge, its width and height less the label's (the padding), its line width,
        // fill colour and alpha, whether its corners are fully round, and whether it draws above the
        // rings and below the label. The selection label is its text and its offset from the pill's
        // centre.
        const emphasis = () =>
          page.evaluate(() => {
            const drawn = {};
            for (const stage of globalThis.yardGame?.scene.getScenes(true) ?? []) {
              const named = (name) => stage.children.list.find((child) => child.name === name);
              const [pill, label, ring] = [
                named("selection-pill"),
                named("selection-label"),
                named("selection-ring"),
              ];
              for (const child of stage.children.list)
                if (child.name)
                  (drawn[child.name] ??= []).push(
                    child === label
                      ? [child.text, child.x - pill?.x, child.y - pill?.y]
                      : child === pill
                        ? [
                            child.x,
                            child.y + child.height / 2,
                            child.width - label?.width,
                            child.height - label?.height,
                            child.lineWidth,
                            child.fillColor,
                            child.fillAlpha,
                            child.isRounded && child.radius === child.height / 2,
                            ring?.depth < child.depth && child.depth < label?.depth,
                          ]
                        : child.type === "Text"
                          ? [child.text, child.x, child.y]
                          : [child.x, child.y, child.width, child.height, child.lineWidth],
                  );
            }
            return drawn;
          });
        await page.getByLabel("Local session credential").fill("yard-inspect");
        const sockets = [];
        const received = [];
        // The world-status answers the browser received, newest last.
        const statuses = [];
        page.on("response", (response) => {
          if (response.url().endsWith("/v1/runtime/world-status") && response.ok())
            statuses.push(response.json());
        });
        const sent = [];
        page.on("websocket", (socket) => {
          // A Refresh reload also opens Vite's HMR socket; only scene sockets are observed.
          if (new URL(socket.url()).pathname !== "/v1/projection") return;
          expect(sockets.map((previous) => previous.isClosed())).toEqual(
            Array(sockets.length).fill(true),
          );
          sockets.push(socket);
          socket.on("framereceived", ({ payload }) => received.push(JSON.parse(String(payload))));
          socket.on("framesent", ({ payload }) => sent.push(JSON.parse(String(payload))));
        });
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("Network.enable");
        await page.evaluate(() => {
          globalThis.yardTransitions = [];
        });
        const handshakes = Promise.all(
          [
            "Network.webSocketWillSendHandshakeRequest",
            "Network.webSocketHandshakeResponseReceived",
          ].map((event) => new Promise((resolve) => cdp.once(event, resolve))),
        );
        await page.getByRole("button", { name: "Sign in", exact: true }).click();
        const [{ request: upgradeRequest }, { response: upgradeResponse }] = await handshakes;
        const [requestHeaders, responseHeaders] = [upgradeRequest, upgradeResponse].map(
          ({ headers }) =>
            Object.fromEntries(
              Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
            ),
        );
        expect(requestHeaders["sec-websocket-protocol"]).toBe(
          `${SCENE_PROTOCOL}, ${SCENE_CREDENTIAL_PREFIX}yard-inspect`,
        );
        expect(requestHeaders.cookie).toBeUndefined();
        expect(responseHeaders["sec-websocket-protocol"]).toBe(SCENE_PROTOCOL);
        const url = new URL(sockets[0].url());
        expect([
          sockets.length,
          url.pathname,
          url.username,
          url.password,
          [...url.searchParams.entries()],
        ]).toEqual([1, "/v1/projection", "", "", Object.entries(auth.scope)]);
        const first = decodeLivingScene(
          (await native.request("/v1/runtime/scene", { version: 1, ...auth.scope }, "yard-inspect"))
            .body,
        );
        const firstEntity = first.entities[0];
        if (firstEntity === undefined) throw new Error("yard fixture has no public entity");
        expect([first.revision, first.simulationTime]).toEqual(before.split("|"));
        // Playwright reports each socket frame to this process asynchronously, so a frame is read
        // from the capture only once it has arrived there, never at a fixed point in the journey.
        const captured = async (type) => {
          await expect.poll(() => received.some((message) => message.type === type)).toBe(true);
          return received.find((message) => message.type === type);
        };
        const committedOutput = () =>
          page.evaluate(() => [
            globalThis.yardSession.queries.getQueryData(["living-yard", "projection"])?.scene,
            globalThis.yardDrawnRevision,
          ]);
        await expect.poll(committedOutput).toEqual([first, first.revision]);
        const snapshot = await captured("snapshot");
        // Signed out, the routed boot holds route_resolving; scene_ready follows the presentation.
        const routed = routeOf(auth.scope);
        expect([
          await bootsOf(page),
          (await page.getByRole("status").allTextContents())[1].replace(
            /^World arrival:/u,
            "Arrival:",
          ),
        ]).toEqual([
          [
            ["route_resolving", routed, null, null, null, 0],
            ...progression(routed, first.revision, 0, [
              ["critical_assets_ready", routed, first.revision, null, null, 1],
              ["scene_ready", routed, first.revision, null, first.revision, 1],
            ]),
          ],
          `Arrival: scene ready at revision ${first.revision}.`,
        ]);
        expect(first.privacyClass).toBe("public_scene");
        expect(first.weather).toEqual({ rainIntensity: world.birth.state.weather.rainIntensity });
        expect(first.entities.map((entity) => entity.objectId)).toEqual(
          world.birth.state.entities
            .filter((entity) => entity.spaceId === auth.scope.spaceId)
            .map((entity) => entity.objectId)
            .sort(),
        );
        expect(Object.keys(first).sort()).toEqual([
          "entities",
          "frames",
          "privacyClass",
          "revision",
          "simulationTime",
          "spaceId",
          "tenantId",
          "timelineId",
          "version",
          "weather",
          "worldId",
        ]);
        for (const entity of first.entities)
          expect(Object.keys(entity).sort()).toEqual([
            "archetypeId",
            "objectId",
            "pose",
            "presentation",
          ]);
        const scene = page.getByRole("region", { name: "Living scene" });
        await scene.getByText(`Canonical revision: ${first.revision}`, { exact: true }).waitFor();
        expect(await commands()).toBe(beforeCommands);
        await expect
          .poll(() => page.evaluate(() => globalThis.yardRendererHookRegistered))
          .toBe(true);
        await expect
          .poll(() => page.evaluate(() => globalThis.yardRendererPresentInvoked))
          .toBe(true);
        await page.locator("canvas").waitFor();
        expect(await page.locator("canvas").count()).toBe(1);
        // issue 20: the live yard draws the pack's bound sprites (worlds/raccoons/presentation.json);
        // unbound entities keep a placeholder marker.
        expect(
          await page.evaluate(() =>
            Object.fromEntries(
              [...globalThis.yardAdapter.drawn]
                .map(([id, { key, body }]) => [id, key ?? body.type])
                .sort(([a], [b]) => (a < b ? -1 : 1)),
            ),
          ),
        ).toEqual({
          "grove.cedar": "tree/static",
          "grove.cedar-hollow": "Arc",
          "grove.den": "den/static",
          "grove.den-stash": "Arc",
          "grove.fence-gate": "Arc",
          "grove.gracie": "gracie/idle",
          "grove.herb": "plant/static",
          "grove.kit": "kit/idle",
          "grove.pantry-bin": "Arc",
          "grove.porch": "Arc",
          "grove.sky": "Arc",
          "grove.snack-dish": "feeder/static",
          "grove.stevie": "stevie/idle",
          "grove.trash-can": "trash-can/static",
          "grove.water-bowl": "Arc",
        });
        const activity = (viewer) =>
          raccoonActivity(viewer, fixture.environment, provisioned.authorization, auth.scope);
        expect(await activity(page)).toEqual([
          ["gracie/idle", null, null],
          ["kit/idle", null, null],
          ["stevie/idle", null, null],
        ]);
        // Only emphasized entities are labelled; the React HUD alone shows revision, time and rain.
        const labels = first.entities.map((entity) => entity.presentation.label);
        await expect.poll(visualText).toEqual([]);
        const panel = page.getByRole("region", { name: "Selected entity", exact: true });
        const values = panel.locator("dd");
        const actionRows = panel.locator("li");
        const earlierButton = panel.getByRole("button", {
          name: "Earlier authorized actions",
          exact: true,
        });
        const waterButton = scene.getByRole("button", { name: "grove.water-bowl", exact: true });
        const { promise: selectionGate, resolve: releaseSelection } = Promise.withResolvers();
        await page.route("**/v1/runtime/entity", async (route) => {
          await selectionGate;
          await route.continue();
        });
        const worldPoint = (objectId) => isoPoint(first, objectId);
        const canvasPoint = (objectId) => {
          const [{ x, y }, [cx, cy]] = [worldPoint(objectId), isoCentre(first)];
          return { x: x - cx + 320, y: y - cy + 200 };
        };
        const pickedEntity = first.entities.find(
          (entity) => entity.objectId === "grove.water-bowl",
        );
        const pointerPosition = canvasPoint("grove.water-bowl");
        const water = worldPoint("grove.water-bowl");
        // Only the selected entity gets a glowing sage ring at its feet and its name centred in a dark
        // pill (10 px side and 4 px top and bottom padding) whose bottom edge sits 6 px above its
        // sprite: a bound sprite's reviewed anchor height (assets/reviewed), a placeholder's feet.
        const { animations: strips } = JSON.parse(
          await readFile(path.join(root, "assets/reviewed/raccoon-world.animations.json"), "utf8"),
        );
        const gracieHeight = strips.find((strip) => strip.assetId === "gracie").anchor.y;
        const ringed = ({ x, y }, label, height = 0) => ({
          "selection-glow": [
            [x, y, 48, 24, 10],
            [x, y, 40, 20, 6],
          ],
          "selection-ring": [[x, y, 32, 16, 3]],
          "selection-pill": [[x, y - height - 6, 20, 8, 1, 0x1e2116, 0.92, true, true]],
          "selection-label": [[label, 0, 0]],
        });
        const pointerResponse = page.waitForResponse(
          (response) => response.url().endsWith("/v1/runtime/entity") && response.status() === 200,
        );
        try {
          await page.locator("canvas").click({ position: pointerPosition });
          await panel.getByText("Loading selected entity.", { exact: true }).waitFor();
          expect(await panel.getAttribute("aria-busy")).toBe("true");
        } finally {
          releaseSelection();
        }
        const picked = decodeEntitySelection(await (await pointerResponse).json());
        expect([
          picked.objectId,
          picked.revision,
          picked.simulationTime,
          picked.derived.simulationTime,
          picked.derived.canonical,
        ]).toEqual(["grove.water-bowl", "0", "8640000000", "8640000100", false]);
        expect(picked.entity).toEqual(pickedEntity);
        expect(picked.physical.resource).toEqual({ kind: "water", quantity: 0 });
        expect([
          picked.physical.needs,
          picked.physical.wellbeing,
          picked.physical.plant,
          picked.derived.needs,
          picked.derived.wellbeing,
          picked.derived.plant,
        ]).toEqual([null, null, null, null, null, null]);
        await panel
          .getByRole("heading", { name: "Selected entity: grove.water-bowl", exact: true })
          .waitFor();
        await panel
          .getByText(
            `Identity: grove.water-bowl; archetype: ${pickedEntity.archetypeId}; frame: ${pickedEntity.pose.frameId} version ${pickedEntity.pose.frameVersion}; position: ${pickedEntity.pose.coordinates.join(", ")}`,
            { exact: true },
          )
          .waitFor();
        await panel.getByText("Canonical revision: 0", { exact: true }).waitFor();
        await panel.getByText("Canonical time: 8640000000", { exact: true }).waitFor();
        await panel
          .getByRole("heading", {
            name: "Derived current-time values (non-canonical)",
            exact: true,
          })
          .waitFor();
        await panel.getByText("Earned simulation time: 8640000100", { exact: true }).waitFor();
        expect(await values.allTextContents()).toEqual([
          "Not applicable",
          "Not applicable",
          "Not applicable",
          "water; quantity 0",
          "Not applicable",
          "None",
          "None",
          "Not applicable",
          "Not applicable",
          "Not applicable",
          "Not applicable",
        ]);
        await panel.getByText("No authorized actions in this page.", { exact: true }).waitFor();
        expect(await earlierButton.count()).toBe(0);
        // One card from the server's summary: its §10 disclosure, a disabled Influence that says
        // why, and no Talk, which a water bowl lacks.
        const card = page.getByRole("region", { name: "Interactions", exact: true });
        await card.getByText("Deterministic/reactive object", { exact: true }).waitFor();
        expect([
          await card.getByRole("button", { name: "Influence", exact: true }).isDisabled(),
          await card.getByRole("button", { name: "Talk", exact: true }).count(),
        ]).toEqual([true, 0]);
        await card
          .getByText("Your world membership does not allow influencing the world.")
          .waitFor();
        await page.unroute("**/v1/runtime/entity");
        // The pointer still rests on the picked sprite: a 1 px hover ring, lighter than the selection.
        await expect.poll(emphasis).toEqual({
          ...ringed(water, "grove.water-bowl"),
          "hover-affordance": [[water.x, water.y, 24, 12, 1]],
        });
        await page.locator("canvas").hover({ position: { x: 5, y: 5 } });
        await expect.poll(emphasis).toEqual(ringed(water, "grove.water-bowl"));
        const pointerText = await panel.textContent();
        // Use the preceding semantic button, then the browser's normal Tab/Enter route.
        await scene.getByRole("button", { name: "grove.cedar", exact: true }).click();
        await expect
          .poll(async () => (await values.allTextContents()).slice(0, 3))
          .toEqual([
            "Not applicable",
            "Not applicable",
            "Wetness 0; growing milliseconds 0; wetness remainder 0; stage 0; integrated at 8640000000",
          ]);
        await expect
          .poll(async () => (await values.allTextContents()).slice(-3))
          .toEqual([
            "Not applicable",
            "Not applicable",
            "Wetness 0; growing milliseconds 0; wetness remainder 0",
          ]);
        await scene.getByRole("button", { name: "grove.gracie", exact: true }).click();
        await expect
          .poll(async () => (await values.allTextContents()).slice(0, 3))
          .toEqual([
            "Hunger 3000; wetness 0; integrated at 8640000000; hunger remainder 0; wetness remainder 0",
            "Thirst 0; health 10000; thirst remainder 0; health remainder 0; comfort comfortable; integrated at 8640000000",
            "Not applicable",
          ]);
        await expect
          .poll(async () => (await values.allTextContents()).slice(-3))
          .toEqual([
            "Hunger 3000; wetness 0; integrated at 8640000100; hunger remainder 80000; wetness remainder 0",
            "Thirst 0; health 10000; thirst remainder 10000; health remainder 0",
            "Not applicable",
          ]);
        // The rail names Gracie with her birth-fixture state and location, and collapsing it and
        // reopening it leaves her selected and ringed.
        const gracie = world.birth.state.entities.find(
          (entity) => entity.objectId === "grove.gracie",
        );
        const railFacts = [
          "grove.gracie",
          `Lifecycle ${gracie?.lifecycle?.status ?? "not applicable"}; action ${gracie?.selectedAction?.kind ?? "none"}`,
          gracie?.locationId ?? "None",
        ];
        const rail = page.getByRole("region", { name: "Entity rail", exact: true });
        const railText = () => rail.locator(":scope > dl > dd").allTextContents();
        const gracieSelected = () =>
          scene
            .getByRole("button", { name: "grove.gracie", exact: true })
            .getAttribute("aria-pressed");
        await expect.poll(railText).toEqual(railFacts);
        await rail.getByRole("button", { name: "Collapse entity rail", exact: true }).click();
        expect([await railText(), await panel.count(), await gracieSelected()]).toEqual([
          [],
          0,
          "true",
        ]);
        await expect
          .poll(emphasis)
          .toEqual(ringed(worldPoint("grove.gracie"), "grove.gracie", gracieHeight));
        await rail.getByRole("button", { name: "Open entity rail", exact: true }).click();
        await expect.poll(railText).toEqual(railFacts);
        expect(await gracieSelected()).toBe("true");
        await scene
          .getByRole("button")
          .nth(pickOrdered(first).findIndex(({ objectId }) => objectId === "grove.water-bowl") - 1)
          .focus();
        await page.keyboard.press("Tab");
        expect(await waterButton.evaluate((button) => button === document.activeElement)).toBe(
          true,
        );
        // Keyboard focus draws its own thin outer ring on the focused entity, apart from the selection.
        await expect.poll(emphasis).toEqual({
          ...ringed(worldPoint("grove.gracie"), "grove.gracie", gracieHeight),
          "focus-affordance": [[water.x, water.y, 40, 20, 1]],
        });
        await page.keyboard.press("Enter");
        await expect.poll(() => panel.textContent()).toBe(pointerText);
        const identity = scene.getByRole("button").first();
        await identity.focus();
        await page.keyboard.press("Enter");
        expect(await identity.getAttribute("aria-pressed")).toBe("true");
        expect(await identity.textContent()).toBe(pickOrdered(first)[0]?.objectId);
        // Hide canvas to exercise the equivalent semantic controls independently of rendering.
        await page.locator("canvas").evaluate((canvas) => {
          canvas.style.display = "none";
        });
        await identity.focus();
        await page.keyboard.press("Enter");
        expect(await identity.getAttribute("aria-pressed")).toBe("true");
        await page.locator("canvas").evaluate((canvas) => {
          canvas.style.display = "";
        });
        expect(
          (
            await executeWorldCommand(
              {
                ...commandRequest(provisioned, {
                  ...resume,
                  type: "PauseWorld",
                  commandId: "browser-clock-pause",
                }),
                trustedWallTime: () => 0n,
              },
              {
                journal: new PostgreSqlWorldCommandJournal(client),
                behavior: provisioned.behavior,
              },
            )
          ).outcome,
        ).toBe("committed");
        expect(await commands()).toBe((BigInt(beforeCommands) + 1n).toString());
        beforeCommands = await commands();
        const ordinary = {
          ...advanceCommand(world, "command-yard-ordinary", 0n, null),
          type: "world.weather.set",
          payload: { schemaVersion: 2, rainIntensity: 6000 },
        };
        await commit(ordinary);
        const [ordinaryRevision, ordinaryTime] = (await durable()).split("|");
        expect(ordinaryRevision).toBe((BigInt(first.revision) + 1n).toString());
        expect(ordinaryTime).toBe(first.simulationTime);
        await scene.getByText(`Canonical revision: ${ordinaryRevision}`, { exact: true }).waitFor();
        await scene.getByText("Rain intensity: 6000", { exact: true }).waitFor();
        const { payload: patch } = await captured("patch");
        expect([snapshot.payload.revision, patch.fromRevision, patch.toRevision]).toEqual([
          first.revision,
          first.revision,
          ordinaryRevision,
        ]);
        const ordinaryScene = {
          ...first,
          revision: ordinaryRevision,
          weather: { rainIntensity: 6000 },
        };
        await expect.poll(committedOutput).toEqual([ordinaryScene, ordinaryRevision]);
        // Only the selected entity (the first in pick order) is labelled; no canvas hover remains.
        const selectedFirst = pickOrdered(first)[0];
        expect(await visualText()).toEqual(selectedFirst ? [selectedFirst.presentation.label] : []);
        expect(navigations).toBe(1);
        // A real transport interruption retires the old owner, then resumes the acknowledged state.
        const initialSocketCount = sockets.length;
        await page.evaluate(() => globalThis.yardCurrentSocket.close());
        await expect.poll(() => sockets.length).toBe(initialSocketCount + 1);
        await expect
          .poll(async () =>
            (await attachments(auth.scope)).map((attachment) => attachment.acknowledgedRevision),
          )
          .toEqual([ordinaryRevision]);
        const advance = advanceCommand(
          world,
          "command-yard-advance",
          world.birth.state.simulationTime + 120_000n,
          null,
        );
        await commit(advance);
        const weather = {
          ...advanceCommand(world, "command-yard-rain", 0n, null),
          type: "world.weather.set",
          payload: { schemaVersion: 2, rainIntensity: 9000 },
        };
        await commit(weather);
        const [revision, simulationTime] = (await durable()).split("|");
        if (revision === undefined || simulationTime === undefined)
          throw new Error("missing durable state");
        expect(BigInt(revision) > BigInt(first.revision) + 1n).toBe(true);
        expect(BigInt(revision) > BigInt(ordinaryRevision) + 1n).toBe(true);
        await scene.getByText(`Canonical revision: ${revision}`, { exact: true }).waitFor();
        await scene.getByText(`Canonical time: ${simulationTime}`, { exact: true }).waitFor();
        await scene.getByText("Rain intensity: 9000", { exact: true }).waitFor();
        // issue 20: once it rains, the residents who chose shelter play the shelter strip.
        await expect
          .poll(() => activity(page))
          .toEqual([
            ["gracie/shelter", "seek-shelter", null],
            ["kit/shelter", "seek-shelter", "completed"],
            ["stevie/idle", "stay", null],
          ]);
        // issue 21: under PostgreSQL's rain at its night clock, puddles lie on the paths' midpoints
        // and the porch lantern and window are lit; the text path says the same.
        expect(Number(BigInt(simulationTime) % 86_400_000n) < 21_600_000).toBe(true);
        await expect.poll(() => shownRoles(page)).toBe("lantern,puddle,window");
        const effects = await effectState(page);
        const porch = isoPoint(first, "grove.porch");
        expect([
          effects
            .filter(({ role }) => role === "puddle")
            .map(({ at }) => at)
            .sort(([a, b], [c, d]) => a - c || b - d),
          effects.filter(({ role }) => role !== "puddle").map(({ role, at }) => [role, ...at]),
        ]).toEqual([
          await puddleSites(),
          [
            ["lantern", porch.x, porch.y],
            ["window", porch.x, porch.y],
          ],
        ]);
        await scene.getByText(`Puddles: ${effects.length - 2}`, { exact: true }).waitFor();
        await scene.getByText("Lights: lantern, window lit", { exact: true }).waitFor();
        // The visible observation and arrival agree with the committed scene.
        await expect
          .poll(() => page.locator("#rw-observation-status").textContent())
          .toContain(
            `Observing revision ${revision}. Canonical time ${simulationTime}. Rain intensity 9000.`,
          );
        expect(await page.locator("#rw-observation-status").textContent()).toContain(
          firstEntity.objectId,
        );
        expect(await page.getByText(/^Arrival: scene ready at revision /u).textContent()).toBe(
          `Arrival: scene ready at revision ${revision}.`,
        );
        // The HUD shows PostgreSQL's paused clock, the pack's speed and 86 400 000 ms day, and rain.
        const day = 86_400_000n;
        const pad = (value) => value.toString().padStart(2, "0");
        const face = (ms) =>
          `Day ${BigInt(ms) / day + 1n}, ${pad((BigInt(ms) % day) / 3_600_000n)}:${pad(((BigInt(ms) % day) / 60_000n) % 60n)}`;
        const hud = page.getByRole("region", { name: "World clock", exact: true });
        await expect
          .poll(() => hud.locator(":scope > span").allTextContents())
          .toEqual([face(simulationTime), "Paused", "Speed ×1", "Rain 90%"]);
        // The feed lists PostgreSQL's public material events, newest first, at their world time.
        const feed = page.getByRole("region", { name: "Event feed", exact: true });
        const materialTimes = (
          await truth(`SELECT string_agg(simulation_time::text, '|' ORDER BY partition_sequence DESC)
            FROM clockgrove.events WHERE partition_id = '${partitionId}' AND privacy_class = 'public_scene'
            AND event_type IN ('weather.changed','weather.transitioned','environment.phase-changed','routine.selected',
            'needs.threshold-crossed','exposure.threshold-crossed','health.threshold-crossed','growth.stage-changed',
            'movement.portal-crossed','movement.completed','portal.opened','portal.closed','resource.offered',
            'resource.consumed','resource.transferred','resource.spoiled')`)
        ).split("|");
        await expect
          .poll(() => feed.locator("time").allTextContents())
          .toEqual(materialTimes.map(face));
        // Each row is a round icon named for its category, or the actor's portrait named for the
        // actor, the sentence the world-status read generated from the event, and the world time.
        const iconNames = {
          weather: "Weather",
          growth: "Ecology",
          resource: "Ecology",
          wellbeing: "Wellbeing",
          portal: "Portal",
        };
        expect(
          await feed
            .locator("button.rw-feed-item")
            .evaluateAll((rows) =>
              rows.map((row) =>
                ["[role=img]", ".rw-feed-text", "time"].map((part, index) =>
                  index === 0
                    ? row.querySelector(part).getAttribute("aria-label")
                    : row.querySelector(part).textContent,
                ),
              ),
            ),
        ).toEqual(
          (await statuses.at(-1)).feed.map((item) => [
            iconNames[item.category] ?? item.objectId,
            item.text,
            face(item.simTimeMs),
          ]),
        );
        // Choosing an entity's event from the keyboard selects it in the scene and the rail, rings
        // and names it on the canvas, and opens the event's Recorded Why; closing it refocuses the row.
        // The runtime labels each entity by its object id.
        const feedItems = (await statuses.at(-1)).feed;
        const entityRow = feedItems.findIndex((item) =>
          first.entities.some((entity) => entity.objectId === item.objectId),
        );
        const feedEntity = feed.locator("button.rw-feed-item").nth(entityRow);
        const feedLabel = feedItems[entityRow].objectId;
        const feedEvent = feedItems[entityRow].sourceEventIds[0];
        await feedEntity.press("Enter");
        expect(
          await scene
            .getByRole("button", { name: feedLabel, exact: true })
            .getAttribute("aria-pressed"),
        ).toBe("true");
        await expect
          .poll(() =>
            page
              .getByRole("region", { name: "Entity rail" })
              .locator(":scope > dl > dd")
              .first()
              .textContent(),
          )
          .toBe(feedLabel);
        await expect
          .poll(async () => {
            const drawn = await emphasis();
            return ["selection-ring", "selection-pill", "selection-label"].map(
              (name) => drawn[name]?.length,
            );
          })
          .toEqual([1, 1, 1]);
        expect((await emphasis())["selection-label"][0][0]).toBe(feedLabel);
        const rowWhy = page.getByRole("region", { name: "Recorded Why", exact: true });
        await rowWhy.getByText(`Started from event ${feedEvent}`, { exact: true }).waitFor();
        await rowWhy.getByRole("button", { name: "Close Why", exact: true }).click();
        expect(await feedEntity.evaluate((row) => row === document.activeElement)).toBe(true);
        // §4.1 hierarchy at desktop, §4.4 sheets below the breakpoint, and no axe violations.
        await page.addScriptTag({ path: require.resolve("axe-core/axe.min.js") });
        const box = async (selector) => {
          const { x, y, width, height } = await page.locator(selector).boundingBox();
          return [x, y, width, height].map(Math.round);
        };
        for (const [width, height] of [
          [1536, 864],
          [1280, 720],
          [390, 844],
        ]) {
          await page.setViewportSize({ width, height });
          // Media-query change events fire in the rendering step after a resize, before animation
          // frame callbacks: after two frames the layout panels have followed the breakpoint.
          await page.evaluate(
            () =>
              new Promise((resolve) => {
                scrollTo(0, 0);
                requestAnimationFrame(() => requestAnimationFrame(resolve));
              }),
          );
          const [hudBox, mainBox, railBox, feedBox, canvasBox] = await Promise.all(
            [".rw-hud", ".rw-main", ".rw-rail", ".rw-feed-dock", "canvas"].map(box),
          );
          const clockBox = await box(".rw-clock");
          if (width >= 1200) {
            expect([hudBox, mainBox.slice(0, 2), railBox[1], railBox[0]]).toEqual([
              [0, 0, width, 60],
              [0, 60],
              60,
              mainBox[2],
            ]);
            expect(Math.abs(railBox[2] - width / 5)).toBeLessThanOrEqual(1);
            const selector = await box("#world");
            expect([
              selector[0] >= 0 && selector[0] + selector[2] <= width,
              selector[1] >= hudBox[1],
              selector[1] + selector[3] <= hudBox[1] + hudBox[3],
              canvasBox[1] >= hudBox[3],
              canvasBox[1] + canvasBox[3] <= height,
            ]).toEqual([true, true, true, true, true]);
            const clockCenter = clockBox[0] + clockBox[2] / 2;
            expect(clockCenter > width * 0.3 && clockCenter < width * 0.7).toBe(true);
            // The feed floats at the lower left, clear of the canvas.
            expect([
              feedBox[0] < width * 0.3,
              feedBox[1] + feedBox[3],
              feedBox[0] + feedBox[2] < canvasBox[0],
            ]).toEqual([true, height - 16, true]);
            expect(await feed.locator("ol").isVisible()).toBe(true);
          } else {
            // The rail is a bottom sheet and the feed a collapsed sheet; selection is unchanged.
            expect([
              railBox[0],
              railBox[2],
              railBox[1] + railBox[3],
              clockBox[1] + clockBox[3] <= height,
            ]).toEqual([0, width, height, true]);
            expect([
              await feed.locator("ol").isHidden(),
              await feed.getByRole("button", { name: "Open event feed" }).isVisible(),
              await page.getByRole("button", { name: "Open entity rail" }).isVisible(),
              await scene
                .getByRole("button", { name: feedLabel, exact: true })
                .getAttribute("aria-pressed"),
            ]).toEqual([true, true, true, "true"]);
            // The feed sheet sits on the collapsed rail's top edge, never over it.
            expect(feedBox[1] + feedBox[3]).toBeLessThanOrEqual(railBox[1]);
            await page.getByRole("button", { name: "Open entity rail", exact: true }).click();
            expect(
              await page
                .locator(".rw-rail")
                .evaluate((element) => getComputedStyle(element).backgroundColor),
            ).toBe("rgb(30, 33, 22)");
            await page.getByRole("button", { name: "Collapse entity rail", exact: true }).click();
            await feed.getByRole("button", { name: "Open event feed", exact: true }).click();
            expect(
              await page
                .locator(".rw-feed-dock")
                .evaluate((element) => getComputedStyle(element).backgroundColor),
            ).toBe("rgb(30, 33, 22)");
            await feed.getByRole("button", { name: "Collapse event feed", exact: true }).click();
            // The window, not an inner container, scrolls the canvas; picking survives the scroll.
            const far = first.entities
              .map((entity) => ({ objectId: entity.objectId, ...canvasPoint(entity.objectId) }))
              .sort((a, b) => b.x - a.x)[0];
            const scrolled = await page.evaluate(
              ([x, y]) => {
                const canvas = document.querySelector("canvas").getBoundingClientRect();
                scrollTo(canvas.left + x - innerWidth / 2, canvas.top + y - innerHeight / 3);
                return scrollX;
              },
              [far.x, far.y],
            );
            expect(scrolled).toBeGreaterThan(0);
            await page.mouse.click(
              ...(await page.locator("canvas").evaluate(
                (canvas, [x, y]) => {
                  const { left, top } = canvas.getBoundingClientRect();
                  return [left + x, top + y];
                },
                [far.x, far.y],
              )),
            );
            await expect
              .poll(() =>
                scene
                  .getByRole("button", { name: far.objectId, exact: true })
                  .getAttribute("aria-pressed"),
              )
              .toBe("true");
          }
          expect(
            (await page.evaluate(() => globalThis.axe.run())).violations.map(
              (violation) =>
                `${violation.id}: ${violation.nodes.map((node) => node.target).join(" ")}`,
            ),
          ).toEqual([]);
        }
        await page.setViewportSize({ width: 1280, height: 720 });
        expect(sockets.length).toBe(initialSocketCount + 1);
        // The live connection status of a ready scene never resets boot.
        expect(await bootsOf(page)).toEqual([]);
        const transitions = await page.evaluate(() => globalThis.yardTransitions);
        expect(
          transitions
            .map(([status]) => status)
            .filter((status, index, all) => status !== all[index - 1]),
        ).toEqual(["connecting", "ready", "degraded", "connecting", "ready"]);
        const applied = transitions.flatMap(([, value]) => (value === null ? [] : [BigInt(value)]));
        expect(applied).toEqual([...applied].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
        expect([applied[0], applied.at(-1)]).toEqual([BigInt(first.revision), BigInt(revision)]);
        expect(
          sent
            .filter((message) => message.type === "resume")
            .map((message) => [message.lastAppliedRevision, message.assetManifestVersion]),
        ).toEqual([
          [null, 1],
          [ordinaryRevision, 1],
        ]);
        expect(sceneRequests).toBe(0);
        expect(navigations).toBe(1);
        expect(await commands()).toBe((BigInt(beforeCommands) + 3n).toString());
        await page.getByRole("button", { name: "Sign out", exact: true }).click();
        expect(await scene.count()).toBe(0);
        await page.getByLabel("Local session credential").fill("yard-inspect");
        await page.getByRole("button", { name: "Sign in", exact: true }).click();
        await scene.waitFor();
        auth.revoke();
        await native.sql(
          "UPDATE clockgrove.world_memberships SET grants=array_remove(grants,'runtime:world-observe') WHERE principal_id='principal-runtime'",
        );
        expect(JSON.parse(await truth(membershipGrants))).toEqual([]);
        await commit({ ...weather, commandId: "command-yard-revoked" });
        await scene.waitFor({ state: "detached" });
        expect(await page.locator("#rw-observation-status").textContent()).toContain(
          "Observation: unavailable. Authorization lost.",
        );
        expect(received.filter((message) => message.type === "disconnect").at(-1)).toEqual({
          protocolVersion: 1,
          type: "disconnect",
          reason: "unauthorized",
        });
        expect(await publicState()).toEqual([undefined, ...emptyDetails]);
        expect(await commands()).toBe((BigInt(beforeCommands) + 4n).toString());
        await native.sql(
          "UPDATE clockgrove.world_memberships SET grants=ARRAY['runtime:world-observe'] WHERE principal_id='principal-runtime'",
        );
        expect(JSON.parse(await truth(membershipGrants))).toEqual(["runtime:world-observe"]);
        worker = new RuntimeWorker(
          livingYardAuthentication(provisioned).authenticator,
          bindings,
          observerLogger,
        );
        // Cross the documented 100-sequence window; history has no lifetime cutoff.
        for (let index = 0; index < 102; index++) {
          await withClient(fixture.environment, async (commandClient) => {
            const owner = new PostgreSqlCommandOwner(commandClient);
            const current = await owner.reader.hydrate(provisioned.authorization, auth.scope);
            const command = {
              ...advanceCommand(
                world,
                `browser-selection-${index}`,
                0n,
                current.document.state.revision,
              ),
              type: index % 2 === 0 ? "resource.offer" : "resource.consume",
              payload: {
                schemaVersion: 1,
                objectId: "grove.water-bowl",
                kind: "water",
                quantity: 1,
              },
            };
            const result = await executeWorldCommand(commandRequest(provisioned, command), {
              journal: new PostgreSqlWorldCommandJournal(commandClient),
              behavior: provisioned.behavior,
            });
            expect(result.outcome).toBe("committed");
          });
        }
        await page.getByLabel("Local session credential").fill("yard-inspect");
        await page.getByRole("button", { name: "Sign in", exact: true }).click();
        await scene.waitFor();
        const recentResponse = page.waitForResponse(
          (response) => response.url().endsWith("/v1/runtime/entity") && response.status() === 200,
        );
        await waterButton.click();
        const recent = decodeEntitySelection(await (await recentResponse).json());
        expect(recent.history.actions.map((action) => action.commandId)).toEqual(
          Array.from({ length: 100 }, (_, index) => `browser-selection-${101 - index}`),
        );
        const recorded = JSON.parse(
          await truth(`SELECT json_agg(json_build_object(
          'eventId',event_id,'actionId',attribution->>'causalRootActionId','commandId',command_id,'type',event_type,
          'partitionSequence',partition_sequence::text,'simulationTime',simulation_time::text,
          'recordedAt',to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
          ORDER BY partition_sequence DESC)::text FROM
          (SELECT * FROM clockgrove.events WHERE command_id LIKE 'browser-selection-%'
           ORDER BY partition_sequence DESC LIMIT 102) AS recent`),
        );
        expect(recent.history.actions).toEqual(recorded.slice(0, 100));
        const recentText = recorded.map(
          (action) =>
            `Action ${action.actionId}; event ${action.eventId}; command ${action.commandId}; ${action.type}; partition sequence ${action.partitionSequence}; recorded simulation time ${action.simulationTime}; recorded at ${action.recordedAt} Why action ${action.actionId}`,
        );
        await expect.poll(() => actionRows.allTextContents()).toEqual(recentText.slice(0, 100));
        // Pointer and keyboard must expose identical ordered action rows through this panel.
        await scene.getByRole("button", { name: "grove.cedar", exact: true }).click();
        await page.locator("canvas").click({ position: pointerPosition });
        await expect.poll(() => actionRows.allTextContents()).toEqual(recentText.slice(0, 100));
        await scene.getByRole("button", { name: "grove.cedar", exact: true }).click();
        await scene
          .getByRole("button")
          .nth(pickOrdered(first).findIndex(({ objectId }) => objectId === "grove.water-bowl") - 1)
          .focus();
        await page.keyboard.press("Tab");
        await page.keyboard.press("Enter");
        await expect.poll(() => actionRows.allTextContents()).toEqual(recentText.slice(0, 100));
        // Each action now has a Why button before the earlier-history control in tab order.
        await actionRows.last().getByRole("button").focus();
        await page.keyboard.press("Tab");
        expect(await earlierButton.evaluate((button) => button === document.activeElement)).toBe(
          true,
        );
        const earlierResponse = page.waitForResponse(
          (response) => response.url().endsWith("/v1/runtime/entity") && response.status() === 200,
        );
        await page.keyboard.press("Enter");
        const earlier = decodeEntitySelection(await (await earlierResponse).json());
        expect(earlier.history.actions.map((action) => action.commandId)).toEqual([
          "browser-selection-1",
          "browser-selection-0",
        ]);
        expect(earlier.history.beforeSequence).toBe(null);
        expect(earlier.history.actions).toEqual(recorded.slice(100));
        await expect.poll(() => actionRows.allTextContents()).toEqual(recentText.slice(100));
        expect(await earlierButton.count()).toBe(0);
        await page.route("**/v1/runtime/entity", async (route) => {
          const input = route.request().postDataJSON();
          await route.continue({ postData: JSON.stringify({ ...input, objectId: "unknown" }) });
        });
        const unavailableResponse = page.waitForResponse(
          (response) => response.url().endsWith("/v1/runtime/entity") && response.status() === 409,
        );
        await panel.getByRole("button", { name: "Refresh selected entity", exact: true }).focus();
        await page.keyboard.press("Enter");
        const unavailable = await unavailableResponse;
        expect([unavailable.status(), await unavailable.json()]).toEqual([
          409,
          { error: "selection_unavailable" },
        ]);
        await panel.getByText("Selected entity unavailable.", { exact: true }).waitFor();
        expect(await panel.locator("dl, ol").count()).toBe(0);
        expect(await panel.getAttribute("aria-busy")).toBe("false");
        await page.unroute("**/v1/runtime/entity");
        // The deterministic day's routine choice is retained by the command owner before Why reads it.
        const whyCommand = advanceCommand(
          world,
          "browser-why-original",
          world.birth.state.simulationTime + world.behavior.policy.decisionIntervalMs,
          null,
        );
        const privateSentinels = [
          "PRIVATE-BELIEF-SENTINEL",
          "PRIVATE-MEMORY-SENTINEL",
          "PRIVATE-PERCEPTION-SENTINEL",
        ];
        await withClient(fixture.environment, async (commandClient) => {
          const result = await executeWorldCommand(commandRequest(provisioned, whyCommand), {
            journal: new PostgreSqlWorldCommandJournal(commandClient),
            behavior: provisioned.behavior,
            kernel(input) {
              const output = executeWorldKernel(input);
              if (!output.ok) return output;
              return {
                ...output,
                result: {
                  ...output.result,
                  decisionDrafts: output.result.decisionDrafts.map((draft) =>
                    draft.kind === "routine"
                      ? {
                          ...draft,
                          decision: {
                            ...draft.decision,
                            beliefRefs: [privateSentinels[0]],
                            memoryRefs: [privateSentinels[1]],
                            perceptionRefs: [privateSentinels[2]],
                          },
                        }
                      : draft,
                  ),
                },
              };
            },
          });
          expect(result.outcome).toBe("committed");
        });
        const retained = decodeCanonicalNode(
          JSON.parse(
            await truth(
              "SELECT result->'projectionDelta'->'decisionTraces'->'drafts' FROM clockgrove.command_receipts WHERE command_id = 'browser-why-original'",
            ),
          ),
        );
        expect(retained.map((draft) => draft.decision.objectId).sort()).toEqual([
          "grove.gracie",
          "grove.kit",
          "grove.stevie",
          "grove.stevie",
        ]);
        expect(retained.map((draft) => draft.decision.beliefRefs)).toEqual(
          retained.map(() => ["PRIVATE-BELIEF-SENTINEL"]),
        );
        await page.evaluate(() => globalThis.yardCurrentSocket.close());
        const whyBefore = await commands();
        const whyDurableBefore = await durable();
        await scene
          .getByText(`Canonical revision: ${whyDurableBefore.split("|")[0]}`, { exact: true })
          .waitFor();
        await page.locator("canvas").evaluate((canvas) => {
          canvas.style.display = "none";
        });
        const gracieButton = scene.getByRole("button", { name: "grove.gracie", exact: true });
        await gracieButton.focus();
        await page.keyboard.press("Enter");
        const whyTrigger = panel
          .getByRole("button", {
            name: "Why action action-browser-why-original",
            exact: true,
          })
          .first();
        await whyTrigger.waitFor();
        // Traverse from the selection refresh control to the action using ordinary Tab input.
        await panel.getByRole("button", { name: "Refresh selected entity", exact: true }).focus();
        await page.keyboard.press("Tab");
        expect(await whyTrigger.evaluate((button) => document.activeElement === button)).toBe(true);
        const whyResponse = page.waitForResponse(
          (response) => response.url().endsWith("/v1/runtime/why") && response.status() === 200,
        );
        await page.keyboard.press("Enter");
        const whyValue = decodeRecordedWhy(await (await whyResponse).json());
        expect(whyValue.commandId).toBe("browser-why-original");
        expect(whyValue.actionId).toBe("action-browser-why-original");
        expect(whyValue.receiptStatus).toBe("committed");
        expect(whyValue.traces.status).toBe("available");
        const whyPanel = page.getByRole("region", { name: "Recorded Why", exact: true });
        await whyPanel.getByText("Recorded evidence loaded.", { exact: true }).waitFor();
        await page.setViewportSize({ width: 390, height: 844 });
        expect(
          await whyPanel.evaluate((element) => [
            getComputedStyle(element).backgroundColor,
            element.contains(document.elementFromPoint(195, 422)),
          ]),
        ).toEqual(["rgb(30, 33, 22)", true]);
        await page.setViewportSize({ width: 1280, height: 720 });
        const whyHeading = whyPanel.getByRole("heading", {
          name: "Recorded Why: browser-why-original",
          exact: true,
        });
        expect(await whyHeading.evaluate((heading) => document.activeElement === heading)).toBe(
          true,
        );
        for (const [index, { decision }] of retained.entries()) {
          const decisionPanel = whyPanel.getByRole("region", {
            name: `Decision ${index + 1}`,
            exact: true,
          });
          expect(await decisionPanel.getByRole("heading").first().textContent()).toBe(
            `Recorded decision ${index + 1} for ${decision.objectId}`,
          );
          expect(await decisionPanel.locator(":scope > dl > dd").allTextContents()).toEqual([
            String(decision.inputRevision),
            String(decision.simulationTime),
            "grove-yard-1/clockgrove.routine-utility@1",
            decision.selectionTier,
            `${decision.selectedAction.kind}; target ${decision.selectedAction.targetObjectId ?? "None"}`,
          ]);
          expect(await decisionPanel.locator("li > p").allTextContents()).toEqual(
            decision.candidates.map(
              (candidate) =>
                `${candidate.action.kind}; target ${candidate.action.targetObjectId ?? "None"}; score ${candidate.score}; exclusion ${candidate.excludedReason ?? "None"}`,
            ),
          );
          expect(await decisionPanel.locator("li dl dt").allTextContents()).toEqual(
            decision.candidates.flatMap((candidate) => Object.keys(candidate.features).sort()),
          );
          expect(await decisionPanel.locator("li dl dd").allTextContents()).toEqual(
            decision.candidates.flatMap((candidate) =>
              Object.entries(candidate.features)
                .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
                .map(([, value]) => String(value)),
            ),
          );
        }
        const causalParents = JSON.parse(
          await truth(
            "SELECT jsonb_agg(DISTINCT scheduled_by_command_id ORDER BY scheduled_by_command_id)::text FROM clockgrove.partition_schedules WHERE completed_by_command_id = 'browser-why-original' AND scheduled_by_command_id <> 'browser-why-original'",
          ),
        );
        expect(whyValue.links).toEqual({ parents: causalParents, children: [] });
        const parentText = `Parent commands: ${causalParents.join(", ")}`;
        expect(await whyPanel.getByText(parentText, { exact: true }).textContent()).toBe(
          parentText,
        );
        expect(
          await whyPanel.getByText("Child commands: None", { exact: true }).textContent(),
        ).toBe("Child commands: None");
        const sharedResponses = [];
        for (const [endpoint, fields] of [
          ["scene", {}],
          ["entity", { objectId: "grove.gracie" }],
          ["why", { commandId: "browser-why-original" }],
        ]) {
          const observed = await page.request.post(
            `http://127.0.0.1:${address.port}/v1/runtime/${endpoint}`,
            {
              headers: { authorization: "Bearer yard-inspect" },
              data: { version: 1, ...auth.scope, ...fields },
            },
          );
          expect(observed.status()).toBe(200);
          sharedResponses.push(await observed.json());
        }
        for (const [fields, credential, status, body] of [
          [{ commandId: "unknown" }, "yard-inspect", 404, { error: "command_not_found" }],
          [
            { commandId: "browser-why-original", spaceId: "foreign-space" },
            "yard-inspect",
            403,
            { error: "authorization_refused" },
          ],
          [
            { commandId: "browser-why-original" },
            "invalid",
            401,
            { error: "authentication_refused" },
          ],
        ]) {
          const rejected = await page.request.post(
            `http://127.0.0.1:${address.port}/v1/runtime/why`,
            {
              headers: { authorization: `Bearer ${credential}` },
              data: { version: 1, ...auth.scope, ...fields },
            },
          );
          const failure = await rejected.json();
          expect([rejected.status(), failure]).toEqual([status, body]);
          sharedResponses.push(failure);
        }
        const originalWhyText = await whyPanel.textContent();
        await page.addScriptTag({
          content: await readFile(require.resolve("axe-core/axe.min.js"), "utf8"),
        });
        expect((await page.evaluate(() => globalThis.axe.run())).violations).toEqual([]);
        expect(await commands()).toBe(whyBefore);
        expect(await durable()).toBe(whyDurableBefore);
        const later = {
          ...advanceCommand(world, "browser-why-later-weather", 0n, null),
          type: "world.weather.set",
          payload: { schemaVersion: 2, rainIntensity: 1000 },
        };
        await commit(later);
        const laterRevision = (await durable()).split("|")[0];
        await scene.getByText(`Canonical revision: ${laterRevision}`, { exact: true }).waitFor();
        expect(await whyPanel.textContent()).toBe(originalWhyText);
        expect(
          await panel
            .getByText("Earned simulation time: 8726400000", { exact: true })
            .textContent(),
        ).toBe("Earned simulation time: 8726400000");
        for (const secret of [
          ...privateSentinels,
          "test-auth",
          "yard-inspect",
          "principal-yard-observer",
          "membership-yard",
          "persona-yard",
          "authority:browser-why-original",
          "privacyCeiling",
          "commandBytes",
        ]) {
          expect((await page.locator("body").textContent()).includes(secret)).toBe(false);
          expect(JSON.stringify([whyValue, ...sharedResponses]).includes(secret)).toBe(false);
          expect(JSON.stringify(observerTelemetry).includes(secret)).toBe(false);
        }
        const observerOutput = [];
        await page.keyboard.press("Tab");
        expect(
          await whyPanel
            .getByRole("button", { name: "Close Why", exact: true })
            .evaluate((button) => document.activeElement === button),
        ).toBe(true);
        await page.keyboard.press("Enter");
        expect(await whyPanel.count()).toBe(0);
        expect(await whyTrigger.evaluate((button) => document.activeElement === button)).toBe(true);
        await page.route("**/v1/runtime/why", (route) =>
          route.fulfill({ json: { "OPERATOR-DECODE-SENTINEL": true } }),
        );
        await page.keyboard.press("Enter");
        await whyPanel.getByText("Recorded evidence unavailable.", { exact: true }).waitFor();
        expect(await page.evaluate(() => globalThis.yardQueryError)).toBe(
          "Runtime request refused (503)",
        );
        observerOutput.push(await page.locator("body").textContent());
        await whyPanel.getByRole("button", { name: "Close Why", exact: true }).click();
        await page.unroute("**/v1/runtime/why");
        // A held obsolete authorization failure cannot erase a newer entity selection.
        const { promise: lateWhyGate, resolve: releaseWhy } = Promise.withResolvers();
        const { promise: lateWhySettled, resolve: settleLateWhy } = Promise.withResolvers();
        await page.route("**/v1/runtime/why", async (route) => {
          await lateWhyGate;
          await route.fulfill({
            status: 403,
            contentType: "application/json",
            body: JSON.stringify({
              error: "authorization_refused",
              diagnostic: "OPERATOR-FAILURE-SENTINEL",
            }),
          });
          settleLateWhy();
        });
        try {
          const heldRequest = page.waitForRequest((request) =>
            request.url().endsWith("/v1/runtime/why"),
          );
          await page.keyboard.press("Enter");
          await heldRequest;
          await scene.getByRole("button", { name: "grove.stevie", exact: true }).focus();
          await page.keyboard.press("Enter");
          await panel
            .getByRole("heading", { name: "Selected entity: grove.stevie", exact: true })
            .waitFor();
          releaseWhy();
          await lateWhySettled;
          await panel
            .getByText(
              "Selected entity at canonical revision " +
                laterRevision +
                ", canonical time 8726400000. Derived non-canonical earned time 8726400000.",
              { exact: true },
            )
            .waitFor();
          expect(await whyPanel.count()).toBe(0);
          expect(await scene.count()).toBe(1);
        } finally {
          releaseWhy();
          await page.unroute("**/v1/runtime/why");
        }
        expect((await page.evaluate(() => globalThis.axe.run())).violations).toEqual([]);
        expect(await commands()).toBe((BigInt(whyBefore) + 1n).toString());
        // An event of a command with retained routine decisions opens the same command's Why from the feed.
        const openFeed = feed.getByRole("button", { name: "Open event feed", exact: true });
        if (await openFeed.isVisible()) await openFeed.click();
        await feed.locator('[data-event-id="browser-why-original:event:28"]').click();
        const eventWhy = page.getByRole("region", { name: "Recorded Why", exact: true });
        await eventWhy
          .getByRole("heading", { name: "Recorded Why: browser-why-original", exact: true })
          .waitFor();
        await eventWhy
          .getByText("Started from event browser-why-original:event:28", { exact: true })
          .waitFor();
        await eventWhy.getByText("receipt: canonical", { exact: true }).waitFor();
        expect(
          await eventWhy.getByRole("heading", { name: /^Recorded decision 1 for / }).count(),
        ).toBe(1);
        // Both destinations are durably provisioned and explicitly authorized; no projection fixture is invented.
        const destination = await provisionTestWorld(
          fixture,
          await testWorld("fixture"),
          "principal-runtime",
        );
        const destinationScope = {
          ...destination.partition.target,
          spaceId: destination.partition.route.spaceId,
        };
        await native.sql(`INSERT INTO clockgrove.world_memberships
          (tenant_id,world_id,timeline_id,space_id,principal_id,membership_id,persona_id,roles,grants,privacy_ceiling,committed_at)
          SELECT '${destinationScope.tenantId}','${destinationScope.worldId}','${destinationScope.timelineId}','${destinationScope.spaceId}',
          principal_id,'membership-browser-destination','persona-browser-destination',roles,grants,privacy_ceiling,committed_at
          FROM clockgrove.world_memberships WHERE space_id='${auth.scope.spaceId}' AND principal_id='principal-runtime'`);
        expect((await attachments(auth.scope)).length).toBe(1);
        // Sign-in reads the directory once, so the new membership is listed after the next sign-in.
        await page.getByRole("button", { name: "Sign out", exact: true }).click();
        expect([await publicState(), await scene.count()]).toEqual([
          [undefined, ...emptyDetails],
          0,
        ]);
        await page.getByLabel("Local session credential").fill("yard-inspect");
        await page.getByRole("button", { name: "Sign in", exact: true }).click();
        await scene.getByRole("heading", { name: auth.scope.worldId, exact: true }).waitFor();
        const selector = page.getByLabel("World", { exact: true });
        expect(await selector.locator("option").allTextContents()).toEqual(
          await observableLabels(),
        );
        expect(await selector.inputValue()).toBe(routeOf(auth.scope));
        await page.evaluate(() => {
          globalThis.replacedObserver = globalThis.yardSession.observation;
          globalThis.replacedMessage = globalThis.replacedObserver.socket.onmessage;
          // The destination's placeholder presentation fails after its renderer loaded.
          globalThis.yardFailPresent = true;
          globalThis.yardPresentedRevision = undefined;
          globalThis.yardBoots = [];
        });
        const successorOpened = page.waitForEvent("websocket").then(() => attachments(auth.scope));
        await selector.selectOption({
          label: `${destinationScope.worldId} / ${destinationScope.spaceId}`,
        });
        expect(await successorOpened).toEqual([]);
        await scene.getByRole("heading", { name: destinationScope.worldId, exact: true }).waitFor();
        await scene
          .getByText("Canvas unavailable. The complete scene is available below.", { exact: true })
          .waitFor();
        const switched = routeOf(destinationScope);
        const destinationRevision = await truth(
          `SELECT revision FROM clockgrove.partition_states WHERE partition_id = '${destination.partition.route.partitionId}'`,
        );
        expect(await bootsOf(page)).toEqual(
          progression(switched, destinationRevision, 1, [
            ["critical_assets_ready", switched, destinationRevision, null, null, 1],
            ["text_ready", switched, destinationRevision, "assets_unavailable", null, 1],
          ]),
        );
        expect([
          page.url(),
          (await publicState()).slice(1),
          await page.locator("input").count(),
        ]).toEqual([`${origin}${routeOf(destinationScope)}`, emptyDetails, 0]);
        expect(
          (await attachments(destinationScope)).map((attachment) => [
            attachment.principalId,
            attachment.audience.spaceId,
          ]),
        ).toEqual([["principal-runtime", destinationScope.spaceId]]);
        await page.evaluate(
          (message) => globalThis.replacedMessage({ data: JSON.stringify(message) }),
          received[0],
        );
        expect(await page.evaluate(() => globalThis.replacedObserver.projection)).toBeUndefined();
        expect((await publicState())[0].worldId).toBe(destinationScope.worldId);
        const recoveryQuery =
          "SELECT jsonb_agg(to_jsonb(state) ORDER BY partition_id)::text FROM clockgrove.partition_states state";
        const recoveryBefore = [await commands(), await truth(recoveryQuery)];
        // Compatibility rejection of an actual native snapshot on the live socket; while yardSkew
        // is set, every snapshot the runtime sends after it carries the same unsupported version.
        const destinationSnapshot = received.findLast((message) => message.type === "snapshot");
        const unsupported = (name) =>
          page.getByRole("region", { name: `Unsupported ${name} version`, exact: true });
        const resumes = () =>
          sent
            .filter((message) => message.type === "resume")
            .map((message) => message.lastAppliedRevision);
        const refreshText = "Refresh to load the current deployment.";
        for (const [field, name, explanation, retried] of [
          [
            "protocolVersion",
            "scene protocol",
            "The world's scene protocol version stayed unsupported after 2 snapshot retries, so no scene is shown.",
            true,
          ],
          [
            "projectionVersion",
            "projection",
            "The world's projection version stayed unsupported after 2 snapshot retries, so no scene is shown.",
            true,
          ],
          [
            "assetManifestVersion",
            "asset-manifest",
            `The world's asset-manifest version is not supported by this client, so no scene is shown. ${refreshText}`,
            false,
          ],
          [
            "clientVersion",
            "client",
            `This client version is not supported by the world, so no scene is shown. ${refreshText}`,
            false,
          ],
        ]) {
          const resumed = resumes().length;
          const opened = sockets.length;
          await page.evaluate(
            ({ message, field }) => {
              globalThis.yardSkew = field;
              globalThis.yardBoots = [];
              globalThis.yardTransitionStart = globalThis.yardTransitions.length;
              globalThis.yardSession.observation.socket.onmessage({
                data: globalThis.yardSkewed(JSON.stringify(message)),
              });
            },
            { message: destinationSnapshot, field },
          );
          await unsupported(name).waitFor();
          // Retries end at the bound: nothing is requested or opened one retry interval later.
          if (retried) await new Promise((resolve) => setTimeout(resolve, 1_500));
          expect([
            await scene.count(),
            await page.locator("#rw-observation-status, #rw-arrival-status").allTextContents(),
            await unsupported(name).getByRole("alert").textContent(),
            await unsupported(name).getByRole("button").allTextContents(),
            await unsupported(name).evaluate((screen) => screen === document.activeElement),
            await publicState(),
            await page.locator("canvas").count(),
            (
              await page.evaluate(() =>
                globalThis.yardTransitions.slice(globalThis.yardTransitionStart),
              )
            ).filter(([status], index, all) => status !== all[index - 1]?.[0]),
            resumes().slice(resumed),
            [
              sockets.length - opened,
              await page.evaluate(() => globalThis.yardSession.observation.socket),
            ],
            await bootsOf(page),
          ]).toEqual([
            0,
            [`Observation: unsupported ${name} version. `, ""],
            explanation,
            retried ? [] : ["Refresh"],
            true,
            [undefined, ...emptyDetails],
            0,
            retried
              ? [
                  ["degraded", null],
                  ["unsupported version", null],
                ]
              : [["unsupported version", null]],
            retried ? [null, null] : [],
            [0, undefined],
            [],
          ]);
          // The retired socket finishes closing before another opens.
          await expect.poll(() => sockets.at(-1).isClosed()).toBe(true);
          if (retried) {
            await page.evaluate(() => {
              globalThis.yardSkew = undefined;
            });
            await page.getByRole("button", { name: "Sign out", exact: true }).click();
          } else {
            // Refresh reloads the current deployment at the same route, which signs the page out.
            const before = navigations;
            await unsupported(name).getByRole("button", { name: "Refresh", exact: true }).click();
            await page.getByLabel("Local session credential").waitFor();
            expect([navigations - before, page.url()]).toEqual([1, `${origin}${switched}`]);
          }
          await page.getByLabel("Local session credential").fill("yard-inspect");
          await page.getByRole("button", { name: "Sign in", exact: true }).click();
          await scene
            .getByRole("heading", { name: destinationScope.worldId, exact: true })
            .waitFor();
          // The renderer loads its reviewed atlas before presenting; its outcome lands first.
          await expect
            .poll(() => page.evaluate(() => globalThis.yardBoots.some(([boot]) => boot.terminal)))
            .toBe(true);
        }
        expect([await commands(), await truth(recoveryQuery)]).toEqual(recoveryBefore);
        await page.evaluate(
          (message) =>
            globalThis.yardSession.observation.socket.onmessage({
              data: JSON.stringify({
                ...message,
                lane: "operator",
                payload: "OPERATOR-LANE-SENTINEL",
              }),
            }),
          received.at(-1),
        );
        await scene.waitFor({ state: "detached" });
        observerOutput.push(await page.locator("body").textContent(), observerTelemetry, received);
        for (const secret of [
          ...privateSentinels,
          "privacyCeiling",
          "commandBytes",
          "OPERATOR-DECODE-SENTINEL",
          "OPERATOR-FAILURE-SENTINEL",
          "OPERATOR-LANE-SENTINEL",
        ])
          expect(JSON.stringify(observerOutput).includes(secret)).toBe(false);
        await page.getByRole("button", { name: "Sign out", exact: true }).click();
        await expect.poll(() => attachments(destinationScope)).toEqual([]);
        expect(await scene.count()).toBe(0);
        await expect
          .poll(() => sockets.map((socket) => socket.isClosed()))
          .toEqual(Array(sockets.length).fill(true));

        // issue 810: two browsers in one space, one with relationship-private access, get different
        // server-decided views; the unprivileged one never holds a private field.
        await truth(
          `UPDATE clockgrove.world_memberships SET privacy_ceiling='{"version":1,"allowedCategories":["public_scene","private_cognition"]}' WHERE principal_id='principal-runtime';
          UPDATE clockgrove.world_memberships SET grants=array_append(grants,'runtime:world-observe') WHERE principal_id='principal-outsider'`,
        );
        const observe = async (credential, options = {}) => {
          const viewer = await (await browser.newContext(options)).newPage();
          await viewer.addInitScript(() => {
            globalThis.WebSocket = class extends WebSocket {
              constructor(...args) {
                super(...args);
                globalThis.yardCurrentSocket = this;
              }
            };
          });
          const frames = [];
          const sockets = [];
          viewer.on("websocket", (socket) => {
            sockets.push(socket);
            socket.on("framereceived", ({ payload }) => frames.push(String(payload)));
          });
          await viewer.goto(`${origin}${routeOf(auth.scope)}`);
          await viewer.getByLabel("Local session credential").fill(credential);
          await viewer.getByRole("button", { name: "Sign in", exact: true }).click();
          await viewer
            .getByRole("region", { name: "Living scene" })
            .getByRole("heading", { name: auth.scope.worldId, exact: true })
            .waitFor();
          const held = () =>
            viewer.evaluate(() =>
              JSON.stringify(
                globalThis.yardSession.queries.getQueryData(["living-yard", "projection"]),
                (_key, value) => (typeof value === "bigint" ? value.toString() : value),
              ),
            );
          const memories = () =>
            viewer.getByRole("list", { name: "Private memories" }).getByRole("listitem");
          return { viewer, frames, sockets, held, memories };
        };
        const kin = await observe("yard-inspect");
        const stranger = await observe("outsider-session-token");
        const remembered = [
          "grove.kit belief about grove.snack-dish: 6000",
          "grove.kit belief about grove.snack-dish: 2000",
          "grove.kit belief about grove.snack-dish: 2000",
          "grove.stevie belief about grove.snack-dish: 3000",
          "grove.stevie memory about grove.snack-dish: 1500",
          "grove.stevie memory about grove.snack-dish: 1500",
          "grove.stevie memory about grove.snack-dish: 1500",
        ];
        await expect.poll(() => kin.memories().allTextContents()).toEqual(remembered);
        const entitiesOf = async (target) => JSON.parse(await target.held()).scene.entities;
        expect(await entitiesOf(stranger)).toEqual(await entitiesOf(kin));
        const strangerOutput = async () => [
          await stranger.held(),
          await stranger.viewer.locator("body").textContent(),
          stranger.frames,
        ];
        expect(await stranger.memories().count()).toBe(0);
        for (const secret of ["scripted:", "privateCognition", "belief about", "memory about"])
          expect(JSON.stringify(await strangerOutput()).includes(secret)).toBe(false);
        // issue 809: the golden yard with rain, on a touch viewer that prefers reduced motion.
        const attached = (await attachments(auth.scope)).length;
        const touch = await observe("yard-inspect", { hasTouch: true, reducedMotion: "reduce" });
        const yard = touch.viewer;
        await expect
          .poll(() => yard.evaluate(() => globalThis.yardAdapter?.stage?.scene.key))
          .toBeTruthy();
        const golden = JSON.parse(await touch.held()).scene;
        expect(golden.weather.rainIntensity).toBeGreaterThan(0);
        const { budgets } = JSON.parse(
          await readFile(path.join(root, "apps/web/scene-budgets.json"), "utf8"),
        );
        // Frame time is sampled over this settled window on the animating viewer, so the golden
        // yard's boot in the touch viewer does not count towards it.
        await kin.viewer.evaluate(() => {
          globalThis.yardAdapter.metrics.frameMs.length = 0;
        });
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        const drawnState = () =>
          yard.evaluate(() => {
            const adapter = globalThis.yardAdapter;
            const camera = adapter.stage.cameras.main;
            const bounds = camera.getBounds();
            const view = camera.worldView;
            return {
              byDepth: [...adapter.drawn]
                .sort(([, a], [, b]) => b.body.depth - a.body.depth)
                .map(([objectId]) => objectId),
              camera: [camera.rotation, camera.zoom],
              bounds: [bounds.centerX, bounds.centerY, bounds.width, bounds.height],
              inside:
                view.left >= bounds.left - 0.01 &&
                view.right <= bounds.right + 0.01 &&
                view.top >= bounds.top - 0.01 &&
                view.bottom <= bounds.bottom + 0.01,
              weather: [adapter.night.visible, adapter.rain.visible],
              reducedMotion: adapter.reducedMotion,
              metrics: adapter.metrics,
            };
          });
        const placed = pickOrdered(golden).filter((entity) =>
          golden.frames.some((frame) => frame.frameId === entity.pose.frameId),
        );
        const points = placed.map((entity) => isoPoint(golden, entity.objectId));
        const extent = (values) => Math.max(...values) - Math.min(...values);
        const timeOfDay = Number(BigInt(golden.simulationTime) % 86_400_000n);
        const state = await drawnState();
        // Drawn front to back in pick order, under a fixed unrotated camera framed on the yard.
        expect([state.byDepth, state.camera, state.bounds, state.inside, state.weather]).toEqual([
          placed.map((entity) => entity.objectId),
          [0, 1],
          [
            ...isoCentre(golden),
            Math.max(extent(points.map(({ x }) => x)) + 320, 640 / 0.75),
            Math.max(extent(points.map(({ y }) => y)) + 320, 400 / 0.75),
          ],
          true,
          [timeOfDay < 21_600_000 || timeOfDay >= 64_800_000, true],
        ]);
        // Budgets (plan §9.3) hold on the golden yard with rain enabled and animating: they are read
        // from the viewer without reduced motion, so rain advances and sprites play.
        const animated = await kin.viewer.evaluate(() => {
          const adapter = globalThis.yardAdapter;
          return {
            weather: [adapter.rain.visible, adapter.reducedMotion],
            rainFrames: adapter.atlas.get("rain/loop")?.frames.length ?? 0,
            metrics: adapter.metrics,
          };
        });
        expect([animated.weather, animated.rainFrames > 1]).toEqual([[true, false], true]);
        // issue 21: the budgets below are read while every puddle and light shows, the looping ones
        // animating (the window is one static frame); the reduced-motion viewer holds them still.
        const kinEffects = await effectState(kin.viewer);
        const heldEffects = await effectState(yard);
        const roles = kinEffects.map(({ role }) => role);
        expect([
          roles.length,
          kinEffects.map(({ role, shown, playing }) => [role, shown, playing]),
          heldEffects.map(({ role, shown, playing }) => [role, shown, playing]),
        ]).toEqual([
          (await puddleSites()).length + 2,
          roles.map((role) => [role, true, role !== "window"]),
          roles.map((role) => [role, true, false]),
        ]);
        const runtime = animated.metrics;
        const frames = [...runtime.frameMs].sort((a, b) => a - b);
        // §17: the animating viewer reports its frame time as frame_ms:p95 points, one per
        // 120-frame window, each a positive interval.
        const framePoints = await kin.viewer.evaluate(() =>
          globalThis.yardMeasurements.points().filter(({ name }) => name === "frame_ms"),
        );
        expect(framePoints.length).toBeGreaterThan(0);
        for (const { category, value } of framePoints) {
          expect(category).toBe("p95");
          expect(value).toBeGreaterThan(0);
        }
        // Reconnect: from the page observing its scene socket drop to the next ready scene.
        const reconnectMs = await yard.evaluate(
          () =>
            new Promise((resolve) => {
              const session = globalThis.yardSession;
              let dropped;
              const stop = session.subscribe(() => {
                if (session.getSnapshot().status !== "ready") dropped ??= performance.now();
                else if (dropped !== undefined) {
                  stop();
                  resolve(performance.now() - dropped);
                }
              });
              globalThis.yardCurrentSocket.close();
            }),
        );
        const measured = {
          textureBytes: runtime.textureBytes,
          firstSceneRenderMs: runtime.firstRenderMs,
          frameTimeMs: frames[Math.floor(frames.length * 0.95)],
          entityCount: runtime.entityCount,
          patchApplicationMs: runtime.patchMs,
          reconnectMs,
        };
        console.log(`scene runtime budgets measured: ${JSON.stringify(measured)}`);
        expect([runtime.entityCount, frames.length > 0]).toEqual([placed.length, true]);
        for (const [name, value] of Object.entries(measured))
          expect([name, value <= budgets[name].limit]).toEqual([name, true]);
        // Wheel zoom stops at its bounds and dragging never pans the view out of its bounds.
        const mouse = kin.viewer;
        const camera = () =>
          mouse.evaluate(() => {
            const view = globalThis.yardAdapter.stage.cameras.main;
            const [bounds, seen] = [view.getBounds(), view.worldView];
            return [
              view.rotation,
              view.zoom,
              seen.left >= bounds.left - 0.01 &&
                seen.right <= bounds.right + 0.01 &&
                seen.top >= bounds.top - 0.01 &&
                seen.bottom <= bounds.bottom + 0.01,
              view.scrollX,
            ];
          });
        await mouse.locator("canvas").scrollIntoViewIfNeeded();
        const canvasBox = await mouse.locator("canvas").boundingBox();
        const middle = [canvasBox.x + 320, canvasBox.y + 200];
        await mouse.mouse.move(...middle);
        for (const [delta, zoom] of [
          [-100, 2],
          [100, 0.75],
        ]) {
          for (let step = 0; step < 16; step += 1) await mouse.mouse.wheel(0, delta);
          await expect.poll(async () => (await camera()).slice(0, 3)).toEqual([0, zoom, true]);
        }
        const panned = (await camera())[3];
        await mouse.mouse.move(...middle);
        await mouse.mouse.down();
        await mouse.mouse.move(middle[0] - 300, middle[1] - 180, { steps: 8 });
        await mouse.mouse.up();
        const [, , inside, scrolled] = await camera();
        expect([inside, scrolled > panned]).toEqual([true, true]);
        expect((await drawnState()).reducedMotion).toBe(true);
        // Touch taps on overlapping sprites cycle through them in pick order (§4.4), at zoom 1.
        await yard.evaluate((centre) => {
          const camera = globalThis.yardAdapter.stage.cameras.main;
          camera.setZoom(1);
          camera.centerOn(...centre);
        }, isoCentre(golden));
        await yard.locator("canvas").scrollIntoViewIfNeeded();
        const touchBox = await yard.locator("canvas").boundingBox();
        const den = isoPoint(golden, "grove.den");
        const [cx, cy] = isoCentre(golden);
        const tapped = placed
          .filter((entity) => {
            const at = isoPoint(golden, entity.objectId);
            return Math.hypot(at.x - den.x, at.y - den.y) <= 24;
          })
          .map((entity) => entity.objectId);
        expect(tapped.length).toBeGreaterThan(2);
        const pressed = yard
          .getByRole("region", { name: "Living scene" })
          .getByRole("listitem")
          .getByRole("button", { pressed: true });
        for (const objectId of [...tapped, tapped[0]]) {
          await yard.touchscreen.tap(touchBox.x + den.x - cx + 320, touchBox.y + den.y - cy + 200);
          await expect.poll(() => pressed.textContent()).toBe(objectId);
        }
        // Reduced motion snaps a short committed move, and a cue draws once per dedupe key.
        const moved = await yard.evaluate(() => {
          const adapter = globalThis.yardAdapter;
          const committed = globalThis.yardSession.getSnapshot().projection;
          const [entity] = committed.entities;
          const step = {
            ...entity,
            pose: {
              ...entity.pose,
              coordinates: entity.pose.coordinates.map((value, index) =>
                index === 0 ? String(BigInt(value) + 1000n) : value,
              ),
            },
          };
          // The real Phaser bridge's applyPatch applies the next contiguous patch and ignores a stale one.
          const patch = {
            fromRevision: committed.revision,
            toRevision: committed.revision + 1n,
            operations: [{ op: "upsert_entity", entity: step }],
            sourceEventIds: [],
            audienceHash: committed.audienceHash,
          };
          const before = adapter.drawn.get(entity.objectId).body.x;
          adapter.applyPatch(patch);
          const patchedX = adapter.drawn.get(entity.objectId).body.x;
          adapter.applyPatch({ ...patch, operations: [{ op: "upsert_entity", entity }] });
          const offset = (x) => Math.round((x - before) * 1000) / 1000;
          const patched = [
            String(adapter.projection.revision) === String(committed.revision + 1n),
            offset(patchedX),
            offset(adapter.drawn.get(entity.objectId).body.x),
          ];
          const cue = {
            kind: "emote",
            objectId: entity.objectId,
            reference: "wave",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            dedupeKey: "cue-1",
          };
          adapter.emitCue(cue);
          adapter.emitCue(cue);
          const body = adapter.drawn.get(entity.objectId).body;
          const result = [
            patched,
            adapter.stage.tweens.getTweensOf(body).length,
            adapter.stage.children.list.filter((child) => child.name === "cue").length,
          ];
          adapter.loadSnapshot(committed);
          return result;
        });
        // One metre east of a 2:1 isometric view is 12.5 px right on screen.
        expect(moved).toEqual([[true, 12.5, 12.5], 0, 1]);
        // §17: the second cue with the same dedupe key is one dropped_cues:duplicate point.
        expect(
          await yard.evaluate(() =>
            globalThis.yardMeasurements
              .points()
              .filter(({ name }) => name === "dropped_cues")
              .map(({ category, value }) => [category, value]),
          ),
        ).toEqual([["duplicate", 1]]);
        // Without reduced motion a one-metre move interpolates and a 20 m move snaps.
        const interpolated = await kin.viewer.evaluate(async () => {
          const adapter = globalThis.yardAdapter;
          const committed = globalThis.yardSession.getSnapshot().projection;
          const [entity] = committed.entities;
          const shifted = (metres) => ({
            ...committed,
            entities: [
              {
                ...entity,
                pose: {
                  ...entity.pose,
                  coordinates: entity.pose.coordinates.map((value, index) =>
                    index === 0 ? String(BigInt(value) + BigInt(metres) * 1000n) : value,
                  ),
                },
              },
              ...committed.entities.slice(1),
            ],
          });
          const body = adapter.drawn.get(entity.objectId).body;
          const start = body.x;
          adapter.loadSnapshot(shifted(1));
          const tweening = [adapter.stage.tweens.getTweensOf(body).length, body.x];
          await new Promise((resolve) => setTimeout(resolve, 600));
          const settled = body.x;
          adapter.loadSnapshot(shifted(21));
          const snapped = [adapter.stage.tweens.getTweensOf(body).length, body.x];
          adapter.loadSnapshot(committed);
          return [start, tweening, settled, snapped];
        });
        const [start, [tweens, during], settled, [snapTweens, snapped]] = interpolated;
        expect([tweens, during < settled, settled - start, snapTweens, snapped - start]).toEqual([
          1,
          true,
          12.5,
          0,
          21 * 12.5,
        ]);
        // Context loss falls back to the text path; the committed projection is unchanged.
        const heldBefore = await touch.held();
        const released = () =>
          yard.evaluate(() => {
            const parent = document.querySelector(".rw-canvas");
            for (const type of ["pointerdown", "pointerover"])
              parent.dispatchEvent(new PointerEvent(type, { bubbles: true }));
            globalThis.dispatchEvent(new Event("scroll"));
            return [
              globalThis.yardTextures.exists("raccoon-world"),
              parent.contains(globalThis.yardCanvas),
              globalThis.yardBoundsReads > 0,
            ];
          });
        await yard.evaluate(() => {
          const game = globalThis.yardGame;
          globalThis.yardTextures = game.textures;
          globalThis.yardCanvas = game.canvas;
          globalThis.yardBoundsReads = 0;
          const update = game.scale.updateBounds.bind(game.scale);
          game.scale.updateBounds = () => {
            globalThis.yardBoundsReads += 1;
            update();
          };
        });
        // Before the loss the atlas is loaded, the canvas attached and its listeners live.
        expect(await released()).toEqual([true, true, true]);
        await yard.evaluate(() => {
          globalThis.yardBoundsReads = 0;
          globalThis.yardGame.renderer.gl.getExtension("WEBGL_lose_context").loseContext();
        });
        await yard
          .getByText("Canvas unavailable. The complete scene is available below.", { exact: true })
          .waitFor();
        await expect.poll(() => yard.locator("canvas").count()).toBe(0);
        expect([
          await touch.held(),
          await yard.evaluate(() => globalThis.yardSession.getSnapshot().status),
          // Released: the atlas texture is gone, the canvas is detached and the parent's and
          // window's bounds listeners no longer fire.
          await released(),
        ]).toEqual([heldBefore, "ready", [false, false, false]]);
        // §16 React error boundary: a throwing yard component leaves a focused, announced error
        // screen, not a blank page, recorded only as client_errors:shell; Reload recovers.
        await yard.evaluate(() => {
          globalThis.yardThrowRender = true;
        });
        await yard
          .getByRole("region", { name: "Living scene" })
          .getByRole("listitem")
          .getByRole("button", { pressed: false })
          .first()
          .click();
        const stopped = yard.getByRole("region", { name: "Raccoon World stopped" });
        await stopped.waitFor();
        expect([
          await stopped.getByRole("alert").textContent(),
          await stopped.evaluate((section) => section === document.activeElement),
          await yard.getByRole("region", { name: "Living scene" }).count(),
          await yard.evaluate(
            () =>
              globalThis.yardMeasurements
                .points()
                .filter(({ name, category }) => `${name}:${category}` === "client_errors:shell")
                .length,
          ),
        ]).toEqual([
          "The view stopped after an error. The world is unchanged. Reload to observe it again.",
          true,
          0,
          1,
        ]);
        // Reload starts a fresh client: the shell's sign-in is back, with the world route kept.
        await stopped.getByRole("button", { name: "Reload", exact: true }).click();
        await yard.getByLabel("Local session credential").waitFor();
        expect(new URL(yard.url()).pathname).toBe(routeOf(auth.scope));
        await yard.context().close();
        await expect.poll(async () => (await attachments(auth.scope)).length).toBe(attached);
        // A narrowed grant forces a snapshot; nothing of the prior audience stays in memory or DOM.
        await truth(
          `UPDATE clockgrove.world_memberships SET privacy_ceiling='{"version":1,"allowedCategories":["public_scene"]}' WHERE principal_id='principal-runtime'`,
        );
        await commit({
          ...advanceCommand(world, "command-yard-audience", 0n, null),
          type: "world.weather.set",
          payload: { schemaVersion: 2, rainIntensity: 3000 },
        });
        for (const target of [kin, stranger])
          await target.viewer.getByText("Rain intensity: 3000", { exact: true }).waitFor();
        expect([
          await kin.memories().count(),
          (await kin.held()).includes("scripted:"),
          kin.frames.at(-1).includes('"type":"snapshot"'),
        ]).toEqual([0, false, true]);
        // issue 21: once PostgreSQL's weather is dry the puddles clear, and once its clock passes
        // 06:00 the lights go out; when it rains again by day, puddles form with the lights off.
        // The text path says the same.
        const kinScene = kin.viewer.getByRole("region", { name: "Living scene" });
        await commit({
          ...advanceCommand(world, "command-yard-dry", 0n, null),
          type: "world.weather.set",
          payload: { schemaVersion: 2, rainIntensity: 0 },
        });
        await kinScene.getByText("Puddles: none", { exact: true }).waitFor();
        await expect.poll(() => shownRoles(kin.viewer)).toBe("lantern,window");
        const night = BigInt((await durable()).split("|")[1]);
        const daybreak = night - (night % 86_400_000n) + 25_200_000n;
        await commit(advanceCommand(world, "command-yard-daybreak", daybreak, null));
        expect((await durable()).split("|")[1]).toBe(daybreak.toString());
        await kinScene.getByText("Lights: off", { exact: true }).waitFor();
        await expect.poll(() => shownRoles(kin.viewer)).toBe("");
        await commit({
          ...advanceCommand(world, "command-yard-rain-again", 0n, null),
          type: "world.weather.set",
          payload: { schemaVersion: 2, rainIntensity: 3000 },
        });
        await kinScene
          .getByText(`Puddles: ${(await puddleSites()).length}`, { exact: true })
          .waitFor();
        await expect.poll(() => shownRoles(kin.viewer)).toBe("puddle");

        // issue 816: viewing nested regions and following Stevie is a read through the one scene
        // socket; only the typed movement command moves him, and every disposition is shown.
        const living = kin.viewer.getByRole("region", { name: "Living scene" });
        const places = living.getByRole("navigation", { name: "Places" });
        const notice = places.getByRole("status");
        const stevie = living.getByRole("button", { name: "grove.stevie", exact: true });
        const navigationAuth = livingYardAuthentication(provisioned);
        worker = new RuntimeWorker(navigationAuth.authenticator, bindings, observerLogger);
        const facts = async () => [await durable(), await commands()];
        const sceneSockets = () =>
          kin.sockets.filter((socket) => new URL(socket.url()).pathname === "/v1/projection");
        const rendered = () =>
          kin.viewer.evaluate(() => [
            globalThis.yardRendererPresentInvoked,
            globalThis.yardDrawnRevision ?? null,
          ]);
        // Each click is a read: no world fact, scene socket or renderer call changes.
        const view = async (place, expected) => {
          const before = await facts();
          const socketsBefore = sceneSockets();
          await kin.viewer.evaluate(() => {
            globalThis.yardRendererPresentInvoked = false;
          });
          const drawn = (await rendered())[1];
          await places.getByRole("button", { name: `View ${place}`, exact: true }).click();
          await expect.poll(() => notice.textContent()).toBe(expected);
          expect(await facts()).toEqual(before);
          expect(sceneSockets()).toEqual(socketsBefore);
          expect(socketsBefore.map((socket) => socket.isClosed())).toEqual([false]);
          expect(await rendered()).toEqual([false, drawn]);
        };
        const cleared = async () => {
          expect(await stevie.getAttribute("aria-pressed")).toBe("false");
          expect(
            await kin.viewer.evaluate(() => {
              const session = globalThis.yardSession;
              return [
                session.getSelectionSnapshot(),
                session.queries
                  .getQueryCache()
                  .findAll({ queryKey: ["living-yard", "entity"] })
                  .filter((query) => query.state.data !== undefined).length,
              ];
            }),
          ).toEqual([{ objectId: undefined, status: "none", value: undefined }, 0]);
          expect(
            await kin.viewer.getByRole("region", { name: "Entity rail" }).locator("dl").count(),
          ).toBe(0);
        };
        expect(await places.getByRole("button").allTextContents()).toEqual([
          `View ${auth.scope.spaceId}`,
          ...[
            "cedar-area",
            "den",
            "garden",
            "green-lake-neighborhood",
            "living-yard",
            "porch",
            "snack-house",
            "street-buffer",
          ].map((region) => `View ${region}`),
        ]);
        // issue 20: Stevie, standing on the trash can his food routine targets, plays the eat strip.
        // Since the dry spell above, Gracie and the kit have left shelter for food.
        await expect
          .poll(() => activity(kin.viewer))
          .toEqual([
            ["gracie/eat", "seek-food", null],
            ["kit/eat", "seek-food", "completed"],
            ["stevie/eat", "seek-food", null],
          ]);
        await stevie.click();
        await view(
          "snack-house",
          `grove.stevie is not within snack-house; the view stayed on ${auth.scope.spaceId}.`,
        );
        expect(await stevie.getAttribute("aria-pressed")).toBe("true");
        await commit({
          ...advanceCommand(
            world,
            "command-yard-follow",
            0n,
            BigInt((await durable()).split("|")[0]),
          ),
          type: "movement.start",
          payload: {
            schemaVersion: 1,
            objectId: "grove.stevie",
            destination: {
              kind: "pose",
              pose: { frameId: "frame-grove", frameVersion: 1, coordinates: [33000n, 13000n] },
            },
            unitsPerSecond: 1000n,
          },
        });
        await living.getByText(/^ Identity: grove\.stevie;.*position: 33000, 13000$/u).waitFor();
        // issue 20: moved off the trash can his food routine targets, Stevie forages (sniffs).
        await expect
          .poll(() => activity(kin.viewer))
          .toEqual([
            ["gracie/eat", "seek-food", null],
            ["kit/eat", "seek-food", "completed"],
            ["stevie/sniff", "seek-food", "completed"],
          ]);
        // issue 21: Stevie moved while the committed rain still falls, and the puddles still lie.
        expect([
          await living.getByText("Rain intensity: 3000", { exact: true }).count(),
          await shownRoles(kin.viewer),
        ]).toEqual([1, "puddle"]);
        await view("snack-house", "Followed grove.stevie to snack-house.");
        expect([
          await stevie.getAttribute("aria-pressed"),
          await places.getByText("Viewing: snack-house").count(),
        ]).toEqual(["true", 1]);
        await view(
          "living-yard",
          "grove.stevie is not within living-yard; the view stayed on snack-house.",
        );
        // Refusals the yard's topology cannot produce here are the runtime's own answers, replayed.
        for (const [disposition, place, expected] of [
          ["target_hidden", "den", "The selected entity is hidden in den. Selection cleared."],
          ["unavailable", "porch", "porch is unavailable. Selection cleared."],
        ]) {
          await kin.viewer.route("**/v1/runtime/viewed-space", (route) =>
            route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({ requestId: "replayed", disposition, selectedEntityId: null }),
            }),
          );
          await stevie.click();
          await view(place, expected);
          await cleared();
          await kin.viewer.unroute("**/v1/runtime/viewed-space");
        }
        // A server failure decided nothing: the selection stays and the notice says it failed.
        await kin.viewer.route("**/v1/runtime/viewed-space", (route) =>
          route.fulfill({ status: 503, contentType: "application/json", body: "{}" }),
        );
        await stevie.click();
        await view("den", "The request to view den failed; nothing changed.");
        expect(await stevie.getAttribute("aria-pressed")).toBe("true");
        await kin.viewer.unroute("**/v1/runtime/viewed-space");
        navigationAuth.revoke();
        await view("garden", "Viewing garden is not permitted. Selection cleared.");
        await cleared();
        // One scene socket was ever opened, and it is still the one open; Vite's HMR socket is not one.
        const scenes = sceneSockets();
        expect([scenes.length, scenes.filter((socket) => !socket.isClosed()).length]).toEqual([
          1, 1,
        ]);
      } finally {
        try {
          await browser?.close();
        } finally {
          await server.close();
        }
      }
    });
  });
}, 240_000);
