import { spawnSync } from "node:child_process";
import { lstat, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const usage =
  "Usage: node scripts/wake-triage-report.mjs --output <new-report.json> [--pack <pack-directory>] [--live]";
const root = fileURLToPath(new URL("../", import.meta.url));
let values;
try {
  ({ values } = parseArgs({
    options: {
      pack: { type: "string" },
      output: { type: "string" },
      live: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  }));
  if (!values.output) throw new Error(usage);
  if (!(await stat(path.dirname(path.resolve(values.output)))).isDirectory())
    throw new Error(usage);
  const existing = await lstat(path.resolve(values.output)).catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing) throw new Error("Output must not exist");
  if (values.pack && !(await stat(path.resolve(values.pack))).isDirectory())
    throw new Error("Pack must be a directory");
} catch {
  process.stderr.write(`${usage}\n`);
  process.exit(2);
}
const require = createRequire(import.meta.url);
const {
  AI_GATEWAY_API_KEY: key,
  ANTHROPIC_API_KEY: _anthropic,
  NATIVE_WAKE_TRIAGE_SCRIPT: _script,
  CLOCKGROVE_WAKE_TRIAGE_LIVE: _live,
  ...environment
} = process.env;
const result = spawnSync(
  process.execPath,
  [
    path.join(path.dirname(require.resolve("vitest/package.json")), "vitest.mjs"),
    "run",
    "--config",
    "scripts/wake-triage-report.vitest.config.ts",
  ],
  {
    cwd: root,
    stdio: "inherit",
    // Decision: ten minutes bounds provisioning, one simulated day and seven model turns.
    timeout: 600_000,
    env: {
      ...environment,
      WAKE_TRIAGE_CONFIG: environment.WAKE_TRIAGE_CONFIG ?? "{}",
      CLOCKGROVE_WAKE_TRIAGE_PACK: values.pack ? path.resolve(values.pack) : "fixture/reference",
      CLOCKGROVE_WAKE_TRIAGE_OUTPUT: path.resolve(values.output),
      ...(values.live
        ? { CLOCKGROVE_WAKE_TRIAGE_LIVE: "1", ...(key ? { AI_GATEWAY_API_KEY: key } : {}) }
        : {}),
    },
  },
);
if (result.error)
  process.stderr.write("Wake-triage report did not finish within its execution bound.\n");
process.exit(result.status ?? 1);
