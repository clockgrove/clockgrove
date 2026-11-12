-- Issue 165: research checkpoints belong to the existing participant-isolated, retained fiber.
-- The history is an encrypted private-cognition artifact; counters and run links contain no text.
ALTER TABLE clockgrove.conversation_turn_fibers
  DROP CONSTRAINT conversation_turn_fibers_phase_check,
  ADD CONSTRAINT conversation_turn_fibers_phase_check CHECK (phase IN (
    'accepted','context_pending','context_ready','model_running','proposal_validating',
    'tool_waiting','tool_completed','committing','finalizing','completed','rejected',
    'cancelled','failed','abandoned')),
  ADD COLUMN research_artifact_id text,
  ADD COLUMN research_privacy_class text NOT NULL DEFAULT 'private_cognition' CHECK (research_privacy_class='private_cognition'),
  ADD COLUMN research_max_model_steps integer CHECK(research_max_model_steps>0),
  ADD COLUMN research_max_cost_microusd bigint CHECK(research_max_cost_microusd BETWEEN 1 AND 9007199254740991),
  ADD COLUMN research_model_steps integer NOT NULL DEFAULT 0 CHECK (research_model_steps>=0),
  ADD COLUMN research_model_answers integer NOT NULL DEFAULT 0 CHECK (research_model_answers>=0 AND research_model_answers<=research_model_steps),
  ADD COLUMN research_reserved_microusd bigint NOT NULL DEFAULT 0 CHECK (research_reserved_microusd BETWEEN 0 AND 9007199254740991),
  ADD COLUMN research_known_cost_microusd bigint NOT NULL DEFAULT 0 CHECK (research_known_cost_microusd BETWEEN 0 AND 9007199254740991),
  ADD COLUMN research_unknown_cost_count integer NOT NULL DEFAULT 0 CHECK (research_unknown_cost_count>=0),
  ADD FOREIGN KEY(tenant_id,research_artifact_id,research_privacy_class)
    REFERENCES clockgrove.artifact_references(tenant_id,artifact_id,privacy_class);
GRANT UPDATE(research_max_model_steps,research_max_cost_microusd,research_artifact_id,research_model_steps,research_model_answers,research_reserved_microusd,
  research_known_cost_microusd,research_unknown_cost_count)
  ON clockgrove.conversation_turn_fibers TO clockgrove_runtime;
ALTER TABLE clockgrove.effect_intents DROP CONSTRAINT effect_intents_capability_id_check,
  ADD CONSTRAINT effect_intents_capability_id_check CHECK(octet_length(capability_id) BETWEEN 1 AND 4096);
ALTER TABLE clockgrove.run_steps DROP CONSTRAINT run_steps_tool_check,
  ADD CONSTRAINT run_steps_tool_check CHECK(octet_length(tool) BETWEEN 1 AND 4096);
ALTER TABLE clockgrove.run_steps ADD COLUMN tool_evidence jsonb
  CHECK (tool_evidence IS NULL OR jsonb_typeof(tool_evidence)='object' AND octet_length(tool_evidence::text)<=16384);
