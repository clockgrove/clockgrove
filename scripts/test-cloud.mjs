// `pnpm test:cloud [environment]`: the cloud suite (tests/cloud) against one canonical environment,
// staging by default. On `local` and `ci` it proves the zero-resource plan; on a hosted environment
// it also probes the deployed runtime. It needs what `pnpm infra:plan <environment>` needs.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { root } from "./ci/evidence.mjs";

const target = process.argv[2] ?? "staging";
const result = spawnSync(
  path.join(root, "node_modules/.bin/vitest"),
  ["run", "--config", "vitest.workspace.ts", "--project", "cloud"],
  { cwd: root, stdio: "inherit", env: { ...process.env, CLOCKGROVE_CLOUD_ENVIRONMENT: target } },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
