-- World commands run through the Wave 1 kernel inside the canonical journal transaction.
-- Additive: one partition-state projection table, and `execute_journal` split into `begin_command`
-- and `append_command`. `execute_journal` stays as their wrapper, so world provisioning and the
-- runtime no-op keep one SQL path. No earlier migration, row or stored event byte changes.

-- One hashed state document per partition: the kernel's state, schedule queue and named random
-- state, at the kernel revision the client sees (D1), and the journal head it covers. The privacy
-- ceiling applies to reads of events, not to the kernel's state load, so the row has no privacy class.
CREATE TABLE clockgrove.partition_states (
  tenant_id text NOT NULL,
  world_id text NOT NULL,
  timeline_id text NOT NULL,
  partition_id text NOT NULL,
  space_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision >= 0),
  covered_head_sequence bigint NOT NULL CHECK (covered_head_sequence >= 0),
  simulation_time bigint NOT NULL,
  document_version integer NOT NULL CHECK (document_version = 1),
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'array'),
  document_hash text NOT NULL CHECK (document_hash ~ '^[0-9a-f]{64}$'),
  state_hash text NOT NULL CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (tenant_id, timeline_id, partition_id),
  FOREIGN KEY (tenant_id, world_id, timeline_id, partition_id, space_id)
    REFERENCES clockgrove.timeline_partitions (
      tenant_id, world_id, timeline_id, partition_id, space_id
    )
);

-- Identity never changes, revision and covered head never move back, and rows are never deleted.
CREATE FUNCTION clockgrove.guard_partition_state() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'partition states are never deleted' USING ERRCODE = 'CG006';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.world_id IS DISTINCT FROM OLD.world_id
    OR NEW.timeline_id IS DISTINCT FROM OLD.timeline_id
    OR NEW.partition_id IS DISTINCT FROM OLD.partition_id
    OR NEW.space_id IS DISTINCT FROM OLD.space_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'partition state identity is immutable' USING ERRCODE = 'CG006';
  END IF;
  IF NEW.revision < OLD.revision OR NEW.covered_head_sequence < OLD.covered_head_sequence THEN
    RAISE EXCEPTION 'partition state never moves back' USING ERRCODE = 'CG006';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER partition_states_guard
  BEFORE UPDATE OR DELETE ON clockgrove.partition_states
  FOR EACH ROW EXECUTE FUNCTION clockgrove.guard_partition_state();

ALTER TABLE clockgrove.partition_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE clockgrove.partition_states FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON clockgrove.partition_states
  USING (clockgrove.has_runtime_context(tenant_id))
  WITH CHECK (clockgrove.has_runtime_context(tenant_id));

REVOKE ALL ON clockgrove.partition_states FROM PUBLIC;
REVOKE ALL ON FUNCTION clockgrove.guard_partition_state() FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON clockgrove.partition_states TO clockgrove_runtime;

