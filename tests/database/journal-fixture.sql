INSERT INTO clockgrove.tenants (tenant_id, display_name)
VALUES ('tenant-j-a', 'Journal A'), ('tenant-j-b', 'Journal B');

INSERT INTO clockgrove.tenant_principals (tenant_id, principal_id)
VALUES ('tenant-j-a', 'principal-j-a'), ('tenant-j-b', 'principal-j-b');

INSERT INTO clockgrove.worlds (tenant_id, world_id, lifecycle_status)
VALUES ('tenant-j-a', 'world-j-a', 'ready'), ('tenant-j-b', 'world-j-b', 'ready');

INSERT INTO clockgrove.timelines (tenant_id, world_id, timeline_id)
VALUES
  ('tenant-j-a', 'world-j-a', 'timeline-j-a'),
  ('tenant-j-b', 'world-j-b', 'timeline-j-b');

INSERT INTO clockgrove.timeline_partitions (
  tenant_id, world_id, timeline_id, partition_id, space_id, routing_epoch
) VALUES
  ('tenant-j-a', 'world-j-a', 'timeline-j-a', 'partition-j-a', 'space-j-a', 7),
  ('tenant-j-b', 'world-j-b', 'timeline-j-b', 'partition-j-b', 'space-j-b', 7);

INSERT INTO clockgrove.streams (
  tenant_id, world_id, timeline_id, partition_id, space_id, stream_id
) VALUES
  ('tenant-j-a', 'world-j-a', 'timeline-j-a', 'partition-j-a', 'space-j-a', 'stream-j-a'),
  ('tenant-j-b', 'world-j-b', 'timeline-j-b', 'partition-j-b', 'space-j-b', 'stream-j-b');
