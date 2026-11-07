-- Partition snapshots (RW-0208, #677). A snapshot row indexes one artifact of its own partition and
-- class, covers one committed partition head, and is append-only for the runtime role. No producer
-- has written snapshots before this migration, so the new NOT NULL column needs no backfill; the
-- migration fails on a leftover row.

-- A snapshot may reference only an artifact of its own tenant, world, timeline, partition, space and
-- privacy class.
ALTER TABLE clockgrove.artifact_references
  ADD CONSTRAINT artifact_references_snapshot_target UNIQUE (
    tenant_id, artifact_id, world_id, timeline_id, partition_id, space_id, privacy_class
  );

-- covered_partition_sequence is the partition head the snapshot covers (partition_states
-- covered_head_sequence). covered_sequence stays the route stream's sequence at that head.
ALTER TABLE clockgrove.snapshots
  DROP CONSTRAINT snapshots_tenant_id_artifact_id_fkey,
  ADD COLUMN covered_partition_sequence bigint NOT NULL,
  -- With covered_sequence >= 0 (0001), this also keeps the partition head non-negative.
  ADD CONSTRAINT snapshots_stream_coverage
    CHECK (covered_sequence <= covered_partition_sequence),
  ADD CONSTRAINT snapshots_state_hash CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT snapshots_compatibility CHECK (jsonb_typeof(compatibility) = 'object'),
  ADD CONSTRAINT snapshots_artifact_target
    FOREIGN KEY (tenant_id, artifact_id, world_id, timeline_id, partition_id, space_id, privacy_class)
    REFERENCES clockgrove.artifact_references (
      tenant_id, artifact_id, world_id, timeline_id, partition_id, space_id, privacy_class
    );

-- One snapshot per covered head; serves "latest snapshot at or before a head".
CREATE UNIQUE INDEX snapshots_partition_head
  ON clockgrove.snapshots (tenant_id, timeline_id, partition_id, covered_partition_sequence);

-- Snapshot rows are append-only for the runtime role, like artifacts and events.
REVOKE UPDATE, DELETE ON clockgrove.snapshots FROM clockgrove_runtime;
