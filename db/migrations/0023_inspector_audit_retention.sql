-- #748: inspector audit rows are retained for 90 days per tenant, and each new access retires the
-- tenant's expired rows.
--
-- Decision: 90 days. It matches the three-month retention Cloudflare documents for Workers Analytics
-- Engine (https://developers.cloudflare.com/analytics/analytics-engine/limits/), where the runtime
-- metrics go (#745). An operator thus has the audit trail for as long as the metrics it explains.
--
-- Retirement path: the function below is the only one. The DELETE half of the row trigger is
-- dropped, and DELETE stays impossible for every other path because nothing grants it: the runtime
-- role holds no table privilege (it can only EXECUTE the function), and support/backup roles hold
-- none either. UPDATE and TRUNCATE stay rejected by trigger for every role. A transaction-local flag
-- the trigger would honour was the alternative; it adds a setting that any role able to `set_config`
-- could raise, so the grant boundary is the simpler sound one.
DROP TRIGGER inspector_accesses_immutable_rows ON clockgrove.inspector_accesses;
CREATE TRIGGER inspector_accesses_immutable_rows
  BEFORE UPDATE ON clockgrove.inspector_accesses
  FOR EACH ROW EXECUTE FUNCTION clockgrove.reject_journal_mutation();

-- The retirement scan: one tenant's oldest rows first.
CREATE INDEX inspector_accesses_tenant_accessed_at
  ON clockgrove.inspector_accesses (tenant_id, accessed_at);

-- Same signature, checks and insert as 0022, then retirement.
-- Decision: at most 100 expired rows per access. Every access adds one row and may retire 100, so a
-- backlog drains 99 rows per access while each call stays a bounded index range delete. Rows locked
-- by a concurrent access are skipped, never waited on.
CREATE OR REPLACE FUNCTION clockgrove.record_inspector_access(
  access_world_id text,
  access_timeline_id text,
  access_space_id text,
  access_command_id text,
  access_decision text,
  access_reason_code text
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, clockgrove
AS $$
DECLARE
  tenant text := clockgrove.runtime_tenant_id();
  principal text := clockgrove.runtime_principal_id();
BEGIN
  IF tenant IS NULL OR principal IS NULL THEN
    RAISE EXCEPTION 'inspector access requires installed authority' USING ERRCODE = '42501';
  END IF;
  IF access_decision IS DISTINCT FROM 'deny' AND NOT clockgrove.has_runtime_context(tenant) THEN
    RAISE EXCEPTION 'only a tenant member can be allowed' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM clockgrove.tenants WHERE tenant_id = tenant) THEN
    RETURN;
  END IF;
  INSERT INTO clockgrove.inspector_accesses (
    tenant_id, principal_id, world_id, timeline_id, space_id, command_id, decision, reason_code
  ) VALUES (
    tenant, principal, access_world_id, access_timeline_id, access_space_id, access_command_id,
    access_decision, access_reason_code
  );
  DELETE FROM clockgrove.inspector_accesses AS expired
   WHERE expired.tenant_id = tenant
     AND expired.access_id IN (
       SELECT candidate.access_id FROM clockgrove.inspector_accesses AS candidate
        WHERE candidate.tenant_id = tenant
          AND candidate.accessed_at < statement_timestamp() - interval '90 days'
        ORDER BY candidate.accessed_at
        LIMIT 100
        FOR UPDATE SKIP LOCKED
     );
END;
$$;
