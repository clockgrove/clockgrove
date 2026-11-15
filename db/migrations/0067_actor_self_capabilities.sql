-- Issue 322: an actor's own capability calls are recorded with their grant, arguments and result,
-- and an operator can revoke a registry capability for one actor.
ALTER TABLE clockgrove.run_steps ADD COLUMN capability_evidence jsonb
  CHECK (capability_evidence IS NULL OR jsonb_typeof(capability_evidence)='object' AND octet_length(capability_evidence::text)<=16384);

ALTER TABLE clockgrove.actor_activation_policies
  ADD COLUMN revoked_capabilities text[] NOT NULL DEFAULT '{}'
  CHECK (cardinality(revoked_capabilities) <= 32);
GRANT UPDATE (revoked_capabilities) ON clockgrove.actor_activation_policies TO clockgrove_runtime;
