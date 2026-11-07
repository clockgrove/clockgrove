-- #852 (Wave 3 RW-0309, §11): operators inspect a scope's runtime state and recover world-reactions
-- Queue failures through the authenticated runtime API, not a database role or the Queue dashboard.
--
-- 1. The runtime-state inspection is audited in `inspector_accesses`, beside the causal chain, under
--    the same grant, rate limit and retention. A row now names its subject; a runtime-state access
--    names no command.
ALTER TABLE clockgrove.inspector_accesses
  ADD COLUMN subject text NOT NULL DEFAULT 'causal-chain'
    CHECK (subject IN ('causal-chain', 'runtime-state')),
  ALTER COLUMN command_id DROP NOT NULL,
  ADD CONSTRAINT inspector_accesses_subject_command
    CHECK ((subject = 'causal-chain') = (command_id IS NOT NULL));

-- Same checks, rate limit, insert and retirement as 0028, with the subject.
CREATE FUNCTION clockgrove.record_inspector_access(
  access_world_id text,
  access_timeline_id text,
  access_space_id text,
  access_command_id text,
  access_decision text,
  access_reason_code text,
  access_subject text
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, clockgrove
AS $$
DECLARE
  tenant text := clockgrove.runtime_tenant_id();
  principal text := clockgrove.runtime_principal_id();
BEGIN
  IF tenant IS NULL OR principal IS NULL THEN
    RAISE EXCEPTION 'inspector access requires installed authority' USING ERRCODE = '42501';
  END IF;
  IF access_decision IS DISTINCT FROM 'deny' AND NOT clockgrove.has_runtime_context(tenant) THEN
    RAISE EXCEPTION 'only a tenant member can be allowed' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM clockgrove.tenants WHERE tenant_id = tenant) THEN
    RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext(tenant || ':' || principal));
  IF (SELECT count(*) FROM (
        SELECT 1 FROM clockgrove.inspector_accesses AS recent
         WHERE recent.tenant_id = tenant AND recent.principal_id = principal
           AND recent.accessed_at > statement_timestamp() - interval '1 hour'
         LIMIT 300
      ) AS window_rows) >= 300 THEN
    IF access_decision = 'deny' THEN
      RETURN;
    END IF;
    RAISE EXCEPTION 'inspector access rate limit reached' USING ERRCODE = 'CG013';
  END IF;
  INSERT INTO clockgrove.inspector_accesses (
    tenant_id, principal_id, world_id, timeline_id, space_id, command_id, decision, reason_code,
    subject
  ) VALUES (
    tenant, principal, access_world_id, access_timeline_id, access_space_id, access_command_id,
    access_decision, access_reason_code, access_subject
  );
  DELETE FROM clockgrove.inspector_accesses AS expired
   WHERE expired.tenant_id = tenant
     AND expired.access_id IN (
       SELECT candidate.access_id FROM clockgrove.inspector_accesses AS candidate
        WHERE candidate.tenant_id = tenant
          AND candidate.accessed_at < statement_timestamp() - interval '90 days'
        ORDER BY candidate.accessed_at
        LIMIT 100
        FOR UPDATE SKIP LOCKED
     );
