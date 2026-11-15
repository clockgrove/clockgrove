import { spawnSync } from "node:child_process";
import { lstat, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

// Issue 271: runs the labelled category set and the labelled actor-reply set through the
// moderation and actor-reply judges on one to three decision models. Scripted by default; --live
// asks the configured models through Vercel AI Gateway with AI_GATEWAY_API_KEY.
const usage = "Usage: node scripts/moderation-eval.mjs --output <new-report.json> [--live]";
const root = fileURLToPath(new URL("../", import.meta.url));
let values;
let policies;
try {
  ({ values } = parseArgs({
    options: { output: { type: "string" }, live: { type: "boolean", default: false } },
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
  policies = values.live
    ? JSON.parse(
        process.env.MODERATION_SHADOW_MODELS ?? `[${process.env.MODERATION_SHADOW_CONFIG ?? ""}]`,
      )
    : [
        { modelAlias: "moderation.scripted-a", model: "scripted-moderation-a" },
        { modelAlias: "moderation.scripted-b", model: "scripted-moderation-b" },
      ];
  // Decision: one to three models, as the moderation shadow report allows.
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
  CLOCKGROVE_MODERATION_EVAL_LIVE: _live,
  ...environment
} = process.env;
const result = spawnSync(
  process.execPath,
  [
    path.join(path.dirname(require.resolve("vitest/package.json")), "vitest.mjs"),
    "run",
    "--config",
    "scripts/moderation-eval.vitest.config.ts",
  ],
  {
    cwd: root,
    stdio: "inherit",
    // Decision: thirty minutes bounds 915 calls (305 per model, three models) at eight in flight,
    // each under the gateway's 5 s decision timeout.
    timeout: 1_800_000,
    env: {
      ...environment,
      MODERATION_SHADOW_MODELS: JSON.stringify(policies),
      CLOCKGROVE_MODERATION_EVAL_OUTPUT: path.resolve(values.output),
      ...(values.live
        ? { CLOCKGROVE_MODERATION_EVAL_LIVE: "1", ...(key ? { AI_GATEWAY_API_KEY: key } : {}) }
        : {}),
    },
  },
);
if (result.error)
  process.stderr.write("Moderation evaluation did not finish within its execution bound.\n");
process.exit(result.status ?? 1);
