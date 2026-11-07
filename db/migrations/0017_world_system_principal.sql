-- Autonomous clock work is attributed to its world's system principal, never to a tenant member.
-- Each world owns exactly one: `system:world:<world_id>` in its tenant, created with the world row
-- and backfilled here for existing worlds. It has no identity link or World membership, so no
-- browser session can act as it; the reserved `system:` prefix keeps member IDs out of that space.
ALTER TABLE clockgrove.tenant_principals ADD COLUMN system_world_id text;
ALTER TABLE clockgrove.tenant_principals ADD CONSTRAINT tenant_principals_system_identity CHECK (
  CASE WHEN system_world_id IS NULL THEN left(principal_id, 7) <> 'system:'
       ELSE principal_id = 'system:world:' || system_world_id END
);
CREATE UNIQUE INDEX tenant_principals_system_world_idx
  ON clockgrove.tenant_principals (tenant_id, system_world_id)
  WHERE system_world_id IS NOT NULL;
ALTER TABLE clockgrove_management.principals ADD CONSTRAINT principals_not_system
  CHECK (left(principal_id, 7) <> 'system:');

-- Fixed at world birth. The definer bypasses the member-only RLS row check, which would otherwise
-- refuse the requesting member inserting a principal other than itself.
CREATE FUNCTION clockgrove.install_world_system_principal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, clockgrove
AS $$
BEGIN
  INSERT INTO clockgrove.tenant_principals (tenant_id, principal_id, system_world_id)
  VALUES (NEW.tenant_id, 'system:world:' || NEW.world_id, NEW.world_id)
  ON CONFLICT (tenant_id, principal_id) DO NOTHING;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION clockgrove.install_world_system_principal() FROM PUBLIC;
CREATE TRIGGER worlds_system_principal
  AFTER INSERT ON clockgrove.worlds
  FOR EACH ROW EXECUTE FUNCTION clockgrove.install_world_system_principal();

INSERT INTO clockgrove.tenant_principals (tenant_id, principal_id, system_world_id)
SELECT tenant_id, 'system:world:' || world_id, world_id FROM clockgrove.worlds
ON CONFLICT (tenant_id, principal_id) DO NOTHING;

-- Same signature, grants and exact ready-scope gate as 0015; only the attributed principal changes.
CREATE OR REPLACE FUNCTION clockgrove.resolve_ready_clock_principal(
  p_tenant text, p_world text, p_timeline text, p_space text
)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, clockgrove
AS $$
  SELECT principal.principal_id
    FROM clockgrove.tenant_principals AS principal
   WHERE principal.tenant_id = p_tenant AND principal.system_world_id = p_world
     AND EXISTS (
       SELECT 1 FROM clockgrove.worlds AS world
       JOIN clockgrove.timelines AS timeline USING (tenant_id, world_id)
       JOIN clockgrove.timeline_partitions AS partition USING (tenant_id, world_id, timeline_id)
       JOIN clockgrove_birth.pack_installations AS installation USING (tenant_id, world_id)
       WHERE world.tenant_id = p_tenant AND world.world_id = p_world
         AND timeline.timeline_id = p_timeline AND partition.space_id = p_space
         AND world.lifecycle_status = 'ready' AND timeline.state = 'active'
     )
$$;
