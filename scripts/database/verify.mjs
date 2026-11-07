import { createHash } from "node:crypto";
import {
  applyMigrations,
  applySqlFile,
  psql,
  psqlQuery,
  verifyPgvectorVersion,
  withDisposableDatabase,
} from "./lib.mjs";

const birthTables = [
  "pack_artifacts",
  "pack_artifact_resources",
  "provisioning_cases",
  "pack_installations",
  "world_birth_states",
  "birth_state_sections",
  "birth_space_state",
  "birth_schedules",
  "birth_random_streams",
  "birth_cognitive_seed_refs",
];

// The migrator-owned dispatch lease functions (0009). Only the runtime role may execute them.
const dispatchFunctions = [
  "'clockgrove.claim_dispatches(text, integer, text, integer)'::regprocedure",
  "'clockgrove.settle_dispatch(text, integer, text, text, integer)'::regprocedure",
].join(", ");

// Receipts follow their state machine, decisions are immutable for every role, and the runtime role
// may only append events, dispatch intent and decisions. External-effects dispatches need a live timeline.
const journalTriggers = [
  ["command_receipts", "command_receipts_guard_transition"],
  ["command_receipts", "command_receipts_immutable_truncate"],
  ["authority_decisions", "authority_decisions_immutable_rows"],
  ["authority_decisions", "authority_decisions_immutable_truncate"],
  ["event_dispatches", "event_dispatches_preview_effect_policy"],
];

await withDisposableDatabase(async ({ tools, environment }) => {
  await applyMigrations(tools, environment);
  await verifySchema(tools, environment, { worldsEmpty: true });

  await psql(tools, { ...environment, PGDATABASE: "postgres" }, "DROP DATABASE clockgrove;");
  await psql(
    tools,
    { ...environment, PGDATABASE: "postgres" },
    "CREATE DATABASE clockgrove OWNER clockgrove_migrator TEMPLATE template0 ENCODING 'UTF8';",
  );
  // Apply the immutable baseline first, then exercise the additive forward migration.
  const { mkdtemp, copyFile, rm } = await import("node:fs/promises");
  const path = await import("node:path");
  const baseline = await mkdtemp(
    path.join((await import("node:os")).tmpdir(), "clockgrove-forward-"),
  );
  try {
    await copyFile(
      new URL("../../db/migrations/0001_wave0_journal.sql", import.meta.url),
      path.join(baseline, "0001_wave0_journal.sql"),
    );
    await applyMigrations(tools, environment, { migrationDirectory: baseline });
  } finally {
    await rm(baseline, { recursive: true, force: true });
  }
  await applyMigrations(tools, environment);
  await applyMigrations(tools, environment);
  await applySqlFile(tools, environment, "db/fixtures/current-schema.sql");
  await verifySchema(tools, environment, { worldsEmpty: false });
  const representative = await psqlQuery(
    tools,
    environment,
    `SELECT count(*) FROM clockgrove.events WHERE event_id = 'event-fixture'`,
  );
  if (representative.trim() !== "1") throw new Error("representative fixture was not loaded");
});

console.log("database migrations verified on empty and representative current-schema databases");

