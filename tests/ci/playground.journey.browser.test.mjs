import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { expect, it, onTestFailed } from "vitest";
import { journeyThenShutdown, namedSteps } from "./journey-steps.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));

// Issue 327: `pnpm playground` serves the neutral playground pack on localhost with no cloud account
// and no model key, prints how to open it as the world's owner, signs that owner in with the
// owner-only inspection the dev:world observer lacks, and Ctrl-C removes its database. The 720 s
// bound is dev:world's (#401): it is the same session.
async function servesToItsOwner({ args, pack, spaceId: expectedSpace, title }) {
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
      if (url && credential) resolve({ url: new URL(url), credential });
    };
    playground.stdout.setEncoding("utf8").on("data", read);
    playground.stderr.setEncoding("utf8").on("data", read);
  });
  let browser;
  await journeyThenShutdown(
    at,
    async () => {
      const { url, credential } = await Promise.race([
        printed,
        exited.then((code) => Promise.reject(new Error(`playground exited ${code}\n${output}`))),
      ]);
      expect(output).toContain(`Playground: ${pack} (`);
      expect(output).toContain(`credential "${credential}" (the world's owner)`);
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
    },
    "Ctrl-C stops the playground",
    async () => {
      await browser?.close();
      process.kill(-playground.pid, "SIGINT");
    },
  );
  const database = /creating directory (\S+)\/data/u.exec(output)?.[1];
  expect([await exited, typeof database, database && existsSync(database)]).toEqual([
    0,
    "string",
    false,
  ]);
}

it("serves the playground pack to its owner and removes it on Ctrl-C", async () => {
  const shell = JSON.parse(await readFile(path.join(root, "worlds/playground/shell.json"), "utf8"));
  await servesToItsOwner({
    args: [],
    pack: "clockgrove.playground@1.0.0",
    spaceId: "playground.plane",
    title: shell.name,
  });
}, 720_000);

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
      pack: "clockgrove.test-world@1.1.0",
      spaceId: "beacon.hall",
      title: "Clockgrove",
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}, 720_000);
