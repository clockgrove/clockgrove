-- Decision (issue 58): one policy row per actor, at most 64 configurations and 1,000 causal
-- receipts in its lifetime. Refuse overflow rather than forget a causal root and execute it again.
CREATE TABLE clockgrove.actor_activation_policies (
  tenant_id text NOT NULL,
  world_id text NOT NULL,
  timeline_id text NOT NULL,
  space_id text NOT NULL,
  actor_id text NOT NULL CHECK (octet_length(actor_id) BETWEEN 1 AND 1024),
  principal_id text NOT NULL,
  configurations jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(configurations) = 'array'
    AND jsonb_array_length(configurations) <= 64 AND octet_length(configurations::text) <= 1048576),
  allow_model boolean NOT NULL DEFAULT false,
  model_budget integer NOT NULL DEFAULT 0 CHECK (model_budget BETWEEN 0 AND 1000),
  model_calls_reserved integer NOT NULL DEFAULT 0 CHECK (model_calls_reserved BETWEEN 0 AND 1000),
  event_cursor bigint NOT NULL DEFAULT 0 CHECK (event_cursor >= 0),
  receipt_count integer NOT NULL DEFAULT 0 CHECK (receipt_count BETWEEN 0 AND 1000),
  PRIMARY KEY (tenant_id, world_id, timeline_id, actor_id)
);
CREATE TABLE clockgrove.actor_activations (
  tenant_id text NOT NULL,
  world_id text NOT NULL,
  timeline_id text NOT NULL,
  space_id text NOT NULL,
  actor_id text NOT NULL,
  causal_root text NOT NULL CHECK (octet_length(causal_root) BETWEEN 1 AND 1024),
  activation_id text NOT NULL CHECK (octet_length(activation_id) BETWEEN 1 AND 128),
  principal_id text NOT NULL,
  configuration_id text NOT NULL CHECK (octet_length(configuration_id) BETWEEN 1 AND 128),
  reason jsonb NOT NULL CHECK (octet_length(reason::text) <= 4096),
  evidence text NOT NULL CHECK (octet_length(evidence) <= 8192),
  session_id text NOT NULL,
  message_id text NOT NULL,
  input text NOT NULL CHECK (octet_length(input) <= 1024),
  leader boolean NOT NULL DEFAULT true,
  has_reservation boolean NOT NULL DEFAULT false,
  model_epoch bigint NOT NULL DEFAULT 0 CHECK (model_epoch >= 0),
  status text NOT NULL CHECK (status IN ('pending', 'completed', 'noop', 'deferred')),
  outcome text NOT NULL CHECK (octet_length(outcome) <= 128),
  PRIMARY KEY (tenant_id, world_id, timeline_id, actor_id, causal_root),
  FOREIGN KEY (tenant_id, world_id, timeline_id, actor_id)
    REFERENCES clockgrove.actor_activation_policies (tenant_id, world_id, timeline_id, actor_id),
  FOREIGN KEY (tenant_id, session_id) REFERENCES clockgrove.conversation_sessions (tenant_id, session_id)
);
CREATE INDEX actor_activations_pending ON clockgrove.actor_activations
  (tenant_id, world_id, timeline_id, actor_id) WHERE status = 'pending';
