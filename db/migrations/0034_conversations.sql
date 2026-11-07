-- Durable private conversations (Wave 5 RW-0501, issue 14). A session is scoped by its participant
-- set (Wave 5 §6.1): one row per human participant, a principal and their world persona. It talks
-- with one addressed actor of one world timeline; its messages and turns are ordered, immutable and
-- visible only to its participants (RLS: the installed principal is a participant of the session)
-- under a ceiling that holds `conversation`. Caretaker Talk sessions have exactly one participant;
-- a later shared session adds rows here, not columns. Message and title text are never stored here: each is a
-- `conversation`-class artifact, which 0012 stores only as AES-256-GCM ciphertext under the tenant
-- and world's data key, and a row names its artifact through a foreign key that pins the class.

-- A row can name an artifact together with its class, so the class is enforced by the key.
ALTER TABLE clockgrove.artifact_references
  ADD CONSTRAINT artifact_references_class_key UNIQUE (tenant_id, artifact_id, privacy_class);

-- Decision: IDs are 1 to 1024 octets, the inspector audit's bound (0022); a server-derived reply
-- message ID adds `:reply`, so message IDs may reach 1030.
CREATE TABLE clockgrove.conversation_sessions (
  tenant_id text NOT NULL,
  session_id text NOT NULL CHECK (octet_length(session_id) BETWEEN 1 AND 1024),
  world_id text NOT NULL,
  timeline_id text NOT NULL,
  -- Where the session was opened; its artifacts live in this partition and space.
  partition_id text NOT NULL,
  space_id text NOT NULL,
  actor_id text NOT NULL CHECK (octet_length(actor_id) BETWEEN 1 AND 1024),
  channel text NOT NULL DEFAULT 'browser' CHECK (channel = 'browser'),
  privacy_class text NOT NULL DEFAULT 'conversation' CHECK (privacy_class = 'conversation'),
  voice_mode text NOT NULL CHECK (voice_mode IN ('cognitive', 'interpreted', 'canonical')),
  state text NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'archived', 'locked', 'deleted')),
  title_artifact_id text,
  -- Decision: at most 1,000 messages (500 turns) a session. Without summarization (Wave 6) a
  -- transcript is read whole by its owner; 1,000 lines of at most 1024 octets bound it near 1 MiB.
  message_count integer NOT NULL DEFAULT 0 CHECK (message_count BETWEEN 0 AND 1000),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (tenant_id, session_id),
  FOREIGN KEY (tenant_id, world_id, timeline_id, partition_id, space_id)
    REFERENCES clockgrove.timeline_partitions (
      tenant_id, world_id, timeline_id, partition_id, space_id
    ),
  FOREIGN KEY (tenant_id, title_artifact_id, privacy_class)
    REFERENCES clockgrove.artifact_references (tenant_id, artifact_id, privacy_class)
);

