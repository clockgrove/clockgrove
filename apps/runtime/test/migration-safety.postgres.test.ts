import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BackfillVerificationError,
  runBackfill,
  // @ts-expect-error -- repository-local JavaScript helper has no declaration file.
} from "../../../scripts/database/backfill.mjs";
import {
  applyMigrations,
  withDisposableDatabase,
  // @ts-expect-error -- repository-local JavaScript helper has no declaration file.
} from "../../../scripts/database/lib.mjs";
import { type DatabaseFixture, truthOf } from "./world-fixture.js";

// RW-0209, plan §14 "during migration backfill and process restart": a data backfill resumes
// from its checkpoint and counts only once verified, and the migration path refuses a contract step
// (DELETE, TRUNCATE, DROP) that nobody declared, however the migration runs it.

/** 25 rows in batches of 10: two full batches and a short one that completes the backfill. */
const ROWS = 25;

/** A migrated database with `tables`, each of ROWS rows whose `digest` the backfill fills. */
async function seeded(fixture: DatabaseFixture, ...tables: string[]) {
  await applyMigrations(fixture.tools, fixture.environment);
  const sql = truthOf(fixture);
  for (const table of tables)
    await sql(`SET ROLE clockgrove_migrator;
      CREATE TABLE clockgrove.${table} (id text PRIMARY KEY, payload text NOT NULL, digest text);
      INSERT INTO clockgrove.${table}
        SELECT format('row-%s', lpad(n::text, 2, '0')), format('payload-%s', n), NULL
          FROM generate_series(1, ${ROWS}) AS n`);
  return sql;
}

/** Fills `digest` with the payload's `hash`; `verify` accepts only SHA-256. */
const digests = (table: string, hash = "sha256") => ({
  migration: "9001_payload_digests",
  key: table,
  batchSize: 10,
  step: (cursor: string, limit: number) => `UPDATE clockgrove.${table} AS t
      SET digest = encode(${hash}(convert_to(t.payload, 'UTF8')), 'hex')
    WHERE t.id IN (SELECT id FROM clockgrove.${table}
                    WHERE ${cursor} IS NULL OR id > ${cursor} ORDER BY id LIMIT ${limit})
    RETURNING t.id AS key`,
  verify: `NOT EXISTS (SELECT 1 FROM clockgrove.${table}
    WHERE digest IS DISTINCT FROM encode(sha256(convert_to(payload, 'UTF8')), 'hex'))`,
});

/** Every row as `id:digest`, the first `filled` rows with their SHA-256 hex computed here. */
const expectedRows = (filled: number) =>
  Array.from({ length: ROWS }, (_, index) => {
    const digest = createHash("sha256")
      .update(`payload-${index + 1}`)
      .digest("hex");
    return `row-${String(index + 1).padStart(2, "0")}:${index < filled ? digest : "-"}`;
  }).join(",");

const rowsOf = (sql: (query: string) => Promise<string>, table: string) =>
  sql(
    `SELECT string_agg(id || ':' || coalesce(digest, '-'), ',' ORDER BY id) FROM clockgrove.${table}`,
  );

const checkpointOf = async (sql: (query: string) => Promise<string>, key: string) => {
  const [value, verified] = (
    await sql(`SELECT checkpoint_value::text || '|' || (verified_at IS NOT NULL)
      FROM clockgrove.migration_backfill_checkpoints WHERE checkpoint_key = '${key}'`)
  ).split("|");
  return { value: JSON.parse(value!), verified: verified === "true" };
};

const complete = { cursor: "row-25", rows: 25, batches: 3, complete: true };