async function verifySchema(tools, environment, { worldsEmpty }) {
  await verifyPgvectorVersion(tools, environment);
  const authority = await psqlQuery(
    tools,
    environment,
    `SELECT
    to_regclass('clockgrove_auth.session') IS NOT NULL,
    to_regclass('clockgrove_management.identity_links') IS NOT NULL,
    (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = 'clockgrove.world_memberships'::regclass),
    NOT has_table_privilege('clockgrove_auth_verifier', 'clockgrove_auth.session', 'INSERT,UPDATE,DELETE'),
    NOT has_table_privilege('clockgrove_management_reader', 'clockgrove.world_memberships', 'SELECT,INSERT,UPDATE,DELETE'),
    NOT has_table_privilege('clockgrove_world_reader', 'clockgrove_management.identity_links', 'SELECT,INSERT,UPDATE,DELETE')`,
  );
  if (authority.trim() !== "t|t|t|t|t|t")
    throw new Error("authentication/authority schema isolation failed");
  const result = await psqlQuery(
    tools,
    environment,
    `SELECT
       to_regclass('clockgrove.events') IS NOT NULL,
       to_regclass('clockgrove.command_receipts') IS NOT NULL,
       to_regclass('clockgrove.event_dispatches') IS NOT NULL,
       to_regclass('clockgrove.snapshots') IS NOT NULL,
       to_regclass('clockgrove.artifact_references') IS NOT NULL,
       (SELECT NOT rolbypassrls AND NOT rolsuper FROM pg_roles WHERE rolname = 'clockgrove_runtime'),
       (SELECT rolbypassrls AND NOT rolsuper FROM pg_roles WHERE rolname = 'clockgrove_migrator'),
       NOT pg_has_role('clockgrove_runtime', 'clockgrove_migrator', 'MEMBER'),
       (SELECT count(*) = 15
          FROM pg_class AS relation
          JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = 'clockgrove'
           AND relation.relname = ANY (ARRAY[
             'tenants', 'tenant_principals', 'worlds', 'timelines', 'timeline_partitions',
             'streams', 'events', 'command_receipts', 'event_dispatches',
             'artifact_references', 'artifact_data_keys', 'snapshots', 'authority_decisions',
             'partition_states', 'partition_schedules'
           ])
           AND relation.relrowsecurity
           AND relation.relforcerowsecurity),
       EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'clockgrove'
            AND indexname = 'event_dispatches_pending_idx'
            AND indexdef LIKE '%(channel, status, next_attempt_at)%'
       ),
       NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexdef ILIKE '%USING hnsw%'),
       (SELECT '[1,0]'::vector <=> '[1,0]'::vector = 0);`,
  );
  const checks = result.trim().split("|");
  if (checks.length !== 12 || checks.some((check) => check !== "t")) {
    throw new Error(`database schema verification failed: ${result.trim()}`);
  }
  await verifyJournalImmutability(tools, environment);
  await verifyArtifactStore(tools, environment);
  if (!worldsEmpty) await verifySnapshotConstraints(tools, environment);
  await verifyPartitionStateSchema(tools, environment, worldsEmpty);
  await verifyBirthSchema(tools, environment, worldsEmpty);
}

// The partition-state projection and its schedule rows: forced tenant RLS, their guard triggers, the
// due index, the runtime role may read, insert and update but never delete, and only the runtime role
// may run the split journal functions.
async function verifyPartitionStateSchema(tools, environment, worldsEmpty) {
  const result = await psqlQuery(
    tools,
    environment,
    `SELECT
       (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class
         WHERE oid = 'clockgrove.partition_states'::regclass),
       EXISTS (
         SELECT 1 FROM pg_policy
          WHERE polrelid = 'clockgrove.partition_states'::regclass AND polname = 'tenant_isolation'),
       EXISTS (
         SELECT 1 FROM pg_trigger
          WHERE tgrelid = 'clockgrove.partition_states'::regclass
            AND tgname = 'partition_states_guard' AND tgenabled = 'O'),
       has_table_privilege('clockgrove_runtime', 'clockgrove.partition_states', 'SELECT,INSERT,UPDATE'),
       NOT has_table_privilege('clockgrove_runtime', 'clockgrove.partition_states', 'DELETE'),
       NOT has_table_privilege('clockgrove_runtime', 'clockgrove.partition_states', 'TRUNCATE'),
       has_function_privilege('clockgrove_runtime', 'clockgrove.begin_command(bytea, jsonb, text)', 'EXECUTE'),
       has_function_privilege('clockgrove_runtime', 'clockgrove.append_command(jsonb, text)', 'EXECUTE'),
       NOT has_function_privilege('clockgrove_support', 'clockgrove.begin_command(bytea, jsonb, text)', 'EXECUTE'),
       NOT has_function_privilege('clockgrove_support', 'clockgrove.append_command(jsonb, text)', 'EXECUTE'),
       ${worldsEmpty ? "(SELECT count(*) = 0 FROM clockgrove.partition_states)" : "true"},
       (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class
         WHERE oid = 'clockgrove.partition_schedules'::regclass),
       EXISTS (
         SELECT 1 FROM pg_policy
          WHERE polrelid = 'clockgrove.partition_schedules'::regclass AND polname = 'tenant_isolation'),
       EXISTS (
         SELECT 1 FROM pg_trigger
          WHERE tgrelid = 'clockgrove.partition_schedules'::regclass
            AND tgname = 'partition_schedules_guard' AND tgenabled = 'O'),
       EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'clockgrove' AND indexname = 'partition_schedules_due_idx'
            AND indexdef LIKE '%(tenant_id, timeline_id, partition_id, due_at, priority, tie_break_key)%'
            AND indexdef LIKE '%WHERE (status = ''pending''::text)%'),
       has_table_privilege('clockgrove_runtime', 'clockgrove.partition_schedules', 'SELECT,INSERT,UPDATE'),
       NOT has_table_privilege('clockgrove_runtime', 'clockgrove.partition_schedules', 'DELETE'),
       NOT has_table_privilege('clockgrove_runtime', 'clockgrove.partition_schedules', 'TRUNCATE'),
       ${worldsEmpty ? "(SELECT count(*) = 0 FROM clockgrove.partition_schedules)" : "true"}`,
  );
  if (result.trim() !== Array(19).fill("t").join("|")) {
    throw new Error(`partition state schema verification failed: ${result.trim()}`);
  }
}

