-- #22 (Wave 4 §15.2 S10): the observer world readiness read. A browser learns whether a world it
-- may observe is ready, still provisioning, or failed provisioning. Membership rows are visible
-- only when every scope setting is pinned, so the read goes through this migrator-owned SECURITY
-- DEFINER function instead of widening that policy. It is keyed only on the installed
-- app.principal_id and answers NULL unless that principal holds an unrevoked, committed (committed_at
-- not after now) runtime:world-observe membership for exactly the four scope ids. Only the world
-- reader may execute it. Additive: no table grant or policy changes.

CREATE FUNCTION clockgrove.observable_world_readiness(
  tenant_id text, world_id text, timeline_id text, space_id text
)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, clockgrove
AS $$
  SELECT CASE
      WHEN world.lifecycle_status = 'ready' THEN 'ready'
      WHEN world.lifecycle_status = 'archived' THEN NULL
      WHEN (SELECT provisioning.status
              FROM clockgrove_birth.provisioning_cases AS provisioning
             WHERE provisioning.tenant_id = world.tenant_id AND provisioning.world_id = world.world_id
             ORDER BY provisioning.updated_at DESC, provisioning.case_id DESC
             LIMIT 1) = 'failed' THEN 'failed'
      ELSE 'provisioning'
    END
    FROM clockgrove.world_memberships AS membership
    JOIN clockgrove.worlds AS world
      ON world.tenant_id = membership.tenant_id AND world.world_id = membership.world_id
   WHERE membership.principal_id = current_setting('app.principal_id', true)
     AND membership.tenant_id = observable_world_readiness.tenant_id
     AND membership.world_id = observable_world_readiness.world_id
     AND membership.timeline_id = observable_world_readiness.timeline_id
     AND membership.space_id = observable_world_readiness.space_id
     AND membership.revoked_at IS NULL
     AND membership.committed_at <= statement_timestamp()
     AND 'runtime:world-observe' = ANY (membership.grants)
   LIMIT 1;
$$;

REVOKE ALL ON FUNCTION clockgrove.observable_world_readiness(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clockgrove.observable_world_readiness(text, text, text, text)
  TO clockgrove_world_reader;
