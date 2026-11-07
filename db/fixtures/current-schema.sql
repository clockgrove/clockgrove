-- Representative current-schema data. This is not a fabricated predecessor schema.
INSERT INTO clockgrove.tenants (tenant_id, display_name)
VALUES ('tenant-fixture', 'Representative tenant');

INSERT INTO clockgrove.tenant_principals (tenant_id, principal_id)
VALUES ('tenant-fixture', 'principal-fixture');

INSERT INTO clockgrove.worlds (tenant_id, world_id, lifecycle_status)
VALUES ('tenant-fixture', 'world-fixture', 'ready');

INSERT INTO clockgrove.timelines (tenant_id, world_id, timeline_id)
VALUES ('tenant-fixture', 'world-fixture', 'timeline-fixture');

INSERT INTO clockgrove.timeline_partitions (
  tenant_id, world_id, timeline_id, partition_id, space_id
) VALUES (
  'tenant-fixture', 'world-fixture', 'timeline-fixture', 'partition-fixture', 'space-fixture'
);

INSERT INTO clockgrove.streams (
  tenant_id, world_id, timeline_id, partition_id, space_id, stream_id, current_sequence
) VALUES (
  'tenant-fixture', 'world-fixture', 'timeline-fixture',
  'partition-fixture', 'space-fixture', 'stream-fixture', 1
);

-- An attributed receipt moves pending -> committed after its allow decision is recorded.
INSERT INTO clockgrove.command_receipts (
  tenant_id, command_id, request_hash, command_bytes, target_address, status, provenance,
  attribution, action_id, correlation_id, expected
) VALUES (
  'tenant-fixture',
  'command-fixture',
  'sha256:request-fixture',
  convert_to('{"commandId":"command-fixture"}', 'UTF8'),
  '{"version":1,"tenantId":"tenant-fixture","worldId":"world-fixture","timelineId":"timeline-fixture","kind":"world","id":"world-fixture"}',
  'pending',
  'attributed',
  '{"effectiveActorId":"world-fixture","causalRootActionId":"action-fixture"}',
  'action-fixture',
  'correlation-fixture',
  '{}'
);

INSERT INTO clockgrove.authority_decisions (
  tenant_id, authority_decision_id, command_id, outcome, world_id, timeline_id, action_id,
  attribution, inputs
) VALUES (
  'tenant-fixture', 'decision-fixture', 'command-fixture', 'allow', 'world-fixture',
  'timeline-fixture', 'action-fixture',
  '{"effectiveActorId":"world-fixture","causalRootActionId":"action-fixture"}',
  '{"principalId":"principal-fixture","roles":[],"grants":[],"privacyCeiling":{"version":1,"allowedCategories":["public_scene"]}}'
);

UPDATE clockgrove.command_receipts
   SET status = 'committed', canonical_event_ids = ARRAY['event-fixture'],
       result = '{"status":"accepted"}', authority_decision_id = 'decision-fixture',
       committed_at = statement_timestamp()
 WHERE tenant_id = 'tenant-fixture' AND command_id = 'command-fixture';

INSERT INTO clockgrove.events (
  event_id, tenant_id, world_id, timeline_id, partition_id, space_id, stream_id,
  stream_sequence, partition_sequence, event_type, schema_version, simulation_time,
  command_id, correlation_id, privacy_class, payload_hash, attribution, policy_versions,
  payload, event_bytes
) VALUES (
  'event-fixture', 'tenant-fixture', 'world-fixture', 'timeline-fixture',
  'partition-fixture', 'space-fixture', 'stream-fixture', 1, 1, 'FixtureRecorded', 2, 0,
  'command-fixture', 'correlation-fixture', 'public_scene', 'sha256:event-fixture',
  '{"effectiveActorId":"world-fixture","causalRootActionId":"action-fixture","authorityDecisionId":"decision-fixture"}',
  '{"fixture":"1"}', '{"fixture":true}', convert_to('{"schemaVersion":2}', 'UTF8')
);

INSERT INTO clockgrove.event_dispatches (
  tenant_id, world_id, timeline_id, partition_id, space_id, dispatch_id, event_id,
  channel, status, privacy_class, payload
) VALUES (
  'tenant-fixture', 'world-fixture', 'timeline-fixture', 'partition-fixture',
  'space-fixture', 'dispatch-fixture', 'event-fixture', 'world-reactions', 'pending',
  'public_scene', '{"eventId":"event-fixture"}'
);

INSERT INTO clockgrove.artifact_references (
  tenant_id, world_id, timeline_id, partition_id, space_id, artifact_id,
  content_hash, media_type, inline_content, byte_length, privacy_class, retention_class, encryption
) VALUES (
  'tenant-fixture', 'world-fixture', 'timeline-fixture', 'partition-fixture',
  'space-fixture', 'artifact-fixture',
  'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
  'application/json', convert_to('{}', 'UTF8'), 2, 'public_scene', 'durable', 'none'
);

INSERT INTO clockgrove.snapshots (
  tenant_id, world_id, timeline_id, partition_id, space_id, snapshot_id,
  stream_id, covered_sequence, covered_partition_sequence, state_hash, artifact_id, privacy_class,
  compatibility
) VALUES (
  'tenant-fixture', 'world-fixture', 'timeline-fixture', 'partition-fixture',
  'space-fixture', 'snapshot-fixture', 'stream-fixture', 1, 1, repeat('0', 64),
  'artifact-fixture', 'public_scene', '{"schemaVersion":1,"codeVersion":"fixture"}'
);
