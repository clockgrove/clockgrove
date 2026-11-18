-- Issue 374: a model route's breaker opening and closing is durable evidence, not the gateway's
-- memory. One row per transition, written by the participant whose turn's model call caused it and
-- never changed after; the run inspector reads a run's rows. Safe metadata only: route, states and
-- the failure count. `run_id` is the participant's open run of the session when the call finished;
-- a call outside any run keeps NULL.
CREATE TABLE clockgrove.model_breaker_transitions (
  tenant_id text NOT NULL,
  world_id text NOT NULL,
  session_id text NOT NULL,
  run_id text,
  call_id text NOT NULL CHECK (octet_length(call_id) BETWEEN 1 AND 1024),
  ordinal smallint NOT NULL CHECK (ordinal BETWEEN 0 AND 15),
  route_id text NOT NULL CHECK (octet_length(route_id) BETWEEN 1 AND 256),
  alias text NOT NULL CHECK (octet_length(alias) BETWEEN 1 AND 256),
  from_state text NOT NULL CHECK (from_state IN ('closed', 'open', 'half_open')),
  to_state text NOT NULL CHECK (to_state IN ('closed', 'open', 'half_open') AND to_state <> from_state),
  consecutive_failures integer NOT NULL CHECK (consecutive_failures >= 0),
  recorded_at timestamptz NOT NULL CHECK (isfinite(recorded_at)),
  PRIMARY KEY (tenant_id, call_id, ordinal),
  FOREIGN KEY (tenant_id, run_id) REFERENCES clockgrove.agent_runs (tenant_id, run_id)
);
CREATE INDEX model_breaker_transitions_run ON clockgrove.model_breaker_transitions
  (tenant_id, run_id, recorded_at, ordinal) WHERE run_id IS NOT NULL;

ALTER TABLE clockgrove.model_breaker_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE clockgrove.model_breaker_transitions FORCE ROW LEVEL SECURITY;
CREATE POLICY breaker_reader ON clockgrove.model_breaker_transitions FOR SELECT
  USING (clockgrove.runtime_can_access(tenant_id, 'operator_evidence')
         OR clockgrove.runtime_conversation_participant(tenant_id, session_id));
CREATE POLICY breaker_writer ON clockgrove.model_breaker_transitions FOR INSERT
  WITH CHECK (clockgrove.runtime_conversation_participant(tenant_id, session_id));
REVOKE ALL ON clockgrove.model_breaker_transitions FROM PUBLIC, clockgrove_runtime;
GRANT SELECT, INSERT ON clockgrove.model_breaker_transitions TO clockgrove_runtime;
CREATE TRIGGER model_breaker_transitions_immutable
  BEFORE UPDATE OR DELETE OR TRUNCATE ON clockgrove.model_breaker_transitions
  FOR EACH STATEMENT EXECUTE FUNCTION clockgrove.reject_journal_mutation();