describe("migration backfills and contract steps", () => {
  it("resumes a backfill killed between batches and ends as an uninterrupted run", async () => {
    await withDisposableDatabase(async (fixture: DatabaseFixture) => {
      const sql = await seeded(fixture, "killed", "uninterrupted");
      const kill = () => {
        throw new Error("killed between batches");
      };
      await expect(
        runBackfill(fixture.tools, fixture.environment, digests("killed"), { afterBatch: kill }),
      ).rejects.toThrow("killed between batches");
      expect(await checkpointOf(sql, "killed")).toEqual({
        value: { cursor: "row-10", rows: 10, batches: 1, complete: false },
        verified: false,
      });
      expect(await rowsOf(sql, "killed")).toBe(expectedRows(10));
      // A new run reads only the checkpoint: it runs the two remaining batches.
      const resumed: unknown[] = [];
      const afterBatch = (checkpoint: unknown) => resumed.push(checkpoint);
      await runBackfill(fixture.tools, fixture.environment, digests("killed"), { afterBatch });
      expect(resumed).toEqual([
        { cursor: "row-20", rows: 20, batches: 2, complete: false },
        complete,
      ]);
      await runBackfill(fixture.tools, fixture.environment, digests("uninterrupted"));
      for (const table of ["killed", "uninterrupted"]) {
        expect(await rowsOf(sql, table)).toBe(expectedRows(ROWS));
        expect(await checkpointOf(sql, table)).toEqual({ value: complete, verified: true });
      }
    });
  }, 120_000);

  it("re-runs a completed, verified backfill as a no-op", async () => {
    await withDisposableDatabase(async (fixture: DatabaseFixture) => {
      const sql = await seeded(fixture, "verified");
      expect(await runBackfill(fixture.tools, fixture.environment, digests("verified"))).toEqual(
        complete,
      );
      const stored = `SELECT checkpoint_value::text || verified_at::text
        FROM clockgrove.migration_backfill_checkpoints WHERE checkpoint_key = 'verified'`;
      const before = await sql(stored);
      const batches: unknown[] = [];
      const afterBatch = (checkpoint: unknown) => batches.push(checkpoint);
      expect(
        await runBackfill(fixture.tools, fixture.environment, digests("verified"), { afterBatch }),
      ).toEqual(complete);
      expect(batches).toEqual([]);
      expect(await sql(stored)).toBe(before);
      expect(await rowsOf(sql, "verified")).toBe(expectedRows(ROWS));
    });
  }, 120_000);

  it("stops a backfill whose verification fails with BackfillVerificationError", async () => {
    await withDisposableDatabase(async (fixture: DatabaseFixture) => {
      const sql = await seeded(fixture, "wrong");
      await expect(
        runBackfill(fixture.tools, fixture.environment, digests("wrong", "sha224")),
      ).rejects.toThrow(new BackfillVerificationError("9001_payload_digests", "wrong"));
      expect(await checkpointOf(sql, "wrong")).toEqual({ value: complete, verified: false });
    });
  }, 120_000);

  it("refuses undeclared DELETE, TRUNCATE and DROP migrations in every form and applies declared ones", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clockgrove-contract-"));
    const purge = "clockgrove.purge_probe(): DELETE FROM clockgrove.probe WHERE id = 5";
    const migrations: Record<string, string> = {
      "0001_expand.sql": `CREATE TABLE clockgrove.probe (id integer);
        INSERT INTO clockgrove.probe SELECT generate_series(1, 5);`,
      "0002_delete.sql": "DELETE FROM clockgrove.probe WHERE id = 1;",
      "0003_with_delete.sql":
        "WITH gone AS (SELECT 2 AS id) DELETE FROM clockgrove.probe WHERE id IN (SELECT id FROM gone);",
      "0004_do_language.sql":
        "DO LANGUAGE plpgsql $$ BEGIN DELETE FROM clockgrove.probe WHERE id = 3; END $$;",
      "0005_execute.sql":
        "DO $$ BEGIN EXECUTE format($q$DELETE FROM clockgrove.%I WHERE id = 4$q$, 'probe'); END $$;",
      "0006_function.sql": `CREATE FUNCTION clockgrove.purge_probe() RETURNS void LANGUAGE sql
        AS $$ DELETE FROM clockgrove.probe WHERE id = 5 $$; SELECT clockgrove.purge_probe();`,
      // A routine an earlier migration created, called again.
      "0007_call.sql": "SELECT clockgrove.purge_probe();",
      "0008_truncate.sql": "TRUNCATE clockgrove.probe;",
      "0009_drop.sql": "DROP TABLE clockgrove.probe;",
    };
    const destroys: Record<string, string> = {
      "0002_delete.sql": "DELETE FROM clockgrove.probe WHERE id = 1",
      "0003_with_delete.sql":
        "WITH gone AS (SELECT 2 AS id) DELETE FROM clockgrove.probe WHERE id IN (SELECT id FROM gone)",
      "0004_do_language.sql": "DELETE FROM clockgrove.probe WHERE id = 3",
      "0005_execute.sql": "DELETE FROM clockgrove.%I WHERE id = 4",
      "0006_function.sql": purge,
      "0007_call.sql": purge,
      "0008_truncate.sql": "TRUNCATE clockgrove.probe",
      "0009_drop.sql": "DROP TABLE clockgrove.probe",
    };
    for (const [name, sql] of Object.entries(migrations))
      await writeFile(join(directory, name), sql);
    await withDisposableDatabase(async (fixture: DatabaseFixture) => {
      const sql = truthOf(fixture);
      const apply = () =>
        applyMigrations(fixture.tools, fixture.environment, { migrationDirectory: directory });
      await expect(apply()).rejects.toThrow(
        [
          "contract-step check failed:",
          ...Object.entries(destroys).map(
            ([name, statement]) => `${name} is an undeclared contract step: ${statement}`,
          ),
        ].join("\n"),
      );
      // Refused before the first migration: not even the migration table exists.
      expect(await sql("SELECT to_regclass('clockgrove.schema_migrations') IS NULL")).toBe("t");
      const declared = Object.fromEntries(
        Object.entries(destroys).map(([name, statement]) => [
          name,
          {
            sha256: createHash("sha256").update(migrations[name]!).digest("hex"),
            destroys: [statement],
            restorePoint: "a verified restore point of the disposable cluster",
            releaseApproval: "#832",
          },
        ]),
      );
      await writeFile(join(directory, "contract-steps.json"), JSON.stringify(declared));
      await apply();
      expect(
        await sql(`SELECT string_agg(migration_name, ',' ORDER BY migration_name)
          || '|' || (to_regclass('clockgrove.probe') IS NULL) FROM clockgrove.schema_migrations`),
      ).toBe(`${Object.keys(migrations).join(",")}|true`);
    }).finally(() => rm(directory, { recursive: true, force: true }));
  }, 120_000);
});
