-- Issue 374 (G8): an operator mutes an actor, or one conversation of it, at once. From then on a
-- muted actor or conversation starts no turn, delivery or effect: each start reads its mute in its
-- own transaction through `actor_muted`, so nothing waits for a model call.
--
-- One row per muted actor (`session_id = ''`) and per muted conversation, updated in place: a mute
-- or unmute bumps `version` and names the operator who made it. Rows are written only through
-- `set_actor_mute`, which holds the caller to a live membership of the world with
-- `runtime:actor-govern` and a `private_cognition` ceiling, the authority of an operator change set
-- over the actor's documents (0037).
CREATE TABLE clockgrove.actor_mutes (
  tenant_id text NOT NULL,
  world_id text NOT NULL,
  timeline_id text NOT NULL,
  actor_id text NOT NULL CHECK (octet_length(actor_id) BETWEEN 1 AND 1024),
  session_id text NOT NULL CHECK (octet_length(session_id) <= 1024),
  muted boolean NOT NULL,
  principal_id text NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  changed_at timestamptz NOT NULL CHECK (isfinite(changed_at)),
  PRIMARY KEY (tenant_id, world_id, timeline_id, actor_id, session_id),
  FOREIGN KEY (tenant_id, world_id, timeline_id)
    REFERENCES clockgrove.timelines (tenant_id, world_id, timeline_id),
  FOREIGN KEY (tenant_id, principal_id)
    REFERENCES clockgrove.tenant_principals (tenant_id, principal_id)
);

ALTER TABLE clockgrove.actor_mutes ENABLE ROW LEVEL SECURITY;
ALTER TABLE clockgrove.actor_mutes FORCE ROW LEVEL SECURITY;
CREATE POLICY actor_mute_reader ON clockgrove.actor_mutes FOR SELECT
  USING (clockgrove.runtime_can_access(tenant_id, 'private_cognition')
         OR clockgrove.runtime_can_access(tenant_id, 'operator_evidence'));
REVOKE ALL ON clockgrove.actor_mutes FROM PUBLIC, clockgrove_runtime;
GRANT SELECT ON clockgrove.actor_mutes TO clockgrove_runtime;
CREATE TRIGGER actor_mutes_no_truncate BEFORE TRUNCATE ON clockgrove.actor_mutes
  FOR EACH STATEMENT EXECUTE FUNCTION clockgrove.reject_journal_mutation();

-- Mutes or unmutes an actor (`mute_session = ''`) or one session of it, and answers the row. The
-- caller is the installed principal; it must hold a live membership of the world's space with
-- `runtime:actor-govern` and a `private_cognition` ceiling. A session must be one of the actor's
-- in the same world timeline (P0002 otherwise, as for a session that does not exist).
CREATE FUNCTION clockgrove.set_actor_mute(
  mute_world text,
  mute_timeline text,
  mute_space text,
  mute_actor text,
  mute_session text,
  mute boolean
)
RETURNS clockgrove.actor_mutes
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, clockgrove
AS $$
DECLARE
  tenant text := clockgrove.runtime_tenant_id();
  principal text := clockgrove.runtime_principal_id();
  saved clockgrove.actor_mutes%ROWTYPE;
