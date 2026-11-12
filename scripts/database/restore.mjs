import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import { digest } from "../ci/evidence.mjs";
import { psql, psqlQuery, run, verifyPgvectorVersion } from "./lib.mjs";

export async function canonicalSnapshot(tools, environment) {
  const tables = (
    await psqlQuery(
      tools,
      environment,
      "SELECT tablename FROM pg_tables WHERE schemaname = 'clockgrove' ORDER BY tablename",
    )
  )
    .trim()
    .split("\n");
  const rows = [];
  for (const table of tables) {
    assert(/^[a-z_]+$/u.test(table), "unexpected canonical table");
    rows.push([
      table,
      (
        await psqlQuery(
          tools,
          environment,
          `SELECT COALESCE(jsonb_agg(row_data ORDER BY row_data::text), '[]'::jsonb) FROM (SELECT to_jsonb(t) AS row_data FROM clockgrove.${table} AS t) AS rows`,
        )
      ).trim(),
    ]);
  }
  return JSON.stringify(rows);
}

// Native recovery compares authentication and Management authority as well as world history.
// Keep the delivered portable/restore receipt's comparison format unchanged.
export async function completeAuthoritySnapshot(tools, environment) {
  const schemas = ["clockgrove", "clockgrove_auth", "clockgrove_management"];
  const rows = [];
  for (const schema of schemas) {
    const tables = (
      await psqlQuery(
        tools,
        environment,
        `SELECT tablename FROM pg_tables WHERE schemaname = '${schema}' ORDER BY tablename`,
      )
    )
      .trim()
      .split("\n");
    assert(tables.length && tables[0], "authority schema missing");
    for (const table of tables) {
      const quotedTable = `"${table.replaceAll('"', '""')}"`;
      rows.push([
        `${schema}.${table}`,
        (
          await psqlQuery(
            tools,
            environment,
            `SELECT COALESCE(jsonb_agg(row_data ORDER BY row_data::text), '[]'::jsonb) FROM (SELECT to_jsonb(t) AS row_data FROM ${schema}.${quotedTable} AS t) AS rows`,
          )
        ).trim(),
      ]);
    }
  }
  return JSON.stringify(rows);
}

// Schema ownership, forced tenant RLS and extension index policy as "t|t|t". Every clockgrove table
// with a tenant_id column must have row-level security enabled and forced; no table count is assumed.
export async function restoredSchemaPolicy(tools, environment) {
  return (
    await psqlQuery(
      tools,
      environment,
      `SELECT
      (SELECT nspowner = 'clockgrove_migrator'::regrole FROM pg_namespace WHERE nspname = 'clockgrove'),
      (SELECT count(*) > 0 AND bool_and(c.relrowsecurity AND c.relforcerowsecurity)
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'clockgrove' AND c.relkind IN ('r', 'p')
          AND EXISTS (SELECT 1 FROM pg_attribute a
                       WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)),
      NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexdef ILIKE '%USING hnsw%')`,
    )
  ).trim();
}

export async function withRestoredHistory(fixture, operation) {
  const { tools, environment, temporaryRoot } = fixture;
  // This connection exists only inside the helper's freshly initialized, owned cluster.
  const destination = { ...environment, PGDATABASE: "clockgrove_owned_restore" };
  const admin = { ...environment, PGDATABASE: "postgres" };
  const dump = path.join(temporaryRoot, "private-history.dump");
  let created = false;
  try {
    const roles = (
      await psqlQuery(
        tools,
        admin,
        `SELECT
      (SELECT rolsuper FROM pg_roles WHERE rolname = 'clockgrove_admin'),
      (SELECT NOT rolsuper AND rolbypassrls AND NOT rolcanlogin FROM pg_roles WHERE rolname = 'clockgrove_migrator'),
      (SELECT NOT rolsuper AND NOT rolbypassrls AND NOT rolinherit FROM pg_roles WHERE rolname = 'clockgrove_runtime'),
      NOT pg_has_role('clockgrove_runtime', 'clockgrove_migrator', 'MEMBER')`,
      )
    ).trim();
    assert.equal(roles, "t|t|t|t", "destination cluster-global accepted roles missing");
    const before = await canonicalSnapshot(tools, environment);
    await run(tools.pg_dump, ["--format=custom", "--file", dump], { environment });
    await psql(
      tools,
      admin,
      "CREATE DATABASE clockgrove_owned_restore OWNER clockgrove_migrator TEMPLATE template0 ENCODING 'UTF8';",
    );
    created = true;
    await run(tools.pg_restore, ["--exit-on-error", "--dbname", destination.PGDATABASE, dump], {
      environment: destination,
    });
    await verifyPgvectorVersion(tools, destination);
    assert.equal(
      await canonicalSnapshot(tools, destination),
      before,
      "restored canonical rows/bytes/hashes/receipts/heads/dispatches changed",
    );
    const policy = await restoredSchemaPolicy(tools, destination);
    assert.equal(policy, "t|t|t", "restore ownership/RLS/extension policy changed");
    assert.equal(
      (
        await psqlQuery(
          tools,
          { ...destination, PGUSER: "clockgrove_runtime" },
          "SELECT count(*) FROM clockgrove.events",
        )
      ).trim(),
      "0",
      "restored runtime leaked unscoped history",
    );
    await operation(destination, {
      canonicalDigest: digest(before),
      comparison: "exact-all-canonical-rows",
      roles,
      policy,
    });
    assert.equal(
      await canonicalSnapshot(tools, environment),
      before,
      "restore altered source history",
    );
  } finally {
    try {
      if (created) await psql(tools, admin, "DROP DATABASE clockgrove_owned_restore;");
    } finally {
      await rm(dump, { force: true });
    }
  }
}
