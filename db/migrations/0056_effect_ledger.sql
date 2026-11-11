-- Issue 165 foundation: no runtime writer is exposed until governed execution is composed.
-- Decision: references use the existing run-ID 1024-byte bound; content remains encrypted.
-- One attempt per intent deliberately forbids automatic resend after an interrupted read.
CREATE TABLE clockgrove.effect_intents (
  tenant_id text NOT NULL, world_id text NOT NULL, timeline_id text NOT NULL,
  space_id text NOT NULL,
  effect_id text NOT NULL CHECK (octet_length(effect_id) BETWEEN 1 AND 1024),
  idempotency_key text NOT NULL CHECK (octet_length(idempotency_key) BETWEEN 1 AND 1024),
  actor_id text NOT NULL CHECK (octet_length(actor_id) BETWEEN 1 AND 1024),
  principal_id text NOT NULL,
  run_id text CHECK (octet_length(run_id) BETWEEN 1 AND 1024),
  call_id text NOT NULL CHECK (octet_length(call_id) BETWEEN 1 AND 1024),
  capability_id text NOT NULL CHECK (octet_length(capability_id) BETWEEN 1 AND 1024),
  grant_id text NOT NULL CHECK (octet_length(grant_id) BETWEEN 1 AND 1024),
  policy_version text NOT NULL CHECK (octet_length(policy_version) BETWEEN 1 AND 1024),
  arguments_hash text NOT NULL CHECK (arguments_hash ~ '^[a-f0-9]{64}$'),
  arguments_artifact_id text,
  privacy_class text NOT NULL DEFAULT 'conversation' CHECK (privacy_class='conversation'),
  reserved_microusd bigint NOT NULL CHECK (reserved_microusd BETWEEN 0 AND 9007199254740991),
  disposition text NOT NULL DEFAULT 'pending' CHECK (disposition IN
    ('pending','started','succeeded','failed','uncertain','blocked','simulated','refused')),
  outcome_code text CHECK (outcome_code ~ '^[a-z_]{1,64}$'),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  ended_at timestamptz,
  PRIMARY KEY (tenant_id,world_id,timeline_id,effect_id),
  UNIQUE (tenant_id,world_id,timeline_id,idempotency_key),
  UNIQUE (tenant_id,world_id,timeline_id,call_id),
  FOREIGN KEY (tenant_id,world_id,timeline_id) REFERENCES clockgrove.timelines(tenant_id,world_id,timeline_id),
  FOREIGN KEY (tenant_id,principal_id) REFERENCES clockgrove.tenant_principals(tenant_id,principal_id),
  FOREIGN KEY (tenant_id,run_id) REFERENCES clockgrove.agent_runs(tenant_id,run_id),
  FOREIGN KEY (tenant_id,arguments_artifact_id,privacy_class)
    REFERENCES clockgrove.artifact_references(tenant_id,artifact_id,privacy_class),
  CHECK (isfinite(created_at) AND (ended_at IS NULL OR isfinite(ended_at) AND ended_at>=created_at)),
  CHECK ((disposition IN ('pending','started')) = (ended_at IS NULL)),
  CHECK ((disposition IN ('pending','started')) = (outcome_code IS NULL))
);
CREATE TABLE clockgrove.effect_attempts (
  tenant_id text NOT NULL, world_id text NOT NULL, timeline_id text NOT NULL,
  effect_id text NOT NULL,
  attempt_id text NOT NULL CHECK (octet_length(attempt_id) BETWEEN 1 AND 1024),
  disposition text NOT NULL DEFAULT 'started' CHECK (disposition IN ('started','succeeded','failed','uncertain')),
  outcome_code text CHECK (outcome_code ~ '^[a-z_]{1,64}$'),
  result_artifact_id text,
  privacy_class text NOT NULL DEFAULT 'conversation' CHECK (privacy_class='conversation'),
  cost_microusd bigint CHECK (cost_microusd BETWEEN 0 AND 9007199254740991),
  started_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  ended_at timestamptz,
  PRIMARY KEY (tenant_id,world_id,timeline_id,effect_id),
  UNIQUE (tenant_id,world_id,timeline_id,attempt_id),
  FOREIGN KEY (tenant_id,world_id,timeline_id,effect_id)
    REFERENCES clockgrove.effect_intents(tenant_id,world_id,timeline_id,effect_id),
  FOREIGN KEY (tenant_id,result_artifact_id,privacy_class)
    REFERENCES clockgrove.artifact_references(tenant_id,artifact_id,privacy_class),
  CHECK (isfinite(started_at) AND (ended_at IS NULL OR isfinite(ended_at) AND ended_at>=started_at)),
  CHECK ((disposition='started') = (ended_at IS NULL)),
  CHECK ((disposition='started') = (outcome_code IS NULL)),
  CHECK (disposition<>'started' OR (result_artifact_id IS NULL AND cost_microusd IS NULL)),
  CHECK (disposition<>'succeeded' OR result_artifact_id IS NOT NULL)
);

