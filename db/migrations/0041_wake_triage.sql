-- Issue 111: one shadow receipt per actor turn. Reserve the entire configured call ceiling,
-- never refund it: unknown costs and an interrupted call remain bounded across owner replacement.
CREATE TABLE clockgrove.wake_triage (
  tenant_id text NOT NULL,
  world_id text NOT NULL,
  timeline_id text NOT NULL,
  space_id text NOT NULL,
  session_id text NOT NULL,
  message_id text NOT NULL,
  principal_id text NOT NULL,
  actor_id text NOT NULL,
  simulation_time bigint NOT NULL,
  day bigint NOT NULL,
  reserved_microusd bigint NOT NULL CHECK (reserved_microusd >= 0),
  record jsonb,
  PRIMARY KEY (tenant_id, session_id, message_id),
  FOREIGN KEY (tenant_id,session_id,message_id)
    REFERENCES clockgrove.conversation_turn_fibers (tenant_id,session_id,message_id)
);
CREATE INDEX wake_triage_day ON clockgrove.wake_triage (tenant_id,world_id,timeline_id,day);
ALTER TABLE clockgrove.wake_triage ENABLE ROW LEVEL SECURITY;
ALTER TABLE clockgrove.wake_triage FORCE ROW LEVEL SECURITY;
CREATE POLICY wake_triage_operator ON clockgrove.wake_triage FOR SELECT USING (
  clockgrove.runtime_can_access(tenant_id,'operator_evidence') AND EXISTS (
    SELECT 1 FROM clockgrove.world_memberships m WHERE m.tenant_id=wake_triage.tenant_id
      AND m.world_id=wake_triage.world_id AND m.timeline_id=wake_triage.timeline_id
      AND m.space_id=wake_triage.space_id AND m.principal_id=clockgrove.runtime_principal_id()
      AND m.revoked_at IS NULL AND 'runtime:world-command'=ANY(m.grants)));
REVOKE ALL ON clockgrove.wake_triage FROM PUBLIC;
GRANT SELECT ON clockgrove.wake_triage TO clockgrove_runtime;
CREATE TRIGGER wake_triage_no_delete BEFORE DELETE OR TRUNCATE ON clockgrove.wake_triage
  FOR EACH STATEMENT EXECUTE FUNCTION clockgrove.reject_journal_mutation();

CREATE FUNCTION clockgrove.reserve_wake_triage(t text,s text,m text,ceiling bigint,daily bigint,day_length bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,clockgrove AS $$
DECLARE f record; sess record; sim bigint; spent bigint; previous record; route record; why text;
BEGIN
  IF ceiling <= 0 OR daily < 0 OR day_length <= 0 THEN RAISE EXCEPTION 'invalid wake triage budget'; END IF;
  SELECT * INTO f FROM clockgrove.conversation_turn_fibers WHERE tenant_id=t AND session_id=s AND message_id=m;
  IF NOT FOUND OR f.principal_id<>clockgrove.runtime_principal_id()
    OR NOT clockgrove.runtime_can_access(t,'conversation') THEN RAISE EXCEPTION 'wake triage refused'; END IF;
  SELECT * INTO sess FROM clockgrove.conversation_sessions WHERE tenant_id=t AND session_id=s;
  IF NOT clockgrove.runtime_conversation_participant(t,s)
    THEN RAISE EXCEPTION 'wake triage refused'; END IF;
  SELECT simulation_time INTO sim FROM clockgrove.partition_states
    WHERE tenant_id=t AND world_id=f.world_id AND timeline_id=f.timeline_id AND partition_id=sess.partition_id;
  IF sim IS NULL THEN RAISE EXCEPTION 'wake triage state missing'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(t||':'||f.world_id||':'||f.timeline_id||':'||(sim/day_length)::text,0));
  SELECT coalesce(sum(greatest(reserved_microusd,coalesce((record->>'costMicrousd')::bigint,0))),0) INTO spent FROM clockgrove.wake_triage
    WHERE tenant_id=t AND world_id=f.world_id AND timeline_id=f.timeline_id AND day=sim/day_length;
  SELECT reason->>'kind' INTO why FROM clockgrove.actor_activations
    WHERE tenant_id=t AND world_id=f.world_id AND timeline_id=f.timeline_id AND actor_id=f.actor_id
      AND session_id=s AND message_id=m ORDER BY leader DESC,causal_root LIMIT 1;
  SELECT stream_id INTO route FROM clockgrove.streams WHERE tenant_id=t AND world_id=f.world_id
    AND timeline_id=f.timeline_id AND partition_id=sess.partition_id AND space_id=sess.space_id ORDER BY stream_id LIMIT 1;
  SELECT * INTO previous FROM clockgrove.wake_triage WHERE tenant_id=t AND session_id=s AND message_id=m;
  IF FOUND THEN
    RETURN jsonb_build_object('existing',true,'record',coalesce(previous.record,
      (SELECT payload FROM clockgrove.events WHERE tenant_id=t AND world_id=f.world_id AND timeline_id=f.timeline_id
        AND event_type='WakeTriageRecorded' AND payload->>'requestId'=s||':'||m LIMIT 1)),
      'reserved',previous.reserved_microusd>0,'simulationTime',previous.simulation_time::text,
      'reason',coalesce(why,'direct_message'),'partitionId',sess.partition_id,'streamId',route.stream_id);
  END IF;
  INSERT INTO clockgrove.wake_triage
    (tenant_id,world_id,timeline_id,space_id,session_id,message_id,principal_id,actor_id,simulation_time,day,reserved_microusd)
    VALUES (t,f.world_id,f.timeline_id,sess.space_id,s,m,f.principal_id,f.actor_id,sim,sim/day_length,
      CASE WHEN spent+ceiling<=daily THEN ceiling ELSE 0 END);
  SELECT stream_id INTO route FROM clockgrove.streams WHERE tenant_id=t AND world_id=f.world_id
    AND timeline_id=f.timeline_id AND partition_id=sess.partition_id AND space_id=sess.space_id ORDER BY stream_id LIMIT 1;
  RETURN jsonb_build_object('existing',false,'reserved',spent+ceiling<=daily,'simulationTime',sim::text,
    'reason',coalesce(why,'direct_message'),'partitionId',sess.partition_id,'streamId',route.stream_id);
