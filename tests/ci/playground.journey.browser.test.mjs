import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { expect, it, onTestFailed } from "vitest";
import { decodeCanonicalNode, encodeCanonicalNode } from "../../packages/application/src/index.ts";
import { journeyThenShutdown, namedSteps } from "./journey-steps.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));

// Issue 327: `pnpm playground` serves the neutral playground pack on localhost with no cloud account
// and no model key, prints how to open it as the world's owner, signs that owner in with the
// owner-only inspection the dev:world observer lacks, and Ctrl-C removes its database. The 720 s
// bound is dev:world's (#401): it is the same session.
async function servesToItsOwner({ args, pack, spaceId: expectedSpace, title, owner, worlds = 1 }) {
  const at = namedSteps(onTestFailed);
  at.step = "playground prints its URL and owner credential";
  // No model key and no cloud account reach the command.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/API_KEY|CLOUDFLARE|NEON/u.test(name)),
  );
  const playground = spawn(process.execPath, ["scripts/playground.mjs", ...args], {
    cwd: root,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });
  let output = "";
  const exited = new Promise((resolve) => playground.on("exit", (code) => resolve(code)));
  const printed = new Promise((resolve) => {
    const read = (chunk) => {
      output += chunk;
      const url = /Open: +(\S+)/u.exec(output)?.[1];
      const credential = /credential "([^"]+)"/u.exec(output)?.[1];
      const [, mcp, token] =
        /MCP: +(\S+) with header "Authorization: Bearer (\S+)"/u.exec(output) ?? [];
      if (url && credential && token) resolve({ url: new URL(url), credential, mcp, token });
    };
    playground.stdout.setEncoding("utf8").on("data", read);
    playground.stderr.setEncoding("utf8").on("data", read);
  });
  let browser;
  await journeyThenShutdown(
    at,
    async () => {
      const { url, credential, mcp, token } = await Promise.race([
        printed,
        exited.then((code) => Promise.reject(new Error(`playground exited ${code}\n${output}`))),
      ]);
      expect(output).toContain(`Playground: ${pack} (`);
      expect(output).toContain(`credential "${credential}" (the world's owner)`);
      expect([new URL(mcp).origin, output]).toEqual([
        url.origin,
        expect.stringContaining(
          `Agent:   claude mcp add --transport http clockgrove-playground ${mcp} --header "Authorization: Bearer ${token}"`,
        ),
      ]);
      at.step = "the owner's world and inspection";
      const post = (route, body) =>
        fetch(new URL(route, url), {
          method: "POST",
          headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      const directory = await post("/v1/runtime/world-directory", { version: 1 }).then((response) =>
        response.json(),
      );
      const [{ tenantId, worldId, timelineId, spaceId }] = directory.entries;
      expect([directory.entries.length, url.pathname, credential, spaceId]).toEqual([
        1,
        `/worlds/${tenantId}/${worldId}/${timelineId}/${spaceId}`,
        "playground-owner",
        expectedSpace,
      ]);
      // The runtime-state inspector needs runtime:world-inspect, which dev:world's observer lacks.
      const inspected = await post("/v1/runtime/runtime-state", {
        schemaVersion: 1,
        tenantId,
        worldId,
        timelineId,
        spaceId,
      });
      expect(inspected.status).toBe(200);
      at.step = "browser signs in and the scene arrives";
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      await page.goto(url.toString());
      expect(await page.title()).toBe(title);
      await page.getByLabel("Local session credential").fill(credential);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page.getByText(/^Arrival: (text )?scene ready at revision /u).waitFor();
      expect(await page.getByText(/^Arrival: /u).textContent()).toBe(
        "Arrival: scene ready at revision 0.",
      );
      await owner?.({ at, page, url, credential, post, entry: directory.entries[0], mcp, token });
    },
    "Ctrl-C stops the playground",
    async () => {
      await browser?.close();
      process.kill(-playground.pid, "SIGINT");
    },
  );
  // Every hosted world had its own database, and each is removed.
  const databases = [...output.matchAll(/creating directory (\S+)\/data/gu)].map(([, at]) => at);
  expect([
    await exited,
    new Set(databases).size,
    databases.length,
    databases.filter((at) => existsSync(at)),
  ]).toEqual([0, worlds, worlds, []]);
}

// Part 2: the owner's Pack panel. Its API answers the owner only; it shows the pack's metadata and
// conformance checks, previews a newer version's migration, and loads another pack from a local
// directory as a fresh world beside this one, which the owner switches to and back from. The owner
// also Talks to the rock in its disclosed object voice, answered by the scripted fixture (no key).
async function ownsThePlayground(journey, scratch) {
  const { at, page, url, credential, post, entry } = journey;
  at.step = "the playground API answers its owner only";
  const pack = (token) =>
    fetch(new URL("/playground/v1/pack", url), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    });
  const outsider = await pack("outsider-session-token");
  expect([outsider.status, await outsider.json()]).toEqual([403, { error: "playground_refused" }]);
  expect((await pack(credential).then((response) => response.json())).metadata).toEqual({
    name: "clockgrove.playground",
    version: "1.1.0",
    content: { entities: 3, places: 1, rules: 1, scenarios: 1, art: 0 },
  });
  at.step = "the Pack panel shows the checks";
  const openPanel = async () => {
    await page.locator("summary", { hasText: /^Pack$/u }).click();
    return page.getByRole("region", { name: "Hosted worlds", exact: true });
  };
  const worlds = await openPanel();
  const checks = page.getByRole("region", { name: "Pack checks", exact: true });
  await checks.getByText("Checks: passed", { exact: true }).waitFor({ timeout: 60_000 });
  expect(await checks.getByRole("listitem").allTextContents()).toEqual([
    "artifact-integrity: passed",
    "seed-genesis: passed",
    "scenario-assertions (weathered-rock): passed",
    "golden-match (weathered-rock): passed",
  ]);
  at.step = "a migration preview from a newer version";
  const newer = path.join(scratch, "playground-1.2.0");
  await cp(path.join(root, "worlds/playground"), newer, { recursive: true });
  const migration = JSON.stringify({
    fromPackVersion: "1.1.0",
    id: "playground.weather-upgrade",
    steps: [
      {
        key: "playground.clear-sky",
        payload: { weather: "clear" },
        type: "world.weather.set",
        version: 2,
      },
    ],
    toPackVersion: "1.2.0",
    version: 1,
  });
  await mkdir(path.join(newer, "resources/migrations"));
  await writeFile(path.join(newer, "resources/migrations/clear-sky.json"), migration);
  const manifest = JSON.parse(await readFile(path.join(newer, "manifest.json"), "utf8"));
  manifest.version = "1.2.0";
  manifest.migrations = [
    {
      id: "playground.weather-upgrade",
      path: "migrations/clear-sky.json",
      sha256: createHash("sha256").update(migration).digest("hex"),
      version: 1,
    },
  ];
  await writeFile(path.join(newer, "manifest.json"), JSON.stringify(manifest));
  const preview = page.getByRole("region", { name: "Migration preview", exact: true });
  await preview.getByLabel("Newer pack directory").fill(newer);
  await preview.getByRole("button", { name: "Preview migration", exact: true }).click();
  await preview.getByText("From 1.1.0 to 1.2.0: 1 steps", { exact: true }).waitFor();
  expect(await preview.getByRole("listitem").allTextContents()).toEqual([
    "playground.weather-upgrade@1/playground.clear-sky (world.weather.set v2)",
  ]);
  at.step = "Talk to the rock";
  await page.getByRole("button", { name: "playground.rock", exact: true }).press("Enter");
  await page.getByRole("button", { name: "Talk", exact: true }).click();
  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  await page.getByLabel(/^Message .+…$/u).fill("hello rock");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const history = page.getByRole("list", { name: "Conversation history" });
  await history.getByText(/Scripted fixture reply/u).waitFor({ timeout: 60_000 });
  expect(await history.getByRole("listitem").count()).toBe(2);
  await debugsThePlayground(page, post, entry);
  at.step = "a coding agent asks over the playground's MCP server";
  await asksOverMcp(journey);
  // The playground world's identity, metadata and clock before another pack is loaded.
  const state = async () => {
    const { tenantId, worldId, timelineId, spaceId } = entry;
    const response = await post("/v1/runtime/runtime-state", {
      schemaVersion: 1,
      tenantId,
      worldId,
      timelineId,
      spaceId,
    });
    expect(response.status).toBe(200);
    // The runtime-state view is a kernel canonical node (bigints preserved).
    const { scope, clock } = decodeCanonicalNode(await response.json());
    const [directory, metadata] = await Promise.all([
      post("/v1/runtime/world-directory", { version: 1 }).then((answer) => answer.json()),
      pack(credential)
        .then((answer) => answer.json())
        .then((answer) => answer.metadata),
    ]);
    return {
      scope,
      entries: directory.entries,
      metadata,
      time: clock.value.simulationTime,
    };
  };
  const before = await state();
  at.step = "load another pack as a fresh world and switch to it";
  const other = path.join(scratch, "fixture");
  await cp(path.join(root, "worlds/fixture"), other, { recursive: true });
  await worlds.getByLabel("Pack directory").fill(other);
  await worlds.getByRole("button", { name: "Load pack", exact: true }).click();
  const open = worlds.getByRole("link", { name: "Open clockgrove.test-world@1.2.0", exact: true });
  await open.waitFor({ timeout: 600_000 });
  await open.click();
  const signIn = async () => {
    await page.getByLabel("Local session credential").fill(credential);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByText(/^Arrival: (text )?scene ready at revision /u).waitFor();
  };
  await signIn();
  // A fresh world from that pack's declared seed.
  expect(await page.getByText(/^Arrival: /u).textContent()).toBe(
    "Arrival: scene ready at revision 0.",
  );
  await openPanel();
  await page
    .getByRole("region", { name: "Pack metadata", exact: true })
    .getByText("clockgrove.test-world 1.2.0", { exact: true })
    .waitFor();
  at.step = "switch back to the playground world";
  await worlds.getByRole("link", { name: "Open clockgrove.playground@1.1.0", exact: true }).click();
  await signIn();
  await openPanel();
  await page
    .getByRole("region", { name: "Pack metadata", exact: true })
    .getByText("clockgrove.playground 1.1.0", { exact: true })
    .waitFor();
  // Loading the other pack left this world as it was: the same world, pack and content, and a clock
  // that only went on.
  const after = await state();
  expect([after.scope, after.entries, after.metadata, after.time >= before.time]).toEqual([
    before.scope,
    before.entries,
    before.metadata,
    true,
  ]);
}

