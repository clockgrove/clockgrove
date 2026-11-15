import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import { advanceCommand, truthOf } from "../../apps/runtime/test/world-fixture.ts";
import {
  isNativeWorldOwnerChild,
  runNativeWorldOwnerProcess,
  withNativeWorldOwner,
} from "../../apps/runtime/test/world-owner/native-harness.ts";
import { createServer } from "../../apps/web/node_modules/vite/dist/node/index.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(import.meta.url);
const FILE = "tests/e2e/conversation-states.journey.browser.test.mjs";
const OFFER = "fixture:offer fixture.water-bowl water";
const BACKENDS = process.env.CLOCKGROVE_RENDERER_PROOF
  ? [process.env.CLOCKGROVE_RENDERER_PROOF]
  : ["webgpu", "webgl2"];
const ARGS = {
  webgpu: [
    "--enable-unsafe-webgpu",
    "--enable-unsafe-swiftshader",
    "--use-webgpu-adapter=swiftshader",
    "--use-angle=swiftshader",
    "--enable-features=Vulkan",
    "--use-vulkan=swiftshader",
  ],
  webgl2: [
    "--disable-blink-features=WebGPU",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
  ],
};
process.env.CLOCKGROVE_WORLD_SHELL = path.join(root, "worlds/fixture/reference/shell.json");

