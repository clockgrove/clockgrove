import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deploymentRolesInput, roleCheckFailures } from "../database/deployment-roles.mjs";
import { databaseIsolationQuery } from "../database/isolation.mjs";
import { ownedSubprocess } from "../lib/subprocess.mjs";
import { withProviderIpc } from "../provider-ipc.mjs";
import {
  assertNoUnrecordedDuplicates,
  awaitNeonOperations,
  hostedTofuEnv,
  ownedInventory,
  persistedAddresses,
  restrictedRolePasswords,
  roleConnections,
  stateSecrets,
  stateStoreFor,
  stateWorkspace,
  verifyPlan,
  verifyPriorActivation,
} from "./deployment-authority.mjs";
import {
  digest,
  fileInventory,
  outstandingPhases,
  provisionRetry,
  root,
  subprocessEvidence,
  validateEvidence,
} from "./evidence.mjs";
import { assertRoutingMetadata } from "./routing-metadata.mjs";
import { assertUnlocked, backupState, describeLock, readLock } from "./state-store.mjs";

const env = process.env;
const require = createRequire(path.join(root, "apps/runtime/package.json"));
const { Client } = require("pg");
const consumedSecrets = [
  "CLOUDFLARE_API_TOKEN",
  "NEON_API_KEY",
  "BETTER_AUTH_SECRET",
  ...stateSecrets,
];
const required = (name) => {
  assert(env[name]?.trim(), `missing ${name}`);
  return env[name];
};
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
// OpenTofu's error diagnostics from `-json` output, reduced to what is safe for release logs:
// summary, resource address, provider error codes and the provider's redacted message. The rest
// of a detail can echo attribute values, so it never prints.
// The provider's own words from a diagnostic detail, for release logs: the API's error message,
// with anything shaped like a credential redacted and the text capped.
export function providerMessage(detail) {
  const text = String(detail ?? "");
  const json = [...text.matchAll(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/gu)].map((match) => match[1]);
  const said = json.length ? json.join("; ") : (text.split(/got error:|error:/iu).pop() ?? "");
  return said
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s/@]*@[^\s]*/giu, "<url>")
    .replace(
      /\b(password|passwd|secret|token|key|authorization)\b\s*[=:]\s*\S+/giu,
      "$1=<redacted>",
    )
    .replace(/[A-Za-z0-9_+/=.-]{24,}/gu, "<redacted>")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 200);
}
// The error diagnostics in OpenTofu's `-json` output.
function tofuErrors(stdout) {
  const errors = [];
  for (const line of String(stdout ?? "").split("\n")) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const diagnostic = event?.type === "diagnostic" ? event.diagnostic : null;
    if (diagnostic?.severity === "error") errors.push(diagnostic);
  }
  return errors;
}
export function tofuDiagnostics(stdout) {
  const found = [];
  for (const diagnostic of tofuErrors(stdout)) {
    const detail = String(diagnostic.detail ?? "");
    const codes = new Set();
    for (const match of detail.matchAll(
      /"code"\s*:\s*(\d{3,6})|\((\d{4,6})\)|status(?: code)?:?\s*(\d{3})\b|\b([45]\d\d) (?:Bad Request|Unauthorized|Forbidden|Not Found|Conflict|Too Many Requests)/gu,
    ))
      codes.add(match[1] ?? match[2] ?? match[3] ?? match[4]);
    const summary = String(diagnostic.summary ?? "error")
      .replace(/\s+/gu, " ")
      .slice(0, 160);
    const said = providerMessage(detail);
    found.push(
      `${summary}${diagnostic.address ? ` at ${diagnostic.address}` : ""}${codes.size ? ` (codes ${[...codes].join(", ")})` : ""}${said ? `: ${said}` : ""}`,
    );
  }
  return found.slice(0, 3).join("; ");
}
// Whether a failed apply may be planned and applied again. OpenTofu must have exited on its own
// (no signal or spawn error), so it saved state and released its lock, and every error it reported
// must be at a Neon resource. Neon runs one operation per project at a time and refuses another
// with 423 Locked meanwhile, which its docs call safe to retry. The Neon provider waits for the
// project's latest operation before each create but drops the HTTP status from its errors, so a
// 423 is told apart from other Neon refusals only by message text; any Neon resource error is
// retried instead, a bounded number of times. Errors without a resource address, such as a state
// that failed to save, are never retried. Nor is a failed create of the Neon project that the
// reviewed `plan` proposed: Neon may have made the project anyway, and if its name search has not
// caught up, a retry would make a second one that state then hides. A project create cannot meet
// the per-project lock that the retry is for.
export function retryableApply(phase, stdout, plan) {
  const errors = tofuErrors(stdout);
  const created = new Set(
    (plan?.resource_changes ?? [])
      .filter((change) => change.change?.actions?.includes("create"))
      .map((change) => change.address),
  );
  return (
    Number.isInteger(phase.exitCode) &&
    phase.exitCode !== 0 &&
    !phase.signal &&
    !phase.errorCode &&
    errors.length > 0 &&
    errors.every((error) => /^neon_/u.test(String(error.address ?? ""))) &&
    !errors.some(({ address }) => /^neon_project\./u.test(address) && created.has(address))
  );
}
// OpenTofu's wall-clock limits. A provider that never returns, such as the Neon provider polling
// a failed operation forever, would otherwise hold the deploy until the job's 45-minute timeout
// kills it mid-apply, leaving the state lock held and the evidence unuploaded. An apply gets
// `applySeconds` and starts only if all of it fits in what is left of `budgetSeconds` since the
// deploy started; any other call (init, plan, show, output) gets `callSeconds`, cut to what is
// left, and starts only with at least `floorSeconds` left. So the deploy ends inside the job
// however many calls it makes, and no apply starts only to be interrupted. At the limit OpenTofu
// gets SIGINT and `graceSeconds` to exit before its process group is killed. On SIGINT OpenTofu
// asks its providers to stop and waits for their calls in flight, then saves state and releases
// the lock; a provider that ignores the stop, as the Neon provider 0.1.15 does (its operation
// wait has no context), never returns, so OpenTofu is killed and the lock stays held. The job's
// setup steps before the deploy and the evidence upload after it fit in what the budget and grace
// leave. The provision retries (four runs of state read, plan, review and apply, 105 s of backoff)
// normally take minutes, and the budget bounds them even when every call nears its limit.
export const tofuLimits = {
  applySeconds: 600,
  callSeconds: 300,
  floorSeconds: 60,
  budgetSeconds: 1800,
  graceSeconds: 120,
};
// One tofu call's limit and grace, `elapsedMs` into the deploy, or `refused` with why it must not
// start.
export function tofuBounds(args, elapsedMs, limits = tofuLimits) {
  const left = limits.budgetSeconds * 1000 - elapsedMs;
  const apply = args[0] === "apply";
  const needed = (apply ? limits.applySeconds : limits.floorSeconds) * 1000;
  if (left < needed)
    return {
      refused: `${apply ? "its" : "the minimum"} ${needed / 1000} s limit does not fit the ${Math.max(0, Math.floor(left / 1000))} s left of the deploy's ${limits.budgetSeconds} s OpenTofu budget`,
    };
  return {
    timeoutMs: apply ? needed : Math.min(left, limits.callSeconds * 1000),
    killGraceMs: limits.graceSeconds * 1000,
  };
}
// A bounded call stops gracefully: SIGINT to tofu's process group (as a terminal's Ctrl-C does;
// provider plugins ignore it, tofu asks them to stop), SIGKILL after the grace.
const stoppable = (executable, args, options) =>
  ownedSubprocess(executable, args, { ...options, stopSignal: "SIGINT" });
