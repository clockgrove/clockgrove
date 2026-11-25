-- Issue 329, part 3: admission before spend. The engine never handles money; a developer limits
-- spend with durable budgets in native quantities, and the engine asks before each model call and
-- tool call of a turn. Nothing here is readable or writable by the runtime role directly: every
-- table has row-level security with no policy and no grant, and the functions below act as
-- definer after their own authorization.

-- A budget is a ceiling on one native quantity of a category, per world, player or session, per
-- UTC day or in total, set in one space and enforced there. NULL is off. A row is never deleted,
-- so turning a budget off and on again keeps the tally counting. `acknowledged_at` is when it was
-- last set: setting a budget acknowledges the unknown quantities its tally met before then.
CREATE TABLE clockgrove.usage_budgets (
  tenant_id text NOT NULL,
  world_id text NOT NULL,
  timeline_id text NOT NULL,
  space_id text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('world', 'player', 'session')),
  category text NOT NULL CHECK (category IN ('model_call', 'tool_call')),
  quantity text NOT NULL CHECK (quantity IN ('calls', 'inputTokens', 'outputTokens')),
  period text NOT NULL CHECK (period IN ('day', 'total')),
  max_quantity bigint CHECK (max_quantity >= 0),
  -- Who set it last.
  principal_id text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  acknowledged_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (tenant_id, world_id, timeline_id, space_id, scope, category, quantity, period),
  CHECK (category = 'model_call' OR quantity = 'calls'),
  FOREIGN KEY (tenant_id, world_id, timeline_id)
    REFERENCES clockgrove.timelines (tenant_id, world_id, timeline_id)
);

-- What a budgeted scope has used, across the whole world: every space and timeline of the world
-- for the `world` scope and for a player, the session's own for a session. The sums are of known
-- quantities only; `<quantity>_unknown_at` is the last time an unknown (`null`) one entered the
-- period, and a budget not acknowledged since refuses on it.
CREATE TABLE clockgrove.usage_tallies (
  tenant_id text NOT NULL,
  world_id text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('world', 'player', 'session')),
  -- '' for the world, the principal for a player, the session for a session.
  subject_id text NOT NULL,
  category text NOT NULL CHECK (category IN ('model_call', 'tool_call')),
  period text NOT NULL CHECK (period IN ('day', 'total')),
  -- The UTC day; 1970-01-01 for a total.
  period_start date NOT NULL,
  calls bigint NOT NULL CHECK (calls >= 0),
  input_tokens bigint NOT NULL CHECK (input_tokens >= 0),
  output_tokens bigint NOT NULL CHECK (output_tokens >= 0),
  calls_unknown_at timestamptz,
  input_tokens_unknown_at timestamptz,
  output_tokens_unknown_at timestamptz,
  PRIMARY KEY (tenant_id, world_id, scope, subject_id, category, period, period_start),
  FOREIGN KEY (tenant_id, world_id) REFERENCES clockgrove.worlds (tenant_id, world_id)
);

-- A call admitted and not yet captured by its usage event, kept by the source that asked: a turn's
-- run step, or a wake-triage or moderation shadow beside it. Each is sequential within its
-- session, so one call per session, category and source is in flight; it counts against the
-- `calls` budgets until its event commits or it expires (the 5-minute cron cadence, as the
-- webhook lease).
CREATE TABLE clockgrove.usage_reservations (
  tenant_id text NOT NULL,
  session_id text NOT NULL,
  category text NOT NULL CHECK (category IN ('model_call', 'tool_call')),
  source text NOT NULL CHECK (source IN ('run_step', 'wake_triage', 'moderation_shadow')),
  world_id text NOT NULL,
  timeline_id text NOT NULL,
  space_id text NOT NULL,
  principal_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, session_id, category, source)
);
CREATE INDEX usage_reservations_world
  ON clockgrove.usage_reservations (tenant_id, world_id, category);