// Part 3: the owner's World debugger, read-only, from recorded evidence: the cube's recorded
// decision (perception, beliefs, goals and the choice), the journal with every event type and its
// cause, a replay to the journal head, the Talk run's steps and cost, and the pack checks. The
// dev:world journey checks that an observer never sees it.
async function debugsThePlayground(page, post, entry) {
  // A fresh world's clock starts paused; its owner runs it (×60, so the cube's 60 s decision
  // interval passes each wall second) through the existing clock commands and `runtime:world-clock`.
  const { tenantId, worldId, timelineId, spaceId } = entry;
  const clock = async (type, payload) => {
    const key = `debugger-${type}`;
    const response = await post("/v1/runtime/commands", {
      schemaVersion: 1,
      tenantId,
      worldId,
      timelineId,
      spaceId,
      routingEpoch: "1",
      authorityEpoch: "1",
      command: encodeCanonicalNode({
        schemaVersion: 1,
        commandId: key,
        type,
        target: { version: 1, tenantId, worldId, timelineId, kind: "world", id: worldId },
        expected: {},
        issuedAt: new Date().toISOString(),
        context: { version: 1, correlationId: `correlation-${key}`, requestId: key },
        attribution: { effectiveActorId: "playground-owner", causalRootActionId: `action-${key}` },
        payload,
      }),
    });
    expect([type, response.status]).toEqual([type, 200]);
  };
  await clock("SetClockPolicy", {
    schemaVersion: 1,
    simulationMillisecondsPerWallMillisecond: 60,
    catchUpCapMs: 86_400_000n,
  });
  await clock("ResumeWorld", { schemaVersion: 1 });
  await page.locator("summary", { hasText: /^World debugger$/u }).click();
  const actors = page.getByRole("region", { name: "Debugger actors", exact: true });
  await actors.getByLabel("Actor").selectOption("playground.cube");
  // The cube decides as the clock runs; read again until its first decision is recorded.
  const decision = actors.getByRole("region", { name: /^Decision at \d+$/u }).first();
  await expect
    .poll(
      async () => {
        await actors.getByRole("button", { name: "Show decisions", exact: true }).click();
        return decision.isVisible().catch(() => false);
      },
      { timeout: 180_000, interval: 5_000 },
    )
    .toBe(true);
  expect(await decision.getByRole("heading", { level: 5 }).allTextContents()).toEqual([
    "Perception",
    "Beliefs",
    "Goals",
    "Choice",
  ]);
  expect(await decision.getByText(/^Chose (stay|seek-[a-z]+) → \S+ \(tier /u).count()).toBe(1);
  // The recorded trace's features, read through: the cube perceives the rock (300 units away, in
  // a 5,000-unit perception range); `stay` records no `perceived` feature; it holds no memory of
  // the rock (expectation 0, no food freshness); and its goals are the actor-level needs.
  const lists = decision.getByRole("list");
  const perception = await lists.nth(0).getByRole("listitem").allTextContents();
  expect(perception).toContain("stay → None: not recorded");
  expect(perception).toContain("seek-shelter → playground.rock: perceived");
  expect(
    perception.filter(
      (line) =>
        !/^seek-water → playground\.puddle: perceived$/u.test(line) &&
        line !== "stay → None: not recorded" &&
        line !== "seek-shelter → playground.rock: perceived",
    ),
  ).toEqual([]);
  const beliefs = await lists.nth(1).getByRole("listitem").allTextContents();
  expect(beliefs).toContain(
    "seek-shelter → playground.rock: expectation 0, freshness not recorded",
  );
  expect(
    beliefs.filter(
      (line) =>
        !/^seek-water → playground\.puddle: expectation \d+, freshness not recorded$/u.test(line) &&
        line !== "seek-shelter → playground.rock: expectation 0, freshness not recorded",
    ),
  ).toEqual([]);
  const goals = await decision
    .getByText(/^hunger \d+|^thirst \d+|^wetness \d+|^U \d+|^rain \d+|^health \d+/u)
    .textContent();
  expect(
    goals
      .split(", ")
      .map((pair) => /^(\S+) -?\d+$/u.exec(pair)?.[1])
      .sort(),
  ).toEqual(["U", "health", "hunger", "rain", "thirst", "uncomfortable", "wetness"]);
  // Paused, the journal head stays put, so a replay to it can be compared with the live projection.
  await clock("PauseWorld", { schemaVersion: 1 });
  const journal = page.getByRole("region", { name: "Debugger journal", exact: true });
  await journal.getByRole("button", { name: "Load journal", exact: true }).click();
  const rows = journal.getByRole("list", { name: "Journal events" }).getByRole("listitem");
  await rows.first().waitFor();
  const types = new Set(
    (await rows.allTextContents()).map((text) => /^#\d+ (\S+) /u.exec(text)?.[1]),
  );
  // Every type, not only the feed's: needs, the clock's policy and the world's genesis records.
  expect([
    types.has("needs.changed"),
    types.has("ClockPolicyChanged"),
    types.has("WorldGenesisCreated"),
    types.has(undefined),
  ]).toEqual([true, true, true, false]);
  expect(await journal.getByText(/, back to the start of the journal\.$/u).count()).toBe(1);
  expect(
    await journal
      .getByText(/^Recorded cause: command \S+; causation \S+; actor \S+; root action \S+/u)
      .count(),
  ).toBe(await rows.count());
  const cause = journal.getByRole("button", { name: /^Cause of event /u }).first();
  await cause.click();
  await journal
    .getByText(/^Caused by command \S+; receipt committed; /u)
    .first()
    .waitFor();
  const timeline = page.getByRole("region", { name: "Debugger timeline", exact: true });
  const head = /^Journal head (\d+);/u.exec(
    await journal.getByText(/^Journal head \d+;/u).textContent(),
  )?.[1];
  await timeline.getByRole("button", { name: `Replay to #${head}`, exact: true }).click();
  const replayed = timeline.getByRole("region", { name: "Replay result", exact: true });
  await replayed.waitFor({ timeout: 60_000 });
  expect(await replayed.getByRole("paragraph").textContent()).toMatch(
    new RegExp(
      `^Replayed to #${head} from \\S+: [1-9]\\d* events applied; revision \\d+; simulation time \\d+; rain \\d+; state hash [0-9a-f]{64}; matches the live projection\\.$`,
      "u",
    ),
  );
  expect(await replayed.getByText(/^playground\.cube: location /u).count()).toBe(1);
  await timeline.getByRole("button", { name: "Go to Timeline", exact: true }).click();
  expect(await page.evaluate(() => document.activeElement?.id)).toBe("rw-timeline-earlier");
  const runs = page.getByRole("region", { name: "Debugger runs", exact: true });
  await runs.getByRole("button", { name: "Load runs", exact: true }).click();
  await runs
    .getByRole("button", { name: /^Inspect run /u })
    .first()
    .click();
  const steps = runs.getByRole("list", { name: "Run steps" }).first();
  await steps.waitFor();
  // The scripted Talk to the rock: one run of three steps, its one model call priced at $0.
  expect([
    await runs
      .getByText(
        /^Run \S+: completed, model scripted-fixture-v1, actor playground\.rock, 3 steps Inspect run /u,
      )
      .count(),
    await steps.getByRole("listitem").allTextContents(),
    await runs.getByText(/^(Model calls|Tool calls|Approvals|Cost): /u).allTextContents(),
  ]).toEqual([
    1,
    [
      "context_retrieval · succeeded",
      "model_attempt · succeeded · scripted-fixture-v1 · 0 in / 0 out tokens · $0.000000",
      "commit · succeeded",
    ],
    ["Model calls: 1", "Tool calls: 0", "Approvals: 0", "Cost: $0.000000"],
  ]);
  const checks = page.getByRole("region", { name: "Debugger checks", exact: true });
  await checks.getByRole("button", { name: "Load checks", exact: true }).click();
  await checks.getByText("Checks: passed", { exact: true }).waitFor();
}

// Part 4: the developer's coding agent asks why over the playground's MCP server with the printed
// token. The official MCP SDK client (the protocol Claude Code, Codex and Copilot speak) reads the
// world's own evidence, each answer with a link into the debugger, and the links open it there.
async function asksOverMcp({ page: shell, url, credential, entry, mcp, token }) {
  // The links open in a tab of their own, as from the agent's answer, beside the owner's shell.
  const page = await shell.context().browser().newPage();
  const runtime = createRequire(path.join(root, "apps/runtime/package.json"));
  const { Client, StreamableHTTPClientTransport } = await import(
    pathToFileURL(runtime.resolve("@modelcontextprotocol/client")).href
  );
  const anonymous = await fetch(mcp, { method: "POST", body: "{}" });
  expect(anonymous.status).toBe(401);
  // The journey pins the current protocol; the 2025-era stateless legacy lane is proved in
  // apps/runtime/test/world-mcp-public.postgres.test.ts.
  const client = new Client(
    { name: "playground-journey", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(mcp), { authProvider: { token: async () => token } }),
  );
  const call = async (name, args) =>
    JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
  const { tenantId, worldId, timelineId, spaceId } = entry;
  const scope = { tenantId, worldId, timelineId, spaceId };
  try {
    // The journal with each event's recorded cause, as the debugger shows it.
    const journal = await call("world_journal", { schemaVersion: 1, ...scope });
    expect([journal.ok, journal.debugger]).toEqual([true, `${url.pathname}?debugger=journal`]);
    // The cube's recorded decision and why: perception, beliefs, goals and the choice.
    // The cube's newest recorded decision, from its history as the debugger reads it (paused clock).
    const cube = await call("entity_inspect", {
      version: 1,
      ...scope,
      objectId: "playground.cube",
    });
    let { history } = cube.value;
    let decided = history.actions.find((action) => action.decision === true);
    for (
      let page = 0;
      decided === undefined && history.beforeSequence !== null && page < 20;
      page++
    ) {
      const { observedRevision, beforeSequence } = history;
      ({ history } = (
        await call("entity_inspect", {
          version: 1,
          ...scope,
          objectId: "playground.cube",
          cursor: { observedRevision, beforeSequence },
        })
      ).value);
      decided = history.actions.find((action) => action.decision === true);
    }
    const why = await call("event_why", { version: 1, ...scope, eventId: decided.eventId });
    const draft = why.value.traces.drafts.find((trace) => trace.objectId === "playground.cube");
    expect([why.debugger, why.value.traces.status, draft.selectedAction.kind]).toEqual([
      `${url.pathname}?debugger=journal&event=${encodeURIComponent(decided.eventId)}`,
      "available",
      expect.stringMatching(/^(stay|seek-[a-z]+)$/u),
    ]);
    const shelter = draft.candidates.find(
      (candidate) => candidate.action.targetObjectId === "playground.rock",
    );
    expect(shelter.features).toEqual(
      expect.arrayContaining([
        { name: "perceived", value: expect.any(String) },
        { name: "expectation", value: "0" },
      ]),
    );
    expect(cube.debugger).toBe(`${url.pathname}?debugger=actors&actor=playground.cube`);
    // The Talk to the rock: its run, steps and cost.
    const runs = await call("run_search", { version: 1, ...scope });
    const [rock] = runs.value.runs.filter((run) => run.actorId === "playground.rock");
    const run = await call("run_receipt", { version: 1, ...scope, runId: rock.runId });
    expect([
      runs.debugger,
      run.debugger,
      run.value.runs.find((view) => view.runId === rock.runId).steps.map((step) => step.kind),
    ]).toEqual([
      `${url.pathname}?debugger=runs`,
      `${url.pathname}?debugger=runs&run=${encodeURIComponent(rock.runId)}`,
      ["context_retrieval", "model_attempt", "commit"],
    ]);
    // Each link is a path on the origin serving the MCP endpoint, and opens the debugger there.
    const open = async (link) => {
      await page.goto(new URL(link, mcp).toString());
      await page.getByLabel("Local session credential").fill(credential);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
    };
    await open(run.debugger);
    const linkedRun = page.getByRole("region", { name: "Linked run", exact: true });
    await linkedRun.getByText("Cost: $0.000000", { exact: true }).waitFor();
    expect(await linkedRun.getByText(/^Linked run /u).textContent()).toBe(
      `Linked run ${rock.runId}`,
    );
    await open(why.debugger);
    const linkedEvent = page.getByRole("region", { name: "Linked event", exact: true });
    await linkedEvent.getByText(/^Caused by command \S+; receipt committed; /u).waitFor();
    await linkedEvent
      .getByRole("button", { name: `Open Why for event ${decided.eventId}` })
      .waitFor();
    await open(cube.debugger);
    await page
      .getByRole("region", { name: "Debugger actors", exact: true })
      .getByRole("region", { name: /^Decision at \d+$/u })
      .first()
      .waitFor();
  } finally {
    await client.close();
    await page.close();
  }
}

// Two hosted worlds, each within dev:world's 720 s bound (#401).
it("serves the playground pack to its owner and removes it on Ctrl-C", async () => {
  const shell = JSON.parse(await readFile(path.join(root, "worlds/playground/shell.json"), "utf8"));
  const scratch = await mkdtemp(path.join(tmpdir(), "playground-owner-"));
  try {
    await servesToItsOwner({
      args: [],
      pack: "clockgrove.playground@1.1.0",
      spaceId: "playground.plane",
      title: shell.name,
      owner: (journey) => ownsThePlayground(journey, scratch),
      worlds: 2,
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}, 1_440_000);

// `--pack <dir>` serves the named pack in the playground's place as a fresh world from its declared
// seed (revision 0) in its own database. The pack here is a copy of worlds/fixture without its
// shell.json, so the neutral shell ("Clockgrove") is used, and `--assets` names its static directory.
it("serves a pack named with --pack, without a shell of its own, as a fresh world", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "playground-pack-"));
  try {
    const pack = path.join(scratch, "pack");
    await cp(path.join(root, "worlds/fixture"), pack, {
      recursive: true,
      filter: (source) => source !== path.join(root, "worlds/fixture/shell.json"),
    });
    expect(existsSync(path.join(pack, "shell.json"))).toBe(false);
    await servesToItsOwner({
      args: ["--pack", pack, "--assets", path.join(pack, "assets/reviewed")],
      pack: "clockgrove.test-world@1.2.0",
      spaceId: "beacon.hall",
      title: "Clockgrove",
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}, 720_000);
