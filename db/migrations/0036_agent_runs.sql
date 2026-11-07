-- Run and step evidence (Wave 5 §8, RW-0502, issue 15). Every cognitive attempt made for an actor
-- is one `agent_runs` row with ordered `run_steps`. Each reaches exactly one terminal disposition:
-- the guards below admit only `running` to a terminal status, never a change after it, and close a
-- run's open steps with the run's own disposition. A run names its parent run and step and its
-- causal root run (itself when it has no parent). Rows hold safe metadata only: raw model input and
-- output are `conversation`-class artifacts of the artifact store (0012), named by foreign keys
-- that pin the class, so their text exists only as ciphertext and only a reader whose ceiling holds
-- `conversation` decrypts it.
--
-- Today's runs are Caretaker Talk turns, so a run belongs to one conversation session (0034):
-- its participant writes it, and an inspector whose ceiling holds `operator_evidence` reads it.

-- Decision: at most 2,000 runs a session, four attempts for each of its 500 possible turns, so
-- retries cannot grow a session's evidence without bound; and 32 steps a run, far above the two a
-- scripted Talk turn records and the nine kinds §8 lists.
CREATE TABLE clockgrove.agent_runs (
  tenant_id text NOT NULL,
  run_id text NOT NULL CHECK (octet_length(run_id) BETWEEN 1 AND 1024),
  world_id text NOT NULL,
  timeline_id text NOT NULL,
  -- The session's partition and space, where its artifacts live.
  partition_id text NOT NULL,
  space_id text NOT NULL,
  session_id text NOT NULL,
  -- Execution: the addressed actor. Initiation: the participant and their world persona.
  actor_id text NOT NULL,
  principal_id text NOT NULL,
  persona_id text NOT NULL,
  activation text NOT NULL CHECK (activation = 'conversation_message'),
  input_message_id text NOT NULL CHECK (octet_length(input_message_id) BETWEEN 1 AND 1030),
  parent_run_id text,
  parent_step integer,
  root_run_id text NOT NULL,
  model text NOT NULL CHECK (octet_length(model) BETWEEN 1 AND 128),
  prompt_version text NOT NULL CHECK (octet_length(prompt_version) BETWEEN 1 AND 128),
  -- The session's message count the attempt read.
  input_revision integer NOT NULL CHECK (input_revision >= 0),
  status text NOT NULL DEFAULT 'running' CHECK (
    status IN ('running', 'completed', 'failed', 'cancelled', 'abandoned', 'superseded')
  ),
  outcome_code text CHECK (outcome_code ~ '^[a-z_]{1,64}$'),
  -- The conversation turn a completed run committed, if it committed one.
  turn integer CHECK (turn BETWEEN 1 AND 500),
  summary text NOT NULL CHECK (octet_length(summary) BETWEEN 1 AND 256),
  prompt_artifact_id text,
  privacy_class text NOT NULL DEFAULT 'conversation' CHECK (privacy_class = 'conversation'),
  started_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  ended_at timestamptz,
  PRIMARY KEY (tenant_id, run_id),
  CONSTRAINT agent_runs_terminal CHECK ((status = 'running') = (ended_at IS NULL)),
  CONSTRAINT agent_runs_turn CHECK (status = 'completed' OR turn IS NULL),
  CONSTRAINT agent_runs_parent CHECK ((parent_run_id IS NULL) = (parent_step IS NULL)),
  FOREIGN KEY (tenant_id, session_id)
    REFERENCES clockgrove.conversation_sessions (tenant_id, session_id),
  FOREIGN KEY (tenant_id, session_id, principal_id, persona_id)
    REFERENCES clockgrove.conversation_participants (tenant_id, session_id, principal_id, persona_id),
  FOREIGN KEY (tenant_id, root_run_id) REFERENCES clockgrove.agent_runs (tenant_id, run_id),
  FOREIGN KEY (tenant_id, prompt_artifact_id, privacy_class)
    REFERENCES clockgrove.artifact_references (tenant_id, artifact_id, privacy_class)
);
CREATE INDEX agent_runs_session ON clockgrove.agent_runs (tenant_id, session_id, input_message_id);
CREATE INDEX agent_runs_root ON clockgrove.agent_runs (tenant_id, root_run_id);
CREATE INDEX agent_runs_world
  ON clockgrove.agent_runs (tenant_id, world_id, timeline_id, started_at DESC, run_id);

