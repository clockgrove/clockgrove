-- #740: the kernel registry changed (world.weather.set v2 replaced v1), so its hash did too, and
-- every snapshot written before this release names the old hash: `requireSnapshotCompatibility`
-- refuses all of them. A snapshot is only a replay shortcut (the journal is the authority), so the
-- stale index rows go; replay runs from birth until new snapshots are written. The snapshot
-- artifacts stay referenced and unreadable by the index (artifact references are append-only).
-- One-time cost: the first verification replay of each partition replays its whole journal
-- (replay_events_per_second, labelled `birth`), instead of only the suffix after its latest snapshot.
-- A later registry change needs the same step in its own migration.
DELETE FROM clockgrove.snapshots;
