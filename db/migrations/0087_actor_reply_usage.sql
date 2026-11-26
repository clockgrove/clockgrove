-- Issue 329: the actor-reply shadow (issue 271, bound by `ACTOR_REPLY_SHADOW_CONFIG`) makes a model
-- call for every committed reply. Its record was only a log line, so that call was spend the
-- developer never saw. It is now kept as one durable, contentless record per reply, and that record
-- is a usage event like a wake triage's or a moderation shadow's (`record_shadow_usage`, 0082).
ALTER TABLE clockgrove.usage_events DROP CONSTRAINT usage_events_source_check,
  ADD CONSTRAINT usage_events_source_check CHECK (
    source IN ('run_step', 'delivery_receipt', 'wake_triage', 'moderation_shadow',
      'offer_presentation', 'actor_reply_shadow'));

-- One immutable record per turn fiber whose reply was judged: opaque IDs, closed codes and numbers,
-- never the reply's text or a hash of it. Row-level security with no policy and no grant: the
-- runtime writes it only through `record_actor_reply_shadow`, and reads it as usage events.
CREATE TABLE clockgrove.actor_reply_shadow (
  tenant_id text NOT NULL,
  world_id text NOT NULL,
  timeline_id text NOT NULL,
  space_id text NOT NULL,
  actor_id text NOT NULL,
  session_id text NOT NULL,
  message_id text NOT NULL,
  principal_id text NOT NULL,
  simulation_time bigint NOT NULL,
  record jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (tenant_id, session_id, message_id),
  FOREIGN KEY (tenant_id, session_id, message_id)
    REFERENCES clockgrove.conversation_turn_fibers (tenant_id, session_id, message_id)
);
ALTER TABLE clockgrove.actor_reply_shadow ENABLE ROW LEVEL SECURITY;
ALTER TABLE clockgrove.actor_reply_shadow FORCE ROW LEVEL SECURITY;
REVOKE ALL ON clockgrove.actor_reply_shadow FROM PUBLIC;
CREATE TRIGGER actor_reply_shadow_no_delete BEFORE DELETE ON clockgrove.actor_reply_shadow
  FOR EACH ROW EXECUTE FUNCTION clockgrove.reject_journal_mutation();
CREATE TRIGGER actor_reply_shadow_no_truncate BEFORE TRUNCATE ON clockgrove.actor_reply_shadow
  FOR EACH STATEMENT EXECUTE FUNCTION clockgrove.reject_journal_mutation();

-- Records the judgement of the turn's committed reply, once, as the turn's own participant. The
-- record must name this turn and its actor and stay contentless; its `usage` becomes the event's
-- quantities through `shadow_usage_quantities`, so a nonconforming count is unknown, never a number.
-- Decision: cap a record at 16 KiB, as a moderation shadow's.
CREATE FUNCTION clockgrove.record_actor_reply_shadow(t text, s text, m text, evidence jsonb)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clockgrove AS $$
DECLARE
  f clockgrove.conversation_turn_fibers%ROWTYPE;
  sess clockgrove.conversation_sessions%ROWTYPE;
  sim bigint;
BEGIN
  SELECT * INTO f FROM clockgrove.conversation_turn_fibers x
   WHERE x.tenant_id = t AND x.session_id = s AND x.message_id = m;
  IF NOT FOUND OR f.principal_id IS DISTINCT FROM clockgrove.runtime_principal_id()
     OR NOT clockgrove.runtime_can_access(t, 'conversation')
     OR NOT clockgrove.runtime_conversation_participant(t, s) THEN
    RAISE EXCEPTION 'actor reply shadow refused' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO sess FROM clockgrove.conversation_sessions x
   WHERE x.tenant_id = t AND x.session_id = s AND x.state <> 'deleted';
  IF NOT FOUND
     OR jsonb_typeof(evidence) IS DISTINCT FROM 'object' OR octet_length(evidence::text) > 16384
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(CASE WHEN jsonb_typeof(evidence) = 'object'
       THEN evidence ELSE '{}'::jsonb END) k WHERE k <> ALL(ARRAY[
       'schemaVersion', 'pointId', 'mode', 'tenantId', 'worldId', 'actorId', 'sessionId',
       'messageId', 'policyVersion', 'modelAlias', 'model', 'status', 'severe', 'categories',
       'confidenceBp', 'latencyMs', 'costMicrousd', 'detail', 'usage']))
     OR evidence->'schemaVersion' IS DISTINCT FROM '1'::jsonb
     OR evidence->>'pointId' IS DISTINCT FROM 'actor-reply-shadow'
     OR evidence->>'mode' IS DISTINCT FROM 'shadow'
     OR evidence->>'tenantId' IS DISTINCT FROM t OR evidence->>'worldId' IS DISTINCT FROM f.world_id
     OR evidence->>'sessionId' IS DISTINCT FROM s OR evidence->>'messageId' IS DISTINCT FROM m
     OR evidence->>'actorId' IS DISTINCT FROM f.actor_id
     OR coalesce(evidence->>'status', '') NOT IN ('judged', 'cant-tell', 'failed', 'skipped')
     OR jsonb_typeof(evidence->'model') NOT IN ('string', 'null')
     OR jsonb_typeof(evidence->'detail') NOT IN ('string', 'null')
     OR jsonb_typeof(evidence->'severe') NOT IN ('boolean', 'null')
     OR jsonb_typeof(evidence->'categories') NOT IN ('object', 'null')
     OR jsonb_typeof(evidence->'usage') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'actor reply shadow refused' USING ERRCODE = '42501';
  END IF;
  SELECT p.simulation_time INTO sim FROM clockgrove.partition_states p
   WHERE p.tenant_id = t AND p.world_id = f.world_id AND p.timeline_id = f.timeline_id
     AND p.partition_id = sess.partition_id;
  IF sim IS NULL THEN RAISE EXCEPTION 'actor reply shadow state missing'; END IF;
  INSERT INTO clockgrove.actor_reply_shadow (tenant_id, world_id, timeline_id, space_id, actor_id,
    session_id, message_id, principal_id, simulation_time, record)
  VALUES (t, f.world_id, f.timeline_id, sess.space_id, f.actor_id, s, m, f.principal_id, sim,
    evidence)
  ON CONFLICT (tenant_id, session_id, message_id) DO NOTHING;
END $$;
REVOKE ALL ON FUNCTION clockgrove.record_actor_reply_shadow(text, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clockgrove.record_actor_reply_shadow(text, text, text, jsonb)
  TO clockgrove_runtime;

-- Its usage event, written at commit by 0082's shadow trigger: source and event-id prefix
-- `actor_reply_shadow`, the record's model as the resource and its conforming `usage`.
CREATE CONSTRAINT TRIGGER actor_reply_shadow_usage
  AFTER INSERT ON clockgrove.actor_reply_shadow
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION clockgrove.record_shadow_usage();
