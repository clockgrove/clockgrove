-- Alarm scans visit only pending deliveries, not growing terminal receipt history.
CREATE INDEX deliveries_delayed_actor_recipient
ON clockgrove.deliveries (tenant_id,world_id,timeline_id,actor_id,principal_id,dedupe_key)
WHERE status='delayed';
