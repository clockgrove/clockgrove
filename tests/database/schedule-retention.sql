-- Done schedule retention, on the attack fixtures inside one rolled-back transaction. The
-- owner seeds backdated rows (the runtime cannot backdate: the guard stamps updated_at), including a
-- tenant-b partition that reuses tenant-a's timeline, partition and space IDs. Then, as the runtime:
-- no DELETE, and a completion retires its partition's done rows older than 90 days, and only those.
INSERT INTO clockgrove.partition_schedules
SELECT (jsonb_populate_record(r, jsonb_build_object('schedule_id', aged.id, 'status', 'done',
  'completed_by_command_id', 'command-a', 'updated_at', now() - aged.age))).*
  FROM clockgrove.partition_schedules AS r,
    (VALUES ('aged-91', interval '91 days'), ('aged-89', interval '89 days')) AS aged (id, age)
 WHERE r.schedule_id = 'schedule-a';
INSERT INTO clockgrove.timelines (tenant_id, world_id, timeline_id)
VALUES ('tenant-b', 'world-b', 'timeline-a');
INSERT INTO clockgrove.timeline_partitions (
  tenant_id, world_id, timeline_id, partition_id, space_id, head_sequence
) VALUES ('tenant-b', 'world-b', 'timeline-a', 'partition-a', 'space-a', 0);
INSERT INTO clockgrove.partition_states
SELECT (jsonb_populate_record(r,
  '{"timeline_id":"timeline-a","partition_id":"partition-a","space_id":"space-a"}')).*
  FROM clockgrove.partition_states AS r WHERE r.tenant_id = 'tenant-b';
INSERT INTO clockgrove.partition_schedules
SELECT (jsonb_populate_record(r, jsonb_build_object('timeline_id', 'timeline-a',
  'partition_id', 'partition-a', 'space_id', 'space-a', 'schedule_id', 'aged-91', 'status', 'done',
  'completed_by_command_id', 'command-b', 'updated_at', now() - interval '91 days'))).*
  FROM clockgrove.partition_schedules AS r WHERE r.schedule_id = 'schedule-b';

SET LOCAL ROLE clockgrove_runtime;
DO $$
BEGIN
  PERFORM set_config('app.tenant_id', 'tenant-a', true);
  PERFORM set_config('app.principal_id', 'principal-a', true);
  BEGIN
    DELETE FROM clockgrove.partition_schedules WHERE schedule_id = 'aged-91';
    RAISE EXCEPTION 'runtime deleted a schedule row' USING ERRCODE = 'XX999';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  -- A backdated completion is stamped with the server clock, so it does not retire itself.
  UPDATE clockgrove.partition_schedules
     SET status = 'done', completed_by_command_id = 'command-a', updated_at = '2000-01-01'
   WHERE schedule_id = 'schedule-a';
  IF (SELECT string_agg(schedule_id || ':' || (updated_at > now() - interval '1 day'), ','
               ORDER BY schedule_id)
        FROM clockgrove.partition_schedules
       WHERE schedule_id IN ('aged-91', 'aged-89', 'schedule-a'))
     IS DISTINCT FROM 'aged-89:false,schedule-a:true' THEN
    RAISE EXCEPTION 'completion retired the wrong done rows';
  END IF;
  PERFORM set_config('app.tenant_id', 'tenant-b', true);
  PERFORM set_config('app.principal_id', 'principal-b', true);
  IF NOT EXISTS (SELECT 1 FROM clockgrove.partition_schedules
                  WHERE timeline_id = 'timeline-a' AND partition_id = 'partition-a'
                    AND schedule_id = 'aged-91') THEN
    RAISE EXCEPTION 'retirement crossed tenant isolation';
  END IF;
END;
$$;

SELECT 'schedule_retention_ok';