CREATE FUNCTION clockgrove.guard_effect_intent() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,clockgrove AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF (to_jsonb(NEW)-'disposition'-'outcome_code'-'ended_at') IS DISTINCT FROM
       (to_jsonb(OLD)-'disposition'-'outcome_code'-'ended_at') OR NOT (
         OLD.disposition='pending' AND NEW.disposition IN ('started','blocked','simulated','refused') OR
         OLD.disposition='started' AND NEW.disposition IN ('succeeded','failed','uncertain')) THEN
      RAISE EXCEPTION 'effect identity or terminal disposition is immutable' USING ERRCODE='22023';
    END IF;
    IF OLD.disposition='started' AND NOT EXISTS (SELECT 1 FROM clockgrove.effect_attempts a
      WHERE a.tenant_id=NEW.tenant_id AND a.world_id=NEW.world_id AND a.timeline_id=NEW.timeline_id
        AND a.effect_id=NEW.effect_id AND a.disposition=NEW.disposition
        AND a.outcome_code=NEW.outcome_code AND a.ended_at=NEW.ended_at) THEN
      RAISE EXCEPTION 'effect disposition requires recorded attempt' USING ERRCODE='22023';
    END IF;
  ELSIF NEW.disposition NOT IN ('pending','blocked','simulated','refused') THEN
    RAISE EXCEPTION 'effect must begin with an intent' USING ERRCODE='22023';
  END IF;
  IF NEW.disposition IN ('pending','started') AND NOT EXISTS (SELECT 1 FROM clockgrove.timelines t
    WHERE t.tenant_id=NEW.tenant_id AND t.world_id=NEW.world_id AND t.timeline_id=NEW.timeline_id AND t.kind='live') THEN
    RAISE EXCEPTION 'non-live effects must be blocked or simulated' USING ERRCODE='CG012';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM clockgrove.timeline_partitions p WHERE p.tenant_id=NEW.tenant_id
    AND p.world_id=NEW.world_id AND p.timeline_id=NEW.timeline_id AND p.space_id=NEW.space_id) THEN
    RAISE EXCEPTION 'effect space unavailable' USING ERRCODE='22023';
  END IF;
  IF NEW.run_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM clockgrove.agent_runs r
    WHERE r.tenant_id=NEW.tenant_id AND r.run_id=NEW.run_id AND r.world_id=NEW.world_id
      AND r.timeline_id=NEW.timeline_id AND r.space_id=NEW.space_id AND r.actor_id=NEW.actor_id
      AND r.principal_id=NEW.principal_id) THEN
    RAISE EXCEPTION 'effect run scope mismatch' USING ERRCODE='22023';
  END IF;
  IF NEW.arguments_artifact_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM clockgrove.artifact_references a
    WHERE a.tenant_id=NEW.tenant_id AND a.artifact_id=NEW.arguments_artifact_id AND a.world_id=NEW.world_id
      AND a.timeline_id=NEW.timeline_id AND a.space_id=NEW.space_id AND a.privacy_class='conversation'
      AND a.encryption='aes-256-gcm-v1') THEN
    RAISE EXCEPTION 'effect arguments require scoped encrypted artifact' USING ERRCODE='22023';
  END IF;
  RETURN NEW;
END $$;

-- A terminal attempt may precede intent settlement. Recovery must read that attempt and
-- settle the intent with its exact outcome and timestamp; it must never resend the call.
CREATE FUNCTION clockgrove.guard_effect_attempt() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,clockgrove AS $$
DECLARE intent clockgrove.effect_intents%ROWTYPE;
BEGIN
  SELECT * INTO intent FROM clockgrove.effect_intents WHERE tenant_id=NEW.tenant_id
    AND world_id=NEW.world_id AND timeline_id=NEW.timeline_id AND effect_id=NEW.effect_id FOR UPDATE;
  IF NOT FOUND OR intent.disposition<>'started' OR NEW.started_at<intent.created_at THEN
    RAISE EXCEPTION 'attempt requires started intent' USING ERRCODE='22023';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF (to_jsonb(NEW)-'disposition'-'outcome_code'-'result_artifact_id'-'cost_microusd'-'ended_at') IS DISTINCT FROM
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
REVOKE ALL ON FUNCTION clockgrove.guard_effect_intent(),clockgrove.guard_effect_attempt() FROM PUBLIC;
CREATE TRIGGER effect_intent_guard BEFORE INSERT OR UPDATE ON clockgrove.effect_intents
  FOR EACH ROW EXECUTE FUNCTION clockgrove.guard_effect_intent();
CREATE TRIGGER effect_attempt_guard BEFORE INSERT OR UPDATE ON clockgrove.effect_attempts
  FOR EACH ROW EXECUTE FUNCTION clockgrove.guard_effect_attempt();

ALTER TABLE clockgrove.effect_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE clockgrove.effect_intents FORCE ROW LEVEL SECURITY;
ALTER TABLE clockgrove.effect_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE clockgrove.effect_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY effect_intent_operator ON clockgrove.effect_intents FOR SELECT USING (
  clockgrove.mcp_install_authorized(tenant_id,world_id,timeline_id,space_id));
CREATE POLICY effect_attempt_operator ON clockgrove.effect_attempts FOR SELECT USING (EXISTS (
  SELECT 1 FROM clockgrove.effect_intents i WHERE i.tenant_id=effect_attempts.tenant_id
    AND i.world_id=effect_attempts.world_id AND i.timeline_id=effect_attempts.timeline_id
    AND i.effect_id=effect_attempts.effect_id));
REVOKE ALL ON clockgrove.effect_intents,clockgrove.effect_attempts FROM PUBLIC,clockgrove_runtime;
GRANT SELECT ON clockgrove.effect_intents,clockgrove.effect_attempts TO clockgrove_runtime;
CREATE TRIGGER effect_intents_no_delete BEFORE DELETE OR TRUNCATE ON clockgrove.effect_intents
  FOR EACH STATEMENT EXECUTE FUNCTION clockgrove.reject_journal_mutation();
CREATE TRIGGER effect_attempts_no_delete BEFORE DELETE OR TRUNCATE ON clockgrove.effect_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION clockgrove.reject_journal_mutation();