END;
$$;
REVOKE ALL ON FUNCTION clockgrove.record_inspector_access(text, text, text, text, text, text, text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clockgrove.record_inspector_access(text, text, text, text, text, text, text)
  TO clockgrove_runtime;

-- The six-argument form stays for code that predates the subject: a causal-chain access.
CREATE OR REPLACE FUNCTION clockgrove.record_inspector_access(
  access_world_id text,
  access_timeline_id text,
  access_space_id text,
  access_command_id text,
  access_decision text,
  access_reason_code text
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, clockgrove
AS $$
BEGIN
  PERFORM clockgrove.record_inspector_access(
    access_world_id, access_timeline_id, access_space_id, access_command_id, access_decision,
    access_reason_code, 'causal-chain'
  );
END;
$$;

-- 2. Operator actions: every accepted or refused publication repair and message replay is one
--    immutable row: who (principal), where (tenant, world, timeline, space), which action, which
--    message (the dispatch ID, the semantic message ID), when, and the decision with its outcome.
--    The runtime role has no privilege on the table and appends only through
--    `record_runtime_operator_action`, which takes tenant and principal from the installed
--    transaction-local authority, like `record_inspector_access` (0022): a denial is recorded under
--    an existing requested tenant, an allow only for its member.
--
-- Decision: IDs are 1 to 1024 octets, the inspector audit's bound (0022).
CREATE TABLE clockgrove.runtime_operator_actions (
  tenant_id text NOT NULL REFERENCES clockgrove.tenants (tenant_id)
    CHECK (octet_length(tenant_id) BETWEEN 1 AND 1024),
  action_id bigint GENERATED ALWAYS AS IDENTITY,
  principal_id text NOT NULL CHECK (octet_length(principal_id) BETWEEN 1 AND 1024),
  world_id text NOT NULL CHECK (octet_length(world_id) BETWEEN 1 AND 1024),
  timeline_id text NOT NULL CHECK (octet_length(timeline_id) BETWEEN 1 AND 1024),
  space_id text NOT NULL CHECK (octet_length(space_id) BETWEEN 1 AND 1024),
  action text NOT NULL CHECK (action IN ('repair-publication', 'replay-message')),
  message_id text NOT NULL CHECK (octet_length(message_id) BETWEEN 1 AND 1024),
  decision text NOT NULL CHECK (decision IN ('allow', 'deny')),
  -- allow: what the authorized action did: repaired, replayed, refused (not-found, not-failed,
  -- not-published) or failed. deny: the authorization refusal, or a contradicting authority source.
  reason_code text NOT NULL CHECK (
    (decision = 'allow' AND reason_code IN (
      'repaired', 'replayed', 'not-found', 'not-failed', 'not-published', 'failed'
    ))
    OR (decision = 'deny' AND reason_code IN (
      'world-participation-absent', 'runtime-grant-missing', 'authority-mismatch'
    ))
  ),
  acted_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (tenant_id, action_id)
);
ALTER TABLE clockgrove.runtime_operator_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE clockgrove.runtime_operator_actions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON clockgrove.runtime_operator_actions
  USING (clockgrove.has_runtime_context(tenant_id))
  WITH CHECK (clockgrove.has_runtime_context(tenant_id));
REVOKE ALL ON clockgrove.runtime_operator_actions FROM PUBLIC;
-- Rows never change. Retirement is the record function's alone (as 0023): nothing grants DELETE.
CREATE TRIGGER runtime_operator_actions_immutable_rows
  BEFORE UPDATE ON clockgrove.runtime_operator_actions
  FOR EACH ROW EXECUTE FUNCTION clockgrove.reject_journal_mutation();
CREATE TRIGGER runtime_operator_actions_immutable_truncate
  BEFORE TRUNCATE ON clockgrove.runtime_operator_actions
  FOR EACH STATEMENT EXECUTE FUNCTION clockgrove.reject_journal_mutation();
-- The rate-limit window (one principal's recent rows) and the retirement scan (a tenant's oldest).
CREATE INDEX runtime_operator_actions_principal_acted_at
  ON clockgrove.runtime_operator_actions (tenant_id, principal_id, acted_at);
CREATE INDEX runtime_operator_actions_tenant_acted_at
  ON clockgrove.runtime_operator_actions (tenant_id, acted_at);

-- Decision: the inspector audit's numbers (0023, 0028). 300 actions per principal per tenant in any
-- trailing hour: an action recovers one message, and a terminal failure needs its whole attempt
-- budget to fail first, so 300 an hour covers a large incident while capping one principal's rows
-- at 7,200 a day. 90 days of retention, matching the Analytics Engine metrics and the inspector
-- audit; each action retires up to 100 of its tenant's expired rows. Over the limit an allow is
-- refused (CG013, answered 429); a denial answers alike and is not recorded.
CREATE FUNCTION clockgrove.runtime_operator_action_admitted()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, clockgrove
AS $$
  SELECT NOT clockgrove.has_runtime_context(clockgrove.runtime_tenant_id())
      OR count(*) < 300
    FROM (
      SELECT 1 FROM clockgrove.runtime_operator_actions AS recent
       WHERE recent.tenant_id = clockgrove.runtime_tenant_id()
         AND recent.principal_id = clockgrove.runtime_principal_id()
         AND recent.acted_at > statement_timestamp() - interval '1 hour'
       LIMIT 300
    ) AS window_rows;
$$;
REVOKE ALL ON FUNCTION clockgrove.runtime_operator_action_admitted() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clockgrove.runtime_operator_action_admitted() TO clockgrove_runtime;

CREATE FUNCTION clockgrove.record_runtime_operator_action(
  action_world_id text,
  action_timeline_id text,
  action_space_id text,
  action_name text,
  action_message_id text,
  action_decision text,
  action_reason_code text
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, clockgrove
AS $$
DECLARE
  tenant text := clockgrove.runtime_tenant_id();
  principal text := clockgrove.runtime_principal_id();
BEGIN
  IF tenant IS NULL OR principal IS NULL THEN
    RAISE EXCEPTION 'operator action requires installed authority' USING ERRCODE = '42501';
  END IF;
  IF action_decision IS DISTINCT FROM 'deny' AND NOT clockgrove.has_runtime_context(tenant) THEN
    RAISE EXCEPTION 'only a tenant member can be allowed' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM clockgrove.tenants WHERE tenant_id = tenant) THEN
    RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('operator:' || tenant || ':' || principal));
  IF (SELECT count(*) FROM (
        SELECT 1 FROM clockgrove.runtime_operator_actions AS recent
         WHERE recent.tenant_id = tenant AND recent.principal_id = principal
           AND recent.acted_at > statement_timestamp() - interval '1 hour'
         LIMIT 300
      ) AS window_rows) >= 300 THEN
    IF action_decision = 'deny' THEN
      RETURN;
    END IF;
    RAISE EXCEPTION 'operator action rate limit reached' USING ERRCODE = 'CG013';
  END IF;
  INSERT INTO clockgrove.runtime_operator_actions (
    tenant_id, principal_id, world_id, timeline_id, space_id, action, message_id, decision,
    reason_code
  ) VALUES (
    tenant, principal, action_world_id, action_timeline_id, action_space_id, action_name,
    action_message_id, action_decision, action_reason_code
  );
  DELETE FROM clockgrove.runtime_operator_actions AS expired
   WHERE expired.tenant_id = tenant
     AND expired.action_id IN (
       SELECT candidate.action_id FROM clockgrove.runtime_operator_actions AS candidate
        WHERE candidate.tenant_id = tenant
          AND candidate.acted_at < statement_timestamp() - interval '90 days'
        ORDER BY candidate.acted_at
        LIMIT 100
        FOR UPDATE SKIP LOCKED
     );
END;
$$;
REVOKE ALL ON FUNCTION clockgrove.record_runtime_operator_action(
  text, text, text, text, text, text, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clockgrove.record_runtime_operator_action(
  text, text, text, text, text, text, text
) TO clockgrove_runtime;

-- 3. Publication repair: a `failed` world-reactions publication of the installed member's tenant, in
--    the requested scope and visible under its ceiling, goes back to `pending`, due now, with its
--    dispatch ID (the semantic message ID) unchanged. Only status and lease fields change: status,
--    lease owner, the lease expiry or due time (`next_attempt_at`) and `settled_at`, which 0009 ties
--    to a terminal status. `attempts` keeps counting, so the attempt fence stays monotonic and the
--    next claim is the repaired row's one further publication attempt. A failed row whose batch was
--    consumed needs no recovery (`consumed_at` wins, database.md) and is refused like any other
--    non-failed row. The audit row commits in the same transaction as the change.
CREATE FUNCTION clockgrove.repair_world_reaction_publication(
  repair_world_id text,
  repair_timeline_id text,
  repair_space_id text,
  repair_message_id text
)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, clockgrove
AS $$
DECLARE
  tenant text := clockgrove.runtime_tenant_id();
  dispatch clockgrove.event_dispatches%ROWTYPE;
  outcome text;
BEGIN
  IF NOT clockgrove.has_runtime_context(tenant) THEN
    RAISE EXCEPTION 'publication repair requires a tenant member' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO dispatch FROM clockgrove.event_dispatches AS candidate
   WHERE candidate.tenant_id = tenant AND candidate.dispatch_id = repair_message_id
     AND candidate.channel = 'world-reactions' AND candidate.world_id = repair_world_id
     AND candidate.timeline_id = repair_timeline_id AND candidate.space_id = repair_space_id
     AND clockgrove.runtime_can_access(candidate.tenant_id, candidate.privacy_class)
   FOR UPDATE;
  IF NOT FOUND THEN
    outcome := 'not-found';
  ELSIF dispatch.status <> 'failed' OR dispatch.consumed_at IS NOT NULL THEN
    outcome := 'not-failed';
  ELSE
    UPDATE clockgrove.event_dispatches
       SET status = 'pending', lease_owner = NULL, next_attempt_at = statement_timestamp(),
           settled_at = NULL
     WHERE tenant_id = tenant AND dispatch_id = repair_message_id;
    outcome := 'repaired';
  END IF;
  PERFORM clockgrove.record_runtime_operator_action(
    repair_world_id, repair_timeline_id, repair_space_id, 'repair-publication', repair_message_id,
    'allow', outcome
  );
  RETURN outcome;
END;
$$;
REVOKE ALL ON FUNCTION clockgrove.repair_world_reaction_publication(text, text, text, text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clockgrove.repair_world_reaction_publication(text, text, text, text)
  TO clockgrove_runtime;

-- 4. Why a world-reactions message went to the physical DLQ, where its identity resolves: the
--    consumer records the failure class of a message's last attempt on its source dispatch, so the
--    runtime-state inspection shows it. A fixed-size pair, overwritten in place by a later dead
--    letter of the same message; neither changes publication or consumption. Like
--    `world_reaction_principal` (0024), a trusted runtime capability that the envelope's tenant and
--    message ID select; only an actual public world-reactions dispatch is marked.
ALTER TABLE clockgrove.event_dispatches
  ADD COLUMN dead_letter_class text
    CHECK (dead_letter_class IN ('malformed', 'inconsistent', 'transient', 'internal')),
  ADD COLUMN dead_lettered_at timestamptz,
  ADD CONSTRAINT event_dispatches_dead_letter_complete
    CHECK ((dead_letter_class IS NULL) = (dead_lettered_at IS NULL));

CREATE FUNCTION clockgrove.record_world_reaction_dead_letter(
  dead_tenant_id text,
  dead_message_id text,
  dead_class text
)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, clockgrove
AS $$
  WITH marked AS (
    UPDATE clockgrove.event_dispatches AS dispatch
       SET dead_letter_class = dead_class, dead_lettered_at = statement_timestamp()
     WHERE dispatch.tenant_id = dead_tenant_id AND dispatch.dispatch_id = dead_message_id
       AND dispatch.channel = 'world-reactions' AND dispatch.privacy_class = 'public_scene'
    RETURNING 1
  )
  SELECT count(*) = 1 FROM marked;
$$;
REVOKE ALL ON FUNCTION clockgrove.record_world_reaction_dead_letter(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clockgrove.record_world_reaction_dead_letter(text, text, text)
  TO clockgrove_runtime;

-- 5. The inspection lists a scope's unresolved world-reactions messages (not yet consumed: pending,
--    leased, failed or published and in flight or dead-lettered). Rows leave this partial index once
--    consumed, so it holds only unresolved work and the read costs that, not the world's history.
CREATE INDEX event_dispatches_unconsumed_world_reactions
  ON clockgrove.event_dispatches (tenant_id, world_id, timeline_id, space_id, created_at)
  WHERE channel = 'world-reactions' AND consumed_at IS NULL;
