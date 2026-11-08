// Issue 77: the 3D Stevie spike builds and renders under software rendering (SwiftShader), the only GPU
// this CI host has. CI checks only that (the issue: "CI checks only that the spike builds and renders
// under SwiftShader"): every arm renders every declared shot in both lighting states, each PNG is the
// declared size and its recorded sha256 matches the written bytes, and no SwiftShader time is reported
// as performance. Look, cost and GPU timing are judged from the report, not asserted.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import { stevieReport } from "../../spikes/renderer-bakeoff/scripts/stevie.mjs";

const spike = path.resolve("spikes/renderer-bakeoff");
const ARMS = ["3d", "2d", "3d-sprites"];
const STATES = ["dusk-rain", "night"];
// The declared shots, written out here rather than read from the page (design checklist item 5).
const SHOTS = [
  ...["three-quarter", "right", "back", "left", "front"].map((h) => `still-${h}`),
  ...Array.from({ length: 8 }, (_, i) => `walk-${i}`),
  ...Array.from({ length: 4 }, (_, i) => `idle-${i}`),
  "cohesion",
];
const CLOSE = { width: 360, height: 360 };
const WIDE = { width: 960, height: 540 };
const ATLASES = [
  "sprites-albedo",
  "sprites-normal",
  "sprites-depth",
  "sheet-albedo",
  "sheet-normal",
];
const SWIFTSHADER = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"];

function pngSize(bytes) {
  if (bytes.length < 24 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

it("builds the spike and renders every arm's shots in both lighting states", async () => {
  execFileSync(process.execPath, ["scripts/build.mjs"], { cwd: spike, stdio: "inherit" });
  const out = await mkdtemp(path.join(os.tmpdir(), "stevie-"));
  const browser = await chromium.launch({ headless: true, args: SWIFTSHADER });
  const consoleErrors = [];
  try {
    const record = await stevieReport({
      out,
      label: "CI SwiftShader",
      // The stand-in arms only, whatever git-ignored media/ this host holds.
      models: [],
      timedFrames: 2,
      timeoutMs: 840_000,
      launch: async (url) => {
        const tab = await browser.newPage();
        tab.on("console", (m) => {
          if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300));
        });
        tab.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`.slice(0, 300)));
        const failed = new Promise((resolve) => tab.on("crash", () => resolve("the page crashed")));
        await tab.goto(url);
        return {
          failed,
          close: () => tab.close(),
          executable: `Playwright Chromium ${browser.version()}`,
          browserArgs: SWIFTSHADER,
        };
      },
    });

    const summary = {};
    const expected = {};
    for (const arm of record.arms) {
      const files = {};
      let hashesMatch = true;
      for (const [key, shot] of Object.entries(arm.shots)) {
        const bytes = await readFile(path.join(out, shot.file)).catch(() => Buffer.alloc(0));
        files[key] = bytes;
        hashesMatch &&= sha256(bytes) === shot.sha256;
      }
      const sized = Object.entries(files).every(([key, bytes]) => {
        const want = key.endsWith("/cohesion") ? WIDE : CLOSE;
        return JSON.stringify(pngSize(bytes)) === JSON.stringify(want);
      });
      summary[arm.arm] = {
        error: arm.error,
        shots: Object.keys(arm.shots),
        sized,
        hashesMatch,
        lightingChangesThePicture: !files["dusk-rain/cohesion"]?.equals(
          files["night/cohesion"] ?? Buffer.alloc(0),
        ),
        softwareIsNeverPerformance: arm.performance === false,
      };
      expected[arm.arm] = {
        error: null,
        shots: STATES.flatMap((s) => SHOTS.map((shot) => `${s}/${shot}`)),
        sized: true,
        hashesMatch: true,
        lightingChangesThePicture: true,
        softwareIsNeverPerformance: true,
      };
    }
    const atlasesHashed = [];
    for (const [name, atlas] of Object.entries(record.atlases ?? {})) {
      const bytes = await readFile(path.join(out, atlas.file));
      if (sha256(bytes) === atlas.sha256 && pngSize(bytes)) atlasesHashed.push(name);
    }
    expect(
      {
        arms: record.arms.map((a) => a.arm),
        summary,
        atlases: atlasesHashed.sort(),
        model: record.model.kind,
      },
      JSON.stringify({
        renderer: record.arms[0]?.description?.rendererString,
        consoleErrors,
      }).slice(0, 4_000),
    ).toEqual({
      arms: ARMS,
      summary: expected,
      atlases: [...ATLASES].sort(),
      model: "procedural-stand-in",
    });
  } finally {
    await browser.close();
  }
}, 900_000);
