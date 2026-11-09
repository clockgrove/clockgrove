#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { readCaptureApprovals } from "./capture-world-report.mjs";

const usage =
  "Usage: node scripts/capture-world.mjs --pack <pack-directory> --shell <shell-json> --assets <static-directory> --out <world-capture-directory> [--actor <object-id>] [--object <object-id>]";
const root = await realpath(fileURLToPath(new URL("../", import.meta.url)));
let options;
try {
  const { values, tokens } = parseArgs({
    options: Object.fromEntries(
      ["pack", "shell", "assets", "out", "actor", "object"].map((name) => [
        name,
        { type: "string" },
      ]),
    ),
    strict: true,
    allowPositionals: false,
    tokens: true,
  });
  if (
    ["pack", "shell", "assets", "out"].some((name) => !values[name]) ||
    tokens.length !== new Set(tokens.map(({ name }) => name)).size ||
    Object.values(values).some((value) => !value || value.startsWith("--"))
  )
    throw new Error(usage);
  options = Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      ["actor", "object"].includes(key) ? value : path.resolve(value),
    ]),
  );
  for (const name of ["pack", "assets"]) {
    options[name] = await realpath(options[name]);
    if (!(await stat(options[name])).isDirectory())
      throw new Error(`Not a directory: ${options[name]}`);
  }
  options.shell = await realpath(options.shell);
  if (!(await stat(options.shell)).isFile()) throw new Error(`Not a file: ${options.shell}`);
  // Resolve the nearest existing parent as well, so a symlink cannot redirect captures into the checkout.
  const resolveOutput = async (target) => {
    try {
      return await realpath(target);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return path.join(await resolveOutput(path.dirname(target)), path.basename(target));
    }
  };
  options.out = await resolveOutput(options.out);
  if (options.out === root || options.out.startsWith(`${root}${path.sep}`))
    throw new Error("External captures must be outside the Clockgrove checkout");
  try {
    if (!(await stat(options.out)).isDirectory())
      throw new Error(`Not a directory: ${options.out}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
} catch (error) {
  console.error(`${error.message}\n${usage}`);
  process.exitCode = 2;
}

if (options && process.exitCode === undefined) {
  try {
    await mkdir(options.out, { recursive: true });
    await writeFile(
      path.join(options.out, "approved-captures.json"),
      `${JSON.stringify(
        {
          note: "A person, or an agent on the owner's explicit delegation, approves each file and SHA-256 in a reviewed change. CI never approves captures.",
          approvals: [],
        },
        null,
        2,
      )}\n`,
      { flag: "wx" },
    ).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
    const require = createRequire(import.meta.url);
    const vitest = path.join(path.dirname(require.resolve("vitest/package.json")), "vitest.mjs");
    const env = {
      ...process.env,
      CI: "true",
      CLOCKGROVE_CAPTURE_PACK: options.pack,
      CLOCKGROVE_CAPTURE_OUT: options.out,
      CLOCKGROVE_WORLD_SHELL: options.shell,
      CLOCKGROVE_WORLD_ASSETS: options.assets,
    };
    delete env.CLOCKGROVE_RENDERER_PROOF;
    delete env.CLOCKGROVE_WORLD_OWNER_FIXTURE;
    delete env.CLOCKGROVE_CAPTURE_ACTOR;
    delete env.CLOCKGROVE_CAPTURE_OBJECT;
    if (options.actor) env.CLOCKGROVE_CAPTURE_ACTOR = options.actor;
    if (options.object) env.CLOCKGROVE_CAPTURE_OBJECT = options.object;
    // Two existing 240 s backend bounds plus teardown; never leave a native process tree behind.
    const child = spawn(
      process.execPath,
      [
        vitest,
        "run",
        "--config",
        "tests/ci/vitest.browser.config.ts",
        "tests/visual/golden-states.journey.browser.test.mjs",
      ],
      { cwd: root, env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stdout.pipe(process.stderr);
    child.stderr.pipe(process.stderr);
    const stop = () => {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    };
    const kill = () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    };
    const timer = setTimeout(kill, 540_000);
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    let result;
    try {
      result = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code));
      });
    } finally {
      clearTimeout(timer);
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
    if (result !== 0) {
      console.error("World capture suite failed; see browser/runtime diagnostics above.");
      process.exitCode = 1;
    } else {
      const reports = await readCaptureApprovals(options.out);
      const report = { status: "ok", reports };
      await writeFile(
        path.join(options.out, "approval-status.json"),
        `${JSON.stringify(report, null, 2)}\n`,
      );
      console.info(JSON.stringify(report));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 70;
  }
}
