-- Internal private delivery boundary. Message-unit limits are recipient-authorized lifetime
-- capacity, not money. Reservations are never refunded: retries and uncertain dispatch cannot
-- spend the same unit twice. Canonical content remains in encrypted conversation artifacts.
CREATE FUNCTION clockgrove.runtime_delivery_authorized(t text,w text,tl text,s text,p text,a text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,clockgrove AS $$
  SELECT EXISTS (SELECT 1 FROM clockgrove.conversation_sessions cs
    JOIN clockgrove.conversation_participants cp USING (tenant_id,session_id)
    JOIN clockgrove.world_memberships m ON m.tenant_id=cs.tenant_id AND m.world_id=cs.world_id
      AND m.timeline_id=cs.timeline_id AND m.space_id=cs.space_id AND m.principal_id=cp.principal_id
    WHERE cs.tenant_id=t AND cs.world_id=w AND cs.timeline_id=tl AND (s IS NULL OR cs.space_id=s)
      AND cs.actor_id=a AND cp.principal_id=p AND cs.state<>'deleted'
      AND m.revoked_at IS NULL AND 'runtime:world-observe'=ANY(m.grants)
      AND m.privacy_ceiling->'allowedCategories' ? 'conversation')
$$;
REVOKE ALL ON FUNCTION clockgrove.runtime_delivery_authorized(text,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clockgrove.runtime_delivery_authorized(text,text,text,text,text,text) TO clockgrove_runtime;

CREATE TABLE clockgrove.delivery_consent (
  tenant_id text NOT NULL, world_id text NOT NULL, timeline_id text NOT NULL,
  space_id text NOT NULL, actor_id text NOT NULL, principal_id text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  timezone text NOT NULL,
  quiet_start integer CHECK (quiet_start BETWEEN 0 AND 1439),
  quiet_end integer CHECK (quiet_end BETWEEN 0 AND 1439),
  version integer NOT NULL CHECK (version > 0),
  budget_limit bigint NOT NULL CHECK (budget_limit >= 0 AND budget_limit <= 9007199254740991),
  reserved_units bigint NOT NULL DEFAULT 0 CHECK (reserved_units BETWEEN 0 AND budget_limit),
  CHECK ((quiet_start IS NULL) = (quiet_end IS NULL)),
  PRIMARY KEY (tenant_id,world_id,timeline_id,actor_id,principal_id),
  FOREIGN KEY (tenant_id,world_id,timeline_id) REFERENCES clockgrove.timelines (tenant_id,world_id,timeline_id),
  FOREIGN KEY (tenant_id,principal_id) REFERENCES clockgrove.tenant_principals (tenant_id,principal_id)
);
CREATE TABLE clockgrove.deliveries (
  tenant_id text NOT NULL, world_id text NOT NULL, timeline_id text NOT NULL,
  space_id text NOT NULL, actor_id text NOT NULL, principal_id text NOT NULL,
  session_id text NOT NULL, dedupe_key text NOT NULL CHECK (octet_length(dedupe_key) BETWEEN 1 AND 1024),
  reservation_id text NOT NULL CHECK (octet_length(reservation_id) BETWEEN 1 AND 1024),
  reserved_units bigint NOT NULL CHECK (reserved_units BETWEEN 0 AND 9007199254740991),
  content_artifact_id text NOT NULL,
  privacy_class text NOT NULL DEFAULT 'conversation' CHECK (privacy_class='conversation'),
  -- Decision: 16 KiB bounds metadata-only envelopes; content stays in encrypted artifacts.
  request jsonb NOT NULL CHECK (octet_length(request::text) <= 16384),
  receipt jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('reserved','approved','delayed','downgraded','rejected')),
  PRIMARY KEY (tenant_id,world_id,timeline_id,actor_id,principal_id,dedupe_key),
  UNIQUE (tenant_id,world_id,timeline_id,actor_id,principal_id,reservation_id),
  FOREIGN KEY (tenant_id,world_id,timeline_id,session_id) REFERENCES clockgrove.conversation_sessions (tenant_id,world_id,timeline_id,session_id),
  FOREIGN KEY (tenant_id,content_artifact_id,privacy_class) REFERENCES clockgrove.artifact_references (tenant_id,artifact_id,privacy_class),
  CHECK ((request->>'actorId'=actor_id AND request->>'sessionId'=session_id
    AND request->>'recipientPrincipalId'=principal_id AND request->>'dedupeKey'=dedupe_key
    AND request->>'contentArtifactId'=content_artifact_id AND request->>'privacyClass'=privacy_class
    AND request->'scope'->>'tenantId'=tenant_id AND request->'scope'->>'worldId'=world_id
    AND request->'scope'->>'timelineId'=timeline_id AND request->'scope'->>'spaceId'=space_id
    AND request->'budgetReservation'->>'id'=reservation_id
    AND receipt->'request'=request AND receipt->>'status'=status
    AND (receipt->>'reservedUnits')::bigint=reserved_units) IS TRUE)
);
CREATE TABLE clockgrove.delivery_sink_receipts (
  tenant_id text NOT NULL, world_id text NOT NULL, timeline_id text NOT NULL,
  space_id text NOT NULL, actor_id text NOT NULL, principal_id text NOT NULL,
  dedupe_key text NOT NULL,
  sink text NOT NULL CHECK (sink IN ('fake','preview')),
  content_artifact_id text NOT NULL,
  PRIMARY KEY (tenant_id,world_id,timeline_id,actor_id,principal_id,dedupe_key),
  FOREIGN KEY (tenant_id,world_id,timeline_id,actor_id,principal_id,dedupe_key)
    REFERENCES clockgrove.deliveries (tenant_id,world_id,timeline_id,actor_id,principal_id,dedupe_key)
);

DO $$ DECLARE n text; authorization_space text; BEGIN
  FOREACH n IN ARRAY ARRAY['delivery_consent','deliveries','delivery_sink_receipts'] LOOP
    -- Consent follows its actor/recipient key across spaces; deliveries retain exact space scope.
    authorization_space:=CASE WHEN n='delivery_consent' THEN 'NULL::text' ELSE 'space_id' END;
    EXECUTE format('ALTER TABLE clockgrove.%I ENABLE ROW LEVEL SECURITY',n);
    EXECUTE format('ALTER TABLE clockgrove.%I FORCE ROW LEVEL SECURITY',n);
    EXECUTE format('CREATE POLICY recipient_isolation ON clockgrove.%I
      USING (clockgrove.runtime_can_access(tenant_id,''conversation'') AND principal_id=clockgrove.runtime_principal_id()
        AND clockgrove.runtime_delivery_authorized(tenant_id,world_id,timeline_id,%s,principal_id,actor_id))
      WITH CHECK (clockgrove.runtime_can_access(tenant_id,''conversation'') AND principal_id=clockgrove.runtime_principal_id()
        AND clockgrove.runtime_delivery_authorized(tenant_id,world_id,timeline_id,%s,principal_id,actor_id))',n,authorization_space,authorization_space);
    EXECUTE format('REVOKE ALL ON clockgrove.%I FROM PUBLIC',n);
    EXECUTE format('GRANT SELECT,INSERT ON clockgrove.%I TO clockgrove_runtime',n);
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE OR TRUNCATE ON clockgrove.%I
      FOR EACH STATEMENT EXECUTE FUNCTION clockgrove.reject_journal_mutation()',n||'_no_delete',n);
  END LOOP;
END $$;
GRANT UPDATE (enabled,timezone,quiet_start,quiet_end,version,budget_limit) ON clockgrove.delivery_consent TO clockgrove_runtime;
GRANT UPDATE (receipt,status) ON clockgrove.deliveries TO clockgrove_runtime;

CREATE FUNCTION clockgrove.guard_delivery_consent() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,clockgrove AS $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name=NEW.timezone) THEN
    RAISE EXCEPTION 'invalid recipient timezone'; END IF;
  IF TG_OP='UPDATE' AND (NEW.reserved_units<OLD.reserved_units
    OR (NEW.enabled,NEW.timezone,NEW.quiet_start,NEW.quiet_end,NEW.budget_limit)
      IS DISTINCT FROM (OLD.enabled,OLD.timezone,OLD.quiet_start,OLD.quiet_end,OLD.budget_limit)
      AND NEW.version<>OLD.version+1
    OR NEW.version<OLD.version OR NEW.version>OLD.version+1) THEN
    RAISE EXCEPTION 'delivery consent version or reservation regressed'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION clockgrove.guard_delivery_consent() FROM PUBLIC;
CREATE TRIGGER delivery_consent_guard BEFORE INSERT OR UPDATE ON clockgrove.delivery_consent
  FOR EACH ROW EXECUTE FUNCTION clockgrove.guard_delivery_consent();

CREATE FUNCTION clockgrove.guard_delivery_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,clockgrove AS $$ DECLARE units bigint; BEGIN
  IF TG_OP='UPDATE' AND (to_jsonb(NEW)-'receipt'-'status') IS DISTINCT FROM (to_jsonb(OLD)-'receipt'-'status') THEN
    RAISE EXCEPTION 'delivery request and reservation are immutable'; END IF;
  IF TG_OP='UPDATE' AND NOT (OLD.status='reserved' AND NEW.status IN ('approved','delayed','downgraded','rejected')
    OR OLD.status='delayed' AND NEW.status IN ('approved','downgraded','rejected')) THEN
    RAISE EXCEPTION 'delivery decision is terminal or still waiting'; END IF;
  IF NOT EXISTS (SELECT 1 FROM clockgrove.conversation_sessions cs
    JOIN clockgrove.channel_bindings cb USING (tenant_id,session_id)
    JOIN clockgrove.artifact_references ar ON ar.tenant_id=cs.tenant_id AND ar.artifact_id=NEW.content_artifact_id
    WHERE cs.tenant_id=NEW.tenant_id AND cs.world_id=NEW.world_id AND cs.timeline_id=NEW.timeline_id
      AND cs.space_id=NEW.space_id AND cs.actor_id=NEW.actor_id AND cs.session_id=NEW.session_id
      AND cs.state<>'deleted' AND cb.principal_id=NEW.principal_id
      AND cb.channel=NEW.request->'channelBinding'->>'channel'
      AND cb.thread_id=NEW.request->'channelBinding'->>'threadId'
      AND ar.world_id=NEW.world_id AND ar.timeline_id=NEW.timeline_id AND ar.space_id=NEW.space_id
      AND ar.privacy_class='conversation' AND ar.encryption='aes-256-gcm-v1'
      AND EXISTS (SELECT 1 FROM clockgrove.conversation_messages cm WHERE cm.tenant_id=NEW.tenant_id
        AND cm.session_id=NEW.session_id AND cm.role='actor' AND cm.author_id=NEW.actor_id
        AND cm.content_artifact_id=NEW.content_artifact_id)) THEN
    RAISE EXCEPTION 'delivery target or encrypted content invalid'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'reserved' OR NEW.reserved_units<>0 THEN RAISE EXCEPTION 'delivery must reserve first'; END IF;
    units:=(NEW.request->'budgetReservation'->>'units')::bigint;
    IF units IS NULL OR units<=0 OR units>9007199254740991 THEN RAISE EXCEPTION 'invalid reservation units'; END IF;
    UPDATE clockgrove.delivery_consent SET reserved_units=reserved_units+units
      WHERE tenant_id=NEW.tenant_id AND world_id=NEW.world_id AND timeline_id=NEW.timeline_id
        AND actor_id=NEW.actor_id AND principal_id=NEW.principal_id AND reserved_units<=budget_limit-units;
    IF FOUND THEN NEW.reserved_units:=units; END IF;
    NEW.receipt:=jsonb_set(NEW.receipt,'{reservedUnits}',to_jsonb(NEW.reserved_units));
  END IF;
  IF NEW.status NOT IN ('rejected','reserved') AND NEW.reserved_units<=0 THEN
    RAISE EXCEPTION 'delivery requires budget reservation'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION clockgrove.guard_delivery_record() FROM PUBLIC;
CREATE TRIGGER delivery_record_guard BEFORE INSERT OR UPDATE ON clockgrove.deliveries
  FOR EACH ROW EXECUTE FUNCTION clockgrove.guard_delivery_record();

CREATE FUNCTION clockgrove.guard_delivery_sink() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,clockgrove AS $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM clockgrove.deliveries d
    JOIN clockgrove.timelines t USING (tenant_id,world_id,timeline_id)
    JOIN clockgrove.delivery_consent c USING (tenant_id,world_id,timeline_id,actor_id,principal_id)
    WHERE d.tenant_id=NEW.tenant_id AND d.world_id=NEW.world_id AND d.timeline_id=NEW.timeline_id
      AND d.space_id=NEW.space_id AND d.actor_id=NEW.actor_id AND d.principal_id=NEW.principal_id
      AND d.dedupe_key=NEW.dedupe_key AND d.content_artifact_id=NEW.content_artifact_id
      AND d.status IN ('approved','downgraded') AND d.reserved_units>0
      AND d.request->>'policyVersion'='delivery-policy-v1'
      AND c.enabled AND c.version=(d.request->>'consentVersion')::integer
      AND c.reserved_units>=d.reserved_units
      AND NEW.sink=CASE WHEN t.kind='live' THEN 'fake' ELSE 'preview' END
      AND d.receipt->>'sink'=NEW.sink) THEN
    RAISE EXCEPTION 'delivery sink requires approved reserved current policy'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION clockgrove.guard_delivery_sink() FROM PUBLIC;
CREATE TRIGGER delivery_sink_guard BEFORE INSERT ON clockgrove.delivery_sink_receipts
  FOR EACH ROW EXECUTE FUNCTION clockgrove.guard_delivery_sink();
CREATE TRIGGER delivery_sink_immutable BEFORE UPDATE OR DELETE ON clockgrove.delivery_sink_receipts
  FOR EACH ROW EXECUTE FUNCTION clockgrove.reject_journal_mutation();

-- A draft reservation is transaction-local work, never a committed historical decision.
CREATE FUNCTION clockgrove.require_delivery_decision() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,clockgrove AS $$ BEGIN
  IF EXISTS (SELECT 1 FROM clockgrove.deliveries d WHERE d.tenant_id=NEW.tenant_id
    AND d.world_id=NEW.world_id AND d.timeline_id=NEW.timeline_id AND d.actor_id=NEW.actor_id
    AND d.principal_id=NEW.principal_id AND d.dedupe_key=NEW.dedupe_key AND d.status='reserved') THEN
    RAISE EXCEPTION 'delivery reservation must have a decision'; END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION clockgrove.require_delivery_decision() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER delivery_requires_decision AFTER INSERT ON clockgrove.deliveries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION clockgrove.require_delivery_decision();
