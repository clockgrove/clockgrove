-- Issue 166: preserve the original tool checkpoint while a human decides.
ALTER TABLE clockgrove.conversation_turn_fibers
  DROP CONSTRAINT conversation_turn_fibers_phase_check,
  ADD CONSTRAINT conversation_turn_fibers_phase_check CHECK (phase IN (
    'accepted','context_pending','context_ready','model_running','proposal_validating',
    'approval_waiting','tool_waiting','tool_completed','committing','finalizing','completed',
    'rejected','cancelled','failed','abandoned'));

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
  IF NEW.phase IN ('tool_waiting','approval_waiting','tool_completed') AND NOT (
      OLD.phase='proposal_validating' AND NEW.phase='tool_waiting' OR
      OLD.phase='tool_waiting' AND NEW.phase IN ('approval_waiting','tool_completed') OR
      OLD.phase='approval_waiting' AND NEW.phase IN ('tool_waiting','tool_completed') OR OLD.phase=NEW.phase) THEN
    RAISE EXCEPTION 'invalid tool checkpoint' USING ERRCODE='CG020';
  END IF;
  IF OLD.phase IN ('tool_waiting','approval_waiting','tool_completed') AND NEW.phase NOT IN
      (OLD.phase,'tool_completed','cancelled','failed','abandoned')
      AND NOT (OLD.phase='tool_waiting' AND NEW.phase='approval_waiting' OR OLD.phase='approval_waiting' AND NEW.phase='tool_waiting')
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

