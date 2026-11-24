// The host of `pnpm playground` (issue 327, started by scripts/playground.mjs). It runs one
// scripts/dev-world.mjs launcher per loaded world and a control server on 127.0.0.1 that the worlds'
// sessions (scripts/dev-world.session.mjs) forward the browser's /playground/v1 requests to, after
// the runtime has authorized the caller. This file imports only Node built-ins.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const CLI = path.join(root, "packages/simulator/cli/clockgrove.mjs");
const PREVIEW = path.join(root, "scripts/playground-migration-preview.mjs");
const MAX_BODY = 64 * 1024;

function readManifest(directory) {
  try {
    const manifest = JSON.parse(readFileSync(path.join(directory, "manifest.json"), "utf8"));
    return manifest !== null && typeof manifest === "object" && !Array.isArray(manifest)
      ? manifest
      : null;
  } catch {
    return null;
  }
}

/** The pack's name, version and content counts, read once from its manifest. */
export function packMetadata(directory) {
  const manifest = readManifest(directory) ?? {};
  const count = (list) => (Array.isArray(list) ? list.length : 0);
  const scenarios = path.join(directory, "scenarios");
  return {
    name: manifest.id ?? null,
    version: manifest.version ?? null,
    content: {
      entities: count(manifest.actors),
      places: count(manifest.spaces),
      rules: count(manifest.rules),
      scenarios: existsSync(scenarios)
        ? readdirSync(scenarios).filter((name) => name.endsWith(".json")).length
        : 0,
      art: count(manifest.assets),
    },
  };
}

/** Runs `node <script> <args>` and collects its stdout; the CLI's warnings on stderr are dropped. */
function run(script, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", () => resolve({ code: null, stdout }));
    child.on("close", (code) => resolve({ code, stdout }));
  });
}

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/**
 * Starts the conformance checks (`pack build`, then `pack test`) in the background. The returned
 * state changes in place from "running" to "passed", "failed" or "unavailable"; `done` settles then.
 */
export function startChecks(directory) {
  const checks = { status: "running", results: [] };
  checks.done = (async () => {
    const scratch = await mkdtemp(path.join(tmpdir(), "clockgrove-playground-"));
    try {
      const artifact = path.join(scratch, "pack.artifact");
      const built = await run(CLI, ["pack", "build", "--pack", directory, "--out", artifact]);
      const build = parseJson(built.stdout);
      if (built.code === 1 && build?.refusal) {
        checks.status = "failed";
        checks.refusal = build.refusal;
        return;
      }
      if (built.code !== 0) throw new Error("build unavailable");
      const tested = await run(CLI, ["pack", "test", "--artifact", artifact]);
      const test = parseJson(tested.stdout);
      if ((tested.code !== 0 && tested.code !== 1) || !Array.isArray(test?.result?.checks))
        throw new Error("test unavailable");
      checks.results = test.result.checks.map(({ name, scenario, status, refusal }) => ({
        name,
        scenario,
        status,
        refusal,
      }));
      checks.status = tested.code === 0 ? "passed" : "failed";
    } catch {
      checks.status = "unavailable";
      checks.results = [];
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  })();
  Object.defineProperty(checks, "done", { enumerable: false });
  return checks;
}

const send = (response, status, body) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size <= MAX_BODY) chunks.push(chunk);
      else if (size - chunk.length <= MAX_BODY)
        reject(Object.assign(new Error("too large"), { tooLarge: true }));
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

/**
 * The host: `start()` opens the control server and spawns the first world's launcher, then resolves
 * with the first world's exit code once every launcher has exited. `spawnLauncher(world, env)` and
 * `directory` of the first world are injectable so the control routes can be exercised alone.
 */
