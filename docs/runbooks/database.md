# Database lifecycle and verification

Clockgrove uses PostgreSQL as canonical durable world history. Runtime actors, queues, caches,
indexes, snapshots, and artifact references do not become alternate authorities. Snapshots and
artifact references are acceleration metadata; journal events remain canonical.

## Local prerequisites and isolation

The supported database policy is exactly PostgreSQL 18.6 with pgvector 0.8.7. The former
pgvector 0.8.1 and 0.8.6 versions are rejected. No other PostgreSQL minor or pgvector version is
implicitly compatible. The fixture looks for `initdb`, `pg_ctl`, `postgres`, `psql`, `pg_config`,
`pg_dump`, and `pg_restore` on `PATH` first. A tool missing there is taken from `pg_config --bindir`,
or from `/usr/lib/postgresql/18/bin` when `pg_config` is not on `PATH` either: PGDG's Debian/Ubuntu
packages put `initdb`, `pg_ctl`, and `postgres` there and not on `PATH`. A missing tool's error names
`PATH` and the fallback directory searched. Wherever it comes from,
every PostgreSQL executable must report 18.6. Migration checks both the available default and
installed extension versions before applying schema changes.

`scripts/ci/toolchain.sh` installs `postgresql-18`, `postgresql-client-18`, and `postgresql-server-dev-18` from
PGDG's signed Ubuntu 26.04 repository (CI skips `postgresql-server-dev-18`, which only compiles pgvector, when it reuses a verified staged build), each at `18.6-1.pgdg26.04+2`, and verifies their installed
package identities and `pg_config` version. It builds the [official stable pgvector 0.8.7 source](https://github.com/pgvector/pgvector/releases/tag/v0.8.7)
from commit `f37c13f68b57d2c3472b2214fbcff699d6d34876`. The archive at
`https://codeload.github.com/pgvector/pgvector/tar.gz/f37c13f68b57d2c3472b2214fbcff699d6d34876`
has SHA-256 `83d673c3b287cddbf3879f86215f043f2c2b56c69d37b2a77504910db1ed6e56`,
verified against the official tag on 2026-10-06 UTC. The script verifies this digest and `vector.control`
before `make` and `make install`, explicitly selecting `/usr/lib/postgresql/18/bin/pg_config`
and `OPTFLAGS=""` for both operations. No guessed pgvector Debian package pin is used. It then
records the commit, source digest and installed `vector.so` digest, so a later run verifies the
installed build instead of rebuilding it. Package versions and that record are checked on every run.
An isolated database preflight checks the available default version, creates the extension,
and checks the installed version before database qualification. The same fail-closed checks
run on every migration path.

`pnpm run test:db` and `pnpm run db:verify` each create a uniquely named, owned cluster below the
operating system's temporary directory and allocate an available local port. The data and log paths
may therefore follow either a short or long `TMPDIR`. Clients reach the cluster through one of two
transports. The focused lifecycle regression starts a real server, queries it, waits for it to stop,
and proves resource removal once with ordinary `/tmp` and once with a deliberately long `TMPDIR`;
the long-path case deliberately fails after its query to exercise the same unconditional cleanup
path.

### Fixture transport: `socket` or `loopback`

The helper (`databaseTransport` in `scripts/database/lib.mjs`) picks the transport in this order:

1. `CLOCKGROVE_TEST_DB_TRANSPORT`, when set and non-empty, wins. Its only values are `socket` and `loopback`; any
   other value fails the run with an error naming the variable.
2. Otherwise `FACTORY_LOCAL=1` selects `loopback`. Factory's local mode sets it in every child
   process and passes commands only an allow-list of environment variables, so a workflow-level
   switch would not reach the fixture.
3. Otherwise `socket`. CI and ordinary local runs keep this default.

`socket` (default). Clients connect through a uniquely named Linux abstract Unix socket. That short
abstract name stays below Linux's 107-byte socket-address limit regardless of the host
temporary-directory length. Trust authentication applies only to that socket; `listen_addresses`
is empty, so there is no TCP listener.

`loopback`. Factory's local sandboxes refuse every `AF_UNIX` socket, abstract and filesystem
alike, with `EPERM`; the owner decided on 2026-11-07, after a security review, that the sandboxes stay
that way and the fixture listens on loopback TCP instead. PostgreSQL listens on `127.0.0.1` at the
allocated port with an empty `unix_socket_directories`; any socket directory makes PostgreSQL
create a Unix socket, which the sandbox refuses. Loopback TCP is reachable by every local process
on a shared host (CI runners, development machines outside a sandbox), so this mode trusts no
connection: `initdb` sets `--auth-host=scram-sha-256` and `--auth-local=reject`. Each run draws
a fresh 256-bit password from `crypto.randomBytes`. The admin password reaches `initdb` through a
`0600` file in the run's owner-private temporary root, deleted as soon as `initdb` returns; every
login role gets the same password as a SCRAM verifier computed in the helper, so no SQL statement,
error or server log carries it. The fixture hands it out only as `PGPASSWORD` in its
`environment` and in the URLs built from it (`connectionString` in
`apps/runtime/test/world-fixture.ts`, the native harness's Hyperdrive bindings); it is never
logged or written elsewhere. Inside a Factory sandbox the loopback listener is also confined to
the sandbox's own network namespace.

In both modes the helper never discovers or contacts a pre-existing database, and it drops an
inherited `PGPASSWORD`. Every success or operation failure passes through `finally`: the helper
immediately stops its owned server, waits for shutdown, and recursively removes only its unique
cluster root. It uses no Docker service, cloud database, production credential, persistent server,
or hard-coded PostgreSQL executable path.

## Migration ownership and roles

The disposable cluster retains the original admin/migrator/runtime setup and adds the declared deployment roles:

- `clockgrove_admin` initializes the cluster/database and enables the pgvector extension;
- `clockgrove_migrator` owns the database schema and applies the forward migration files;
- `clockgrove_runtime` is the ordinary login used by canonical application traffic;
- `clockgrove_support` and `clockgrove_backup` retain their read-only deployment obligations;
- `clockgrove_auth_verifier` can read only Better Auth user/session storage;
- `clockgrove_management_reader` reads scoped Management identity/principal and optional workspace facts;
- `clockgrove_world_reader` reads only exact scoped committed World participation through forced RLS.

Migration `0002_authentication_authority.sql` is additive; the applied journal migration bytes stay
unchanged. Migration `0003_tenant_scoped_event_ids.sql` scopes event identity to `(tenant_id, event_id)`:
a global key would let one tenant probe or squat another tenant's event IDs. Migrator-owned `clockgrove_auth` contains Better Auth 1.7.7 user/session/account/verification
schema. It enables verification only, with no provider write or enrollment connection in runtime.
Migrator-owned `clockgrove_management` holds provider-environment/subject links to opaque identities,
principals and administrative workspace membership. Runtime-owned `clockgrove.world_memberships`
records already committed membership/persona, exact tenant/world/timeline/space, roles, explicit grants
and privacy ceiling. Management administration and provider sessions never create World authority.
Readers use short read-only transactions and scoped transaction-local settings, always rollback/close
on failure, and never use runtime/migrator credentials for pre-authentication lookup. Unknown, revoked,
malformed or mismatched facts refuse. Controlled fixture rows are restricted to disposable tests;
initialization/migrations seed no participation or ready-world state.

The runtime role is neither a superuser nor an RLS bypass role. It cannot inherit migration
authority. The migration role has explicit RLS-bypass authority for controlled schema/data
migrations; that authority is never granted to runtime. Production operators must give
`pnpm run db:migrate` a PostgreSQL administrative
connection through the ordinary `PGHOST`, `PGPORT`, `PGDATABASE`, and `PGUSER` variables; the
command does not contain or discover credentials. Drizzle migration files and their journal are
ordered under `db/migrations/` and checksummed in `clockgrove.schema_migrations`; query-facing core
tables are declared in `packages/persistence/src/schema.ts`. Reviewed SQL owns extension enablement,
constraints, triggers, grants, and RLS because those operations require PostgreSQL-specific
semantics.

The schema also owns the atomic `clockgrove.execute_journal` function used by the persistence
adapter. It stores exact command bytes and their PostgreSQL-computed SHA-256, locks receipt and head
rows, verifies expected values, allocates sequences, appends immutable event bytes, writes dispatch
intent, and stores the stable result in one caller-controlled transaction. See
`docs/runbooks/journal-replay.md` for the complete ordering and crash contract.

Production migrations are forward-only and follow **expand → backfill → verify → switch →
contract**. Readers tolerate old and new forms before writers require the new form. Projection
rebuilds use explicit checkpoints, and event payloads are immutable and evolve through upcasters
rather than rewrites.

Backfills are resumable through explicit checkpoints (RW-0209, issue 832). A data backfill runs after its
expand migration through `runBackfill` (`scripts/database/backfill.mjs`), as the migrator, in bounded
batches. The definition names its checkpoint row (`migration`, `key`), its `batchSize`, one
data-modifying `step` that changes the next rows after the cursor in key order and returns their
keys, and a `verify` expression. Each batch and its checkpoint in
`clockgrove.migration_backfill_checkpoints` commit in one transaction under an advisory lock, so a
run killed between or during batches resumes from the last committed checkpoint and ends with the
rows of an uninterrupted run. The checkpoint value records the cursor, rows, batches and whether a
short batch completed the backfill. `verified_at` is set only in the statement that finds `verify`
true; otherwise the run stops with `BackfillVerificationError` and the backfill stays unverified. A
verified backfill is never run again. The table has no RLS and no runtime grant: only the migrator
writes it, one row per backfill.

A destructive contract step requires a verified backup/restore point and release approval. Every
migration path (`pnpm db:migrate`, `pnpm db:verify`, `pnpm test:db`, through `applyMigrations`) and
`pnpm check` refuse, before anything is applied, a migration that deletes, truncates or drops data
unless `db/migrations/contract-steps.json` declares it (`scripts/database/contract-steps.mjs`). It
counts a statement that contains `DELETE FROM` or `TRUNCATE` anywhere (a `WITH … DELETE` too), a
`DROP TABLE`/`SCHEMA`/`DATABASE`/`OWNED`/`MATERIALIZED VIEW`, an `ALTER TABLE … DROP` of a column,
any `DROP … CASCADE`, and a rewrite of an append-only table: an `UPDATE` of, or an `ALTER COLUMN …
TYPE` on, `clockgrove.events`, `authority_decisions`, `artifact_references` or `snapshots`, and any
`session_replication_role` setting other than `DEFAULT` or `origin`, which skips the immutability
triggers. A declaration pins the migration's SHA-256 (the checksum `schema_migrations` records),
lists the statements that destroy data exactly as the check reports them, states the restore point
the deploy needs first (`restorePoint`) and names the issue or pull request that approved its release
(`releaseApproval`, `#<number>`). The check reads what a migration runs: its statements; the body of
each DO block, with or without a `LANGUAGE` clause; the text of every string literal and of every
other dollar-quoted string, nested ones included, so SQL passed to `EXECUTE` is read; and the body of
every function or procedure the migration calls by name (`SELECT`, `PERFORM`, `CALL` or any other
expression), when this or an earlier migration created it, following the routines that body calls.
A routine it reaches is reported as `<routine>(): <statement>`. It does not read SQL assembled at run
time from separate pieces (`'DELETE ' || 'FROM …'`), or the body of a trigger function, which runs on
a later write, even one the same migration makes. The retention functions of 0023, 0027 and 0028
delete rows, but no migration calls them: the runtime or a trigger runs them later, and they are
reviewed as code and listed in `db/retention.json`. Two applied migrations are
declared as reviewed contract steps, their bytes unchanged: `0019_clock_owner_claim_in_place.sql` and `0029_drop_incompatible_snapshots.sql`. Neither ran in a tagged release: the
`wave-2` fixture's migration head is `0014`. `apps/runtime/test/migration-safety.postgres.test.ts`
proves the backfill and contract-step rules in `test:db`.

The Hyperdrive adapter uses `pg` 8.23.1 with one connection owned by each operation,
opened from its binding connection string and closed in `finally`. Cleanup rolls back
unfinished transactions. The operation-owned Client error listener retains connection
failures through cleanup so they cannot produce a successful result. Ending a connection can
discard a termination the operation has not read yet: on Workers, `pg-cloudflare`
1.4.1 `CloudflareSocket.close()` drops data its read loop has not delivered and reports no
error; on a Unix socket (local and CI) `pg` ignores its Terminate write's EPIPE while ending.
Node over TCP, with or without TLS, reads the termination before the socket closes. So the
authentication and authorization reads (`authenticationRead` in
`apps/runtime/src/cloudflare-entry.ts`) confirm their session: once the read succeeds, one
`SELECT 1` on the same connection, which a termination fails on every transport, refuses
the read. A failure the confirmation sees without the server's error carries SQLSTATE 08006
(connection failure). It costs one round trip per successful authority read. What decides it
is the rule for authority: an authentication or authorization read that observes
a termination refuses. Canonical state and journal results stay valid after a later
termination, which would only turn them into a retry, so they do not confirm, and on Workers
and a Unix socket a termination after their last reply is not observed. That includes the
canonical state read whose `authorityEpoch` the scene-join assertion signs: the request's
authority was already decided by confirmed reads, and the epoch is a value the server returned. Nor is one that reaches any connection
only while it closes, after every read. Serialized JSON strings and `Uint8Array`
bytes retain their existing meanings. In `socket` mode the disposable test encodes a NUL-prefixed
full abstract socket address in the URL's `host` parameter; the adapter uses pg's declared
`stream` configuration and a real Node socket for that address. Ordinary Hyperdrive URLs, and
`loopback` mode's `127.0.0.1` URLs with their per-run password, retain default transport. Better Auth
uses Kysely's built-in `PostgresDialect` with a separate request-owned pg `Pool` limited
to one connection, destroyed in `finally`, and its own least-privilege session-storage role.
Pool and borrowed-client errors refuse authentication, including errors observed while
identity mapping or cleanup is pending.

## Transaction-local runtime authorization

Every application database operation starts a short transaction and installs all request authority
with transaction-local configuration:

```sql
BEGIN;
SELECT set_config('app.tenant_id', :tenant_id, true);
SELECT set_config('app.principal_id', :principal_id, true);
SELECT set_config('app.privacy_ceiling', :privacy_ceiling, true);
-- authorized statements
COMMIT;
```

The privacy value is JSON in the accepted version-1 shape
`{"version":1,"allowedCategories":[...]}`. Categories are exactly `public_scene`,
`private_cognition`, `conversation`, `credential`, and `operator_evidence`. This is a set, not a
scalar ordering. Duplicate or unknown categories fail closed, and privacy never grants tenant,
world, timeline, actor, session, or principal authority. No connection-session `SET` state is used.

RLS is enabled and forced on every runtime tenant-owned table. Its policies require a matching
tenant/principal membership, and privacy-bearing rows additionally require explicit category
membership. The real PostgreSQL test reuses one connection across transactions and proves that
tenant, principal, and privacy authority disappear after commit; it also proves cross-tenant reads
and writes fail.

`tests/database/authorization.sql` is the attack suite, run as the runtime role over the seeded
tenants plus the hostile-looking tenants in `hostile-fixture.sql`. It proves that:

- cross-tenant UPDATE and DELETE reach no rows, with and without a `WHERE` clause (a bare
  statement needs no SELECT rights, so only the write policies decide), and moving a row into
  another tenant is refused;
- UPDATE and DELETE of `events`, `event_dispatches` and `authority_decisions`, and DELETE of
  `command_receipts`, fail with `insufficient_privilege` in every context (before migration `0006`
  these statements reached zero rows; immutability now lives in the database), and an UPDATE that
  reaches a terminal receipt is refused by its guard;
- SQL metacharacters, LIKE wildcards, case and whitespace variants, confusable or invisible Unicode,
  and oversized values in tenant, principal and privacy-ceiling context never match another
  tenant or widen a ceiling;
- errors and refusals carry no other tenant's identifiers, a refusal for an existing foreign
  identifier equals one for an unknown identifier, and hidden rows are never evaluated (no
  error, no leaky function call);
- tables the runtime role has no privilege on (`world_memberships`, `inspector_accesses`,
  `runtime_operator_actions`, `clockgrove_management.principals`, `identity_links` and
  `workspace_memberships`) hold fixture
  rows that the runtime role can neither read nor write, and the world birth tables in
  `clockgrove_birth` accept no cross-tenant read, UPDATE, DELETE, INSERT or tenant-moving UPDATE;
- `record_inspector_access` records an allow only for a tenant member and a deny for any installed
  principal under an existing tenant (a deny naming no stored tenant writes nothing), takes tenant and principal only from the installed context, and refuses a missing
  principal, an invalid decision or reason, and an oversized ID;
- `record_runtime_operator_action` follows the same rules, and `repair_world_reaction_publication`
  needs a tenant member, reaches only a failed world-reactions row of that tenant in the named
  scope, and changes only its status and lease fields.

The attack suite covers every RLS table. It carries its own explicit list of exercised tables
(`attack_surface`), and each attack block iterates that list. A completeness check compares the list
with every RLS-enabled table in the `clockgrove`, `clockgrove_auth`, `clockgrove_management` and
`clockgrove_birth` schemas and fails, naming the table, on any RLS table the suite does not exercise.
`pnpm run test:db` also runs the suite against a disposable database holding an extra RLS table the
suite does not exercise, and fails unless the suite fails there and names that table. A new RLS
table therefore needs a row in `attack_surface`, fixture rows in `seed.sql` and `hostile-fixture.sql`,
and its attacks in `authorization.sql`.

`tests/database/journal-immutability.sql` runs in `test:db` as `clockgrove_admin`,
`clockgrove_migrator` and `clockgrove_runtime` and proves the receipt state machine and the
immutability rules of the next section for each role.

`apps/runtime/test/journal-isolation.postgres.test.ts` runs in `test:db` and drives
`PostgreSqlJournal` and its event reader on one reused `pg` connection. It alternates tenants and
privacy ceilings, injects failures at the first and last server-side stage and after COMMIT, and
sends hostile identifiers and payloads. After each step the connection holds no authority and sees
no rows.

### One transaction per client

A `PostgreSqlClient` is one connection, and a connection runs one transaction at a time. If two
calls shared a client at once, one call's authorization settings and statements would land inside
the other's transaction. Some adapters also await non-database work (WebCrypto) while their
transaction is open, so the overlap is easy to hit.

- Wave 3 composition gives each request its own client (one connection per request), as
  `withHyperdrivePostgreSqlClient` does. Never share a client across concurrent calls.
- Every adapter opens its transaction through `withClientTransaction` in
  `packages/persistence/src/postgres-transaction.ts`. It refuses a second transaction on a client
  that already has one in flight with `ConcurrentClientTransactionError`, before sending any
  statement, so a mis-composed caller fails closed instead of crossing authorization contexts.
  Nesting one adapter call inside another's transaction on the same client fails the same way.
- New adapters use the same helper; no adapter sends `BEGIN` itself.

`journal-isolation.postgres.test.ts` starts two tenants' reads on one client at once and proves
that the first returns only its own rows, the second is refused, and the connection stays clean.

## Attributed receipts and authority decisions

Migration `0006_attributed_receipts.sql` is additive. It replaces `clockgrove.execute_journal` with
`CREATE OR REPLACE` (see `docs/runbooks/journal-replay.md`) and changes no earlier migration or
stored event bytes.

`clockgrove.command_receipts` gains `provenance` (`attributed` or `legacy-wave0`), `attribution`,
`action_id`, `correlation_id`, `causation_id`, `expected`, `authority_decision_id` and `failed_at`,
and its status set gains `failed`. Receipts that existed before the migration become
`legacy-wave0` with no attribution, ActionId or decision; their `correlation_id` and `expected` are
filled only from facts already stored (their first event's correlation, else the command bytes'
context, and the command bytes' expected values). New rows must state their provenance. CHECK
constraints require an attributed receipt to carry attribution, an ActionId equal to
`attribution.causalRootActionId`, correlation and expected values, and a decision reference exactly
when it is not pending; `committed_at` is set exactly for `committed` and `rejected`, `failed_at`
exactly for `failed`.

`clockgrove.authority_decisions` holds one immutable allow or deny decision per `(tenant_id,
command_id)`, keyed by `(tenant_id, authority_decision_id)`: outcome, world, timeline, ActionId,
attribution, inputs, `reason_code` (present exactly for deny) and `decided_at`. It references its
receipt and its timeline; the receipt references its decision through `(tenant_id,
authority_decision_id, command_id)`. No foreign key points from existing events to decision rows. It
has forced tenant RLS (`tenant_isolation`, no privacy class) and is part of the attack suite.

Receipt state machine (trigger `command_receipts_guard_transition`, SQLSTATE `CG006`):
`pending -> committed | rejected | failed`; terminal receipts never change ("command receipt is
terminal"). Tenant, command ID, request hash, bytes, target, provenance, attribution, ActionId,
correlation, causation, expected revisions, `created_at` and, once set, the decision reference never
change ("command receipt identity is immutable"), and receipts are never deleted. Triggers apply to
every role, owner and superuser included:

- `command_receipts_guard_transition` (BEFORE UPDATE OR DELETE) and
  `command_receipts_immutable_truncate` (BEFORE TRUNCATE) on receipts;
- `authority_decisions_immutable_rows` (BEFORE UPDATE OR DELETE) and
  `authority_decisions_immutable_truncate` (BEFORE TRUNCATE) on decisions.

Grants: the runtime role has `SELECT, INSERT` on `authority_decisions`, `events` and
`event_dispatches` (UPDATE and DELETE on the last two are revoked) and `SELECT, INSERT, UPDATE` on
`command_receipts` (DELETE is revoked). Dispatch rows change state only through the migrator-owned
functions of migration `0009` (see "Dispatch claims and leases"), which only the runtime role may
execute. `pnpm run db:verify` checks the new table's forced RLS, these four triggers, these privileges
and the dispatch function grants on the empty and the representative database.
`apps/runtime/test/attributed-receipts.postgres.test.ts` applies `0001`–`0005`, commits Wave 0 and
world-birth history through the old function, applies `0006`, and proves the history unchanged,
legacy receipts decoded as `legacy-wave0`, and exact legacy retries returning the stored result.

## Partition-state projection

Migration `0007_partition_state_projection.sql` is additive. It adds `clockgrove.partition_states`, one
hashed state document per partition (the world state, schedule queue and named random state of the
Wave 1 kernel), with its kernel `revision`, `covered_head_sequence` (the journal head it covers),
`simulation_time`, `document` (a typed canonical node), `document_hash` and `state_hash`. It references
its partition through `(tenant_id, world_id, timeline_id, partition_id, space_id)`, has forced tenant
RLS (`tenant_isolation`, no privacy class: the ceiling applies to event reads, not to the kernel's
state load) and is in the attack suite as an `insert_update` table. Trigger `partition_states_guard`
(SQLSTATE `CG006`) keeps identity immutable, never lets revision or covered head move back and
refuses DELETE for every role; the runtime role has `SELECT, INSERT, UPDATE`. The `WorldReady`
transaction writes a world's first row.

It also replaces `clockgrove.execute_journal` with a wrapper over the new `clockgrove.begin_command`
and `clockgrove.append_command` (see `docs/runbooks/journal-replay.md`), both executable by the runtime
role only. `pnpm run db:verify` checks the table's forced RLS, policy, trigger, privileges and function
grants, and that migrations alone leave it empty. `apps/runtime/test/world-command.postgres.test.ts`
runs in `test:db`.

## Durable schedules and continuations

Migration `0008_durable_schedules.sql` moves the kernel's schedule queue out of the partition-state
document (Wave 2 plan §7.3). `clockgrove.partition_schedules` holds one row per scheduled occurrence
`(schedule_id, idempotency_key)` of a partition: its indexed fields (`due_at`, `priority`,
`tie_break_key` in `COLLATE "C"` byte order, kind, payload version, catch-up class, supersession), the
typed canonical node of the complete kernel `item` and its `item_hash`, `status` (`pending` or `done`),
and `scheduled_by_command_id` / `completed_by_command_id`. `pending` rows are the live queue. Two partial
unique indexes over pending rows keep one entry per schedule ID and the due index
`partition_schedules_due_idx` `(tenant_id, timeline_id, partition_id, due_at, priority, tie_break_key)`,
which serves the due query and the next-deadline query in the kernel queue's order. The table has
forced tenant RLS, the attack suite exercises it as an `insert_update` table, and trigger
`partition_schedules_guard` (`CG006`) keeps identity immutable and refuses DELETE for every role,
except of a `done` row completed more than 90 days ago (migration `0027`). The runtime role holds no
DELETE; the statement trigger `partition_schedules_retire_done` retires up to 100 such rows of each
partition whose occurrence a statement completes. Receipts and authority decisions are never retired;
`db/retention.json` gives each table's reason.

`partition_states.document_version` moves to 2: the document holds the world state, the named random
state and the hash of the schedule queue, so a reader that rebuilds the queue from the pending rows
detects a dropped, added or changed row (`PartitionStateIntegrityError('schedule-mismatch')`). The
state hash is unchanged (`sha256(canonicalBytes(state))`). No version-1 row exists outside disposable
databases, so there is no backfill; the migration fails on a leftover one. New nullable columns
`continuation`, `continuation_hash` and `continuation_command_id` (all or none) hold the open
continuation of an incomplete kernel result.

`clockgrove.append_command` is replaced: it applies the command's schedule mutations
(`schedules: {done, put}`, required exactly when it writes state; `done` first, then `put`) and the
continuation in the same transaction as the events and state, raises `CG010` for an event ID that
already exists or repeats in the batch, `CG011` for a `done` entry that names no pending row, and adds
the `after-schedules` fault point. The `WorldReady` transaction writes the birth queue as pending rows.
`pnpm run db:verify` checks the table's forced RLS, policy, trigger, due index and privileges.

## Dispatch claims and leases

Migration `0009_dispatch_leases.sql` lets a dispatcher lease and settle `event_dispatches` rows while
the runtime role keeps no UPDATE or DELETE grant. Migrator-owned SECURITY DEFINER functions own
every transition. The migrator bypasses RLS, so both filter with `clockgrove.runtime_can_access`
themselves: they reach only the installed tenant's rows within the installed privacy ceiling.

- `claim_dispatches(channel, limit, lease_owner, lease_ms)` leases due rows (`pending`, or `leased`
  with an expired lease) oldest first with `FOR UPDATE SKIP LOCKED`, so concurrent claims are disjoint.
  It sets `status = 'leased'`, increments `attempts` and stores the lease expiry in `next_attempt_at`,
  so one predicate and `event_dispatches_pending_idx` cover pending rows and expired leases.
  Migration `0021_dispatch_claim_backlog_age.sql` adds `backlog_age_ms` to its result: each
  claimed row's age since `created_at`, on the database clock, for the dispatch backlog age metric.
- `settle_dispatch(dispatch_id, attempt, outcome, error_class, retry_after_ms)` settles `delivered`,
  `failed` (both terminal, with `settled_at`) or `retry` (back to `pending` after the delay). The
  attempt number is the fencing token: unless the row is `leased` at exactly that attempt it returns
  false and changes nothing, so a holder whose lease was reclaimed can never settle.

New columns: `lease_owner` (required while leased), `last_error_class` (`retryable` or `permanent`),
`settled_at` (set exactly for terminal rows) and `created_at` (backlog age). The adapter is
`PostgreSqlDispatchStore`; `apps/runtime/test/dispatch-claims.postgres.test.ts` runs in `test:db`.

### World-reactions consumption and recovery

Migration `0024_world_reaction_consumption.sql` adds `consumed_at` and `consumed_principal_id` to
`event_dispatches`. Publication `status = delivered` means the Queue accepted a message; it does
not mean a consumer committed its disposition. A non-null `consumed_at` means canonical batch
verification committed. The principal is the world's fixed `system:world:<world_id>` identity.

`PostgreSqlDispatchStore.consumeWorldReaction` resolves that identity from the canonical dispatch,
installs only a public-scene privacy ceiling transaction-locally, and calls `consume_world_reaction`.
The function locks the source dispatch, compares canonical envelope identity/scope/payload, and
checks that the committed receipt's entire ordered event-ID list matches its command's actual
committed events, source anchor and event count. All events must share the canonical route,
correlation and public privacy class. The function records one disposition, returns `duplicate` on
redelivery, and returns `invalid` without success for inconsistent input. Database operational errors
propagate for transport retry; they are not malformed-input classifications. Consumption writes
neither events nor physical state and runs no simulation or other effects.

The trusted runtime resolves due background authority through `due_world_reaction_principals`;
scheduled reconciliation queries all due public world-reactions work after hint loss or isolate
replacement. The post-commit wake skips this query and claims as the committing world's system
principal. Its page bound reuses the adapter's existing 1,000-claim maximum. Autonomous claim and settle operations additionally require
the principal's canonical world to match the dispatch's world; member callers retain existing
claim/settlement semantics. Lease expiry and attempt fencing still govern publication recovery.

The scheduled snapshot sweep finds its work the same way, through
`clockgrove.snapshot_due_partitions(compatibility, interval, limit)` (migration
`0030_snapshot_due_partitions.sql`, `PostgreSqlSnapshotStore.duePartitions`). This `SECURITY DEFINER`
function, executable only by `clockgrove_runtime`, returns up to `limit` partitions of ready worlds
with no open continuation, each with its world's system principal. A partition qualifies when it has
no snapshot under `compatibility` plus its world's pack hash, or its committed head is at least
`interval` events past the latest such snapshot, and its head is past every snapshot it has. The
least recently attempted come first, then the most behind. The function's only write is
`partition_states.snapshot_attempted_at`, stamped on each partition it returns, a fixed-size
operational column like `catch_up_reconcile_attempted_at` (0026). Every read and write the sweep then
makes runs under the partition's principal and RLS. See
[runtime.md](runtime.md#scheduled-snapshots-and-verification-replay).

Operators inspect a scope's unconsumed dispatches (publication `status`, `attempts`,
`last_error_class`, times and the DLQ reason) through the authenticated runtime-state inspector, and
recover them through the operator actions, not a database role (see
[runtime.md](runtime.md#world-reactions-queue-lifecycle)); transport attempts differ from publication
attempts. Do not emit payloads to unrestricted logs. A delivered dispatch without consumption may
still be in flight or awaiting retry or DLQ replay. Replay sends the original canonical envelope
after the operational cause is corrected, preserving its message ID; successful prior consumption
remains a duplicate. A failed publication remains operator-visible and must be repaired explicitly,
rather than being mistaken for successful consumption.

Migration `0031_runtime_operator_actions.sql` adds what those paths need:

- `repair_world_reaction_publication(world, timeline, space, message)`, a migrator-owned SECURITY
  DEFINER function only the runtime role may run. As a tenant member under the installed authority,
  it returns a `failed`, unconsumed world-reactions row of the named scope, visible under the ceiling,
  to `pending`, due now, changing only `status`, `lease_owner`, `next_attempt_at` and `settled_at`;
  `attempts` keeps counting, so the attempt fence stays monotonic. It writes the action's audit row
  in the same transaction.
- `clockgrove.runtime_operator_actions`, the append-only audit of every repair and replay, accepted
  or refused, with forced tenant RLS and no runtime privilege: the runtime appends only through
  `record_runtime_operator_action`, which takes tenant and principal from the installed context,
  limits a principal to 300 rows per tenant an hour and retires the tenant's rows after 90 days. It is
  not part of the journal: an action writes no event, command receipt or authority decision.
- `event_dispatches.dead_letter_class` and `dead_lettered_at`, set together by
  `record_world_reaction_dead_letter(tenant, message, class)` when a consumer's last delivery attempt
  of a public world-reactions message fails; overwritten in place by a later dead letter, never
  touching publication or consumption.
- The partial index `event_dispatches_unconsumed_world_reactions` over unconsumed world-reactions rows,
  for the inspector's list.
- `inspector_accesses.subject` (`causal-chain` or `runtime-state`), with `command_id` required
  exactly for the causal chain, and a seven-argument `record_inspector_access` that takes it; the
  six-argument form records a causal-chain access, for code that predates it.

Migration `0035_observer_world_readiness.sql` adds the world reader's `observable_world_readiness(tenant, world, timeline, space)`, a migrator-owned SECURITY DEFINER function keyed on `app.principal_id` that answers `ready`, `provisioning`, `failed` or nothing (see the observation protocol).

Migration `0033_inspector_entry_points.sql` adds the subjects `event`, `scheduled-action` and
`client-view` to `inspector_accesses`, and an `entry_id` column that holds the event ID or the
canonical JSON `[scheduleId, idempotencyKey]`. The column is required for those two subjects and
empty otherwise, and holds at most 2100 octets (two 1024-octet IDs plus JSON syntax). An eight-argument
`record_inspector_access` takes the entry. The seven-argument form records an access without one.
Grants, rate limit and retirement do not change.

When the two fields disagree, `consumed_at` wins. A publish that timed out after the Queue accepted
the message can leave `status = 'failed'` with `consumed_at` set: the batch was verified, so the row
needs no recovery. `status` records only what the publisher saw; consumption is the end-to-end fact.
Treat only `failed` rows with `consumed_at IS NULL` as needing republication.

Retention: consumption occupies columns on the existing dispatch row, so duplicates allocate no
new evidence and never change the successful timestamp or principal. Keep that evidence for the
whole source-dispatch lifetime, including transport and DLQ replay. Dispatches currently have no
retirement. Any future source retirement must first establish that Queue/DLQ redelivery is no longer
possible. No new table is introduced, so the attack suite's explicit RLS table membership remains
unchanged; it additionally exercises these consumption columns and functions.

Native local Queue transport plus disposable PostgreSQL provides local evidence only. Passing
local commands does not establish hosted deployment behavior or full Wave 3 qualification.

## Artifact store

Migration `0012_artifact_store.sql` (RW-0207, issue 667) holds all artifact schema.

- `artifact_references` stores either `inline_content` (at most 131072 bytes) or a `storage_key`,
  never both. `content_hash` is `sha256:<hex>` of the stored bytes; CHECKs tie inline bytes to their
  hash and length, and a spill key to `<retention_class>/<tenant hex>/sha256/<hex>`, where the tenant
  segment is the lowercase hex of the UTF-8 tenant ID, so a row can only name its own tenant's object.
  Encrypted rows are at least 29 bytes, and inline ciphertext starts with the envelope version `0x01`. `retention_class` is
  `durable` or `ephemeral` (R2 expires the `ephemeral/` prefix).
- Every class except `public_scene` is stored as AES-256-GCM ciphertext (`encryption =
  'aes-256-gcm-v1'`) under a recorded `data_key_version`; `credential` is refused. No plaintext hash
  is stored.
- `artifact_data_keys` holds one KEK-wrapped data key (61 bytes) per tenant, world, private class and
  version. The KEK never reaches PostgreSQL. Forced RLS uses the privacy ceiling, so a principal
  without the class cannot read the wrapped key.
- The runtime role may only append artifacts. On data keys it may insert and update `kek_id` and
  `wrapped_key` (rewrap), never delete. Support and backup have no privilege on either table.

`pnpm run db:verify` checks the privileges and that the migrator is refused by each named CHECK;
`pnpm run test:db` runs the attack suite over seeded rows of both tables in two tenants.

The adapter is `PostgreSqlArtifactStore` (port `ArtifactStore`). Every call reauthorizes in short
authorized transactions, never inside a journal transaction. A get selects by the full scope, so
another tenant, a ceiling without the class, an altered scope and a missing ID all give the same
`ArtifactNotFoundError`; bytes are returned only after their length and SHA-256 match. Public JSON
and `text/*` artifacts up to 128 KiB are stored inline. Private classes are sealed (envelope v1) under
their (tenant, world, class) data key, created on first use and wrapped by the `keyring` option
(`KeyEncryptionKeys`, `WebCryptoKeyring.fromJson(ARTIFACT_KEYRING)`); without a keyring or with an
unknown KEK they fail closed with `ArtifactKeyUnavailableError`, and a failed unwrap or tag is
`ArtifactIntegrityError('decrypt')`. `apps/runtime/test/artifact-store.postgres.test.ts`
runs in `test:db`.

Larger or binary artifacts spill to the `bucket` option (`R2BucketLike`, the `put`/`get` subset of the
Workers R2 binding) at `<retention>/<tenant hex>/sha256/<hex>`. The object is written with its
`sha256` before any SQL, so a crash leaves only an orphaned object that a retry overwrites. A get
fetches the key from the authorized row after COMMIT, never from the caller, so a denied read makes no
bucket call; a missing, truncated or altered object is `ArtifactIntegrityError` (`missing`, `size`,
`hash`) and returns no bytes. Without a bucket, spilling fails with
`ArtifactBlobStorageUnavailableError`. `MemoryR2Bucket` is the local fake.

The runtime composes the store with `composeArtifactStore` (`apps/runtime/src/cloudflare-entry.ts`)
over the `ARTIFACTS_BUCKET` R2 binding, narrowed to `put` and `get` by `workersR2Bucket`. Every
`infra/wrangler/<env>.json` binds `ARTIFACTS_BUCKET` to that environment's
`resources.buckets.artifacts` (for example `rw-local-artifacts`), and `pnpm check` refuses a manifest
that names another bucket (`infra/check-configuration.mjs`). No artifact keyring is bound, so the
composed store stores `public_scene` only and refuses every other class with
`ArtifactKeyUnavailableError`. `apps/runtime/test/runtime-snapshots.postgres.test.ts` (in
`test:runtime`) runs the composed store in the native workerd/PostgreSQL harness against a Miniflare
R2 bucket: a JSON artifact one byte over the inline limit spills to its content-addressed key and
round-trips, a rewritten object is `ArtifactIntegrityError('hash')`, another tenant's read is
`ArtifactNotFoundError` and a private put is refused. The staging round trip stays pending on
issue 3.

### Artifact key rotation

- **Data key:** `rotateDataKey(authorization, { tenantId, worldId, privacyClass })` adds version N+1
  under the current KEK. New puts use the highest version; old artifacts keep their recorded version
  and stay readable. Nothing is re-encrypted, so hashes, spill keys and metadata never change.
- **KEK** (the `ARTIFACT_KEYRING` secret, a reviewed dual-key transition):
  1. Deploy a keyring holding the old and new KEK, with `current` set to the new one.
  2. For each tenant, run `rewrapDataKeys(authorization, { fromKekId: "<old>" })` with a principal
     whose ceiling holds every private class. It rewrites only `kek_id` and `wrapped_key` and is
     idempotent.
  3. When `SELECT count(*) FROM clockgrove.artifact_data_keys WHERE kek_id = '<old>'` is 0 (as the
     migrator), deploy a keyring without the old KEK.
- Removing a KEK while any row still references it fails closed: those artifacts are unreadable and
  puts in their scope are refused, writing nothing. Restore the KEK and finish the rewrap.

## Conversations

Migration `0034_conversations.sql` (Wave 5 RW-0501, issue 14) holds the private conversation
schema: `conversation_sessions`, `conversation_participants`, `conversation_messages` and
`conversation_turns`.

- **Participant scope:** each table has the `participant_isolation` policy, which is
  `runtime_can_access(tenant_id, 'conversation')` and
  `runtime_conversation_participant(tenant_id, session_id)`: the installed principal has a row in
  the session's participant set. That function is migrator-owned `SECURITY DEFINER`, so the
  policies never recurse. A member of the same tenant and world, a ceiling without
  `conversation`, and another tenant see no row and write none.
- **Participants:** one immutable row per human participant (principal and persona). A member
  inserts only their own row, and only before the session row in the transaction that creates it
  (the key to the session is deferred to commit); `guard_conversation_participant` refuses joining
  an existing session with `CG020`. A Caretaker message names its author participant and persona
  through a key to the participant set, and an actor answer names none. A turn names the
  participant whose message opened it.
- **Text is ciphertext:** a message's `content_artifact_id` and a session's `title_artifact_id`
  name `conversation`-class artifacts through `(tenant_id, artifact_id, privacy_class)`. That is
  why 0034 adds the `artifact_references_class_key` unique key. The class is always encrypted
  (0012).
- **Immutability:** the runtime role may only insert participants, messages and turns. Triggers refuse UPDATE,
  DELETE and TRUNCATE with `CG006`. On a session it may update only `state`, `title_artifact_id`,
  `message_count` and `updated_at`, and it may never delete one.
- **Guard:** `guard_conversation_session` starts every session active, empty and untitled. It
  keeps `deleted` terminal, lets `message_count` only grow and only while active, and admits at
  most 100 sessions that are not deleted per participant and world timeline (`CG021`). Other
  guard refusals are `CG020`.
- **Ordering:** messages are numbered from 1 per session (at most 1,000). Turns are numbered from 1
  (at most 500), and each turn's output follows its input. The store locks the session row to
  append one turn's two messages.
- **Retention:** see `db/retention.json`. Delete is a tombstone, and the ciphertext stays until
  Wave 9's crypto-shred.

## Run and step evidence

Migration `0036_agent_runs.sql` (Wave 5 RW-0502, issue 15) holds `agent_runs` and `run_steps`.
See [run and step evidence](../protocols/runs.md).

- **Policies:** `run_reader` admits `runtime_can_access(tenant_id, 'operator_evidence')`, or a
  `conversation` ceiling and participation in the run's session. `run_writer` (INSERT) and
  `run_closer` (UPDATE) admit only a participant, and a run's `principal_id` must be the installed
  principal. An inspector reads and never writes.
- **State machine:** `guard_agent_run` and `guard_run_step` (`SECURITY DEFINER`) start every run
  `running`, with `root_run_id` equal to itself or to its parent's root and session. They allow a
  run or step one change only, from `running` to a terminal status, and stamp `ended_at`. They
  refuse completing a run with an open step, and close a run's open steps with any other
  disposition. They number steps in order from 1 inside a running run, and admit at most 2,000 runs
  per session (`CG021`). Other refusals are `CG020`. The runtime role may update only the
  disposition columns. DELETE and TRUNCATE are refused.
- **Payloads:** `prompt_artifact_id`, `input_artifact_id` and `output_artifact_id` name
  `conversation`-class artifacts through `artifact_references_class_key`. `command_id` names a
  `command_receipts` row and `output_message_id` a message of the run's session.
- **Audit:** 0036 adds the `agent-runs` subject to `inspector_accesses`.

## Actor documents and context manifests

Migration `0037_actor_documents.sql` (Wave 5 RW-0505, issue 17) holds `actor_documents`,
`actor_document_versions`, `document_change_sets` and `context_manifests`. See
[context assembly](../protocols/context-assembly.md).

- **Policies:** document rows are read and written by a `private_cognition` ceiling, or by a
  participant of a session that addresses the actor (`runtime_actor_participant`). That participant
  never reads another session's summary, and creates only `actor_writable` documents. Change sets
  are written by their own principal: an operator's needs `private_cognition`, a model's comes from
  its session's participant. They are read by their author, `private_cognition` or
  `operator_evidence`. Manifests follow the run policy of 0036.
- **Guards:** the path fixes the kind and the kind fixes the write class (CHECKs).
  `guard_actor_document_version` (`SECURITY DEFINER`) admits a version only from a committed change
  set of the same actor whose proposer may write that class, as the head plus one, and moves the
  head. Its refusals are `CG023` (class or authority) and `CG024` (version). `guard_actor_document`
  admits at most 256 documents per actor (`CG022`). The source hash and size are CHECKed against
  the text. Versions and manifests are immutable, and DELETE and TRUNCATE are refused. Refused
  change sets retire after 90 days (`retire_refused_change_sets`).
- **Candidates:** `actor_context_candidates(tenant, session)` (`SECURITY DEFINER`) returns document
  metadata, never text, to a participant of the session only.
- **Audit:** 0037 adds the `context-manifest` and `actor-documents` subjects to
  `inspector_accesses`.

## Model-backed turns

Migration `0040_model_turns.sql` (issue 19) replaces `conversation_turns_model_check`, which allowed
only `scripted-fixture-v1`, with a pattern for a route's model name
(`^[a-z0-9][a-z0-9._-]{0,127}$`). The fixture's name still matches. See
[capabilities](../protocols/capabilities.md).

## Turn fibers and actor processes

Migration `0038_turn_fibers.sql` (Wave 5 RW-0503, issue 18) holds `conversation_turn_fibers`,
`actor_processes` and `actor_process_segments`. See
[recoverable turn fibers](../protocols/conversation-fibers.md).

- **Policies:** a turn fiber has the participant policy of a session's turns (0034): only a
  participant under a `conversation` ceiling sees or writes it, as themselves. Processes and
  segments have tenant isolation (`has_runtime_context`).
- **State machine:** `guard_turn_fiber` starts every turn `accepted` at attempt and lease epoch 0,
  moves its phase only forward in §7.1 order, freezes a terminal turn and a checkpointed answer,
  and lets the lease epoch only grow, with each claim one attempt. It admits at most 1,000 turns a
  session (`CG021`). A unique partial index allows one open turn a session. The runtime role may
  update only the checkpoint columns.
- **Processes:** `guard_actor_process` keeps a process's lease epoch, checkpoint and segment count
  from decreasing and gives a completed process no new lease. `append_actor_process_segment` admits
  a segment only under the process's current lease epoch and holder (`CG022` otherwise), only from
  its checkpoint, and moves the checkpoint (at most 64 segments). The runtime role may update only
  a process's lease. Segments never change.
- DELETE and TRUNCATE are refused on all three. Retention: see `db/retention.json`.

## Snapshots

Migration `0013_partition_snapshots.sql` (RW-0208, issue 677) constrains `snapshots`.

- A row indexes one artifact of its own tenant, world, timeline, partition, space and privacy class:
  the only artifact foreign key, `snapshots_artifact_target`, covers all seven columns.
- `covered_partition_sequence` is the partition head the snapshot covers; `covered_sequence` is the
  route stream's sequence at that head and may not exceed it. `snapshots_partition_head` allows one
  snapshot per covered head and serves "latest snapshot at or before a head".
- `state_hash` is 64 lowercase hex characters, as in `partition_states`; `compatibility` is a JSON
  object.
- The runtime role may only append snapshots. Support and backup have no privilege.

`pnpm run db:verify` checks the privileges, the foreign key and that the migrator is refused by each
named constraint; `pnpm run test:db` runs the attack suite over seeded snapshots in two tenants.

## Preview effect policy

Migration `0011_preview_effect_policy.sql` adds trigger `event_dispatches_preview_effect_policy`
(BEFORE INSERT on `clockgrove.event_dispatches`). It refuses an `external-effects` dispatch unless its
timeline's kind is `live`, with `CG012` (`JournalPreviewEffectRefusedError`), so the whole command
writes nothing. A timeline the inserting role cannot see counts as not live. This is the Wave 2
enforcement of the preview gate: the `effect_intents` table is deferred to Wave 5, the first wave that
produces an external effect. Simulate mode is not built. `pnpm run db:verify` checks the trigger;
`apps/runtime/test/journal-isolation.postgres.test.ts` covers branch refusal and live commit.

## World birth tables and provisioning cases

Migration `0004_world_birth.sql` adds schema `clockgrove_birth` (runtime role has `USAGE`). Worlds,
timelines, partitions, streams and events stay in `clockgrove`; after migrations alone every new
table and `clockgrove.worlds` are empty. PostgreSQL CHECK constraints restrict
`worlds.lifecycle_status` to `initializing|provisioning|ready|archived`, `timelines.kind` to
`live|branch` and `timelines.state` to `active|archived`; the installation and case status columns
carry their own CHECK sets, and composite foreign keys reject references across
tenant/world/timeline/partition scopes.

Table families (all carry `tenant_id`, with RLS enabled and forced, policy `tenant_isolation`):

- `pack_artifacts`, `pack_artifact_resources`: the stored immutable pack artifact and its resource bytes.
- `provisioning_cases`: one row per case identity; the only table the runtime role may update.
- `pack_installations`: one installation per case (`installation:<caseId>`).
- `world_birth_states`, `birth_state_sections`, `birth_space_state`, `birth_schedules`,
  `birth_random_streams`: versioned birth state scoped by tenant/world/timeline, and by
  partition/space where partition-relative, plus clock policy and simulation epoch.
- `birth_cognitive_seed_refs`: cognitive seeds as `(seed id, sha256)` references into
  `pack_artifact_resources`; their content is not copied.

Case state machine (trigger `guard_case_transition`, SQLSTATE `CG006` on a bad move):
`requested -> seeding | failed`, `seeding -> verified | failed`, `verified -> ready | failed`.
`ready` and `failed` are terminal. Case identity is immutable, `world_id` is immutable once set,
counters only advance (`seeded_commands` by at most one per update), and a case may become `ready`
only when its world is `ready`. Reusing a case identity with a different request raises
`ProvisioningCaseConflictError`; a new case for an already installed `packId`/`version` with a
different `contentHash` raises `PackVersionConflictError` (`PACK_VERSION_CONFLICT`).

Immutability: `UPDATE`, `DELETE` and `TRUNCATE` on the nine tables other than `provisioning_cases`
are rejected by `reject_mutation` triggers with `CG006` ("rows are immutable"), including for the
owner role; the runtime role additionally has only `SELECT` and `INSERT` on them.

Readiness gating: a world is `ready` only after `WorldReady` commits, which happens after the stored
birth rows reconstruct to the pack's `expectedSeedProjectionHash`. Failed attempts record
attempt/failure evidence on the case and leave the world non-ready. `PostgreSqlWorldProvisioningStore`
accepts a test-only fault point (`genesis`, `seed-command-<n>`, `projection-verified`, `ready`, before
or after commit) to interrupt a stage; retrying the same case resumes at the first uncommitted stage.

World-scoped authority reads follow the same rule. Migration `0005_world_ready_authority.sql` adds the
migrator-owned `SECURITY DEFINER` predicate `clockgrove.world_is_ready(tenant_id, world_id)` and adds it
to the `scoped_authority_read` policy on `clockgrove.world_memberships`. A committed, unrevoked
membership therefore resolves through `PostgreSqlWorldAuthorizationReader.resolveWorld` only while its
world is `ready`; `initializing`, `provisioning` and `archived` worlds yield no authority. The
predicate is executable by `clockgrove_world_reader` alone, so the reader still holds exactly `SELECT` on
`clockgrove.world_memberships` and no grant on `clockgrove.worlds`. Runtime entry
(`PostgreSqlCanonicalRuntimeStateSource`) filters on `lifecycle_status = 'ready'` and changes no rows when
it refuses. `apps/runtime/test/world-readiness.postgres.test.ts` covers both in `test:db`.

`pnpm run db:verify` checks these tables, their forced RLS and privileges, and that the birth tables
and `clockgrove.worlds` are empty on the migrated empty database.

## Committed timeline clock policy

Clock controls share the existing receipt, authority decision and event transaction. `PauseWorld`,
`ResumeWorld` and `SetClockPolicy` atomically record `ClockPolicyChanged` and the resulting policy;
exact retries read the stored outcome without changing policy again. The canonical policy includes
a monotonic version used to fence trusted autonomous physical commits against superseding changes.
Clock changes leave the physical partition state, kernel revision, schedules and named random state
unchanged. Policy and version reconstruct after runtime-local loss; corrupt policy is a durable
integrity failure.

Clock storage remains tenant scoped under the existing runtime authorization and forced-RLS
boundary. It does not grant public authority or add browser-session credentials to trusted owner
execution. Migration `0015_timeline_clock_policy.sql` adds nullable canonical-node `clock_policy`
to `partition_states`, inheriting its forced tenant RLS and privileges. Missing projections reconstruct
the latest `ClockPolicyChanged` policy, or paused genesis defaults when no clock history exists.
Admission and every command transaction read that latest event under the partition lock through the
partial index `events_clock_policy_idx` (migration `0020`), a one-row seek whose size grows with
clock changes only, never with the partition's other events.
The runtime-only `resolve_ready_clock_principal` function resolves the world's system principal for
an exact installed, ready world and active timeline/space scope; it creates no principal or World
grant. Migration `0017_world_system_principal.sql` gives every world one `tenant_principals` row
`system:world:<world_id>` with `system_world_id` set, inserted by a definer trigger with the world row
and backfilled for existing worlds. The `system:` prefix is reserved: member and Management
principal IDs cannot use it, and the system principal has no identity link or World membership. The database attack suite checks the column and resolver scope/role boundaries, and migration
verification applies the addition on empty and upgraded databases. Existing table inventories need
no new table entry; historical migration bytes remain unchanged. The
[command protocol](../protocols/runtime-world-commands.md#timeline-clock-controls) defines payload
bounds, initial genesis speed, paused activation and the 86400000-simulation-millisecond initial cap.

## Fixture policy and exact commands

The base at `2666b16efcd62c6161079cda04248ffca959d7ef` had no supported prior-release database
schema fixture. None is fabricated. `db/fixtures/current-schema.sql` is representative data for the
current schema. If a genuine supported predecessor is added later, verification must add it without
removing empty/current coverage.

From the repository root:

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm run test:db
pnpm run test:replay
pnpm run db:verify
```

The first command runs real RLS, pooled-connection, role, receipt-immutability, atomic append,
concurrency, retry, failure-injection, decision, denial and legacy-upgrade checks, and the runtime
gateway over PostgreSQL (`apps/runtime/test/runtime.postgres.test.ts`). The replay command verifies accepted golden
upcasting and deterministic state evidence. The final command migrates both an empty database and a
fresh database upgraded from the immutable journal migration to the additive authentication migration
and loaded with the representative current fixture, verifies pgvector, required table families, roles, and exact cosine behavior, then cleans
up. Repository-wide validation remains:

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
pnpm test
pnpm run verify:docs
```

## Owned local backup/restore integrity

W0-010 qualification extends the existing disposable cluster with one custom-format pg_dump/
pg_restore roundtrip. Verified 18.6 tools restore into clockgrove_owned_restore, explicitly created
in the already owned cluster. Cluster-global accepted admin/migrator/runtime roles are verified
before restore; database dumps cannot recreate them. Checked migrations and the committed runtime
journal journey establish source history. Every canonical row is compared exactly, including bytea
command/event bytes, hashes, stable receipts, stream/partition heads and dispatch counts. Schema
ownership, runtime role isolation, forced RLS, pgvector 0.8.7 and extension index policy are checked.
Forced RLS is checked on every `clockgrove` table with a `tenant_id` column, without a fixed table
count; `test:db` proves the check fails once such a table lacks forced RLS.
The source is also compared after the restored-history operation. Dumps stay private below the
owned cluster root and are removed in finally; only comparison hashes/results enter evidence.
Success/failure cleanup drops only the explicitly created destination, then the existing cluster
lifecycle stops and removes its unique resources. Ordinary /tmp and long-TMPDIR probes stay intact.

## Native Workers fixture transport

Only the active fixture returned by `withDisposableDatabase` exposes `withLoopbackTransport`.
In `socket` mode its closure captures that exact freshly owned abstract PostgreSQL socket; it
accepts no discovered host/database target, and the bridge refuses any address but an owned
`\0clockgrove-` abstract one. The native test's temporary loopback TCP bridge binds only
`127.0.0.1` on an allocated port and pipes PostgreSQL wire bytes unchanged, with at most sixteen
connections and 35-second idle limits (longer than the owner's 30-second kernel bound). It
synthesizes no queries, results, credentials or authority. A synthetic local URL password
satisfies Miniflare's Hyperdrive configuration; the underlying disposable Unix socket retains its
existing trust policy. No PostgreSQL TCP listener is enabled. All bridge sockets close before the
server and the owned database shuts down, including callback failure.
In `loopback` mode there is no bridge: `withLoopbackTransport` hands the callback PostgreSQL's own
`127.0.0.1` port, and the native harness puts the run's password in its URLs. PostgreSQL's
`max_connections`, not the bridge's sixteen, then bounds connections, and the bridge-closure
probes in `native.postgres.test.ts` apply to `socket` mode only.
Native recovery compares all world, authentication and Management tables without changing the
existing portable backup/restore receipt format or rebuilding that delivered capability.


Database subprocesses share the owned process-group runner with CI command receipts. Tools have
thirty-second deadlines; each fixture inherits cancellation within a five-minute owner deadline.
Cancellation settles the child and its pipes before fixture cleanup.
An attempted `pg_ctl start` is cleaned up even if its wait failed after the postmaster started.
Cleanup runs outside the cancelled operation with a twelve-second bound. If the owned postmaster
cannot be confirmed stopped, its directory and ownership evidence are retained and the operation
fails; deleting files beneath a potentially live server is refused. CI command execution has a
thirty-minute deadline and thirty seconds for cooperative owner cleanup before forced termination.
Timeouts retain actual exit/signal/error observations and never become passing command evidence.

## Deploying a kernel registry change

A snapshot records the kernel registry hash it was written under, and `requireSnapshotCompatibility`
refuses any other. A change to the registry (a command or event version added or retired, as
`world.weather.set` v2 did in issue 740) therefore invalidates every existing snapshot and every exported
replay bundle. Snapshots are only a replay shortcut, so the deploy ships a migration that deletes the
snapshot index rows (`0029_drop_incompatible_snapshots.sql`). Replay bundles are re-exported after
the deploy (`exportReplayBundle`).

The old runtime keeps running its snapshot Cron Trigger between that migration and the new Worker
deploy, and during a gradual deployment. It finds every emptied partition due and writes snapshots
under the old registry hash. The new runtime never loads those: replay and verification pass over a
snapshot whose row names another compatibility set (`isSnapshotCompatible`), and do not report it as
a failure. `snapshot_due_partitions` counts only snapshots under the current set and the world's pack
hash, so each such partition stays due. Its first snapshot under the current registry is written on
the first run after its head moves past the old snapshot (a snapshot's ID and index slot derive from
its head). Partitions the old runtime did not reach are snapshotted at once. Both go through the
runtime's scheduled snapshot sweep (every 5 minutes,
[runtime.md](runtime.md#scheduled-snapshots-and-verification-replay)): four partitions per run, least
recently attempted first, then most behind, each verified by exact replay before its snapshot.

One-time cost: that first verification replay of each partition runs from birth
(`replay_events_per_second`, label `birth`) over its whole journal, instead of the suffix after its
latest snapshot. Later registry changes need the same migration. It is a contract step: declare it in
`db/migrations/contract-steps.json` with its restore point and release approval, or every migration
path refuses it.

A snapshot written after the deploy, at the same head as a retired one, gets a new artifact: the
artifact ID carries the compatibility hash, and the retired artifact stays. For every prior-release
fixture, `apps/runtime/test/prior-release-fixtures.postgres.test.ts` proves the upgraded database
regains a snapshot. After migrating to head it checks that 0029 retired the old snapshots and that
replay from birth reaches the recorded final state hash. It then takes a snapshot at that head with
`createPartitionSnapshot` and commits one `world.advance` with the behavior installed in the upgraded
database, which appends kernel events above the snapshot (62 for the `wave-2` fixture). A diagnostic
`verifyPartitionReplay` then applies exactly that suffix from the snapshot and reaches the new live
hash, as full replay from birth and the offline bundle do, with no mismatches; the snapshot's
checkpoint still holds the recorded hash. For the running service,
`apps/runtime/test/runtime-snapshots.postgres.test.ts` empties the snapshot index as 0029 does and
proves the next cron sweep writes a new snapshot. It then rewrites that snapshot to another kernel
registry hash, as an old-runtime snapshot carries, and proves the next sweep after a command passes
over it (a `birth` replay only, no failure) and writes a new snapshot.
