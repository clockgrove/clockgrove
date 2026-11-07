SET ROLE clockgrove_runtime;

BEGIN;
SELECT set_config('app.tenant_id', 'tenant-a', true);
SELECT set_config('app.principal_id', 'principal-a', true);
SELECT set_config(
  'app.privacy_ceiling',
  '{"version":1,"allowedCategories":["public_scene"]}',
  true
);
DO $$
BEGIN
  IF (SELECT count(*) FROM clockgrove.tenants) <> 1 THEN
    RAISE EXCEPTION 'tenant-a context did not isolate tenants';
  END IF;
  IF (SELECT count(*) FROM clockgrove.tenant_principals) <> 1 THEN
    RAISE EXCEPTION 'tenant-a context leaked principals';
  END IF;
  IF (SELECT count(*) FROM clockgrove.events) <> 1 THEN
    RAISE EXCEPTION 'public ceiling did not isolate private events';
  END IF;
  IF (SELECT count(*) FROM clockgrove.artifact_references) <> 1
     OR (SELECT count(*) FROM clockgrove.artifact_data_keys) <> 0 THEN
    RAISE EXCEPTION 'public ceiling did not isolate private artifacts and their wrapped keys';
  END IF;
END;
$$;
COMMIT;

BEGIN;
SELECT set_config('app.tenant_id', 'tenant-a', true);
SELECT set_config('app.principal_id', 'principal-a', true);
SELECT set_config(
  'app.privacy_ceiling',
  '{"version":1,"allowedCategories":["conversation"]}',
  true
);
DO $$
BEGIN
  IF (SELECT count(*) FROM clockgrove.events) <> 1
     OR NOT EXISTS (
       SELECT 1 FROM clockgrove.events WHERE event_id = 'event-a-private'
     ) THEN
    RAISE EXCEPTION 'privacy category set was treated as scalar or leaked categories';
  END IF;
END;
$$;
COMMIT;

-- ---------------------------------------------------------------------------------------------
-- Attack suite. Everything below runs as the ordinary runtime login against the seeded tenants
-- (tenant-a, tenant-b) and the hostile-looking tenants from hostile-fixture.sql.
-- ---------------------------------------------------------------------------------------------

-- The exercised table set. This is the suite's own explicit list: every row below is driven through
-- the attack blocks, and none of it is read from the catalog. The completeness check compares it with
-- the RLS-enabled tables of the catalog and fails on any RLS table missing here (or listed here without
-- RLS). runtime_privilege records what the runtime role is granted on the table:
--   dml             SELECT, INSERT, UPDATE and DELETE
--   append_only     SELECT and INSERT (world birth tables)
--   insert_update   SELECT, INSERT and UPDATE (provisioning cases, partition states and schedules)
--   journal_append  SELECT and INSERT (committed events, dispatch intent, authority decisions)
--   journal_receipt SELECT, INSERT and UPDATE along the receipt state machine (command receipts)
--   insert_delete   SELECT, INSERT and DELETE (clock admission receipts, retired when unreachable)
--   participant     SELECT and INSERT, sessions also UPDATE of state, title and count, each row
--                   only of a session the installed principal participates in (conversations,
--                   0034)
--   none            nothing; the attack suite proves the runtime role reads and writes nothing
--                   (inspector_accesses is appended only through record_inspector_access, and
--                   runtime_operator_actions only through record_runtime_operator_action)
CREATE TEMP TABLE attack_surface (
  schema_name text NOT NULL,
  table_name text NOT NULL,
  runtime_privilege text NOT NULL
    CHECK (runtime_privilege IN (
      'dml', 'append_only', 'insert_update', 'insert_delete', 'journal_append', 'journal_receipt',
      'key_rewrap', 'participant', 'none'
    )),
  PRIMARY KEY (schema_name, table_name)
);
INSERT INTO attack_surface (schema_name, table_name, runtime_privilege) VALUES
  ('clockgrove', 'tenants', 'dml'),
  ('clockgrove', 'tenant_principals', 'dml'),
  ('clockgrove', 'worlds', 'dml'),
  ('clockgrove', 'timelines', 'dml'),
  ('clockgrove', 'timeline_partitions', 'dml'),
  ('clockgrove', 'streams', 'dml'),
  ('clockgrove', 'command_receipts', 'journal_receipt'),
  ('clockgrove', 'authority_decisions', 'journal_append'),
  ('clockgrove', 'events', 'journal_append'),
  ('clockgrove', 'event_dispatches', 'journal_append'),
  ('clockgrove', 'artifact_references', 'journal_append'),
  ('clockgrove', 'artifact_data_keys', 'key_rewrap'),
  ('clockgrove', 'snapshots', 'journal_append'),
  ('clockgrove', 'partition_states', 'insert_update'),
  ('clockgrove', 'clock_admissions', 'insert_delete'),
  ('clockgrove', 'partition_schedules', 'insert_update'),
  ('clockgrove', 'world_memberships', 'none'),
  ('clockgrove', 'inspector_accesses', 'none'),
  ('clockgrove', 'runtime_operator_actions', 'none'),
  ('clockgrove', 'conversation_sessions', 'participant'),
  ('clockgrove', 'conversation_participants', 'participant'),
  ('clockgrove', 'conversation_messages', 'participant'),
  ('clockgrove', 'conversation_turns', 'participant'),
  ('clockgrove', 'agent_runs', 'participant'),
  ('clockgrove', 'run_steps', 'participant'),
  ('clockgrove_management', 'principals', 'none'),
  ('clockgrove_management', 'identity_links', 'none'),
  ('clockgrove_management', 'workspace_memberships', 'none'),
  ('clockgrove_birth', 'pack_artifacts', 'append_only'),
  ('clockgrove_birth', 'pack_artifact_resources', 'append_only'),
  ('clockgrove_birth', 'provisioning_cases', 'insert_update'),
  ('clockgrove_birth', 'pack_installations', 'append_only'),
  ('clockgrove_birth', 'world_birth_states', 'append_only'),
  ('clockgrove_birth', 'birth_state_sections', 'append_only'),
  ('clockgrove_birth', 'birth_space_state', 'append_only'),
  ('clockgrove_birth', 'birth_schedules', 'append_only'),
  ('clockgrove_birth', 'birth_random_streams', 'append_only'),
  ('clockgrove_birth', 'birth_cognitive_seed_refs', 'append_only');

-- Completeness: every RLS-enabled table of the suite's schemas must be in the exercised set above.
DO $$
DECLARE
  unexercised text;
  stale text;
BEGIN
  SELECT string_agg(format('%I.%I', namespace.nspname, class.relname), ', '
           ORDER BY namespace.nspname, class.relname)
    INTO unexercised
    FROM pg_class AS class
    JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
   WHERE class.relkind IN ('r', 'p')
     AND class.relrowsecurity
     AND namespace.nspname IN (
       'clockgrove', 'clockgrove_auth', 'clockgrove_management', 'clockgrove_birth'
     )
     AND NOT EXISTS (
       SELECT 1 FROM pg_temp.attack_surface AS surface
        WHERE surface.schema_name = namespace.nspname AND surface.table_name = class.relname
     );
  IF unexercised IS NOT NULL THEN
    RAISE EXCEPTION 'RLS tables not exercised by the attack suite: %', unexercised
      USING ERRCODE = 'XX997';
  END IF;
  SELECT string_agg(format('%I.%I', surface.schema_name, surface.table_name), ', '
           ORDER BY surface.schema_name, surface.table_name)
    INTO stale
    FROM pg_temp.attack_surface AS surface
   WHERE NOT EXISTS (
     SELECT 1
       FROM pg_class AS class
       JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
      WHERE namespace.nspname = surface.schema_name
        AND class.relname = surface.table_name
        AND class.relrowsecurity
   );
  IF stale IS NOT NULL THEN
    RAISE EXCEPTION 'attack suite lists tables that are not RLS-enabled: %', stale
      USING ERRCODE = 'XX997';
  END IF;
END;
$$;

-- Session-local helpers. They live in pg_temp, so they only exist for this connection. The digest
-- helper hashes every row the current context can read, across all tables the runtime role may
-- read. The leak helper is the classic RLS probe: a cheap non-leakproof function that records every
-- value it is handed, to show whether the planner feeds it rows the policy should have hidden.
CREATE FUNCTION pg_temp.visible_digest() RETURNS text
LANGUAGE sql AS $f$
  SELECT md5(string_agg(
    query_to_xml(
      format('SELECT * FROM %I.%I AS x ORDER BY to_jsonb(x)::text', schema_name, table_name),
      false, false, ''
    )::text, '' ORDER BY schema_name, table_name))
  FROM pg_temp.attack_surface
  WHERE runtime_privilege <> 'none'
$f$;

CREATE FUNCTION pg_temp.leak(value text) RETURNS boolean
LANGUAGE sql VOLATILE COST 0.0001 AS $f$
  SELECT set_config(
    'attack.seen',
    coalesce(current_setting('attack.seen', true), '') || '|' || value,
    true
  ) IS NOT NULL
$f$;

-- Sets a transaction-local runtime context; the ceiling defaults to every category.
CREATE FUNCTION pg_temp.act_as(
  tenant text,
  principal text,
  ceiling text DEFAULT '{"version":1,"allowedCategories":["public_scene","private_cognition","conversation","credential","operator_evidence"]}'
) RETURNS void
LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM set_config('app.tenant_id', tenant, true);
  PERFORM set_config('app.principal_id', principal, true);
  PERFORM set_config('app.privacy_ceiling', ceiling, true);
END;
$f$;

CREATE TEMP TABLE attack_digests (label text PRIMARY KEY, digest text NOT NULL);

BEGIN;
SELECT pg_temp.act_as('tenant-a', 'principal-a');
INSERT INTO attack_digests SELECT 'tenant-a', pg_temp.visible_digest();
SELECT set_config('app.tenant_id', 'tenant-b', true);
SELECT set_config('app.principal_id', 'principal-b', true);
INSERT INTO attack_digests SELECT 'tenant-b', pg_temp.visible_digest();
COMMIT;

-- Hostile identifiers and payloads in tenant, principal and privacy-ceiling context.
-- A stored hostile tenant sees only itself even though the same principal belongs to every one.
DO $$
DECLARE
  hostile text;
  table_name text;
  foreign_rows bigint;
  own_rows bigint;
  expected_rows bigint;
  tables text[] := ARRAY(
    SELECT format('%I.%I', surface.schema_name, surface.table_name)
      FROM pg_temp.attack_surface AS surface
     WHERE surface.runtime_privilege <> 'none'
     ORDER BY surface.schema_name, surface.table_name
  );
BEGIN
  FOREACH hostile IN ARRAY ARRAY[
    'tenant-a'' OR ''1''=''1',
    'tenant-a''; DROP TABLE clockgrove.events; --',
    'tenant-a%',
    'tenant_a',
    'TENANT-A',
    'tenant-a ',
    'tenant' || chr(8209) || 'a',
    't' || chr(1077) || 'nant-a',
    'tenant-a' || chr(8203),
    'tenant-a' || chr(769),
    'tenant-a"\',
    repeat('tenant-a-', 100)
  ] LOOP
    PERFORM pg_temp.act_as(hostile, 'principal-a', '{"version":1,"allowedCategories":["public_scene"]}');
    FOREACH table_name IN ARRAY tables LOOP
      EXECUTE format(
        'SELECT count(*) FILTER (WHERE tenant_id <> %L), count(*) FROM %s',
        hostile, table_name
      ) INTO foreign_rows, own_rows;
      IF foreign_rows <> 0 THEN
        RAISE EXCEPTION 'hostile tenant context read % foreign rows from %',
          foreign_rows, table_name;
      END IF;
      expected_rows := CASE WHEN table_name IN (
        'clockgrove.event_dispatches', 'clockgrove.artifact_references',
        'clockgrove.artifact_data_keys', 'clockgrove.snapshots',
        'clockgrove.conversation_sessions', 'clockgrove.conversation_participants',
        'clockgrove.conversation_messages', 'clockgrove.conversation_turns',
        'clockgrove.agent_runs', 'clockgrove.run_steps'
      ) THEN 0 ELSE 1 END;
      IF own_rows <> expected_rows THEN
        RAISE EXCEPTION 'hostile tenant context saw % rows in %', own_rows, table_name;
      END IF;
    END LOOP;
  END LOOP;
END;
$$;

-- Tenant, principal and ceiling values that match nothing must see nothing, and never fail.
DO $$
DECLARE
  hostile text;
  table_name text;
  visible bigint;
  tables text[] := ARRAY(
    SELECT format('%I.%I', surface.schema_name, surface.table_name)
      FROM pg_temp.attack_surface AS surface
     WHERE surface.runtime_privilege <> 'none'
     ORDER BY surface.schema_name, surface.table_name
  );
