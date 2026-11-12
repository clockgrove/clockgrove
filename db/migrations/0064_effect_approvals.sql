-- Internal foundation for issue 166; no runtime approval writer is exposed.
-- Identity bounds follow the effect ledger; ten-minute expiry is the owner's default.
CREATE TABLE clockgrove.effect_approvals (
  tenant_id text NOT NULL, world_id text NOT NULL, timeline_id text NOT NULL,
  space_id text NOT NULL,
  approval_id text NOT NULL CHECK (octet_length(approval_id) BETWEEN 1 AND 1024),
  effect_id text NOT NULL CHECK (octet_length(effect_id) BETWEEN 1 AND 1024),
  principal_id text NOT NULL, approver_principal_id text NOT NULL,
  arguments_hash text NOT NULL CHECK (arguments_hash ~ '^[a-f0-9]{64}$'),
  effect_hash text NOT NULL CHECK (effect_hash ~ '^[a-f0-9]{64}$'),
  arguments_artifact_id text,
  privacy_class text NOT NULL DEFAULT 'conversation' CHECK (privacy_class='conversation'),
  expiry_seconds integer NOT NULL DEFAULT 600 CHECK (expiry_seconds>0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','approved','denied','revoked','expired','consumed')),
  decision text CHECK (decision IN ('approved','denied')),
  decided_by text, decided_at timestamptz,
  revoked_by text, revoked_at timestamptz,
  consumed_by text, consumed_at timestamptz,
  PRIMARY KEY (tenant_id,world_id,timeline_id,approval_id),
  FOREIGN KEY (tenant_id,world_id,timeline_id) REFERENCES clockgrove.timelines(tenant_id,world_id,timeline_id),
  FOREIGN KEY (tenant_id,principal_id) REFERENCES clockgrove.tenant_principals(tenant_id,principal_id),
  FOREIGN KEY (tenant_id,approver_principal_id) REFERENCES clockgrove.tenant_principals(tenant_id,principal_id),
  FOREIGN KEY (tenant_id,arguments_artifact_id,privacy_class) REFERENCES clockgrove.artifact_references(tenant_id,artifact_id,privacy_class),
  CHECK (isfinite(created_at) AND isfinite(expires_at) AND expires_at=created_at+expiry_seconds*interval '1 second'),
  CHECK ((decision IS NULL AND decided_by IS NULL AND decided_at IS NULL) OR
    (decision IS NOT NULL AND decided_by IS NOT NULL AND decided_by=approver_principal_id AND decided_at IS NOT NULL AND
      isfinite(decided_at) AND decided_at>=created_at AND decided_at<expires_at)),
  CHECK (((state='pending' AND decision IS NULL) OR (state IN ('approved','consumed') AND decision='approved') OR
    (state='denied' AND decision='denied') OR (state IN ('revoked','expired') AND (decision IS NULL OR decision='approved'))) IS TRUE),
  CHECK ((state='revoked' AND revoked_by IS NOT NULL AND revoked_by=approver_principal_id AND revoked_at IS NOT NULL AND
    isfinite(revoked_at) AND revoked_at>=created_at AND revoked_at<expires_at) OR
    (state<>'revoked' AND revoked_by IS NULL AND revoked_at IS NULL)),
  CHECK ((state='consumed' AND consumed_by IS NOT NULL AND consumed_by=principal_id AND consumed_at IS NOT NULL AND
    isfinite(consumed_at) AND consumed_at>=decided_at AND consumed_at<expires_at) OR
    (state<>'consumed' AND consumed_by IS NULL AND consumed_at IS NULL))
);
CREATE FUNCTION clockgrove.guard_effect_approval() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,clockgrove AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'pending' OR NEW.decision IS NOT NULL THEN
      RAISE EXCEPTION 'approval must begin pending' USING ERRCODE='22023';
    END IF;
    NEW.created_at:=clock_timestamp();
    NEW.expires_at:=NEW.created_at+NEW.expiry_seconds*interval '1 second';
  ELSE
    IF (to_jsonb(NEW)-ARRAY['state','decision','decided_by','decided_at','revoked_by','revoked_at','consumed_by','consumed_at'])
      IS DISTINCT FROM
      (to_jsonb(OLD)-ARRAY['state','decision','decided_by','decided_at','revoked_by','revoked_at','consumed_by','consumed_at']) OR
      NOT (OLD.state='pending' AND NEW.state IN ('approved','denied','revoked','expired') OR
           OLD.state='approved' AND NEW.state IN ('revoked','expired','consumed')) THEN
      RAISE EXCEPTION 'approval identity or terminal state is immutable' USING ERRCODE='22023';
    END IF;
    IF NEW.state IN ('approved','denied') THEN
      NEW.decision:=NEW.state;
      NEW.decided_at:=clock_timestamp();
    ELSIF ROW(NEW.decision,NEW.decided_by,NEW.decided_at) IS DISTINCT FROM ROW(OLD.decision,OLD.decided_by,OLD.decided_at) THEN
      RAISE EXCEPTION 'approval decision is immutable' USING ERRCODE='22023';
    END IF;
    IF NEW.state='revoked' THEN NEW.revoked_at:=clock_timestamp(); END IF;
    IF NEW.state='consumed' THEN NEW.consumed_at:=clock_timestamp(); END IF;
    IF NEW.state='expired' AND clock_timestamp()<OLD.expires_at THEN
      RAISE EXCEPTION 'approval has not expired' USING ERRCODE='22023';
    END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM clockgrove.timeline_partitions p WHERE p.tenant_id=NEW.tenant_id
    AND p.world_id=NEW.world_id AND p.timeline_id=NEW.timeline_id AND p.space_id=NEW.space_id) THEN
    RAISE EXCEPTION 'approval scope unavailable' USING ERRCODE='22023';
  END IF;
  IF NEW.state IN ('approved','consumed') AND NOT EXISTS (SELECT 1 FROM clockgrove.timelines t
    WHERE t.tenant_id=NEW.tenant_id AND t.world_id=NEW.world_id AND t.timeline_id=NEW.timeline_id AND t.kind='live') THEN
    RAISE EXCEPTION 'preview cannot authorize effects' USING ERRCODE='CG012';
  END IF;
  IF NEW.arguments_artifact_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM clockgrove.artifact_references a
    WHERE a.tenant_id=NEW.tenant_id AND a.artifact_id=NEW.arguments_artifact_id AND a.world_id=NEW.world_id
      AND a.timeline_id=NEW.timeline_id AND a.space_id=NEW.space_id AND a.privacy_class='conversation'
      AND a.encryption='aes-256-gcm-v1') THEN
    RAISE EXCEPTION 'approval arguments require scoped encrypted artifact' USING ERRCODE='22023';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION clockgrove.guard_effect_approval() FROM PUBLIC;
CREATE TRIGGER effect_approval_guard BEFORE INSERT OR UPDATE ON clockgrove.effect_approvals
  FOR EACH ROW EXECUTE FUNCTION clockgrove.guard_effect_approval();
CREATE TRIGGER effect_approvals_no_delete BEFORE DELETE OR TRUNCATE ON clockgrove.effect_approvals
  FOR EACH STATEMENT EXECUTE FUNCTION clockgrove.reject_journal_mutation();
ALTER TABLE clockgrove.effect_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE clockgrove.effect_approvals FORCE ROW LEVEL SECURITY;
CREATE POLICY effect_approval_operator ON clockgrove.effect_approvals FOR SELECT USING (
  clockgrove.mcp_install_authorized(tenant_id,world_id,timeline_id,space_id));
REVOKE ALL ON clockgrove.effect_approvals FROM PUBLIC,clockgrove_runtime;
GRANT SELECT ON clockgrove.effect_approvals TO clockgrove_runtime;
