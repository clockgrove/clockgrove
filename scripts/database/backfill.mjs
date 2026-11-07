import { psqlQuery } from "./lib.mjs";

// Resumable data backfills (docs/runbooks/database.md, "expand → backfill → verify → switch →
// contract"). A backfill runs as the migrator in bounded batches. Each batch and its checkpoint in
// `clockgrove.migration_backfill_checkpoints` commit in one transaction, so a run killed between or
// during batches resumes from the last committed checkpoint: no row is skipped or done twice. When
// a batch finds fewer rows than its bound, the backfill is complete; `verified_at` is set only when
// the definition's verification holds, in the same statement that checks it.

/** A complete backfill whose rows fail its verification; nothing is marked verified. */
export class BackfillVerificationError extends Error {
  constructor(migration, key) {
    super(`backfill ${migration}/${key} failed verification`);
    this.name = "BackfillVerificationError";
  }
}

/**
 * Runs `definition` to completion and verifies it, resuming from its checkpoint; a verified backfill
 * is not run again. The definition is
 * - `migration` and `key`: the checkpoint row (`migration_name`, `checkpoint_key`);
 * - `batchSize`: the most rows one batch transaction changes, chosen per backfill;
 * - `step(cursor, limit)`: one data-modifying statement for the next `limit` rows after `cursor`
 *   (an SQL text expression, NULL before the first batch) in its key order, returning each row's
 *   key as `key`; the largest returned key becomes the next cursor;
 * - `verify`: an SQL boolean expression that holds when every backfilled row is correct.
 * `afterBatch(checkpoint)` runs after each committed batch; a throw there stops the run between
 * batches, as a killed process would.
 */
export async function runBackfill(tools, environment, definition, { afterBatch } = {}) {
  const { migration, key, batchSize, step, verify } = definition;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1)
    throw new RangeError("a backfill batch size is a positive integer");
  const row = `migration_name = ${literal(migration)} AND checkpoint_key = ${literal(key)}`;
  const transaction = async (statement) => {
    const output = await psqlQuery(
      tools,
      environment,
      `SET ROLE clockgrove_migrator;
       SELECT pg_advisory_xact_lock(hashtextextended(${literal(`backfill:${migration}/${key}`)}, 0));
       ${statement}`,
    );
    // psql prints every statement's result; only the last statement returns JSON, when it has a row.
    const result = output.split("\n").findLast((line) => line.startsWith("{"));
    return result === undefined ? undefined : JSON.parse(result);
  };
  let checkpoint = await transaction(
    `SELECT jsonb_build_object('value', checkpoint_value, 'verified', verified_at IS NOT NULL)
       FROM clockgrove.migration_backfill_checkpoints WHERE ${row}`,
  );
  if (checkpoint?.verified) return checkpoint.value;
  let value = checkpoint?.value;
  while (value?.complete !== true) {
    value = await transaction(
      `WITH previous AS (
         SELECT checkpoint_value FROM clockgrove.migration_backfill_checkpoints WHERE ${row}
       ), step AS (
         ${step("(SELECT checkpoint_value->>'cursor' FROM previous)", batchSize)}
       ), progress AS (
         SELECT max(key) AS last, count(*) AS rows FROM step
       )
       INSERT INTO clockgrove.migration_backfill_checkpoints AS c
         (migration_name, checkpoint_key, checkpoint_value)
       SELECT ${literal(migration)}, ${literal(key)}, jsonb_build_object(
         'cursor', coalesce(to_jsonb(progress.last), (SELECT checkpoint_value->'cursor' FROM previous), 'null'),
         'rows', coalesce((SELECT (checkpoint_value->>'rows')::bigint FROM previous), 0) + progress.rows,
         'batches', coalesce((SELECT (checkpoint_value->>'batches')::bigint FROM previous), 0) + 1,
         'complete', progress.rows < ${batchSize})
         FROM progress
       ON CONFLICT (migration_name, checkpoint_key)
         DO UPDATE SET checkpoint_value = EXCLUDED.checkpoint_value
       RETURNING checkpoint_value::text`,
    );
    await afterBatch?.(value);
  }
  checkpoint = await transaction(
    `UPDATE clockgrove.migration_backfill_checkpoints
        SET verified_at = coalesce(verified_at, statement_timestamp())
      WHERE ${row} AND (verified_at IS NOT NULL OR (${verify}))
      RETURNING checkpoint_value::text`,
  );
  if (checkpoint === undefined) throw new BackfillVerificationError(migration, key);
  return checkpoint;
}

function literal(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}
