-- Issue 329, part 2: usage reaches the developer's own code as signed, retried webhooks. One row
-- per registrar and space holds where to post (an https URL; NULL is disabled), the cursor into the
-- usage feed (`usage_events.sequence`) and the retry state. The sweep acts as the registrar, so a
-- webhook only ever reads usage its registrar may read (`runtime_usage_reader`). No price, cost,
-- currency or account is stored.
CREATE TABLE clockgrove.usage_webhooks (
  tenant_id text NOT NULL,
  world_id text NOT NULL,
  timeline_id text NOT NULL,
  space_id text NOT NULL,
  -- The registrar: the sweep reads and settles as this principal.
  principal_id text NOT NULL,
  -- Random at first registration and kept on re-registration; the signing secret derives from it.
  webhook_id text NOT NULL CHECK (octet_length(webhook_id) BETWEEN 1 AND 128),
  url text CHECK (url ~ '^https://' AND octet_length(url) <= 2048),
  -- Every usage event with a sequence up to this one has been delivered.
  delivered_through bigint NOT NULL DEFAULT 0 CHECK (delivered_through >= 0),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  -- A sweep that claimed the webhook holds it until then, so two sweeps never post at once.
  lease_until timestamptz,
  last_status text CHECK (last_status ~ '^[a-z0-9_]{1,64}$'),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (tenant_id, world_id, timeline_id, space_id, principal_id),
  UNIQUE (tenant_id, webhook_id),
  FOREIGN KEY (tenant_id, world_id, timeline_id)
    REFERENCES clockgrove.timelines (tenant_id, world_id, timeline_id)
);

