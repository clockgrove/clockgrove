import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));

// issue 1002: `pnpm dev:yard` serves green-lake-yard@1 at the URL it prints, the printed credential signs
// in there, and Ctrl-C removes the temporary database it created.
it("serves the living yard it prints and removes it on Ctrl-C", async () => {
  const yard = spawn(process.execPath, ["scripts/dev-yard.mjs"], {
    cwd: root,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const exited = new Promise((resolve) => yard.on("exit", (code) => resolve(code)));
  const printed = new Promise((resolve) => {
    const read = (chunk) => {
      output += chunk;
      const url = /Open: +(\S+)/u.exec(output)?.[1];
      const credential = /credential "([^"]+)"/u.exec(output)?.[1];
      if (url && credential) resolve({ url: new URL(url), credential });
    };
    yard.stdout.setEncoding("utf8").on("data", read);
    yard.stderr.setEncoding("utf8").on("data", read);
  });
  let browser;
  try {
    const { url, credential } = await Promise.race([
      printed,
      exited.then((code) => Promise.reject(new Error(`dev:yard exited ${code}\n${output}`))),
    ]);
    const directory = await fetch(new URL("/v1/runtime/world-directory", url), {
      method: "POST",
      headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
      body: JSON.stringify({ version: 1 }),
    }).then((response) => response.json());
    const [{ tenantId, worldId, timelineId, spaceId }] = directory.entries;
    expect([directory.entries.length, url.pathname, credential]).toEqual([
      1,
      `/worlds/${tenantId}/${worldId}/${timelineId}/${spaceId}`,
      "yard-observer",
    ]);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(url.toString());
    await page.getByLabel("Local session credential").fill(credential);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByText(/^Arrival: (text )?scene ready at revision /u).waitFor();
    expect(await page.getByText(/^Arrival: /u).textContent()).toBe(
      "Arrival: scene ready at revision 0.",
    );
  } finally {
    await browser?.close();
    process.kill(-yard.pid, "SIGINT");
  }
  const database = /creating directory (\S+)\/data/u.exec(output)?.[1];
  expect([await exited, typeof database, database && existsSync(database)]).toEqual([
    0,
    "string",
    false,
  ]);
}, 240_000);

it("serves an external pack with its shell and static assets and cleans up on Ctrl-C", async () => {
  const external = await mkdtemp(path.join(tmpdir(), "clockgrove-external-world-"));
  const launcher = path.join(root, "scripts/dev-yard.mjs");
  let session;
  let exited;
  let browser;
  let output = "";
  try {
    await cp(path.join(root, "worlds/fixture"), path.join(external, "external pack"), {
      recursive: true,
    });
    await writeFile(
      path.join(external, "external pack/runtime.json"),
      `{
      "presentationVersion": 1,
      "presentations": [{
        "presentation": {"presentationVersion": 1, "assetManifestVersion": 1,
          "pack": {"id": "clockgrove.test-world", "version": "1.1.0"},
          "bindings": [{"objectId": "beacon.master", "assetId": "external-lamp",
            "animationFamily": "idle", "accessibilityLabel": "External keeper"}], "effects": []},
        "drawable": ["external-lamp/idle"],
        "activity": {"families": [], "moving": "idle", "shelter": "idle", "arrived": "idle", "seeking": "idle"}
      }]
    }`,
    );
    const shell = JSON.parse(
      await readFile(path.join(external, "external pack/shell.json"), "utf8"),
    );
    shell.name = "External Fixture";
    shell.wordmark = "External Fixture";
    await writeFile(path.join(external, "shell.json"), JSON.stringify(shell));
    await mkdir(path.join(external, "static"));
    await writeFile(path.join(external, "static/fixture.txt"), "external fixture asset\n");
    const args = ["--pack", "external pack", "--shell", "shell.json", "--assets", "static"];
    for (const invalid of [
      args.slice(0, 2),
      [...args, "--pack", "external pack"],
      [...args, "--unknown", "x"],
      ["--pack", "missing", ...args.slice(2)],
    ]) {
      const refused = spawnSync(process.execPath, [launcher, ...invalid], {
        cwd: external,
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(refused.status, refused.stderr).toBe(2);
      expect(refused.stderr).toContain("Usage:");
      expect(refused.stdout).toBe("");
    }
    session = spawn(process.execPath, [launcher, ...args], {
      cwd: external,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    exited = new Promise((resolve) => session.on("exit", (code) => resolve(code)));
    const printed = new Promise((resolve) => {
      const read = (chunk) => {
        output += chunk;
        const url = /Open: +(\S+)/u.exec(output)?.[1];
        const credential = /credential "([^"]+)"/u.exec(output)?.[1];
        if (url && credential) resolve({ url: new URL(url), credential });
      };
      session.stdout.setEncoding("utf8").on("data", read);
      session.stderr.setEncoding("utf8").on("data", read);
    });
    const { url, credential } = await Promise.race([
      printed,
      exited.then((code) =>
        Promise.reject(new Error(`external session exited ${code}\n${output}`)),
      ),
    ]);
    expect(output).toContain("Living world: clockgrove.test-world@1.1.0");
    expect(await fetch(new URL("/fixture.txt", url)).then((response) => response.text())).toBe(
      "external fixture asset\n",
    );
    const directory = await fetch(new URL("/v1/runtime/world-directory", url), {
      method: "POST",
      headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
      body: JSON.stringify({ version: 1 }),
    }).then((response) => response.json());
    const [{ tenantId, worldId, timelineId, spaceId }] = directory.entries;
    expect([directory.entries.length, url.pathname, credential]).toEqual([
      1,
      `/worlds/${tenantId}/${worldId}/${timelineId}/${spaceId}`,
      "yard-observer",
    ]);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const snapshots = [];
    page.on("websocket", (socket) => {
      if (new URL(socket.url()).pathname === "/v1/projection")
        socket.on("framereceived", ({ payload }) => snapshots.push(JSON.parse(String(payload))));
    });
    await page.goto(url.toString());
    expect(await page.title()).toBe("External Fixture");
    await page.getByLabel("Local session credential").fill(credential);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByText(/^Arrival: (text )?scene ready at revision /u).waitFor();
    expect(await page.getByText(/^Arrival: /u).textContent()).toBe(
      "Arrival: scene ready at revision 0.",
    );
    expect(
      snapshots.find((message) => message.type === "snapshot").payload.presentationBindings,
    ).toEqual([
      {
        objectId: "beacon.master",
        assetId: "external-lamp",
        animationFamily: "idle",
        accessibilityLabel: "External keeper",
      },
    ]);
  } finally {
    await browser?.close();
    if (session?.exitCode === null) process.kill(-session.pid, "SIGINT");
    if (exited) {
      const database = /creating directory (\S+)\/data/u.exec(output)?.[1];
      expect([await exited, typeof database, database && existsSync(database)]).toEqual([
        0,
        "string",
        false,
      ]);
    }
    await rm(external, { recursive: true, force: true });
  }
}, 240_000);