BEGIN
  IF tenant IS NULL OR principal IS NULL OR mute IS NULL
     OR NOT clockgrove.runtime_can_access(tenant, 'private_cognition')
     OR NOT EXISTS (
       SELECT 1 FROM clockgrove.world_memberships m
        WHERE m.tenant_id = tenant AND m.world_id = mute_world AND m.timeline_id = mute_timeline
          AND m.space_id = mute_space AND m.principal_id = principal AND m.revoked_at IS NULL
          AND 'runtime:actor-govern' = ANY (m.grants)
          AND m.privacy_ceiling -> 'allowedCategories' ? 'private_cognition') THEN
    RAISE EXCEPTION 'actor mute refused' USING ERRCODE = '42501';
  END IF;
  IF mute_session <> '' AND NOT EXISTS (
       SELECT 1 FROM clockgrove.conversation_sessions s
        WHERE s.tenant_id = tenant AND s.session_id = mute_session AND s.world_id = mute_world
          AND s.timeline_id = mute_timeline AND s.actor_id = mute_actor) THEN
    RAISE EXCEPTION 'conversation not found' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO clockgrove.actor_mutes AS current (
    tenant_id, world_id, timeline_id, actor_id, session_id, muted, principal_id, version, changed_at
  ) VALUES (
    tenant, mute_world, mute_timeline, mute_actor, mute_session, mute, principal, 1,
    statement_timestamp()
  )
  ON CONFLICT (tenant_id, world_id, timeline_id, actor_id, session_id) DO UPDATE
    SET muted = EXCLUDED.muted, principal_id = EXCLUDED.principal_id,
        version = current.version + 1, changed_at = EXCLUDED.changed_at
  RETURNING * INTO saved;
  RETURN saved;
END;
$$;
REVOKE ALL ON FUNCTION clockgrove.set_actor_mute(text, text, text, text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clockgrove.set_actor_mute(text, text, text, text, text, boolean)
  TO clockgrove_runtime;

-- Whether the actor, or the named session of it, is muted; a wake session (0075) is muted with the
-- conversation it wakes, whose thread it delivers on. Every start of a turn, delivery or
-- effect asks in its own transaction. It answers only for the installed tenant, or for a trusted
-- internal caller that installs none (the effect ledger), and only a boolean, never the row.
CREATE FUNCTION clockgrove.actor_muted(
  mute_tenant text,
  mute_world text,
  mute_timeline text,
  mute_actor text,
  mute_session text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, clockgrove
AS $$
  SELECT (clockgrove.runtime_tenant_id() IS NULL OR clockgrove.runtime_tenant_id() = mute_tenant)
     AND EXISTS (
       SELECT 1 FROM clockgrove.actor_mutes m
        WHERE m.tenant_id = mute_tenant AND m.world_id = mute_world
          AND m.timeline_id = mute_timeline AND m.actor_id = mute_actor AND m.muted
          AND (m.session_id = '' OR m.session_id = mute_session
               OR m.session_id = (SELECT s.wake_of FROM clockgrove.conversation_sessions s
                                   WHERE s.tenant_id = mute_tenant
                                     AND s.session_id = mute_session)))
$$;
REVOKE ALL ON FUNCTION clockgrove.actor_muted(text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clockgrove.actor_muted(text, text, text, text, text)
  TO clockgrove_runtime;

-- Whether a pending effect's actor, or the conversation of the run that proposed it, is muted: the
-- effect ledger asks before it starts an attempt, and records a muted one refused instead.
CREATE FUNCTION clockgrove.effect_muted(
  mute_tenant text,
  mute_world text,
  mute_timeline text,
  mute_effect text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, clockgrove
AS $$
  SELECT EXISTS (
    SELECT 1 FROM clockgrove.effect_intents i
      LEFT JOIN clockgrove.agent_runs r ON r.tenant_id = i.tenant_id AND r.run_id = i.run_id
     WHERE i.tenant_id = mute_tenant AND i.world_id = mute_world
       AND i.timeline_id = mute_timeline AND i.effect_id = mute_effect
       AND clockgrove.actor_muted(i.tenant_id, i.world_id, i.timeline_id, i.actor_id,
                                  coalesce(r.session_id, '')))
$$;
REVOKE ALL ON FUNCTION clockgrove.effect_muted(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clockgrove.effect_muted(text, text, text, text) TO clockgrove_runtime;

-- An actor mute request is audited beside the document change sets it shares its grant with.
ALTER TABLE clockgrove.inspector_accesses
  DROP CONSTRAINT inspector_accesses_subject_check,
  ADD CONSTRAINT inspector_accesses_subject_check CHECK (
    subject IN (
      'causal-chain', 'runtime-state', 'event', 'scheduled-action', 'client-view', 'agent-runs',
      'context-manifest', 'actor-documents', 'usage-events', 'actor-mute'
    )
  );