-- A participant joins in the transaction that creates the session, before the session row (the
-- session's policy checks participation), so the key to the session is checked at commit.
CREATE TABLE clockgrove.conversation_participants (
  tenant_id text NOT NULL,
  session_id text NOT NULL,
  principal_id text NOT NULL CHECK (octet_length(principal_id) BETWEEN 1 AND 1024),
  persona_id text NOT NULL CHECK (octet_length(persona_id) BETWEEN 1 AND 1024),
  privacy_class text NOT NULL DEFAULT 'conversation' CHECK (privacy_class = 'conversation'),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (tenant_id, session_id, principal_id),
  UNIQUE (tenant_id, session_id, persona_id),
  UNIQUE (tenant_id, session_id, principal_id, persona_id),
  FOREIGN KEY (tenant_id, session_id)
    REFERENCES clockgrove.conversation_sessions (tenant_id, session_id)
    DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX conversation_participants_principal
  ON clockgrove.conversation_participants (tenant_id, principal_id, session_id);

-- Whether the installed principal participates in a session. It reads the participant set past
-- RLS (the migrator's bypass), so the policies below never recurse.
CREATE FUNCTION clockgrove.runtime_conversation_participant(row_tenant_id text, row_session_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, clockgrove
AS $$
  SELECT EXISTS (
    SELECT 1 FROM clockgrove.conversation_participants AS participant
     WHERE participant.tenant_id = row_tenant_id AND participant.session_id = row_session_id
       AND participant.principal_id = clockgrove.runtime_principal_id()
  )
$$;
REVOKE ALL ON FUNCTION clockgrove.runtime_conversation_participant(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clockgrove.runtime_conversation_participant(text, text)
  TO clockgrove_runtime;

CREATE TABLE clockgrove.conversation_messages (
  tenant_id text NOT NULL,
  session_id text NOT NULL,
  -- The author participant of a Caretaker message; an actor answer has none.
  principal_id text,
  sequence integer NOT NULL CHECK (sequence BETWEEN 1 AND 1000),
  message_id text NOT NULL CHECK (octet_length(message_id) BETWEEN 1 AND 1030),
  role text NOT NULL CHECK (role IN ('caretaker', 'actor')),
  -- The Caretaker's world persona, or the addressed actor.
  author_id text NOT NULL CHECK (octet_length(author_id) BETWEEN 1 AND 1024),
  voice_mode text CHECK (voice_mode IN ('cognitive', 'interpreted', 'canonical')),
  privacy_class text NOT NULL DEFAULT 'conversation' CHECK (privacy_class = 'conversation'),
  content_artifact_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (tenant_id, session_id, sequence),
  UNIQUE (tenant_id, session_id, message_id),
  CONSTRAINT conversation_messages_voice CHECK ((role = 'caretaker') = (voice_mode IS NULL)),
  CONSTRAINT conversation_messages_author CHECK ((role = 'caretaker') = (principal_id IS NOT NULL)),
  FOREIGN KEY (tenant_id, session_id) REFERENCES clockgrove.conversation_sessions (tenant_id, session_id),
  -- A Caretaker message is authored by a participant under that participant's persona.
  FOREIGN KEY (tenant_id, session_id, principal_id, author_id)
    REFERENCES clockgrove.conversation_participants (tenant_id, session_id, principal_id, persona_id),
  FOREIGN KEY (tenant_id, content_artifact_id, privacy_class)
    REFERENCES clockgrove.artifact_references (tenant_id, artifact_id, privacy_class)
);

CREATE TABLE clockgrove.conversation_turns (
  tenant_id text NOT NULL,
  session_id text NOT NULL,
  principal_id text NOT NULL,
  turn integer NOT NULL CHECK (turn BETWEEN 1 AND 500),
  input_sequence integer NOT NULL,
  output_sequence integer NOT NULL,
  model text NOT NULL CHECK (model = 'scripted-fixture-v1'),
  state text NOT NULL CHECK (state IN ('queued', 'completed', 'failed', 'cancelled')),
  privacy_class text NOT NULL DEFAULT 'conversation' CHECK (privacy_class = 'conversation'),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (tenant_id, session_id, turn),
  CONSTRAINT conversation_turns_order CHECK (output_sequence > input_sequence),
  -- The participant whose message opened the turn.
  FOREIGN KEY (tenant_id, session_id, principal_id)
    REFERENCES clockgrove.conversation_participants (tenant_id, session_id, principal_id),
  FOREIGN KEY (tenant_id, session_id, input_sequence)
    REFERENCES clockgrove.conversation_messages (tenant_id, session_id, sequence),
  FOREIGN KEY (tenant_id, session_id, output_sequence)
    REFERENCES clockgrove.conversation_messages (tenant_id, session_id, sequence)
);

-- Participant scope: under a ceiling holding `conversation`, the installed tenant member sees and
-- changes only sessions they participate in, with those sessions' participants, messages and turns.
-- Another member of the same world sees nothing. A member adds only themselves as a participant
-- (and only with a new session, below), and writes Caretaker messages and turns only as themselves.
DO $rls$
DECLARE
  table_name text;
  writer text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'conversation_sessions', 'conversation_participants', 'conversation_messages',
    'conversation_turns'
  ] LOOP
    -- A new participant row is not yet visible to the participation check; it names its writer.
    writer := CASE table_name
      WHEN 'conversation_participants' THEN 'principal_id = clockgrove.runtime_principal_id()'
      WHEN 'conversation_sessions' THEN
        'clockgrove.runtime_conversation_participant(tenant_id, session_id)'
      WHEN 'conversation_messages' THEN
        'clockgrove.runtime_conversation_participant(tenant_id, session_id)
         AND coalesce(principal_id = clockgrove.runtime_principal_id(), role = ''actor'')'
      ELSE 'clockgrove.runtime_conversation_participant(tenant_id, session_id)
         AND principal_id = clockgrove.runtime_principal_id()'
    END;
    EXECUTE format('ALTER TABLE clockgrove.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE clockgrove.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY participant_isolation ON clockgrove.%I
         USING (clockgrove.runtime_can_access(tenant_id, privacy_class)
                AND clockgrove.runtime_conversation_participant(tenant_id, session_id))
         WITH CHECK (clockgrove.runtime_can_access(tenant_id, privacy_class) AND %s)',
      table_name, writer
    );
    EXECUTE format('REVOKE ALL ON clockgrove.%I FROM PUBLIC', table_name);
    EXECUTE format('GRANT SELECT, INSERT ON clockgrove.%I TO clockgrove_runtime', table_name);
  END LOOP;
END;
$rls$;

-- A session changes only its state, title, message count and update time; nothing is deleted.
GRANT UPDATE (state, title_artifact_id, message_count, updated_at)
  ON clockgrove.conversation_sessions TO clockgrove_runtime;

-- Messages and turns never change.
CREATE TRIGGER conversation_messages_immutable_rows
  BEFORE UPDATE OR DELETE ON clockgrove.conversation_messages
  FOR EACH ROW EXECUTE FUNCTION clockgrove.reject_journal_mutation();
CREATE TRIGGER conversation_messages_immutable_truncate
  BEFORE TRUNCATE ON clockgrove.conversation_messages
  FOR EACH STATEMENT EXECUTE FUNCTION clockgrove.reject_journal_mutation();
CREATE TRIGGER conversation_turns_immutable_rows
  BEFORE UPDATE OR DELETE ON clockgrove.conversation_turns
  FOR EACH ROW EXECUTE FUNCTION clockgrove.reject_journal_mutation();
CREATE TRIGGER conversation_turns_immutable_truncate
  BEFORE TRUNCATE ON clockgrove.conversation_turns
  FOR EACH STATEMENT EXECUTE FUNCTION clockgrove.reject_journal_mutation();
CREATE TRIGGER conversation_participants_immutable_rows
  BEFORE UPDATE OR DELETE ON clockgrove.conversation_participants
  FOR EACH ROW EXECUTE FUNCTION clockgrove.reject_journal_mutation();
CREATE TRIGGER conversation_participants_immutable_truncate
  BEFORE TRUNCATE ON clockgrove.conversation_participants
  FOR EACH STATEMENT EXECUTE FUNCTION clockgrove.reject_journal_mutation();
CREATE TRIGGER conversation_sessions_immutable_truncate
  BEFORE TRUNCATE ON clockgrove.conversation_sessions
  FOR EACH STATEMENT EXECUTE FUNCTION clockgrove.reject_journal_mutation();

-- A participant joins only with a new session: a member who learns a session ID cannot add
-- themselves to it. The check reads past RLS, which hides the existing session from that member.
CREATE FUNCTION clockgrove.guard_conversation_participant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, clockgrove
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM clockgrove.conversation_sessions AS session
              WHERE session.tenant_id = NEW.tenant_id AND session.session_id = NEW.session_id) THEN
    RAISE EXCEPTION 'a participant joins only with a new session' USING ERRCODE = 'CG020';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION clockgrove.guard_conversation_participant() FROM PUBLIC;
CREATE TRIGGER conversation_participants_guard
  BEFORE INSERT ON clockgrove.conversation_participants
  FOR EACH ROW EXECUTE FUNCTION clockgrove.guard_conversation_participant();

-- `deleted` is terminal, a message count only grows, and only an active session takes messages.
-- Decision: at most 100 sessions that are not deleted per participant and world timeline: a
-- selector lists them whole, and a member who needs more deletes old ones. The count reads past
-- RLS so that it covers each participant's sessions, not only those the installed member sees.
CREATE FUNCTION clockgrove.guard_conversation_session()
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
             AND open.state <> 'deleted') >= 100 THEN
        RAISE EXCEPTION 'conversation session limit reached' USING ERRCODE = 'CG021';
      END IF;
    END LOOP;
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
REVOKE ALL ON FUNCTION clockgrove.guard_conversation_session() FROM PUBLIC;
CREATE TRIGGER conversation_sessions_guard
  BEFORE INSERT OR UPDATE ON clockgrove.conversation_sessions
  FOR EACH ROW EXECUTE FUNCTION clockgrove.guard_conversation_session();
