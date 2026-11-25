-- Issue 329, part 2: model calls made outside a run (wake triage, moderation shadow) are usage
-- events too, written from the durable shadow record when it is finished.
ALTER TABLE clockgrove.usage_events DROP CONSTRAINT usage_events_source_check,
  ADD CONSTRAINT usage_events_source_check CHECK (
    source IN ('run_step', 'delivery_receipt', 'wake_triage', 'moderation_shadow'));

-- A moderation record carries its model call's `usage` ({calls, inputTokens, outputTokens}: calls
-- 0 or 1, or null when unknown; tokens a non-negative integer or null). Records written before it
-- stay valid without it.
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
      'confidenceBp','modelAlias','model','latencyMs','costMicrousd','categories','usage']))
    OR (evidence ? 'usage' AND (jsonb_typeof(evidence->'usage') IS DISTINCT FROM 'object'
      OR NOT (evidence->'usage') ?& ARRAY['calls','inputTokens','outputTokens']
      OR EXISTS (SELECT 1 FROM jsonb_each(CASE WHEN jsonb_typeof(evidence->'usage')='object'
          THEN evidence->'usage' ELSE '{}'::jsonb END) u
        WHERE u.key<>ALL(ARRAY['calls','inputTokens','outputTokens'])
          OR (u.value<>'null'::jsonb AND (jsonb_typeof(u.value)<>'number' OR u.value#>>'{}' !~ '^[0-9]+$'
            OR CASE WHEN u.value#>>'{}' ~ '^[0-9]+$' THEN (u.value#>>'{}')::numeric>9007199254740991 ELSE false END))
          OR (u.key='calls' AND u.value NOT IN ('null'::jsonb,'0'::jsonb,'1'::jsonb)))))
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

-- A shadow record's `usage` is the runtime's claim, so only a conforming value becomes a quantity:
-- a count is a JSON non-negative integer no larger than 2^53 - 1, and `calls` is 0 or 1. Anything
-- else (a negative, a fraction, a string, `calls: 7`, a `usage` that is no object) is unknown,
-- null, never a number. `finish_moderation_shadow` refuses such a record; `finish_wake_triage`
-- (0041) checks only its size, so this is the rule for both.
CREATE FUNCTION clockgrove.shadow_usage_quantities(decision jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, clockgrove AS $$
DECLARE
  usage jsonb := CASE WHEN jsonb_typeof(decision->'usage') = 'object' THEN decision->'usage'
    ELSE '{}'::jsonb END;
  counts jsonb := '{}'::jsonb;
  name text;
  value jsonb;
  absent jsonb;
BEGIN
  FOREACH name IN ARRAY ARRAY['calls', 'inputTokens', 'outputTokens'] LOOP
    value := usage->name;
    IF (jsonb_typeof(value) IS DISTINCT FROM 'number' OR value#>>'{}' !~ '^[0-9]+$'
      OR (CASE WHEN value#>>'{}' ~ '^[0-9]+$' THEN (value#>>'{}')::numeric > 9007199254740991
        ELSE false END)
      OR (name = 'calls' AND value NOT IN ('0'::jsonb, '1'::jsonb))) THEN
      value := 'null'::jsonb;
    END IF;
    counts := counts || jsonb_build_object(name, value);
  END LOOP;
  absent := CASE WHEN counts->'calls' = '0'::jsonb THEN '0'::jsonb ELSE 'null'::jsonb END;
  RETURN jsonb_build_object(
    'inputTokens', counts->'inputTokens', 'cachedInputTokens', absent,
    'cacheWriteInputTokens', absent, 'outputTokens', counts->'outputTokens',
    'reasoningTokens', absent, 'calls', counts->'calls');
END;
$$;
REVOKE ALL ON FUNCTION clockgrove.shadow_usage_quantities(jsonb) FROM PUBLIC;

-- One event per shadow decision whose record is finished: the model call a wake triage or a
-- moderation shadow made outside any run. Its quantities are the record's conforming `usage`:
-- `calls` 1 when the call was sent to the provider, 0 when it was refused before (then its tokens
-- are 0), and null when unknown (an interrupted decision whose earlier owner may have called). The
-- decisions endpoint reports no cache or reasoning tokens: unknown, or 0 without a call. A record
-- without `usage` reports nothing known. The source and the event id's prefix are the table's name.
CREATE FUNCTION clockgrove.record_shadow_usage() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clockgrove AS $$
BEGIN
  IF NEW.record IS NULL OR (TG_OP = 'UPDATE' AND OLD.record IS NOT NULL) THEN
    RETURN NULL;
  END IF;
  PERFORM clockgrove.usage_feed_lock(NEW.tenant_id, NEW.world_id, NEW.timeline_id);
  INSERT INTO clockgrove.usage_events (
    tenant_id, event_id, world_id, timeline_id, space_id, category, source, resource, status,
    principal_id, persona_id, actor_id, session_id, quantities, occurred_at, world_time
  ) VALUES (
    NEW.tenant_id,
    TG_TABLE_NAME || ':' || encode(sha256(convert_to(
      jsonb_build_array(NEW.session_id, NEW.message_id)::text, 'UTF8')), 'hex'),
    NEW.world_id, NEW.timeline_id, NEW.space_id, 'model_call', TG_TABLE_NAME, NEW.record->>'model',
    replace(NEW.record->>'status', '-', '_'), NEW.principal_id,
    (SELECT f.persona_id FROM clockgrove.conversation_turn_fibers f
      WHERE f.tenant_id = NEW.tenant_id AND f.session_id = NEW.session_id
        AND f.message_id = NEW.message_id),
    NEW.actor_id, NEW.session_id, clockgrove.shadow_usage_quantities(NEW.record),
    statement_timestamp(), NEW.simulation_time
  ) ON CONFLICT (tenant_id, event_id) DO NOTHING;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION clockgrove.record_shadow_usage() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER wake_triage_usage AFTER INSERT OR UPDATE OF record ON clockgrove.wake_triage
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION clockgrove.record_shadow_usage();
CREATE CONSTRAINT TRIGGER moderation_shadow_usage
  AFTER INSERT OR UPDATE OF record ON clockgrove.moderation_shadow
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION clockgrove.record_shadow_usage();
