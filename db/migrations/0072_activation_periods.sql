-- Issue 358: wakes and model opportunities are limited per period of wall-clock time, not over an
-- actor's lifetime. Expand only: the lifetime receipt tally stays, uncapped, and receipts are never deleted.
ALTER TABLE clockgrove.actor_activation_policies
  ADD COLUMN budget_period_ms bigint NOT NULL DEFAULT 3600000 CHECK (budget_period_ms BETWEEN 60000 AND 2592000000),
  ADD COLUMN wake_limit integer NOT NULL DEFAULT 120 CHECK (wake_limit BETWEEN 1 AND 10000),
  ADD COLUMN period_index bigint NOT NULL DEFAULT 0 CHECK (period_index >= 0),
  ADD COLUMN period_wakes integer NOT NULL DEFAULT 0 CHECK (period_wakes >= 0);
ALTER TABLE clockgrove.actor_activation_policies
  DROP CONSTRAINT actor_activation_policies_receipt_count_check,
  ADD CONSTRAINT actor_activation_policies_receipt_count_check CHECK (receipt_count >= 0);
ALTER TABLE clockgrove.actor_activations
  ADD COLUMN admitted_at timestamptz NOT NULL DEFAULT statement_timestamp();
CREATE INDEX actor_activations_admitted ON clockgrove.actor_activations
  (tenant_id, world_id, timeline_id, actor_id, admitted_at);
GRANT UPDATE (budget_period_ms, wake_limit, period_index, period_wakes)
  ON clockgrove.actor_activation_policies TO clockgrove_runtime;

-- The database-side counter now also bounds the wakes of the current period.
CREATE OR REPLACE FUNCTION clockgrove.guard_actor_activation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clockgrove AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM clockgrove.conversation_sessions s
    JOIN clockgrove.conversation_participants cp
      ON cp.tenant_id=s.tenant_id AND cp.session_id=s.session_id
    WHERE s.tenant_id=NEW.tenant_id AND s.world_id=NEW.world_id
      AND s.timeline_id=NEW.timeline_id AND s.space_id=NEW.space_id
      AND s.actor_id=NEW.actor_id AND s.session_id=NEW.session_id
      AND cp.principal_id=NEW.principal_id
  ) THEN RAISE EXCEPTION 'activation conversation not found'; END IF;
  UPDATE clockgrove.actor_activation_policies
    SET receipt_count = receipt_count + 1, period_wakes = period_wakes + 1
    WHERE tenant_id = NEW.tenant_id AND world_id = NEW.world_id AND timeline_id = NEW.timeline_id
      AND actor_id = NEW.actor_id AND principal_id = NEW.principal_id AND space_id=NEW.space_id
      AND period_wakes < wake_limit;
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM clockgrove.actor_activation_policies
      WHERE tenant_id = NEW.tenant_id AND world_id = NEW.world_id AND timeline_id = NEW.timeline_id
        AND actor_id = NEW.actor_id AND principal_id = NEW.principal_id AND space_id=NEW.space_id)
    THEN RAISE EXCEPTION 'activation wake limit reached'; END IF;
    RAISE EXCEPTION 'activation policy not found';
  END IF;
  RETURN NEW;
END $$;
