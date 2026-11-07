-- #734: done schedule rows are retained for 90 days after completion; each command that completes an
-- occurrence retires its partition's expired done rows. Receipts and authority decisions stay
-- durable (db/retention.json says why).
--
-- Why done rows may go: the live queue is the pending rows only. The partition state hashes the
-- queue, snapshots and replay rebuild it, and a re-put of a retired occurrence simply inserts it
-- again. The one reader of done rows is the causal inspector's command links.
--
-- Decision: 90 days, the inspector audit window (#748, 0023): an operator can follow a command's
-- schedule links for as long as the audit trail and metrics that point at that command exist.
--
-- Retirement path: the trigger below only. The runtime role holds no DELETE, and the guard refuses
-- DELETE of a pending or unexpired row for every role, so nothing else can shrink the queue. The
-- guard also stamps updated_at on every UPDATE, so the 90 days run from the server's clock.
CREATE OR REPLACE FUNCTION clockgrove.guard_partition_schedule() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'done' OR OLD.updated_at >= statement_timestamp() - interval '90 days' THEN
      RAISE EXCEPTION 'partition schedules are retired only when done for 90 days'
        USING ERRCODE = 'CG006';
    END IF;
    RETURN OLD;
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
  -- The retirement clock is server-owned: a caller cannot backdate a row into retirement.
  NEW.updated_at := statement_timestamp();
  RETURN NEW;
END;
$$;

-- The retirement scan: one partition's oldest done rows first.
CREATE INDEX partition_schedules_done_updated_at
  ON clockgrove.partition_schedules (tenant_id, timeline_id, partition_id, updated_at)
  WHERE status = 'done';

-- One statement-level pass per schedule update, not per row: the command's `done` UPDATE fires it
-- once. Decision: at most 100 expired rows per partition per pass, as in 0023. A command adds at
-- least one done row and may retire 100, so a backlog drains while each pass stays a bounded index
-- range delete. Rows locked elsewhere are skipped, never waited on.
CREATE FUNCTION clockgrove.retire_done_schedules() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, clockgrove
AS $$
DECLARE
  part record;
BEGIN
  FOR part IN
    SELECT DISTINCT tenant_id, timeline_id, partition_id FROM completed WHERE status = 'done'
  LOOP
    DELETE FROM clockgrove.partition_schedules
     WHERE ctid = ANY (ARRAY(
       SELECT candidate.ctid FROM clockgrove.partition_schedules AS candidate
        WHERE candidate.tenant_id = part.tenant_id
          AND candidate.timeline_id = part.timeline_id
          AND candidate.partition_id = part.partition_id
          AND candidate.status = 'done'
          AND candidate.updated_at < statement_timestamp() - interval '90 days'
        ORDER BY candidate.updated_at
        LIMIT 100
        FOR UPDATE SKIP LOCKED
     ));
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE TRIGGER partition_schedules_retire_done
  AFTER UPDATE ON clockgrove.partition_schedules
  REFERENCING NEW TABLE AS completed
  FOR EACH STATEMENT EXECUTE FUNCTION clockgrove.retire_done_schedules();

REVOKE ALL ON FUNCTION clockgrove.retire_done_schedules() FROM PUBLIC;
