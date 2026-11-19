// `pnpm playground` (issue 327): the local pack host. It serves Clockgrove with the neutral playground
// pack (worlds/playground) on localhost and signs its one local credential in as the world's owner;
// `--pack <directory>` loads the developer's own pack in its place as a fresh world from that pack's
// declared seed. No cloud account and no model key are needed. It installs the workspace on a fresh
// clone, then runs scripts/dev-world.mjs, the living-hall launcher, which owns the session, Ctrl-C and
// clean-up. This file imports only Node built-ins, so it runs before the install.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const usage =
  "Usage: pnpm playground [--pack <pack-directory>] [--shell <shell-json>] [--assets <static-directory>]";
const root = fileURLToPath(new URL("../", import.meta.url));
const PLAYGROUND = path.join(root, "worlds/playground");

let inputs;
try {
  const { values } = parseArgs({
    options: { pack: { type: "string" }, shell: { type: "string" }, assets: { type: "string" } },
    strict: true,
    allowPositionals: false,
  });
  for (const value of Object.values(values))
    if (!value || value.startsWith("--")) throw new Error(usage);
  const pack = path.resolve(values.pack ?? PLAYGROUND);
  if (!existsSync(pack) || !statSync(pack).isDirectory())
    throw new Error(`Not a directory: ${pack}`);
  if (!existsSync(path.join(pack, "manifest.json")))
    throw new Error(`Not a world pack (no manifest.json): ${pack}`);
  // The pack's own shell.json unless --shell names another; without either, the neutral shell.
  const shell =
    values.shell === undefined ? path.join(pack, "shell.json") : path.resolve(values.shell);
  if (values.shell !== undefined && !(existsSync(shell) && statSync(shell).isFile()))
    throw new Error(`Not a file: ${shell}`);
  const assets = values.assets === undefined ? undefined : path.resolve(values.assets);
  if (assets !== undefined && !(existsSync(assets) && statSync(assets).isDirectory()))
    throw new Error(`Not a directory: ${assets}`);
  inputs = {
    CLOCKGROVE_DEV_WORLD_PACK: pack,
    ...(existsSync(shell) ? { CLOCKGROVE_WORLD_SHELL: shell } : {}),
    ...(assets === undefined ? {} : { CLOCKGROVE_WORLD_ASSETS: assets }),
    CLOCKGROVE_DEV_WORLD_ROLE: "owner",
  };
} catch (error) {
  process.stderr.write(`${error.message}\n${usage}\n`);
  process.exit(2);
}

// A fresh clone has no workspace yet: install it from the lockfile first.
if (!existsSync(path.join(root, "node_modules/.modules.yaml"))) {
  process.stdout.write("Installing the workspace (pnpm install --frozen-lockfile)…\n");
  const installed = spawnSync("pnpm", ["install", "--frozen-lockfile"], {
    cwd: root,
    stdio: "inherit",
  });
  if (installed.status !== 0) process.exit(installed.status ?? 1);
}

// The launcher shares this process group, so Ctrl-C reaches it directly; this process only waits
// for it and passes on a SIGTERM or SIGHUP sent to this process alone.
const host = spawn(process.execPath, [path.join(root, "scripts/dev-world.mjs")], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, ...inputs },
});
process.on("SIGINT", () => undefined);
for (const signal of ["SIGTERM", "SIGHUP"]) process.on(signal, () => host.kill(signal));
const [code, signal] = await new Promise((resolve) =>
  host.on("exit", (exitCode, exitSignal) => resolve([exitCode, exitSignal])),
);
process.exit(code ?? (signal === null ? 1 : 128));
