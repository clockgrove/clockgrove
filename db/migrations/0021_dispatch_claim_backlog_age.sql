-- #701: a claim also returns each claimed dispatch's age since it was enqueued (`created_at`, 0009),
-- measured on the database clock, so the dispatcher exports dispatch backlog age from the read it
-- already makes. Only the result shape changes, which `CREATE OR REPLACE` cannot do; the arguments,
-- owner, SECURITY DEFINER, tenant/privacy filter and grants are those of 0009.
DROP FUNCTION clockgrove.claim_dispatches(text, integer, text, integer);

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
  correlation_id text,
  backlog_age_ms bigint
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
      dispatch.payload, due.next_attempt_at AS due_at, dispatch.created_at
  )
  SELECT claimed.tenant_id, claimed.world_id, claimed.timeline_id, claimed.dispatch_id,
    claimed.event_id, claimed.channel, claimed.attempts, claimed.privacy_class, claimed.payload,
    event.correlation_id,
    floor(extract(epoch FROM statement_timestamp() - claimed.created_at) * 1000)::bigint
  FROM claimed
  JOIN clockgrove.events AS event
    ON event.tenant_id = claimed.tenant_id AND event.event_id = claimed.event_id
  ORDER BY claimed.due_at, claimed.dispatch_id;
$$;

REVOKE ALL ON FUNCTION clockgrove.claim_dispatches(text, integer, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clockgrove.claim_dispatches(text, integer, text, integer)
  TO clockgrove_runtime;
