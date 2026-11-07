-- #699 hot path: admission and every physical command read the latest ClockPolicyChanged event of
-- the partition under the lock. This partial index serves that query's exact predicate and order
-- (scope, event_type = 'ClockPolicyChanged', partition_sequence DESC LIMIT 1) as a one-row index
-- seek, instead of a backward walk over every non-clock event since the last policy change. It holds
-- one entry per policy change, so it grows with clock commands only.
CREATE INDEX events_clock_policy_idx
  ON clockgrove.events (tenant_id, timeline_id, partition_id, partition_sequence)
  WHERE event_type = 'ClockPolicyChanged';
