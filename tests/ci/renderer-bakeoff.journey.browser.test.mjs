// Issue 67: the renderer bake-off's measurement page and script work end to end under software
// rendering (SwiftShader), the only GPU this CI host has. Its numbers are correctness evidence, never
// performance: the script must say so. GPU numbers come from the maintainer step in the spike README.
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { expect, it } from "vitest";

const spike = path.resolve("spikes/renderer-bakeoff");
const CANDIDATES = ["phaser", "three-webgl2", "three-webgpu"];
const STATES = ["dusk-rain", "night"];
const TIERS = ["low", "medium", "high"];
// Ubuntu 24.04 runners forbid unprivileged user namespaces, so Chromium's sandbox cannot start there;
// Playwright's own launches pass --no-sandbox for the same reason (its chromiumSandbox default).
const SWIFTSHADER = ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"];
// A uniformly filled 960×540 PNG deflates to a few kilobytes; a drawn, textured yard is far larger.
const DRAWN_PNG_BYTES = 20_000;

it("builds every candidate, measures the fixed sequence through the served page and a dumped DOM", async () => {
  execFileSync(process.execPath, ["scripts/build.mjs"], { cwd: spike, stdio: "inherit" });
  const out = await mkdtemp(path.join(os.tmpdir(), "bakeoff-"));
  execFileSync(
    process.execPath,
    [
      "scripts/measure.mjs",
      "--browser",
      chromium.executablePath(),
      ...SWIFTSHADER.map((flag) => `--browser-arg=${flag}`),
      "--out",
      out,
      "--frames",
      "6",
      "--warmup",
      "1",
      "--raf-frames",
      "2",
      "--label",
      "CI SwiftShader",
    ],
    { cwd: spike, stdio: "inherit", timeout: 540_000 },
  );
  const record = JSON.parse(await readFile(path.join(out, "results.json"), "utf8"));
  expect(record.candidates.map((c) => c.candidate)).toEqual(CANDIDATES);
  for (const candidate of record.candidates) {
    expect(candidate.error).toBeUndefined();
    expect(candidate.description.rendererString).toMatch(/swiftshader/iu);
    expect(candidate.performance).toBe(false);
    expect(candidate.host.label).toBe("CI SwiftShader");
    expect(candidate.browser.userAgent).toMatch(/Chrome\//u);
    expect(candidate.runs.map((r) => `${r.state}/${r.tier}/${r.frameMs.count}`)).toEqual(
      STATES.flatMap((s) => TIERS.map((t) => `${s}/${t}/6`)),
    );
    expect(candidate.reducedMotion).toEqual({ frozen: true, animatesWhenOff: true });
    const built = await stat(path.join(spike, "dist", `${candidate.candidate}.js`));
    expect(candidate.bundle.candidate.bytes).toBe(built.size);
    expect(candidate.codeLines).toBeGreaterThan(100);
    const shot = async (state, tier) =>
      readFile(path.join(out, `${candidate.candidate}-${state}-${tier}.png`));
    for (const state of STATES)
      for (const tier of TIERS)
        expect((await shot(state, tier)).length).toBeGreaterThan(DRAWN_PNG_BYTES);
    // The lighting patch and the tiers change the picture.
    expect((await shot("dusk-rain", "high")).equals(await shot("night", "high"))).toBe(false);
    expect((await shot("night", "low")).equals(await shot("night", "high"))).toBe(false);
  }

  // The owner's Edge path: the same page from a file:// URL, its record read back from the DOM.
  const dump = path.join(out, "dump.html");
  const page = `file://${path.join(spike, "dist", "index.html")}?candidates=phaser&frames=2&warmup=1&rafFrames=1`;
  const profile = await mkdtemp(path.join(os.tmpdir(), "bakeoff-profile-"));
  const html = execFileSync(
    chromium.executablePath(),
    [
      "--headless=new",
      `--user-data-dir=${profile}`,
      ...SWIFTSHADER,
      "--virtual-time-budget=120000",
      "--dump-dom",
      page,
    ],
    { timeout: 240_000, maxBuffer: 256 * 1024 * 1024 },
  );
  await writeFile(dump, html);
  const fromDom = path.join(out, "from-dom");
  execFileSync(process.execPath, ["scripts/measure.mjs", "--from-dom", dump, "--out", fromDom], {
    cwd: spike,
    stdio: "inherit",
  });
  const dumped = JSON.parse(await readFile(path.join(fromDom, "results.json"), "utf8"));
  expect(dumped.candidates.map((c) => [c.candidate, c.error, c.performance])).toEqual([
    ["phaser", undefined, false],
  ]);
  expect(dumped.candidates[0].runs).toHaveLength(6);
}, 900_000);
