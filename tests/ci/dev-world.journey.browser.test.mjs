import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import { encodePng, sha256Hex } from "../../packages/assets/src/index.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));

// Issue 137: a painterly world whose reviewed output has four pages. A 14-frame walk of 300x700 px
// frames wraps into two rows of six on the `walker` page and continues its last two frames on
// `walker-page-2`, and two 600x1100 px strips overflow the `sheet` atlas onto a second page.
// The fixture's actors stand close together, so each strip paints its own colour in a 40 px square
// at its own offset from the bottom-centre anchor, 4 px further right in each frame; frame edges
// stay transparent.
const STRIPS = [
  ["walker", "walk", "walker", 300, 700, 14, [255, 0, 255], 10],
  ["tall-a", "idle", "sheet", 600, 1100, 1, [0, 255, 255], 280],
  ["tall-b", "idle", "sheet", 600, 1100, 1, [0, 0, 255], 550],
];
async function buildPagedWorld(world) {
  const read = async (file) => JSON.parse(await readFile(path.join(root, file), "utf8"));
  const template = await read("packages/contracts/test/fixtures/asset-manifest/approved.json");
  const profile = await read("worlds/fixture/reference/asset-style.json");
  Object.assign(profile, {
    alpha: { mode: "soft", boundsThreshold: 128 },
    colour: { mode: "unrestricted" },
    edge: "unrestricted",
  });
  for (const limit of Object.values(profile.sizes))
    Object.assign(limit, { maxWidth: 1024, maxHeight: 2048 });
  await mkdir(path.join(world, "reference"), { recursive: true });
  await writeFile(path.join(world, "reference/asset-style.json"), JSON.stringify(profile));
  for (const [assetId, family, atlasId, width, height, count, colour, left] of STRIPS) {
    const [side, top] = [40, height - 41];
    const rgba = new Uint8Array(width * count * height * 4);
    for (let f = 0; f < count; f++)
      for (let y = top; y < top + side; y++)
        for (let x = left + 4 * f; x < left + 4 * f + side; x++)
          rgba.set([...colour, 255], (y * width * count + f * width + x) * 4);
    const png = encodePng({ width: width * count, height, rgba });
    const source = `assets/source/${assetId}/${family}.png`;
    await mkdir(path.join(world, `assets/manifests/${assetId}`), { recursive: true });
    await mkdir(path.dirname(path.join(world, source)), { recursive: true });
    await writeFile(path.join(world, source), png);
    await writeFile(
      path.join(world, `assets/manifests/${assetId}/${family}.json`),
      JSON.stringify({
        ...template,
        assetId,
        animationFamily: family,
        source: { ...template.source, path: source },
        frames: { width, height, count, durationMs: count > 1 ? 100 : null },
        anchor: { x: width / 2, y: height - 1 },
        bounds: { x: left, y: top, width: side + 4 * (count - 1), height: side },
        contentHash: sha256Hex(png),
        atlas: { atlasId, x: 0, y: 0 },
      }),
    );
  }
  const cli = path.join(root, "packages/assets/bin/clockgrove-assets.mjs");
  execFileSync(process.execPath, [cli, "build", "--world", world], { timeout: 30_000 });
  return path.join(world, "assets/reviewed");
}