-- Where the developer's own code is asked about a call before it is made. One row per space.
CREATE TABLE clockgrove.usage_admission_hooks (
  tenant_id text NOT NULL,
  world_id text NOT NULL,
  timeline_id text NOT NULL,
  space_id text NOT NULL,
  -- The registrar: while they no longer qualify, the hook's space is refused, never unlimited.
  principal_id text NOT NULL,
  hook_id text NOT NULL CHECK (octet_length(hook_id) BETWEEN 1 AND 128),
  url text CHECK (url ~ '^https://' AND octet_length(url) <= 2048),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (tenant_id, world_id, timeline_id, space_id),
  UNIQUE (tenant_id, hook_id),
  FOREIGN KEY (tenant_id, world_id, timeline_id)
    REFERENCES clockgrove.timelines (tenant_id, world_id, timeline_id)
);

ALTER TABLE clockgrove.usage_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE clockgrove.usage_budgets FORCE ROW LEVEL SECURITY;
ALTER TABLE clockgrove.usage_tallies ENABLE ROW LEVEL SECURITY;
ALTER TABLE clockgrove.usage_tallies FORCE ROW LEVEL SECURITY;
ALTER TABLE clockgrove.usage_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE clockgrove.usage_reservations FORCE ROW LEVEL SECURITY;
ALTER TABLE clockgrove.usage_admission_hooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE clockgrove.usage_admission_hooks FORCE ROW LEVEL SECURITY;
REVOKE ALL ON clockgrove.usage_budgets, clockgrove.usage_tallies, clockgrove.usage_reservations,
  clockgrove.usage_admission_hooks FROM PUBLIC;

CREATE TRIGGER usage_budgets_no_delete BEFORE DELETE ON clockgrove.usage_budgets
  FOR EACH ROW EXECUTE FUNCTION clockgrove.reject_journal_mutation();
CREATE TRIGGER usage_budgets_no_truncate BEFORE TRUNCATE ON clockgrove.usage_budgets
  FOR EACH STATEMENT EXECUTE FUNCTION clockgrove.reject_journal_mutation();
CREATE TRIGGER usage_admission_hooks_no_delete BEFORE DELETE ON clockgrove.usage_admission_hooks
  FOR EACH ROW EXECUTE FUNCTION clockgrove.reject_journal_mutation();
CREATE TRIGGER usage_admission_hooks_no_truncate BEFORE TRUNCATE ON clockgrove.usage_admission_hooks
  FOR EACH STATEMENT EXECUTE FUNCTION clockgrove.reject_journal_mutation();

-- Admission and capture of one world are serialized by this lock, so a capture never commits
-- between admission's reading of a tally and its counting of the reservations.
CREATE FUNCTION clockgrove.usage_admission_lock(t text, w text) RETURNS void
LANGUAGE sql SET search_path = pg_catalog, clockgrove AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('usage-admission:'
    || jsonb_build_array(t, w)::text, 0));
$$;
REVOKE ALL ON FUNCTION clockgrove.usage_admission_lock(text, text) FROM PUBLIC;

-- Capture: the usage event commits in the transaction that ends its step or shadow decision, so
-- the same commit releases the reservation its source made and adds the use to every budgeted
-- tally. The event's own source keys the reservation: a shadow's event never releases the call of
-- the turn beside it.
CREATE FUNCTION clockgrove.capture_usage_admission() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clockgrove AS $$
DECLARE
  -- Tokens do not apply to a tool, so a tool call adds zero; an absent model quantity is unknown.
  c bigint := (NEW.quantities->>'calls')::bigint;
  i bigint := CASE WHEN NEW.category = 'tool_call' THEN 0
    ELSE (NEW.quantities->>'inputTokens')::bigint END;
  o bigint := CASE WHEN NEW.category = 'tool_call' THEN 0
    ELSE (NEW.quantities->>'outputTokens')::bigint END;
  seen timestamptz := clock_timestamp();
