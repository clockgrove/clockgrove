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
    const nativeOrigin = await native.origin();
    let browserOrigin = "";
    const server = await createServer({
      root: path.join(root, "apps/web"),
      configFile: path.join(root, "apps/web/vite.config.ts"),
      server: {
        host: "127.0.0.1",
        port: 0,
        proxy: {
          "/v1/projection": { target: await native.origin(), ws: true },
          "/v1/runtime": {
            target: nativeOrigin,
            changeOrigin: true,
            configure(proxy) {
              // The fixture proxies between two loopback ports; preserve same-origin semantics
              // for the browser's own origin while retaining foreign origins for rejection.
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
    let releaseList = () => {};
    try {
      await server.listen();
      browserOrigin = `http://127.0.0.1:${server.httpServer.address().port}`;
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
      let listArrived;
      const listReady = new Promise((resolve) => {
        listArrived = resolve;
      });
      const heldList = new Promise((resolve) => {
        releaseList = resolve;
      });
      await page.route("**/v1/runtime/conversations/list", async (request) => {
        const response = await request.fetch();
        listArrived();
        await heldList;
        await request.fulfill({ response });
      });
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
      await listReady;
      const listResponse = page.waitForResponse((response) =>
        response.url().endsWith("/v1/runtime/conversations/list"),
      );
      releaseList();
      await listResponse;
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
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
      await page.getByLabel("Local session credential").fill("local-reader-session");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
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
      // Switch the reviewed fixture to its protected effect class; the tool schema stays pinned.
      await native.sql(`UPDATE clockgrove.mcp_installations SET reviews=jsonb_set(reviews,'{lookup,effectClass}','"external-write"') WHERE installation_id='fixture';
        UPDATE clockgrove.mcp_bindings SET binding=jsonb_set(binding,'{constraints,effectClasses}','["external-write"]') WHERE binding_id='binding';
        UPDATE clockgrove.world_memberships SET grants=grants||ARRAY['runtime:world-operate'] WHERE principal_id='principal-runtime';`);
      await page.getByRole("button", { name: "New conversation", exact: true }).click();
      await page
        .getByLabel("Message Keeper…", { exact: true })
        .fill(`fixture:research 1 ${CAPABILITY} {"q":"approved-write"}`);
      await page.getByRole("button", { name: "Send", exact: true }).click();
      const approvals = page.getByRole("complementary", { name: "Call approvals", exact: true });
      await approvals.getByText("Awaiting approval", { exact: true }).waitFor();
      expect(await approvals.textContent()).toContain(`Proposed call: ${CAPABILITY}`);
      expect(await approvals.getByLabel("Exact call arguments").textContent()).toBe(
        '{\n  "q": "approved-write"\n}',
      );
      expect(await fetch(`${process.env.NATIVE_RESEARCH_ORIGIN}/count`).then((r) => r.text())).toBe(
        calls,
      );
      await page.reload();
      await page.getByLabel("Local session credential").fill("local-reader-session");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page.getByRole("button", { name: ACTOR, exact: true }).press("Enter");
      await page.getByRole("button", { name: "Talk", exact: true }).click();
      await approvals.getByText("Awaiting approval", { exact: true }).waitFor();
      const approvalResponse = page.waitForResponse((response) =>
        response.url().endsWith("/effects/decide"),
      );
      await approvals.getByRole("button", { name: "Approve exact call", exact: true }).click();
      expect((await approvalResponse).status()).toBe(200);
      await expect
        .poll(
          () =>
            native.sql(
              "SELECT phase||':'||coalesce(outcome_code,'') FROM clockgrove.conversation_turn_fibers ORDER BY updated_at DESC LIMIT 1",
            ),
          { timeout: 30000 },
        )
        .toBe("completed:");

      await history
        .getByText(/Fixture research succeeded: The fixture archive code is ORCHID-42\./u)
        .waitFor({ timeout: 60000 });
      expect(await fetch(`${process.env.NATIVE_RESEARCH_ORIGIN}/count`).then((r) => r.text())).toBe(
        String(Number(calls) + 1),
      );
      await page
        .getByLabel("Message Keeper…", { exact: true })
        .fill(`fixture:research 1 ${CAPABILITY} {"q":"changed-write"}`);
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await approvals.getByText("Awaiting approval", { exact: true }).waitFor();
      await approvals.getByRole("button", { name: "Deny call", exact: true }).click();
      await history
        .getByText(/Fixture research refused: Tool refused: approval_denied/u)
        .waitFor({ timeout: 60000 });
      expect(await fetch(`${process.env.NATIVE_RESEARCH_ORIGIN}/count`).then((r) => r.text())).toBe(
        String(Number(calls) + 1),
      );
      await native.sql(
        "UPDATE clockgrove.world_memberships SET grants=array_remove(array_remove(grants,'runtime:world-operate'),'runtime:world-inspect') WHERE principal_id='principal-runtime'",
      );
      await page
        .getByLabel("Message Keeper…", { exact: true })
        .fill(`fixture:research 1 ${CAPABILITY} {"q":"down"}`);
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await approvals.getByText("Awaiting approval", { exact: true }).waitFor();
      await approvals.getByRole("button", { name: "Approve exact call", exact: true }).click();
      await approvals.getByText(/Uncertain write:/u).waitFor();
      expect(
        await approvals
          .getByRole("button", { name: "Mark done after checking provider", exact: true })
          .count(),
      ).toBe(0);
      await history
        .getByText(/Fixture research uncertain: tool_uncertain/u)
        .waitFor({ timeout: 60000 });
      await page
        .getByLabel("Message Keeper…", { exact: true })
        .fill(`fixture:research-no-answer 1 ${CAPABILITY} {"q":"down"}`);
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await approvals.getByText("Awaiting approval", { exact: true }).waitFor();
      await approvals.getByRole("button", { name: "Approve exact call", exact: true }).click();
      await expect.poll(() => approvals.getByText(/Uncertain write:/u).count()).toBe(2);
      await history
        .getByText(/Model unavailable\. I could not finish this turn\./u)
        .waitFor({ timeout: 60000 });
      await native.sql(
        "UPDATE clockgrove.world_memberships SET grants=grants||ARRAY['runtime:world-operate'] WHERE principal_id='principal-runtime'",
      );
      await page.getByText("Operator approvals", { exact: true }).click();
      const operator = page.getByRole("complementary", { name: "Operator approvals", exact: true });
      await operator
        .getByText(/Uncertain write:/u)
        .first()
        .waitFor();
      await operator
        .getByRole("button", { name: "Mark done after checking provider", exact: true })
        .first()
        .click();
      await expect
        .poll(() =>
          native.sql("SELECT resolved_by||':'||disposition FROM clockgrove.effect_resolutions"),
        )
        .toBe("principal-runtime:done");
      expect(await fetch(`${process.env.NATIVE_RESEARCH_ORIGIN}/count`).then((r) => r.text())).toBe(
        String(Number(calls) + 3),
      );
    } finally {
      releaseList();
      await browser?.close();
      await server.close();
    }
  });
}, 240000);