// Runs one phase and records it. With `timeoutMs` the call is bounded as above; a call stopped at
// its limit is `unknown` with reason `timeout`, never retried, and stops the deploy. With
// `refused` (from tofuBounds) nothing runs: the call is recorded `failed` with reason `budget` and
// stops the deploy, so the evidence names why it ended.
export async function recordDeploymentPhase(
  result,
  candidate,
  name,
  executable,
  args,
  options = {},
) {
  const {
    explain,
    retryable,
    attempt,
    timeoutMs,
    refused,
    run = timeoutMs ? stoppable : spawnSync,
    ...spawnOptions
  } = options;
  const startedAt = new Date().toISOString();
  const label = attempt > 1 ? `${name} (attempt ${attempt})` : name;
  if (refused) {
    result.phases.push({
      commit: candidate.commit,
      tree: candidate.tree,
      command: [name],
      exitCode: null,
      status: "failed",
      signal: null,
      errorCode: null,
      reason: "budget",
      startedAt,
      completedAt: startedAt,
      outputDigest: digest(""),
      ...(attempt > 1 ? { attempt } : {}),
    });
    throw new assert.AssertionError({ message: `${label} not started: ${refused}` });
  }
  const command = await run(executable, args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeoutMs,
    ...spawnOptions,
  });
  const observed = subprocessEvidence(command);
  const timedOut = command.timedOut === true;
  const phase = {
    commit: candidate.commit,
    tree: candidate.tree,
    command: [name],
    ...observed,
    status:
      timedOut || (observed.status === "failed" && /apply|publication/u.test(name))
        ? "unknown"
        : observed.status,
    ...(timedOut ? { reason: "timeout" } : {}),
    startedAt,
    completedAt: new Date().toISOString(),
    outputDigest: digest(`${command.stdout ?? ""}${command.stderr ?? ""}`),
    ...(attempt > 1 ? { attempt } : {}),
  };
  result.phases.push(phase);
  if (phase.status !== "passed") {
    const why = explain ? explain(command.stdout, command.stderr) : "";
    const stopped = timedOut
      ? `stopped: no result within ${Math.round(timeoutMs / 1000)} s; interrupted with SIGINT${
          command.signal === "SIGKILL"
            ? ", then killed after the grace; the state lock may be held"
            : ", exited within the grace"
        }`
      : "failed";
    const error = new assert.AssertionError({
      message: `${label} ${stopped}; ${why ? `${why}; other ` : ""}sensitive command output withheld`,
    });
    // A timeout is never a Neon lock: the provider may still be waiting on its operation.
    error.retryable = !timedOut && retryable?.(phase, command.stdout) === true;
    throw error;
  }
  console.log(`${label}: passed`);
  return command.stdout;
}
// Plans one stage, reviews the saved plan and applies exactly that plan. A failed apply that
// `retryable` accepts is planned, reviewed and applied again, up to `attempts` runs in all, after
// `beforeRetry` (which re-checks the lock and lost state). Every run is recorded as its own phases;
// a stale plan is never applied, since each run writes and applies a new one.
export async function applyStage(stage, context) {
  const {
    work,
    planArgs,
    phase,
    review,
    applyArgs = [],
    retry = { attempts: 1, backoffSeconds: [] },
    beforeRetry = async () => {},
    sleep = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000)),
  } = context;
  for (let attempt = 1; ; attempt++) {
    const plan = path.join(work, attempt > 1 ? `${stage}-${attempt}.tfplan` : `${stage}.tfplan`);
    await phase(
      `OpenTofu ${stage} plan`,
      "tofu",
      ["plan", "-input=false", ...planArgs, `-out=${plan}`],
      { attempt },
    );
    const proposed = JSON.parse(
      await phase(`OpenTofu ${stage} review`, "tofu", ["show", "-json", plan], { attempt }),
    );
    review(proposed);
    try {
      await phase(
        `OpenTofu ${stage} apply`,
        "tofu",
        ["apply", "-input=false", "-json", ...applyArgs, plan],
        {
          attempt,
          explain: tofuDiagnostics,
          retryable: (record, stdout) => retryableApply(record, stdout, proposed),
        },
      );
      return;
    } catch (error) {
      if (!error.retryable || attempt >= retry.attempts) throw error;
      const wait = retry.backoffSeconds[attempt - 1] ?? retry.backoffSeconds.at(-1) ?? 0;
      console.error(
        `${error.message}; retrying in ${wait} s (${attempt} of ${retry.attempts} tries used)`,
      );
      // Saved plans hold generated credentials; the failed one is never applied again.
      await rm(plan, { force: true });
      await sleep(wait);
      await beforeRetry(attempt + 1);
    }
  }
}
// The provision stage's apply options. One Neon request at a time: the provider waits for the
// project's latest operation before each create, so serial creates each start after the previous
// one finished, where parallel ones all start at once and all but one get 423 Locked. Retries cover
// what is left; each first refuses a held lock and re-reads state for a lost duplicable resource.
export function provisionOptions(store, target, readInventory) {
  return {
    applyArgs: ["-parallelism=1"],
    retry: provisionRetry,
    beforeRetry: async (attempt) => {
      await assertUnlocked(store, target);
      await readInventory(attempt);
    },
  };
}
// A failed deployment's status: `unknown` while an apply or publication with an open effect
// decides it (a provision apply that a later attempt passed does not), else `failed` once the
// workspace exists, else `held`.
export function failedDeploymentStatus(phases, started) {
  return outstandingPhases(phases).some((phase) => phase.status === "unknown")
    ? "unknown"
    : started
      ? "failed"
      : "held";
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
  let temporary;
  let work;
  let store;
  let providerIpc;
  let connections;
  const started = Date.now();
  const phase = (name, executable, args, options = {}) => {
    const tofu = executable === "tofu";
    return recordDeploymentPhase(result, manifest.candidate, name, executable, args, {
      cwd: work,
      env: {
        ...env,
        ...(tofu ? hostedTofuEnv(env, providerIpc, work) : {}),
      },
      ...(tofu ? tofuBounds(args, Date.now() - started) : {}),
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
    // A lock left by an interrupted run would fail the first plan with its output withheld, so it
    // is reported first by holder and age. It is never cleared here.
    store = stateStoreFor(target, config, env);
    await assertUnlocked(store, target);
    ({ temporary, work } = await stateWorkspace(target, config, env));
    await withProviderIpc(work, async (ipc) => {
      providerIpc = ipc;
      await phase("OpenTofu initialization", "tofu", [
        "init",
        "-input=false",
        "-lockfile=readonly",
      ]);
      // Owned resources must be declared, and state must not have lost a duplicable one. Checked
      // before the first plan and again before a provision retry, since a failed apply can have
      // created a resource it did not record.
      const readInventory = async (attempt) => {
        const owned = ownedInventory(
          JSON.parse(
            await phase("read owned persisted resource identities", "tofu", ["show", "-json"], {
              attempt,
            }),
          ),
        );
        const allowed = persistedAddresses(config);
        assert(
          owned.length <= allowed.size && owned.every((resource) => allowed.has(resource.address)),
          "persisted resource ownership bounds exceeded",
        );
        await assertNoUnrecordedDuplicates(config, env, owned, target);
        return owned;
      };
      const inventory = await readInventory(1);
      const preserveBindings = inventory.some(
        (resource) => resource.address === "cloudflare_hyperdrive_config.world[0]",
      );
      const preservePublic = await verifyPriorActivation(
        config,
        env.CLOUDFLARE_API_TOKEN,
        inventory,
      );
      const apply = async (stage, options = {}) => {
        await applyStage(stage, {
          work,
          phase,
          planArgs: [
            `-var=environment=${target}`,
            `-var=activation_stage=${stage}`,
            `-var=preserve_bindings=${preserveBindings}`,
            `-var=preserve_public_activation=${preservePublic}`,
          ],
          review: (proposed) => verifyPlan(proposed, config, stage, preservePublic),
          ...options,
        });
        // Only a passed apply is backed up.
        const backup = await backupState(store, target, `${stage}-${candidate.slice(0, 12)}`);
        console.log(`state backup: ${store.bucket}/${backup}`);
      };
      await apply("provision", provisionOptions(store, target, readInventory));
      const credentials = JSON.parse(
        await phase("owned generated role credentials", "tofu", [
          "output",
          "-json",
          "database_credentials",
        ]),
      );
      connections = roleConnections(credentials, config);
      const rolePasswords = restrictedRolePasswords(credentials, config);
      await awaitNeonOperations(credentials.project_id, env.NEON_API_KEY, { since: started });
      const migrator = new URL(connections.MIGRATION_DATABASE_URL);
      const migrationEnv = {
        ...env,
        PGHOST: migrator.hostname,
        PGPORT: migrator.port || "5432",
        PGDATABASE: decodeURIComponent(migrator.pathname.slice(1)),
        PGUSER: decodeURIComponent(migrator.username),
        PGPASSWORD: decodeURIComponent(migrator.password),
        PGSSLMODE: "verify-full",
        // libpq's verify-full otherwise looks for ~/.postgresql/root.crt, which a hosted runner
        // lacks, so psql never connects. "system" (libpq 16+) trusts the OS certificate store,
        // as node-postgres already does for the deploy's other database checks.
        PGSSLROOTCERT: "system",
      };
      // Creates or updates the restricted roles with SQL. Their passwords reach psql only on
      // standard input; a failed role check is reported by role name, the rest of psql's output
      // is withheld.
      await phase(
        "reviewed database-role grants",
        "psql",
        ["--no-psqlrc", "--set=ON_ERROR_STOP=1", "--single-transaction", "--file=-"],
        {
          env: migrationEnv,
          input: await deploymentRolesInput(rolePasswords),
          explain: (_stdout, stderr) => roleCheckFailures(stderr),
        },
      );
      await phase(
        "database migrations",
        "node",
        [path.join(root, "scripts/database/migrate.mjs")],
        {
          env: migrationEnv,
          // Migration SQL carries no secrets; the first error line names why it stopped.
          explain: (_stdout, stderr) => roleCheckFailures(stderr),
        },
      );
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
      await apply("bindings");
      const hyperdrive = JSON.parse(
        await phase("Hyperdrive identity", "tofu", ["output", "-json", "hyperdrive_id"]),
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
      await phase(
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
      await phase("Wrangler Worker publication", wranglerBin, [
        "deploy",
        "--config",
        wranglerFile,
        "--no-bundle",
      ]);
      await apply("routing");
      result.status = "passed";
    });
  } catch (error) {
    // A lock still held after a failed OpenTofu phase, or one stopped at its time limit, is named,
    // since that phase's output is not.
    const last = result.phases.at(-1);
    if (
      store &&
      last &&
      last.status !== "passed" &&
      (last.command[0].startsWith("OpenTofu") || last.reason === "timeout")
    )
      await readLock(store, target)
        .then((lock) => lock && console.error(describeLock(target, store, lock)))
        .catch(() => {});
    result.status = failedDeploymentStatus(result.phases, Boolean(work));
    throw error;
  } finally {
    await validateEvidence(manifest);
    await writeFile(
      path.join(evidenceDirectory, "evidence-manifest.json"),
      JSON.stringify(manifest, null, 2),
    );
    // Saved plans hold generated credentials; state lives only in the R2 bucket.
    connections = undefined;
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  await runDeployment().catch((error) => {
    console.error(
      `deployment held or failed: ${error instanceof assert.AssertionError ? error.message.split("\n")[0] : "operation failed; sensitive details withheld"}`,
    );
    process.exitCode = 1;
  });
