-- Drizzle-owned forward migration with reviewed SQL for roles, locking invariants, and RLS.
-- Production migrations follow expand -> backfill -> verify -> switch -> contract.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE SCHEMA IF NOT EXISTS clockgrove AUTHORIZATION clockgrove_migrator;

CREATE TABLE clockgrove.tenants (
  tenant_id text PRIMARY KEY,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp()
);

CREATE TABLE clockgrove.tenant_principals (
  tenant_id text NOT NULL REFERENCES clockgrove.tenants (tenant_id),
  principal_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (tenant_id, principal_id)
);

CREATE TABLE clockgrove.worlds (
  tenant_id text NOT NULL REFERENCES clockgrove.tenants (tenant_id),
  world_id text NOT NULL,
  lifecycle_status text NOT NULL DEFAULT 'initializing',
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (tenant_id, world_id)
);

CREATE TABLE clockgrove.timelines (
  tenant_id text NOT NULL,
  world_id text NOT NULL,
  timeline_id text NOT NULL,
  kind text NOT NULL DEFAULT 'live',
  state text NOT NULL DEFAULT 'active',
  parent_timeline_id text,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (tenant_id, timeline_id),
  UNIQUE (tenant_id, world_id, timeline_id),
  FOREIGN KEY (tenant_id, world_id)
    REFERENCES clockgrove.worlds (tenant_id, world_id)
);

CREATE TABLE clockgrove.timeline_partitions (
  tenant_id text NOT NULL,
  world_id text NOT NULL,
  timeline_id text NOT NULL,
  partition_id text NOT NULL,
  space_id text NOT NULL,
  routing_epoch integer NOT NULL DEFAULT 0 CHECK (routing_epoch >= 0),
  head_sequence bigint NOT NULL DEFAULT 0 CHECK (head_sequence >= 0),
  PRIMARY KEY (tenant_id, timeline_id, partition_id),
  UNIQUE (tenant_id, world_id, timeline_id, partition_id),
  UNIQUE (tenant_id, world_id, timeline_id, partition_id, space_id),
  FOREIGN KEY (tenant_id, world_id, timeline_id)
    REFERENCES clockgrove.timelines (tenant_id, world_id, timeline_id)
);

CREATE TABLE clockgrove.streams (
  tenant_id text NOT NULL,
  world_id text NOT NULL,
  timeline_id text NOT NULL,
  partition_id text NOT NULL,
  space_id text NOT NULL,
  stream_id text NOT NULL,
  current_sequence bigint NOT NULL DEFAULT 0 CHECK (current_sequence >= 0),
  snapshot_sequence bigint NOT NULL DEFAULT 0 CHECK (
    snapshot_sequence >= 0 AND snapshot_sequence <= current_sequence
  ),
  PRIMARY KEY (tenant_id, timeline_id, stream_id),
  UNIQUE (tenant_id, world_id, timeline_id, partition_id, space_id, stream_id),
  FOREIGN KEY (tenant_id, world_id, timeline_id, partition_id, space_id)
    REFERENCES clockgrove.timeline_partitions (
      tenant_id, world_id, timeline_id, partition_id, space_id
    )
);

CREATE TABLE clockgrove.events (
  event_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  world_id text NOT NULL,
  timeline_id text NOT NULL,
  partition_id text NOT NULL,
  space_id text NOT NULL,
  stream_id text NOT NULL,
  stream_sequence bigint NOT NULL CHECK (stream_sequence > 0),
  partition_sequence bigint NOT NULL CHECK (partition_sequence > 0),
  journal_position bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  event_type text NOT NULL,
  schema_version integer NOT NULL CHECK (schema_version > 0),
  simulation_time bigint NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  command_id text NOT NULL,
  correlation_id text NOT NULL,
  causation_id text,
  principal_id text,
  actor_id text,
  object_id text,
  privacy_class text NOT NULL CHECK (privacy_class IN (
    'public_scene',
    'private_cognition',
    'conversation',
    'credential',
    'operator_evidence'
  )),
  payload_hash text NOT NULL,
  attribution jsonb NOT NULL,
  actor_address jsonb,
  policy_versions jsonb NOT NULL,
  payload jsonb NOT NULL,
  event_bytes bytea NOT NULL,
  UNIQUE (tenant_id, event_id),
  UNIQUE (tenant_id, timeline_id, stream_id, stream_sequence),
  UNIQUE (tenant_id, timeline_id, partition_id, partition_sequence),
  FOREIGN KEY (tenant_id, world_id, timeline_id, partition_id, space_id, stream_id)
    REFERENCES clockgrove.streams (
      tenant_id, world_id, timeline_id, partition_id, space_id, stream_id
    )
);

