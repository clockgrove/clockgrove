import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkInfrastructure,
  expectedRateLimitRule,
  readJson,
} from "../infra/check-configuration.mjs";
import { environments } from "../infra/environment-schema.ts";
import { restrictedRoleKeys } from "./database/deployment-roles.mjs";
import { isolatedTofu, offline } from "./lib/opentofu.mjs";
import { withProviderIpc } from "./provider-ipc.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
}
await checkInfrastructure(root);
run(path.join(root, "node_modules/.bin/tsc"), ["--project", "infra/tsconfig.json"]);
run(path.join(root, "node_modules/.bin/vitest"), [
  "run",
  "--config",
  "vitest.workspace.ts",
  "--project",
  "infra",
]);
let mirror;
const temporary = await mkdtemp(path.join(os.tmpdir(), "clockgrove-infra-"));
try {
  const { env, mirror: used } = await isolatedTofu(root, temporary);
  mirror = used;
  const version = spawnSync("tofu", ["version", "-json"], { env, encoding: "utf8" });
  if (version.status !== 0 || JSON.parse(version.stdout).terraform_version !== "1.13.1")
    throw new Error("OpenTofu 1.13.1 is required on PATH");
  await cp(path.join(root, "infra"), path.join(temporary, "infra"), {
    recursive: true,
    filter: (source) =>
      ![".terraform", "node_modules"].includes(path.basename(source)) &&
      !/\.tfstate|\.tfplan/u.test(source),
  });
  const offlineEnv = { ...env, ...offline };
  const tofuDirectory = path.join(temporary, "infra/opentofu");
  await withProviderIpc(tofuDirectory, async (ipc) => {
    const providerEnv = { ...(mirror ? offlineEnv : env), TMPDIR: ipc };
    const providerOptions = { cwd: tofuDirectory, env: providerEnv };
    run("tofu", [`-chdir=${tofuDirectory}`, "fmt", "-check", "-recursive"], providerOptions);
    // Always installs into a new, empty TF_DATA_DIR, including in a fresh checkout. From the mirror
    // this runs offline; otherwise it is the sole network phase: registry metadata, signatures and
    // provider releases.
    run(
      "tofu",
      [
        `-chdir=${tofuDirectory}`,
        "init",
        "-backend=false",
        "-input=false",
        "-lockfile=readonly",
        "-no-color",
      ],
      providerOptions,
    );
    // Validate performs schema/type checking, never plan, refresh or provider Configure.
    run("tofu", [`-chdir=${tofuDirectory}`, "validate", "-no-color"], {
      cwd: tofuDirectory,
      env: { ...offlineEnv, TMPDIR: ipc },
    });
    // Each hosted environment's rate-limiting rule and database roles, evaluated by OpenTofu from its
    // manifest with no state and HTTP refused. The rule must be the one its zone plan allows.
    for (const environment of ["development", "staging", "production"]) {
      const result = spawnSync(
        "tofu",
        [
          "console",
          "-no-color",
          `-var=environment=${environment}`,
          `-state=${path.join(temporary, "console.tfstate")}`,
        ],
        {
          cwd: tofuDirectory,
          env: { ...offlineEnv, TMPDIR: ipc },
          input:
            "jsonencode(local.rate_limit_rule)\njsonencode(local.api_roles)\njsonencode(local.restricted_roles)\n",
          encoding: "utf8",
        },
      );
      if (result.status !== 0) throw new Error(`tofu console failed (${result.status})`);
      const manifest = await readJson(root, `infra/environments/${environment}.json`);
      const [rule, apiRoles, restrictedRoles] = result.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(JSON.parse(line)));
      assert.deepEqual(
        rule,
        expectedRateLimitRule(manifest),
        `${environment} rate-limiting rule must match its ${manifest.cloudflareZonePlan} zone`,
      );
      // Only the migration role is a Neon API role (a neon_superuser member); the deploy's role SQL
      // creates exactly the others, from the passwords OpenTofu generates for them.
      const { migrations, ...restricted } = manifest.resources.database.roles;
      assert.deepEqual(apiRoles, { migrations }, `${environment} Neon API roles`);
      assert.deepEqual(restrictedRoles, restricted, `${environment} SQL-created roles`);
      assert.deepEqual(Object.keys(restricted).sort(), [...restrictedRoleKeys].sort());
      console.log(`${environment}: ${manifest.cloudflareZonePlan}-zone rate-limiting rule`);
    }
  });
  for (const environment of environments) {
    run(
      path.join(root, "node_modules/.bin/wrangler"),
      [
        "deploy",
        "--dry-run",
        "--config",
        `infra/wrangler/${environment}.json`,
        "--outdir",
        path.join(temporary, `worker-${environment}`),
      ],
      { env: offlineEnv },
    );
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
console.log(
  `infrastructure validated with lock-file-verified providers from ${mirror ?? "the public registry"}; no resources created`,
);