async function verifyJournalImmutability(tools, environment) {
  const triggers = journalTriggers
    .map(([table, trigger]) => `('${table}', '${trigger}')`)
    .join(", ");
  const result = await psqlQuery(
    tools,
    environment,
    `SELECT
       (SELECT count(*) = ${journalTriggers.length}
          FROM pg_trigger AS trigger
          JOIN pg_class AS relation ON relation.oid = trigger.tgrelid
          JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = 'clockgrove' AND trigger.tgenabled = 'O'
           AND (relation.relname, trigger.tgname) IN (${triggers})),
       NOT has_table_privilege('clockgrove_runtime', 'clockgrove.events', 'UPDATE'),
       NOT has_table_privilege('clockgrove_runtime', 'clockgrove.events', 'DELETE'),
       NOT has_table_privilege('clockgrove_runtime', 'clockgrove.event_dispatches', 'UPDATE'),
       NOT has_table_privilege('clockgrove_runtime', 'clockgrove.event_dispatches', 'DELETE'),
       has_table_privilege('clockgrove_runtime', 'clockgrove.events', 'SELECT,INSERT'),
       has_table_privilege('clockgrove_runtime', 'clockgrove.event_dispatches', 'SELECT,INSERT'),
       NOT has_table_privilege('clockgrove_runtime', 'clockgrove.command_receipts', 'DELETE'),
       has_table_privilege('clockgrove_runtime', 'clockgrove.authority_decisions', 'SELECT,INSERT'),
       NOT has_table_privilege('clockgrove_runtime', 'clockgrove.authority_decisions', 'UPDATE'),
       NOT has_table_privilege('clockgrove_runtime', 'clockgrove.authority_decisions', 'DELETE'),
       NOT has_table_privilege('clockgrove_runtime', 'clockgrove.authority_decisions', 'TRUNCATE'),
       has_function_privilege('clockgrove_runtime', 'clockgrove.claim_dispatches(text, integer, text, integer)', 'EXECUTE'),
       has_function_privilege('clockgrove_runtime', 'clockgrove.settle_dispatch(text, integer, text, text, integer)', 'EXECUTE'),
       NOT has_function_privilege('clockgrove_support', 'clockgrove.claim_dispatches(text, integer, text, integer)', 'EXECUTE'),
       (SELECT bool_and(pg_get_userbyid(proowner) = 'clockgrove_migrator' AND prosecdef)
          FROM pg_proc WHERE oid IN (${dispatchFunctions})),
       (SELECT bool_and(acl.grantee <> 0
                        AND pg_get_userbyid(acl.grantee) IN ('clockgrove_runtime', 'clockgrove_migrator'))
          FROM pg_proc, aclexplode(pg_proc.proacl) AS acl
         WHERE pg_proc.oid IN (${dispatchFunctions}))`,
  );
  if (result.trim() !== Array(17).fill("t").join("|")) {
    throw new Error(`journal immutability verification failed: ${result.trim()}`);
  }
}

