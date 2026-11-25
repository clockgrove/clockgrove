-- Issue 329, part 3: admission before spend. The engine never handles money; a developer limits
-- spend with durable budgets in native quantities, and the engine asks before each model call and
-- tool call of a turn. Nothing here is readable or writable by the runtime role directly: every
-- table has row-level security with no policy and no grant, and the functions below act as
-- definer after their own authorization.

-- A budget is a ceiling on one native quantity of a category, per world, player or session, per
-- UTC day or in total. NULL is off. A row is never deleted, so turning a budget off and on again
-- keeps the tally counting.
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
  PRIMARY KEY (tenant_id, world_id, timeline_id, space_id, scope, category, quantity, period),
  CHECK (category = 'model_call' OR quantity = 'calls'),
  FOREIGN KEY (tenant_id, world_id, timeline_id)
    REFERENCES clockgrove.timelines (tenant_id, world_id, timeline_id)
);

-- What a budgeted scope has used. A NULL token column means an unknown quantity entered the
-- period: it stays unknown for the rest of the period, and admission refuses on it.
CREATE TABLE clockgrove.usage_tallies (
  tenant_id text NOT NULL,
  world_id text NOT NULL,
  timeline_id text NOT NULL,
  space_id text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('world', 'player', 'session')),
  -- '' for the world, the principal for a player, the session for a session.
  subject_id text NOT NULL,
  category text NOT NULL CHECK (category IN ('model_call', 'tool_call')),
  period text NOT NULL CHECK (period IN ('day', 'total')),
  -- The UTC day; 1970-01-01 for a total.
  period_start date NOT NULL,
  calls bigint CHECK (calls >= 0),
  input_tokens bigint CHECK (input_tokens >= 0),
  output_tokens bigint CHECK (output_tokens >= 0),
  PRIMARY KEY (tenant_id, world_id, timeline_id, space_id, scope, subject_id, category, period,
    period_start),
  FOREIGN KEY (tenant_id, world_id, timeline_id)
    REFERENCES clockgrove.timelines (tenant_id, world_id, timeline_id)
);

-- A call admitted and not yet captured by its usage event. A session's turns are sequential, so
-- one call per session and category is in flight; it counts against the budgets until its event
-- commits or it expires (the 5-minute cron cadence, as the webhook lease).
CREATE TABLE clockgrove.usage_reservations (
  tenant_id text NOT NULL,
  session_id text NOT NULL,
  category text NOT NULL CHECK (category IN ('model_call', 'tool_call')),
  world_id text NOT NULL,
  timeline_id text NOT NULL,
  space_id text NOT NULL,
  principal_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, session_id, category)
);
CREATE INDEX usage_reservations_space
  ON clockgrove.usage_reservations (tenant_id, world_id, timeline_id, space_id, category);

