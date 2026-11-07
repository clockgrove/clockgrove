-- Admission is runtime control accounting, independent of physical state and revision.
ALTER TABLE clockgrove.partition_states ADD COLUMN clock_admitted_horizon bigint
  NOT NULL DEFAULT 0 CHECK (clock_admitted_horizon >= 0);

-- A reconstructed owner claims a new generation; stale native handlers fence before work.
ALTER TABLE clockgrove.partition_states
  ADD COLUMN clock_owner_generation bigint NOT NULL DEFAULT 0 CHECK (clock_owner_generation >= 0),
  ADD COLUMN clock_owner_id text;

CREATE TABLE clockgrove.clock_admissions (
  tenant_id text NOT NULL,
  timeline_id text NOT NULL,
  partition_id text NOT NULL,
  activation_id text NOT NULL,
  policy_version bigint NOT NULL CHECK (policy_version >= 0),
  horizon bigint NOT NULL CHECK (horizon >= 0),
  admitted bigint NOT NULL CHECK (admitted >= 0),
  PRIMARY KEY (tenant_id, timeline_id, partition_id, activation_id),
  FOREIGN KEY (tenant_id, timeline_id, partition_id)
    REFERENCES clockgrove.partition_states (tenant_id, timeline_id, partition_id)
);
ALTER TABLE clockgrove.clock_admissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE clockgrove.clock_admissions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON clockgrove.clock_admissions
  USING (clockgrove.has_runtime_context(tenant_id))
  WITH CHECK (clockgrove.has_runtime_context(tenant_id));
REVOKE ALL ON clockgrove.clock_admissions FROM PUBLIC;
GRANT SELECT, INSERT ON clockgrove.clock_admissions TO clockgrove_runtime;
CREATE TRIGGER clock_admissions_immutable_rows
  BEFORE UPDATE OR DELETE ON clockgrove.clock_admissions
  FOR EACH ROW EXECUTE FUNCTION clockgrove.reject_journal_mutation();
CREATE TRIGGER clock_admissions_immutable_truncate
  BEFORE TRUNCATE ON clockgrove.clock_admissions
  FOR EACH STATEMENT EXECUTE FUNCTION clockgrove.reject_journal_mutation();

-- Claim receipts make a lost response retry recover its original generation, never reclaim a
-- newer incarnation's authority.
CREATE TABLE clockgrove.clock_owner_claims (
  tenant_id text NOT NULL,
  timeline_id text NOT NULL,
  partition_id text NOT NULL,
  owner_id text NOT NULL,
  generation bigint NOT NULL CHECK (generation > 0),
  PRIMARY KEY (tenant_id, timeline_id, partition_id, owner_id),
  UNIQUE (tenant_id, timeline_id, partition_id, generation),
  FOREIGN KEY (tenant_id, timeline_id, partition_id)
    REFERENCES clockgrove.partition_states (tenant_id, timeline_id, partition_id)
);
ALTER TABLE clockgrove.clock_owner_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE clockgrove.clock_owner_claims FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON clockgrove.clock_owner_claims
  USING (clockgrove.has_runtime_context(tenant_id))
  WITH CHECK (clockgrove.has_runtime_context(tenant_id));
REVOKE ALL ON clockgrove.clock_owner_claims FROM PUBLIC;
GRANT SELECT, INSERT ON clockgrove.clock_owner_claims TO clockgrove_runtime;
CREATE TRIGGER clock_owner_claims_immutable_rows
  BEFORE UPDATE OR DELETE ON clockgrove.clock_owner_claims
  FOR EACH ROW EXECUTE FUNCTION clockgrove.reject_journal_mutation();
CREATE TRIGGER clock_owner_claims_immutable_truncate
  BEFORE TRUNCATE ON clockgrove.clock_owner_claims
  FOR EACH STATEMENT EXECUTE FUNCTION clockgrove.reject_journal_mutation();
