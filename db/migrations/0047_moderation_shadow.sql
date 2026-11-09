-- Issue 162: a private shadow annotation, held beside the immutable message. Reserving before
-- calling the model makes retries/recovery observational and prevents another provider call.
CREATE TABLE clockgrove.moderation_shadow (
  tenant_id text NOT NULL,
  world_id text NOT NULL,
  timeline_id text NOT NULL,
  space_id text NOT NULL,
  actor_id text NOT NULL,
  session_id text NOT NULL,
  message_id text NOT NULL,
  principal_id text NOT NULL,
  simulation_time bigint NOT NULL,
  record jsonb,
  PRIMARY KEY (tenant_id,session_id,message_id),
  FOREIGN KEY (tenant_id,session_id,message_id)
    REFERENCES clockgrove.conversation_turn_fibers (tenant_id,session_id,message_id)
);
ALTER TABLE clockgrove.moderation_shadow ENABLE ROW LEVEL SECURITY;
ALTER TABLE clockgrove.moderation_shadow FORCE ROW LEVEL SECURITY;
CREATE POLICY moderation_shadow_participant ON clockgrove.moderation_shadow FOR SELECT USING (
  clockgrove.runtime_can_access(tenant_id,'conversation')
  AND clockgrove.runtime_conversation_participant(tenant_id,session_id)
  AND EXISTS (SELECT 1 FROM clockgrove.conversation_sessions s WHERE s.tenant_id=moderation_shadow.tenant_id
    AND s.session_id=moderation_shadow.session_id AND s.state<>'deleted'));
REVOKE ALL ON clockgrove.moderation_shadow FROM PUBLIC;
GRANT SELECT ON clockgrove.moderation_shadow TO clockgrove_runtime;
CREATE TRIGGER moderation_shadow_no_delete BEFORE DELETE OR TRUNCATE ON clockgrove.moderation_shadow
  FOR EACH STATEMENT EXECUTE FUNCTION clockgrove.reject_journal_mutation();

CREATE FUNCTION clockgrove.reserve_moderation_shadow(t text,s text,m text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,clockgrove AS $$
DECLARE f record; sess record; sim bigint; previous record; route record;
BEGIN
  SELECT * INTO f FROM clockgrove.conversation_turn_fibers WHERE tenant_id=t AND session_id=s AND message_id=m;
  IF NOT FOUND OR f.principal_id<>clockgrove.runtime_principal_id()
    OR NOT clockgrove.runtime_can_access(t,'conversation')
    OR NOT clockgrove.runtime_conversation_participant(t,s)
    OR starts_with(m,'activation:')
    THEN RAISE EXCEPTION 'moderation shadow refused'; END IF;
  SELECT * INTO sess FROM clockgrove.conversation_sessions WHERE tenant_id=t AND session_id=s AND state<>'deleted';
  IF NOT FOUND THEN RAISE EXCEPTION 'moderation shadow refused'; END IF;
  SELECT simulation_time INTO sim FROM clockgrove.partition_states
    WHERE tenant_id=t AND world_id=f.world_id AND timeline_id=f.timeline_id AND partition_id=sess.partition_id;
  IF sim IS NULL THEN RAISE EXCEPTION 'moderation shadow state missing'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('moderation:'||t||':'||s||':'||m,0));
  SELECT stream_id INTO route FROM clockgrove.streams WHERE tenant_id=t AND world_id=f.world_id
    AND timeline_id=f.timeline_id AND partition_id=sess.partition_id AND space_id=sess.space_id ORDER BY stream_id LIMIT 1;
  SELECT * INTO previous FROM clockgrove.moderation_shadow WHERE tenant_id=t AND session_id=s AND message_id=m;
  IF FOUND THEN
    RETURN jsonb_build_object('existing',true,'record',previous.record,'simulationTime',previous.simulation_time::text,
      'partitionId',sess.partition_id,'streamId',route.stream_id);
  END IF;
  INSERT INTO clockgrove.moderation_shadow
    (tenant_id,world_id,timeline_id,space_id,actor_id,session_id,message_id,principal_id,simulation_time)
    VALUES (t,f.world_id,f.timeline_id,sess.space_id,f.actor_id,s,m,f.principal_id,sim);
  RETURN jsonb_build_object('existing',false,'record',null,'simulationTime',sim::text,
    'partitionId',sess.partition_id,'streamId',route.stream_id);