// issue 1002: `pnpm dev:world` serves fixture-hall@1 at the URL it prints, the printed credential signs
// in there, and Ctrl-C removes the temporary database it created.
it("serves the living hall it prints and removes it on Ctrl-C", async () => {
  const hall = spawn(process.execPath, ["scripts/dev-world.mjs"], {
    cwd: root,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const exited = new Promise((resolve) => hall.on("exit", (code) => resolve(code)));
  const printed = new Promise((resolve) => {
    const read = (chunk) => {
      output += chunk;
      const url = /Open: +(\S+)/u.exec(output)?.[1];
      const credential = /credential "([^"]+)"/u.exec(output)?.[1];
      if (url && credential) resolve({ url: new URL(url), credential });
    };
    hall.stdout.setEncoding("utf8").on("data", read);
    hall.stderr.setEncoding("utf8").on("data", read);
  });
  let browser;
  try {
    const { url, credential } = await Promise.race([
      printed,
      exited.then((code) => Promise.reject(new Error(`dev:world exited ${code}\n${output}`))),
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
      "hall-observer",
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
    process.kill(-hall.pid, "SIGINT");
  }
  const database = /creating directory (\S+)\/data/u.exec(output)?.[1];
  expect([await exited, typeof database, database && existsSync(database)]).toEqual([
    0,
    "string",
    false,
  ]);
}, 240_000);

it("serves an external pack with its shell and every reviewed atlas page, and cleans up on Ctrl-C", async () => {
  const external = await mkdtemp(path.join(tmpdir(), "clockgrove-external-world-"));
  const launcher = path.join(root, "scripts/dev-world.mjs");
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
        "presentation": {"presentationVersion": 1, "assetManifestVersion": 2,
          "pack": {"id": "clockgrove.test-world", "version": "1.1.0"},
          "bindings": [{"objectId": "beacon.master", "assetId": "walker",
            "animationFamily": "walk", "accessibilityLabel": "External keeper"},
            {"objectId": "beacon.lamp", "assetId": "tall-a", "animationFamily": "idle", "accessibilityLabel": "Lamp"},
            {"objectId": "beacon.cistern", "assetId": "tall-b", "animationFamily": "idle", "accessibilityLabel": "Cistern"}],
          "effects": []},
        "drawable": ["walker/walk", "tall-a/idle", "tall-b/idle"],
        "activity": {"families": [], "moving": "idle", "shelter": "idle", "arrived": "idle", "seeking": "idle"}
      }]
    }`,
    );
    const shell = JSON.parse(
      await readFile(path.join(external, "external pack/shell.json"), "utf8"),
    );
    shell.name = "External Fixture";
    shell.wordmark = "External Fixture";
    shell.scene.atlases = true;
    await writeFile(path.join(external, "shell.json"), JSON.stringify(shell));
    const reviewed = await buildPagedWorld(path.join(external, "world"));
    expect(JSON.parse(await readFile(path.join(reviewed, "atlases.json"), "utf8")).atlases).toEqual(
      ["sheet", "sheet-page-2", "walker", "walker-page-2"],
    );
    await writeFile(path.join(reviewed, "fixture.txt"), "external fixture asset\n");
    const args = ["--pack", "external pack", "--shell", "shell.json", "--assets", reviewed];
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
      "hall-observer",
    ]);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const snapshots = [];
    const requested = new Set();
    page.on("request", (request) => requested.add(new URL(request.url()).pathname));
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
    ).toMatchObject(STRIPS.map(([assetId, animationFamily]) => ({ assetId, animationFamily })));
    // The shell loads every page the index lists and draws each page's strip in its colour. Every
    // sample shows all three, and the walk's square reaches all 14 positions: each frame's own rect
    // on its own page, across both wrapped rows and onto the continuation page.
    for (const name of ["sheet", "sheet-page-2", "walker", "walker-page-2"])
      for (const file of ["atlases.json", `${name}.animations.json`, `${name}.png`])
        expect(requested).toContain(`/${file}`);
    const walked = new Set();
    for (let sample = 0; sample < 200 && walked.size < 14; sample++) {
      const shot = (await page.locator("canvas").screenshot()).toString("base64");
      const [magenta, cyan, blue, left] = await page.evaluate(async (encoded) => {
        const image = new Image();
        image.src = `data:image/png;base64,${encoded}`;
        await image.decode();
        const context = Object.assign(document.createElement("canvas"), {
          width: image.width,
          height: image.height,
        }).getContext("2d");
        context.drawImage(image, 0, 0);
        const { data } = context.getImageData(0, 0, image.width, image.height);
        const found = [0, 0, 0, image.width];
        for (let i = 0; i < data.length; i += 4) {
          const [r, g, b] = data.subarray(i, i + 3);
          if (r > 2 * g + 40 && b > 2 * g + 40) {
            found[0]++;
            found[3] = Math.min(found[3], (i / 4) % image.width);
          } else if (g > 2 * r + 40 && b > 2 * r + 40) found[1]++;
          else if (b > 2 * (r + g) + 40) found[2]++;
        }
        return found;
      }, shot);
      expect(
        [magenta, cyan, blue].every((count) => count >= 1200),
        `${magenta} ${cyan} ${blue}`,
      ).toBe(true);
      walked.add(left);
    }
    expect(walked.size).toBe(14);
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
