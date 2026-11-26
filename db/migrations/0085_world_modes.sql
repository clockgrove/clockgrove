-- Issue 329, part 4: world modes. The developer's server sets a space's mode, for example when a
-- player's subscription lapses: `active`, `restricted` (no model or tool call), `read_only` (no
-- world command and no new turn) or `paused` (neither), with a reason code the world shows. A mode
-- is an admission policy, never world truth: it writes no journal event and never moves the clock,
-- so replay never depends on it. The runtime reads it through `world_mode` and sets it only
-- through `set_world_mode`; the table has row-level security with no policy and no grant.

-- One row per space, updated in place and never deleted (`active` is a mode like the others). The
-- reason is a code, not text: every observer of the world is shown it.
CREATE TABLE clockgrove.world_modes (
  tenant_id text NOT NULL,
  world_id text NOT NULL,
  timeline_id text NOT NULL,
  space_id text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('active', 'restricted', 'read_only', 'paused')),
  reason text CHECK (reason ~ '^[a-z0-9_]{1,64}$'),
  -- Who set it last.
  principal_id text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (tenant_id, world_id, timeline_id, space_id),
  CHECK (mode <> 'active' OR reason IS NULL),
  FOREIGN KEY (tenant_id, world_id, timeline_id)
    REFERENCES clockgrove.timelines (tenant_id, world_id, timeline_id)
);
ALTER TABLE clockgrove.world_modes ENABLE ROW LEVEL SECURITY;
ALTER TABLE clockgrove.world_modes FORCE ROW LEVEL SECURITY;
REVOKE ALL ON clockgrove.world_modes FROM PUBLIC;
CREATE TRIGGER world_modes_no_delete BEFORE DELETE ON clockgrove.world_modes
  FOR EACH ROW EXECUTE FUNCTION clockgrove.reject_journal_mutation();
CREATE TRIGGER world_modes_no_truncate BEFORE TRUNCATE ON clockgrove.world_modes
  FOR EACH STATEMENT EXECUTE FUNCTION clockgrove.reject_journal_mutation();

