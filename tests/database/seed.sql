INSERT INTO clockgrove.tenants (tenant_id, display_name)
VALUES ('tenant-a', 'Tenant A'), ('tenant-b', 'Tenant B');

INSERT INTO clockgrove.tenant_principals (tenant_id, principal_id)
VALUES ('tenant-a', 'principal-a'), ('tenant-b', 'principal-b');

INSERT INTO clockgrove.worlds (tenant_id, world_id, lifecycle_status)
VALUES ('tenant-a', 'world-a', 'ready'), ('tenant-b', 'world-b', 'ready');

INSERT INTO clockgrove.timelines (tenant_id, world_id, timeline_id)
VALUES
  ('tenant-a', 'world-a', 'timeline-a'),
  ('tenant-b', 'world-b', 'timeline-b');

INSERT INTO clockgrove.timeline_partitions (
  tenant_id, world_id, timeline_id, partition_id, space_id, head_sequence
) VALUES
  ('tenant-a', 'world-a', 'timeline-a', 'partition-a', 'space-a', 2),
  ('tenant-b', 'world-b', 'timeline-b', 'partition-b', 'space-b', 1);

INSERT INTO clockgrove.streams (
  tenant_id, world_id, timeline_id, partition_id, space_id, stream_id, current_sequence
) VALUES
  ('tenant-a', 'world-a', 'timeline-a', 'partition-a', 'space-a', 'stream-a', 2),
  ('tenant-b', 'world-b', 'timeline-b', 'partition-b', 'space-b', 'stream-b', 1);

-- Attributed receipts: pending, then their allow decisions, then committed.
INSERT INTO clockgrove.command_receipts (
  tenant_id, command_id, request_hash, command_bytes, target_address, status, provenance,
  attribution, action_id, correlation_id, expected
) VALUES
  ('tenant-a', 'command-a', 'hash-a', convert_to('command-a', 'UTF8'), '{"worldId":"world-a"}', 'pending',
   'attributed', '{"effectiveActorId":"world-a","causalRootActionId":"action-a"}', 'action-a',
   'correlation-a', '{}'),
  ('tenant-b', 'command-b', 'hash-b', convert_to('command-b', 'UTF8'), '{"worldId":"world-b"}', 'pending',
   'attributed', '{"effectiveActorId":"world-b","causalRootActionId":"action-b"}', 'action-b',
   'correlation-b', '{}');

INSERT INTO clockgrove.authority_decisions (
  tenant_id, authority_decision_id, command_id, outcome, world_id, timeline_id, action_id,
  attribution, inputs
) VALUES
  ('tenant-a', 'authority:command-a', 'command-a', 'allow', 'world-a', 'timeline-a', 'action-a',
   '{"effectiveActorId":"world-a","causalRootActionId":"action-a"}',
   '{"principalId":"principal-a","roles":[],"grants":[],"privacyCeiling":{"version":1,"allowedCategories":[]}}'),
  ('tenant-b', 'authority:command-b', 'command-b', 'allow', 'world-b', 'timeline-b', 'action-b',
   '{"effectiveActorId":"world-b","causalRootActionId":"action-b"}',
   '{"principalId":"principal-b","roles":[],"grants":[],"privacyCeiling":{"version":1,"allowedCategories":[]}}');

UPDATE clockgrove.command_receipts
   SET status = 'committed', authority_decision_id = 'authority:' || command_id,
       committed_at = statement_timestamp(),
       canonical_event_ids = CASE command_id
         WHEN 'command-a' THEN ARRAY['event-a-public', 'event-a-private']
         ELSE ARRAY['event-b-public']
       END
 WHERE command_id IN ('command-a', 'command-b');

INSERT INTO clockgrove.events (
  event_id, tenant_id, world_id, timeline_id, partition_id, space_id, stream_id,
  stream_sequence, partition_sequence, event_type, schema_version, simulation_time,
  command_id, correlation_id, principal_id, privacy_class, payload_hash, attribution,
  policy_versions, payload, event_bytes
) VALUES
  ('event-a-public', 'tenant-a', 'world-a', 'timeline-a', 'partition-a', 'space-a',
   'stream-a', 1, 1, 'PublicFixture', 2, 0, 'command-a', 'correlation-a', 'principal-a',
   'public_scene', 'hash-event-a-public', '{}', '{}', '{}', convert_to('{"schemaVersion":2}', 'UTF8')),
  ('event-a-private', 'tenant-a', 'world-a', 'timeline-a', 'partition-a', 'space-a',
   'stream-a', 2, 2, 'PrivateFixture', 2, 1, 'command-a', 'correlation-a', 'principal-a',
   'conversation', 'hash-event-a-private', '{}', '{}', '{}', convert_to('{"schemaVersion":2}', 'UTF8')),
  ('event-b-public', 'tenant-b', 'world-b', 'timeline-b', 'partition-b', 'space-b',
   'stream-b', 1, 1, 'PublicFixture', 2, 0, 'command-b', 'correlation-b', 'principal-b',
   'public_scene', 'hash-event-b-public', '{}', '{}', '{}', convert_to('{"schemaVersion":2}', 'UTF8'));