CREATE INDEX events_append_lookup_idx
  ON clockgrove.events (tenant_id, timeline_id, partition_id, journal_position);
CREATE INDEX events_actor_simulation_time_idx
  ON clockgrove.events (tenant_id, timeline_id, actor_id, simulation_time)
  WHERE actor_id IS NOT NULL;
CREATE INDEX events_object_simulation_time_idx
  ON clockgrove.events (tenant_id, timeline_id, object_id, simulation_time)
  WHERE object_id IS NOT NULL;
CREATE INDEX events_recorded_at_idx
  ON clockgrove.events (tenant_id, recorded_at);
CREATE INDEX events_correlation_idx
  ON clockgrove.events (tenant_id, correlation_id);
CREATE INDEX events_causation_idx
  ON clockgrove.events (tenant_id, causation_id)
  WHERE causation_id IS NOT NULL;
CREATE INDEX events_command_idx
  ON clockgrove.events (tenant_id, command_id);
CREATE INDEX events_privacy_idx
  ON clockgrove.events (tenant_id, privacy_class, recorded_at);

CREATE TABLE clockgrove.command_receipts (
  tenant_id text NOT NULL REFERENCES clockgrove.tenants (tenant_id),
  command_id text NOT NULL,
  request_hash text NOT NULL,
  command_bytes bytea NOT NULL,
  target_address jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'committed', 'rejected')),
  canonical_event_ids text[] NOT NULL DEFAULT '{}',
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  committed_at timestamptz,
  PRIMARY KEY (tenant_id, command_id)
);

CREATE FUNCTION clockgrove.preserve_command_request()
RETURNS trigger
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

CREATE TRIGGER command_receipts_immutable_request
BEFORE UPDATE ON clockgrove.command_receipts
FOR EACH ROW EXECUTE FUNCTION clockgrove.preserve_command_request();

