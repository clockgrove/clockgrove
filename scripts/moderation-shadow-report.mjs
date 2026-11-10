import { spawnSync } from "node:child_process";
import { lstat, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const usage =
  "Usage: node scripts/moderation-shadow-report.mjs --output <new-report.json> [--pack <pack-directory>] [--live]";
const root = fileURLToPath(new URL("../", import.meta.url));
let values;
let policies;
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
  if (!values.output || !(await stat(path.dirname(path.resolve(values.output)))).isDirectory())
    throw new Error(usage);
  const existing = await lstat(path.resolve(values.output)).catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing) throw new Error("Output must not exist");
  if (values.pack && !(await stat(path.resolve(values.pack))).isDirectory())
    throw new Error("Pack must be a directory");
  policies = values.live
    ? JSON.parse(
        process.env.MODERATION_SHADOW_MODELS ?? `[${process.env.MODERATION_SHADOW_CONFIG ?? ""}]`,
      )
    : [
        { modelAlias: "moderation.scripted-a", model: "scripted-moderation-a" },
        { modelAlias: "moderation.scripted-b", model: "scripted-moderation-b" },
      ];
  // Decision: three policies bound this operator probe to eighteen decision opportunities.
  if (
    !Array.isArray(policies) ||
    policies.length < 1 ||
    policies.length > 3 ||
    policies.some(
      (policy) => typeof policy.modelAlias !== "string" || typeof policy.model !== "string",
    )
  )
    throw new Error("Configure one to three model policies");
} catch {
  process.stderr.write(
    `${usage}\nLive measurements require MODERATION_SHADOW_CONFIG or MODERATION_SHADOW_MODELS JSON.\n`,
  );
  process.exit(2);
}
const require = createRequire(import.meta.url);
const {
  AI_GATEWAY_API_KEY: key,
  ANTHROPIC_API_KEY: _anthropic,
  NATIVE_MODERATION_SHADOW_SCRIPT: _script,
  CLOCKGROVE_MODERATION_SHADOW_LIVE: _live,
  WAKE_TRIAGE_CONFIG: _triage,
  ...environment
} = process.env;
const result = spawnSync(
  process.execPath,
  [
    path.join(path.dirname(require.resolve("vitest/package.json")), "vitest.mjs"),
    "run",
    "--config",
    "scripts/moderation-shadow-report.vitest.config.ts",
  ],
  {
    cwd: root,
    stdio: "inherit",
    // Decision: ten minutes bounds provisioning and at most eighteen gateway-bounded decisions.
    timeout: 600_000,
    env: {
      ...environment,
      NATIVE_MODERATION_SHADOW_SCRIPTED_TURNS: "1",
      MODERATION_SHADOW_MODELS: JSON.stringify(policies),
      MODERATION_SHADOW_CONFIG: JSON.stringify(policies[0]),
      CLOCKGROVE_MODERATION_SHADOW_PACK: values.pack ? path.resolve(values.pack) : "",
      CLOCKGROVE_MODERATION_SHADOW_OUTPUT: path.resolve(values.output),
      ...(values.live
        ? { CLOCKGROVE_MODERATION_SHADOW_LIVE: "1", ...(key ? { AI_GATEWAY_API_KEY: key } : {}) }
        : {}),
    },
  },
);
if (result.error)
  process.stderr.write("Moderation shadow report did not finish within its execution bound.\n");
process.exit(result.status ?? 1);
