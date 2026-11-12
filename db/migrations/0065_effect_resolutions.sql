-- Issue 166: an operator observation supplements uncertainty; it never rewrites an attempt.
-- Identifier bounds follow the existing effect ledger (0056).
CREATE TABLE clockgrove.effect_resolutions (
  tenant_id text NOT NULL, world_id text NOT NULL, timeline_id text NOT NULL,
  effect_id text NOT NULL, space_id text NOT NULL,
  attempt_id text NOT NULL CHECK (octet_length(attempt_id) BETWEEN 1 AND 1024),
  resolved_by text NOT NULL CHECK (octet_length(resolved_by) BETWEEN 1 AND 1024),
  disposition text NOT NULL CHECK (disposition IN ('done','failed')),
  resolved_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(resolved_at)),
  PRIMARY KEY (tenant_id,world_id,timeline_id,effect_id),
  FOREIGN KEY (tenant_id,world_id,timeline_id,effect_id)
    REFERENCES clockgrove.effect_attempts(tenant_id,world_id,timeline_id,effect_id),
  FOREIGN KEY (tenant_id,world_id,timeline_id,attempt_id)
    REFERENCES clockgrove.effect_attempts(tenant_id,world_id,timeline_id,attempt_id),
  FOREIGN KEY (tenant_id,resolved_by) REFERENCES clockgrove.tenant_principals(tenant_id,principal_id)
);
CREATE FUNCTION clockgrove.guard_effect_resolution() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,clockgrove AS $$
DECLARE intent clockgrove.effect_intents%ROWTYPE;
BEGIN
  SELECT * INTO intent FROM clockgrove.effect_intents WHERE tenant_id=NEW.tenant_id
    AND world_id=NEW.world_id AND timeline_id=NEW.timeline_id AND effect_id=NEW.effect_id FOR UPDATE;
  IF NOT FOUND OR intent.disposition<>'uncertain' OR intent.space_id<>NEW.space_id OR
    NOT EXISTS (SELECT 1 FROM clockgrove.effect_attempts a WHERE a.tenant_id=NEW.tenant_id
      AND a.world_id=NEW.world_id AND a.timeline_id=NEW.timeline_id AND a.effect_id=NEW.effect_id
      AND a.attempt_id=NEW.attempt_id AND a.disposition='uncertain') THEN
    RAISE EXCEPTION 'resolution requires scoped terminal uncertainty' USING ERRCODE='22023';
  END IF;
  NEW.resolved_at:=clock_timestamp();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION clockgrove.guard_effect_resolution() FROM PUBLIC;
CREATE TRIGGER effect_resolution_guard BEFORE INSERT ON clockgrove.effect_resolutions
  FOR EACH ROW EXECUTE FUNCTION clockgrove.guard_effect_resolution();
CREATE TRIGGER effect_resolutions_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON clockgrove.effect_resolutions
  FOR EACH STATEMENT EXECUTE FUNCTION clockgrove.reject_journal_mutation();
ALTER TABLE clockgrove.effect_resolutions ENABLE ROW LEVEL SECURITY;
ALTER TABLE clockgrove.effect_resolutions FORCE ROW LEVEL SECURITY;
CREATE POLICY effect_resolution_operator ON clockgrove.effect_resolutions FOR SELECT USING (
  clockgrove.mcp_install_authorized(tenant_id,world_id,timeline_id,space_id));
REVOKE ALL ON clockgrove.effect_resolutions FROM PUBLIC,clockgrove_runtime;
GRANT SELECT ON clockgrove.effect_resolutions TO clockgrove_runtime;
