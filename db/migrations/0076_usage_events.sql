-- Issue 329, part 1: billing-grade usage events, derived only from the engine's own durable
-- records. A usage event is written by a trigger on the row that proves the use: a model attempt
-- or tool execution step that ended (run_steps), or a delivery its sink received
-- (delivery_sink_receipts). No role writes one directly, so no client claim becomes usage.
-- Quantities are native (tokens by type, calls, deliveries); a null quantity is unknown, never
-- zero. No price, cost, currency, balance or account is part of an event (docs/protocols/usage.md).

-- A model step records what the whole call used: every route attempt, by token type.
ALTER TABLE clockgrove.run_steps
  ADD COLUMN cached_input_tokens integer CHECK (cached_input_tokens >= 0),
  ADD COLUMN reasoning_tokens integer CHECK (reasoning_tokens >= 0),
  ADD COLUMN model_calls integer CHECK (model_calls BETWEEN 0 AND 32);
GRANT UPDATE (cached_input_tokens, reasoning_tokens, model_calls)
  ON clockgrove.run_steps TO clockgrove_runtime;

CREATE TABLE clockgrove.usage_events (
  tenant_id text NOT NULL,
  -- Stable identity derived from the source row's key: deriving or forwarding twice is one event.
  event_id text NOT NULL CHECK (octet_length(event_id) BETWEEN 1 AND 2200),
  -- The feed order: a reader pages by it and resumes after the last one it took.
  sequence bigint GENERATED ALWAYS AS IDENTITY,
  world_id text NOT NULL,
  timeline_id text NOT NULL,
  space_id text NOT NULL,
  category text NOT NULL CHECK (category IN ('model_call', 'tool_call', 'delivery')),
  source text NOT NULL CHECK (source IN ('run_step', 'delivery_receipt')),
  -- The model, the capability or the delivery sink the use went to.
  resource text CHECK (octet_length(resource) BETWEEN 1 AND 256),
  status text NOT NULL CHECK (status ~ '^[a-z_]{1,64}$'),
  outcome_code text CHECK (outcome_code ~ '^[a-z_]{1,64}$'),
  -- Who and what it is for: the player (principal), their persona, the actor, the session, the
  -- run and the run's causal root.
  principal_id text NOT NULL,
  persona_id text,
  actor_id text NOT NULL,
  session_id text NOT NULL,
  run_id text,
  root_run_id text,
  quantities jsonb NOT NULL CHECK (jsonb_typeof(quantities) = 'object'),
  -- Wall-clock time of the use, and the world's committed simulation time beside it.
  occurred_at timestamptz NOT NULL CHECK (isfinite(occurred_at)),
  world_time bigint,
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (tenant_id, event_id),
  UNIQUE (sequence),
  FOREIGN KEY (tenant_id, world_id, timeline_id)
    REFERENCES clockgrove.timelines (tenant_id, world_id, timeline_id)
);
CREATE INDEX usage_events_player
  ON clockgrove.usage_events (tenant_id, world_id, timeline_id, principal_id, occurred_at);
CREATE INDEX usage_events_feed
  ON clockgrove.usage_events (tenant_id, world_id, timeline_id, sequence);

