-- The journal append is set-based (#653). `append_command` as in 0008, except that its events are
-- appended in one statement instead of one draft at a time: each stream and partition head moves
-- once by its draft count, journal positions are drawn together and assigned in draft order, and the
-- committed result is aggregated once instead of growing one array element per draft. Appending N
-- events was quadratic in N; it is now linear. Every value written (sequences, positions, recorded
-- time, canonical event bytes, receipt and result) is the same as before. No table, row or stored
-- byte changes.

CREATE OR REPLACE FUNCTION clockgrove.append_command(
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
  SELECT proposed.event->>'eventId' INTO colliding
    FROM jsonb_array_elements(p_request->'events') AS proposed(event)
   WHERE EXISTS (
     SELECT 1 FROM clockgrove.events AS existing
      WHERE existing.tenant_id = v_tenant AND existing.event_id = proposed.event->>'eventId'
   )
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

REVOKE ALL ON FUNCTION clockgrove.append_command(jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clockgrove.append_command(jsonb, text) TO clockgrove_runtime;
