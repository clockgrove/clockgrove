// `pnpm dev:yard`: the local living-yard checkpoint. The session itself is
// scripts/dev-yard.session.mjs, run through Vitest. Vitest exits at once on Ctrl-C, before the
// harness can stop PostgreSQL and remove its temporary directories, so this launcher runs it in its
// own process group and turns Ctrl-C, SIGTERM or a closed terminal (SIGHUP) into a stop file the session watches. The session
// then returns and the harness tears everything down as it does after a journey.
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const vitest = path.join(
  path.dirname(createRequire(import.meta.url).resolve("vitest/package.json")),
  "vitest.mjs",
);
// CLOCKGROVE_DEV_YARD_HOURS overrides the 4 h session bound (and the credential's lifetime).
const hours = process.env.CLOCKGROVE_DEV_YARD_HOURS;
if (hours !== undefined && !(Number(hours) > 0)) {
  process.stderr.write(
    `CLOCKGROVE_DEV_YARD_HOURS must be a positive number of hours, not "${hours}".\n`,
  );
  process.exit(2);
}
const control = await mkdtemp(path.join(tmpdir(), "clockgrove-dev-yard-"));
const stopFile = path.join(control, "stop");
const session = spawn(
  process.execPath,
  [vitest, "run", "--config", "scripts/dev-yard.vitest.config.ts"],
  {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    env: { ...process.env, CLOCKGROVE_DEV_YARD_STOP: stopFile },
  },
);
// The session writes through this launcher, never to the terminal itself, so a closed terminal
// cannot fail its writes; the launcher drops output it can no longer deliver.
for (const stream of [process.stdout, process.stderr]) stream.on("error", () => undefined);
session.stdout.on("data", (chunk) => process.stdout.writable && process.stdout.write(chunk));
session.stderr.on("data", (chunk) => process.stderr.writable && process.stderr.write(chunk));
const stop = () => {
  if (process.stdout.writable)
    process.stdout.write("\nStopping the living yard and removing its database…\n");
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
