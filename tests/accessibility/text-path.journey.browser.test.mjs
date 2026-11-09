import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
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
import { decodeLivingScene, decodeWorldStatus } from "../../packages/contracts/src/index.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(import.meta.url);

// issue 812: every Wave 4 journey through the text path alone, with WebGL disabled and no renderer.
it("completes every Wave 4 journey without the canvas", async () => {
  if (!isNativeWorldOwnerChild()) {
    await runNativeWorldOwnerProcess(
      "tests/accessibility/text-path.journey.browser.test.mjs",
      "fixture/reference",
      {
        vitestConfig: "tests/ci/vitest.browser.config.ts",
        timeoutMs: 150_000,
        inheritOutput: true,
        prepare: (fixture) =>
          truthOf(fixture)(
            `UPDATE clockgrove.world_memberships SET grants=ARRAY['runtime:world-observe','runtime:world-command'] WHERE principal_id='principal-runtime';
          UPDATE clockgrove_auth.session SET token='hall-inspect' WHERE token='local-reader-session'`,
          ),
      },
    );
    return;
  }
  await withNativeWorldOwner(async (native) => {
    const { fixture, world } = native;
    const provisioned = await provisionTestWorld(fixture, world, "principal-runtime");
    const scope = { ...provisioned.partition.target, spaceId: provisioned.partition.route.spaceId };
    const truth = truthOf(fixture);
    const revision = async () =>
      truth(
        `SELECT revision FROM clockgrove.partition_states WHERE partition_id = '${provisioned.partition.route.partitionId}'`,
      );
    const read = async (endpoint, decode) =>
      decode((await native.request(endpoint, { version: 1, ...scope }, "hall-inspect")).body);
    const commit = async (key, type, payload, expected = null) => {
      const { status, body } = await native.submit(
        { ...advanceCommand(world, key, 0n, expected), type, payload },
        {},
        "hall-inspect",
      );
      expect(status, JSON.stringify(body)).toBe(200);
    };
    const walk = async (key, x, y) =>
      commit(
        key,
        "movement.start",
        {
          schemaVersion: 1,
          objectId: "fixture.keeper",
          destination: {
            kind: "pose",
            pose: { frameId: "frame-grove", frameVersion: 1, coordinates: [x, y] },
          },
          unitsPerSecond: 1000n,
        },
        BigInt(await revision()),
      );
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
          // §17: the bounded client measurement ring, read to assert the Influence outcome point.
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
      browser = await chromium.launch({
        headless: true,
        args: ["--disable-webgl", "--disable-webgl2", "--disable-blink-features=WebGPU"],
      });
      const { port } = server.httpServer.address();
      // WebGL2 unavailable with the renderer loaded: the complete text scene remains ready.
      const probe = await browser.newPage();
      const rendererErrors = [];
      probe.on("pageerror", (error) => rendererErrors.push(error.message));
      await probe.goto(`http://127.0.0.1:${port}/`);
      await probe.getByLabel("Local session credential").fill("hall-inspect");
      await probe.getByRole("button", { name: "Sign in", exact: true }).click();
      await probe
        .getByLabel("World", { exact: true })
        .selectOption({ label: `${scope.worldId} / ${scope.spaceId}` });
      await probe.getByText(/^Arrival: text scene ready at revision /u).waitFor();
      expect([
        await probe.getByText(/^Arrival: /u).textContent(),
        await probe.evaluate(() => document.createElement("canvas").getContext("webgl") === null),
        await probe.locator("canvas").count(),
        await probe.getByRole("region", { name: "Living scene" }).count(),
      ]).toEqual([
        `Arrival: text scene ready at revision ${(await read("/v1/runtime/scene", decodeLivingScene)).revision}; renderer unavailable.`,
        true,
        0,
        1,
      ]);
      expect(rendererErrors).toEqual([]);
      await probe.close();
      const page = await browser.newPage({ reducedMotion: "reduce" });
      await page.addInitScript(() => {
        globalThis.WebSocket = class extends WebSocket {
          constructor(...args) {
            super(...args);
            if (new URL(this.url).pathname === "/v1/projection") globalThis.hallSceneSocket = this;
          }
        };
      });
      const sockets = [];
      page.on("websocket", (socket) => {
        if (new URL(socket.url()).pathname === "/v1/projection") sockets.push(socket);
      });
      // The renderer never loads, so the whole journey runs with no canvas at all (§16).
      await page.route(
        (url) => url.pathname === "/src/renderer.ts",
        (route) => route.abort(),
      );
      const report = [];
      const axe = async () => {
        await page.addScriptTag({
          content: await readFile(require.resolve("axe-core/axe.min.js"), "utf8"),
        });
        const result = await page.evaluate(() => globalThis.axe.run());
        // The §19 accessibility report: each axe run's rule outcomes, for qualify:wave4.
        report.push({
          step: report.length + 1,
          viewport: page.viewportSize(),
          violations: result.violations.map((v) => v.id),
          passes: result.passes.length,
          incomplete: result.incomplete.map((v) => v.id),
        });
        return result.violations.map((v) => v.id);
      };
      const focusedKey = () =>
        page.evaluate(() => {
          const active = document.activeElement;
          return active?.dataset.focusKey || active?.id || active?.textContent;
        });

      // Observe: the text scene arrives as text_ready and summarizes space, weather and entities.
      await page.goto(`http://127.0.0.1:${port}/`);
      expect(
        await page.evaluate(() => document.createElement("canvas").getContext("webgl") === null),
      ).toBe(true);
      await page.getByLabel("Local session credential").fill("hall-inspect");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page
        .getByLabel("World", { exact: true })
        .selectOption({ label: `${scope.worldId} / ${scope.spaceId}` });
      const arrived = await read("/v1/runtime/scene", decodeLivingScene);
      await page
        .getByText(
          `Arrival: text scene ready at revision ${arrived.revision}; renderer unavailable.`,
          { exact: true },
        )
        .waitFor();
      const scene = page.getByRole("region", { name: "Living scene" });
      await scene
        .getByText(
          `Space summary: ${scope.worldId}, space ${scope.spaceId}, viewing ${scope.spaceId}. Weather: Dry. ${arrived.entities.length} perceivable entities.`,
          { exact: true },
        )
        .waitFor();
      expect(await page.locator("canvas").count()).toBe(0);
      // Each entity lists the server's interaction summary for it (issue 811's journey).
      const row = (objectId) =>
        scene.getByRole("listitem").filter({ hasText: `Identity: ${objectId};` });
      expect(await row("fixture.den").locator("span").nth(1).textContent()).toBe(
        "; Interactions: inspectable, Inspection from world evidence; available actions Inspect, History",
      );
      expect(await row("fixture.water-bowl").locator("span").nth(1).textContent()).toBe(
        "; Interactions: reactive, Deterministic/reactive object; available actions Inspect, History, Influence",
      );
      expect(await axe()).toEqual([]);

      // Select: arrow keys, Home and End move between entities; Enter selects and is announced.
      // The list is in the canvas's pick order, so keys follow the listed order.
      const entities = await scene
        .locator('[data-focus-key^="entity:"]')
        .evaluateAll((buttons) => buttons.map((button) => button.dataset.focusKey));
      expect([...entities].sort()).toEqual(
        arrived.entities.map((entity) => `entity:${entity.objectId}`).sort(),
      );
      await scene.locator(`[data-focus-key="${entities[0]}"]`).focus();
      await page.keyboard.press("ArrowDown");
      expect(await focusedKey()).toBe(entities[1]);
      await page.keyboard.press("End");
      expect(await focusedKey()).toBe(entities.at(-1));
      await page.keyboard.press("ArrowUp");
      expect(await focusedKey()).toBe(entities.at(-2));
      await page.keyboard.press("Home");
      expect(await focusedKey()).toBe(entities[0]);
      while ((await focusedKey()) !== "entity:fixture.water-bowl")
        await page.keyboard.press("ArrowRight");
      await page.keyboard.press("Enter");
      const selected = page.getByRole("region", { name: "Selected entity", exact: true });
      await selected
        .getByRole("status")
        .getByText(`Selected entity at canonical revision ${arrived.revision},`)
        .waitFor();

      // Inspect moves focus to the inspected state; Influence proposes and shows its receipt.
      const card = page.getByRole("region", { name: "Interactions" });
      await card.getByRole("button", { name: "Inspect", exact: true }).press("Enter");
      expect(await focusedKey()).toBe("rw-selected-entity");
      const receipts = "SELECT count(*) FROM clockgrove.command_receipts";
      const before = await truth(receipts);
      await card.getByRole("button", { name: /^Offer 1 water/u }).press("Enter");
      const stages = card.getByRole("list", { name: "Influence stages" }).locator("li");
      await stages.nth(3).waitFor();
      const committed = await revision();
      expect([
        await card.getByRole("list", { name: "Influence stages" }).locator("li").allTextContents(),
        await truth(receipts),
        await truth(
          "SELECT status || ' ' || (attribution->>'personaId') FROM clockgrove.command_receipts WHERE command_id LIKE 'influence:principal-runtime:%'",
        ),
      ]).toEqual([
        [
          "Proposed: offer submitted",
          "Accepted by the world",
          `Committed at revision ${committed}`,
          "Consequence: resource.offered",
        ],
        String(Number(before) + 1),
        "committed persona-runtime",
      ]);
      // §17: the one committed receipt is one interaction_outcome:accepted point.
      expect(
        await page.evaluate(() =>
          globalThis.hallMeasurements
            .points()
            .filter(({ name }) => name === "interaction_outcome")
            .map(({ category, value }) => [category, value]),
        ),
      ).toEqual([["accepted", 1]]);

      // Live changes: movement, weather and material events, at most one announcement per 3 s.
      await page.evaluate(() => {
        globalThis.hallLogged = [];
        globalThis.hallObservationAnnouncements = [];
        const observation = document.querySelector("#rw-observation-announcement");
        let previous = observation.textContent;
        new MutationObserver(() => {
          if (observation.textContent === previous) return;
          previous = observation.textContent;
          globalThis.hallObservationAnnouncements.push([Date.now(), previous]);
        }).observe(observation, { childList: true, characterData: true, subtree: true });
        new MutationObserver((records) => {
          for (const record of records)
            for (const node of record.addedNodes)
              if (node.textContent !== "No changes since arrival.")
                globalThis.hallLogged.push([Date.now(), node.textContent]);
        }).observe(document.querySelector('[role="log"]'), { childList: true });
      });
      const currentObservation = async () => {
        const committed = await read("/v1/runtime/scene", decodeLivingScene);
        await expect
          .poll(() => page.locator("#rw-observation-status").textContent())
          .toContain(
            `Observing revision ${committed.revision}. Canonical time ${committed.simulationTime}. Rain intensity ${committed.weather.rainIntensity}.`,
          );
        expect(await page.locator("#rw-arrival-status").textContent()).toContain(
          `revision ${committed.revision};`,
        );
        expect(
          await page
            .locator("#rw-observation-status .rw-observation-details")
            .evaluate((details) => details.closest('[aria-live], [role="status"]') === null),
        ).toBe(true);
        expect(await page.locator("#rw-observation-announcement").textContent()).not.toContain(
          "fixture.keeper",
        );
        expect(await page.getByText(/^Observation: /u).count()).toBe(1);
        return committed.revision;
      };
      await commit("text-rain", "world.weather.set", { schemaVersion: 2, rainIntensity: 1000 });
      const rainRevision = await currentObservation();
      await expect
        .poll(() => page.locator("#rw-observation-announcement").textContent())
        .toContain(`Revision ${rainRevision}.`);
      // The storm and the walk follow the first announcement, so they land in a later interval.
      await expect.poll(() => page.evaluate(() => globalThis.hallLogged.length)).toBe(1);
      await commit("text-storm", "world.weather.set", { schemaVersion: 2, rainIntensity: 2000 });
      await currentObservation();
      await walk("text-walk", 33000n, 13000n);
      await currentObservation();
      const latest = await revision();
      await expect
        .poll(() => page.locator("#rw-observation-announcement").textContent())
        .toContain(`Revision ${latest}.`);
      const announcements = await page.evaluate(() => globalThis.hallObservationAnnouncements);
      expect(announcements.length).toBeGreaterThanOrEqual(2);
      expect(announcements.slice(1).every(([at], i) => at - announcements[i][0] >= 3000)).toBe(
        true,
      );
      const status = await read("/v1/runtime/world-status", decodeWorldStatus);
      expect(status.revision).toBe(latest);
      const logged = async () =>
        (await page.evaluate(() => globalThis.hallLogged)).map(([, t]) => t);
      await expect
        .poll(async () => (await logged()).join(" "))
        .toContain("fixture.keeper moved to 33000, 13000");
      const log = await page.evaluate(() => globalThis.hallLogged);
      // The rain is announced alone, and the storm and walk at least one interval later.
      expect(log.length).toBeGreaterThanOrEqual(2);
      // 100 ms below the 3 s bound absorbs render delay between a commit and its DOM addition.
      expect(log.slice(1).every(([at], i) => at - log[i][0] >= 2_900)).toBe(true);
      expect(log.map(([, text]) => text).join(" ")).toContain("Weather now Rain 20%");
      for (const item of status.feed.filter((entry) => entry.category === "weather"))
        expect(log.map(([, text]) => text).join(" ")).toContain(item.text);

      // Timeline: metadata, a branch placeholder, and stepping through events into history and Why.
      const timeline = page.getByRole("region", { name: "Timeline" });
      await timeline.getByRole("definition").nth(1).getByText(latest, { exact: true }).waitFor();
      expect(await timeline.getByRole("definition").allTextContents()).toEqual([
        scope.timelineId,
        latest,
        status.clock.simulationTime,
        `${status.clock.runState === "running" ? "Running" : "Paused"}, speed ×${status.clock.speed}`,
        "No branches shown. Branching is not available yet.",
      ]);
      const stepText = () => timeline.locator("#rw-timeline-event").textContent();
      // The browser's own status read follows the scene revision within its 1 s interval.
      await expect
        .poll(stepText)
        .toMatch(
          `Event ${status.feed.length} of ${status.feed.length}: Movement; ${status.feed[0].text}; `,
        );
      expect([status.feed[0].category, status.feed[0].objectId]).toEqual([
        "movement",
        "fixture.keeper",
      ]);
      const earlier = timeline.getByRole("button", { name: "Earlier event", exact: true });
      await earlier.press("Enter");
      expect(await stepText()).toMatch(new RegExp(`^Event ${status.feed.length - 1} of `, "u"));
      // Only the step is announced; the event line itself is not a live region.
      expect(await timeline.locator("p[aria-live]").textContent()).toBe(await stepText());
      while ((await earlier.getAttribute("aria-disabled")) !== "true") await earlier.press("Enter");
      expect([await stepText(), await focusedKey()]).toEqual([
        expect.stringMatching(/^Event 1 of /u),
        "rw-timeline-earlier",
      ]);
      const later = timeline.getByRole("button", { name: "Later event", exact: true });
      while (
        !(await timeline
          .getByRole("button", { name: "Open history of fixture.water-bowl" })
          .count())
      )
        await later.press("Enter");
      await timeline
        .getByRole("button", { name: "Open history of fixture.water-bowl" })
        .press("Enter");
      await expect.poll(focusedKey).toBe("rw-recent-actions");
      const why = timeline.getByRole("button", { name: /^Why event / });
      await why.press("Enter");
      const whyPanel = page.getByRole("region", { name: "Recorded Why" });
      await whyPanel.getByText("Recorded evidence loaded.", { exact: true }).waitFor();
      await whyPanel.getByRole("button", { name: "Close Why", exact: true }).press("Enter");
      expect(await focusedKey()).toBe(await why.textContent());

      // Reconnect: the transport drops and resumes, and focus stays on the same entity control.
      await scene.getByRole("button", { name: "fixture.keeper", exact: true }).focus();
      await page.evaluate(() => globalThis.hallSceneSocket.close());
      await expect.poll(() => sockets.length).toBe(2);
      await expect
        .poll(() => page.locator("#rw-observation-status").textContent())
        .toMatch(/^Observation: ready\. Observing revision /u);
      expect(await focusedKey()).toBe("entity:fixture.keeper");

      // Reduced motion: nothing in the shell animates or transitions.
      expect(
        await page.evaluate(() => [
          matchMedia("(prefers-reduced-motion: reduce)").matches,
          [...document.querySelectorAll(".rw-shell, .rw-shell *")].filter((element) => {
            const style = getComputedStyle(element);
            return (
              style.animationName !== "none" ||
              style.transitionDuration.split(", ").some((d) => d !== "0s")
            );
          }).length,
        ]),
      ).toEqual([true, 0]);
      // High zoom: 1280 px at 400% is 320 CSS px (WCAG 1.4.10), with text at 200% (WCAG 1.4.4).
      await page.setViewportSize({ width: 320, height: 720 });
      await page.evaluate(() => {
        document.documentElement.style.fontSize = "200%";
      });
      expect(
        await page.evaluate(() => {
          const scroller = document.scrollingElement;
          return scroller.scrollWidth <= scroller.clientWidth;
        }),
      ).toBe(true);
      const box = await scene
        .getByRole("button", { name: "fixture.keeper", exact: true })
        .boundingBox();
      expect(box.x >= 0 && box.x + box.width <= 320).toBe(true);
      expect(await axe()).toEqual([]);
      const evidence = process.env.CLOCKGROVE_WAVE4_EVIDENCE;
      if (evidence)
        await writeFile(
          path.join(evidence, "accessibility-report.json"),
          `${JSON.stringify({ axeVersion: require("axe-core/package.json").version, webgl: false, runs: report }, null, 2)}\n`,
        );
    } finally {
      await browser?.close();
      await server.close();
    }
  });
}, 180_000);
