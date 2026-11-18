-- Issue 374: a model route's breaker opening and closing is durable evidence, not the gateway's
-- memory. One row per transition, written by the participant whose turn's model call caused it and
-- never changed after; the run inspector reads a run's rows. Safe metadata only: route, states and
-- the failure count. `run_id` is the run whose model call caused the transition, named by the
-- caller; the guard holds it to a running run of the row's own session and world.
CREATE TABLE clockgrove.model_breaker_transitions (
  tenant_id text NOT NULL,
  world_id text NOT NULL,
  session_id text NOT NULL,
  run_id text NOT NULL,
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
  (tenant_id, run_id, recorded_at, ordinal);

-- A row belongs to a running run of its own session and world, as a run step does (0036), and a
-- run holds at most 64 rows: two per route attempt (a half-open trial and its verdict), so 32
-- attempts, whatever its calls' aliases and steps.
CREATE FUNCTION clockgrove.guard_breaker_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, clockgrove
AS $$
DECLARE
  run clockgrove.agent_runs%ROWTYPE;
BEGIN
  SELECT * INTO run FROM clockgrove.agent_runs
   WHERE tenant_id = NEW.tenant_id AND run_id = NEW.run_id FOR UPDATE;
  IF NOT FOUND OR run.status <> 'running' OR run.session_id <> NEW.session_id
     OR run.world_id <> NEW.world_id THEN
    RAISE EXCEPTION 'a breaker transition belongs to a running run of its session'
      USING ERRCODE = 'CG020';
  END IF;
  IF (SELECT count(*) FROM clockgrove.model_breaker_transitions
       WHERE tenant_id = NEW.tenant_id AND run_id = NEW.run_id) >= 64 THEN
    RAISE EXCEPTION 'run breaker transition limit reached' USING ERRCODE = 'CG021';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION clockgrove.guard_breaker_transition() FROM PUBLIC;
CREATE TRIGGER model_breaker_transitions_guard
  BEFORE INSERT ON clockgrove.model_breaker_transitions
  FOR EACH ROW EXECUTE FUNCTION clockgrove.guard_breaker_transition();

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
