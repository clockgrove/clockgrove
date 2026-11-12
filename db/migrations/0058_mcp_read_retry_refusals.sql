-- Issue 165: conflicting proposals retain evidence without changing the original effect.
CREATE TABLE clockgrove.mcp_read_retry_refusals (
  tenant_id text NOT NULL, world_id text NOT NULL, timeline_id text NOT NULL,
  effect_id text NOT NULL,
  retry_hash text NOT NULL CHECK (retry_hash ~ '^[0-9a-f]{64}$'),
  presented_arguments_hash text NOT NULL CHECK (presented_arguments_hash ~ '^[0-9a-f]{64}$'),
  outcome_code text NOT NULL CHECK (outcome_code IN ('arguments_changed','retry_conflict')),
  PRIMARY KEY(tenant_id,world_id,timeline_id,effect_id,retry_hash),
  FOREIGN KEY(tenant_id,world_id,timeline_id,effect_id)
    REFERENCES clockgrove.mcp_read_admissions(tenant_id,world_id,timeline_id,effect_id)
);
ALTER TABLE clockgrove.mcp_read_retry_refusals ENABLE ROW LEVEL SECURITY;
ALTER TABLE clockgrove.mcp_read_retry_refusals FORCE ROW LEVEL SECURITY;
REVOKE ALL ON clockgrove.mcp_read_retry_refusals FROM PUBLIC,clockgrove_runtime;
CREATE TRIGGER mcp_read_retry_refusals_immutable BEFORE UPDATE ON clockgrove.mcp_read_retry_refusals
  FOR EACH ROW EXECUTE FUNCTION clockgrove.reject_journal_mutation();
CREATE TRIGGER mcp_read_retry_refusals_no_delete BEFORE DELETE OR TRUNCATE ON clockgrove.mcp_read_retry_refusals
  FOR EACH STATEMENT EXECUTE FUNCTION clockgrove.reject_journal_mutation();