-- The space's mode and reason, `active` with none when never set. The mode is shown to every
-- observer of the space, so any runtime caller of the tenant may read it, as `actor_muted`.
CREATE FUNCTION clockgrove.world_mode(t text, w text, tl text, s text)
RETURNS TABLE (mode text, reason text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, clockgrove AS $$
  SELECT coalesce(m.mode, 'active'), m.reason
    FROM (SELECT 1) AS one
    LEFT JOIN clockgrove.world_modes m
      ON m.tenant_id = t AND m.world_id = w AND m.timeline_id = tl AND m.space_id = s
   WHERE clockgrove.runtime_tenant_id() IS NULL OR clockgrove.runtime_tenant_id() = t
$$;
REVOKE ALL ON FUNCTION clockgrove.world_mode(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clockgrove.world_mode(text, text, text, text) TO clockgrove_runtime;

-- Sets the space's mode. Restricting a world is an operator's decision, as a budget is: the usage
-- reader's grant and ceiling, and `runtime:world-operate`.
CREATE FUNCTION clockgrove.set_world_mode(t text, w text, tl text, s text, md text, why text)
RETURNS TABLE (mode text, reason text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clockgrove AS $$
#variable_conflict use_column
BEGIN
  IF NOT clockgrove.runtime_usage_reader(t, w, tl, s) OR NOT EXISTS (
       SELECT 1 FROM clockgrove.world_memberships m
        WHERE m.tenant_id = t AND m.world_id = w AND m.timeline_id = tl AND m.space_id = s
          AND m.principal_id = clockgrove.runtime_principal_id() AND m.revoked_at IS NULL
          AND 'runtime:world-operate' = ANY(m.grants)) THEN
    RAISE EXCEPTION 'world mode refused' USING ERRCODE = '42501';
  END IF;
  INSERT INTO clockgrove.world_modes AS x (tenant_id, world_id, timeline_id, space_id, mode,
    reason, principal_id, updated_at)
  VALUES (t, w, tl, s, md, why, clockgrove.runtime_principal_id(), statement_timestamp())
  ON CONFLICT (tenant_id, world_id, timeline_id, space_id)
  DO UPDATE SET mode = EXCLUDED.mode, reason = EXCLUDED.reason,
    principal_id = EXCLUDED.principal_id, updated_at = EXCLUDED.updated_at;
  RETURN QUERY SELECT md, why;
END $$;
REVOKE ALL ON FUNCTION clockgrove.set_world_mode(text, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clockgrove.set_world_mode(text, text, text, text, text, text)
  TO clockgrove_runtime;

-- Admission (0084) with the mode first: a `restricted` or `paused` space refuses every model and
-- tool call, and every shadow's, with cause `world_mode_<mode>`, before any budget or the hook.
CREATE OR REPLACE FUNCTION clockgrove.admit_usage(t text, sess text, msg text, cat text, res text, src text)
RETURNS TABLE (decision text, cause text, hook_id text, hook_url text, world_id text,
  timeline_id text, space_id text, principal_id text, persona_id text, actor_id text, run_id text,
  resource text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clockgrove AS $$
#variable_conflict use_column
DECLARE
  f clockgrove.conversation_turn_fibers%ROWTYPE;
  sp text;
  b record;
  y clockgrove.usage_tallies%ROWTYPE;
  used bigint;
  unknown_at timestamptz;
  held bigint;
  subject text;
  why text := NULL;
  hook clockgrove.usage_admission_hooks%ROWTYPE;
  qualified boolean;
  md text;
BEGIN
  IF cat NOT IN ('model_call', 'tool_call')
     OR src NOT IN ('run_step', 'wake_triage', 'moderation_shadow', 'actor_reply_shadow')
     OR (src <> 'run_step' AND cat <> 'model_call')
     OR NOT clockgrove.runtime_can_access(t, 'conversation')
     OR NOT clockgrove.runtime_conversation_participant(t, sess) THEN
    RAISE EXCEPTION 'usage admission refused' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO f FROM clockgrove.conversation_turn_fibers x
   WHERE x.tenant_id = t AND x.session_id = sess AND x.message_id = msg;
  IF NOT FOUND OR f.principal_id IS DISTINCT FROM clockgrove.runtime_principal_id() THEN
    RAISE EXCEPTION 'usage admission refused' USING ERRCODE = '42501';
  END IF;
  SELECT c.space_id INTO STRICT sp FROM clockgrove.conversation_sessions c
   WHERE c.tenant_id = t AND c.session_id = sess;
  IF res IS NULL AND cat = 'model_call' AND src = 'run_step' THEN
    SELECT r.model INTO res FROM clockgrove.agent_runs r
     WHERE r.tenant_id = t AND r.run_id = f.run_id;
  END IF;
  PERFORM clockgrove.usage_admission_lock(t, f.world_id);
  -- A restricted or paused space spends nothing: refused before any budget or the hook is asked.
  SELECT m.mode INTO md FROM clockgrove.world_modes m
   WHERE m.tenant_id = t AND m.world_id = f.world_id AND m.timeline_id = f.timeline_id
     AND m.space_id = sp;
  IF md IN ('restricted', 'paused') THEN why := 'world_mode_' || md; END IF;
  FOR b IN
    SELECT u.scope, u.quantity, u.period, u.max_quantity, u.acknowledged_at
      FROM clockgrove.usage_budgets u
     WHERE u.tenant_id = t AND u.world_id = f.world_id AND u.timeline_id = f.timeline_id
       AND u.space_id = sp AND u.category = cat AND u.max_quantity IS NOT NULL
       AND why IS NULL
     ORDER BY u.scope, u.quantity, u.period
  LOOP
    subject := CASE b.scope WHEN 'world' THEN '' WHEN 'player' THEN f.principal_id ELSE sess END;
    used := 0;
    SELECT * INTO y FROM clockgrove.usage_tallies x
     WHERE x.tenant_id = t AND x.world_id = f.world_id AND x.scope = b.scope
       AND x.subject_id = subject AND x.category = cat AND x.period = b.period
       AND x.period_start = CASE b.period WHEN 'day'
         THEN (statement_timestamp() AT TIME ZONE 'UTC')::date ELSE DATE '1970-01-01' END;
    IF FOUND THEN
      used := CASE b.quantity WHEN 'calls' THEN y.calls WHEN 'inputTokens' THEN y.input_tokens
        ELSE y.output_tokens END;
      unknown_at := CASE b.quantity WHEN 'calls' THEN y.calls_unknown_at
        WHEN 'inputTokens' THEN y.input_tokens_unknown_at ELSE y.output_tokens_unknown_at END;
      IF unknown_at > b.acknowledged_at THEN why := 'usage_budget_unknown'; EXIT; END IF;
    END IF;
    held := 0;
    IF b.quantity = 'calls' THEN
      SELECT count(*) INTO held FROM clockgrove.usage_reservations v
       WHERE v.tenant_id = t AND v.world_id = f.world_id AND v.category = cat
         AND v.expires_at > statement_timestamp()
         AND NOT (v.session_id = sess AND v.source = src)
         AND CASE b.scope WHEN 'world' THEN true
           WHEN 'player' THEN v.principal_id = f.principal_id ELSE v.session_id = sess END;
    END IF;
    IF used + held + 1 > b.max_quantity THEN why := 'usage_budget_exhausted'; EXIT; END IF;
  END LOOP;
  SELECT h.* INTO hook FROM clockgrove.usage_admission_hooks h
   WHERE h.tenant_id = t AND h.world_id = f.world_id AND h.timeline_id = f.timeline_id
     AND h.space_id = sp AND h.url IS NOT NULL;
  IF FOUND AND why IS NULL THEN
    qualified := EXISTS (
      SELECT 1 FROM clockgrove.world_memberships m
       WHERE m.tenant_id = hook.tenant_id AND m.world_id = hook.world_id
         AND m.timeline_id = hook.timeline_id AND m.space_id = hook.space_id
         AND m.principal_id = hook.principal_id AND m.revoked_at IS NULL
         AND 'runtime:world-inspect' = ANY(m.grants)
         AND clockgrove.usage_webhook_authority(m.roles, m.grants, m.principal_id)
         AND m.privacy_ceiling->'allowedCategories' ? 'operator_evidence');
    -- A hook is a limit on spend: one whose registrar lost the authority is not asked, and its
    -- space refuses rather than lose the limit.
    IF NOT qualified THEN
      why := coalesce(why, 'usage_admission_unavailable');
      hook := NULL;
    END IF;
  END IF;
  IF why IS NULL AND src <> 'actor_reply_shadow' THEN
    INSERT INTO clockgrove.usage_reservations AS v (tenant_id, session_id, category, source,
      world_id, timeline_id, space_id, principal_id, expires_at)
    VALUES (t, sess, cat, src, f.world_id, f.timeline_id, sp, f.principal_id,
      statement_timestamp() + interval '300 seconds')
    ON CONFLICT (tenant_id, session_id, category, source)
    DO UPDATE SET world_id = EXCLUDED.world_id, timeline_id = EXCLUDED.timeline_id,
      space_id = EXCLUDED.space_id, principal_id = EXCLUDED.principal_id,
      expires_at = EXCLUDED.expires_at;
  END IF;
  IF why IS NOT NULL THEN hook := NULL; END IF;
  RETURN QUERY SELECT CASE WHEN why IS NULL THEN 'admitted' ELSE 'refused' END, why,
    hook.hook_id, hook.url, f.world_id, f.timeline_id, sp, f.principal_id, f.persona_id,
    f.actor_id, f.run_id, res;
END $$;

-- Each change of a mode is audited as its own subject, the entry the mode set.
ALTER TABLE clockgrove.inspector_accesses
  DROP CONSTRAINT inspector_accesses_subject_check,
  DROP CONSTRAINT inspector_accesses_subject_entry,
  ADD CONSTRAINT inspector_accesses_subject_check CHECK (
    subject IN (
      'causal-chain', 'runtime-state', 'event', 'scheduled-action', 'client-view', 'agent-runs',
      'context-manifest', 'actor-documents', 'usage-events', 'actor-mute', 'journal',
      'usage-webhook', 'usage-budget', 'usage-admission-hook', 'world-mode'
    )
  ),
  ADD CONSTRAINT inspector_accesses_subject_entry
    CHECK ((subject IN ('event', 'scheduled-action', 'usage-webhook', 'usage-budget',
      'usage-admission-hook', 'world-mode')) = (entry_id IS NOT NULL));
