-- Decision (issue 366): the executor heartbeats a started attempt every 15 s; the sweep treats an
-- attempt as lost only once neither a heartbeat nor its start is within the 60 s reconciliation
-- window. NULL means never beat: older attempts and executors that died before their first beat.
ALTER TABLE clockgrove.effect_attempts ADD COLUMN heartbeat_at timestamptz
  CHECK (heartbeat_at IS NULL OR (isfinite(heartbeat_at) AND heartbeat_at>=started_at));

CREATE OR REPLACE FUNCTION clockgrove.guard_effect_attempt() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,clockgrove AS $$
DECLARE intent clockgrove.effect_intents%ROWTYPE;
BEGIN
  SELECT * INTO intent FROM clockgrove.effect_intents WHERE tenant_id=NEW.tenant_id
    AND world_id=NEW.world_id AND timeline_id=NEW.timeline_id AND effect_id=NEW.effect_id FOR UPDATE;
  IF NOT FOUND OR intent.disposition<>'started' OR NEW.started_at<intent.created_at THEN
    RAISE EXCEPTION 'attempt requires started intent' USING ERRCODE='22023';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF OLD.disposition='started' AND NEW.disposition='started'
       AND NEW.heartbeat_at IS DISTINCT FROM OLD.heartbeat_at THEN
      -- A beat is the database's own now: never backward, and never ahead to hold a lease open.
      IF NEW.heartbeat_at IS NULL OR NEW.heartbeat_at<coalesce(OLD.heartbeat_at,OLD.started_at)
         OR NEW.heartbeat_at>statement_timestamp()
         OR (to_jsonb(NEW)-'heartbeat_at') IS DISTINCT FROM (to_jsonb(OLD)-'heartbeat_at') THEN
        RAISE EXCEPTION 'attempt heartbeat may only move forward' USING ERRCODE='22023';
      END IF;
    ELSIF (to_jsonb(NEW)-'disposition'-'outcome_code'-'result_artifact_id'-'cost_microusd'-'ended_at') IS DISTINCT FROM
       (to_jsonb(OLD)-'disposition'-'outcome_code'-'result_artifact_id'-'cost_microusd'-'ended_at')
       OR OLD.disposition<>'started' OR NEW.disposition='started' THEN
      RAISE EXCEPTION 'attempt identity or terminal disposition is immutable' USING ERRCODE='22023';
    END IF;
  ELSIF NEW.disposition<>'started' THEN
    RAISE EXCEPTION 'attempt must start before completion' USING ERRCODE='22023';
  END IF;
  IF NEW.result_artifact_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM clockgrove.artifact_references a
    WHERE a.tenant_id=NEW.tenant_id AND a.artifact_id=NEW.result_artifact_id AND a.world_id=NEW.world_id
      AND a.timeline_id=NEW.timeline_id AND a.space_id=intent.space_id AND a.privacy_class='conversation'
      AND a.encryption='aes-256-gcm-v1') THEN
    RAISE EXCEPTION 'effect result requires scoped encrypted artifact' USING ERRCODE='22023';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION clockgrove.guard_effect_attempt() FROM PUBLIC;
