-- The administrator creates the isolated NOLOGIN clockgrove_mcp_secrets role before migration.
-- No production runtime role is a member; trusted secret-provider composition owns its connection.
CREATE SCHEMA clockgrove_mcp AUTHORIZATION clockgrove_migrator;
REVOKE ALL ON SCHEMA clockgrove_mcp FROM PUBLIC;
GRANT USAGE ON SCHEMA clockgrove_mcp TO clockgrove_mcp_secrets;

CREATE TABLE clockgrove_mcp.credentials (
  reference uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  world_id text NOT NULL,
  timeline_id text NOT NULL,
  installation_id text NOT NULL,
  owner_principal_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0 AND revision <= 9007199254740991),
  state text NOT NULL CHECK (state IN ('pending', 'active', 'blocked', 'revoked')),
  revocation_requested boolean NOT NULL DEFAULT false,
  envelope jsonb NOT NULL CHECK (jsonb_typeof(envelope) = 'object'),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  FOREIGN KEY (tenant_id, world_id, timeline_id)
    REFERENCES clockgrove.timelines (tenant_id, world_id, timeline_id),
  FOREIGN KEY (tenant_id, owner_principal_id)
    REFERENCES clockgrove.tenant_principals (tenant_id, principal_id),
  CHECK (envelope->>'state' = state AND (envelope->>'revision')::bigint = revision),
  CHECK (state <> 'revoked' OR (revocation_requested AND envelope->'ciphertext' = '[]'::jsonb
    AND envelope->'wrappedKey' = '[]'::jsonb))
);
ALTER TABLE clockgrove_mcp.credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE clockgrove_mcp.credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY credential_scope ON clockgrove_mcp.credentials TO clockgrove_mcp_secrets
  USING (
    tenant_id = current_setting('mcp.tenant_id', true)
    AND world_id = current_setting('mcp.world_id', true)
    AND timeline_id = current_setting('mcp.timeline_id', true)
    AND installation_id = current_setting('mcp.installation_id', true)
    AND owner_principal_id = current_setting('mcp.owner_principal_id', true)
  ) WITH CHECK (
    tenant_id = current_setting('mcp.tenant_id', true)
    AND world_id = current_setting('mcp.world_id', true)
    AND timeline_id = current_setting('mcp.timeline_id', true)
    AND installation_id = current_setting('mcp.installation_id', true)
    AND owner_principal_id = current_setting('mcp.owner_principal_id', true)
  );
GRANT SELECT, INSERT, UPDATE ON clockgrove_mcp.credentials TO clockgrove_mcp_secrets;

CREATE FUNCTION clockgrove_mcp.guard_credential() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.revision <> 1 OR NEW.state NOT IN ('pending', 'active') OR NEW.revocation_requested THEN
      RAISE EXCEPTION 'credential transition refused' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF (NEW.reference, NEW.tenant_id, NEW.world_id, NEW.timeline_id,
        NEW.installation_id, NEW.owner_principal_id, NEW.created_at)
       IS DISTINCT FROM
       (OLD.reference, OLD.tenant_id, OLD.world_id, OLD.timeline_id,
        OLD.installation_id, OLD.owner_principal_id, OLD.created_at)
      OR OLD.state = 'revoked'
      OR (OLD.revocation_requested AND NOT NEW.revocation_requested) THEN
      RAISE EXCEPTION 'credential transition refused' USING ERRCODE = '23514';
    END IF;
    -- A fence does not change authenticated envelope bytes, state or revision (vault AAD).
    IF NEW.envelope = OLD.envelope AND NEW.revision = OLD.revision AND NEW.state = OLD.state
       AND NEW.revocation_requested THEN
      RETURN NEW;
    END IF;
    IF NEW.revision <> OLD.revision + 1
      OR (OLD.revocation_requested AND NEW.state <> 'revoked')
      OR (NEW.revocation_requested AND NEW.state <> 'revoked') THEN
      RAISE EXCEPTION 'credential transition refused' USING ERRCODE = '23514';
    END IF;
  END IF;
  NEW.updated_at := statement_timestamp();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION clockgrove_mcp.guard_credential() FROM PUBLIC;
CREATE TRIGGER guard_credential BEFORE INSERT OR UPDATE ON clockgrove_mcp.credentials
  FOR EACH ROW EXECUTE FUNCTION clockgrove_mcp.guard_credential();
