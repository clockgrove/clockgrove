-- Receipt state machine and journal immutability, run once per role (the caller sets the role and,
-- for clockgrove_runtime, the transaction-local tenant context). Everything is rolled back.
-- Owner and administrative roles are refused by triggers (CG006); the runtime role is refused by
-- missing privileges (42501) wherever it holds none, and by the same triggers otherwise.
DO $$
DECLARE
  is_runtime boolean := current_user = 'clockgrove_runtime';
  attempt text;
  expected_state text;
  expected_message text;
  captured_state text;
  captured_message text;
BEGIN
  INSERT INTO clockgrove.command_receipts (
    tenant_id, command_id, request_hash, command_bytes, target_address, status, provenance,
    attribution, action_id, correlation_id, causation_id, expected
  ) VALUES (
    'tenant-j-a', 'command-probe', 'sha256:probe', '\x00',
    '{"version":1,"tenantId":"tenant-j-a","worldId":"world-j-a","timelineId":"timeline-j-a","kind":"world","id":"world-j-a"}',
    'pending', 'attributed', '{"effectiveActorId":"world-j-a","causalRootActionId":"action-probe"}',
    'action-probe', 'correlation-probe', 'cause-probe', '{}'
  );
  INSERT INTO clockgrove.authority_decisions (
    tenant_id, authority_decision_id, command_id, outcome, world_id, timeline_id, action_id,
    attribution, inputs
  ) VALUES (
    'tenant-j-a', 'authority:command-probe', 'command-probe', 'allow', 'world-j-a', 'timeline-j-a',
    'action-probe', '{"effectiveActorId":"world-j-a","causalRootActionId":"action-probe"}',
    '{"roles":[],"grants":[],"privacyCeiling":{"version":1,"allowedCategories":[]}}'
  );

  -- Identity of a pending receipt: the state machine would allow the update, so only the identity
  -- guard can refuse it.
  FOREACH attempt IN ARRAY ARRAY[
    $q$UPDATE clockgrove.command_receipts SET attribution = '{"effectiveActorId":"other","causalRootActionId":"action-probe"}' WHERE command_id = 'command-probe'$q$,
    $q$UPDATE clockgrove.command_receipts SET action_id = 'action-other', attribution = '{"effectiveActorId":"world-j-a","causalRootActionId":"action-other"}' WHERE command_id = 'command-probe'$q$,
    $q$UPDATE clockgrove.command_receipts SET target_address = '{"version":1,"tenantId":"tenant-j-a","worldId":"world-j-a","timelineId":"timeline-j-a","kind":"world","id":"world-other"}' WHERE command_id = 'command-probe'$q$,
    $q$UPDATE clockgrove.command_receipts SET created_at = created_at - interval '1 day' WHERE command_id = 'command-probe'$q$,
    $q$UPDATE clockgrove.command_receipts SET request_hash = 'sha256:other' WHERE command_id = 'command-probe'$q$,
    $q$UPDATE clockgrove.command_receipts SET command_bytes = '\x01' WHERE command_id = 'command-probe'$q$,
    $q$UPDATE clockgrove.command_receipts SET correlation_id = 'correlation-other' WHERE command_id = 'command-probe'$q$,
    $q$UPDATE clockgrove.command_receipts SET causation_id = 'cause-other' WHERE command_id = 'command-probe'$q$,
    $q$UPDATE clockgrove.command_receipts SET expected = '{"routingEpoch":1}' WHERE command_id = 'command-probe'$q$,
    $q$UPDATE clockgrove.command_receipts SET routed_space_id = 'space-other' WHERE command_id = 'command-probe'$q$,
    $q$UPDATE clockgrove.command_receipts SET provenance = 'legacy-wave0', attribution = NULL, action_id = NULL WHERE command_id = 'command-probe'$q$
  ] LOOP
    BEGIN
      EXECUTE attempt;
      RAISE EXCEPTION 'pending receipt identity changed as %: %', current_user, attempt
        USING ERRCODE = 'XX999';
    EXCEPTION WHEN SQLSTATE 'CG006' THEN
      GET STACKED DIAGNOSTICS captured_message = MESSAGE_TEXT;
      IF captured_message <> 'command receipt identity is immutable' THEN
        RAISE EXCEPTION 'identity change refused for the wrong reason (%): %',
          captured_message, attempt;
      END IF;
    END;
  END LOOP;

  -- Legal transitions from pending; each is rolled back by its subtransaction.
  FOREACH attempt IN ARRAY ARRAY[
    $q$UPDATE clockgrove.command_receipts SET status = 'committed', authority_decision_id = 'authority:command-probe', result = '{}', committed_at = statement_timestamp() WHERE command_id = 'command-probe'$q$,
    $q$UPDATE clockgrove.command_receipts SET status = 'rejected', authority_decision_id = 'authority:command-probe', result = '{}', committed_at = statement_timestamp() WHERE command_id = 'command-probe'$q$,
    $q$UPDATE clockgrove.command_receipts SET status = 'failed', authority_decision_id = 'authority:command-probe', failed_at = statement_timestamp() WHERE command_id = 'command-probe'$q$
  ] LOOP
    BEGIN
      EXECUTE attempt;
      RAISE EXCEPTION 'rollback' USING ERRCODE = 'XX998';
    EXCEPTION WHEN SQLSTATE 'XX998' THEN
      NULL;
    END;
  END LOOP;

  -- failedAt belongs to failed receipts only; committedAt to committed and rejected ones only.
  FOREACH attempt IN ARRAY ARRAY[
    $q$UPDATE clockgrove.command_receipts SET status = 'committed', authority_decision_id = 'authority:command-probe', result = '{}', committed_at = statement_timestamp(), failed_at = statement_timestamp() WHERE command_id = 'command-probe'$q$,
    $q$UPDATE clockgrove.command_receipts SET status = 'failed', authority_decision_id = 'authority:command-probe' WHERE command_id = 'command-probe'$q$,
    $q$UPDATE clockgrove.command_receipts SET failed_at = statement_timestamp() WHERE command_id = 'command-probe'$q$,
    $q$UPDATE clockgrove.command_receipts SET status = 'committed', result = '{}', committed_at = statement_timestamp() WHERE command_id = 'command-probe'$q$
  ] LOOP
    BEGIN
      EXECUTE attempt;
      RAISE EXCEPTION 'receipt timestamps or decision accepted as %: %', current_user, attempt
        USING ERRCODE = 'XX999';
    EXCEPTION WHEN check_violation THEN
      NULL;
    END;
  END LOOP;

  UPDATE clockgrove.command_receipts
     SET status = 'committed', authority_decision_id = 'authority:command-probe', result = '{}',
         committed_at = statement_timestamp()
   WHERE command_id = 'command-probe';

  -- A terminal receipt never changes; its decision reference is identity.
  FOREACH attempt IN ARRAY ARRAY[
    $q$UPDATE clockgrove.command_receipts SET status = 'pending', committed_at = NULL WHERE command_id = 'command-probe'$q$,
    $q$UPDATE clockgrove.command_receipts SET status = 'rejected' WHERE command_id = 'command-probe'$q$,
    $q$UPDATE clockgrove.command_receipts SET status = 'failed', committed_at = NULL, failed_at = statement_timestamp() WHERE command_id = 'command-probe'$q$,
    $q$UPDATE clockgrove.command_receipts SET result = '{"forged":true}' WHERE command_id = 'command-probe'$q$,
    $q$UPDATE clockgrove.command_receipts SET canonical_event_ids = ARRAY['event-forged'] WHERE command_id = 'command-probe'$q$
  ] LOOP
    BEGIN
      EXECUTE attempt;
      RAISE EXCEPTION 'terminal receipt changed as %: %', current_user, attempt
        USING ERRCODE = 'XX999';
    EXCEPTION WHEN SQLSTATE 'CG006' THEN
      GET STACKED DIAGNOSTICS captured_message = MESSAGE_TEXT;
      IF captured_message <> 'command receipt is terminal' THEN
        RAISE EXCEPTION 'terminal change refused for the wrong reason (%): %',
          captured_message, attempt;
      END IF;
    END;
  END LOOP;
  BEGIN
    UPDATE clockgrove.command_receipts SET authority_decision_id = 'authority:command-other'
     WHERE command_id = 'command-probe';
    RAISE EXCEPTION 'decision reference changed as %', current_user USING ERRCODE = 'XX999';
  EXCEPTION WHEN SQLSTATE 'CG006' THEN
    GET STACKED DIAGNOSTICS captured_message = MESSAGE_TEXT;
    IF captured_message <> 'command receipt identity is immutable' THEN
      RAISE EXCEPTION 'decision reference change refused for the wrong reason: %', captured_message;
    END IF;
  END;

  -- Deletion and truncation of receipts and decisions, and changes to decisions.
  FOREACH attempt IN ARRAY ARRAY[
    $q$DELETE FROM clockgrove.command_receipts WHERE command_id = 'command-probe'$q$,
    $q$TRUNCATE clockgrove.command_receipts CASCADE$q$,
    $q$UPDATE clockgrove.authority_decisions SET reason_code = NULL, inputs = '{}' WHERE authority_decision_id = 'authority:command-probe'$q$,
    $q$UPDATE clockgrove.authority_decisions SET outcome = 'deny', reason_code = 'forged' WHERE authority_decision_id = 'authority:command-probe'$q$,
    $q$DELETE FROM clockgrove.authority_decisions WHERE authority_decision_id = 'authority:command-probe'$q$,
    $q$TRUNCATE clockgrove.authority_decisions CASCADE$q$
  ] LOOP
    expected_state := CASE WHEN is_runtime THEN '42501' ELSE 'CG006' END;
    BEGIN
      EXECUTE attempt;
      RAISE EXCEPTION 'journal record mutated as %: %', current_user, attempt
        USING ERRCODE = 'XX999';
    EXCEPTION WHEN SQLSTATE 'XX999' THEN
      RAISE;
    WHEN OTHERS THEN
      captured_state := SQLSTATE;
    END;
    IF captured_state <> expected_state THEN
      RAISE EXCEPTION 'journal record mutation as % failed with %, expected %: %',
        current_user, captured_state, expected_state, attempt;
    END IF;
  END LOOP;

  -- Schedule rows: a pending or recently done row cannot be deleted by any role; the runtime
  -- role holds no DELETE, the others are refused by the guard.
  INSERT INTO clockgrove.partition_states (
    tenant_id, world_id, timeline_id, partition_id, space_id, revision, covered_head_sequence,
    simulation_time, document_version, document, document_hash, state_hash
  ) VALUES ('tenant-j-a', 'world-j-a', 'timeline-j-a', 'partition-j-a', 'space-j-a', 0, 0, 0, 2,
    '[]', repeat('a', 64), repeat('a', 64));
  INSERT INTO clockgrove.partition_schedules (
    tenant_id, world_id, timeline_id, partition_id, space_id, schedule_id, idempotency_key,
    owner_partition_id, due_at, priority, tie_break_key, kind, payload_version, catch_up_class,
    item, item_hash, status, scheduled_by_command_id, completed_by_command_id
  ) SELECT 'tenant-j-a', 'world-j-a', 'timeline-j-a', 'partition-j-a', 'space-j-a', id, id,
      'partition-j-a', 60000, 10, 'object-j-a', 'world.decision', 1, 'exact', '[]',
      repeat('a', 64), status, 'command-probe', completed
    FROM (VALUES ('schedule-pending', 'pending', NULL), ('schedule-done', 'done', 'command-probe'))
      AS row (id, status, completed);
  FOREACH attempt IN ARRAY ARRAY['schedule-pending', 'schedule-done'] LOOP
    expected_state := CASE WHEN is_runtime THEN '42501' ELSE 'CG006' END;
    BEGIN
      DELETE FROM clockgrove.partition_schedules WHERE schedule_id = attempt;
      RAISE EXCEPTION 'schedule row % deleted as %', attempt, current_user USING ERRCODE = 'XX999';
    EXCEPTION WHEN insufficient_privilege OR SQLSTATE 'CG006' THEN
      IF SQLSTATE <> expected_state THEN
        RAISE EXCEPTION 'schedule delete as % failed with %', current_user, SQLSTATE;
      END IF;
    END;
  END LOOP;

  -- Committed events and dispatch intent are append-only for the runtime role.
  IF is_runtime THEN
    FOREACH attempt IN ARRAY ARRAY[
      $q$UPDATE clockgrove.events SET payload_hash = 'forged' WHERE tenant_id = 'tenant-j-a'$q$,
      $q$DELETE FROM clockgrove.events WHERE tenant_id = 'tenant-j-a'$q$,
      $q$UPDATE clockgrove.event_dispatches SET status = 'delivered' WHERE tenant_id = 'tenant-j-a'$q$,
      $q$DELETE FROM clockgrove.event_dispatches WHERE tenant_id = 'tenant-j-a'$q$
    ] LOOP
      BEGIN
        EXECUTE attempt;
        RAISE EXCEPTION 'runtime role mutated committed journal rows: %', attempt
          USING ERRCODE = 'XX999';
      EXCEPTION WHEN insufficient_privilege THEN
        NULL;
      END;
    END LOOP;
  END IF;
END;
$$;

SELECT 'journal_immutability_ok';