-- Where the developer's own code is asked about a call before it is made. One row per space.
CREATE TABLE clockgrove.usage_admission_hooks (
  tenant_id text NOT NULL,
  world_id text NOT NULL,
  timeline_id text NOT NULL,
  space_id text NOT NULL,
  -- The registrar: the hook is asked only while they still qualify.
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

-- Capture: the step's usage event commits in the transaction that ends the step, so the same
-- commit releases the reservation and adds the use to every budgeted tally.
CREATE FUNCTION clockgrove.capture_usage_admission() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clockgrove AS $$
BEGIN
  DELETE FROM clockgrove.usage_reservations r
   WHERE r.tenant_id = NEW.tenant_id AND r.session_id = NEW.session_id
     AND r.category = NEW.category;
  -- Tokens do not apply to a tool, so a tool call adds zero; an absent model quantity is unknown.
  INSERT INTO clockgrove.usage_tallies AS u (tenant_id, world_id, timeline_id, space_id, scope,
    subject_id, category, period, period_start, calls, input_tokens, output_tokens)
  SELECT NEW.tenant_id, NEW.world_id, NEW.timeline_id, NEW.space_id, b.scope,
         CASE b.scope WHEN 'world' THEN '' WHEN 'player' THEN NEW.principal_id
           ELSE NEW.session_id END,
         NEW.category, b.period,
         CASE b.period WHEN 'day' THEN (NEW.occurred_at AT TIME ZONE 'UTC')::date
           ELSE DATE '1970-01-01' END,
         (NEW.quantities->>'calls')::bigint,
         CASE WHEN NEW.category = 'tool_call' THEN 0
           ELSE (NEW.quantities->>'inputTokens')::bigint END,
         CASE WHEN NEW.category = 'tool_call' THEN 0
           ELSE (NEW.quantities->>'outputTokens')::bigint END
    FROM (SELECT DISTINCT scope, period FROM clockgrove.usage_budgets
           WHERE tenant_id = NEW.tenant_id AND world_id = NEW.world_id
             AND timeline_id = NEW.timeline_id AND space_id = NEW.space_id
             AND category = NEW.category) b
  ON CONFLICT (tenant_id, world_id, timeline_id, space_id, scope, subject_id, category, period,
    period_start)
  DO UPDATE SET calls = u.calls + EXCLUDED.calls,
                input_tokens = u.input_tokens + EXCLUDED.input_tokens,
                output_tokens = u.output_tokens + EXCLUDED.output_tokens;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION clockgrove.capture_usage_admission() FROM PUBLIC;
CREATE TRIGGER usage_events_capture_admission AFTER INSERT ON clockgrove.usage_events
  FOR EACH ROW WHEN (NEW.category IN ('model_call', 'tool_call'))
  EXECUTE FUNCTION clockgrove.capture_usage_admission();

-- Asked before a model call or tool call of a turn. Acts on the turn fiber of the installed
-- participant (as 0071's step reservation does), serializes per space, and either refuses on the
-- first exhausted or unknown budget or reserves the call. A call in flight counts as one more
-- call against every `calls` budget, so concurrent turns cannot overshoot by their number.
CREATE FUNCTION clockgrove.admit_usage(t text, sess text, msg text, cat text, res text)
RETURNS TABLE (decision text, cause text, hook_id text, hook_url text, world_id text,
  timeline_id text, space_id text, principal_id text, persona_id text, actor_id text, run_id text,
  resource text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clockgrove AS $$
#variable_conflict use_column
DECLARE
  f clockgrove.conversation_turn_fibers%ROWTYPE;
  sp text;
  b record;
  used bigint;
  held bigint;
  subject text;
  why text := NULL;
  hook clockgrove.usage_admission_hooks%ROWTYPE;
BEGIN
  IF cat NOT IN ('model_call', 'tool_call')
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
  IF res IS NULL AND cat = 'model_call' THEN
    SELECT r.model INTO res FROM clockgrove.agent_runs r
     WHERE r.tenant_id = t AND r.run_id = f.run_id;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('usage-admission:'
    || jsonb_build_array(t, f.world_id, f.timeline_id, sp)::text, 0));
  FOR b IN
    SELECT u.scope, u.quantity, u.period, u.max_quantity FROM clockgrove.usage_budgets u
     WHERE u.tenant_id = t AND u.world_id = f.world_id AND u.timeline_id = f.timeline_id
       AND u.space_id = sp AND u.category = cat AND u.max_quantity IS NOT NULL
     ORDER BY u.scope, u.quantity, u.period
  LOOP
    subject := CASE b.scope WHEN 'world' THEN '' WHEN 'player' THEN f.principal_id ELSE sess END;
    SELECT CASE b.quantity WHEN 'calls' THEN y.calls WHEN 'inputTokens' THEN y.input_tokens
             ELSE y.output_tokens END
      INTO used
      FROM clockgrove.usage_tallies y
     WHERE y.tenant_id = t AND y.world_id = f.world_id AND y.timeline_id = f.timeline_id
       AND y.space_id = sp AND y.scope = b.scope AND y.subject_id = subject
       AND y.category = cat AND y.period = b.period
       AND y.period_start = CASE b.period WHEN 'day'
         THEN (statement_timestamp() AT TIME ZONE 'UTC')::date ELSE DATE '1970-01-01' END;
    IF NOT FOUND THEN used := 0;
    ELSIF used IS NULL THEN why := 'usage_budget_unknown'; EXIT; END IF;
    held := 0;
    IF b.quantity = 'calls' THEN
      SELECT count(*) INTO held FROM clockgrove.usage_reservations v
       WHERE v.tenant_id = t AND v.world_id = f.world_id AND v.timeline_id = f.timeline_id
         AND v.space_id = sp AND v.category = cat AND v.expires_at > statement_timestamp()
         AND v.session_id <> sess
         AND (b.scope = 'world' OR (b.scope = 'player' AND v.principal_id = f.principal_id));
    END IF;
    IF used + held + 1 > b.max_quantity THEN why := 'usage_budget_exhausted'; EXIT; END IF;
  END LOOP;
  IF why IS NULL THEN
    INSERT INTO clockgrove.usage_reservations AS v (tenant_id, session_id, category, world_id,
      timeline_id, space_id, principal_id, expires_at)
    VALUES (t, sess, cat, f.world_id, f.timeline_id, sp, f.principal_id,
      statement_timestamp() + interval '300 seconds')
    ON CONFLICT (tenant_id, session_id, category)
    DO UPDATE SET world_id = EXCLUDED.world_id, timeline_id = EXCLUDED.timeline_id,
      space_id = EXCLUDED.space_id, principal_id = EXCLUDED.principal_id,
      expires_at = EXCLUDED.expires_at;
  END IF;
  SELECT h.* INTO hook FROM clockgrove.usage_admission_hooks h
   WHERE h.tenant_id = t AND h.world_id = f.world_id AND h.timeline_id = f.timeline_id
     AND h.space_id = sp AND h.url IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM clockgrove.world_memberships m
        WHERE m.tenant_id = h.tenant_id AND m.world_id = h.world_id
          AND m.timeline_id = h.timeline_id AND m.space_id = h.space_id
          AND m.principal_id = h.principal_id AND m.revoked_at IS NULL
          AND 'runtime:world-inspect' = ANY(m.grants)
          AND clockgrove.usage_webhook_authority(m.roles, m.grants, m.principal_id)
          AND m.privacy_ceiling->'allowedCategories' ? 'operator_evidence');
  RETURN QUERY SELECT CASE WHEN why IS NULL THEN 'admitted' ELSE 'refused' END, why,
    hook.hook_id, hook.url, f.world_id, f.timeline_id, sp, f.principal_id, f.persona_id,
    f.actor_id, f.run_id, res;
END $$;
REVOKE ALL ON FUNCTION clockgrove.admit_usage(text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clockgrove.admit_usage(text, text, text, text, text)
  TO clockgrove_runtime;

-- Sets one budget (NULL max is off) and lists the space's budgets. Setting a ceiling on spend is
-- an operator's decision: the usage reader's grant and ceiling, and `runtime:world-operate`.
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
    updated_at = EXCLUDED.updated_at;
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