END $$;
REVOKE ALL ON FUNCTION clockgrove.reserve_moderation_shadow(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clockgrove.reserve_moderation_shadow(text,text,text) TO clockgrove_runtime;

CREATE FUNCTION clockgrove.finish_moderation_shadow(t text,s text,m text,evidence jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,clockgrove AS $$
DECLARE stored jsonb;
BEGIN
  -- Decision: cap an annotation at 16 KiB, matching wake-triage evidence and bounding metadata reads.
  IF NOT clockgrove.runtime_can_access(t,'conversation') OR NOT clockgrove.runtime_conversation_participant(t,s)
    OR jsonb_typeof(evidence) IS DISTINCT FROM 'object'
    OR octet_length(evidence::text)>16384 OR evidence->>'mode' IS DISTINCT FROM 'shadow'
    OR NOT evidence ?& ARRAY['schemaVersion','pointId','sessionId','messageId','actorId','simulationTime',
      'policyVersion','confidenceThreshold','inputSha256','signature','detail','mode','status',
      'disposition','injection','confidenceBp','modelAlias','model','latencyMs','costMicrousd']
    OR EXISTS (SELECT 1 FROM jsonb_object_keys(CASE WHEN jsonb_typeof(evidence)='object' THEN evidence ELSE '{}'::jsonb END) k WHERE k<>ALL(ARRAY[
      'schemaVersion','pointId','sessionId','messageId','actorId','simulationTime','policyVersion',
      'confidenceThreshold','inputSha256','signature','detail','mode','status','disposition','injection',
      'confidenceBp','modelAlias','model','latencyMs','costMicrousd']))
    OR evidence->'schemaVersion' IS DISTINCT FROM '1'::jsonb
    OR evidence->>'pointId' IS DISTINCT FROM 'moderation-shadow'
    OR coalesce(evidence->>'status','') NOT IN ('picked','low-confidence','cant-tell','failed','skipped')
    OR jsonb_typeof(evidence->'disposition') NOT IN ('string','null')
    OR (evidence->'disposition'<>'null'::jsonb AND evidence->>'disposition' NOT IN ('allow','flag','block'))
    OR jsonb_typeof(evidence->'injection') NOT IN ('boolean','null')
    OR jsonb_typeof(evidence->'model') NOT IN ('string','null')
    OR jsonb_typeof(evidence->'detail') NOT IN ('string','null')
    OR jsonb_typeof(evidence->'modelAlias') IS DISTINCT FROM 'string'
    OR length(evidence->>'modelAlias')=0
    OR jsonb_typeof(evidence->'policyVersion') IS DISTINCT FROM 'string'
    OR length(evidence->>'policyVersion')=0
    OR coalesce(evidence->>'inputSha256','') !~ '^[0-9a-f]{64}$'
    OR coalesce(evidence->>'signature','') !~ '^moderation_[0-9a-f]{32}$'
    OR coalesce(evidence->>'simulationTime','') !~ '^[0-9]+$'
    OR EXISTS (SELECT 1 FROM (VALUES ('confidenceBp'),('latencyMs'),('costMicrousd')) AS fields(name)
      WHERE evidence->name<>'null'::jsonb AND (jsonb_typeof(evidence->name)<>'number'
        OR evidence->>name !~ '^[0-9]+$'
        OR CASE WHEN evidence->>name ~ '^[0-9]+$' THEN (evidence->>name)::numeric>9007199254740991 ELSE false END))
    OR (CASE WHEN evidence->>'confidenceBp' ~ '^[0-9]+$' THEN (evidence->>'confidenceBp')::numeric>10000 ELSE false END)
    OR jsonb_typeof(evidence->'confidenceThreshold') IS DISTINCT FROM 'number'
    OR coalesce(evidence->>'confidenceThreshold','') !~ '^[0-9]+$'
    OR (CASE WHEN evidence->>'confidenceThreshold' ~ '^[0-9]+$' THEN (evidence->>'confidenceThreshold')::numeric>10000 ELSE false END)
    OR evidence->>'sessionId' IS DISTINCT FROM s OR evidence->>'messageId' IS DISTINCT FROM m
    OR evidence->>'actorId' IS DISTINCT FROM (SELECT actor_id FROM clockgrove.moderation_shadow
      WHERE tenant_id=t AND session_id=s AND message_id=m AND principal_id=clockgrove.runtime_principal_id())
    OR NOT EXISTS (SELECT 1 FROM clockgrove.conversation_sessions WHERE tenant_id=t AND session_id=s AND state<>'deleted')
    THEN RAISE EXCEPTION 'moderation shadow refused'; END IF;
  UPDATE clockgrove.moderation_shadow SET record=evidence WHERE tenant_id=t AND session_id=s AND message_id=m
    AND principal_id=clockgrove.runtime_principal_id() AND record IS NULL;
  SELECT record INTO stored FROM clockgrove.moderation_shadow WHERE tenant_id=t AND session_id=s AND message_id=m
    AND principal_id=clockgrove.runtime_principal_id();
  IF stored IS NULL THEN RAISE EXCEPTION 'moderation shadow refused'; END IF;
  RETURN stored;
END $$;
REVOKE ALL ON FUNCTION clockgrove.finish_moderation_shadow(text,text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clockgrove.finish_moderation_shadow(text,text,text,jsonb) TO clockgrove_runtime;
