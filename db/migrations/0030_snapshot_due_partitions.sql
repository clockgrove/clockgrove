-- #843: the scheduled snapshot sweep finds the partitions due for a snapshot with no tenant member
-- at hand, and takes them in turns. A partition of a ready world with no open continuation is due when
-- it has no usable snapshot (none, as after 0029, or none written under the current compatibility set
-- with its world's pack hash) or its committed head is at least p_interval partition events past its
-- latest usable one. Its head must also be past every snapshot it has, because a snapshot's ID and
-- index slot derive from its head; so a snapshot the previous runtime wrote under another registry or
-- pack holds the partition back only until its head moves.
-- Least recently attempted first, then most behind. Each pick stamps snapshot_attempted_at before any
-- work starts, so a partition that keeps failing, or whose run is cut off, goes behind the others
-- instead of taking every slot on every run. The function returns identities only: the world's system
-- principal (0017), under which RLS governs every read and write the sweep then makes.
-- One stamp per partition, updated in place: an operational column like
-- catch_up_reconcile_attempted_at (0026), never canonical state.
ALTER TABLE clockgrove.partition_states ADD COLUMN snapshot_attempted_at timestamptz;

CREATE FUNCTION clockgrove.snapshot_due_partitions(
  p_compatibility jsonb, p_interval bigint, p_limit integer
)
RETURNS TABLE (
  tenant_id text, world_id text, timeline_id text, partition_id text, principal_id text
)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, clockgrove AS $$
  WITH due AS (
    SELECT state.tenant_id, state.world_id, state.timeline_id, state.partition_id,
           principal.principal_id, state.snapshot_attempted_at AS attempted,
           state.covered_head_sequence - coalesce(latest.usable, 0) AS behind
      FROM clockgrove.partition_states AS state
      JOIN clockgrove.worlds AS world
        ON world.tenant_id = state.tenant_id AND world.world_id = state.world_id
      JOIN clockgrove.tenant_principals AS principal
        ON principal.tenant_id = state.tenant_id AND principal.system_world_id = state.world_id
      JOIN clockgrove_birth.pack_installations AS installation
        ON installation.tenant_id = state.tenant_id AND installation.world_id = state.world_id
      -- snapshots_partition_head (0013) serves the partition's snapshots.
      LEFT JOIN LATERAL (
        SELECT max(snapshot.covered_partition_sequence) AS covered,
               max(snapshot.covered_partition_sequence) FILTER (
                 WHERE snapshot.compatibility = p_compatibility
                   || jsonb_build_object('packContentHash', installation.content_hash)
               ) AS usable
          FROM clockgrove.snapshots AS snapshot
         WHERE snapshot.tenant_id = state.tenant_id AND snapshot.timeline_id = state.timeline_id
           AND snapshot.partition_id = state.partition_id
      ) AS latest ON true
     WHERE world.lifecycle_status = 'ready' AND state.continuation IS NULL
       AND state.covered_head_sequence > coalesce(latest.covered, -1)
       AND (latest.usable IS NULL
            OR state.covered_head_sequence - latest.usable >= greatest(p_interval, 1))
     ORDER BY state.snapshot_attempted_at NULLS FIRST,
              state.covered_head_sequence - coalesce(latest.usable, 0) DESC,
              state.tenant_id, state.timeline_id, state.partition_id
     LIMIT greatest(p_limit, 0)
       FOR UPDATE OF state SKIP LOCKED
  ), stamped AS (
    UPDATE clockgrove.partition_states AS state
       SET snapshot_attempted_at = statement_timestamp()
      FROM due
     WHERE state.tenant_id = due.tenant_id AND state.timeline_id = due.timeline_id
       AND state.partition_id = due.partition_id
    RETURNING due.*
  )
  SELECT stamped.tenant_id, stamped.world_id, stamped.timeline_id, stamped.partition_id,
         stamped.principal_id
    FROM stamped
   ORDER BY stamped.attempted NULLS FIRST, stamped.behind DESC,
            stamped.tenant_id, stamped.timeline_id, stamped.partition_id
$$;
REVOKE ALL ON FUNCTION clockgrove.snapshot_due_partitions(jsonb, bigint, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clockgrove.snapshot_due_partitions(jsonb, bigint, integer)
  TO clockgrove_runtime;
