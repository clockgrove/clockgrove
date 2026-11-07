-- Attributed command receipts, immutable authority decisions and database-enforced immutability.
-- Additive: existing receipts become provenance 'legacy-wave0' with no attribution or decision, no
-- foreign key points from existing events to decision rows, and no stored event bytes change.

-- Receipt lifecycle: pending -> committed | rejected | failed. Terminal receipts never change.
ALTER TABLE clockgrove.command_receipts
  DROP CONSTRAINT command_receipts_status_check,
  ADD CONSTRAINT command_receipts_status_check
    CHECK (status IN ('pending', 'committed', 'rejected', 'failed')),
  ADD COLUMN provenance text NOT NULL DEFAULT 'legacy-wave0'
    CHECK (provenance IN ('attributed', 'legacy-wave0')),
  ADD COLUMN attribution jsonb,
  ADD COLUMN action_id text,
  ADD COLUMN correlation_id text,
  ADD COLUMN causation_id text,
  ADD COLUMN expected jsonb,
  ADD COLUMN authority_decision_id text,
  ADD COLUMN failed_at timestamptz;

-- Existing rows keep 'legacy-wave0'; every new row states its provenance.
ALTER TABLE clockgrove.command_receipts ALTER COLUMN provenance DROP DEFAULT;

-- Legacy receipts carry correlation and expected revisions only where already stored: the
-- correlation of the command's first event (else the command bytes' context) and the command bytes'
-- expected values. Attribution, ActionId and decisions are never invented for them.
DO $$
DECLARE
  legacy record;
  parsed jsonb;
BEGIN
  FOR legacy IN SELECT tenant_id, command_id, command_bytes FROM clockgrove.command_receipts LOOP
    BEGIN
      parsed := convert_from(legacy.command_bytes, 'UTF8')::jsonb;
    EXCEPTION WHEN OTHERS THEN
      parsed := NULL;
    END;
    IF jsonb_typeof(parsed) IS DISTINCT FROM 'object' THEN
      parsed := '{}'::jsonb;
    END IF;
    UPDATE clockgrove.command_receipts AS receipt
       SET correlation_id = coalesce(
             (SELECT event.correlation_id FROM clockgrove.events AS event
               WHERE event.tenant_id = receipt.tenant_id AND event.command_id = receipt.command_id
               ORDER BY event.journal_position LIMIT 1),
             parsed#>>'{context,correlationId}'),
           expected = CASE
             WHEN jsonb_typeof(parsed->'expected') = 'object' THEN parsed->'expected'
             ELSE '{}'::jsonb
           END
     WHERE receipt.tenant_id = legacy.tenant_id AND receipt.command_id = legacy.command_id;
  END LOOP;
END;
$$;

ALTER TABLE clockgrove.command_receipts
  ADD CONSTRAINT command_receipts_provenance_shape CHECK (
    (provenance = 'legacy-wave0'
      AND attribution IS NULL AND action_id IS NULL AND authority_decision_id IS NULL)
    OR (provenance = 'attributed'
      AND jsonb_typeof(attribution) = 'object'
      AND action_id IS NOT NULL
      AND action_id = attribution->>'causalRootActionId'
      AND correlation_id IS NOT NULL
      AND jsonb_typeof(expected) = 'object'
      AND (status = 'pending') = (authority_decision_id IS NULL))
  ),
  ADD CONSTRAINT command_receipts_committed_at_shape
    CHECK ((status IN ('committed', 'rejected')) = (committed_at IS NOT NULL)),
  ADD CONSTRAINT command_receipts_failed_at_shape
    CHECK ((status = 'failed') = (failed_at IS NOT NULL));

-- One immutable allow or deny decision per (tenant, command), minted by trusted application code.
CREATE TABLE clockgrove.authority_decisions (
  tenant_id text NOT NULL REFERENCES clockgrove.tenants (tenant_id),
  authority_decision_id text NOT NULL,
  command_id text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('allow', 'deny')),
  world_id text NOT NULL,
  timeline_id text NOT NULL,
  action_id text NOT NULL,
  attribution jsonb NOT NULL CHECK (jsonb_typeof(attribution) = 'object'),
  inputs jsonb NOT NULL CHECK (jsonb_typeof(inputs) = 'object'),
  reason_code text,
  decided_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (tenant_id, authority_decision_id),
  UNIQUE (tenant_id, command_id),
  UNIQUE (tenant_id, authority_decision_id, command_id),
  CHECK ((outcome = 'deny') = (reason_code IS NOT NULL)),
  CHECK (action_id = attribution->>'causalRootActionId'),
  FOREIGN KEY (tenant_id, command_id)
    REFERENCES clockgrove.command_receipts (tenant_id, command_id),
  FOREIGN KEY (tenant_id, world_id, timeline_id)
    REFERENCES clockgrove.timelines (tenant_id, world_id, timeline_id)
);

ALTER TABLE clockgrove.command_receipts
  ADD CONSTRAINT command_receipts_authority_decision_fkey
    FOREIGN KEY (tenant_id, authority_decision_id, command_id)
    REFERENCES clockgrove.authority_decisions (tenant_id, authority_decision_id, command_id);

CREATE FUNCTION clockgrove.reject_journal_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME USING ERRCODE = 'CG006';
END;
$$;

-- Receipt identity (and the decision reference once set) never changes; only a pending receipt may
-- move, and only to a terminal status. Receipts are never deleted.
CREATE FUNCTION clockgrove.guard_command_receipt() RETURNS trigger
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

CREATE TRIGGER command_receipts_guard_transition
  BEFORE UPDATE OR DELETE ON clockgrove.command_receipts
  FOR EACH ROW EXECUTE FUNCTION clockgrove.guard_command_receipt();
