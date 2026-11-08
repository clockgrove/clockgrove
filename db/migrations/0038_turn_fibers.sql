-- Recoverable turn fibers (Wave 5 §7, RW-0503, issue 18). A Caretaker message accepted for an actor
-- is one `conversation_turn_fibers` row, keyed by its session and message ID, so a duplicate wakeup
-- or retry finds the same turn and never a second one. The row is the turn's durable checkpoint:
-- its phase only moves forward, and every move is fenced by the lease epoch of the owner incarnation
-- running it. A claim bumps the epoch, so a superseded incarnation can no longer move the turn. A
-- session holds at most one open turn, which orders its turns; separate sessions run concurrently.
--
-- The `ActorProcess` contract (Wave 5 §1) is `actor_processes`: a stable process ID whose bounded
-- run segments each claim a new lease epoch and append one immutable checkpoint segment.

-- Decision: at most 1,000 fibers a session, one for each of its possible messages (0034), so
-- cancelled and failed turns cannot grow a session's rows without bound.
CREATE TABLE clockgrove.conversation_turn_fibers (
  tenant_id text NOT NULL,
  session_id text NOT NULL,
  message_id text NOT NULL CHECK (octet_length(message_id) BETWEEN 1 AND 1024),
  world_id text NOT NULL,
  timeline_id text NOT NULL,
  actor_id text NOT NULL,
  -- Initiation: the participant whose message opened the turn, under their world persona.
  principal_id text NOT NULL,
  persona_id text NOT NULL,
  input_artifact_id text NOT NULL,
  phase text NOT NULL DEFAULT 'accepted' CHECK (phase IN (
    'accepted', 'context_pending', 'context_ready', 'model_running', 'proposal_validating',
    'committing', 'finalizing', 'completed', 'rejected', 'cancelled', 'failed', 'abandoned'
  )),
  -- The number of claims so far: each claim opens one run (0036).
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt BETWEEN 0 AND 2000),
  lease_epoch bigint NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
  lease_holder text CHECK (octet_length(lease_holder) BETWEEN 1 AND 256),
  run_id text,
  -- The model's answer once checkpointed: a recovered attempt commits it instead of asking again.
  reply_artifact_id text,
  -- The model's document proposal checkpointed with its answer (issue 17): the actor's private
  -- cognition, so a recovered attempt commits the same proposal without asking again.
  proposal_artifact_id text,
  proposal_privacy_class text NOT NULL DEFAULT 'private_cognition'
    CHECK (proposal_privacy_class = 'private_cognition'),
  -- The session's message count the turn read, fixed at context assembly.
  input_revision integer CHECK (input_revision >= 0),
  capability_revision bigint NOT NULL DEFAULT 0 CHECK (capability_revision >= 0),
  outcome_code text CHECK (outcome_code ~ '^[a-z_]{1,64}$'),
  privacy_class text NOT NULL DEFAULT 'conversation' CHECK (privacy_class = 'conversation'),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (tenant_id, session_id, message_id),
  FOREIGN KEY (tenant_id, session_id, principal_id, persona_id)
    REFERENCES clockgrove.conversation_participants (tenant_id, session_id, principal_id, persona_id),
  FOREIGN KEY (tenant_id, input_artifact_id, privacy_class)
    REFERENCES clockgrove.artifact_references (tenant_id, artifact_id, privacy_class),
  FOREIGN KEY (tenant_id, reply_artifact_id, privacy_class)
    REFERENCES clockgrove.artifact_references (tenant_id, artifact_id, privacy_class),
  FOREIGN KEY (tenant_id, proposal_artifact_id, proposal_privacy_class)
    REFERENCES clockgrove.artifact_references (tenant_id, artifact_id, privacy_class),
  FOREIGN KEY (tenant_id, run_id) REFERENCES clockgrove.agent_runs (tenant_id, run_id)
);
-- One open turn a session: the session's turns are ordered by acceptance.
CREATE UNIQUE INDEX conversation_turn_fibers_open
  ON clockgrove.conversation_turn_fibers (tenant_id, session_id)
  WHERE phase NOT IN ('completed', 'rejected', 'cancelled', 'failed', 'abandoned');
CREATE INDEX conversation_turn_fibers_actor
  ON clockgrove.conversation_turn_fibers (tenant_id, world_id, timeline_id, actor_id, principal_id)
  WHERE phase NOT IN ('completed', 'rejected', 'cancelled', 'failed', 'abandoned');

ALTER TABLE clockgrove.conversation_turn_fibers ENABLE ROW LEVEL SECURITY;
ALTER TABLE clockgrove.conversation_turn_fibers FORCE ROW LEVEL SECURITY;
-- As a session's turns (0034): only its participant, under a ceiling holding `conversation`.
CREATE POLICY participant_isolation ON clockgrove.conversation_turn_fibers
  USING (clockgrove.runtime_can_access(tenant_id, privacy_class)
         AND clockgrove.runtime_conversation_participant(tenant_id, session_id))
  WITH CHECK (clockgrove.runtime_can_access(tenant_id, privacy_class)
              AND clockgrove.runtime_conversation_participant(tenant_id, session_id)
              AND principal_id = clockgrove.runtime_principal_id());
