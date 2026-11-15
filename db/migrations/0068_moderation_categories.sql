-- Issue 271: moderation evidence schema 2 carries the route-changing harm codes, each a yes/no
-- answer or null, beside the disposition. Schema 1 evidence stays valid without them.
CREATE OR REPLACE FUNCTION clockgrove.finish_moderation_shadow(t text,s text,m text,evidence jsonb)
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
    OR (evidence->'schemaVersion'='2'::jsonb AND NOT evidence ? 'categories')
    OR (evidence->'schemaVersion'='1'::jsonb AND evidence ? 'categories')
    OR (evidence ? 'categories' AND jsonb_typeof(evidence->'categories') NOT IN ('object','null'))
    OR (jsonb_typeof(evidence->'categories')='object' AND (
      NOT (evidence->'categories') ?& ARRAY['sexual_minors','harm_to_others','self_harm_intent',
        'self_harm_encouragement','stated_minor']
      OR EXISTS (SELECT 1 FROM jsonb_each(evidence->'categories') c
        WHERE c.key<>ALL(ARRAY['sexual_minors','harm_to_others','self_harm_intent',
          'self_harm_encouragement','stated_minor']) OR jsonb_typeof(c.value) NOT IN ('boolean','null'))))
    OR EXISTS (SELECT 1 FROM jsonb_object_keys(CASE WHEN jsonb_typeof(evidence)='object' THEN evidence ELSE '{}'::jsonb END) k WHERE k<>ALL(ARRAY[
      'schemaVersion','pointId','sessionId','messageId','actorId','simulationTime','policyVersion',
      'confidenceThreshold','inputSha256','signature','detail','mode','status','disposition','injection',
      'confidenceBp','modelAlias','model','latencyMs','costMicrousd','categories']))
    OR coalesce(evidence->>'schemaVersion','') NOT IN ('1','2')
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