BEGIN
  FOREACH hostile IN ARRAY ARRAY[
    '',
    ''' OR 1=1 --',
    'tenant-a''--',
    '%',
    'tenant-%',
    'tenant-_',
    '*',
    '(SELECT ''tenant-a'')',
    'tenant-a,tenant-b',
    'tenant-a tenant-b',
    'tenant-a/*',
    'tenant-a' || chr(160),
    'tenant-a' || chr(65279),
    'tenant-a' || E'\n',
    'tenant-a' || E'\t',
    '{tenant-a}',
    'tenant-a' || repeat(' ', 100000),
    repeat('x', 1000000)
  ] LOOP
    -- Hostile tenant, real principal.
    PERFORM pg_temp.act_as(hostile, 'principal-a');
    FOREACH table_name IN ARRAY tables LOOP
      EXECUTE format('SELECT count(*) FROM %s', table_name) INTO visible;
      IF visible <> 0 THEN
        RAISE EXCEPTION 'unmatched hostile tenant read % rows from %', visible, table_name;
      END IF;
    END LOOP;
    -- Real tenant, hostile principal.
    PERFORM set_config('app.tenant_id', 'tenant-a', true);
    PERFORM set_config('app.principal_id', hostile, true);
    FOREACH table_name IN ARRAY tables LOOP
      EXECUTE format('SELECT count(*) FROM %s', table_name) INTO visible;
      IF visible <> 0 THEN
        RAISE EXCEPTION 'unmatched hostile principal read % rows from %', visible, table_name;
      END IF;
    END LOOP;
  END LOOP;

  -- A principal of another tenant has no authority in this one, in either direction.
  FOREACH hostile IN ARRAY ARRAY['tenant-a:principal-b', 'tenant-b:principal-a'] LOOP
    PERFORM set_config('app.tenant_id', split_part(hostile, ':', 1), true);
    PERFORM set_config('app.principal_id', split_part(hostile, ':', 2), true);
    FOREACH table_name IN ARRAY tables LOOP
      EXECUTE format('SELECT count(*) FROM %s', table_name) INTO visible;
      IF visible <> 0 THEN
        RAISE EXCEPTION '% read % rows from %', hostile, visible, table_name;
      END IF;
    END LOOP;
  END LOOP;
  PERFORM set_config('app.tenant_id', 'tenant-a', true);

  -- Malformed, ambiguous or oversized privacy ceilings fail closed.
  PERFORM set_config('app.principal_id', 'principal-a', true);
  FOREACH hostile IN ARRAY ARRAY[
    '{"version":1,"allowedCategories":["public_scene"],"extra":true}',
    '{"version":"1","allowedCategories":["public_scene"]}',
    '{"version":2,"allowedCategories":["public_scene"]}',
    '{"allowedCategories":["public_scene"]}',
    '["public_scene"]',
    '"public_scene"',
    'public_scene',
    'null',
    '{',
    '{"version":1,"allowedCategories":["public_scene"]}garbage',
    '{"version":1,"allowedCategories":["public_scene'' OR ''1''=''1"]}',
    '{"version":1,"allowedCategories":[["public_scene"]]}',
    '{"version":1,"allowedCategories":{"public_scene":true}}',
    '{"version":1,"allowedCategories":["PUBLIC_SCENE"]}',
    '{"version":1,"allowedCategories":["public_scene ", "conversation"]}',
    '{"version":1,"allowedCategories":["public_scene' || chr(8203) || '"]}',
    '{"version":1,"allowedCategories":["public' || chr(8208) || 'scene"]}',
    '{"version":1,"allowedCategories":["public_scene",null]}',
    '{"version":1,"allowedCategories":["public_scene",1]}',
    '{"version":1,"allowedCategories":["*"]}',
    '{"version":1,"allowedCategories":["public_scene","public_scene"]}',
    '{"version":1,"allowedCategories":[' ||
      (SELECT string_agg('"public_scene"', ',') FROM generate_series(1, 50000)) || ']}',
    repeat('[', 100000) || repeat(']', 100000),
    '{"version":1,"allowedCategories":["' || repeat('p', 1000000) || '"]}'
  ] LOOP
    PERFORM set_config('app.privacy_ceiling', hostile, true);
    SELECT count(*) INTO visible FROM clockgrove.events;
    IF visible <> 0 THEN
      RAISE EXCEPTION 'hostile privacy ceiling % granted % events', left(hostile, 60), visible;
    END IF;
    SELECT count(*) INTO visible FROM clockgrove.event_dispatches;
    IF visible <> 0 THEN
      RAISE EXCEPTION 'hostile privacy ceiling granted dispatches';
    END IF;
  END LOOP;
END;
$$;

-- Errors and refusals reveal nothing about another tenant. A refusal for an identifier that exists
-- in another tenant is indistinguishable from one for an identifier that does not exist.
DO $$
DECLARE
  statements text[] := ARRAY[
    $q$INSERT INTO clockgrove.command_receipts (tenant_id, command_id, request_hash, command_bytes, target_address, status) VALUES ('tenant-b', 'command-b', 'x', '\x00', '{}', 'pending')$q$,
    $q$INSERT INTO clockgrove.command_receipts (tenant_id, command_id, request_hash, command_bytes, target_address, status) VALUES ('tenant-b', 'command-unknown', 'x', '\x00', '{}', 'pending')$q$,
    $q$INSERT INTO clockgrove.tenants (tenant_id, display_name) VALUES ('tenant-b', 'x')$q$,
    $q$INSERT INTO clockgrove.tenants (tenant_id, display_name) VALUES ('tenant-unknown', 'x')$q$,
    $q$INSERT INTO clockgrove.tenant_principals (tenant_id, principal_id) VALUES ('tenant-b', 'principal-b')$q$,
    $q$INSERT INTO clockgrove.tenant_principals (tenant_id, principal_id) VALUES ('tenant-unknown', 'principal-b')$q$,
    $q$UPDATE clockgrove.worlds SET tenant_id = 'tenant-b' WHERE tenant_id = 'tenant-a'$q$,
    $q$UPDATE clockgrove.worlds SET tenant_id = 'tenant-unknown' WHERE tenant_id = 'tenant-a'$q$,
    $q$UPDATE clockgrove.events SET privacy_class = 'credential' WHERE event_id = 'event-a-public'$q$,
    $q$INSERT INTO clockgrove.events (event_id, tenant_id, world_id, timeline_id, partition_id, space_id, stream_id, stream_sequence, partition_sequence, event_type, schema_version, simulation_time, command_id, correlation_id, privacy_class, payload_hash, attribution, policy_versions, payload, event_bytes) VALUES ('event-forged', 'tenant-a', 'world-a', 'timeline-a', 'partition-a', 'space-a', 'stream-a', 9, 9, 'X', 2, 0, 'command-a', 'c', 'credential', 'h', '{}', '{}', '{}', '\x00')$q$,
    $q$INSERT INTO clockgrove.events (event_id, tenant_id, world_id, timeline_id, partition_id, space_id, stream_id, stream_sequence, partition_sequence, event_type, schema_version, simulation_time, command_id, correlation_id, privacy_class, payload_hash, attribution, policy_versions, payload, event_bytes) VALUES ('event-forged', 'tenant-b', 'world-b', 'timeline-b', 'partition-b', 'space-b', 'stream-b', 9, 9, 'X', 2, 0, 'command-b', 'c', 'public_scene', 'h', '{}', '{}', '{}', '\x00')$q$,
    $q$SELECT tenant_id::integer FROM clockgrove.tenants$q$,
    $q$SELECT event_id::integer FROM clockgrove.events$q$,
    $q$SELECT payload_hash::integer FROM clockgrove.events$q$,
    $q$INSERT INTO clockgrove.authority_decisions (tenant_id, authority_decision_id, command_id, outcome, world_id, timeline_id, action_id, attribution, inputs) VALUES ('tenant-b', 'authority:command-b', 'command-b', 'allow', 'world-b', 'timeline-b', 'a', '{"causalRootActionId":"a"}', '{}')$q$,
    $q$INSERT INTO clockgrove.authority_decisions (tenant_id, authority_decision_id, command_id, outcome, world_id, timeline_id, action_id, attribution, inputs) VALUES ('tenant-b', 'authority:command-unknown', 'command-unknown', 'allow', 'world-b', 'timeline-b', 'a', '{"causalRootActionId":"a"}', '{}')$q$
  ];
  expected_state text[] := ARRAY[
    '42501', '42501', '42501', '42501', '42501', '42501', '42501', '42501', '42501',
    '42501', '42501', '22P02', '22P02', '22P02', '42501', '42501'
  ];
  states text[] := '{}';
  messages text[] := '{}';
  statement text;
  captured_state text;
  captured_message text;
  captured_detail text;
  captured_hint text;
  foreign_token text;
  index integer := 0;
BEGIN
  PERFORM pg_temp.act_as('tenant-a', 'principal-a', '{"version":1,"allowedCategories":["public_scene","conversation"]}');
  FOREACH statement IN ARRAY statements LOOP
    index := index + 1;
    BEGIN
      EXECUTE statement;
      RAISE EXCEPTION 'attack statement % unexpectedly succeeded', index USING ERRCODE = 'XX999';
    EXCEPTION
      WHEN SQLSTATE 'XX999' THEN RAISE;
      WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS captured_detail = PG_EXCEPTION_DETAIL,
                                captured_hint = PG_EXCEPTION_HINT;
        captured_state := SQLSTATE;
        captured_message := SQLERRM;
    END;
    IF captured_state <> expected_state[index] THEN
      RAISE EXCEPTION 'attack statement % failed with %, expected %',
        index, captured_state, expected_state[index];
    END IF;
    -- Message, detail and hint are what a client receives. The statement text itself is the
    -- attacker's own input, so only the server's wording is inspected.
    FOREACH foreign_token IN ARRAY ARRAY[
      'tenant-b', 'principal-b', 'world-b', 'timeline-b', 'partition-b', 'space-b', 'stream-b',
      'command-b', 'event-b', 'hash-b', 'Tenant B'
    ] LOOP
      IF position(foreign_token IN coalesce(captured_message, '') || ' '
           || coalesce(captured_detail, '') || ' ' || coalesce(captured_hint, '')) > 0 THEN
        RAISE EXCEPTION 'error for attack statement % mentions another tenant: %',
          index, captured_message;
      END IF;
    END LOOP;
    states := states || captured_state;
    messages := messages || captured_message;
  END LOOP;
  -- Existing and unknown foreign identifiers draw the same refusal.
  FOREACH index IN ARRAY ARRAY[1, 3, 5, 7, 15] LOOP
    IF states[index] IS DISTINCT FROM states[index + 1]
       OR messages[index] IS DISTINCT FROM messages[index + 1] THEN
      RAISE EXCEPTION 'refusal % differs for existing and unknown foreign identifiers', index;
    END IF;
  END LOOP;
END;
$$;

-- Hidden rows are never evaluated, so they cannot raise errors or feed a leaky function.
DO $$
DECLARE
  seen text;
BEGIN
  PERFORM pg_temp.act_as('tenant-a', 'principal-a', '{"version":1,"allowedCategories":["public_scene"]}');
  PERFORM 1 / CASE WHEN tenant_id = 'tenant-b' THEN 0 ELSE 1 END FROM clockgrove.tenants;
  PERFORM 1 / CASE WHEN tenant_id = 'tenant-b' THEN 0 ELSE 1 END FROM clockgrove.events;
  PERFORM 1 / CASE WHEN event_id = 'event-a-private' THEN 0 ELSE 1 END FROM clockgrove.events;

  PERFORM set_config('attack.seen', '', true);
  PERFORM count(*) FROM clockgrove.tenants WHERE pg_temp.leak(tenant_id);
  PERFORM count(*) FROM clockgrove.worlds WHERE pg_temp.leak(world_id);
  PERFORM count(*) FROM clockgrove.command_receipts WHERE pg_temp.leak(command_id);
  PERFORM count(*) FROM clockgrove.authority_decisions WHERE pg_temp.leak(authority_decision_id);
  PERFORM count(*) FROM clockgrove.events WHERE pg_temp.leak(event_id);
  PERFORM count(*) FROM clockgrove.events WHERE pg_temp.leak(payload_hash);
  seen := current_setting('attack.seen');
  IF seen = '' OR seen ~ '(tenant-b|world-b|command-b|event-b|hash-event-b|event-a-private|hash-event-a-private)' THEN
    RAISE EXCEPTION 'non-leakproof function observed hidden rows: %', seen;
  END IF;
END;
$$;

-- Identifiers are scoped by tenant. Reusing an event ID that belongs to another tenant must succeed
-- exactly as for an unused ID: a refusal would tell this tenant that the other one exists and
-- what it called its events.
DO $$
BEGIN
  PERFORM pg_temp.act_as('tenant-a', 'principal-a', '{"version":1,"allowedCategories":["public_scene"]}');
  BEGIN
    INSERT INTO clockgrove.events (
      event_id, tenant_id, world_id, timeline_id, partition_id, space_id, stream_id,
      stream_sequence, partition_sequence, event_type, schema_version, simulation_time,
      command_id, correlation_id, privacy_class, payload_hash, attribution, policy_versions,
      payload, event_bytes
    ) VALUES (
      'event-b-public', 'tenant-a', 'world-a', 'timeline-a', 'partition-a', 'space-a',
      'stream-a', 9, 9, 'X', 2, 0, 'command-a', 'c', 'public_scene', 'h', '{}', '{}', '{}',
      '\x00'
    );
    RAISE EXCEPTION 'rollback' USING ERRCODE = 'XX998';
  EXCEPTION
    WHEN SQLSTATE 'XX998' THEN NULL;
  END;
END;
$$;

-- Cross-tenant UPDATE and DELETE. Rows the policy hides match no statement; moving a row into
-- another tenant is refused. Both are committed, then every tenant is proven byte-identical.
BEGIN;
SELECT pg_temp.act_as('tenant-a', 'principal-a');
DO $$
DECLARE
  statement text;
  affected bigint;
BEGIN
  FOREACH statement IN ARRAY ARRAY[
    $q$UPDATE clockgrove.tenants SET display_name = 'taken over' WHERE tenant_id = 'tenant-b'$q$,
    $q$UPDATE clockgrove.tenant_principals SET principal_id = 'principal-a' WHERE tenant_id = 'tenant-b'$q$,
    $q$UPDATE clockgrove.worlds SET lifecycle_status = 'archived' WHERE tenant_id = 'tenant-b'$q$,
    $q$UPDATE clockgrove.timelines SET state = 'archived' WHERE tenant_id = 'tenant-b'$q$,
    $q$UPDATE clockgrove.timeline_partitions SET head_sequence = 999 WHERE tenant_id = 'tenant-b'$q$,
    $q$UPDATE clockgrove.streams SET current_sequence = 999 WHERE tenant_id = 'tenant-b'$q$,
    $q$UPDATE clockgrove.command_receipts SET status = 'rejected' WHERE tenant_id = 'tenant-b'$q$,
    $q$UPDATE clockgrove.partition_states SET revision = 999 WHERE tenant_id = 'tenant-b'$q$,
    $q$UPDATE clockgrove.partition_states SET clock_admitted_horizon = 999, clock_owner_generation = 999, clock_owner_id = 'foreign-owner' WHERE tenant_id = 'tenant-b'$q$,
    $q$UPDATE clockgrove.partition_states SET clock_policy = '["record", []]'::jsonb WHERE tenant_id = 'tenant-b'$q$,
    $q$UPDATE clockgrove.partition_schedules SET status = 'done', completed_by_command_id = 'x' WHERE tenant_id = 'tenant-b'$q$,
    $q$UPDATE clockgrove.tenants SET display_name = 'taken over' WHERE tenant_id <> 'tenant-a'$q$,
    $q$UPDATE clockgrove.artifact_data_keys SET kek_id = 'kek-forged' WHERE tenant_id = 'tenant-b'$q$,
    $q$DELETE FROM clockgrove.clock_admissions WHERE tenant_id = 'tenant-b'$q$,
    $q$DELETE FROM clockgrove.clock_admissions WHERE tenant_id <> 'tenant-a'$q$,
    $q$DELETE FROM clockgrove.streams WHERE tenant_id = 'tenant-b'$q$,
    $q$DELETE FROM clockgrove.timeline_partitions WHERE tenant_id = 'tenant-b'$q$,
    $q$DELETE FROM clockgrove.timelines WHERE tenant_id = 'tenant-b'$q$,
    $q$DELETE FROM clockgrove.worlds WHERE tenant_id = 'tenant-b'$q$,
    $q$DELETE FROM clockgrove.tenant_principals WHERE tenant_id = 'tenant-b'$q$,
    $q$DELETE FROM clockgrove.tenants WHERE tenant_id = 'tenant-b'$q$,
    $q$DELETE FROM clockgrove.tenants WHERE tenant_id <> 'tenant-a'$q$
  ] LOOP
    EXECUTE statement;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 0 THEN
      RAISE EXCEPTION 'cross-tenant statement affected % rows: %', affected, statement;
    END IF;
  END LOOP;

  -- Committed journal rows are append-only for the runtime role: UPDATE and DELETE of events,
  -- dispatch intent, decisions, artifacts and snapshots, and DELETE of receipts, are refused before
  -- any row is chosen. Data keys may only be rewrapped (kek_id, wrapped_key), never relabelled or
  -- deleted.
  FOREACH statement IN ARRAY ARRAY[
    $q$UPDATE clockgrove.events SET payload_hash = 'forged' WHERE tenant_id = 'tenant-b'$q$,
    $q$UPDATE clockgrove.events SET payload_hash = 'forged' WHERE event_id = 'event-b-public'$q$,
    $q$UPDATE clockgrove.event_dispatches SET status = 'delivered' WHERE tenant_id = 'tenant-b'$q$,
    $q$UPDATE clockgrove.authority_decisions SET reason_code = 'forged' WHERE tenant_id = 'tenant-b'$q$,
    $q$DELETE FROM clockgrove.event_dispatches WHERE tenant_id <> 'tenant-a'$q$,
    $q$DELETE FROM clockgrove.events WHERE tenant_id = 'tenant-b'$q$,
    $q$DELETE FROM clockgrove.events WHERE event_id = 'event-b-public'$q$,
    $q$DELETE FROM clockgrove.command_receipts WHERE tenant_id = 'tenant-b'$q$,
    $q$DELETE FROM clockgrove.authority_decisions WHERE tenant_id = 'tenant-b'$q$,
    $q$UPDATE clockgrove.artifact_references SET content_hash = content_hash WHERE tenant_id = 'tenant-b'$q$,
    $q$DELETE FROM clockgrove.artifact_references WHERE tenant_id <> 'tenant-a'$q$,
    $q$DELETE FROM clockgrove.snapshots WHERE tenant_id <> 'tenant-a'$q$,
    $q$UPDATE clockgrove.artifact_data_keys SET privacy_class = 'conversation'$q$,
    $q$UPDATE clockgrove.artifact_data_keys SET key_version = 2$q$,
    $q$DELETE FROM clockgrove.artifact_data_keys WHERE tenant_id = 'tenant-b'$q$,
    $q$DELETE FROM clockgrove.artifact_data_keys$q$
  ] LOOP
    BEGIN
      EXECUTE statement;
      RAISE EXCEPTION 'append-only journal statement was allowed: %', statement
        USING ERRCODE = 'XX999';
    EXCEPTION
      WHEN insufficient_privilege THEN NULL;
    END;
  END LOOP;

  -- Moving rows into another tenant is refused, even by a statement that needs no SELECT rights.
  FOREACH statement IN ARRAY ARRAY[
    $q$UPDATE clockgrove.worlds SET tenant_id = 'tenant-b'$q$,
    $q$UPDATE clockgrove.command_receipts SET tenant_id = 'tenant-b'$q$,
    $q$UPDATE clockgrove.events SET tenant_id = 'tenant-b'$q$,
    $q$UPDATE clockgrove.tenant_principals SET tenant_id = 'tenant-b'$q$,
    $q$UPDATE clockgrove.tenants SET tenant_id = 'tenant-b'$q$,
    $q$UPDATE clockgrove.artifact_data_keys SET tenant_id = 'tenant-b'$q$,
    $q$INSERT INTO clockgrove.authority_decisions SELECT (jsonb_populate_record(NULL::clockgrove.authority_decisions, to_jsonb(source) || '{"tenant_id":"tenant-b"}')).* FROM clockgrove.authority_decisions AS source$q$,
    $q$INSERT INTO clockgrove.artifact_data_keys SELECT (jsonb_populate_record(NULL::clockgrove.artifact_data_keys, to_jsonb(source) || '{"tenant_id":"tenant-b"}')).* FROM clockgrove.artifact_data_keys AS source$q$,
    $q$INSERT INTO clockgrove.artifact_references SELECT (jsonb_populate_record(NULL::clockgrove.artifact_references, to_jsonb(source) || '{"tenant_id":"tenant-b"}')).* FROM clockgrove.artifact_references AS source$q$
  ] LOOP
    BEGIN
      EXECUTE statement;
      RAISE EXCEPTION 'tenant-moving statement unexpectedly succeeded: %', statement
        USING ERRCODE = 'XX999';
    EXCEPTION
      -- Receipt identity, tenant included, is immutable: the receipt guard refuses first.
      WHEN insufficient_privilege OR SQLSTATE 'CG006' THEN NULL;
    END;
  END LOOP;
END;
$$;
COMMIT;

-- World birth tables. The runtime role may only append to them (and advance provisioning cases), so
-- cross-tenant UPDATE and DELETE are refused or reach no rows, a row copied or moved into another
-- tenant is refused, and nothing is deletable.
BEGIN;
SELECT pg_temp.act_as('tenant-a', 'principal-a');
DO $$
DECLARE
  surface record;
  target text;
  foreign_tenant text;
  affected bigint;
BEGIN
  FOR surface IN
    SELECT schema_name, table_name, runtime_privilege FROM pg_temp.attack_surface
     WHERE runtime_privilege IN ('append_only', 'insert_update')
     ORDER BY schema_name, table_name
  LOOP
    target := format('%I.%I', surface.schema_name, surface.table_name);
    FOREACH foreign_tenant IN ARRAY ARRAY['tenant-b', 'tenant-a%'] LOOP
      IF surface.runtime_privilege = 'insert_update' THEN
        EXECUTE format('UPDATE %s SET tenant_id = tenant_id WHERE tenant_id = %L', target, foreign_tenant);
        GET DIAGNOSTICS affected = ROW_COUNT;
        IF affected <> 0 THEN
          RAISE EXCEPTION 'cross-tenant UPDATE reached % rows of %', affected, target;
        END IF;
      ELSE
        BEGIN
          EXECUTE format('UPDATE %s SET tenant_id = tenant_id WHERE tenant_id = %L', target, foreign_tenant);
          RAISE EXCEPTION 'append-only table % accepted an UPDATE', target USING ERRCODE = 'XX999';
        EXCEPTION
          WHEN insufficient_privilege THEN NULL;
        END;
      END IF;
      BEGIN
        EXECUTE format('DELETE FROM %s WHERE tenant_id = %L', target, foreign_tenant);
        RAISE EXCEPTION 'table % accepted a DELETE', target USING ERRCODE = 'XX999';
      EXCEPTION
        WHEN insufficient_privilege THEN NULL;
      END;
      -- A copy of this tenant's own row, re-keyed to another tenant, is refused.
      BEGIN
        EXECUTE format(
          $q$INSERT INTO %1$s
             SELECT (jsonb_populate_record(
               NULL::%1$s, to_jsonb(source) || jsonb_build_object('tenant_id', %2$L::text)
             )).*
             FROM %1$s AS source WHERE tenant_id = 'tenant-a'$q$,
          target, foreign_tenant
        );
        RAISE EXCEPTION 'cross-tenant INSERT into % succeeded', target USING ERRCODE = 'XX999';
      EXCEPTION
        WHEN insufficient_privilege THEN NULL;
      END;
      -- Moving a visible row into another tenant is refused (by the privilege, the policy check, or
      -- for provisioning cases the immutable-identity trigger).
      BEGIN
        EXECUTE format('UPDATE %s SET tenant_id = %L', target, foreign_tenant);
        RAISE EXCEPTION 'tenant-moving UPDATE of % succeeded', target USING ERRCODE = 'XX999';
      EXCEPTION
        WHEN insufficient_privilege OR SQLSTATE 'CG006' THEN NULL;
      END;
    END LOOP;
  END LOOP;
END;
$$;
COMMIT;

-- Transaction-local authorization does not survive COMMIT: the pooled connection holds no
-- authority and reads nothing between transactions.
DO $$
DECLARE
  surface record;
  visible bigint;
BEGIN
  IF nullif(current_setting('app.tenant_id', true), '') IS NOT NULL
     OR nullif(current_setting('app.principal_id', true), '') IS NOT NULL
     OR nullif(current_setting('app.privacy_ceiling', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'transaction-local authorization leaked after commit';
  END IF;
  FOR surface IN
    SELECT schema_name, table_name FROM pg_temp.attack_surface WHERE runtime_privilege <> 'none'
  LOOP
    EXECUTE format('SELECT count(*) FROM %I.%I', surface.schema_name, surface.table_name)
      INTO visible;
    IF visible <> 0 THEN
      RAISE EXCEPTION 'authority remained after commit: % rows of %.%',
        visible, surface.schema_name, surface.table_name;
    END IF;
  END LOOP;
END;
$$;

-- Every context sees only its own birth rows, and a blind provisioning-case UPDATE reaches exactly
-- those rows. A non-member principal, another tenant's principal and an unknown tenant reach none.
BEGIN;
DO $$
DECLARE
  context record;
  surface record;
  target text;
  visible bigint;
  expected bigint;
  affected bigint;
BEGIN
  FOR context IN
    SELECT * FROM (VALUES
      ('tenant-a', 'principal-a', true),
      ('tenant-a', 'principal-b', false),
      ('tenant-b', 'principal-a', false),
      ('tenant-unknown', 'principal-a', false),
      ('tenant-a%', 'principal-a', true)
    ) AS contexts (tenant_id, principal_id, member)
  LOOP
    PERFORM pg_temp.act_as(context.tenant_id, context.principal_id);
    expected := CASE WHEN context.member THEN 1 ELSE 0 END;
    FOR surface IN
      SELECT schema_name, table_name, runtime_privilege FROM pg_temp.attack_surface
       WHERE runtime_privilege IN ('append_only', 'insert_update')
       ORDER BY schema_name, table_name
    LOOP
      target := format('%I.%I', surface.schema_name, surface.table_name);
      EXECUTE format('SELECT count(*) FROM %s', target) INTO visible;
      IF visible <> expected THEN
        RAISE EXCEPTION 'context % read % rows of %, expected %',
          context::text, visible, target, expected;
      END IF;
      IF surface.runtime_privilege = 'insert_update' THEN
        BEGIN
          EXECUTE format('UPDATE %s SET updated_at = DEFAULT', target);
          GET DIAGNOSTICS affected = ROW_COUNT;
          IF affected <> expected THEN
            RAISE EXCEPTION 'blind UPDATE of % as % reached % rows, expected %',
              target, context::text, affected, expected;
          END IF;
          RAISE EXCEPTION 'rollback' USING ERRCODE = 'XX998';
        EXCEPTION
          WHEN SQLSTATE 'XX998' THEN NULL;
        END;
      END IF;
    END LOOP;
  END LOOP;
END;
$$;
COMMIT;

-- Tables the runtime role has no privilege on hold real fixture rows. In a tenant context, a hostile
-- tenant context and a foreign tenant context, it can neither read nor write any of them.
BEGIN;
DO $$
DECLARE
  tenant text;
  surface record;
  target text;
  first_column name;
  statement text;
BEGIN
  FOREACH tenant IN ARRAY ARRAY['tenant-a', 'tenant-b', 'tenant-a%'] LOOP
    PERFORM pg_temp.act_as(tenant, 'principal-a');
    FOR surface IN
      SELECT schema_name, table_name FROM pg_temp.attack_surface
       WHERE runtime_privilege = 'none' ORDER BY schema_name, table_name
    LOOP
      target := format('%I.%I', surface.schema_name, surface.table_name);
      first_column := (
        SELECT attribute.attname FROM pg_attribute AS attribute
          JOIN pg_class AS class ON class.oid = attribute.attrelid
          JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
         WHERE namespace.nspname = surface.schema_name AND class.relname = surface.table_name
           AND attribute.attnum = 1
      );
      FOREACH statement IN ARRAY ARRAY[
        format('SELECT count(*) FROM %s', target),
        format('INSERT INTO %s DEFAULT VALUES', target),
        format('UPDATE %s SET %I = %I', target, first_column, first_column),
        format('DELETE FROM %s', target),
        format('TRUNCATE %s', target)
      ] LOOP
        BEGIN
          EXECUTE statement;
          RAISE EXCEPTION 'runtime role was allowed: %', statement USING ERRCODE = 'XX999';
        EXCEPTION
          WHEN insufficient_privilege THEN NULL;
        END;
      END LOOP;
    END LOOP;
  END LOOP;
END;
$$;
COMMIT;

-- Statements without a WHERE clause need no SELECT rights, so only the UPDATE and DELETE policies
-- decide which rows they reach. Each context must touch exactly its own readable rows, or none; where world birth rows
-- block the deletion, only the scratch tenant proves the exact DELETE count.
-- A subtransaction rolls each attempt back so the next one starts from the same data.
DO $$
DECLARE
  contexts jsonb := '[
    {"tenant":"tenant-a","principal":"principal-a","member":true,"categories":["public_scene","private_cognition","conversation","credential","operator_evidence"],"deleteAll":true},
    {"tenant":"scratch-victim","principal":"principal-a","member":true,"categories":["public_scene","private_cognition","conversation","credential","operator_evidence"],"deleteAll":true},
    {"tenant":"tenant-a","principal":"principal-a","member":true,"categories":["public_scene"],"deleteAll":false},
    {"tenant":"tenant-a","principal":"principal-a","member":true,"categories":["conversation"],"deleteAll":false},
    {"tenant":"tenant-a","principal":"principal-a","member":true,"categories":[],"deleteAll":false},
    {"tenant":"tenant-a","principal":"principal-b","member":false,"categories":["public_scene","private_cognition","conversation","credential","operator_evidence"],"deleteAll":true},
    {"tenant":"tenant-unknown","principal":"principal-a","member":false,"categories":["public_scene","private_cognition","conversation","credential","operator_evidence"],"deleteAll":true}
  ]';
  -- Children first, so a context that may delete everything satisfies foreign keys.
  tables text[] := ARRAY[
    'event_dispatches', 'snapshots', 'artifact_references', 'artifact_data_keys', 'events',
    'command_receipts', 'authority_decisions', 'streams', 'timeline_partitions', 'timelines', 'worlds',
    'tenant_principals', 'tenants'
  ];
  -- The runtime role may not UPDATE these, nor DELETE from these, command_receipts or data keys.
  append_only_tables text[] := ARRAY[
    'event_dispatches', 'events', 'authority_decisions', 'artifact_references', 'snapshots'
  ];
  assignments jsonb := '{
    "tenants":"display_name = ''x''",
    "tenant_principals":"created_at = DEFAULT",
    "worlds":"lifecycle_status = ''archived''",
    "timelines":"state = ''archived''",
    "timeline_partitions":"head_sequence = 5",
    "streams":"current_sequence = 5",
    "command_receipts":"result = ''{}''",
    "authority_decisions":"reason_code = ''forged''",
    "events":"payload_hash = ''forged''",
    "event_dispatches":"attempts = 0",
    "artifact_references":"byte_length = 0",
    "artifact_data_keys":"kek_id = kek_id",
    "snapshots":"state_hash = state_hash"
  }';
  privacy_tables text[] := ARRAY[
    'events', 'event_dispatches', 'artifact_references', 'artifact_data_keys', 'snapshots'
  ];
  -- Rows that surviving world birth or journal rows (events, receipts, decisions) still reference.
  referenced_tables text[] := ARRAY['streams', 'timeline_partitions', 'timelines', 'worlds'];
  context jsonb;
  table_name text;
  categories text[];
  expected bigint;
  affected bigint;
BEGIN
  FOR context IN SELECT value FROM jsonb_array_elements(contexts) LOOP
    categories := ARRAY(SELECT jsonb_array_elements_text(context->'categories'));
    PERFORM set_config('app.tenant_id', context->>'tenant', true);
    PERFORM set_config('app.principal_id', context->>'principal', true);
    PERFORM set_config(
      'app.privacy_ceiling',
      jsonb_build_object('version', 1, 'allowedCategories', context->'categories')::text,
      true
    );
    FOREACH table_name IN ARRAY tables LOOP
      -- Rows this context may legitimately reach, counted by the stored tenant and category.
      IF (context->>'member')::boolean THEN
        IF table_name = ANY (privacy_tables) THEN
          EXECUTE format(
            'SELECT count(*) FROM clockgrove.%I WHERE tenant_id = %L AND privacy_class = ANY (%L)',
            table_name, context->>'tenant', categories
          ) INTO expected;
        ELSE
          EXECUTE format(
            'SELECT count(*) FROM clockgrove.%I WHERE tenant_id = %L', table_name, context->>'tenant'
          ) INTO expected;
        END IF;
      ELSE
        expected := 0;
      END IF;
      BEGIN
        EXECUTE format('UPDATE clockgrove.%I SET %s', table_name, assignments->>table_name);
        GET DIAGNOSTICS affected = ROW_COUNT;
        IF table_name = ANY (append_only_tables) THEN
          RAISE EXCEPTION 'blind UPDATE of append-only % was allowed', table_name
            USING ERRCODE = 'XX999';
        END IF;
        IF affected <> expected THEN
          RAISE EXCEPTION 'blind UPDATE of % as % reached % rows, expected %',
            table_name, context::text, affected, expected;
        END IF;
        RAISE EXCEPTION 'rollback' USING ERRCODE = 'XX998';
      EXCEPTION
        WHEN SQLSTATE 'XX998' THEN NULL;
        WHEN insufficient_privilege THEN
          IF NOT table_name = ANY (append_only_tables) THEN RAISE; END IF;
        -- Every reachable receipt is terminal, so the receipt guard refuses the first one.
        WHEN SQLSTATE 'CG006' THEN
          IF table_name <> 'command_receipts' OR expected = 0 THEN RAISE; END IF;
      END;
    END LOOP;
    -- Every context except the privacy-limited ones may delete all of its rows.
    BEGIN
      FOREACH table_name IN ARRAY tables LOOP
        CONTINUE WHEN NOT (context->>'deleteAll')::boolean
          AND NOT table_name = ANY (privacy_tables);
        CONTINUE WHEN table_name IN ('tenant_principals', 'tenants')
          AND (context->>'member')::boolean;
        IF table_name = ANY (append_only_tables)
           OR table_name IN ('command_receipts', 'artifact_data_keys') THEN
          BEGIN
            EXECUTE format('DELETE FROM clockgrove.%I', table_name);
            RAISE EXCEPTION 'blind DELETE from append-only % was allowed', table_name
              USING ERRCODE = 'XX999';
          EXCEPTION
            WHEN insufficient_privilege THEN NULL;
          END;
          CONTINUE;
        END IF;
        IF (context->>'member')::boolean THEN
          IF table_name = ANY (privacy_tables) THEN
            EXECUTE format(
              'SELECT count(*) FROM clockgrove.%I WHERE tenant_id = %L AND privacy_class = ANY (%L)',
              table_name, context->>'tenant', categories
            ) INTO expected;
          ELSE
            EXECUTE format(
              'SELECT count(*) FROM clockgrove.%I WHERE tenant_id = %L',
              table_name, context->>'tenant'
            ) INTO expected;
          END IF;
        ELSE
          expected := 0;
        END IF;
        IF expected > 0 AND table_name = ANY (referenced_tables)
           AND context->>'tenant' <> 'scratch-victim' THEN
          -- World birth or journal rows reference these and the runtime role cannot delete them, so
          -- the foreign key stops the statement. The scratch tenant has no dependants and is counted
          -- exactly.
          BEGIN
            EXECUTE format('DELETE FROM clockgrove.%I', table_name);
            RAISE EXCEPTION 'blind DELETE from % ignored its dependants as %', table_name, context::text
              USING ERRCODE = 'XX999';
          EXCEPTION
            WHEN foreign_key_violation THEN NULL;
          END;
          CONTINUE;
        END IF;
        EXECUTE format('DELETE FROM clockgrove.%I', table_name);
        GET DIAGNOSTICS affected = ROW_COUNT;
        IF affected <> expected THEN
          RAISE EXCEPTION 'blind DELETE from % as % reached % rows, expected %',
            table_name, context::text, affected, expected;
        END IF;
      END LOOP;
      RAISE EXCEPTION 'rollback' USING ERRCODE = 'XX998';
    EXCEPTION
      WHEN SQLSTATE 'XX998' THEN NULL;
    END;
  END LOOP;
END;
$$;

-- Unscoped statements from a hostile-looking tenant that shares the principal change only its own
-- rows. These are committed on purpose: they would be the damage if the tenant match were loose.
BEGIN;
SELECT pg_temp.act_as('tenant-a%', 'principal-a');
DO $$
DECLARE
  statement text;
  affected bigint;
BEGIN
  FOREACH statement IN ARRAY ARRAY[
    $q$UPDATE clockgrove.tenants SET display_name = 'overwritten'$q$,
    $q$UPDATE clockgrove.worlds SET lifecycle_status = 'archived'$q$,
    $q$UPDATE clockgrove.timelines SET state = 'archived'$q$,
    $q$UPDATE clockgrove.timeline_partitions SET head_sequence = 5$q$,
    $q$UPDATE clockgrove.streams SET current_sequence = 5$q$
  ] LOOP
    EXECUTE statement;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected > 1 THEN
      RAISE EXCEPTION 'unscoped statement touched % rows: %', affected, statement;
    END IF;
  END LOOP;
  -- Its committed journal rows stay: append-only privileges, the receipt guard and the events that
  -- still reference its stream refuse these.
  FOREACH statement IN ARRAY ARRAY[
    $q$UPDATE clockgrove.command_receipts SET result = '{}'$q$,
    $q$UPDATE clockgrove.events SET payload_hash = 'forged'$q$,
    $q$DELETE FROM clockgrove.event_dispatches$q$,
    $q$DELETE FROM clockgrove.events$q$,
    $q$DELETE FROM clockgrove.command_receipts$q$,
    $q$DELETE FROM clockgrove.authority_decisions$q$,
    $q$DELETE FROM clockgrove.streams$q$,
    $q$DELETE FROM clockgrove.artifact_references$q$,
    $q$DELETE FROM clockgrove.snapshots$q$,
    $q$DELETE FROM clockgrove.artifact_data_keys$q$
  ] LOOP
    BEGIN
      EXECUTE statement;
      RAISE EXCEPTION 'unscoped journal statement was allowed: %', statement
        USING ERRCODE = 'XX999';
    EXCEPTION
      WHEN insufficient_privilege OR foreign_key_violation OR SQLSTATE 'CG006' THEN NULL;
    END;
  END LOOP;
END;
$$;
COMMIT;

-- The scratch tenant 'scratch%' has no dependants, so its unscoped DELETEs are counted exactly: each
-- reaches the one row of that tenant and nothing of 'scratch-victim', which a LIKE match would add.
-- Its membership row goes before its tenant row, so the tenant row is no longer visible to it.
BEGIN;
SELECT set_config('app.tenant_id', 'scratch%', true);
SELECT set_config('app.principal_id', 'principal-a', true);
DO $$
DECLARE
  statement text;
  expected bigint;
  affected bigint;
BEGIN
  FOR statement, expected IN
    SELECT step->>0, (step->>1)::bigint FROM jsonb_array_elements('[
      ["DELETE FROM clockgrove.timeline_partitions", 1],
      ["DELETE FROM clockgrove.timelines", 1],
      ["DELETE FROM clockgrove.worlds", 1],
      ["SELECT 1", 0],
      ["DELETE FROM clockgrove.tenant_principals", 1],
      ["DELETE FROM clockgrove.tenants", 0]
    ]') AS step
  LOOP
    IF statement = 'SELECT 1' THEN
      IF (SELECT count(*) FROM clockgrove.worlds) <> 0
         OR (SELECT count(*) FROM clockgrove.timelines) <> 0
         OR (SELECT count(*) FROM clockgrove.timeline_partitions) <> 0 THEN
        RAISE EXCEPTION 'unscoped scratch DELETE did not remove its own rows';
      END IF;
      CONTINUE;
    END IF;
    EXECUTE statement;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> expected THEN
      RAISE EXCEPTION 'unscoped scratch statement % reached % rows, expected %',
        statement, affected, expected;
    END IF;
  END LOOP;
END;
$$;
COMMIT;

-- Nothing above changed what either real tenant can read, and the unscoped statements really ran.
BEGIN;
SELECT pg_temp.act_as('tenant-a', 'principal-a');
DO $$
BEGIN
  IF pg_temp.visible_digest() IS DISTINCT FROM
     (SELECT digest FROM attack_digests WHERE label = 'tenant-a') THEN
    RAISE EXCEPTION 'tenant-a data changed during cross-tenant attacks';
  END IF;
  PERFORM set_config('app.tenant_id', 'tenant-b', true);
  PERFORM set_config('app.principal_id', 'principal-b', true);
  IF pg_temp.visible_digest() IS DISTINCT FROM
     (SELECT digest FROM attack_digests WHERE label = 'tenant-b') THEN
    RAISE EXCEPTION 'tenant-b data changed during cross-tenant attacks';
  END IF;
  PERFORM set_config('app.tenant_id', 'tenant-a%', true);
  PERFORM set_config('app.principal_id', 'principal-a', true);
  IF (SELECT count(*) FROM clockgrove.events) <> 1
     OR (SELECT count(*) FROM clockgrove.command_receipts) <> 1
     OR (SELECT count(*) FROM clockgrove.authority_decisions) <> 1 THEN
    RAISE EXCEPTION 'hostile-tenant statements changed its committed journal rows';
  END IF;
  IF (SELECT count(*) FROM clockgrove.tenants) <> 1
     OR (SELECT count(*) FROM clockgrove.worlds) <> 1 THEN
    RAISE EXCEPTION 'hostile-tenant statements changed rows that world birth still references';
  END IF;
  PERFORM set_config('app.tenant_id', 'scratch-victim', true);
  IF (SELECT count(*) FROM clockgrove.worlds) <> 1
     OR (SELECT count(*) FROM clockgrove.timelines) <> 1
     OR (SELECT count(*) FROM clockgrove.timeline_partitions) <> 1 THEN
    RAISE EXCEPTION 'unscoped scratch DELETE reached the other scratch tenant';
  END IF;
END;
$$;
COMMIT;

-- Clock policy inherits the physical state's forced tenant RLS and exact privileges. The trusted
-- ready-scope resolver is deliberately unavailable to all external identity and read-only roles.
BEGIN;
SELECT pg_temp.act_as('tenant-a', 'principal-a');
DO $$
DECLARE role_name text; constraint_name text;
BEGIN
  -- The world's system principal, not a member: a member sorting first, then removed, changes nothing.
  PERFORM pg_temp.act_as('tenant-a', 'a-first-member');
  INSERT INTO clockgrove.tenant_principals (tenant_id, principal_id) VALUES ('tenant-a', 'a-first-member');
  IF clockgrove.resolve_ready_clock_principal('tenant-a', 'world-a', 'timeline-a', 'space-a')
       IS DISTINCT FROM 'system:world:world-a' THEN
    RAISE EXCEPTION 'ready scope did not reconstruct the world system principal';
  END IF;
  DELETE FROM clockgrove.tenant_principals WHERE principal_id = 'a-first-member';
  PERFORM pg_temp.act_as('tenant-a', 'principal-a');
  IF clockgrove.resolve_ready_clock_principal('tenant-a', 'world-a', 'timeline-a', 'space-a')
       IS DISTINCT FROM 'system:world:world-a' THEN
    RAISE EXCEPTION 'removing a member changed the autonomous principal';
  END IF;
  IF clockgrove.resolve_ready_clock_principal('tenant-a', 'world-b', 'timeline-a', 'space-a') IS NOT NULL
     OR clockgrove.resolve_ready_clock_principal('tenant-a', 'world-a', 'timeline-b', 'space-a') IS NOT NULL
     OR clockgrove.resolve_ready_clock_principal('tenant-a', 'world-a', 'timeline-a', 'space-b') IS NOT NULL
     OR clockgrove.resolve_ready_clock_principal('missing', 'world-a', 'timeline-a', 'space-a') IS NOT NULL THEN
    RAISE EXCEPTION 'autonomous principal escaped exact ready scope';
  END IF;
  FOREACH role_name IN ARRAY ARRAY['clockgrove_support', 'clockgrove_backup',
      'clockgrove_auth_verifier', 'clockgrove_management_reader', 'clockgrove_world_reader'] LOOP
    IF has_function_privilege(role_name,
      'clockgrove.resolve_ready_clock_principal(text,text,text,text)', 'EXECUTE') THEN
      RAISE EXCEPTION 'external role can resolve autonomous authority: %', role_name;
    END IF;
  END LOOP;
  BEGIN
    UPDATE clockgrove.partition_states SET clock_policy = '{}'::jsonb
      WHERE tenant_id = 'tenant-a';
    RAISE EXCEPTION 'clock policy allowed a noncanonical node';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS constraint_name = CONSTRAINT_NAME;
    IF constraint_name <> 'partition_states_clock_policy_node' THEN RAISE; END IF;
  END;
  UPDATE clockgrove.worlds SET lifecycle_status = 'archived'
    WHERE tenant_id = 'tenant-a' AND world_id = 'world-a';
  IF clockgrove.resolve_ready_clock_principal('tenant-a', 'world-a', 'timeline-a', 'space-a') IS NOT NULL THEN
    RAISE EXCEPTION 'archived world reconstructed autonomous authority';
  END IF;
END;
$$;
ROLLBACK;

-- Observer world directory (issue 808, 0032): no other principal's memberships leak. Only the world
-- reader may execute observable_world_scopes, so the runtime and every other external role, whatever
-- principal it installs, can list no principal's memberships, and the function returns the scope
-- columns only. Its row filter is exercised as the world reader in
-- apps/runtime/test/world-directory.journey.postgres.test.ts.
BEGIN;
SELECT pg_temp.act_as('tenant-b', 'principal-b');
DO $$
DECLARE role_name text;
BEGIN
  BEGIN
    PERFORM * FROM clockgrove.observable_world_scopes();
    RAISE EXCEPTION 'runtime listed a principal''s world memberships';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  FOREACH role_name IN ARRAY ARRAY['clockgrove_runtime', 'clockgrove_support', 'clockgrove_backup',
      'clockgrove_auth_verifier', 'clockgrove_management_reader'] LOOP
    IF has_function_privilege(role_name, 'clockgrove.observable_world_scopes()', 'EXECUTE') THEN
      RAISE EXCEPTION 'non-reader role can list world memberships: %', role_name;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('clockgrove_world_reader', 'clockgrove.observable_world_scopes()', 'EXECUTE')
     OR (SELECT proargnames FROM pg_proc WHERE oid = 'clockgrove.observable_world_scopes()'::regprocedure)
       IS DISTINCT FROM ARRAY['tenant_id', 'world_id', 'timeline_id', 'space_id'] THEN
    RAISE EXCEPTION 'world directory is not the reader''s scope-only read';
  END IF;
END;
$$;
ROLLBACK;

-- Inspector audit. The runtime role appends only through record_inspector_access, which
-- takes tenant and principal from the installed context. A tenant member may record an allow; a
-- non-member only a deny, under the tenant it asked for if that tenant exists. Without an installed principal, with an
-- invalid decision or reason, or with an oversized ID, nothing is recorded. The function returns
-- nothing, so it cannot read the table.
BEGIN;
DO $$
DECLARE
  attempt record;
BEGIN
  PERFORM pg_temp.act_as('tenant-a', 'principal-a');
  PERFORM clockgrove.record_inspector_access(
    'world-a', 'timeline-a', 'space-a', 'command-a', 'allow', 'served');
  PERFORM clockgrove.record_inspector_access(
    'world-a', 'timeline-a', 'space-a', 'command-b', 'deny', 'runtime-grant-missing');
  PERFORM pg_temp.act_as('tenant-b', 'principal-a');
  PERFORM clockgrove.record_inspector_access(
    'world-b', 'timeline-b', 'space-b', 'command-b', 'deny', 'world-participation-absent');
  -- A denial naming no stored tenant writes nothing and does not fail: the foreign key to tenants
  -- would refuse an insert, so returning here proves no row was attempted.
  PERFORM pg_temp.act_as('tenant-missing', 'principal-a');
  PERFORM clockgrove.record_inspector_access(
    'world-x', 'timeline-x', 'space-x', 'command-x', 'deny', 'world-participation-absent');
  FOR attempt IN
    SELECT * FROM (VALUES
      ('tenant-b', 'principal-a', 'allow', 'served', 'world-b', '42501'),
      ('tenant-missing', 'principal-a', 'allow', 'served', 'world-x', '42501'),
      ('tenant-a%', 'principal-b', 'allow', 'served', 'world-a', '42501'),
      ('tenant-a', '', 'deny', 'runtime-grant-missing', 'world-a', '42501'),
      ('', 'principal-a', 'deny', 'runtime-grant-missing', 'world-a', '42501'),
      ('tenant-a', 'principal-a', 'allow', 'runtime-grant-missing', 'world-a', '23514'),
      ('tenant-a', 'principal-a', 'deny', 'served', 'world-a', '23514'),
      ('tenant-a', 'principal-a', 'grant', 'served', 'world-a', '23514'),
      ('tenant-a', 'principal-a', 'allow', 'served', repeat('w', 1025), '23514'),
      ('tenant-a', 'principal-a', 'allow', 'served', '', '23514'),
      ('tenant-a', 'principal-a', NULL, 'served', 'world-a', '23514')
    ) AS attempts (tenant, principal, decision, reason, world, expected)
  LOOP
    PERFORM set_config('app.tenant_id', attempt.tenant, true);
    PERFORM set_config('app.principal_id', attempt.principal, true);
    BEGIN
      PERFORM clockgrove.record_inspector_access(
        attempt.world, 'timeline-a', 'space-a', 'command-a', attempt.decision, attempt.reason);
      RAISE EXCEPTION 'inspector access was recorded: %', attempt::text USING ERRCODE = 'XX999';
    EXCEPTION
      WHEN insufficient_privilege OR check_violation OR not_null_violation THEN
        IF SQLSTATE <> attempt.expected
           AND NOT (attempt.expected = '23514' AND SQLSTATE = '23502') THEN
          RAISE EXCEPTION 'inspector access % refused with %', attempt::text, SQLSTATE;
        END IF;
    END;
  END LOOP;
  PERFORM pg_temp.act_as('tenant-a', 'principal-a');
  -- Rate limit: 300 accesses per principal per tenant an hour (the seed row and the two above
  -- count). Over it, an allow fails with CG013; a denial still returns without error.
  FOR attempt IN SELECT generate_series(1, 296) LOOP
    PERFORM clockgrove.record_inspector_access(
      'world-a', 'timeline-a', 'space-a', 'command-a', 'allow', 'served');
  END LOOP;
  IF NOT clockgrove.inspector_access_admitted() THEN
    RAISE EXCEPTION 'inspector access refused under the limit';
  END IF;
  PERFORM clockgrove.record_inspector_access(
    'world-a', 'timeline-a', 'space-a', 'command-a', 'allow', 'served');
  IF clockgrove.inspector_access_admitted() THEN
    RAISE EXCEPTION 'inspector access admitted over the limit';
  END IF;
  BEGIN
    PERFORM clockgrove.record_inspector_access(
      'world-a', 'timeline-a', 'space-a', 'command-a', 'allow', 'served');
    RAISE EXCEPTION 'inspector allow recorded over the limit' USING ERRCODE = 'XX999';
  EXCEPTION WHEN SQLSTATE 'CG013' THEN NULL;
  END;
  -- An over-limit denial attempts no insert: an oversized ID would fail the table's CHECK if it did.
  PERFORM clockgrove.record_inspector_access(
    repeat('w', 1025), 'timeline-a', 'space-a', 'command-a', 'deny', 'runtime-grant-missing');
END;
$$;
ROLLBACK;

-- Operator actions. The audit takes tenant and principal from the installed context only, as
-- the inspector audit does. Publication repair reaches only a failed world-reactions row of the
-- installed member's own tenant and named scope, and needs a tenant member.
BEGIN;
DO $$
DECLARE
  attempt record;
BEGIN
  PERFORM pg_temp.act_as('tenant-a', 'principal-a');
  PERFORM clockgrove.record_runtime_operator_action(
    'world-a', 'timeline-a', 'space-a', 'replay-message', 'message-a', 'allow', 'replayed');
  PERFORM pg_temp.act_as('tenant-b', 'principal-a');
  PERFORM clockgrove.record_runtime_operator_action(
    'world-b', 'timeline-b', 'space-b', 'replay-message', 'message-b', 'deny',
    'world-participation-absent');
  FOR attempt IN
    SELECT * FROM (VALUES
      ('tenant-b', 'principal-a', 'allow', 'replayed', 'replay-message', '42501'),
      ('tenant-a', '', 'deny', 'runtime-grant-missing', 'replay-message', '42501'),
      ('tenant-a', 'principal-a', 'allow', 'runtime-grant-missing', 'replay-message', '23514'),
      ('tenant-a', 'principal-a', 'deny', 'replayed', 'replay-message', '23514'),
      ('tenant-a', 'principal-a', 'allow', 'replayed', 'delete-message', '23514')
    ) AS attempts (tenant, principal, decision, reason, action, expected)
  LOOP
    PERFORM set_config('app.tenant_id', attempt.tenant, true);
    PERFORM set_config('app.principal_id', attempt.principal, true);
    BEGIN
      PERFORM clockgrove.record_runtime_operator_action(
        'world-a', 'timeline-a', 'space-a', attempt.action, 'message-a', attempt.decision,
        attempt.reason);
      RAISE EXCEPTION 'operator action was recorded: %', attempt::text USING ERRCODE = 'XX999';
    EXCEPTION WHEN insufficient_privilege OR check_violation THEN
      IF SQLSTATE <> attempt.expected THEN
        RAISE EXCEPTION 'operator action % refused with %', attempt::text, SQLSTATE;
      END IF;
    END;
  END LOOP;
  PERFORM pg_temp.act_as('tenant-b', 'principal-b');
  INSERT INTO clockgrove.event_dispatches (
    tenant_id, world_id, timeline_id, partition_id, space_id, dispatch_id, event_id, channel,
    status, privacy_class, payload, attempts, last_error_class, settled_at
  ) VALUES ('tenant-b', 'world-b', 'timeline-b', 'partition-b', 'space-b', 'repair-b',
    'event-b-public', 'world-reactions', 'failed', 'public_scene', '{}', 4, 'retryable',
    statement_timestamp());
  PERFORM pg_temp.act_as('tenant-a', 'principal-a');
  IF clockgrove.repair_world_reaction_publication('world-b', 'timeline-b', 'space-b', 'repair-b')
     <> 'not-found' THEN
    RAISE EXCEPTION 'a member repaired another tenant''s publication';
  END IF;
  PERFORM pg_temp.act_as('tenant-b', 'principal-a');
  BEGIN
    PERFORM clockgrove.repair_world_reaction_publication(
      'world-b', 'timeline-b', 'space-b', 'repair-b');
    RAISE EXCEPTION 'a non-member repaired a publication' USING ERRCODE = 'XX999';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  PERFORM pg_temp.act_as('tenant-b', 'principal-b');
  IF clockgrove.repair_world_reaction_publication('world-b', 'timeline-b', 'space-a', 'repair-b')
     <> 'not-found'
     OR clockgrove.repair_world_reaction_publication('world-b', 'timeline-b', 'space-b', 'repair-b')
     <> 'repaired'
     OR clockgrove.repair_world_reaction_publication('world-b', 'timeline-b', 'space-b', 'repair-b')
     <> 'not-failed' THEN
    RAISE EXCEPTION 'publication repair crossed its scope or repaired twice';
  END IF;
  IF (SELECT status || '|' || attempts || '|' || (settled_at IS NULL)
        FROM clockgrove.event_dispatches WHERE dispatch_id = 'repair-b') <> 'pending|4|true' THEN
    RAISE EXCEPTION 'publication repair changed more than its status and lease';
  END IF;
END;
$$;
ROLLBACK;

-- Queue disposition lives on the existing event_dispatches attack surface: no new RLS table.
-- A public single-event source batch provides the independent committed identity below. A second
-- source batch mixes public/private events: even the system principal cannot consume it as public.
BEGIN;
DO $$
DECLARE
  envelope jsonb := '{"schemaVersion":2,"messageId":"command-b:dispatch:world-reactions","channel":"world-reactions","tenantId":"tenant-b","worldId":"world-b","timelineId":"timeline-b","sourceEventId":"event-b-public","correlationId":"correlation-b","attemptHint":1,"payload":{"eventId":"event-b-public","eventCount":1}}';
  change jsonb;
  consumed timestamptz;
BEGIN
  PERFORM pg_temp.act_as('tenant-b', 'principal-b');
  INSERT INTO clockgrove.event_dispatches (
    tenant_id, world_id, timeline_id, partition_id, space_id, dispatch_id, event_id,
    channel, status, privacy_class, payload
  ) VALUES ('tenant-b', 'world-b', 'timeline-b', 'partition-b', 'space-b',
    'command-b:dispatch:world-reactions', 'event-b-public', 'world-reactions', 'pending',
    'public_scene', '{"eventId":"event-b-public","eventCount":1}');
  IF clockgrove.consume_world_reaction(envelope) <> 'invalid' THEN
    RAISE EXCEPTION 'a tenant member acquired background consumption authority';
  END IF;
  BEGIN
    INSERT INTO clockgrove.event_dispatches (
      tenant_id, world_id, timeline_id, partition_id, space_id, dispatch_id, event_id,
      channel, status, privacy_class, payload, consumed_at, consumed_principal_id
    ) VALUES ('tenant-b', 'world-b', 'timeline-b', 'partition-b', 'space-b',
      'forged-consumption', 'event-b-public', 'world-reactions', 'pending',
      'public_scene', '{}', statement_timestamp(), 'principal-b');
    RAISE EXCEPTION 'caller inserted an unverified successful disposition' USING ERRCODE = 'XX999';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLSTATE <> '42501' THEN RAISE; END IF;
  END;
  PERFORM pg_temp.act_as('tenant-a', 'system:world:world-a');
  IF clockgrove.consume_world_reaction(envelope) <> 'invalid' THEN
    RAISE EXCEPTION 'background consumer crossed tenant isolation';
  END IF;
  PERFORM pg_temp.act_as('tenant-b', 'principal-b');
  INSERT INTO clockgrove.worlds (tenant_id, world_id, lifecycle_status)
    VALUES ('tenant-b', 'world-b-other', 'ready');
  PERFORM pg_temp.act_as('tenant-b', 'system:world:world-b');
  IF (SELECT count(*) FROM clockgrove.claim_dispatches('world-reactions', 1, 'owner-b', 0)) <> 1 THEN
    RAISE EXCEPTION 'canonical system principal did not claim its dispatch';
  END IF;
  PERFORM pg_temp.act_as('tenant-b', 'system:world:world-b-other');
  IF clockgrove.consume_world_reaction(envelope) <> 'invalid'
     OR (SELECT count(*) FROM clockgrove.claim_dispatches('world-reactions', 1, 'wrong-world', 0)) <> 0
     OR clockgrove.settle_dispatch('command-b:dispatch:world-reactions', 1, 'delivered', NULL, NULL) THEN
    RAISE EXCEPTION 'same-tenant other-world system acquired dispatch authority';
  END IF;
  PERFORM pg_temp.act_as('tenant-b', 'system:world:world-b',
    '{"version":1,"allowedCategories":["conversation"]}');
  IF clockgrove.consume_world_reaction(envelope) <> 'invalid' THEN
    RAISE EXCEPTION 'background consumer exceeded its installed privacy ceiling';
  END IF;
  PERFORM pg_temp.act_as('tenant-b', 'system:world:world-b',
    '{"version":1,"allowedCategories":["public_scene"]}');
  FOR change IN SELECT value FROM jsonb_array_elements('[
    {"tenantId":"tenant-a"}, {"worldId":"world-a"}, {"timelineId":"timeline-a"},
    {"sourceEventId":"event-a-public"}, {"messageId":"missing"},
    {"channel":"external-effects"}, {"correlationId":"wrong"},
    {"payload":{"eventId":"event-b-public","eventCount":2}}, {"schemaVersion":1},
    {"effectId":"not-a-world-reaction"}
  ]') LOOP
    IF clockgrove.consume_world_reaction(envelope || change) <> 'invalid' THEN
      RAISE EXCEPTION 'consumer accepted changed canonical envelope: %', change;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM clockgrove.event_dispatches WHERE consumed_at IS NOT NULL) <> 0 THEN
    RAISE EXCEPTION 'invalid input recorded successful consumption';
  END IF;
  IF clockgrove.consume_world_reaction(envelope) <> 'consumed' THEN
    RAISE EXCEPTION 'canonical committed batch was not consumed';
  END IF;
  SELECT consumed_at INTO consumed FROM clockgrove.event_dispatches
   WHERE dispatch_id = 'command-b:dispatch:world-reactions';
  IF clockgrove.consume_world_reaction(envelope || '{"attemptHint":100}') <> 'duplicate' THEN
    RAISE EXCEPTION 'transport attempt count repeated semantic consumption';
  END IF;
  IF (SELECT count(*) FROM clockgrove.event_dispatches
       WHERE consumed_at = consumed AND consumed_principal_id = 'system:world:world-b') <> 1 THEN
    RAISE EXCEPTION 'consumption identity or timestamp changed on redelivery';
  END IF;
  PERFORM pg_temp.act_as('tenant-a', 'principal-a');
  INSERT INTO clockgrove.event_dispatches (
    tenant_id, world_id, timeline_id, partition_id, space_id, dispatch_id, event_id,
    channel, status, privacy_class, payload
  ) VALUES ('tenant-a', 'world-a', 'timeline-a', 'partition-a', 'space-a',
    'command-a:dispatch:world-reactions', 'event-a-public', 'world-reactions', 'pending',
    'public_scene', '{"eventId":"event-a-public","eventCount":2}');
  PERFORM pg_temp.act_as('tenant-a', 'system:world:world-a');
  IF clockgrove.consume_world_reaction('{"schemaVersion":2,"messageId":"command-a:dispatch:world-reactions","channel":"world-reactions","tenantId":"tenant-a","worldId":"world-a","timelineId":"timeline-a","sourceEventId":"event-a-public","correlationId":"correlation-a","attemptHint":1,"payload":{"eventId":"event-a-public","eventCount":2}}') <> 'invalid' THEN
    RAISE EXCEPTION 'consumer accepted a batch containing a private event';
  END IF;
END;
$$;
ROLLBACK;

-- The canonical payload declares both actual public events while the immutable receipt names
-- only its original event. This isolates completeness from payload, scope and privacy checks.
BEGIN;
SELECT pg_temp.act_as('tenant-b', 'principal-b');
-- Independently stage a pending receipt with a complete event list; no committed disposition exists.
INSERT INTO clockgrove.command_receipts
  SELECT (jsonb_populate_record(NULL::clockgrove.command_receipts, to_jsonb(receipt) ||
    '{"command_id":"command-b-pending","status":"pending","authority_decision_id":null,"committed_at":null,"canonical_event_ids":["event-b-pending"]}'::jsonb)).*
  FROM clockgrove.command_receipts AS receipt
  WHERE tenant_id = 'tenant-b' AND command_id = 'command-b';
INSERT INTO clockgrove.events OVERRIDING USER VALUE
  SELECT (jsonb_populate_record(NULL::clockgrove.events, to_jsonb(event) ||
    jsonb_build_object('event_id', source.event_id, 'command_id', source.command_id,
      'stream_sequence', source.sequence, 'partition_sequence', source.sequence))).*
  FROM clockgrove.events AS event CROSS JOIN (VALUES
    ('event-b-extra', 'command-b', 99), ('event-b-pending', 'command-b-pending', 100)
  ) AS source(event_id, command_id, sequence)
  WHERE tenant_id = 'tenant-b' AND event.event_id = 'event-b-public';
INSERT INTO clockgrove.event_dispatches (
  tenant_id, world_id, timeline_id, partition_id, space_id, dispatch_id, event_id,
  channel, status, privacy_class, payload
) VALUES ('tenant-b', 'world-b', 'timeline-b', 'partition-b', 'space-b',
  'command-b:dispatch:world-reactions', 'event-b-public', 'world-reactions', 'pending',
  'public_scene', '{"eventId":"event-b-public","eventCount":2}'),
  ('tenant-b', 'world-b', 'timeline-b', 'partition-b', 'space-b',
  'command-b-pending:dispatch:world-reactions', 'event-b-pending', 'world-reactions', 'pending',
  'public_scene', '{"eventId":"event-b-pending","eventCount":1}');
SELECT pg_temp.act_as('tenant-b', 'system:world:world-b');
DO $$
BEGIN
  IF clockgrove.consume_world_reaction('{"schemaVersion":2,"messageId":"command-b:dispatch:world-reactions","channel":"world-reactions","tenantId":"tenant-b","worldId":"world-b","timelineId":"timeline-b","sourceEventId":"event-b-public","correlationId":"correlation-b","attemptHint":1,"payload":{"eventId":"event-b-public","eventCount":2}}') <> 'invalid'
     OR (SELECT count(*) FROM clockgrove.event_dispatches WHERE consumed_at IS NOT NULL) <> 0 THEN
    RAISE EXCEPTION 'incomplete committed receipt recorded successful consumption';
  END IF;
  IF clockgrove.consume_world_reaction('{"schemaVersion":2,"messageId":"command-b-pending:dispatch:world-reactions","channel":"world-reactions","tenantId":"tenant-b","worldId":"world-b","timelineId":"timeline-b","sourceEventId":"event-b-pending","correlationId":"correlation-b","attemptHint":1,"payload":{"eventId":"event-b-pending","eventCount":1}}') <> 'invalid'
     OR (SELECT count(*) FROM clockgrove.event_dispatches WHERE consumed_at IS NOT NULL) <> 0 THEN
    RAISE EXCEPTION 'pending source receipt recorded successful consumption';
  END IF;
END;
$$;
ROLLBACK;
DO $$
BEGIN
  IF clockgrove.runtime_tenant_id() IS NOT NULL OR clockgrove.runtime_principal_id() IS NOT NULL
     OR clockgrove.privacy_allows('public_scene') THEN
    RAISE EXCEPTION 'background transaction leaked tenant, principal or privacy authority';
  END IF;
END;
$$;

-- Catch-up linkage belongs to the exact physical owner/system principal. Tenant membership
-- cannot install or replace autonomous intent. Reads require the complete accepted scope/run key.
BEGIN;
SELECT pg_temp.act_as('tenant-a', 'principal-a');
DO $$
BEGIN
  BEGIN
    UPDATE clockgrove.partition_states SET catch_up_run_id = 'catch-up-a',
      catch_up_owner_generation = clock_owner_generation, catch_up_policy_version = 0,
      catch_up_wall_time = 1, catch_up_step = 0 WHERE world_id = 'world-a';
    RAISE EXCEPTION 'ordinary member installed catch-up intent';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  PERFORM pg_temp.act_as('tenant-a', 'system:world:world-a');
  UPDATE clockgrove.partition_states SET catch_up_run_id = 'catch-up-a',
    catch_up_owner_generation = clock_owner_generation, catch_up_policy_version = 0,
    catch_up_wall_time = 1, catch_up_step = 0 WHERE world_id = 'world-a';
  IF (SELECT count(*) FROM clockgrove.read_catch_up_operation(
      'tenant-a', 'world-a', 'timeline-a', 'space-a', 'catch-up-a')) <> 1 THEN
    RAISE EXCEPTION 'accepted catch-up scope did not resolve exactly one operation';
  END IF;
  IF (SELECT count(*) FROM clockgrove.read_catch_up_operation(
      'tenant-b', 'world-a', 'timeline-a', 'space-a', 'catch-up-a')) <> 0
    OR (SELECT count(*) FROM clockgrove.read_catch_up_operation(
      'tenant-a', 'world-b', 'timeline-a', 'space-a', 'catch-up-a')) <> 0
    OR (SELECT count(*) FROM clockgrove.read_catch_up_operation(
      'tenant-a', 'world-a', 'timeline-b', 'space-a', 'catch-up-a')) <> 0
    OR (SELECT count(*) FROM clockgrove.read_catch_up_operation(
      'tenant-a', 'world-a', 'timeline-a', 'space-b', 'catch-up-a')) <> 0
    OR (SELECT count(*) FROM clockgrove.read_catch_up_operation(
      'tenant-a', 'world-a', 'timeline-a', 'space-a', 'other-run')) <> 0 THEN
    RAISE EXCEPTION 'catch-up reference escaped tenant/world/timeline/space/run identity';
  END IF;
  PERFORM pg_temp.act_as('tenant-b', 'principal-b');
  IF (SELECT count(*) FROM clockgrove.read_catch_up_operation(
      'tenant-a', 'world-a', 'timeline-a', 'space-a', 'catch-up-a')) <> 0 THEN
    RAISE EXCEPTION 'installed tenant read foreign accepted catch-up linkage';
  END IF;
  PERFORM pg_temp.act_as('tenant-a', 'system:world:world-a');
  BEGIN
    UPDATE clockgrove.partition_states SET catch_up_owner_generation = clock_owner_generation + 1
      WHERE world_id = 'world-a';
    RAISE EXCEPTION 'catch-up accepted a non-owner generation';
  EXCEPTION WHEN SQLSTATE 'CG006' THEN NULL;
  END;
  PERFORM pg_temp.act_as('tenant-a', 'principal-a');
  BEGIN
    UPDATE clockgrove.partition_states SET catch_up_step = 1 WHERE world_id = 'world-a';
    RAISE EXCEPTION 'member advanced autonomous operation';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  UPDATE clockgrove.partition_states SET clock_policy = '["record", []]'::jsonb
    WHERE world_id = 'world-a';
  IF (SELECT count(*) FROM clockgrove.partition_states WHERE world_id = 'world-a'
      AND catch_up_run_id IS NULL AND catch_up_owner_generation IS NULL
      AND catch_up_policy_version IS NULL AND catch_up_wall_time IS NULL
      AND catch_up_step IS NULL AND catch_up_reconcile_attempted_at IS NULL) <> 1 THEN
    RAISE EXCEPTION 'clock policy supersession retained operational linkage';
  END IF;
END;
$$;
ROLLBACK;

-- Conversations (0034): a session, its participant set, its messages and its turn are its
-- participants' alone. Another member of the same tenant and world, a narrower ceiling and another
-- tenant see and change nothing, and cannot join the session; participants, messages and turns
-- never change; text is only a conversation-class artifact; deleted is terminal; a participant
-- opens at most 100 live sessions per world timeline.
BEGIN;
SELECT pg_temp.act_as('tenant-a', 'principal-a');
INSERT INTO clockgrove.artifact_data_keys (
  tenant_id, world_id, privacy_class, key_version, kek_id, wrapped_key
) VALUES ('tenant-a', 'world-a', 'conversation', 1, 'kek-test', decode(repeat('c1', 61), 'hex'));
INSERT INTO clockgrove.artifact_references (
  tenant_id, world_id, timeline_id, partition_id, space_id, artifact_id, content_hash, media_type,
  inline_content, byte_length, privacy_class, retention_class, encryption, data_key_version
) SELECT 'tenant-a', 'world-a', 'timeline-a', 'partition-a', 'space-a', artifact_id,
         'sha256:' || encode(sha256(bytes), 'hex'), 'text/plain;charset=utf-8', bytes,
         octet_length(bytes), 'conversation', 'durable', 'aes-256-gcm-v1', 1
    FROM (VALUES ('conversation-text-1', decode('01' || repeat('c2', 40), 'hex')),
                 ('conversation-text-2', decode('01' || repeat('c3', 40), 'hex')))
      AS sealed (artifact_id, bytes);
-- A session without its participant is refused by the policy.
DO $$
BEGIN
  INSERT INTO clockgrove.conversation_sessions (
    tenant_id, session_id, world_id, timeline_id, partition_id, space_id, actor_id, voice_mode
  ) VALUES ('tenant-a', 'session-orphan', 'world-a', 'timeline-a', 'partition-a', 'space-a',
            'stevie', 'cognitive');
  RAISE EXCEPTION 'session opened without a participant' USING ERRCODE = 'XX999';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END;
$$;
INSERT INTO clockgrove.conversation_participants (tenant_id, session_id, principal_id, persona_id)
  VALUES ('tenant-a', 'session-a', 'principal-a', 'persona-a');
INSERT INTO clockgrove.conversation_sessions (
  tenant_id, session_id, world_id, timeline_id, partition_id, space_id, actor_id, voice_mode
) VALUES ('tenant-a', 'session-a', 'world-a', 'timeline-a', 'partition-a', 'space-a', 'stevie',
          'cognitive');
INSERT INTO clockgrove.conversation_messages (
  tenant_id, session_id, principal_id, sequence, message_id, role, author_id, voice_mode,
  content_artifact_id
) VALUES
  ('tenant-a', 'session-a', 'principal-a', 1, 'message-1', 'caretaker', 'persona-a', NULL,
   'conversation-text-1'),
  ('tenant-a', 'session-a', NULL, 2, 'message-1:reply', 'actor', 'stevie', 'cognitive',
   'conversation-text-2');
INSERT INTO clockgrove.conversation_turns (
  tenant_id, session_id, principal_id, turn, input_sequence, output_sequence, model, state
) VALUES ('tenant-a', 'session-a', 'principal-a', 1, 1, 2, 'scripted-fixture-v1', 'completed');
UPDATE clockgrove.conversation_sessions SET message_count = 2 WHERE session_id = 'session-a';
DO $$
DECLARE
  context record;
  affected bigint;
  i integer;
BEGIN
  IF (SELECT count(*) FROM clockgrove.conversation_sessions) <> 1
     OR (SELECT count(*) FROM clockgrove.conversation_participants) <> 1
     OR (SELECT count(*) FROM clockgrove.conversation_messages) <> 2
     OR (SELECT count(*) FROM clockgrove.conversation_turns) <> 1 THEN
    RAISE EXCEPTION 'participant does not see their own conversation';
  END IF;
  FOR context IN
    SELECT * FROM (VALUES
      ('tenant-a', 'principal-a2', '{"version":1,"allowedCategories":["public_scene","conversation"]}'),
      ('tenant-a', 'principal-a', '{"version":1,"allowedCategories":["public_scene"]}'),
      ('tenant-b', 'principal-b', '{"version":1,"allowedCategories":["public_scene","conversation"]}'),
      ('tenant-a%', 'principal-a', '{"version":1,"allowedCategories":["conversation"]}')
    ) AS contexts (tenant_id, principal_id, ceiling)
  LOOP
    PERFORM pg_temp.act_as(context.tenant_id, context.principal_id, context.ceiling);
    PERFORM set_config('attack.seen', '', true);
    IF (SELECT count(*) FROM clockgrove.conversation_sessions WHERE pg_temp.leak(session_id)) <> 0
       OR (SELECT count(*) FROM clockgrove.conversation_participants
            WHERE pg_temp.leak(session_id)) <> 0
       OR (SELECT count(*) FROM clockgrove.conversation_messages WHERE pg_temp.leak(message_id)) <> 0
       OR (SELECT count(*) FROM clockgrove.conversation_turns WHERE pg_temp.leak(session_id)) <> 0
       OR current_setting('attack.seen', true) LIKE '%session-a%'
       OR current_setting('attack.seen', true) LIKE '%message-1%' THEN
      RAISE EXCEPTION 'conversation leaked to %', context::text;
    END IF;
    UPDATE clockgrove.conversation_sessions SET state = 'deleted' WHERE session_id = 'session-a';
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 0 THEN
      RAISE EXCEPTION 'conversation changed by %', context::text;
    END IF;
    BEGIN
      INSERT INTO clockgrove.conversation_messages (
        tenant_id, session_id, principal_id, sequence, message_id, role, author_id, voice_mode,
        content_artifact_id
      ) VALUES ('tenant-a', 'session-a', 'principal-a', 3, 'forged', 'caretaker', 'persona-a',
                NULL, 'conversation-text-1');
      RAISE EXCEPTION 'message forged into a foreign conversation by %', context::text
        USING ERRCODE = 'XX999';
    EXCEPTION WHEN insufficient_privilege OR foreign_key_violation THEN NULL;
    END;
    BEGIN
      INSERT INTO clockgrove.conversation_messages (
        tenant_id, session_id, principal_id, sequence, message_id, role, author_id, voice_mode,
        content_artifact_id
      ) VALUES ('tenant-a', 'session-a', NULL, 3, 'forged:reply', 'actor', 'stevie', 'cognitive',
                'conversation-text-2');
      RAISE EXCEPTION 'answer forged into a foreign conversation by %', context::text
        USING ERRCODE = 'XX999';
    EXCEPTION WHEN insufficient_privilege OR foreign_key_violation THEN NULL;
    END;
    BEGIN
      INSERT INTO clockgrove.conversation_participants (
        tenant_id, session_id, principal_id, persona_id
      ) VALUES ('tenant-a', 'session-forged', 'principal-a', 'persona-a');
      RAISE EXCEPTION 'participant forged for another principal by %', context::text
        USING ERRCODE = 'XX999';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    -- Joining the existing session as oneself is refused too.
    BEGIN
      INSERT INTO clockgrove.conversation_participants (
        tenant_id, session_id, principal_id, persona_id
      ) VALUES ('tenant-a', 'session-a', context.principal_id, 'persona-intruder');
      RAISE EXCEPTION 'foreign conversation joined by %', context::text USING ERRCODE = 'XX999';
    EXCEPTION WHEN insufficient_privilege OR SQLSTATE 'CG020' THEN NULL;
    END;
  END LOOP;

  PERFORM pg_temp.act_as('tenant-a', 'principal-a');
  BEGIN
    UPDATE clockgrove.conversation_messages SET author_id = 'someone' WHERE sequence = 1;
    RAISE EXCEPTION 'conversation message changed' USING ERRCODE = 'XX999';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM clockgrove.conversation_turns;
    RAISE EXCEPTION 'conversation turn deleted' USING ERRCODE = 'XX999';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM clockgrove.conversation_sessions;
    RAISE EXCEPTION 'conversation session deleted' USING ERRCODE = 'XX999';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE clockgrove.conversation_participants SET principal_id = 'principal-a2';
    RAISE EXCEPTION 'conversation moved to another participant' USING ERRCODE = 'XX999';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM clockgrove.conversation_participants;
    RAISE EXCEPTION 'conversation participant removed' USING ERRCODE = 'XX999';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  -- A Caretaker message is authored by its participant under their persona, never another's.
  BEGIN
    INSERT INTO clockgrove.conversation_messages (
      tenant_id, session_id, principal_id, sequence, message_id, role, author_id, voice_mode,
      content_artifact_id
    ) VALUES ('tenant-a', 'session-a', 'principal-a', 3, 'message-2', 'caretaker', 'persona-other',
              NULL, 'conversation-text-1');
    RAISE EXCEPTION 'conversation message attributed to a non-participant' USING ERRCODE = 'XX999';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  -- Text is only a conversation-class artifact: an operator-evidence artifact is refused.
  BEGIN
    INSERT INTO clockgrove.conversation_messages (
      tenant_id, session_id, principal_id, sequence, message_id, role, author_id, voice_mode,
      content_artifact_id
    ) VALUES ('tenant-a', 'session-a', 'principal-a', 3, 'message-2', 'caretaker', 'persona-a',
              NULL, 'artifact-a-private');
    RAISE EXCEPTION 'conversation text stored outside the conversation class' USING ERRCODE = 'XX999';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  BEGIN
    UPDATE clockgrove.conversation_sessions SET message_count = 0;
    RAISE EXCEPTION 'conversation history shrank' USING ERRCODE = 'XX999';
  EXCEPTION WHEN SQLSTATE 'CG020' THEN NULL;
  END;
  UPDATE clockgrove.conversation_sessions SET state = 'deleted';
  BEGIN
    UPDATE clockgrove.conversation_sessions SET state = 'active';
    RAISE EXCEPTION 'deleted conversation restored' USING ERRCODE = 'XX999';
  EXCEPTION WHEN SQLSTATE 'CG020' THEN NULL;
  END;
  -- The deleted session no longer counts: 100 live sessions are admitted, the 101st is refused.
  FOR i IN 1..101 LOOP
    INSERT INTO clockgrove.conversation_participants (
      tenant_id, session_id, principal_id, persona_id
    ) VALUES ('tenant-a', 'session-' || i, 'principal-a', 'persona-a');
  END LOOP;
  FOR i IN 1..100 LOOP
    INSERT INTO clockgrove.conversation_sessions (
      tenant_id, session_id, world_id, timeline_id, partition_id, space_id, actor_id, voice_mode
    ) VALUES ('tenant-a', 'session-' || i, 'world-a', 'timeline-a', 'partition-a', 'space-a',
              'stevie', 'cognitive');
  END LOOP;
  BEGIN
    INSERT INTO clockgrove.conversation_sessions (
      tenant_id, session_id, world_id, timeline_id, partition_id, space_id, actor_id, voice_mode
    ) VALUES ('tenant-a', 'session-101', 'world-a', 'timeline-a', 'partition-a', 'space-a',
              'stevie', 'cognitive');
    RAISE EXCEPTION 'conversation session limit not enforced' USING ERRCODE = 'XX999';
  EXCEPTION WHEN SQLSTATE 'CG021' THEN NULL;
  END;
END;
$$;
ROLLBACK;

-- Runs and steps (0036): the participant writes the runs of their own session as themselves; an
-- inspector whose ceiling holds operator_evidence reads them but writes nothing; everyone else sees
-- nothing. The guards admit one terminal disposition, in order, and refuse deletion.
BEGIN;
SELECT pg_temp.act_as('tenant-a', 'principal-a2');
INSERT INTO clockgrove.tenant_principals (tenant_id, principal_id) VALUES ('tenant-a', 'principal-a2');
SELECT pg_temp.act_as('tenant-a', 'principal-a');
INSERT INTO clockgrove.conversation_participants (tenant_id, session_id, principal_id, persona_id)
  VALUES ('tenant-a', 'session-r', 'principal-a', 'persona-a');
INSERT INTO clockgrove.conversation_sessions (
  tenant_id, session_id, world_id, timeline_id, partition_id, space_id, actor_id, voice_mode
) VALUES ('tenant-a', 'session-r', 'world-a', 'timeline-a', 'partition-a', 'space-a', 'stevie',
          'cognitive');
CREATE FUNCTION pg_temp.new_run(run text, root text, parent text, parent_step integer, st text)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO clockgrove.agent_runs (
    tenant_id, run_id, world_id, timeline_id, partition_id, space_id, session_id, actor_id,
    principal_id, persona_id, activation, input_message_id, parent_run_id, parent_step, root_run_id,
    model, prompt_version, input_revision, status, summary
  ) VALUES ('tenant-a', run, 'world-a', 'timeline-a', 'partition-a', 'space-a', 'session-r', 'stevie',
            'principal-a', 'persona-a', 'conversation_message', 'message-r', parent, parent_step,
            root, 'scripted-fixture-v1', 'v1', 0, st, 'attempt')
$$;
CREATE FUNCTION pg_temp.new_step(run text, n integer) RETURNS void LANGUAGE sql AS $$
  INSERT INTO clockgrove.run_steps (tenant_id, run_id, session_id, step, kind, summary)
  VALUES ('tenant-a', run, 'session-r', n, 'model_attempt', 'step')
$$;
SELECT pg_temp.new_run('run-1', 'run-1', NULL, NULL, 'running');
SELECT pg_temp.new_step('run-1', 1);
DO $$
DECLARE
  context record;
  affected bigint;
BEGIN
  IF (SELECT count(*) FROM clockgrove.agent_runs) <> 1 OR (SELECT count(*) FROM clockgrove.run_steps) <> 1 THEN
    RAISE EXCEPTION 'participant does not see their own run';
  END IF;
  FOR context IN
    SELECT * FROM (VALUES
      ('tenant-a', 'principal-a2', '{"version":1,"allowedCategories":["public_scene","conversation"]}', 0),
      ('tenant-b', 'principal-b', '{"version":1,"allowedCategories":["public_scene","conversation","operator_evidence"]}', 0),
      ('tenant-a', 'principal-a2', '{"version":1,"allowedCategories":["public_scene","operator_evidence"]}', 1)
    ) AS contexts (tenant_id, principal_id, ceiling, visible)
  LOOP
    PERFORM pg_temp.act_as(context.tenant_id, context.principal_id, context.ceiling);
    IF (SELECT count(*) FROM clockgrove.agent_runs) <> context.visible
       OR (SELECT count(*) FROM clockgrove.run_steps) <> context.visible THEN
      RAISE EXCEPTION 'runs visible wrongly to %', context::text;
    END IF;
    BEGIN
      PERFORM pg_temp.new_run('run-forged', 'run-forged', NULL, NULL, 'running');
      RAISE EXCEPTION 'run forged by %', context::text USING ERRCODE = 'XX999';
    EXCEPTION WHEN insufficient_privilege OR foreign_key_violation THEN NULL;
    END;
    BEGIN
      PERFORM pg_temp.new_step('run-1', 2);
      RAISE EXCEPTION 'step forged by %', context::text USING ERRCODE = 'XX999';
    EXCEPTION WHEN insufficient_privilege OR foreign_key_violation THEN NULL;
    END;
    UPDATE clockgrove.agent_runs SET status = 'failed', outcome_code = 'forged';
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 0 THEN
      RAISE EXCEPTION 'run closed by %', context::text;
    END IF;
    UPDATE clockgrove.run_steps SET status = 'failed', outcome_code = 'forged';
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 0 THEN
      RAISE EXCEPTION 'step closed by %', context::text;
    END IF;
  END LOOP;

  PERFORM pg_temp.act_as('tenant-a', 'principal-a');
  BEGIN
    PERFORM pg_temp.new_run('run-x', 'run-x', NULL, NULL, 'completed');
    RAISE EXCEPTION 'run started finished' USING ERRCODE = 'XX999';
  EXCEPTION WHEN SQLSTATE 'CG020' THEN NULL;
  END;
  BEGIN
    PERFORM pg_temp.new_run('run-x', 'run-1', NULL, NULL, 'running');
    RAISE EXCEPTION 'root-less run with a foreign root' USING ERRCODE = 'XX999';
  EXCEPTION WHEN SQLSTATE 'CG020' THEN NULL;
  END;
  BEGIN
    PERFORM pg_temp.new_step('run-1', 3);
    RAISE EXCEPTION 'steps numbered out of order' USING ERRCODE = 'XX999';
  EXCEPTION WHEN SQLSTATE 'CG020' THEN NULL;
  END;
  BEGIN
    UPDATE clockgrove.agent_runs SET status = 'completed', turn = 1 WHERE run_id = 'run-1';
    RAISE EXCEPTION 'run completed with a running step' USING ERRCODE = 'XX999';
  EXCEPTION WHEN SQLSTATE 'CG020' THEN NULL;
  END;
  -- A child run shares its parent's root and session.
  PERFORM pg_temp.new_run('run-2', 'run-1', 'run-1', 1, 'running');
  BEGIN
    PERFORM pg_temp.new_run('run-3', 'run-3', 'run-1', 1, 'running');
    RAISE EXCEPTION 'child run with another root' USING ERRCODE = 'XX999';
  EXCEPTION WHEN SQLSTATE 'CG020' THEN NULL;
  END;
  BEGIN
    DELETE FROM clockgrove.run_steps;
    RAISE EXCEPTION 'step deleted' USING ERRCODE = 'XX999';
  EXCEPTION WHEN insufficient_privilege OR SQLSTATE 'CG020' THEN NULL;
  END;
  BEGIN
    DELETE FROM clockgrove.agent_runs;
    RAISE EXCEPTION 'run deleted' USING ERRCODE = 'XX999';
  EXCEPTION WHEN insufficient_privilege OR SQLSTATE 'CG020' THEN NULL;
  END;
  UPDATE clockgrove.agent_runs SET status = 'failed', outcome_code = 'model_error' WHERE run_id = 'run-1';
  IF (SELECT count(*) FROM clockgrove.run_steps
       WHERE run_id = 'run-1' AND status = 'failed' AND ended_at IS NOT NULL) <> 1 THEN
    RAISE EXCEPTION 'failed run left its step open';
  END IF;
  BEGIN
    UPDATE clockgrove.agent_runs SET status = 'cancelled' WHERE run_id = 'run-1';
    RAISE EXCEPTION 'finished run changed' USING ERRCODE = 'XX999';
  EXCEPTION WHEN SQLSTATE 'CG020' THEN NULL;
  END;
  BEGIN
    PERFORM pg_temp.new_step('run-1', 2);
    RAISE EXCEPTION 'step added to a finished run' USING ERRCODE = 'XX999';
  EXCEPTION WHEN SQLSTATE 'CG020' THEN NULL;
  END;
END;
$$;
ROLLBACK;

SELECT 'database_authorization_ok';