-- Scheduled work must still hold the configuring principal's live world grant. In particular,
-- persisting a callback cannot preserve authority after membership revocation.
CREATE FUNCTION clockgrove.runtime_activation_authorized(t text, w text, tl text, s text, p text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, clockgrove AS $$
  SELECT EXISTS (SELECT 1 FROM clockgrove.world_memberships m
    WHERE m.tenant_id=t AND m.world_id=w AND m.timeline_id=tl AND m.space_id=s AND m.principal_id=p
      AND m.revoked_at IS NULL AND 'runtime:world-command'=ANY(m.grants)
      AND m.privacy_ceiling->'allowedCategories' ? 'conversation')
$$;
REVOKE ALL ON FUNCTION clockgrove.runtime_activation_authorized(text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clockgrove.runtime_activation_authorized(text,text,text,text,text) TO clockgrove_runtime;

DO $$
DECLARE name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['actor_activation_policies', 'actor_activations'] LOOP
    EXECUTE format('ALTER TABLE clockgrove.%I ENABLE ROW LEVEL SECURITY', name);
    EXECUTE format('ALTER TABLE clockgrove.%I FORCE ROW LEVEL SECURITY', name);
    EXECUTE format('CREATE POLICY participant_isolation ON clockgrove.%I
      USING (clockgrove.runtime_can_access(tenant_id, ''conversation'')
             AND principal_id = clockgrove.runtime_principal_id()
             AND clockgrove.runtime_activation_authorized(tenant_id,world_id,timeline_id,space_id,principal_id))
      WITH CHECK (clockgrove.runtime_can_access(tenant_id, ''conversation'')
                  AND principal_id = clockgrove.runtime_principal_id()
             AND clockgrove.runtime_activation_authorized(tenant_id,world_id,timeline_id,space_id,principal_id))', name);
    EXECUTE format('REVOKE ALL ON clockgrove.%I FROM PUBLIC', name);
    EXECUTE format('GRANT SELECT, INSERT ON clockgrove.%I TO clockgrove_runtime', name);
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE OR TRUNCATE ON clockgrove.%I
      FOR EACH STATEMENT EXECUTE FUNCTION clockgrove.reject_journal_mutation()', name || '_no_delete', name);
  END LOOP;
END $$;
GRANT UPDATE (configurations, allow_model, model_budget, model_calls_reserved, receipt_count, event_cursor)
  ON clockgrove.actor_activation_policies TO clockgrove_runtime;
GRANT UPDATE (status, outcome) ON clockgrove.actor_activations TO clockgrove_runtime;

-- A database-side counter serializes every receipt, including direct SQL writes.
CREATE FUNCTION clockgrove.guard_actor_activation() RETURNS trigger
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
  UPDATE clockgrove.actor_activation_policies SET receipt_count = receipt_count + 1
    WHERE tenant_id = NEW.tenant_id AND world_id = NEW.world_id AND timeline_id = NEW.timeline_id
      AND actor_id = NEW.actor_id AND principal_id = NEW.principal_id AND space_id=NEW.space_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'activation policy not found'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION clockgrove.guard_actor_activation() FROM PUBLIC;
CREATE TRIGGER actor_activations_bound BEFORE INSERT ON clockgrove.actor_activations
  FOR EACH ROW EXECUTE FUNCTION clockgrove.guard_actor_activation();

CREATE FUNCTION clockgrove.guard_activation_status() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, clockgrove AS $$
BEGIN
  IF NOT ((OLD.status IN ('pending','deferred') AND NEW.status IN ('pending','deferred','noop','completed'))
    OR (OLD.status='noop' AND NEW.status='noop')) THEN
    RAISE EXCEPTION 'activation decision is terminal';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION clockgrove.guard_activation_status() FROM PUBLIC;
CREATE TRIGGER actor_activations_terminal BEFORE UPDATE ON clockgrove.actor_activations
  FOR EACH ROW EXECUTE FUNCTION clockgrove.guard_activation_status();

-- Recheck live authority, policy and the compiled decision at the actual model boundary. A
-- reservation is per model opportunity: recovery after an interrupted model call needs another.
CREATE FUNCTION clockgrove.activation_model_gate(t text,w text,tl text,a text,p text,sid text,mid text,epoch bigint)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,clockgrove AS $$
DECLARE r clockgrove.actor_activations%ROWTYPE;
DECLARE policy clockgrove.actor_activation_policies%ROWTYPE;
DECLARE config jsonb;
DECLARE decision text := 'pending';
DECLARE why text := 'admitted';
DECLARE reserve boolean;
BEGIN
  IF NOT clockgrove.runtime_can_access(t, 'conversation')
    OR t IS DISTINCT FROM current_setting('app.tenant_id',true)
    OR p IS DISTINCT FROM clockgrove.runtime_principal_id() THEN RAISE EXCEPTION 'activation principal mismatch'; END IF;
  SELECT * INTO r FROM clockgrove.actor_activations WHERE tenant_id=t AND world_id=w
    AND timeline_id=tl AND actor_id=a AND session_id=sid AND message_id=mid AND principal_id=p
    ORDER BY leader DESC, causal_root LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO policy FROM clockgrove.actor_activation_policies WHERE tenant_id=t AND world_id=w
    AND timeline_id=tl AND actor_id=a AND principal_id=p FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'activation policy not found'; END IF;
  IF r.status IN ('noop','completed') THEN RETURN r.status; END IF;
  IF NOT EXISTS (SELECT 1 FROM clockgrove.conversation_turn_fibers f WHERE f.tenant_id=t
    AND f.session_id=sid AND f.message_id=mid AND f.lease_epoch=epoch AND f.phase='model_running') THEN
    RAISE EXCEPTION 'activation lease moved';
  END IF;
  SELECT value INTO config FROM jsonb_array_elements(policy.configurations) WHERE value->>'id'=r.configuration_id;
  IF NOT clockgrove.runtime_activation_authorized(t,w,tl,policy.space_id,p)
     OR NOT policy.allow_model OR coalesce((config->>'enabled')::boolean,false)=false THEN
    decision := 'deferred'; why := 'policy_denied';
  ELSIF config->>'compiledRoutine'='noop' THEN decision := 'noop'; why := 'compiled_noop';
  END IF;
  reserve := NOT r.has_reservation OR (r.model_epoch > 0 AND r.model_epoch <> epoch);
  IF decision='pending' AND reserve AND policy.model_calls_reserved >= policy.model_budget THEN
    decision := 'deferred'; why := 'budget_exhausted';
  END IF;
  IF decision='pending' THEN
    IF reserve THEN UPDATE clockgrove.actor_activation_policies SET model_calls_reserved=model_calls_reserved+1
      WHERE tenant_id=t AND world_id=w AND timeline_id=tl AND actor_id=a; END IF;
    UPDATE clockgrove.actor_activations SET status='pending',outcome=why,has_reservation=true,model_epoch=epoch
      WHERE tenant_id=t AND world_id=w AND timeline_id=tl AND actor_id=a AND activation_id=r.activation_id;
  ELSE
    IF decision='noop' THEN
      UPDATE clockgrove.actor_activation_policies SET configurations=(
        SELECT jsonb_agg(CASE WHEN value->>'id'=r.configuration_id
          THEN value || '{"enabled":false,"nextWakeAt":null}'::jsonb ELSE value END)
        FROM jsonb_array_elements(policy.configurations)
      ) WHERE tenant_id=t AND world_id=w AND timeline_id=tl AND actor_id=a;
    END IF;
    UPDATE clockgrove.actor_activations SET status=decision,outcome=why
      WHERE tenant_id=t AND world_id=w AND timeline_id=tl AND actor_id=a AND activation_id=r.activation_id;
  END IF;
  RETURN decision;
END $$;
REVOKE ALL ON FUNCTION clockgrove.activation_model_gate(text,text,text,text,text,text,text,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clockgrove.activation_model_gate(text,text,text,text,text,text,text,bigint) TO clockgrove_runtime;
