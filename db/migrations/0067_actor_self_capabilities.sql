-- Issue 322: an actor's own capability calls are recorded with their grant, arguments and result,
-- and an operator can revoke a registry capability for one actor.
ALTER TABLE clockgrove.run_steps ADD COLUMN capability_evidence jsonb
  CHECK (capability_evidence IS NULL OR jsonb_typeof(capability_evidence)='object' AND octet_length(capability_evidence::text)<=16384);

ALTER TABLE clockgrove.actor_activation_policies
  ADD COLUMN revoked_capabilities text[] NOT NULL DEFAULT '{}'
  CHECK (cardinality(revoked_capabilities) <= 32);
GRANT UPDATE (revoked_capabilities) ON clockgrove.actor_activation_policies TO clockgrove_runtime;

-- Revocation is canonical per actor: every live member of the policy's space reads the actor's
-- revoked capabilities, and whether it owns the policy, never the owner's identity or configurations.
CREATE FUNCTION clockgrove.actor_capability_policy(t text, w text, tl text, a text)
RETURNS TABLE (owned boolean, revoked_capabilities text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, clockgrove AS $$
  SELECT p.principal_id = clockgrove.runtime_principal_id(), p.revoked_capabilities
    FROM clockgrove.actor_activation_policies p
   WHERE clockgrove.has_runtime_context(t)
     AND p.tenant_id=t AND p.world_id=w AND p.timeline_id=tl AND p.actor_id=a
     AND EXISTS (SELECT 1 FROM clockgrove.world_memberships m
       WHERE m.tenant_id=t AND m.world_id=w AND m.timeline_id=tl AND m.space_id=p.space_id
         AND m.principal_id=clockgrove.runtime_principal_id() AND m.revoked_at IS NULL)
$$;
REVOKE ALL ON FUNCTION clockgrove.actor_capability_policy(text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clockgrove.actor_capability_policy(text,text,text,text) TO clockgrove_runtime;