CREATE TABLE clockgrove.event_dispatches (
  tenant_id text NOT NULL,
  world_id text NOT NULL,
  timeline_id text NOT NULL,
  partition_id text NOT NULL,
  space_id text NOT NULL,
  dispatch_id text NOT NULL,
  event_id text NOT NULL REFERENCES clockgrove.events (event_id),
  channel text NOT NULL CHECK (channel IN (
    'world-reactions', 'cognitive-indexing', 'external-effects'
  )),
  status text NOT NULL CHECK (status IN ('pending', 'leased', 'delivered', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  privacy_class text NOT NULL CHECK (privacy_class IN (
    'public_scene',
    'private_cognition',
    'conversation',
    'credential',
    'operator_evidence'
  )),
  payload jsonb NOT NULL,
  PRIMARY KEY (tenant_id, dispatch_id),
  UNIQUE (tenant_id, event_id, channel),
  FOREIGN KEY (tenant_id, event_id)
    REFERENCES clockgrove.events (tenant_id, event_id),
  FOREIGN KEY (tenant_id, world_id, timeline_id, partition_id, space_id)
    REFERENCES clockgrove.timeline_partitions (
      tenant_id, world_id, timeline_id, partition_id, space_id
    )
);

CREATE INDEX event_dispatches_pending_idx
  ON clockgrove.event_dispatches (channel, status, next_attempt_at);

CREATE TABLE clockgrove.artifact_references (
  tenant_id text NOT NULL,
  world_id text NOT NULL,
  timeline_id text NOT NULL,
  partition_id text NOT NULL,
  space_id text NOT NULL,
  artifact_id text NOT NULL,
  content_hash text NOT NULL,
  media_type text NOT NULL,
  storage_key text NOT NULL,
  byte_length bigint NOT NULL CHECK (byte_length >= 0),
  privacy_class text NOT NULL CHECK (privacy_class IN (
    'public_scene',
    'private_cognition',
    'conversation',
    'credential',
    'operator_evidence'
  )),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (tenant_id, artifact_id),
  FOREIGN KEY (tenant_id, world_id, timeline_id, partition_id, space_id)
    REFERENCES clockgrove.timeline_partitions (
      tenant_id, world_id, timeline_id, partition_id, space_id
    )
);

CREATE TABLE clockgrove.snapshots (
  tenant_id text NOT NULL,
  world_id text NOT NULL,
  timeline_id text NOT NULL,
  partition_id text NOT NULL,
  space_id text NOT NULL,
  snapshot_id text NOT NULL,
  stream_id text NOT NULL,
  covered_sequence bigint NOT NULL CHECK (covered_sequence >= 0),
  state_hash text NOT NULL,
  artifact_id text NOT NULL,
  privacy_class text NOT NULL CHECK (privacy_class IN (
    'public_scene',
    'private_cognition',
    'conversation',
    'credential',
    'operator_evidence'
  )),
  compatibility jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (tenant_id, snapshot_id),
  FOREIGN KEY (tenant_id, world_id, timeline_id, partition_id, space_id, stream_id)
    REFERENCES clockgrove.streams (
      tenant_id, world_id, timeline_id, partition_id, space_id, stream_id
    ),
  FOREIGN KEY (tenant_id, artifact_id)
    REFERENCES clockgrove.artifact_references (tenant_id, artifact_id)
);

CREATE TABLE clockgrove.migration_backfill_checkpoints (
  migration_name text NOT NULL,
  checkpoint_key text NOT NULL,
  checkpoint_value jsonb NOT NULL,
  verified_at timestamptz,
  PRIMARY KEY (migration_name, checkpoint_key)
);

-- Engineering choice: one database function owns the Wave 0 append statement
-- layout. The adapter owns BEGIN/RLS context/COMMIT, error mapping, and the
-- provider-neutral best-effort post-commit notification seam.
CREATE FUNCTION clockgrove.execute_journal(
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
     OR v_timeline IS NULL OR v_world IS NULL OR v_primary_partition IS NULL
     OR v_primary_space IS NULL OR v_primary_stream IS NULL
     OR p_request#>>'{target,tenantId}' IS DISTINCT FROM v_tenant
     OR jsonb_typeof(p_request->'events') <> 'array'
     OR jsonb_typeof(p_request->'dispatches') <> 'array'
     OR NOT p_request ? 'stableResult' OR NOT p_request ? 'projectionDelta' THEN
    RAISE EXCEPTION 'malformed journal request' USING ERRCODE = '22023';
  END IF;
  IF p_failure_stage IS NOT NULL AND p_failure_stage NOT IN (
    'after-receipt', 'after-head-locks', 'after-events', 'after-dispatches', 'before-commit'
  ) THEN
    RAISE EXCEPTION 'unknown journal failure stage' USING ERRCODE = '22023';
  END IF;

  -- (2-3) Create/wait for and lock the receipt; compare exact bytes.
  INSERT INTO clockgrove.command_receipts (
    tenant_id, command_id, request_hash, command_bytes, target_address, status
  ) VALUES (
    v_tenant, v_command_id, v_request_hash, p_command_bytes, p_request->'target', 'pending'
  ) ON CONFLICT ON CONSTRAINT command_receipts_pkey DO NOTHING;
  SELECT * INTO STRICT stored_receipt
    FROM clockgrove.command_receipts AS receipt
   WHERE receipt.tenant_id = v_tenant AND receipt.command_id = v_command_id
   FOR UPDATE;
  IF stored_receipt.command_bytes IS DISTINCT FROM p_command_bytes
     OR stored_receipt.request_hash IS DISTINCT FROM v_request_hash THEN
    RAISE EXCEPTION 'command ID reused with different bytes' USING ERRCODE = 'CG001';
  END IF;
  IF stored_receipt.status = 'committed' THEN
    RETURN stored_receipt.result;
  END IF;
  IF p_failure_stage = 'after-receipt' THEN
    RAISE EXCEPTION 'injected failure after receipt';
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

  -- (6) Wave 0 has no validation-critical projections. Validate each draft
  -- against its authoritative current stream/partition route.
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

  -- (9) There are no Wave 0 projection/schedule tables. (10) Outbox intent.
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

  -- (11) Persist the complete stable response before the caller commits.
  committed_result := jsonb_build_object(
    'value', p_request->'stableResult', 'events', committed_events,
    'projectionDelta', p_request->'projectionDelta'
  );
  UPDATE clockgrove.command_receipts AS receipt
     SET status = 'committed',
         canonical_event_ids = ARRAY(
           SELECT event->>'eventId' FROM jsonb_array_elements(committed_events) AS event
         ),
         result = committed_result, committed_at = statement_timestamp()
   WHERE receipt.tenant_id = v_tenant AND receipt.command_id = v_command_id;
  IF p_failure_stage = 'before-commit' THEN RAISE EXCEPTION 'injected failure before commit'; END IF;
  RETURN committed_result;
END;
$$;

CREATE FUNCTION clockgrove.runtime_tenant_id()
RETURNS text
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$ SELECT nullif(current_setting('app.tenant_id', true), '') $$;

CREATE FUNCTION clockgrove.runtime_principal_id()
RETURNS text
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$ SELECT nullif(current_setting('app.principal_id', true), '') $$;

CREATE FUNCTION clockgrove.has_runtime_context(row_tenant_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, clockgrove
AS $$
  SELECT row_tenant_id = clockgrove.runtime_tenant_id()
    AND EXISTS (
      SELECT 1
      FROM clockgrove.tenant_principals AS membership
      WHERE membership.tenant_id = row_tenant_id
        AND membership.principal_id = clockgrove.runtime_principal_id()
    )
$$;

CREATE FUNCTION clockgrove.privacy_allows(category text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
PARALLEL SAFE
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

CREATE FUNCTION clockgrove.runtime_can_access(row_tenant_id text, category text)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT clockgrove.has_runtime_context(row_tenant_id)
    AND clockgrove.privacy_allows(category)
$$;

REVOKE ALL ON FUNCTION clockgrove.preserve_command_request() FROM PUBLIC;
REVOKE ALL ON FUNCTION clockgrove.execute_journal(bytea, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION clockgrove.has_runtime_context(text) FROM PUBLIC;

ALTER TABLE clockgrove.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE clockgrove.tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON clockgrove.tenants
  USING (clockgrove.has_runtime_context(tenant_id))
  WITH CHECK (clockgrove.has_runtime_context(tenant_id));

ALTER TABLE clockgrove.tenant_principals ENABLE ROW LEVEL SECURITY;
ALTER TABLE clockgrove.tenant_principals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_principal_isolation ON clockgrove.tenant_principals
  USING (
    tenant_id = clockgrove.runtime_tenant_id()
    AND principal_id = clockgrove.runtime_principal_id()
  )
  WITH CHECK (
    tenant_id = clockgrove.runtime_tenant_id()
    AND principal_id = clockgrove.runtime_principal_id()
  );

DO $rls$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'worlds',
    'timelines',
    'timeline_partitions',
    'streams',
    'command_receipts'
  ] LOOP
    EXECUTE format('ALTER TABLE clockgrove.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE clockgrove.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON clockgrove.%I USING (clockgrove.has_runtime_context(tenant_id)) WITH CHECK (clockgrove.has_runtime_context(tenant_id))',
      table_name
    );
  END LOOP;
  FOREACH table_name IN ARRAY ARRAY[
    'events',
    'event_dispatches',
    'artifact_references',
    'snapshots'
  ] LOOP
    EXECUTE format('ALTER TABLE clockgrove.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE clockgrove.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_privacy_isolation ON clockgrove.%I USING (clockgrove.runtime_can_access(tenant_id, privacy_class)) WITH CHECK (clockgrove.runtime_can_access(tenant_id, privacy_class))',
      table_name
    );
  END LOOP;
END;
$rls$;

REVOKE ALL ON SCHEMA clockgrove FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA clockgrove FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA clockgrove FROM PUBLIC;
GRANT USAGE ON SCHEMA clockgrove TO clockgrove_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  clockgrove.tenants,
  clockgrove.tenant_principals,
  clockgrove.worlds,
  clockgrove.timelines,
  clockgrove.timeline_partitions,
  clockgrove.streams,
  clockgrove.events,
  clockgrove.command_receipts,
  clockgrove.event_dispatches,
  clockgrove.artifact_references,
  clockgrove.snapshots
TO clockgrove_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA clockgrove TO clockgrove_runtime;
GRANT EXECUTE ON FUNCTION clockgrove.has_runtime_context(text) TO clockgrove_runtime;
GRANT EXECUTE ON FUNCTION clockgrove.runtime_tenant_id() TO clockgrove_runtime;
GRANT EXECUTE ON FUNCTION clockgrove.runtime_principal_id() TO clockgrove_runtime;
GRANT EXECUTE ON FUNCTION clockgrove.privacy_allows(text) TO clockgrove_runtime;
GRANT EXECUTE ON FUNCTION clockgrove.runtime_can_access(text, text) TO clockgrove_runtime;
GRANT EXECUTE ON FUNCTION clockgrove.execute_journal(bytea, jsonb, text) TO clockgrove_runtime;
