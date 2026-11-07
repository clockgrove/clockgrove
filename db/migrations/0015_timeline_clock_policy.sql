-- Control policy is independent of the immutable physical document and kernel revision.
-- NULL is an absent projection: readers reconstruct the latest clock event, or derive a paused
-- version zero from the installed birth policy when no clock event exists. Each control persists
-- its complete policy in the journal transaction.
ALTER TABLE clockgrove.partition_states ADD COLUMN clock_policy jsonb;
ALTER TABLE clockgrove.partition_states ADD CONSTRAINT partition_states_clock_policy_node
  CHECK (clock_policy IS NULL OR jsonb_typeof(clock_policy) = 'array');

-- This capability is only executable by the trusted runtime login. It does not create World
-- participation or user grants; it recovers a tenant principal solely for an exact ready owner scope.
CREATE FUNCTION clockgrove.resolve_ready_clock_principal(
  p_tenant text, p_world text, p_timeline text, p_space text
)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, clockgrove
AS $$
  SELECT membership.principal_id
    FROM clockgrove.tenant_principals AS membership
   WHERE membership.tenant_id = p_tenant
     AND EXISTS (
       SELECT 1 FROM clockgrove.worlds AS world
       JOIN clockgrove.timelines AS timeline USING (tenant_id, world_id)
       JOIN clockgrove.timeline_partitions AS partition USING (tenant_id, world_id, timeline_id)
       JOIN clockgrove_birth.pack_installations AS installation USING (tenant_id, world_id)
       WHERE world.tenant_id = p_tenant AND world.world_id = p_world
         AND timeline.timeline_id = p_timeline AND partition.space_id = p_space
         AND world.lifecycle_status = 'ready' AND timeline.state = 'active'
     )
   ORDER BY membership.principal_id COLLATE "C" LIMIT 1
$$;
REVOKE ALL ON FUNCTION clockgrove.resolve_ready_clock_principal(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clockgrove.resolve_ready_clock_principal(text, text, text, text) TO clockgrove_runtime;