// Artifact and snapshot metadata are append-only for the runtime role, data keys may only be
// rewrapped, and support and backup hold no privilege on any of them.
async function verifyArtifactStore(tools, environment) {
  const result = await psqlQuery(
    tools,
    environment,
    `SELECT
       has_table_privilege('clockgrove_runtime', 'clockgrove.artifact_references', 'SELECT')
         AND has_table_privilege('clockgrove_runtime', 'clockgrove.artifact_references', 'INSERT'),
       NOT has_table_privilege('clockgrove_runtime', 'clockgrove.artifact_references', 'UPDATE,DELETE,TRUNCATE'),
       NOT has_any_column_privilege('clockgrove_runtime', 'clockgrove.artifact_references', 'UPDATE'),
       has_table_privilege('clockgrove_runtime', 'clockgrove.artifact_data_keys', 'SELECT')
         AND has_table_privilege('clockgrove_runtime', 'clockgrove.artifact_data_keys', 'INSERT'),
       NOT has_table_privilege('clockgrove_runtime', 'clockgrove.artifact_data_keys', 'UPDATE,DELETE,TRUNCATE'),
       (SELECT bool_and(has_column_privilege('clockgrove_runtime', attrelid, attnum, 'UPDATE')
                        = (attname IN ('kek_id', 'wrapped_key')))
          FROM pg_attribute
         WHERE attrelid = 'clockgrove.artifact_data_keys'::regclass AND attnum > 0 AND NOT attisdropped),
       EXISTS (SELECT 1 FROM pg_policy
                WHERE polrelid = 'clockgrove.artifact_data_keys'::regclass
                  AND polname = 'tenant_privacy_isolation'),
       (SELECT bool_and(
                 NOT has_table_privilege(role, relation, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
                 AND NOT has_any_column_privilege(role, relation, 'SELECT,INSERT,UPDATE,REFERENCES'))
          FROM unnest(ARRAY['clockgrove_support', 'clockgrove_backup']) AS role,
               unnest(ARRAY['clockgrove.artifact_references', 'clockgrove.artifact_data_keys',
                            'clockgrove.snapshots']) AS relation),
       has_table_privilege('clockgrove_runtime', 'clockgrove.snapshots', 'SELECT')
         AND has_table_privilege('clockgrove_runtime', 'clockgrove.snapshots', 'INSERT'),
       NOT has_table_privilege('clockgrove_runtime', 'clockgrove.snapshots', 'UPDATE,DELETE,TRUNCATE'),
       NOT has_any_column_privilege('clockgrove_runtime', 'clockgrove.snapshots', 'UPDATE'),
       (SELECT array_agg(conname || ' ' || pg_get_constraintdef(oid)) FROM pg_constraint
         WHERE conrelid = 'clockgrove.snapshots'::regclass AND confrelid = 'clockgrove.artifact_references'::regclass)
         = ARRAY['snapshots_artifact_target FOREIGN KEY (tenant_id, artifact_id, world_id, timeline_id, partition_id, space_id, privacy_class) REFERENCES clockgrove.artifact_references(tenant_id, artifact_id, world_id, timeline_id, partition_id, space_id, privacy_class)']`,
  );
  if (result.trim() !== Array(12).fill("t").join("|")) {
    throw new Error(`artifact and snapshot privilege verification failed: ${result.trim()}`);
  }
  // CHECKs run before foreign keys, so an empty database works.
  const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const hex = (bytes) => `\\x${Buffer.from(bytes).toString("hex")}`;
  const [hash, otherHash, big] = [sha256("{}"), `sha256:${"0".repeat(64)}`, Buffer.alloc(131_073)];
  const scope = {
    tenant_id: "tenant-fixture",
    world_id: "world-fixture",
    created_at: "2026-01-01Z",
  };
  const artifact = {
    ...scope,
    timeline_id: "timeline-fixture",
    partition_id: "partition-fixture",
    space_id: "space-fixture",
    artifact_id: "artifact-refused",
    media_type: "application/json",
    content_hash: hash,
    inline_content: hex("{}"),
    byte_length: 2,
    privacy_class: "public_scene",
    retention_class: "durable",
    encryption: "none",
  };
  const dataKey = { ...scope, privacy_class: "operator_evidence", key_version: 1, kek_id: "kek-a" };
  // 29 inline bytes starting with `first`: an envelope v1 shape only when `first` is 0x01.
  const sealed = (first) => {
    const bytes = Buffer.alloc(29, first);
    return { inline_content: hex(bytes), byte_length: 29, content_hash: sha256(bytes) };
  };
  const encrypted = { encryption: "aes-256-gcm-v1", data_key_version: 1, ...sealed(1) };
  const spill = (key, tenant = artifact.tenant_id) => ({
    inline_content: null,
    storage_key: `durable/${Buffer.from(tenant).toString("hex")}/sha256/${key.slice(7)}`,
  });
  const refused = Object.entries({
    references_private_encrypted: [{ privacy_class: "conversation" }, encrypted],
    references_no_credential: [{ privacy_class: "credential", ...encrypted }],
    references_data_key_version: [
      { privacy_class: "conversation", encryption: encrypted.encryption },
    ],
    references_content_hash: [{ content_hash: hash.toUpperCase() }],
    references_inline_bytes: [
      { content_hash: otherHash },
      { byte_length: 3 },
      { inline_content: hex(big), byte_length: big.length, content_hash: sha256(big) },
    ],
    references_one_location: [{ storage_key: spill(hash).storage_key }, { inline_content: null }],
    references_storage_key: [
      spill(otherHash),
      { ...spill(hash), retention_class: "ephemeral" },
      spill(hash, "tenant-other"),
    ],
    references_envelope: [{ privacy_class: "conversation", ...encrypted, ...sealed(2) }],
    data_keys_wrapped_key: [{ wrapped_key: hex(Buffer.alloc(60)) }],
    data_keys_private_class: [{ privacy_class: "public_scene" }],
    data_keys_kek_id: [{ kek_id: "KEK" }],
  }).flatMap(([constraint, changes]) =>
    changes.map((change) => {
      const keys = constraint.startsWith("data_keys");
      return {
        table_name: keys ? "artifact_data_keys" : "artifact_references",
        constraint_name: `artifact_${constraint}`,
        fields: {
          ...(keys ? { ...dataKey, wrapped_key: hex(Buffer.alloc(61)) } : artifact),
          ...change,
        },
      };
    }),
  );
  await refuseInserts(tools, environment, refused);
}