-- A usage reader is a member of the space with the inspect grant and `operator_evidence`, as for
-- run search. Memberships are private to their readers, so the check runs as definer.
CREATE FUNCTION clockgrove.runtime_usage_reader(t text, w text, tl text, s text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, clockgrove AS $$
  SELECT clockgrove.runtime_can_access(t, 'operator_evidence') AND EXISTS (
    SELECT 1 FROM clockgrove.world_memberships m
     WHERE m.tenant_id = t AND m.world_id = w AND m.timeline_id = tl AND m.space_id = s
       AND m.principal_id = clockgrove.runtime_principal_id() AND m.revoked_at IS NULL
       AND 'runtime:world-inspect' = ANY(m.grants))
$$;
REVOKE ALL ON FUNCTION clockgrove.runtime_usage_reader(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clockgrove.runtime_usage_reader(text, text, text, text)
  TO clockgrove_runtime;

ALTER TABLE clockgrove.usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE clockgrove.usage_events FORCE ROW LEVEL SECURITY;
CREATE POLICY usage_reader ON clockgrove.usage_events FOR SELECT USING (
  clockgrove.runtime_usage_reader(tenant_id, world_id, timeline_id, space_id));
REVOKE ALL ON clockgrove.usage_events FROM PUBLIC;
GRANT SELECT ON clockgrove.usage_events TO clockgrove_runtime;
CREATE TRIGGER usage_events_no_update_delete BEFORE UPDATE OR DELETE ON clockgrove.usage_events
  FOR EACH ROW EXECUTE FUNCTION clockgrove.reject_journal_mutation();
CREATE TRIGGER usage_events_no_truncate BEFORE TRUNCATE ON clockgrove.usage_events
  FOR EACH STATEMENT EXECUTE FUNCTION clockgrove.reject_journal_mutation();

-- The world's committed simulation time for a space, when the space has a partition state.
CREATE FUNCTION clockgrove.usage_world_time(t text, w text, tl text, s text)
RETURNS bigint LANGUAGE sql STABLE SET search_path = pg_catalog, clockgrove AS $$
  SELECT simulation_time FROM clockgrove.partition_states
   WHERE tenant_id = t AND world_id = w AND timeline_id = tl AND space_id = s
   ORDER BY revision DESC, partition_id LIMIT 1
$$;
REVOKE ALL ON FUNCTION clockgrove.usage_world_time(text, text, text, text) FROM PUBLIC;

-- One event per model attempt or tool execution step, when it ends.
CREATE FUNCTION clockgrove.record_step_usage() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clockgrove AS $$
DECLARE
  run clockgrove.agent_runs%ROWTYPE;
BEGIN
  IF NEW.status = 'running' OR NEW.kind NOT IN ('model_attempt', 'tool_execution')
     OR (TG_OP = 'UPDATE' AND OLD.status <> 'running') THEN
    RETURN NULL;
  END IF;
  SELECT * INTO STRICT run FROM clockgrove.agent_runs
   WHERE tenant_id = NEW.tenant_id AND run_id = NEW.run_id;
  INSERT INTO clockgrove.usage_events (
    tenant_id, event_id, world_id, timeline_id, space_id, category, source, resource, status,
    outcome_code, principal_id, persona_id, actor_id, session_id, run_id, root_run_id, quantities,
    occurred_at, world_time
  ) VALUES (
    NEW.tenant_id, 'run_step:' || NEW.run_id || ':' || NEW.step, run.world_id, run.timeline_id,
    run.space_id,
    CASE NEW.kind WHEN 'model_attempt' THEN 'model_call' ELSE 'tool_call' END,
    'run_step', coalesce(NEW.model, NEW.tool), NEW.status, NEW.outcome_code, run.principal_id,
    run.persona_id, run.actor_id, NEW.session_id, NEW.run_id, run.root_run_id,
    CASE NEW.kind
      WHEN 'model_attempt' THEN jsonb_build_object(
        'inputTokens', NEW.input_tokens, 'cachedInputTokens', NEW.cached_input_tokens,
        'outputTokens', NEW.output_tokens, 'reasoningTokens', NEW.reasoning_tokens,
        'calls', NEW.model_calls)
      ELSE jsonb_build_object('calls', 1)
    END,
    coalesce(NEW.ended_at, statement_timestamp()),
    (SELECT simulation_time FROM clockgrove.partition_states AS p
      WHERE p.tenant_id = run.tenant_id AND p.timeline_id = run.timeline_id
        AND p.partition_id = run.partition_id)
  ) ON CONFLICT (tenant_id, event_id) DO NOTHING;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION clockgrove.record_step_usage() FROM PUBLIC;
CREATE TRIGGER run_steps_usage AFTER INSERT OR UPDATE OF status ON clockgrove.run_steps
  FOR EACH ROW EXECUTE FUNCTION clockgrove.record_step_usage();

-- One event per delivery its sink received.
CREATE FUNCTION clockgrove.record_delivery_usage() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clockgrove AS $$
DECLARE
  delivery clockgrove.deliveries%ROWTYPE;
BEGIN
  SELECT * INTO STRICT delivery FROM clockgrove.deliveries d
   WHERE d.tenant_id = NEW.tenant_id AND d.world_id = NEW.world_id
     AND d.timeline_id = NEW.timeline_id AND d.actor_id = NEW.actor_id
     AND d.principal_id = NEW.principal_id AND d.dedupe_key = NEW.dedupe_key;
  INSERT INTO clockgrove.usage_events (
    tenant_id, event_id, world_id, timeline_id, space_id, category, source, resource, status,
    principal_id, actor_id, session_id, quantities, occurred_at, world_time
  ) VALUES (
    NEW.tenant_id,
    'delivery:' || encode(sha256(convert_to(jsonb_build_array(
      NEW.world_id, NEW.timeline_id, NEW.actor_id, NEW.principal_id, NEW.dedupe_key)::text,
      'UTF8')), 'hex'),
    NEW.world_id, NEW.timeline_id, NEW.space_id, 'delivery', 'delivery_receipt', NEW.sink,
    'delivered', NEW.principal_id, NEW.actor_id, delivery.session_id,
    jsonb_build_object('deliveries', 1), statement_timestamp(),
    clockgrove.usage_world_time(NEW.tenant_id, NEW.world_id, NEW.timeline_id, NEW.space_id)
  ) ON CONFLICT (tenant_id, event_id) DO NOTHING;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION clockgrove.record_delivery_usage() FROM PUBLIC;
CREATE TRIGGER delivery_sink_receipts_usage AFTER INSERT ON clockgrove.delivery_sink_receipts
  FOR EACH ROW EXECUTE FUNCTION clockgrove.record_delivery_usage();

-- Usage reads are audited like every other inspector read.
ALTER TABLE clockgrove.inspector_accesses
  DROP CONSTRAINT inspector_accesses_subject_check,
  ADD CONSTRAINT inspector_accesses_subject_check CHECK (
    subject IN (
      'causal-chain', 'runtime-state', 'event', 'scheduled-action', 'client-view', 'agent-runs',
      'context-manifest', 'actor-documents', 'usage-events'
    )
  );
