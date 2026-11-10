import { runBackfill } from "./backfill.mjs";

// JSON encodes the complete partition key without delimiter collisions. C ordering keeps the
// cursor, batch ordering and runBackfill's max(key) consistent regardless of database locale.
const partitionKey = `jsonb_build_array(tenant_id, timeline_id, partition_id)::text COLLATE "C"`;

export const worldProcessDeadlineBackfill = {
  migration: "0048_world_process_deadlines.sql",
  key: "partition-process-deadlines",
  // Operational choice: at most 100 partition document rows are locked in each transaction.
  batchSize: 100,
  step: (cursor, limit) => `UPDATE clockgrove.partition_states AS state
    SET next_process_due_at = clockgrove.world_process_deadline(state.document)
    FROM (SELECT tenant_id, timeline_id, partition_id, ${partitionKey} AS key
      FROM clockgrove.partition_states
      WHERE ${cursor} IS NULL OR ${partitionKey} > ${cursor} COLLATE "C"
      ORDER BY key LIMIT ${limit}) AS batch
    WHERE (state.tenant_id, state.timeline_id, state.partition_id) =
      (batch.tenant_id, batch.timeline_id, batch.partition_id)
    RETURNING batch.key`,
  verify: `NOT EXISTS (SELECT 1 FROM clockgrove.partition_states
    WHERE next_process_due_at IS DISTINCT FROM clockgrove.world_process_deadline(document))`,
};

export function backfillWorldProcessDeadlines(tools, environment, options) {
  return runBackfill(tools, environment, worldProcessDeadlineBackfill, options);
}
