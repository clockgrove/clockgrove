import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { REPO_ROOT } from "./pack-source.js";

// Two sequential workerd conformance invocations share the existing 240 s per-run bound.
const RUN_TIMEOUT = 240_000;

it(
  "checks an external pack from its repository and rejects a changed golden",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "clockgrove-external-"));
    try {
      const pack = join(root, "worlds", "sample");
      await cp(join(REPO_ROOT, "worlds", "fixture"), pack, { recursive: true });
      const assets = join(root, "assets", "manifests", "fixture-critter");
      await mkdir(assets, { recursive: true });
      const asset = JSON.parse(
        await readFile(
          join(REPO_ROOT, "packages/contracts/test/fixtures/asset-manifest/approved.json"),
          "utf8",
        ),
      );
      asset.semantic.entity = "beacon.master";
      await writeFile(join(assets, "idle.json"), JSON.stringify(asset));
      await writeFile(
        join(pack, "presentation.json"),
        JSON.stringify({
          presentationVersion: 1,
          assetManifestVersion: 2,
          pack: { id: "clockgrove.test-world", version: "1.1.0" },
          bindings: [
            {
              objectId: "beacon.master",
              assetId: "fixture-critter",
              animationFamily: "idle",
              accessibilityLabel: "Keeper",
            },
          ],
          effects: [],
        }),
      );
      const args = [
        join(REPO_ROOT, "scripts", "check-world-pack.mjs"),
        "--pack",
        "worlds/sample",
        "--assets",
        "assets/manifests",
      ];
      const run = () =>
        promisify(execFile)(process.execPath, args, {
          cwd: root,
          timeout: RUN_TIMEOUT,
        });
      const { stdout } = await run();
      const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
      expect(result.status).toBe("ok");
      expect(
        result.reports.map((report: { pack: string; scenario: string }) => [
          report.pack,
          report.scenario,
        ]),
      ).toEqual([
        ["sample", "neutral-conformance"],
        ["sample", "neutral-conformance"],
      ]);
      expect(result.reports.map((report: { runtime: string }) => report.runtime)).toEqual([
        `node/${process.version}`,
        "Cloudflare-Workers (workerd)",
      ]);
      expect(result.reports[0].bundleHash).toBe(result.reports[1].bundleHash);
      const golden = join(pack, "goldens", "neutral-conformance.json");
      const original = await readFile(golden);
      await writeFile(golden, "{}");
      await expect(run()).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('check "golden-match"'),
      });
      expect(await readFile(golden, "utf8")).toBe("{}");
      expect(await readFile(join(pack, "goldens", "neutral-conformance.actual.json"))).toEqual(
        original,
      );
      await rm(join(assets, "idle.json"));
      await expect(run()).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('check "presentation-bindings"'),
      });
      for (const invalid of [
        [],
        [...args.slice(1), "--pack", "worlds/sample"],
        ["--unknown", "value"],
      ]) {
        await expect(
          promisify(execFile)(process.execPath, [args[0]!, ...invalid], {
            cwd: root,
            timeout: RUN_TIMEOUT,
          }),
        ).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining("Usage:") });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  RUN_TIMEOUT * 2,
);