CREATE TABLE clockgrove.run_steps (
  tenant_id text NOT NULL,
  run_id text NOT NULL,
  session_id text NOT NULL,
  step integer NOT NULL CHECK (step BETWEEN 1 AND 32),
  kind text NOT NULL CHECK (kind IN (
    'context_retrieval', 'model_attempt', 'tool_proposal', 'approval', 'tool_execution',
    'world_command_proposal', 'validation', 'commit', 'delivery'
  )),
  status text NOT NULL DEFAULT 'running' CHECK (
    status IN ('running', 'succeeded', 'failed', 'cancelled', 'abandoned', 'superseded')
  ),
  outcome_code text CHECK (outcome_code ~ '^[a-z_]{1,64}$'),
  model text CHECK (octet_length(model) BETWEEN 1 AND 128),
  tool text CHECK (octet_length(tool) BETWEEN 1 AND 256),
  -- What the step led to: a world command, or a message of the run's session.
  command_id text,
  output_message_id text,
  input_artifact_id text,
  output_artifact_id text,
  -- Usage and cost where known; NULL is unknown, not zero.
  input_tokens integer CHECK (input_tokens >= 0),
  output_tokens integer CHECK (output_tokens >= 0),
  cost_microusd bigint CHECK (cost_microusd >= 0),
  summary text NOT NULL CHECK (octet_length(summary) BETWEEN 1 AND 256),
  privacy_class text NOT NULL DEFAULT 'conversation' CHECK (privacy_class = 'conversation'),
  started_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  ended_at timestamptz,
  PRIMARY KEY (tenant_id, run_id, step),
  CONSTRAINT run_steps_terminal CHECK ((status = 'running') = (ended_at IS NULL)),
  FOREIGN KEY (tenant_id, run_id) REFERENCES clockgrove.agent_runs (tenant_id, run_id),
  FOREIGN KEY (tenant_id, command_id) REFERENCES clockgrove.command_receipts (tenant_id, command_id),
  FOREIGN KEY (tenant_id, session_id, output_message_id)
    REFERENCES clockgrove.conversation_messages (tenant_id, session_id, message_id),
  FOREIGN KEY (tenant_id, input_artifact_id, privacy_class)
    REFERENCES clockgrove.artifact_references (tenant_id, artifact_id, privacy_class),
  FOREIGN KEY (tenant_id, output_artifact_id, privacy_class)
    REFERENCES clockgrove.artifact_references (tenant_id, artifact_id, privacy_class)
);
CREATE INDEX run_steps_command ON clockgrove.run_steps (tenant_id, command_id)
  WHERE command_id IS NOT NULL;
CREATE INDEX run_steps_output_message ON clockgrove.run_steps (tenant_id, session_id, output_message_id)
  WHERE output_message_id IS NOT NULL;

ALTER TABLE clockgrove.agent_runs
  ADD FOREIGN KEY (tenant_id, parent_run_id, parent_step)
    REFERENCES clockgrove.run_steps (tenant_id, run_id, step);

-- A participant writes the runs of their own sessions as themselves; they and an inspector whose
-- ceiling holds `operator_evidence` read them. The route adds the world and timeline scope.
DO $rls$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['agent_runs', 'run_steps'] LOOP
    EXECUTE format('ALTER TABLE clockgrove.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE clockgrove.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY run_reader ON clockgrove.%I FOR SELECT
         USING (clockgrove.runtime_can_access(tenant_id, ''operator_evidence'')
                OR (clockgrove.runtime_can_access(tenant_id, privacy_class)
                    AND clockgrove.runtime_conversation_participant(tenant_id, session_id)))',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY run_writer ON clockgrove.%I FOR INSERT
         WITH CHECK (clockgrove.runtime_can_access(tenant_id, privacy_class)
                     AND clockgrove.runtime_conversation_participant(tenant_id, session_id) %s)',
      table_name,
      CASE table_name WHEN 'agent_runs'
        THEN 'AND principal_id = clockgrove.runtime_principal_id()' ELSE '' END
    );
    EXECUTE format(
      'CREATE POLICY run_closer ON clockgrove.%I FOR UPDATE
         USING (clockgrove.runtime_can_access(tenant_id, privacy_class)
                AND clockgrove.runtime_conversation_participant(tenant_id, session_id))
         WITH CHECK (clockgrove.runtime_can_access(tenant_id, privacy_class)
                     AND clockgrove.runtime_conversation_participant(tenant_id, session_id))',
      table_name
    );
    EXECUTE format('REVOKE ALL ON clockgrove.%I FROM PUBLIC', table_name);
    EXECUTE format('GRANT SELECT, INSERT ON clockgrove.%I TO clockgrove_runtime', table_name);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE DELETE ON clockgrove.%I
         FOR EACH ROW EXECUTE FUNCTION clockgrove.reject_journal_mutation()',
      table_name || '_no_delete', table_name
    );
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON clockgrove.%I
         FOR EACH STATEMENT EXECUTE FUNCTION clockgrove.reject_journal_mutation()',
      table_name || '_no_truncate', table_name
    );
  END LOOP;
END;
$rls$;

