-- Readiness gating for world-scoped authority reads. The world reader cannot read clockgrove.worlds, so
-- the policy asks a migrator-owned SECURITY DEFINER predicate instead of gaining a table privilege.
-- Additive: no table grant changes; the reader keeps exactly SELECT on clockgrove.world_memberships.

CREATE FUNCTION clockgrove.world_is_ready(row_tenant_id text, row_world_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, clockgrove
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM clockgrove.worlds AS world
    WHERE world.tenant_id = row_tenant_id
      AND world.world_id = row_world_id
      AND world.lifecycle_status = 'ready'
  );
$$;

REVOKE ALL ON FUNCTION clockgrove.world_is_ready(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clockgrove.world_is_ready(text, text) TO clockgrove_world_reader;

ALTER POLICY scoped_authority_read ON clockgrove.world_memberships
  USING (
    revoked_at IS NULL AND tenant_id = current_setting('app.tenant_id', true)
    AND principal_id = current_setting('app.principal_id', true)
    AND world_id = current_setting('app.world_id', true)
    AND timeline_id = current_setting('app.timeline_id', true)
    AND space_id = current_setting('app.space_id', true)
    AND clockgrove.world_is_ready(tenant_id, world_id)
  );
