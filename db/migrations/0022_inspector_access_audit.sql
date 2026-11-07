-- #701: every authenticated access to the causal-chain inspector endpoint, allowed or denied, is one
-- immutable audit row: who (principal), what scope (tenant, world, timeline, space), which chain
-- (command ID), when, and the decision with its reason.
--
-- The runtime role has no privilege on the table. It appends only through the migrator-owned
-- SECURITY DEFINER function below, which takes the tenant and principal from the installed
-- transaction-local authority, never from arguments. A denial is recorded under the requested tenant
-- when the principal is not its member, so the targeted tenant sees cross-tenant probes, but only
-- for a tenant that exists: a denial naming no stored tenant writes nothing, so a caller cannot
-- create rows under invented tenants. An allow is recorded only for a tenant member. Nothing can
-- read, update or delete rows through the function.
--
-- Decision: IDs are 1 to 1024 octets. No ID decoder bounds length (`decodeOpaqueId` accepts any
-- trimmed string), so there is no existing bound to reuse. Request IDs are attacker-chosen; 1024
-- bounds one row and is far above any ID the system mints (UUIDs, `command-...`, `trusted:...`).
CREATE TABLE clockgrove.inspector_accesses (
  tenant_id text NOT NULL REFERENCES clockgrove.tenants (tenant_id)
    CHECK (octet_length(tenant_id) BETWEEN 1 AND 1024),
  access_id bigint GENERATED ALWAYS AS IDENTITY,
  principal_id text NOT NULL CHECK (octet_length(principal_id) BETWEEN 1 AND 1024),
  world_id text NOT NULL CHECK (octet_length(world_id) BETWEEN 1 AND 1024),
  timeline_id text NOT NULL CHECK (octet_length(timeline_id) BETWEEN 1 AND 1024),
  space_id text NOT NULL CHECK (octet_length(space_id) BETWEEN 1 AND 1024),
  command_id text NOT NULL CHECK (octet_length(command_id) BETWEEN 1 AND 1024),
  decision text NOT NULL CHECK (decision IN ('allow', 'deny')),
  -- allow: the chain was served, was not found (or is another scope's), or failed verification.
  -- deny: the authorization refusal, or an authority source that contradicted the request.
  reason_code text NOT NULL CHECK (
    (decision = 'allow' AND reason_code IN ('served', 'not-found', 'failed'))
    OR (decision = 'deny' AND reason_code IN (
      'world-participation-absent', 'runtime-grant-missing', 'authority-mismatch'
    ))
  ),
  accessed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (tenant_id, access_id)
);
ALTER TABLE clockgrove.inspector_accesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE clockgrove.inspector_accesses FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON clockgrove.inspector_accesses
  USING (clockgrove.has_runtime_context(tenant_id))
  WITH CHECK (clockgrove.has_runtime_context(tenant_id));
REVOKE ALL ON clockgrove.inspector_accesses FROM PUBLIC;
CREATE TRIGGER inspector_accesses_immutable_rows
  BEFORE UPDATE OR DELETE ON clockgrove.inspector_accesses
  FOR EACH ROW EXECUTE FUNCTION clockgrove.reject_journal_mutation();
CREATE TRIGGER inspector_accesses_immutable_truncate
  BEFORE TRUNCATE ON clockgrove.inspector_accesses
  FOR EACH STATEMENT EXECUTE FUNCTION clockgrove.reject_journal_mutation();

CREATE FUNCTION clockgrove.record_inspector_access(
  access_world_id text,
  access_timeline_id text,
  access_space_id text,
  access_command_id text,
  access_decision text,
  access_reason_code text
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, clockgrove
AS $$
DECLARE
  tenant text := clockgrove.runtime_tenant_id();
  principal text := clockgrove.runtime_principal_id();
BEGIN
  IF tenant IS NULL OR principal IS NULL THEN
    RAISE EXCEPTION 'inspector access requires installed authority' USING ERRCODE = '42501';
  END IF;
  IF access_decision IS DISTINCT FROM 'deny' AND NOT clockgrove.has_runtime_context(tenant) THEN
    RAISE EXCEPTION 'only a tenant member can be allowed' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM clockgrove.tenants WHERE tenant_id = tenant) THEN
    RETURN;
  END IF;
  INSERT INTO clockgrove.inspector_accesses (
    tenant_id, principal_id, world_id, timeline_id, space_id, command_id, decision, reason_code
  ) VALUES (
    tenant, principal, access_world_id, access_timeline_id, access_space_id, access_command_id,
    access_decision, access_reason_code
  );
END;
$$;
REVOKE ALL ON FUNCTION clockgrove.record_inspector_access(text, text, text, text, text, text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clockgrove.record_inspector_access(text, text, text, text, text, text)
  TO clockgrove_runtime;
