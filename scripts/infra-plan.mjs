// `pnpm infra:plan <environment>`: a read-only OpenTofu plan of one canonical environment. It never
// applies. `local` and `ci` own no cloud resources: their plan runs offline in a new temporary
// directory with no credentials or backend, and must stay empty. `development` and `staging` plan the
// full configuration a completed deploy owns against the environment's R2 state, with the same checks
// the deploy makes first. Only resource addresses, actions and a digest of the change set are printed;
// saved plans hold sensitive values and are removed with their temporary directory.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hostedTofuEnv, stateWorkspace, verifyPlan } from "./ci/deployment-authority.mjs";
import { digest, root } from "./ci/evidence.mjs";
import { assertRoutingMetadata } from "./ci/routing-metadata.mjs";
import { isolatedTofu, offline } from "./lib/opentofu.mjs";
import { withProviderIpc } from "./provider-ipc.mjs";

export const zeroResource = (target) => ["local", "ci"].includes(target);
const planned = ["local", "ci", "development", "staging"];

// Hosted runs withhold OpenTofu's output, as the deploy does.
function tofu(args, options, withhold) {
  const result = spawnSync("tofu", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (!withhold) process.stderr.write(result.stderr);
    throw new Error(
      `tofu ${args[0]} failed (${result.status})${withhold ? ` in ${options.cwd}; sensitive output withheld` : ""}`,
    );
  }
  return result.stdout;
}

// Addresses and actions only, sorted, so two plans of unchanged infrastructure compare equal.
export function summarizePlan(target, proposed) {
  const changes = (proposed.resource_changes ?? [])
    .map(({ address, change }) => ({ address, actions: change.actions }))
    .sort((a, b) => a.address.localeCompare(b.address));
  const counted = (module) =>
    (module?.resources?.length ?? 0) +
    (module?.child_modules ?? []).reduce((sum, child) => sum + counted(child), 0);
  return {
    environment: target,
    resources: counted(proposed.planned_values?.root_module),
    pending: changes.filter(({ actions }) => !actions.every((action) => action === "no-op")),
    changeDigest: digest(JSON.stringify(changes)),
  };
}

// Prepares one OpenTofu working directory for the target, then hands `operation` a `plan()` that
// makes one more saved plan in it and returns its summary.
export async function withEnvironmentPlans(target, operation) {
  assert(planned.includes(target), `infra:plan takes ${planned.join(", ")}`);
  const config = JSON.parse(
    await readFile(path.join(root, `infra/environments/${target}.json`), "utf8"),
  );
  if (zeroResource(target)) return zeroResourcePlans(target, operation);
  return hostedPlans(target, config, operation);
}

async function zeroResourcePlans(target, operation) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "clockgrove-plan-"));
  try {
    const { env, mirror } = await isolatedTofu(root, temporary);
    await cp(path.join(root, "infra"), path.join(temporary, "infra"), {
      recursive: true,
      filter: (source) =>
        ![".terraform", "node_modules"].includes(path.basename(source)) &&
        !/\.tfstate|\.tfplan/u.test(source),
    });
    const work = path.join(temporary, "infra/opentofu");
    return await withProviderIpc(work, async (ipc) => {
      const options = (network, extra = {}) => ({
        cwd: work,
        env: { ...env, ...(network ? {} : offline), TMPDIR: ipc, ...extra },
      });
      // From the mirror this runs offline; otherwise it is the sole network phase.
      tofu(
        ["init", "-backend=false", "-input=false", "-lockfile=readonly", "-no-color"],
        options(!mirror),
      );
      let count = 0;
      return operation(async () => {
        const plan = path.join(temporary, `${target}-${++count}.tfplan`);
        // The Neon provider refuses to configure without a token even when it owns nothing. This
        // placeholder is never sent: the plan has no resources and runs with HTTP refused.
        tofu(
          [
            "plan",
            "-input=false",
            "-lock=false",
            "-no-color",
            `-var=environment=${target}`,
            `-state=${path.join(temporary, `${target}.tfstate`)}`,
            `-out=${plan}`,
          ],
          options(false, { NEON_TOKEN: "unused" }),
        );
        const summary = summarizePlan(
          target,
          JSON.parse(tofu(["show", "-json", plan], options(false))),
        );
        assert.equal(summary.resources, 0, `${target} must own no cloud resources`);
        return summary;
      });
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function hostedPlans(target, config, operation) {
  const env = process.env;
  for (const name of ["CLOUDFLARE_API_TOKEN", "NEON_API_KEY"])
    assert(env[name]?.trim(), `missing ${name}`);
  assertRoutingMetadata(config, target);
  const { temporary, work } = await stateWorkspace(target, config, env);
  try {
    return await withProviderIpc(work, async (ipc) => {
      const options = { cwd: work, env: hostedTofuEnv(env, ipc, work) };
      tofu(["init", "-input=false", "-lockfile=readonly", "-no-color"], options, true);
      let count = 0;
      return operation(async () => {
        const plan = path.join(work, `plan-${++count}.tfplan`);
        // The full configuration of a completed deploy: every stage's resources, so an applied
        // environment plans with no pending change.
        tofu(
          [
            "plan",
            "-input=false",
            "-no-color",
            `-var=environment=${target}`,
            "-var=activation_stage=routing",
            "-var=preserve_bindings=true",
            "-var=preserve_public_activation=true",
            `-out=${plan}`,
          ],
          options,
          true,
        );
        const proposed = JSON.parse(tofu(["show", "-json", plan], options, true));
        verifyPlan(proposed, config, "routing", true);
        return summarizePlan(target, proposed);
      });
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const target = process.argv[2];
  try {
    const summary = await withEnvironmentPlans(target, (plan) => plan());
    console.log(JSON.stringify(summary, null, 2));
    console.log(
      `${target}: ${summary.resources} planned resources, ${summary.pending.length} pending changes; nothing applied`,
    );
  } catch (error) {
    console.error(
      `infra:plan ${target ?? "<environment>"}: ${error instanceof assert.AssertionError ? error.message.split("\n")[0] : error.message}`,
    );
    process.exitCode = 1;
  }
}