-- Pointing a webhook at a host makes the deployment send the space's usage outside it on a
-- schedule, the egress an outbound MCP server has, so setting a URL takes the same narrow,
-- owner-held authority (the owner's decision of 2026-11-25): `runtime:usage-webhook`, which a
-- world's owner holds by default and may delegate as `runtime:mcp-install` (0046), beside the usage
-- reader's grant and ceiling. As in 0046's `mcp_install_authorized`, an actor or `system:`
-- identity never qualifies, even with the explicit grant. `runtime:world-operate` alone is not
-- enough. Disabling (a NULL URL) and the sweep's cursor and retry updates need only the reader's.
CREATE FUNCTION clockgrove.usage_webhook_authority(roles text[], grants text[], p text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT NOT 'actor' = ANY(roles) AND left(p, 7) <> 'system:'
     AND ('runtime:usage-webhook' = ANY(grants) OR 'owner' = ANY(roles))
$$;
REVOKE ALL ON FUNCTION clockgrove.usage_webhook_authority(text[], text[], text) FROM PUBLIC;
CREATE FUNCTION clockgrove.runtime_usage_webhook_registrar(t text, w text, tl text, s text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, clockgrove AS $$
  SELECT EXISTS (
    SELECT 1 FROM clockgrove.world_memberships m
     WHERE m.tenant_id = t AND m.world_id = w AND m.timeline_id = tl AND m.space_id = s
       AND m.principal_id = clockgrove.runtime_principal_id() AND m.revoked_at IS NULL
       AND clockgrove.usage_webhook_authority(m.roles, m.grants, m.principal_id))
$$;
REVOKE ALL ON FUNCTION clockgrove.runtime_usage_webhook_registrar(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clockgrove.runtime_usage_webhook_registrar(text, text, text, text)
  TO clockgrove_runtime;

ALTER TABLE clockgrove.usage_webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE clockgrove.usage_webhooks FORCE ROW LEVEL SECURITY;
CREATE POLICY usage_webhooks_registrar_select ON clockgrove.usage_webhooks FOR SELECT USING (
  clockgrove.runtime_usage_reader(tenant_id, world_id, timeline_id, space_id)
  AND principal_id = clockgrove.runtime_principal_id());
CREATE POLICY usage_webhooks_registrar_insert ON clockgrove.usage_webhooks FOR INSERT WITH CHECK (
  clockgrove.runtime_usage_reader(tenant_id, world_id, timeline_id, space_id)
  AND principal_id = clockgrove.runtime_principal_id()
  AND (url IS NULL
       OR clockgrove.runtime_usage_webhook_registrar(tenant_id, world_id, timeline_id, space_id)));
CREATE POLICY usage_webhooks_registrar_update ON clockgrove.usage_webhooks FOR UPDATE USING (
  clockgrove.runtime_usage_reader(tenant_id, world_id, timeline_id, space_id)
  AND principal_id = clockgrove.runtime_principal_id())
  WITH CHECK (
  clockgrove.runtime_usage_reader(tenant_id, world_id, timeline_id, space_id)
  AND principal_id = clockgrove.runtime_principal_id()
  AND (url IS NULL
       OR clockgrove.runtime_usage_webhook_registrar(tenant_id, world_id, timeline_id, space_id)));
REVOKE ALL ON clockgrove.usage_webhooks FROM PUBLIC;
GRANT SELECT, INSERT ON clockgrove.usage_webhooks TO clockgrove_runtime;
GRANT UPDATE (url, delivered_through, attempts, next_attempt_at, lease_until, last_status,
  updated_at) ON clockgrove.usage_webhooks TO clockgrove_runtime;
CREATE TRIGGER usage_webhooks_no_delete BEFORE DELETE ON clockgrove.usage_webhooks
  FOR EACH ROW EXECUTE FUNCTION clockgrove.reject_journal_mutation();
CREATE TRIGGER usage_webhooks_no_truncate BEFORE TRUNCATE ON clockgrove.usage_webhooks
  FOR EACH STATEMENT EXECUTE FUNCTION clockgrove.reject_journal_mutation();

-- The scheduled sweep finds due webhooks with no member at hand, as the snapshot sweep does
-- (0030). It returns identities only; every read and write the sweep then makes runs as the
-- registrar under row-level security.
CREATE FUNCTION clockgrove.due_usage_webhooks(lim integer)
RETURNS TABLE (tenant_id text, principal_id text, world_id text, timeline_id text, space_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, clockgrove AS $$
  SELECT w.tenant_id, w.principal_id, w.world_id, w.timeline_id, w.space_id
    FROM clockgrove.usage_webhooks AS w
   WHERE w.url IS NOT NULL AND w.next_attempt_at <= statement_timestamp()
     AND (w.lease_until IS NULL OR w.lease_until <= statement_timestamp())
     -- Only while the registrar may still read the usage (`runtime_usage_reader`'s grant and
     -- ceiling) and still holds `runtime:usage-webhook`: a webhook whose registrar lost any of
     -- them is not due, so it never crowds out the rest.
     AND EXISTS (
       SELECT 1 FROM clockgrove.world_memberships m
        WHERE m.tenant_id = w.tenant_id AND m.world_id = w.world_id
          AND m.timeline_id = w.timeline_id AND m.space_id = w.space_id
          AND m.principal_id = w.principal_id AND m.revoked_at IS NULL
          AND 'runtime:world-inspect' = ANY(m.grants)
          AND clockgrove.usage_webhook_authority(m.roles, m.grants, m.principal_id)
          AND m.privacy_ceiling->'allowedCategories' ? 'operator_evidence')
   ORDER BY w.next_attempt_at
   LIMIT greatest(lim, 0)
$$;
REVOKE ALL ON FUNCTION clockgrove.due_usage_webhooks(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clockgrove.due_usage_webhooks(integer) TO clockgrove_runtime;

-- Registering, replacing or disabling a webhook starts or stops a standing export of the space's
-- usage, so it is audited as its own subject, not as a usage read. Its entry is where the export
-- now goes: the URL's origin, or `disabled`. The path and query are not kept, since they may carry
-- the receiver's own credential.
ALTER TABLE clockgrove.inspector_accesses
  DROP CONSTRAINT inspector_accesses_subject_check,
  DROP CONSTRAINT inspector_accesses_subject_entry,
  ADD CONSTRAINT inspector_accesses_subject_check CHECK (
    subject IN (
      'causal-chain', 'runtime-state', 'event', 'scheduled-action', 'client-view', 'agent-runs',
      'context-manifest', 'actor-documents', 'usage-events', 'actor-mute',
      'usage-webhook'
    )
  ),
  ADD CONSTRAINT inspector_accesses_subject_entry
    CHECK ((subject IN ('event', 'scheduled-action', 'usage-webhook')) = (entry_id IS NOT NULL));
