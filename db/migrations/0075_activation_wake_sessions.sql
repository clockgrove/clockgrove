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
