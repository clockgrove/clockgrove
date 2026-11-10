import assertStrict from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { access, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { testDisposableDatabaseLifecycle } from "../../tests/database/lifecycle.mjs";
import { ownedSubprocess } from "../lib/subprocess.mjs";
import {
  deploymentRolesInput,
  restrictedRoleKeys,
  roleCheckFailures,
} from "./deployment-roles.mjs";
import { databaseIsolationQuery } from "./isolation.mjs";
import { applyMigrations, applySqlFile, psql, psqlQuery, withDisposableDatabase } from "./lib.mjs";
import { restoredSchemaPolicy, withRestoredHistory } from "./restore.mjs";

await testDisposableDatabaseLifecycle();

// The hosted role SQL (deployment-grants.sql) as a deploy runs it on Neon: the migration role is a
// CREATEROLE, CREATEDB member of neon_superuser but no superuser, and creates the restricted roles.
// pg_stat_statements, a password policy and DDL plus failed-statement logging run alongside, and
// no generated password may reach the statement statistics or the server log.
await withDisposableDatabase(
  async ({ tools, environment, temporaryRoot }) => {
    const restricted = [
      "clockgrove_runtime",
      "clockgrove_support",
      "clockgrove_backup",
      "clockgrove_auth_verifier",
      "clockgrove_management_reader",
      "clockgrove_world_reader",
      "clockgrove_mcp_secrets",
    ];
    await psql(
      tools,
      environment,
      `DROP ROLE ${restricted.join(", ")};
     CREATE ROLE neon_superuser NOLOGIN;
     ALTER ROLE clockgrove_migrator CREATEROLE CREATEDB;
     GRANT neon_superuser TO clockgrove_migrator;
     CREATE EXTENSION pg_stat_statements;`,
    );
    const used = [];
    const generated = (letters = false) => {
      const bytes = randomBytes(letters ? 40 : 24);
      const value = letters
        ? String.fromCharCode(...[...bytes].map((byte) => 97 + (byte % 26)))
        : bytes.toString("hex");
      used.push(value);
      return value;
    };
    const passwords = Object.fromEntries(restrictedRoleKeys.map((key) => [key, generated()]));
    const provision = async () => {
      const result = await ownedSubprocess(
        tools.psql,
        ["--no-psqlrc", "--set=ON_ERROR_STOP=1", "--single-transaction", "--file=-"],
        {
          env: environment,
          input: `SET ROLE clockgrove_migrator;\n${await deploymentRolesInput(passwords)}`,
        },
      );
      return result.status === 0 ? "passed" : roleCheckFailures(result.stderr) || result.stderr;
    };
    // A same-named role the migration role did not create, as a Neon API role, is refused by name.
    await psql(tools, environment, "CREATE ROLE clockgrove_backup LOGIN;");
    assertStrict.equal(
      await provision(),
      "clockgrove_backup is not administered by clockgrove_migrator",
    );
    await psql(tools, environment, "DROP ROLE clockgrove_backup;");
    assertStrict.equal(await provision(), "passed");
    passwords.runtime = generated();
    assertStrict.equal(await provision(), "passed", "a second run updates the roles in place");
    // A re-run undoes attribute drift.
    await psql(tools, environment, "ALTER ROLE clockgrove_backup CREATEDB BYPASSRLS;");
    assertStrict.equal(await provision(), "passed", "a re-run normalizes drifted attributes");
    // A password the server's policy refuses (passwordcheck wants a non-letter) fails by role name.
    passwords.support = generated(true);
    assertStrict.equal(await provision(), "clockgrove_support password not set (22023)");
    passwords.support = generated();
    assertStrict.equal(await provision(), "passed");
    assertStrict.equal(
      (
        await psqlQuery(
          tools,
          environment,
          `SELECT count(*) FILTER (WHERE rolcanlogin AND rolpassword LIKE 'SCRAM-SHA-256$%')
                || '|' || count(*) FILTER (WHERE EXISTS (SELECT 1 FROM pg_auth_members m
                  WHERE m.roleid = a.oid AND m.admin_option
                    AND m.member = 'clockgrove_migrator'::regrole))
           FROM pg_authid a WHERE rolname IN (${restricted.map((name) => `'${name}'`).join(", ")})`,
        )
      ).trim(),
      "6|7",
    );
    // Each login role's stored SCRAM verifier is the one for its generated password.
    const verifiers = await psqlQuery(
      tools,
      environment,
      `SELECT rolname, rolpassword FROM pg_authid WHERE rolcanlogin AND rolname = ANY (ARRAY[${restricted.map((name) => `'${name}'`).join(", ")}])`,
    );
    const keyOf = Object.fromEntries(
      restrictedRoleKeys.map((key, index) => [restricted[index], key]),
    );
    for (const line of verifiers.trim().split("\n")) {
      const [name, verifier] = line.split("|");
      const [, rounds, salt, storedKey] = /^SCRAM-SHA-256\$(\d+):([^$]+)\$([^:]+):/u.exec(verifier);
      const salted = pbkdf2Sync(
        passwords[keyOf[name]],
        Buffer.from(salt, "base64"),
        Number(rounds),
        32,
        "sha256",
      );
      const clientKey = createHmac("sha256", salted).update("Client Key").digest();
      assertStrict.equal(createHash("sha256").update(clientKey).digest("base64"), storedKey, name);
    }
    await applyMigrations(tools, environment);
    const isolation = await psqlQuery(
      tools,
      environment,
      `SET ROLE clockgrove_migrator; ${databaseIsolationQuery}`,
    );
    assertStrict.match(
      isolation.trim().split("\n").at(-1),
      /^t(?:\|t)+$/u,
      "hosted-shape isolation",
    );
    // Membership in neon_superuser, which Neon gives its API roles, is refused by name.
    await psql(tools, environment, "GRANT neon_superuser TO clockgrove_support;");
    assertStrict.equal(await provision(), "clockgrove_support is a member of neon_superuser");
    const statements = await psqlQuery(tools, environment, "SELECT query FROM pg_stat_statements");
    const serverLog = await readFile(path.join(temporaryRoot, "postgres.log"), "utf8");
    assertStrict.ok(
      statements.includes("set_password"),
      "pg_stat_statements recorded the role SQL",
    );
    assertStrict.ok(serverLog.includes("clockgrove_support password not set"), "refusal logged");
    for (const password of used)
      assertStrict.ok(
        !statements.includes(password) && !serverLog.includes(password),
        "a generated password reached pg_stat_statements or the server log",
      );
  },
  {
    settings: [
      "shared_preload_libraries=pg_stat_statements,passwordcheck",
      "log_statement=ddl",
      "log_min_error_statement=error",
    ],
  },
);

const attackSuitePath = new URL("../../tests/database/authorization.sql", import.meta.url);
// The crash windows of one journal transaction (Wave 2 plan §14), each injected server-side.
const FAULT_STAGES = [
  "after-receipt",
  "after-head-locks",
  "after-events",
  "after-dispatches",
  "before-commit",
];

async function seedAttackFixtures(tools, environment) {
  await applyMigrations(tools, environment);
  await applySqlFile(tools, environment, "tests/database/seed.sql");
  await applySqlFile(tools, environment, "tests/database/journal-fixture.sql");
  await applySqlFile(tools, environment, "tests/database/hostile-fixture.sql");
}

async function runAttackSuite(tools, environment) {
  return psqlQuery(
    tools,
    { ...environment, PGUSER: "clockgrove_runtime" },
    await readFile(attackSuitePath, "utf8"),
  );
}

// Negative control: the suite must fail, naming the table, when an RLS table is not exercised.
await withDisposableDatabase(async ({ tools, environment }) => {
  await seedAttackFixtures(tools, environment);
  const unexercisedTable = "clockgrove.attack_suite_unexercised_control";
  await psql(
    tools,
    environment,
    `CREATE TABLE ${unexercisedTable} (tenant_id text NOT NULL);
     ALTER TABLE ${unexercisedTable} ENABLE ROW LEVEL SECURITY;`,
  );
  await assertStrict.rejects(runAttackSuite(tools, environment), (error) =>
    String(error.message).includes(unexercisedTable),
  );
});

await withDisposableDatabase(async ({ tools, environment }) => {
  await seedAttackFixtures(tools, environment);
  const result = await runAttackSuite(tools, environment);
  if (!result.includes("database_authorization_ok")) {
    throw new Error(`database authorization checks did not complete: ${result.trim()}`);
  }
  await testJournal(tools, environment);
  await testAttributedJournal(tools, environment);
  await testJournalImmutability(tools, environment);
  const retention = await readFile(
    new URL("../../tests/database/schedule-retention.sql", import.meta.url),
    "utf8",
  );
  const retained = await psqlQuery(tools, environment, `BEGIN; ${retention} ROLLBACK;`);
  assertStrict.ok(retained.includes("schedule_retention_ok"), "schedule retention checks failed");
});

// The Wave 0 restored-history check requires forced RLS on every clockgrove tenant table, without a
// table count: it passes on the migrated schema and fails once a tenant table lacks forced RLS.
await withDisposableDatabase(async (fixture) => {
  const { tools, environment } = fixture;
  await applyMigrations(tools, environment);
  assertStrict.equal(await restoredSchemaPolicy(tools, environment), "t|t|t");
  await withRestoredHistory(fixture, async () => undefined);
  await psql(
    tools,
    environment,
    `SET ROLE clockgrove_migrator;
     CREATE TABLE clockgrove.restore_rls_control (tenant_id text NOT NULL);
     ALTER TABLE clockgrove.restore_rls_control ENABLE ROW LEVEL SECURITY;`,
  );
  await assertStrict.rejects(
    withRestoredHistory(fixture, async () => undefined),
    (error) => {
      assertStrict.equal(error.code, "ERR_ASSERTION");
      assertStrict.equal(error.actual, "t|f|t");
      return true;
    },
  );
});

async function testJournal(tools, environment) {
  const runtime = { ...environment, PGUSER: "clockgrove_runtime" };
  const counts = (commandId, ...expected) =>
    assertCounts(tools, environment, "tenant-j-a", commandId, ...expected);

  // Two real connections contend on the receipt. Both must return one stored result.
  const identical = journalRequest("identical", "tenant-j-a");
  const [left, right] = await Promise.all([
    execute(tools, runtime, identical, "identical-bytes"),
    execute(tools, runtime, identical, "identical-bytes"),
  ]);
  assertStrict.equal(left, right, "identical retry result was unstable");
  await counts("command-identical", 1, 1, 1);

  // Different exact bytes race on one ID: one commits and one fails closed; later different bytes
  // are refused too.
  const conflicting = journalRequest("concurrent-conflict", "tenant-j-a");
  const raced = await Promise.allSettled([
    execute(tools, runtime, conflicting, "left-bytes"),
    execute(tools, runtime, conflicting, "right-bytes"),
  ]);
  assertStrict.deepEqual(raced.map(({ status }) => status).sort(), ["fulfilled", "rejected"]);
  await counts("command-concurrent-conflict", 1, 1, 1);
  await assertStrict.rejects(execute(tools, runtime, identical, "changed-bytes"));

  // Each expected-revision mismatch is refused and writes nothing.
  for (const [name, expected] of [
    ["stream-conflict", { streamSequence: "999" }],
    ["partition-conflict", { partitionRevision: "999" }],
    ["routing-conflict", { routingEpoch: 999 }],
  ]) {
    await assertStrict.rejects(
      execute(tools, runtime, journalRequest(name, "tenant-j-a", expected), name),
    );
    await counts(`command-${name}`, 0, 0, 0);
  }

  // Every crash window leaves nothing and no moved head, and the same command then commits normally.
  for (const stage of FAULT_STAGES) {
    const name = `failure-${stage}`;
    const heads = await headsOf(tools, environment, "tenant-j-a");
    await assertStrict.rejects(
      execute(tools, runtime, journalRequest(name, "tenant-j-a"), name, stage),
    );
    await counts(`command-${name}`, 0, 0, 0);
    assertStrict.equal(await headsOf(tools, environment, "tenant-j-a"), heads);
    await execute(tools, runtime, journalRequest(name, "tenant-j-a"), name);
    await counts(`command-${name}`, 1, 1, 1);
  }
  const allocatedSequences = await psqlQuery(
    tools,
    environment,
    `SELECT count(*) = count(DISTINCT stream_sequence),
            count(*) = count(DISTINCT partition_sequence)
       FROM clockgrove.events WHERE tenant_id = 'tenant-j-a'`,
  );
  assertStrict.equal(allocatedSequences.trim(), "t|t", "journal allocated duplicate sequences");

  // A lost response: the retry returns the committed result and appends nothing.
  const lost = journalRequest("lost-response", "tenant-j-a");
  await execute(tools, runtime, lost, "lost-response-bytes");
  const recovered = await execute(tools, runtime, lost, "lost-response-bytes");
  assertStrict.equal(JSON.parse(recovered).value.accepted, "lost-response");
  await counts("command-lost-response", 1, 1, 1);

  // The same command ID is isolated by tenant and cannot be observed across RLS scopes.
  await execute(tools, runtime, journalRequest("identical", "tenant-j-b"), "identical-bytes");
  const visible = await psqlQuery(
    tools,
    runtime,
    inContext(
      "tenant-j-a",
      "principal-j-a",
      "SELECT 'count:' || count(*) FROM clockgrove.command_receipts WHERE command_id = 'command-identical';",
    ),
  );
  assertStrict.match(
    visible,
    /^count:1$/mu,
    "runtime tenant isolation exposed another tenant receipt",
  );
}

async function testAttributedJournal(tools, environment) {
  const runtime = { ...environment, PGUSER: "clockgrove_runtime" };
  const counts = (commandId, ...expected) =>
    assertCounts(tools, environment, "tenant-j-a", commandId, ...expected);

  // An allowed command commits an attributed receipt linked to one allow decision that records who
  // asked and on what inputs, and its committed event seals that decision.
  const allowed = journalRequest("attributed", "tenant-j-a", { routingEpoch: 7 });
  await execute(tools, runtime, allowed, "attributed-bytes");
  assertStrict.equal(
    await recorded(tools, environment, allowed),
    "committed|attributed|authority-attributed|allow|-|event-attributed-j-a|t",
  );
  const sealed = await psqlQuery(
    tools,
    environment,
    `SELECT count(*) FROM clockgrove.events
      WHERE tenant_id = 'tenant-j-a' AND command_id = 'command-attributed'
        AND attribution->>'authorityDecisionId' = 'authority-attributed'`,
  );
  assertStrict.equal(sealed.trim(), "1", "committed event does not seal its authority decision");

  // Drafts sealing another decision are refused and write nothing.
  const mismatched = journalRequest("mismatched-seal", "tenant-j-a");
  mismatched.request.events[0].attribution.authorityDecisionId = "authority-other";
  assertStrict.equal(await executeState(tools, runtime, mismatched, "mismatched-bytes"), "CG007");
  await counts("command-mismatched-seal", 0, 0, 0);

  // A denial interrupted before COMMIT leaves nothing. Committed, it records a rejected receipt and
  // its deny decision, appends nothing, moves no head, and every exact retry returns the stored
  // rejection, even one now carrying an allow decision.
  const heads = await headsOf(tools, environment, "tenant-j-a");
  const denied = journalRequest("denied", "tenant-j-a", {}, "deny");
  assertStrict.equal(
    await executeState(tools, runtime, denied, "denied-bytes", "before-commit"),
    "P0001",
  );
  await counts("command-denied", 0, 0, 0);
  const rejected = await execute(tools, runtime, denied, "denied-bytes");
  assertStrict.deepEqual(JSON.parse(rejected), {
    value: { error: "authorization_refused" },
    events: [],
    projectionDelta: null,
    outcome: "rejected",
  });
  assertStrict.equal(
    await recorded(tools, environment, denied),
    "rejected|attributed|authority-denied|deny|runtime-grant-missing||t",
  );
  for (const retry of [denied, journalRequest("denied", "tenant-j-a")]) {
    assertStrict.equal(await execute(tools, runtime, retry, "denied-bytes"), rejected);
    await counts("command-denied", 1, 0, 0, 1);
    assertStrict.equal(await headsOf(tools, environment, "tenant-j-a"), heads);
  }

  // A scope that names no world and timeline of the authorized tenant writes nothing.
  const unknownWorld = journalRequest("unknown-world", "tenant-j-a", {}, "deny");
  for (const target of [unknownWorld.request.target, unknownWorld.request.authorityDecision]) {
    target.worldId = "world-unknown";
  }
  assertStrict.equal(await executeState(tools, runtime, unknownWorld, "unknown-bytes"), "CG005");
  const foreign = journalRequest("foreign-scope", "tenant-j-b", {}, "deny");
  assertStrict.equal(
    await executeState(tools, runtime, { ...foreign, principal: "principal-j-a" }, "foreign-bytes"),
    "CG005",
  );
  await counts("command-unknown-world", 0, 0, 0);
  await assertCounts(tools, environment, "tenant-j-b", "command-foreign-scope", 0, 0, 0);
}

async function testJournalImmutability(tools, environment) {
  const suite = await readFile(
    new URL("../../tests/database/journal-immutability.sql", import.meta.url),
    "utf8",
  );
  for (const role of ["clockgrove_admin", "clockgrove_migrator", "clockgrove_runtime"]) {
    const context = role === "clockgrove_runtime" ? contextSql("tenant-j-a", "principal-j-a") : "";
    const result = await psqlQuery(
      tools,
      environment,
      `BEGIN; SET LOCAL ROLE ${role}; ${context}
       ${suite}
       ROLLBACK;`,
    );
    assert(result.includes("journal_immutability_ok"), `journal immutability failed as ${role}`);
  }
}

/**
 * `status|provenance|decision|outcome|reason|event IDs|attribution and inputs stored as requested`
 * of a command's receipt and its authority decision.
 */
async function recorded(tools, environment, input) {
  const { commandId, attribution, authorityDecision } = input.request;
  return (
    await psqlQuery(
      tools,
      environment,
      `SELECT concat_ws('|', receipt.status, receipt.provenance, receipt.authority_decision_id,
                decision.outcome, coalesce(decision.reason_code, '-'),
                array_to_string(receipt.canonical_event_ids, ','),
                receipt.attribution = ${literal(JSON.stringify(attribution))}::jsonb
                  AND decision.attribution = receipt.attribution
                  AND decision.inputs = ${literal(JSON.stringify(authorityDecision.inputs))}::jsonb)
         FROM clockgrove.command_receipts AS receipt
         JOIN clockgrove.authority_decisions AS decision USING (tenant_id, command_id)
        WHERE tenant_id = 'tenant-j-a' AND command_id = ${literal(commandId)}`,
    )
  ).trim();
}

async function headsOf(tools, environment, tenant) {
  return (
    await psqlQuery(
      tools,
      environment,
      `SELECT string_agg(stream_id || ':' || current_sequence, ',' ORDER BY stream_id)
         || '/' || (SELECT string_agg(partition_id || ':' || head_sequence, ',' ORDER BY partition_id)
                      FROM clockgrove.timeline_partitions WHERE tenant_id = ${literal(tenant)})
         FROM clockgrove.streams WHERE tenant_id = ${literal(tenant)}`,
    )
  ).trim();
}

/** The transaction-local authorization of a runtime request. */
function contextSql(tenant, principal) {
  return `SELECT set_config('app.tenant_id', ${literal(tenant)}, true);
     SELECT set_config('app.principal_id', ${literal(principal)}, true);
     SELECT set_config('app.privacy_ceiling', '{"version":1,"allowedCategories":["public_scene"]}', true);`;
}

/** `sql` in one committed transaction under a runtime request's authorization. */
function inContext(tenant, principal, sql) {
  return `BEGIN;
     ${contextSql(tenant, principal)}
     ${sql}
     COMMIT;`;
}

/** The `execute_journal` call of one request, with its exact bytes and optional fault stage. */
function journalCall(input, bytes, failureStage) {
  return `decode(${literal(Buffer.from(bytes).toString("hex"))}, 'hex'),
       ${literal(JSON.stringify(input.request))}::jsonb,
       ${failureStage === null ? "NULL" : literal(failureStage)}`;
}

async function execute(tools, environment, input, bytes, failureStage = null) {
  const result = await psqlQuery(
    tools,
    environment,
    inContext(
      input.request.target.tenantId,
      input.principal,
      `SELECT clockgrove.execute_journal(${journalCall(input, bytes, failureStage)})::text;`,
    ),
  );
  return (
    result
      .trim()
      .split("\n")
      .find((line) => line.includes('"events"') && line.includes('"projectionDelta"')) ?? ""
  );
}

/** Runs the journal function and returns the SQLSTATE it raised, or "ok"; failures write nothing. */
async function executeState(tools, environment, input, bytes, failureStage = null) {
  const result = await psqlQuery(
    tools,
    environment,
    inContext(
      input.request.target.tenantId,
      input.principal,
      `CREATE FUNCTION pg_temp.journal_state(bytes bytea, request jsonb, stage text) RETURNS text
       LANGUAGE plpgsql AS $state$
       BEGIN
         PERFORM clockgrove.execute_journal(bytes, request, stage);
         RETURN 'state:ok';
       EXCEPTION WHEN OTHERS THEN
         RETURN 'state:' || SQLSTATE;
       END;
       $state$;
       SELECT pg_temp.journal_state(${journalCall(input, bytes, failureStage)});`,
    ),
  );
  const line = result.split("\n").find((candidate) => candidate.startsWith("state:"));
  return line?.slice("state:".length).trim() ?? "";
}

/** A journal request in one fixture tenant: one event and one dispatch, or none for a denial. */
function journalRequest(name, tenant, expected = {}, outcome = "allow") {
  const suffix = tenant === "tenant-j-a" ? "j-a" : "j-b";
  const commandId = `command-${name}`;
  const eventId = `event-${name}-${suffix}`;
  const attribution = { effectiveActorId: `world-${suffix}`, causalRootActionId: `action-${name}` };
  const scope = { worldId: `world-${suffix}`, timelineId: `timeline-${suffix}` };
  const route = {
    partitionId: `partition-${suffix}`,
    spaceId: `space-${suffix}`,
    streamId: `stream-${suffix}`,
  };
  const request = {
    commandId,
    target: { version: 1, tenantId: tenant, ...scope, kind: "world", id: `world-${suffix}` },
    expected,
    attribution,
    correlationId: `correlation-${name}`,
    authorityDecision: {
      version: 1,
      authorityDecisionId: `authority-${name}`,
      outcome,
      tenantId: tenant,
      ...scope,
      commandId,
      actionId: `action-${name}`,
      attribution,
      inputs: {
        principalId: `principal-${suffix}`,
        roles: [],
        grants: outcome === "allow" ? ["runtime:no-op"] : [],
        privacyCeiling: { version: 1, allowedCategories: ["public_scene"] },
      },
      ...(outcome === "deny" ? { reasonCode: "runtime-grant-missing" } : {}),
    },
    events: [],
    dispatches: [],
    stableResult: { error: "authorization_refused" },
    projectionDelta: null,
  };
  if (outcome === "allow") {
    Object.assign(request, {
      route,
      events: [
        {
          schemaVersion: 2,
          eventId,
          type: "JournalFixtureRecorded",
          ...route,
          simulationTime: "42",
          correlationId: `correlation-${name}`,
          attribution: { ...attribution, authorityDecisionId: `authority-${name}` },
          policyVersions: { fixture: "1" },
          privacyClass: "public_scene",
          payloadHash: `sha256:${name}`,
          payload: { name },
        },
      ],
      dispatches: [
        {
          dispatchId: `dispatch-${name}-${suffix}`,
          eventId,
          channel: "world-reactions",
          privacyClass: "public_scene",
          payload: { eventId },
        },
      ],
      stableResult: { accepted: name },
    });
  }
  return { principal: `principal-${suffix}`, request };
}

async function assertCounts(
  tools,
  environment,
  tenant,
  commandId,
  receipts,
  events,
  dispatches,
  decisions = receipts,
) {
  const result = await psqlQuery(
    tools,
    environment,
    `SELECT
       (SELECT count(*) FROM clockgrove.command_receipts WHERE tenant_id = ${literal(tenant)} AND command_id = ${literal(commandId)}),
       (SELECT count(*) FROM clockgrove.authority_decisions WHERE tenant_id = ${literal(tenant)} AND command_id = ${literal(commandId)}),
       (SELECT count(*) FROM clockgrove.events WHERE tenant_id = ${literal(tenant)} AND command_id = ${literal(commandId)}),
       (SELECT count(*) FROM clockgrove.event_dispatches AS dispatch
          JOIN clockgrove.events AS event ON event.tenant_id = dispatch.tenant_id AND event.event_id = dispatch.event_id
         WHERE event.tenant_id = ${literal(tenant)} AND event.command_id = ${literal(commandId)});`,
  );
  assert(
    result.trim() === `${receipts}|${decisions}|${events}|${dispatches}`,
    `unexpected atomic counts for ${commandId}: ${result.trim()}`,
  );
}

function literal(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// In Qualification, each case's result is retained for the Wave 2 evidence manifest (qualify:wave2)
// in CLOCKGROVE_WAVE2_EVIDENCE, a directory of its own outside CI_EVIDENCE_DIR. The first test:db
// run of a job writes it (the one whose receipt the manifest reads); a rerun leaves it.
const wave2Report = process.env.CLOCKGROVE_WAVE2_EVIDENCE
  ? path.join(process.env.CLOCKGROVE_WAVE2_EVIDENCE, "test-db.vitest.json")
  : null;
const writeReport =
  wave2Report !== null &&
  !(await access(wave2Report).then(
    () => true,
    () => false,
  ));
if (writeReport) await mkdir(path.dirname(wave2Report), { recursive: true });
await new Promise((resolve, reject) => {
  const child = spawn(
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      "--config",
      "apps/runtime/vitest.runtime.config.ts",
      "apps/runtime/test/hyperdrive.postgres.test.ts",
      "apps/runtime/test/journal-isolation.postgres.test.ts",
      "apps/runtime/test/journal-range.postgres.test.ts",
      "apps/runtime/test/attributed-receipts.postgres.test.ts",
      "apps/runtime/test/runtime.postgres.test.ts",
      "apps/runtime/test/world-provisioning.postgres.test.ts",
      "apps/runtime/test/world-readiness.postgres.test.ts",
      "apps/runtime/test/world-command.postgres.test.ts",
      "apps/runtime/test/due-work.postgres.test.ts",
      "apps/runtime/test/dispatch-claims.postgres.test.ts",
      "apps/runtime/test/dispatch-delivery.postgres.test.ts",
      "apps/runtime/test/journal-parity.postgres.test.ts",
      "apps/runtime/test/native-parity.postgres.test.ts",
      "apps/runtime/test/artifact-store.postgres.test.ts",
      "apps/runtime/test/partition-snapshot.postgres.test.ts",
      "apps/runtime/test/causal-inspector.postgres.test.ts",
      "apps/runtime/test/prior-release-fixtures.postgres.test.ts",
      "apps/runtime/test/migration-safety.postgres.test.ts",
      "apps/runtime/test/mcp-installations.postgres.test.ts",
      ...(writeReport
        ? ["--reporter=default", "--reporter=json", `--outputFile.json=${wave2Report}`]
        : []),
    ],
    { stdio: "inherit" },
  );
  child.on("error", reject);
  child.on("exit", (code, signal) =>
    code === 0
      ? resolve()
      : reject(new Error(`Hyperdrive database test exited with ${code ?? signal}`)),
  );
});

console.log("real PostgreSQL database tests passed");
