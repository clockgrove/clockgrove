-- Dispatch claims and leases (Wave 2 plan RW-0206). A dispatcher claims due `event_dispatches` rows
-- and settles each claim. The runtime role keeps no UPDATE or DELETE grant on the table: every
-- transition goes through the two migrator-owned SECURITY DEFINER functions below.
--
-- The lease expiry lives in `next_attempt_at`, so one predicate (`next_attempt_at <= now`) and the
-- existing pending index cover both pending rows and expired leases. The attempt number is the
-- fencing token: a claim increments it, and a settle names the attempt it holds, so a holder whose
-- lease expired and was reclaimed can never settle.

ALTER TABLE clockgrove.event_dispatches
  ADD COLUMN lease_owner text CHECK (lease_owner <> ''),
  ADD COLUMN last_error_class text CHECK (last_error_class IN ('retryable', 'permanent')),
  ADD COLUMN settled_at timestamptz,
  -- Existing rows take the migration time; backlog age is queried from here.
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  ADD CONSTRAINT event_dispatches_leased_owner_check
    CHECK (status <> 'leased' OR lease_owner IS NOT NULL),
  ADD CONSTRAINT event_dispatches_terminal_settled_check
    CHECK ((status IN ('delivered', 'failed')) = (settled_at IS NOT NULL));

-- Both functions run as the owner, which bypasses RLS, so each one filters with the same
-- `runtime_can_access` predicate as the table policy: only the installed tenant's rows within the
-- installed privacy ceiling are ever claimed or settled.
CREATE FUNCTION clockgrove.claim_dispatches(
  claim_channel text,
  claim_limit integer,
  claim_owner text,
  lease_ms integer
)
RETURNS TABLE (
  tenant_id text,
  world_id text,
  timeline_id text,
  dispatch_id text,
  event_id text,
  channel text,
  attempt integer,
  privacy_class text,
  payload jsonb,
  correlation_id text
)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, clockgrove
AS $$
  WITH due AS (
    SELECT candidate.tenant_id, candidate.dispatch_id, candidate.next_attempt_at
    FROM clockgrove.event_dispatches AS candidate
    WHERE candidate.tenant_id = clockgrove.runtime_tenant_id()
      AND candidate.channel = claim_channel
      AND candidate.status IN ('pending', 'leased')
      AND candidate.next_attempt_at <= statement_timestamp()
      AND clockgrove.runtime_can_access(candidate.tenant_id, candidate.privacy_class)
    ORDER BY candidate.next_attempt_at, candidate.dispatch_id
    LIMIT greatest(claim_limit, 0)
    FOR UPDATE SKIP LOCKED
  ),
  claimed AS (
    UPDATE clockgrove.event_dispatches AS dispatch
       SET status = 'leased',
           attempts = dispatch.attempts + 1,
           lease_owner = claim_owner,
           next_attempt_at = statement_timestamp()
             + make_interval(secs => greatest(lease_ms, 0) / 1000.0)
      FROM due
     WHERE dispatch.tenant_id = due.tenant_id AND dispatch.dispatch_id = due.dispatch_id
    RETURNING dispatch.tenant_id, dispatch.world_id, dispatch.timeline_id, dispatch.dispatch_id,
      dispatch.event_id, dispatch.channel, dispatch.attempts, dispatch.privacy_class,
      dispatch.payload, due.next_attempt_at AS due_at
  )
  SELECT claimed.tenant_id, claimed.world_id, claimed.timeline_id, claimed.dispatch_id,
    claimed.event_id, claimed.channel, claimed.attempts, claimed.privacy_class, claimed.payload,
    event.correlation_id
  FROM claimed
  JOIN clockgrove.events AS event
    ON event.tenant_id = claimed.tenant_id AND event.event_id = claimed.event_id
  ORDER BY claimed.due_at, claimed.dispatch_id;
$$;

-- `retry` returns the row to pending after `retry_after_ms`; `delivered` and `failed` are terminal.
-- Returns false and changes nothing unless the row is leased at exactly `settle_attempt`.
CREATE FUNCTION clockgrove.settle_dispatch(
  settle_dispatch_id text,
  settle_attempt integer,
  settle_outcome text,
  settle_error_class text,
  retry_after_ms integer
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, clockgrove
AS $$
DECLARE
  settled integer;
BEGIN
  IF settle_outcome IS NULL OR settle_outcome NOT IN ('delivered', 'retry', 'failed')
     OR (settle_outcome = 'delivered') <> (settle_error_class IS NULL)
     OR settle_error_class NOT IN ('retryable', 'permanent')
     OR (settle_outcome = 'retry') <> (retry_after_ms IS NOT NULL)
     OR retry_after_ms < 0 THEN
    RAISE EXCEPTION 'invalid dispatch settlement' USING ERRCODE = '22023';
  END IF;
  UPDATE clockgrove.event_dispatches AS dispatch
     SET status = CASE settle_outcome WHEN 'retry' THEN 'pending' ELSE settle_outcome END,
         lease_owner = CASE settle_outcome WHEN 'retry' THEN NULL ELSE dispatch.lease_owner END,
         last_error_class = coalesce(settle_error_class, dispatch.last_error_class),
         next_attempt_at = CASE settle_outcome
           WHEN 'retry' THEN statement_timestamp() + make_interval(secs => retry_after_ms / 1000.0)
           ELSE dispatch.next_attempt_at
         END,
         settled_at = CASE settle_outcome WHEN 'retry' THEN NULL ELSE statement_timestamp() END
   WHERE dispatch.tenant_id = clockgrove.runtime_tenant_id()
     AND dispatch.dispatch_id = settle_dispatch_id
     AND dispatch.status = 'leased'
     AND dispatch.attempts = settle_attempt
     AND clockgrove.runtime_can_access(dispatch.tenant_id, dispatch.privacy_class);
  GET DIAGNOSTICS settled = ROW_COUNT;
  RETURN settled = 1;
END;
$$;

REVOKE ALL ON FUNCTION clockgrove.claim_dispatches(text, integer, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION clockgrove.settle_dispatch(text, integer, text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clockgrove.claim_dispatches(text, integer, text, integer)
  TO clockgrove_runtime;
GRANT EXECUTE ON FUNCTION clockgrove.settle_dispatch(text, integer, text, text, integer)
  TO clockgrove_runtime;
