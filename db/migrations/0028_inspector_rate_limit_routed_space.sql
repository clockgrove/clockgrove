-- #749: a command receipt stores the space its command was routed to, so the causal-chain
-- inspector scopes a command by it, not by where its readable events landed. A rejected command
-- (no events) and a caller whose ceiling hides the events are then served under the same
-- space-scope check. Receipts from before this migration, and a denial sent without a route, keep
-- NULL; the inspector falls back to the event span for them. The routed space is receipt identity:
-- it never changes once written.
ALTER TABLE clockgrove.command_receipts
  ADD COLUMN routed_space_id text CHECK (octet_length(routed_space_id) BETWEEN 1 AND 1024);

-- Same checks as 0006, plus the routed space.
CREATE OR REPLACE FUNCTION clockgrove.guard_command_receipt() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'command receipts are immutable' USING ERRCODE = 'CG006';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.command_id IS DISTINCT FROM OLD.command_id
    OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
    OR NEW.command_bytes IS DISTINCT FROM OLD.command_bytes
    OR NEW.target_address IS DISTINCT FROM OLD.target_address
    OR NEW.routed_space_id IS DISTINCT FROM OLD.routed_space_id
    OR NEW.provenance IS DISTINCT FROM OLD.provenance
    OR NEW.attribution IS DISTINCT FROM OLD.attribution
    OR NEW.action_id IS DISTINCT FROM OLD.action_id
    OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
    OR NEW.causation_id IS DISTINCT FROM OLD.causation_id
    OR NEW.expected IS DISTINCT FROM OLD.expected
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR (OLD.authority_decision_id IS NOT NULL
      AND NEW.authority_decision_id IS DISTINCT FROM OLD.authority_decision_id) THEN
    RAISE EXCEPTION 'command receipt identity is immutable' USING ERRCODE = 'CG006';
  END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'command receipt is terminal' USING ERRCODE = 'CG006';
  END IF;
  RETURN NEW;
END;
$$;

