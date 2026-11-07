-- #808 (Wave 4): the observer world directory. An authenticated principal lists the scopes it may
-- observe without naming one. scoped_authority_read exposes a membership row only when every scope
-- setting is pinned, so the directory reads through this migrator-owned SECURITY DEFINER function
-- instead of widening that policy. The function is keyed only on the installed app.principal_id and
-- returns only the scope columns of that principal's committed (committed_at not after now),
-- unrevoked memberships that hold runtime:world-observe in a ready world. Only the world reader may
-- execute it. Additive: no table grant or policy changes.

CREATE FUNCTION clockgrove.observable_world_scopes()
RETURNS TABLE (tenant_id text, world_id text, timeline_id text, space_id text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, clockgrove
AS $$
  SELECT membership.tenant_id, membership.world_id, membership.timeline_id, membership.space_id
    FROM clockgrove.world_memberships AS membership
    JOIN clockgrove.worlds AS world
      ON world.tenant_id = membership.tenant_id AND world.world_id = membership.world_id
   WHERE membership.principal_id = current_setting('app.principal_id', true)
     AND membership.revoked_at IS NULL
     AND membership.committed_at <= statement_timestamp()
     AND 'runtime:world-observe' = ANY (membership.grants)
     AND world.lifecycle_status = 'ready';
$$;

REVOKE ALL ON FUNCTION clockgrove.observable_world_scopes() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clockgrove.observable_world_scopes() TO clockgrove_world_reader;

-- The directory's one read per call is indexed on its only key.
CREATE INDEX world_memberships_principal ON clockgrove.world_memberships (principal_id);
