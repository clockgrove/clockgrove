#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { readCaptureApprovals } from "./capture-world-report.mjs";

const usage =
  "Usage: node scripts/capture-world.mjs --pack <pack-directory> --shell <shell-json> --assets <static-directory> --out <world-capture-directory> [--actor <object-id>] [--object <object-id>]";
// Two existing 240 s backend bounds plus teardown.
const RUN_DEADLINE_MS = 540_000;
// The harness's own teardown margin: PostgreSQL's 12 s stop and the native owner's settling.
const STOP_GRACE_MS = 60_000;
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
    // The run owns this directory: its temporary files, PostgreSQL cluster and stop request.
    const run = await mkdtemp(path.join(os.tmpdir(), "clockgrove-capture-"));
    const stopFile = path.join(run, "stop");
    const marker = `CLOCKGROVE_CAPTURE_RUN=${path.basename(run)}`;
    const env = {
      ...process.env,
      CI: "true",
      TMPDIR: run,
      CLOCKGROVE_CAPTURE_RUN: path.basename(run),
      CLOCKGROVE_CAPTURE_STOP: stopFile,
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
    // A closed terminal must not fail the run's teardown; output it can no longer deliver is dropped.
    for (const stream of [process.stdout, process.stderr]) stream.on("error", () => undefined);
    child.stdout.on("data", (chunk) => process.stderr.writable && process.stderr.write(chunk));
    child.stderr.on("data", (chunk) => process.stderr.writable && process.stderr.write(chunk));
    // Vitest exits at once on a signal, before the harness stops PostgreSQL (see dev-world.mjs), so a
    // stop is a request the suite observes; it then tears down as it does after a failure. Only a run
    // that has not finished `STOP_GRACE_MS` after the request is terminated by force.
    let stopped;
    let force;
    const requestStop = (reason) => {
      if (stopped !== undefined) {
        if (reason !== "deadline") forceStop();
        return;
      }
      stopped = reason;
      if (process.stderr.writable)
        process.stderr.write(`\nStopping the capture run (${reason}) and removing its database…\n`);
      writeFile(stopFile, reason).catch(() => undefined);
      force = setTimeout(forceStop, STOP_GRACE_MS);
    };
    const forceStop = () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    };
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
    const handlers = signals.map((signal) => [signal, () => requestStop(signal)]);
    for (const [signal, handler] of handlers) process.on(signal, handler);
    const deadline = setTimeout(() => requestStop("deadline"), RUN_DEADLINE_MS);
    let result;
    try {
      result = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code));
      });
    } finally {
      clearTimeout(deadline);
      clearTimeout(force);
      // Whatever the suite left, including a run terminated by force, is removed before exit.
      await reapRun(run, marker);
      for (const [signal, handler] of handlers) process.off(signal, handler);
    }
    if (stopped !== undefined) {
      console.error(
        stopped === "deadline"
          ? `World capture suite exceeded its ${RUN_DEADLINE_MS / 1000} s bound and was stopped.`
          : "World capture run stopped; its database and runtime were removed.",
      );
      process.exitCode = stopped === "deadline" ? 1 : 128 + os.constants.signals[stopped];
    } else if (result !== 0) {
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

/**
 * The processes this run started, whatever their process group: each inherits the run's marker,
 * runs in the run's directory, or names it on its command line. PostgreSQL and Chromium rewrite
 * their environment block for process titles, but run in their data directory or name their
 * profile under it.
 */
async function ownedProcesses(run, marker) {
  const owned = [];
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/u.test(name) || Number(name) === process.pid) continue;
    const read = (file) => readFile(`/proc/${name}/${file}`, "latin1").catch(() => "");
    const cwd = await readlink(`/proc/${name}/cwd`).catch(() => "");
    if (
      (await read("environ")).split("\0").includes(marker) ||
      cwd === run ||
      cwd.startsWith(`${run}/`) ||
      (await read("cmdline")).includes(`${run}/`)
    )
      owned.push(Number(name));
  }
  return owned;
}

/** Sends `name` to `pid`; false when the process no longer exists. */
function send(pid, name) {
  try {
    process.kill(pid, name);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

/**
 * Stops what a finished or force-terminated run left, then removes its directory. PostgreSQL
 * daemonises out of the suite's process groups: a postmaster runs in its data directory, whose
 * `postmaster.pid` names it, and gets the immediate shutdown `pg_ctl stop --mode=immediate` sends
 * (SIGQUIT). Every other process the run still owns is then killed.
 */
async function reapRun(run, marker) {
  for (const pid of await ownedProcesses(run, marker)) {
    const directory = await readlink(`/proc/${pid}/cwd`).catch(() => "");
    const lock = await readFile(path.join(directory, "postmaster.pid"), "utf8").catch(() => "");
    if (Number(lock.split("\n")[0]) !== pid || !send(pid, "SIGQUIT")) continue;
    for (let waited = 0; waited < 10_000 && send(pid, 0); waited += 50) await delay(50);
  }
  for (let attempt = 0; ; attempt++) {
    const remaining = await ownedProcesses(run, marker);
    if (remaining.length === 0) break;
    if (attempt === 100) throw new Error(`Capture run processes survived: ${remaining.join(", ")}`);
    for (const pid of remaining) send(pid, "SIGKILL");
    await delay(50);
  }
  await rm(run, { recursive: true, force: true });
}