-- Authority storage the runtime role has no privilege on. The attack suite proves it can neither
-- read nor write these rows.
INSERT INTO clockgrove_management.principals (principal_id)
VALUES ('principal-a'), ('principal-b');

INSERT INTO clockgrove_management.identity_links (
  environment, subject, external_identity_id, principal_id
) VALUES
  ('test', 'subject-a', 'identity-a', 'principal-a'),
  ('test', 'subject-b', 'identity-b', 'principal-b');

INSERT INTO clockgrove_management.workspace_memberships (
  tenant_id, principal_id, membership_id, roles, grants
) VALUES
  ('tenant-a', 'principal-a', 'workspace-membership-a', ARRAY['member'], ARRAY['read']),
  ('tenant-b', 'principal-b', 'workspace-membership-b', ARRAY['member'], ARRAY['read']);

INSERT INTO clockgrove.world_memberships (
  tenant_id, world_id, timeline_id, space_id, principal_id, membership_id, persona_id,
  roles, grants, privacy_ceiling, committed_at
) VALUES
  ('tenant-a', 'world-a', 'timeline-a', 'space-a', 'principal-a', 'world-membership-a',
   'persona-a', ARRAY['member'], ARRAY['read'],
   '{"version":1,"allowedCategories":["public_scene"]}', statement_timestamp()),
  ('tenant-b', 'world-b', 'timeline-b', 'space-b', 'principal-b', 'world-membership-b',
   'persona-b', ARRAY['member'], ARRAY['read'],
   '{"version":1,"allowedCategories":["public_scene"]}', statement_timestamp());

-- World birth state for the seeded tenants: one installed pack, one provisioning case and one row
-- in every birth table. hostile-fixture.sql copies the tenant-a rows for each hostile tenant.
INSERT INTO clockgrove_birth.pack_artifacts (
  tenant_id, pack_id, pack_version, content_hash, engine_compatibility, resource_manifest_hash,
  asset_manifest_hash, migration_set_hash, build_tool_version
) VALUES
  ('tenant-a', 'pack', '1', repeat('a', 64), 'engine-1', repeat('a', 64), repeat('a', 64),
   repeat('a', 64), 'tool-1'),
  ('tenant-b', 'pack', '1', repeat('b', 64), 'engine-1', repeat('b', 64), repeat('b', 64),
   repeat('b', 64), 'tool-1');

INSERT INTO clockgrove_birth.pack_artifact_resources (
  tenant_id, pack_id, pack_version, resource_kind, resource_id, resource_version, path, sha256,
  content
) SELECT tenant_id, 'pack', '1', 'cognitiveSeeds', 'seed-1', 1, 'seeds/seed-1.json',
         encode(sha256(convert_to(tenant_id, 'UTF8')), 'hex'), convert_to(tenant_id, 'UTF8')
  FROM (VALUES ('tenant-a'), ('tenant-b')) AS seeded (tenant_id);

INSERT INTO clockgrove_birth.provisioning_cases (
  tenant_id, case_id, request_hash, pack_id, pack_version, content_hash, status, world_id
) VALUES
  ('tenant-a', 'case-1', repeat('a', 64), 'pack', '1', repeat('a', 64), 'seeding', 'world-a'),
  ('tenant-b', 'case-1', repeat('b', 64), 'pack', '1', repeat('b', 64), 'seeding', 'world-b');

INSERT INTO clockgrove_birth.pack_installations (
  tenant_id, installation_id, case_id, world_id, pack_id, pack_version, content_hash, status
) VALUES
  ('tenant-a', 'installation-1', 'case-1', 'world-a', 'pack', '1', repeat('a', 64), 'installed'),
  ('tenant-b', 'installation-1', 'case-1', 'world-b', 'pack', '1', repeat('b', 64), 'installed');

