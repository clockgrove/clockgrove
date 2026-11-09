// `pnpm dev:world`: the local living-hall checkpoint. The session itself is
// scripts/dev-world.session.mjs, run through Vitest. Vitest exits at once on Ctrl-C, before the
// harness can stop PostgreSQL and remove its temporary directories, so this launcher runs it in its
// own process group and turns Ctrl-C, SIGTERM or a closed terminal (SIGHUP) into a stop file the session watches. The session
// then returns and the harness tears everything down as it does after a journey.
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const usage =
  "Usage: node scripts/dev-world.mjs [--pack <pack-directory> --shell <shell-json> --assets <static-directory>]";
let inputs = {};
try {
  const { values, tokens } = parseArgs({
    options: { pack: { type: "string" }, shell: { type: "string" }, assets: { type: "string" } },
    strict: true,
    allowPositionals: false,
    tokens: true,
  });
  if (tokens.length !== 0) {
    if (
      tokens.length !== 3 ||
      [values.pack, values.shell, values.assets].some((value) => !value || value.startsWith("--"))
    )
      throw new Error(usage);
    const pack = path.resolve(values.pack);
    const shell = path.resolve(values.shell);
    const assets = path.resolve(values.assets);
    for (const directory of [pack, assets])
      if (!(await stat(directory)).isDirectory()) throw new Error(`Not a directory: ${directory}`);
    if (!(await stat(shell)).isFile()) throw new Error(`Not a file: ${shell}`);
    inputs = {
      CLOCKGROVE_DEV_WORLD_PACK: pack,
      CLOCKGROVE_WORLD_SHELL: shell,
      CLOCKGROVE_WORLD_ASSETS: assets,
    };
  }
} catch (error) {
  process.stderr.write(`${error.message}\n${usage}\n`);
  process.exit(2);
}

const root = fileURLToPath(new URL("../", import.meta.url));
const vitest = path.join(
  path.dirname(createRequire(import.meta.url).resolve("vitest/package.json")),
  "vitest.mjs",
);
// CLOCKGROVE_DEV_WORLD_HOURS overrides the 4 h session bound (and the credential's lifetime).
const hours = process.env.CLOCKGROVE_DEV_WORLD_HOURS;
if (hours !== undefined && !(Number(hours) > 0)) {
  process.stderr.write(
    `CLOCKGROVE_DEV_WORLD_HOURS must be a positive number of hours, not "${hours}".\n`,
  );
  process.exit(2);
}
const control = await mkdtemp(path.join(tmpdir(), "clockgrove-dev-hall-"));
const stopFile = path.join(control, "stop");
const session = spawn(
  process.execPath,
  [vitest, "run", "--config", "scripts/dev-world.vitest.config.ts"],
  {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    env: { ...process.env, ...inputs, CLOCKGROVE_DEV_WORLD_STOP: stopFile },
  },
);
// The session writes through this launcher, never to the terminal itself, so a closed terminal
// cannot fail its writes; the launcher drops output it can no longer deliver.
for (const stream of [process.stdout, process.stderr]) stream.on("error", () => undefined);
session.stdout.on("data", (chunk) => process.stdout.writable && process.stdout.write(chunk));
session.stderr.on("data", (chunk) => process.stderr.writable && process.stderr.write(chunk));
const stop = () => {
  if (process.stdout.writable)
    process.stdout.write("\nStopping the living hall and removing its database…\n");
  writeFile(stopFile, "stop").catch(() => undefined);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.on("SIGHUP", stop);
const [code, signal] = await new Promise((resolve) =>
  session.on("exit", (exitCode, exitSignal) => resolve([exitCode, exitSignal])),
);
await rm(control, { recursive: true, force: true });
process.exit(code ?? (signal === null ? 1 : 128));
