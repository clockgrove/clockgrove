-- Issue 329, part 2: model calls made outside a run (wake triage, moderation shadow) are usage
-- events too, written from the durable shadow record when it is finished.
ALTER TABLE clockgrove.usage_events DROP CONSTRAINT usage_events_source_check,
  ADD CONSTRAINT usage_events_source_check CHECK (
    source IN ('run_step', 'delivery_receipt', 'wake_triage', 'moderation_shadow'));

-- One event per shadow decision whose record is finished: the model call a wake triage or a
-- moderation shadow made outside any run. `calls` is 1 only when the record shows a call was made
-- (it carries a latency); the provider's token counts are not recorded, so they stay unknown.
-- The source and the event id's prefix are the table's name.
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
    NEW.actor_id, NEW.session_id,
    jsonb_build_object('inputTokens', NULL, 'cachedInputTokens', NULL,
      'cacheWriteInputTokens', NULL, 'outputTokens', NULL, 'reasoningTokens', NULL,
      'calls', CASE WHEN jsonb_typeof(NEW.record->'latencyMs') = 'number' THEN 1 ELSE 0 END),
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
