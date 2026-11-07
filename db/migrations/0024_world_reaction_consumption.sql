-- Publication and consumption are independent dispositions on the source dispatch. One successful
-- consumption occupies two nullable columns, retained for exactly the source row's lifetime.
ALTER TABLE clockgrove.event_dispatches
  ADD COLUMN consumed_at timestamptz,
  ADD COLUMN consumed_principal_id text,
  ADD CONSTRAINT event_dispatches_consumption_complete CHECK (
    (consumed_at IS NULL) = (consumed_principal_id IS NULL)
  ),
  ADD CONSTRAINT event_dispatches_consumption_principal FOREIGN KEY (tenant_id, consumed_principal_id)
    REFERENCES clockgrove.tenant_principals (tenant_id, principal_id);

CREATE FUNCTION clockgrove.guard_dispatch_consumption() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'consumption requires canonical verification' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.consumed_at IS NOT NULL AND
     (NEW.consumed_at IS DISTINCT FROM OLD.consumed_at OR
      NEW.consumed_principal_id IS DISTINCT FROM OLD.consumed_principal_id) THEN
    RAISE EXCEPTION 'consumption disposition is immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION clockgrove.guard_dispatch_consumption() FROM PUBLIC;
CREATE TRIGGER event_dispatches_consumption_guard BEFORE INSERT OR UPDATE
  ON clockgrove.event_dispatches FOR EACH ROW EXECUTE FUNCTION clockgrove.guard_dispatch_consumption();

-- Trusted runtime capability: reveals only the autonomous identity of an actual public producer
-- dispatch. No session grants, browser identity or arbitrary tenant member can supply authority.
CREATE FUNCTION clockgrove.world_reaction_principal(p_tenant text, p_dispatch text)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, clockgrove AS $$
  SELECT principal.principal_id
    FROM clockgrove.event_dispatches AS dispatch
    JOIN clockgrove.tenant_principals AS principal
      ON principal.tenant_id = dispatch.tenant_id AND principal.system_world_id = dispatch.world_id
   WHERE dispatch.tenant_id = p_tenant AND dispatch.dispatch_id = p_dispatch
     AND dispatch.channel = 'world-reactions' AND dispatch.privacy_class = 'public_scene'