-- Only the disposition and what it produced change; identity, links and inputs never do.
GRANT UPDATE (status, outcome_code, turn, ended_at) ON clockgrove.agent_runs TO clockgrove_runtime;
GRANT UPDATE (status, outcome_code, output_artifact_id, output_message_id, command_id,
              input_tokens, output_tokens, cost_microusd, summary, ended_at)
  ON clockgrove.run_steps TO clockgrove_runtime;

-- The run state machine. A run starts `running`, with its root fixed by its parent; it ends once.
-- A completed run has no open step; any other disposition closes its open steps with itself.
CREATE FUNCTION clockgrove.guard_agent_run()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, clockgrove
AS $$
DECLARE
  parent clockgrove.agent_runs%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'running' OR NEW.turn IS NOT NULL OR NEW.outcome_code IS NOT NULL THEN
      RAISE EXCEPTION 'a run starts running' USING ERRCODE = 'CG020';
    END IF;
    NEW.ended_at := NULL;
    IF NEW.parent_run_id IS NULL THEN
      IF NEW.root_run_id <> NEW.run_id THEN
        RAISE EXCEPTION 'a run without a parent is its own root' USING ERRCODE = 'CG020';
      END IF;
    ELSE
      SELECT * INTO parent FROM clockgrove.agent_runs
       WHERE tenant_id = NEW.tenant_id AND run_id = NEW.parent_run_id;
      IF NOT FOUND OR parent.root_run_id <> NEW.root_run_id
         OR parent.session_id <> NEW.session_id THEN
        RAISE EXCEPTION 'a child run shares its parent''s session and root' USING ERRCODE = 'CG020';
      END IF;
    END IF;
    PERFORM pg_advisory_xact_lock(hashtext('agent-runs:' || NEW.tenant_id || ':' || NEW.session_id));
    IF (SELECT count(*) FROM clockgrove.agent_runs
         WHERE tenant_id = NEW.tenant_id AND session_id = NEW.session_id) >= 2000 THEN
      RAISE EXCEPTION 'session run limit reached' USING ERRCODE = 'CG021';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'running' THEN
    RAISE EXCEPTION 'a finished run never changes' USING ERRCODE = 'CG020';
  END IF;
  IF NEW.status = 'running' THEN
    RAISE EXCEPTION 'a run update records its disposition' USING ERRCODE = 'CG020';
  END IF;
  NEW.ended_at := clock_timestamp();
  IF NEW.status = 'completed' THEN
    IF EXISTS (SELECT 1 FROM clockgrove.run_steps
                WHERE tenant_id = NEW.tenant_id AND run_id = NEW.run_id AND status = 'running') THEN
      RAISE EXCEPTION 'a run completes only when its steps have ended' USING ERRCODE = 'CG020';
    END IF;
  ELSE
    UPDATE clockgrove.run_steps
       SET status = NEW.status, outcome_code = coalesce(outcome_code, NEW.outcome_code)
     WHERE tenant_id = NEW.tenant_id AND run_id = NEW.run_id AND status = 'running';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION clockgrove.guard_agent_run() FROM PUBLIC;
CREATE TRIGGER agent_runs_guard
  BEFORE INSERT OR UPDATE ON clockgrove.agent_runs
  FOR EACH ROW EXECUTE FUNCTION clockgrove.guard_agent_run();

-- The step state machine: steps are numbered in order inside a running run, and a step ends once.
CREATE FUNCTION clockgrove.guard_run_step()
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
  IF NOT FOUND OR run.status <> 'running' OR run.session_id <> NEW.session_id THEN
    RAISE EXCEPTION 'a step belongs to a running run' USING ERRCODE = 'CG020';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.step <> 1 + (SELECT count(*) FROM clockgrove.run_steps
                         WHERE tenant_id = NEW.tenant_id AND run_id = NEW.run_id) THEN
      RAISE EXCEPTION 'steps are numbered in order' USING ERRCODE = 'CG020';
    END IF;
  ELSIF OLD.status <> 'running' THEN
    RAISE EXCEPTION 'a finished step never changes' USING ERRCODE = 'CG020';
  END IF;
  NEW.ended_at := CASE WHEN NEW.status = 'running' THEN NULL ELSE clock_timestamp() END;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION clockgrove.guard_run_step() FROM PUBLIC;
CREATE TRIGGER run_steps_guard
  BEFORE INSERT OR UPDATE ON clockgrove.run_steps
  FOR EACH ROW EXECUTE FUNCTION clockgrove.guard_run_step();

-- Run inspection is audited like every other inspector read (0022, 0031, 0033), naming no entry.
ALTER TABLE clockgrove.inspector_accesses
  DROP CONSTRAINT inspector_accesses_subject_check,
  ADD CONSTRAINT inspector_accesses_subject_check CHECK (
    subject IN (
      'causal-chain', 'runtime-state', 'event', 'scheduled-action', 'client-view', 'agent-runs'
    )
  );