CREATE OR REPLACE FUNCTION clockgrove.guard_turn_fiber()
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
       OR NEW.proposal_artifact_id IS NOT NULL OR NEW.research_artifact_id IS NOT NULL
       OR NEW.research_model_steps<>0 OR NEW.research_model_answers<>0
       OR NEW.research_reserved_microusd<>0 OR NEW.research_known_cost_microusd<>0
       OR NEW.research_unknown_cost_count<>0 OR NEW.research_max_model_steps IS NOT NULL
       OR NEW.research_max_cost_microusd IS NOT NULL THEN
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
  IF NOT (OLD.phase = 'tool_completed' AND NEW.phase = 'model_running')
     AND NEW.phase = ANY (phases)
     AND array_position(phases, NEW.phase) < array_position(phases, OLD.phase) THEN
    RAISE EXCEPTION 'a turn phase only moves forward' USING ERRCODE = 'CG020';
  END IF;
  IF NOT (OLD.phase = 'tool_completed' AND NEW.phase = 'model_running' AND NEW.reply_artifact_id IS NULL AND NEW.proposal_artifact_id IS NULL OR OLD.phase='proposal_validating' AND NEW.phase='committing' AND NEW.proposal_artifact_id IS NULL AND NEW.outcome_code IN ('model_unavailable','model_steps_exhausted','cost_budget_exhausted','tool_calls_exhausted'))
     AND OLD.reply_artifact_id IS NOT NULL AND NEW.reply_artifact_id IS DISTINCT FROM OLD.reply_artifact_id THEN
    RAISE EXCEPTION 'a checkpointed answer never changes' USING ERRCODE = 'CG020';
  END IF;
  IF NOT (OLD.phase = 'tool_completed' AND NEW.phase = 'model_running' AND NEW.reply_artifact_id IS NULL AND NEW.proposal_artifact_id IS NULL OR OLD.phase='proposal_validating' AND NEW.phase='committing' AND NEW.proposal_artifact_id IS NULL AND NEW.outcome_code IN ('model_unavailable','model_steps_exhausted','cost_budget_exhausted','tool_calls_exhausted'))
     AND NEW.proposal_artifact_id IS DISTINCT FROM OLD.proposal_artifact_id
     AND (OLD.reply_artifact_id IS NOT NULL OR NEW.reply_artifact_id IS NULL) THEN
    RAISE EXCEPTION 'a proposal is checkpointed only with its answer' USING ERRCODE = 'CG020';
  END IF;
  IF NEW.phase IN ('tool_waiting','tool_completed') AND NOT (
      OLD.phase='proposal_validating' AND NEW.phase='tool_waiting' OR
      OLD.phase='tool_waiting' AND NEW.phase='tool_completed' OR OLD.phase=NEW.phase) THEN
    RAISE EXCEPTION 'invalid tool checkpoint' USING ERRCODE='CG020';
  END IF;
  IF OLD.phase IN ('tool_waiting','tool_completed') AND NEW.phase NOT IN
      (OLD.phase,'tool_completed','cancelled','failed','abandoned')
      AND NOT (OLD.phase='tool_completed' AND NEW.phase='model_running') THEN
    RAISE EXCEPTION 'tool result required before resume' USING ERRCODE='CG020';
  END IF;
  IF OLD.research_max_model_steps IS NOT NULL AND NEW.research_max_model_steps IS DISTINCT FROM OLD.research_max_model_steps
     OR OLD.research_max_cost_microusd IS NOT NULL AND NEW.research_max_cost_microusd IS DISTINCT FROM OLD.research_max_cost_microusd THEN
    RAISE EXCEPTION 'initial research envelope is immutable' USING ERRCODE='CG020';
  END IF;
  IF NEW.research_model_answers < OLD.research_model_answers
     OR NEW.research_model_steps < OLD.research_model_steps
     OR NEW.research_reserved_microusd < OLD.research_reserved_microusd
     OR NEW.research_known_cost_microusd < OLD.research_known_cost_microusd
     OR NEW.research_unknown_cost_count < OLD.research_unknown_cost_count THEN
    RAISE EXCEPTION 'research accounting never decreases' USING ERRCODE='CG020';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

-- The narrow definer can see effect reservations without granting the participant the ledger.
-- Both admission and model reservation lock the fiber before examining the shared cost envelope.
CREATE FUNCTION clockgrove.reserve_turn_model_step(
  t text, s text, m text, epoch bigint, max_steps integer, max_cost bigint, reserve_cost bigint)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,clockgrove AS $$
DECLARE f clockgrove.conversation_turn_fibers%ROWTYPE; tool_cost bigint;
BEGIN
  IF NOT clockgrove.runtime_can_access(t,'conversation')
     OR NOT clockgrove.runtime_conversation_participant(t,s)
     OR max_steps<=0 OR max_cost<=0 OR reserve_cost<=0 THEN
    RAISE EXCEPTION 'model reservation refused' USING ERRCODE='42501';
  END IF;
  SELECT * INTO f FROM clockgrove.conversation_turn_fibers
    WHERE tenant_id=t AND session_id=s AND message_id=m AND principal_id=clockgrove.runtime_principal_id() FOR UPDATE;
  IF NOT FOUND OR f.lease_epoch<>epoch OR f.phase<>'model_running' THEN RETURN 'fenced'; END IF;
  max_steps:=least(max_steps,coalesce(f.research_max_model_steps,max_steps));
  max_cost:=least(max_cost,coalesce(f.research_max_cost_microusd,max_cost));
  IF f.research_model_steps>=max_steps THEN RETURN 'model_steps_exhausted'; END IF;
  SELECT coalesce(sum(i.reserved_microusd),0) INTO tool_cost
    FROM clockgrove.mcp_read_admissions a JOIN clockgrove.effect_intents i
      USING(tenant_id,world_id,timeline_id,effect_id)
    WHERE a.tenant_id=t AND a.world_id=f.world_id AND a.timeline_id=f.timeline_id
      AND a.identity->>'sessionId'=s AND a.identity->>'turnId'=m AND a.admitted;
  IF reserve_cost>max_cost-f.research_reserved_microusd-tool_cost THEN RETURN 'cost_budget_exhausted'; END IF;
  UPDATE clockgrove.conversation_turn_fibers
    SET research_max_model_steps=coalesce(research_max_model_steps,max_steps),
        research_max_cost_microusd=coalesce(research_max_cost_microusd,max_cost),
        research_model_steps=research_model_steps+1,
        research_reserved_microusd=research_reserved_microusd+reserve_cost
    WHERE tenant_id=t AND session_id=s AND message_id=m;
  RETURN 'reserved';
END $$;
REVOKE ALL ON FUNCTION clockgrove.reserve_turn_model_step(text,text,text,bigint,integer,bigint,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clockgrove.reserve_turn_model_step(text,text,text,bigint,integer,bigint,bigint) TO clockgrove_runtime;
