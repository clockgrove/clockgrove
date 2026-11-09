# Database fixtures

`current-schema.sql` is representative data for the schema produced by all checked-in
migrations. `db:verify` migrates it alongside an empty database.

`prior/<tag>/` is a prior-release database: what a tagged release's own code wrote. Capture it with
`node scripts/database/capture-prior-release.mjs <tag>`. The script checks the tag out in a
temporary worktree. There it migrates a fresh cluster, provisions a world and runs one committed
scenario through the Journal (`apps/runtime/test/prior-release.ts`). Every parity check against the
tag's golden must pass. It then writes:

- `database.sql`: a plain `pg_dump` of that database, schema and data, taken after
  `clockgrove.rebase_activation_order()` (when the tag has it) so that it restores into any cluster;
- `manifest.json`: the tag's commit, its migration head, the world scope, event and snapshot
  counts, the digest of every stored event's bytes, and the final state hash.

Two captures of one tag differ only in wall-clock timestamps, which are also inside the event bytes.
The final state hash is the same. So a fixture's event digest belongs to its own dump: re-capture
both files together, never one of them.

`pnpm test:db` migrates every fixture to head (`apps/runtime/test/prior-release-fixtures.postgres.test.ts`,
`scripts/database/prior-fixtures.mjs`). It refuses a dump that its manifest does not match. Every
pre-existing row must keep its pre-existing columns, and every event its bytes; a migration may add
columns and rows, and the declared contract step 0029 deletes the snapshots of the old kernel
registry. As the runtime, full replay and the offline bundle must reach the recorded final state
hash. Then a snapshot is taken at that head under the current registry, and one `world.advance`, run
with the behavior installed in the upgraded database, appends kernel events above it. Replay from the
snapshot must apply that whole suffix and reach the new live hash, as full replay and the offline
bundle do, and the snapshot's checkpoint must still hold the recorded hash (#832).

Replay reads each kernel event through the upcast table (`WORLD_EVENT_UPCASTS`) and refuses a version
it has no upcast for. So every historic event version present in a supported fixture upcasts and
replays. The test also stores a fixture's `routine.selected` at version 1: it replays through its
upcaster to the same hash, and an unsupported version is refused. No release ever wrote
`routine.selected@1` or event envelope v1 to a database. Their committed goldens prove them
(`packages/world-pack-sdk/test/historic-upcast.test.ts`, `journal-range.postgres.test.ts`).

Policy (#694): capture each wave-close tag. A fixture stays supported, in `test:db`, until it is
retired by removing its directory.
