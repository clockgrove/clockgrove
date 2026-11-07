import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { applyMigrations, psql, psqlQuery, repositoryRoot } from "./lib.mjs";

// Prior-release database fixtures (issue 694, db/fixtures/README.md): each db/fixtures/prior/<tag> is
// restored into a disposable cluster as its release wrote it, then migrated to head.

const fixturesDirectory = path.join(repositoryRoot, "db/fixtures/prior");

/** Every event's stored bytes, in journal order, as one SHA-256 hex digest (as captured). */
export const EVENT_BYTES_DIGEST = `SELECT encode(sha256(coalesce(string_agg(sha256(event_bytes), ''::bytea
  ORDER BY journal_position), ''::bytea)), 'hex') FROM clockgrove.events`;

/** The tags with a committed prior-release fixture. */
export async function priorReleaseFixtures() {
  return (await readdir(fixturesDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * Replaces the cluster's `clockgrove` database with the fixture of `tag`, refuses a dump that is not
 * the one its manifest recorded, and migrates it to head (or `migrationDirectory`). Returns the
 * manifest, the tables in which any pre-existing row changed or vanished (pre-existing columns only,
 * so a migration may add columns and rows), and the event bytes digest after the migration.
 */
export async function migratePriorRelease({ tools, environment }, tag, options = {}) {
  const directory = path.join(fixturesDirectory, tag);
  const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
  await psql(
    tools,
    { ...environment, PGDATABASE: "postgres" },
    `DROP DATABASE clockgrove;
     CREATE DATABASE clockgrove OWNER clockgrove_migrator TEMPLATE template0 ENCODING 'UTF8';`,
  );
  await psql(tools, environment, await readFile(path.join(directory, "database.sql"), "utf8"), [
    "--single-transaction",
    "--quiet",
    "--output=/dev/null",
  ]);
  const digest = async () => (await psqlQuery(tools, environment, EVENT_BYTES_DIGEST)).trim();
  if ((await digest()) !== manifest.eventBytesDigest)
    throw new Error(`the ${tag} dump is not the one its manifest recorded`);
  const tables = await tableColumns(tools, environment);
  const before = await rowHashes(tools, environment, tables);
  await applyMigrations(tools, environment, options);
  const after = await rowHashes(tools, environment, tables);
  const changed = [...before]
    .filter(([table, rows]) => {
      const kept = new Set(after.get(table));
      return rows.some((row) => !kept.has(row));
    })
    .map(([table]) => table);
  return { manifest, changed, eventBytesDigest: await digest() };
}

/** Each table of the clockgrove schemas, with its columns as a select list. */
async function tableColumns(tools, environment) {
  const listed = await psqlQuery(
    tools,
    environment,
    `SELECT format('%I.%I', n.nspname, c.relname) || '|' ||
            string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum)
       FROM pg_class AS c
       JOIN pg_namespace AS n ON n.oid = c.relnamespace
       JOIN pg_attribute AS a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE c.relkind IN ('r', 'p') AND n.nspname LIKE 'clockgrove%'
      GROUP BY n.nspname, c.relname ORDER BY 1`,
  );
  return listed
    .trim()
    .split("\n")
    .map((line) => line.split("|"));
}

/** Per table, the hash of every row over the given columns, read as the superuser (no RLS). */
async function rowHashes(tools, environment, tables) {
  const hashes = new Map();
  for (const [table, columns] of tables) {
    const rows = await psqlQuery(
      tools,
      environment,
      `SELECT md5(ROW(${columns})::text) FROM ${table}`,
    );
    hashes.set(table, rows.trim().split("\n").filter(Boolean));
  }
  return hashes;
}