REVOKE ALL ON clockgrove.conversation_turn_fibers FROM PUBLIC;
GRANT SELECT, INSERT ON clockgrove.conversation_turn_fibers TO clockgrove_runtime;
-- Only the checkpoint changes; identity and input never do.
GRANT UPDATE (phase, attempt, lease_epoch, lease_holder, run_id,
              reply_artifact_id, proposal_artifact_id, input_revision, capability_revision, outcome_code, updated_at)
  ON clockgrove.conversation_turn_fibers TO clockgrove_runtime;
CREATE TRIGGER conversation_turn_fibers_no_delete
  BEFORE DELETE ON clockgrove.conversation_turn_fibers
  FOR EACH ROW EXECUTE FUNCTION clockgrove.reject_journal_mutation();
CREATE TRIGGER conversation_turn_fibers_no_truncate
  BEFORE TRUNCATE ON clockgrove.conversation_turn_fibers
  FOR EACH STATEMENT EXECUTE FUNCTION clockgrove.reject_journal_mutation();

-- The fiber state machine: a turn starts `accepted`; its phase moves only forward, in §7.1 order;
-- a terminal turn never changes; the lease epoch never decreases, and a move that does not claim
-- (bump the epoch) keeps it.
CREATE FUNCTION clockgrove.guard_turn_fiber()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, clockgrove
AS $$
DECLARE
  phases constant text[] := ARRAY[
    'accepted', 'context_pending', 'context_ready', 'model_running', 'proposal_validating',
    'committing', 'finalizing', 'completed'
  ];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.phase <> 'accepted' OR NEW.attempt <> 0 OR NEW.lease_epoch <> 0
       OR NEW.run_id IS NOT NULL OR NEW.reply_artifact_id IS NOT NULL
       OR NEW.proposal_artifact_id IS NOT NULL THEN
      RAISE EXCEPTION 'a turn starts accepted' USING ERRCODE = 'CG020';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtext('turn-fibers:' || NEW.tenant_id || ':' || NEW.session_id));
    IF (SELECT count(*) FROM clockgrove.conversation_turn_fibers
         WHERE tenant_id = NEW.tenant_id AND session_id = NEW.session_id) >= 1000 THEN
      RAISE EXCEPTION 'session turn limit reached' USING ERRCODE = 'CG021';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.phase IN ('completed', 'rejected', 'cancelled', 'failed', 'abandoned') THEN
    RAISE EXCEPTION 'a finished turn never changes' USING ERRCODE = 'CG020';
  END IF;
  IF NEW.lease_epoch < OLD.lease_epoch
     OR (NEW.lease_epoch = OLD.lease_epoch AND NEW.attempt <> OLD.attempt)
     OR NEW.attempt < OLD.attempt THEN
    RAISE EXCEPTION 'a turn lease only moves forward' USING ERRCODE = 'CG020';
  END IF;
  IF NEW.phase = ANY (phases)
     AND array_position(phases, NEW.phase) < array_position(phases, OLD.phase) THEN
    RAISE EXCEPTION 'a turn phase only moves forward' USING ERRCODE = 'CG020';
  END IF;
  IF OLD.reply_artifact_id IS NOT NULL AND NEW.reply_artifact_id IS DISTINCT FROM OLD.reply_artifact_id THEN
    RAISE EXCEPTION 'a checkpointed answer never changes' USING ERRCODE = 'CG020';
  END IF;
  IF NEW.proposal_artifact_id IS DISTINCT FROM OLD.proposal_artifact_id
     AND (OLD.reply_artifact_id IS NOT NULL OR NEW.reply_artifact_id IS NULL) THEN
    RAISE EXCEPTION 'a proposal is checkpointed only with its answer' USING ERRCODE = 'CG020';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION clockgrove.guard_turn_fiber() FROM PUBLIC;
CREATE TRIGGER conversation_turn_fibers_guard
  BEFORE INSERT OR UPDATE ON clockgrove.conversation_turn_fibers
  FOR EACH ROW EXECUTE FUNCTION clockgrove.guard_turn_fiber();

