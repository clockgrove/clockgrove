-- Decision (issue 366): an admitted model wake runs its turn in a wake session of the configured
-- session, not in the configured session itself, so a once-a-minute heartbeat cannot fill the
-- person's conversation (1,000 messages). A wake session records the configured session it belongs
-- to and a generation; a new generation opens only when the newest one nears its message limit.
-- Nothing is deleted: the person's sessions and every wake session stay readable.
ALTER TABLE clockgrove.conversation_sessions
  ADD COLUMN wake_of text,
  ADD COLUMN wake_generation integer,
  ADD CONSTRAINT conversation_sessions_wake_pair
    CHECK ((wake_of IS NULL) = (wake_generation IS NULL)),
  ADD CONSTRAINT conversation_sessions_wake_generation
    CHECK (wake_generation >= 1),
  ADD CONSTRAINT conversation_sessions_wake_of_fkey
    FOREIGN KEY (tenant_id, wake_of)
    REFERENCES clockgrove.conversation_sessions (tenant_id, session_id);
CREATE UNIQUE INDEX conversation_sessions_wake
  ON clockgrove.conversation_sessions (tenant_id, wake_of, wake_generation)
  WHERE wake_of IS NOT NULL;

-- `deleted` is terminal, a message count only grows, and only an active session takes messages.
-- Decision: at most 100 sessions that are not deleted per participant and world timeline: a
-- selector lists them whole, and a member who needs more deletes old ones. Wake sessions are not
-- counted and not capped: model wakes bound them, and the selector lists only the newest of each.
CREATE OR REPLACE FUNCTION clockgrove.guard_conversation_session()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, clockgrove
AS $$
DECLARE
  member text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'active' OR NEW.message_count <> 0 OR NEW.title_artifact_id IS NOT NULL THEN
      RAISE EXCEPTION 'a session starts active, empty and untitled' USING ERRCODE = 'CG020';
    END IF;
    IF NEW.wake_of IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM clockgrove.conversation_sessions AS configured
       WHERE configured.tenant_id = NEW.tenant_id AND configured.session_id = NEW.wake_of
         AND configured.world_id = NEW.world_id AND configured.timeline_id = NEW.timeline_id
         AND configured.space_id = NEW.space_id AND configured.actor_id = NEW.actor_id
         AND configured.channel = NEW.channel AND configured.voice_mode = NEW.voice_mode
    ) THEN
      RAISE EXCEPTION 'a wake session belongs to a session of the same actor and space'
        USING ERRCODE = 'CG020';
    END IF;
    IF NEW.wake_of IS NULL THEN
      FOR member IN
        SELECT participant.principal_id FROM clockgrove.conversation_participants AS participant
         WHERE participant.tenant_id = NEW.tenant_id AND participant.session_id = NEW.session_id
         ORDER BY participant.principal_id
      LOOP
        PERFORM pg_advisory_xact_lock(hashtext(
          'conversation:' || NEW.tenant_id || ':' || member || ':' || NEW.world_id || ':'
          || NEW.timeline_id
        ));
        IF (SELECT count(*) FROM clockgrove.conversation_sessions AS open
              JOIN clockgrove.conversation_participants AS participant
                ON participant.tenant_id = open.tenant_id
               AND participant.session_id = open.session_id
             WHERE open.tenant_id = NEW.tenant_id AND participant.principal_id = member
               AND open.world_id = NEW.world_id AND open.timeline_id = NEW.timeline_id
               AND open.wake_of IS NULL
               AND open.state <> 'deleted') >= 100 THEN
          RAISE EXCEPTION 'conversation session limit reached' USING ERRCODE = 'CG021';
        END IF;
      END LOOP;
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state = 'deleted' THEN
    RAISE EXCEPTION 'a deleted session never changes' USING ERRCODE = 'CG020';
  END IF;
  IF NEW.message_count < OLD.message_count
     OR (NEW.message_count > OLD.message_count AND OLD.state <> 'active') THEN
    RAISE EXCEPTION 'messages only grow, and only in an active session' USING ERRCODE = 'CG020';
  END IF;
  RETURN NEW;
END;
$$;

-- A deferred activation that has not run moves to a wake session when it is admitted; any other
-- activation keeps the session its turn runs in.
GRANT UPDATE (session_id) ON clockgrove.actor_activations TO clockgrove_runtime;
CREATE FUNCTION clockgrove.guard_activation_session() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clockgrove AS $$
BEGIN
  IF NEW.session_id IS DISTINCT FROM OLD.session_id THEN
    IF OLD.status <> 'deferred'
       OR EXISTS (SELECT 1 FROM clockgrove.conversation_turn_fibers AS fiber
                   WHERE fiber.tenant_id = OLD.tenant_id AND fiber.session_id = OLD.session_id
                     AND fiber.message_id = OLD.message_id)
       OR NOT EXISTS (
         SELECT 1 FROM clockgrove.conversation_sessions AS wake
           JOIN clockgrove.conversation_participants AS participant
             ON participant.tenant_id = wake.tenant_id AND participant.session_id = wake.session_id
          WHERE wake.tenant_id = NEW.tenant_id AND wake.session_id = NEW.session_id
            AND wake.wake_of IS NOT NULL AND wake.world_id = NEW.world_id
            AND wake.timeline_id = NEW.timeline_id AND wake.space_id = NEW.space_id
            AND wake.actor_id = NEW.actor_id AND participant.principal_id = NEW.principal_id)
    THEN
      RAISE EXCEPTION 'activation session is fixed';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION clockgrove.guard_activation_session() FROM PUBLIC;
CREATE TRIGGER actor_activations_session BEFORE UPDATE ON clockgrove.actor_activations
  FOR EACH ROW EXECUTE FUNCTION clockgrove.guard_activation_session();

-- A wake session's deliveries go to its configured session's channel thread: the person's own
-- thread, never the wake session's. The delivery binding of a session is its configured session's.
CREATE OR REPLACE FUNCTION clockgrove.guard_delivery_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,clockgrove AS $$ DECLARE units bigint; BEGIN
  IF TG_OP='UPDATE' AND (to_jsonb(NEW)-'receipt'-'status') IS DISTINCT FROM (to_jsonb(OLD)-'receipt'-'status') THEN
    RAISE EXCEPTION 'delivery request and reservation are immutable'; END IF;
  IF TG_OP='UPDATE' AND NOT (OLD.status='reserved' AND NEW.status IN ('approved','delayed','downgraded','rejected')
    OR OLD.status='delayed' AND NEW.status IN ('approved','downgraded','rejected')) THEN
    RAISE EXCEPTION 'delivery decision is terminal or still waiting'; END IF;
  IF NOT EXISTS (SELECT 1 FROM clockgrove.conversation_sessions cs
    JOIN clockgrove.channel_bindings cb ON cb.tenant_id=cs.tenant_id
      AND cb.session_id=COALESCE(cs.wake_of,cs.session_id)
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