INSERT INTO clockgrove_birth.world_birth_states (
  tenant_id, world_id, timeline_id, birth_version, pack_id, pack_version, content_hash,
  state_schema_version, state_partition_id, scalars, clock_policy, simulation_epoch,
  seed_projection_hash
) VALUES
  ('tenant-a', 'world-a', 'timeline-a', 1, 'pack', '1', repeat('a', 64), 1, 'partition-a',
   '{}', '{}', 0, repeat('a', 64)),
  ('tenant-b', 'world-b', 'timeline-b', 1, 'pack', '1', repeat('b', 64), 1, 'partition-b',
   '{}', '{}', 0, repeat('b', 64));

INSERT INTO clockgrove_birth.birth_state_sections (
  tenant_id, world_id, timeline_id, birth_version, section, section_version, node
) VALUES
  ('tenant-a', 'world-a', 'timeline-a', 1, 'environment', 1, '{}'),
  ('tenant-b', 'world-b', 'timeline-b', 1, 'environment', 1, '{}');

INSERT INTO clockgrove_birth.birth_space_state (
  tenant_id, world_id, timeline_id, birth_version, partition_id, space_id, element_kind,
  element_key, ordinal, node
) VALUES
  ('tenant-a', 'world-a', 'timeline-a', 1, 'partition-a', 'space-a', 'frame', 'frame-a', 0, '{}'),
  ('tenant-b', 'world-b', 'timeline-b', 1, 'partition-b', 'space-b', 'frame', 'frame-b', 0, '{}');

INSERT INTO clockgrove_birth.birth_schedules (
  tenant_id, world_id, timeline_id, birth_version, ordinal, node
) VALUES
  ('tenant-a', 'world-a', 'timeline-a', 1, 0, '{}'),
  ('tenant-b', 'world-b', 'timeline-b', 1, 0, '{}');

INSERT INTO clockgrove_birth.birth_random_streams (
  tenant_id, world_id, timeline_id, birth_version, stream_name, algorithm, algorithm_version,
  draws, state_words
) VALUES
  ('tenant-a', 'world-a', 'timeline-a', 1, 'stream', 'algorithm', 1, 0, ARRAY['0']),
  ('tenant-b', 'world-b', 'timeline-b', 1, 'stream', 'algorithm', 1, 0, ARRAY['0']);

INSERT INTO clockgrove_birth.birth_cognitive_seed_refs (
  tenant_id, world_id, timeline_id, birth_version, ordinal, pack_id, pack_version, seed_id,
  seed_version, sha256
) SELECT tenant_id, world_id, timeline_id, 1, 0, 'pack', '1', 'seed-1', 1,
         encode(sha256(convert_to(tenant_id, 'UTF8')), 'hex')
  FROM (VALUES ('tenant-a', 'world-a', 'timeline-a'), ('tenant-b', 'world-b', 'timeline-b'))
    AS seeded (tenant_id, world_id, timeline_id);

-- The live partition state of each seeded world (one row per tenant). hostile-fixture.sql adds one
-- for each hostile tenant.
INSERT INTO clockgrove.partition_states (
  tenant_id, world_id, timeline_id, partition_id, space_id, revision, covered_head_sequence,
  simulation_time, document_version, document, document_hash, state_hash
) VALUES
  ('tenant-a', 'world-a', 'timeline-a', 'partition-a', 'space-a', 2, 2, 0, 2, '[]',
   repeat('a', 64), repeat('a', 64)),
  ('tenant-b', 'world-b', 'timeline-b', 'partition-b', 'space-b', 1, 1, 0, 2, '[]',
   repeat('b', 64), repeat('b', 64));

-- One pending schedule row per seeded partition state. hostile-fixture.sql adds one for each hostile
-- tenant.
INSERT INTO clockgrove.partition_schedules (
  tenant_id, world_id, timeline_id, partition_id, space_id, schedule_id, idempotency_key,
  owner_partition_id, due_at, priority, tie_break_key, kind, payload_version, catch_up_class, item,
  item_hash, status, scheduled_by_command_id
) VALUES
  ('tenant-a', 'world-a', 'timeline-a', 'partition-a', 'space-a', 'schedule-a', 'schedule-a:60000',
   'partition-a', 60000, 10, 'object-a', 'world.decision', 1, 'exact', '[]', repeat('a', 64),
   'pending', 'command-a'),
  ('tenant-b', 'world-b', 'timeline-b', 'partition-b', 'space-b', 'schedule-b', 'schedule-b:60000',
   'partition-b', 60000, 10, 'object-b', 'world.decision', 1, 'exact', '[]', repeat('b', 64),
   'pending', 'command-b');

