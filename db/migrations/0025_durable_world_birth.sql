-- One launch record per canonical case. The run identity and the small authorized request header
-- are permanent case evidence. The pack source is held only while the case is open: its tree, with
-- each byte string replaced by its [offset, length], and the bytes themselves stored once as bytea.
-- Terminal cases release both; installed bytes stay in pack_artifact_resources.
ALTER TABLE clockgrove_birth.provisioning_cases
  ADD COLUMN workflow_run_id text,
  ADD COLUMN workflow_request_hash text CHECK (workflow_request_hash ~ '^[0-9a-f]{64}$'),
  ADD COLUMN workflow_request jsonb,
  ADD COLUMN workflow_source jsonb,
  ADD COLUMN workflow_source_bytes bytea,
  -- Set only by the scheduled reconcile when it picks the case, so it rotates past failing cases.
  ADD COLUMN reconcile_attempted_at timestamptz,
  ADD CONSTRAINT workflow_registration_complete CHECK (
    (workflow_run_id IS NULL AND workflow_request_hash IS NULL AND workflow_request IS NULL)
    OR (workflow_run_id IS NOT NULL AND workflow_request_hash IS NOT NULL AND workflow_request IS NOT NULL)
  ),
  -- Present exactly while a registered case is open.
  ADD CONSTRAINT workflow_source_open CHECK (
    (workflow_source IS NULL) = (workflow_source_bytes IS NULL)
    AND (workflow_source IS NULL) = (workflow_run_id IS NULL OR status IN ('ready', 'failed'))
  ),
  -- Bytes: 128 MB Workers memory limit / 6 copies at the read peak (hex wire data 2, hex text 2,
  -- parsed bytes 1, decoded resources 1), rounded down to 21 MiB; registration refuses larger packs.
  -- Tree: decision, the SDK's 1 MiB per-document limit; it holds only the manifest and byte references.
  ADD CONSTRAINT workflow_source_bounded CHECK (
    octet_length(workflow_source_bytes) <= 22020096
    AND octet_length(workflow_source::text) <= 1048576
  ),
  ADD CONSTRAINT workflow_run_identity UNIQUE (workflow_run_id);

CREATE FUNCTION clockgrove_birth.guard_workflow_registration() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  -- The only change to a registered source: a terminal case releases it.
  IF NEW.status IN ('ready', 'failed') THEN
    NEW.workflow_source := NULL;
    NEW.workflow_source_bytes := NULL;
  END IF;
  IF OLD.workflow_run_id IS NOT NULL AND (
    NEW.workflow_run_id IS DISTINCT FROM OLD.workflow_run_id
    OR NEW.workflow_request_hash IS DISTINCT FROM OLD.workflow_request_hash
    OR NEW.workflow_request IS DISTINCT FROM OLD.workflow_request
    OR (NEW.status NOT IN ('ready', 'failed') AND (
      NEW.workflow_source IS DISTINCT FROM OLD.workflow_source
      OR NEW.workflow_source_bytes IS DISTINCT FROM OLD.workflow_source_bytes))
  ) THEN
    RAISE EXCEPTION 'workflow registration is immutable' USING ERRCODE = 'CG006';
  END IF;
  -- The cron stamp exists only on registered open cases (terminal ones never update) and only advances.
  IF NEW.reconcile_attempted_at IS DISTINCT FROM OLD.reconcile_attempted_at AND (
    OLD.workflow_run_id IS NULL OR NEW.reconcile_attempted_at IS NULL
    OR NEW.reconcile_attempted_at < OLD.reconcile_attempted_at
  ) THEN
    RAISE EXCEPTION 'reconcile stamp only advances on registered cases' USING ERRCODE = 'CG006';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER provisioning_workflow_registration_guard
  BEFORE UPDATE ON clockgrove_birth.provisioning_cases
  FOR EACH ROW EXECUTE FUNCTION clockgrove_birth.guard_workflow_registration();

-- Trusted orchestration may retrieve only the already registered request matching all three keys.
-- This routine creates no rows and grants no independent provisioning or readiness capability.
CREATE FUNCTION clockgrove_birth.read_workflow_request(p_tenant_id text, p_case_id text, p_run_id text)
RETURNS TABLE (request jsonb, request_hash text, source jsonb, source_bytes bytea)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog AS $$
  SELECT provisioning_case.workflow_request, provisioning_case.workflow_request_hash,
         provisioning_case.workflow_source, provisioning_case.workflow_source_bytes
    FROM clockgrove_birth.provisioning_cases AS provisioning_case
   WHERE provisioning_case.tenant_id = p_tenant_id
     AND provisioning_case.case_id = p_case_id
     AND provisioning_case.workflow_run_id = p_run_id;
$$;
REVOKE ALL ON FUNCTION clockgrove_birth.read_workflow_request(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clockgrove_birth.read_workflow_request(text, text, text) TO clockgrove_runtime;

-- Scheduled recovery finds open registered cases across tenants; it returns only lookup keys, so the
-- request itself still comes through read_workflow_request and the case's own authorization.
-- A case whose last attempt hit a deterministic genesis defect waits for an operator or a code fix
-- (manual reconcile still retries it). Picking a case stamps reconcile_attempted_at, so a case that
-- fails before any attempt cannot hold the head: untouched cases first, then least recently picked.
CREATE INDEX provisioning_cases_open_workflows
  ON clockgrove_birth.provisioning_cases (reconcile_attempted_at NULLS FIRST, updated_at, tenant_id, case_id)
  WHERE workflow_run_id IS NOT NULL AND status IN ('requested', 'seeding', 'verified')
    AND (last_failure->>'code') IS DISTINCT FROM 'WorldGenesisDefectError';
CREATE FUNCTION clockgrove_birth.open_workflow_cases(p_limit integer)
RETURNS TABLE (tenant_id text, case_id text, workflow_run_id text)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog AS $$
  UPDATE clockgrove_birth.provisioning_cases AS provisioning_case
     SET reconcile_attempted_at = statement_timestamp()
   WHERE (provisioning_case.tenant_id, provisioning_case.case_id) IN (
     SELECT candidate.tenant_id, candidate.case_id
       FROM clockgrove_birth.provisioning_cases AS candidate
      WHERE candidate.workflow_run_id IS NOT NULL
        AND candidate.status IN ('requested', 'seeding', 'verified')
        AND (candidate.last_failure->>'code') IS DISTINCT FROM 'WorldGenesisDefectError'
      ORDER BY candidate.reconcile_attempted_at NULLS FIRST, candidate.updated_at,
               candidate.tenant_id, candidate.case_id
      LIMIT greatest(p_limit, 0)
        FOR UPDATE SKIP LOCKED)
  RETURNING provisioning_case.tenant_id, provisioning_case.case_id, provisioning_case.workflow_run_id;
$$;
REVOKE ALL ON FUNCTION clockgrove_birth.open_workflow_cases(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clockgrove_birth.open_workflow_cases(integer) TO clockgrove_runtime;

-- Reconciliation reads only the finite birth-stage receipts, independent of later world history.
CREATE INDEX events_birth_receipt_lookup
  ON clockgrove.events (tenant_id, world_id, command_id)
  WHERE event_type IN ('WorldGenesisCreated', 'WorldSeedCommandApplied',
    'WorldProjectionVerified', 'WorldReady');
