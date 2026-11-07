-- Event IDs are scoped by tenant, like every other journal identifier. The global primary key on
-- events (event_id) made another tenant's event ID observable: inserting a row whose ID was in
-- use elsewhere failed with a unique violation (and, for a direct client, an error detail naming
-- it), and one tenant could squat IDs another tenant needed. Rows are unchanged; only the
-- uniqueness scope narrows to the tenant, which the (tenant_id, event_id) unique constraint
-- already enforced.
ALTER TABLE clockgrove.event_dispatches
  DROP CONSTRAINT event_dispatches_event_id_fkey,
  DROP CONSTRAINT event_dispatches_tenant_id_event_id_fkey;

ALTER TABLE clockgrove.events
  DROP CONSTRAINT events_pkey,
  DROP CONSTRAINT events_tenant_id_event_id_key,
  ADD CONSTRAINT events_pkey PRIMARY KEY (tenant_id, event_id);

ALTER TABLE clockgrove.event_dispatches
  ADD CONSTRAINT event_dispatches_tenant_id_event_id_fkey
    FOREIGN KEY (tenant_id, event_id) REFERENCES clockgrove.events (tenant_id, event_id);