// Variants of the representative fixture snapshot (covered head 1), each refused by one constraint.
async function verifySnapshotConstraints(tools, environment) {
  const row = JSON.parse(
    await psqlQuery(
      tools,
      environment,
      `SELECT to_jsonb(s) || '{"snapshot_id":"refused","covered_partition_sequence":2}' FROM clockgrove.snapshots s`,
    ),
  );
  const refused = [
    ["snapshots_state_hash", { ...row, state_hash: `sha256:${"0".repeat(64)}` }],
    ["snapshots_state_hash", { ...row, state_hash: "A".repeat(64) }],
    ["snapshots_stream_coverage", { ...row, covered_sequence: 3 }],
    ["snapshots_compatibility", { ...row, compatibility: [] }],
    ["snapshots_partition_head", { ...row, covered_partition_sequence: 1 }],
    ["snapshots_artifact_target", { ...row, privacy_class: "operator_evidence" }],
  ].map(([constraint_name, fields]) => ({ table_name: "snapshots", constraint_name, fields }));
  await refuseInserts(tools, environment, refused);
}

// Each row is valid except for one property and must be refused by exactly the named constraint,
// even for the migrator, which bypasses RLS.
async function refuseInserts(tools, environment, refused) {
  await psql(
    tools,
    environment,
    `SET ROLE clockgrove_migrator;
     DO $verify$
     DECLARE
       attempt record;
       hit text;
     BEGIN
       FOR attempt IN
         SELECT * FROM jsonb_to_recordset($json$${JSON.stringify(refused)}$json$)
           AS attempts (table_name text, constraint_name text, fields jsonb)
       LOOP
         BEGIN
           EXECUTE format(
             'INSERT INTO clockgrove.%1$I SELECT * FROM jsonb_populate_record(NULL::clockgrove.%1$I, $1)',
             attempt.table_name
           ) USING attempt.fields;
           RAISE EXCEPTION 'migrator inserted a % row that % must refuse',
             attempt.table_name, attempt.constraint_name;
         EXCEPTION WHEN check_violation OR unique_violation OR foreign_key_violation THEN
           GET STACKED DIAGNOSTICS hit = CONSTRAINT_NAME;
           IF hit IS DISTINCT FROM attempt.constraint_name THEN
             RAISE EXCEPTION '% row was refused by %, expected %',
               attempt.table_name, hit, attempt.constraint_name;
           END IF;
         END;
       END LOOP;
     END
     $verify$;`,
  );
}

