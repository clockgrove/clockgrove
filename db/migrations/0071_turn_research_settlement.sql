-- Issue 349: a research step reserves the worst case of its own measured request, which the
-- gateway's byte measure overstates several times over. Once the step's cost is known, the unused
-- part of its reservation is released, so the turn's shared envelope holds what was spent plus the
-- worst case of the step in flight. A step whose cost is unknown keeps its whole reservation.
-- Both counters only grow, so research accounting still never decreases.
ALTER TABLE clockgrove.conversation_turn_fibers
  ADD COLUMN research_released_microusd bigint NOT NULL DEFAULT 0
    CHECK (research_released_microusd BETWEEN 0 AND 9007199254740991),
  ADD COLUMN research_step_reserved_microusd bigint NOT NULL DEFAULT 0
    CHECK (research_step_reserved_microusd BETWEEN 0 AND 9007199254740991),
  ADD CONSTRAINT conversation_turn_fibers_research_released_check
    CHECK (research_released_microusd <= research_reserved_microusd);

CREATE FUNCTION clockgrove.guard_turn_research_release()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,clockgrove AS $$
BEGIN
  IF TG_OP='INSERT' AND (NEW.research_released_microusd<>0 OR NEW.research_step_reserved_microusd<>0)
     OR TG_OP='UPDATE' AND NEW.research_released_microusd<OLD.research_released_microusd THEN
    RAISE EXCEPTION 'research accounting never decreases' USING ERRCODE='CG020';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION clockgrove.guard_turn_research_release() FROM PUBLIC;
CREATE TRIGGER conversation_turn_fibers_research_release
  BEFORE INSERT OR UPDATE ON clockgrove.conversation_turn_fibers
  FOR EACH ROW EXECUTE FUNCTION clockgrove.guard_turn_research_release();

-- Same signature, authorization and grants as migration 0060; the envelope now counts what is
-- still held (reserved less released), and the step's own reservation is kept for its settlement.
CREATE OR REPLACE FUNCTION clockgrove.reserve_turn_model_step(
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
  IF reserve_cost>max_cost-(f.research_reserved_microusd-f.research_released_microusd)-tool_cost THEN
    RETURN 'cost_budget_exhausted';
  END IF;
  UPDATE clockgrove.conversation_turn_fibers
    SET research_max_model_steps=coalesce(research_max_model_steps,max_steps),
        research_max_cost_microusd=coalesce(research_max_cost_microusd,max_cost),
        research_model_steps=research_model_steps+1,
        research_reserved_microusd=research_reserved_microusd+reserve_cost,
        research_step_reserved_microusd=reserve_cost
    WHERE tenant_id=t AND session_id=s AND message_id=m;
  RETURN 'reserved';
END $$;

-- Settles the step in flight once its answer is recorded: a known cost releases the rest of the
-- step's reservation; an unknown one (null) releases nothing. A second call releases nothing more.
CREATE FUNCTION clockgrove.settle_turn_model_step(
  t text, s text, m text, epoch bigint, known_cost bigint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,clockgrove AS $$
BEGIN
  IF NOT clockgrove.runtime_can_access(t,'conversation')
     OR NOT clockgrove.runtime_conversation_participant(t,s)
     OR known_cost<0 THEN
    RAISE EXCEPTION 'model settlement refused' USING ERRCODE='42501';
  END IF;
  UPDATE clockgrove.conversation_turn_fibers
    SET research_released_microusd=research_released_microusd
          +CASE WHEN known_cost IS NULL THEN 0 ELSE greatest(0,research_step_reserved_microusd-known_cost) END,
        research_step_reserved_microusd=0
    WHERE tenant_id=t AND session_id=s AND message_id=m
      AND principal_id=clockgrove.runtime_principal_id()
      AND lease_epoch=epoch AND phase='model_running' AND research_step_reserved_microusd>0;
END $$;
REVOKE ALL ON FUNCTION clockgrove.settle_turn_model_step(text,text,text,bigint,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clockgrove.settle_turn_model_step(text,text,text,bigint,bigint) TO clockgrove_runtime;
