import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import {
  ACTOR,
  CAPABILITY,
  seedResearch,
  withResearchFixture,
} from "../../apps/runtime/test/research-node-fixture.ts";
import {
  isNativeWorldOwnerChild,
  runNativeWorldOwnerProcess,
  withNativeWorldOwner,
} from "../../apps/runtime/test/world-owner/native-harness.ts";
import { createServer } from "../../apps/web/node_modules/vite/dist/node/index.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const FILE = "tests/e2e/research.journey.browser.test.mjs";
process.env.CLOCKGROVE_WORLD_SHELL = path.join(root, "worlds/fixture/reference/shell.json");
it("shows queued research, the cited answer and its canonical tool evidence", async () => {
  if (!isNativeWorldOwnerChild()) {
    await withResearchFixture(() =>
      runNativeWorldOwnerProcess(FILE, "fixture/reference", {
        vitestConfig: "tests/ci/vitest.browser.config.ts",
        queues: true,
        timeoutMs: 180000,
        inheritOutput: true,
      }),
    );
    return;
  }
  await withNativeWorldOwner(async (native) => {
    await seedResearch(native);
    await native.sql(
      "UPDATE clockgrove.world_memberships SET grants=grants||ARRAY['runtime:world-inspect'] WHERE principal_id='principal-runtime'",
    );
    const server = await createServer({
      root: path.join(root, "apps/web"),
      configFile: path.join(root, "apps/web/vite.config.ts"),
      server: {
        host: "127.0.0.1",
        port: 0,
        proxy: {
          "/v1/projection": { target: await native.origin(), ws: true },
          "/v1/runtime": await native.origin(),
        },
      },
    });
    let browser;
    try {
      await server.listen();
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      const route = `/worlds/${Object.values(native.scope).map(encodeURIComponent).join("/")}`;
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}${route}`);
      await page.getByLabel("Local session credential").fill("local-reader-session");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page.getByRole("button", { name: ACTOR, exact: true }).press("Enter");
      await page.getByRole("button", { name: "Talk", exact: true }).click();
      await page
        .getByLabel("Message Keeper…", { exact: true })
        .fill(`fixture:research 1 ${CAPABILITY} {"q":"hold"}`);
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await page.getByText("Using tool…", { exact: true }).waitFor();
      expect(
        await native.sql(
          "SELECT count(*) FROM clockgrove.effect_attempts WHERE disposition='started'",
        ),
      ).toBe("1");
      await fetch(`${process.env.NATIVE_RESEARCH_ORIGIN}/release`);
      const history = page.getByRole("list", { name: "Conversation history" });
      await history
        .getByText(/Fixture research succeeded: The fixture archive code is ORCHID-42\./u)
        .waitFor({ timeout: 60000 });
      expect(await history.textContent()).not.toContain("Unexecuted proposal text");
      await history.getByRole("button", { name: "Why? Tool evidence", exact: true }).click();
      const evidence = page.getByRole("complementary", { name: "Tool evidence", exact: true });
      await evidence
        .getByText("Tool result recorded as untrusted evidence", { exact: true })
        .waitFor();
      expect(await evidence.locator("dt").allTextContents()).toEqual([
        "Call",
        "Effect",
        "Grant",
        "Result",
        "Queue latency",
        "Call",
        "Effect",
        "Grant",
        "Result",
        "Queue latency",
      ]);
      expect(await evidence.textContent()).toMatch(/tool:[a-f0-9]{64}/u);
      expect(await evidence.textContent()).toContain("binding");
      expect(await evidence.textContent()).toContain("succeeded");
      const calls = await fetch(`${process.env.NATIVE_RESEARCH_ORIGIN}/count`).then((response) =>
        response.text(),
      );
      await page.reload();
      await page.getByRole("button", { name: ACTOR, exact: true }).press("Enter");
      await page.getByRole("button", { name: "Talk", exact: true }).click();
      await history
        .getByText(/Fixture research succeeded: The fixture archive code is ORCHID-42\./u)
        .waitFor();
      expect(
        await fetch(`${process.env.NATIVE_RESEARCH_ORIGIN}/count`).then((response) =>
          response.text(),
        ),
      ).toBe(calls);
    } finally {
      await browser?.close();
      await server.close();
    }
  });
}, 240000);