BEGIN
  PERFORM clockgrove.usage_admission_lock(NEW.tenant_id, NEW.world_id);
  DELETE FROM clockgrove.usage_reservations r
   WHERE r.tenant_id = NEW.tenant_id AND r.session_id = NEW.session_id
     AND r.category = NEW.category AND r.source = NEW.source;
  INSERT INTO clockgrove.usage_tallies AS u (tenant_id, world_id, scope, subject_id, category,
    period, period_start, calls, input_tokens, output_tokens, calls_unknown_at,
    input_tokens_unknown_at, output_tokens_unknown_at)
  SELECT NEW.tenant_id, NEW.world_id, b.scope,
         CASE b.scope WHEN 'world' THEN '' WHEN 'player' THEN NEW.principal_id
           ELSE NEW.session_id END,
         NEW.category, b.period,
         CASE b.period WHEN 'day' THEN (NEW.occurred_at AT TIME ZONE 'UTC')::date
           ELSE DATE '1970-01-01' END,
         coalesce(c, 0), coalesce(i, 0), coalesce(o, 0),
         CASE WHEN c IS NULL THEN seen END, CASE WHEN i IS NULL THEN seen END,
         CASE WHEN o IS NULL THEN seen END
    FROM (SELECT DISTINCT x.scope, x.period FROM clockgrove.usage_budgets x
           WHERE x.tenant_id = NEW.tenant_id AND x.world_id = NEW.world_id
             AND x.category = NEW.category
             AND (x.scope <> 'session' OR (NEW.session_id IS NOT NULL
               AND x.timeline_id = NEW.timeline_id AND x.space_id = NEW.space_id))) b
  ON CONFLICT (tenant_id, world_id, scope, subject_id, category, period, period_start)
  DO UPDATE SET calls = u.calls + EXCLUDED.calls,
                input_tokens = u.input_tokens + EXCLUDED.input_tokens,
                output_tokens = u.output_tokens + EXCLUDED.output_tokens,
                calls_unknown_at = coalesce(EXCLUDED.calls_unknown_at, u.calls_unknown_at),
                input_tokens_unknown_at =
                  coalesce(EXCLUDED.input_tokens_unknown_at, u.input_tokens_unknown_at),
                output_tokens_unknown_at =
                  coalesce(EXCLUDED.output_tokens_unknown_at, u.output_tokens_unknown_at);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION clockgrove.capture_usage_admission() FROM PUBLIC;
CREATE TRIGGER usage_events_capture_admission AFTER INSERT ON clockgrove.usage_events
  FOR EACH ROW WHEN (NEW.category IN ('model_call', 'tool_call'))
  EXECUTE FUNCTION clockgrove.capture_usage_admission();