-- Decision: a process runs at most 64 segments; the fixture objective needs a handful.
CREATE TABLE clockgrove.actor_processes (
  tenant_id text NOT NULL,
  process_id text NOT NULL CHECK (octet_length(process_id) BETWEEN 1 AND 256),
  world_id text NOT NULL,
  timeline_id text NOT NULL,
  -- Execution: the actor whose process this is, for its whole life.
  actor_id text NOT NULL CHECK (octet_length(actor_id) BETWEEN 1 AND 1024),
  objective text NOT NULL CHECK (objective = 'fixture-tally'),
  target integer NOT NULL CHECK (target BETWEEN 1 AND 10000),
  checkpoint integer NOT NULL DEFAULT 0 CHECK (checkpoint >= 0 AND checkpoint <= target),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'completed')),
  lease_epoch bigint NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
  lease_holder text CHECK (octet_length(lease_holder) BETWEEN 1 AND 256),
  segments integer NOT NULL DEFAULT 0 CHECK (segments BETWEEN 0 AND 64),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (tenant_id, process_id),
  CONSTRAINT actor_processes_completed CHECK ((state = 'completed') = (checkpoint = target))
);
CREATE TABLE clockgrove.actor_process_segments (
  tenant_id text NOT NULL,
  process_id text NOT NULL,
  segment integer NOT NULL CHECK (segment BETWEEN 1 AND 64),
  lease_epoch bigint NOT NULL CHECK (lease_epoch >= 1),
  lease_holder text NOT NULL CHECK (octet_length(lease_holder) BETWEEN 1 AND 256),
  from_checkpoint integer NOT NULL CHECK (from_checkpoint >= 0),
  to_checkpoint integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (tenant_id, process_id, segment),
  CONSTRAINT actor_process_segments_progress CHECK (to_checkpoint > from_checkpoint),
  FOREIGN KEY (tenant_id, process_id) REFERENCES clockgrove.actor_processes (tenant_id, process_id)
);
DO $rls$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['actor_processes', 'actor_process_segments'] LOOP
    EXECUTE format('ALTER TABLE clockgrove.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE clockgrove.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON clockgrove.%I
         USING (clockgrove.has_runtime_context(tenant_id))
         WITH CHECK (clockgrove.has_runtime_context(tenant_id))',
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
-- A claim changes only the lease; a segment's trigger moves the checkpoint.
GRANT UPDATE (lease_epoch, lease_holder, updated_at) ON clockgrove.actor_processes TO clockgrove_runtime;
CREATE TRIGGER actor_process_segments_immutable
  BEFORE UPDATE ON clockgrove.actor_process_segments
  FOR EACH ROW EXECUTE FUNCTION clockgrove.reject_journal_mutation();

-- A process's identity and objective never change, its lease epoch never decreases, and a
-- completed process takes no new lease.
CREATE FUNCTION clockgrove.guard_actor_process()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, clockgrove
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.checkpoint <> 0 OR NEW.segments <> 0 OR NEW.lease_epoch <> 0 OR NEW.state <> 'active' THEN
      RAISE EXCEPTION 'a process starts at its beginning' USING ERRCODE = 'CG020';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.lease_epoch < OLD.lease_epoch OR NEW.checkpoint < OLD.checkpoint
     OR NEW.segments < OLD.segments THEN
    RAISE EXCEPTION 'a process only moves forward' USING ERRCODE = 'CG020';
  END IF;
  IF OLD.state = 'completed' AND NEW.lease_epoch <> OLD.lease_epoch THEN
    RAISE EXCEPTION 'a completed process takes no lease' USING ERRCODE = 'CG020';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION clockgrove.guard_actor_process() FROM PUBLIC;
CREATE TRIGGER actor_processes_guard
  BEFORE INSERT OR UPDATE ON clockgrove.actor_processes
  FOR EACH ROW EXECUTE FUNCTION clockgrove.guard_actor_process();

-- A segment is written only under the process's current lease epoch and holder, continues from its
-- checkpoint, and advances that checkpoint in the same statement. A stale epoch is refused.
CREATE FUNCTION clockgrove.append_actor_process_segment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, clockgrove
AS $$
DECLARE
  process clockgrove.actor_processes%ROWTYPE;
BEGIN
  SELECT * INTO process FROM clockgrove.actor_processes
   WHERE tenant_id = NEW.tenant_id AND process_id = NEW.process_id FOR UPDATE;
  IF NOT FOUND OR process.state <> 'active' THEN
    RAISE EXCEPTION 'a segment belongs to an active process' USING ERRCODE = 'CG020';
  END IF;
  IF NEW.lease_epoch <> process.lease_epoch OR NEW.lease_holder IS DISTINCT FROM process.lease_holder THEN
    RAISE EXCEPTION 'stale process lease' USING ERRCODE = 'CG022';
  END IF;
  IF NEW.segment <> process.segments + 1 OR NEW.from_checkpoint <> process.checkpoint
     OR NEW.to_checkpoint > process.target THEN
    RAISE EXCEPTION 'a segment continues its process' USING ERRCODE = 'CG020';
  END IF;
  UPDATE clockgrove.actor_processes
     SET checkpoint = NEW.to_checkpoint, segments = NEW.segment,
         state = CASE WHEN NEW.to_checkpoint = process.target THEN 'completed' ELSE 'active' END
   WHERE tenant_id = NEW.tenant_id AND process_id = NEW.process_id;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION clockgrove.append_actor_process_segment() FROM PUBLIC;
CREATE TRIGGER actor_process_segments_append
  BEFORE INSERT ON clockgrove.actor_process_segments
  FOR EACH ROW EXECUTE FUNCTION clockgrove.append_actor_process_segment();
