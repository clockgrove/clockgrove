import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { databaseIsolationQuery } from "../database/isolation.mjs";
import { withProviderIpc } from "../provider-ipc.mjs";
import {
  assertRoutingMetadata,
  authenticatedFact,
  externalPath,
  externalStateConfiguration,
  hostedTofuEnv,
  ownedInventory,
  prepareStateWorkspace,
  resourceAddresses,
  roleConnections,
  verifyPlan,
  verifyPriorActivation,
  verifyReview,
} from "./deployment-authority.mjs";
import { digest, fileInventory, root, subprocessEvidence, validateEvidence } from "./evidence.mjs";

const env = process.env;
const require = createRequire(path.join(root, "apps/runtime/package.json"));
const { Client } = require("pg");
const consumedSecrets = ["CLOUDFLARE_API_TOKEN", "NEON_API_KEY", "BETTER_AUTH_SECRET"];
const required = (name) => {
  assert(env[name]?.trim(), `missing ${name}`);
  return env[name];
};
const outside = (name) => externalPath(env, name);
export async function verifyDatabaseIsolation(connectionString) {
  const client = new Client({ connectionString });
  // Do not leak URLs, provider errors or parameters to release logs.
  client.on("error", () => {});
  try {
    await client.connect();
    const result = await client.query(databaseIsolationQuery);
    const row = result.rows[0];
    for (const [name, passed] of Object.entries(row))
      assert.equal(passed, true, `database role isolation failed: ${name}`);
  } catch (error) {
    if (error.message.startsWith("database role isolation failed:")) throw error;
    throw new Error(
      "database role isolation failed: MIGRATION_DATABASE_URL connection or catalog query",
    );
  } finally {
    await client.end().catch(() => {});
  }
}
export function recordDeploymentPhase(result, candidate, name, executable, args, options = {}) {
  const startedAt = new Date().toISOString();
  const command = spawnSync(executable, args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  const observed = subprocessEvidence(command);
  result.phases.push({
    commit: candidate.commit,
    tree: candidate.tree,
    command: [name],
    ...observed,
    status:
      observed.status === "failed" && /apply|publication/u.test(name) ? "unknown" : observed.status,
    startedAt,
    completedAt: new Date().toISOString(),
    outputDigest: digest(`${command.stdout ?? ""}${command.stderr ?? ""}`),
  });
  assert.equal(observed.status, "passed", `${name} failed; sensitive command output withheld`);
  console.log(`${name}: passed`);
  return command.stdout;
}
async function runDeployment() {
  const target = required("DEPLOY_ENVIRONMENT");
  assert(["development", "staging"].includes(target), "production deployment is disabled");
  const candidate = required("DEPLOY_CANDIDATE");
  assert.equal(
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    candidate,
    "protected candidate mismatch",
  );
  const evidenceDirectory = required("CI_EVIDENCE_DIR");
  const manifest = await validateEvidence(
    JSON.parse(await readFile(path.join(evidenceDirectory, "evidence-manifest.json"), "utf8")),
  );
  assert.equal(manifest.candidate.commit, candidate, "qualified artifact candidate mismatch");
  assert.equal(
    manifest.candidate.tree,
    execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: root, encoding: "utf8" }).trim(),
    "qualified artifact tree mismatch",
  );
  assert.equal(manifest.execution.runId, required("QUALITY_RUN_ID"), "qualified CI run mismatch");
  assert(
    manifest.commands.length > 0 &&
      manifest.commands.every((command) => command.status === "passed") &&
      manifest.browser.status === "passed" &&
      manifest.extensions.missingCommands.length === 0,
    "required actual CI outcomes missing or failed",
  );
  assert.equal(
    manifest.execution.provider,
    "github-actions",
    "qualified candidate requires authenticated CI evidence",
  );
  assert(
    manifest.candidate.clean && manifest.candidate.buildDigest,
    "qualified build evidence absent",
  );
  assert.equal(
    digest(JSON.stringify(await fileInventory(path.join(evidenceDirectory, "build")))),
    manifest.candidate.buildDigest,
    "qualified build digest mismatch",
  );
  const result = {
    environment: target,
    commit: candidate,
    buildDigest: manifest.candidate.buildDigest,
    status: "held",
    phases: [],
  };
  manifest.deployments.push(result);
  let work;
  let providerIpc;
  let connections;
  const phase = (name, executable, args, options = {}) => {
    return recordDeploymentPhase(result, manifest.candidate, name, executable, args, {
      cwd: work,
      env: {
        ...env,
        ...(executable === "tofu" ? hostedTofuEnv(env, providerIpc, work) : {}),
      },
      ...options,
    });
  };
  try {
    assert.equal(required("OWNER_SETUP_READY"), "true", "owner setup issue 1 remains pending");
    for (const name of consumedSecrets) required(name);
    const declarations = JSON.parse(
      await readFile(path.join(root, `infra/environments/${target}.secrets.json`), "utf8"),
    );
    for (const name of consumedSecrets)
      assert(
        declarations.secrets.some((secret) => secret.name === name),
        `undeclared consumed secret ${name}`,
      );
    const config = JSON.parse(
      await readFile(path.join(root, `infra/environments/${target}.json`), "utf8"),
    );
    assertRoutingMetadata(config, target);
    assert.equal(
      required("ACTIVATION_PREREQUISITES_READY"),
      "true",
      "activation prerequisite issue 2 remains pending",
    );
    const acceptanceKey = await outside("OWNER_ACCEPTANCE_PUBLIC_KEY_FILE");
    const keyDigest = required("OWNER_ACCEPTANCE_PUBLIC_KEY_DIGEST");
    const review = await authenticatedFact(
      await outside("INDEPENDENT_REVIEW_EVIDENCE_FILE"),
      acceptanceKey,
      keyDigest,
    );
    verifyReview(review, candidate, manifest.candidate.tree, required("INDEPENDENT_REVIEWER"));
    const stateDirectory = await outside("INFRA_STATE_DIRECTORY");
    assert(
      ((await stat(stateDirectory)).mode & 0o077) === 0,
      "INFRA_STATE_DIRECTORY must be private to its owner",
    );
    const { backend, encryption } = await externalStateConfiguration(
      target,
      await outside("INFRA_BACKEND_CONFIG_FILE"),
      await outside("INFRA_ENCRYPTION_CONFIG_FILE"),
      required("INFRA_CONFIGURATION_DIGEST"),
    );
    const recoveryFile = await outside("INFRA_RECOVERY_EVIDENCE_FILE");
    const recovery = await authenticatedFact(recoveryFile, acceptanceKey, keyDigest);
    assert.equal(recovery.environment, target, "encrypted state recovery environment mismatch");
    assert.equal(
      recovery.configurationDigest,
      env.INFRA_CONFIGURATION_DIGEST,
      "encrypted state recovery configuration mismatch",
    );
    assert(
      recovery.evidence && recovery.operator && typeof recovery.statePresent === "boolean",
      "missing encrypted persisted-state recovery evidence",
    );
    work = path.join(stateDirectory, `${target}-${candidate}-${required("GITHUB_RUN_ID")}`);
    await mkdir(work, { mode: 0o700 });
    await prepareStateWorkspace(work, backend, encryption);
    await withProviderIpc(work, async (ipc) => {
      providerIpc = ipc;
      phase("OpenTofu initialization", "tofu", ["init", "-input=false", "-lockfile=readonly"]);
      const priorState = JSON.parse(
        phase("read owned persisted resource identities", "tofu", ["show", "-json"]),
      );
      const inventory = ownedInventory(priorState);
      if (recovery.statePresent) {
        const stateBytes = phase("recover encrypted persisted state", "tofu", ["state", "pull"]);
        assert(
          digest(stateBytes) === recovery.restoredStateDigest,
          "encrypted state recovery digest mismatch",
        );
      } else {
        assert(
          inventory.length === 0 &&
            recovery.restoredStateDigest === null &&
            recovery.emptyEnvironmentVerified === true,
          "fresh provisioning requires verified empty environment and absent state",
        );
      }
      const allowed = resourceAddresses(config);
      assert(
        inventory.length <= allowed.size &&
          inventory.every((resource) => allowed.has(resource.address)),
        "persisted resource ownership bounds exceeded",
      );
      assert(
        JSON.stringify(inventory) === JSON.stringify(recovery.ownedResources),
        "verified ownership/state-import identities required",
      );
      if (inventory.length)
        assert(
          recovery.ownershipVerified === true && recovery.stateImportVerified === true,
          "existing resources require verified ownership and state import",
        );
      const preserveBindings = inventory.some(
        (resource) => resource.address === "cloudflare_hyperdrive_config.world[0]",
      );
      result.stateRecovery = {
        status: recovery.statePresent ? "passed" : "missing",
        evidence: [digest(JSON.stringify(recovery))],
      };
      const preservePublic = await verifyPriorActivation(
        config,
        env.CLOUDFLARE_API_TOKEN,
        inventory,
        recovery.activation,
      );
      const apply = (stage) => {
        const plan = path.join(work, `${stage}.tfplan`);
        phase(`OpenTofu ${stage} plan`, "tofu", [
          "plan",
          "-input=false",
          `-var=environment=${target}`,
          `-var=activation_stage=${stage}`,
          `-var=preserve_bindings=${preserveBindings}`,
          `-var=preserve_public_activation=${preservePublic}`,
          `-out=${plan}`,
        ]);
        const proposed = JSON.parse(
          phase(`OpenTofu ${stage} review`, "tofu", ["show", "-json", plan]),
        );
        verifyPlan(proposed, config, stage, preservePublic);
        phase(`OpenTofu ${stage} apply`, "tofu", ["apply", "-input=false", plan]);
      };
      apply("provision");
      const credentials = JSON.parse(
        phase("owned generated role credentials", "tofu", [
          "output",
          "-json",
          "database_credentials",
        ]),
      );
      connections = roleConnections(credentials, config);
      const migrator = new URL(connections.MIGRATION_DATABASE_URL);
      const migrationEnv = {
        ...env,
        PGHOST: migrator.hostname,
        PGPORT: migrator.port || "5432",
        PGDATABASE: decodeURIComponent(migrator.pathname.slice(1)),
        PGUSER: decodeURIComponent(migrator.username),
        PGPASSWORD: decodeURIComponent(migrator.password),
        PGSSLMODE: "verify-full",
      };
      phase(
        "reviewed database-role grants",
        "psql",
        ["--no-psqlrc", "--set=ON_ERROR_STOP=1", "--single-transaction", "--file=-"],
        {
          env: migrationEnv,
          input: await readFile(path.join(root, "scripts/database/deployment-grants.sql"), "utf8"),
        },
      );
      phase("database migrations", "node", [path.join(root, "scripts/database/migrate.mjs")], {
        env: migrationEnv,
      });
      await verifyDatabaseIsolation(connections.MIGRATION_DATABASE_URL);
      const runtime = new Client({ connectionString: connections.DATABASE_URL });
      runtime.on("error", () => {});
      try {
        await runtime.connect();
        const result = await runtime.query(
          "SELECT current_user = 'clockgrove_runtime' AND NOT has_schema_privilege(current_user, 'clockgrove', 'CREATE') AS isolated",
        );
        assert.equal(
          result.rows[0]?.isolated,
          true,
          "DATABASE_URL effective runtime-role isolation failed",
        );
      } catch {
        throw new Error("DATABASE_URL effective runtime-role isolation failed");
      } finally {
        await runtime.end().catch(() => {});
      }
      assert(
        env.BETTER_AUTH_SECRET.length >= 32 &&
          env.BETTER_AUTH_SECRET.trim() === env.BETTER_AUTH_SECRET,
        "invalid BETTER_AUTH_SECRET",
      );
      // Authenticate each generated connection independently before protected publication.
      for (const [name, role] of [
        ["AUTH_DATABASE_URL", "clockgrove_auth_verifier"],
        ["MANAGEMENT_DATABASE_URL", "clockgrove_management_reader"],
        ["WORLD_AUTHORIZATION_DATABASE_URL", "clockgrove_world_reader"],
      ]) {
        const reader = new Client({ connectionString: connections[name] });
        let failed = false;
        reader.on("error", () => {
          failed = true;
        });
        try {
          await reader.connect();
          const identity = await reader.query(
            "SELECT current_user = $1 AND current_database() = $2 AS isolated",
            [role, config.resources.database.database],
          );
          if (identity.rows[0]?.isolated !== true) failed = true;
        } catch {
          failed = true;
        } finally {
          await reader.end().catch(() => {
            failed = true;
          });
        }
        assert(!failed, `${name} generated reader identity verification failed`);
      }
      apply("bindings");
      const hyperdrive = JSON.parse(
        phase("Hyperdrive identity", "tofu", ["output", "-json", "hyperdrive_id"]),
      );
      const wrangler = JSON.parse(
        await readFile(path.join(root, `infra/wrangler/${target}.json`), "utf8"),
      );
      wrangler.main = path.join(evidenceDirectory, "build/worker/cloudflare-entry.js");
      wrangler.hyperdrive = [{ binding: "HYPERDRIVE", id: hyperdrive }];
      wrangler.vars.AUTH_ORIGIN = config.authentication.origin;
      wrangler.vars.PROVIDER_ENVIRONMENT = config.authentication.providerEnvironment;
      assert.equal(
        config.authentication.transport,
        "direct-postgresql",
        "unsupported authentication transport",
      );
      assert.equal(
        config.authentication.origin,
        `https://${config.domains.runtime}`,
        "authentication origin mismatch",
      );
      assert.equal(
        config.authentication.providerEnvironment,
        target,
        "provider environment mismatch",
      );
      wrangler.account_id = config.safeIds.cloudflareAccountId;
      wrangler.assets = {
        directory: path.join(evidenceDirectory, "build/web"),
        binding: "ASSETS",
        run_worker_first: ["/v1/*"],
      };
      const wranglerFile = path.join(work, "wrangler.json");
      await writeFile(wranglerFile, JSON.stringify(wrangler));
      const wranglerBin = path.join(root, "node_modules/.bin/wrangler");
      phase(
        "Wrangler secret publication",
        wranglerBin,
        ["secret", "bulk", "--config", wranglerFile],
        {
          input: JSON.stringify({
            BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
            AUTH_DATABASE_URL: connections.AUTH_DATABASE_URL,
            MANAGEMENT_DATABASE_URL: connections.MANAGEMENT_DATABASE_URL,
            WORLD_AUTHORIZATION_DATABASE_URL: connections.WORLD_AUTHORIZATION_DATABASE_URL,
          }),
        },
      );
      phase("Wrangler Worker publication", wranglerBin, [
        "deploy",
        "--config",
        wranglerFile,
        "--no-bundle",
      ]);
      apply("routing");
      result.status = "passed";
    });
  } catch (error) {
    result.status = result.phases.some((phase) => phase.status === "unknown")
      ? "unknown"
      : work
        ? "failed"
        : "held";
    throw error;
  } finally {
    await validateEvidence(manifest);
    await writeFile(
      path.join(evidenceDirectory, "evidence-manifest.json"),
      JSON.stringify(manifest, null, 2),
    );
    // Encrypted saved plans/state are deliberately retained outside checkout for recovery.
    connections = undefined;
    if (work) await rm(path.join(work, ".terraform"), { recursive: true, force: true });
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  await runDeployment().catch((error) => {
    console.error(
      `deployment held or failed: ${error instanceof assert.AssertionError ? error.message.split("\n")[0] : "operation failed; sensitive details withheld"}`,
    );
    process.exitCode = 1;
  });