export function createPlaygroundHost({ directory, shell, assets, spawnLauncher = spawnDevWorld }) {
  const secret = randomBytes(32).toString("hex");
  const worlds = new Map();
  let running = 0;
  let settle;
  const allExited = new Promise((resolve) => {
    settle = resolve;
  });
  let controlUrl = null;

  const entryOf = (world, caller) => ({
    id: world.id,
    packId: world.packId,
    version: world.version,
    directory: world.directory,
    status: world.status,
    url: world.url,
    current: world.id === caller,
  });

  function addWorld(worldDirectory, extra) {
    const manifest = readManifest(worldDirectory) ?? {};
    const world = {
      id: String(worlds.size + 1),
      packId: manifest.id ?? null,
      version: manifest.version ?? null,
      directory: worldDirectory,
      status: "starting",
      url: null,
      metadata: packMetadata(worldDirectory),
      checks: startChecks(worldDirectory),
    };
    worlds.set(world.id, world);
    const worldShell = extra?.shell ?? path.join(worldDirectory, "shell.json");
    running += 1;
    let printed = "";
    const child = spawnLauncher(
      world,
      {
        CLOCKGROVE_DEV_WORLD_PACK: worldDirectory,
        CLOCKGROVE_DEV_WORLD_ROLE: "owner",
        ...(existsSync(worldShell) ? { CLOCKGROVE_WORLD_SHELL: worldShell } : {}),
        ...(extra?.assets === undefined ? {} : { CLOCKGROVE_WORLD_ASSETS: extra.assets }),
        CLOCKGROVE_PLAYGROUND_HOST: controlUrl,
        CLOCKGROVE_PLAYGROUND_SECRET: secret,
        CLOCKGROVE_PLAYGROUND_WORLD: world.id,
      },
      (text) => {
        // The session prints its URL once; a chunk may end inside that line.
        printed = (printed + text).slice(-8192);
        const open = /Open: +(\S+)\n/u.exec(printed);
        if (open && world.url === null) {
          world.url = open[1];
          world.status = "ready";
        }
      },
    );
    world.child = child;
    world.exit = new Promise((resolve) => {
      child.on("exit", (code, signal) => {
        world.status = "stopped";
        running -= 1;
        resolve(code ?? (signal === null ? 1 : 128));
        if (running === 0) settle();
      });
    });
    return world;
  }

  async function handle(request, response) {
    const caller = worlds.get(request.headers["x-playground-world"]);
    if (request.headers["x-playground-secret"] !== secret || caller === undefined)
      return send(response, 403, { error: "forbidden" });
    if (request.method !== "POST") return send(response, 405, { error: "method_not_allowed" });
    let body;
    try {
      body = parseJson((await readBody(request)) || "{}");
    } catch (error) {
      return send(response, error.tooLarge ? 413 : 400, {
        error: error.tooLarge ? "too_large" : "bad_request",
      });
    }
    if (body === null || typeof body !== "object" || Array.isArray(body))
      return send(response, 400, { error: "bad_request" });

    switch (request.url) {
      case "/pack":
        return send(response, 200, {
          world: entryOf(caller, caller.id),
          metadata: caller.metadata,
          checks: caller.checks,
        });
      case "/worlds":
        return send(response, 200, {
          worlds: [...worlds.values()].map((world) => entryOf(world, caller.id)),
        });
      case "/load": {
        const target =
          typeof body.directory === "string" && body.directory !== ""
            ? path.resolve(body.directory)
            : null;
        if (
          target === null ||
          !existsSync(target) ||
          !statSync(target).isDirectory() ||
          readManifest(target) === null
        )
          return send(response, 400, {
            error: "not_a_pack",
            message: "Not a world pack directory (no readable manifest.json).",
          });
        return send(response, 200, { world: entryOf(addWorld(target), caller.id) });
      }
      case "/migration-preview": {
        if (typeof body.directory !== "string" || body.directory === "")
          return send(response, 400, { error: "bad_request" });
        const { code, stdout } = await run(PREVIEW, [
          path.resolve(body.directory),
          String(caller.packId),
          String(caller.version),
        ]);
        const preview = parseJson(stdout);
        if ((code === 0 || code === 1) && preview !== null)
          return send(response, code === 0 ? 200 : 422, preview);
        return send(response, 500, { error: "preview_unavailable" });
      }
      default:
        return send(response, 404, { error: "not_found" });
    }
  }

  const server = createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) send(response, 500, { error: "internal_error" });
    });
  });

  return {
    secret,
    worlds,
    server,
    /** Opens the control server on a free loopback port and spawns the first world. */
    async listen() {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      controlUrl = `http://127.0.0.1:${server.address().port}`;
      return controlUrl;
    },
    start() {
      return this.listen().then(async () => {
        const first = addWorld(directory, { shell, assets });
        for (const signal of ["SIGTERM", "SIGHUP"])
          process.on(signal, () => {
            for (const world of worlds.values())
              if (world.status !== "stopped") world.child.kill(signal);
          });
        const code = await first.exit;
        await allExited;
        server.closeAllConnections();
        server.close();
        return code;
      });
    },
  };
}

/** Spawns one scripts/dev-world.mjs launcher; its output is forwarded, the first world's unchanged. */
function spawnDevWorld(world, env, onText) {
  const child = spawn(process.execPath, [path.join(root, "scripts/dev-world.mjs")], {
    cwd: root,
    stdio: ["inherit", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  for (const [stream, target] of [
    [child.stdout, process.stdout],
    [child.stderr, process.stderr],
  ]) {
    let partial = "";
    stream.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      onText(text);
      if (!target.writable) return;
      if (world.id === "1") return void target.write(chunk);
      const lines = (partial + text).split("\n");
      partial = lines.pop();
      for (const line of lines) target.write(`[world ${world.id}] ${line}\n`);
    });
    stream.on("end", () => {
      if (partial !== "" && target.writable) target.write(`[world ${world.id}] ${partial}\n`);
    });
  }
  return child;
}

/** Runs the host for `pnpm playground`; resolves with the exit code. */
export function runPlaygroundHost(options) {
  for (const stream of [process.stdout, process.stderr]) stream.on("error", () => undefined);
  // The launchers share this process group, so Ctrl-C reaches each of them directly.
  process.on("SIGINT", () => undefined);
  return createPlaygroundHost(options).start();
}