it("shows each turn state, cancels, retries a stale offer and opens run details", async () => {
  if (!isNativeWorldOwnerChild()) {
    for (const backend of BACKENDS) {
      process.env.CLOCKGROVE_RENDERER_PROOF = backend;
      await runNativeWorldOwnerProcess(FILE, "fixture/reference", {
        vitestConfig: "tests/ci/vitest.browser.config.ts",
        timeoutMs: 240000,
        inheritOutput: true,
        prepare: async (fixture) => {
          await truthOf(fixture)(
            `UPDATE clockgrove.world_memberships
                SET grants = ARRAY(SELECT DISTINCT unnest(grants || ARRAY['runtime:world-observe', 'runtime:world-command'])),
                    persona_id = 'persona-caretaker',
                    privacy_ceiling = '{"version":1,"allowedCategories":["public_scene","conversation"]}'`,
          );
        },
      });
    }
    return;
  }
  const backend = process.env.CLOCKGROVE_RENDERER_PROOF;
  await withNativeWorldOwner(async (native) => {
    const grant = (sql) =>
      native.sql(
        `UPDATE clockgrove.world_memberships SET grants=${sql} WHERE principal_id='principal-runtime'`,
      );
    await grant("grants||ARRAY['runtime:world-inspect']");
    const keeper = async (fields) => {
      const { status } = await native.request(
        "/actor-agent",
        { scope: native.scope, actorId: "fixture.keeper", ...fields },
        "local-reader-session",
      );
      expect(status).toBe(200);
    };
    const nativeOrigin = await native.origin();
    let browserOrigin = "";
    const server = await createServer({
      root: path.join(root, "apps/web"),
      configFile: path.join(root, "apps/web/vite.config.ts"),
      server: {
        host: "127.0.0.1",
        port: 0,
        proxy: {
          "/v1/projection": { target: nativeOrigin, ws: true },
          "/v1/runtime": {
            target: nativeOrigin,
            changeOrigin: true,
            configure(proxy) {
              proxy.on("proxyReq", (forwarded, incoming) => {
                if (incoming.headers.origin === browserOrigin)
                  forwarded.setHeader("origin", nativeOrigin);
              });
            },
          },
        },
      },
    });
    let browser;
    try {
      await server.listen();
      browserOrigin = `http://127.0.0.1:${server.httpServer.address().port}`;
      browser = await chromium.launch({ headless: true, args: ARGS[backend] });
      const page = await browser.newPage();
      const route = `/worlds/${Object.values(native.scope).map(encodeURIComponent).join("/")}`;
      const openTalk = async () => {
        await page.goto(`${browserOrigin}${route}`);
        await page.getByLabel("Local session credential").fill("local-reader-session");
        await page.getByRole("button", { name: "Sign in", exact: true }).click();
        await page.getByRole("button", { name: "fixture.keeper", exact: true }).press("Enter");
        await page.getByRole("button", { name: "Talk", exact: true }).click();
      };
      await openTalk();
      expect(await page.evaluate(() => "gpu" in navigator)).toBe(backend === "webgpu");
      await page.getByRole("button", { name: "New conversation", exact: true }).click();
      const panel = page.getByRole("region", { name: "Private conversation" });
      const history = page.getByRole("list", { name: "Conversation history" });
      const send = async (text) => {
        await page.getByLabel("Message Keeper…", { exact: true }).fill(text);
        await page.getByRole("button", { name: "Send", exact: true }).click();
      };
      const state = (label) => panel.getByText(label, { exact: true });
      const sessionId = () =>
        native.sql(
          "SELECT session_id FROM clockgrove.conversation_sessions ORDER BY created_at DESC LIMIT 1",
        );
      const phase = (id) =>
        native.sql(
          `SELECT phase FROM clockgrove.conversation_turn_fibers WHERE session_id='${id}' ORDER BY updated_at DESC LIMIT 1`,
        );
      const keeperRows = async (table, id) =>
        native.sql(
          `SELECT count(*) FROM clockgrove.${table} WHERE command_id LIKE 'keeper:%:${id}:%'`,
        );

      // 1. A held model turn shows Thinking while the scene stays usable; release completes it.
      await keeper({ op: "fault", phase: "hold:model_running:streaming" });
      await send("hello");
      await state("Thinking…").waitFor();
      const actor = page.getByRole("button", { name: "fixture.keeper", exact: true });
      expect(await actor.isEnabled()).toBe(true);
      await actor.focus();
      expect(await page.evaluate(() => document.activeElement?.textContent)).toContain(
        "fixture.keeper",
      );
      await keeper({ op: "release" });
      await keeper({ op: "fault", phase: null });
      await state("Completed").waitFor();
      await history.getByText(/Scripted fixture reply/u).waitFor();
      const id = await sessionId();

      // 2. Cancelling a turn held before it validates its proposal commits nothing.
      await keeper({ op: "fault", phase: "hold:proposal_validating" });
      await send(OFFER);
      await expect.poll(() => phase(id)).toBe("proposal_validating");
      await page.getByRole("button", { name: "Cancel turn", exact: true }).click();
      await state("Cancelled").waitFor();
      await keeper({ op: "release" });
      await keeper({ op: "fault", phase: null });
      await expect
        .poll(() =>
          native.sql(
            `SELECT string_agg(status||'/'||outcome_code, ',' ORDER BY started_at) FROM clockgrove.agent_runs WHERE session_id='${id}' AND status<>'completed'`,
          ),
        )
        .toBe("cancelled/cancel_requested");
      expect(await keeperRows("command_receipts", id)).toBe("0");
      expect(await keeperRows("events", id)).toBe("0");

      // 3. A world change during a held offer refuses it as stale; Retry reaches the closed world.
      await keeper({ op: "fault", phase: "hold:proposal_validating" });
      await send(OFFER);
      await expect.poll(() => phase(id)).toBe("proposal_validating");
      const time = BigInt(
        await native.sql("SELECT simulation_time::text FROM clockgrove.partition_states"),
      );
      const advanced = await native.submit(
        advanceCommand(native.world, `journey-advance-${backend}`, time + 1000n, null),
      );
      expect(advanced.status).toBe(200);
      await keeper({ op: "release" });
      await keeper({ op: "fault", phase: null });
      await panel
        .getByText("The world changed while this turn ran, so nothing was changed.", {
          exact: true,
        })
        .waitFor();
      expect(await keeperRows("command_receipts", id)).toBe("0");
      await panel
        .getByRole("button", { name: "Retry against the current world", exact: true })
        .click();
      await history
        .getByText("refused: World command refused: precondition_failed", { exact: false })
        .waitFor();
      await state("Completed").waitFor();
      expect(await keeperRows("command_receipts", id)).toBe("1");

      // 4. The run drawer shows SQL-derived run evidence, and vanishes with the grant.
      const run = await native.sql(
        `SELECT r.status||'|'||coalesce(r.outcome_code,'none')||'|'||r.model||'|'||r.input_revision||'|'||
           (SELECT string_agg(kind||' · '||status||coalesce(' · '||model,'')||coalesce(' · '||tool,'')||coalesce(' · '||outcome_code,''), ';' ORDER BY step) FROM clockgrove.run_steps s WHERE s.run_id=r.run_id)||'|'||
           (SELECT count(*) FROM clockgrove.run_steps s WHERE s.run_id=r.run_id AND kind='model_attempt')||'|'||
           (SELECT CASE WHEN count(cost_microusd)=0 THEN 'unknown' ELSE '$'||to_char(sum(cost_microusd)/1e6,'FM0.000000') END FROM clockgrove.run_steps s WHERE s.run_id=r.run_id)
         FROM clockgrove.agent_runs r WHERE session_id='${id}' AND input_message_id=(
           SELECT input_message_id FROM clockgrove.agent_runs WHERE session_id='${id}' ORDER BY started_at LIMIT 1)`,
      );
      const [status, outcome, model, revision, steps, attempts, cost] = run.split("|");
      await history.getByRole("button", { name: "Run details", exact: true }).first().click();
      const drawer = page.getByRole("complementary", { name: "Run drawer", exact: true });
      await drawer.getByText(`Status: ${status}`, { exact: true }).waitFor();
      for (const line of [
        `Outcome: ${outcome}`,
        `Model: ${model}`,
        `World revision: ${revision}`,
        `Model attempts: ${attempts}`,
        `Cost: ${cost}`,
      ])
        await drawer.getByText(line, { exact: true }).waitFor();
      expect(
        await drawer.getByRole("list", { name: "Steps" }).getByRole("listitem").allTextContents(),
      ).toEqual(steps.split(";"));
      await drawer.getByRole("button", { name: "Close run drawer", exact: true }).click();
      expect(await drawer.count()).toBe(0);

      // 5. The open conversation panel has no accessibility violations.
      await page.addScriptTag({
        content: await (await import("node:fs/promises")).readFile(
          require.resolve("axe-core/axe.min.js"),
          "utf8",
        ),
      });
      const violations = await page.evaluate(async () =>
        (
          await globalThis.axe.run(document.querySelector('[aria-label="Private conversation"]'))
        ).violations.map((violation) => violation.id),
      );
      expect(violations).toEqual([]);

      await grant("array_remove(grants,'runtime:world-inspect')");
      await openTalk();
      await history
        .getByText(/Scripted fixture reply/u)
        .first()
        .waitFor();
      expect(await page.getByRole("button", { name: "Run details", exact: true }).count()).toBe(0);
      expect(
        await page.getByRole("complementary", { name: "Run drawer", exact: true }).count(),
      ).toBe(0);
    } finally {
      await browser?.close();
      await server.close();
    }
  });
}, 540000);