$$;
REVOKE ALL ON FUNCTION clockgrove.world_reaction_principal(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clockgrove.world_reaction_principal(text, text) TO clockgrove_runtime;

CREATE FUNCTION clockgrove.due_world_reaction_principals(p_tenant text, p_limit integer)
RETURNS TABLE (tenant_id text, principal_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, clockgrove AS $$
  WITH due AS (
    SELECT dispatch.tenant_id, dispatch.world_id
      FROM clockgrove.event_dispatches AS dispatch
     WHERE (p_tenant IS NULL OR dispatch.tenant_id = p_tenant)
       AND dispatch.channel = 'world-reactions' AND dispatch.privacy_class = 'public_scene'
       AND dispatch.status IN ('pending', 'leased')
       AND dispatch.next_attempt_at <= statement_timestamp()
     ORDER BY dispatch.next_attempt_at, dispatch.tenant_id, dispatch.dispatch_id
     LIMIT greatest(p_limit, 0)
  )
  SELECT DISTINCT due.tenant_id, principal.principal_id
    FROM due JOIN clockgrove.tenant_principals AS principal
      ON principal.tenant_id = due.tenant_id AND principal.system_world_id = due.world_id
   ORDER BY due.tenant_id, principal.principal_id
$$;
REVOKE ALL ON FUNCTION clockgrove.due_world_reaction_principals(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clockgrove.due_world_reaction_principals(text, integer) TO clockgrove_runtime;

CREATE FUNCTION clockgrove.consume_world_reaction(envelope jsonb)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, clockgrove AS $$
DECLARE
  dispatch clockgrove.event_dispatches%ROWTYPE;
  anchor clockgrove.events%ROWTYPE;
  receipt clockgrove.command_receipts%ROWTYPE;
  batch_ids text[];
  batch_valid boolean;
  principal text;
BEGIN
  SELECT * INTO dispatch FROM clockgrove.event_dispatches AS candidate
   WHERE candidate.tenant_id = clockgrove.runtime_tenant_id()
     AND candidate.tenant_id = envelope->>'tenantId'
     AND candidate.dispatch_id = envelope->>'messageId'
     AND clockgrove.runtime_can_access(candidate.tenant_id, candidate.privacy_class)
   FOR UPDATE;
  IF NOT FOUND THEN RETURN 'invalid'; END IF;
  principal := clockgrove.world_reaction_principal(dispatch.tenant_id, dispatch.dispatch_id);
  IF principal IS NULL OR principal IS DISTINCT FROM clockgrove.runtime_principal_id()
     OR envelope->'schemaVersion' IS DISTINCT FROM '2'::jsonb
     OR envelope ?| ARRAY['effectId', 'causationId', 'availableAt']
     OR envelope->>'channel' IS DISTINCT FROM 'world-reactions'
     OR envelope->>'worldId' IS DISTINCT FROM dispatch.world_id
     OR envelope->>'timelineId' IS DISTINCT FROM dispatch.timeline_id
     OR envelope->>'sourceEventId' IS DISTINCT FROM dispatch.event_id
     OR envelope->'payload' IS DISTINCT FROM dispatch.payload THEN
    RETURN 'invalid';
  END IF;
  SELECT * INTO anchor FROM clockgrove.events AS event
   WHERE event.tenant_id = dispatch.tenant_id AND event.event_id = dispatch.event_id;
  IF NOT FOUND OR envelope->>'correlationId' IS DISTINCT FROM anchor.correlation_id THEN
    RETURN 'invalid';
  END IF;
  SELECT * INTO receipt FROM clockgrove.command_receipts AS command
   WHERE command.tenant_id = dispatch.tenant_id AND command.command_id = anchor.command_id;
  IF NOT FOUND OR receipt.status <> 'committed' OR receipt.committed_at IS NULL THEN
    RETURN 'invalid';
  END IF;
  SELECT array_agg(event.event_id ORDER BY event.partition_sequence),
         bool_and(event.world_id = dispatch.world_id AND event.timeline_id = dispatch.timeline_id
           AND event.partition_id = dispatch.partition_id AND event.space_id = dispatch.space_id
           AND event.privacy_class = 'public_scene'
           AND event.correlation_id = anchor.correlation_id
           AND clockgrove.runtime_can_access(event.tenant_id, event.privacy_class))
    INTO batch_ids, batch_valid
    FROM clockgrove.events AS event
   WHERE event.tenant_id = dispatch.tenant_id AND event.command_id = anchor.command_id;
  IF batch_valid IS DISTINCT FROM true
     OR batch_ids IS DISTINCT FROM receipt.canonical_event_ids
     OR batch_ids[1] IS DISTINCT FROM dispatch.event_id
     OR dispatch.dispatch_id IS DISTINCT FROM anchor.command_id || ':dispatch:world-reactions'
     OR dispatch.payload IS DISTINCT FROM jsonb_build_object(
       'eventId', dispatch.event_id, 'eventCount', cardinality(batch_ids)) THEN
    RETURN 'invalid';
  END IF;
  -- The row lock serializes concurrent duplicates. A retry after COMMIT observes this same result;
  -- no transport attempt count, event append or additional audit row participates in correctness.
  IF dispatch.consumed_at IS NOT NULL THEN RETURN 'duplicate'; END IF;
  UPDATE clockgrove.event_dispatches SET consumed_at = statement_timestamp(),
    consumed_principal_id = principal
   WHERE tenant_id = dispatch.tenant_id AND dispatch_id = dispatch.dispatch_id;
  RETURN 'consumed';
END;
$$;
REVOKE ALL ON FUNCTION clockgrove.consume_world_reaction(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clockgrove.consume_world_reaction(jsonb) TO clockgrove_runtime;

-- Preserve lease fencing and user dispatch semantics; autonomous publication stays in its world.
CREATE OR REPLACE FUNCTION clockgrove.claim_dispatches(
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
      AND NOT EXISTS (
        SELECT 1 FROM clockgrove.tenant_principals AS principal
         WHERE principal.tenant_id = candidate.tenant_id
           AND principal.principal_id = clockgrove.runtime_principal_id()
           AND principal.system_world_id IS NOT NULL
           AND principal.system_world_id <> candidate.world_id
      )
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

CREATE OR REPLACE FUNCTION clockgrove.settle_dispatch(
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
     AND clockgrove.runtime_can_access(dispatch.tenant_id, dispatch.privacy_class)
      AND NOT EXISTS (
        SELECT 1 FROM clockgrove.tenant_principals AS principal
         WHERE principal.tenant_id = dispatch.tenant_id
           AND principal.principal_id = clockgrove.runtime_principal_id()
           AND principal.system_world_id IS NOT NULL
           AND principal.system_world_id <> dispatch.world_id
      );
  GET DIAGNOSTICS settled = ROW_COUNT;
  RETURN settled = 1;
END;
$$;
