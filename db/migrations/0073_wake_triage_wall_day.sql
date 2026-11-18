-- Issue 358: the daily triage budget resets once per wall-clock day in the configured zone, whatever
-- the world's day length. The runtime passes that day; the world day stays on the row as evidence.
-- Expand only: rows written before this migration keep a NULL wall_day and count against no
-- wall-clock day. The six-argument function stays in place and is no longer called.
ALTER TABLE clockgrove.wake_triage ADD COLUMN wall_day date;
CREATE INDEX wake_triage_wall_day ON clockgrove.wake_triage (tenant_id,world_id,timeline_id,wall_day);
CREATE FUNCTION clockgrove.reserve_wake_triage(t text,s text,m text,ceiling bigint,daily bigint,day_length bigint,wall_day date)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,clockgrove AS $$
DECLARE f record; sess record; sim bigint; spent bigint; previous record; route record; why text;
  woken text; config jsonb; wakes jsonb; routines jsonb;
BEGIN
  IF ceiling <= 0 OR daily < 0 OR day_length <= 0 OR wall_day IS NULL THEN RAISE EXCEPTION 'invalid wake triage budget'; END IF;
  SELECT * INTO f FROM clockgrove.conversation_turn_fibers WHERE tenant_id=t AND session_id=s AND message_id=m;
  IF NOT FOUND OR f.principal_id<>clockgrove.runtime_principal_id()
    OR NOT clockgrove.runtime_can_access(t,'conversation') THEN RAISE EXCEPTION 'wake triage refused'; END IF;
  SELECT * INTO sess FROM clockgrove.conversation_sessions WHERE tenant_id=t AND session_id=s;
  IF NOT clockgrove.runtime_conversation_participant(t,s)
    THEN RAISE EXCEPTION 'wake triage refused'; END IF;
  SELECT simulation_time INTO sim FROM clockgrove.partition_states
    WHERE tenant_id=t AND world_id=f.world_id AND timeline_id=f.timeline_id AND partition_id=sess.partition_id;
  IF sim IS NULL THEN RAISE EXCEPTION 'wake triage state missing'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(t||':'||f.world_id||':'||f.timeline_id||':'||wall_day::text,0));
  SELECT coalesce(sum(greatest(reserved_microusd,coalesce((record->>'costMicrousd')::bigint,0))),0) INTO spent FROM clockgrove.wake_triage
    WHERE tenant_id=t AND world_id=f.world_id AND timeline_id=f.timeline_id AND wake_triage.wall_day=reserve_wake_triage.wall_day;
  SELECT reason->>'kind',configuration_id INTO why,woken FROM clockgrove.actor_activations
    WHERE tenant_id=t AND world_id=f.world_id AND timeline_id=f.timeline_id AND actor_id=f.actor_id
      AND session_id=s AND message_id=m ORDER BY leader DESC,causal_root LIMIT 1;
  SELECT coalesce(jsonb_agg(jsonb_build_object('reason',w.reason,'evidence',w.evidence)
      ORDER BY w.leader DESC,w.causal_root),'[]'::jsonb) INTO wakes
    FROM (SELECT reason,evidence,leader,causal_root FROM clockgrove.actor_activations
      WHERE tenant_id=t AND world_id=f.world_id AND timeline_id=f.timeline_id AND actor_id=f.actor_id
        AND session_id=s AND message_id=m ORDER BY leader DESC,causal_root LIMIT 4) w;
  SELECT c.value INTO config FROM clockgrove.actor_activation_policies p,
      jsonb_array_elements(p.configurations) c
    WHERE p.tenant_id=t AND p.world_id=f.world_id AND p.timeline_id=f.timeline_id
      AND p.actor_id=f.actor_id AND c.value->>'id'=woken LIMIT 1;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',r.value->>'id','kind',r.value->>'kind',
      'eventType',r.value->>'eventType','input',coalesce(r.value->>'input',''),
      'condition',coalesce(r.value->>'condition','')) ORDER BY r.value->>'id'),'[]'::jsonb) INTO routines
    FROM (SELECT c.value FROM clockgrove.actor_activation_policies p,
        jsonb_array_elements(p.configurations) c
      WHERE config IS NOT NULL AND p.tenant_id=t AND p.world_id=f.world_id
        AND p.timeline_id=f.timeline_id AND p.actor_id=f.actor_id
        AND c.value->>'compiledRoutine'='noop' AND c.value->>'enabled'='true'
        AND c.value->>'kind'=config->>'kind'
        AND (c.value->>'eventType' IS NULL OR c.value->>'eventType'=config->>'eventType')
      ORDER BY c.value->>'id' LIMIT 16) r;
  SELECT stream_id INTO route FROM clockgrove.streams WHERE tenant_id=t AND world_id=f.world_id
    AND timeline_id=f.timeline_id AND partition_id=sess.partition_id AND space_id=sess.space_id ORDER BY stream_id LIMIT 1;
  SELECT * INTO previous FROM clockgrove.wake_triage WHERE tenant_id=t AND session_id=s AND message_id=m;
  IF FOUND THEN
    RETURN jsonb_build_object('existing',true,'record',coalesce(previous.record,
      (SELECT payload FROM clockgrove.events WHERE tenant_id=t AND world_id=f.world_id AND timeline_id=f.timeline_id
        AND event_type='WakeTriageRecorded' AND payload->>'requestId'=s||':'||m LIMIT 1)),
      'reserved',previous.reserved_microusd>0,'simulationTime',previous.simulation_time::text,
      'reason',coalesce(why,'direct_message'),'partitionId',sess.partition_id,'streamId',route.stream_id,
      'wakes',wakes,'routines',routines);
  END IF;
  INSERT INTO clockgrove.wake_triage
    (tenant_id,world_id,timeline_id,space_id,session_id,message_id,principal_id,actor_id,simulation_time,day,wall_day,reserved_microusd)
    VALUES (t,f.world_id,f.timeline_id,sess.space_id,s,m,f.principal_id,f.actor_id,sim,sim/day_length,wall_day,
      CASE WHEN spent+ceiling<=daily THEN ceiling ELSE 0 END);
  RETURN jsonb_build_object('existing',false,'reserved',spent+ceiling<=daily,'simulationTime',sim::text,
    'reason',coalesce(why,'direct_message'),'partitionId',sess.partition_id,'streamId',route.stream_id,
    'wakes',wakes,'routines',routines);
END $$;
REVOKE ALL ON FUNCTION clockgrove.reserve_wake_triage(text,text,text,bigint,bigint,bigint,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clockgrove.reserve_wake_triage(text,text,text,bigint,bigint,bigint,date) TO clockgrove_runtime;
