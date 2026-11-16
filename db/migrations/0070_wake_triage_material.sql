-- Issue 350: a woken turn is material when its journaled facts show person-visible or durable
-- output: an approved or downgraded delivery for one of its activations, a committed change to
-- the actor's documents, a recorded world command proposal (by step kind, not by artifact id), or
-- a reply in a direct-message turn (the reader derives that from outputMessage and the reason).
CREATE OR REPLACE FUNCTION clockgrove.read_wake_triage_report(t text,w text,tl text,s text)
RETURNS SETOF jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,clockgrove AS $$
BEGIN
  IF NOT clockgrove.runtime_wake_triage_operator(t,w,tl,s) THEN RAISE EXCEPTION 'wake triage report refused'; END IF;
  RETURN QUERY SELECT jsonb_build_object('record',q.record,'phase',f.phase,
    'proposedCommand',EXISTS(SELECT 1 FROM clockgrove.agent_runs r JOIN clockgrove.run_steps st
      ON st.tenant_id=r.tenant_id AND st.run_id=r.run_id AND st.kind='world_command_proposal'
      WHERE r.tenant_id=q.tenant_id AND r.session_id=q.session_id AND r.input_message_id=q.message_id),
    'deliveredMessage',EXISTS(SELECT 1 FROM clockgrove.actor_activations a JOIN clockgrove.deliveries d
      ON d.tenant_id=a.tenant_id AND d.world_id=a.world_id AND d.timeline_id=a.timeline_id
        AND d.actor_id=a.actor_id AND d.principal_id=a.principal_id
        AND d.dedupe_key='activation:'||a.activation_id
        AND d.status IN ('approved','downgraded')
      WHERE a.tenant_id=q.tenant_id AND a.world_id=q.world_id AND a.timeline_id=q.timeline_id
        AND a.actor_id=q.actor_id AND a.session_id=q.session_id AND a.message_id=q.message_id),
    'documentChanged',EXISTS(SELECT 1 FROM clockgrove.agent_runs r JOIN clockgrove.document_change_sets c
      ON c.tenant_id=r.tenant_id AND c.run_id=r.run_id AND c.status='committed'
      WHERE r.tenant_id=q.tenant_id AND r.session_id=q.session_id AND r.input_message_id=q.message_id),
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
