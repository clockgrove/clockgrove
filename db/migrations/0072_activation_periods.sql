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
-- Inspection reads each bucket in index order with a LIMIT, so its cost does not grow with an
-- actor's receipt history: the deferred scheduled wakes, the oldest deferred event wakes
-- (budget-exhausted ones apart, since only they renew with a period) and the newest settled ones.
CREATE INDEX actor_activations_deferred_schedule ON clockgrove.actor_activations
  (tenant_id, world_id, timeline_id, actor_id) WHERE status = 'deferred' AND left(causal_root, 9) = 'schedule:';
CREATE INDEX actor_activations_exhausted ON clockgrove.actor_activations
  (tenant_id, world_id, timeline_id, actor_id, admitted_at)
  WHERE status = 'deferred' AND outcome = 'budget_exhausted' AND left(causal_root, 9) <> 'schedule:';
CREATE INDEX actor_activations_deferred ON clockgrove.actor_activations
  (tenant_id, world_id, timeline_id, actor_id, admitted_at)
  WHERE status = 'deferred' AND outcome <> 'budget_exhausted' AND left(causal_root, 9) <> 'schedule:';
CREATE INDEX actor_activations_settled ON clockgrove.actor_activations
  (tenant_id, world_id, timeline_id, actor_id, admitted_at) WHERE status IN ('completed', 'noop');
-- Receipts are no longer capped at 1,000 per actor, so the per-turn reads that find a receipt by
-- its turn or its activation are served by an index instead of scanning the actor's (or, without
-- an actor, the timeline's) whole receipt history: the model gate (activation_model_gate),
-- wake triage (reserve_wake_triage), MCP admission and approval, and settle's lookup by activation.
CREATE INDEX actor_activations_turn ON clockgrove.actor_activations
  (tenant_id, world_id, timeline_id, session_id, message_id);
CREATE INDEX actor_activations_activation ON clockgrove.actor_activations
  (tenant_id, world_id, timeline_id, actor_id, activation_id);
GRANT UPDATE (budget_period_ms, wake_limit, period_index, period_wakes)
  ON clockgrove.actor_activation_policies TO clockgrove_runtime;

-- The database-side counter now also bounds the wakes of the current period. The trigger starts a
-- new period itself from the database clock when the stored one has passed, so a runtime from
-- before 0072 (which never rolls a period) keeps admitting wakes at the per-period rate instead of
-- stopping for good. A runtime that rolled the period already, on its own clock, is left alone:
-- the period index only moves forward.
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
  UPDATE clockgrove.actor_activation_policies p
    SET receipt_count = p.receipt_count + 1,
      period_index = greatest(p.period_index, n.current),
      period_wakes = CASE WHEN p.period_index < n.current THEN 0 ELSE p.period_wakes END + 1,
      model_calls_reserved = CASE WHEN p.period_index < n.current THEN 0 ELSE p.model_calls_reserved END
    FROM (SELECT floor(extract(epoch FROM clock_timestamp()) * 1000 / q.budget_period_ms)::bigint AS current
      FROM clockgrove.actor_activation_policies q
      WHERE q.tenant_id = NEW.tenant_id AND q.world_id = NEW.world_id AND q.timeline_id = NEW.timeline_id
        AND q.actor_id = NEW.actor_id) n
    WHERE p.tenant_id = NEW.tenant_id AND p.world_id = NEW.world_id AND p.timeline_id = NEW.timeline_id
      AND p.actor_id = NEW.actor_id AND p.principal_id = NEW.principal_id AND p.space_id=NEW.space_id
      AND (p.period_index < n.current OR p.period_wakes < p.wake_limit);
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM clockgrove.actor_activation_policies
      WHERE tenant_id = NEW.tenant_id AND world_id = NEW.world_id AND timeline_id = NEW.timeline_id
        AND actor_id = NEW.actor_id AND principal_id = NEW.principal_id AND space_id=NEW.space_id)
    THEN RAISE EXCEPTION 'activation wake limit reached' USING ERRCODE = 'check_violation'; END IF;
    RAISE EXCEPTION 'activation policy not found';
  END IF;
  RETURN NEW;
END $$;