-- Artifacts in both tenants: public rows stored inline, and a private tenant-a row whose ciphertext
-- is spilled to its content-addressed key under the tenant's wrapped data key. The bytes are
-- arbitrary; only their hash, length and location must agree.
INSERT INTO clockgrove.artifact_data_keys (
  tenant_id, world_id, privacy_class, key_version, kek_id, wrapped_key
) VALUES
  ('tenant-a', 'world-a', 'operator_evidence', 1, 'kek-test', decode(repeat('a1', 61), 'hex')),
  ('tenant-b', 'world-b', 'operator_evidence', 1, 'kek-test', decode(repeat('b1', 61), 'hex'));

INSERT INTO clockgrove.artifact_references (
  tenant_id, world_id, timeline_id, partition_id, space_id, artifact_id, content_hash, media_type,
  inline_content, storage_key, byte_length, privacy_class, retention_class, encryption,
  data_key_version
) SELECT tenant_id, world_id, timeline_id, partition_id, space_id, artifact_id,
         'sha256:' || encode(sha256(bytes), 'hex'), media_type,
         CASE WHEN version IS NULL THEN bytes END,
         CASE WHEN version IS NOT NULL
           THEN 'durable/' || encode(convert_to(tenant_id, 'UTF8'), 'hex') || '/sha256/'
                || encode(sha256(bytes), 'hex') END,
         octet_length(bytes), privacy_class, 'durable', encryption, version
  FROM (VALUES
    ('tenant-a', 'world-a', 'timeline-a', 'partition-a', 'space-a', 'artifact-a-public',
     convert_to('{}', 'UTF8'), 'application/json', 'public_scene', 'none', NULL::integer),
    ('tenant-a', 'world-a', 'timeline-a', 'partition-a', 'space-a', 'artifact-a-private',
     decode(repeat('a2', 64), 'hex'), 'application/json', 'operator_evidence', 'aes-256-gcm-v1', 1),
    ('tenant-b', 'world-b', 'timeline-b', 'partition-b', 'space-b', 'artifact-b-public',
     convert_to('{}', 'UTF8'), 'application/json', 'public_scene', 'none', NULL)
  ) AS seeded (tenant_id, world_id, timeline_id, partition_id, space_id, artifact_id, bytes,
               media_type, privacy_class, encryption, version);

INSERT INTO clockgrove.snapshots (
  tenant_id, world_id, timeline_id, partition_id, space_id, snapshot_id, stream_id,
  covered_sequence, covered_partition_sequence, state_hash, artifact_id, privacy_class, compatibility
) VALUES
  ('tenant-a', 'world-a', 'timeline-a', 'partition-a', 'space-a', 'snapshot-a', 'stream-a',
   2, 2, repeat('a', 64), 'artifact-a-public', 'public_scene', '{"codec":1}'),
  ('tenant-b', 'world-b', 'timeline-b', 'partition-b', 'space-b', 'snapshot-b', 'stream-b',
   1, 1, repeat('b', 64), 'artifact-b-public', 'public_scene', '{"codec":1}');

-- Admission receipts participate in every generic forced-RLS attack.
INSERT INTO clockgrove.clock_admissions
  (tenant_id, timeline_id, partition_id, activation_id, policy_version, horizon, admitted)
VALUES ('tenant-a', 'timeline-a', 'partition-a', 'activation-fixture', 1, 100, 100),
       ('tenant-b', 'timeline-b', 'partition-b', 'activation-fixture', 1, 100, 100);

-- Inspector audit rows in both tenants, so the no-privilege probes run against real rows.
INSERT INTO clockgrove.inspector_accesses
  (tenant_id, principal_id, world_id, timeline_id, space_id, command_id, decision, reason_code)
VALUES ('tenant-a', 'principal-a', 'world-a', 'timeline-a', 'space-a', 'command-a', 'allow', 'served'),
       ('tenant-b', 'principal-b', 'world-b', 'timeline-b', 'space-b', 'command-b', 'deny',
        'runtime-grant-missing');

-- Operator action audit rows in both tenants, for the same no-privilege probes.
INSERT INTO clockgrove.runtime_operator_actions (tenant_id, principal_id, world_id, timeline_id,
  space_id, action, message_id, decision, reason_code)
VALUES ('tenant-a', 'principal-a', 'world-a', 'timeline-a', 'space-a', 'repair-publication',
        'message-a', 'allow', 'repaired'),
       ('tenant-b', 'principal-b', 'world-b', 'timeline-b', 'space-b', 'replay-message',
        'message-b', 'deny', 'runtime-grant-missing');