CREATE TRIGGER command_receipts_immutable_truncate
  BEFORE TRUNCATE ON clockgrove.command_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION clockgrove.reject_journal_mutation();
CREATE TRIGGER authority_decisions_immutable_rows
  BEFORE UPDATE OR DELETE ON clockgrove.authority_decisions
  FOR EACH ROW EXECUTE FUNCTION clockgrove.reject_journal_mutation();
CREATE TRIGGER authority_decisions_immutable_truncate
  BEFORE TRUNCATE ON clockgrove.authority_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION clockgrove.reject_journal_mutation();

ALTER TABLE clockgrove.authority_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE clockgrove.authority_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON clockgrove.authority_decisions
  USING (clockgrove.has_runtime_context(tenant_id))
  WITH CHECK (clockgrove.has_runtime_context(tenant_id));

REVOKE ALL ON clockgrove.authority_decisions FROM PUBLIC;
REVOKE ALL ON FUNCTION clockgrove.reject_journal_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION clockgrove.guard_command_receipt() FROM PUBLIC;
GRANT SELECT, INSERT ON clockgrove.authority_decisions TO clockgrove_runtime;
-- Committed events and dispatch intent are append-only for the runtime role, and receipts are
-- updated only along the state machine above.
REVOKE UPDATE, DELETE ON clockgrove.events, clockgrove.event_dispatches FROM clockgrove_runtime;
REVOKE DELETE ON clockgrove.command_receipts FROM clockgrove_runtime;

-- Engineering choice: the same single function owns the append statement layout. It now also
-- records the request's authority decision and the attributed receipt, and commits a denial as a
-- rejected receipt without events, dispatches or head changes.
CREATE OR REPLACE FUNCTION clockgrove.execute_journal(
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
  stored_receipt clockgrove.command_receipts%ROWTYPE;
  actual_stream bigint;
  actual_partition bigint;
  actual_epoch integer;
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
     OR jsonb_typeof(p_request->'expected') IS DISTINCT FROM 'object' THEN
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
    'after-receipt', 'after-head-locks', 'after-events', 'after-dispatches', 'before-commit'
  ) THEN
    RAISE EXCEPTION 'unknown journal failure stage' USING ERRCODE = '22023';
  END IF;
  -- (1) The target world and timeline must belong to the authorized tenant. Row-level security
  -- hides every other tenant's timelines, so a foreign or unknown scope writes nothing.
  IF NOT EXISTS (
    SELECT 1 FROM clockgrove.timelines AS timeline
     WHERE timeline.tenant_id = v_tenant AND timeline.world_id = v_world
       AND timeline.timeline_id = v_timeline
  ) THEN
    RAISE EXCEPTION 'journal route not found' USING ERRCODE = 'CG005';
  END IF;

  -- (2-3) Create/wait for and lock the receipt; compare exact bytes. A decided command returns
  -- its stored outcome without recording another decision.
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
    RETURN stored_receipt.result;
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
    -- A denial appends no events or dispatches and changes no heads.
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
    RETURN committed_result;
  END IF;

  -- (4) Acquire required partition and stream locks in stable lexical order.
  PERFORM 1 FROM clockgrove.timeline_partitions AS head
   WHERE head.tenant_id = v_tenant AND head.timeline_id = v_timeline
     AND head.partition_id IN (
       SELECT v_primary_partition UNION
       SELECT event->>'partitionId' FROM jsonb_array_elements(p_request->'events') AS event
     )
   ORDER BY head.tenant_id, head.timeline_id, head.partition_id FOR UPDATE;
  PERFORM 1 FROM clockgrove.streams AS head
   WHERE head.tenant_id = v_tenant AND head.timeline_id = v_timeline
     AND head.stream_id IN (
       SELECT v_primary_stream UNION
       SELECT event->>'streamId' FROM jsonb_array_elements(p_request->'events') AS event
     )
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
  IF p_failure_stage = 'after-head-locks' THEN
    RAISE EXCEPTION 'injected failure after head locks';
  END IF;

  -- (5) Expected values apply to the command's primary route.
  IF p_request#>'{expected,streamSequence}' IS NOT NULL
     AND (p_request#>>'{expected,streamSequence}')::bigint IS DISTINCT FROM actual_stream THEN
    RAISE EXCEPTION 'stream revision conflict' USING ERRCODE = 'CG002',
      DETAIL = (p_request#>>'{expected,streamSequence}') || ':' || actual_stream;
  END IF;
  IF p_request#>'{expected,partitionRevision}' IS NOT NULL
     AND (p_request#>>'{expected,partitionRevision}')::bigint IS DISTINCT FROM actual_partition THEN
    RAISE EXCEPTION 'partition revision conflict' USING ERRCODE = 'CG003',
      DETAIL = (p_request#>>'{expected,partitionRevision}') || ':' || actual_partition;
  END IF;
  IF p_request#>'{expected,routingEpoch}' IS NOT NULL
     AND (p_request#>>'{expected,routingEpoch}')::integer IS DISTINCT FROM actual_epoch THEN
    RAISE EXCEPTION 'routing epoch conflict' USING ERRCODE = 'CG004',
      DETAIL = (p_request#>>'{expected,routingEpoch}') || ':' || actual_epoch;
  END IF;

  -- (6) Validate each draft against its authoritative current stream/partition route.
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

  -- (7-8) Allocate distinct local sequences and append immutable semantic bytes.
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

  -- (9) There are no projection/schedule tables yet. (10) Outbox intent.
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

  -- (11) Persist the complete stable response and the decision reference before the caller commits.
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
  RETURN committed_result;
END;
$$;
