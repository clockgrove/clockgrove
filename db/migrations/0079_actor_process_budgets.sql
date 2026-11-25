-- Issue 374 (S16): an `ActorProcess` names its mode and carries its budget. A process in the
-- `continuously_eligible` mode is admitted for its next bounded segment at once, without waiting for
-- an event; every mode stays a sequence of bounded segments under one stable process ID (0038), so
-- nothing about it lives in a resident isolate and it carries on across a deployment from its
-- checkpoint.
--
-- The budget is fixed at start, like the objective:
-- - `segment_limit`: the segments the process may run. Defaults to the 0038 bound of 64.
-- - `step_limit`: the checkpoint steps one segment may advance. Defaults to 10,000, the `target`
--   bound (0038), so an unbudgeted segment may finish its objective.
-- A segment past either limit is refused (`CG025`), and a process whose segments are spent takes no
-- new lease, so a spent budget stops the process without completing it.
ALTER TABLE clockgrove.actor_processes
  ADD COLUMN mode text NOT NULL DEFAULT 'reactive'
    CHECK (mode IN ('reactive', 'scheduled', 'continuously_eligible')),
  ADD COLUMN segment_limit integer NOT NULL DEFAULT 64 CHECK (segment_limit BETWEEN 1 AND 64),
  ADD COLUMN step_limit integer NOT NULL DEFAULT 10000 CHECK (step_limit BETWEEN 1 AND 10000);

-- A process's identity, objective, mode and budget never change, its lease epoch never decreases,
-- and a completed process, or one whose segment budget is spent, takes no new lease.
CREATE OR REPLACE FUNCTION clockgrove.guard_actor_process()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, clockgrove
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.checkpoint <> 0 OR NEW.segments <> 0 OR NEW.lease_epoch <> 0 OR NEW.state <> 'active' THEN
      RAISE EXCEPTION 'a process starts at its beginning' USING ERRCODE = 'CG020';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.lease_epoch < OLD.lease_epoch OR NEW.checkpoint < OLD.checkpoint
     OR NEW.segments < OLD.segments THEN
    RAISE EXCEPTION 'a process only moves forward' USING ERRCODE = 'CG020';
  END IF;
  IF NEW.mode <> OLD.mode OR NEW.segment_limit <> OLD.segment_limit
     OR NEW.step_limit <> OLD.step_limit THEN
    RAISE EXCEPTION 'a process keeps its mode and budget' USING ERRCODE = 'CG020';
  END IF;
  IF OLD.state = 'completed' AND NEW.lease_epoch <> OLD.lease_epoch THEN
    RAISE EXCEPTION 'a completed process takes no lease' USING ERRCODE = 'CG020';
  END IF;
  IF NEW.lease_epoch <> OLD.lease_epoch AND OLD.segments >= OLD.segment_limit THEN
    RAISE EXCEPTION 'process segment budget spent' USING ERRCODE = 'CG025';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

-- A segment is written only under the process's current lease epoch and holder, continues from its
-- checkpoint, stays within the process's budget, and advances that checkpoint in the same statement.
CREATE OR REPLACE FUNCTION clockgrove.append_actor_process_segment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, clockgrove
AS $$
DECLARE
  process clockgrove.actor_processes%ROWTYPE;
BEGIN
  SELECT * INTO process FROM clockgrove.actor_processes
   WHERE tenant_id = NEW.tenant_id AND process_id = NEW.process_id FOR UPDATE;
  IF NOT FOUND OR process.state <> 'active' THEN
    RAISE EXCEPTION 'a segment belongs to an active process' USING ERRCODE = 'CG020';
  END IF;
  IF NEW.lease_epoch <> process.lease_epoch OR NEW.lease_holder IS DISTINCT FROM process.lease_holder THEN
    RAISE EXCEPTION 'stale process lease' USING ERRCODE = 'CG022';
  END IF;
  IF NEW.segment <> process.segments + 1 OR NEW.from_checkpoint <> process.checkpoint
     OR NEW.to_checkpoint > process.target THEN
    RAISE EXCEPTION 'a segment continues its process' USING ERRCODE = 'CG020';
  END IF;
  IF NEW.segment > process.segment_limit THEN
    RAISE EXCEPTION 'process segment budget spent' USING ERRCODE = 'CG025';
  END IF;
  IF NEW.to_checkpoint - NEW.from_checkpoint > process.step_limit THEN
    RAISE EXCEPTION 'segment exceeds its step budget' USING ERRCODE = 'CG025';
  END IF;
  UPDATE clockgrove.actor_processes
     SET checkpoint = NEW.to_checkpoint, segments = NEW.segment,
         state = CASE WHEN NEW.to_checkpoint = process.target THEN 'completed' ELSE 'active' END
   WHERE tenant_id = NEW.tenant_id AND process_id = NEW.process_id;
  RETURN NEW;
END;
$$;
