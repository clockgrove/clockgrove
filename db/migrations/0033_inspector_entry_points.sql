-- #819 (Wave 4 §11.1): the causal inspector starts from an event, a scheduled action or the viewer's
-- own client view as well as a command. Each entry is audited in `inspector_accesses` under the same
-- grant checks, rate limit (0028) and retirement (0023) as the causal chain; a row names its subject
-- and, for an event or scheduled action, the entry it started from.
--
-- `entry_id` is the event ID, or the canonical JSON `[scheduleId, idempotencyKey]` of the schedule
-- row. Decision: at most 2100 octets, two 1024-octet IDs (0022's bound) plus the JSON array syntax.
-- A client view is the caller's own scope and interest, so it names no entry.
ALTER TABLE clockgrove.inspector_accesses
  DROP CONSTRAINT inspector_accesses_subject_check,
  DROP CONSTRAINT inspector_accesses_subject_command;
ALTER TABLE clockgrove.inspector_accesses
  ADD COLUMN entry_id text CHECK (octet_length(entry_id) BETWEEN 1 AND 2100),
  ADD CONSTRAINT inspector_accesses_subject_check CHECK (
    subject IN ('causal-chain', 'runtime-state', 'event', 'scheduled-action', 'client-view')
  ),
  ADD CONSTRAINT inspector_accesses_subject_command
    CHECK ((subject = 'causal-chain') = (command_id IS NOT NULL)),
  ADD CONSTRAINT inspector_accesses_subject_entry
    CHECK ((subject IN ('event', 'scheduled-action')) = (entry_id IS NOT NULL));

-- Same checks, rate limit, insert and retirement as 0031, with the entry.
CREATE FUNCTION clockgrove.record_inspector_access(
  access_world_id text,
  access_timeline_id text,
  access_space_id text,
  access_command_id text,
  access_decision text,
  access_reason_code text,
  access_subject text,
  access_entry_id text
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
  PERFORM pg_advisory_xact_lock(hashtext(tenant || ':' || principal));
  IF (SELECT count(*) FROM (
        SELECT 1 FROM clockgrove.inspector_accesses AS recent
         WHERE recent.tenant_id = tenant AND recent.principal_id = principal
           AND recent.accessed_at > statement_timestamp() - interval '1 hour'
         LIMIT 300
      ) AS window_rows) >= 300 THEN
    IF access_decision = 'deny' THEN
      RETURN;
    END IF;
    RAISE EXCEPTION 'inspector access rate limit reached' USING ERRCODE = 'CG013';
  END IF;
  INSERT INTO clockgrove.inspector_accesses (
    tenant_id, principal_id, world_id, timeline_id, space_id, command_id, decision, reason_code,
    subject, entry_id
  ) VALUES (
    tenant, principal, access_world_id, access_timeline_id, access_space_id, access_command_id,
    access_decision, access_reason_code, access_subject, access_entry_id
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
REVOKE ALL ON FUNCTION clockgrove.record_inspector_access(
  text, text, text, text, text, text, text, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clockgrove.record_inspector_access(
  text, text, text, text, text, text, text, text
) TO clockgrove_runtime;

-- The seven-argument form stays for code that predates the entry: a subject without one.
CREATE OR REPLACE FUNCTION clockgrove.record_inspector_access(
  access_world_id text,
  access_timeline_id text,
  access_space_id text,
  access_command_id text,
  access_decision text,
  access_reason_code text,
  access_subject text
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, clockgrove
AS $$
BEGIN
  PERFORM clockgrove.record_inspector_access(
    access_world_id, access_timeline_id, access_space_id, access_command_id, access_decision,
    access_reason_code, access_subject, NULL
  );
END;
$$;
