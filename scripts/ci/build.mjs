import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { root, subprocessEvidence } from "./evidence.mjs";

const directory = process.argv[2];
if (!directory || !path.isAbsolute(directory)) throw new Error("explicit build directory required");
await mkdir(directory, { recursive: true });
assert.deepEqual(await readdir(directory), [], "refuse overwriting prior build artifacts");
const worker = path.join(root, "apps/runtime/.wrangler/clockgrove-release-build");
await mkdir(path.dirname(worker), { recursive: true });
// Fixed source-relative producer destination makes esbuild's sources deterministic too.
// Refuse collisions rather than deleting an existing resource.
await mkdir(worker);
try {
  for (const [executable, args, cwd] of [
    [path.join(root, "apps/web/node_modules/.bin/vite"), ["build"], path.join(root, "apps/web")],
    [
      path.join(root, "node_modules/.bin/wrangler"),
      ["deploy", "--config", "infra/wrangler/ci.json", "--dry-run", "--outdir", worker],
      root,
    ],
  ]) {
    const date = execFileSync("git", ["show", "-s", "--format=%cI", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    const result = spawnSync(executable, args, {
      cwd,
      stdio: "inherit",
      env: {
        ...process.env,
        WRANGLER_SEND_METRICS: "false",
        CLOCKGROVE_BUILD_DATE: new Date(date).toISOString(),
        NODE_OPTIONS: `--import=${path.join(root, "scripts/ci/build-metadata.mjs")}`,
      },
    });
    const observed = subprocessEvidence(result);
    if (observed.status !== "passed")
      throw new Error(
        `candidate production bundle failed: ${JSON.stringify(observed)}; usage unknown`,
      );
  }
  await cp(path.join(root, "apps/web/dist"), path.join(directory, "web"), { recursive: true });
  await cp(worker, path.join(directory, "worker"), { recursive: true });
} finally {
  await rm(worker, { recursive: true, force: true });
}