-- Same as 0007, except that the receipt insert stores `route.spaceId`. An allow decision already
-- requires the route and verifies it against the stream head below; a denial's route is built by
-- trusted code from the canonical placement (world-commands.ts `deny`).
CREATE OR REPLACE FUNCTION clockgrove.begin_command(
  p_command_bytes bytea,
  p_request jsonb,
  p_failure_stage text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_tenant text := clockgrove.runtime_tenant_id();
  v_command_id text := p_request->>'commandId';
  v_request_hash text := 'sha256:' || encode(sha256(p_command_bytes), 'hex');
  v_timeline text := p_request#>>'{target,timelineId}';
  v_world text := p_request#>>'{target,worldId}';
  v_primary_partition text := p_request#>>'{route,partitionId}';
  v_primary_space text := p_request#>>'{route,spaceId}';
  v_primary_stream text := p_request#>>'{route,streamId}';
  v_attribution jsonb := p_request->'attribution';
  v_decision jsonb := p_request->'authorityDecision';
  v_decision_id text := p_request#>>'{authorityDecision,authorityDecisionId}';
  v_outcome text := p_request#>>'{authorityDecision,outcome}';
  v_aggregate boolean := coalesce((p_request->>'aggregate')::boolean, false);
  v_partitions jsonb;
  v_streams jsonb;
  stored_receipt clockgrove.command_receipts%ROWTYPE;
  stored_state clockgrove.partition_states%ROWTYPE;
  actual_stream bigint;
  actual_partition bigint;
  actual_epoch integer;
  actual_revision bigint;
  content_hash text;
  aggregate jsonb := NULL;
  rejected_result jsonb;
BEGIN
  IF v_tenant IS NULL OR v_command_id IS NULL OR p_command_bytes IS NULL
     OR v_timeline IS NULL OR v_world IS NULL
     OR p_request#>>'{target,tenantId}' IS DISTINCT FROM v_tenant
     OR jsonb_typeof(p_request->'events') IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_request->'dispatches') IS DISTINCT FROM 'array'
     OR NOT p_request ? 'stableResult' OR NOT p_request ? 'projectionDelta'
     OR jsonb_typeof(v_attribution) IS DISTINCT FROM 'object'
     OR v_attribution->>'causalRootActionId' IS NULL
     OR p_request->>'correlationId' IS NULL
     OR jsonb_typeof(p_request->'expected') IS DISTINCT FROM 'object'
     OR (p_request ? 'aggregate' AND jsonb_typeof(p_request->'aggregate') IS DISTINCT FROM 'boolean') THEN
    RAISE EXCEPTION 'malformed journal request' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(v_decision) IS DISTINCT FROM 'object'
     OR v_decision->'version' IS DISTINCT FROM '1'::jsonb
     OR v_decision_id IS NULL
     OR v_outcome IS NULL OR v_outcome NOT IN ('allow', 'deny')
     OR v_decision->>'tenantId' IS DISTINCT FROM v_tenant
     OR v_decision->>'worldId' IS DISTINCT FROM v_world
     OR v_decision->>'timelineId' IS DISTINCT FROM v_timeline
     OR v_decision->>'commandId' IS DISTINCT FROM v_command_id
     OR v_decision->'attribution' IS DISTINCT FROM v_attribution
     OR v_decision->>'actionId' IS DISTINCT FROM v_attribution->>'causalRootActionId'
     OR jsonb_typeof(v_decision->'inputs') IS DISTINCT FROM 'object'
     OR (v_outcome = 'deny') <> (jsonb_typeof(v_decision->'reasonCode') = 'string') THEN
    RAISE EXCEPTION 'malformed authority decision' USING ERRCODE = '22023';
  END IF;
  IF v_outcome = 'allow' AND (
       v_primary_partition IS NULL OR v_primary_space IS NULL OR v_primary_stream IS NULL
     ) OR v_outcome = 'deny' AND (
       jsonb_array_length(p_request->'events') <> 0
       OR jsonb_array_length(p_request->'dispatches') <> 0
     ) THEN
    RAISE EXCEPTION 'malformed journal request' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_request->'events') AS proposed(event)
     WHERE proposed.event#>>'{attribution,authorityDecisionId}' IS DISTINCT FROM v_decision_id
  ) THEN
    RAISE EXCEPTION 'event draft seals another authority decision' USING ERRCODE = 'CG007';
  END IF;
  IF p_failure_stage IS NOT NULL AND p_failure_stage NOT IN (
    'after-receipt', 'after-head-locks', 'after-events', 'after-dispatches', 'after-state',
    'before-commit'
  ) THEN
    RAISE EXCEPTION 'unknown journal failure stage' USING ERRCODE = '22023';
  END IF;
  IF nullif(current_setting('app.journal_command', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'a journal command is already open in this transaction' USING ERRCODE = '22023';
  END IF;
  -- The target world and timeline must belong to the authorized tenant. Row-level security hides
  -- every other tenant's timelines, so a foreign or unknown scope writes nothing.
  IF NOT EXISTS (
    SELECT 1 FROM clockgrove.timelines AS timeline
     WHERE timeline.tenant_id = v_tenant AND timeline.world_id = v_world
       AND timeline.timeline_id = v_timeline
  ) THEN
    RAISE EXCEPTION 'journal route not found' USING ERRCODE = 'CG005';
  END IF;

  -- Create/wait for and lock the receipt; compare exact bytes. A decided command returns its stored
  -- outcome without recording another decision.
  INSERT INTO clockgrove.command_receipts (
    tenant_id, command_id, request_hash, command_bytes, target_address, status, provenance,
    attribution, action_id, correlation_id, causation_id, expected, routed_space_id
  ) VALUES (
    v_tenant, v_command_id, v_request_hash, p_command_bytes, p_request->'target', 'pending',
    'attributed', v_attribution, v_attribution->>'causalRootActionId',
    p_request->>'correlationId', p_request->>'causationId', p_request->'expected', v_primary_space
  ) ON CONFLICT ON CONSTRAINT command_receipts_pkey DO NOTHING;
  SELECT * INTO STRICT stored_receipt
    FROM clockgrove.command_receipts AS receipt
   WHERE receipt.tenant_id = v_tenant AND receipt.command_id = v_command_id
   FOR UPDATE;
  IF stored_receipt.command_bytes IS DISTINCT FROM p_command_bytes
     OR stored_receipt.request_hash IS DISTINCT FROM v_request_hash THEN
    RAISE EXCEPTION 'command ID reused with different bytes' USING ERRCODE = 'CG001';
  END IF;
  IF stored_receipt.status IN ('committed', 'rejected') THEN
    RETURN jsonb_build_object('status', 'decided', 'result', stored_receipt.result);
  END IF;
  IF stored_receipt.status = 'failed' THEN
    RAISE EXCEPTION 'command receipt failed' USING ERRCODE = 'CG008';
  END IF;
  IF p_failure_stage = 'after-receipt' THEN
    RAISE EXCEPTION 'injected failure after receipt';
  END IF;

  INSERT INTO clockgrove.authority_decisions (
    tenant_id, authority_decision_id, command_id, outcome, world_id, timeline_id, action_id,
    attribution, inputs, reason_code
  ) VALUES (
    v_tenant, v_decision_id, v_command_id, v_outcome, v_world, v_timeline,
    v_attribution->>'causalRootActionId', v_attribution, v_decision->'inputs',
    v_decision->>'reasonCode'
  );

  IF v_outcome = 'deny' THEN
    -- A denial appends no events or dispatches and changes no heads or state.
    rejected_result := jsonb_build_object(
      'value', p_request->'stableResult', 'events', '[]'::jsonb,
      'projectionDelta', p_request->'projectionDelta', 'outcome', 'rejected'
    );
    UPDATE clockgrove.command_receipts AS receipt
       SET status = 'rejected', result = rejected_result,
           authority_decision_id = v_decision_id, committed_at = statement_timestamp()
     WHERE receipt.tenant_id = v_tenant AND receipt.command_id = v_command_id;
    IF p_failure_stage = 'before-commit' THEN
      RAISE EXCEPTION 'injected failure before commit';
    END IF;
    RETURN jsonb_build_object('status', 'decided', 'result', rejected_result);
  END IF;

  -- The lock set: the primary route plus every draft known now. Partition heads, then stream heads,
  -- each in stable lexical order. `append_command` writes only inside this set.
  SELECT coalesce(jsonb_agg(key ORDER BY key), '[]'::jsonb) INTO v_partitions FROM (
    SELECT v_primary_partition AS key UNION
    SELECT event->>'partitionId' FROM jsonb_array_elements(p_request->'events') AS event
  ) AS keys;
  SELECT coalesce(jsonb_agg(key ORDER BY key), '[]'::jsonb) INTO v_streams FROM (
    SELECT v_primary_stream AS key UNION
    SELECT event->>'streamId' FROM jsonb_array_elements(p_request->'events') AS event
  ) AS keys;
  PERFORM 1 FROM clockgrove.timeline_partitions AS head
   WHERE head.tenant_id = v_tenant AND head.timeline_id = v_timeline
     AND head.partition_id IN (SELECT jsonb_array_elements_text(v_partitions))
   ORDER BY head.tenant_id, head.timeline_id, head.partition_id FOR UPDATE;
  PERFORM 1 FROM clockgrove.streams AS head
   WHERE head.tenant_id = v_tenant AND head.timeline_id = v_timeline
     AND head.stream_id IN (SELECT jsonb_array_elements_text(v_streams))
   ORDER BY head.tenant_id, head.timeline_id, head.stream_id FOR UPDATE;
  SELECT stream_head.current_sequence, partition_head.head_sequence, partition_head.routing_epoch
    INTO actual_stream, actual_partition, actual_epoch
    FROM clockgrove.streams AS stream_head
    JOIN clockgrove.timeline_partitions AS partition_head
      ON partition_head.tenant_id = stream_head.tenant_id
     AND partition_head.timeline_id = stream_head.timeline_id
     AND partition_head.partition_id = stream_head.partition_id
     AND partition_head.space_id = stream_head.space_id
   WHERE stream_head.tenant_id = v_tenant AND stream_head.world_id = v_world
     AND stream_head.timeline_id = v_timeline AND stream_head.partition_id = v_primary_partition
     AND stream_head.space_id = v_primary_space AND stream_head.stream_id = v_primary_stream;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'journal route not found' USING ERRCODE = 'CG005';
  END IF;

  -- A world command also locks its partition's state; that row exists only once the world is live.
  actual_revision := actual_partition;
  IF v_aggregate THEN
    SELECT * INTO stored_state
      FROM clockgrove.partition_states AS state
     WHERE state.tenant_id = v_tenant AND state.world_id = v_world
       AND state.timeline_id = v_timeline AND state.partition_id = v_primary_partition
       AND state.space_id = v_primary_space
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'partition state not found' USING ERRCODE = 'CG005';
    END IF;
    actual_revision := stored_state.revision;
    SELECT installation.content_hash INTO content_hash
      FROM clockgrove_birth.pack_installations AS installation
     WHERE installation.tenant_id = v_tenant AND installation.world_id = v_world;
    aggregate := jsonb_build_object(
      'revision', stored_state.revision::text,
      'coveredHeadSequence', stored_state.covered_head_sequence::text,
      'simulationTime', stored_state.simulation_time::text,
      'documentVersion', stored_state.document_version,
      'document', stored_state.document,
      'documentHash', stored_state.document_hash,
      'stateHash', stored_state.state_hash,
      'packContentHash', content_hash
    );
  END IF;
  IF p_failure_stage = 'after-head-locks' THEN
    RAISE EXCEPTION 'injected failure after head locks';
  END IF;

  -- Expected values apply to the command's primary route. The partition revision a client sees is
  -- the kernel revision for a world command and the journal head otherwise.
  IF p_request#>'{expected,streamSequence}' IS NOT NULL
     AND (p_request#>>'{expected,streamSequence}')::bigint IS DISTINCT FROM actual_stream THEN
    RAISE EXCEPTION 'stream revision conflict' USING ERRCODE = 'CG002',
      DETAIL = (p_request#>>'{expected,streamSequence}') || ':' || actual_stream;
  END IF;
  IF p_request#>'{expected,partitionRevision}' IS NOT NULL
     AND (p_request#>>'{expected,partitionRevision}')::bigint IS DISTINCT FROM actual_revision THEN
    RAISE EXCEPTION 'partition revision conflict' USING ERRCODE = 'CG003',
      DETAIL = (p_request#>>'{expected,partitionRevision}') || ':' || actual_revision;
  END IF;
  IF p_request#>'{expected,routingEpoch}' IS NOT NULL
     AND (p_request#>>'{expected,routingEpoch}')::integer IS DISTINCT FROM actual_epoch THEN
    RAISE EXCEPTION 'routing epoch conflict' USING ERRCODE = 'CG004',
      DETAIL = (p_request#>>'{expected,routingEpoch}') || ':' || actual_epoch;
  END IF;

  PERFORM set_config('app.journal_command', jsonb_build_object(
    'tenantId', v_tenant, 'commandId', v_command_id, 'worldId', v_world,
    'timelineId', v_timeline, 'authorityDecisionId', v_decision_id,
    'route', p_request->'route', 'partitions', v_partitions, 'streams', v_streams,
    'basisRevision', CASE WHEN v_aggregate THEN to_jsonb(stored_state.revision::text) ELSE NULL END
  )::text, true);
  RETURN jsonb_build_object('status', 'begun', 'aggregate', aggregate);
END;
$$;


-- #748: inspector requests are rate-limited per principal in each tenant, counted from the
-- principal's own audit rows, so no counter table is added and nothing new grows.
--
-- Decision: 300 accesses per principal per tenant in any trailing hour. A chain is walked one
-- command per request, and one due-work call commits at most 64 commands (`advanceDueWork`
-- maxCommands default), so 300 covers several full walks an hour. It caps one principal's rows in
-- one tenant at 7,200 a day, about 650k within the 90-day retention (0023).
--
-- Over the limit, an allow (a tenant member holding the inspect grant) is refused with CG013 and the
-- runtime answers 429. A denial is still refused alike, but is not recorded: answering denials
-- differently would show which tenants exist (a missing tenant records nothing, so it would never
-- hit the limit). The audit keeps the first 300 denials of the hour, which is the probing signal.
--
-- Decision: identical denials are not coalesced. Rows are immutable, so coalescing would either
-- drop the count or need a mutable counter on an audit table; the limit already bounds them.
-- The cap is exact: `record_inspector_access` takes a transaction-scoped advisory lock per tenant and
-- principal before it counts, so concurrent accesses of one principal count and insert one at a time.
-- A burst that passed the pre-read check is refused at record time (CG013, 429) with nothing returned.
CREATE INDEX inspector_accesses_principal_accessed_at
  ON clockgrove.inspector_accesses (tenant_id, principal_id, accessed_at);

-- Whether the installed tenant member may make another inspector access now. Checked before the
-- chain is read, so a limited request reads nothing. A non-member is always admitted here: its
-- denial is limited silently by `record_inspector_access`.
CREATE FUNCTION clockgrove.inspector_access_admitted()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, clockgrove
AS $$
  SELECT NOT clockgrove.has_runtime_context(clockgrove.runtime_tenant_id())
      OR count(*) < 300
    FROM (
      SELECT 1 FROM clockgrove.inspector_accesses AS recent
       WHERE recent.tenant_id = clockgrove.runtime_tenant_id()
         AND recent.principal_id = clockgrove.runtime_principal_id()
         AND recent.accessed_at > statement_timestamp() - interval '1 hour'
       LIMIT 300
    ) AS window_rows;
$$;
REVOKE ALL ON FUNCTION clockgrove.inspector_access_admitted() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clockgrove.inspector_access_admitted() TO clockgrove_runtime;

-- Same signature, checks, insert and retirement as 0023, after the rate limit.
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
    tenant_id, principal_id, world_id, timeline_id, space_id, command_id, decision, reason_code
  ) VALUES (
    tenant, principal, access_world_id, access_timeline_id, access_space_id, access_command_id,
    access_decision, access_reason_code
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