-- Asked before a model call or tool call of a turn, or a shadow's model call beside it (`src`).
-- Acts on the turn fiber of the installed participant (as 0071's step reservation does),
-- serializes per world, and either refuses on the first exhausted or unacknowledged unknown budget
-- or on a hook whose registrar no longer qualifies, or reserves the call. A call in flight counts
-- as one more call against every `calls` budget, so concurrent calls cannot overshoot by their
-- number. The actor-reply shadow writes no usage event to capture a reservation, so it is asked
-- and reserves nothing.
CREATE FUNCTION clockgrove.admit_usage(t text, sess text, msg text, cat text, res text, src text)
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
  FOR b IN
    SELECT u.scope, u.quantity, u.period, u.max_quantity, u.acknowledged_at
      FROM clockgrove.usage_budgets u
     WHERE u.tenant_id = t AND u.world_id = f.world_id AND u.timeline_id = f.timeline_id
       AND u.space_id = sp AND u.category = cat AND u.max_quantity IS NOT NULL
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
  IF FOUND THEN
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
  RETURN QUERY SELECT CASE WHEN why IS NULL THEN 'admitted' ELSE 'refused' END, why,
    hook.hook_id, hook.url, f.world_id, f.timeline_id, sp, f.principal_id, f.persona_id,
    f.actor_id, f.run_id, res;
END $$;
REVOKE ALL ON FUNCTION clockgrove.admit_usage(text, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clockgrove.admit_usage(text, text, text, text, text, text)
  TO clockgrove_runtime;

-- Sets one budget (NULL max is off) and lists the space's budgets. Setting a ceiling on spend is
-- an operator's decision: the usage reader's grant and ceiling, and `runtime:world-operate`.
-- Setting it, which is audited, also acknowledges the unknown quantities its tally met so far:
-- from then it counts their known part, and a later unknown refuses again.
CREATE FUNCTION clockgrove.set_usage_budget(t text, w text, tl text, s text, sc text, cat text,
  qty text, per text, mx bigint)
RETURNS TABLE (scope text, category text, quantity text, period text, max_quantity bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clockgrove AS $$
#variable_conflict use_column
BEGIN
  IF NOT clockgrove.runtime_usage_reader(t, w, tl, s) OR NOT EXISTS (
       SELECT 1 FROM clockgrove.world_memberships m
        WHERE m.tenant_id = t AND m.world_id = w AND m.timeline_id = tl AND m.space_id = s
          AND m.principal_id = clockgrove.runtime_principal_id() AND m.revoked_at IS NULL
          AND 'runtime:world-operate' = ANY(m.grants)) THEN
    RAISE EXCEPTION 'usage budget refused' USING ERRCODE = '42501';
  END IF;
  INSERT INTO clockgrove.usage_budgets AS u (tenant_id, world_id, timeline_id, space_id, scope,
    category, quantity, period, max_quantity, principal_id, updated_at)
  VALUES (t, w, tl, s, sc, cat, qty, per, mx, clockgrove.runtime_principal_id(),
    statement_timestamp())
  ON CONFLICT (tenant_id, world_id, timeline_id, space_id, scope, category, quantity, period)
  DO UPDATE SET max_quantity = EXCLUDED.max_quantity, principal_id = EXCLUDED.principal_id,
    updated_at = EXCLUDED.updated_at, acknowledged_at = EXCLUDED.updated_at;
  RETURN QUERY SELECT u.scope, u.category, u.quantity, u.period, u.max_quantity
    FROM clockgrove.usage_budgets u
   WHERE u.tenant_id = t AND u.world_id = w AND u.timeline_id = tl AND u.space_id = s
   ORDER BY u.scope, u.category, u.quantity, u.period;
END $$;
REVOKE ALL ON FUNCTION clockgrove.set_usage_budget(text, text, text, text, text, text, text, text,
  bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clockgrove.set_usage_budget(text, text, text, text, text, text, text,
  text, bigint) TO clockgrove_runtime;

-- Registers (or with a NULL url disables) the space's admission hook and returns its id, which is
-- kept on re-registration. A URL takes the webhook registrar's narrow authority (0083), since the
-- deployment then sends turn attribution to that host; disabling needs it too.
CREATE FUNCTION clockgrove.register_usage_admission_hook(t text, w text, tl text, s text,
  hook_url text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clockgrove AS $$
DECLARE id text;
BEGIN
  -- Disabling needs the same authority as pointing it somewhere: a hook is a limit on spend, so a
  -- mere reader turning it off would lift the developer's limit.
  IF NOT clockgrove.runtime_usage_reader(t, w, tl, s)
     OR NOT clockgrove.runtime_usage_webhook_registrar(t, w, tl, s) THEN
    RAISE EXCEPTION 'usage admission hook refused' USING ERRCODE = '42501';
  END IF;
  INSERT INTO clockgrove.usage_admission_hooks AS h (tenant_id, world_id, timeline_id, space_id,
    principal_id, hook_id, url)
  VALUES (t, w, tl, s, clockgrove.runtime_principal_id(), gen_random_uuid()::text, hook_url)
  ON CONFLICT (tenant_id, world_id, timeline_id, space_id)
  DO UPDATE SET principal_id = EXCLUDED.principal_id, url = EXCLUDED.url,
    updated_at = statement_timestamp()
  RETURNING h.hook_id INTO id;
  RETURN id;
END $$;
REVOKE ALL ON FUNCTION clockgrove.register_usage_admission_hook(text, text, text, text, text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clockgrove.register_usage_admission_hook(text, text, text, text, text)
  TO clockgrove_runtime;

-- Setting a budget or a hook changes who may spend and where turn attribution goes, so each is
-- audited as its own subject, with its entry.
ALTER TABLE clockgrove.inspector_accesses
  DROP CONSTRAINT inspector_accesses_subject_check,
  DROP CONSTRAINT inspector_accesses_subject_entry,
  ADD CONSTRAINT inspector_accesses_subject_check CHECK (
    subject IN (
      'causal-chain', 'runtime-state', 'event', 'scheduled-action', 'client-view', 'agent-runs',
      'context-manifest', 'actor-documents', 'usage-events', 'actor-mute', 'journal',
      'usage-webhook', 'usage-budget', 'usage-admission-hook'
    )
  ),
  ADD CONSTRAINT inspector_accesses_subject_entry
    CHECK ((subject IN ('event', 'scheduled-action', 'usage-webhook', 'usage-budget',
      'usage-admission-hook')) = (entry_id IS NOT NULL));
