--
-- PostgreSQL database dump
--

\restrict clockgrove

-- Dumped from database version 18.6 (Ubuntu 18.6-1.pgdg26.04+2)
-- Dumped by pg_dump version 18.6 (Ubuntu 18.6-1.pgdg26.04+2)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: clockgrove; Type: SCHEMA; Schema: -; Owner: clockgrove_migrator
--

CREATE SCHEMA clockgrove;


ALTER SCHEMA clockgrove OWNER TO clockgrove_migrator;

--
-- Name: clockgrove_auth; Type: SCHEMA; Schema: -; Owner: clockgrove_migrator
--

CREATE SCHEMA clockgrove_auth;


ALTER SCHEMA clockgrove_auth OWNER TO clockgrove_migrator;

--
-- Name: clockgrove_birth; Type: SCHEMA; Schema: -; Owner: clockgrove_migrator
--

CREATE SCHEMA clockgrove_birth;


ALTER SCHEMA clockgrove_birth OWNER TO clockgrove_migrator;

--
-- Name: clockgrove_management; Type: SCHEMA; Schema: -; Owner: clockgrove_migrator
--

CREATE SCHEMA clockgrove_management;


ALTER SCHEMA clockgrove_management OWNER TO clockgrove_migrator;

--
-- Name: vector; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;


--
-- Name: EXTENSION vector; Type: COMMENT; Schema: -; Owner: 
--

COMMENT ON EXTENSION vector IS 'vector data type and ivfflat and hnsw access methods';


--
-- Name: append_command(jsonb, text); Type: FUNCTION; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE FUNCTION clockgrove.append_command(p_request jsonb, p_failure_stage text DEFAULT NULL::text) RETURNS jsonb
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
  v_schedules jsonb := p_request->'schedules';
  v_continuation jsonb;
  committed_events jsonb := '[]'::jsonb;
  committed_result jsonb;
  recorded_at text;
  dispatch jsonb;
  matched integer;
  actual_revision bigint;
  colliding text;
  v_event_count integer;
  v_stream_bases jsonb;
  v_partition_bases jsonb;
  v_positions bigint[];
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
       OR jsonb_array_length(p_request->'dispatches') <> 0 OR v_state IS NOT NULL
       OR v_schedules IS NOT NULL))
     OR (v_outcome = 'committed'
       AND (v_open->'basisRevision' IS NOT NULL AND jsonb_typeof(v_open->'basisRevision') <> 'null')
         <> (v_state IS NOT NULL))
     OR (v_state IS NOT NULL) <> (v_schedules IS NOT NULL)
     OR (v_schedules IS NOT NULL AND (
       jsonb_typeof(v_schedules->'done') IS DISTINCT FROM 'array'
       OR jsonb_typeof(v_schedules->'put') IS DISTINCT FROM 'array')) THEN
    RAISE EXCEPTION 'malformed journal append' USING ERRCODE = '22023';
  END IF;
  IF p_failure_stage IS NOT NULL AND p_failure_stage NOT IN (
    'after-receipt', 'after-head-locks', 'after-events', 'after-dispatches', 'after-schedules',
    'after-state', 'before-commit'
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
  -- An event ID is unique per tenant: one already committed, or repeated in this batch, is a stable
  -- collision error rather than a unique violation. A concurrent insert of the same ID still raises
  -- 23505, which the adapter maps to the same error.
  -- One unique-index probe per draft: the LIMIT keeps the lateral lookup parameterized, so the
  -- planner cannot hash the tenant's whole event history (#663).
  SELECT proposed.event->>'eventId' INTO colliding
    FROM jsonb_array_elements(p_request->'events') AS proposed(event)
    CROSS JOIN LATERAL (
      SELECT 1 FROM clockgrove.events AS existing
       WHERE existing.tenant_id = v_tenant AND existing.event_id = proposed.event->>'eventId'
       LIMIT 1
    ) AS hit
   LIMIT 1;
  IF colliding IS NULL THEN
    SELECT proposed.event->>'eventId' INTO colliding
      FROM jsonb_array_elements(p_request->'events') AS proposed(event)
     GROUP BY proposed.event->>'eventId' HAVING count(*) > 1
     LIMIT 1;
  END IF;
  IF colliding IS NOT NULL THEN
    RAISE EXCEPTION 'event ID already exists' USING ERRCODE = 'CG010', DETAIL = colliding;
  END IF;

  -- Allocate distinct local sequences and append immutable semantic bytes, set-based: each head
  -- row moves once by its draft count, journal positions are drawn in one statement and assigned in
  -- draft order, and every event is inserted by one statement. The values equal those of one draft
  -- at a time in draft order (stream and partition sequences count up per head in draft order).
  v_event_count := jsonb_array_length(p_request->'events');
  IF v_event_count > 0 THEN
    WITH drafts AS (
      SELECT proposed.event FROM jsonb_array_elements(p_request->'events') AS proposed(event)
    ), counts AS (
      SELECT event->>'partitionId' AS partition_id, event->>'spaceId' AS space_id,
             event->>'streamId' AS stream_id, count(*) AS drafted
        FROM drafts GROUP BY 1, 2, 3
    ), moved AS (
      UPDATE clockgrove.streams AS head SET current_sequence = head.current_sequence + counts.drafted
        FROM counts
       WHERE head.tenant_id = v_tenant AND head.timeline_id = v_timeline
         AND head.partition_id = counts.partition_id AND head.space_id = counts.space_id
         AND head.stream_id = counts.stream_id
      RETURNING head.partition_id, head.space_id, head.stream_id,
                head.current_sequence - counts.drafted AS base
    )
    SELECT jsonb_object_agg(jsonb_build_array(partition_id, space_id, stream_id)::text, base),
           count(*)
      INTO v_stream_bases, matched
      FROM moved;
    IF matched <> (
      SELECT count(DISTINCT (proposed.event->>'partitionId', proposed.event->>'spaceId',
                             proposed.event->>'streamId'))
        FROM jsonb_array_elements(p_request->'events') AS proposed(event)
    ) THEN
      RAISE EXCEPTION 'event draft failed authoritative route validation' USING ERRCODE = 'CG005';
    END IF;
    WITH drafts AS (
      SELECT proposed.event FROM jsonb_array_elements(p_request->'events') AS proposed(event)
    ), counts AS (
      SELECT event->>'partitionId' AS partition_id, event->>'spaceId' AS space_id,
             count(*) AS drafted
        FROM drafts GROUP BY 1, 2
    ), moved AS (
      UPDATE clockgrove.timeline_partitions AS head
         SET head_sequence = head.head_sequence + counts.drafted
        FROM counts
       WHERE head.tenant_id = v_tenant AND head.timeline_id = v_timeline
         AND head.partition_id = counts.partition_id AND head.space_id = counts.space_id
      RETURNING head.partition_id, head.space_id, head.head_sequence - counts.drafted AS base
    )
    SELECT jsonb_object_agg(jsonb_build_array(partition_id, space_id)::text, base), count(*)
      INTO v_partition_bases, matched
      FROM moved;
    IF matched <> (
      SELECT count(DISTINCT (proposed.event->>'partitionId', proposed.event->>'spaceId'))
        FROM jsonb_array_elements(p_request->'events') AS proposed(event)
    ) THEN
      RAISE EXCEPTION 'event draft failed authoritative route validation' USING ERRCODE = 'CG005';
    END IF;
    SELECT array_agg(drawn.position ORDER BY drawn.position) INTO v_positions
      FROM (
        SELECT nextval(pg_get_serial_sequence('clockgrove.events', 'journal_position')) AS position
          FROM generate_series(1, v_event_count)
      ) AS drawn;
    recorded_at := to_char(transaction_timestamp() AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
    WITH drafts AS (
      SELECT proposed.event AS draft, proposed.ordinality AS ordinal
        FROM jsonb_array_elements(p_request->'events') WITH ORDINALITY AS proposed(event, ordinality)
    ), numbered AS (
      SELECT draft, ordinal,
        (v_stream_bases->>jsonb_build_array(
            draft->>'partitionId', draft->>'spaceId', draft->>'streamId')::text)::bigint
          + row_number() OVER (
            PARTITION BY draft->>'partitionId', draft->>'spaceId', draft->>'streamId'
            ORDER BY ordinal) AS stream_sequence,
        (v_partition_bases->>jsonb_build_array(draft->>'partitionId', draft->>'spaceId')::text)::bigint
          + row_number() OVER (
            PARTITION BY draft->>'partitionId', draft->>'spaceId' ORDER BY ordinal)
          AS partition_sequence,
        v_positions[ordinal] AS journal_position
        FROM drafts
    ), built AS (
      SELECT draft, ordinal, stream_sequence, partition_sequence, journal_position,
        jsonb_build_object(
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
        || CASE WHEN draft ? 'ruleFiringId' THEN jsonb_build_object('ruleFiringId', draft->>'ruleFiringId') ELSE '{}'::jsonb END
          AS canonical_event
        FROM numbered
    ), inserted AS (
      INSERT INTO clockgrove.events (
        event_id, tenant_id, world_id, timeline_id, partition_id, space_id, stream_id,
        stream_sequence, partition_sequence, journal_position, event_type, schema_version,
        simulation_time, recorded_at, command_id, correlation_id, causation_id, principal_id,
        actor_id, privacy_class, payload_hash, attribution, actor_address, policy_versions,
        payload, event_bytes
      ) OVERRIDING SYSTEM VALUE
      SELECT draft->>'eventId', v_tenant, v_world, v_timeline, draft->>'partitionId',
        draft->>'spaceId', draft->>'streamId', stream_sequence, partition_sequence,
        journal_position, draft->>'type', 2, (draft->>'simulationTime')::bigint,
        recorded_at::timestamptz, v_command_id, draft->>'correlationId', draft->>'causationId',
        draft->>'principalId', draft#>>'{actor,id}', draft->>'privacyClass',
        draft->>'payloadHash', draft->'attribution', draft->'actor', draft->'policyVersions',
        draft->'payload', convert_to(canonical_event::text, 'UTF8')
        FROM built
       ORDER BY ordinal
      RETURNING 1
    )
    SELECT jsonb_agg(canonical_event ORDER BY ordinal), (SELECT count(*) FROM inserted)
      INTO committed_events, matched
      FROM built;
    IF matched <> v_event_count THEN
      RAISE EXCEPTION 'journal append inserted % of % events', matched, v_event_count;
    END IF;
  END IF;
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

  -- Schedule mutations on the command's partition: occurrences that left the queue first, then the
  -- new or changed ones, so the pending indexes never see two live entries for one ID or tuple.
  IF v_schedules IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_schedules->'done') AS done(entry)
       WHERE NOT EXISTS (
         SELECT 1 FROM clockgrove.partition_schedules AS schedule
          WHERE schedule.tenant_id = v_tenant AND schedule.timeline_id = v_timeline
            AND schedule.partition_id = v_partition AND schedule.status = 'pending'
            AND schedule.schedule_id = done.entry->>'scheduleId'
            AND schedule.idempotency_key = done.entry->>'idempotencyKey'
       )
    ) THEN
      RAISE EXCEPTION 'schedule mutation names no pending occurrence' USING ERRCODE = 'CG011';
    END IF;
    UPDATE clockgrove.partition_schedules AS schedule
       SET status = 'done', completed_by_command_id = v_command_id,
           updated_at = statement_timestamp()
      FROM jsonb_array_elements(v_schedules->'done') AS done(entry)
     WHERE schedule.tenant_id = v_tenant AND schedule.timeline_id = v_timeline
       AND schedule.partition_id = v_partition AND schedule.status = 'pending'
       AND schedule.schedule_id = done.entry->>'scheduleId'
       AND schedule.idempotency_key = done.entry->>'idempotencyKey';
    INSERT INTO clockgrove.partition_schedules AS schedule (
      tenant_id, world_id, timeline_id, partition_id, space_id, schedule_id, idempotency_key,
      owner_partition_id, due_at, priority, tie_break_key, kind, payload_version, catch_up_class,
      supersedes, item, item_hash, status, scheduled_by_command_id
    )
    SELECT v_tenant, v_world, v_timeline, v_partition, v_space, put.item->>'scheduleId',
      put.item->>'idempotencyKey', put.item->>'ownerPartitionId', (put.item->>'dueAt')::bigint,
      (put.item->>'priority')::bigint, put.item->>'tieBreakKey', put.item->>'kind',
      (put.item->>'payloadVersion')::integer, put.item->>'catchUpClass', put.item->>'supersedes',
      put.item->'item', put.item->>'itemHash', 'pending', v_command_id
      FROM jsonb_array_elements(v_schedules->'put') AS put(item)
    ON CONFLICT (tenant_id, timeline_id, partition_id, schedule_id, idempotency_key) DO UPDATE
       SET owner_partition_id = excluded.owner_partition_id, due_at = excluded.due_at,
           priority = excluded.priority, tie_break_key = excluded.tie_break_key,
           kind = excluded.kind, payload_version = excluded.payload_version,
           catch_up_class = excluded.catch_up_class, supersedes = excluded.supersedes,
           item = excluded.item, item_hash = excluded.item_hash, status = 'pending',
           scheduled_by_command_id = excluded.scheduled_by_command_id,
           completed_by_command_id = NULL, updated_at = statement_timestamp();
  END IF;
  IF p_failure_stage = 'after-schedules' THEN
    RAISE EXCEPTION 'injected failure after schedules';
  END IF;

  -- The partition state, written against the revision begin_command locked, now covers the head,
  -- with the continuation of an incomplete kernel result (or none).
  IF v_state IS NOT NULL THEN
    v_continuation := v_state->'continuation';
    IF jsonb_typeof(v_state->'document') IS DISTINCT FROM 'array'
       OR v_state->>'revision' IS NULL OR v_state->>'simulationTime' IS NULL
       OR v_state->>'documentHash' IS NULL OR v_state->>'stateHash' IS NULL
       OR (jsonb_typeof(v_continuation) IS DISTINCT FROM 'null'
         AND jsonb_typeof(v_continuation) IS DISTINCT FROM 'object') THEN
      RAISE EXCEPTION 'malformed partition state' USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(v_continuation) = 'null' THEN
      v_continuation := NULL;
    END IF;
    UPDATE clockgrove.partition_states AS state
       SET revision = (v_state->>'revision')::bigint,
           simulation_time = (v_state->>'simulationTime')::bigint,
           document_version = 2,
           document = v_state->'document',
           document_hash = v_state->>'documentHash',
           state_hash = v_state->>'stateHash',
           continuation = v_continuation->'document',
           continuation_hash = v_continuation->>'documentHash',
           continuation_command_id = v_continuation->>'commandId',
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


ALTER FUNCTION clockgrove.append_command(p_request jsonb, p_failure_stage text) OWNER TO clockgrove_migrator;

--
-- Name: begin_command(bytea, jsonb, text); Type: FUNCTION; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE FUNCTION clockgrove.begin_command(p_command_bytes bytea, p_request jsonb, p_failure_stage text DEFAULT NULL::text) RETURNS jsonb
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


ALTER FUNCTION clockgrove.begin_command(p_command_bytes bytea, p_request jsonb, p_failure_stage text) OWNER TO clockgrove_migrator;

--
-- Name: claim_dispatches(text, integer, text, integer); Type: FUNCTION; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE FUNCTION clockgrove.claim_dispatches(claim_channel text, claim_limit integer, claim_owner text, lease_ms integer) RETURNS TABLE(tenant_id text, world_id text, timeline_id text, dispatch_id text, event_id text, channel text, attempt integer, privacy_class text, payload jsonb, correlation_id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'clockgrove'
    AS $$
  WITH due AS (
    SELECT candidate.tenant_id, candidate.dispatch_id, candidate.next_attempt_at
    FROM clockgrove.event_dispatches AS candidate
    WHERE candidate.tenant_id = clockgrove.runtime_tenant_id()
      AND candidate.channel = claim_channel
      AND candidate.status IN ('pending', 'leased')
      AND candidate.next_attempt_at <= statement_timestamp()
      AND clockgrove.runtime_can_access(candidate.tenant_id, candidate.privacy_class)
    ORDER BY candidate.next_attempt_at, candidate.dispatch_id
    LIMIT greatest(claim_limit, 0)
    FOR UPDATE SKIP LOCKED
  ),
  claimed AS (
    UPDATE clockgrove.event_dispatches AS dispatch
       SET status = 'leased',
           attempts = dispatch.attempts + 1,
           lease_owner = claim_owner,
           next_attempt_at = statement_timestamp()
             + make_interval(secs => greatest(lease_ms, 0) / 1000.0)
      FROM due
     WHERE dispatch.tenant_id = due.tenant_id AND dispatch.dispatch_id = due.dispatch_id
    RETURNING dispatch.tenant_id, dispatch.world_id, dispatch.timeline_id, dispatch.dispatch_id,
      dispatch.event_id, dispatch.channel, dispatch.attempts, dispatch.privacy_class,
      dispatch.payload, due.next_attempt_at AS due_at
  )
  SELECT claimed.tenant_id, claimed.world_id, claimed.timeline_id, claimed.dispatch_id,
    claimed.event_id, claimed.channel, claimed.attempts, claimed.privacy_class, claimed.payload,
    event.correlation_id
  FROM claimed
  JOIN clockgrove.events AS event
    ON event.tenant_id = claimed.tenant_id AND event.event_id = claimed.event_id
  ORDER BY claimed.due_at, claimed.dispatch_id;
$$;


ALTER FUNCTION clockgrove.claim_dispatches(claim_channel text, claim_limit integer, claim_owner text, lease_ms integer) OWNER TO clockgrove_migrator;

--
-- Name: execute_journal(bytea, jsonb, text); Type: FUNCTION; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE FUNCTION clockgrove.execute_journal(p_command_bytes bytea, p_request jsonb, p_failure_stage text DEFAULT NULL::text) RETURNS jsonb
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


ALTER FUNCTION clockgrove.execute_journal(p_command_bytes bytea, p_request jsonb, p_failure_stage text) OWNER TO clockgrove_migrator;

--
-- Name: guard_command_receipt(); Type: FUNCTION; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE FUNCTION clockgrove.guard_command_receipt() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


ALTER FUNCTION clockgrove.guard_command_receipt() OWNER TO clockgrove_migrator;

--
-- Name: guard_partition_schedule(); Type: FUNCTION; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE FUNCTION clockgrove.guard_partition_schedule() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'partition schedules are never deleted' USING ERRCODE = 'CG006';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.world_id IS DISTINCT FROM OLD.world_id
    OR NEW.timeline_id IS DISTINCT FROM OLD.timeline_id
    OR NEW.partition_id IS DISTINCT FROM OLD.partition_id
    OR NEW.space_id IS DISTINCT FROM OLD.space_id
    OR NEW.schedule_id IS DISTINCT FROM OLD.schedule_id
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'partition schedule identity is immutable' USING ERRCODE = 'CG006';
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION clockgrove.guard_partition_schedule() OWNER TO clockgrove_migrator;

--
-- Name: guard_partition_state(); Type: FUNCTION; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE FUNCTION clockgrove.guard_partition_state() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


ALTER FUNCTION clockgrove.guard_partition_state() OWNER TO clockgrove_migrator;

--
-- Name: guard_preview_effect_dispatch(); Type: FUNCTION; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE FUNCTION clockgrove.guard_preview_effect_dispatch() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.channel = 'external-effects' AND NOT EXISTS (
    SELECT 1 FROM clockgrove.timelines AS timeline
     WHERE timeline.tenant_id = NEW.tenant_id
       AND timeline.world_id = NEW.world_id
       AND timeline.timeline_id = NEW.timeline_id
       AND timeline.kind = 'live'
  ) THEN
    RAISE EXCEPTION 'external effects are recorded only on live timelines' USING ERRCODE = 'CG012';
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION clockgrove.guard_preview_effect_dispatch() OWNER TO clockgrove_migrator;

--
-- Name: has_runtime_context(text); Type: FUNCTION; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE FUNCTION clockgrove.has_runtime_context(row_tenant_id text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'clockgrove'
    AS $$
  SELECT row_tenant_id = clockgrove.runtime_tenant_id()
    AND EXISTS (
      SELECT 1
      FROM clockgrove.tenant_principals AS membership
      WHERE membership.tenant_id = row_tenant_id
        AND membership.principal_id = clockgrove.runtime_principal_id()
    )
$$;


ALTER FUNCTION clockgrove.has_runtime_context(row_tenant_id text) OWNER TO clockgrove_migrator;

--
-- Name: preserve_command_request(); Type: FUNCTION; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE FUNCTION clockgrove.preserve_command_request() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.request_hash IS DISTINCT FROM OLD.request_hash
     OR NEW.command_bytes IS DISTINCT FROM OLD.command_bytes
     OR NEW.target_address IS DISTINCT FROM OLD.target_address THEN
    RAISE EXCEPTION 'command request identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION clockgrove.preserve_command_request() OWNER TO clockgrove_migrator;

--
-- Name: privacy_allows(text); Type: FUNCTION; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE FUNCTION clockgrove.privacy_allows(category text) RETURNS boolean
    LANGUAGE plpgsql STABLE PARALLEL SAFE
    AS $$
DECLARE
  ceiling jsonb;
  categories jsonb;
  total_count integer;
  distinct_count integer;
BEGIN
  BEGIN
    ceiling := nullif(current_setting('app.privacy_ceiling', true), '')::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN false;
  END;
  IF ceiling IS NULL
     OR jsonb_typeof(ceiling) <> 'object'
     OR ceiling <> jsonb_build_object(
       'version', 1,
       'allowedCategories', ceiling->'allowedCategories'
     )
     OR jsonb_typeof(ceiling->'allowedCategories') <> 'array' THEN
    RETURN false;
  END IF;
  categories := ceiling->'allowedCategories';
  SELECT count(*), count(DISTINCT value)
    INTO total_count, distinct_count
    FROM jsonb_array_elements_text(categories);
  IF total_count <> distinct_count OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(categories) AS allowed(value)
    WHERE value NOT IN (
      'public_scene',
      'private_cognition',
      'conversation',
      'credential',
      'operator_evidence'
    )
  ) THEN
    RETURN false;
  END IF;
  RETURN categories ? category;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$;


ALTER FUNCTION clockgrove.privacy_allows(category text) OWNER TO clockgrove_migrator;

--
-- Name: reject_journal_mutation(); Type: FUNCTION; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE FUNCTION clockgrove.reject_journal_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME USING ERRCODE = 'CG006';
END;
$$;


ALTER FUNCTION clockgrove.reject_journal_mutation() OWNER TO clockgrove_migrator;

--
-- Name: runtime_can_access(text, text); Type: FUNCTION; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE FUNCTION clockgrove.runtime_can_access(row_tenant_id text, category text) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
  SELECT clockgrove.has_runtime_context(row_tenant_id)
    AND clockgrove.privacy_allows(category)
$$;


ALTER FUNCTION clockgrove.runtime_can_access(row_tenant_id text, category text) OWNER TO clockgrove_migrator;

--
-- Name: runtime_principal_id(); Type: FUNCTION; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE FUNCTION clockgrove.runtime_principal_id() RETURNS text
    LANGUAGE sql STABLE PARALLEL SAFE
    AS $$ SELECT nullif(current_setting('app.principal_id', true), '') $$;


ALTER FUNCTION clockgrove.runtime_principal_id() OWNER TO clockgrove_migrator;

--
-- Name: runtime_tenant_id(); Type: FUNCTION; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE FUNCTION clockgrove.runtime_tenant_id() RETURNS text
    LANGUAGE sql STABLE PARALLEL SAFE
    AS $$ SELECT nullif(current_setting('app.tenant_id', true), '') $$;


ALTER FUNCTION clockgrove.runtime_tenant_id() OWNER TO clockgrove_migrator;

--
-- Name: settle_dispatch(text, integer, text, text, integer); Type: FUNCTION; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE FUNCTION clockgrove.settle_dispatch(settle_dispatch_id text, settle_attempt integer, settle_outcome text, settle_error_class text, retry_after_ms integer) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'clockgrove'
    AS $$
DECLARE
  settled integer;
BEGIN
  IF settle_outcome IS NULL OR settle_outcome NOT IN ('delivered', 'retry', 'failed')
     OR (settle_outcome = 'delivered') <> (settle_error_class IS NULL)
     OR settle_error_class NOT IN ('retryable', 'permanent')
     OR (settle_outcome = 'retry') <> (retry_after_ms IS NOT NULL)
     OR retry_after_ms < 0 THEN
    RAISE EXCEPTION 'invalid dispatch settlement' USING ERRCODE = '22023';
  END IF;
  UPDATE clockgrove.event_dispatches AS dispatch
     SET status = CASE settle_outcome WHEN 'retry' THEN 'pending' ELSE settle_outcome END,
         lease_owner = CASE settle_outcome WHEN 'retry' THEN NULL ELSE dispatch.lease_owner END,
         last_error_class = coalesce(settle_error_class, dispatch.last_error_class),
         next_attempt_at = CASE settle_outcome
           WHEN 'retry' THEN statement_timestamp() + make_interval(secs => retry_after_ms / 1000.0)
           ELSE dispatch.next_attempt_at
         END,
         settled_at = CASE settle_outcome WHEN 'retry' THEN NULL ELSE statement_timestamp() END
   WHERE dispatch.tenant_id = clockgrove.runtime_tenant_id()
     AND dispatch.dispatch_id = settle_dispatch_id
     AND dispatch.status = 'leased'
     AND dispatch.attempts = settle_attempt
     AND clockgrove.runtime_can_access(dispatch.tenant_id, dispatch.privacy_class);
  GET DIAGNOSTICS settled = ROW_COUNT;
  RETURN settled = 1;
END;
$$;


ALTER FUNCTION clockgrove.settle_dispatch(settle_dispatch_id text, settle_attempt integer, settle_outcome text, settle_error_class text, retry_after_ms integer) OWNER TO clockgrove_migrator;

--
-- Name: world_is_ready(text, text); Type: FUNCTION; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE FUNCTION clockgrove.world_is_ready(row_tenant_id text, row_world_id text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'clockgrove'
    AS $$
  SELECT EXISTS (
    SELECT 1
    FROM clockgrove.worlds AS world
    WHERE world.tenant_id = row_tenant_id
      AND world.world_id = row_world_id
      AND world.lifecycle_status = 'ready'
  );
$$;


ALTER FUNCTION clockgrove.world_is_ready(row_tenant_id text, row_world_id text) OWNER TO clockgrove_migrator;

--
-- Name: guard_case_transition(); Type: FUNCTION; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

CREATE FUNCTION clockgrove_birth.guard_case_transition() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.case_id IS DISTINCT FROM OLD.case_id
    OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
    OR NEW.pack_id IS DISTINCT FROM OLD.pack_id
    OR NEW.pack_version IS DISTINCT FROM OLD.pack_version
    OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'provisioning case identity is immutable' USING ERRCODE = 'CG006';
  END IF;
  IF OLD.status IN ('ready', 'failed') THEN
    RAISE EXCEPTION 'provisioning case is terminal' USING ERRCODE = 'CG006';
  END IF;
  IF OLD.world_id IS NOT NULL AND NEW.world_id IS DISTINCT FROM OLD.world_id THEN
    RAISE EXCEPTION 'provisioning case world is immutable' USING ERRCODE = 'CG006';
  END IF;
  IF NEW.attempts < OLD.attempts
    OR NEW.seeded_commands < OLD.seeded_commands
    OR NEW.seeded_commands > OLD.seeded_commands + 1 THEN
    RAISE EXCEPTION 'provisioning case counters only advance' USING ERRCODE = 'CG006';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'requested' AND NEW.status IN ('seeding', 'failed'))
    OR (OLD.status = 'seeding' AND NEW.status IN ('verified', 'failed'))
    OR (OLD.status = 'verified' AND NEW.status IN ('ready', 'failed'))
  ) THEN
    RAISE EXCEPTION 'provisioning case cannot move from % to %', OLD.status, NEW.status
      USING ERRCODE = 'CG006';
  END IF;
  IF NEW.status = 'ready' AND NOT EXISTS (
    SELECT 1 FROM clockgrove.worlds world
    WHERE world.tenant_id = NEW.tenant_id AND world.world_id = NEW.world_id
      AND world.lifecycle_status = 'ready'
  ) THEN
    RAISE EXCEPTION 'provisioning case is ready only after its world is ready' USING ERRCODE = 'CG006';
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION clockgrove_birth.guard_case_transition() OWNER TO clockgrove_migrator;

--
-- Name: reject_mutation(); Type: FUNCTION; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

CREATE FUNCTION clockgrove_birth.reject_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME USING ERRCODE = 'CG006';
END;
$$;


ALTER FUNCTION clockgrove_birth.reject_mutation() OWNER TO clockgrove_migrator;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: artifact_data_keys; Type: TABLE; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE TABLE clockgrove.artifact_data_keys (
    tenant_id text NOT NULL,
    world_id text NOT NULL,
    privacy_class text NOT NULL,
    key_version integer NOT NULL,
    kek_id text NOT NULL,
    wrapped_key bytea NOT NULL,
    created_at timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
    CONSTRAINT artifact_data_keys_kek_id CHECK ((kek_id ~ '^[a-z0-9-]{1,64}$'::text)),
    CONSTRAINT artifact_data_keys_key_version CHECK ((key_version >= 1)),
    CONSTRAINT artifact_data_keys_private_class CHECK ((privacy_class = ANY (ARRAY['private_cognition'::text, 'conversation'::text, 'operator_evidence'::text]))),
    CONSTRAINT artifact_data_keys_wrapped_key CHECK ((octet_length(wrapped_key) = 61))
);

ALTER TABLE ONLY clockgrove.artifact_data_keys FORCE ROW LEVEL SECURITY;


ALTER TABLE clockgrove.artifact_data_keys OWNER TO clockgrove_migrator;

--
-- Name: artifact_references; Type: TABLE; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE TABLE clockgrove.artifact_references (
    tenant_id text NOT NULL,
    world_id text NOT NULL,
    timeline_id text NOT NULL,
    partition_id text NOT NULL,
    space_id text NOT NULL,
    artifact_id text NOT NULL,
    content_hash text NOT NULL,
    media_type text NOT NULL,
    storage_key text,
    byte_length bigint NOT NULL,
    privacy_class text NOT NULL,
    created_at timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
    inline_content bytea,
    retention_class text NOT NULL,
    encryption text NOT NULL,
    data_key_version integer,
    CONSTRAINT artifact_references_byte_length_check CHECK ((byte_length >= 0)),
    CONSTRAINT artifact_references_content_hash CHECK ((content_hash ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT artifact_references_data_key_version CHECK (((encryption = 'none'::text) = (data_key_version IS NULL))),
    CONSTRAINT artifact_references_encryption CHECK ((encryption = ANY (ARRAY['none'::text, 'aes-256-gcm-v1'::text]))),
    CONSTRAINT artifact_references_envelope CHECK (((encryption = 'none'::text) OR ((byte_length >= 29) AND ((inline_content IS NULL) OR (substr(inline_content, 1, 1) = '\x01'::bytea))))),
    CONSTRAINT artifact_references_inline_bytes CHECK (((inline_content IS NULL) OR ((octet_length(inline_content) = byte_length) AND (byte_length <= 131072) AND (content_hash = ('sha256:'::text || encode(sha256(inline_content), 'hex'::text)))))),
    CONSTRAINT artifact_references_no_credential CHECK ((privacy_class <> 'credential'::text)),
    CONSTRAINT artifact_references_one_location CHECK (((inline_content IS NULL) <> (storage_key IS NULL))),
    CONSTRAINT artifact_references_privacy_class_check CHECK ((privacy_class = ANY (ARRAY['public_scene'::text, 'private_cognition'::text, 'conversation'::text, 'credential'::text, 'operator_evidence'::text]))),
    CONSTRAINT artifact_references_private_encrypted CHECK (((privacy_class = 'public_scene'::text) = (encryption = 'none'::text))),
    CONSTRAINT artifact_references_retention_class CHECK ((retention_class = ANY (ARRAY['durable'::text, 'ephemeral'::text]))),
    CONSTRAINT artifact_references_storage_key CHECK (((storage_key IS NULL) OR (storage_key = ((((retention_class || '/'::text) || encode(convert_to(tenant_id, 'UTF8'::name), 'hex'::text)) || '/sha256/'::text) || substr(content_hash, 8)))))
);

ALTER TABLE ONLY clockgrove.artifact_references FORCE ROW LEVEL SECURITY;


ALTER TABLE clockgrove.artifact_references OWNER TO clockgrove_migrator;

--
-- Name: authority_decisions; Type: TABLE; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE TABLE clockgrove.authority_decisions (
    tenant_id text NOT NULL,
    authority_decision_id text NOT NULL,
    command_id text NOT NULL,
    outcome text NOT NULL,
    world_id text NOT NULL,
    timeline_id text NOT NULL,
    action_id text NOT NULL,
    attribution jsonb NOT NULL,
    inputs jsonb NOT NULL,
    reason_code text,
    decided_at timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
    CONSTRAINT authority_decisions_attribution_check CHECK ((jsonb_typeof(attribution) = 'object'::text)),
    CONSTRAINT authority_decisions_check CHECK (((outcome = 'deny'::text) = (reason_code IS NOT NULL))),
    CONSTRAINT authority_decisions_check1 CHECK ((action_id = (attribution ->> 'causalRootActionId'::text))),
    CONSTRAINT authority_decisions_inputs_check CHECK ((jsonb_typeof(inputs) = 'object'::text)),
    CONSTRAINT authority_decisions_outcome_check CHECK ((outcome = ANY (ARRAY['allow'::text, 'deny'::text])))
);

ALTER TABLE ONLY clockgrove.authority_decisions FORCE ROW LEVEL SECURITY;


ALTER TABLE clockgrove.authority_decisions OWNER TO clockgrove_migrator;

--
-- Name: command_receipts; Type: TABLE; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE TABLE clockgrove.command_receipts (
    tenant_id text NOT NULL,
    command_id text NOT NULL,
    request_hash text NOT NULL,
    command_bytes bytea NOT NULL,
    target_address jsonb NOT NULL,
    status text NOT NULL,
    canonical_event_ids text[] DEFAULT '{}'::text[] NOT NULL,
    result jsonb,
    created_at timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
    committed_at timestamp with time zone,
    provenance text NOT NULL,
    attribution jsonb,
    action_id text,
    correlation_id text,
    causation_id text,
    expected jsonb,
    authority_decision_id text,
    failed_at timestamp with time zone,
    CONSTRAINT command_receipts_committed_at_shape CHECK (((status = ANY (ARRAY['committed'::text, 'rejected'::text])) = (committed_at IS NOT NULL))),
    CONSTRAINT command_receipts_failed_at_shape CHECK (((status = 'failed'::text) = (failed_at IS NOT NULL))),
    CONSTRAINT command_receipts_provenance_check CHECK ((provenance = ANY (ARRAY['attributed'::text, 'legacy-wave0'::text]))),
    CONSTRAINT command_receipts_provenance_shape CHECK ((((provenance = 'legacy-wave0'::text) AND (attribution IS NULL) AND (action_id IS NULL) AND (authority_decision_id IS NULL)) OR ((provenance = 'attributed'::text) AND (jsonb_typeof(attribution) = 'object'::text) AND (action_id IS NOT NULL) AND (action_id = (attribution ->> 'causalRootActionId'::text)) AND (correlation_id IS NOT NULL) AND (jsonb_typeof(expected) = 'object'::text) AND ((status = 'pending'::text) = (authority_decision_id IS NULL))))),
    CONSTRAINT command_receipts_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'committed'::text, 'rejected'::text, 'failed'::text])))
);

ALTER TABLE ONLY clockgrove.command_receipts FORCE ROW LEVEL SECURITY;


ALTER TABLE clockgrove.command_receipts OWNER TO clockgrove_migrator;

--
-- Name: event_dispatches; Type: TABLE; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE TABLE clockgrove.event_dispatches (
    tenant_id text NOT NULL,
    world_id text NOT NULL,
    timeline_id text NOT NULL,
    partition_id text NOT NULL,
    space_id text NOT NULL,
    dispatch_id text NOT NULL,
    event_id text NOT NULL,
    channel text NOT NULL,
    status text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
    privacy_class text NOT NULL,
    payload jsonb NOT NULL,
    lease_owner text,
    last_error_class text,
    settled_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
    CONSTRAINT event_dispatches_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT event_dispatches_channel_check CHECK ((channel = ANY (ARRAY['world-reactions'::text, 'cognitive-indexing'::text, 'external-effects'::text]))),
    CONSTRAINT event_dispatches_last_error_class_check CHECK ((last_error_class = ANY (ARRAY['retryable'::text, 'permanent'::text]))),
    CONSTRAINT event_dispatches_lease_owner_check CHECK ((lease_owner <> ''::text)),
    CONSTRAINT event_dispatches_leased_owner_check CHECK (((status <> 'leased'::text) OR (lease_owner IS NOT NULL))),
    CONSTRAINT event_dispatches_privacy_class_check CHECK ((privacy_class = ANY (ARRAY['public_scene'::text, 'private_cognition'::text, 'conversation'::text, 'credential'::text, 'operator_evidence'::text]))),
    CONSTRAINT event_dispatches_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'leased'::text, 'delivered'::text, 'failed'::text]))),
    CONSTRAINT event_dispatches_terminal_settled_check CHECK (((status = ANY (ARRAY['delivered'::text, 'failed'::text])) = (settled_at IS NOT NULL)))
);

ALTER TABLE ONLY clockgrove.event_dispatches FORCE ROW LEVEL SECURITY;


ALTER TABLE clockgrove.event_dispatches OWNER TO clockgrove_migrator;

--
-- Name: events; Type: TABLE; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE TABLE clockgrove.events (
    event_id text NOT NULL,
    tenant_id text NOT NULL,
    world_id text NOT NULL,
    timeline_id text NOT NULL,
    partition_id text NOT NULL,
    space_id text NOT NULL,
    stream_id text NOT NULL,
    stream_sequence bigint NOT NULL,
    partition_sequence bigint NOT NULL,
    journal_position bigint NOT NULL,
    event_type text NOT NULL,
    schema_version integer NOT NULL,
    simulation_time bigint NOT NULL,
    recorded_at timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
    command_id text NOT NULL,
    correlation_id text NOT NULL,
    causation_id text,
    principal_id text,
    actor_id text,
    object_id text,
    privacy_class text NOT NULL,
    payload_hash text NOT NULL,
    attribution jsonb NOT NULL,
    actor_address jsonb,
    policy_versions jsonb NOT NULL,
    payload jsonb NOT NULL,
    event_bytes bytea NOT NULL,
    CONSTRAINT events_partition_sequence_check CHECK ((partition_sequence > 0)),
    CONSTRAINT events_privacy_class_check CHECK ((privacy_class = ANY (ARRAY['public_scene'::text, 'private_cognition'::text, 'conversation'::text, 'credential'::text, 'operator_evidence'::text]))),
    CONSTRAINT events_schema_version_check CHECK ((schema_version > 0)),
    CONSTRAINT events_stream_sequence_check CHECK ((stream_sequence > 0))
);

ALTER TABLE ONLY clockgrove.events FORCE ROW LEVEL SECURITY;


ALTER TABLE clockgrove.events OWNER TO clockgrove_migrator;

--
-- Name: events_journal_position_seq; Type: SEQUENCE; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE clockgrove.events ALTER COLUMN journal_position ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME clockgrove.events_journal_position_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: migration_backfill_checkpoints; Type: TABLE; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE TABLE clockgrove.migration_backfill_checkpoints (
    migration_name text NOT NULL,
    checkpoint_key text NOT NULL,
    checkpoint_value jsonb NOT NULL,
    verified_at timestamp with time zone
);


ALTER TABLE clockgrove.migration_backfill_checkpoints OWNER TO clockgrove_migrator;

--
-- Name: partition_schedules; Type: TABLE; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE TABLE clockgrove.partition_schedules (
    tenant_id text NOT NULL,
    world_id text NOT NULL,
    timeline_id text NOT NULL,
    partition_id text NOT NULL,
    space_id text NOT NULL,
    schedule_id text NOT NULL,
    idempotency_key text NOT NULL,
    owner_partition_id text NOT NULL,
    due_at bigint NOT NULL,
    priority bigint NOT NULL,
    tie_break_key text NOT NULL COLLATE pg_catalog."C",
    kind text NOT NULL,
    payload_version integer NOT NULL,
    catch_up_class text NOT NULL,
    supersedes text,
    item jsonb NOT NULL,
    item_hash text NOT NULL,
    status text NOT NULL,
    scheduled_by_command_id text NOT NULL,
    completed_by_command_id text,
    created_at timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
    CONSTRAINT partition_schedules_catch_up_class_check CHECK ((catch_up_class = ANY (ARRAY['exact'::text, 'aggregate'::text, 'skippable'::text, 'externallyBlocked'::text]))),
    CONSTRAINT partition_schedules_check CHECK (((status = 'done'::text) = (completed_by_command_id IS NOT NULL))),
    CONSTRAINT partition_schedules_due_at_check CHECK ((due_at >= 0)),
    CONSTRAINT partition_schedules_item_check CHECK ((jsonb_typeof(item) = 'array'::text)),
    CONSTRAINT partition_schedules_item_hash_check CHECK ((item_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT partition_schedules_payload_version_check CHECK ((payload_version >= 1)),
    CONSTRAINT partition_schedules_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'done'::text])))
);

ALTER TABLE ONLY clockgrove.partition_schedules FORCE ROW LEVEL SECURITY;


ALTER TABLE clockgrove.partition_schedules OWNER TO clockgrove_migrator;

--
-- Name: partition_states; Type: TABLE; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE TABLE clockgrove.partition_states (
    tenant_id text NOT NULL,
    world_id text NOT NULL,
    timeline_id text NOT NULL,
    partition_id text NOT NULL,
    space_id text NOT NULL,
    revision bigint NOT NULL,
    covered_head_sequence bigint NOT NULL,
    simulation_time bigint NOT NULL,
    document_version integer NOT NULL,
    document jsonb NOT NULL,
    document_hash text NOT NULL,
    state_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
    continuation jsonb,
    continuation_hash text,
    continuation_command_id text,
    CONSTRAINT partition_states_continuation_complete CHECK ((((continuation IS NULL) = (continuation_hash IS NULL)) AND ((continuation IS NULL) = (continuation_command_id IS NULL)) AND ((continuation IS NULL) OR (jsonb_typeof(continuation) = 'array'::text)))),
    CONSTRAINT partition_states_continuation_hash_check CHECK ((continuation_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT partition_states_covered_head_sequence_check CHECK ((covered_head_sequence >= 0)),
    CONSTRAINT partition_states_document_check CHECK ((jsonb_typeof(document) = 'array'::text)),
    CONSTRAINT partition_states_document_hash_check CHECK ((document_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT partition_states_document_version_check CHECK ((document_version = 2)),
    CONSTRAINT partition_states_revision_check CHECK ((revision >= 0)),
    CONSTRAINT partition_states_state_hash_check CHECK ((state_hash ~ '^[0-9a-f]{64}$'::text))
);

ALTER TABLE ONLY clockgrove.partition_states FORCE ROW LEVEL SECURITY;


ALTER TABLE clockgrove.partition_states OWNER TO clockgrove_migrator;

--
-- Name: schema_migrations; Type: TABLE; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE TABLE clockgrove.schema_migrations (
    migration_name text NOT NULL,
    checksum text NOT NULL,
    applied_at timestamp with time zone DEFAULT statement_timestamp() NOT NULL
);


ALTER TABLE clockgrove.schema_migrations OWNER TO clockgrove_migrator;

--
-- Name: snapshots; Type: TABLE; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE TABLE clockgrove.snapshots (
    tenant_id text NOT NULL,
    world_id text NOT NULL,
    timeline_id text NOT NULL,
    partition_id text NOT NULL,
    space_id text NOT NULL,
    snapshot_id text NOT NULL,
    stream_id text NOT NULL,
    covered_sequence bigint NOT NULL,
    state_hash text NOT NULL,
    artifact_id text NOT NULL,
    privacy_class text NOT NULL,
    compatibility jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
    covered_partition_sequence bigint NOT NULL,
    CONSTRAINT snapshots_compatibility CHECK ((jsonb_typeof(compatibility) = 'object'::text)),
    CONSTRAINT snapshots_covered_sequence_check CHECK ((covered_sequence >= 0)),
    CONSTRAINT snapshots_privacy_class_check CHECK ((privacy_class = ANY (ARRAY['public_scene'::text, 'private_cognition'::text, 'conversation'::text, 'credential'::text, 'operator_evidence'::text]))),
    CONSTRAINT snapshots_state_hash CHECK ((state_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT snapshots_stream_coverage CHECK ((covered_sequence <= covered_partition_sequence))
);

ALTER TABLE ONLY clockgrove.snapshots FORCE ROW LEVEL SECURITY;


ALTER TABLE clockgrove.snapshots OWNER TO clockgrove_migrator;

--
-- Name: streams; Type: TABLE; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE TABLE clockgrove.streams (
    tenant_id text NOT NULL,
    world_id text NOT NULL,
    timeline_id text NOT NULL,
    partition_id text NOT NULL,
    space_id text NOT NULL,
    stream_id text NOT NULL,
    current_sequence bigint DEFAULT 0 NOT NULL,
    snapshot_sequence bigint DEFAULT 0 NOT NULL,
    CONSTRAINT streams_check CHECK (((snapshot_sequence >= 0) AND (snapshot_sequence <= current_sequence))),
    CONSTRAINT streams_current_sequence_check CHECK ((current_sequence >= 0))
);

ALTER TABLE ONLY clockgrove.streams FORCE ROW LEVEL SECURITY;


ALTER TABLE clockgrove.streams OWNER TO clockgrove_migrator;

--
-- Name: tenant_principals; Type: TABLE; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE TABLE clockgrove.tenant_principals (
    tenant_id text NOT NULL,
    principal_id text NOT NULL,
    created_at timestamp with time zone DEFAULT statement_timestamp() NOT NULL
);

ALTER TABLE ONLY clockgrove.tenant_principals FORCE ROW LEVEL SECURITY;


ALTER TABLE clockgrove.tenant_principals OWNER TO clockgrove_migrator;

--
-- Name: tenants; Type: TABLE; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE TABLE clockgrove.tenants (
    tenant_id text NOT NULL,
    display_name text NOT NULL,
    created_at timestamp with time zone DEFAULT statement_timestamp() NOT NULL
);

ALTER TABLE ONLY clockgrove.tenants FORCE ROW LEVEL SECURITY;


ALTER TABLE clockgrove.tenants OWNER TO clockgrove_migrator;

--
-- Name: timeline_partitions; Type: TABLE; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE TABLE clockgrove.timeline_partitions (
    tenant_id text NOT NULL,
    world_id text NOT NULL,
    timeline_id text NOT NULL,
    partition_id text NOT NULL,
    space_id text NOT NULL,
    routing_epoch integer DEFAULT 0 NOT NULL,
    head_sequence bigint DEFAULT 0 NOT NULL,
    CONSTRAINT timeline_partitions_head_sequence_check CHECK ((head_sequence >= 0)),
    CONSTRAINT timeline_partitions_routing_epoch_check CHECK ((routing_epoch >= 0))
);

ALTER TABLE ONLY clockgrove.timeline_partitions FORCE ROW LEVEL SECURITY;


ALTER TABLE clockgrove.timeline_partitions OWNER TO clockgrove_migrator;

--
-- Name: timelines; Type: TABLE; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE TABLE clockgrove.timelines (
    tenant_id text NOT NULL,
    world_id text NOT NULL,
    timeline_id text NOT NULL,
    kind text DEFAULT 'live'::text NOT NULL,
    state text DEFAULT 'active'::text NOT NULL,
    parent_timeline_id text,
    created_at timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
    CONSTRAINT timelines_kind_check CHECK ((kind = ANY (ARRAY['live'::text, 'branch'::text]))),
    CONSTRAINT timelines_state_check CHECK ((state = ANY (ARRAY['active'::text, 'archived'::text])))
);

ALTER TABLE ONLY clockgrove.timelines FORCE ROW LEVEL SECURITY;


ALTER TABLE clockgrove.timelines OWNER TO clockgrove_migrator;

--
-- Name: world_memberships; Type: TABLE; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE TABLE clockgrove.world_memberships (
    tenant_id text NOT NULL,
    world_id text NOT NULL,
    timeline_id text NOT NULL,
    space_id text NOT NULL,
    principal_id text NOT NULL,
    membership_id text NOT NULL,
    persona_id text NOT NULL,
    roles text[] NOT NULL,
    grants text[] NOT NULL,
    privacy_ceiling jsonb NOT NULL,
    committed_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone
);

ALTER TABLE ONLY clockgrove.world_memberships FORCE ROW LEVEL SECURITY;


ALTER TABLE clockgrove.world_memberships OWNER TO clockgrove_migrator;

--
-- Name: worlds; Type: TABLE; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE TABLE clockgrove.worlds (
    tenant_id text NOT NULL,
    world_id text NOT NULL,
    lifecycle_status text DEFAULT 'initializing'::text NOT NULL,
    created_at timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
    CONSTRAINT worlds_lifecycle_status_check CHECK ((lifecycle_status = ANY (ARRAY['initializing'::text, 'provisioning'::text, 'ready'::text, 'archived'::text])))
);

ALTER TABLE ONLY clockgrove.worlds FORCE ROW LEVEL SECURITY;


ALTER TABLE clockgrove.worlds OWNER TO clockgrove_migrator;

--
-- Name: account; Type: TABLE; Schema: clockgrove_auth; Owner: clockgrove_migrator
--

CREATE TABLE clockgrove_auth.account (
    id text NOT NULL,
    "accountId" text NOT NULL,
    "providerId" text NOT NULL,
    "userId" text NOT NULL,
    "accessToken" text,
    "refreshToken" text,
    "idToken" text,
    "accessTokenExpiresAt" timestamp with time zone,
    "refreshTokenExpiresAt" timestamp with time zone,
    scope text,
    password text,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL
);


ALTER TABLE clockgrove_auth.account OWNER TO clockgrove_migrator;

--
-- Name: session; Type: TABLE; Schema: clockgrove_auth; Owner: clockgrove_migrator
--

CREATE TABLE clockgrove_auth.session (
    id text NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    token text NOT NULL,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL,
    "ipAddress" text,
    "userAgent" text,
    "userId" text NOT NULL
);


ALTER TABLE clockgrove_auth.session OWNER TO clockgrove_migrator;

--
-- Name: user; Type: TABLE; Schema: clockgrove_auth; Owner: clockgrove_migrator
--

CREATE TABLE clockgrove_auth."user" (
    id text NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    "emailVerified" boolean DEFAULT false NOT NULL,
    image text,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL
);


ALTER TABLE clockgrove_auth."user" OWNER TO clockgrove_migrator;

--
-- Name: verification; Type: TABLE; Schema: clockgrove_auth; Owner: clockgrove_migrator
--

CREATE TABLE clockgrove_auth.verification (
    id text NOT NULL,
    identifier text NOT NULL,
    value text NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL
);


ALTER TABLE clockgrove_auth.verification OWNER TO clockgrove_migrator;

--
-- Name: birth_cognitive_seed_refs; Type: TABLE; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

CREATE TABLE clockgrove_birth.birth_cognitive_seed_refs (
    tenant_id text NOT NULL,
    world_id text NOT NULL,
    timeline_id text NOT NULL,
    birth_version integer NOT NULL,
    ordinal integer NOT NULL,
    pack_id text NOT NULL,
    pack_version text NOT NULL,
    seed_kind text DEFAULT 'cognitiveSeeds'::text NOT NULL,
    seed_id text NOT NULL,
    seed_version integer NOT NULL,
    sha256 text NOT NULL,
    CONSTRAINT birth_cognitive_seed_refs_ordinal_check CHECK ((ordinal >= 0)),
    CONSTRAINT birth_cognitive_seed_refs_seed_kind_check CHECK ((seed_kind = 'cognitiveSeeds'::text))
);

ALTER TABLE ONLY clockgrove_birth.birth_cognitive_seed_refs FORCE ROW LEVEL SECURITY;


ALTER TABLE clockgrove_birth.birth_cognitive_seed_refs OWNER TO clockgrove_migrator;

--
-- Name: birth_random_streams; Type: TABLE; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

CREATE TABLE clockgrove_birth.birth_random_streams (
    tenant_id text NOT NULL,
    world_id text NOT NULL,
    timeline_id text NOT NULL,
    birth_version integer NOT NULL,
    stream_name text NOT NULL,
    algorithm text NOT NULL,
    algorithm_version integer NOT NULL,
    draws bigint NOT NULL,
    state_words text[] NOT NULL,
    CONSTRAINT birth_random_streams_algorithm_version_check CHECK ((algorithm_version = 1)),
    CONSTRAINT birth_random_streams_draws_check CHECK ((draws >= 0)),
    CONSTRAINT birth_random_streams_state_words_check CHECK ((cardinality(state_words) > 0))
);

ALTER TABLE ONLY clockgrove_birth.birth_random_streams FORCE ROW LEVEL SECURITY;


ALTER TABLE clockgrove_birth.birth_random_streams OWNER TO clockgrove_migrator;

--
-- Name: birth_schedules; Type: TABLE; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

CREATE TABLE clockgrove_birth.birth_schedules (
    tenant_id text NOT NULL,
    world_id text NOT NULL,
    timeline_id text NOT NULL,
    birth_version integer NOT NULL,
    ordinal integer NOT NULL,
    node jsonb NOT NULL,
    CONSTRAINT birth_schedules_ordinal_check CHECK ((ordinal >= 0))
);

ALTER TABLE ONLY clockgrove_birth.birth_schedules FORCE ROW LEVEL SECURITY;


ALTER TABLE clockgrove_birth.birth_schedules OWNER TO clockgrove_migrator;

--
-- Name: birth_space_state; Type: TABLE; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

CREATE TABLE clockgrove_birth.birth_space_state (
    tenant_id text NOT NULL,
    world_id text NOT NULL,
    timeline_id text NOT NULL,
    birth_version integer NOT NULL,
    partition_id text NOT NULL,
    space_id text NOT NULL,
    element_kind text NOT NULL,
    element_key text NOT NULL,
    ordinal integer NOT NULL,
    node jsonb NOT NULL,
    CONSTRAINT birth_space_state_element_kind_check CHECK ((element_kind = ANY (ARRAY['frame'::text, 'region'::text, 'anchor-graph'::text, 'entity'::text]))),
    CONSTRAINT birth_space_state_ordinal_check CHECK ((ordinal >= 0))
);

ALTER TABLE ONLY clockgrove_birth.birth_space_state FORCE ROW LEVEL SECURITY;


ALTER TABLE clockgrove_birth.birth_space_state OWNER TO clockgrove_migrator;

--
-- Name: birth_state_sections; Type: TABLE; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

CREATE TABLE clockgrove_birth.birth_state_sections (
    tenant_id text NOT NULL,
    world_id text NOT NULL,
    timeline_id text NOT NULL,
    birth_version integer NOT NULL,
    section text NOT NULL,
    section_version integer NOT NULL,
    node jsonb NOT NULL,
    CONSTRAINT birth_state_sections_section_check CHECK ((section = ANY (ARRAY['environment'::text, 'ecology'::text, 'wellbeing'::text, 'lifecycle'::text])))
);

ALTER TABLE ONLY clockgrove_birth.birth_state_sections FORCE ROW LEVEL SECURITY;


ALTER TABLE clockgrove_birth.birth_state_sections OWNER TO clockgrove_migrator;

--
-- Name: pack_artifact_resources; Type: TABLE; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

CREATE TABLE clockgrove_birth.pack_artifact_resources (
    tenant_id text NOT NULL,
    pack_id text NOT NULL,
    pack_version text NOT NULL,
    resource_kind text NOT NULL,
    resource_id text NOT NULL,
    resource_version integer NOT NULL,
    path text NOT NULL,
    sha256 text NOT NULL,
    content bytea NOT NULL,
    CONSTRAINT pack_artifact_resources_check CHECK ((sha256 = encode(sha256(content), 'hex'::text))),
    CONSTRAINT pack_artifact_resources_resource_kind_check CHECK ((resource_kind = ANY (ARRAY['archetypes'::text, 'traits'::text, 'actors'::text, 'policies'::text, 'cognitiveSeeds'::text, 'spaces'::text, 'rules'::text]))),
    CONSTRAINT pack_artifact_resources_resource_version_check CHECK ((resource_version >= 0)),
    CONSTRAINT pack_artifact_resources_sha256_check CHECK ((sha256 ~ '^[0-9a-f]{64}$'::text))
);

ALTER TABLE ONLY clockgrove_birth.pack_artifact_resources FORCE ROW LEVEL SECURITY;


ALTER TABLE clockgrove_birth.pack_artifact_resources OWNER TO clockgrove_migrator;

--
-- Name: pack_artifacts; Type: TABLE; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

CREATE TABLE clockgrove_birth.pack_artifacts (
    tenant_id text NOT NULL,
    pack_id text NOT NULL,
    pack_version text NOT NULL,
    content_hash text NOT NULL,
    engine_compatibility text NOT NULL,
    resource_manifest_hash text NOT NULL,
    asset_manifest_hash text NOT NULL,
    migration_set_hash text NOT NULL,
    build_tool_version text NOT NULL,
    stored_at timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
    CONSTRAINT pack_artifacts_asset_manifest_hash_check CHECK ((asset_manifest_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT pack_artifacts_content_hash_check CHECK ((content_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT pack_artifacts_migration_set_hash_check CHECK ((migration_set_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT pack_artifacts_resource_manifest_hash_check CHECK ((resource_manifest_hash ~ '^[0-9a-f]{64}$'::text))
);

ALTER TABLE ONLY clockgrove_birth.pack_artifacts FORCE ROW LEVEL SECURITY;


ALTER TABLE clockgrove_birth.pack_artifacts OWNER TO clockgrove_migrator;

--
-- Name: pack_installations; Type: TABLE; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

CREATE TABLE clockgrove_birth.pack_installations (
    tenant_id text NOT NULL,
    installation_id text NOT NULL,
    case_id text NOT NULL,
    world_id text NOT NULL,
    pack_id text NOT NULL,
    pack_version text NOT NULL,
    content_hash text NOT NULL,
    status text NOT NULL,
    installed_at timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
    CONSTRAINT pack_installations_status_check CHECK ((status = 'installed'::text))
);

ALTER TABLE ONLY clockgrove_birth.pack_installations FORCE ROW LEVEL SECURITY;


ALTER TABLE clockgrove_birth.pack_installations OWNER TO clockgrove_migrator;

--
-- Name: provisioning_cases; Type: TABLE; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

CREATE TABLE clockgrove_birth.provisioning_cases (
    tenant_id text NOT NULL,
    case_id text NOT NULL,
    request_hash text NOT NULL,
    pack_id text NOT NULL,
    pack_version text NOT NULL,
    content_hash text NOT NULL,
    status text DEFAULT 'requested'::text NOT NULL,
    attempts integer DEFAULT 1 NOT NULL,
    seeded_commands integer DEFAULT 0 NOT NULL,
    world_id text,
    last_failure jsonb,
    failure jsonb,
    created_at timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
    CONSTRAINT provisioning_cases_attempts_check CHECK ((attempts >= 1)),
    CONSTRAINT provisioning_cases_check CHECK (((status = 'failed'::text) = (failure IS NOT NULL))),
    CONSTRAINT provisioning_cases_check1 CHECK (((world_id IS NOT NULL) OR (status = ANY (ARRAY['requested'::text, 'failed'::text])))),
    CONSTRAINT provisioning_cases_content_hash_check CHECK ((content_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT provisioning_cases_request_hash_check CHECK ((request_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT provisioning_cases_seeded_commands_check CHECK ((seeded_commands >= 0)),
    CONSTRAINT provisioning_cases_status_check CHECK ((status = ANY (ARRAY['requested'::text, 'seeding'::text, 'verified'::text, 'ready'::text, 'failed'::text])))
);

ALTER TABLE ONLY clockgrove_birth.provisioning_cases FORCE ROW LEVEL SECURITY;


ALTER TABLE clockgrove_birth.provisioning_cases OWNER TO clockgrove_migrator;

--
-- Name: world_birth_states; Type: TABLE; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

CREATE TABLE clockgrove_birth.world_birth_states (
    tenant_id text NOT NULL,
    world_id text NOT NULL,
    timeline_id text NOT NULL,
    birth_version integer NOT NULL,
    pack_id text NOT NULL,
    pack_version text NOT NULL,
    content_hash text NOT NULL,
    state_schema_version integer NOT NULL,
    state_partition_id text NOT NULL,
    scalars jsonb NOT NULL,
    clock_policy jsonb NOT NULL,
    simulation_epoch bigint NOT NULL,
    seed_projection_hash text NOT NULL,
    CONSTRAINT world_birth_states_birth_version_check CHECK ((birth_version >= 1)),
    CONSTRAINT world_birth_states_seed_projection_hash_check CHECK ((seed_projection_hash ~ '^[0-9a-f]{64}$'::text))
);

ALTER TABLE ONLY clockgrove_birth.world_birth_states FORCE ROW LEVEL SECURITY;


ALTER TABLE clockgrove_birth.world_birth_states OWNER TO clockgrove_migrator;

--
-- Name: identity_links; Type: TABLE; Schema: clockgrove_management; Owner: clockgrove_migrator
--

CREATE TABLE clockgrove_management.identity_links (
    environment text NOT NULL,
    subject text NOT NULL,
    external_identity_id text NOT NULL,
    principal_id text NOT NULL,
    revoked_at timestamp with time zone
);

ALTER TABLE ONLY clockgrove_management.identity_links FORCE ROW LEVEL SECURITY;


ALTER TABLE clockgrove_management.identity_links OWNER TO clockgrove_migrator;

--
-- Name: principals; Type: TABLE; Schema: clockgrove_management; Owner: clockgrove_migrator
--

CREATE TABLE clockgrove_management.principals (
    principal_id text NOT NULL,
    revoked_at timestamp with time zone
);

ALTER TABLE ONLY clockgrove_management.principals FORCE ROW LEVEL SECURITY;


ALTER TABLE clockgrove_management.principals OWNER TO clockgrove_migrator;

--
-- Name: workspace_memberships; Type: TABLE; Schema: clockgrove_management; Owner: clockgrove_migrator
--

CREATE TABLE clockgrove_management.workspace_memberships (
    tenant_id text NOT NULL,
    principal_id text NOT NULL,
    membership_id text NOT NULL,
    roles text[] NOT NULL,
    grants text[] NOT NULL,
    revoked_at timestamp with time zone
);

ALTER TABLE ONLY clockgrove_management.workspace_memberships FORCE ROW LEVEL SECURITY;


ALTER TABLE clockgrove_management.workspace_memberships OWNER TO clockgrove_migrator;

--
-- Data for Name: artifact_data_keys; Type: TABLE DATA; Schema: clockgrove; Owner: clockgrove_migrator
--

COPY clockgrove.artifact_data_keys (tenant_id, world_id, privacy_class, key_version, kek_id, wrapped_key, created_at) FROM stdin;
\.


--
-- Data for Name: artifact_references; Type: TABLE DATA; Schema: clockgrove; Owner: clockgrove_migrator
--

COPY clockgrove.artifact_references (tenant_id, world_id, timeline_id, partition_id, space_id, artifact_id, content_hash, media_type, storage_key, byte_length, privacy_class, created_at, inline_content, retention_class, encryption, data_key_version) FROM stdin;
tenantid_443adfa47140780d	worldid_b09aed54932c8f51	timelineid_a944a1d612944976	partitionid_3acf598aeb8a3d83:beacon.hall	beacon.hall	snapshot:timelineid_a944a1d612944976:partitionid_3acf598aeb8a3d83%3Abeacon.hall:3:artifact	sha256:83bc85bab4f901a6f9776ef1541dfee6db2c0aa54a62e5a34e7592c188d837f4	application/json	\N	14289	public_scene	2026-10-19 23:52:18.904117-07	\\x5b22636c6f636b67726f76652d63616e6f6e6963616c2d7631222c5b227265636f7264222c5b5b22636f6d7061746962696c697479222c5b227265636f7264222c5b5b2263616e6f6e6963616c456e636f64696e67222c5b22737472696e67222c22636c6f636b67726f76652d63616e6f6e6963616c2d7631225d5d2c5b22636f646563222c5b22696e7465676572222c2231225d5d2c5b22646f63756d656e7456657273696f6e222c5b22696e7465676572222c2232225d5d2c5b226b65726e656c526567697374727948617368222c5b22737472696e67222c2238303566663961336266396134373762303361343138386336396266313062353365396538653536323435336363393933356535366438643036613537373938225d5d2c5b227061636b436f6e74656e7448617368222c5b22737472696e67222c2238313361336638343638353965353563643935626530666262333335396530653336323338663739346536323635663365663139613166616436353937393036225d5d2c5b2272616e646f6d436f6e7472616374222c5b22737472696e67222c22636c6f636b67726f76652d72616e646f6d2d7631225d5d5d5d5d2c5b22636f7665726564506172746974696f6e53657175656e6365222c5b22626967696e74222c2233225d5d2c5b22636f766572656453747265616d53657175656e6365222c5b22626967696e74222c2233225d5d2c5b226b696e64222c5b22737472696e67222c22636c6f636b67726f76652e706172746974696f6e2d736e617073686f74225d5d2c5b2273636f7065222c5b227265636f7264222c5b5b22706172746974696f6e4964222c5b22737472696e67222c22706172746974696f6e69645f336163663539386165623861336438333a626561636f6e2e68616c6c225d5d2c5b2273706163654964222c5b22737472696e67222c22626561636f6e2e68616c6c225d5d2c5b2274656e616e744964222c5b22737472696e67222c2274656e616e7469645f34343361646661343731343037383064225d5d2c5b2274696d656c696e654964222c5b22737472696e67222c2274696d656c696e6569645f61393434613164363132393434393736225d5d2c5b22776f726c644964222c5b22737472696e67222c22776f726c6469645f62303961656435343933326338663531225d5d5d5d5d2c5b2273746f726564222c5b227265636f7264222c5b5b22646f63756d656e74222c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c226b696e64225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22636c6f636b67726f76652e706172746974696f6e2d7374617465225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c2272616e646f6d5374617465225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c225b5c22636c6f636b67726f76652d63616e6f6e6963616c2d76315c222c5b5c2261727261795c222c5b5b5c22737472696e675c222c5c22636c6f636b67726f76652d72616e646f6d2d76315c225d2c5b5c2261727261795c222c5b5b5c2261727261795c222c5b5b5c22737472696e675c222c5c22776561746865725c225d2c5b5c22737472696e675c222c5c22707572652d72616e6440382e342e322f786f726f736869726f313238706c75735c225d2c5b5c22737472696e675c222c5c22315c225d2c5b5c22737472696e675c222c5c22305c225d2c5b5c2261727261795c222c5b5b5c22737472696e675c222c5c222d315c225d2c5b5c22737472696e675c222c5c22355c225d2c5b5c22737472696e675c222c5c222d365c225d2c5b5c22737472696e675c222c5c22375c225d5d5d5d5d5d5d5d5d5d225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227363686564756c657348617368225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c2237383638323937633439313135303461613535343330626230623334613861383066636664383064326537343263353937306431323231666232346133653435225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227374617465225d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c22656e746974696573225d2c5b226172726179222c5b5b22737472696e67222c226172726179225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c226172636865747970654964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22626561636f6e2e6369737465726e2d6b696e644031225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226f626a6563744964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22626561636f6e2e6369737465726e225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22706f7365225d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c22636f6f7264696e61746573225d2c5b226172726179222c5b5b22737472696e67222c226172726179225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c22323030225d5d5d2c5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c22313030225d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226672616d654964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c226672616d652d68616c6c225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226672616d6556657273696f6e225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2231225d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227265736f75726365225d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c226b696e64225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c227761746572225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227175616e74697479225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2235225d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c2273706163654964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22626561636f6e2e68616c6c225d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c226172636865747970654964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22626561636f6e2e6c616d702d6b696e644031225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226f626a6563744964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22626561636f6e2e6c616d70225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22706f7365225d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c22636f6f7264696e61746573225d2c5b226172726179222c5b5b22737472696e67222c226172726179225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c22333030225d5d5d2c5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c22313030225d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226672616d654964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c226672616d652d68616c6c225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226672616d6556657273696f6e225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2231225d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227368656c746572225d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c227261696e50726f74656374696f6e225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2235303030225d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c2273706163654964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22626561636f6e2e68616c6c225d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c226172636865747970654964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22626561636f6e2e6c61726465722d6b696e644031225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226f626a6563744964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22626561636f6e2e6c6172646572225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22706f7365225d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c22636f6f7264696e61746573225d2c5b226172726179222c5b5b22737472696e67222c226172726179225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c22313030225d5d5d2c5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c22313030225d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226672616d654964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c226672616d652d68616c6c225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226672616d6556657273696f6e225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2231225d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227265736f75726365225d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c226b696e64225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22666f6f64225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227175616e74697479225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2233225d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c2273706163654964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22626561636f6e2e68616c6c225d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c226172636865747970654964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22626561636f6e2e6b65657065722d6b696e644031225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226e65656473225d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c2268756e676572225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2233303030225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c2268756e67657252656d61696e646572225d2c5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c2230225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22696e74656772617465644174225d2c5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c2230225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227765746e657373225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2230225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227765746e65737352656d61696e646572225d2c5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c2230225d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226f626a6563744964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22626561636f6e2e6d6173746572225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22706f7365225d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c22636f6f7264696e61746573225d2c5b226172726179222c5b5b22737472696e67222c226172726179225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c223130225d5d5d2c5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c223230225d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226672616d654964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c226672616d652d68616c6c225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226672616d6556657273696f6e225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2231225d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c2273706163654964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22626561636f6e2e68616c6c225d5d5d5d5d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22656e7669726f6e6d656e74225d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c226c6967687442616e64225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22627269676874225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226e6578745068617365426f756e64617279225d2c5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c223433323030303030225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226e65787457656174686572426f756e64617279225d2c5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c2233363030303030225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227068617365225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22646179225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227365676d656e74496e646578225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2230225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c2274656d706572617475726542616e64225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c226d696c64225d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22706172746974696f6e4964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22706172746974696f6e69645f33616366353938616562386133643833225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227265766973696f6e225d2c5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c2230225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22736368656d6156657273696f6e225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2231225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227363726970746564436f676e6974696f6e225d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c22656e7472696573225d2c5b226172726179222c5b5b22737472696e67222c226172726179225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c226163746f724964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22626561636f6e2e6d6173746572225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226566666563746976654174225d2c5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c2231303030225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226b696e64225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c226d656d6f7279225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22726566225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c2273637269707465643a6369737465726e2d6d656d6f7279225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227461726765744f626a6563744964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22626561636f6e2e6369737465726e225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c2276616c7565225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2234303030225d5d5d5d5d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22736368656d6156657273696f6e225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2231225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22736f75726365225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c227363726970746564225d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c2273696d756c6174696f6e54696d65225d2c5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c22313030303030225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227370617469616c4672616d6573225d2c5b226172726179222c5b5b22737472696e67222c226172726179225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c2261786573225d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c2261786573225d2c5b226172726179222c5b5b22737472696e67222c226172726179225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c226e616d65225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c2278225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22706f736974697665446972656374696f6e225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c2265617374225d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c226e616d65225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c2279225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22706f736974697665446972656374696f6e225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c226e6f727468225d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c2264696d656e73696f6e73225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2232225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226672616d654964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c226672616d652d68616c6c225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c2267726176697479225d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c226b696e64225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22636f6e7374616e742d766563746f72225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22766563746f72225d2c5b226172726179222c5b5b22737472696e67222c226172726179225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c2230225d5d5d2c5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c2230225d5d5d5d5d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226f726967696e225d2c5b226172726179222c5b5b22737472696e67222c226172726179225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c2230225d5d5d2c5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c2230225d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22756e6974225d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c226672616374696f6e616c446967697473225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2233225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226e616d65225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c226d65746572225d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c2276657273696f6e225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2231225d5d5d5d5d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227370617469616c526567696f6e73225d2c5b226172726179222c5b5b22737472696e67222c226172726179225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c226672616d654964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c226672616d652d68616c6c225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226672616d6556657273696f6e225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2231225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22726567696f6e4964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c2268616c6c225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227368617065225d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c226b696e64225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c2272656374616e676c65225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226d6178225d2c5b226172726179222c5b5b22737472696e67222c226172726179225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c2232303030225d5d5d2c5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c2231303030225d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226d696e225d2c5b226172726179222c5b5b22737472696e67222c226172726179225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c2230225d5d5d2c5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c2230225d5d5d5d5d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c2276657273696f6e225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2231225d5d5d5d5d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c2274656e616e744964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c2274656e616e7469645f34343361646661343731343037383064225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c2274696d656c696e654964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c2274696d656c696e6569645f61393434613164363132393434393736225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c2277656174686572225d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c227261696e496e74656e73697479225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2230225d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c2277656c6c6265696e67225d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c22656e7472696573225d2c5b226172726179222c5b5b22737472696e67222c226172726179225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c22636f6d666f7274225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22636f6d666f727461626c65225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226865616c7468225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c223130303030225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226865616c746852656d61696e646572225d2c5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c2230225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22696e74656772617465644174225d2c5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c2230225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226f626a6563744964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22626561636f6e2e6d6173746572225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22746869727374225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2230225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c2274686972737452656d61696e646572225d2c5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c2230225d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22776f726c644964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22776f726c6469645f62303961656435343933326338663531225d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c2276657273696f6e225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2232225d5d5d5d5d5d5d5d5d5d2c5b22646f63756d656e7448617368222c5b22737472696e67222c2230353438646238323631643337383230353163383539306339356165653264386133313162323061363836393235396638346266626639633538623164373761225d5d2c5b22646f63756d656e7456657273696f6e222c5b22696e7465676572222c2232225d5d2c5b227265766973696f6e222c5b22626967696e74222c2230225d5d2c5b227363686564756c6573222c5b226172726179222c5b5b227265636f7264222c5b5b2263617463685570436c617373222c5b22737472696e67222c226578616374225d5d2c5b226475654174222c5b22626967696e74222c22313030303030225d5d2c5b226964656d706f74656e63794b6579222c5b22737472696e67222c227363686564756c6569645f363263643866343635343631353463323a313030303030225d5d2c5b226974656d222c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c2263617463685570436c617373225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c226578616374225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226475654174225d2c5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c22313030303030225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c227363686564756c6569645f36326364386634363534363135346332225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226964656d706f74656e63794b6579225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c227363686564756c6569645f363263643866343635343631353463323a313030303030225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226b696e64225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22776f726c642e6465636973696f6e225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226f776e6572506172746974696f6e4964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22706172746974696f6e69645f33616366353938616562386133643833225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227061796c6f6164225d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c226f626a6563744964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22626561636f6e2e6d6173746572225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22736368656d6156657273696f6e225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2231225d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227061796c6f616456657273696f6e225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2231225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227072696f72697479225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c223130225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c2274656e616e744964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c2274656e616e7469645f34343361646661343731343037383064225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22746965427265616b4b6579225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22626561636f6e2e6d6173746572225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c2274696d656c696e654964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c2274696d656c696e6569645f61393434613164363132393434393736225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22776f726c644964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22776f726c6469645f62303961656435343933326338663531225d5d5d5d5d5d5d5d5d5d2c5b226974656d48617368222c5b22737472696e67222c2235303133643465396465363839616564373663626430316432386162623032393336656330393061306165643866376638663234323037636136643965636333225d5d2c5b226b696e64222c5b22737472696e67222c22776f726c642e6465636973696f6e225d5d2c5b226f776e6572506172746974696f6e4964222c5b22737472696e67222c22706172746974696f6e69645f33616366353938616562386133643833225d5d2c5b227061796c6f616456657273696f6e222c5b22696e7465676572222c2231225d5d2c5b227072696f72697479222c5b22696e7465676572222c223130225d5d2c5b227363686564756c654964222c5b22737472696e67222c227363686564756c6569645f36326364386634363534363135346332225d5d2c5b22746965427265616b4b6579222c5b22737472696e67222c22626561636f6e2e6d6173746572225d5d5d5d5d5d5d2c5b2273696d756c6174696f6e54696d65222c5b22626967696e74222c22313030303030225d5d2c5b22737461746548617368222c5b22737472696e67222c2230623233376436656130613535323135343630626362383035346562663738663032643663666530336337666639323139343333363434376539333237386664225d5d5d5d5d2c5b2273747265616d4964222c5b22737472696e67222c22706172746974696f6e69645f336163663539386165623861336438333a626561636f6e2e68616c6c3a73747265616d225d5d2c5b2276657273696f6e222c5b22696e7465676572222c2231225d5d5d5d5d	durable	none	\N
tenantid_443adfa47140780d	worldid_b09aed54932c8f51	timelineid_a944a1d612944976	partitionid_3acf598aeb8a3d83:beacon.hall	beacon.hall	snapshot:timelineid_a944a1d612944976:partitionid_3acf598aeb8a3d83%3Abeacon.hall:6:artifact	sha256:282c6ce6170928ea280d322a503d9e3a283eea14bf0a410926c757afc401660c	application/json	\N	14308	public_scene	2026-10-19 23:52:18.937017-07	\\x5b22636c6f636b67726f76652d63616e6f6e6963616c2d7631222c5b227265636f7264222c5b5b22636f6d7061746962696c697479222c5b227265636f7264222c5b5b2263616e6f6e6963616c456e636f64696e67222c5b22737472696e67222c22636c6f636b67726f76652d63616e6f6e6963616c2d7631225d5d2c5b22636f646563222c5b22696e7465676572222c2231225d5d2c5b22646f63756d656e7456657273696f6e222c5b22696e7465676572222c2232225d5d2c5b226b65726e656c526567697374727948617368222c5b22737472696e67222c2238303566663961336266396134373762303361343138386336396266313062353365396538653536323435336363393933356535366438643036613537373938225d5d2c5b227061636b436f6e74656e7448617368222c5b22737472696e67222c2238313361336638343638353965353563643935626530666262333335396530653336323338663739346536323635663365663139613166616436353937393036225d5d2c5b2272616e646f6d436f6e7472616374222c5b22737472696e67222c22636c6f636b67726f76652d72616e646f6d2d7631225d5d5d5d5d2c5b22636f7665726564506172746974696f6e53657175656e6365222c5b22626967696e74222c2236225d5d2c5b22636f766572656453747265616d53657175656e6365222c5b22626967696e74222c2236225d5d2c5b226b696e64222c5b22737472696e67222c22636c6f636b67726f76652e706172746974696f6e2d736e617073686f74225d5d2c5b2273636f7065222c5b227265636f7264222c5b5b22706172746974696f6e4964222c5b22737472696e67222c22706172746974696f6e69645f336163663539386165623861336438333a626561636f6e2e68616c6c225d5d2c5b2273706163654964222c5b22737472696e67222c22626561636f6e2e68616c6c225d5d2c5b2274656e616e744964222c5b22737472696e67222c2274656e616e7469645f34343361646661343731343037383064225d5d2c5b2274696d656c696e654964222c5b22737472696e67222c2274696d656c696e6569645f61393434613164363132393434393736225d5d2c5b22776f726c644964222c5b22737472696e67222c22776f726c6469645f62303961656435343933326338663531225d5d5d5d5d2c5b2273746f726564222c5b227265636f7264222c5b5b22646f63756d656e74222c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c226b696e64225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22636c6f636b67726f76652e706172746974696f6e2d7374617465225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c2272616e646f6d5374617465225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c225b5c22636c6f636b67726f76652d63616e6f6e6963616c2d76315c222c5b5c2261727261795c222c5b5b5c22737472696e675c222c5c22636c6f636b67726f76652d72616e646f6d2d76315c225d2c5b5c2261727261795c222c5b5b5c2261727261795c222c5b5b5c22737472696e675c222c5c22776561746865725c225d2c5b5c22737472696e675c222c5c22707572652d72616e6440382e342e322f786f726f736869726f313238706c75735c225d2c5b5c22737472696e675c222c5c22315c225d2c5b5c22737472696e675c222c5c22305c225d2c5b5c2261727261795c222c5b5b5c22737472696e675c222c5c222d315c225d2c5b5c22737472696e675c222c5c22355c225d2c5b5c22737472696e675c222c5c222d365c225d2c5b5c22737472696e675c222c5c22375c225d5d5d5d5d5d5d5d5d5d225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227363686564756c657348617368225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c2237383638323937633439313135303461613535343330626230623334613861383066636664383064326537343263353937306431323231666232346133653435225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227374617465225d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c22656e746974696573225d2c5b226172726179222c5b5b22737472696e67222c226172726179225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c226172636865747970654964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22626561636f6e2e6369737465726e2d6b696e644031225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226f626a6563744964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22626561636f6e2e6369737465726e225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22706f7365225d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c22636f6f7264696e61746573225d2c5b226172726179222c5b5b22737472696e67222c226172726179225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c22323030225d5d5d2c5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c22313030225d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226672616d654964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c226672616d652d68616c6c225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226672616d6556657273696f6e225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2231225d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227265736f75726365225d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c226b696e64225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c227761746572225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227175616e74697479225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2235225d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c2273706163654964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22626561636f6e2e68616c6c225d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c226172636865747970654964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22626561636f6e2e6c616d702d6b696e644031225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226f626a6563744964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22626561636f6e2e6c616d70225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22706f7365225d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c22636f6f7264696e61746573225d2c5b226172726179222c5b5b22737472696e67222c226172726179225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c22333030225d5d5d2c5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c22313030225d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226672616d654964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c226672616d652d68616c6c225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226672616d6556657273696f6e225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2231225d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227368656c746572225d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c227261696e50726f74656374696f6e225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2235303030225d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c2273706163654964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22626561636f6e2e68616c6c225d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c226172636865747970654964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22626561636f6e2e6c61726465722d6b696e644031225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226f626a6563744964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22626561636f6e2e6c6172646572225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22706f7365225d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c22636f6f7264696e61746573225d2c5b226172726179222c5b5b22737472696e67222c226172726179225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c22313030225d5d5d2c5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c22313030225d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226672616d654964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c226672616d652d68616c6c225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226672616d6556657273696f6e225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2231225d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227265736f75726365225d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c226b696e64225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22666f6f64225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227175616e74697479225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2233225d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c2273706163654964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22626561636f6e2e68616c6c225d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c226172636865747970654964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22626561636f6e2e6b65657065722d6b696e644031225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226e65656473225d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c2268756e676572225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2233313636225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c2268756e67657252656d61696e646572225d2c5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c223430303030225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22696e74656772617465644174225d2c5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c22313030303030225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227765746e657373225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2230225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227765746e65737352656d61696e646572225d2c5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c2230225d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226f626a6563744964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22626561636f6e2e6d6173746572225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22706f7365225d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c22636f6f7264696e61746573225d2c5b226172726179222c5b5b22737472696e67222c226172726179225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c223130225d5d5d2c5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c223230225d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226672616d654964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c226672616d652d68616c6c225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226672616d6556657273696f6e225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2231225d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c2273706163654964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22626561636f6e2e68616c6c225d5d5d5d5d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22656e7669726f6e6d656e74225d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c226c6967687442616e64225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22627269676874225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226e6578745068617365426f756e64617279225d2c5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c223433323030303030225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226e65787457656174686572426f756e64617279225d2c5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c2233363030303030225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227068617365225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22646179225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227365676d656e74496e646578225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2230225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c2274656d706572617475726542616e64225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c226d696c64225d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22706172746974696f6e4964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22706172746974696f6e69645f33616366353938616562386133643833225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227265766973696f6e225d2c5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c2233225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22736368656d6156657273696f6e225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2231225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227363726970746564436f676e6974696f6e225d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c22656e7472696573225d2c5b226172726179222c5b5b22737472696e67222c226172726179225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c226163746f724964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22626561636f6e2e6d6173746572225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226566666563746976654174225d2c5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c2231303030225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226b696e64225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c226d656d6f7279225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22726566225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c2273637269707465643a6369737465726e2d6d656d6f7279225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227461726765744f626a6563744964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22626561636f6e2e6369737465726e225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c2276616c7565225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2234303030225d5d5d5d5d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22736368656d6156657273696f6e225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2231225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22736f75726365225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c227363726970746564225d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c2273696d756c6174696f6e54696d65225d2c5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c22313030303030225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227370617469616c4672616d6573225d2c5b226172726179222c5b5b22737472696e67222c226172726179225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c2261786573225d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c2261786573225d2c5b226172726179222c5b5b22737472696e67222c226172726179225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c226e616d65225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c2278225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22706f736974697665446972656374696f6e225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c2265617374225d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c226e616d65225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c2279225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22706f736974697665446972656374696f6e225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c226e6f727468225d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c2264696d656e73696f6e73225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2232225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226672616d654964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c226672616d652d68616c6c225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c2267726176697479225d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c226b696e64225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22636f6e7374616e742d766563746f72225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22766563746f72225d2c5b226172726179222c5b5b22737472696e67222c226172726179225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c2230225d5d5d2c5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c2230225d5d5d5d5d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226f726967696e225d2c5b226172726179222c5b5b22737472696e67222c226172726179225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c2230225d5d5d2c5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c2230225d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22756e6974225d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c226672616374696f6e616c446967697473225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2233225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226e616d65225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c226d65746572225d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c2276657273696f6e225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2231225d5d5d5d5d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227370617469616c526567696f6e73225d2c5b226172726179222c5b5b22737472696e67222c226172726179225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c226672616d654964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c226672616d652d68616c6c225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226672616d6556657273696f6e225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2231225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22726567696f6e4964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c2268616c6c225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227368617065225d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c226b696e64225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c2272656374616e676c65225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226d6178225d2c5b226172726179222c5b5b22737472696e67222c226172726179225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c2232303030225d5d5d2c5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c2231303030225d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226d696e225d2c5b226172726179222c5b5b22737472696e67222c226172726179225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c2230225d5d5d2c5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c2230225d5d5d5d5d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c2276657273696f6e225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2231225d5d5d5d5d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c2274656e616e744964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c2274656e616e7469645f34343361646661343731343037383064225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c2274696d656c696e654964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c2274696d656c696e6569645f61393434613164363132393434393736225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c2277656174686572225d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c227261696e496e74656e73697479225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2230225d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c2277656c6c6265696e67225d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c22656e7472696573225d2c5b226172726179222c5b5b22737472696e67222c226172726179225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c22636f6d666f7274225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22636f6d666f727461626c65225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226865616c7468225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c223130303030225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226865616c746852656d61696e646572225d2c5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c2230225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22696e74656772617465644174225d2c5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c22313030303030225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226f626a6563744964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22626561636f6e2e6d6173746572225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22746869727374225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c223833225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c2274686972737452656d61696e646572225d2c5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c223230303030225d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22776f726c644964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22776f726c6469645f62303961656435343933326338663531225d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c2276657273696f6e225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2232225d5d5d5d5d5d5d5d5d5d2c5b22646f63756d656e7448617368222c5b22737472696e67222c2239346130666464373530366164663463626537633266646332303033653034356165376261393331336664633037393733646665383830643263663238653730225d5d2c5b22646f63756d656e7456657273696f6e222c5b22696e7465676572222c2232225d5d2c5b227265766973696f6e222c5b22626967696e74222c2233225d5d2c5b227363686564756c6573222c5b226172726179222c5b5b227265636f7264222c5b5b2263617463685570436c617373222c5b22737472696e67222c226578616374225d5d2c5b226475654174222c5b22626967696e74222c22313030303030225d5d2c5b226964656d706f74656e63794b6579222c5b22737472696e67222c227363686564756c6569645f363263643866343635343631353463323a313030303030225d5d2c5b226974656d222c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c2263617463685570436c617373225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c226578616374225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226475654174225d2c5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c22313030303030225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c227363686564756c6569645f36326364386634363534363135346332225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226964656d706f74656e63794b6579225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c227363686564756c6569645f363263643866343635343631353463323a313030303030225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226b696e64225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22776f726c642e6465636973696f6e225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226f776e6572506172746974696f6e4964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22706172746974696f6e69645f33616366353938616562386133643833225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227061796c6f6164225d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c226f626a6563744964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22626561636f6e2e6d6173746572225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22736368656d6156657273696f6e225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2231225d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227061796c6f616456657273696f6e225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2231225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227072696f72697479225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c223130225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c2274656e616e744964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c2274656e616e7469645f34343361646661343731343037383064225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22746965427265616b4b6579225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22626561636f6e2e6d6173746572225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c2274696d656c696e654964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c2274696d656c696e6569645f61393434613164363132393434393736225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22776f726c644964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22776f726c6469645f62303961656435343933326338663531225d5d5d5d5d5d5d5d5d5d2c5b226974656d48617368222c5b22737472696e67222c2235303133643465396465363839616564373663626430316432386162623032393336656330393061306165643866376638663234323037636136643965636333225d5d2c5b226b696e64222c5b22737472696e67222c22776f726c642e6465636973696f6e225d5d2c5b226f776e6572506172746974696f6e4964222c5b22737472696e67222c22706172746974696f6e69645f33616366353938616562386133643833225d5d2c5b227061796c6f616456657273696f6e222c5b22696e7465676572222c2231225d5d2c5b227072696f72697479222c5b22696e7465676572222c223130225d5d2c5b227363686564756c654964222c5b22737472696e67222c227363686564756c6569645f36326364386634363534363135346332225d5d2c5b22746965427265616b4b6579222c5b22737472696e67222c22626561636f6e2e6d6173746572225d5d5d5d5d5d5d2c5b2273696d756c6174696f6e54696d65222c5b22626967696e74222c22313030303030225d5d2c5b22737461746548617368222c5b22737472696e67222c2266373738356166343063303963653462326531366566663932616439376266343965613765363339316566336232646137303432326132623565383936343633225d5d5d5d5d2c5b2273747265616d4964222c5b22737472696e67222c22706172746974696f6e69645f336163663539386165623861336438333a626561636f6e2e68616c6c3a73747265616d225d5d2c5b2276657273696f6e222c5b22696e7465676572222c2231225d5d5d5d5d	durable	none	\N
tenantid_443adfa47140780d	worldid_b09aed54932c8f51	timelineid_a944a1d612944976	partitionid_3acf598aeb8a3d83:beacon.hall	beacon.hall	snapshot:timelineid_a944a1d612944976:partitionid_3acf598aeb8a3d83%3Abeacon.hall:26:artifact	sha256:535911e111c2b99339bf949c907478ed17efe9e02e452b38baea3b3a1b8219f7	application/json	\N	17253	public_scene	2026-10-19 23:52:18.989388-07	\\x5b22636c6f636b67726f76652d63616e6f6e6963616c2d7631222c5b227265636f7264222c5b5b22636f6d7061746962696c697479222c5b227265636f7264222c5b5b2263616e6f6e6963616c456e636f64696e67222c5b22737472696e67222c22636c6f636b67726f76652d63616e6f6e6963616c2d7631225d5d2c5b22636f646563222c5b22696e7465676572222c2231225d5d2c5b22646f63756d656e7456657273696f6e222c5b22696e7465676572222c2232225d5d2c5b226b65726e656c526567697374727948617368222c5b22737472696e67222c2238303566663961336266396134373762303361343138386336396266313062353365396538653536323435336363393933356535366438643036613537373938225d5d2c5b227061636b436f6e74656e7448617368222c5b22737472696e67222c2238313361336638343638353965353563643935626530666262333335396530653336323338663739346536323635663365663139613166616436353937393036225d5d2c5b2272616e646f6d436f6e7472616374222c5b22737472696e67222c22636c6f636b67726f76652d72616e646f6d2d7631225d5d5d5d5d2c5b22636f7665726564506172746974696f6e53657175656e6365222c5b22626967696e74222c223236225d5d2c5b22636f766572656453747265616d53657175656e6365222c5b22626967696e74222c223236225d5d2c5b226b696e64222c5b22737472696e67222c22636c6f636b67726f76652e706172746974696f6e2d736e617073686f74225d5d2c5b2273636f7065222c5b227265636f7264222c5b5b22706172746974696f6e4964222c5b22737472696e67222c22706172746974696f6e69645f336163663539386165623861336438333a626561636f6e2e68616c6c225d5d2c5b2273706163654964222c5b22737472696e67222c22626561636f6e2e68616c6c225d5d2c5b2274656e616e744964222c5b22737472696e67222c2274656e616e7469645f34343361646661343731343037383064225d5d2c5b2274696d656c696e654964222c5b22737472696e67222c2274696d656c696e6569645f61393434613164363132393434393736225d5d2c5b22776f726c644964222c5b22737472696e67222c22776f726c6469645f62303961656435343933326338663531225d5d5d5d5d2c5b2273746f726564222c5b227265636f7264222c5b5b22646f63756d656e74222c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c226b696e64225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22636c6f636b67726f76652e706172746974696f6e2d7374617465225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c2272616e646f6d5374617465225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c225b5c22636c6f636b67726f76652d63616e6f6e6963616c2d76315c222c5b5c2261727261795c222c5b5b5c22737472696e675c222c5c22636c6f636b67726f76652d72616e646f6d2d76315c225d2c5b5c2261727261795c222c5b5b5c2261727261795c222c5b5b5c22737472696e675c222c5c22776561746865725c225d2c5b5c22737472696e675c222c5c22707572652d72616e6440382e342e322f786f726f736869726f313238706c75735c225d2c5b5c22737472696e675c222c5c22315c225d2c5b5c22737472696e675c222c5c22305c225d2c5b5c2261727261795c222c5b5b5c22737472696e675c222c5c222d315c225d2c5b5c22737472696e675c222c5c22355c225d2c5b5c22737472696e675c222c5c222d365c225d2c5b5c22737472696e675c222c5c22375c225d5d5d5d5d5d5d5d5d5d225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227363686564756c657348617368225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c2261373862306634346164303565323366663439386262366662373261396466363831383837663364643436393036336163613038353831626665326437623837225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227374617465225d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c22656e746974696573225d2c5b226172726179222c5b5b22737472696e67222c226172726179225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c226172636865747970654964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22626561636f6e2e6369737465726e2d6b696e644031225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226f626a6563744964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22626561636f6e2e6369737465726e225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22706f7365225d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c22636f6f7264696e61746573225d2c5b226172726179222c5b5b22737472696e67222c226172726179225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c22323030225d5d5d2c5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c22313030225d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226672616d654964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c226672616d652d68616c6c225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226672616d6556657273696f6e225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2231225d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227265736f75726365225d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c226b696e64225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c227761746572225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227175616e74697479225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2234225d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c2273706163654964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22626561636f6e2e68616c6c225d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c226172636865747970654964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22626561636f6e2e6c616d702d6b696e644031225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226f626a6563744964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22626561636f6e2e6c616d70225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22706f7365225d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c22636f6f7264696e61746573225d2c5b226172726179222c5b5b22737472696e67222c226172726179225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c22333030225d5d5d2c5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c22313030225d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226672616d654964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c226672616d652d68616c6c225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226672616d6556657273696f6e225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2231225d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227368656c746572225d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c227261696e50726f74656374696f6e225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2235303030225d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c2273706163654964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22626561636f6e2e68616c6c225d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c226172636865747970654964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22626561636f6e2e6c61726465722d6b696e644031225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226f626a6563744964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22626561636f6e2e6c6172646572225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22706f7365225d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c22636f6f7264696e61746573225d2c5b226172726179222c5b5b22737472696e67222c226172726179225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c22313030225d5d5d2c5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c22313030225d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226672616d654964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c226672616d652d68616c6c225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226672616d6556657273696f6e225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2231225d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227265736f75726365225d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c226b696e64225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22666f6f64225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227175616e74697479225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2232225d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c2273706163654964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22626561636f6e2e68616c6c225d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c226172636865747970654964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22626561636f6e2e6b65657065722d6b696e644031225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226d6f76656d656e74225d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c22616e63686f7250617468225d2c5b226172726179222c5b5b22737472696e67222c226172726179225d2c5b226172726179222c5b5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c2264657374696e6174696f6e225d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c226b696e64225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22706f7365225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22706f7365225d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c22636f6f7264696e61746573225d2c5b226172726179222c5b5b22737472696e67222c226172726179225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c22323030225d5d5d2c5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c22313030225d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226672616d654964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c226672616d652d68616c6c225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226672616d6556657273696f6e225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2231225d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22656d6974746564225d2c5b226172726179222c5b5b22737472696e67222c226172726179225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c226b696e64225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22657869746564225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22726567696f6e4964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c2268616c6c225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22726567696f6e56657273696f6e225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2231225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c2274696d65225d2c5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c22313630313030225d5d5d5d5d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22656e6465644174225d2c5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c22313630313030225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c2265786974656441745374617274225d2c5b226172726179222c5b5b22737472696e67222c226172726179225d2c5b226172726179222c5b5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226672616d654964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c226672616d652d68616c6c225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226672616d6556657273696f6e225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2231225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22696e697469616c496e73696465225d2c5b226172726179222c5b5b22737472696e67222c226172726179225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c2268616c6c225d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226d6f76656d656e744964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c226d6f76656d656e742d636f6d6d616e6469645f37303335663533363034343930356437225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227365676d656e74225d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c227370656564225d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c226b696e64225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22636f6e7374616e742d756e6974732d7065722d7365636f6e64225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22756e6974735065725365636f6e64225d2c5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c2231303030225d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22737461727454696d65225d2c5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c22313630303030225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22776179706f696e7473225d2c5b226172726179222c5b5b22737472696e67222c226172726179225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c226172726179225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c22313030225d5d5d2c5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c22313030225d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226172726179225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c22323030225d5d5d2c5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c22313030225d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22737461747573225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22636f6d706c65746564225d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226e65656473225d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c2268756e676572225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2232323833225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c2268756e67657252656d61696e646572225d2c5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c223230303030225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22696e74656772617465644174225d2c5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c22313730303030225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227765746e657373225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2230225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227765746e65737352656d61696e646572225d2c5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c2230225d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226f626a6563744964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22626561636f6e2e6d6173746572225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22706f7365225d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c22636f6f7264696e61746573225d2c5b226172726179222c5b5b22737472696e67222c226172726179225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c22323030225d5d5d2c5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c22313030225d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226672616d654964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c226672616d652d68616c6c225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226672616d6556657273696f6e225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2231225d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c2273656c6563746564416374696f6e225d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c226b696e64225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c227365656b2d7761746572225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227461726765744f626a6563744964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22626561636f6e2e6369737465726e225d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c2273706163654964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22626561636f6e2e68616c6c225d5d5d5d5d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22656e7669726f6e6d656e74225d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c226c6967687442616e64225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22627269676874225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226e6578745068617365426f756e64617279225d2c5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c223433323030303030225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226e65787457656174686572426f756e64617279225d2c5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c2233363030303030225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227068617365225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22646179225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227365676d656e74496e646578225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2230225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c2274656d706572617475726542616e64225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c226d696c64225d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22706172746974696f6e4964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22706172746974696f6e69645f33616366353938616562386133643833225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227265766973696f6e225d2c5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c223233225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22736368656d6156657273696f6e225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2231225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227363726970746564436f676e6974696f6e225d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c22656e7472696573225d2c5b226172726179222c5b5b22737472696e67222c226172726179225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c226163746f724964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22626561636f6e2e6d6173746572225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226566666563746976654174225d2c5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c2231303030225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226b696e64225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c226d656d6f7279225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22726566225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c2273637269707465643a6369737465726e2d6d656d6f7279225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227461726765744f626a6563744964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22626561636f6e2e6369737465726e225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c2276616c7565225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2234303030225d5d5d5d5d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22736368656d6156657273696f6e225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2231225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22736f75726365225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c227363726970746564225d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c2273696d756c6174696f6e54696d65225d2c5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c22313730303030225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227370617469616c4672616d6573225d2c5b226172726179222c5b5b22737472696e67222c226172726179225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c2261786573225d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c2261786573225d2c5b226172726179222c5b5b22737472696e67222c226172726179225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c226e616d65225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c2278225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22706f736974697665446972656374696f6e225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c2265617374225d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c226e616d65225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c2279225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22706f736974697665446972656374696f6e225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c226e6f727468225d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c2264696d656e73696f6e73225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2232225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226672616d654964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c226672616d652d68616c6c225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c2267726176697479225d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c226b696e64225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22636f6e7374616e742d766563746f72225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22766563746f72225d2c5b226172726179222c5b5b22737472696e67222c226172726179225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c2230225d5d5d2c5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c2230225d5d5d5d5d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226f726967696e225d2c5b226172726179222c5b5b22737472696e67222c226172726179225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c2230225d5d5d2c5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c2230225d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22756e6974225d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c226672616374696f6e616c446967697473225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2233225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226e616d65225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c226d65746572225d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c2276657273696f6e225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2231225d5d5d5d5d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227370617469616c526567696f6e73225d2c5b226172726179222c5b5b22737472696e67222c226172726179225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c226672616d654964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c226672616d652d68616c6c225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226672616d6556657273696f6e225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2231225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22726567696f6e4964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c2268616c6c225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227368617065225d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c226b696e64225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c2272656374616e676c65225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226d6178225d2c5b226172726179222c5b5b22737472696e67222c226172726179225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c2232303030225d5d5d2c5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c2231303030225d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226d696e225d2c5b226172726179222c5b5b22737472696e67222c226172726179225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c2230225d5d5d2c5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c2230225d5d5d5d5d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c2276657273696f6e225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2231225d5d5d5d5d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c2274656e616e744964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c2274656e616e7469645f34343361646661343731343037383064225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c2274696d656c696e654964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c2274696d656c696e6569645f61393434613164363132393434393736225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c2277656174686572225d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c227261696e496e74656e73697479225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2230225d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c2277656c6c6265696e67225d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c22656e7472696573225d2c5b226172726179222c5b5b22737472696e67222c226172726179225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c22636f6d666f7274225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22636f6d666f727461626c65225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226865616c7468225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c223130303030225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226865616c746852656d61696e646572225d2c5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c2230225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22696e74656772617465644174225d2c5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c22313730303030225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226f626a6563744964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22626561636f6e2e6d6173746572225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22746869727374225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2238225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c2274686972737452656d61696e646572225d2c5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c223430303030225d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22776f726c644964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22776f726c6469645f62303961656435343933326338663531225d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c2276657273696f6e225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2232225d5d5d5d5d5d5d5d5d5d2c5b22646f63756d656e7448617368222c5b22737472696e67222c2266373534633061383263366530663363626230396264323030396335333661653339333437656639336431313733313533336333336335633262323831613239225d5d2c5b22646f63756d656e7456657273696f6e222c5b22696e7465676572222c2232225d5d2c5b227265766973696f6e222c5b22626967696e74222c223233225d5d2c5b227363686564756c6573222c5b226172726179222c5b5b227265636f7264222c5b5b2263617463685570436c617373222c5b22737472696e67222c226578616374225d5d2c5b226475654174222c5b22626967696e74222c22323230303030225d5d2c5b226964656d706f74656e63794b6579222c5b22737472696e67222c227363686564756c6569645f363263643866343635343631353463323a323230303030225d5d2c5b226974656d222c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c2263617463685570436c617373225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c226578616374225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226475654174225d2c5b226172726179222c5b5b22737472696e67222c22626967696e74225d2c5b22737472696e67222c22323230303030225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c227363686564756c6569645f36326364386634363534363135346332225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226964656d706f74656e63794b6579225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c227363686564756c6569645f363263643866343635343631353463323a323230303030225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226b696e64225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22776f726c642e6465636973696f6e225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c226f776e6572506172746974696f6e4964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22706172746974696f6e69645f33616366353938616562386133643833225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227061796c6f6164225d2c5b226172726179222c5b5b22737472696e67222c227265636f7264225d2c5b226172726179222c5b5b226172726179222c5b5b22737472696e67222c226f626a6563744964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22626561636f6e2e6d6173746572225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22736368656d6156657273696f6e225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2231225d5d5d5d5d5d5d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227061796c6f616456657273696f6e225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c2231225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c227072696f72697479225d2c5b226172726179222c5b5b22737472696e67222c22696e7465676572225d2c5b22737472696e67222c223130225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c2274656e616e744964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c2274656e616e7469645f34343361646661343731343037383064225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22746965427265616b4b6579225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22626561636f6e2e6d6173746572225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c2274696d656c696e654964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c2274696d656c696e6569645f61393434613164363132393434393736225d5d5d5d5d2c5b226172726179222c5b5b22737472696e67222c22776f726c644964225d2c5b226172726179222c5b5b22737472696e67222c22737472696e67225d2c5b22737472696e67222c22776f726c6469645f62303961656435343933326338663531225d5d5d5d5d5d5d5d5d5d2c5b226974656d48617368222c5b22737472696e67222c2230643833613461353537393236616137643064376663313566373661313565656364353866313635323364303539383863666238396333616539623439363766225d5d2c5b226b696e64222c5b22737472696e67222c22776f726c642e6465636973696f6e225d5d2c5b226f776e6572506172746974696f6e4964222c5b22737472696e67222c22706172746974696f6e69645f33616366353938616562386133643833225d5d2c5b227061796c6f616456657273696f6e222c5b22696e7465676572222c2231225d5d2c5b227072696f72697479222c5b22696e7465676572222c223130225d5d2c5b227363686564756c654964222c5b22737472696e67222c227363686564756c6569645f36326364386634363534363135346332225d5d2c5b22746965427265616b4b6579222c5b22737472696e67222c22626561636f6e2e6d6173746572225d5d5d5d5d5d5d2c5b2273696d756c6174696f6e54696d65222c5b22626967696e74222c22313730303030225d5d2c5b22737461746548617368222c5b22737472696e67222c2234643263396264346236386165656534383964666165353338303335336530663435383832366134623736653565643134653337656565363464333434333939225d5d5d5d5d2c5b2273747265616d4964222c5b22737472696e67222c22706172746974696f6e69645f336163663539386165623861336438333a626561636f6e2e68616c6c3a73747265616d225d5d2c5b2276657273696f6e222c5b22696e7465676572222c2231225d5d5d5d5d	durable	none	\N
\.


--
-- Data for Name: authority_decisions; Type: TABLE DATA; Schema: clockgrove; Owner: clockgrove_migrator
--

COPY clockgrove.authority_decisions (tenant_id, authority_decision_id, command_id, outcome, world_id, timeline_id, action_id, attribution, inputs, reason_code, decided_at) FROM stdin;
tenantid_443adfa47140780d	authority:trusted:world-provisioning:commandid_978eb8659995d56a	trusted:world-provisioning:commandid_978eb8659995d56a	allow	worldid_b09aed54932c8f51	timelineid_a944a1d612944976	commandid_978eb8659995d56a	{"effectiveActorId": "world-provisioning", "causalRootActionId": "commandid_978eb8659995d56a"}	{"roles": [], "grants": [], "principalId": "principal-journal-parity", "privacyCeiling": {"version": 1, "allowedCategories": ["public_scene"]}}	\N	2026-10-19 23:52:18.792988-07
tenantid_443adfa47140780d	authority:trusted:world-provisioning:commandid_978eb8659995d56a:projection-verified	trusted:world-provisioning:commandid_978eb8659995d56a:projection-verified	allow	worldid_b09aed54932c8f51	timelineid_a944a1d612944976	commandid_978eb8659995d56a	{"effectiveActorId": "world-provisioning", "causalRootActionId": "commandid_978eb8659995d56a"}	{"roles": [], "grants": [], "principalId": "principal-journal-parity", "privacyCeiling": {"version": 1, "allowedCategories": ["public_scene"]}}	\N	2026-10-19 23:52:18.810375-07
tenantid_443adfa47140780d	authority:trusted:world-provisioning:commandid_978eb8659995d56a:world-ready	trusted:world-provisioning:commandid_978eb8659995d56a:world-ready	allow	worldid_b09aed54932c8f51	timelineid_a944a1d612944976	commandid_978eb8659995d56a	{"effectiveActorId": "world-provisioning", "causalRootActionId": "commandid_978eb8659995d56a"}	{"roles": [], "grants": [], "principalId": "principal-journal-parity", "privacyCeiling": {"version": 1, "allowedCategories": ["public_scene"]}}	\N	2026-10-19 23:52:18.816177-07
tenantid_443adfa47140780d	authority:commandid_a0368bd6d2238e50	commandid_a0368bd6d2238e50	allow	worldid_b09aed54932c8f51	timelineid_a944a1d612944976	commandid_2227c78359bd6f1a	{"effectiveActorId": "simulator-scenario", "causalRootActionId": "commandid_2227c78359bd6f1a"}	{"roles": [], "grants": [], "principalId": "principal-journal-parity", "privacyCeiling": {"version": 1, "allowedCategories": ["public_scene"]}}	\N	2026-10-19 23:52:18.909355-07
tenantid_443adfa47140780d	authority:commandid_d18fe531fbc57ee9	commandid_d18fe531fbc57ee9	allow	worldid_b09aed54932c8f51	timelineid_a944a1d612944976	commandid_2227c78359bd6f1a	{"effectiveActorId": "simulator-scenario", "causalRootActionId": "commandid_2227c78359bd6f1a"}	{"roles": [], "grants": [], "principalId": "principal-journal-parity", "privacyCeiling": {"version": 1, "allowedCategories": ["public_scene"]}}	\N	2026-10-19 23:52:18.941831-07
\.


--
-- Data for Name: command_receipts; Type: TABLE DATA; Schema: clockgrove; Owner: clockgrove_migrator
--

COPY clockgrove.command_receipts (tenant_id, command_id, request_hash, command_bytes, target_address, status, canonical_event_ids, result, created_at, committed_at, provenance, attribution, action_id, correlation_id, causation_id, expected, authority_decision_id, failed_at) FROM stdin;
tenantid_443adfa47140780d	trusted:world-provisioning:commandid_978eb8659995d56a	sha256:bf623e0187b6549e077569219818695f42f80b3ac94f1ad4b9941a61067e0e52	\\x5b22636c6f636b67726f76652d63616e6f6e6963616c2d7631222c5b227265636f7264222c5b5b226174747269627574696f6e222c5b227265636f7264222c5b5b2263617573616c526f6f74416374696f6e4964222c5b22737472696e67222c22636f6d6d616e6469645f39373865623836353939393564353661225d5d2c5b226566666563746976654163746f724964222c5b22737472696e67222c22776f726c642d70726f766973696f6e696e67225d5d5d5d5d2c5b22636f6d6d616e644964222c5b22737472696e67222c22747275737465643a776f726c642d70726f766973696f6e696e673a636f6d6d616e6469645f39373865623836353939393564353661225d5d2c5b22636f6e74657874222c5b227265636f7264222c5b5b22636f7272656c6174696f6e4964222c5b22737472696e67222c22636f6d6d616e6469645f39373865623836353939393564353661225d5d2c5b22726571756573744964222c5b22737472696e67222c22747275737465643a776f726c642d70726f766973696f6e696e673a636f6d6d616e6469645f39373865623836353939393564353661225d5d2c5b2276657273696f6e222c5b22696e7465676572222c2231225d5d5d5d5d2c5b226578706563746564222c5b227265636f7264222c5b5d5d5d2c5b226973737565644174222c5b22737472696e67222c22323032362d30312d30315430303a30303a30302e3030305a225d5d2c5b227061796c6f6164222c5b227265636f7264222c5b5b22636173654964222c5b22737472696e67222c22636173652d776f726c6469645f62303961656435343933326338663531225d5d2c5b22636f6e74656e7448617368222c5b22737472696e67222c2238313361336638343638353965353563643935626530666262333335396530653336323338663739346536323635663365663139613166616436353937393036225d5d2c5b2265787065637465645365656450726f6a656374696f6e48617368222c5b22737472696e67222c2234393932383632623734336565373436613561326231383363363432623633616237663535366136323664343638336563386431343266333163333637633939225d5d2c5b227061636b4964222c5b22737472696e67222c22636c6f636b67726f76652e746573742d776f726c64225d5d2c5b227061636b56657273696f6e222c5b22737472696e67222c22312e302e30225d5d2c5b22706172746974696f6e73222c5b226172726179222c5b5b227265636f7264222c5b5b22706172746974696f6e4964222c5b22737472696e67222c22706172746974696f6e69645f336163663539386165623861336438333a626561636f6e2e68616c6c225d5d2c5b2273706163654964222c5b22737472696e67222c22626561636f6e2e68616c6c225d5d2c5b2273747265616d4964222c5b22737472696e67222c22706172746974696f6e69645f336163663539386165623861336438333a626561636f6e2e68616c6c3a73747265616d225d5d5d5d5d5d5d2c5b2273656564436f6d6d616e6473222c5b22696e7465676572222c2230225d5d2c5b2274696d656c696e654964222c5b22737472696e67222c2274696d656c696e6569645f61393434613164363132393434393736225d5d2c5b22776f726c644964222c5b22737472696e67222c22776f726c6469645f62303961656435343933326338663531225d5d5d5d5d2c5b22736368656d6156657273696f6e222c5b22696e7465676572222c2232225d5d2c5b22746172676574222c5b227265636f7264222c5b5b226964222c5b22737472696e67222c22776f726c6469645f62303961656435343933326338663531225d5d2c5b226b696e64222c5b22737472696e67222c22776f726c64225d5d2c5b2274656e616e744964222c5b22737472696e67222c2274656e616e7469645f34343361646661343731343037383064225d5d2c5b2274696d656c696e654964222c5b22737472696e67222c2274696d656c696e6569645f61393434613164363132393434393736225d5d2c5b2276657273696f6e222c5b22696e7465676572222c2231225d5d2c5b22776f726c644964222c5b22737472696e67222c22776f726c6469645f62303961656435343933326338663531225d5d5d5d5d2c5b2274797065222c5b22737472696e67222c22437265617465576f726c6447656e65736973225d5d5d5d5d	{"id": "worldid_b09aed54932c8f51", "kind": "world", "version": 1, "worldId": "worldid_b09aed54932c8f51", "tenantId": "tenantid_443adfa47140780d", "timelineId": "timelineid_a944a1d612944976"}	committed	{trusted:world-provisioning:commandid_978eb8659995d56a:event}	{"value": {"commandId": "trusted:world-provisioning:commandid_978eb8659995d56a", "eventType": "WorldGenesisCreated"}, "events": [{"type": "WorldGenesisCreated", "eventId": "trusted:world-provisioning:commandid_978eb8659995d56a:event", "payload": {"caseId": "case-worldid_b09aed54932c8f51", "packId": "clockgrove.test-world", "worldId": "worldid_b09aed54932c8f51", "partitions": [{"spaceId": "beacon.hall", "streamId": "partitionid_3acf598aeb8a3d83:beacon.hall:stream", "partitionId": "partitionid_3acf598aeb8a3d83:beacon.hall"}], "timelineId": "timelineid_a944a1d612944976", "contentHash": "813a3f846859e55cd95be0fbb3359e0e36238f794e6265f3ef19a1fad6597906", "packVersion": "1.0.0", "seedCommands": 0, "expectedSeedProjectionHash": "4992862b743ee746a5a2b183c642b63ab7f556a626d4683ec8d142f31c367c99"}, "worldId": "worldid_b09aed54932c8f51", "streamId": "partitionid_3acf598aeb8a3d83:beacon.hall:stream", "tenantId": "tenantid_443adfa47140780d", "commandId": "trusted:world-provisioning:commandid_978eb8659995d56a", "recordedAt": "2026-10-20T06:52:18.777Z", "timelineId": "timelineid_a944a1d612944976", "attribution": {"effectiveActorId": "world-provisioning", "causalRootActionId": "commandid_978eb8659995d56a", "authorityDecisionId": "authority:trusted:world-provisioning:commandid_978eb8659995d56a"}, "partitionId": "partitionid_3acf598aeb8a3d83:beacon.hall", "payloadHash": "sha256:f9172d8b62831a3d8c9b43dd59c1868be82db09b29008f60044172da01d1f2c0", "privacyClass": "public_scene", "correlationId": "commandid_978eb8659995d56a", "schemaVersion": 2, "policyVersions": {}, "simulationTime": "100000", "streamSequence": "1", "journalPosition": "1", "partitionSequence": "1"}], "projectionDelta": null}	2026-10-19 23:52:18.792988-07	2026-10-19 23:52:18.792988-07	attributed	{"effectiveActorId": "world-provisioning", "causalRootActionId": "commandid_978eb8659995d56a"}	commandid_978eb8659995d56a	commandid_978eb8659995d56a	\N	{}	authority:trusted:world-provisioning:commandid_978eb8659995d56a	\N
tenantid_443adfa47140780d	trusted:world-provisioning:commandid_978eb8659995d56a:projection-verified	sha256:a8bcc5f0b10b78d99da4d2d967cd4e27cc1f254d68caabdf9ae0a592f6637936	\\x5b22636c6f636b67726f76652d63616e6f6e6963616c2d7631222c5b227265636f7264222c5b5b226174747269627574696f6e222c5b227265636f7264222c5b5b2263617573616c526f6f74416374696f6e4964222c5b22737472696e67222c22636f6d6d616e6469645f39373865623836353939393564353661225d5d2c5b226566666563746976654163746f724964222c5b22737472696e67222c22776f726c642d70726f766973696f6e696e67225d5d5d5d5d2c5b22636f6d6d616e644964222c5b22737472696e67222c22747275737465643a776f726c642d70726f766973696f6e696e673a636f6d6d616e6469645f393738656238363539393935643536613a70726f6a656374696f6e2d7665726966696564225d5d2c5b22636f6e74657874222c5b227265636f7264222c5b5b22636f7272656c6174696f6e4964222c5b22737472696e67222c22636f6d6d616e6469645f39373865623836353939393564353661225d5d2c5b22726571756573744964222c5b22737472696e67222c22747275737465643a776f726c642d70726f766973696f6e696e673a636f6d6d616e6469645f393738656238363539393935643536613a70726f6a656374696f6e2d7665726966696564225d5d2c5b2276657273696f6e222c5b22696e7465676572222c2231225d5d5d5d5d2c5b226578706563746564222c5b227265636f7264222c5b5d5d5d2c5b226973737565644174222c5b22737472696e67222c22323032362d30312d30315430303a30303a30302e3030305a225d5d2c5b227061796c6f6164222c5b227265636f7264222c5b5b2265787065637465645365656450726f6a656374696f6e48617368222c5b22737472696e67222c2234393932383632623734336565373436613561326231383363363432623633616237663535366136323664343638336563386431343266333163333637633939225d5d2c5b227265636f6e73747275637465645365656450726f6a656374696f6e48617368222c5b22737472696e67222c2234393932383632623734336565373436613561326231383363363432623633616237663535366136323664343638336563386431343266333163333637633939225d5d5d5d5d2c5b22736368656d6156657273696f6e222c5b22696e7465676572222c2232225d5d2c5b22746172676574222c5b227265636f7264222c5b5b226964222c5b22737472696e67222c22776f726c6469645f62303961656435343933326338663531225d5d2c5b226b696e64222c5b22737472696e67222c22776f726c64225d5d2c5b2274656e616e744964222c5b22737472696e67222c2274656e616e7469645f34343361646661343731343037383064225d5d2c5b2274696d656c696e654964222c5b22737472696e67222c2274696d656c696e6569645f61393434613164363132393434393736225d5d2c5b2276657273696f6e222c5b22696e7465676572222c2231225d5d2c5b22776f726c644964222c5b22737472696e67222c22776f726c6469645f62303961656435343933326338663531225d5d5d5d5d2c5b2274797065222c5b22737472696e67222c22566572696679576f726c6450726f6a656374696f6e225d5d5d5d5d	{"id": "worldid_b09aed54932c8f51", "kind": "world", "version": 1, "worldId": "worldid_b09aed54932c8f51", "tenantId": "tenantid_443adfa47140780d", "timelineId": "timelineid_a944a1d612944976"}	committed	{trusted:world-provisioning:commandid_978eb8659995d56a:projection-verified:event}	{"value": {"commandId": "trusted:world-provisioning:commandid_978eb8659995d56a:projection-verified", "eventType": "WorldProjectionVerified"}, "events": [{"type": "WorldProjectionVerified", "eventId": "trusted:world-provisioning:commandid_978eb8659995d56a:projection-verified:event", "payload": {"expectedSeedProjectionHash": "4992862b743ee746a5a2b183c642b63ab7f556a626d4683ec8d142f31c367c99", "reconstructedSeedProjectionHash": "4992862b743ee746a5a2b183c642b63ab7f556a626d4683ec8d142f31c367c99"}, "worldId": "worldid_b09aed54932c8f51", "streamId": "partitionid_3acf598aeb8a3d83:beacon.hall:stream", "tenantId": "tenantid_443adfa47140780d", "commandId": "trusted:world-provisioning:commandid_978eb8659995d56a:projection-verified", "recordedAt": "2026-10-20T06:52:18.809Z", "timelineId": "timelineid_a944a1d612944976", "attribution": {"effectiveActorId": "world-provisioning", "causalRootActionId": "commandid_978eb8659995d56a", "authorityDecisionId": "authority:trusted:world-provisioning:commandid_978eb8659995d56a:projection-verified"}, "partitionId": "partitionid_3acf598aeb8a3d83:beacon.hall", "payloadHash": "sha256:d133c58c0a8790d873423db00b9a7dbb25744c74f841c3702271c8c0e24d6639", "privacyClass": "public_scene", "correlationId": "commandid_978eb8659995d56a", "schemaVersion": 2, "policyVersions": {}, "simulationTime": "100000", "streamSequence": "2", "journalPosition": "2", "partitionSequence": "2"}], "projectionDelta": null}	2026-10-19 23:52:18.810375-07	2026-10-19 23:52:18.810375-07	attributed	{"effectiveActorId": "world-provisioning", "causalRootActionId": "commandid_978eb8659995d56a"}	commandid_978eb8659995d56a	commandid_978eb8659995d56a	\N	{}	authority:trusted:world-provisioning:commandid_978eb8659995d56a:projection-verified	\N
tenantid_443adfa47140780d	trusted:world-provisioning:commandid_978eb8659995d56a:world-ready	sha256:41505c78559b9f487d1284367a1fdaaf71842f8e021eb6f24e703dbb764bdf52	\\x5b22636c6f636b67726f76652d63616e6f6e6963616c2d7631222c5b227265636f7264222c5b5b226174747269627574696f6e222c5b227265636f7264222c5b5b2263617573616c526f6f74416374696f6e4964222c5b22737472696e67222c22636f6d6d616e6469645f39373865623836353939393564353661225d5d2c5b226566666563746976654163746f724964222c5b22737472696e67222c22776f726c642d70726f766973696f6e696e67225d5d5d5d5d2c5b22636f6d6d616e644964222c5b22737472696e67222c22747275737465643a776f726c642d70726f766973696f6e696e673a636f6d6d616e6469645f393738656238363539393935643536613a776f726c642d7265616479225d5d2c5b22636f6e74657874222c5b227265636f7264222c5b5b22636f7272656c6174696f6e4964222c5b22737472696e67222c22636f6d6d616e6469645f39373865623836353939393564353661225d5d2c5b22726571756573744964222c5b22737472696e67222c22747275737465643a776f726c642d70726f766973696f6e696e673a636f6d6d616e6469645f393738656238363539393935643536613a776f726c642d7265616479225d5d2c5b2276657273696f6e222c5b22696e7465676572222c2231225d5d5d5d5d2c5b226578706563746564222c5b227265636f7264222c5b5d5d5d2c5b226973737565644174222c5b22737472696e67222c22323032362d30312d30315430303a30303a30302e3030305a225d5d2c5b227061796c6f6164222c5b227265636f7264222c5b5b22696e7374616c6c6174696f6e4964222c5b22737472696e67222c22696e7374616c6c6174696f6e3a636173652d776f726c6469645f62303961656435343933326338663531225d5d2c5b227365656450726f6a656374696f6e48617368222c5b22737472696e67222c2234393932383632623734336565373436613561326231383363363432623633616237663535366136323664343638336563386431343266333163333637633939225d5d2c5b2274696d656c696e654964222c5b22737472696e67222c2274696d656c696e6569645f61393434613164363132393434393736225d5d2c5b22776f726c644964222c5b22737472696e67222c22776f726c6469645f62303961656435343933326338663531225d5d5d5d5d2c5b22736368656d6156657273696f6e222c5b22696e7465676572222c2232225d5d2c5b22746172676574222c5b227265636f7264222c5b5b226964222c5b22737472696e67222c22776f726c6469645f62303961656435343933326338663531225d5d2c5b226b696e64222c5b22737472696e67222c22776f726c64225d5d2c5b2274656e616e744964222c5b22737472696e67222c2274656e616e7469645f34343361646661343731343037383064225d5d2c5b2274696d656c696e654964222c5b22737472696e67222c2274696d656c696e6569645f61393434613164363132393434393736225d5d2c5b2276657273696f6e222c5b22696e7465676572222c2231225d5d2c5b22776f726c644964222c5b22737472696e67222c22776f726c6469645f62303961656435343933326338663531225d5d5d5d5d2c5b2274797065222c5b22737472696e67222c224d61726b576f726c645265616479225d5d5d5d5d	{"id": "worldid_b09aed54932c8f51", "kind": "world", "version": 1, "worldId": "worldid_b09aed54932c8f51", "tenantId": "tenantid_443adfa47140780d", "timelineId": "timelineid_a944a1d612944976"}	committed	{trusted:world-provisioning:commandid_978eb8659995d56a:world-ready:event}	{"value": {"commandId": "trusted:world-provisioning:commandid_978eb8659995d56a:world-ready", "eventType": "WorldReady"}, "events": [{"type": "WorldReady", "eventId": "trusted:world-provisioning:commandid_978eb8659995d56a:world-ready:event", "payload": {"worldId": "worldid_b09aed54932c8f51", "timelineId": "timelineid_a944a1d612944976", "installationId": "installation:case-worldid_b09aed54932c8f51", "seedProjectionHash": "4992862b743ee746a5a2b183c642b63ab7f556a626d4683ec8d142f31c367c99"}, "worldId": "worldid_b09aed54932c8f51", "streamId": "partitionid_3acf598aeb8a3d83:beacon.hall:stream", "tenantId": "tenantid_443adfa47140780d", "commandId": "trusted:world-provisioning:commandid_978eb8659995d56a:world-ready", "recordedAt": "2026-10-20T06:52:18.814Z", "timelineId": "timelineid_a944a1d612944976", "attribution": {"effectiveActorId": "world-provisioning", "causalRootActionId": "commandid_978eb8659995d56a", "authorityDecisionId": "authority:trusted:world-provisioning:commandid_978eb8659995d56a:world-ready"}, "partitionId": "partitionid_3acf598aeb8a3d83:beacon.hall", "payloadHash": "sha256:c168b692295e1f4fb8543137472304569ae355694d3424a74c187b17b09e8811", "privacyClass": "public_scene", "correlationId": "commandid_978eb8659995d56a", "schemaVersion": 2, "policyVersions": {}, "simulationTime": "100000", "streamSequence": "3", "journalPosition": "3", "partitionSequence": "3"}], "projectionDelta": null}	2026-10-19 23:52:18.816177-07	2026-10-19 23:52:18.816177-07	attributed	{"effectiveActorId": "world-provisioning", "causalRootActionId": "commandid_978eb8659995d56a"}	commandid_978eb8659995d56a	commandid_978eb8659995d56a	\N	{}	authority:trusted:world-provisioning:commandid_978eb8659995d56a:world-ready	\N
tenantid_443adfa47140780d	commandid_a0368bd6d2238e50	sha256:0a8e4dab021f1de38f696227ea08b6c0a15ad5972a554822a56880abe01aecce	\\x5b22636c6f636b67726f76652d63616e6f6e6963616c2d7631222c5b227265636f7264222c5b5b226174747269627574696f6e222c5b227265636f7264222c5b5b2263617573616c526f6f74416374696f6e4964222c5b22737472696e67222c22636f6d6d616e6469645f32323237633738333539626436663161225d5d2c5b226566666563746976654163746f724964222c5b22737472696e67222c2273696d756c61746f722d7363656e6172696f225d5d5d5d5d2c5b22636f6d6d616e644964222c5b22737472696e67222c22636f6d6d616e6469645f61303336386264366432323338653530225d5d2c5b22636f6e74657874222c5b227265636f7264222c5b5b22636f7272656c6174696f6e4964222c5b22737472696e67222c22636f6d6d616e6469645f32323237633738333539626436663161225d5d2c5b22726571756573744964222c5b22737472696e67222c22636f6d6d616e6469645f61303336386264366432323338653530225d5d2c5b2276657273696f6e222c5b22696e7465676572222c2231225d5d5d5d5d2c5b226578706563746564222c5b227265636f7264222c5b5b22706172746974696f6e5265766973696f6e222c5b22626967696e74222c2230225d5d5d5d5d2c5b226973737565644174222c5b22737472696e67222c22323032362d30312d30315430303a30303a30302e3030305a225d5d2c5b227061796c6f6164222c5b227265636f7264222c5b5b226d61784576656e7473222c5b22696e7465676572222c223332225d5d2c5b226d6178496e70757473222c5b22696e7465676572222c223332225d5d2c5b227261696e496e74656e73697479222c5b22696e7465676572222c2230225d5d2c5b22736368656d6156657273696f6e222c5b22696e7465676572222c2231225d5d2c5b2274617267657454696d65222c5b22626967696e74222c22313030303030225d5d5d5d5d2c5b22736368656d6156657273696f6e222c5b22696e7465676572222c2231225d5d2c5b22746172676574222c5b227265636f7264222c5b5b226964222c5b22737472696e67222c22776f726c6469645f62303961656435343933326338663531225d5d2c5b226b696e64222c5b22737472696e67222c22776f726c64225d5d2c5b2274656e616e744964222c5b22737472696e67222c2274656e616e7469645f34343361646661343731343037383064225d5d2c5b2274696d656c696e654964222c5b22737472696e67222c2274696d656c696e6569645f61393434613164363132393434393736225d5d2c5b2276657273696f6e222c5b22696e7465676572222c2231225d5d2c5b22776f726c644964222c5b22737472696e67222c22776f726c6469645f62303961656435343933326338663531225d5d5d5d5d2c5b2274797065222c5b22737472696e67222c22776f726c642e776561746865722e736574225d5d5d5d5d	{"id": "worldid_b09aed54932c8f51", "kind": "world", "version": 1, "worldId": "worldid_b09aed54932c8f51", "tenantId": "tenantid_443adfa47140780d", "timelineId": "timelineid_a944a1d612944976"}	committed	{commandid_a0368bd6d2238e50:event:0,commandid_a0368bd6d2238e50:event:1,commandid_a0368bd6d2238e50:event:2}	{"value": {"status": "committed", "complete": true, "revision": "3", "stateHash": "f7785af40c09ce4b2e16eff92ad97bf49ea7e6391ef3b2da70422a2b5e896463", "eventCount": 3, "simulationTime": "100000"}, "events": [{"type": "needs.changed", "eventId": "commandid_a0368bd6d2238e50:event:0", "payload": {"kernelEvent": ["record", [["attribution", ["record", [["authorityDecisionId", ["string", "authority:commandid_a0368bd6d2238e50"]], ["causalRootActionId", ["string", "commandid_2227c78359bd6f1a"]], ["effectiveActorId", ["string", "simulator-scenario"]]]]], ["commandId", ["string", "commandid_a0368bd6d2238e50"]], ["eventId", ["string", "eventid_511cb7d8a641d3b2"]], ["eventIndex", ["integer", "0"]], ["partitionId", ["string", "partitionid_3acf598aeb8a3d83"]], ["payload", ["record", [["hunger", ["integer", "3166"]], ["hungerRemainder", ["bigint", "40000"]], ["integratedAt", ["bigint", "100000"]], ["objectId", ["string", "beacon.master"]], ["wetness", ["integer", "0"]], ["wetnessRemainder", ["bigint", "0"]]]]], ["policyVersions", ["record", [["routine", ["string", "beacon-1"]]]]], ["schemaVersion", ["integer", "1"]], ["simulationTime", ["bigint", "100000"]], ["tenantId", ["string", "tenantid_443adfa47140780d"]], ["timelineId", ["string", "timelineid_a944a1d612944976"]], ["type", ["string", "needs.changed"]], ["worldId", ["string", "worldid_b09aed54932c8f51"]]]]}, "worldId": "worldid_b09aed54932c8f51", "streamId": "partitionid_3acf598aeb8a3d83:beacon.hall:stream", "tenantId": "tenantid_443adfa47140780d", "commandId": "commandid_a0368bd6d2238e50", "recordedAt": "2026-10-20T06:52:18.908Z", "timelineId": "timelineid_a944a1d612944976", "attribution": {"effectiveActorId": "simulator-scenario", "causalRootActionId": "commandid_2227c78359bd6f1a", "authorityDecisionId": "authority:commandid_a0368bd6d2238e50"}, "partitionId": "partitionid_3acf598aeb8a3d83:beacon.hall", "payloadHash": "sha256:cfc3efa222b2241118403ffc60e57dfb2327419e9957636d0d3f7cea97d10e16", "privacyClass": "public_scene", "correlationId": "commandid_2227c78359bd6f1a", "schemaVersion": 2, "policyVersions": {"routine": "beacon-1"}, "simulationTime": "100000", "streamSequence": "4", "journalPosition": "4", "partitionSequence": "4"}, {"type": "wellbeing.integrated", "eventId": "commandid_a0368bd6d2238e50:event:1", "payload": {"kernelEvent": ["record", [["attribution", ["record", [["authorityDecisionId", ["string", "authority:commandid_a0368bd6d2238e50"]], ["causalRootActionId", ["string", "commandid_2227c78359bd6f1a"]], ["effectiveActorId", ["string", "simulator-scenario"]]]]], ["commandId", ["string", "commandid_a0368bd6d2238e50"]], ["eventId", ["string", "eventid_0dbdc013e2ebc543"]], ["eventIndex", ["integer", "1"]], ["partitionId", ["string", "partitionid_3acf598aeb8a3d83"]], ["payload", ["record", [["health", ["integer", "10000"]], ["healthRemainder", ["bigint", "0"]], ["integratedAt", ["bigint", "100000"]], ["objectId", ["string", "beacon.master"]], ["thirst", ["integer", "83"]], ["thirstRemainder", ["bigint", "20000"]]]]], ["policyVersions", ["record", [["routine", ["string", "beacon-1"]]]]], ["schemaVersion", ["integer", "1"]], ["simulationTime", ["bigint", "100000"]], ["tenantId", ["string", "tenantid_443adfa47140780d"]], ["timelineId", ["string", "timelineid_a944a1d612944976"]], ["type", ["string", "wellbeing.integrated"]], ["worldId", ["string", "worldid_b09aed54932c8f51"]]]]}, "worldId": "worldid_b09aed54932c8f51", "streamId": "partitionid_3acf598aeb8a3d83:beacon.hall:stream", "tenantId": "tenantid_443adfa47140780d", "commandId": "commandid_a0368bd6d2238e50", "recordedAt": "2026-10-20T06:52:18.908Z", "timelineId": "timelineid_a944a1d612944976", "attribution": {"effectiveActorId": "simulator-scenario", "causalRootActionId": "commandid_2227c78359bd6f1a", "authorityDecisionId": "authority:commandid_a0368bd6d2238e50"}, "partitionId": "partitionid_3acf598aeb8a3d83:beacon.hall", "payloadHash": "sha256:bfb6e6aa4cc85937107bcbbb992404635a0b8aeb14e13b2ece4498e940ef2b78", "privacyClass": "public_scene", "correlationId": "commandid_2227c78359bd6f1a", "schemaVersion": 2, "policyVersions": {"routine": "beacon-1"}, "simulationTime": "100000", "streamSequence": "5", "journalPosition": "5", "partitionSequence": "5"}, {"type": "weather.changed", "eventId": "commandid_a0368bd6d2238e50:event:2", "payload": {"kernelEvent": ["record", [["attribution", ["record", [["authorityDecisionId", ["string", "authority:commandid_a0368bd6d2238e50"]], ["causalRootActionId", ["string", "commandid_2227c78359bd6f1a"]], ["effectiveActorId", ["string", "simulator-scenario"]]]]], ["commandId", ["string", "commandid_a0368bd6d2238e50"]], ["eventId", ["string", "eventid_027add91b9792bf4"]], ["eventIndex", ["integer", "2"]], ["partitionId", ["string", "partitionid_3acf598aeb8a3d83"]], ["payload", ["record", [["rainIntensity", ["integer", "0"]]]]], ["policyVersions", ["record", [["routine", ["string", "beacon-1"]]]]], ["schemaVersion", ["integer", "1"]], ["simulationTime", ["bigint", "100000"]], ["tenantId", ["string", "tenantid_443adfa47140780d"]], ["timelineId", ["string", "timelineid_a944a1d612944976"]], ["type", ["string", "weather.changed"]], ["worldId", ["string", "worldid_b09aed54932c8f51"]]]]}, "worldId": "worldid_b09aed54932c8f51", "streamId": "partitionid_3acf598aeb8a3d83:beacon.hall:stream", "tenantId": "tenantid_443adfa47140780d", "commandId": "commandid_a0368bd6d2238e50", "recordedAt": "2026-10-20T06:52:18.908Z", "timelineId": "timelineid_a944a1d612944976", "attribution": {"effectiveActorId": "simulator-scenario", "causalRootActionId": "commandid_2227c78359bd6f1a", "authorityDecisionId": "authority:commandid_a0368bd6d2238e50"}, "partitionId": "partitionid_3acf598aeb8a3d83:beacon.hall", "payloadHash": "sha256:da5fe4fc46576db201d3333bb72c138fa886fee730146a774efd356d729c94b7", "privacyClass": "public_scene", "correlationId": "commandid_2227c78359bd6f1a", "schemaVersion": 2, "policyVersions": {"routine": "beacon-1"}, "simulationTime": "100000", "streamSequence": "6", "journalPosition": "6", "partitionSequence": "6"}], "projectionDelta": {"toRevision": "3", "fromRevision": "0"}}	2026-10-19 23:52:18.909355-07	2026-10-19 23:52:18.923261-07	attributed	{"effectiveActorId": "simulator-scenario", "causalRootActionId": "commandid_2227c78359bd6f1a"}	commandid_2227c78359bd6f1a	commandid_2227c78359bd6f1a	\N	{"partitionRevision": "0"}	authority:commandid_a0368bd6d2238e50	\N
tenantid_443adfa47140780d	commandid_d18fe531fbc57ee9	sha256:b7b32e6b3eeb6297c4180c8c77f3c9ba3e65c65a6c6fe7a8b323e13e06396f19	\\x5b22636c6f636b67726f76652d63616e6f6e6963616c2d7631222c5b227265636f7264222c5b5b226174747269627574696f6e222c5b227265636f7264222c5b5b2263617573616c526f6f74416374696f6e4964222c5b22737472696e67222c22636f6d6d616e6469645f32323237633738333539626436663161225d5d2c5b226566666563746976654163746f724964222c5b22737472696e67222c2273696d756c61746f722d7363656e6172696f225d5d5d5d5d2c5b22636f6d6d616e644964222c5b22737472696e67222c22636f6d6d616e6469645f64313866653533316662633537656539225d5d2c5b22636f6e74657874222c5b227265636f7264222c5b5b22636f7272656c6174696f6e4964222c5b22737472696e67222c22636f6d6d616e6469645f32323237633738333539626436663161225d5d2c5b22726571756573744964222c5b22737472696e67222c22636f6d6d616e6469645f64313866653533316662633537656539225d5d2c5b2276657273696f6e222c5b22696e7465676572222c2231225d5d5d5d5d2c5b226578706563746564222c5b227265636f7264222c5b5b22706172746974696f6e5265766973696f6e222c5b22626967696e74222c2233225d5d5d5d5d2c5b226973737565644174222c5b22737472696e67222c22323032362d30312d30315430303a30303a30302e3030305a225d5d2c5b227061796c6f6164222c5b227265636f7264222c5b5b226d61784576656e7473222c5b22696e7465676572222c2234303936225d5d2c5b226d6178496e70757473222c5b22696e7465676572222c2231303234225d5d2c5b22736368656d6156657273696f6e222c5b22696e7465676572222c2231225d5d2c5b2274617267657454696d65222c5b22626967696e74222c22313730303030225d5d5d5d5d2c5b22736368656d6156657273696f6e222c5b22696e7465676572222c2231225d5d2c5b22746172676574222c5b227265636f7264222c5b5b226964222c5b22737472696e67222c22776f726c6469645f62303961656435343933326338663531225d5d2c5b226b696e64222c5b22737472696e67222c22776f726c64225d5d2c5b2274656e616e744964222c5b22737472696e67222c2274656e616e7469645f34343361646661343731343037383064225d5d2c5b2274696d656c696e654964222c5b22737472696e67222c2274696d656c696e6569645f61393434613164363132393434393736225d5d2c5b2276657273696f6e222c5b22696e7465676572222c2231225d5d2c5b22776f726c644964222c5b22737472696e67222c22776f726c6469645f62303961656435343933326338663531225d5d5d5d5d2c5b2274797065222c5b22737472696e67222c22776f726c642e616476616e6365225d5d5d5d5d	{"id": "worldid_b09aed54932c8f51", "kind": "world", "version": 1, "worldId": "worldid_b09aed54932c8f51", "tenantId": "tenantid_443adfa47140780d", "timelineId": "timelineid_a944a1d612944976"}	committed	{commandid_d18fe531fbc57ee9:event:0,commandid_d18fe531fbc57ee9:event:1,commandid_d18fe531fbc57ee9:event:2,commandid_d18fe531fbc57ee9:event:3,commandid_d18fe531fbc57ee9:event:4,commandid_d18fe531fbc57ee9:event:5,commandid_d18fe531fbc57ee9:event:6,commandid_d18fe531fbc57ee9:event:7,commandid_d18fe531fbc57ee9:event:8,commandid_d18fe531fbc57ee9:event:9,commandid_d18fe531fbc57ee9:event:10,commandid_d18fe531fbc57ee9:event:11,commandid_d18fe531fbc57ee9:event:12,commandid_d18fe531fbc57ee9:event:13,commandid_d18fe531fbc57ee9:event:14,commandid_d18fe531fbc57ee9:event:15,commandid_d18fe531fbc57ee9:event:16,commandid_d18fe531fbc57ee9:event:17,commandid_d18fe531fbc57ee9:event:18,commandid_d18fe531fbc57ee9:event:19}	{"value": {"status": "committed", "complete": true, "revision": "23", "stateHash": "4d2c9bd4b68aeee489dfae5380353e0f458826a4b76e5ed14e37eee64d344399", "eventCount": 20, "simulationTime": "170000"}, "events": [{"type": "routine.selected", "eventId": "commandid_d18fe531fbc57ee9:event:0", "payload": {"kernelEvent": ["record", [["attribution", ["record", [["authorityDecisionId", ["string", "authority:commandid_d18fe531fbc57ee9"]], ["causalRootActionId", ["string", "commandid_2227c78359bd6f1a"]], ["effectiveActorId", ["string", "simulator-scenario"]]]]], ["commandId", ["string", "commandid_d18fe531fbc57ee9"]], ["eventId", ["string", "eventid_04b7c4e818aeb01b"]], ["eventIndex", ["integer", "3"]], ["partitionId", ["string", "partitionid_3acf598aeb8a3d83"]], ["payload", ["record", [["action", ["record", [["kind", ["string", "seek-food"]], ["targetObjectId", ["string", "beacon.larder"]]]]], ["objectId", ["string", "beacon.master"]]]]], ["policyVersions", ["record", [["routine", ["string", "beacon-1"]]]]], ["schemaVersion", ["integer", "2"]], ["simulationTime", ["bigint", "100000"]], ["tenantId", ["string", "tenantid_443adfa47140780d"]], ["timelineId", ["string", "timelineid_a944a1d612944976"]], ["type", ["string", "routine.selected"]], ["worldId", ["string", "worldid_b09aed54932c8f51"]]]]}, "worldId": "worldid_b09aed54932c8f51", "streamId": "partitionid_3acf598aeb8a3d83:beacon.hall:stream", "tenantId": "tenantid_443adfa47140780d", "commandId": "commandid_d18fe531fbc57ee9", "recordedAt": "2026-10-20T06:52:18.940Z", "timelineId": "timelineid_a944a1d612944976", "attribution": {"effectiveActorId": "simulator-scenario", "causalRootActionId": "commandid_2227c78359bd6f1a", "authorityDecisionId": "authority:commandid_d18fe531fbc57ee9"}, "partitionId": "partitionid_3acf598aeb8a3d83:beacon.hall", "payloadHash": "sha256:3ce56a6c4b855f631303f0569fbf954bf957874655404bd1e11e39fdc6286ca0", "privacyClass": "public_scene", "correlationId": "commandid_2227c78359bd6f1a", "schemaVersion": 2, "policyVersions": {"routine": "beacon-1"}, "simulationTime": "100000", "streamSequence": "7", "journalPosition": "7", "partitionSequence": "7"}, {"type": "movement.started", "eventId": "commandid_d18fe531fbc57ee9:event:1", "payload": {"kernelEvent": ["record", [["attribution", ["record", [["authorityDecisionId", ["string", "authority:commandid_d18fe531fbc57ee9"]], ["causalRootActionId", ["string", "commandid_2227c78359bd6f1a"]], ["effectiveActorId", ["string", "simulator-scenario"]]]]], ["commandId", ["string", "commandid_d18fe531fbc57ee9"]], ["eventId", ["string", "eventid_dbcd34c931538b68"]], ["eventIndex", ["integer", "4"]], ["partitionId", ["string", "partitionid_3acf598aeb8a3d83"]], ["payload", ["record", [["movement", ["record", [["anchorPath", ["array", []]], ["destination", ["record", [["kind", ["string", "pose"]], ["pose", ["record", [["coordinates", ["array", [["bigint", "100"], ["bigint", "100"]]]], ["frameId", ["string", "frame-hall"]], ["frameVersion", ["integer", "1"]]]]]]]], ["emitted", ["array", []]], ["exitedAtStart", ["array", []]], ["frameId", ["string", "frame-hall"]], ["frameVersion", ["integer", "1"]], ["initialInside", ["array", [["string", "hall"]]]], ["movementId", ["string", "movement-commandid_c6999b77a9a5d639"]], ["segment", ["record", [["speed", ["record", [["kind", ["string", "constant-units-per-second"]], ["unitsPerSecond", ["bigint", "1000"]]]]], ["startTime", ["bigint", "100000"]], ["waypoints", ["array", [["array", [["bigint", "10"], ["bigint", "20"]]], ["array", [["bigint", "100"], ["bigint", "100"]]]]]]]]], ["status", ["string", "active"]]]]], ["objectId", ["string", "beacon.master"]]]]], ["policyVersions", ["record", [["routine", ["string", "beacon-1"]]]]], ["schemaVersion", ["integer", "1"]], ["simulationTime", ["bigint", "100000"]], ["tenantId", ["string", "tenantid_443adfa47140780d"]], ["timelineId", ["string", "timelineid_a944a1d612944976"]], ["type", ["string", "movement.started"]], ["worldId", ["string", "worldid_b09aed54932c8f51"]]]]}, "worldId": "worldid_b09aed54932c8f51", "streamId": "partitionid_3acf598aeb8a3d83:beacon.hall:stream", "tenantId": "tenantid_443adfa47140780d", "commandId": "commandid_d18fe531fbc57ee9", "recordedAt": "2026-10-20T06:52:18.940Z", "timelineId": "timelineid_a944a1d612944976", "attribution": {"effectiveActorId": "simulator-scenario", "causalRootActionId": "commandid_2227c78359bd6f1a", "authorityDecisionId": "authority:commandid_d18fe531fbc57ee9"}, "partitionId": "partitionid_3acf598aeb8a3d83:beacon.hall", "payloadHash": "sha256:a45eee835834a075c59751da41273081255a58abf88efaa5dd511626637cf48b", "privacyClass": "public_scene", "correlationId": "commandid_2227c78359bd6f1a", "schemaVersion": 2, "policyVersions": {"routine": "beacon-1"}, "simulationTime": "100000", "streamSequence": "8", "journalPosition": "8", "partitionSequence": "8"}, {"type": "movement.region-exited", "eventId": "commandid_d18fe531fbc57ee9:event:2", "payload": {"kernelEvent": ["record", [["attribution", ["record", [["authorityDecisionId", ["string", "authority:commandid_d18fe531fbc57ee9"]], ["causalRootActionId", ["string", "commandid_2227c78359bd6f1a"]], ["effectiveActorId", ["string", "simulator-scenario"]]]]], ["commandId", ["string", "commandid_d18fe531fbc57ee9"]], ["eventId", ["string", "eventid_dc6680c61df45a59"]], ["eventIndex", ["integer", "5"]], ["partitionId", ["string", "partitionid_3acf598aeb8a3d83"]], ["payload", ["record", [["movementId", ["string", "movement-commandid_c6999b77a9a5d639"]], ["objectId", ["string", "beacon.master"]], ["regionId", ["string", "hall"]], ["regionVersion", ["integer", "1"]]]]], ["policyVersions", ["record", [["routine", ["string", "beacon-1"]]]]], ["schemaVersion", ["integer", "1"]], ["simulationTime", ["bigint", "100120"]], ["tenantId", ["string", "tenantid_443adfa47140780d"]], ["timelineId", ["string", "timelineid_a944a1d612944976"]], ["type", ["string", "movement.region-exited"]], ["worldId", ["string", "worldid_b09aed54932c8f51"]]]]}, "worldId": "worldid_b09aed54932c8f51", "streamId": "partitionid_3acf598aeb8a3d83:beacon.hall:stream", "tenantId": "tenantid_443adfa47140780d", "commandId": "commandid_d18fe531fbc57ee9", "recordedAt": "2026-10-20T06:52:18.940Z", "timelineId": "timelineid_a944a1d612944976", "attribution": {"effectiveActorId": "simulator-scenario", "causalRootActionId": "commandid_2227c78359bd6f1a", "authorityDecisionId": "authority:commandid_d18fe531fbc57ee9"}, "partitionId": "partitionid_3acf598aeb8a3d83:beacon.hall", "payloadHash": "sha256:1705a4962c986043c56c7826a2e5d8092087d89104438266b6c2115f3713157b", "privacyClass": "public_scene", "correlationId": "commandid_2227c78359bd6f1a", "schemaVersion": 2, "policyVersions": {"routine": "beacon-1"}, "simulationTime": "100120", "streamSequence": "9", "journalPosition": "9", "partitionSequence": "9"}, {"type": "needs.changed", "eventId": "commandid_d18fe531fbc57ee9:event:3", "payload": {"kernelEvent": ["record", [["attribution", ["record", [["authorityDecisionId", ["string", "authority:commandid_d18fe531fbc57ee9"]], ["causalRootActionId", ["string", "commandid_2227c78359bd6f1a"]], ["effectiveActorId", ["string", "simulator-scenario"]]]]], ["commandId", ["string", "commandid_d18fe531fbc57ee9"]], ["eventId", ["string", "eventid_f831064646c398e6"]], ["eventIndex", ["integer", "6"]], ["partitionId", ["string", "partitionid_3acf598aeb8a3d83"]], ["payload", ["record", [["hunger", ["integer", "3166"]], ["hungerRemainder", ["bigint", "52000"]], ["integratedAt", ["bigint", "100120"]], ["objectId", ["string", "beacon.master"]], ["wetness", ["integer", "0"]], ["wetnessRemainder", ["bigint", "0"]]]]], ["policyVersions", ["record", [["routine", ["string", "beacon-1"]]]]], ["schemaVersion", ["integer", "1"]], ["simulationTime", ["bigint", "100120"]], ["tenantId", ["string", "tenantid_443adfa47140780d"]], ["timelineId", ["string", "timelineid_a944a1d612944976"]], ["type", ["string", "needs.changed"]], ["worldId", ["string", "worldid_b09aed54932c8f51"]]]]}, "worldId": "worldid_b09aed54932c8f51", "streamId": "partitionid_3acf598aeb8a3d83:beacon.hall:stream", "tenantId": "tenantid_443adfa47140780d", "commandId": "commandid_d18fe531fbc57ee9", "recordedAt": "2026-10-20T06:52:18.940Z", "timelineId": "timelineid_a944a1d612944976", "attribution": {"effectiveActorId": "simulator-scenario", "causalRootActionId": "commandid_2227c78359bd6f1a", "authorityDecisionId": "authority:commandid_d18fe531fbc57ee9"}, "partitionId": "partitionid_3acf598aeb8a3d83:beacon.hall", "payloadHash": "sha256:415337a997606b612e0345f141525e7343a8a62b20a133bc32e045688f9f5679", "privacyClass": "public_scene", "correlationId": "commandid_2227c78359bd6f1a", "schemaVersion": 2, "policyVersions": {"routine": "beacon-1"}, "simulationTime": "100120", "streamSequence": "10", "journalPosition": "10", "partitionSequence": "10"}, {"type": "wellbeing.integrated", "eventId": "commandid_d18fe531fbc57ee9:event:4", "payload": {"kernelEvent": ["record", [["attribution", ["record", [["authorityDecisionId", ["string", "authority:commandid_d18fe531fbc57ee9"]], ["causalRootActionId", ["string", "commandid_2227c78359bd6f1a"]], ["effectiveActorId", ["string", "simulator-scenario"]]]]], ["commandId", ["string", "commandid_d18fe531fbc57ee9"]], ["eventId", ["string", "eventid_0dc216e9111c1d77"]], ["eventIndex", ["integer", "7"]], ["partitionId", ["string", "partitionid_3acf598aeb8a3d83"]], ["payload", ["record", [["health", ["integer", "10000"]], ["healthRemainder", ["bigint", "0"]], ["integratedAt", ["bigint", "100120"]], ["objectId", ["string", "beacon.master"]], ["thirst", ["integer", "83"]], ["thirstRemainder", ["bigint", "26000"]]]]], ["policyVersions", ["record", [["routine", ["string", "beacon-1"]]]]], ["schemaVersion", ["integer", "1"]], ["simulationTime", ["bigint", "100120"]], ["tenantId", ["string", "tenantid_443adfa47140780d"]], ["timelineId", ["string", "timelineid_a944a1d612944976"]], ["type", ["string", "wellbeing.integrated"]], ["worldId", ["string", "worldid_b09aed54932c8f51"]]]]}, "worldId": "worldid_b09aed54932c8f51", "streamId": "partitionid_3acf598aeb8a3d83:beacon.hall:stream", "tenantId": "tenantid_443adfa47140780d", "commandId": "commandid_d18fe531fbc57ee9", "recordedAt": "2026-10-20T06:52:18.940Z", "timelineId": "timelineid_a944a1d612944976", "attribution": {"effectiveActorId": "simulator-scenario", "causalRootActionId": "commandid_2227c78359bd6f1a", "authorityDecisionId": "authority:commandid_d18fe531fbc57ee9"}, "partitionId": "partitionid_3acf598aeb8a3d83:beacon.hall", "payloadHash": "sha256:d7b15f5a0f0c7b0b2292d986c70b96fa9d9953c9a8bc2779b6432e085c8b3d59", "privacyClass": "public_scene", "correlationId": "commandid_2227c78359bd6f1a", "schemaVersion": 2, "policyVersions": {"routine": "beacon-1"}, "simulationTime": "100120", "streamSequence": "11", "journalPosition": "11", "partitionSequence": "11"}, {"type": "movement.completed", "eventId": "commandid_d18fe531fbc57ee9:event:5", "payload": {"kernelEvent": ["record", [["attribution", ["record", [["authorityDecisionId", ["string", "authority:commandid_d18fe531fbc57ee9"]], ["causalRootActionId", ["string", "commandid_2227c78359bd6f1a"]], ["effectiveActorId", ["string", "simulator-scenario"]]]]], ["commandId", ["string", "commandid_d18fe531fbc57ee9"]], ["eventId", ["string", "eventid_7fc316483db4a824"]], ["eventIndex", ["integer", "8"]], ["partitionId", ["string", "partitionid_3acf598aeb8a3d83"]], ["payload", ["record", [["movementId", ["string", "movement-commandid_c6999b77a9a5d639"]], ["objectId", ["string", "beacon.master"]]]]], ["policyVersions", ["record", [["routine", ["string", "beacon-1"]]]]], ["schemaVersion", ["integer", "1"]], ["simulationTime", ["bigint", "100120"]], ["tenantId", ["string", "tenantid_443adfa47140780d"]], ["timelineId", ["string", "timelineid_a944a1d612944976"]], ["type", ["string", "movement.completed"]], ["worldId", ["string", "worldid_b09aed54932c8f51"]]]]}, "worldId": "worldid_b09aed54932c8f51", "streamId": "partitionid_3acf598aeb8a3d83:beacon.hall:stream", "tenantId": "tenantid_443adfa47140780d", "commandId": "commandid_d18fe531fbc57ee9", "recordedAt": "2026-10-20T06:52:18.940Z", "timelineId": "timelineid_a944a1d612944976", "attribution": {"effectiveActorId": "simulator-scenario", "causalRootActionId": "commandid_2227c78359bd6f1a", "authorityDecisionId": "authority:commandid_d18fe531fbc57ee9"}, "partitionId": "partitionid_3acf598aeb8a3d83:beacon.hall", "payloadHash": "sha256:ab602807edc412e0c125a094f5b31efbafe087897ba0a28bedfd955559bcd443", "privacyClass": "public_scene", "correlationId": "commandid_2227c78359bd6f1a", "schemaVersion": 2, "policyVersions": {"routine": "beacon-1"}, "simulationTime": "100120", "streamSequence": "12", "journalPosition": "12", "partitionSequence": "12"}, {"type": "resource.consumed", "eventId": "commandid_d18fe531fbc57ee9:event:6", "payload": {"kernelEvent": ["record", [["attribution", ["record", [["authorityDecisionId", ["string", "authority:commandid_d18fe531fbc57ee9"]], ["causalRootActionId", ["string", "commandid_2227c78359bd6f1a"]], ["effectiveActorId", ["string", "simulator-scenario"]]]]], ["commandId", ["string", "commandid_d18fe531fbc57ee9"]], ["eventId", ["string", "eventid_424f1b154fe0e215"]], ["eventIndex", ["integer", "9"]], ["partitionId", ["string", "partitionid_3acf598aeb8a3d83"]], ["payload", ["record", [["kind", ["string", "food"]], ["objectId", ["string", "beacon.larder"]], ["quantity", ["integer", "1"]]]]], ["policyVersions", ["record", [["routine", ["string", "beacon-1"]]]]], ["schemaVersion", ["integer", "1"]], ["simulationTime", ["bigint", "100120"]], ["tenantId", ["string", "tenantid_443adfa47140780d"]], ["timelineId", ["string", "timelineid_a944a1d612944976"]], ["type", ["string", "resource.consumed"]], ["worldId", ["string", "worldid_b09aed54932c8f51"]]]]}, "worldId": "worldid_b09aed54932c8f51", "streamId": "partitionid_3acf598aeb8a3d83:beacon.hall:stream", "tenantId": "tenantid_443adfa47140780d", "commandId": "commandid_d18fe531fbc57ee9", "recordedAt": "2026-10-20T06:52:18.940Z", "timelineId": "timelineid_a944a1d612944976", "attribution": {"effectiveActorId": "simulator-scenario", "causalRootActionId": "commandid_2227c78359bd6f1a", "authorityDecisionId": "authority:commandid_d18fe531fbc57ee9"}, "partitionId": "partitionid_3acf598aeb8a3d83:beacon.hall", "payloadHash": "sha256:56ab74394c5406354a444591b66c6357a77aaf4f6362c2abdd842d6fcd2b30e0", "privacyClass": "public_scene", "correlationId": "commandid_2227c78359bd6f1a", "schemaVersion": 2, "policyVersions": {"routine": "beacon-1"}, "simulationTime": "100120", "streamSequence": "13", "journalPosition": "13", "partitionSequence": "13"}, {"type": "needs.relieved", "eventId": "commandid_d18fe531fbc57ee9:event:7", "payload": {"kernelEvent": ["record", [["attribution", ["record", [["authorityDecisionId", ["string", "authority:commandid_d18fe531fbc57ee9"]], ["causalRootActionId", ["string", "commandid_2227c78359bd6f1a"]], ["effectiveActorId", ["string", "simulator-scenario"]]]]], ["commandId", ["string", "commandid_d18fe531fbc57ee9"]], ["eventId", ["string", "eventid_a918c24aa924f28d"]], ["eventIndex", ["integer", "10"]], ["partitionId", ["string", "partitionid_3acf598aeb8a3d83"]], ["payload", ["record", [["need", ["string", "hunger"]], ["objectId", ["string", "beacon.master"]], ["planId", ["string", "plan:beacon.master@100000"]], ["quantity", ["integer", "1"]], ["sourceObjectId", ["string", "beacon.larder"]], ["value", ["integer", "2166"]]]]], ["policyVersions", ["record", [["routine", ["string", "beacon-1"]]]]], ["schemaVersion", ["integer", "1"]], ["simulationTime", ["bigint", "100120"]], ["tenantId", ["string", "tenantid_443adfa47140780d"]], ["timelineId", ["string", "timelineid_a944a1d612944976"]], ["type", ["string", "needs.relieved"]], ["worldId", ["string", "worldid_b09aed54932c8f51"]]]]}, "worldId": "worldid_b09aed54932c8f51", "streamId": "partitionid_3acf598aeb8a3d83:beacon.hall:stream", "tenantId": "tenantid_443adfa47140780d", "commandId": "commandid_d18fe531fbc57ee9", "recordedAt": "2026-10-20T06:52:18.940Z", "timelineId": "timelineid_a944a1d612944976", "attribution": {"effectiveActorId": "simulator-scenario", "causalRootActionId": "commandid_2227c78359bd6f1a", "authorityDecisionId": "authority:commandid_d18fe531fbc57ee9"}, "partitionId": "partitionid_3acf598aeb8a3d83:beacon.hall", "payloadHash": "sha256:e96b00b530cbdd3e9ee9ea49280ee1eea4ce42e841db0288edc953c4f1b77115", "privacyClass": "public_scene", "correlationId": "commandid_2227c78359bd6f1a", "schemaVersion": 2, "policyVersions": {"routine": "beacon-1"}, "simulationTime": "100120", "streamSequence": "14", "journalPosition": "14", "partitionSequence": "14"}, {"type": "needs.changed", "eventId": "commandid_d18fe531fbc57ee9:event:8", "payload": {"kernelEvent": ["record", [["attribution", ["record", [["authorityDecisionId", ["string", "authority:commandid_d18fe531fbc57ee9"]], ["causalRootActionId", ["string", "commandid_2227c78359bd6f1a"]], ["effectiveActorId", ["string", "simulator-scenario"]]]]], ["commandId", ["string", "commandid_d18fe531fbc57ee9"]], ["eventId", ["string", "eventid_79fb7dedb624f25c"]], ["eventIndex", ["integer", "11"]], ["partitionId", ["string", "partitionid_3acf598aeb8a3d83"]], ["payload", ["record", [["hunger", ["integer", "2266"]], ["hungerRemainder", ["bigint", "40000"]], ["integratedAt", ["bigint", "160000"]], ["objectId", ["string", "beacon.master"]], ["wetness", ["integer", "0"]], ["wetnessRemainder", ["bigint", "0"]]]]], ["policyVersions", ["record", [["routine", ["string", "beacon-1"]]]]], ["schemaVersion", ["integer", "1"]], ["simulationTime", ["bigint", "160000"]], ["tenantId", ["string", "tenantid_443adfa47140780d"]], ["timelineId", ["string", "timelineid_a944a1d612944976"]], ["type", ["string", "needs.changed"]], ["worldId", ["string", "worldid_b09aed54932c8f51"]]]]}, "worldId": "worldid_b09aed54932c8f51", "streamId": "partitionid_3acf598aeb8a3d83:beacon.hall:stream", "tenantId": "tenantid_443adfa47140780d", "commandId": "commandid_d18fe531fbc57ee9", "recordedAt": "2026-10-20T06:52:18.940Z", "timelineId": "timelineid_a944a1d612944976", "attribution": {"effectiveActorId": "simulator-scenario", "causalRootActionId": "commandid_2227c78359bd6f1a", "authorityDecisionId": "authority:commandid_d18fe531fbc57ee9"}, "partitionId": "partitionid_3acf598aeb8a3d83:beacon.hall", "payloadHash": "sha256:bbf0ab8b313c16ac60a465f1297f7e95e56177f488d0e963788b54c7fff32639", "privacyClass": "public_scene", "correlationId": "commandid_2227c78359bd6f1a", "schemaVersion": 2, "policyVersions": {"routine": "beacon-1"}, "simulationTime": "160000", "streamSequence": "15", "journalPosition": "15", "partitionSequence": "15"}, {"type": "wellbeing.integrated", "eventId": "commandid_d18fe531fbc57ee9:event:9", "payload": {"kernelEvent": ["record", [["attribution", ["record", [["authorityDecisionId", ["string", "authority:commandid_d18fe531fbc57ee9"]], ["causalRootActionId", ["string", "commandid_2227c78359bd6f1a"]], ["effectiveActorId", ["string", "simulator-scenario"]]]]], ["commandId", ["string", "commandid_d18fe531fbc57ee9"]], ["eventId", ["string", "eventid_dfeced2c24c04f8b"]], ["eventIndex", ["integer", "12"]], ["partitionId", ["string", "partitionid_3acf598aeb8a3d83"]], ["payload", ["record", [["health", ["integer", "10000"]], ["healthRemainder", ["bigint", "0"]], ["integratedAt", ["bigint", "160000"]], ["objectId", ["string", "beacon.master"]], ["thirst", ["integer", "133"]], ["thirstRemainder", ["bigint", "20000"]]]]], ["policyVersions", ["record", [["routine", ["string", "beacon-1"]]]]], ["schemaVersion", ["integer", "1"]], ["simulationTime", ["bigint", "160000"]], ["tenantId", ["string", "tenantid_443adfa47140780d"]], ["timelineId", ["string", "timelineid_a944a1d612944976"]], ["type", ["string", "wellbeing.integrated"]], ["worldId", ["string", "worldid_b09aed54932c8f51"]]]]}, "worldId": "worldid_b09aed54932c8f51", "streamId": "partitionid_3acf598aeb8a3d83:beacon.hall:stream", "tenantId": "tenantid_443adfa47140780d", "commandId": "commandid_d18fe531fbc57ee9", "recordedAt": "2026-10-20T06:52:18.940Z", "timelineId": "timelineid_a944a1d612944976", "attribution": {"effectiveActorId": "simulator-scenario", "causalRootActionId": "commandid_2227c78359bd6f1a", "authorityDecisionId": "authority:commandid_d18fe531fbc57ee9"}, "partitionId": "partitionid_3acf598aeb8a3d83:beacon.hall", "payloadHash": "sha256:58aada8d0fde9248bd230bcd7313e36ed2257c0d7a989b1c6f3af1c5e65f1c1e", "privacyClass": "public_scene", "correlationId": "commandid_2227c78359bd6f1a", "schemaVersion": 2, "policyVersions": {"routine": "beacon-1"}, "simulationTime": "160000", "streamSequence": "16", "journalPosition": "16", "partitionSequence": "16"}, {"type": "routine.selected", "eventId": "commandid_d18fe531fbc57ee9:event:10", "payload": {"kernelEvent": ["record", [["attribution", ["record", [["authorityDecisionId", ["string", "authority:commandid_d18fe531fbc57ee9"]], ["causalRootActionId", ["string", "commandid_2227c78359bd6f1a"]], ["effectiveActorId", ["string", "simulator-scenario"]]]]], ["commandId", ["string", "commandid_d18fe531fbc57ee9"]], ["eventId", ["string", "eventid_7743ed3e2cde7f3a"]], ["eventIndex", ["integer", "13"]], ["partitionId", ["string", "partitionid_3acf598aeb8a3d83"]], ["payload", ["record", [["action", ["record", [["kind", ["string", "seek-water"]], ["targetObjectId", ["string", "beacon.cistern"]]]]], ["objectId", ["string", "beacon.master"]]]]], ["policyVersions", ["record", [["routine", ["string", "beacon-1"]]]]], ["schemaVersion", ["integer", "2"]], ["simulationTime", ["bigint", "160000"]], ["tenantId", ["string", "tenantid_443adfa47140780d"]], ["timelineId", ["string", "timelineid_a944a1d612944976"]], ["type", ["string", "routine.selected"]], ["worldId", ["string", "worldid_b09aed54932c8f51"]]]]}, "worldId": "worldid_b09aed54932c8f51", "streamId": "partitionid_3acf598aeb8a3d83:beacon.hall:stream", "tenantId": "tenantid_443adfa47140780d", "commandId": "commandid_d18fe531fbc57ee9", "recordedAt": "2026-10-20T06:52:18.940Z", "timelineId": "timelineid_a944a1d612944976", "attribution": {"effectiveActorId": "simulator-scenario", "causalRootActionId": "commandid_2227c78359bd6f1a", "authorityDecisionId": "authority:commandid_d18fe531fbc57ee9"}, "partitionId": "partitionid_3acf598aeb8a3d83:beacon.hall", "payloadHash": "sha256:eb8de0abfb09e77f9295efc42cc4e054fe38cc37c4389e49a7748f2dfebd2431", "privacyClass": "public_scene", "correlationId": "commandid_2227c78359bd6f1a", "schemaVersion": 2, "policyVersions": {"routine": "beacon-1"}, "simulationTime": "160000", "streamSequence": "17", "journalPosition": "17", "partitionSequence": "17"}, {"type": "movement.started", "eventId": "commandid_d18fe531fbc57ee9:event:11", "payload": {"kernelEvent": ["record", [["attribution", ["record", [["authorityDecisionId", ["string", "authority:commandid_d18fe531fbc57ee9"]], ["causalRootActionId", ["string", "commandid_2227c78359bd6f1a"]], ["effectiveActorId", ["string", "simulator-scenario"]]]]], ["commandId", ["string", "commandid_d18fe531fbc57ee9"]], ["eventId", ["string", "eventid_110267ab19b9c409"]], ["eventIndex", ["integer", "14"]], ["partitionId", ["string", "partitionid_3acf598aeb8a3d83"]], ["payload", ["record", [["movement", ["record", [["anchorPath", ["array", []]], ["destination", ["record", [["kind", ["string", "pose"]], ["pose", ["record", [["coordinates", ["array", [["bigint", "200"], ["bigint", "100"]]]], ["frameId", ["string", "frame-hall"]], ["frameVersion", ["integer", "1"]]]]]]]], ["emitted", ["array", []]], ["exitedAtStart", ["array", []]], ["frameId", ["string", "frame-hall"]], ["frameVersion", ["integer", "1"]], ["initialInside", ["array", [["string", "hall"]]]], ["movementId", ["string", "movement-commandid_7035f536044905d7"]], ["segment", ["record", [["speed", ["record", [["kind", ["string", "constant-units-per-second"]], ["unitsPerSecond", ["bigint", "1000"]]]]], ["startTime", ["bigint", "160000"]], ["waypoints", ["array", [["array", [["bigint", "100"], ["bigint", "100"]]], ["array", [["bigint", "200"], ["bigint", "100"]]]]]]]]], ["status", ["string", "active"]]]]], ["objectId", ["string", "beacon.master"]]]]], ["policyVersions", ["record", [["routine", ["string", "beacon-1"]]]]], ["schemaVersion", ["integer", "1"]], ["simulationTime", ["bigint", "160000"]], ["tenantId", ["string", "tenantid_443adfa47140780d"]], ["timelineId", ["string", "timelineid_a944a1d612944976"]], ["type", ["string", "movement.started"]], ["worldId", ["string", "worldid_b09aed54932c8f51"]]]]}, "worldId": "worldid_b09aed54932c8f51", "streamId": "partitionid_3acf598aeb8a3d83:beacon.hall:stream", "tenantId": "tenantid_443adfa47140780d", "commandId": "commandid_d18fe531fbc57ee9", "recordedAt": "2026-10-20T06:52:18.940Z", "timelineId": "timelineid_a944a1d612944976", "attribution": {"effectiveActorId": "simulator-scenario", "causalRootActionId": "commandid_2227c78359bd6f1a", "authorityDecisionId": "authority:commandid_d18fe531fbc57ee9"}, "partitionId": "partitionid_3acf598aeb8a3d83:beacon.hall", "payloadHash": "sha256:81c48051b92d9dab17583c269423e63060af016414d3dd57da8ba7eb22be258e", "privacyClass": "public_scene", "correlationId": "commandid_2227c78359bd6f1a", "schemaVersion": 2, "policyVersions": {"routine": "beacon-1"}, "simulationTime": "160000", "streamSequence": "18", "journalPosition": "18", "partitionSequence": "18"}, {"type": "movement.region-exited", "eventId": "commandid_d18fe531fbc57ee9:event:12", "payload": {"kernelEvent": ["record", [["attribution", ["record", [["authorityDecisionId", ["string", "authority:commandid_d18fe531fbc57ee9"]], ["causalRootActionId", ["string", "commandid_2227c78359bd6f1a"]], ["effectiveActorId", ["string", "simulator-scenario"]]]]], ["commandId", ["string", "commandid_d18fe531fbc57ee9"]], ["eventId", ["string", "eventid_570cb4a41e07ce58"]], ["eventIndex", ["integer", "15"]], ["partitionId", ["string", "partitionid_3acf598aeb8a3d83"]], ["payload", ["record", [["movementId", ["string", "movement-commandid_7035f536044905d7"]], ["objectId", ["string", "beacon.master"]], ["regionId", ["string", "hall"]], ["regionVersion", ["integer", "1"]]]]], ["policyVersions", ["record", [["routine", ["string", "beacon-1"]]]]], ["schemaVersion", ["integer", "1"]], ["simulationTime", ["bigint", "160100"]], ["tenantId", ["string", "tenantid_443adfa47140780d"]], ["timelineId", ["string", "timelineid_a944a1d612944976"]], ["type", ["string", "movement.region-exited"]], ["worldId", ["string", "worldid_b09aed54932c8f51"]]]]}, "worldId": "worldid_b09aed54932c8f51", "streamId": "partitionid_3acf598aeb8a3d83:beacon.hall:stream", "tenantId": "tenantid_443adfa47140780d", "commandId": "commandid_d18fe531fbc57ee9", "recordedAt": "2026-10-20T06:52:18.940Z", "timelineId": "timelineid_a944a1d612944976", "attribution": {"effectiveActorId": "simulator-scenario", "causalRootActionId": "commandid_2227c78359bd6f1a", "authorityDecisionId": "authority:commandid_d18fe531fbc57ee9"}, "partitionId": "partitionid_3acf598aeb8a3d83:beacon.hall", "payloadHash": "sha256:b50c91ce7c1fafeb22954e14e24fbb144333060e2a961f8f2b274d31192d76fa", "privacyClass": "public_scene", "correlationId": "commandid_2227c78359bd6f1a", "schemaVersion": 2, "policyVersions": {"routine": "beacon-1"}, "simulationTime": "160100", "streamSequence": "19", "journalPosition": "19", "partitionSequence": "19"}, {"type": "needs.changed", "eventId": "commandid_d18fe531fbc57ee9:event:13", "payload": {"kernelEvent": ["record", [["attribution", ["record", [["authorityDecisionId", ["string", "authority:commandid_d18fe531fbc57ee9"]], ["causalRootActionId", ["string", "commandid_2227c78359bd6f1a"]], ["effectiveActorId", ["string", "simulator-scenario"]]]]], ["commandId", ["string", "commandid_d18fe531fbc57ee9"]], ["eventId", ["string", "eventid_0a3afbd52cd79a27"]], ["eventIndex", ["integer", "16"]], ["partitionId", ["string", "partitionid_3acf598aeb8a3d83"]], ["payload", ["record", [["hunger", ["integer", "2266"]], ["hungerRemainder", ["bigint", "50000"]], ["integratedAt", ["bigint", "160100"]], ["objectId", ["string", "beacon.master"]], ["wetness", ["integer", "0"]], ["wetnessRemainder", ["bigint", "0"]]]]], ["policyVersions", ["record", [["routine", ["string", "beacon-1"]]]]], ["schemaVersion", ["integer", "1"]], ["simulationTime", ["bigint", "160100"]], ["tenantId", ["string", "tenantid_443adfa47140780d"]], ["timelineId", ["string", "timelineid_a944a1d612944976"]], ["type", ["string", "needs.changed"]], ["worldId", ["string", "worldid_b09aed54932c8f51"]]]]}, "worldId": "worldid_b09aed54932c8f51", "streamId": "partitionid_3acf598aeb8a3d83:beacon.hall:stream", "tenantId": "tenantid_443adfa47140780d", "commandId": "commandid_d18fe531fbc57ee9", "recordedAt": "2026-10-20T06:52:18.940Z", "timelineId": "timelineid_a944a1d612944976", "attribution": {"effectiveActorId": "simulator-scenario", "causalRootActionId": "commandid_2227c78359bd6f1a", "authorityDecisionId": "authority:commandid_d18fe531fbc57ee9"}, "partitionId": "partitionid_3acf598aeb8a3d83:beacon.hall", "payloadHash": "sha256:8c5a1ddfbefad57734946488833f6d2aa7aad0a0b2490d27958dec0ac9de0fcc", "privacyClass": "public_scene", "correlationId": "commandid_2227c78359bd6f1a", "schemaVersion": 2, "policyVersions": {"routine": "beacon-1"}, "simulationTime": "160100", "streamSequence": "20", "journalPosition": "20", "partitionSequence": "20"}, {"type": "wellbeing.integrated", "eventId": "commandid_d18fe531fbc57ee9:event:14", "payload": {"kernelEvent": ["record", [["attribution", ["record", [["authorityDecisionId", ["string", "authority:commandid_d18fe531fbc57ee9"]], ["causalRootActionId", ["string", "commandid_2227c78359bd6f1a"]], ["effectiveActorId", ["string", "simulator-scenario"]]]]], ["commandId", ["string", "commandid_d18fe531fbc57ee9"]], ["eventId", ["string", "eventid_33e6d9a46589fe16"]], ["eventIndex", ["integer", "17"]], ["partitionId", ["string", "partitionid_3acf598aeb8a3d83"]], ["payload", ["record", [["health", ["integer", "10000"]], ["healthRemainder", ["bigint", "0"]], ["integratedAt", ["bigint", "160100"]], ["objectId", ["string", "beacon.master"]], ["thirst", ["integer", "133"]], ["thirstRemainder", ["bigint", "25000"]]]]], ["policyVersions", ["record", [["routine", ["string", "beacon-1"]]]]], ["schemaVersion", ["integer", "1"]], ["simulationTime", ["bigint", "160100"]], ["tenantId", ["string", "tenantid_443adfa47140780d"]], ["timelineId", ["string", "timelineid_a944a1d612944976"]], ["type", ["string", "wellbeing.integrated"]], ["worldId", ["string", "worldid_b09aed54932c8f51"]]]]}, "worldId": "worldid_b09aed54932c8f51", "streamId": "partitionid_3acf598aeb8a3d83:beacon.hall:stream", "tenantId": "tenantid_443adfa47140780d", "commandId": "commandid_d18fe531fbc57ee9", "recordedAt": "2026-10-20T06:52:18.940Z", "timelineId": "timelineid_a944a1d612944976", "attribution": {"effectiveActorId": "simulator-scenario", "causalRootActionId": "commandid_2227c78359bd6f1a", "authorityDecisionId": "authority:commandid_d18fe531fbc57ee9"}, "partitionId": "partitionid_3acf598aeb8a3d83:beacon.hall", "payloadHash": "sha256:8d99f0bd19d05176072928fa53134bb7e8ae18b55d8779670beca465c3538d32", "privacyClass": "public_scene", "correlationId": "commandid_2227c78359bd6f1a", "schemaVersion": 2, "policyVersions": {"routine": "beacon-1"}, "simulationTime": "160100", "streamSequence": "21", "journalPosition": "21", "partitionSequence": "21"}, {"type": "movement.completed", "eventId": "commandid_d18fe531fbc57ee9:event:15", "payload": {"kernelEvent": ["record", [["attribution", ["record", [["authorityDecisionId", ["string", "authority:commandid_d18fe531fbc57ee9"]], ["causalRootActionId", ["string", "commandid_2227c78359bd6f1a"]], ["effectiveActorId", ["string", "simulator-scenario"]]]]], ["commandId", ["string", "commandid_d18fe531fbc57ee9"]], ["eventId", ["string", "eventid_4f426abec464d445"]], ["eventIndex", ["integer", "18"]], ["partitionId", ["string", "partitionid_3acf598aeb8a3d83"]], ["payload", ["record", [["movementId", ["string", "movement-commandid_7035f536044905d7"]], ["objectId", ["string", "beacon.master"]]]]], ["policyVersions", ["record", [["routine", ["string", "beacon-1"]]]]], ["schemaVersion", ["integer", "1"]], ["simulationTime", ["bigint", "160100"]], ["tenantId", ["string", "tenantid_443adfa47140780d"]], ["timelineId", ["string", "timelineid_a944a1d612944976"]], ["type", ["string", "movement.completed"]], ["worldId", ["string", "worldid_b09aed54932c8f51"]]]]}, "worldId": "worldid_b09aed54932c8f51", "streamId": "partitionid_3acf598aeb8a3d83:beacon.hall:stream", "tenantId": "tenantid_443adfa47140780d", "commandId": "commandid_d18fe531fbc57ee9", "recordedAt": "2026-10-20T06:52:18.940Z", "timelineId": "timelineid_a944a1d612944976", "attribution": {"effectiveActorId": "simulator-scenario", "causalRootActionId": "commandid_2227c78359bd6f1a", "authorityDecisionId": "authority:commandid_d18fe531fbc57ee9"}, "partitionId": "partitionid_3acf598aeb8a3d83:beacon.hall", "payloadHash": "sha256:99ccb90941fb4a6a8bfca74f6a78aee258e64884f00839abfa61f788ec15d2ab", "privacyClass": "public_scene", "correlationId": "commandid_2227c78359bd6f1a", "schemaVersion": 2, "policyVersions": {"routine": "beacon-1"}, "simulationTime": "160100", "streamSequence": "22", "journalPosition": "22", "partitionSequence": "22"}, {"type": "resource.consumed", "eventId": "commandid_d18fe531fbc57ee9:event:16", "payload": {"kernelEvent": ["record", [["attribution", ["record", [["authorityDecisionId", ["string", "authority:commandid_d18fe531fbc57ee9"]], ["causalRootActionId", ["string", "commandid_2227c78359bd6f1a"]], ["effectiveActorId", ["string", "simulator-scenario"]]]]], ["commandId", ["string", "commandid_d18fe531fbc57ee9"]], ["eventId", ["string", "eventid_586af5dad476f414"]], ["eventIndex", ["integer", "19"]], ["partitionId", ["string", "partitionid_3acf598aeb8a3d83"]], ["payload", ["record", [["kind", ["string", "water"]], ["objectId", ["string", "beacon.cistern"]], ["quantity", ["integer", "1"]]]]], ["policyVersions", ["record", [["routine", ["string", "beacon-1"]]]]], ["schemaVersion", ["integer", "1"]], ["simulationTime", ["bigint", "160100"]], ["tenantId", ["string", "tenantid_443adfa47140780d"]], ["timelineId", ["string", "timelineid_a944a1d612944976"]], ["type", ["string", "resource.consumed"]], ["worldId", ["string", "worldid_b09aed54932c8f51"]]]]}, "worldId": "worldid_b09aed54932c8f51", "streamId": "partitionid_3acf598aeb8a3d83:beacon.hall:stream", "tenantId": "tenantid_443adfa47140780d", "commandId": "commandid_d18fe531fbc57ee9", "recordedAt": "2026-10-20T06:52:18.940Z", "timelineId": "timelineid_a944a1d612944976", "attribution": {"effectiveActorId": "simulator-scenario", "causalRootActionId": "commandid_2227c78359bd6f1a", "authorityDecisionId": "authority:commandid_d18fe531fbc57ee9"}, "partitionId": "partitionid_3acf598aeb8a3d83:beacon.hall", "payloadHash": "sha256:d57f9bf32a95bb35ef27d241fa751c21107606d5f2bfbbe015ee738915e210e8", "privacyClass": "public_scene", "correlationId": "commandid_2227c78359bd6f1a", "schemaVersion": 2, "policyVersions": {"routine": "beacon-1"}, "simulationTime": "160100", "streamSequence": "23", "journalPosition": "23", "partitionSequence": "23"}, {"type": "needs.relieved", "eventId": "commandid_d18fe531fbc57ee9:event:17", "payload": {"kernelEvent": ["record", [["attribution", ["record", [["authorityDecisionId", ["string", "authority:commandid_d18fe531fbc57ee9"]], ["causalRootActionId", ["string", "commandid_2227c78359bd6f1a"]], ["effectiveActorId", ["string", "simulator-scenario"]]]]], ["commandId", ["string", "commandid_d18fe531fbc57ee9"]], ["eventId", ["string", "eventid_e4c4e5e893f35bc4"]], ["eventIndex", ["integer", "20"]], ["partitionId", ["string", "partitionid_3acf598aeb8a3d83"]], ["payload", ["record", [["need", ["string", "thirst"]], ["objectId", ["string", "beacon.master"]], ["planId", ["string", "plan:beacon.master@160000"]], ["quantity", ["integer", "1"]], ["sourceObjectId", ["string", "beacon.cistern"]], ["value", ["integer", "0"]]]]], ["policyVersions", ["record", [["routine", ["string", "beacon-1"]]]]], ["schemaVersion", ["integer", "1"]], ["simulationTime", ["bigint", "160100"]], ["tenantId", ["string", "tenantid_443adfa47140780d"]], ["timelineId", ["string", "timelineid_a944a1d612944976"]], ["type", ["string", "needs.relieved"]], ["worldId", ["string", "worldid_b09aed54932c8f51"]]]]}, "worldId": "worldid_b09aed54932c8f51", "streamId": "partitionid_3acf598aeb8a3d83:beacon.hall:stream", "tenantId": "tenantid_443adfa47140780d", "commandId": "commandid_d18fe531fbc57ee9", "recordedAt": "2026-10-20T06:52:18.940Z", "timelineId": "timelineid_a944a1d612944976", "attribution": {"effectiveActorId": "simulator-scenario", "causalRootActionId": "commandid_2227c78359bd6f1a", "authorityDecisionId": "authority:commandid_d18fe531fbc57ee9"}, "partitionId": "partitionid_3acf598aeb8a3d83:beacon.hall", "payloadHash": "sha256:b32a04ad11c1528348cf90c85d04bbd8fc73c9937dbca00760846da189d89000", "privacyClass": "public_scene", "correlationId": "commandid_2227c78359bd6f1a", "schemaVersion": 2, "policyVersions": {"routine": "beacon-1"}, "simulationTime": "160100", "streamSequence": "24", "journalPosition": "24", "partitionSequence": "24"}, {"type": "needs.changed", "eventId": "commandid_d18fe531fbc57ee9:event:18", "payload": {"kernelEvent": ["record", [["attribution", ["record", [["authorityDecisionId", ["string", "authority:commandid_d18fe531fbc57ee9"]], ["causalRootActionId", ["string", "commandid_2227c78359bd6f1a"]], ["effectiveActorId", ["string", "simulator-scenario"]]]]], ["commandId", ["string", "commandid_d18fe531fbc57ee9"]], ["eventId", ["string", "eventid_2b7f37dca71aa0b5"]], ["eventIndex", ["integer", "21"]], ["partitionId", ["string", "partitionid_3acf598aeb8a3d83"]], ["payload", ["record", [["hunger", ["integer", "2283"]], ["hungerRemainder", ["bigint", "20000"]], ["integratedAt", ["bigint", "170000"]], ["objectId", ["string", "beacon.master"]], ["wetness", ["integer", "0"]], ["wetnessRemainder", ["bigint", "0"]]]]], ["policyVersions", ["record", [["routine", ["string", "beacon-1"]]]]], ["schemaVersion", ["integer", "1"]], ["simulationTime", ["bigint", "170000"]], ["tenantId", ["string", "tenantid_443adfa47140780d"]], ["timelineId", ["string", "timelineid_a944a1d612944976"]], ["type", ["string", "needs.changed"]], ["worldId", ["string", "worldid_b09aed54932c8f51"]]]]}, "worldId": "worldid_b09aed54932c8f51", "streamId": "partitionid_3acf598aeb8a3d83:beacon.hall:stream", "tenantId": "tenantid_443adfa47140780d", "commandId": "commandid_d18fe531fbc57ee9", "recordedAt": "2026-10-20T06:52:18.940Z", "timelineId": "timelineid_a944a1d612944976", "attribution": {"effectiveActorId": "simulator-scenario", "causalRootActionId": "commandid_2227c78359bd6f1a", "authorityDecisionId": "authority:commandid_d18fe531fbc57ee9"}, "partitionId": "partitionid_3acf598aeb8a3d83:beacon.hall", "payloadHash": "sha256:8d950ec7954b3b731c5f27925ad300d3127796506eb44984517a3b2008aefe4f", "privacyClass": "public_scene", "correlationId": "commandid_2227c78359bd6f1a", "schemaVersion": 2, "policyVersions": {"routine": "beacon-1"}, "simulationTime": "170000", "streamSequence": "25", "journalPosition": "25", "partitionSequence": "25"}, {"type": "wellbeing.integrated", "eventId": "commandid_d18fe531fbc57ee9:event:19", "payload": {"kernelEvent": ["record", [["attribution", ["record", [["authorityDecisionId", ["string", "authority:commandid_d18fe531fbc57ee9"]], ["causalRootActionId", ["string", "commandid_2227c78359bd6f1a"]], ["effectiveActorId", ["string", "simulator-scenario"]]]]], ["commandId", ["string", "commandid_d18fe531fbc57ee9"]], ["eventId", ["string", "eventid_ab402b8404cba442"]], ["eventIndex", ["integer", "22"]], ["partitionId", ["string", "partitionid_3acf598aeb8a3d83"]], ["payload", ["record", [["health", ["integer", "10000"]], ["healthRemainder", ["bigint", "0"]], ["integratedAt", ["bigint", "170000"]], ["objectId", ["string", "beacon.master"]], ["thirst", ["integer", "8"]], ["thirstRemainder", ["bigint", "40000"]]]]], ["policyVersions", ["record", [["routine", ["string", "beacon-1"]]]]], ["schemaVersion", ["integer", "1"]], ["simulationTime", ["bigint", "170000"]], ["tenantId", ["string", "tenantid_443adfa47140780d"]], ["timelineId", ["string", "timelineid_a944a1d612944976"]], ["type", ["string", "wellbeing.integrated"]], ["worldId", ["string", "worldid_b09aed54932c8f51"]]]]}, "worldId": "worldid_b09aed54932c8f51", "streamId": "partitionid_3acf598aeb8a3d83:beacon.hall:stream", "tenantId": "tenantid_443adfa47140780d", "commandId": "commandid_d18fe531fbc57ee9", "recordedAt": "2026-10-20T06:52:18.940Z", "timelineId": "timelineid_a944a1d612944976", "attribution": {"effectiveActorId": "simulator-scenario", "causalRootActionId": "commandid_2227c78359bd6f1a", "authorityDecisionId": "authority:commandid_d18fe531fbc57ee9"}, "partitionId": "partitionid_3acf598aeb8a3d83:beacon.hall", "payloadHash": "sha256:2f2825ab9b72319f535e6be7860e92c1a4dcd23131d9d5381c30cec843edb547", "privacyClass": "public_scene", "correlationId": "commandid_2227c78359bd6f1a", "schemaVersion": 2, "policyVersions": {"routine": "beacon-1"}, "simulationTime": "170000", "streamSequence": "26", "journalPosition": "26", "partitionSequence": "26"}], "projectionDelta": {"toRevision": "23", "fromRevision": "3"}}	2026-10-19 23:52:18.941831-07	2026-10-19 23:52:18.973883-07	attributed	{"effectiveActorId": "simulator-scenario", "causalRootActionId": "commandid_2227c78359bd6f1a"}	commandid_2227c78359bd6f1a	commandid_2227c78359bd6f1a	\N	{"partitionRevision": "3"}	authority:commandid_d18fe531fbc57ee9	\N
\.


--
-- Data for Name: event_dispatches; Type: TABLE DATA; Schema: clockgrove; Owner: clockgrove_migrator
--

COPY clockgrove.event_dispatches (tenant_id, world_id, timeline_id, partition_id, space_id, dispatch_id, event_id, channel, status, attempts, next_attempt_at, privacy_class, payload, lease_owner, last_error_class, settled_at, created_at) FROM stdin;
tenantid_443adfa47140780d	worldid_b09aed54932c8f51	timelineid_a944a1d612944976	partitionid_3acf598aeb8a3d83:beacon.hall	beacon.hall	commandid_a0368bd6d2238e50:dispatch:world-reactions	commandid_a0368bd6d2238e50:event:0	world-reactions	pending	0	2026-10-19 23:52:18.923261-07	public_scene	{"eventId": "commandid_a0368bd6d2238e50:event:0", "eventCount": 3}	\N	\N	\N	2026-10-19 23:52:18.923261-07
tenantid_443adfa47140780d	worldid_b09aed54932c8f51	timelineid_a944a1d612944976	partitionid_3acf598aeb8a3d83:beacon.hall	beacon.hall	commandid_d18fe531fbc57ee9:dispatch:world-reactions	commandid_d18fe531fbc57ee9:event:0	world-reactions	pending	0	2026-10-19 23:52:18.973883-07	public_scene	{"eventId": "commandid_d18fe531fbc57ee9:event:0", "eventCount": 20}	\N	\N	\N	2026-10-19 23:52:18.973883-07
\.


--
-- Data for Name: events; Type: TABLE DATA; Schema: clockgrove; Owner: clockgrove_migrator
--

COPY clockgrove.events (event_id, tenant_id, world_id, timeline_id, partition_id, space_id, stream_id, stream_sequence, partition_sequence, journal_position, event_type, schema_version, simulation_time, recorded_at, command_id, correlation_id, causation_id, principal_id, actor_id, object_id, privacy_class, payload_hash, attribution, actor_address, policy_versions, payload, event_bytes) FROM stdin;
trusted:world-provisioning:commandid_978eb8659995d56a:event	tenantid_443adfa47140780d	worldid_b09aed54932c8f51	timelineid_a944a1d612944976	partitionid_3acf598aeb8a3d83:beacon.hall	beacon.hall	partitionid_3acf598aeb8a3d83:beacon.hall:stream	1	1	1	WorldGenesisCreated	2	100000	2026-10-19 23:52:18.777-07	trusted:world-provisioning:commandid_978eb8659995d56a	commandid_978eb8659995d56a	\N	\N	\N	\N	public_scene	sha256:f9172d8b62831a3d8c9b43dd59c1868be82db09b29008f60044172da01d1f2c0	{"effectiveActorId": "world-provisioning", "causalRootActionId": "commandid_978eb8659995d56a", "authorityDecisionId": "authority:trusted:world-provisioning:commandid_978eb8659995d56a"}	\N	{}	{"caseId": "case-worldid_b09aed54932c8f51", "packId": "clockgrove.test-world", "worldId": "worldid_b09aed54932c8f51", "partitions": [{"spaceId": "beacon.hall", "streamId": "partitionid_3acf598aeb8a3d83:beacon.hall:stream", "partitionId": "partitionid_3acf598aeb8a3d83:beacon.hall"}], "timelineId": "timelineid_a944a1d612944976", "contentHash": "813a3f846859e55cd95be0fbb3359e0e36238f794e6265f3ef19a1fad6597906", "packVersion": "1.0.0", "seedCommands": 0, "expectedSeedProjectionHash": "4992862b743ee746a5a2b183c642b63ab7f556a626d4683ec8d142f31c367c99"}	\\x7b2274797065223a2022576f726c6447656e6573697343726561746564222c20226576656e744964223a2022747275737465643a776f726c642d70726f766973696f6e696e673a636f6d6d616e6469645f393738656238363539393935643536613a6576656e74222c20227061796c6f6164223a207b22636173654964223a2022636173652d776f726c6469645f62303961656435343933326338663531222c20227061636b4964223a2022636c6f636b67726f76652e746573742d776f726c64222c2022776f726c644964223a2022776f726c6469645f62303961656435343933326338663531222c2022706172746974696f6e73223a205b7b2273706163654964223a2022626561636f6e2e68616c6c222c202273747265616d4964223a2022706172746974696f6e69645f336163663539386165623861336438333a626561636f6e2e68616c6c3a73747265616d222c2022706172746974696f6e4964223a2022706172746974696f6e69645f336163663539386165623861336438333a626561636f6e2e68616c6c227d5d2c202274696d656c696e654964223a202274696d656c696e6569645f61393434613164363132393434393736222c2022636f6e74656e7448617368223a202238313361336638343638353965353563643935626530666262333335396530653336323338663739346536323635663365663139613166616436353937393036222c20227061636b56657273696f6e223a2022312e302e30222c202273656564436f6d6d616e6473223a20302c202265787065637465645365656450726f6a656374696f6e48617368223a202234393932383632623734336565373436613561326231383363363432623633616237663535366136323664343638336563386431343266333163333637633939227d2c2022776f726c644964223a2022776f726c6469645f62303961656435343933326338663531222c202273747265616d4964223a2022706172746974696f6e69645f336163663539386165623861336438333a626561636f6e2e68616c6c3a73747265616d222c202274656e616e744964223a202274656e616e7469645f34343361646661343731343037383064222c2022636f6d6d616e644964223a2022747275737465643a776f726c642d70726f766973696f6e696e673a636f6d6d616e6469645f39373865623836353939393564353661222c20227265636f726465644174223a2022323032362d31302d32305430363a35323a31382e3737375a222c202274696d656c696e654964223a202274696d656c696e6569645f61393434613164363132393434393736222c20226174747269627574696f6e223a207b226566666563746976654163746f724964223a2022776f726c642d70726f766973696f6e696e67222c202263617573616c526f6f74416374696f6e4964223a2022636f6d6d616e6469645f39373865623836353939393564353661222c2022617574686f726974794465636973696f6e4964223a2022617574686f726974793a747275737465643a776f726c642d70726f766973696f6e696e673a636f6d6d616e6469645f39373865623836353939393564353661227d2c2022706172746974696f6e4964223a2022706172746974696f6e69645f336163663539386165623861336438333a626561636f6e2e68616c6c222c20227061796c6f616448617368223a20227368613235363a66393137326438623632383331613364386339623433646435396331383638626538326462303962323930303866363030343431373264613031643166326330222c202270726976616379436c617373223a20227075626c69635f7363656e65222c2022636f7272656c6174696f6e4964223a2022636f6d6d616e6469645f39373865623836353939393564353661222c2022736368656d6156657273696f6e223a20322c2022706f6c69637956657273696f6e73223a207b7d2c202273696d756c6174696f6e54696d65223a2022313030303030222c202273747265616d53657175656e6365223a202231222c20226a6f75726e616c506f736974696f6e223a202231222c2022706172746974696f6e53657175656e6365223a202231227d
trusted:world-provisioning:commandid_978eb8659995d56a:projection-verified:event	tenantid_443adfa47140780d	worldid_b09aed54932c8f51	timelineid_a944a1d612944976	partitionid_3acf598aeb8a3d83:beacon.hall	beacon.hall	partitionid_3acf598aeb8a3d83:beacon.hall:stream	2	2	2	WorldProjectionVerified	2	100000	2026-10-19 23:52:18.809-07	trusted:world-provisioning:commandid_978eb8659995d56a:projection-verified	commandid_978eb8659995d56a	\N	\N	\N	\N	public_scene	sha256:d133c58c0a8790d873423db00b9a7dbb25744c74f841c3702271c8c0e24d6639	{"effectiveActorId": "world-provisioning", "causalRootActionId": "commandid_978eb8659995d56a", "authorityDecisionId": "authority:trusted:world-provisioning:commandid_978eb8659995d56a:projection-verified"}	\N	{}	{"expectedSeedProjectionHash": "4992862b743ee746a5a2b183c642b63ab7f556a626d4683ec8d142f31c367c99", "reconstructedSeedProjectionHash": "4992862b743ee746a5a2b183c642b63ab7f556a626d4683ec8d142f31c367c99"}	\\x7b2274797065223a2022576f726c6450726f6a656374696f6e5665726966696564222c20226576656e744964223a2022747275737465643a776f726c642d70726f766973696f6e696e673a636f6d6d616e6469645f393738656238363539393935643536613a70726f6a656374696f6e2d76657269666965643a6576656e74222c20227061796c6f6164223a207b2265787065637465645365656450726f6a656374696f6e48617368223a202234393932383632623734336565373436613561326231383363363432623633616237663535366136323664343638336563386431343266333163333637633939222c20227265636f6e73747275637465645365656450726f6a656374696f6e48617368223a202234393932383632623734336565373436613561326231383363363432623633616237663535366136323664343638336563386431343266333163333637633939227d2c2022776f726c644964223a2022776f726c6469645f62303961656435343933326338663531222c202273747265616d4964223a2022706172746974696f6e69645f336163663539386165623861336438333a626561636f6e2e68616c6c3a73747265616d222c202274656e616e744964223a202274656e616e7469645f34343361646661343731343037383064222c2022636f6d6d616e644964223a2022747275737465643a776f726c642d70726f766973696f6e696e673a636f6d6d616e6469645f393738656238363539393935643536613a70726f6a656374696f6e2d7665726966696564222c20227265636f726465644174223a2022323032362d31302d32305430363a35323a31382e3830395a222c202274696d656c696e654964223a202274696d656c696e6569645f61393434613164363132393434393736222c20226174747269627574696f6e223a207b226566666563746976654163746f724964223a2022776f726c642d70726f766973696f6e696e67222c202263617573616c526f6f74416374696f6e4964223a2022636f6d6d616e6469645f39373865623836353939393564353661222c2022617574686f726974794465636973696f6e4964223a2022617574686f726974793a747275737465643a776f726c642d70726f766973696f6e696e673a636f6d6d616e6469645f393738656238363539393935643536613a70726f6a656374696f6e2d7665726966696564227d2c2022706172746974696f6e4964223a2022706172746974696f6e69645f336163663539386165623861336438333a626561636f6e2e68616c6c222c20227061796c6f616448617368223a20227368613235363a64313333633538633061383739306438373334323364623030623961376462623235373434633734663834316333373032323731633863306532346436363339222c202270726976616379436c617373223a20227075626c69635f7363656e65222c2022636f7272656c6174696f6e4964223a2022636f6d6d616e6469645f39373865623836353939393564353661222c2022736368656d6156657273696f6e223a20322c2022706f6c69637956657273696f6e73223a207b7d2c202273696d756c6174696f6e54696d65223a2022313030303030222c202273747265616d53657175656e6365223a202232222c20226a6f75726e616c506f736974696f6e223a202232222c2022706172746974696f6e53657175656e6365223a202232227d
trusted:world-provisioning:commandid_978eb8659995d56a:world-ready:event	tenantid_443adfa47140780d	worldid_b09aed54932c8f51	timelineid_a944a1d612944976	partitionid_3acf598aeb8a3d83:beacon.hall	beacon.hall	partitionid_3acf598aeb8a3d83:beacon.hall:stream	3	3	3	WorldReady	2	100000	2026-10-19 23:52:18.814-07	trusted:world-provisioning:commandid_978eb8659995d56a:world-ready	commandid_978eb8659995d56a	\N	\N	\N	\N	public_scene	sha256:c168b692295e1f4fb8543137472304569ae355694d3424a74c187b17b09e8811	{"effectiveActorId": "world-provisioning", "causalRootActionId": "commandid_978eb8659995d56a", "authorityDecisionId": "authority:trusted:world-provisioning:commandid_978eb8659995d56a:world-ready"}	\N	{}	{"worldId": "worldid_b09aed54932c8f51", "timelineId": "timelineid_a944a1d612944976", "installationId": "installation:case-worldid_b09aed54932c8f51", "seedProjectionHash": "4992862b743ee746a5a2b183c642b63ab7f556a626d4683ec8d142f31c367c99"}	\\x7b2274797065223a2022576f726c645265616479222c20226576656e744964223a2022747275737465643a776f726c642d70726f766973696f6e696e673a636f6d6d616e6469645f393738656238363539393935643536613a776f726c642d72656164793a6576656e74222c20227061796c6f6164223a207b22776f726c644964223a2022776f726c6469645f62303961656435343933326338663531222c202274696d656c696e654964223a202274696d656c696e6569645f61393434613164363132393434393736222c2022696e7374616c6c6174696f6e4964223a2022696e7374616c6c6174696f6e3a636173652d776f726c6469645f62303961656435343933326338663531222c20227365656450726f6a656374696f6e48617368223a202234393932383632623734336565373436613561326231383363363432623633616237663535366136323664343638336563386431343266333163333637633939227d2c2022776f726c644964223a2022776f726c6469645f62303961656435343933326338663531222c202273747265616d4964223a2022706172746974696f6e69645f336163663539386165623861336438333a626561636f6e2e68616c6c3a73747265616d222c202274656e616e744964223a202274656e616e7469645f34343361646661343731343037383064222c2022636f6d6d616e644964223a2022747275737465643a776f726c642d70726f766973696f6e696e673a636f6d6d616e6469645f393738656238363539393935643536613a776f726c642d7265616479222c20227265636f726465644174223a2022323032362d31302d32305430363a35323a31382e3831345a222c202274696d656c696e654964223a202274696d656c696e6569645f61393434613164363132393434393736222c20226174747269627574696f6e223a207b226566666563746976654163746f724964223a2022776f726c642d70726f766973696f6e696e67222c202263617573616c526f6f74416374696f6e4964223a2022636f6d6d616e6469645f39373865623836353939393564353661222c2022617574686f726974794465636973696f6e4964223a2022617574686f726974793a747275737465643a776f726c642d70726f766973696f6e696e673a636f6d6d616e6469645f393738656238363539393935643536613a776f726c642d7265616479227d2c2022706172746974696f6e4964223a2022706172746974696f6e69645f336163663539386165623861336438333a626561636f6e2e68616c6c222c20227061796c6f616448617368223a20227368613235363a63313638623639323239356531663466623835343331333734373233303435363961653335353639346433343234613734633138376231376230396538383131222c202270726976616379436c617373223a20227075626c69635f7363656e65222c2022636f7272656c6174696f6e4964223a2022636f6d6d616e6469645f39373865623836353939393564353661222c2022736368656d6156657273696f6e223a20322c2022706f6c69637956657273696f6e73223a207b7d2c202273696d756c6174696f6e54696d65223a2022313030303030222c202273747265616d53657175656e6365223a202233222c20226a6f75726e616c506f736974696f6e223a202233222c2022706172746974696f6e53657175656e6365223a202233227d
commandid_a0368bd6d2238e50:event:0	tenantid_443adfa47140780d	worldid_b09aed54932c8f51	timelineid_a944a1d612944976	partitionid_3acf598aeb8a3d83:beacon.hall	beacon.hall	partitionid_3acf598aeb8a3d83:beacon.hall:stream	4	4	4	needs.changed	2	100000	2026-10-19 23:52:18.908-07	commandid_a0368bd6d2238e50	commandid_2227c78359bd6f1a	\N	\N	\N	\N	public_scene	sha256:cfc3efa222b2241118403ffc60e57dfb2327419e9957636d0d3f7cea97d10e16	{"effectiveActorId": "simulator-scenario", "causalRootActionId": "commandid_2227c78359bd6f1a", "authorityDecisionId": "authority:commandid_a0368bd6d2238e50"}	\N	{"routine": "beacon-1"}	{"kernelEvent": ["record", [["attribution", ["record", [["authorityDecisionId", ["string", "authority:commandid_a0368bd6d2238e50"]], ["causalRootActionId", ["string", "commandid_2227c78359bd6f1a"]], ["effectiveActorId", ["string", "simulator-scenario"]]]]], ["commandId", ["string", "commandid_a0368bd6d2238e50"]], ["eventId", ["string", "eventid_511cb7d8a641d3b2"]], ["eventIndex", ["integer", "0"]], ["partitionId", ["string", "partitionid_3acf598aeb8a3d83"]], ["payload", ["record", [["hunger", ["integer", "3166"]], ["hungerRemainder", ["bigint", "40000"]], ["integratedAt", ["bigint", "100000"]], ["objectId", ["string", "beacon.master"]], ["wetness", ["integer", "0"]], ["wetnessRemainder", ["bigint", "0"]]]]], ["policyVersions", ["record", [["routine", ["string", "beacon-1"]]]]], ["schemaVersion", ["integer", "1"]], ["simulationTime", ["bigint", "100000"]], ["tenantId", ["string", "tenantid_443adfa47140780d"]], ["timelineId", ["string", "timelineid_a944a1d612944976"]], ["type", ["string", "needs.changed"]], ["worldId", ["string", "worldid_b09aed54932c8f51"]]]]}	\\x7b2274797065223a20226e656564732e6368616e676564222c20226576656e744964223a2022636f6d6d616e6469645f613033363862643664323233386535303a6576656e743a30222c20227061796c6f6164223a207b226b65726e656c4576656e74223a205b227265636f7264222c205b5b226174747269627574696f6e222c205b227265636f7264222c205b5b22617574686f726974794465636973696f6e4964222c205b22737472696e67222c2022617574686f726974793a636f6d6d616e6469645f61303336386264366432323338653530225d5d2c205b2263617573616c526f6f74416374696f6e4964222c205b22737472696e67222c2022636f6d6d616e6469645f32323237633738333539626436663161225d5d2c205b226566666563746976654163746f724964222c205b22737472696e67222c202273696d756c61746f722d7363656e6172696f225d5d5d5d5d2c205b22636f6d6d616e644964222c205b22737472696e67222c2022636f6d6d616e6469645f61303336386264366432323338653530225d5d2c205b226576656e744964222c205b22737472696e67222c20226576656e7469645f35313163623764386136343164336232225d5d2c205b226576656e74496e646578222c205b22696e7465676572222c202230225d5d2c205b22706172746974696f6e4964222c205b22737472696e67222c2022706172746974696f6e69645f33616366353938616562386133643833225d5d2c205b227061796c6f6164222c205b227265636f7264222c205b5b2268756e676572222c205b22696e7465676572222c202233313636225d5d2c205b2268756e67657252656d61696e646572222c205b22626967696e74222c20223430303030225d5d2c205b22696e74656772617465644174222c205b22626967696e74222c2022313030303030225d5d2c205b226f626a6563744964222c205b22737472696e67222c2022626561636f6e2e6d6173746572225d5d2c205b227765746e657373222c205b22696e7465676572222c202230225d5d2c205b227765746e65737352656d61696e646572222c205b22626967696e74222c202230225d5d5d5d5d2c205b22706f6c69637956657273696f6e73222c205b227265636f7264222c205b5b22726f7574696e65222c205b22737472696e67222c2022626561636f6e2d31225d5d5d5d5d2c205b22736368656d6156657273696f6e222c205b22696e7465676572222c202231225d5d2c205b2273696d756c6174696f6e54696d65222c205b22626967696e74222c2022313030303030225d5d2c205b2274656e616e744964222c205b22737472696e67222c202274656e616e7469645f34343361646661343731343037383064225d5d2c205b2274696d656c696e654964222c205b22737472696e67222c202274696d656c696e6569645f61393434613164363132393434393736225d5d2c205b2274797065222c205b22737472696e67222c20226e656564732e6368616e676564225d5d2c205b22776f726c644964222c205b22737472696e67222c2022776f726c6469645f62303961656435343933326338663531225d5d5d5d7d2c2022776f726c644964223a2022776f726c6469645f62303961656435343933326338663531222c202273747265616d4964223a2022706172746974696f6e69645f336163663539386165623861336438333a626561636f6e2e68616c6c3a73747265616d222c202274656e616e744964223a202274656e616e7469645f34343361646661343731343037383064222c2022636f6d6d616e644964223a2022636f6d6d616e6469645f61303336386264366432323338653530222c20227265636f726465644174223a2022323032362d31302d32305430363a35323a31382e3930385a222c202274696d656c696e654964223a202274696d656c696e6569645f61393434613164363132393434393736222c20226174747269627574696f6e223a207b226566666563746976654163746f724964223a202273696d756c61746f722d7363656e6172696f222c202263617573616c526f6f74416374696f6e4964223a2022636f6d6d616e6469645f32323237633738333539626436663161222c2022617574686f726974794465636973696f6e4964223a2022617574686f726974793a636f6d6d616e6469645f61303336386264366432323338653530227d2c2022706172746974696f6e4964223a2022706172746974696f6e69645f336163663539386165623861336438333a626561636f6e2e68616c6c222c20227061796c6f616448617368223a20227368613235363a63666333656661323232623232343131313834303366666336306535376466623233323734313965393935373633366430643366376365613937643130653136222c202270726976616379436c617373223a20227075626c69635f7363656e65222c2022636f7272656c6174696f6e4964223a2022636f6d6d616e6469645f32323237633738333539626436663161222c2022736368656d6156657273696f6e223a20322c2022706f6c69637956657273696f6e73223a207b22726f7574696e65223a2022626561636f6e2d31227d2c202273696d756c6174696f6e54696d65223a2022313030303030222c202273747265616d53657175656e6365223a202234222c20226a6f75726e616c506f736974696f6e223a202234222c2022706172746974696f6e53657175656e6365223a202234227d
commandid_a0368bd6d2238e50:event:1	tenantid_443adfa47140780d	worldid_b09aed54932c8f51	timelineid_a944a1d612944976	partitionid_3acf598aeb8a3d83:beacon.hall	beacon.hall	partitionid_3acf598aeb8a3d83:beacon.hall:stream	5	5	5	wellbeing.integrated	2	100000	2026-10-19 23:52:18.908-07	commandid_a0368bd6d2238e50	commandid_2227c78359bd6f1a	\N	\N	\N	\N	public_scene	sha256:bfb6e6aa4cc85937107bcbbb992404635a0b8aeb14e13b2ece4498e940ef2b78	{"effectiveActorId": "simulator-scenario", "causalRootActionId": "commandid_2227c78359bd6f1a", "authorityDecisionId": "authority:commandid_a0368bd6d2238e50"}	\N	{"routine": "beacon-1"}	{"kernelEvent": ["record", [["attribution", ["record", [["authorityDecisionId", ["string", "authority:commandid_a0368bd6d2238e50"]], ["causalRootActionId", ["string", "commandid_2227c78359bd6f1a"]], ["effectiveActorId", ["string", "simulator-scenario"]]]]], ["commandId", ["string", "commandid_a0368bd6d2238e50"]], ["eventId", ["string", "eventid_0dbdc013e2ebc543"]], ["eventIndex", ["integer", "1"]], ["partitionId", ["string", "partitionid_3acf598aeb8a3d83"]], ["payload", ["record", [["health", ["integer", "10000"]], ["healthRemainder", ["bigint", "0"]], ["integratedAt", ["bigint", "100000"]], ["objectId", ["string", "beacon.master"]], ["thirst", ["integer", "83"]], ["thirstRemainder", ["bigint", "20000"]]]]], ["policyVersions", ["record", [["routine", ["string", "beacon-1"]]]]], ["schemaVersion", ["integer", "1"]], ["simulationTime", ["bigint", "100000"]], ["tenantId", ["string", "tenantid_443adfa47140780d"]], ["timelineId", ["string", "timelineid_a944a1d612944976"]], ["type", ["string", "wellbeing.integrated"]], ["worldId", ["string", "worldid_b09aed54932c8f51"]]]]}	\\x7b2274797065223a202277656c6c6265696e672e696e7465677261746564222c20226576656e744964223a2022636f6d6d616e6469645f613033363862643664323233386535303a6576656e743a31222c20227061796c6f6164223a207b226b65726e656c4576656e74223a205b227265636f7264222c205b5b226174747269627574696f6e222c205b227265636f7264222c205b5b22617574686f726974794465636973696f6e4964222c205b22737472696e67222c2022617574686f726974793a636f6d6d616e6469645f61303336386264366432323338653530225d5d2c205b2263617573616c526f6f74416374696f6e4964222c205b22737472696e67222c2022636f6d6d616e6469645f32323237633738333539626436663161225d5d2c205b226566666563746976654163746f724964222c205b22737472696e67222c202273696d756c61746f722d7363656e6172696f225d5d5d5d5d2c205b22636f6d6d616e644964222c205b22737472696e67222c2022636f6d6d616e6469645f61303336386264366432323338653530225d5d2c205b226576656e744964222c205b22737472696e67222c20226576656e7469645f30646264633031336532656263353433225d5d2c205b226576656e74496e646578222c205b22696e7465676572222c202231225d5d2c205b22706172746974696f6e4964222c205b22737472696e67222c2022706172746974696f6e69645f33616366353938616562386133643833225d5d2c205b227061796c6f6164222c205b227265636f7264222c205b5b226865616c7468222c205b22696e7465676572222c20223130303030225d5d2c205b226865616c746852656d61696e646572222c205b22626967696e74222c202230225d5d2c205b22696e74656772617465644174222c205b22626967696e74222c2022313030303030225d5d2c205b226f626a6563744964222c205b22737472696e67222c2022626561636f6e2e6d6173746572225d5d2c205b22746869727374222c205b22696e7465676572222c20223833225d5d2c205b2274686972737452656d61696e646572222c205b22626967696e74222c20223230303030225d5d5d5d5d2c205b22706f6c69637956657273696f6e73222c205b227265636f7264222c205b5b22726f7574696e65222c205b22737472696e67222c2022626561636f6e2d31225d5d5d5d5d2c205b22736368656d6156657273696f6e222c205b22696e7465676572222c202231225d5d2c205b2273696d756c6174696f6e54696d65222c205b22626967696e74222c2022313030303030225d5d2c205b2274656e616e744964222c205b22737472696e67222c202274656e616e7469645f34343361646661343731343037383064225d5d2c205b2274696d656c696e654964222c205b22737472696e67222c202274696d656c696e6569645f61393434613164363132393434393736225d5d2c205b2274797065222c205b22737472696e67222c202277656c6c6265696e672e696e7465677261746564225d5d2c205b22776f726c644964222c205b22737472696e67222c2022776f726c6469645f62303961656435343933326338663531225d5d5d5d7d2c2022776f726c644964223a2022776f726c6469645f62303961656435343933326338663531222c202273747265616d4964223a2022706172746974696f6e69645f336163663539386165623861336438333a626561636f6e2e68616c6c3a73747265616d222c202274656e616e744964223a202274656e616e7469645f34343361646661343731343037383064222c2022636f6d6d616e644964223a2022636f6d6d616e6469645f61303336386264366432323338653530222c20227265636f726465644174223a2022323032362d31302d32305430363a35323a31382e3930385a222c202274696d656c696e654964223a202274696d656c696e6569645f61393434613164363132393434393736222c20226174747269627574696f6e223a207b226566666563746976654163746f724964223a202273696d756c61746f722d7363656e6172696f222c202263617573616c526f6f74416374696f6e4964223a2022636f6d6d616e6469645f32323237633738333539626436663161222c2022617574686f726974794465636973696f6e4964223a2022617574686f726974793a636f6d6d616e6469645f61303336386264366432323338653530227d2c2022706172746974696f6e4964223a2022706172746974696f6e69645f336163663539386165623861336438333a626561636f6e2e68616c6c222c20227061796c6f616448617368223a20227368613235363a62666236653661613463633835393337313037626362626239393234303436333561306238616562313465313362326563653434393865393430656632623738222c202270726976616379436c617373223a20227075626c69635f7363656e65222c2022636f7272656c6174696f6e4964223a2022636f6d6d616e6469645f32323237633738333539626436663161222c2022736368656d6156657273696f6e223a20322c2022706f6c69637956657273696f6e73223a207b22726f7574696e65223a2022626561636f6e2d31227d2c202273696d756c6174696f6e54696d65223a2022313030303030222c202273747265616d53657175656e6365223a202235222c20226a6f75726e616c506f736974696f6e223a202235222c2022706172746974696f6e53657175656e6365223a202235227d
commandid_a0368bd6d2238e50:event:2	tenantid_443adfa47140780d	worldid_b09aed54932c8f51	timelineid_a944a1d612944976	partitionid_3acf598aeb8a3d83:beacon.hall	beacon.hall	partitionid_3acf598aeb8a3d83:beacon.hall:stream	6	6	6	weather.changed	2	100000	2026-10-19 23:52:18.908-07	commandid_a0368bd6d2238e50	commandid_2227c78359bd6f1a	\N	\N	\N	\N	public_scene	sha256:da5fe4fc46576db201d3333bb72c138fa886fee730146a774efd356d729c94b7	{"effectiveActorId": "simulator-scenario", "causalRootActionId": "commandid_2227c78359bd6f1a", "authorityDecisionId": "authority:commandid_a0368bd6d2238e50"}	\N	{"routine": "beacon-1"}	{"kernelEvent": ["record", [["attribution", ["record", [["authorityDecisionId", ["string", "authority:commandid_a0368bd6d2238e50"]], ["causalRootActionId", ["string", "commandid_2227c78359bd6f1a"]], ["effectiveActorId", ["string", "simulator-scenario"]]]]], ["commandId", ["string", "commandid_a0368bd6d2238e50"]], ["eventId", ["string", "eventid_027add91b9792bf4"]], ["eventIndex", ["integer", "2"]], ["partitionId", ["string", "partitionid_3acf598aeb8a3d83"]], ["payload", ["record", [["rainIntensity", ["integer", "0"]]]]], ["policyVersions", ["record", [["routine", ["string", "beacon-1"]]]]], ["schemaVersion", ["integer", "1"]], ["simulationTime", ["bigint", "100000"]], ["tenantId", ["string", "tenantid_443adfa47140780d"]], ["timelineId", ["string", "timelineid_a944a1d612944976"]], ["type", ["string", "weather.changed"]], ["worldId", ["string", "worldid_b09aed54932c8f51"]]]]}	\\x7b2274797065223a2022776561746865722e6368616e676564222c20226576656e744964223a2022636f6d6d616e6469645f613033363862643664323233386535303a6576656e743a32222c20227061796c6f6164223a207b226b65726e656c4576656e74223a205b227265636f7264222c205b5b226174747269627574696f6e222c205b227265636f7264222c205b5b22617574686f726974794465636973696f6e4964222c205b22737472696e67222c2022617574686f726974793a636f6d6d616e6469645f61303336386264366432323338653530225d5d2c205b2263617573616c526f6f74416374696f6e4964222c205b22737472696e67222c2022636f6d6d616e6469645f32323237633738333539626436663161225d5d2c205b226566666563746976654163746f724964222c205b22737472696e67222c202273696d756c61746f722d7363656e6172696f225d5d5d5d5d2c205b22636f6d6d616e644964222c205b22737472696e67222c2022636f6d6d616e6469645f61303336386264366432323338653530225d5d2c205b226576656e744964222c205b22737472696e67222c20226576656e7469645f30323761646439316239373932626634225d5d2c205b226576656e74496e646578222c205b22696e7465676572222c202232225d5d2c205b22706172746974696f6e4964222c205b22737472696e67222c2022706172746974696f6e69645f33616366353938616562386133643833225d5d2c205b227061796c6f6164222c205b227265636f7264222c205b5b227261696e496e74656e73697479222c205b22696e7465676572222c202230225d5d5d5d5d2c205b22706f6c69637956657273696f6e73222c205b227265636f7264222c205b5b22726f7574696e65222c205b22737472696e67222c2022626561636f6e2d31225d5d5d5d5d2c205b22736368656d6156657273696f6e222c205b22696e7465676572222c202231225d5d2c205b2273696d756c6174696f6e54696d65222c205b22626967696e74222c2022313030303030225d5d2c205b2274656e616e744964222c205b22737472696e67222c202274656e616e7469645f34343361646661343731343037383064225d5d2c205b2274696d656c696e654964222c205b22737472696e67222c202274696d656c696e6569645f61393434613164363132393434393736225d5d2c205b2274797065222c205b22737472696e67222c2022776561746865722e6368616e676564225d5d2c205b22776f726c644964222c205b22737472696e67222c2022776f726c6469645f62303961656435343933326338663531225d5d5d5d7d2c2022776f726c644964223a2022776f726c6469645f62303961656435343933326338663531222c202273747265616d4964223a2022706172746974696f6e69645f336163663539386165623861336438333a626561636f6e2e68616c6c3a73747265616d222c202274656e616e744964223a202274656e616e7469645f34343361646661343731343037383064222c2022636f6d6d616e644964223a2022636f6d6d616e6469645f61303336386264366432323338653530222c20227265636f726465644174223a2022323032362d31302d32305430363a35323a31382e3930385a222c202274696d656c696e654964223a202274696d656c696e6569645f61393434613164363132393434393736222c20226174747269627574696f6e223a207b226566666563746976654163746f724964223a202273696d756c61746f722d7363656e6172696f222c202263617573616c526f6f74416374696f6e4964223a2022636f6d6d616e6469645f32323237633738333539626436663161222c2022617574686f726974794465636973696f6e4964223a2022617574686f726974793a636f6d6d616e6469645f61303336386264366432323338653530227d2c2022706172746974696f6e4964223a2022706172746974696f6e69645f336163663539386165623861336438333a626561636f6e2e68616c6c222c20227061796c6f616448617368223a20227368613235363a64613566653466633436353736646232303164333333336262373263313338666138383666656537333031343661373734656664333536643732396339346237222c202270726976616379436c617373223a20227075626c69635f7363656e65222c2022636f7272656c6174696f6e4964223a2022636f6d6d616e6469645f32323237633738333539626436663161222c2022736368656d6156657273696f6e223a20322c2022706f6c69637956657273696f6e73223a207b22726f7574696e65223a2022626561636f6e2d31227d2c202273696d756c6174696f6e54696d65223a2022313030303030222c202273747265616d53657175656e6365223a202236222c20226a6f75726e616c506f736974696f6e223a202236222c2022706172746974696f6e53657175656e6365223a202236227d
commandid_d18fe531fbc57ee9:event:0	tenantid_443adfa47140780d	worldid_b09aed54932c8f51	timelineid_a944a1d612944976	partitionid_3acf598aeb8a3d83:beacon.hall	beacon.hall	partitionid_3acf598aeb8a3d83:beacon.hall:stream	7	7	7	routine.selected	2	100000	2026-10-19 23:52:18.94-07	commandid_d18fe531fbc57ee9	commandid_2227c78359bd6f1a	\N	\N	\N	\N	public_scene	sha256:3ce56a6c4b855f631303f0569fbf954bf957874655404bd1e11e39fdc6286ca0	{"effectiveActorId": "simulator-scenario", "causalRootActionId": "commandid_2227c78359bd6f1a", "authorityDecisionId": "authority:commandid_d18fe531fbc57ee9"}	\N	{"routine": "beacon-1"}	{"kernelEvent": ["record", [["attribution", ["record", [["authorityDecisionId", ["string", "authority:commandid_d18fe531fbc57ee9"]], ["causalRootActionId", ["string", "commandid_2227c78359bd6f1a"]], ["effectiveActorId", ["string", "simulator-scenario"]]]]], ["commandId", ["string", "commandid_d18fe531fbc57ee9"]], ["eventId", ["string", "eventid_04b7c4e818aeb01b"]], ["eventIndex", ["integer", "3"]], ["partitionId", ["string", "partitionid_3acf598aeb8a3d83"]], ["payload", ["record", [["action", ["record", [["kind", ["string", "seek-food"]], ["targetObjectId", ["string", "beacon.larder"]]]]], ["objectId", ["string", "beacon.master"]]]]], ["policyVersions", ["record", [["routine", ["string", "beacon-1"]]]]], ["schemaVersion", ["integer", "2"]], ["simulationTime", ["bigint", "100000"]], ["tenantId", ["string", "tenantid_443adfa47140780d"]], ["timelineId", ["string", "timelineid_a944a1d612944976"]], ["type", ["string", "routine.selected"]], ["worldId", ["string", "worldid_b09aed54932c8f51"]]]]}	\\x7b2274797065223a2022726f7574696e652e73656c6563746564222c20226576656e744964223a2022636f6d6d616e6469645f643138666535333166626335376565393a6576656e743a30222c20227061796c6f6164223a207b226b65726e656c4576656e74223a205b227265636f7264222c205b5b226174747269627574696f6e222c205b227265636f7264222c205b5b22617574686f726974794465636973696f6e4964222c205b22737472696e67222c2022617574686f726974793a636f6d6d616e6469645f64313866653533316662633537656539225d5d2c205b2263617573616c526f6f74416374696f6e4964222c205b22737472696e67222c2022636f6d6d616e6469645f32323237633738333539626436663161225d5d2c205b226566666563746976654163746f724964222c205b22737472696e67222c202273696d756c61746f722d7363656e6172696f225d5d5d5d5d2c205b22636f6d6d616e644964222c205b22737472696e67222c2022636f6d6d616e6469645f64313866653533316662633537656539225d5d2c205b226576656e744964222c205b22737472696e67222c20226576656e7469645f30346237633465383138616562303162225d5d2c205b226576656e74496e646578222c205b22696e7465676572222c202233225d5d2c205b22706172746974696f6e4964222c205b22737472696e67222c2022706172746974696f6e69645f33616366353938616562386133643833225d5d2c205b227061796c6f6164222c205b227265636f7264222c205b5b22616374696f6e222c205b227265636f7264222c205b5b226b696e64222c205b22737472696e67222c20227365656b2d666f6f64225d5d2c205b227461726765744f626a6563744964222c205b22737472696e67222c2022626561636f6e2e6c6172646572225d5d5d5d5d2c205b226f626a6563744964222c205b22737472696e67222c2022626561636f6e2e6d6173746572225d5d5d5d5d2c205b22706f6c69637956657273696f6e73222c205b227265636f7264222c205b5b22726f7574696e65222c205b22737472696e67222c2022626561636f6e2d31225d5d5d5d5d2c205b22736368656d6156657273696f6e222c205b22696e7465676572222c202232225d5d2c205b2273696d756c6174696f6e54696d65222c205b22626967696e74222c2022313030303030225d5d2c205b2274656e616e744964222c205b22737472696e67222c202274656e616e7469645f34343361646661343731343037383064225d5d2c205b2274696d656c696e654964222c205b22737472696e67222c202274696d656c696e6569645f61393434613164363132393434393736225d5d2c205b2274797065222c205b22737472696e67222c2022726f7574696e652e73656c6563746564225d5d2c205b22776f726c644964222c205b22737472696e67222c2022776f726c6469645f62303961656435343933326338663531225d5d5d5d7d2c2022776f726c644964223a2022776f726c6469645f62303961656435343933326338663531222c202273747265616d4964223a2022706172746974696f6e69645f336163663539386165623861336438333a626561636f6e2e68616c6c3a73747265616d222c202274656e616e744964223a202274656e616e7469645f34343361646661343731343037383064222c2022636f6d6d616e644964223a2022636f6d6d616e6469645f64313866653533316662633537656539222c20227265636f726465644174223a2022323032362d31302d32305430363a35323a31382e3934305a222c202274696d656c696e654964223a202274696d656c696e6569645f61393434613164363132393434393736222c20226174747269627574696f6e223a207b226566666563746976654163746f724964223a202273696d756c61746f722d7363656e6172696f222c202263617573616c526f6f74416374696f6e4964223a2022636f6d6d616e6469645f32323237633738333539626436663161222c2022617574686f726974794465636973696f6e4964223a2022617574686f726974793a636f6d6d616e6469645f64313866653533316662633537656539227d2c2022706172746974696f6e4964223a2022706172746974696f6e69645f336163663539386165623861336438333a626561636f6e2e68616c6c222c20227061796c6f616448617368223a20227368613235363a33636535366136633462383535663633313330336630353639666266393534626639353738373436353534303462643165313165333966646336323836636130222c202270726976616379436c617373223a20227075626c69635f7363656e65222c2022636f7272656c6174696f6e4964223a2022636f6d6d616e6469645f32323237633738333539626436663161222c2022736368656d6156657273696f6e223a20322c2022706f6c69637956657273696f6e73223a207b22726f7574696e65223a2022626561636f6e2d31227d2c202273696d756c6174696f6e54696d65223a2022313030303030222c202273747265616d53657175656e6365223a202237222c20226a6f75726e616c506f736974696f6e223a202237222c2022706172746974696f6e53657175656e6365223a202237227d
commandid_d18fe531fbc57ee9:event:1	tenantid_443adfa47140780d	worldid_b09aed54932c8f51	timelineid_a944a1d612944976	partitionid_3acf598aeb8a3d83:beacon.hall	beacon.hall	partitionid_3acf598aeb8a3d83:beacon.hall:stream	8	8	8	movement.started	2	100000	2026-10-19 23:52:18.94-07	commandid_d18fe531fbc57ee9	commandid_2227c78359bd6f1a	\N	\N	\N	\N	public_scene	sha256:a45eee835834a075c59751da41273081255a58abf88efaa5dd511626637cf48b	{"effectiveActorId": "simulator-scenario", "causalRootActionId": "commandid_2227c78359bd6f1a", "authorityDecisionId": "authority:commandid_d18fe531fbc57ee9"}	\N	{"routine": "beacon-1"}	{"kernelEvent": ["record", [["attribution", ["record", [["authorityDecisionId", ["string", "authority:commandid_d18fe531fbc57ee9"]], ["causalRootActionId", ["string", "commandid_2227c78359bd6f1a"]], ["effectiveActorId", ["string", "simulator-scenario"]]]]], ["commandId", ["string", "commandid_d18fe531fbc57ee9"]], ["eventId", ["string", "eventid_dbcd34c931538b68"]], ["eventIndex", ["integer", "4"]], ["partitionId", ["string", "partitionid_3acf598aeb8a3d83"]], ["payload", ["record", [["movement", ["record", [["anchorPath", ["array", []]], ["destination", ["record", [["kind", ["string", "pose"]], ["pose", ["record", [["coordinates", ["array", [["bigint", "100"], ["bigint", "100"]]]], ["frameId", ["string", "frame-hall"]], ["frameVersion", ["integer", "1"]]]]]]]], ["emitted", ["array", []]], ["exitedAtStart", ["array", []]], ["frameId", ["string", "frame-hall"]], ["frameVersion", ["integer", "1"]], ["initialInside", ["array", [["string", "hall"]]]], ["movementId", ["string", "movement-commandid_c6999b77a9a5d639"]], ["segment", ["record", [["speed", ["record", [["kind", ["string", "constant-units-per-second"]], ["unitsPerSecond", ["bigint", "1000"]]]]], ["startTime", ["bigint", "100000"]], ["waypoints", ["array", [["array", [["bigint", "10"], ["bigint", "20"]]], ["array", [["bigint", "100"], ["bigint", "100"]]]]]]]]], ["status", ["string", "active"]]]]], ["objectId", ["string", "beacon.master"]]]]], ["policyVersions", ["record", [["routine", ["string", "beacon-1"]]]]], ["schemaVersion", ["integer", "1"]], ["simulationTime", ["bigint", "100000"]], ["tenantId", ["string", "tenantid_443adfa47140780d"]], ["timelineId", ["string", "timelineid_a944a1d612944976"]], ["type", ["string", "movement.started"]], ["worldId", ["string", "worldid_b09aed54932c8f51"]]]]}	\\x7b2274797065223a20226d6f76656d656e742e73746172746564222c20226576656e744964223a2022636f6d6d616e6469645f643138666535333166626335376565393a6576656e743a31222c20227061796c6f6164223a207b226b65726e656c4576656e74223a205b227265636f7264222c205b5b226174747269627574696f6e222c205b227265636f7264222c205b5b22617574686f726974794465636973696f6e4964222c205b22737472696e67222c2022617574686f726974793a636f6d6d616e6469645f64313866653533316662633537656539225d5d2c205b2263617573616c526f6f74416374696f6e4964222c205b22737472696e67222c2022636f6d6d616e6469645f32323237633738333539626436663161225d5d2c205b226566666563746976654163746f724964222c205b22737472696e67222c202273696d756c61746f722d7363656e6172696f225d5d5d5d5d2c205b22636f6d6d616e644964222c205b22737472696e67222c2022636f6d6d616e6469645f64313866653533316662633537656539225d5d2c205b226576656e744964222c205b22737472696e67222c20226576656e7469645f64626364333463393331353338623638225d5d2c205b226576656e74496e646578222c205b22696e7465676572222c202234225d5d2c205b22706172746974696f6e4964222c205b22737472696e67222c2022706172746974696f6e69645f33616366353938616562386133643833225d5d2c205b227061796c6f6164222c205b227265636f7264222c205b5b226d6f76656d656e74222c205b227265636f7264222c205b5b22616e63686f7250617468222c205b226172726179222c205b5d5d5d2c205b2264657374696e6174696f6e222c205b227265636f7264222c205b5b226b696e64222c205b22737472696e67222c2022706f7365225d5d2c205b22706f7365222c205b227265636f7264222c205b5b22636f6f7264696e61746573222c205b226172726179222c205b5b22626967696e74222c2022313030225d2c205b22626967696e74222c2022313030225d5d5d5d2c205b226672616d654964222c205b22737472696e67222c20226672616d652d68616c6c225d5d2c205b226672616d6556657273696f6e222c205b22696e7465676572222c202231225d5d5d5d5d5d5d5d2c205b22656d6974746564222c205b226172726179222c205b5d5d5d2c205b2265786974656441745374617274222c205b226172726179222c205b5d5d5d2c205b226672616d654964222c205b22737472696e67222c20226672616d652d68616c6c225d5d2c205b226672616d6556657273696f6e222c205b22696e7465676572222c202231225d5d2c205b22696e697469616c496e73696465222c205b226172726179222c205b5b22737472696e67222c202268616c6c225d5d5d5d2c205b226d6f76656d656e744964222c205b22737472696e67222c20226d6f76656d656e742d636f6d6d616e6469645f63363939396237376139613564363339225d5d2c205b227365676d656e74222c205b227265636f7264222c205b5b227370656564222c205b227265636f7264222c205b5b226b696e64222c205b22737472696e67222c2022636f6e7374616e742d756e6974732d7065722d7365636f6e64225d5d2c205b22756e6974735065725365636f6e64222c205b22626967696e74222c202231303030225d5d5d5d5d2c205b22737461727454696d65222c205b22626967696e74222c2022313030303030225d5d2c205b22776179706f696e7473222c205b226172726179222c205b5b226172726179222c205b5b22626967696e74222c20223130225d2c205b22626967696e74222c20223230225d5d5d2c205b226172726179222c205b5b22626967696e74222c2022313030225d2c205b22626967696e74222c2022313030225d5d5d5d5d5d5d5d5d2c205b22737461747573222c205b22737472696e67222c2022616374697665225d5d5d5d5d2c205b226f626a6563744964222c205b22737472696e67222c2022626561636f6e2e6d6173746572225d5d5d5d5d2c205b22706f6c69637956657273696f6e73222c205b227265636f7264222c205b5b22726f7574696e65222c205b22737472696e67222c2022626561636f6e2d31225d5d5d5d5d2c205b22736368656d6156657273696f6e222c205b22696e7465676572222c202231225d5d2c205b2273696d756c6174696f6e54696d65222c205b22626967696e74222c2022313030303030225d5d2c205b2274656e616e744964222c205b22737472696e67222c202274656e616e7469645f34343361646661343731343037383064225d5d2c205b2274696d656c696e654964222c205b22737472696e67222c202274696d656c696e6569645f61393434613164363132393434393736225d5d2c205b2274797065222c205b22737472696e67222c20226d6f76656d656e742e73746172746564225d5d2c205b22776f726c644964222c205b22737472696e67222c2022776f726c6469645f62303961656435343933326338663531225d5d5d5d7d2c2022776f726c644964223a2022776f726c6469645f62303961656435343933326338663531222c202273747265616d4964223a2022706172746974696f6e69645f336163663539386165623861336438333a626561636f6e2e68616c6c3a73747265616d222c202274656e616e744964223a202274656e616e7469645f34343361646661343731343037383064222c2022636f6d6d616e644964223a2022636f6d6d616e6469645f64313866653533316662633537656539222c20227265636f726465644174223a2022323032362d31302d32305430363a35323a31382e3934305a222c202274696d656c696e654964223a202274696d656c696e6569645f61393434613164363132393434393736222c20226174747269627574696f6e223a207b226566666563746976654163746f724964223a202273696d756c61746f722d7363656e6172696f222c202263617573616c526f6f74416374696f6e4964223a2022636f6d6d616e6469645f32323237633738333539626436663161222c2022617574686f726974794465636973696f6e4964223a2022617574686f726974793a636f6d6d616e6469645f64313866653533316662633537656539227d2c2022706172746974696f6e4964223a2022706172746974696f6e69645f336163663539386165623861336438333a626561636f6e2e68616c6c222c20227061796c6f616448617368223a20227368613235363a61343565656538333538333461303735633539373531646134313237333038313235356135386162663838656661613564643531313632363633376366343862222c202270726976616379436c617373223a20227075626c69635f7363656e65222c2022636f7272656c6174696f6e4964223a2022636f6d6d616e6469645f32323237633738333539626436663161222c2022736368656d6156657273696f6e223a20322c2022706f6c69637956657273696f6e73223a207b22726f7574696e65223a2022626561636f6e2d31227d2c202273696d756c6174696f6e54696d65223a2022313030303030222c202273747265616d53657175656e6365223a202238222c20226a6f75726e616c506f736974696f6e223a202238222c2022706172746974696f6e53657175656e6365223a202238227d
commandid_d18fe531fbc57ee9:event:2	tenantid_443adfa47140780d	worldid_b09aed54932c8f51	timelineid_a944a1d612944976	partitionid_3acf598aeb8a3d83:beacon.hall	beacon.hall	partitionid_3acf598aeb8a3d83:beacon.hall:stream	9	9	9	movement.region-exited	2	100120	2026-10-19 23:52:18.94-07	commandid_d18fe531fbc57ee9	commandid_2227c78359bd6f1a	\N	\N	\N	\N	public_scene	sha256:1705a4962c986043c56c7826a2e5d8092087d89104438266b6c2115f3713157b	{"effectiveActorId": "simulator-scenario", "causalRootActionId": "commandid_2227c78359bd6f1a", "authorityDecisionId": "authority:commandid_d18fe531fbc57ee9"}	\N	{"routine": "beacon-1"}	{"kernelEvent": ["record", [["attribution", ["record", [["authorityDecisionId", ["string", "authority:commandid_d18fe531fbc57ee9"]], ["causalRootActionId", ["string", "commandid_2227c78359bd6f1a"]], ["effectiveActorId", ["string", "simulator-scenario"]]]]], ["commandId", ["string", "commandid_d18fe531fbc57ee9"]], ["eventId", ["string", "eventid_dc6680c61df45a59"]], ["eventIndex", ["integer", "5"]], ["partitionId", ["string", "partitionid_3acf598aeb8a3d83"]], ["payload", ["record", [["movementId", ["string", "movement-commandid_c6999b77a9a5d639"]], ["objectId", ["string", "beacon.master"]], ["regionId", ["string", "hall"]], ["regionVersion", ["integer", "1"]]]]], ["policyVersions", ["record", [["routine", ["string", "beacon-1"]]]]], ["schemaVersion", ["integer", "1"]], ["simulationTime", ["bigint", "100120"]], ["tenantId", ["string", "tenantid_443adfa47140780d"]], ["timelineId", ["string", "timelineid_a944a1d612944976"]], ["type", ["string", "movement.region-exited"]], ["worldId", ["string", "worldid_b09aed54932c8f51"]]]]}	\\x7b2274797065223a20226d6f76656d656e742e726567696f6e2d657869746564222c20226576656e744964223a2022636f6d6d616e6469645f643138666535333166626335376565393a6576656e743a32222c20227061796c6f6164223a207b226b65726e656c4576656e74223a205b227265636f7264222c205b5b226174747269627574696f6e222c205b227265636f7264222c205b5b22617574686f726974794465636973696f6e4964222c205b22737472696e67222c2022617574686f726974793a636f6d6d616e6469645f64313866653533316662633537656539225d5d2c205b2263617573616c526f6f74416374696f6e4964222c205b22737472696e67222c2022636f6d6d616e6469645f32323237633738333539626436663161225d5d2c205b226566666563746976654163746f724964222c205b22737472696e67222c202273696d756c61746f722d7363656e6172696f225d5d5d5d5d2c205b22636f6d6d616e644964222c205b22737472696e67222c2022636f6d6d616e6469645f64313866653533316662633537656539225d5d2c205b226576656e744964222c205b22737472696e67222c20226576656e7469645f64633636383063363164663435613539225d5d2c205b226576656e74496e646578222c205b22696e7465676572222c202235225d5d2c205b22706172746974696f6e4964222c205b22737472696e67222c2022706172746974696f6e69645f33616366353938616562386133643833225d5d2c205b227061796c6f6164222c205b227265636f7264222c205b5b226d6f76656d656e744964222c205b22737472696e67222c20226d6f76656d656e742d636f6d6d616e6469645f63363939396237376139613564363339225d5d2c205b226f626a6563744964222c205b22737472696e67222c2022626561636f6e2e6d6173746572225d5d2c205b22726567696f6e4964222c205b22737472696e67222c202268616c6c225d5d2c205b22726567696f6e56657273696f6e222c205b22696e7465676572222c202231225d5d5d5d5d2c205b22706f6c69637956657273696f6e73222c205b227265636f7264222c205b5b22726f7574696e65222c205b22737472696e67222c2022626561636f6e2d31225d5d5d5d5d2c205b22736368656d6156657273696f6e222c205b22696e7465676572222c202231225d5d2c205b2273696d756c6174696f6e54696d65222c205b22626967696e74222c2022313030313230225d5d2c205b2274656e616e744964222c205b22737472696e67222c202274656e616e7469645f34343361646661343731343037383064225d5d2c205b2274696d656c696e654964222c205b22737472696e67222c202274696d656c696e6569645f61393434613164363132393434393736225d5d2c205b2274797065222c205b22737472696e67222c20226d6f76656d656e742e726567696f6e2d657869746564225d5d2c205b22776f726c644964222c205b22737472696e67222c2022776f726c6469645f62303961656435343933326338663531225d5d5d5d7d2c2022776f726c644964223a2022776f726c6469645f62303961656435343933326338663531222c202273747265616d4964223a2022706172746974696f6e69645f336163663539386165623861336438333a626561636f6e2e68616c6c3a73747265616d222c202274656e616e744964223a202274656e616e7469645f34343361646661343731343037383064222c2022636f6d6d616e644964223a2022636f6d6d616e6469645f64313866653533316662633537656539222c20227265636f726465644174223a2022323032362d31302d32305430363a35323a31382e3934305a222c202274696d656c696e654964223a202274696d656c696e6569645f61393434613164363132393434393736222c20226174747269627574696f6e223a207b226566666563746976654163746f724964223a202273696d756c61746f722d7363656e6172696f222c202263617573616c526f6f74416374696f6e4964223a2022636f6d6d616e6469645f32323237633738333539626436663161222c2022617574686f726974794465636973696f6e4964223a2022617574686f726974793a636f6d6d616e6469645f64313866653533316662633537656539227d2c2022706172746974696f6e4964223a2022706172746974696f6e69645f336163663539386165623861336438333a626561636f6e2e68616c6c222c20227061796c6f616448617368223a20227368613235363a31373035613439363263393836303433633536633738323661326535643830393230383764383931303434333832363662366332313135663337313331353762222c202270726976616379436c617373223a20227075626c69635f7363656e65222c2022636f7272656c6174696f6e4964223a2022636f6d6d616e6469645f32323237633738333539626436663161222c2022736368656d6156657273696f6e223a20322c2022706f6c69637956657273696f6e73223a207b22726f7574696e65223a2022626561636f6e2d31227d2c202273696d756c6174696f6e54696d65223a2022313030313230222c202273747265616d53657175656e6365223a202239222c20226a6f75726e616c506f736974696f6e223a202239222c2022706172746974696f6e53657175656e6365223a202239227d
commandid_d18fe531fbc57ee9:event:3	tenantid_443adfa47140780d	worldid_b09aed54932c8f51	timelineid_a944a1d612944976	partitionid_3acf598aeb8a3d83:beacon.hall	beacon.hall	partitionid_3acf598aeb8a3d83:beacon.hall:stream	10	10	10	needs.changed	2	100120	2026-10-19 23:52:18.94-07	commandid_d18fe531fbc57ee9	commandid_2227c78359bd6f1a	\N	\N	\N	\N	public_scene	sha256:415337a997606b612e0345f141525e7343a8a62b20a133bc32e045688f9f5679	{"effectiveActorId": "simulator-scenario", "causalRootActionId": "commandid_2227c78359bd6f1a", "authorityDecisionId": "authority:commandid_d18fe531fbc57ee9"}	\N	{"routine": "beacon-1"}	{"kernelEvent": ["record", [["attribution", ["record", [["authorityDecisionId", ["string", "authority:commandid_d18fe531fbc57ee9"]], ["causalRootActionId", ["string", "commandid_2227c78359bd6f1a"]], ["effectiveActorId", ["string", "simulator-scenario"]]]]], ["commandId", ["string", "commandid_d18fe531fbc57ee9"]], ["eventId", ["string", "eventid_f831064646c398e6"]], ["eventIndex", ["integer", "6"]], ["partitionId", ["string", "partitionid_3acf598aeb8a3d83"]], ["payload", ["record", [["hunger", ["integer", "3166"]], ["hungerRemainder", ["bigint", "52000"]], ["integratedAt", ["bigint", "100120"]], ["objectId", ["string", "beacon.master"]], ["wetness", ["integer", "0"]], ["wetnessRemainder", ["bigint", "0"]]]]], ["policyVersions", ["record", [["routine", ["string", "beacon-1"]]]]], ["schemaVersion", ["integer", "1"]], ["simulationTime", ["bigint", "100120"]], ["tenantId", ["string", "tenantid_443adfa47140780d"]], ["timelineId", ["string", "timelineid_a944a1d612944976"]], ["type", ["string", "needs.changed"]], ["worldId", ["string", "worldid_b09aed54932c8f51"]]]]}	\\x7b2274797065223a20226e656564732e6368616e676564222c20226576656e744964223a2022636f6d6d616e6469645f643138666535333166626335376565393a6576656e743a33222c20227061796c6f6164223a207b226b65726e656c4576656e74223a205b227265636f7264222c205b5b226174747269627574696f6e222c205b227265636f7264222c205b5b22617574686f726974794465636973696f6e4964222c205b22737472696e67222c2022617574686f726974793a636f6d6d616e6469645f64313866653533316662633537656539225d5d2c205b2263617573616c526f6f74416374696f6e4964222c205b22737472696e67222c2022636f6d6d616e6469645f32323237633738333539626436663161225d5d2c205b226566666563746976654163746f724964222c205b22737472696e67222c202273696d756c61746f722d7363656e6172696f225d5d5d5d5d2c205b22636f6d6d616e644964222c205b22737472696e67222c2022636f6d6d616e6469645f64313866653533316662633537656539225d5d2c205b226576656e744964222c205b22737472696e67222c20226576656e7469645f66383331303634363436633339386536225d5d2c205b226576656e74496e646578222c205b22696e7465676572222c202236225d5d2c205b22706172746974696f6e4964222c205b22737472696e67222c2022706172746974696f6e69645f33616366353938616562386133643833225d5d2c205b227061796c6f6164222c205b227265636f7264222c205b5b2268756e676572222c205b22696e7465676572222c202233313636225d5d2c205b2268756e67657252656d61696e646572222c205b22626967696e74222c20223532303030225d5d2c205b22696e74656772617465644174222c205b22626967696e74222c2022313030313230225d5d2c205b226f626a6563744964222c205b22737472696e67222c2022626561636f6e2e6d6173746572225d5d2c205b227765746e657373222c205b22696e7465676572222c202230225d5d2c205b227765746e65737352656d61696e646572222c205b22626967696e74222c202230225d5d5d5d5d2c205b22706f6c69637956657273696f6e73222c205b227265636f7264222c205b5b22726f7574696e65222c205b22737472696e67222c2022626561636f6e2d31225d5d5d5d5d2c205b22736368656d6156657273696f6e222c205b22696e7465676572222c202231225d5d2c205b2273696d756c6174696f6e54696d65222c205b22626967696e74222c2022313030313230225d5d2c205b2274656e616e744964222c205b22737472696e67222c202274656e616e7469645f34343361646661343731343037383064225d5d2c205b2274696d656c696e654964222c205b22737472696e67222c202274696d656c696e6569645f61393434613164363132393434393736225d5d2c205b2274797065222c205b22737472696e67222c20226e656564732e6368616e676564225d5d2c205b22776f726c644964222c205b22737472696e67222c2022776f726c6469645f62303961656435343933326338663531225d5d5d5d7d2c2022776f726c644964223a2022776f726c6469645f62303961656435343933326338663531222c202273747265616d4964223a2022706172746974696f6e69645f336163663539386165623861336438333a626561636f6e2e68616c6c3a73747265616d222c202274656e616e744964223a202274656e616e7469645f34343361646661343731343037383064222c2022636f6d6d616e644964223a2022636f6d6d616e6469645f64313866653533316662633537656539222c20227265636f726465644174223a2022323032362d31302d32305430363a35323a31382e3934305a222c202274696d656c696e654964223a202274696d656c696e6569645f61393434613164363132393434393736222c20226174747269627574696f6e223a207b226566666563746976654163746f724964223a202273696d756c61746f722d7363656e6172696f222c202263617573616c526f6f74416374696f6e4964223a2022636f6d6d616e6469645f32323237633738333539626436663161222c2022617574686f726974794465636973696f6e4964223a2022617574686f726974793a636f6d6d616e6469645f64313866653533316662633537656539227d2c2022706172746974696f6e4964223a2022706172746974696f6e69645f336163663539386165623861336438333a626561636f6e2e68616c6c222c20227061796c6f616448617368223a20227368613235363a34313533333761393937363036623631326530333435663134313532356537333433613861363262323061313333626333326530343536383866396635363739222c202270726976616379436c617373223a20227075626c69635f7363656e65222c2022636f7272656c6174696f6e4964223a2022636f6d6d616e6469645f32323237633738333539626436663161222c2022736368656d6156657273696f6e223a20322c2022706f6c69637956657273696f6e73223a207b22726f7574696e65223a2022626561636f6e2d31227d2c202273696d756c6174696f6e54696d65223a2022313030313230222c202273747265616d53657175656e6365223a20223130222c20226a6f75726e616c506f736974696f6e223a20223130222c2022706172746974696f6e53657175656e6365223a20223130227d
commandid_d18fe531fbc57ee9:event:4	tenantid_443adfa47140780d	worldid_b09aed54932c8f51	timelineid_a944a1d612944976	partitionid_3acf598aeb8a3d83:beacon.hall	beacon.hall	partitionid_3acf598aeb8a3d83:beacon.hall:stream	11	11	11	wellbeing.integrated	2	100120	2026-10-19 23:52:18.94-07	commandid_d18fe531fbc57ee9	commandid_2227c78359bd6f1a	\N	\N	\N	\N	public_scene	sha256:d7b15f5a0f0c7b0b2292d986c70b96fa9d9953c9a8bc2779b6432e085c8b3d59	{"effectiveActorId": "simulator-scenario", "causalRootActionId": "commandid_2227c78359bd6f1a", "authorityDecisionId": "authority:commandid_d18fe531fbc57ee9"}	\N	{"routine": "beacon-1"}	{"kernelEvent": ["record", [["attribution", ["record", [["authorityDecisionId", ["string", "authority:commandid_d18fe531fbc57ee9"]], ["causalRootActionId", ["string", "commandid_2227c78359bd6f1a"]], ["effectiveActorId", ["string", "simulator-scenario"]]]]], ["commandId", ["string", "commandid_d18fe531fbc57ee9"]], ["eventId", ["string", "eventid_0dc216e9111c1d77"]], ["eventIndex", ["integer", "7"]], ["partitionId", ["string", "partitionid_3acf598aeb8a3d83"]], ["payload", ["record", [["health", ["integer", "10000"]], ["healthRemainder", ["bigint", "0"]], ["integratedAt", ["bigint", "100120"]], ["objectId", ["string", "beacon.master"]], ["thirst", ["integer", "83"]], ["thirstRemainder", ["bigint", "26000"]]]]], ["policyVersions", ["record", [["routine", ["string", "beacon-1"]]]]], ["schemaVersion", ["integer", "1"]], ["simulationTime", ["bigint", "100120"]], ["tenantId", ["string", "tenantid_443adfa47140780d"]], ["timelineId", ["string", "timelineid_a944a1d612944976"]], ["type", ["string", "wellbeing.integrated"]], ["worldId", ["string", "worldid_b09aed54932c8f51"]]]]}	\\x7b2274797065223a202277656c6c6265696e672e696e7465677261746564222c20226576656e744964223a2022636f6d6d616e6469645f643138666535333166626335376565393a6576656e743a34222c20227061796c6f6164223a207b226b65726e656c4576656e74223a205b227265636f7264222c205b5b226174747269627574696f6e222c205b227265636f7264222c205b5b22617574686f726974794465636973696f6e4964222c205b22737472696e67222c2022617574686f726974793a636f6d6d616e6469645f64313866653533316662633537656539225d5d2c205b2263617573616c526f6f74416374696f6e4964222c205b22737472696e67222c2022636f6d6d616e6469645f32323237633738333539626436663161225d5d2c205b226566666563746976654163746f724964222c205b22737472696e67222c202273696d756c61746f722d7363656e6172696f225d5d5d5d5d2c205b22636f6d6d616e644964222c205b22737472696e67222c2022636f6d6d616e6469645f64313866653533316662633537656539225d5d2c205b226576656e744964222c205b22737472696e67222c20226576656e7469645f30646332313665393131316331643737225d5d2c205b226576656e74496e646578222c205b22696e7465676572222c202237225d5d2c205b22706172746974696f6e4964222c205b22737472696e67222c2022706172746974696f6e69645f33616366353938616562386133643833225d5d2c205b227061796c6f6164222c205b227265636f7264222c205b5b226865616c7468222c205b22696e7465676572222c20223130303030225d5d2c205b226865616c746852656d61696e646572222c205b22626967696e74222c202230225d5d2c205b22696e74656772617465644174222c205b22626967696e74222c2022313030313230225d5d2c205b226f626a6563744964222c205b22737472696e67222c2022626561636f6e2e6d6173746572225d5d2c205b22746869727374222c205b22696e7465676572222c20223833225d5d2c205b2274686972737452656d61696e646572222c205b22626967696e74222c20223236303030225d5d5d5d5d2c205b22706f6c69637956657273696f6e73222c205b227265636f7264222c205b5b22726f7574696e65222c205b22737472696e67222c2022626561636f6e2d31225d5d5d5d5d2c205b22736368656d6156657273696f6e222c205b22696e7465676572222c202231225d5d2c205b2273696d756c6174696f6e54696d65222c205b22626967696e74222c2022313030313230225d5d2c205b2274656e616e744964222c205b22737472696e67222c202274656e616e7469645f34343361646661343731343037383064225d5d2c205b2274696d656c696e654964222c205b22737472696e67222c202274696d656c696e6569645f61393434613164363132393434393736225d5d2c205b2274797065222c205b22737472696e67222c202277656c6c6265696e672e696e7465677261746564225d5d2c205b22776f726c644964222c205b22737472696e67222c2022776f726c6469645f62303961656435343933326338663531225d5d5d5d7d2c2022776f726c644964223a2022776f726c6469645f62303961656435343933326338663531222c202273747265616d4964223a2022706172746974696f6e69645f336163663539386165623861336438333a626561636f6e2e68616c6c3a73747265616d222c202274656e616e744964223a202274656e616e7469645f34343361646661343731343037383064222c2022636f6d6d616e644964223a2022636f6d6d616e6469645f64313866653533316662633537656539222c20227265636f726465644174223a2022323032362d31302d32305430363a35323a31382e3934305a222c202274696d656c696e654964223a202274696d656c696e6569645f61393434613164363132393434393736222c20226174747269627574696f6e223a207b226566666563746976654163746f724964223a202273696d756c61746f722d7363656e6172696f222c202263617573616c526f6f74416374696f6e4964223a2022636f6d6d616e6469645f32323237633738333539626436663161222c2022617574686f726974794465636973696f6e4964223a2022617574686f726974793a636f6d6d616e6469645f64313866653533316662633537656539227d2c2022706172746974696f6e4964223a2022706172746974696f6e69645f336163663539386165623861336438333a626561636f6e2e68616c6c222c20227061796c6f616448617368223a20227368613235363a64376231356635613066306337623062323239326439383663373062393666613964393935336339613862633237373962363433326530383563386233643539222c202270726976616379436c617373223a20227075626c69635f7363656e65222c2022636f7272656c6174696f6e4964223a2022636f6d6d616e6469645f32323237633738333539626436663161222c2022736368656d6156657273696f6e223a20322c2022706f6c69637956657273696f6e73223a207b22726f7574696e65223a2022626561636f6e2d31227d2c202273696d756c6174696f6e54696d65223a2022313030313230222c202273747265616d53657175656e6365223a20223131222c20226a6f75726e616c506f736974696f6e223a20223131222c2022706172746974696f6e53657175656e6365223a20223131227d
commandid_d18fe531fbc57ee9:event:5	tenantid_443adfa47140780d	worldid_b09aed54932c8f51	timelineid_a944a1d612944976	partitionid_3acf598aeb8a3d83:beacon.hall	beacon.hall	partitionid_3acf598aeb8a3d83:beacon.hall:stream	12	12	12	movement.completed	2	100120	2026-10-19 23:52:18.94-07	commandid_d18fe531fbc57ee9	commandid_2227c78359bd6f1a	\N	\N	\N	\N	public_scene	sha256:ab602807edc412e0c125a094f5b31efbafe087897ba0a28bedfd955559bcd443	{"effectiveActorId": "simulator-scenario", "causalRootActionId": "commandid_2227c78359bd6f1a", "authorityDecisionId": "authority:commandid_d18fe531fbc57ee9"}	\N	{"routine": "beacon-1"}	{"kernelEvent": ["record", [["attribution", ["record", [["authorityDecisionId", ["string", "authority:commandid_d18fe531fbc57ee9"]], ["causalRootActionId", ["string", "commandid_2227c78359bd6f1a"]], ["effectiveActorId", ["string", "simulator-scenario"]]]]], ["commandId", ["string", "commandid_d18fe531fbc57ee9"]], ["eventId", ["string", "eventid_7fc316483db4a824"]], ["eventIndex", ["integer", "8"]], ["partitionId", ["string", "partitionid_3acf598aeb8a3d83"]], ["payload", ["record", [["movementId", ["string", "movement-commandid_c6999b77a9a5d639"]], ["objectId", ["string", "beacon.master"]]]]], ["policyVersions", ["record", [["routine", ["string", "beacon-1"]]]]], ["schemaVersion", ["integer", "1"]], ["simulationTime", ["bigint", "100120"]], ["tenantId", ["string", "tenantid_443adfa47140780d"]], ["timelineId", ["string", "timelineid_a944a1d612944976"]], ["type", ["string", "movement.completed"]], ["worldId", ["string", "worldid_b09aed54932c8f51"]]]]}	\\x7b2274797065223a20226d6f76656d656e742e636f6d706c65746564222c20226576656e744964223a2022636f6d6d616e6469645f643138666535333166626335376565393a6576656e743a35222c20227061796c6f6164223a207b226b65726e656c4576656e74223a205b227265636f7264222c205b5b226174747269627574696f6e222c205b227265636f7264222c205b5b22617574686f726974794465636973696f6e4964222c205b22737472696e67222c2022617574686f726974793a636f6d6d616e6469645f64313866653533316662633537656539225d5d2c205b2263617573616c526f6f74416374696f6e4964222c205b22737472696e67222c2022636f6d6d616e6469645f32323237633738333539626436663161225d5d2c205b226566666563746976654163746f724964222c205b22737472696e67222c202273696d756c61746f722d7363656e6172696f225d5d5d5d5d2c205b22636f6d6d616e644964222c205b22737472696e67222c2022636f6d6d616e6469645f64313866653533316662633537656539225d5d2c205b226576656e744964222c205b22737472696e67222c20226576656e7469645f37666333313634383364623461383234225d5d2c205b226576656e74496e646578222c205b22696e7465676572222c202238225d5d2c205b22706172746974696f6e4964222c205b22737472696e67222c2022706172746974696f6e69645f33616366353938616562386133643833225d5d2c205b227061796c6f6164222c205b227265636f7264222c205b5b226d6f76656d656e744964222c205b22737472696e67222c20226d6f76656d656e742d636f6d6d616e6469645f63363939396237376139613564363339225d5d2c205b226f626a6563744964222c205b22737472696e67222c2022626561636f6e2e6d6173746572225d5d5d5d5d2c205b22706f6c69637956657273696f6e73222c205b227265636f7264222c205b5b22726f7574696e65222c205b22737472696e67222c2022626561636f6e2d31225d5d5d5d5d2c205b22736368656d6156657273696f6e222c205b22696e7465676572222c202231225d5d2c205b2273696d756c6174696f6e54696d65222c205b22626967696e74222c2022313030313230225d5d2c205b2274656e616e744964222c205b22737472696e67222c202274656e616e7469645f34343361646661343731343037383064225d5d2c205b2274696d656c696e654964222c205b22737472696e67222c202274696d656c696e6569645f61393434613164363132393434393736225d5d2c205b2274797065222c205b22737472696e67222c20226d6f76656d656e742e636f6d706c65746564225d5d2c205b22776f726c644964222c205b22737472696e67222c2022776f726c6469645f62303961656435343933326338663531225d5d5d5d7d2c2022776f726c644964223a2022776f726c6469645f62303961656435343933326338663531222c202273747265616d4964223a2022706172746974696f6e69645f336163663539386165623861336438333a626561636f6e2e68616c6c3a73747265616d222c202274656e616e744964223a202274656e616e7469645f34343361646661343731343037383064222c2022636f6d6d616e644964223a2022636f6d6d616e6469645f64313866653533316662633537656539222c20227265636f726465644174223a2022323032362d31302d32305430363a35323a31382e3934305a222c202274696d656c696e654964223a202274696d656c696e6569645f61393434613164363132393434393736222c20226174747269627574696f6e223a207b226566666563746976654163746f724964223a202273696d756c61746f722d7363656e6172696f222c202263617573616c526f6f74416374696f6e4964223a2022636f6d6d616e6469645f32323237633738333539626436663161222c2022617574686f726974794465636973696f6e4964223a2022617574686f726974793a636f6d6d616e6469645f64313866653533316662633537656539227d2c2022706172746974696f6e4964223a2022706172746974696f6e69645f336163663539386165623861336438333a626561636f6e2e68616c6c222c20227061796c6f616448617368223a20227368613235363a61623630323830376564633431326530633132356130393466356233316566626166653038373839376261306132386265646664393535353539626364343433222c202270726976616379436c617373223a20227075626c69635f7363656e65222c2022636f7272656c6174696f6e4964223a2022636f6d6d616e6469645f32323237633738333539626436663161222c2022736368656d6156657273696f6e223a20322c2022706f6c69637956657273696f6e73223a207b22726f7574696e65223a2022626561636f6e2d31227d2c202273696d756c6174696f6e54696d65223a2022313030313230222c202273747265616d53657175656e6365223a20223132222c20226a6f75726e616c506f736974696f6e223a20223132222c2022706172746974696f6e53657175656e6365223a20223132227d
commandid_d18fe531fbc57ee9:event:6	tenantid_443adfa47140780d	worldid_b09aed54932c8f51	timelineid_a944a1d612944976	partitionid_3acf598aeb8a3d83:beacon.hall	beacon.hall	partitionid_3acf598aeb8a3d83:beacon.hall:stream	13	13	13	resource.consumed	2	100120	2026-10-19 23:52:18.94-07	commandid_d18fe531fbc57ee9	commandid_2227c78359bd6f1a	\N	\N	\N	\N	public_scene	sha256:56ab74394c5406354a444591b66c6357a77aaf4f6362c2abdd842d6fcd2b30e0	{"effectiveActorId": "simulator-scenario", "causalRootActionId": "commandid_2227c78359bd6f1a", "authorityDecisionId": "authority:commandid_d18fe531fbc57ee9"}	\N	{"routine": "beacon-1"}	{"kernelEvent": ["record", [["attribution", ["record", [["authorityDecisionId", ["string", "authority:commandid_d18fe531fbc57ee9"]], ["causalRootActionId", ["string", "commandid_2227c78359bd6f1a"]], ["effectiveActorId", ["string", "simulator-scenario"]]]]], ["commandId", ["string", "commandid_d18fe531fbc57ee9"]], ["eventId", ["string", "eventid_424f1b154fe0e215"]], ["eventIndex", ["integer", "9"]], ["partitionId", ["string", "partitionid_3acf598aeb8a3d83"]], ["payload", ["record", [["kind", ["string", "food"]], ["objectId", ["string", "beacon.larder"]], ["quantity", ["integer", "1"]]]]], ["policyVersions", ["record", [["routine", ["string", "beacon-1"]]]]], ["schemaVersion", ["integer", "1"]], ["simulationTime", ["bigint", "100120"]], ["tenantId", ["string", "tenantid_443adfa47140780d"]], ["timelineId", ["string", "timelineid_a944a1d612944976"]], ["type", ["string", "resource.consumed"]], ["worldId", ["string", "worldid_b09aed54932c8f51"]]]]}	\\x7b2274797065223a20227265736f757263652e636f6e73756d6564222c20226576656e744964223a2022636f6d6d616e6469645f643138666535333166626335376565393a6576656e743a36222c20227061796c6f6164223a207b226b65726e656c4576656e74223a205b227265636f7264222c205b5b226174747269627574696f6e222c205b227265636f7264222c205b5b22617574686f726974794465636973696f6e4964222c205b22737472696e67222c2022617574686f726974793a636f6d6d616e6469645f64313866653533316662633537656539225d5d2c205b2263617573616c526f6f74416374696f6e4964222c205b22737472696e67222c2022636f6d6d616e6469645f32323237633738333539626436663161225d5d2c205b226566666563746976654163746f724964222c205b22737472696e67222c202273696d756c61746f722d7363656e6172696f225d5d5d5d5d2c205b22636f6d6d616e644964222c205b22737472696e67222c2022636f6d6d616e6469645f64313866653533316662633537656539225d5d2c205b226576656e744964222c205b22737472696e67222c20226576656e7469645f34323466316231353466653065323135225d5d2c205b226576656e74496e646578222c205b22696e7465676572222c202239225d5d2c205b22706172746974696f6e4964222c205b22737472696e67222c2022706172746974696f6e69645f33616366353938616562386133643833225d5d2c205b227061796c6f6164222c205b227265636f7264222c205b5b226b696e64222c205b22737472696e67222c2022666f6f64225d5d2c205b226f626a6563744964222c205b22737472696e67222c2022626561636f6e2e6c6172646572225d5d2c205b227175616e74697479222c205b22696e7465676572222c202231225d5d5d5d5d2c205b22706f6c69637956657273696f6e73222c205b227265636f7264222c205b5b22726f7574696e65222c205b22737472696e67222c2022626561636f6e2d31225d5d5d5d5d2c205b22736368656d6156657273696f6e222c205b22696e7465676572222c202231225d5d2c205b2273696d756c6174696f6e54696d65222c205b22626967696e74222c2022313030313230225d5d2c205b2274656e616e744964222c205b22737472696e67222c202274656e616e7469645f34343361646661343731343037383064225d5d2c205b2274696d656c696e654964222c205b22737472696e67222c202274696d656c696e6569645f61393434613164363132393434393736225d5d2c205b2274797065222c205b22737472696e67222c20227265736f757263652e636f6e73756d6564225d5d2c205b22776f726c644964222c205b22737472696e67222c2022776f726c6469645f62303961656435343933326338663531225d5d5d5d7d2c2022776f726c644964223a2022776f726c6469645f62303961656435343933326338663531222c202273747265616d4964223a2022706172746974696f6e69645f336163663539386165623861336438333a626561636f6e2e68616c6c3a73747265616d222c202274656e616e744964223a202274656e616e7469645f34343361646661343731343037383064222c2022636f6d6d616e644964223a2022636f6d6d616e6469645f64313866653533316662633537656539222c20227265636f726465644174223a2022323032362d31302d32305430363a35323a31382e3934305a222c202274696d656c696e654964223a202274696d656c696e6569645f61393434613164363132393434393736222c20226174747269627574696f6e223a207b226566666563746976654163746f724964223a202273696d756c61746f722d7363656e6172696f222c202263617573616c526f6f74416374696f6e4964223a2022636f6d6d616e6469645f32323237633738333539626436663161222c2022617574686f726974794465636973696f6e4964223a2022617574686f726974793a636f6d6d616e6469645f64313866653533316662633537656539227d2c2022706172746974696f6e4964223a2022706172746974696f6e69645f336163663539386165623861336438333a626561636f6e2e68616c6c222c20227061796c6f616448617368223a20227368613235363a35366162373433393463353430363335346134343435393162363663363335376137376161663466363336326332616264643834326436666364326233306530222c202270726976616379436c617373223a20227075626c69635f7363656e65222c2022636f7272656c6174696f6e4964223a2022636f6d6d616e6469645f32323237633738333539626436663161222c2022736368656d6156657273696f6e223a20322c2022706f6c69637956657273696f6e73223a207b22726f7574696e65223a2022626561636f6e2d31227d2c202273696d756c6174696f6e54696d65223a2022313030313230222c202273747265616d53657175656e6365223a20223133222c20226a6f75726e616c506f736974696f6e223a20223133222c2022706172746974696f6e53657175656e6365223a20223133227d
commandid_d18fe531fbc57ee9:event:7	tenantid_443adfa47140780d	worldid_b09aed54932c8f51	timelineid_a944a1d612944976	partitionid_3acf598aeb8a3d83:beacon.hall	beacon.hall	partitionid_3acf598aeb8a3d83:beacon.hall:stream	14	14	14	needs.relieved	2	100120	2026-10-19 23:52:18.94-07	commandid_d18fe531fbc57ee9	commandid_2227c78359bd6f1a	\N	\N	\N	\N	public_scene	sha256:e96b00b530cbdd3e9ee9ea49280ee1eea4ce42e841db0288edc953c4f1b77115	{"effectiveActorId": "simulator-scenario", "causalRootActionId": "commandid_2227c78359bd6f1a", "authorityDecisionId": "authority:commandid_d18fe531fbc57ee9"}	\N	{"routine": "beacon-1"}	{"kernelEvent": ["record", [["attribution", ["record", [["authorityDecisionId", ["string", "authority:commandid_d18fe531fbc57ee9"]], ["causalRootActionId", ["string", "commandid_2227c78359bd6f1a"]], ["effectiveActorId", ["string", "simulator-scenario"]]]]], ["commandId", ["string", "commandid_d18fe531fbc57ee9"]], ["eventId", ["string", "eventid_a918c24aa924f28d"]], ["eventIndex", ["integer", "10"]], ["partitionId", ["string", "partitionid_3acf598aeb8a3d83"]], ["payload", ["record", [["need", ["string", "hunger"]], ["objectId", ["string", "beacon.master"]], ["planId", ["string", "plan:beacon.master@100000"]], ["quantity", ["integer", "1"]], ["sourceObjectId", ["string", "beacon.larder"]], ["value", ["integer", "2166"]]]]], ["policyVersions", ["record", [["routine", ["string", "beacon-1"]]]]], ["schemaVersion", ["integer", "1"]], ["simulationTime", ["bigint", "100120"]], ["tenantId", ["string", "tenantid_443adfa47140780d"]], ["timelineId", ["string", "timelineid_a944a1d612944976"]], ["type", ["string", "needs.relieved"]], ["worldId", ["string", "worldid_b09aed54932c8f51"]]]]}	\\x7b2274797065223a20226e656564732e72656c6965766564222c20226576656e744964223a2022636f6d6d616e6469645f643138666535333166626335376565393a6576656e743a37222c20227061796c6f6164223a207b226b65726e656c4576656e74223a205b227265636f7264222c205b5b226174747269627574696f6e222c205b227265636f7264222c205b5b22617574686f726974794465636973696f6e4964222c205b22737472696e67222c2022617574686f726974793a636f6d6d616e6469645f64313866653533316662633537656539225d5d2c205b2263617573616c526f6f74416374696f6e4964222c205b22737472696e67222c2022636f6d6d616e6469645f32323237633738333539626436663161225d5d2c205b226566666563746976654163746f724964222c205b22737472696e67222c202273696d756c61746f722d7363656e6172696f225d5d5d5d5d2c205b22636f6d6d616e644964222c205b22737472696e67222c2022636f6d6d616e6469645f64313866653533316662633537656539225d5d2c205b226576656e744964222c205b22737472696e67222c20226576656e7469645f61393138633234616139323466323864225d5d2c205b226576656e74496e646578222c205b22696e7465676572222c20223130225d5d2c205b22706172746974696f6e4964222c205b22737472696e67222c2022706172746974696f6e69645f33616366353938616562386133643833225d5d2c205b227061796c6f6164222c205b227265636f7264222c205b5b226e656564222c205b22737472696e67222c202268756e676572225d5d2c205b226f626a6563744964222c205b22737472696e67222c2022626561636f6e2e6d6173746572225d5d2c205b22706c616e4964222c205b22737472696e67222c2022706c616e3a626561636f6e2e6d617374657240313030303030225d5d2c205b227175616e74697479222c205b22696e7465676572222c202231225d5d2c205b22736f757263654f626a6563744964222c205b22737472696e67222c2022626561636f6e2e6c6172646572225d5d2c205b2276616c7565222c205b22696e7465676572222c202232313636225d5d5d5d5d2c205b22706f6c69637956657273696f6e73222c205b227265636f7264222c205b5b22726f7574696e65222c205b22737472696e67222c2022626561636f6e2d31225d5d5d5d5d2c205b22736368656d6156657273696f6e222c205b22696e7465676572222c202231225d5d2c205b2273696d756c6174696f6e54696d65222c205b22626967696e74222c2022313030313230225d5d2c205b2274656e616e744964222c205b22737472696e67222c202274656e616e7469645f34343361646661343731343037383064225d5d2c205b2274696d656c696e654964222c205b22737472696e67222c202274696d656c696e6569645f61393434613164363132393434393736225d5d2c205b2274797065222c205b22737472696e67222c20226e656564732e72656c6965766564225d5d2c205b22776f726c644964222c205b22737472696e67222c2022776f726c6469645f62303961656435343933326338663531225d5d5d5d7d2c2022776f726c644964223a2022776f726c6469645f62303961656435343933326338663531222c202273747265616d4964223a2022706172746974696f6e69645f336163663539386165623861336438333a626561636f6e2e68616c6c3a73747265616d222c202274656e616e744964223a202274656e616e7469645f34343361646661343731343037383064222c2022636f6d6d616e644964223a2022636f6d6d616e6469645f64313866653533316662633537656539222c20227265636f726465644174223a2022323032362d31302d32305430363a35323a31382e3934305a222c202274696d656c696e654964223a202274696d656c696e6569645f61393434613164363132393434393736222c20226174747269627574696f6e223a207b226566666563746976654163746f724964223a202273696d756c61746f722d7363656e6172696f222c202263617573616c526f6f74416374696f6e4964223a2022636f6d6d616e6469645f32323237633738333539626436663161222c2022617574686f726974794465636973696f6e4964223a2022617574686f726974793a636f6d6d616e6469645f64313866653533316662633537656539227d2c2022706172746974696f6e4964223a2022706172746974696f6e69645f336163663539386165623861336438333a626561636f6e2e68616c6c222c20227061796c6f616448617368223a20227368613235363a65393662303062353330636264643365396565396561343932383065653165656134636534326538343164623032383865646339353363346631623737313135222c202270726976616379436c617373223a20227075626c69635f7363656e65222c2022636f7272656c6174696f6e4964223a2022636f6d6d616e6469645f32323237633738333539626436663161222c2022736368656d6156657273696f6e223a20322c2022706f6c69637956657273696f6e73223a207b22726f7574696e65223a2022626561636f6e2d31227d2c202273696d756c6174696f6e54696d65223a2022313030313230222c202273747265616d53657175656e6365223a20223134222c20226a6f75726e616c506f736974696f6e223a20223134222c2022706172746974696f6e53657175656e6365223a20223134227d
commandid_d18fe531fbc57ee9:event:8	tenantid_443adfa47140780d	worldid_b09aed54932c8f51	timelineid_a944a1d612944976	partitionid_3acf598aeb8a3d83:beacon.hall	beacon.hall	partitionid_3acf598aeb8a3d83:beacon.hall:stream	15	15	15	needs.changed	2	160000	2026-10-19 23:52:18.94-07	commandid_d18fe531fbc57ee9	commandid_2227c78359bd6f1a	\N	\N	\N	\N	public_scene	sha256:bbf0ab8b313c16ac60a465f1297f7e95e56177f488d0e963788b54c7fff32639	{"effectiveActorId": "simulator-scenario", "causalRootActionId": "commandid_2227c78359bd6f1a", "authorityDecisionId": "authority:commandid_d18fe531fbc57ee9"}	\N	{"routine": "beacon-1"}	{"kernelEvent": ["record", [["attribution", ["record", [["authorityDecisionId", ["string", "authority:commandid_d18fe531fbc57ee9"]], ["causalRootActionId", ["string", "commandid_2227c78359bd6f1a"]], ["effectiveActorId", ["string", "simulator-scenario"]]]]], ["commandId", ["string", "commandid_d18fe531fbc57ee9"]], ["eventId", ["string", "eventid_79fb7dedb624f25c"]], ["eventIndex", ["integer", "11"]], ["partitionId", ["string", "partitionid_3acf598aeb8a3d83"]], ["payload", ["record", [["hunger", ["integer", "2266"]], ["hungerRemainder", ["bigint", "40000"]], ["integratedAt", ["bigint", "160000"]], ["objectId", ["string", "beacon.master"]], ["wetness", ["integer", "0"]], ["wetnessRemainder", ["bigint", "0"]]]]], ["policyVersions", ["record", [["routine", ["string", "beacon-1"]]]]], ["schemaVersion", ["integer", "1"]], ["simulationTime", ["bigint", "160000"]], ["tenantId", ["string", "tenantid_443adfa47140780d"]], ["timelineId", ["string", "timelineid_a944a1d612944976"]], ["type", ["string", "needs.changed"]], ["worldId", ["string", "worldid_b09aed54932c8f51"]]]]}	\\x7b2274797065223a20226e656564732e6368616e676564222c20226576656e744964223a2022636f6d6d616e6469645f643138666535333166626335376565393a6576656e743a38222c20227061796c6f6164223a207b226b65726e656c4576656e74223a205b227265636f7264222c205b5b226174747269627574696f6e222c205b227265636f7264222c205b5b22617574686f726974794465636973696f6e4964222c205b22737472696e67222c2022617574686f726974793a636f6d6d616e6469645f64313866653533316662633537656539225d5d2c205b2263617573616c526f6f74416374696f6e4964222c205b22737472696e67222c2022636f6d6d616e6469645f32323237633738333539626436663161225d5d2c205b226566666563746976654163746f724964222c205b22737472696e67222c202273696d756c61746f722d7363656e6172696f225d5d5d5d5d2c205b22636f6d6d616e644964222c205b22737472696e67222c2022636f6d6d616e6469645f64313866653533316662633537656539225d5d2c205b226576656e744964222c205b22737472696e67222c20226576656e7469645f37396662376465646236323466323563225d5d2c205b226576656e74496e646578222c205b22696e7465676572222c20223131225d5d2c205b22706172746974696f6e4964222c205b22737472696e67222c2022706172746974696f6e69645f33616366353938616562386133643833225d5d2c205b227061796c6f6164222c205b227265636f7264222c205b5b2268756e676572222c205b22696e7465676572222c202232323636225d5d2c205b2268756e67657252656d61696e646572222c205b22626967696e74222c20223430303030225d5d2c205b22696e74656772617465644174222c205b22626967696e74222c2022313630303030225d5d2c205b226f626a6563744964222c205b22737472696e67222c2022626561636f6e2e6d6173746572225d5d2c205b227765746e657373222c205b22696e7465676572222c202230225d5d2c205b227765746e65737352656d61696e646572222c205b22626967696e74222c202230225d5d5d5d5d2c205b22706f6c69637956657273696f6e73222c205b227265636f7264222c205b5b22726f7574696e65222c205b22737472696e67222c2022626561636f6e2d31225d5d5d5d5d2c205b22736368656d6156657273696f6e222c205b22696e7465676572222c202231225d5d2c205b2273696d756c6174696f6e54696d65222c205b22626967696e74222c2022313630303030225d5d2c205b2274656e616e744964222c205b22737472696e67222c202274656e616e7469645f34343361646661343731343037383064225d5d2c205b2274696d656c696e654964222c205b22737472696e67222c202274696d656c696e6569645f61393434613164363132393434393736225d5d2c205b2274797065222c205b22737472696e67222c20226e656564732e6368616e676564225d5d2c205b22776f726c644964222c205b22737472696e67222c2022776f726c6469645f62303961656435343933326338663531225d5d5d5d7d2c2022776f726c644964223a2022776f726c6469645f62303961656435343933326338663531222c202273747265616d4964223a2022706172746974696f6e69645f336163663539386165623861336438333a626561636f6e2e68616c6c3a73747265616d222c202274656e616e744964223a202274656e616e7469645f34343361646661343731343037383064222c2022636f6d6d616e644964223a2022636f6d6d616e6469645f64313866653533316662633537656539222c20227265636f726465644174223a2022323032362d31302d32305430363a35323a31382e3934305a222c202274696d656c696e654964223a202274696d656c696e6569645f61393434613164363132393434393736222c20226174747269627574696f6e223a207b226566666563746976654163746f724964223a202273696d756c61746f722d7363656e6172696f222c202263617573616c526f6f74416374696f6e4964223a2022636f6d6d616e6469645f32323237633738333539626436663161222c2022617574686f726974794465636973696f6e4964223a2022617574686f726974793a636f6d6d616e6469645f64313866653533316662633537656539227d2c2022706172746974696f6e4964223a2022706172746974696f6e69645f336163663539386165623861336438333a626561636f6e2e68616c6c222c20227061796c6f616448617368223a20227368613235363a62626630616238623331336331366163363061343635663132393766376539356535363137376634383864306539363337383862353463376666663332363339222c202270726976616379436c617373223a20227075626c69635f7363656e65222c2022636f7272656c6174696f6e4964223a2022636f6d6d616e6469645f32323237633738333539626436663161222c2022736368656d6156657273696f6e223a20322c2022706f6c69637956657273696f6e73223a207b22726f7574696e65223a2022626561636f6e2d31227d2c202273696d756c6174696f6e54696d65223a2022313630303030222c202273747265616d53657175656e6365223a20223135222c20226a6f75726e616c506f736974696f6e223a20223135222c2022706172746974696f6e53657175656e6365223a20223135227d
commandid_d18fe531fbc57ee9:event:9	tenantid_443adfa47140780d	worldid_b09aed54932c8f51	timelineid_a944a1d612944976	partitionid_3acf598aeb8a3d83:beacon.hall	beacon.hall	partitionid_3acf598aeb8a3d83:beacon.hall:stream	16	16	16	wellbeing.integrated	2	160000	2026-10-19 23:52:18.94-07	commandid_d18fe531fbc57ee9	commandid_2227c78359bd6f1a	\N	\N	\N	\N	public_scene	sha256:58aada8d0fde9248bd230bcd7313e36ed2257c0d7a989b1c6f3af1c5e65f1c1e	{"effectiveActorId": "simulator-scenario", "causalRootActionId": "commandid_2227c78359bd6f1a", "authorityDecisionId": "authority:commandid_d18fe531fbc57ee9"}	\N	{"routine": "beacon-1"}	{"kernelEvent": ["record", [["attribution", ["record", [["authorityDecisionId", ["string", "authority:commandid_d18fe531fbc57ee9"]], ["causalRootActionId", ["string", "commandid_2227c78359bd6f1a"]], ["effectiveActorId", ["string", "simulator-scenario"]]]]], ["commandId", ["string", "commandid_d18fe531fbc57ee9"]], ["eventId", ["string", "eventid_dfeced2c24c04f8b"]], ["eventIndex", ["integer", "12"]], ["partitionId", ["string", "partitionid_3acf598aeb8a3d83"]], ["payload", ["record", [["health", ["integer", "10000"]], ["healthRemainder", ["bigint", "0"]], ["integratedAt", ["bigint", "160000"]], ["objectId", ["string", "beacon.master"]], ["thirst", ["integer", "133"]], ["thirstRemainder", ["bigint", "20000"]]]]], ["policyVersions", ["record", [["routine", ["string", "beacon-1"]]]]], ["schemaVersion", ["integer", "1"]], ["simulationTime", ["bigint", "160000"]], ["tenantId", ["string", "tenantid_443adfa47140780d"]], ["timelineId", ["string", "timelineid_a944a1d612944976"]], ["type", ["string", "wellbeing.integrated"]], ["worldId", ["string", "worldid_b09aed54932c8f51"]]]]}	\\x7b2274797065223a202277656c6c6265696e672e696e7465677261746564222c20226576656e744964223a2022636f6d6d616e6469645f643138666535333166626335376565393a6576656e743a39222c20227061796c6f6164223a207b226b65726e656c4576656e74223a205b227265636f7264222c205b5b226174747269627574696f6e222c205b227265636f7264222c205b5b22617574686f726974794465636973696f6e4964222c205b22737472696e67222c2022617574686f726974793a636f6d6d616e6469645f64313866653533316662633537656539225d5d2c205b2263617573616c526f6f74416374696f6e4964222c205b22737472696e67222c2022636f6d6d616e6469645f32323237633738333539626436663161225d5d2c205b226566666563746976654163746f724964222c205b22737472696e67222c202273696d756c61746f722d7363656e6172696f225d5d5d5d5d2c205b22636f6d6d616e644964222c205b22737472696e67222c2022636f6d6d616e6469645f64313866653533316662633537656539225d5d2c205b226576656e744964222c205b22737472696e67222c20226576656e7469645f64666563656432633234633034663862225d5d2c205b226576656e74496e646578222c205b22696e7465676572222c20223132225d5d2c205b22706172746974696f6e4964222c205b22737472696e67222c2022706172746974696f6e69645f33616366353938616562386133643833225d5d2c205b227061796c6f6164222c205b227265636f7264222c205b5b226865616c7468222c205b22696e7465676572222c20223130303030225d5d2c205b226865616c746852656d61696e646572222c205b22626967696e74222c202230225d5d2c205b22696e74656772617465644174222c205b22626967696e74222c2022313630303030225d5d2c205b226f626a6563744964222c205b22737472696e67222c2022626561636f6e2e6d6173746572225d5d2c205b22746869727374222c205b22696e7465676572222c2022313333225d5d2c205b2274686972737452656d61696e646572222c205b22626967696e74222c20223230303030225d5d5d5d5d2c205b22706f6c69637956657273696f6e73222c205b227265636f7264222c205b5b22726f7574696e65222c205b22737472696e67222c2022626561636f6e2d31225d5d5d5d5d2c205b22736368656d6156657273696f6e222c205b22696e7465676572222c202231225d5d2c205b2273696d756c6174696f6e54696d65222c205b22626967696e74222c2022313630303030225d5d2c205b2274656e616e744964222c205b22737472696e67222c202274656e616e7469645f34343361646661343731343037383064225d5d2c205b2274696d656c696e654964222c205b22737472696e67222c202274696d656c696e6569645f61393434613164363132393434393736225d5d2c205b2274797065222c205b22737472696e67222c202277656c6c6265696e672e696e7465677261746564225d5d2c205b22776f726c644964222c205b22737472696e67222c2022776f726c6469645f62303961656435343933326338663531225d5d5d5d7d2c2022776f726c644964223a2022776f726c6469645f62303961656435343933326338663531222c202273747265616d4964223a2022706172746974696f6e69645f336163663539386165623861336438333a626561636f6e2e68616c6c3a73747265616d222c202274656e616e744964223a202274656e616e7469645f34343361646661343731343037383064222c2022636f6d6d616e644964223a2022636f6d6d616e6469645f64313866653533316662633537656539222c20227265636f726465644174223a2022323032362d31302d32305430363a35323a31382e3934305a222c202274696d656c696e654964223a202274696d656c696e6569645f61393434613164363132393434393736222c20226174747269627574696f6e223a207b226566666563746976654163746f724964223a202273696d756c61746f722d7363656e6172696f222c202263617573616c526f6f74416374696f6e4964223a2022636f6d6d616e6469645f32323237633738333539626436663161222c2022617574686f726974794465636973696f6e4964223a2022617574686f726974793a636f6d6d616e6469645f64313866653533316662633537656539227d2c2022706172746974696f6e4964223a2022706172746974696f6e69645f336163663539386165623861336438333a626561636f6e2e68616c6c222c20227061796c6f616448617368223a20227368613235363a35386161646138643066646539323438626432333062636437333133653336656432323537633064376139383962316336663361663163356536356631633165222c202270726976616379436c617373223a20227075626c69635f7363656e65222c2022636f7272656c6174696f6e4964223a2022636f6d6d616e6469645f32323237633738333539626436663161222c2022736368656d6156657273696f6e223a20322c2022706f6c69637956657273696f6e73223a207b22726f7574696e65223a2022626561636f6e2d31227d2c202273696d756c6174696f6e54696d65223a2022313630303030222c202273747265616d53657175656e6365223a20223136222c20226a6f75726e616c506f736974696f6e223a20223136222c2022706172746974696f6e53657175656e6365223a20223136227d
commandid_d18fe531fbc57ee9:event:10	tenantid_443adfa47140780d	worldid_b09aed54932c8f51	timelineid_a944a1d612944976	partitionid_3acf598aeb8a3d83:beacon.hall	beacon.hall	partitionid_3acf598aeb8a3d83:beacon.hall:stream	17	17	17	routine.selected	2	160000	2026-10-19 23:52:18.94-07	commandid_d18fe531fbc57ee9	commandid_2227c78359bd6f1a	\N	\N	\N	\N	public_scene	sha256:eb8de0abfb09e77f9295efc42cc4e054fe38cc37c4389e49a7748f2dfebd2431	{"effectiveActorId": "simulator-scenario", "causalRootActionId": "commandid_2227c78359bd6f1a", "authorityDecisionId": "authority:commandid_d18fe531fbc57ee9"}	\N	{"routine": "beacon-1"}	{"kernelEvent": ["record", [["attribution", ["record", [["authorityDecisionId", ["string", "authority:commandid_d18fe531fbc57ee9"]], ["causalRootActionId", ["string", "commandid_2227c78359bd6f1a"]], ["effectiveActorId", ["string", "simulator-scenario"]]]]], ["commandId", ["string", "commandid_d18fe531fbc57ee9"]], ["eventId", ["string", "eventid_7743ed3e2cde7f3a"]], ["eventIndex", ["integer", "13"]], ["partitionId", ["string", "partitionid_3acf598aeb8a3d83"]], ["payload", ["record", [["action", ["record", [["kind", ["string", "seek-water"]], ["targetObjectId", ["string", "beacon.cistern"]]]]], ["objectId", ["string", "beacon.master"]]]]], ["policyVersions", ["record", [["routine", ["string", "beacon-1"]]]]], ["schemaVersion", ["integer", "2"]], ["simulationTime", ["bigint", "160000"]], ["tenantId", ["string", "tenantid_443adfa47140780d"]], ["timelineId", ["string", "timelineid_a944a1d612944976"]], ["type", ["string", "routine.selected"]], ["worldId", ["string", "worldid_b09aed54932c8f51"]]]]}	\\x7b2274797065223a2022726f7574696e652e73656c6563746564222c20226576656e744964223a2022636f6d6d616e6469645f643138666535333166626335376565393a6576656e743a3130222c20227061796c6f6164223a207b226b65726e656c4576656e74223a205b227265636f7264222c205b5b226174747269627574696f6e222c205b227265636f7264222c205b5b22617574686f726974794465636973696f6e4964222c205b22737472696e67222c2022617574686f726974793a636f6d6d616e6469645f64313866653533316662633537656539225d5d2c205b2263617573616c526f6f74416374696f6e4964222c205b22737472696e67222c2022636f6d6d616e6469645f32323237633738333539626436663161225d5d2c205b226566666563746976654163746f724964222c205b22737472696e67222c202273696d756c61746f722d7363656e6172696f225d5d5d5d5d2c205b22636f6d6d616e644964222c205b22737472696e67222c2022636f6d6d616e6469645f64313866653533316662633537656539225d5d2c205b226576656e744964222c205b22737472696e67222c20226576656e7469645f37373433656433653263646537663361225d5d2c205b226576656e74496e646578222c205b22696e7465676572222c20223133225d5d2c205b22706172746974696f6e4964222c205b22737472696e67222c2022706172746974696f6e69645f33616366353938616562386133643833225d5d2c205b227061796c6f6164222c205b227265636f7264222c205b5b22616374696f6e222c205b227265636f7264222c205b5b226b696e64222c205b22737472696e67222c20227365656b2d7761746572225d5d2c205b227461726765744f626a6563744964222c205b22737472696e67222c2022626561636f6e2e6369737465726e225d5d5d5d5d2c205b226f626a6563744964222c205b22737472696e67222c2022626561636f6e2e6d6173746572225d5d5d5d5d2c205b22706f6c69637956657273696f6e73222c205b227265636f7264222c205b5b22726f7574696e65222c205b22737472696e67222c2022626561636f6e2d31225d5d5d5d5d2c205b22736368656d6156657273696f6e222c205b22696e7465676572222c202232225d5d2c205b2273696d756c6174696f6e54696d65222c205b22626967696e74222c2022313630303030225d5d2c205b2274656e616e744964222c205b22737472696e67222c202274656e616e7469645f34343361646661343731343037383064225d5d2c205b2274696d656c696e654964222c205b22737472696e67222c202274696d656c696e6569645f61393434613164363132393434393736225d5d2c205b2274797065222c205b22737472696e67222c2022726f7574696e652e73656c6563746564225d5d2c205b22776f726c644964222c205b22737472696e67222c2022776f726c6469645f62303961656435343933326338663531225d5d5d5d7d2c2022776f726c644964223a2022776f726c6469645f62303961656435343933326338663531222c202273747265616d4964223a2022706172746974696f6e69645f336163663539386165623861336438333a626561636f6e2e68616c6c3a73747265616d222c202274656e616e744964223a202274656e616e7469645f34343361646661343731343037383064222c2022636f6d6d616e644964223a2022636f6d6d616e6469645f64313866653533316662633537656539222c20227265636f726465644174223a2022323032362d31302d32305430363a35323a31382e3934305a222c202274696d656c696e654964223a202274696d656c696e6569645f61393434613164363132393434393736222c20226174747269627574696f6e223a207b226566666563746976654163746f724964223a202273696d756c61746f722d7363656e6172696f222c202263617573616c526f6f74416374696f6e4964223a2022636f6d6d616e6469645f32323237633738333539626436663161222c2022617574686f726974794465636973696f6e4964223a2022617574686f726974793a636f6d6d616e6469645f64313866653533316662633537656539227d2c2022706172746974696f6e4964223a2022706172746974696f6e69645f336163663539386165623861336438333a626561636f6e2e68616c6c222c20227061796c6f616448617368223a20227368613235363a65623864653061626662303965373766393239356566633432636334653035346665333863633337633433383965343961373734386632646665626432343331222c202270726976616379436c617373223a20227075626c69635f7363656e65222c2022636f7272656c6174696f6e4964223a2022636f6d6d616e6469645f32323237633738333539626436663161222c2022736368656d6156657273696f6e223a20322c2022706f6c69637956657273696f6e73223a207b22726f7574696e65223a2022626561636f6e2d31227d2c202273696d756c6174696f6e54696d65223a2022313630303030222c202273747265616d53657175656e6365223a20223137222c20226a6f75726e616c506f736974696f6e223a20223137222c2022706172746974696f6e53657175656e6365223a20223137227d
commandid_d18fe531fbc57ee9:event:11	tenantid_443adfa47140780d	worldid_b09aed54932c8f51	timelineid_a944a1d612944976	partitionid_3acf598aeb8a3d83:beacon.hall	beacon.hall	partitionid_3acf598aeb8a3d83:beacon.hall:stream	18	18	18	movement.started	2	160000	2026-10-19 23:52:18.94-07	commandid_d18fe531fbc57ee9	commandid_2227c78359bd6f1a	\N	\N	\N	\N	public_scene	sha256:81c48051b92d9dab17583c269423e63060af016414d3dd57da8ba7eb22be258e	{"effectiveActorId": "simulator-scenario", "causalRootActionId": "commandid_2227c78359bd6f1a", "authorityDecisionId": "authority:commandid_d18fe531fbc57ee9"}	\N	{"routine": "beacon-1"}	{"kernelEvent": ["record", [["attribution", ["record", [["authorityDecisionId", ["string", "authority:commandid_d18fe531fbc57ee9"]], ["causalRootActionId", ["string", "commandid_2227c78359bd6f1a"]], ["effectiveActorId", ["string", "simulator-scenario"]]]]], ["commandId", ["string", "commandid_d18fe531fbc57ee9"]], ["eventId", ["string", "eventid_110267ab19b9c409"]], ["eventIndex", ["integer", "14"]], ["partitionId", ["string", "partitionid_3acf598aeb8a3d83"]], ["payload", ["record", [["movement", ["record", [["anchorPath", ["array", []]], ["destination", ["record", [["kind", ["string", "pose"]], ["pose", ["record", [["coordinates", ["array", [["bigint", "200"], ["bigint", "100"]]]], ["frameId", ["string", "frame-hall"]], ["frameVersion", ["integer", "1"]]]]]]]], ["emitted", ["array", []]], ["exitedAtStart", ["array", []]], ["frameId", ["string", "frame-hall"]], ["frameVersion", ["integer", "1"]], ["initialInside", ["array", [["string", "hall"]]]], ["movementId", ["string", "movement-commandid_7035f536044905d7"]], ["segment", ["record", [["speed", ["record", [["kind", ["string", "constant-units-per-second"]], ["unitsPerSecond", ["bigint", "1000"]]]]], ["startTime", ["bigint", "160000"]], ["waypoints", ["array", [["array", [["bigint", "100"], ["bigint", "100"]]], ["array", [["bigint", "200"], ["bigint", "100"]]]]]]]]], ["status", ["string", "active"]]]]], ["objectId", ["string", "beacon.master"]]]]], ["policyVersions", ["record", [["routine", ["string", "beacon-1"]]]]], ["schemaVersion", ["integer", "1"]], ["simulationTime", ["bigint", "160000"]], ["tenantId", ["string", "tenantid_443adfa47140780d"]], ["timelineId", ["string", "timelineid_a944a1d612944976"]], ["type", ["string", "movement.started"]], ["worldId", ["string", "worldid_b09aed54932c8f51"]]]]}	\\x7b2274797065223a20226d6f76656d656e742e73746172746564222c20226576656e744964223a2022636f6d6d616e6469645f643138666535333166626335376565393a6576656e743a3131222c20227061796c6f6164223a207b226b65726e656c4576656e74223a205b227265636f7264222c205b5b226174747269627574696f6e222c205b227265636f7264222c205b5b22617574686f726974794465636973696f6e4964222c205b22737472696e67222c2022617574686f726974793a636f6d6d616e6469645f64313866653533316662633537656539225d5d2c205b2263617573616c526f6f74416374696f6e4964222c205b22737472696e67222c2022636f6d6d616e6469645f32323237633738333539626436663161225d5d2c205b226566666563746976654163746f724964222c205b22737472696e67222c202273696d756c61746f722d7363656e6172696f225d5d5d5d5d2c205b22636f6d6d616e644964222c205b22737472696e67222c2022636f6d6d616e6469645f64313866653533316662633537656539225d5d2c205b226576656e744964222c205b22737472696e67222c20226576656e7469645f31313032363761623139623963343039225d5d2c205b226576656e74496e646578222c205b22696e7465676572222c20223134225d5d2c205b22706172746974696f6e4964222c205b22737472696e67222c2022706172746974696f6e69645f33616366353938616562386133643833225d5d2c205b227061796c6f6164222c205b227265636f7264222c205b5b226d6f76656d656e74222c205b227265636f7264222c205b5b22616e63686f7250617468222c205b226172726179222c205b5d5d5d2c205b2264657374696e6174696f6e222c205b227265636f7264222c205b5b226b696e64222c205b22737472696e67222c2022706f7365225d5d2c205b22706f7365222c205b227265636f7264222c205b5b22636f6f7264696e61746573222c205b226172726179222c205b5b22626967696e74222c2022323030225d2c205b22626967696e74222c2022313030225d5d5d5d2c205b226672616d654964222c205b22737472696e67222c20226672616d652d68616c6c225d5d2c205b226672616d6556657273696f6e222c205b22696e7465676572222c202231225d5d5d5d5d5d5d5d2c205b22656d6974746564222c205b226172726179222c205b5d5d5d2c205b2265786974656441745374617274222c205b226172726179222c205b5d5d5d2c205b226672616d654964222c205b22737472696e67222c20226672616d652d68616c6c225d5d2c205b226672616d6556657273696f6e222c205b22696e7465676572222c202231225d5d2c205b22696e697469616c496e73696465222c205b226172726179222c205b5b22737472696e67222c202268616c6c225d5d5d5d2c205b226d6f76656d656e744964222c205b22737472696e67222c20226d6f76656d656e742d636f6d6d616e6469645f37303335663533363034343930356437225d5d2c205b227365676d656e74222c205b227265636f7264222c205b5b227370656564222c205b227265636f7264222c205b5b226b696e64222c205b22737472696e67222c2022636f6e7374616e742d756e6974732d7065722d7365636f6e64225d5d2c205b22756e6974735065725365636f6e64222c205b22626967696e74222c202231303030225d5d5d5d5d2c205b22737461727454696d65222c205b22626967696e74222c2022313630303030225d5d2c205b22776179706f696e7473222c205b226172726179222c205b5b226172726179222c205b5b22626967696e74222c2022313030225d2c205b22626967696e74222c2022313030225d5d5d2c205b226172726179222c205b5b22626967696e74222c2022323030225d2c205b22626967696e74222c2022313030225d5d5d5d5d5d5d5d5d2c205b22737461747573222c205b22737472696e67222c2022616374697665225d5d5d5d5d2c205b226f626a6563744964222c205b22737472696e67222c2022626561636f6e2e6d6173746572225d5d5d5d5d2c205b22706f6c69637956657273696f6e73222c205b227265636f7264222c205b5b22726f7574696e65222c205b22737472696e67222c2022626561636f6e2d31225d5d5d5d5d2c205b22736368656d6156657273696f6e222c205b22696e7465676572222c202231225d5d2c205b2273696d756c6174696f6e54696d65222c205b22626967696e74222c2022313630303030225d5d2c205b2274656e616e744964222c205b22737472696e67222c202274656e616e7469645f34343361646661343731343037383064225d5d2c205b2274696d656c696e654964222c205b22737472696e67222c202274696d656c696e6569645f61393434613164363132393434393736225d5d2c205b2274797065222c205b22737472696e67222c20226d6f76656d656e742e73746172746564225d5d2c205b22776f726c644964222c205b22737472696e67222c2022776f726c6469645f62303961656435343933326338663531225d5d5d5d7d2c2022776f726c644964223a2022776f726c6469645f62303961656435343933326338663531222c202273747265616d4964223a2022706172746974696f6e69645f336163663539386165623861336438333a626561636f6e2e68616c6c3a73747265616d222c202274656e616e744964223a202274656e616e7469645f34343361646661343731343037383064222c2022636f6d6d616e644964223a2022636f6d6d616e6469645f64313866653533316662633537656539222c20227265636f726465644174223a2022323032362d31302d32305430363a35323a31382e3934305a222c202274696d656c696e654964223a202274696d656c696e6569645f61393434613164363132393434393736222c20226174747269627574696f6e223a207b226566666563746976654163746f724964223a202273696d756c61746f722d7363656e6172696f222c202263617573616c526f6f74416374696f6e4964223a2022636f6d6d616e6469645f32323237633738333539626436663161222c2022617574686f726974794465636973696f6e4964223a2022617574686f726974793a636f6d6d616e6469645f64313866653533316662633537656539227d2c2022706172746974696f6e4964223a2022706172746974696f6e69645f336163663539386165623861336438333a626561636f6e2e68616c6c222c20227061796c6f616448617368223a20227368613235363a38316334383035316239326439646162313735383363323639343233653633303630616630313634313464336464353764613862613765623232626532353865222c202270726976616379436c617373223a20227075626c69635f7363656e65222c2022636f7272656c6174696f6e4964223a2022636f6d6d616e6469645f32323237633738333539626436663161222c2022736368656d6156657273696f6e223a20322c2022706f6c69637956657273696f6e73223a207b22726f7574696e65223a2022626561636f6e2d31227d2c202273696d756c6174696f6e54696d65223a2022313630303030222c202273747265616d53657175656e6365223a20223138222c20226a6f75726e616c506f736974696f6e223a20223138222c2022706172746974696f6e53657175656e6365223a20223138227d
commandid_d18fe531fbc57ee9:event:12	tenantid_443adfa47140780d	worldid_b09aed54932c8f51	timelineid_a944a1d612944976	partitionid_3acf598aeb8a3d83:beacon.hall	beacon.hall	partitionid_3acf598aeb8a3d83:beacon.hall:stream	19	19	19	movement.region-exited	2	160100	2026-10-19 23:52:18.94-07	commandid_d18fe531fbc57ee9	commandid_2227c78359bd6f1a	\N	\N	\N	\N	public_scene	sha256:b50c91ce7c1fafeb22954e14e24fbb144333060e2a961f8f2b274d31192d76fa	{"effectiveActorId": "simulator-scenario", "causalRootActionId": "commandid_2227c78359bd6f1a", "authorityDecisionId": "authority:commandid_d18fe531fbc57ee9"}	\N	{"routine": "beacon-1"}	{"kernelEvent": ["record", [["attribution", ["record", [["authorityDecisionId", ["string", "authority:commandid_d18fe531fbc57ee9"]], ["causalRootActionId", ["string", "commandid_2227c78359bd6f1a"]], ["effectiveActorId", ["string", "simulator-scenario"]]]]], ["commandId", ["string", "commandid_d18fe531fbc57ee9"]], ["eventId", ["string", "eventid_570cb4a41e07ce58"]], ["eventIndex", ["integer", "15"]], ["partitionId", ["string", "partitionid_3acf598aeb8a3d83"]], ["payload", ["record", [["movementId", ["string", "movement-commandid_7035f536044905d7"]], ["objectId", ["string", "beacon.master"]], ["regionId", ["string", "hall"]], ["regionVersion", ["integer", "1"]]]]], ["policyVersions", ["record", [["routine", ["string", "beacon-1"]]]]], ["schemaVersion", ["integer", "1"]], ["simulationTime", ["bigint", "160100"]], ["tenantId", ["string", "tenantid_443adfa47140780d"]], ["timelineId", ["string", "timelineid_a944a1d612944976"]], ["type", ["string", "movement.region-exited"]], ["worldId", ["string", "worldid_b09aed54932c8f51"]]]]}	\\x7b2274797065223a20226d6f76656d656e742e726567696f6e2d657869746564222c20226576656e744964223a2022636f6d6d616e6469645f643138666535333166626335376565393a6576656e743a3132222c20227061796c6f6164223a207b226b65726e656c4576656e74223a205b227265636f7264222c205b5b226174747269627574696f6e222c205b227265636f7264222c205b5b22617574686f726974794465636973696f6e4964222c205b22737472696e67222c2022617574686f726974793a636f6d6d616e6469645f64313866653533316662633537656539225d5d2c205b2263617573616c526f6f74416374696f6e4964222c205b22737472696e67222c2022636f6d6d616e6469645f32323237633738333539626436663161225d5d2c205b226566666563746976654163746f724964222c205b22737472696e67222c202273696d756c61746f722d7363656e6172696f225d5d5d5d5d2c205b22636f6d6d616e644964222c205b22737472696e67222c2022636f6d6d616e6469645f64313866653533316662633537656539225d5d2c205b226576656e744964222c205b22737472696e67222c20226576656e7469645f35373063623461343165303763653538225d5d2c205b226576656e74496e646578222c205b22696e7465676572222c20223135225d5d2c205b22706172746974696f6e4964222c205b22737472696e67222c2022706172746974696f6e69645f33616366353938616562386133643833225d5d2c205b227061796c6f6164222c205b227265636f7264222c205b5b226d6f76656d656e744964222c205b22737472696e67222c20226d6f76656d656e742d636f6d6d616e6469645f37303335663533363034343930356437225d5d2c205b226f626a6563744964222c205b22737472696e67222c2022626561636f6e2e6d6173746572225d5d2c205b22726567696f6e4964222c205b22737472696e67222c202268616c6c225d5d2c205b22726567696f6e56657273696f6e222c205b22696e7465676572222c202231225d5d5d5d5d2c205b22706f6c69637956657273696f6e73222c205b227265636f7264222c205b5b22726f7574696e65222c205b22737472696e67222c2022626561636f6e2d31225d5d5d5d5d2c205b22736368656d6156657273696f6e222c205b22696e7465676572222c202231225d5d2c205b2273696d756c6174696f6e54696d65222c205b22626967696e74222c2022313630313030225d5d2c205b2274656e616e744964222c205b22737472696e67222c202274656e616e7469645f34343361646661343731343037383064225d5d2c205b2274696d656c696e654964222c205b22737472696e67222c202274696d656c696e6569645f61393434613164363132393434393736225d5d2c205b2274797065222c205b22737472696e67222c20226d6f76656d656e742e726567696f6e2d657869746564225d5d2c205b22776f726c644964222c205b22737472696e67222c2022776f726c6469645f62303961656435343933326338663531225d5d5d5d7d2c2022776f726c644964223a2022776f726c6469645f62303961656435343933326338663531222c202273747265616d4964223a2022706172746974696f6e69645f336163663539386165623861336438333a626561636f6e2e68616c6c3a73747265616d222c202274656e616e744964223a202274656e616e7469645f34343361646661343731343037383064222c2022636f6d6d616e644964223a2022636f6d6d616e6469645f64313866653533316662633537656539222c20227265636f726465644174223a2022323032362d31302d32305430363a35323a31382e3934305a222c202274696d656c696e654964223a202274696d656c696e6569645f61393434613164363132393434393736222c20226174747269627574696f6e223a207b226566666563746976654163746f724964223a202273696d756c61746f722d7363656e6172696f222c202263617573616c526f6f74416374696f6e4964223a2022636f6d6d616e6469645f32323237633738333539626436663161222c2022617574686f726974794465636973696f6e4964223a2022617574686f726974793a636f6d6d616e6469645f64313866653533316662633537656539227d2c2022706172746974696f6e4964223a2022706172746974696f6e69645f336163663539386165623861336438333a626561636f6e2e68616c6c222c20227061796c6f616448617368223a20227368613235363a62353063393163653763316661666562323239353465313465323466626231343433333330363065326139363166386632623237346433313139326437366661222c202270726976616379436c617373223a20227075626c69635f7363656e65222c2022636f7272656c6174696f6e4964223a2022636f6d6d616e6469645f32323237633738333539626436663161222c2022736368656d6156657273696f6e223a20322c2022706f6c69637956657273696f6e73223a207b22726f7574696e65223a2022626561636f6e2d31227d2c202273696d756c6174696f6e54696d65223a2022313630313030222c202273747265616d53657175656e6365223a20223139222c20226a6f75726e616c506f736974696f6e223a20223139222c2022706172746974696f6e53657175656e6365223a20223139227d
commandid_d18fe531fbc57ee9:event:13	tenantid_443adfa47140780d	worldid_b09aed54932c8f51	timelineid_a944a1d612944976	partitionid_3acf598aeb8a3d83:beacon.hall	beacon.hall	partitionid_3acf598aeb8a3d83:beacon.hall:stream	20	20	20	needs.changed	2	160100	2026-10-19 23:52:18.94-07	commandid_d18fe531fbc57ee9	commandid_2227c78359bd6f1a	\N	\N	\N	\N	public_scene	sha256:8c5a1ddfbefad57734946488833f6d2aa7aad0a0b2490d27958dec0ac9de0fcc	{"effectiveActorId": "simulator-scenario", "causalRootActionId": "commandid_2227c78359bd6f1a", "authorityDecisionId": "authority:commandid_d18fe531fbc57ee9"}	\N	{"routine": "beacon-1"}	{"kernelEvent": ["record", [["attribution", ["record", [["authorityDecisionId", ["string", "authority:commandid_d18fe531fbc57ee9"]], ["causalRootActionId", ["string", "commandid_2227c78359bd6f1a"]], ["effectiveActorId", ["string", "simulator-scenario"]]]]], ["commandId", ["string", "commandid_d18fe531fbc57ee9"]], ["eventId", ["string", "eventid_0a3afbd52cd79a27"]], ["eventIndex", ["integer", "16"]], ["partitionId", ["string", "partitionid_3acf598aeb8a3d83"]], ["payload", ["record", [["hunger", ["integer", "2266"]], ["hungerRemainder", ["bigint", "50000"]], ["integratedAt", ["bigint", "160100"]], ["objectId", ["string", "beacon.master"]], ["wetness", ["integer", "0"]], ["wetnessRemainder", ["bigint", "0"]]]]], ["policyVersions", ["record", [["routine", ["string", "beacon-1"]]]]], ["schemaVersion", ["integer", "1"]], ["simulationTime", ["bigint", "160100"]], ["tenantId", ["string", "tenantid_443adfa47140780d"]], ["timelineId", ["string", "timelineid_a944a1d612944976"]], ["type", ["string", "needs.changed"]], ["worldId", ["string", "worldid_b09aed54932c8f51"]]]]}	\\x7b2274797065223a20226e656564732e6368616e676564222c20226576656e744964223a2022636f6d6d616e6469645f643138666535333166626335376565393a6576656e743a3133222c20227061796c6f6164223a207b226b65726e656c4576656e74223a205b227265636f7264222c205b5b226174747269627574696f6e222c205b227265636f7264222c205b5b22617574686f726974794465636973696f6e4964222c205b22737472696e67222c2022617574686f726974793a636f6d6d616e6469645f64313866653533316662633537656539225d5d2c205b2263617573616c526f6f74416374696f6e4964222c205b22737472696e67222c2022636f6d6d616e6469645f32323237633738333539626436663161225d5d2c205b226566666563746976654163746f724964222c205b22737472696e67222c202273696d756c61746f722d7363656e6172696f225d5d5d5d5d2c205b22636f6d6d616e644964222c205b22737472696e67222c2022636f6d6d616e6469645f64313866653533316662633537656539225d5d2c205b226576656e744964222c205b22737472696e67222c20226576656e7469645f30613361666264353263643739613237225d5d2c205b226576656e74496e646578222c205b22696e7465676572222c20223136225d5d2c205b22706172746974696f6e4964222c205b22737472696e67222c2022706172746974696f6e69645f33616366353938616562386133643833225d5d2c205b227061796c6f6164222c205b227265636f7264222c205b5b2268756e676572222c205b22696e7465676572222c202232323636225d5d2c205b2268756e67657252656d61696e646572222c205b22626967696e74222c20223530303030225d5d2c205b22696e74656772617465644174222c205b22626967696e74222c2022313630313030225d5d2c205b226f626a6563744964222c205b22737472696e67222c2022626561636f6e2e6d6173746572225d5d2c205b227765746e657373222c205b22696e7465676572222c202230225d5d2c205b227765746e65737352656d61696e646572222c205b22626967696e74222c202230225d5d5d5d5d2c205b22706f6c69637956657273696f6e73222c205b227265636f7264222c205b5b22726f7574696e65222c205b22737472696e67222c2022626561636f6e2d31225d5d5d5d5d2c205b22736368656d6156657273696f6e222c205b22696e7465676572222c202231225d5d2c205b2273696d756c6174696f6e54696d65222c205b22626967696e74222c2022313630313030225d5d2c205b2274656e616e744964222c205b22737472696e67222c202274656e616e7469645f34343361646661343731343037383064225d5d2c205b2274696d656c696e654964222c205b22737472696e67222c202274696d656c696e6569645f61393434613164363132393434393736225d5d2c205b2274797065222c205b22737472696e67222c20226e656564732e6368616e676564225d5d2c205b22776f726c644964222c205b22737472696e67222c2022776f726c6469645f62303961656435343933326338663531225d5d5d5d7d2c2022776f726c644964223a2022776f726c6469645f62303961656435343933326338663531222c202273747265616d4964223a2022706172746974696f6e69645f336163663539386165623861336438333a626561636f6e2e68616c6c3a73747265616d222c202274656e616e744964223a202274656e616e7469645f34343361646661343731343037383064222c2022636f6d6d616e644964223a2022636f6d6d616e6469645f64313866653533316662633537656539222c20227265636f726465644174223a2022323032362d31302d32305430363a35323a31382e3934305a222c202274696d656c696e654964223a202274696d656c696e6569645f61393434613164363132393434393736222c20226174747269627574696f6e223a207b226566666563746976654163746f724964223a202273696d756c61746f722d7363656e6172696f222c202263617573616c526f6f74416374696f6e4964223a2022636f6d6d616e6469645f32323237633738333539626436663161222c2022617574686f726974794465636973696f6e4964223a2022617574686f726974793a636f6d6d616e6469645f64313866653533316662633537656539227d2c2022706172746974696f6e4964223a2022706172746974696f6e69645f336163663539386165623861336438333a626561636f6e2e68616c6c222c20227061796c6f616448617368223a20227368613235363a38633561316464666265666164353737333439343634383838333366366432616137616164306130623234393064323739353864656330616339646530666363222c202270726976616379436c617373223a20227075626c69635f7363656e65222c2022636f7272656c6174696f6e4964223a2022636f6d6d616e6469645f32323237633738333539626436663161222c2022736368656d6156657273696f6e223a20322c2022706f6c69637956657273696f6e73223a207b22726f7574696e65223a2022626561636f6e2d31227d2c202273696d756c6174696f6e54696d65223a2022313630313030222c202273747265616d53657175656e6365223a20223230222c20226a6f75726e616c506f736974696f6e223a20223230222c2022706172746974696f6e53657175656e6365223a20223230227d
commandid_d18fe531fbc57ee9:event:14	tenantid_443adfa47140780d	worldid_b09aed54932c8f51	timelineid_a944a1d612944976	partitionid_3acf598aeb8a3d83:beacon.hall	beacon.hall	partitionid_3acf598aeb8a3d83:beacon.hall:stream	21	21	21	wellbeing.integrated	2	160100	2026-10-19 23:52:18.94-07	commandid_d18fe531fbc57ee9	commandid_2227c78359bd6f1a	\N	\N	\N	\N	public_scene	sha256:8d99f0bd19d05176072928fa53134bb7e8ae18b55d8779670beca465c3538d32	{"effectiveActorId": "simulator-scenario", "causalRootActionId": "commandid_2227c78359bd6f1a", "authorityDecisionId": "authority:commandid_d18fe531fbc57ee9"}	\N	{"routine": "beacon-1"}	{"kernelEvent": ["record", [["attribution", ["record", [["authorityDecisionId", ["string", "authority:commandid_d18fe531fbc57ee9"]], ["causalRootActionId", ["string", "commandid_2227c78359bd6f1a"]], ["effectiveActorId", ["string", "simulator-scenario"]]]]], ["commandId", ["string", "commandid_d18fe531fbc57ee9"]], ["eventId", ["string", "eventid_33e6d9a46589fe16"]], ["eventIndex", ["integer", "17"]], ["partitionId", ["string", "partitionid_3acf598aeb8a3d83"]], ["payload", ["record", [["health", ["integer", "10000"]], ["healthRemainder", ["bigint", "0"]], ["integratedAt", ["bigint", "160100"]], ["objectId", ["string", "beacon.master"]], ["thirst", ["integer", "133"]], ["thirstRemainder", ["bigint", "25000"]]]]], ["policyVersions", ["record", [["routine", ["string", "beacon-1"]]]]], ["schemaVersion", ["integer", "1"]], ["simulationTime", ["bigint", "160100"]], ["tenantId", ["string", "tenantid_443adfa47140780d"]], ["timelineId", ["string", "timelineid_a944a1d612944976"]], ["type", ["string", "wellbeing.integrated"]], ["worldId", ["string", "worldid_b09aed54932c8f51"]]]]}	\\x7b2274797065223a202277656c6c6265696e672e696e7465677261746564222c20226576656e744964223a2022636f6d6d616e6469645f643138666535333166626335376565393a6576656e743a3134222c20227061796c6f6164223a207b226b65726e656c4576656e74223a205b227265636f7264222c205b5b226174747269627574696f6e222c205b227265636f7264222c205b5b22617574686f726974794465636973696f6e4964222c205b22737472696e67222c2022617574686f726974793a636f6d6d616e6469645f64313866653533316662633537656539225d5d2c205b2263617573616c526f6f74416374696f6e4964222c205b22737472696e67222c2022636f6d6d616e6469645f32323237633738333539626436663161225d5d2c205b226566666563746976654163746f724964222c205b22737472696e67222c202273696d756c61746f722d7363656e6172696f225d5d5d5d5d2c205b22636f6d6d616e644964222c205b22737472696e67222c2022636f6d6d616e6469645f64313866653533316662633537656539225d5d2c205b226576656e744964222c205b22737472696e67222c20226576656e7469645f33336536643961343635383966653136225d5d2c205b226576656e74496e646578222c205b22696e7465676572222c20223137225d5d2c205b22706172746974696f6e4964222c205b22737472696e67222c2022706172746974696f6e69645f33616366353938616562386133643833225d5d2c205b227061796c6f6164222c205b227265636f7264222c205b5b226865616c7468222c205b22696e7465676572222c20223130303030225d5d2c205b226865616c746852656d61696e646572222c205b22626967696e74222c202230225d5d2c205b22696e74656772617465644174222c205b22626967696e74222c2022313630313030225d5d2c205b226f626a6563744964222c205b22737472696e67222c2022626561636f6e2e6d6173746572225d5d2c205b22746869727374222c205b22696e7465676572222c2022313333225d5d2c205b2274686972737452656d61696e646572222c205b22626967696e74222c20223235303030225d5d5d5d5d2c205b22706f6c69637956657273696f6e73222c205b227265636f7264222c205b5b22726f7574696e65222c205b22737472696e67222c2022626561636f6e2d31225d5d5d5d5d2c205b22736368656d6156657273696f6e222c205b22696e7465676572222c202231225d5d2c205b2273696d756c6174696f6e54696d65222c205b22626967696e74222c2022313630313030225d5d2c205b2274656e616e744964222c205b22737472696e67222c202274656e616e7469645f34343361646661343731343037383064225d5d2c205b2274696d656c696e654964222c205b22737472696e67222c202274696d656c696e6569645f61393434613164363132393434393736225d5d2c205b2274797065222c205b22737472696e67222c202277656c6c6265696e672e696e7465677261746564225d5d2c205b22776f726c644964222c205b22737472696e67222c2022776f726c6469645f62303961656435343933326338663531225d5d5d5d7d2c2022776f726c644964223a2022776f726c6469645f62303961656435343933326338663531222c202273747265616d4964223a2022706172746974696f6e69645f336163663539386165623861336438333a626561636f6e2e68616c6c3a73747265616d222c202274656e616e744964223a202274656e616e7469645f34343361646661343731343037383064222c2022636f6d6d616e644964223a2022636f6d6d616e6469645f64313866653533316662633537656539222c20227265636f726465644174223a2022323032362d31302d32305430363a35323a31382e3934305a222c202274696d656c696e654964223a202274696d656c696e6569645f61393434613164363132393434393736222c20226174747269627574696f6e223a207b226566666563746976654163746f724964223a202273696d756c61746f722d7363656e6172696f222c202263617573616c526f6f74416374696f6e4964223a2022636f6d6d616e6469645f32323237633738333539626436663161222c2022617574686f726974794465636973696f6e4964223a2022617574686f726974793a636f6d6d616e6469645f64313866653533316662633537656539227d2c2022706172746974696f6e4964223a2022706172746974696f6e69645f336163663539386165623861336438333a626561636f6e2e68616c6c222c20227061796c6f616448617368223a20227368613235363a38643939663062643139643035313736303732393238666135333133346262376538616531386235356438373739363730626563613436356333353338643332222c202270726976616379436c617373223a20227075626c69635f7363656e65222c2022636f7272656c6174696f6e4964223a2022636f6d6d616e6469645f32323237633738333539626436663161222c2022736368656d6156657273696f6e223a20322c2022706f6c69637956657273696f6e73223a207b22726f7574696e65223a2022626561636f6e2d31227d2c202273696d756c6174696f6e54696d65223a2022313630313030222c202273747265616d53657175656e6365223a20223231222c20226a6f75726e616c506f736974696f6e223a20223231222c2022706172746974696f6e53657175656e6365223a20223231227d
commandid_d18fe531fbc57ee9:event:15	tenantid_443adfa47140780d	worldid_b09aed54932c8f51	timelineid_a944a1d612944976	partitionid_3acf598aeb8a3d83:beacon.hall	beacon.hall	partitionid_3acf598aeb8a3d83:beacon.hall:stream	22	22	22	movement.completed	2	160100	2026-10-19 23:52:18.94-07	commandid_d18fe531fbc57ee9	commandid_2227c78359bd6f1a	\N	\N	\N	\N	public_scene	sha256:99ccb90941fb4a6a8bfca74f6a78aee258e64884f00839abfa61f788ec15d2ab	{"effectiveActorId": "simulator-scenario", "causalRootActionId": "commandid_2227c78359bd6f1a", "authorityDecisionId": "authority:commandid_d18fe531fbc57ee9"}	\N	{"routine": "beacon-1"}	{"kernelEvent": ["record", [["attribution", ["record", [["authorityDecisionId", ["string", "authority:commandid_d18fe531fbc57ee9"]], ["causalRootActionId", ["string", "commandid_2227c78359bd6f1a"]], ["effectiveActorId", ["string", "simulator-scenario"]]]]], ["commandId", ["string", "commandid_d18fe531fbc57ee9"]], ["eventId", ["string", "eventid_4f426abec464d445"]], ["eventIndex", ["integer", "18"]], ["partitionId", ["string", "partitionid_3acf598aeb8a3d83"]], ["payload", ["record", [["movementId", ["string", "movement-commandid_7035f536044905d7"]], ["objectId", ["string", "beacon.master"]]]]], ["policyVersions", ["record", [["routine", ["string", "beacon-1"]]]]], ["schemaVersion", ["integer", "1"]], ["simulationTime", ["bigint", "160100"]], ["tenantId", ["string", "tenantid_443adfa47140780d"]], ["timelineId", ["string", "timelineid_a944a1d612944976"]], ["type", ["string", "movement.completed"]], ["worldId", ["string", "worldid_b09aed54932c8f51"]]]]}	\\x7b2274797065223a20226d6f76656d656e742e636f6d706c65746564222c20226576656e744964223a2022636f6d6d616e6469645f643138666535333166626335376565393a6576656e743a3135222c20227061796c6f6164223a207b226b65726e656c4576656e74223a205b227265636f7264222c205b5b226174747269627574696f6e222c205b227265636f7264222c205b5b22617574686f726974794465636973696f6e4964222c205b22737472696e67222c2022617574686f726974793a636f6d6d616e6469645f64313866653533316662633537656539225d5d2c205b2263617573616c526f6f74416374696f6e4964222c205b22737472696e67222c2022636f6d6d616e6469645f32323237633738333539626436663161225d5d2c205b226566666563746976654163746f724964222c205b22737472696e67222c202273696d756c61746f722d7363656e6172696f225d5d5d5d5d2c205b22636f6d6d616e644964222c205b22737472696e67222c2022636f6d6d616e6469645f64313866653533316662633537656539225d5d2c205b226576656e744964222c205b22737472696e67222c20226576656e7469645f34663432366162656334363464343435225d5d2c205b226576656e74496e646578222c205b22696e7465676572222c20223138225d5d2c205b22706172746974696f6e4964222c205b22737472696e67222c2022706172746974696f6e69645f33616366353938616562386133643833225d5d2c205b227061796c6f6164222c205b227265636f7264222c205b5b226d6f76656d656e744964222c205b22737472696e67222c20226d6f76656d656e742d636f6d6d616e6469645f37303335663533363034343930356437225d5d2c205b226f626a6563744964222c205b22737472696e67222c2022626561636f6e2e6d6173746572225d5d5d5d5d2c205b22706f6c69637956657273696f6e73222c205b227265636f7264222c205b5b22726f7574696e65222c205b22737472696e67222c2022626561636f6e2d31225d5d5d5d5d2c205b22736368656d6156657273696f6e222c205b22696e7465676572222c202231225d5d2c205b2273696d756c6174696f6e54696d65222c205b22626967696e74222c2022313630313030225d5d2c205b2274656e616e744964222c205b22737472696e67222c202274656e616e7469645f34343361646661343731343037383064225d5d2c205b2274696d656c696e654964222c205b22737472696e67222c202274696d656c696e6569645f61393434613164363132393434393736225d5d2c205b2274797065222c205b22737472696e67222c20226d6f76656d656e742e636f6d706c65746564225d5d2c205b22776f726c644964222c205b22737472696e67222c2022776f726c6469645f62303961656435343933326338663531225d5d5d5d7d2c2022776f726c644964223a2022776f726c6469645f62303961656435343933326338663531222c202273747265616d4964223a2022706172746974696f6e69645f336163663539386165623861336438333a626561636f6e2e68616c6c3a73747265616d222c202274656e616e744964223a202274656e616e7469645f34343361646661343731343037383064222c2022636f6d6d616e644964223a2022636f6d6d616e6469645f64313866653533316662633537656539222c20227265636f726465644174223a2022323032362d31302d32305430363a35323a31382e3934305a222c202274696d656c696e654964223a202274696d656c696e6569645f61393434613164363132393434393736222c20226174747269627574696f6e223a207b226566666563746976654163746f724964223a202273696d756c61746f722d7363656e6172696f222c202263617573616c526f6f74416374696f6e4964223a2022636f6d6d616e6469645f32323237633738333539626436663161222c2022617574686f726974794465636973696f6e4964223a2022617574686f726974793a636f6d6d616e6469645f64313866653533316662633537656539227d2c2022706172746974696f6e4964223a2022706172746974696f6e69645f336163663539386165623861336438333a626561636f6e2e68616c6c222c20227061796c6f616448617368223a20227368613235363a39396363623930393431666234613661386266636137346636613738616565323538653634383834663030383339616266613631663738386563313564326162222c202270726976616379436c617373223a20227075626c69635f7363656e65222c2022636f7272656c6174696f6e4964223a2022636f6d6d616e6469645f32323237633738333539626436663161222c2022736368656d6156657273696f6e223a20322c2022706f6c69637956657273696f6e73223a207b22726f7574696e65223a2022626561636f6e2d31227d2c202273696d756c6174696f6e54696d65223a2022313630313030222c202273747265616d53657175656e6365223a20223232222c20226a6f75726e616c506f736974696f6e223a20223232222c2022706172746974696f6e53657175656e6365223a20223232227d
commandid_d18fe531fbc57ee9:event:16	tenantid_443adfa47140780d	worldid_b09aed54932c8f51	timelineid_a944a1d612944976	partitionid_3acf598aeb8a3d83:beacon.hall	beacon.hall	partitionid_3acf598aeb8a3d83:beacon.hall:stream	23	23	23	resource.consumed	2	160100	2026-10-19 23:52:18.94-07	commandid_d18fe531fbc57ee9	commandid_2227c78359bd6f1a	\N	\N	\N	\N	public_scene	sha256:d57f9bf32a95bb35ef27d241fa751c21107606d5f2bfbbe015ee738915e210e8	{"effectiveActorId": "simulator-scenario", "causalRootActionId": "commandid_2227c78359bd6f1a", "authorityDecisionId": "authority:commandid_d18fe531fbc57ee9"}	\N	{"routine": "beacon-1"}	{"kernelEvent": ["record", [["attribution", ["record", [["authorityDecisionId", ["string", "authority:commandid_d18fe531fbc57ee9"]], ["causalRootActionId", ["string", "commandid_2227c78359bd6f1a"]], ["effectiveActorId", ["string", "simulator-scenario"]]]]], ["commandId", ["string", "commandid_d18fe531fbc57ee9"]], ["eventId", ["string", "eventid_586af5dad476f414"]], ["eventIndex", ["integer", "19"]], ["partitionId", ["string", "partitionid_3acf598aeb8a3d83"]], ["payload", ["record", [["kind", ["string", "water"]], ["objectId", ["string", "beacon.cistern"]], ["quantity", ["integer", "1"]]]]], ["policyVersions", ["record", [["routine", ["string", "beacon-1"]]]]], ["schemaVersion", ["integer", "1"]], ["simulationTime", ["bigint", "160100"]], ["tenantId", ["string", "tenantid_443adfa47140780d"]], ["timelineId", ["string", "timelineid_a944a1d612944976"]], ["type", ["string", "resource.consumed"]], ["worldId", ["string", "worldid_b09aed54932c8f51"]]]]}	\\x7b2274797065223a20227265736f757263652e636f6e73756d6564222c20226576656e744964223a2022636f6d6d616e6469645f643138666535333166626335376565393a6576656e743a3136222c20227061796c6f6164223a207b226b65726e656c4576656e74223a205b227265636f7264222c205b5b226174747269627574696f6e222c205b227265636f7264222c205b5b22617574686f726974794465636973696f6e4964222c205b22737472696e67222c2022617574686f726974793a636f6d6d616e6469645f64313866653533316662633537656539225d5d2c205b2263617573616c526f6f74416374696f6e4964222c205b22737472696e67222c2022636f6d6d616e6469645f32323237633738333539626436663161225d5d2c205b226566666563746976654163746f724964222c205b22737472696e67222c202273696d756c61746f722d7363656e6172696f225d5d5d5d5d2c205b22636f6d6d616e644964222c205b22737472696e67222c2022636f6d6d616e6469645f64313866653533316662633537656539225d5d2c205b226576656e744964222c205b22737472696e67222c20226576656e7469645f35383661663564616434373666343134225d5d2c205b226576656e74496e646578222c205b22696e7465676572222c20223139225d5d2c205b22706172746974696f6e4964222c205b22737472696e67222c2022706172746974696f6e69645f33616366353938616562386133643833225d5d2c205b227061796c6f6164222c205b227265636f7264222c205b5b226b696e64222c205b22737472696e67222c20227761746572225d5d2c205b226f626a6563744964222c205b22737472696e67222c2022626561636f6e2e6369737465726e225d5d2c205b227175616e74697479222c205b22696e7465676572222c202231225d5d5d5d5d2c205b22706f6c69637956657273696f6e73222c205b227265636f7264222c205b5b22726f7574696e65222c205b22737472696e67222c2022626561636f6e2d31225d5d5d5d5d2c205b22736368656d6156657273696f6e222c205b22696e7465676572222c202231225d5d2c205b2273696d756c6174696f6e54696d65222c205b22626967696e74222c2022313630313030225d5d2c205b2274656e616e744964222c205b22737472696e67222c202274656e616e7469645f34343361646661343731343037383064225d5d2c205b2274696d656c696e654964222c205b22737472696e67222c202274696d656c696e6569645f61393434613164363132393434393736225d5d2c205b2274797065222c205b22737472696e67222c20227265736f757263652e636f6e73756d6564225d5d2c205b22776f726c644964222c205b22737472696e67222c2022776f726c6469645f62303961656435343933326338663531225d5d5d5d7d2c2022776f726c644964223a2022776f726c6469645f62303961656435343933326338663531222c202273747265616d4964223a2022706172746974696f6e69645f336163663539386165623861336438333a626561636f6e2e68616c6c3a73747265616d222c202274656e616e744964223a202274656e616e7469645f34343361646661343731343037383064222c2022636f6d6d616e644964223a2022636f6d6d616e6469645f64313866653533316662633537656539222c20227265636f726465644174223a2022323032362d31302d32305430363a35323a31382e3934305a222c202274696d656c696e654964223a202274696d656c696e6569645f61393434613164363132393434393736222c20226174747269627574696f6e223a207b226566666563746976654163746f724964223a202273696d756c61746f722d7363656e6172696f222c202263617573616c526f6f74416374696f6e4964223a2022636f6d6d616e6469645f32323237633738333539626436663161222c2022617574686f726974794465636973696f6e4964223a2022617574686f726974793a636f6d6d616e6469645f64313866653533316662633537656539227d2c2022706172746974696f6e4964223a2022706172746974696f6e69645f336163663539386165623861336438333a626561636f6e2e68616c6c222c20227061796c6f616448617368223a20227368613235363a64353766396266333261393562623335656632376432343166613735316332313130373630366435663262666262653031356565373338393135653231306538222c202270726976616379436c617373223a20227075626c69635f7363656e65222c2022636f7272656c6174696f6e4964223a2022636f6d6d616e6469645f32323237633738333539626436663161222c2022736368656d6156657273696f6e223a20322c2022706f6c69637956657273696f6e73223a207b22726f7574696e65223a2022626561636f6e2d31227d2c202273696d756c6174696f6e54696d65223a2022313630313030222c202273747265616d53657175656e6365223a20223233222c20226a6f75726e616c506f736974696f6e223a20223233222c2022706172746974696f6e53657175656e6365223a20223233227d
commandid_d18fe531fbc57ee9:event:17	tenantid_443adfa47140780d	worldid_b09aed54932c8f51	timelineid_a944a1d612944976	partitionid_3acf598aeb8a3d83:beacon.hall	beacon.hall	partitionid_3acf598aeb8a3d83:beacon.hall:stream	24	24	24	needs.relieved	2	160100	2026-10-19 23:52:18.94-07	commandid_d18fe531fbc57ee9	commandid_2227c78359bd6f1a	\N	\N	\N	\N	public_scene	sha256:b32a04ad11c1528348cf90c85d04bbd8fc73c9937dbca00760846da189d89000	{"effectiveActorId": "simulator-scenario", "causalRootActionId": "commandid_2227c78359bd6f1a", "authorityDecisionId": "authority:commandid_d18fe531fbc57ee9"}	\N	{"routine": "beacon-1"}	{"kernelEvent": ["record", [["attribution", ["record", [["authorityDecisionId", ["string", "authority:commandid_d18fe531fbc57ee9"]], ["causalRootActionId", ["string", "commandid_2227c78359bd6f1a"]], ["effectiveActorId", ["string", "simulator-scenario"]]]]], ["commandId", ["string", "commandid_d18fe531fbc57ee9"]], ["eventId", ["string", "eventid_e4c4e5e893f35bc4"]], ["eventIndex", ["integer", "20"]], ["partitionId", ["string", "partitionid_3acf598aeb8a3d83"]], ["payload", ["record", [["need", ["string", "thirst"]], ["objectId", ["string", "beacon.master"]], ["planId", ["string", "plan:beacon.master@160000"]], ["quantity", ["integer", "1"]], ["sourceObjectId", ["string", "beacon.cistern"]], ["value", ["integer", "0"]]]]], ["policyVersions", ["record", [["routine", ["string", "beacon-1"]]]]], ["schemaVersion", ["integer", "1"]], ["simulationTime", ["bigint", "160100"]], ["tenantId", ["string", "tenantid_443adfa47140780d"]], ["timelineId", ["string", "timelineid_a944a1d612944976"]], ["type", ["string", "needs.relieved"]], ["worldId", ["string", "worldid_b09aed54932c8f51"]]]]}	\\x7b2274797065223a20226e656564732e72656c6965766564222c20226576656e744964223a2022636f6d6d616e6469645f643138666535333166626335376565393a6576656e743a3137222c20227061796c6f6164223a207b226b65726e656c4576656e74223a205b227265636f7264222c205b5b226174747269627574696f6e222c205b227265636f7264222c205b5b22617574686f726974794465636973696f6e4964222c205b22737472696e67222c2022617574686f726974793a636f6d6d616e6469645f64313866653533316662633537656539225d5d2c205b2263617573616c526f6f74416374696f6e4964222c205b22737472696e67222c2022636f6d6d616e6469645f32323237633738333539626436663161225d5d2c205b226566666563746976654163746f724964222c205b22737472696e67222c202273696d756c61746f722d7363656e6172696f225d5d5d5d5d2c205b22636f6d6d616e644964222c205b22737472696e67222c2022636f6d6d616e6469645f64313866653533316662633537656539225d5d2c205b226576656e744964222c205b22737472696e67222c20226576656e7469645f65346334653565383933663335626334225d5d2c205b226576656e74496e646578222c205b22696e7465676572222c20223230225d5d2c205b22706172746974696f6e4964222c205b22737472696e67222c2022706172746974696f6e69645f33616366353938616562386133643833225d5d2c205b227061796c6f6164222c205b227265636f7264222c205b5b226e656564222c205b22737472696e67222c2022746869727374225d5d2c205b226f626a6563744964222c205b22737472696e67222c2022626561636f6e2e6d6173746572225d5d2c205b22706c616e4964222c205b22737472696e67222c2022706c616e3a626561636f6e2e6d617374657240313630303030225d5d2c205b227175616e74697479222c205b22696e7465676572222c202231225d5d2c205b22736f757263654f626a6563744964222c205b22737472696e67222c2022626561636f6e2e6369737465726e225d5d2c205b2276616c7565222c205b22696e7465676572222c202230225d5d5d5d5d2c205b22706f6c69637956657273696f6e73222c205b227265636f7264222c205b5b22726f7574696e65222c205b22737472696e67222c2022626561636f6e2d31225d5d5d5d5d2c205b22736368656d6156657273696f6e222c205b22696e7465676572222c202231225d5d2c205b2273696d756c6174696f6e54696d65222c205b22626967696e74222c2022313630313030225d5d2c205b2274656e616e744964222c205b22737472696e67222c202274656e616e7469645f34343361646661343731343037383064225d5d2c205b2274696d656c696e654964222c205b22737472696e67222c202274696d656c696e6569645f61393434613164363132393434393736225d5d2c205b2274797065222c205b22737472696e67222c20226e656564732e72656c6965766564225d5d2c205b22776f726c644964222c205b22737472696e67222c2022776f726c6469645f62303961656435343933326338663531225d5d5d5d7d2c2022776f726c644964223a2022776f726c6469645f62303961656435343933326338663531222c202273747265616d4964223a2022706172746974696f6e69645f336163663539386165623861336438333a626561636f6e2e68616c6c3a73747265616d222c202274656e616e744964223a202274656e616e7469645f34343361646661343731343037383064222c2022636f6d6d616e644964223a2022636f6d6d616e6469645f64313866653533316662633537656539222c20227265636f726465644174223a2022323032362d31302d32305430363a35323a31382e3934305a222c202274696d656c696e654964223a202274696d656c696e6569645f61393434613164363132393434393736222c20226174747269627574696f6e223a207b226566666563746976654163746f724964223a202273696d756c61746f722d7363656e6172696f222c202263617573616c526f6f74416374696f6e4964223a2022636f6d6d616e6469645f32323237633738333539626436663161222c2022617574686f726974794465636973696f6e4964223a2022617574686f726974793a636f6d6d616e6469645f64313866653533316662633537656539227d2c2022706172746974696f6e4964223a2022706172746974696f6e69645f336163663539386165623861336438333a626561636f6e2e68616c6c222c20227061796c6f616448617368223a20227368613235363a62333261303461643131633135323833343863663930633835643034626264386663373363393933376462636130303736303834366461313839643839303030222c202270726976616379436c617373223a20227075626c69635f7363656e65222c2022636f7272656c6174696f6e4964223a2022636f6d6d616e6469645f32323237633738333539626436663161222c2022736368656d6156657273696f6e223a20322c2022706f6c69637956657273696f6e73223a207b22726f7574696e65223a2022626561636f6e2d31227d2c202273696d756c6174696f6e54696d65223a2022313630313030222c202273747265616d53657175656e6365223a20223234222c20226a6f75726e616c506f736974696f6e223a20223234222c2022706172746974696f6e53657175656e6365223a20223234227d
commandid_d18fe531fbc57ee9:event:18	tenantid_443adfa47140780d	worldid_b09aed54932c8f51	timelineid_a944a1d612944976	partitionid_3acf598aeb8a3d83:beacon.hall	beacon.hall	partitionid_3acf598aeb8a3d83:beacon.hall:stream	25	25	25	needs.changed	2	170000	2026-10-19 23:52:18.94-07	commandid_d18fe531fbc57ee9	commandid_2227c78359bd6f1a	\N	\N	\N	\N	public_scene	sha256:8d950ec7954b3b731c5f27925ad300d3127796506eb44984517a3b2008aefe4f	{"effectiveActorId": "simulator-scenario", "causalRootActionId": "commandid_2227c78359bd6f1a", "authorityDecisionId": "authority:commandid_d18fe531fbc57ee9"}	\N	{"routine": "beacon-1"}	{"kernelEvent": ["record", [["attribution", ["record", [["authorityDecisionId", ["string", "authority:commandid_d18fe531fbc57ee9"]], ["causalRootActionId", ["string", "commandid_2227c78359bd6f1a"]], ["effectiveActorId", ["string", "simulator-scenario"]]]]], ["commandId", ["string", "commandid_d18fe531fbc57ee9"]], ["eventId", ["string", "eventid_2b7f37dca71aa0b5"]], ["eventIndex", ["integer", "21"]], ["partitionId", ["string", "partitionid_3acf598aeb8a3d83"]], ["payload", ["record", [["hunger", ["integer", "2283"]], ["hungerRemainder", ["bigint", "20000"]], ["integratedAt", ["bigint", "170000"]], ["objectId", ["string", "beacon.master"]], ["wetness", ["integer", "0"]], ["wetnessRemainder", ["bigint", "0"]]]]], ["policyVersions", ["record", [["routine", ["string", "beacon-1"]]]]], ["schemaVersion", ["integer", "1"]], ["simulationTime", ["bigint", "170000"]], ["tenantId", ["string", "tenantid_443adfa47140780d"]], ["timelineId", ["string", "timelineid_a944a1d612944976"]], ["type", ["string", "needs.changed"]], ["worldId", ["string", "worldid_b09aed54932c8f51"]]]]}	\\x7b2274797065223a20226e656564732e6368616e676564222c20226576656e744964223a2022636f6d6d616e6469645f643138666535333166626335376565393a6576656e743a3138222c20227061796c6f6164223a207b226b65726e656c4576656e74223a205b227265636f7264222c205b5b226174747269627574696f6e222c205b227265636f7264222c205b5b22617574686f726974794465636973696f6e4964222c205b22737472696e67222c2022617574686f726974793a636f6d6d616e6469645f64313866653533316662633537656539225d5d2c205b2263617573616c526f6f74416374696f6e4964222c205b22737472696e67222c2022636f6d6d616e6469645f32323237633738333539626436663161225d5d2c205b226566666563746976654163746f724964222c205b22737472696e67222c202273696d756c61746f722d7363656e6172696f225d5d5d5d5d2c205b22636f6d6d616e644964222c205b22737472696e67222c2022636f6d6d616e6469645f64313866653533316662633537656539225d5d2c205b226576656e744964222c205b22737472696e67222c20226576656e7469645f32623766333764636137316161306235225d5d2c205b226576656e74496e646578222c205b22696e7465676572222c20223231225d5d2c205b22706172746974696f6e4964222c205b22737472696e67222c2022706172746974696f6e69645f33616366353938616562386133643833225d5d2c205b227061796c6f6164222c205b227265636f7264222c205b5b2268756e676572222c205b22696e7465676572222c202232323833225d5d2c205b2268756e67657252656d61696e646572222c205b22626967696e74222c20223230303030225d5d2c205b22696e74656772617465644174222c205b22626967696e74222c2022313730303030225d5d2c205b226f626a6563744964222c205b22737472696e67222c2022626561636f6e2e6d6173746572225d5d2c205b227765746e657373222c205b22696e7465676572222c202230225d5d2c205b227765746e65737352656d61696e646572222c205b22626967696e74222c202230225d5d5d5d5d2c205b22706f6c69637956657273696f6e73222c205b227265636f7264222c205b5b22726f7574696e65222c205b22737472696e67222c2022626561636f6e2d31225d5d5d5d5d2c205b22736368656d6156657273696f6e222c205b22696e7465676572222c202231225d5d2c205b2273696d756c6174696f6e54696d65222c205b22626967696e74222c2022313730303030225d5d2c205b2274656e616e744964222c205b22737472696e67222c202274656e616e7469645f34343361646661343731343037383064225d5d2c205b2274696d656c696e654964222c205b22737472696e67222c202274696d656c696e6569645f61393434613164363132393434393736225d5d2c205b2274797065222c205b22737472696e67222c20226e656564732e6368616e676564225d5d2c205b22776f726c644964222c205b22737472696e67222c2022776f726c6469645f62303961656435343933326338663531225d5d5d5d7d2c2022776f726c644964223a2022776f726c6469645f62303961656435343933326338663531222c202273747265616d4964223a2022706172746974696f6e69645f336163663539386165623861336438333a626561636f6e2e68616c6c3a73747265616d222c202274656e616e744964223a202274656e616e7469645f34343361646661343731343037383064222c2022636f6d6d616e644964223a2022636f6d6d616e6469645f64313866653533316662633537656539222c20227265636f726465644174223a2022323032362d31302d32305430363a35323a31382e3934305a222c202274696d656c696e654964223a202274696d656c696e6569645f61393434613164363132393434393736222c20226174747269627574696f6e223a207b226566666563746976654163746f724964223a202273696d756c61746f722d7363656e6172696f222c202263617573616c526f6f74416374696f6e4964223a2022636f6d6d616e6469645f32323237633738333539626436663161222c2022617574686f726974794465636973696f6e4964223a2022617574686f726974793a636f6d6d616e6469645f64313866653533316662633537656539227d2c2022706172746974696f6e4964223a2022706172746974696f6e69645f336163663539386165623861336438333a626561636f6e2e68616c6c222c20227061796c6f616448617368223a20227368613235363a38643935306563373935346233623733316335663237393235616433303064333132373739363530366562343439383435313761336232303038616566653466222c202270726976616379436c617373223a20227075626c69635f7363656e65222c2022636f7272656c6174696f6e4964223a2022636f6d6d616e6469645f32323237633738333539626436663161222c2022736368656d6156657273696f6e223a20322c2022706f6c69637956657273696f6e73223a207b22726f7574696e65223a2022626561636f6e2d31227d2c202273696d756c6174696f6e54696d65223a2022313730303030222c202273747265616d53657175656e6365223a20223235222c20226a6f75726e616c506f736974696f6e223a20223235222c2022706172746974696f6e53657175656e6365223a20223235227d
commandid_d18fe531fbc57ee9:event:19	tenantid_443adfa47140780d	worldid_b09aed54932c8f51	timelineid_a944a1d612944976	partitionid_3acf598aeb8a3d83:beacon.hall	beacon.hall	partitionid_3acf598aeb8a3d83:beacon.hall:stream	26	26	26	wellbeing.integrated	2	170000	2026-10-19 23:52:18.94-07	commandid_d18fe531fbc57ee9	commandid_2227c78359bd6f1a	\N	\N	\N	\N	public_scene	sha256:2f2825ab9b72319f535e6be7860e92c1a4dcd23131d9d5381c30cec843edb547	{"effectiveActorId": "simulator-scenario", "causalRootActionId": "commandid_2227c78359bd6f1a", "authorityDecisionId": "authority:commandid_d18fe531fbc57ee9"}	\N	{"routine": "beacon-1"}	{"kernelEvent": ["record", [["attribution", ["record", [["authorityDecisionId", ["string", "authority:commandid_d18fe531fbc57ee9"]], ["causalRootActionId", ["string", "commandid_2227c78359bd6f1a"]], ["effectiveActorId", ["string", "simulator-scenario"]]]]], ["commandId", ["string", "commandid_d18fe531fbc57ee9"]], ["eventId", ["string", "eventid_ab402b8404cba442"]], ["eventIndex", ["integer", "22"]], ["partitionId", ["string", "partitionid_3acf598aeb8a3d83"]], ["payload", ["record", [["health", ["integer", "10000"]], ["healthRemainder", ["bigint", "0"]], ["integratedAt", ["bigint", "170000"]], ["objectId", ["string", "beacon.master"]], ["thirst", ["integer", "8"]], ["thirstRemainder", ["bigint", "40000"]]]]], ["policyVersions", ["record", [["routine", ["string", "beacon-1"]]]]], ["schemaVersion", ["integer", "1"]], ["simulationTime", ["bigint", "170000"]], ["tenantId", ["string", "tenantid_443adfa47140780d"]], ["timelineId", ["string", "timelineid_a944a1d612944976"]], ["type", ["string", "wellbeing.integrated"]], ["worldId", ["string", "worldid_b09aed54932c8f51"]]]]}	\\x7b2274797065223a202277656c6c6265696e672e696e7465677261746564222c20226576656e744964223a2022636f6d6d616e6469645f643138666535333166626335376565393a6576656e743a3139222c20227061796c6f6164223a207b226b65726e656c4576656e74223a205b227265636f7264222c205b5b226174747269627574696f6e222c205b227265636f7264222c205b5b22617574686f726974794465636973696f6e4964222c205b22737472696e67222c2022617574686f726974793a636f6d6d616e6469645f64313866653533316662633537656539225d5d2c205b2263617573616c526f6f74416374696f6e4964222c205b22737472696e67222c2022636f6d6d616e6469645f32323237633738333539626436663161225d5d2c205b226566666563746976654163746f724964222c205b22737472696e67222c202273696d756c61746f722d7363656e6172696f225d5d5d5d5d2c205b22636f6d6d616e644964222c205b22737472696e67222c2022636f6d6d616e6469645f64313866653533316662633537656539225d5d2c205b226576656e744964222c205b22737472696e67222c20226576656e7469645f61623430326238343034636261343432225d5d2c205b226576656e74496e646578222c205b22696e7465676572222c20223232225d5d2c205b22706172746974696f6e4964222c205b22737472696e67222c2022706172746974696f6e69645f33616366353938616562386133643833225d5d2c205b227061796c6f6164222c205b227265636f7264222c205b5b226865616c7468222c205b22696e7465676572222c20223130303030225d5d2c205b226865616c746852656d61696e646572222c205b22626967696e74222c202230225d5d2c205b22696e74656772617465644174222c205b22626967696e74222c2022313730303030225d5d2c205b226f626a6563744964222c205b22737472696e67222c2022626561636f6e2e6d6173746572225d5d2c205b22746869727374222c205b22696e7465676572222c202238225d5d2c205b2274686972737452656d61696e646572222c205b22626967696e74222c20223430303030225d5d5d5d5d2c205b22706f6c69637956657273696f6e73222c205b227265636f7264222c205b5b22726f7574696e65222c205b22737472696e67222c2022626561636f6e2d31225d5d5d5d5d2c205b22736368656d6156657273696f6e222c205b22696e7465676572222c202231225d5d2c205b2273696d756c6174696f6e54696d65222c205b22626967696e74222c2022313730303030225d5d2c205b2274656e616e744964222c205b22737472696e67222c202274656e616e7469645f34343361646661343731343037383064225d5d2c205b2274696d656c696e654964222c205b22737472696e67222c202274696d656c696e6569645f61393434613164363132393434393736225d5d2c205b2274797065222c205b22737472696e67222c202277656c6c6265696e672e696e7465677261746564225d5d2c205b22776f726c644964222c205b22737472696e67222c2022776f726c6469645f62303961656435343933326338663531225d5d5d5d7d2c2022776f726c644964223a2022776f726c6469645f62303961656435343933326338663531222c202273747265616d4964223a2022706172746974696f6e69645f336163663539386165623861336438333a626561636f6e2e68616c6c3a73747265616d222c202274656e616e744964223a202274656e616e7469645f34343361646661343731343037383064222c2022636f6d6d616e644964223a2022636f6d6d616e6469645f64313866653533316662633537656539222c20227265636f726465644174223a2022323032362d31302d32305430363a35323a31382e3934305a222c202274696d656c696e654964223a202274696d656c696e6569645f61393434613164363132393434393736222c20226174747269627574696f6e223a207b226566666563746976654163746f724964223a202273696d756c61746f722d7363656e6172696f222c202263617573616c526f6f74416374696f6e4964223a2022636f6d6d616e6469645f32323237633738333539626436663161222c2022617574686f726974794465636973696f6e4964223a2022617574686f726974793a636f6d6d616e6469645f64313866653533316662633537656539227d2c2022706172746974696f6e4964223a2022706172746974696f6e69645f336163663539386165623861336438333a626561636f6e2e68616c6c222c20227061796c6f616448617368223a20227368613235363a32663238323561623962373233313966353335653662653738363065393263316134646364323331333164396435333831633330636563383433656462353437222c202270726976616379436c617373223a20227075626c69635f7363656e65222c2022636f7272656c6174696f6e4964223a2022636f6d6d616e6469645f32323237633738333539626436663161222c2022736368656d6156657273696f6e223a20322c2022706f6c69637956657273696f6e73223a207b22726f7574696e65223a2022626561636f6e2d31227d2c202273696d756c6174696f6e54696d65223a2022313730303030222c202273747265616d53657175656e6365223a20223236222c20226a6f75726e616c506f736974696f6e223a20223236222c2022706172746974696f6e53657175656e6365223a20223236227d
\.


--
-- Data for Name: migration_backfill_checkpoints; Type: TABLE DATA; Schema: clockgrove; Owner: clockgrove_migrator
--

COPY clockgrove.migration_backfill_checkpoints (migration_name, checkpoint_key, checkpoint_value, verified_at) FROM stdin;
\.


--
-- Data for Name: partition_schedules; Type: TABLE DATA; Schema: clockgrove; Owner: clockgrove_migrator
--

COPY clockgrove.partition_schedules (tenant_id, world_id, timeline_id, partition_id, space_id, schedule_id, idempotency_key, owner_partition_id, due_at, priority, tie_break_key, kind, payload_version, catch_up_class, supersedes, item, item_hash, status, scheduled_by_command_id, completed_by_command_id, created_at, updated_at) FROM stdin;
tenantid_443adfa47140780d	worldid_b09aed54932c8f51	timelineid_a944a1d612944976	partitionid_3acf598aeb8a3d83:beacon.hall	beacon.hall	scheduleid_62cd8f46546154c2	scheduleid_62cd8f46546154c2:100000	partitionid_3acf598aeb8a3d83	100000	10	beacon.master	world.decision	1	exact	\N	["record", [["catchUpClass", ["string", "exact"]], ["dueAt", ["bigint", "100000"]], ["id", ["string", "scheduleid_62cd8f46546154c2"]], ["idempotencyKey", ["string", "scheduleid_62cd8f46546154c2:100000"]], ["kind", ["string", "world.decision"]], ["ownerPartitionId", ["string", "partitionid_3acf598aeb8a3d83"]], ["payload", ["record", [["objectId", ["string", "beacon.master"]], ["schemaVersion", ["integer", "1"]]]]], ["payloadVersion", ["integer", "1"]], ["priority", ["integer", "10"]], ["tenantId", ["string", "tenantid_443adfa47140780d"]], ["tieBreakKey", ["string", "beacon.master"]], ["timelineId", ["string", "timelineid_a944a1d612944976"]], ["worldId", ["string", "worldid_b09aed54932c8f51"]]]]	5013d4e9de689aed76cbd01d28abb02936ec090a0aed8f7f8f24207ca6d9ecc3	done	trusted:world-provisioning:commandid_978eb8659995d56a:world-ready	commandid_d18fe531fbc57ee9	2026-10-19 23:52:18.819697-07	2026-10-19 23:52:18.973883-07
tenantid_443adfa47140780d	worldid_b09aed54932c8f51	timelineid_a944a1d612944976	partitionid_3acf598aeb8a3d83:beacon.hall	beacon.hall	scheduleid_62cd8f46546154c2	scheduleid_62cd8f46546154c2:220000	partitionid_3acf598aeb8a3d83	220000	10	beacon.master	world.decision	1	exact	\N	["record", [["catchUpClass", ["string", "exact"]], ["dueAt", ["bigint", "220000"]], ["id", ["string", "scheduleid_62cd8f46546154c2"]], ["idempotencyKey", ["string", "scheduleid_62cd8f46546154c2:220000"]], ["kind", ["string", "world.decision"]], ["ownerPartitionId", ["string", "partitionid_3acf598aeb8a3d83"]], ["payload", ["record", [["objectId", ["string", "beacon.master"]], ["schemaVersion", ["integer", "1"]]]]], ["payloadVersion", ["integer", "1"]], ["priority", ["integer", "10"]], ["tenantId", ["string", "tenantid_443adfa47140780d"]], ["tieBreakKey", ["string", "beacon.master"]], ["timelineId", ["string", "timelineid_a944a1d612944976"]], ["worldId", ["string", "worldid_b09aed54932c8f51"]]]]	0d83a4a557926aa7d0d7fc15f76a15eecd58f16523d05988cfb89c3ae9b4967f	pending	commandid_d18fe531fbc57ee9	\N	2026-10-19 23:52:18.973883-07	2026-10-19 23:52:18.973883-07
\.


--
-- Data for Name: partition_states; Type: TABLE DATA; Schema: clockgrove; Owner: clockgrove_migrator
--

COPY clockgrove.partition_states (tenant_id, world_id, timeline_id, partition_id, space_id, revision, covered_head_sequence, simulation_time, document_version, document, document_hash, state_hash, created_at, updated_at, continuation, continuation_hash, continuation_command_id) FROM stdin;
tenantid_443adfa47140780d	worldid_b09aed54932c8f51	timelineid_a944a1d612944976	partitionid_3acf598aeb8a3d83:beacon.hall	beacon.hall	23	26	170000	2	["record", [["kind", ["string", "clockgrove.partition-state"]], ["randomState", ["string", "[\\"clockgrove-canonical-v1\\",[\\"array\\",[[\\"string\\",\\"clockgrove-random-v1\\"],[\\"array\\",[[\\"array\\",[[\\"string\\",\\"weather\\"],[\\"string\\",\\"pure-rand@8.4.2/xoroshiro128plus\\"],[\\"string\\",\\"1\\"],[\\"string\\",\\"0\\"],[\\"array\\",[[\\"string\\",\\"-1\\"],[\\"string\\",\\"5\\"],[\\"string\\",\\"-6\\"],[\\"string\\",\\"7\\"]]]]]]]]]]"]], ["schedulesHash", ["string", "a78b0f44ad05e23ff498bb6fb72a9df681887f3dd469063aca08581bfe2d7b87"]], ["state", ["record", [["entities", ["array", [["record", [["archetypeId", ["string", "beacon.cistern-kind@1"]], ["objectId", ["string", "beacon.cistern"]], ["pose", ["record", [["coordinates", ["array", [["bigint", "200"], ["bigint", "100"]]]], ["frameId", ["string", "frame-hall"]], ["frameVersion", ["integer", "1"]]]]], ["resource", ["record", [["kind", ["string", "water"]], ["quantity", ["integer", "4"]]]]], ["spaceId", ["string", "beacon.hall"]]]], ["record", [["archetypeId", ["string", "beacon.lamp-kind@1"]], ["objectId", ["string", "beacon.lamp"]], ["pose", ["record", [["coordinates", ["array", [["bigint", "300"], ["bigint", "100"]]]], ["frameId", ["string", "frame-hall"]], ["frameVersion", ["integer", "1"]]]]], ["shelter", ["record", [["rainProtection", ["integer", "5000"]]]]], ["spaceId", ["string", "beacon.hall"]]]], ["record", [["archetypeId", ["string", "beacon.larder-kind@1"]], ["objectId", ["string", "beacon.larder"]], ["pose", ["record", [["coordinates", ["array", [["bigint", "100"], ["bigint", "100"]]]], ["frameId", ["string", "frame-hall"]], ["frameVersion", ["integer", "1"]]]]], ["resource", ["record", [["kind", ["string", "food"]], ["quantity", ["integer", "2"]]]]], ["spaceId", ["string", "beacon.hall"]]]], ["record", [["archetypeId", ["string", "beacon.keeper-kind@1"]], ["movement", ["record", [["anchorPath", ["array", []]], ["destination", ["record", [["kind", ["string", "pose"]], ["pose", ["record", [["coordinates", ["array", [["bigint", "200"], ["bigint", "100"]]]], ["frameId", ["string", "frame-hall"]], ["frameVersion", ["integer", "1"]]]]]]]], ["emitted", ["array", [["record", [["kind", ["string", "exited"]], ["regionId", ["string", "hall"]], ["regionVersion", ["integer", "1"]], ["time", ["bigint", "160100"]]]]]]], ["endedAt", ["bigint", "160100"]], ["exitedAtStart", ["array", []]], ["frameId", ["string", "frame-hall"]], ["frameVersion", ["integer", "1"]], ["initialInside", ["array", [["string", "hall"]]]], ["movementId", ["string", "movement-commandid_7035f536044905d7"]], ["segment", ["record", [["speed", ["record", [["kind", ["string", "constant-units-per-second"]], ["unitsPerSecond", ["bigint", "1000"]]]]], ["startTime", ["bigint", "160000"]], ["waypoints", ["array", [["array", [["bigint", "100"], ["bigint", "100"]]], ["array", [["bigint", "200"], ["bigint", "100"]]]]]]]]], ["status", ["string", "completed"]]]]], ["needs", ["record", [["hunger", ["integer", "2283"]], ["hungerRemainder", ["bigint", "20000"]], ["integratedAt", ["bigint", "170000"]], ["wetness", ["integer", "0"]], ["wetnessRemainder", ["bigint", "0"]]]]], ["objectId", ["string", "beacon.master"]], ["pose", ["record", [["coordinates", ["array", [["bigint", "200"], ["bigint", "100"]]]], ["frameId", ["string", "frame-hall"]], ["frameVersion", ["integer", "1"]]]]], ["selectedAction", ["record", [["kind", ["string", "seek-water"]], ["targetObjectId", ["string", "beacon.cistern"]]]]], ["spaceId", ["string", "beacon.hall"]]]]]]], ["environment", ["record", [["lightBand", ["string", "bright"]], ["nextPhaseBoundary", ["bigint", "43200000"]], ["nextWeatherBoundary", ["bigint", "3600000"]], ["phase", ["string", "day"]], ["segmentIndex", ["integer", "0"]], ["temperatureBand", ["string", "mild"]]]]], ["partitionId", ["string", "partitionid_3acf598aeb8a3d83"]], ["revision", ["bigint", "23"]], ["schemaVersion", ["integer", "1"]], ["scriptedCognition", ["record", [["entries", ["array", [["record", [["actorId", ["string", "beacon.master"]], ["effectiveAt", ["bigint", "1000"]], ["kind", ["string", "memory"]], ["ref", ["string", "scripted:cistern-memory"]], ["targetObjectId", ["string", "beacon.cistern"]], ["value", ["integer", "4000"]]]]]]], ["schemaVersion", ["integer", "1"]], ["source", ["string", "scripted"]]]]], ["simulationTime", ["bigint", "170000"]], ["spatialFrames", ["array", [["record", [["axes", ["record", [["axes", ["array", [["record", [["name", ["string", "x"]], ["positiveDirection", ["string", "east"]]]], ["record", [["name", ["string", "y"]], ["positiveDirection", ["string", "north"]]]]]]]]]], ["dimensions", ["integer", "2"]], ["frameId", ["string", "frame-hall"]], ["gravity", ["record", [["kind", ["string", "constant-vector"]], ["vector", ["array", [["bigint", "0"], ["bigint", "0"]]]]]]], ["origin", ["array", [["bigint", "0"], ["bigint", "0"]]]], ["unit", ["record", [["fractionalDigits", ["integer", "3"]], ["name", ["string", "meter"]]]]], ["version", ["integer", "1"]]]]]]], ["spatialRegions", ["array", [["record", [["frameId", ["string", "frame-hall"]], ["frameVersion", ["integer", "1"]], ["regionId", ["string", "hall"]], ["shape", ["record", [["kind", ["string", "rectangle"]], ["max", ["array", [["bigint", "2000"], ["bigint", "1000"]]]], ["min", ["array", [["bigint", "0"], ["bigint", "0"]]]]]]], ["version", ["integer", "1"]]]]]]], ["tenantId", ["string", "tenantid_443adfa47140780d"]], ["timelineId", ["string", "timelineid_a944a1d612944976"]], ["weather", ["record", [["rainIntensity", ["integer", "0"]]]]], ["wellbeing", ["record", [["entries", ["array", [["record", [["comfort", ["string", "comfortable"]], ["health", ["integer", "10000"]], ["healthRemainder", ["bigint", "0"]], ["integratedAt", ["bigint", "170000"]], ["objectId", ["string", "beacon.master"]], ["thirst", ["integer", "8"]], ["thirstRemainder", ["bigint", "40000"]]]]]]]]]], ["worldId", ["string", "worldid_b09aed54932c8f51"]]]]], ["version", ["integer", "2"]]]]	f754c0a82c6e0f3cbb09bd2009c536ae39347ef93d11731533c33c5c2b281a29	4d2c9bd4b68aeee489dfae5380353e0f458826a4b76e5ed14e37eee64d344399	2026-10-19 23:52:18.818823-07	2026-10-19 23:52:18.973883-07	\N	\N	\N
\.


--
-- Data for Name: schema_migrations; Type: TABLE DATA; Schema: clockgrove; Owner: clockgrove_migrator
--

COPY clockgrove.schema_migrations (migration_name, checksum, applied_at) FROM stdin;
0001_wave0_journal.sql	dab86e97027f712fc190dabd92004916b0199ca5b0b2e1ba5296b79f7d9c580c	2026-10-19 23:52:18.320107-07
0002_authentication_authority.sql	8b603b4c32e6bdc534e19faf0a490af4fd44903e1cd05ba7d0367ba437221206	2026-10-19 23:52:18.35213-07
0003_tenant_scoped_event_ids.sql	8689e66294fec7e222ced54eceafeb7fa75b61cedb79df96ce550386d7a20a20	2026-10-19 23:52:18.372338-07
0004_world_birth.sql	2608262fc2f85feca5c2e5d12f8edc89738a10af0f1847ad8a4a9c0ff01c967d	2026-10-19 23:52:18.410959-07
0005_world_ready_authority.sql	9dcbd8d6904c680e39b30457b3af5bcb4cf0b602075445831327f33bf877adbb	2026-10-19 23:52:18.429984-07
0006_attributed_receipts.sql	382cedfbde1a0bc95dd6ea82933a031f105e50821b88127ccfa095a3275df1f2	2026-10-19 23:52:18.459396-07
0007_partition_state_projection.sql	1b130f05c6c65c36808b467ed6dfce158ba8760f2f3b3195ffaeb574377bdbcd	2026-10-19 23:52:18.485086-07
0008_durable_schedules.sql	cb71508f60f863621525caffa7f84ef81f692dc03952720f6bf831e9f06f4e45	2026-10-19 23:52:18.511653-07
0009_dispatch_leases.sql	47e7863f0a1e4e8585211a49fe3d89dc1c1119b84f3c998a233f3bc144d35560	2026-10-19 23:52:18.532701-07
0010_linear_journal_append.sql	7564bffdbaa9ff5538f2f467c3101b2799ab2639dd85112895de7b8de9052b4e	2026-10-19 23:52:18.553536-07
0011_preview_effect_policy.sql	85676e88eb95da9d092907bb83dc4014ca807fd5ddf72fd15018c0d683650515	2026-10-19 23:52:18.571489-07
0012_artifact_store.sql	8a7660ab27a5e7fc05c7ba22c9577c5711a04d90eebd7876d2a4314599dc3211	2026-10-19 23:52:18.596719-07
0013_partition_snapshots.sql	8dcf447e2f9b13422138374410c0fb0fdf0d2d71d9dfe407f1f7687ca19e2d8b	2026-10-19 23:52:18.620648-07
0014_indexed_event_collision_check.sql	f19b4f5521584a19b899931c5ab3a3910f4d72d85cc287d542c8ac7d93b6689a	2026-10-19 23:52:18.640634-07
\.


--
-- Data for Name: snapshots; Type: TABLE DATA; Schema: clockgrove; Owner: clockgrove_migrator
--

COPY clockgrove.snapshots (tenant_id, world_id, timeline_id, partition_id, space_id, snapshot_id, stream_id, covered_sequence, state_hash, artifact_id, privacy_class, compatibility, created_at, covered_partition_sequence) FROM stdin;
tenantid_443adfa47140780d	worldid_b09aed54932c8f51	timelineid_a944a1d612944976	partitionid_3acf598aeb8a3d83:beacon.hall	beacon.hall	snapshot:timelineid_a944a1d612944976:partitionid_3acf598aeb8a3d83%3Abeacon.hall:3	partitionid_3acf598aeb8a3d83:beacon.hall:stream	3	0b237d6ea0a55215460bcb8054ebf78f02d6cfe03c7ff92194336447e93278fd	snapshot:timelineid_a944a1d612944976:partitionid_3acf598aeb8a3d83%3Abeacon.hall:3:artifact	public_scene	{"codec": 1, "randomContract": "clockgrove-random-v1", "documentVersion": 2, "packContentHash": "813a3f846859e55cd95be0fbb3359e0e36238f794e6265f3ef19a1fad6597906", "canonicalEncoding": "clockgrove-canonical-v1", "kernelRegistryHash": "805ff9a3bf9a477b03a4188c69bf10b53e9e8e562453cc9935e56d8d06a57798"}	2026-10-19 23:52:18.907039-07	3
tenantid_443adfa47140780d	worldid_b09aed54932c8f51	timelineid_a944a1d612944976	partitionid_3acf598aeb8a3d83:beacon.hall	beacon.hall	snapshot:timelineid_a944a1d612944976:partitionid_3acf598aeb8a3d83%3Abeacon.hall:6	partitionid_3acf598aeb8a3d83:beacon.hall:stream	6	f7785af40c09ce4b2e16eff92ad97bf49ea7e6391ef3b2da70422a2b5e896463	snapshot:timelineid_a944a1d612944976:partitionid_3acf598aeb8a3d83%3Abeacon.hall:6:artifact	public_scene	{"codec": 1, "randomContract": "clockgrove-random-v1", "documentVersion": 2, "packContentHash": "813a3f846859e55cd95be0fbb3359e0e36238f794e6265f3ef19a1fad6597906", "canonicalEncoding": "clockgrove-canonical-v1", "kernelRegistryHash": "805ff9a3bf9a477b03a4188c69bf10b53e9e8e562453cc9935e56d8d06a57798"}	2026-10-19 23:52:18.9385-07	6
tenantid_443adfa47140780d	worldid_b09aed54932c8f51	timelineid_a944a1d612944976	partitionid_3acf598aeb8a3d83:beacon.hall	beacon.hall	snapshot:timelineid_a944a1d612944976:partitionid_3acf598aeb8a3d83%3Abeacon.hall:26	partitionid_3acf598aeb8a3d83:beacon.hall:stream	26	4d2c9bd4b68aeee489dfae5380353e0f458826a4b76e5ed14e37eee64d344399	snapshot:timelineid_a944a1d612944976:partitionid_3acf598aeb8a3d83%3Abeacon.hall:26:artifact	public_scene	{"codec": 1, "randomContract": "clockgrove-random-v1", "documentVersion": 2, "packContentHash": "813a3f846859e55cd95be0fbb3359e0e36238f794e6265f3ef19a1fad6597906", "canonicalEncoding": "clockgrove-canonical-v1", "kernelRegistryHash": "805ff9a3bf9a477b03a4188c69bf10b53e9e8e562453cc9935e56d8d06a57798"}	2026-10-19 23:52:18.991019-07	26
\.


--
-- Data for Name: streams; Type: TABLE DATA; Schema: clockgrove; Owner: clockgrove_migrator
--

COPY clockgrove.streams (tenant_id, world_id, timeline_id, partition_id, space_id, stream_id, current_sequence, snapshot_sequence) FROM stdin;
tenantid_443adfa47140780d	worldid_b09aed54932c8f51	timelineid_a944a1d612944976	partitionid_3acf598aeb8a3d83:beacon.hall	beacon.hall	partitionid_3acf598aeb8a3d83:beacon.hall:stream	26	0
\.


--
-- Data for Name: tenant_principals; Type: TABLE DATA; Schema: clockgrove; Owner: clockgrove_migrator
--

COPY clockgrove.tenant_principals (tenant_id, principal_id, created_at) FROM stdin;
tenantid_443adfa47140780d	principal-journal-parity	2026-10-19 23:52:18.759058-07
\.


--
-- Data for Name: tenants; Type: TABLE DATA; Schema: clockgrove; Owner: clockgrove_migrator
--

COPY clockgrove.tenants (tenant_id, display_name, created_at) FROM stdin;
tenantid_443adfa47140780d	test	2026-10-19 23:52:18.759058-07
\.


--
-- Data for Name: timeline_partitions; Type: TABLE DATA; Schema: clockgrove; Owner: clockgrove_migrator
--

COPY clockgrove.timeline_partitions (tenant_id, world_id, timeline_id, partition_id, space_id, routing_epoch, head_sequence) FROM stdin;
tenantid_443adfa47140780d	worldid_b09aed54932c8f51	timelineid_a944a1d612944976	partitionid_3acf598aeb8a3d83:beacon.hall	beacon.hall	0	26
\.


--
-- Data for Name: timelines; Type: TABLE DATA; Schema: clockgrove; Owner: clockgrove_migrator
--

COPY clockgrove.timelines (tenant_id, world_id, timeline_id, kind, state, parent_timeline_id, created_at) FROM stdin;
tenantid_443adfa47140780d	worldid_b09aed54932c8f51	timelineid_a944a1d612944976	live	active	\N	2026-10-19 23:52:18.78411-07
\.


--
-- Data for Name: world_memberships; Type: TABLE DATA; Schema: clockgrove; Owner: clockgrove_migrator
--

COPY clockgrove.world_memberships (tenant_id, world_id, timeline_id, space_id, principal_id, membership_id, persona_id, roles, grants, privacy_ceiling, committed_at, revoked_at) FROM stdin;
\.


--
-- Data for Name: worlds; Type: TABLE DATA; Schema: clockgrove; Owner: clockgrove_migrator
--

COPY clockgrove.worlds (tenant_id, world_id, lifecycle_status, created_at) FROM stdin;
tenantid_443adfa47140780d	worldid_b09aed54932c8f51	ready	2026-10-19 23:52:18.783659-07
\.


--
-- Data for Name: account; Type: TABLE DATA; Schema: clockgrove_auth; Owner: clockgrove_migrator
--

COPY clockgrove_auth.account (id, "accountId", "providerId", "userId", "accessToken", "refreshToken", "idToken", "accessTokenExpiresAt", "refreshTokenExpiresAt", scope, password, "createdAt", "updatedAt") FROM stdin;
\.


--
-- Data for Name: session; Type: TABLE DATA; Schema: clockgrove_auth; Owner: clockgrove_migrator
--

COPY clockgrove_auth.session (id, "expiresAt", token, "createdAt", "updatedAt", "ipAddress", "userAgent", "userId") FROM stdin;
\.


--
-- Data for Name: user; Type: TABLE DATA; Schema: clockgrove_auth; Owner: clockgrove_migrator
--

COPY clockgrove_auth."user" (id, name, email, "emailVerified", image, "createdAt", "updatedAt") FROM stdin;
\.


--
-- Data for Name: verification; Type: TABLE DATA; Schema: clockgrove_auth; Owner: clockgrove_migrator
--

COPY clockgrove_auth.verification (id, identifier, value, "expiresAt", "createdAt", "updatedAt") FROM stdin;
\.


--
-- Data for Name: birth_cognitive_seed_refs; Type: TABLE DATA; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

COPY clockgrove_birth.birth_cognitive_seed_refs (tenant_id, world_id, timeline_id, birth_version, ordinal, pack_id, pack_version, seed_kind, seed_id, seed_version, sha256) FROM stdin;
tenantid_443adfa47140780d	worldid_b09aed54932c8f51	timelineid_a944a1d612944976	1	0	clockgrove.test-world	1.0.0	cognitiveSeeds	beacon.memory	1	a116c6e6826902df650c148048790ecd55b057486d1e4519817e303e6b9a9f46
\.


--
-- Data for Name: birth_random_streams; Type: TABLE DATA; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

COPY clockgrove_birth.birth_random_streams (tenant_id, world_id, timeline_id, birth_version, stream_name, algorithm, algorithm_version, draws, state_words) FROM stdin;
tenantid_443adfa47140780d	worldid_b09aed54932c8f51	timelineid_a944a1d612944976	1	weather	pure-rand@8.4.2/xoroshiro128plus	1	0	{-1,5,-6,7}
\.


--
-- Data for Name: birth_schedules; Type: TABLE DATA; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

COPY clockgrove_birth.birth_schedules (tenant_id, world_id, timeline_id, birth_version, ordinal, node) FROM stdin;
tenantid_443adfa47140780d	worldid_b09aed54932c8f51	timelineid_a944a1d612944976	1	0	["record", [["catchUpClass", ["string", "exact"]], ["dueAt", ["bigint", "100000"]], ["id", ["string", "scheduleid_62cd8f46546154c2"]], ["idempotencyKey", ["string", "scheduleid_62cd8f46546154c2:100000"]], ["kind", ["string", "world.decision"]], ["ownerPartitionId", ["string", "partitionid_3acf598aeb8a3d83"]], ["payload", ["record", [["objectId", ["string", "beacon.master"]], ["schemaVersion", ["integer", "1"]]]]], ["payloadVersion", ["integer", "1"]], ["priority", ["integer", "10"]], ["tenantId", ["string", "tenantid_443adfa47140780d"]], ["tieBreakKey", ["string", "beacon.master"]], ["timelineId", ["string", "timelineid_a944a1d612944976"]], ["worldId", ["string", "worldid_b09aed54932c8f51"]]]]
\.


--
-- Data for Name: birth_space_state; Type: TABLE DATA; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

COPY clockgrove_birth.birth_space_state (tenant_id, world_id, timeline_id, birth_version, partition_id, space_id, element_kind, element_key, ordinal, node) FROM stdin;
tenantid_443adfa47140780d	worldid_b09aed54932c8f51	timelineid_a944a1d612944976	1	partitionid_3acf598aeb8a3d83:beacon.hall	beacon.hall	frame	frame-hall	0	["record", [["axes", ["record", [["axes", ["array", [["record", [["name", ["string", "x"]], ["positiveDirection", ["string", "east"]]]], ["record", [["name", ["string", "y"]], ["positiveDirection", ["string", "north"]]]]]]]]]], ["dimensions", ["integer", "2"]], ["frameId", ["string", "frame-hall"]], ["gravity", ["record", [["kind", ["string", "constant-vector"]], ["vector", ["array", [["bigint", "0"], ["bigint", "0"]]]]]]], ["origin", ["array", [["bigint", "0"], ["bigint", "0"]]]], ["unit", ["record", [["fractionalDigits", ["integer", "3"]], ["name", ["string", "meter"]]]]], ["version", ["integer", "1"]]]]
tenantid_443adfa47140780d	worldid_b09aed54932c8f51	timelineid_a944a1d612944976	1	partitionid_3acf598aeb8a3d83:beacon.hall	beacon.hall	region	hall@1	0	["record", [["frameId", ["string", "frame-hall"]], ["frameVersion", ["integer", "1"]], ["regionId", ["string", "hall"]], ["shape", ["record", [["kind", ["string", "rectangle"]], ["max", ["array", [["bigint", "2000"], ["bigint", "1000"]]]], ["min", ["array", [["bigint", "0"], ["bigint", "0"]]]]]]], ["version", ["integer", "1"]]]]
tenantid_443adfa47140780d	worldid_b09aed54932c8f51	timelineid_a944a1d612944976	1	partitionid_3acf598aeb8a3d83:beacon.hall	beacon.hall	entity	beacon.cistern	0	["record", [["archetypeId", ["string", "beacon.cistern-kind@1"]], ["objectId", ["string", "beacon.cistern"]], ["pose", ["record", [["coordinates", ["array", [["bigint", "200"], ["bigint", "100"]]]], ["frameId", ["string", "frame-hall"]], ["frameVersion", ["integer", "1"]]]]], ["resource", ["record", [["kind", ["string", "water"]], ["quantity", ["integer", "5"]]]]], ["spaceId", ["string", "beacon.hall"]]]]
tenantid_443adfa47140780d	worldid_b09aed54932c8f51	timelineid_a944a1d612944976	1	partitionid_3acf598aeb8a3d83:beacon.hall	beacon.hall	entity	beacon.lamp	1	["record", [["archetypeId", ["string", "beacon.lamp-kind@1"]], ["objectId", ["string", "beacon.lamp"]], ["pose", ["record", [["coordinates", ["array", [["bigint", "300"], ["bigint", "100"]]]], ["frameId", ["string", "frame-hall"]], ["frameVersion", ["integer", "1"]]]]], ["shelter", ["record", [["rainProtection", ["integer", "5000"]]]]], ["spaceId", ["string", "beacon.hall"]]]]
tenantid_443adfa47140780d	worldid_b09aed54932c8f51	timelineid_a944a1d612944976	1	partitionid_3acf598aeb8a3d83:beacon.hall	beacon.hall	entity	beacon.larder	2	["record", [["archetypeId", ["string", "beacon.larder-kind@1"]], ["objectId", ["string", "beacon.larder"]], ["pose", ["record", [["coordinates", ["array", [["bigint", "100"], ["bigint", "100"]]]], ["frameId", ["string", "frame-hall"]], ["frameVersion", ["integer", "1"]]]]], ["resource", ["record", [["kind", ["string", "food"]], ["quantity", ["integer", "3"]]]]], ["spaceId", ["string", "beacon.hall"]]]]
tenantid_443adfa47140780d	worldid_b09aed54932c8f51	timelineid_a944a1d612944976	1	partitionid_3acf598aeb8a3d83:beacon.hall	beacon.hall	entity	beacon.master	3	["record", [["archetypeId", ["string", "beacon.keeper-kind@1"]], ["needs", ["record", [["hunger", ["integer", "3000"]], ["hungerRemainder", ["bigint", "0"]], ["integratedAt", ["bigint", "0"]], ["wetness", ["integer", "0"]], ["wetnessRemainder", ["bigint", "0"]]]]], ["objectId", ["string", "beacon.master"]], ["pose", ["record", [["coordinates", ["array", [["bigint", "10"], ["bigint", "20"]]]], ["frameId", ["string", "frame-hall"]], ["frameVersion", ["integer", "1"]]]]], ["spaceId", ["string", "beacon.hall"]]]]
\.


--
-- Data for Name: birth_state_sections; Type: TABLE DATA; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

COPY clockgrove_birth.birth_state_sections (tenant_id, world_id, timeline_id, birth_version, section, section_version, node) FROM stdin;
tenantid_443adfa47140780d	worldid_b09aed54932c8f51	timelineid_a944a1d612944976	1	environment	1	["record", [["lightBand", ["string", "bright"]], ["nextPhaseBoundary", ["bigint", "43200000"]], ["nextWeatherBoundary", ["bigint", "3600000"]], ["phase", ["string", "day"]], ["segmentIndex", ["integer", "0"]], ["temperatureBand", ["string", "mild"]]]]
tenantid_443adfa47140780d	worldid_b09aed54932c8f51	timelineid_a944a1d612944976	1	wellbeing	1	["record", [["entries", ["array", [["record", [["comfort", ["string", "comfortable"]], ["health", ["integer", "10000"]], ["healthRemainder", ["bigint", "0"]], ["integratedAt", ["bigint", "0"]], ["objectId", ["string", "beacon.master"]], ["thirst", ["integer", "0"]], ["thirstRemainder", ["bigint", "0"]]]]]]]]]
\.


--
-- Data for Name: pack_artifact_resources; Type: TABLE DATA; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

COPY clockgrove_birth.pack_artifact_resources (tenant_id, pack_id, pack_version, resource_kind, resource_id, resource_version, path, sha256, content) FROM stdin;
tenantid_443adfa47140780d	clockgrove.test-world	1.0.0	archetypes	beacon.cistern-kind	1	archetypes/cistern.json	9a04c498277c9ba3e98d84039158d5272f4856ccd293c015458c511fe3553318	\\x7b22636f6d706f6e656e7473223a7b22636c6f636b67726f76652e7265736f75726365223a7b227374617465223a7b226b696e64223a227761746572222c227175616e74697479223a357d2c2274797065223a22636c6f636b67726f76652e7265736f75726365222c2276657273696f6e223a317d7d2c226964223a22626561636f6e2e6369737465726e2d6b696e64222c22747261697473223a5b5d2c2276657273696f6e223a317d
tenantid_443adfa47140780d	clockgrove.test-world	1.0.0	archetypes	beacon.keeper-kind	1	archetypes/keeper.json	061194c8a3127363e141543439c5fdd04420e5669d6baa0c68d4bc96a17eb1ff	\\x7b22636f6d706f6e656e7473223a7b7d2c226964223a22626561636f6e2e6b65657065722d6b696e64222c22747261697473223a5b7b226964223a22626561636f6e2e6e65656473222c2276657273696f6e223a317d5d2c2276657273696f6e223a317d
tenantid_443adfa47140780d	clockgrove.test-world	1.0.0	archetypes	beacon.lamp-kind	1	archetypes/lamp.json	c25d3198d82e1bd7caca171f817281c0ff375a753e11f745b8855876dad6031a	\\x7b22636f6d706f6e656e7473223a7b22636c6f636b67726f76652e776561746865722d6578706f73757265223a7b227374617465223a7b227261696e50726f74656374696f6e223a353030307d2c2274797065223a22636c6f636b67726f76652e776561746865722d6578706f73757265222c2276657273696f6e223a317d7d2c226964223a22626561636f6e2e6c616d702d6b696e64222c22747261697473223a5b5d2c2276657273696f6e223a317d
tenantid_443adfa47140780d	clockgrove.test-world	1.0.0	archetypes	beacon.larder-kind	1	archetypes/larder.json	96d743ff663c1d90e9db4925198c573f0b7e986c4fe5f8d48b7d0639894c233a	\\x7b22636f6d706f6e656e7473223a7b22636c6f636b67726f76652e7265736f75726365223a7b227374617465223a7b226b696e64223a22666f6f64222c227175616e74697479223a337d2c2274797065223a22636c6f636b67726f76652e7265736f75726365222c2276657273696f6e223a317d7d2c226964223a22626561636f6e2e6c61726465722d6b696e64222c22747261697473223a5b5d2c2276657273696f6e223a317d
tenantid_443adfa47140780d	clockgrove.test-world	1.0.0	traits	beacon.needs	1	traits/needs.json	2ddf104a8b8b13f02b56a78545ed7ee08a9ab6a1a1c50094450b5351a6f1e99b	\\x7b22636f6d706f6e656e7473223a7b22636c6f636b67726f76652e6e65656473223a7b227374617465223a7b2268756e676572223a333030302c2268756e67657252656d61696e646572223a7b2224626967696e74223a2230227d2c22696e74656772617465644174223a7b2224626967696e74223a2230227d2c227765746e657373223a302c227765746e65737352656d61696e646572223a7b2224626967696e74223a2230227d7d2c2274797065223a22636c6f636b67726f76652e6e65656473222c2276657273696f6e223a317d7d2c226964223a22626561636f6e2e6e65656473222c22747261697473223a5b5d2c2276657273696f6e223a317d
tenantid_443adfa47140780d	clockgrove.test-world	1.0.0	actors	beacon.cistern	1	actors/cistern.json	e3afa5d49abb5010a139c5f938bab90ce1b054353a836978e9a2b9a8c30fd6ae	\\x7b22617263686574797065223a7b226964223a22626561636f6e2e6369737465726e2d6b696e64222c2276657273696f6e223a317d2c226361706162696c6974696573223a5b5d2c226964223a22626561636f6e2e6369737465726e222c226f7665727269646573223a5b5d2c22706c6163656d656e74223a7b22636f6f7264696e61746573223a5b7b2224626967696e74223a22323030227d2c7b2224626967696e74223a22313030227d5d2c227370616365223a7b226964223a22626561636f6e2e68616c6c222c2276657273696f6e223a317d7d2c22747261697473223a5b5d7d
tenantid_443adfa47140780d	clockgrove.test-world	1.0.0	actors	beacon.lamp	1	actors/lamp.json	2a5f4734171c8f4fb36d585d0e86a7a447a44f9d2b0dec1abafed38e4736a5f8	\\x7b22617263686574797065223a7b226964223a22626561636f6e2e6c616d702d6b696e64222c2276657273696f6e223a317d2c226361706162696c6974696573223a5b7b226964223a22626561636f6e2e737065616b222c2276657273696f6e223a317d5d2c226964223a22626561636f6e2e6c616d70222c226f7665727269646573223a5b5d2c22706c6163656d656e74223a7b22636f6f7264696e61746573223a5b7b2224626967696e74223a22333030227d2c7b2224626967696e74223a22313030227d5d2c227370616365223a7b226964223a22626561636f6e2e68616c6c222c2276657273696f6e223a317d7d2c22747261697473223a5b5d7d
tenantid_443adfa47140780d	clockgrove.test-world	1.0.0	actors	beacon.larder	1	actors/larder.json	e394bf7209ccb69e6496d2ad9d6427206c22f622f662548aeb4ca8b8a2202ce8	\\x7b22617263686574797065223a7b226964223a22626561636f6e2e6c61726465722d6b696e64222c2276657273696f6e223a317d2c226361706162696c6974696573223a5b5d2c226964223a22626561636f6e2e6c6172646572222c226f7665727269646573223a5b5d2c22706c6163656d656e74223a7b22636f6f7264696e61746573223a5b7b2224626967696e74223a22313030227d2c7b2224626967696e74223a22313030227d5d2c227370616365223a7b226964223a22626561636f6e2e68616c6c222c2276657273696f6e223a317d7d2c22747261697473223a5b5d7d
tenantid_443adfa47140780d	clockgrove.test-world	1.0.0	actors	beacon.master	1	actors/master.json	94c2a072958df8e49437dd3c7a18123010949a4ece832b9e9ef8ce62f4a4118b	\\x7b22617263686574797065223a7b226964223a22626561636f6e2e6b65657065722d6b696e64222c2276657273696f6e223a317d2c226361706162696c6974696573223a5b5d2c226964223a22626561636f6e2e6d6173746572222c226f7665727269646573223a5b5d2c22706c6163656d656e74223a7b22636f6f7264696e61746573223a5b7b2224626967696e74223a223130227d2c7b2224626967696e74223a223230227d5d2c227370616365223a7b226964223a22626561636f6e2e68616c6c222c2276657273696f6e223a317d7d2c22747261697473223a5b5d7d
tenantid_443adfa47140780d	clockgrove.test-world	1.0.0	policies	beacon.behavior	1	policies/behavior.json	596e4c2548ce5b44f885893224509118791882f8ec447ef6e1a6a609278bfa13	\\x7b22706f6c696379223a7b226465636973696f6e496e74657276616c4d73223a7b2224626967696e74223a223630303030227d2c22647279696e67506572496e74657276616c223a3130302c22656e7669726f6e6d656e74223a7b226461794c656e6774684d73223a7b2224626967696e74223a223836343030303030227d2c22646973636f6d666f72745468726573686f6c64223a363030302c22706861736573223a5b7b226c6967687442616e64223a22627269676874222c226e616d65223a22646179222c2273746172744d73223a7b2224626967696e74223a2230227d7d2c7b226c6967687442616e64223a226461726b222c226e616d65223a226e69676874222c2273746172744d73223a7b2224626967696e74223a223433323030303030227d7d5d2c22736368656d6156657273696f6e223a312c22776561746865725365676d656e7473223a5b7b226475726174696f6e4d73223a7b2224626967696e74223a2233363030303030227d2c227261696e496e74656e73697479223a302c2274656d706572617475726542616e64223a226d696c64227d2c7b226475726174696f6e4d73223a7b2224626967696e74223a2231383030303030227d2c227261696e496e74656e73697479223a353030302c2274656d706572617475726542616e64223a22636f6f6c227d5d2c227765745468726573686f6c64223a333030307d2c2268756e676572506572496e74657276616c223a3130302c2268756e676572576569676874223a353030302c22736368656d6156657273696f6e223a312c227368656c746572576569676874223a353030302c227574696c697479223a7b22626974655175616e74697479223a312c226578706563746174696f6e576569676874223a333030302c2268756e67657252656c696566506572556e6974223a313030302c2270657263657074696f6e52616e6765223a7b2224626967696e74223a2235303030227d2c22736368656d6156657273696f6e223a312c2273636f726572223a22636c6f636b67726f76652e726f7574696e652d7574696c697479222c2273636f72657256657273696f6e223a312c2274686972737452656c696566506572556e6974223a313030302c22746869727374576569676874223a353030302c2274726176656c576569676874223a323030302c22756e6974735065725365636f6e64223a7b2224626967696e74223a2231303030227d7d2c2276657273696f6e223a22626561636f6e2d31222c2277656c6c6265696e67223a7b22637269746963616c4865616c7468223a323030302c226865616c74684c6f7373506572496e74657276616c223a3130302c226865616c74685265636f76657279506572496e74657276616c223a35302c22736368656d6156657273696f6e223a312c22746869727374506572496e74657276616c223a35302c22757267656e7448756e676572223a373030302c22757267656e74546869727374223a373030307d2c227765746e657373506572496e74657276616c223a3130307d2c2274797065223a22636c6f636b67726f76652e776f726c642d6265686176696f722d706f6c696379227d
tenantid_443adfa47140780d	clockgrove.test-world	1.0.0	policies	beacon.clock	1	policies/clock.json	595dfb0207f5489316655e7a22e4aa76ffef3f342c44d3b2393f1a5252ad5906	\\x7b226465636973696f6e496e74657276616c4d73223a7b2224626967696e74223a223630303030227d2c2265706f6368223a7b2224626967696e74223a22313030303030227d2c2273696d756c6174696f6e4d696c6c697365636f6e647350657257616c6c4d696c6c697365636f6e64223a312c2274797065223a22636c6f636b67726f76652e636c6f636b2d706f6c696379222c2277616c6c45706f6368223a22323032362d30312d30315430303a30303a30302e3030305a227d
tenantid_443adfa47140780d	clockgrove.test-world	1.0.0	cognitiveSeeds	beacon.memory	1	cognition/memory.json	a116c6e6826902df650c148048790ecd55b057486d1e4519817e303e6b9a9f46	\\x7b22656e7472696573223a5b7b226163746f724964223a22626561636f6e2e6d6173746572222c226566666563746976654174223a7b2224626967696e74223a2231303030227d2c226b696e64223a226d656d6f7279222c22726566223a2273637269707465643a6369737465726e2d6d656d6f7279222c227461726765744f626a6563744964223a22626561636f6e2e6369737465726e222c2276616c7565223a343030307d5d2c22736368656d6156657273696f6e223a312c2274797065223a22636c6f636b67726f76652e73637269707465642d636f676e6974696f6e227d
tenantid_443adfa47140780d	clockgrove.test-world	1.0.0	spaces	beacon.hall	1	spaces/hall.json	50b9683b6da33a8629a3867e1602b59623cb6144274e0ad704924c3fd91e243e	\\x7b22616e63686f724772617068223a6e756c6c2c226672616d65223a7b2261786573223a7b2261786573223a5b7b226e616d65223a2278222c22706f736974697665446972656374696f6e223a2265617374227d2c7b226e616d65223a2279222c22706f736974697665446972656374696f6e223a226e6f727468227d5d7d2c2264696d656e73696f6e73223a322c226672616d654964223a226672616d652d68616c6c222c2267726176697479223a7b226b696e64223a22636f6e7374616e742d766563746f72222c22766563746f72223a5b7b2224626967696e74223a2230227d2c7b2224626967696e74223a2230227d5d7d2c226f726967696e223a5b7b2224626967696e74223a2230227d2c7b2224626967696e74223a2230227d5d2c22756e6974223a7b226672616374696f6e616c446967697473223a332c226e616d65223a226d65746572227d2c2276657273696f6e223a317d2c226964223a22626561636f6e2e68616c6c222c22726567696f6e73223a5b7b226672616d654964223a226672616d652d68616c6c222c226672616d6556657273696f6e223a312c22726567696f6e4964223a2268616c6c222c227368617065223a7b226b696e64223a2272656374616e676c65222c226d6178223a5b7b2224626967696e74223a2232303030227d2c7b2224626967696e74223a2231303030227d5d2c226d696e223a5b7b2224626967696e74223a2230227d2c7b2224626967696e74223a2230227d5d7d2c2276657273696f6e223a317d5d2c2276657273696f6e223a317d
tenantid_443adfa47140780d	clockgrove.test-world	1.0.0	rules	beacon.on-choice	1	rules/on-choice.json	f93e0a370e4dc311fbceb9e394a7aa4630a0a1e681afa038d54d269eaa0cb2aa	\\x7b2262696e64696e6773223a5b5d2c22627564676574223a7b22636f6f6c646f776e4d73223a7b2224626967696e74223a2235227d2c226d61784465707468223a332c226d617846616e6f7574223a327d2c22636f6e646974696f6e223a6e756c6c2c226964223a22626561636f6e2e6f6e2d63686f696365222c22696e74656e7473223a5b7b22636f6d6d616e6454797065223a22776f726c642e776561746865722e736574222c22636f6d6d616e6456657273696f6e223a312c227061796c6f6164223a7b227261696e496e74656e73697479223a7b226f70223a226c69746572616c222c2274797065223a22696e7465676572222c2276616c7565223a7b2224626967696e74223a2231303030227d7d7d7d5d2c22736368656d6156657273696f6e223a312c2274726967676572223a7b226576656e7454797065223a22726f7574696e652e73656c6563746564222c226576656e7456657273696f6e223a312c226b696e64223a226576656e74227d2c2276657273696f6e223a317d
tenantid_443adfa47140780d	clockgrove.test-world	1.0.0	rules	beacon.on-tide	1	rules/on-tide.json	2f027945af768175dc69e4bf055d18a7b416f6474b0cc264269d9d41d64a1e2c	\\x7b2262696e64696e6773223a5b5d2c22627564676574223a7b22636f6f6c646f776e4d73223a7b2224626967696e74223a2235227d2c226d61784465707468223a332c226d617846616e6f7574223a327d2c22636f6e646974696f6e223a6e756c6c2c226964223a22626561636f6e2e6f6e2d74696465222c22696e74656e7473223a5b7b22636f6d6d616e6454797065223a22776f726c642e776561746865722e736574222c22636f6d6d616e6456657273696f6e223a312c227061796c6f6164223a7b227261696e496e74656e73697479223a7b226f70223a226c69746572616c222c2274797065223a22696e7465676572222c2276616c7565223a7b2224626967696e74223a2232303030227d7d7d7d5d2c22736368656d6156657273696f6e223a312c2274726967676572223a7b2265766572794d73223a7b2224626967696e74223a22313230303030227d2c226b696e64223a227363686564756c65222c226f66667365744d73223a7b2224626967696e74223a2230227d7d2c2276657273696f6e223a317d
\.


--
-- Data for Name: pack_artifacts; Type: TABLE DATA; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

COPY clockgrove_birth.pack_artifacts (tenant_id, pack_id, pack_version, content_hash, engine_compatibility, resource_manifest_hash, asset_manifest_hash, migration_set_hash, build_tool_version, stored_at) FROM stdin;
tenantid_443adfa47140780d	clockgrove.test-world	1.0.0	813a3f846859e55cd95be0fbb3359e0e36238f794e6265f3ef19a1fad6597906	>=1.0.0 <2.0.0	9034bbfcdc767c5fd44e897d3b545107e7d1dd9e8e2d702428f76544139767d3	b2777dc88e82fa7bf3ce0513c4eb3bcdfa9151c0ba90c288f32e6e51d3d5c3c6	5a49b0e503fc168120bdc07d486689582e8a65170777aeb88405676b2ba64c34	clockgrove-world-pack-sdk@0.1.0	2026-10-19 23:52:18.778603-07
\.


--
-- Data for Name: pack_installations; Type: TABLE DATA; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

COPY clockgrove_birth.pack_installations (tenant_id, installation_id, case_id, world_id, pack_id, pack_version, content_hash, status, installed_at) FROM stdin;
tenantid_443adfa47140780d	installation:case-worldid_b09aed54932c8f51	case-worldid_b09aed54932c8f51	worldid_b09aed54932c8f51	clockgrove.test-world	1.0.0	813a3f846859e55cd95be0fbb3359e0e36238f794e6265f3ef19a1fad6597906	installed	2026-10-19 23:52:18.791992-07
\.


--
-- Data for Name: provisioning_cases; Type: TABLE DATA; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

COPY clockgrove_birth.provisioning_cases (tenant_id, case_id, request_hash, pack_id, pack_version, content_hash, status, attempts, seeded_commands, world_id, last_failure, failure, created_at, updated_at) FROM stdin;
tenantid_443adfa47140780d	case-worldid_b09aed54932c8f51	3e4485c4661d9bc54b84b99709aa7691adba40780f7b065455fe379ee0c338f3	clockgrove.test-world	1.0.0	813a3f846859e55cd95be0fbb3359e0e36238f794e6265f3ef19a1fad6597906	ready	1	0	worldid_b09aed54932c8f51	\N	\N	2026-10-19 23:52:18.769386-07	2026-10-19 23:52:18.820531-07
\.


--
-- Data for Name: world_birth_states; Type: TABLE DATA; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

COPY clockgrove_birth.world_birth_states (tenant_id, world_id, timeline_id, birth_version, pack_id, pack_version, content_hash, state_schema_version, state_partition_id, scalars, clock_policy, simulation_epoch, seed_projection_hash) FROM stdin;
tenantid_443adfa47140780d	worldid_b09aed54932c8f51	timelineid_a944a1d612944976	1	clockgrove.test-world	1.0.0	813a3f846859e55cd95be0fbb3359e0e36238f794e6265f3ef19a1fad6597906	1	partitionid_3acf598aeb8a3d83	["record", [["revision", ["bigint", "0"]], ["simulationTime", ["bigint", "100000"]], ["tenantId", ["string", "tenantid_443adfa47140780d"]], ["timelineId", ["string", "timelineid_a944a1d612944976"]], ["weather", ["record", [["rainIntensity", ["integer", "0"]]]]], ["worldId", ["string", "worldid_b09aed54932c8f51"]]]]	["record", [["decisionIntervalMs", ["bigint", "60000"]], ["epoch", ["bigint", "100000"]], ["simulationMillisecondsPerWallMillisecond", ["integer", "1"]], ["wallEpoch", ["string", "2026-01-01T00:00:00.000Z"]]]]	100000	4992862b743ee746a5a2b183c642b63ab7f556a626d4683ec8d142f31c367c99
\.


--
-- Data for Name: identity_links; Type: TABLE DATA; Schema: clockgrove_management; Owner: clockgrove_migrator
--

COPY clockgrove_management.identity_links (environment, subject, external_identity_id, principal_id, revoked_at) FROM stdin;
\.


--
-- Data for Name: principals; Type: TABLE DATA; Schema: clockgrove_management; Owner: clockgrove_migrator
--

COPY clockgrove_management.principals (principal_id, revoked_at) FROM stdin;
\.


--
-- Data for Name: workspace_memberships; Type: TABLE DATA; Schema: clockgrove_management; Owner: clockgrove_migrator
--

COPY clockgrove_management.workspace_memberships (tenant_id, principal_id, membership_id, roles, grants, revoked_at) FROM stdin;
\.


--
-- Name: events_journal_position_seq; Type: SEQUENCE SET; Schema: clockgrove; Owner: clockgrove_migrator
--

SELECT pg_catalog.setval('clockgrove.events_journal_position_seq', 26, true);


--
-- Name: artifact_data_keys artifact_data_keys_pkey; Type: CONSTRAINT; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove.artifact_data_keys
    ADD CONSTRAINT artifact_data_keys_pkey PRIMARY KEY (tenant_id, world_id, privacy_class, key_version);


--
-- Name: artifact_references artifact_references_pkey; Type: CONSTRAINT; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove.artifact_references
    ADD CONSTRAINT artifact_references_pkey PRIMARY KEY (tenant_id, artifact_id);


--
-- Name: artifact_references artifact_references_snapshot_target; Type: CONSTRAINT; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove.artifact_references
    ADD CONSTRAINT artifact_references_snapshot_target UNIQUE (tenant_id, artifact_id, world_id, timeline_id, partition_id, space_id, privacy_class);


--
-- Name: authority_decisions authority_decisions_pkey; Type: CONSTRAINT; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove.authority_decisions
    ADD CONSTRAINT authority_decisions_pkey PRIMARY KEY (tenant_id, authority_decision_id);


--
-- Name: authority_decisions authority_decisions_tenant_id_authority_decision_id_command_key; Type: CONSTRAINT; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove.authority_decisions
    ADD CONSTRAINT authority_decisions_tenant_id_authority_decision_id_command_key UNIQUE (tenant_id, authority_decision_id, command_id);


--
-- Name: authority_decisions authority_decisions_tenant_id_command_id_key; Type: CONSTRAINT; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove.authority_decisions
    ADD CONSTRAINT authority_decisions_tenant_id_command_id_key UNIQUE (tenant_id, command_id);


--
-- Name: command_receipts command_receipts_pkey; Type: CONSTRAINT; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove.command_receipts
    ADD CONSTRAINT command_receipts_pkey PRIMARY KEY (tenant_id, command_id);


--
-- Name: event_dispatches event_dispatches_pkey; Type: CONSTRAINT; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove.event_dispatches
    ADD CONSTRAINT event_dispatches_pkey PRIMARY KEY (tenant_id, dispatch_id);


--
-- Name: event_dispatches event_dispatches_tenant_id_event_id_channel_key; Type: CONSTRAINT; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove.event_dispatches
    ADD CONSTRAINT event_dispatches_tenant_id_event_id_channel_key UNIQUE (tenant_id, event_id, channel);


--
-- Name: events events_journal_position_key; Type: CONSTRAINT; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove.events
    ADD CONSTRAINT events_journal_position_key UNIQUE (journal_position);


--
-- Name: events events_pkey; Type: CONSTRAINT; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove.events
    ADD CONSTRAINT events_pkey PRIMARY KEY (tenant_id, event_id);


--
-- Name: events events_tenant_id_timeline_id_partition_id_partition_sequenc_key; Type: CONSTRAINT; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove.events
    ADD CONSTRAINT events_tenant_id_timeline_id_partition_id_partition_sequenc_key UNIQUE (tenant_id, timeline_id, partition_id, partition_sequence);


--
-- Name: events events_tenant_id_timeline_id_stream_id_stream_sequence_key; Type: CONSTRAINT; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove.events
    ADD CONSTRAINT events_tenant_id_timeline_id_stream_id_stream_sequence_key UNIQUE (tenant_id, timeline_id, stream_id, stream_sequence);


--
-- Name: migration_backfill_checkpoints migration_backfill_checkpoints_pkey; Type: CONSTRAINT; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove.migration_backfill_checkpoints
    ADD CONSTRAINT migration_backfill_checkpoints_pkey PRIMARY KEY (migration_name, checkpoint_key);


--
-- Name: partition_schedules partition_schedules_pkey; Type: CONSTRAINT; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove.partition_schedules
    ADD CONSTRAINT partition_schedules_pkey PRIMARY KEY (tenant_id, timeline_id, partition_id, schedule_id, idempotency_key);


--
-- Name: partition_states partition_states_pkey; Type: CONSTRAINT; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove.partition_states
    ADD CONSTRAINT partition_states_pkey PRIMARY KEY (tenant_id, timeline_id, partition_id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (migration_name);


--
-- Name: snapshots snapshots_pkey; Type: CONSTRAINT; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove.snapshots
    ADD CONSTRAINT snapshots_pkey PRIMARY KEY (tenant_id, snapshot_id);


--
-- Name: streams streams_pkey; Type: CONSTRAINT; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove.streams
    ADD CONSTRAINT streams_pkey PRIMARY KEY (tenant_id, timeline_id, stream_id);


--
-- Name: streams streams_tenant_id_world_id_timeline_id_partition_id_space_i_key; Type: CONSTRAINT; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove.streams
    ADD CONSTRAINT streams_tenant_id_world_id_timeline_id_partition_id_space_i_key UNIQUE (tenant_id, world_id, timeline_id, partition_id, space_id, stream_id);


--
-- Name: tenant_principals tenant_principals_pkey; Type: CONSTRAINT; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove.tenant_principals
    ADD CONSTRAINT tenant_principals_pkey PRIMARY KEY (tenant_id, principal_id);


--
-- Name: tenants tenants_pkey; Type: CONSTRAINT; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove.tenants
    ADD CONSTRAINT tenants_pkey PRIMARY KEY (tenant_id);


--
-- Name: timeline_partitions timeline_partitions_pkey; Type: CONSTRAINT; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove.timeline_partitions
    ADD CONSTRAINT timeline_partitions_pkey PRIMARY KEY (tenant_id, timeline_id, partition_id);


--
-- Name: timeline_partitions timeline_partitions_tenant_id_world_id_timeline_id_partiti_key1; Type: CONSTRAINT; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove.timeline_partitions
    ADD CONSTRAINT timeline_partitions_tenant_id_world_id_timeline_id_partiti_key1 UNIQUE (tenant_id, world_id, timeline_id, partition_id, space_id);


--
-- Name: timeline_partitions timeline_partitions_tenant_id_world_id_timeline_id_partitio_key; Type: CONSTRAINT; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove.timeline_partitions
    ADD CONSTRAINT timeline_partitions_tenant_id_world_id_timeline_id_partitio_key UNIQUE (tenant_id, world_id, timeline_id, partition_id);


--
-- Name: timelines timelines_pkey; Type: CONSTRAINT; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove.timelines
    ADD CONSTRAINT timelines_pkey PRIMARY KEY (tenant_id, timeline_id);


--
-- Name: timelines timelines_tenant_id_world_id_timeline_id_key; Type: CONSTRAINT; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove.timelines
    ADD CONSTRAINT timelines_tenant_id_world_id_timeline_id_key UNIQUE (tenant_id, world_id, timeline_id);


--
-- Name: world_memberships world_memberships_pkey; Type: CONSTRAINT; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove.world_memberships
    ADD CONSTRAINT world_memberships_pkey PRIMARY KEY (tenant_id, world_id, timeline_id, space_id, principal_id);


--
-- Name: worlds worlds_pkey; Type: CONSTRAINT; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove.worlds
    ADD CONSTRAINT worlds_pkey PRIMARY KEY (tenant_id, world_id);


--
-- Name: account account_pkey; Type: CONSTRAINT; Schema: clockgrove_auth; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove_auth.account
    ADD CONSTRAINT account_pkey PRIMARY KEY (id);


--
-- Name: session session_pkey; Type: CONSTRAINT; Schema: clockgrove_auth; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove_auth.session
    ADD CONSTRAINT session_pkey PRIMARY KEY (id);


--
-- Name: session session_token_key; Type: CONSTRAINT; Schema: clockgrove_auth; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove_auth.session
    ADD CONSTRAINT session_token_key UNIQUE (token);


--
-- Name: user user_email_key; Type: CONSTRAINT; Schema: clockgrove_auth; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove_auth."user"
    ADD CONSTRAINT user_email_key UNIQUE (email);


--
-- Name: user user_pkey; Type: CONSTRAINT; Schema: clockgrove_auth; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove_auth."user"
    ADD CONSTRAINT user_pkey PRIMARY KEY (id);


--
-- Name: verification verification_pkey; Type: CONSTRAINT; Schema: clockgrove_auth; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove_auth.verification
    ADD CONSTRAINT verification_pkey PRIMARY KEY (id);


--
-- Name: birth_cognitive_seed_refs birth_cognitive_seed_refs_pkey; Type: CONSTRAINT; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove_birth.birth_cognitive_seed_refs
    ADD CONSTRAINT birth_cognitive_seed_refs_pkey PRIMARY KEY (tenant_id, world_id, timeline_id, birth_version, ordinal);


--
-- Name: birth_random_streams birth_random_streams_pkey; Type: CONSTRAINT; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove_birth.birth_random_streams
    ADD CONSTRAINT birth_random_streams_pkey PRIMARY KEY (tenant_id, world_id, timeline_id, birth_version, stream_name);


--
-- Name: birth_schedules birth_schedules_pkey; Type: CONSTRAINT; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove_birth.birth_schedules
    ADD CONSTRAINT birth_schedules_pkey PRIMARY KEY (tenant_id, world_id, timeline_id, birth_version, ordinal);


--
-- Name: birth_space_state birth_space_state_pkey; Type: CONSTRAINT; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove_birth.birth_space_state
    ADD CONSTRAINT birth_space_state_pkey PRIMARY KEY (tenant_id, world_id, timeline_id, birth_version, element_kind, element_key);


--
-- Name: birth_space_state birth_space_state_tenant_id_world_id_timeline_id_birth_vers_key; Type: CONSTRAINT; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove_birth.birth_space_state
    ADD CONSTRAINT birth_space_state_tenant_id_world_id_timeline_id_birth_vers_key UNIQUE (tenant_id, world_id, timeline_id, birth_version, element_kind, ordinal);


--
-- Name: birth_state_sections birth_state_sections_pkey; Type: CONSTRAINT; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove_birth.birth_state_sections
    ADD CONSTRAINT birth_state_sections_pkey PRIMARY KEY (tenant_id, world_id, timeline_id, birth_version, section);


--
-- Name: pack_artifact_resources pack_artifact_resources_pkey; Type: CONSTRAINT; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove_birth.pack_artifact_resources
    ADD CONSTRAINT pack_artifact_resources_pkey PRIMARY KEY (tenant_id, pack_id, pack_version, path);


--
-- Name: pack_artifact_resources pack_artifact_resources_tenant_id_pack_id_pack_version_reso_key; Type: CONSTRAINT; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove_birth.pack_artifact_resources
    ADD CONSTRAINT pack_artifact_resources_tenant_id_pack_id_pack_version_reso_key UNIQUE (tenant_id, pack_id, pack_version, resource_kind, resource_id, resource_version, sha256);


--
-- Name: pack_artifacts pack_artifacts_pkey; Type: CONSTRAINT; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove_birth.pack_artifacts
    ADD CONSTRAINT pack_artifacts_pkey PRIMARY KEY (tenant_id, pack_id, pack_version);


--
-- Name: pack_artifacts pack_artifacts_tenant_id_pack_id_pack_version_content_hash_key; Type: CONSTRAINT; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove_birth.pack_artifacts
    ADD CONSTRAINT pack_artifacts_tenant_id_pack_id_pack_version_content_hash_key UNIQUE (tenant_id, pack_id, pack_version, content_hash);


--
-- Name: pack_installations pack_installations_pkey; Type: CONSTRAINT; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove_birth.pack_installations
    ADD CONSTRAINT pack_installations_pkey PRIMARY KEY (tenant_id, installation_id);


--
-- Name: pack_installations pack_installations_tenant_id_case_id_key; Type: CONSTRAINT; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove_birth.pack_installations
    ADD CONSTRAINT pack_installations_tenant_id_case_id_key UNIQUE (tenant_id, case_id);


--
-- Name: pack_installations pack_installations_tenant_id_world_id_key; Type: CONSTRAINT; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove_birth.pack_installations
    ADD CONSTRAINT pack_installations_tenant_id_world_id_key UNIQUE (tenant_id, world_id);


--
-- Name: provisioning_cases provisioning_cases_pkey; Type: CONSTRAINT; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove_birth.provisioning_cases
    ADD CONSTRAINT provisioning_cases_pkey PRIMARY KEY (tenant_id, case_id);


--
-- Name: provisioning_cases provisioning_cases_tenant_id_case_id_world_id_key; Type: CONSTRAINT; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove_birth.provisioning_cases
    ADD CONSTRAINT provisioning_cases_tenant_id_case_id_world_id_key UNIQUE (tenant_id, case_id, world_id);


--
-- Name: world_birth_states world_birth_states_pkey; Type: CONSTRAINT; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove_birth.world_birth_states
    ADD CONSTRAINT world_birth_states_pkey PRIMARY KEY (tenant_id, world_id, timeline_id, birth_version);


--
-- Name: identity_links identity_links_external_identity_id_key; Type: CONSTRAINT; Schema: clockgrove_management; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove_management.identity_links
    ADD CONSTRAINT identity_links_external_identity_id_key UNIQUE (external_identity_id);


--
-- Name: identity_links identity_links_pkey; Type: CONSTRAINT; Schema: clockgrove_management; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove_management.identity_links
    ADD CONSTRAINT identity_links_pkey PRIMARY KEY (environment, subject);


--
-- Name: principals principals_pkey; Type: CONSTRAINT; Schema: clockgrove_management; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove_management.principals
    ADD CONSTRAINT principals_pkey PRIMARY KEY (principal_id);


--
-- Name: workspace_memberships workspace_memberships_membership_id_key; Type: CONSTRAINT; Schema: clockgrove_management; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove_management.workspace_memberships
    ADD CONSTRAINT workspace_memberships_membership_id_key UNIQUE (membership_id);


--
-- Name: workspace_memberships workspace_memberships_pkey; Type: CONSTRAINT; Schema: clockgrove_management; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove_management.workspace_memberships
    ADD CONSTRAINT workspace_memberships_pkey PRIMARY KEY (tenant_id, principal_id);


--
-- Name: event_dispatches_pending_idx; Type: INDEX; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE INDEX event_dispatches_pending_idx ON clockgrove.event_dispatches USING btree (channel, status, next_attempt_at);


--
-- Name: events_actor_simulation_time_idx; Type: INDEX; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE INDEX events_actor_simulation_time_idx ON clockgrove.events USING btree (tenant_id, timeline_id, actor_id, simulation_time) WHERE (actor_id IS NOT NULL);


--
-- Name: events_append_lookup_idx; Type: INDEX; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE INDEX events_append_lookup_idx ON clockgrove.events USING btree (tenant_id, timeline_id, partition_id, journal_position);


--
-- Name: events_causation_idx; Type: INDEX; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE INDEX events_causation_idx ON clockgrove.events USING btree (tenant_id, causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_command_idx; Type: INDEX; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE INDEX events_command_idx ON clockgrove.events USING btree (tenant_id, command_id);


--
-- Name: events_correlation_idx; Type: INDEX; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE INDEX events_correlation_idx ON clockgrove.events USING btree (tenant_id, correlation_id);


--
-- Name: events_object_simulation_time_idx; Type: INDEX; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE INDEX events_object_simulation_time_idx ON clockgrove.events USING btree (tenant_id, timeline_id, object_id, simulation_time) WHERE (object_id IS NOT NULL);


--
-- Name: events_privacy_idx; Type: INDEX; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE INDEX events_privacy_idx ON clockgrove.events USING btree (tenant_id, privacy_class, recorded_at);


--
-- Name: events_recorded_at_idx; Type: INDEX; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE INDEX events_recorded_at_idx ON clockgrove.events USING btree (tenant_id, recorded_at);


--
-- Name: partition_schedules_due_idx; Type: INDEX; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE UNIQUE INDEX partition_schedules_due_idx ON clockgrove.partition_schedules USING btree (tenant_id, timeline_id, partition_id, due_at, priority, tie_break_key) WHERE (status = 'pending'::text);


--
-- Name: partition_schedules_pending_id; Type: INDEX; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE UNIQUE INDEX partition_schedules_pending_id ON clockgrove.partition_schedules USING btree (tenant_id, timeline_id, partition_id, schedule_id) WHERE (status = 'pending'::text);


--
-- Name: snapshots_partition_head; Type: INDEX; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE UNIQUE INDEX snapshots_partition_head ON clockgrove.snapshots USING btree (tenant_id, timeline_id, partition_id, covered_partition_sequence);


--
-- Name: account_user_idx; Type: INDEX; Schema: clockgrove_auth; Owner: clockgrove_migrator
--

CREATE INDEX account_user_idx ON clockgrove_auth.account USING btree ("userId");


--
-- Name: session_user_idx; Type: INDEX; Schema: clockgrove_auth; Owner: clockgrove_migrator
--

CREATE INDEX session_user_idx ON clockgrove_auth.session USING btree ("userId");


--
-- Name: verification_identifier_idx; Type: INDEX; Schema: clockgrove_auth; Owner: clockgrove_migrator
--

CREATE INDEX verification_identifier_idx ON clockgrove_auth.verification USING btree (identifier);


--
-- Name: authority_decisions authority_decisions_immutable_rows; Type: TRIGGER; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE TRIGGER authority_decisions_immutable_rows BEFORE DELETE OR UPDATE ON clockgrove.authority_decisions FOR EACH ROW EXECUTE FUNCTION clockgrove.reject_journal_mutation();


--
-- Name: authority_decisions authority_decisions_immutable_truncate; Type: TRIGGER; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE TRIGGER authority_decisions_immutable_truncate BEFORE TRUNCATE ON clockgrove.authority_decisions FOR EACH STATEMENT EXECUTE FUNCTION clockgrove.reject_journal_mutation();


--
-- Name: command_receipts command_receipts_guard_transition; Type: TRIGGER; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE TRIGGER command_receipts_guard_transition BEFORE DELETE OR UPDATE ON clockgrove.command_receipts FOR EACH ROW EXECUTE FUNCTION clockgrove.guard_command_receipt();


--
-- Name: command_receipts command_receipts_immutable_request; Type: TRIGGER; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE TRIGGER command_receipts_immutable_request BEFORE UPDATE ON clockgrove.command_receipts FOR EACH ROW EXECUTE FUNCTION clockgrove.preserve_command_request();


--
-- Name: command_receipts command_receipts_immutable_truncate; Type: TRIGGER; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE TRIGGER command_receipts_immutable_truncate BEFORE TRUNCATE ON clockgrove.command_receipts FOR EACH STATEMENT EXECUTE FUNCTION clockgrove.reject_journal_mutation();


--
-- Name: event_dispatches event_dispatches_preview_effect_policy; Type: TRIGGER; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE TRIGGER event_dispatches_preview_effect_policy BEFORE INSERT ON clockgrove.event_dispatches FOR EACH ROW EXECUTE FUNCTION clockgrove.guard_preview_effect_dispatch();


--
-- Name: partition_schedules partition_schedules_guard; Type: TRIGGER; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE TRIGGER partition_schedules_guard BEFORE DELETE OR UPDATE ON clockgrove.partition_schedules FOR EACH ROW EXECUTE FUNCTION clockgrove.guard_partition_schedule();


--
-- Name: partition_states partition_states_guard; Type: TRIGGER; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE TRIGGER partition_states_guard BEFORE DELETE OR UPDATE ON clockgrove.partition_states FOR EACH ROW EXECUTE FUNCTION clockgrove.guard_partition_state();


--
-- Name: birth_cognitive_seed_refs birth_cognitive_seed_refs_immutable_rows; Type: TRIGGER; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

CREATE TRIGGER birth_cognitive_seed_refs_immutable_rows BEFORE DELETE OR UPDATE ON clockgrove_birth.birth_cognitive_seed_refs FOR EACH ROW EXECUTE FUNCTION clockgrove_birth.reject_mutation();


--
-- Name: birth_cognitive_seed_refs birth_cognitive_seed_refs_immutable_truncate; Type: TRIGGER; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

CREATE TRIGGER birth_cognitive_seed_refs_immutable_truncate BEFORE TRUNCATE ON clockgrove_birth.birth_cognitive_seed_refs FOR EACH STATEMENT EXECUTE FUNCTION clockgrove_birth.reject_mutation();


--
-- Name: birth_random_streams birth_random_streams_immutable_rows; Type: TRIGGER; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

CREATE TRIGGER birth_random_streams_immutable_rows BEFORE DELETE OR UPDATE ON clockgrove_birth.birth_random_streams FOR EACH ROW EXECUTE FUNCTION clockgrove_birth.reject_mutation();


--
-- Name: birth_random_streams birth_random_streams_immutable_truncate; Type: TRIGGER; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

CREATE TRIGGER birth_random_streams_immutable_truncate BEFORE TRUNCATE ON clockgrove_birth.birth_random_streams FOR EACH STATEMENT EXECUTE FUNCTION clockgrove_birth.reject_mutation();


--
-- Name: birth_schedules birth_schedules_immutable_rows; Type: TRIGGER; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

CREATE TRIGGER birth_schedules_immutable_rows BEFORE DELETE OR UPDATE ON clockgrove_birth.birth_schedules FOR EACH ROW EXECUTE FUNCTION clockgrove_birth.reject_mutation();


--
-- Name: birth_schedules birth_schedules_immutable_truncate; Type: TRIGGER; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

CREATE TRIGGER birth_schedules_immutable_truncate BEFORE TRUNCATE ON clockgrove_birth.birth_schedules FOR EACH STATEMENT EXECUTE FUNCTION clockgrove_birth.reject_mutation();


--
-- Name: birth_space_state birth_space_state_immutable_rows; Type: TRIGGER; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

CREATE TRIGGER birth_space_state_immutable_rows BEFORE DELETE OR UPDATE ON clockgrove_birth.birth_space_state FOR EACH ROW EXECUTE FUNCTION clockgrove_birth.reject_mutation();


--
-- Name: birth_space_state birth_space_state_immutable_truncate; Type: TRIGGER; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

CREATE TRIGGER birth_space_state_immutable_truncate BEFORE TRUNCATE ON clockgrove_birth.birth_space_state FOR EACH STATEMENT EXECUTE FUNCTION clockgrove_birth.reject_mutation();


--
-- Name: birth_state_sections birth_state_sections_immutable_rows; Type: TRIGGER; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

CREATE TRIGGER birth_state_sections_immutable_rows BEFORE DELETE OR UPDATE ON clockgrove_birth.birth_state_sections FOR EACH ROW EXECUTE FUNCTION clockgrove_birth.reject_mutation();


--
-- Name: birth_state_sections birth_state_sections_immutable_truncate; Type: TRIGGER; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

CREATE TRIGGER birth_state_sections_immutable_truncate BEFORE TRUNCATE ON clockgrove_birth.birth_state_sections FOR EACH STATEMENT EXECUTE FUNCTION clockgrove_birth.reject_mutation();


--
-- Name: pack_artifact_resources pack_artifact_resources_immutable_rows; Type: TRIGGER; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

CREATE TRIGGER pack_artifact_resources_immutable_rows BEFORE DELETE OR UPDATE ON clockgrove_birth.pack_artifact_resources FOR EACH ROW EXECUTE FUNCTION clockgrove_birth.reject_mutation();


--
-- Name: pack_artifact_resources pack_artifact_resources_immutable_truncate; Type: TRIGGER; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

CREATE TRIGGER pack_artifact_resources_immutable_truncate BEFORE TRUNCATE ON clockgrove_birth.pack_artifact_resources FOR EACH STATEMENT EXECUTE FUNCTION clockgrove_birth.reject_mutation();


--
-- Name: pack_artifacts pack_artifacts_immutable_rows; Type: TRIGGER; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

CREATE TRIGGER pack_artifacts_immutable_rows BEFORE DELETE OR UPDATE ON clockgrove_birth.pack_artifacts FOR EACH ROW EXECUTE FUNCTION clockgrove_birth.reject_mutation();


--
-- Name: pack_artifacts pack_artifacts_immutable_truncate; Type: TRIGGER; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

CREATE TRIGGER pack_artifacts_immutable_truncate BEFORE TRUNCATE ON clockgrove_birth.pack_artifacts FOR EACH STATEMENT EXECUTE FUNCTION clockgrove_birth.reject_mutation();


--
-- Name: pack_installations pack_installations_immutable_rows; Type: TRIGGER; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

CREATE TRIGGER pack_installations_immutable_rows BEFORE DELETE OR UPDATE ON clockgrove_birth.pack_installations FOR EACH ROW EXECUTE FUNCTION clockgrove_birth.reject_mutation();


--
-- Name: pack_installations pack_installations_immutable_truncate; Type: TRIGGER; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

CREATE TRIGGER pack_installations_immutable_truncate BEFORE TRUNCATE ON clockgrove_birth.pack_installations FOR EACH STATEMENT EXECUTE FUNCTION clockgrove_birth.reject_mutation();


--
-- Name: provisioning_cases provisioning_cases_guard_transition; Type: TRIGGER; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

CREATE TRIGGER provisioning_cases_guard_transition BEFORE UPDATE ON clockgrove_birth.provisioning_cases FOR EACH ROW EXECUTE FUNCTION clockgrove_birth.guard_case_transition();


--
-- Name: world_birth_states world_birth_states_immutable_rows; Type: TRIGGER; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

CREATE TRIGGER world_birth_states_immutable_rows BEFORE DELETE OR UPDATE ON clockgrove_birth.world_birth_states FOR EACH ROW EXECUTE FUNCTION clockgrove_birth.reject_mutation();


--
-- Name: world_birth_states world_birth_states_immutable_truncate; Type: TRIGGER; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

CREATE TRIGGER world_birth_states_immutable_truncate BEFORE TRUNCATE ON clockgrove_birth.world_birth_states FOR EACH STATEMENT EXECUTE FUNCTION clockgrove_birth.reject_mutation();


--
-- Name: artifact_data_keys artifact_data_keys_tenant_id_world_id_fkey; Type: FK CONSTRAINT; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove.artifact_data_keys
    ADD CONSTRAINT artifact_data_keys_tenant_id_world_id_fkey FOREIGN KEY (tenant_id, world_id) REFERENCES clockgrove.worlds(tenant_id, world_id);


--
-- Name: artifact_references artifact_references_data_key; Type: FK CONSTRAINT; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove.artifact_references
    ADD CONSTRAINT artifact_references_data_key FOREIGN KEY (tenant_id, world_id, privacy_class, data_key_version) REFERENCES clockgrove.artifact_data_keys(tenant_id, world_id, privacy_class, key_version);


--
-- Name: artifact_references artifact_references_tenant_id_world_id_timeline_id_partiti_fkey; Type: FK CONSTRAINT; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove.artifact_references
    ADD CONSTRAINT artifact_references_tenant_id_world_id_timeline_id_partiti_fkey FOREIGN KEY (tenant_id, world_id, timeline_id, partition_id, space_id) REFERENCES clockgrove.timeline_partitions(tenant_id, world_id, timeline_id, partition_id, space_id);


--
-- Name: authority_decisions authority_decisions_tenant_id_command_id_fkey; Type: FK CONSTRAINT; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove.authority_decisions
    ADD CONSTRAINT authority_decisions_tenant_id_command_id_fkey FOREIGN KEY (tenant_id, command_id) REFERENCES clockgrove.command_receipts(tenant_id, command_id);


--
-- Name: authority_decisions authority_decisions_tenant_id_fkey; Type: FK CONSTRAINT; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove.authority_decisions
    ADD CONSTRAINT authority_decisions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES clockgrove.tenants(tenant_id);


--
-- Name: authority_decisions authority_decisions_tenant_id_world_id_timeline_id_fkey; Type: FK CONSTRAINT; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove.authority_decisions
    ADD CONSTRAINT authority_decisions_tenant_id_world_id_timeline_id_fkey FOREIGN KEY (tenant_id, world_id, timeline_id) REFERENCES clockgrove.timelines(tenant_id, world_id, timeline_id);


--
-- Name: command_receipts command_receipts_authority_decision_fkey; Type: FK CONSTRAINT; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove.command_receipts
    ADD CONSTRAINT command_receipts_authority_decision_fkey FOREIGN KEY (tenant_id, authority_decision_id, command_id) REFERENCES clockgrove.authority_decisions(tenant_id, authority_decision_id, command_id);


--
-- Name: command_receipts command_receipts_tenant_id_fkey; Type: FK CONSTRAINT; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove.command_receipts
    ADD CONSTRAINT command_receipts_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES clockgrove.tenants(tenant_id);


--
-- Name: event_dispatches event_dispatches_tenant_id_event_id_fkey; Type: FK CONSTRAINT; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove.event_dispatches
    ADD CONSTRAINT event_dispatches_tenant_id_event_id_fkey FOREIGN KEY (tenant_id, event_id) REFERENCES clockgrove.events(tenant_id, event_id);


--
-- Name: event_dispatches event_dispatches_tenant_id_world_id_timeline_id_partition__fkey; Type: FK CONSTRAINT; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove.event_dispatches
    ADD CONSTRAINT event_dispatches_tenant_id_world_id_timeline_id_partition__fkey FOREIGN KEY (tenant_id, world_id, timeline_id, partition_id, space_id) REFERENCES clockgrove.timeline_partitions(tenant_id, world_id, timeline_id, partition_id, space_id);


--
-- Name: events events_tenant_id_world_id_timeline_id_partition_id_space_i_fkey; Type: FK CONSTRAINT; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove.events
    ADD CONSTRAINT events_tenant_id_world_id_timeline_id_partition_id_space_i_fkey FOREIGN KEY (tenant_id, world_id, timeline_id, partition_id, space_id, stream_id) REFERENCES clockgrove.streams(tenant_id, world_id, timeline_id, partition_id, space_id, stream_id);


--
-- Name: partition_schedules partition_schedules_tenant_id_timeline_id_partition_id_fkey; Type: FK CONSTRAINT; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove.partition_schedules
    ADD CONSTRAINT partition_schedules_tenant_id_timeline_id_partition_id_fkey FOREIGN KEY (tenant_id, timeline_id, partition_id) REFERENCES clockgrove.partition_states(tenant_id, timeline_id, partition_id);


--
-- Name: partition_schedules partition_schedules_tenant_id_world_id_timeline_id_partiti_fkey; Type: FK CONSTRAINT; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove.partition_schedules
    ADD CONSTRAINT partition_schedules_tenant_id_world_id_timeline_id_partiti_fkey FOREIGN KEY (tenant_id, world_id, timeline_id, partition_id, space_id) REFERENCES clockgrove.timeline_partitions(tenant_id, world_id, timeline_id, partition_id, space_id);


--
-- Name: partition_states partition_states_tenant_id_world_id_timeline_id_partition__fkey; Type: FK CONSTRAINT; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove.partition_states
    ADD CONSTRAINT partition_states_tenant_id_world_id_timeline_id_partition__fkey FOREIGN KEY (tenant_id, world_id, timeline_id, partition_id, space_id) REFERENCES clockgrove.timeline_partitions(tenant_id, world_id, timeline_id, partition_id, space_id);


--
-- Name: snapshots snapshots_artifact_target; Type: FK CONSTRAINT; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove.snapshots
    ADD CONSTRAINT snapshots_artifact_target FOREIGN KEY (tenant_id, artifact_id, world_id, timeline_id, partition_id, space_id, privacy_class) REFERENCES clockgrove.artifact_references(tenant_id, artifact_id, world_id, timeline_id, partition_id, space_id, privacy_class);


--
-- Name: snapshots snapshots_tenant_id_world_id_timeline_id_partition_id_spac_fkey; Type: FK CONSTRAINT; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove.snapshots
    ADD CONSTRAINT snapshots_tenant_id_world_id_timeline_id_partition_id_spac_fkey FOREIGN KEY (tenant_id, world_id, timeline_id, partition_id, space_id, stream_id) REFERENCES clockgrove.streams(tenant_id, world_id, timeline_id, partition_id, space_id, stream_id);


--
-- Name: streams streams_tenant_id_world_id_timeline_id_partition_id_space__fkey; Type: FK CONSTRAINT; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove.streams
    ADD CONSTRAINT streams_tenant_id_world_id_timeline_id_partition_id_space__fkey FOREIGN KEY (tenant_id, world_id, timeline_id, partition_id, space_id) REFERENCES clockgrove.timeline_partitions(tenant_id, world_id, timeline_id, partition_id, space_id);


--
-- Name: tenant_principals tenant_principals_tenant_id_fkey; Type: FK CONSTRAINT; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove.tenant_principals
    ADD CONSTRAINT tenant_principals_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES clockgrove.tenants(tenant_id);


--
-- Name: timeline_partitions timeline_partitions_tenant_id_world_id_timeline_id_fkey; Type: FK CONSTRAINT; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove.timeline_partitions
    ADD CONSTRAINT timeline_partitions_tenant_id_world_id_timeline_id_fkey FOREIGN KEY (tenant_id, world_id, timeline_id) REFERENCES clockgrove.timelines(tenant_id, world_id, timeline_id);


--
-- Name: timelines timelines_tenant_id_world_id_fkey; Type: FK CONSTRAINT; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove.timelines
    ADD CONSTRAINT timelines_tenant_id_world_id_fkey FOREIGN KEY (tenant_id, world_id) REFERENCES clockgrove.worlds(tenant_id, world_id);


--
-- Name: world_memberships world_memberships_tenant_id_principal_id_fkey; Type: FK CONSTRAINT; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove.world_memberships
    ADD CONSTRAINT world_memberships_tenant_id_principal_id_fkey FOREIGN KEY (tenant_id, principal_id) REFERENCES clockgrove.tenant_principals(tenant_id, principal_id);


--
-- Name: world_memberships world_memberships_tenant_id_world_id_timeline_id_fkey; Type: FK CONSTRAINT; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove.world_memberships
    ADD CONSTRAINT world_memberships_tenant_id_world_id_timeline_id_fkey FOREIGN KEY (tenant_id, world_id, timeline_id) REFERENCES clockgrove.timelines(tenant_id, world_id, timeline_id);


--
-- Name: worlds worlds_tenant_id_fkey; Type: FK CONSTRAINT; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove.worlds
    ADD CONSTRAINT worlds_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES clockgrove.tenants(tenant_id);


--
-- Name: account account_userId_fkey; Type: FK CONSTRAINT; Schema: clockgrove_auth; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove_auth.account
    ADD CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES clockgrove_auth."user"(id) ON DELETE CASCADE;


--
-- Name: session session_userId_fkey; Type: FK CONSTRAINT; Schema: clockgrove_auth; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove_auth.session
    ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES clockgrove_auth."user"(id) ON DELETE CASCADE;


--
-- Name: birth_cognitive_seed_refs birth_cognitive_seed_refs_tenant_id_pack_id_pack_version_s_fkey; Type: FK CONSTRAINT; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove_birth.birth_cognitive_seed_refs
    ADD CONSTRAINT birth_cognitive_seed_refs_tenant_id_pack_id_pack_version_s_fkey FOREIGN KEY (tenant_id, pack_id, pack_version, seed_kind, seed_id, seed_version, sha256) REFERENCES clockgrove_birth.pack_artifact_resources(tenant_id, pack_id, pack_version, resource_kind, resource_id, resource_version, sha256);


--
-- Name: birth_cognitive_seed_refs birth_cognitive_seed_refs_tenant_id_world_id_timeline_id_b_fkey; Type: FK CONSTRAINT; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove_birth.birth_cognitive_seed_refs
    ADD CONSTRAINT birth_cognitive_seed_refs_tenant_id_world_id_timeline_id_b_fkey FOREIGN KEY (tenant_id, world_id, timeline_id, birth_version) REFERENCES clockgrove_birth.world_birth_states(tenant_id, world_id, timeline_id, birth_version);


--
-- Name: birth_random_streams birth_random_streams_tenant_id_world_id_timeline_id_birth__fkey; Type: FK CONSTRAINT; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove_birth.birth_random_streams
    ADD CONSTRAINT birth_random_streams_tenant_id_world_id_timeline_id_birth__fkey FOREIGN KEY (tenant_id, world_id, timeline_id, birth_version) REFERENCES clockgrove_birth.world_birth_states(tenant_id, world_id, timeline_id, birth_version);


--
-- Name: birth_schedules birth_schedules_tenant_id_world_id_timeline_id_birth_versi_fkey; Type: FK CONSTRAINT; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove_birth.birth_schedules
    ADD CONSTRAINT birth_schedules_tenant_id_world_id_timeline_id_birth_versi_fkey FOREIGN KEY (tenant_id, world_id, timeline_id, birth_version) REFERENCES clockgrove_birth.world_birth_states(tenant_id, world_id, timeline_id, birth_version);


--
-- Name: birth_space_state birth_space_state_tenant_id_world_id_timeline_id_birth_ver_fkey; Type: FK CONSTRAINT; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove_birth.birth_space_state
    ADD CONSTRAINT birth_space_state_tenant_id_world_id_timeline_id_birth_ver_fkey FOREIGN KEY (tenant_id, world_id, timeline_id, birth_version) REFERENCES clockgrove_birth.world_birth_states(tenant_id, world_id, timeline_id, birth_version);


--
-- Name: birth_space_state birth_space_state_tenant_id_world_id_timeline_id_partition_fkey; Type: FK CONSTRAINT; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove_birth.birth_space_state
    ADD CONSTRAINT birth_space_state_tenant_id_world_id_timeline_id_partition_fkey FOREIGN KEY (tenant_id, world_id, timeline_id, partition_id, space_id) REFERENCES clockgrove.timeline_partitions(tenant_id, world_id, timeline_id, partition_id, space_id);


--
-- Name: birth_state_sections birth_state_sections_tenant_id_world_id_timeline_id_birth__fkey; Type: FK CONSTRAINT; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove_birth.birth_state_sections
    ADD CONSTRAINT birth_state_sections_tenant_id_world_id_timeline_id_birth__fkey FOREIGN KEY (tenant_id, world_id, timeline_id, birth_version) REFERENCES clockgrove_birth.world_birth_states(tenant_id, world_id, timeline_id, birth_version);


--
-- Name: pack_artifact_resources pack_artifact_resources_tenant_id_pack_id_pack_version_fkey; Type: FK CONSTRAINT; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove_birth.pack_artifact_resources
    ADD CONSTRAINT pack_artifact_resources_tenant_id_pack_id_pack_version_fkey FOREIGN KEY (tenant_id, pack_id, pack_version) REFERENCES clockgrove_birth.pack_artifacts(tenant_id, pack_id, pack_version);


--
-- Name: pack_artifacts pack_artifacts_tenant_id_fkey; Type: FK CONSTRAINT; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove_birth.pack_artifacts
    ADD CONSTRAINT pack_artifacts_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES clockgrove.tenants(tenant_id);


--
-- Name: pack_installations pack_installations_tenant_id_case_id_world_id_fkey; Type: FK CONSTRAINT; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove_birth.pack_installations
    ADD CONSTRAINT pack_installations_tenant_id_case_id_world_id_fkey FOREIGN KEY (tenant_id, case_id, world_id) REFERENCES clockgrove_birth.provisioning_cases(tenant_id, case_id, world_id);


--
-- Name: pack_installations pack_installations_tenant_id_pack_id_pack_version_content__fkey; Type: FK CONSTRAINT; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove_birth.pack_installations
    ADD CONSTRAINT pack_installations_tenant_id_pack_id_pack_version_content__fkey FOREIGN KEY (tenant_id, pack_id, pack_version, content_hash) REFERENCES clockgrove_birth.pack_artifacts(tenant_id, pack_id, pack_version, content_hash);


--
-- Name: provisioning_cases provisioning_cases_tenant_id_fkey; Type: FK CONSTRAINT; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove_birth.provisioning_cases
    ADD CONSTRAINT provisioning_cases_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES clockgrove.tenants(tenant_id);


--
-- Name: provisioning_cases provisioning_cases_tenant_id_world_id_fkey; Type: FK CONSTRAINT; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove_birth.provisioning_cases
    ADD CONSTRAINT provisioning_cases_tenant_id_world_id_fkey FOREIGN KEY (tenant_id, world_id) REFERENCES clockgrove.worlds(tenant_id, world_id);


--
-- Name: world_birth_states world_birth_states_tenant_id_pack_id_pack_version_content__fkey; Type: FK CONSTRAINT; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove_birth.world_birth_states
    ADD CONSTRAINT world_birth_states_tenant_id_pack_id_pack_version_content__fkey FOREIGN KEY (tenant_id, pack_id, pack_version, content_hash) REFERENCES clockgrove_birth.pack_artifacts(tenant_id, pack_id, pack_version, content_hash);


--
-- Name: world_birth_states world_birth_states_tenant_id_world_id_timeline_id_fkey; Type: FK CONSTRAINT; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove_birth.world_birth_states
    ADD CONSTRAINT world_birth_states_tenant_id_world_id_timeline_id_fkey FOREIGN KEY (tenant_id, world_id, timeline_id) REFERENCES clockgrove.timelines(tenant_id, world_id, timeline_id);


--
-- Name: identity_links identity_links_principal_id_fkey; Type: FK CONSTRAINT; Schema: clockgrove_management; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove_management.identity_links
    ADD CONSTRAINT identity_links_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES clockgrove_management.principals(principal_id);


--
-- Name: workspace_memberships workspace_memberships_principal_id_fkey; Type: FK CONSTRAINT; Schema: clockgrove_management; Owner: clockgrove_migrator
--

ALTER TABLE ONLY clockgrove_management.workspace_memberships
    ADD CONSTRAINT workspace_memberships_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES clockgrove_management.principals(principal_id);


--
-- Name: artifact_data_keys; Type: ROW SECURITY; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE clockgrove.artifact_data_keys ENABLE ROW LEVEL SECURITY;

--
-- Name: artifact_references; Type: ROW SECURITY; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE clockgrove.artifact_references ENABLE ROW LEVEL SECURITY;

--
-- Name: authority_decisions; Type: ROW SECURITY; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE clockgrove.authority_decisions ENABLE ROW LEVEL SECURITY;

--
-- Name: command_receipts; Type: ROW SECURITY; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE clockgrove.command_receipts ENABLE ROW LEVEL SECURITY;

--
-- Name: event_dispatches; Type: ROW SECURITY; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE clockgrove.event_dispatches ENABLE ROW LEVEL SECURITY;

--
-- Name: events; Type: ROW SECURITY; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE clockgrove.events ENABLE ROW LEVEL SECURITY;

--
-- Name: partition_schedules; Type: ROW SECURITY; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE clockgrove.partition_schedules ENABLE ROW LEVEL SECURITY;

--
-- Name: partition_states; Type: ROW SECURITY; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE clockgrove.partition_states ENABLE ROW LEVEL SECURITY;

--
-- Name: world_memberships scoped_authority_read; Type: POLICY; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE POLICY scoped_authority_read ON clockgrove.world_memberships FOR SELECT TO clockgrove_world_reader USING (((revoked_at IS NULL) AND (tenant_id = current_setting('app.tenant_id'::text, true)) AND (principal_id = current_setting('app.principal_id'::text, true)) AND (world_id = current_setting('app.world_id'::text, true)) AND (timeline_id = current_setting('app.timeline_id'::text, true)) AND (space_id = current_setting('app.space_id'::text, true)) AND clockgrove.world_is_ready(tenant_id, world_id)));


--
-- Name: snapshots; Type: ROW SECURITY; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE clockgrove.snapshots ENABLE ROW LEVEL SECURITY;

--
-- Name: streams; Type: ROW SECURITY; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE clockgrove.streams ENABLE ROW LEVEL SECURITY;

--
-- Name: authority_decisions tenant_isolation; Type: POLICY; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE POLICY tenant_isolation ON clockgrove.authority_decisions USING (clockgrove.has_runtime_context(tenant_id)) WITH CHECK (clockgrove.has_runtime_context(tenant_id));


--
-- Name: command_receipts tenant_isolation; Type: POLICY; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE POLICY tenant_isolation ON clockgrove.command_receipts USING (clockgrove.has_runtime_context(tenant_id)) WITH CHECK (clockgrove.has_runtime_context(tenant_id));


--
-- Name: partition_schedules tenant_isolation; Type: POLICY; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE POLICY tenant_isolation ON clockgrove.partition_schedules USING (clockgrove.has_runtime_context(tenant_id)) WITH CHECK (clockgrove.has_runtime_context(tenant_id));


--
-- Name: partition_states tenant_isolation; Type: POLICY; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE POLICY tenant_isolation ON clockgrove.partition_states USING (clockgrove.has_runtime_context(tenant_id)) WITH CHECK (clockgrove.has_runtime_context(tenant_id));


--
-- Name: streams tenant_isolation; Type: POLICY; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE POLICY tenant_isolation ON clockgrove.streams USING (clockgrove.has_runtime_context(tenant_id)) WITH CHECK (clockgrove.has_runtime_context(tenant_id));


--
-- Name: tenants tenant_isolation; Type: POLICY; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE POLICY tenant_isolation ON clockgrove.tenants USING (clockgrove.has_runtime_context(tenant_id)) WITH CHECK (clockgrove.has_runtime_context(tenant_id));


--
-- Name: timeline_partitions tenant_isolation; Type: POLICY; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE POLICY tenant_isolation ON clockgrove.timeline_partitions USING (clockgrove.has_runtime_context(tenant_id)) WITH CHECK (clockgrove.has_runtime_context(tenant_id));


--
-- Name: timelines tenant_isolation; Type: POLICY; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE POLICY tenant_isolation ON clockgrove.timelines USING (clockgrove.has_runtime_context(tenant_id)) WITH CHECK (clockgrove.has_runtime_context(tenant_id));


--
-- Name: worlds tenant_isolation; Type: POLICY; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE POLICY tenant_isolation ON clockgrove.worlds USING (clockgrove.has_runtime_context(tenant_id)) WITH CHECK (clockgrove.has_runtime_context(tenant_id));


--
-- Name: tenant_principals tenant_principal_isolation; Type: POLICY; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE POLICY tenant_principal_isolation ON clockgrove.tenant_principals USING (((tenant_id = clockgrove.runtime_tenant_id()) AND (principal_id = clockgrove.runtime_principal_id()))) WITH CHECK (((tenant_id = clockgrove.runtime_tenant_id()) AND (principal_id = clockgrove.runtime_principal_id())));


--
-- Name: tenant_principals; Type: ROW SECURITY; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE clockgrove.tenant_principals ENABLE ROW LEVEL SECURITY;

--
-- Name: artifact_data_keys tenant_privacy_isolation; Type: POLICY; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE POLICY tenant_privacy_isolation ON clockgrove.artifact_data_keys USING (clockgrove.runtime_can_access(tenant_id, privacy_class)) WITH CHECK (clockgrove.runtime_can_access(tenant_id, privacy_class));


--
-- Name: artifact_references tenant_privacy_isolation; Type: POLICY; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE POLICY tenant_privacy_isolation ON clockgrove.artifact_references USING (clockgrove.runtime_can_access(tenant_id, privacy_class)) WITH CHECK (clockgrove.runtime_can_access(tenant_id, privacy_class));


--
-- Name: event_dispatches tenant_privacy_isolation; Type: POLICY; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE POLICY tenant_privacy_isolation ON clockgrove.event_dispatches USING (clockgrove.runtime_can_access(tenant_id, privacy_class)) WITH CHECK (clockgrove.runtime_can_access(tenant_id, privacy_class));


--
-- Name: events tenant_privacy_isolation; Type: POLICY; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE POLICY tenant_privacy_isolation ON clockgrove.events USING (clockgrove.runtime_can_access(tenant_id, privacy_class)) WITH CHECK (clockgrove.runtime_can_access(tenant_id, privacy_class));


--
-- Name: snapshots tenant_privacy_isolation; Type: POLICY; Schema: clockgrove; Owner: clockgrove_migrator
--

CREATE POLICY tenant_privacy_isolation ON clockgrove.snapshots USING (clockgrove.runtime_can_access(tenant_id, privacy_class)) WITH CHECK (clockgrove.runtime_can_access(tenant_id, privacy_class));


--
-- Name: tenants; Type: ROW SECURITY; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE clockgrove.tenants ENABLE ROW LEVEL SECURITY;

--
-- Name: timeline_partitions; Type: ROW SECURITY; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE clockgrove.timeline_partitions ENABLE ROW LEVEL SECURITY;

--
-- Name: timelines; Type: ROW SECURITY; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE clockgrove.timelines ENABLE ROW LEVEL SECURITY;

--
-- Name: world_memberships; Type: ROW SECURITY; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE clockgrove.world_memberships ENABLE ROW LEVEL SECURITY;

--
-- Name: worlds; Type: ROW SECURITY; Schema: clockgrove; Owner: clockgrove_migrator
--

ALTER TABLE clockgrove.worlds ENABLE ROW LEVEL SECURITY;

--
-- Name: birth_cognitive_seed_refs; Type: ROW SECURITY; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

ALTER TABLE clockgrove_birth.birth_cognitive_seed_refs ENABLE ROW LEVEL SECURITY;

--
-- Name: birth_random_streams; Type: ROW SECURITY; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

ALTER TABLE clockgrove_birth.birth_random_streams ENABLE ROW LEVEL SECURITY;

--
-- Name: birth_schedules; Type: ROW SECURITY; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

ALTER TABLE clockgrove_birth.birth_schedules ENABLE ROW LEVEL SECURITY;

--
-- Name: birth_space_state; Type: ROW SECURITY; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

ALTER TABLE clockgrove_birth.birth_space_state ENABLE ROW LEVEL SECURITY;

--
-- Name: birth_state_sections; Type: ROW SECURITY; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

ALTER TABLE clockgrove_birth.birth_state_sections ENABLE ROW LEVEL SECURITY;

--
-- Name: pack_artifact_resources; Type: ROW SECURITY; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

ALTER TABLE clockgrove_birth.pack_artifact_resources ENABLE ROW LEVEL SECURITY;

--
-- Name: pack_artifacts; Type: ROW SECURITY; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

ALTER TABLE clockgrove_birth.pack_artifacts ENABLE ROW LEVEL SECURITY;

--
-- Name: pack_installations; Type: ROW SECURITY; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

ALTER TABLE clockgrove_birth.pack_installations ENABLE ROW LEVEL SECURITY;

--
-- Name: provisioning_cases; Type: ROW SECURITY; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

ALTER TABLE clockgrove_birth.provisioning_cases ENABLE ROW LEVEL SECURITY;

--
-- Name: birth_cognitive_seed_refs tenant_isolation; Type: POLICY; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

CREATE POLICY tenant_isolation ON clockgrove_birth.birth_cognitive_seed_refs USING (clockgrove.has_runtime_context(tenant_id)) WITH CHECK (clockgrove.has_runtime_context(tenant_id));


--
-- Name: birth_random_streams tenant_isolation; Type: POLICY; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

CREATE POLICY tenant_isolation ON clockgrove_birth.birth_random_streams USING (clockgrove.has_runtime_context(tenant_id)) WITH CHECK (clockgrove.has_runtime_context(tenant_id));


--
-- Name: birth_schedules tenant_isolation; Type: POLICY; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

CREATE POLICY tenant_isolation ON clockgrove_birth.birth_schedules USING (clockgrove.has_runtime_context(tenant_id)) WITH CHECK (clockgrove.has_runtime_context(tenant_id));


--
-- Name: birth_space_state tenant_isolation; Type: POLICY; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

CREATE POLICY tenant_isolation ON clockgrove_birth.birth_space_state USING (clockgrove.has_runtime_context(tenant_id)) WITH CHECK (clockgrove.has_runtime_context(tenant_id));


--
-- Name: birth_state_sections tenant_isolation; Type: POLICY; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

CREATE POLICY tenant_isolation ON clockgrove_birth.birth_state_sections USING (clockgrove.has_runtime_context(tenant_id)) WITH CHECK (clockgrove.has_runtime_context(tenant_id));


--
-- Name: pack_artifact_resources tenant_isolation; Type: POLICY; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

CREATE POLICY tenant_isolation ON clockgrove_birth.pack_artifact_resources USING (clockgrove.has_runtime_context(tenant_id)) WITH CHECK (clockgrove.has_runtime_context(tenant_id));


--
-- Name: pack_artifacts tenant_isolation; Type: POLICY; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

CREATE POLICY tenant_isolation ON clockgrove_birth.pack_artifacts USING (clockgrove.has_runtime_context(tenant_id)) WITH CHECK (clockgrove.has_runtime_context(tenant_id));


--
-- Name: pack_installations tenant_isolation; Type: POLICY; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

CREATE POLICY tenant_isolation ON clockgrove_birth.pack_installations USING (clockgrove.has_runtime_context(tenant_id)) WITH CHECK (clockgrove.has_runtime_context(tenant_id));


--
-- Name: provisioning_cases tenant_isolation; Type: POLICY; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

CREATE POLICY tenant_isolation ON clockgrove_birth.provisioning_cases USING (clockgrove.has_runtime_context(tenant_id)) WITH CHECK (clockgrove.has_runtime_context(tenant_id));


--
-- Name: world_birth_states tenant_isolation; Type: POLICY; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

CREATE POLICY tenant_isolation ON clockgrove_birth.world_birth_states USING (clockgrove.has_runtime_context(tenant_id)) WITH CHECK (clockgrove.has_runtime_context(tenant_id));


--
-- Name: world_birth_states; Type: ROW SECURITY; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

ALTER TABLE clockgrove_birth.world_birth_states ENABLE ROW LEVEL SECURITY;

--
-- Name: identity_links; Type: ROW SECURITY; Schema: clockgrove_management; Owner: clockgrove_migrator
--

ALTER TABLE clockgrove_management.identity_links ENABLE ROW LEVEL SECURITY;

--
-- Name: identity_links identity_lookup; Type: POLICY; Schema: clockgrove_management; Owner: clockgrove_migrator
--

CREATE POLICY identity_lookup ON clockgrove_management.identity_links FOR SELECT TO clockgrove_management_reader USING (((revoked_at IS NULL) AND (environment = current_setting('lookup.environment'::text, true)) AND ((subject = current_setting('lookup.subject'::text, true)) OR (external_identity_id = current_setting('lookup.identity'::text, true)))));


--
-- Name: principals principal_lookup; Type: POLICY; Schema: clockgrove_management; Owner: clockgrove_migrator
--

CREATE POLICY principal_lookup ON clockgrove_management.principals FOR SELECT TO clockgrove_management_reader USING (((revoked_at IS NULL) AND ((principal_id = current_setting('app.principal_id'::text, true)) OR (EXISTS ( SELECT 1
   FROM clockgrove_management.identity_links link
  WHERE ((link.principal_id = principals.principal_id) AND (link.environment = current_setting('lookup.environment'::text, true)) AND ((link.subject = current_setting('lookup.subject'::text, true)) OR (link.external_identity_id = current_setting('lookup.identity'::text, true)))))))));


--
-- Name: principals; Type: ROW SECURITY; Schema: clockgrove_management; Owner: clockgrove_migrator
--

ALTER TABLE clockgrove_management.principals ENABLE ROW LEVEL SECURITY;

--
-- Name: workspace_memberships workspace_lookup; Type: POLICY; Schema: clockgrove_management; Owner: clockgrove_migrator
--

CREATE POLICY workspace_lookup ON clockgrove_management.workspace_memberships FOR SELECT TO clockgrove_management_reader USING (((revoked_at IS NULL) AND (tenant_id = current_setting('app.tenant_id'::text, true)) AND (principal_id = current_setting('app.principal_id'::text, true))));


--
-- Name: workspace_memberships; Type: ROW SECURITY; Schema: clockgrove_management; Owner: clockgrove_migrator
--

ALTER TABLE clockgrove_management.workspace_memberships ENABLE ROW LEVEL SECURITY;

--
-- Name: SCHEMA clockgrove; Type: ACL; Schema: -; Owner: clockgrove_migrator
--

GRANT USAGE ON SCHEMA clockgrove TO clockgrove_runtime;
GRANT USAGE ON SCHEMA clockgrove TO clockgrove_world_reader;


--
-- Name: SCHEMA clockgrove_auth; Type: ACL; Schema: -; Owner: clockgrove_migrator
--

GRANT USAGE ON SCHEMA clockgrove_auth TO clockgrove_auth_verifier;


--
-- Name: SCHEMA clockgrove_birth; Type: ACL; Schema: -; Owner: clockgrove_migrator
--

GRANT USAGE ON SCHEMA clockgrove_birth TO clockgrove_runtime;


--
-- Name: SCHEMA clockgrove_management; Type: ACL; Schema: -; Owner: clockgrove_migrator
--

GRANT USAGE ON SCHEMA clockgrove_management TO clockgrove_management_reader;


--
-- Name: FUNCTION append_command(p_request jsonb, p_failure_stage text); Type: ACL; Schema: clockgrove; Owner: clockgrove_migrator
--

REVOKE ALL ON FUNCTION clockgrove.append_command(p_request jsonb, p_failure_stage text) FROM PUBLIC;
GRANT ALL ON FUNCTION clockgrove.append_command(p_request jsonb, p_failure_stage text) TO clockgrove_runtime;


--
-- Name: FUNCTION begin_command(p_command_bytes bytea, p_request jsonb, p_failure_stage text); Type: ACL; Schema: clockgrove; Owner: clockgrove_migrator
--

REVOKE ALL ON FUNCTION clockgrove.begin_command(p_command_bytes bytea, p_request jsonb, p_failure_stage text) FROM PUBLIC;
GRANT ALL ON FUNCTION clockgrove.begin_command(p_command_bytes bytea, p_request jsonb, p_failure_stage text) TO clockgrove_runtime;


--
-- Name: FUNCTION claim_dispatches(claim_channel text, claim_limit integer, claim_owner text, lease_ms integer); Type: ACL; Schema: clockgrove; Owner: clockgrove_migrator
--

REVOKE ALL ON FUNCTION clockgrove.claim_dispatches(claim_channel text, claim_limit integer, claim_owner text, lease_ms integer) FROM PUBLIC;
GRANT ALL ON FUNCTION clockgrove.claim_dispatches(claim_channel text, claim_limit integer, claim_owner text, lease_ms integer) TO clockgrove_runtime;


--
-- Name: FUNCTION execute_journal(p_command_bytes bytea, p_request jsonb, p_failure_stage text); Type: ACL; Schema: clockgrove; Owner: clockgrove_migrator
--

REVOKE ALL ON FUNCTION clockgrove.execute_journal(p_command_bytes bytea, p_request jsonb, p_failure_stage text) FROM PUBLIC;
GRANT ALL ON FUNCTION clockgrove.execute_journal(p_command_bytes bytea, p_request jsonb, p_failure_stage text) TO clockgrove_runtime;


--
-- Name: FUNCTION guard_command_receipt(); Type: ACL; Schema: clockgrove; Owner: clockgrove_migrator
--

REVOKE ALL ON FUNCTION clockgrove.guard_command_receipt() FROM PUBLIC;


--
-- Name: FUNCTION guard_partition_schedule(); Type: ACL; Schema: clockgrove; Owner: clockgrove_migrator
--

REVOKE ALL ON FUNCTION clockgrove.guard_partition_schedule() FROM PUBLIC;


--
-- Name: FUNCTION guard_partition_state(); Type: ACL; Schema: clockgrove; Owner: clockgrove_migrator
--

REVOKE ALL ON FUNCTION clockgrove.guard_partition_state() FROM PUBLIC;


--
-- Name: FUNCTION guard_preview_effect_dispatch(); Type: ACL; Schema: clockgrove; Owner: clockgrove_migrator
--

REVOKE ALL ON FUNCTION clockgrove.guard_preview_effect_dispatch() FROM PUBLIC;


--
-- Name: FUNCTION has_runtime_context(row_tenant_id text); Type: ACL; Schema: clockgrove; Owner: clockgrove_migrator
--

REVOKE ALL ON FUNCTION clockgrove.has_runtime_context(row_tenant_id text) FROM PUBLIC;
GRANT ALL ON FUNCTION clockgrove.has_runtime_context(row_tenant_id text) TO clockgrove_runtime;


--
-- Name: FUNCTION preserve_command_request(); Type: ACL; Schema: clockgrove; Owner: clockgrove_migrator
--

REVOKE ALL ON FUNCTION clockgrove.preserve_command_request() FROM PUBLIC;


--
-- Name: FUNCTION privacy_allows(category text); Type: ACL; Schema: clockgrove; Owner: clockgrove_migrator
--

GRANT ALL ON FUNCTION clockgrove.privacy_allows(category text) TO clockgrove_runtime;


--
-- Name: FUNCTION reject_journal_mutation(); Type: ACL; Schema: clockgrove; Owner: clockgrove_migrator
--

REVOKE ALL ON FUNCTION clockgrove.reject_journal_mutation() FROM PUBLIC;


--
-- Name: FUNCTION runtime_can_access(row_tenant_id text, category text); Type: ACL; Schema: clockgrove; Owner: clockgrove_migrator
--

GRANT ALL ON FUNCTION clockgrove.runtime_can_access(row_tenant_id text, category text) TO clockgrove_runtime;


--
-- Name: FUNCTION runtime_principal_id(); Type: ACL; Schema: clockgrove; Owner: clockgrove_migrator
--

GRANT ALL ON FUNCTION clockgrove.runtime_principal_id() TO clockgrove_runtime;


--
-- Name: FUNCTION runtime_tenant_id(); Type: ACL; Schema: clockgrove; Owner: clockgrove_migrator
--

GRANT ALL ON FUNCTION clockgrove.runtime_tenant_id() TO clockgrove_runtime;


--
-- Name: FUNCTION settle_dispatch(settle_dispatch_id text, settle_attempt integer, settle_outcome text, settle_error_class text, retry_after_ms integer); Type: ACL; Schema: clockgrove; Owner: clockgrove_migrator
--

REVOKE ALL ON FUNCTION clockgrove.settle_dispatch(settle_dispatch_id text, settle_attempt integer, settle_outcome text, settle_error_class text, retry_after_ms integer) FROM PUBLIC;
GRANT ALL ON FUNCTION clockgrove.settle_dispatch(settle_dispatch_id text, settle_attempt integer, settle_outcome text, settle_error_class text, retry_after_ms integer) TO clockgrove_runtime;


--
-- Name: FUNCTION world_is_ready(row_tenant_id text, row_world_id text); Type: ACL; Schema: clockgrove; Owner: clockgrove_migrator
--

REVOKE ALL ON FUNCTION clockgrove.world_is_ready(row_tenant_id text, row_world_id text) FROM PUBLIC;
GRANT ALL ON FUNCTION clockgrove.world_is_ready(row_tenant_id text, row_world_id text) TO clockgrove_world_reader;


--
-- Name: TABLE artifact_data_keys; Type: ACL; Schema: clockgrove; Owner: clockgrove_migrator
--

GRANT SELECT,INSERT ON TABLE clockgrove.artifact_data_keys TO clockgrove_runtime;


--
-- Name: COLUMN artifact_data_keys.kek_id; Type: ACL; Schema: clockgrove; Owner: clockgrove_migrator
--

GRANT UPDATE(kek_id) ON TABLE clockgrove.artifact_data_keys TO clockgrove_runtime;


--
-- Name: COLUMN artifact_data_keys.wrapped_key; Type: ACL; Schema: clockgrove; Owner: clockgrove_migrator
--

GRANT UPDATE(wrapped_key) ON TABLE clockgrove.artifact_data_keys TO clockgrove_runtime;


--
-- Name: TABLE artifact_references; Type: ACL; Schema: clockgrove; Owner: clockgrove_migrator
--

GRANT SELECT,INSERT ON TABLE clockgrove.artifact_references TO clockgrove_runtime;


--
-- Name: TABLE authority_decisions; Type: ACL; Schema: clockgrove; Owner: clockgrove_migrator
--

GRANT SELECT,INSERT ON TABLE clockgrove.authority_decisions TO clockgrove_runtime;


--
-- Name: TABLE command_receipts; Type: ACL; Schema: clockgrove; Owner: clockgrove_migrator
--

GRANT SELECT,INSERT,UPDATE ON TABLE clockgrove.command_receipts TO clockgrove_runtime;


--
-- Name: TABLE event_dispatches; Type: ACL; Schema: clockgrove; Owner: clockgrove_migrator
--

GRANT SELECT,INSERT ON TABLE clockgrove.event_dispatches TO clockgrove_runtime;


--
-- Name: TABLE events; Type: ACL; Schema: clockgrove; Owner: clockgrove_migrator
--

GRANT SELECT,INSERT ON TABLE clockgrove.events TO clockgrove_runtime;


--
-- Name: SEQUENCE events_journal_position_seq; Type: ACL; Schema: clockgrove; Owner: clockgrove_migrator
--

GRANT SELECT,USAGE ON SEQUENCE clockgrove.events_journal_position_seq TO clockgrove_runtime;


--
-- Name: TABLE partition_schedules; Type: ACL; Schema: clockgrove; Owner: clockgrove_migrator
--

GRANT SELECT,INSERT,UPDATE ON TABLE clockgrove.partition_schedules TO clockgrove_runtime;


--
-- Name: TABLE partition_states; Type: ACL; Schema: clockgrove; Owner: clockgrove_migrator
--

GRANT SELECT,INSERT,UPDATE ON TABLE clockgrove.partition_states TO clockgrove_runtime;


--
-- Name: TABLE snapshots; Type: ACL; Schema: clockgrove; Owner: clockgrove_migrator
--

GRANT SELECT,INSERT ON TABLE clockgrove.snapshots TO clockgrove_runtime;


--
-- Name: TABLE streams; Type: ACL; Schema: clockgrove; Owner: clockgrove_migrator
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE clockgrove.streams TO clockgrove_runtime;


--
-- Name: TABLE tenant_principals; Type: ACL; Schema: clockgrove; Owner: clockgrove_migrator
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE clockgrove.tenant_principals TO clockgrove_runtime;


--
-- Name: TABLE tenants; Type: ACL; Schema: clockgrove; Owner: clockgrove_migrator
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE clockgrove.tenants TO clockgrove_runtime;


--
-- Name: TABLE timeline_partitions; Type: ACL; Schema: clockgrove; Owner: clockgrove_migrator
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE clockgrove.timeline_partitions TO clockgrove_runtime;


--
-- Name: TABLE timelines; Type: ACL; Schema: clockgrove; Owner: clockgrove_migrator
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE clockgrove.timelines TO clockgrove_runtime;


--
-- Name: TABLE world_memberships; Type: ACL; Schema: clockgrove; Owner: clockgrove_migrator
--

GRANT SELECT ON TABLE clockgrove.world_memberships TO clockgrove_world_reader;


--
-- Name: TABLE worlds; Type: ACL; Schema: clockgrove; Owner: clockgrove_migrator
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE clockgrove.worlds TO clockgrove_runtime;


--
-- Name: TABLE session; Type: ACL; Schema: clockgrove_auth; Owner: clockgrove_migrator
--

GRANT SELECT ON TABLE clockgrove_auth.session TO clockgrove_auth_verifier;


--
-- Name: TABLE "user"; Type: ACL; Schema: clockgrove_auth; Owner: clockgrove_migrator
--

GRANT SELECT ON TABLE clockgrove_auth."user" TO clockgrove_auth_verifier;


--
-- Name: TABLE birth_cognitive_seed_refs; Type: ACL; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

GRANT SELECT,INSERT ON TABLE clockgrove_birth.birth_cognitive_seed_refs TO clockgrove_runtime;


--
-- Name: TABLE birth_random_streams; Type: ACL; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

GRANT SELECT,INSERT ON TABLE clockgrove_birth.birth_random_streams TO clockgrove_runtime;


--
-- Name: TABLE birth_schedules; Type: ACL; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

GRANT SELECT,INSERT ON TABLE clockgrove_birth.birth_schedules TO clockgrove_runtime;


--
-- Name: TABLE birth_space_state; Type: ACL; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

GRANT SELECT,INSERT ON TABLE clockgrove_birth.birth_space_state TO clockgrove_runtime;


--
-- Name: TABLE birth_state_sections; Type: ACL; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

GRANT SELECT,INSERT ON TABLE clockgrove_birth.birth_state_sections TO clockgrove_runtime;


--
-- Name: TABLE pack_artifact_resources; Type: ACL; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

GRANT SELECT,INSERT ON TABLE clockgrove_birth.pack_artifact_resources TO clockgrove_runtime;


--
-- Name: TABLE pack_artifacts; Type: ACL; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

GRANT SELECT,INSERT ON TABLE clockgrove_birth.pack_artifacts TO clockgrove_runtime;


--
-- Name: TABLE pack_installations; Type: ACL; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

GRANT SELECT,INSERT ON TABLE clockgrove_birth.pack_installations TO clockgrove_runtime;


--
-- Name: TABLE provisioning_cases; Type: ACL; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

GRANT SELECT,INSERT,UPDATE ON TABLE clockgrove_birth.provisioning_cases TO clockgrove_runtime;


--
-- Name: TABLE world_birth_states; Type: ACL; Schema: clockgrove_birth; Owner: clockgrove_migrator
--

GRANT SELECT,INSERT ON TABLE clockgrove_birth.world_birth_states TO clockgrove_runtime;


--
-- Name: TABLE identity_links; Type: ACL; Schema: clockgrove_management; Owner: clockgrove_migrator
--

GRANT SELECT ON TABLE clockgrove_management.identity_links TO clockgrove_management_reader;


--
-- Name: TABLE principals; Type: ACL; Schema: clockgrove_management; Owner: clockgrove_migrator
--

GRANT SELECT ON TABLE clockgrove_management.principals TO clockgrove_management_reader;


--
-- Name: TABLE workspace_memberships; Type: ACL; Schema: clockgrove_management; Owner: clockgrove_migrator
--

GRANT SELECT ON TABLE clockgrove_management.workspace_memberships TO clockgrove_management_reader;


--
-- PostgreSQL database dump complete
--

\unrestrict clockgrove

