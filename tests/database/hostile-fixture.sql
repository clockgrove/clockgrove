-- Hostile identifiers stored as real data. Each tenant looks like "tenant-a" to a naive
-- comparison (SQL metacharacters, LIKE wildcards, case, whitespace, confusable or invisible
-- Unicode, oversized). The runtime principal "principal-a" is a member of every one, so only the
-- exact tenant match can keep them apart. authorization.sql keeps the same list in sync.
DO $$
DECLARE
  hostile text;
  birth_table text;
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
    INSERT INTO clockgrove.tenants (tenant_id, display_name) VALUES (hostile, 'Hostile');
    INSERT INTO clockgrove.tenant_principals (tenant_id, principal_id)
      VALUES (hostile, 'principal-a');
    INSERT INTO clockgrove.worlds (tenant_id, world_id, lifecycle_status)
      VALUES (hostile, hostile, 'ready');
    INSERT INTO clockgrove.timelines (tenant_id, world_id, timeline_id)
      VALUES (hostile, hostile, hostile);
    INSERT INTO clockgrove.timeline_partitions (
      tenant_id, world_id, timeline_id, partition_id, space_id, head_sequence
    ) VALUES (hostile, hostile, hostile, hostile, hostile, 1);
    INSERT INTO clockgrove.streams (
      tenant_id, world_id, timeline_id, partition_id, space_id, stream_id, current_sequence
    ) VALUES (hostile, hostile, hostile, hostile, hostile, hostile, 1);
    INSERT INTO clockgrove.partition_states (
      tenant_id, world_id, timeline_id, partition_id, space_id, revision, covered_head_sequence,
      simulation_time, document_version, document, document_hash, state_hash
    ) VALUES (
      hostile, hostile, hostile, hostile, hostile, 1, 1, 0, 2, '[]', repeat('a', 64), repeat('a', 64)
    );
    INSERT INTO clockgrove.clock_admissions
      (tenant_id, timeline_id, partition_id, activation_id, policy_version, horizon, admitted)
      VALUES (hostile, hostile, hostile, 'activation-fixture', 1, 100, 100);
    INSERT INTO clockgrove.partition_schedules (
      tenant_id, world_id, timeline_id, partition_id, space_id, schedule_id, idempotency_key,
      owner_partition_id, due_at, priority, tie_break_key, kind, payload_version, catch_up_class,
      item, item_hash, status, scheduled_by_command_id
    ) VALUES (
      hostile, hostile, hostile, hostile, hostile, hostile, hostile, hostile, 60000, 10, hostile,
      'world.decision', 1, 'exact', '[]', repeat('a', 64), 'pending', 'command-hostile'
    );
    INSERT INTO clockgrove.command_receipts (
      tenant_id, command_id, request_hash, command_bytes, target_address, status, provenance,
      attribution, action_id, correlation_id, expected
    ) VALUES (
      hostile, 'command-hostile', 'hash-hostile', convert_to('command-hostile', 'UTF8'), '{}',
      'pending', 'attributed', '{"effectiveActorId":"hostile","causalRootActionId":"action-hostile"}',
      'action-hostile', 'correlation-hostile', '{}'
    );
    INSERT INTO clockgrove.authority_decisions (
      tenant_id, authority_decision_id, command_id, outcome, world_id, timeline_id, action_id,
      attribution, inputs
    ) VALUES (
      hostile, 'authority:command-hostile', 'command-hostile', 'allow', hostile, hostile,
      'action-hostile', '{"effectiveActorId":"hostile","causalRootActionId":"action-hostile"}',
      '{"principalId":"principal-a","roles":[],"grants":[],"privacyCeiling":{"version":1,"allowedCategories":[]}}'
    );
    UPDATE clockgrove.command_receipts
       SET status = 'committed', authority_decision_id = 'authority:command-hostile',
           committed_at = statement_timestamp(), canonical_event_ids = ARRAY['event-' || hostile]
     WHERE tenant_id = hostile AND command_id = 'command-hostile';
    INSERT INTO clockgrove.events (
      event_id, tenant_id, world_id, timeline_id, partition_id, space_id, stream_id,
      stream_sequence, partition_sequence, event_type, schema_version, simulation_time,
      command_id, correlation_id, principal_id, privacy_class, payload_hash, attribution,
      policy_versions, payload, event_bytes
    ) VALUES (
      'event-' || hostile, hostile, hostile, hostile, hostile, hostile, hostile,
      1, 1, 'PublicFixture', 2, 0,
      'command-hostile', 'correlation-hostile', 'principal-a', 'public_scene', 'hash-hostile',
      '{}', '{}', '{}', convert_to('{"schemaVersion":2}', 'UTF8')
    );
    INSERT INTO clockgrove.world_memberships (
      tenant_id, world_id, timeline_id, space_id, principal_id, membership_id, persona_id,
      roles, grants, privacy_ceiling, committed_at
    ) VALUES (
      hostile, hostile, hostile, hostile, 'principal-a', 'world-membership-' || hostile,
      'persona-hostile', ARRAY['member'], ARRAY['read'],
      '{"version":1,"allowedCategories":["public_scene"]}', statement_timestamp()
    );
    INSERT INTO clockgrove_management.workspace_memberships (
      tenant_id, principal_id, membership_id, roles, grants
    ) VALUES (
      hostile, 'principal-a', 'workspace-membership-' || hostile, ARRAY['member'], ARRAY['read']
    );
    -- World birth rows: the seeded tenant-a row of each birth table, re-keyed to this tenant.
    -- Parents come first so foreign keys hold. Requires seed.sql to have run.
    FOREACH birth_table IN ARRAY ARRAY[
      'pack_artifacts', 'pack_artifact_resources', 'provisioning_cases', 'pack_installations',
      'world_birth_states', 'birth_state_sections', 'birth_space_state', 'birth_schedules',
      'birth_random_streams', 'birth_cognitive_seed_refs'
    ] LOOP
      EXECUTE format(
        $q$INSERT INTO clockgrove_birth.%1$I
           SELECT (jsonb_populate_record(
             NULL::clockgrove_birth.%1$I,
             to_jsonb(source) || coalesce((
               SELECT jsonb_object_agg(key, to_jsonb(%2$L::text))
               FROM jsonb_object_keys(to_jsonb(source)) AS key
               WHERE key IN (
                 'tenant_id', 'world_id', 'timeline_id', 'partition_id', 'space_id',
                 'state_partition_id'
               )
             ), '{}')
           )).*
           FROM clockgrove_birth.%1$I AS source WHERE tenant_id = 'tenant-a'$q$,
        birth_table, hostile
      );
    END LOOP;
  END LOOP;
END;
$$;

-- Scratch tenants without world birth or membership dependants, so the runtime role can delete their
-- rows and authorization.sql can count blind and unscoped DELETEs exactly. 'scratch%' looks like a
-- LIKE pattern that would also match 'scratch-victim'.
DO $$
DECLARE
  scratch text;
BEGIN
  FOREACH scratch IN ARRAY ARRAY['scratch-victim', 'scratch%'] LOOP
    INSERT INTO clockgrove.tenants (tenant_id, display_name) VALUES (scratch, 'Scratch');
    INSERT INTO clockgrove.tenant_principals (tenant_id, principal_id) VALUES (scratch, 'principal-a');
    INSERT INTO clockgrove.worlds (tenant_id, world_id, lifecycle_status)
      VALUES (scratch, 'world-scratch', 'ready');
    INSERT INTO clockgrove.timelines (tenant_id, world_id, timeline_id)
      VALUES (scratch, 'world-scratch', 'timeline-scratch');
    INSERT INTO clockgrove.timeline_partitions (
      tenant_id, world_id, timeline_id, partition_id, space_id, head_sequence
    ) VALUES (scratch, 'world-scratch', 'timeline-scratch', 'partition-scratch', 'space-scratch', 1);
  END LOOP;
END;
$$;