END $$;
REVOKE ALL ON FUNCTION clockgrove.reserve_wake_triage(text,text,text,bigint,bigint,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clockgrove.reserve_wake_triage(text,text,text,bigint,bigint,bigint) TO clockgrove_runtime;

CREATE FUNCTION clockgrove.finish_wake_triage(t text,s text,m text,evidence jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,clockgrove AS $$
BEGIN
  IF NOT clockgrove.runtime_can_access(t,'conversation') OR octet_length(evidence::text)>16384
    THEN RAISE EXCEPTION 'wake triage refused'; END IF;
  UPDATE clockgrove.wake_triage SET record=evidence WHERE tenant_id=t AND session_id=s AND message_id=m
    AND principal_id=clockgrove.runtime_principal_id() AND record IS NULL;
END $$;
REVOKE ALL ON FUNCTION clockgrove.finish_wake_triage(text,text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clockgrove.finish_wake_triage(text,text,text,jsonb) TO clockgrove_runtime;

-- The operator gets metadata, never the participants' prompt, reply or private proposal bytes.
CREATE FUNCTION clockgrove.read_wake_triage_report(t text,w text,tl text,s text)
RETURNS SETOF jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,clockgrove AS $$
BEGIN
  IF NOT clockgrove.runtime_can_access(t,'operator_evidence') OR NOT EXISTS (
    SELECT 1 FROM clockgrove.world_memberships m WHERE m.tenant_id=t AND m.world_id=w AND m.timeline_id=tl
      AND m.space_id=s AND m.principal_id=clockgrove.runtime_principal_id() AND m.revoked_at IS NULL
      AND 'runtime:world-command'=ANY(m.grants)) THEN RAISE EXCEPTION 'wake triage report refused'; END IF;
  RETURN QUERY SELECT jsonb_build_object('record',q.record,'phase',f.phase,
    'proposedCommand', f.proposal_artifact_id IS NOT NULL AND strpos(f.proposal_artifact_id,':command:')>0,
    'outputMessage',EXISTS(SELECT 1 FROM clockgrove.conversation_messages msg
      WHERE msg.tenant_id=q.tenant_id AND msg.session_id=q.session_id
        AND msg.content_artifact_id=f.reply_artifact_id AND msg.role='actor'),
    'costMicrousd',(SELECT CASE WHEN count(*)=count(st.cost_microusd) THEN sum(st.cost_microusd) ELSE NULL END
      FROM clockgrove.agent_runs r JOIN clockgrove.run_steps st ON st.tenant_id=r.tenant_id AND st.run_id=r.run_id
      AND st.kind='model_attempt' WHERE r.tenant_id=q.tenant_id AND r.session_id=q.session_id AND r.input_message_id=q.message_id))
    FROM clockgrove.wake_triage q JOIN clockgrove.conversation_turn_fibers f
      ON f.tenant_id=q.tenant_id AND f.session_id=q.session_id AND f.message_id=q.message_id
    WHERE q.tenant_id=t AND q.world_id=w AND q.timeline_id=tl AND q.space_id=s
    ORDER BY q.simulation_time,q.session_id,q.message_id;
END $$;
REVOKE ALL ON FUNCTION clockgrove.read_wake_triage_report(text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clockgrove.read_wake_triage_report(text,text,text,text) TO clockgrove_runtime;
