-- Governed actor documents and context manifests (Wave 5 §5.3, §9, RW-0505, issue 17).
--
-- An actor's identity, policy, goals, working context and session summaries are logical Markdown
-- documents with a stable ID per path and immutable versions. A version holds its exact text, a
-- SHA-256 source hash the database recomputes, its size and the change set that wrote it. Every
-- write is an atomic change set that names its proposer: an `operator` holding the `private_cognition`
-- ceiling, or a `model` proposal of one run, made as the run's session participant. The path fixes
-- the kind and the kind fixes the write class, so a model-returned path never selects a protected or
-- governed target: the guard below refuses such a version whatever the application does.
--
-- Document text is private cognition. It never enters scene state: no projection, delivery or
-- public table references these rows. A reader whose ceiling holds `private_cognition` reads them;
-- a participant of a session addressing the actor reads them too, except another session's summary,
-- so context can be assembled for that session.
--
-- Each Talk attempt's context manifest is one immutable row per run: every candidate source with its
-- version, hash, token estimate, prompt section, trust label and inclusion decision or exclusion
-- rule. It holds metadata only, never text.

-- Decision (issue 17 defaults, docs/protocols/context-assembly.md): at most 256 documents an actor
-- and 1,000 versions a document, each version at most 8,192 bytes, so an actor's documents stay
-- bounded however often its working context changes.
CREATE TABLE clockgrove.actor_documents (
  tenant_id text NOT NULL,
  document_id text NOT NULL CHECK (octet_length(document_id) BETWEEN 1 AND 128),
  world_id text NOT NULL,
  timeline_id text NOT NULL,
  actor_id text NOT NULL CHECK (octet_length(actor_id) BETWEEN 1 AND 1024),
  path text NOT NULL CHECK (
    path IN ('identity.md', 'policy.md', 'goals.md', 'working-context.md')
    OR path ~ '^sessions/[A-Za-z0-9._:-]{1,256}/summary\.md$'
  ),
  kind text NOT NULL CHECK (
    kind IN ('identity', 'policy', 'goals', 'working_context', 'session_summary')
  ),
  write_class text NOT NULL CHECK (write_class IN ('protected', 'governed', 'actor_writable')),
  -- The session a summary belongs to; no other kind has one.
  session_id text,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'archived')),
  current_version integer NOT NULL DEFAULT 0 CHECK (current_version BETWEEN 0 AND 1000),
  privacy_class text NOT NULL DEFAULT 'private_cognition'
    CHECK (privacy_class = 'private_cognition'),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (tenant_id, document_id),
  UNIQUE (tenant_id, world_id, timeline_id, actor_id, path),
  -- The path decides the kind, and the kind the write class.
  CONSTRAINT actor_documents_kind CHECK (
    kind = CASE path
      WHEN 'identity.md' THEN 'identity'
      WHEN 'policy.md' THEN 'policy'
      WHEN 'goals.md' THEN 'goals'
      WHEN 'working-context.md' THEN 'working_context'
      ELSE 'session_summary'
    END
  ),
  CONSTRAINT actor_documents_write_class CHECK (
    write_class = CASE kind
      WHEN 'identity' THEN 'protected'
      WHEN 'policy' THEN 'protected'
      WHEN 'goals' THEN 'governed'
      ELSE 'actor_writable'
    END
  ),
  CONSTRAINT actor_documents_session CHECK (
    (kind = 'session_summary') = (session_id IS NOT NULL)
    AND (session_id IS NULL OR path = 'sessions/' || session_id || '/summary.md')
  ),
  FOREIGN KEY (tenant_id, session_id)
    REFERENCES clockgrove.conversation_sessions (tenant_id, session_id),
  FOREIGN KEY (tenant_id, world_id, timeline_id)
    REFERENCES clockgrove.timelines (tenant_id, world_id, timeline_id)
);