// The world birth table families: forced RLS with a tenant column, immutability grants, and no rows
// from migrations alone. The upgraded representative database may already hold fixture worlds.
async function verifyBirthSchema(tools, environment, worldsEmpty) {
  const names = birthTables.map((table) => `'${table}'`).join(", ");
  const structure = await psqlQuery(
    tools,
    environment,
    `SELECT
       (SELECT count(*) = ${birthTables.length}
          FROM pg_class AS relation
          JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = 'clockgrove_birth'
           AND relation.relkind = 'r'
           AND relation.relname = ANY (ARRAY[${names}])
           AND relation.relrowsecurity
           AND relation.relforcerowsecurity
           AND EXISTS (
             SELECT 1 FROM pg_attribute AS attribute
              WHERE attribute.attrelid = relation.oid
                AND attribute.attname = 'tenant_id'
                AND NOT attribute.attisdropped)),
       (SELECT count(*) = ${birthTables.length}
          FROM pg_class AS relation
          JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = 'clockgrove_birth' AND relation.relkind = 'r'),
       NOT has_table_privilege('clockgrove_runtime', 'clockgrove_birth.pack_artifacts', 'UPDATE,DELETE'),
       NOT has_table_privilege('clockgrove_runtime', 'clockgrove_birth.pack_installations', 'UPDATE,DELETE'),
       NOT has_table_privilege('clockgrove_runtime', 'clockgrove_birth.provisioning_cases', 'DELETE'),
       NOT has_table_privilege('clockgrove_world_reader', 'clockgrove_birth.world_birth_states', 'SELECT')`,
  );
  if (structure.trim() !== "t|t|t|t|t|t") {
    throw new Error(`world birth schema verification failed: ${structure.trim()}`);
  }
  const counts = await psqlQuery(
    tools,
    environment,
    `SELECT ${birthTables.map((table) => `(SELECT count(*) FROM clockgrove_birth.${table})`).join(" + ")}`,
  );
  if (counts.trim() !== "0")
    throw new Error("migrations alone must leave the world birth tables empty");
  if (worldsEmpty) {
    const worlds = await psqlQuery(tools, environment, "SELECT count(*) FROM clockgrove.worlds");
    if (worlds.trim() !== "0")
      throw new Error("migrations alone must leave clockgrove.worlds empty");
  }
}
