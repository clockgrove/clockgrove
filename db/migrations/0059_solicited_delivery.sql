-- Explicit Talk grants one private response; proactive consent remains independent and default off.
CREATE OR REPLACE FUNCTION clockgrove.guard_delivery_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,clockgrove AS $$ DECLARE units bigint; BEGIN
  IF TG_OP='UPDATE' AND (to_jsonb(NEW)-'receipt'-'status') IS DISTINCT FROM (to_jsonb(OLD)-'receipt'-'status') THEN
    RAISE EXCEPTION 'delivery request and reservation are immutable'; END IF;
  IF TG_OP='UPDATE' AND NOT (OLD.status='reserved' AND NEW.status IN ('approved','delayed','downgraded','rejected')
    OR OLD.status='delayed' AND NEW.status IN ('approved','downgraded','rejected')) THEN
    RAISE EXCEPTION 'delivery decision is terminal or still waiting'; END IF;
  IF NOT EXISTS (SELECT 1 FROM clockgrove.conversation_sessions cs
    JOIN clockgrove.channel_bindings cb USING (tenant_id,session_id)
    JOIN clockgrove.artifact_references ar ON ar.tenant_id=cs.tenant_id AND ar.artifact_id=NEW.content_artifact_id
    WHERE cs.tenant_id=NEW.tenant_id AND cs.world_id=NEW.world_id AND cs.timeline_id=NEW.timeline_id
      AND cs.space_id=NEW.space_id AND cs.actor_id=NEW.actor_id AND cs.session_id=NEW.session_id
      AND cs.state<>'deleted' AND cb.principal_id=NEW.principal_id
      AND cb.channel=NEW.request->'channelBinding'->>'channel'
      AND cb.thread_id=NEW.request->'channelBinding'->>'threadId'
      AND ar.world_id=NEW.world_id AND ar.timeline_id=NEW.timeline_id AND ar.space_id=NEW.space_id
      AND ar.privacy_class='conversation' AND ar.encryption='aes-256-gcm-v1'
      AND EXISTS (SELECT 1 FROM clockgrove.conversation_messages cm WHERE cm.tenant_id=NEW.tenant_id
        AND cm.session_id=NEW.session_id AND cm.role='actor' AND cm.author_id=NEW.actor_id
        AND cm.content_artifact_id=NEW.content_artifact_id)) THEN
    RAISE EXCEPTION 'delivery target or encrypted content invalid'; END IF;
  IF NEW.request->'reason'->>'kind'='response' AND NOT EXISTS (
    SELECT 1 FROM clockgrove.conversation_messages input
    JOIN clockgrove.conversation_messages reply ON reply.tenant_id=input.tenant_id
      AND reply.session_id=input.session_id AND reply.sequence=input.sequence+1
    JOIN clockgrove.conversation_turns ct ON ct.tenant_id=input.tenant_id
      AND ct.session_id=input.session_id AND ct.input_sequence=input.sequence
      AND ct.output_sequence=reply.sequence AND ct.principal_id=input.principal_id
    JOIN clockgrove.conversation_turn_fibers f ON f.tenant_id=input.tenant_id
      AND f.session_id=input.session_id AND f.message_id=input.message_id
    WHERE input.tenant_id=NEW.tenant_id AND input.session_id=NEW.session_id
      AND input.message_id=NEW.request->'reason'->>'id' AND input.role='caretaker'
      AND input.principal_id=NEW.principal_id AND reply.role='actor'
      AND reply.author_id=NEW.actor_id AND reply.content_artifact_id=NEW.content_artifact_id
      AND reply.message_id=input.message_id||':reply' AND ct.state='completed'
      AND f.principal_id=NEW.principal_id AND f.phase IN ('committing','finalizing','completed')
      AND NOT EXISTS (SELECT 1 FROM clockgrove.actor_activations aa
        WHERE aa.tenant_id=input.tenant_id AND aa.session_id=input.session_id
          AND aa.message_id=input.message_id)
      AND NEW.dedupe_key='response:'||encode(sha256(convert_to(
        octet_length(NEW.session_id)::text||':'||NEW.session_id||input.message_id,'UTF8')),'hex')
      AND NEW.reservation_id=NEW.dedupe_key
      AND NEW.request->'budgetReservation'->>'units'='1'
      AND NEW.request->>'consentVersion'='0'
      AND NEW.request->>'urgency'='normal' AND NEW.request->>'quietHoursBehavior'='reject'
      AND NEW.request->>'policyVersion'='delivery-policy-v1'
  ) THEN RAISE EXCEPTION 'response requires committed solicited turn'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'reserved' OR NEW.reserved_units<>0 THEN RAISE EXCEPTION 'delivery must reserve first'; END IF;
    units:=(NEW.request->'budgetReservation'->>'units')::bigint;
    IF units IS NULL OR units<=0 OR units>9007199254740991 THEN RAISE EXCEPTION 'invalid reservation units'; END IF;
    IF NEW.request->'reason'->>'kind'='response' THEN
      -- Each committed Talk pair authorizes exactly one unit. The canonical dedupe key and
      -- session's existing message cap bound spending without enabling proactive consent.
      NEW.reserved_units:=1;
    ELSE
    UPDATE clockgrove.delivery_consent SET reserved_units=reserved_units+units
      WHERE tenant_id=NEW.tenant_id AND world_id=NEW.world_id AND timeline_id=NEW.timeline_id
        AND actor_id=NEW.actor_id AND principal_id=NEW.principal_id AND reserved_units<=budget_limit-units;
    IF FOUND THEN NEW.reserved_units:=units; END IF;
    END IF;
    NEW.receipt:=jsonb_set(NEW.receipt,'{reservedUnits}',to_jsonb(NEW.reserved_units));
  END IF;
  IF NEW.status NOT IN ('rejected','reserved') AND NEW.reserved_units<=0 THEN
    RAISE EXCEPTION 'delivery requires budget reservation'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION clockgrove.guard_delivery_record() FROM PUBLIC;

CREATE OR REPLACE FUNCTION clockgrove.guard_delivery_sink() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,clockgrove AS $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM clockgrove.deliveries d
    JOIN clockgrove.timelines t USING (tenant_id,world_id,timeline_id)
    LEFT JOIN clockgrove.delivery_consent c USING (tenant_id,world_id,timeline_id,actor_id,principal_id)
    WHERE d.tenant_id=NEW.tenant_id AND d.world_id=NEW.world_id AND d.timeline_id=NEW.timeline_id
      AND d.space_id=NEW.space_id AND d.actor_id=NEW.actor_id AND d.principal_id=NEW.principal_id
      AND d.dedupe_key=NEW.dedupe_key AND d.content_artifact_id=NEW.content_artifact_id
      AND d.status IN ('approved','downgraded') AND d.reserved_units>0
      AND d.request->>'policyVersion'='delivery-policy-v1'
      AND (d.request->'reason'->>'kind'='response'
        OR (c.enabled AND c.version=(d.request->>'consentVersion')::integer
          AND c.reserved_units>=d.reserved_units))
      AND NEW.sink=CASE WHEN t.kind='live' THEN 'fake' ELSE 'preview' END
      AND d.receipt->>'sink'=NEW.sink) THEN
    RAISE EXCEPTION 'delivery sink requires approved reserved current policy'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION clockgrove.guard_delivery_sink() FROM PUBLIC;