CREATE TABLE clockgrove.document_change_sets (
  tenant_id text NOT NULL,
  change_set_id text NOT NULL CHECK (octet_length(change_set_id) BETWEEN 1 AND 128),
  world_id text NOT NULL,
  timeline_id text NOT NULL,
  actor_id text NOT NULL,
  proposer text NOT NULL CHECK (proposer IN ('operator', 'model')),
  principal_id text NOT NULL,
  persona_id text,
  -- A model proposal's run and its session; an operator change set has neither.
  run_id text,
  session_id text,
  status text NOT NULL CHECK (status IN ('committed', 'refused')),
  refusal_code text CHECK (refusal_code ~ '^[a-z_]{1,64}$'),
  -- The operation (from 1) a refusal names, when one operation caused it.
  refused_operation integer CHECK (refused_operation BETWEEN 1 AND 64),
  -- A change set over the limit of 8 operations is recorded refused; the request decoder bounds 64.
  operation_count integer NOT NULL CHECK (operation_count BETWEEN 1 AND 64),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (tenant_id, change_set_id),
  CONSTRAINT document_change_sets_refusal CHECK ((status = 'refused') = (refusal_code IS NOT NULL)),
  CONSTRAINT document_change_sets_model CHECK (
    (proposer = 'model') = (run_id IS NOT NULL) AND (run_id IS NULL) = (session_id IS NULL)
  ),
  -- One proposal a run, so model proposals are bounded by runs.
  UNIQUE (tenant_id, run_id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES clockgrove.agent_runs (tenant_id, run_id)
);
CREATE INDEX document_change_sets_refused
  ON clockgrove.document_change_sets (tenant_id, created_at) WHERE status = 'refused';

CREATE TABLE clockgrove.actor_document_versions (
  tenant_id text NOT NULL,
  document_id text NOT NULL,
  version integer NOT NULL CHECK (version BETWEEN 1 AND 1000),
  world_id text NOT NULL,
  timeline_id text NOT NULL,
  actor_id text NOT NULL,
  session_id text,
  state text NOT NULL CHECK (state IN ('active', 'archived')),
  content text NOT NULL,
  byte_length integer NOT NULL CHECK (byte_length BETWEEN 0 AND 8192),
  source_hash text NOT NULL,
  change_set_id text NOT NULL,
  privacy_class text NOT NULL DEFAULT 'private_cognition'
    CHECK (privacy_class = 'private_cognition'),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (tenant_id, document_id, version),
  CONSTRAINT actor_document_versions_size CHECK (byte_length = octet_length(content)),
  CONSTRAINT actor_document_versions_hash CHECK (
    source_hash = encode(sha256(convert_to(content, 'UTF8')), 'hex')
  ),
  FOREIGN KEY (tenant_id, document_id) REFERENCES clockgrove.actor_documents (tenant_id, document_id),
  FOREIGN KEY (tenant_id, change_set_id)
    REFERENCES clockgrove.document_change_sets (tenant_id, change_set_id)
);

-- Whether the installed principal participates in a session of this world timeline that addresses
-- the actor. It reads past RLS (the migrator's bypass), as runtime_conversation_participant does.
CREATE FUNCTION clockgrove.runtime_actor_participant(
  row_tenant_id text, row_world_id text, row_timeline_id text, row_actor_id text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, clockgrove
AS $$
  SELECT EXISTS (
    SELECT 1 FROM clockgrove.conversation_sessions AS session
      JOIN clockgrove.conversation_participants AS participant
        ON participant.tenant_id = session.tenant_id AND participant.session_id = session.session_id
     WHERE session.tenant_id = row_tenant_id AND session.world_id = row_world_id
       AND session.timeline_id = row_timeline_id AND session.actor_id = row_actor_id
       AND session.state <> 'deleted'
       AND participant.principal_id = clockgrove.runtime_principal_id()
  )
$$;
REVOKE ALL ON FUNCTION clockgrove.runtime_actor_participant(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clockgrove.runtime_actor_participant(text, text, text, text)
  TO clockgrove_runtime;

-- Document rows: a `private_cognition` reader, or a participant addressing the actor, who sees no
-- other session's summary. An operator writes any class; a participant only actor-writable ones, a
-- summary only of their own session.
DO $rls$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['actor_documents', 'actor_document_versions'] LOOP
    EXECUTE format('ALTER TABLE clockgrove.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE clockgrove.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY document_reader ON clockgrove.%I FOR SELECT
         USING (clockgrove.runtime_can_access(tenant_id, privacy_class)
                OR (clockgrove.has_runtime_context(tenant_id)
                    AND clockgrove.runtime_actor_participant(tenant_id, world_id, timeline_id, actor_id)
                    AND (session_id IS NULL
                         OR clockgrove.runtime_conversation_participant(tenant_id, session_id))))',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY document_writer ON clockgrove.%I FOR INSERT
         WITH CHECK (clockgrove.runtime_can_access(tenant_id, privacy_class)
                     OR (clockgrove.has_runtime_context(tenant_id)
                         AND clockgrove.runtime_actor_participant(tenant_id, world_id, timeline_id, actor_id)
                         AND (session_id IS NULL
                              OR clockgrove.runtime_conversation_participant(tenant_id, session_id))
                         %s))',
      table_name,
      CASE table_name WHEN 'actor_documents' THEN 'AND write_class = ''actor_writable''' ELSE '' END
    );
    EXECUTE format('REVOKE ALL ON clockgrove.%I FROM PUBLIC', table_name);
    EXECUTE format('GRANT SELECT, INSERT ON clockgrove.%I TO clockgrove_runtime', table_name);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE DELETE ON clockgrove.%I
         FOR EACH ROW EXECUTE FUNCTION clockgrove.reject_journal_mutation()',
      table_name || '_no_delete', table_name
    );
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON clockgrove.%I
         FOR EACH STATEMENT EXECUTE FUNCTION clockgrove.reject_journal_mutation()',
      table_name || '_no_truncate', table_name
    );
  END LOOP;
END;
$rls$;

-- Change sets: written by their own principal; an operator's needs `private_cognition`, a model's
-- is its session participant's. Their author, a `private_cognition` reader and an inspector holding
-- `operator_evidence` read them.
ALTER TABLE clockgrove.document_change_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE clockgrove.document_change_sets FORCE ROW LEVEL SECURITY;
CREATE POLICY change_set_reader ON clockgrove.document_change_sets FOR SELECT
  USING (clockgrove.runtime_can_access(tenant_id, 'private_cognition')
         OR clockgrove.runtime_can_access(tenant_id, 'operator_evidence')
         OR (clockgrove.has_runtime_context(tenant_id)
             AND principal_id = clockgrove.runtime_principal_id()));
CREATE POLICY change_set_writer ON clockgrove.document_change_sets FOR INSERT
  WITH CHECK (principal_id = clockgrove.runtime_principal_id() AND CASE proposer
    WHEN 'operator' THEN clockgrove.runtime_can_access(tenant_id, 'private_cognition')
    ELSE clockgrove.has_runtime_context(tenant_id)
         AND clockgrove.runtime_conversation_participant(tenant_id, session_id)
  END);
REVOKE ALL ON clockgrove.document_change_sets FROM PUBLIC;
GRANT SELECT, INSERT ON clockgrove.document_change_sets TO clockgrove_runtime;
CREATE TRIGGER document_change_sets_no_truncate BEFORE TRUNCATE ON clockgrove.document_change_sets
  FOR EACH STATEMENT EXECUTE FUNCTION clockgrove.reject_journal_mutation();

-- A document starts empty and active at version 0; at most 256 per actor.
CREATE FUNCTION clockgrove.guard_actor_document()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, clockgrove
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.current_version := 0;
    NEW.state := 'active';
    PERFORM pg_advisory_xact_lock(hashtext(
      'actor-documents:' || NEW.tenant_id || ':' || NEW.world_id || ':' || NEW.timeline_id || ':'
      || NEW.actor_id));
    IF (SELECT count(*) FROM clockgrove.actor_documents
         WHERE tenant_id = NEW.tenant_id AND world_id = NEW.world_id
           AND timeline_id = NEW.timeline_id AND actor_id = NEW.actor_id) >= 256 THEN
      RAISE EXCEPTION 'actor document limit reached' USING ERRCODE = 'CG022';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION clockgrove.guard_actor_document() FROM PUBLIC;
CREATE TRIGGER actor_documents_guard
  BEFORE INSERT ON clockgrove.actor_documents
  FOR EACH ROW EXECUTE FUNCTION clockgrove.guard_actor_document();

-- A version is the document's next one, written by a committed change set of the same actor whose
-- proposer may write the document's class: a model proposal only an actor-writable document, and a
-- summary only of its own session. The version then becomes the document's head. Nothing else
-- moves a head, and no version changes (the runtime role holds no UPDATE on versions).
CREATE FUNCTION clockgrove.guard_actor_document_version()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, clockgrove
AS $$
DECLARE
  document clockgrove.actor_documents%ROWTYPE;
  change clockgrove.document_change_sets%ROWTYPE;
BEGIN
  SELECT * INTO document FROM clockgrove.actor_documents
   WHERE tenant_id = NEW.tenant_id AND document_id = NEW.document_id FOR UPDATE;
  SELECT * INTO change FROM clockgrove.document_change_sets
   WHERE tenant_id = NEW.tenant_id AND change_set_id = NEW.change_set_id;
  IF NOT FOUND OR change.status <> 'committed' OR change.actor_id <> document.actor_id
     OR change.world_id <> document.world_id OR change.timeline_id <> document.timeline_id
     OR NEW.actor_id <> document.actor_id OR NEW.world_id <> document.world_id
     OR NEW.timeline_id <> document.timeline_id
     OR NEW.session_id IS DISTINCT FROM document.session_id THEN
    RAISE EXCEPTION 'a version belongs to a committed change set of its actor' USING ERRCODE = 'CG023';
  END IF;
  IF change.proposer = 'model' AND (document.write_class <> 'actor_writable'
     OR (document.session_id IS NOT NULL AND document.session_id <> change.session_id)) THEN
    RAISE EXCEPTION 'a model proposal writes only its actor-writable documents'
      USING ERRCODE = 'CG023';
  END IF;
  IF change.proposer = 'operator' AND NOT clockgrove.privacy_allows('private_cognition') THEN
    RAISE EXCEPTION 'an operator change set needs private_cognition' USING ERRCODE = 'CG023';
  END IF;
  IF NEW.version <> document.current_version + 1 THEN
    RAISE EXCEPTION 'a version follows its document''s head' USING ERRCODE = 'CG024';
  END IF;
  IF document.state = 'archived' THEN
    RAISE EXCEPTION 'an archived document never changes' USING ERRCODE = 'CG024';
  END IF;
  UPDATE clockgrove.actor_documents
     SET current_version = NEW.version, state = NEW.state, updated_at = statement_timestamp()
   WHERE tenant_id = NEW.tenant_id AND document_id = NEW.document_id;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION clockgrove.guard_actor_document_version() FROM PUBLIC;
CREATE TRIGGER actor_document_versions_guard
  BEFORE INSERT ON clockgrove.actor_document_versions
  FOR EACH ROW EXECUTE FUNCTION clockgrove.guard_actor_document_version();

-- Refused change sets are evidence kept 90 days, then retired on insert, 100 at a time (as 0023).
CREATE FUNCTION clockgrove.retire_refused_change_sets()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, clockgrove
AS $$
BEGIN
  DELETE FROM clockgrove.document_change_sets AS expired
   WHERE expired.tenant_id = NEW.tenant_id
     AND expired.change_set_id IN (
       SELECT candidate.change_set_id FROM clockgrove.document_change_sets AS candidate
        WHERE candidate.tenant_id = NEW.tenant_id AND candidate.status = 'refused'
          AND candidate.created_at < statement_timestamp() - interval '90 days'
        ORDER BY candidate.created_at
        LIMIT 100
        FOR UPDATE SKIP LOCKED
     );
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION clockgrove.retire_refused_change_sets() FROM PUBLIC;
CREATE TRIGGER document_change_sets_retire
  AFTER INSERT ON clockgrove.document_change_sets
  FOR EACH ROW WHEN (NEW.status = 'refused')
  EXECUTE FUNCTION clockgrove.retire_refused_change_sets();

-- The metadata of every document of the actor a session addresses, for its participant: candidate
-- selection decides on these fields before any text is read. Another session's summary appears
-- here, so its exclusion is recorded, while its row stays unreadable to the participant.
CREATE FUNCTION clockgrove.actor_context_candidates(row_tenant_id text, row_session_id text)
RETURNS TABLE (
  document_id text, path text, kind text, write_class text, session_id text, state text,
  version integer, source_hash text, byte_length integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, clockgrove
AS $$
  SELECT document.document_id, document.path, document.kind, document.write_class,
         document.session_id, document.state, document.current_version, head.source_hash,
         head.byte_length
    FROM clockgrove.conversation_sessions AS session
    JOIN clockgrove.actor_documents AS document
      ON document.tenant_id = session.tenant_id AND document.world_id = session.world_id
     AND document.timeline_id = session.timeline_id AND document.actor_id = session.actor_id
    JOIN clockgrove.actor_document_versions AS head
      ON head.tenant_id = document.tenant_id AND head.document_id = document.document_id
     AND head.version = document.current_version
   WHERE session.tenant_id = row_tenant_id AND session.session_id = row_session_id
     AND session.state <> 'deleted'
     AND clockgrove.has_runtime_context(row_tenant_id)
     AND clockgrove.runtime_conversation_participant(row_tenant_id, row_session_id)
   ORDER BY document.path
$$;
REVOKE ALL ON FUNCTION clockgrove.actor_context_candidates(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clockgrove.actor_context_candidates(text, text) TO clockgrove_runtime;

-- One context manifest per run, written with its context step and never changed.
CREATE TABLE clockgrove.context_manifests (
  tenant_id text NOT NULL,
  run_id text NOT NULL,
  session_id text NOT NULL,
  world_id text NOT NULL,
  timeline_id text NOT NULL,
  space_id text NOT NULL,
  actor_id text NOT NULL,
  input_message_id text NOT NULL,
  input_revision integer NOT NULL CHECK (input_revision >= 0),
  token_budget integer NOT NULL CHECK (token_budget > 0),
  tokens_used integer NOT NULL CHECK (tokens_used >= 0),
  manifest_hash text NOT NULL CHECK (manifest_hash ~ '^[0-9a-f]{64}$'),
  -- At most 256 documents, 16 history messages and the input (decision, context-assembly.md).
  entries jsonb NOT NULL CHECK (
    jsonb_typeof(entries) = 'array' AND jsonb_array_length(entries) BETWEEN 1 AND 273
  ),
  privacy_class text NOT NULL DEFAULT 'conversation' CHECK (privacy_class = 'conversation'),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (tenant_id, run_id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES clockgrove.agent_runs (tenant_id, run_id)
);
ALTER TABLE clockgrove.context_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE clockgrove.context_manifests FORCE ROW LEVEL SECURITY;
CREATE POLICY manifest_reader ON clockgrove.context_manifests FOR SELECT
  USING (clockgrove.runtime_can_access(tenant_id, 'operator_evidence')
         OR (clockgrove.runtime_can_access(tenant_id, privacy_class)
             AND clockgrove.runtime_conversation_participant(tenant_id, session_id)));
CREATE POLICY manifest_writer ON clockgrove.context_manifests FOR INSERT
  WITH CHECK (clockgrove.runtime_can_access(tenant_id, privacy_class)
              AND clockgrove.runtime_conversation_participant(tenant_id, session_id));
REVOKE ALL ON clockgrove.context_manifests FROM PUBLIC;
GRANT SELECT, INSERT ON clockgrove.context_manifests TO clockgrove_runtime;
CREATE TRIGGER context_manifests_no_delete BEFORE DELETE ON clockgrove.context_manifests
  FOR EACH ROW EXECUTE FUNCTION clockgrove.reject_journal_mutation();
CREATE TRIGGER context_manifests_no_truncate BEFORE TRUNCATE ON clockgrove.context_manifests
  FOR EACH STATEMENT EXECUTE FUNCTION clockgrove.reject_journal_mutation();

-- Context and document inspection are audited like every other inspector read.
ALTER TABLE clockgrove.inspector_accesses
  DROP CONSTRAINT inspector_accesses_subject_check,
  ADD CONSTRAINT inspector_accesses_subject_check CHECK (
    subject IN (
      'causal-chain', 'runtime-state', 'event', 'scheduled-action', 'client-view', 'agent-runs',
      'context-manifest', 'actor-documents'
    )
  );