-- Opens one command in the caller's transaction: validates the request and decision, checks the
-- tenant's route, creates or locks the attributed receipt and compares exact bytes. A decided command
-- returns `{status: 'decided', result}` with its stored outcome; a deny decision commits its rejected
-- receipt the same way. An allow decision is recorded, the partition and stream heads are locked in
-- lexical key order, and expected values are checked; for a world command (`aggregate: true`) the
-- partition-state row is locked too and `expected.partitionRevision` is the kernel revision (D1).
-- It returns `{status: 'begun', aggregate}` and records the open command and its lock set
-- transaction-locally for `append_command`.
CREATE FUNCTION clockgrove.begin_command(
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
    attribution, action_id, correlation_id, causation_id, expected
  ) VALUES (
    v_tenant, v_command_id, v_request_hash, p_command_bytes, p_request->'target', 'pending',
    'attributed', v_attribution, v_attribution->>'causalRootActionId',
    p_request->>'correlationId', p_request->>'causationId', p_request->'expected'
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

-- Closes the command opened by `begin_command` in this transaction. A `rejected` outcome (a domain
-- refusal under the allow decision) commits a rejected receipt and writes nothing else. A `committed`
-- outcome validates the drafts (sealed decision, inside the locked set, authoritative routes),
-- allocates sequences, appends events and dispatch intent, writes the partition state against its
-- basis revision with the head it now covers, and stores the stable result on the receipt.
CREATE FUNCTION clockgrove.append_command(
  p_request jsonb,
  p_failure_stage text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_tenant text := clockgrove.runtime_tenant_id();
  v_open jsonb := nullif(current_setting('app.journal_command', true), '')::jsonb;
  v_command_id text := p_request->>'commandId';
  v_outcome text := p_request->>'outcome';
  v_world text;
  v_timeline text;
  v_decision_id text;
  v_partition text;
  v_space text;
  v_state jsonb := p_request->'state';
  draft jsonb;
  canonical_event jsonb;
  committed_events jsonb := '[]'::jsonb;
  committed_result jsonb;
  stream_sequence bigint;
  partition_sequence bigint;
  journal_position bigint;
  recorded_at text;
  dispatch jsonb;
  matched integer;
  actual_revision bigint;
BEGIN
  IF v_open IS NULL OR v_tenant IS NULL OR v_command_id IS NULL
     OR v_open->>'tenantId' IS DISTINCT FROM v_tenant
     OR v_open->>'commandId' IS DISTINCT FROM v_command_id THEN
    RAISE EXCEPTION 'no journal command is open for this request' USING ERRCODE = '22023';
  END IF;
  v_world := v_open->>'worldId';
  v_timeline := v_open->>'timelineId';
  v_decision_id := v_open->>'authorityDecisionId';
  v_partition := v_open#>>'{route,partitionId}';
  v_space := v_open#>>'{route,spaceId}';
  IF v_outcome IS NULL OR v_outcome NOT IN ('committed', 'rejected')
     OR jsonb_typeof(p_request->'events') IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_request->'dispatches') IS DISTINCT FROM 'array'
     OR NOT p_request ? 'stableResult' OR NOT p_request ? 'projectionDelta'
     OR (v_outcome = 'rejected' AND (
       jsonb_array_length(p_request->'events') <> 0
       OR jsonb_array_length(p_request->'dispatches') <> 0 OR v_state IS NOT NULL))
     OR (v_outcome = 'committed'
       AND (v_open->'basisRevision' IS NOT NULL AND jsonb_typeof(v_open->'basisRevision') <> 'null')
         <> (v_state IS NOT NULL)) THEN
    RAISE EXCEPTION 'malformed journal append' USING ERRCODE = '22023';
  END IF;
  IF p_failure_stage IS NOT NULL AND p_failure_stage NOT IN (
    'after-receipt', 'after-head-locks', 'after-events', 'after-dispatches', 'after-state',
    'before-commit'
  ) THEN
    RAISE EXCEPTION 'unknown journal failure stage' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM clockgrove.command_receipts AS receipt
   WHERE receipt.tenant_id = v_tenant AND receipt.command_id = v_command_id
     AND receipt.status = 'pending'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no journal command is open for this request' USING ERRCODE = '22023';
  END IF;

  IF v_outcome = 'rejected' THEN
    -- A domain refusal under the allow decision: no events, dispatches, heads or state change.
    committed_result := jsonb_build_object(
      'value', p_request->'stableResult', 'events', '[]'::jsonb,
      'projectionDelta', p_request->'projectionDelta', 'outcome', 'rejected'
    );
    UPDATE clockgrove.command_receipts AS receipt
       SET status = 'rejected', result = committed_result,
           authority_decision_id = v_decision_id, committed_at = statement_timestamp()
     WHERE receipt.tenant_id = v_tenant AND receipt.command_id = v_command_id;
    IF p_failure_stage = 'before-commit' THEN
      RAISE EXCEPTION 'injected failure before commit';
    END IF;
    PERFORM set_config('app.journal_command', '', true);
    RETURN committed_result;
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_request->'events') AS proposed(event)
     WHERE proposed.event#>>'{attribution,authorityDecisionId}' IS DISTINCT FROM v_decision_id
  ) THEN
    RAISE EXCEPTION 'event draft seals another authority decision' USING ERRCODE = 'CG007';
  END IF;
  -- Drafts stay inside the lock set taken by begin_command; a transaction never widens it.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_request->'events') AS proposed(event)
     WHERE NOT (v_open->'partitions') ? (proposed.event->>'partitionId')
        OR NOT (v_open->'streams') ? (proposed.event->>'streamId')
  ) THEN
    RAISE EXCEPTION 'event draft is outside the locked heads' USING ERRCODE = 'CG005';
  END IF;
  -- Validate each draft against its authoritative current stream/partition route.
  SELECT count(*) INTO matched
    FROM jsonb_array_elements(p_request->'events') AS proposed(event)
    JOIN clockgrove.streams AS head
      ON head.tenant_id = v_tenant AND head.world_id = v_world AND head.timeline_id = v_timeline
     AND head.partition_id = proposed.event->>'partitionId'
     AND head.space_id = proposed.event->>'spaceId'
     AND head.stream_id = proposed.event->>'streamId'
   WHERE proposed.event->>'schemaVersion' = '2' AND proposed.event ? 'eventId'
     AND proposed.event ? 'type' AND proposed.event ? 'attribution'
     AND proposed.event ? 'policyVersions' AND proposed.event ? 'privacyClass'
     AND proposed.event ? 'payloadHash' AND proposed.event ? 'payload';
  IF matched <> jsonb_array_length(p_request->'events') THEN
    RAISE EXCEPTION 'event draft failed authoritative route validation' USING ERRCODE = 'CG005';
  END IF;

  -- Allocate distinct local sequences and append immutable semantic bytes.
  FOR draft IN SELECT value FROM jsonb_array_elements(p_request->'events') LOOP
    UPDATE clockgrove.streams SET current_sequence = current_sequence + 1
     WHERE tenant_id = v_tenant AND timeline_id = v_timeline
       AND partition_id = draft->>'partitionId' AND space_id = draft->>'spaceId'
       AND stream_id = draft->>'streamId'
     RETURNING current_sequence INTO STRICT stream_sequence;
    UPDATE clockgrove.timeline_partitions SET head_sequence = head_sequence + 1
     WHERE tenant_id = v_tenant AND timeline_id = v_timeline
       AND partition_id = draft->>'partitionId' AND space_id = draft->>'spaceId'
     RETURNING head_sequence INTO STRICT partition_sequence;
    journal_position := nextval(pg_get_serial_sequence('clockgrove.events', 'journal_position'));
    recorded_at := to_char(transaction_timestamp() AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
    canonical_event := jsonb_build_object(
      'schemaVersion', 2, 'eventId', draft->>'eventId', 'type', draft->>'type',
      'tenantId', v_tenant, 'worldId', v_world, 'timelineId', v_timeline,
      'partitionId', draft->>'partitionId', 'streamId', draft->>'streamId',
      'streamSequence', stream_sequence::text, 'partitionSequence', partition_sequence::text,
      'journalPosition', journal_position::text, 'simulationTime', draft->>'simulationTime',
      'recordedAt', recorded_at, 'commandId', v_command_id,
      'correlationId', draft->>'correlationId', 'attribution', draft->'attribution',
      'policyVersions', draft->'policyVersions', 'privacyClass', draft->>'privacyClass',
      'payloadHash', draft->>'payloadHash', 'payload', draft->'payload'
    )
    || CASE WHEN draft ? 'causationId' THEN jsonb_build_object('causationId', draft->>'causationId') ELSE '{}'::jsonb END
    || CASE WHEN draft ? 'actor' THEN jsonb_build_object('actor', draft->'actor') ELSE '{}'::jsonb END
    || CASE WHEN draft ? 'principalId' THEN jsonb_build_object('principalId', draft->>'principalId') ELSE '{}'::jsonb END
    || CASE WHEN draft ? 'decisionTraceId' THEN jsonb_build_object('decisionTraceId', draft->>'decisionTraceId') ELSE '{}'::jsonb END
    || CASE WHEN draft ? 'ruleFiringId' THEN jsonb_build_object('ruleFiringId', draft->>'ruleFiringId') ELSE '{}'::jsonb END;
    INSERT INTO clockgrove.events (
      event_id, tenant_id, world_id, timeline_id, partition_id, space_id, stream_id,
      stream_sequence, partition_sequence, journal_position, event_type, schema_version,
      simulation_time, recorded_at, command_id, correlation_id, causation_id, principal_id,
      actor_id, privacy_class, payload_hash, attribution, actor_address, policy_versions,
      payload, event_bytes
    ) OVERRIDING SYSTEM VALUE VALUES (
      draft->>'eventId', v_tenant, v_world, v_timeline, draft->>'partitionId', draft->>'spaceId',
      draft->>'streamId', stream_sequence, partition_sequence, journal_position,
      draft->>'type', 2, (draft->>'simulationTime')::bigint, recorded_at::timestamptz,
      v_command_id, draft->>'correlationId', draft->>'causationId', draft->>'principalId',
      draft#>>'{actor,id}', draft->>'privacyClass', draft->>'payloadHash',
      draft->'attribution', draft->'actor', draft->'policyVersions', draft->'payload',
      convert_to(canonical_event::text, 'UTF8')
    );
    committed_events := committed_events || jsonb_build_array(canonical_event);
  END LOOP;
  IF p_failure_stage = 'after-events' THEN RAISE EXCEPTION 'injected failure after events'; END IF;

  -- Outbox intent.
  FOR dispatch IN SELECT value FROM jsonb_array_elements(p_request->'dispatches') LOOP
    INSERT INTO clockgrove.event_dispatches (
      tenant_id, world_id, timeline_id, partition_id, space_id, dispatch_id,
      event_id, channel, status, privacy_class, payload
    )
    SELECT v_tenant, v_world, v_timeline, event.partition_id, event.space_id,
      dispatch->>'dispatchId', dispatch->>'eventId', dispatch->>'channel', 'pending',
      dispatch->>'privacyClass', dispatch->'payload'
      FROM clockgrove.events AS event
     WHERE event.tenant_id = v_tenant AND event.command_id = v_command_id
       AND event.event_id = dispatch->>'eventId';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'dispatch does not reference this command event' USING ERRCODE = '23503';
    END IF;
  END LOOP;
  IF p_failure_stage = 'after-dispatches' THEN
    RAISE EXCEPTION 'injected failure after dispatches';
  END IF;

  -- The partition state, written against the revision begin_command locked, now covers the head.
  IF v_state IS NOT NULL THEN
    IF jsonb_typeof(v_state->'document') IS DISTINCT FROM 'array'
       OR v_state->>'revision' IS NULL OR v_state->>'simulationTime' IS NULL
       OR v_state->>'documentHash' IS NULL OR v_state->>'stateHash' IS NULL THEN
      RAISE EXCEPTION 'malformed partition state' USING ERRCODE = '22023';
    END IF;
    UPDATE clockgrove.partition_states AS state
       SET revision = (v_state->>'revision')::bigint,
           simulation_time = (v_state->>'simulationTime')::bigint,
           document = v_state->'document',
           document_hash = v_state->>'documentHash',
           state_hash = v_state->>'stateHash',
           covered_head_sequence = head.head_sequence,
           updated_at = statement_timestamp()
      FROM clockgrove.timeline_partitions AS head
     WHERE state.tenant_id = v_tenant AND state.world_id = v_world
       AND state.timeline_id = v_timeline AND state.partition_id = v_partition
       AND state.space_id = v_space
       AND state.revision = (v_open->>'basisRevision')::bigint
       AND head.tenant_id = state.tenant_id AND head.timeline_id = state.timeline_id
       AND head.partition_id = state.partition_id;
    IF NOT FOUND THEN
      SELECT state.revision INTO actual_revision FROM clockgrove.partition_states AS state
       WHERE state.tenant_id = v_tenant AND state.timeline_id = v_timeline
         AND state.partition_id = v_partition;
      RAISE EXCEPTION 'partition revision conflict' USING ERRCODE = 'CG003',
        DETAIL = (v_open->>'basisRevision') || ':' || coalesce(actual_revision::text, '0');
    END IF;
  END IF;
  IF p_failure_stage = 'after-state' THEN RAISE EXCEPTION 'injected failure after state'; END IF;

  -- Persist the complete stable response and the decision reference before the caller commits.
  committed_result := jsonb_build_object(
    'value', p_request->'stableResult', 'events', committed_events,
    'projectionDelta', p_request->'projectionDelta'
  );
  UPDATE clockgrove.command_receipts AS receipt
     SET status = 'committed',
         canonical_event_ids = ARRAY(
           SELECT event->>'eventId' FROM jsonb_array_elements(committed_events) AS event
         ),
         result = committed_result, authority_decision_id = v_decision_id,
         committed_at = statement_timestamp()
   WHERE receipt.tenant_id = v_tenant AND receipt.command_id = v_command_id;
  IF p_failure_stage = 'before-commit' THEN RAISE EXCEPTION 'injected failure before commit'; END IF;
  PERFORM set_config('app.journal_command', '', true);
  RETURN committed_result;
END;
$$;

-- The single-statement path for commands whose drafts are known before the transaction (world
-- provisioning stages and the runtime no-op): begin, then append the same request.
CREATE OR REPLACE FUNCTION clockgrove.execute_journal(
  p_command_bytes bytea,
  p_request jsonb,
  p_failure_stage text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  begun jsonb;
BEGIN
  IF p_request ? 'aggregate' THEN
    RAISE EXCEPTION 'malformed journal request' USING ERRCODE = '22023';
  END IF;
  begun := clockgrove.begin_command(p_command_bytes, p_request, p_failure_stage);
  IF begun->>'status' = 'decided' THEN
    RETURN begun->'result';
  END IF;
  RETURN clockgrove.append_command(
    p_request || jsonb_build_object('outcome', 'committed'), p_failure_stage
  );
END;
$$;

REVOKE ALL ON FUNCTION clockgrove.begin_command(bytea, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION clockgrove.append_command(jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clockgrove.begin_command(bytea, jsonb, text) TO clockgrove_runtime;
GRANT EXECUTE ON FUNCTION clockgrove.append_command(jsonb, text) TO clockgrove_runtime;
