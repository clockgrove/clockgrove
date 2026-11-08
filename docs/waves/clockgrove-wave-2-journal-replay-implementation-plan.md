# Clockgrove Wave 2: Canonical Journal, Projections, Replay, and Evidence

**Status:** Coding-agent implementation specification  
**Version:** 1.7  
**Date:** October 27, 2026
**Parent plan:** `raccoon-world-cloudflare-implementation-plan.md` v3.9  
**Product source:** `clockgrove-prd-v0.5.md` v0.5.8  
**Wave:** 2 of the first three substantive implementation waves  
**Assumptions:** Wave 0 is complete; Wave 1 kernel contracts and golden scenarios are frozen  
**Development tooling:** external tools such as `clockgrove/factory` may execute this wave; their state is not canonical journal or product/runtime authority.  

---

## 1. Outcome

Wave 2 turns the pure headless world into durable, searchable, rewindable canonical history using the final PostgreSQL semantics. It introduces the authoritative command transaction, semantic journal, validation-critical projections, durable schedules, dispatch/effect intent ledgers, first-class timelines, snapshots, replay, export, and causal inspection.

The wave exits only when:

> No acknowledged mutation is lost or duplicated under the complete injected crash matrix, and replay from a verified snapshot plus subsequent events reproduces the live authoritative projection and state hash.

PostgreSQL is the sole canonical database. Wave 2 does not wait for Durable Objects to prove correctness; Wave 3 will route through these same application and persistence contracts.

Wave 2 persists the foundational attribution lifecycle: trusted `AttributionIntent` and `ActionId` at command receipt, immutable allow/deny `AuthorityDecision`, and sealed `AttributionEnvelope` on committed events. No later billing or multiuser wave may need to infer authorship from a socket, current owner, or payer.

---

### 1.1 Objectives, sequencing, and checkpoints

This wave is a substantial workstream containing numerous Objectives and Work Items. The accepted [incremental-delivery ADR](../adr/clockgrove-adr-incremental-wave-delivery-and-evidence.md) governs capability scope, readiness, comparison rules, and proportionate qualification. The complete exit checklist below remains authoritative for full-wave qualification.

Extend the accepted PostgreSQL journal and isolation/idempotency contracts; do not build a parallel journal or duplicate canonical store.

First carry the real kernel command → event → projection/schedule path through atomic transactions and the ordinary inspector. Subsequent Objectives complete dispatch/effect intent, artifact/snapshot acceleration, replay/upcasters, provisioning/lifecycle, timeline foundations and export/restore. Each capability has its own accepted scope; the complete fault, RLS and replay matrices qualify the full wave.

Use the actual supported isolated PostgreSQL fixture, including native PostgreSQL where supported. Freeze a final database candidate before broad qualification and preserve exact event serialization, hashes and transaction invariants.

---

## 2. Entry conditions

These are the full-wave/default entry conditions. A named local-development Objective may consume only accepted prerequisite capabilities under the ADR's recorded readiness exception; its Issue must preserve pending qualification obligations and the selected path's mandatory safety evidence.

- Wave 1 exit evidence is green and immutable.
- Command/event schemas, reducers, schedules, state hashing, and pack compatibility fixtures are versioned.
- The supported Wave 0 isolated PostgreSQL/pgvector fixture starts reproducibly, using its container or native database profile.
- Drizzle migration tooling and reviewed raw-SQL path are established.
- `Journal`, `ArtifactStore`, and `EvidenceRecorder` application ports exist with deterministic fakes.
- Tenant, world, timeline, partition, space, stream, command, event, schedule, artifact, decision, correlation, and causation IDs exist.
- The five accepted privacy categories, set-based ceilings, and independent access context are defined.
- R2 bindings may exist in the Cloudflare skeleton, but local filesystem/minimal fake and production R2 adapter remain behind `ArtifactStore`.

If Wave 1 state cannot be serialized without losing required semantics, fix the versioned codec contract before persistence implementation. Do not serialize JavaScript implementation details opportunistically.

---

## 3. Authority and consistency model

### 3.1 Authority rule

> PostgreSQL decides whether a command became canonical history.

No successful mutation response may leave `Journal.execute()` before the PostgreSQL transaction commits. A CLI process, Worker, Durable Object, Queue publisher, R2 write, telemetry exporter, or client cache cannot acknowledge world truth independently.

### 3.2 Ordering

- `stream_sequence` orders one aggregate stream.
- `partition_sequence` orders one physical consistency partition.
- `journal_position` orders database ingestion for search/dispatch but is not a global causal clock.
- `simulation_time` plus deterministic schedule tie-break orders simulation work.
- cross-partition causality uses explicit causation, transfer, barrier, and saga records.
- a branch/fork point is a partition-head vector, not one assumed world-global sequence.

### 3.3 Canonical versus evidence-only

Event source behavior-affecting state:

- physical/environmental changes;
- schedules and clock policy;
- active rules and authored changes;
- future behavior-affecting perceptions, episodes, beliefs, relationships, and summaries;
- capability installation/grant changes;
- timeline/fork/promotion state.

Append-only/versioned evidence that is not reconstructed as domain state:

- transcripts, prompts, and model outputs;
- retrieval/model/tool/run steps;
- approval and runtime diagnostics;
- external provider attempts and acknowledgements.

A semantic event references its evidence source. Replay never reruns a model or tool to reconstruct an already accepted event.

### 3.4 Transaction limits

The canonical append transaction must not contain:

- model or MCP calls;
- R2 upload/download;
- Queue delivery;
- telemetry export;
- long simulation, replay, or projection rebuild;
- cross-space network RPC;
- human approval waits.

Only short, deterministic validation and synchronous projection/schedule/dispatch writes occur inside it.

---

## 4. Owned code and data

```text
packages/
  application/src/journal/
  application/src/timelines/
  application/src/inspection/
  persistence/
    src/db/
    src/journal/
    src/projections/
    src/schedules/
    src/dispatch/
    src/artifacts/
    src/snapshots/
    src/replay/
    src/timelines/
    src/inspection/
  observability/src/evidence/
  testkit/src/postgres/
  testkit/src/faults/
  testkit/src/replay/
apps/cli/src/{journal,inspect,replay,export,verify}/
db/
  migrations/
  policies/
  seeds/
  verification/
tests/{persistence,recovery,security}/
docs/protocols/{journal,replay,timelines}.md
```

`persistence` may depend on contracts, domain, kernel, and application ports. Domain/kernel never import persistence. The CLI composes the adapter through application use cases; it does not execute private SQL as an alternate authority path.

Amended (2026-10-19): paths follow the repository. There is no `apps/cli`: Wave 2 has no CLI (issue 686 D4), so wherever this plan says CLI, read the application API. There is no `packages/observability`; evidence goes to the qualification manifest (§16). PostgreSQL fixtures live in `scripts/database/` and `tests/database/`, not `testkit/src/postgres`, and `db/` holds `migrations/` and `fixtures/`. The contract docs are `docs/runbooks/journal-replay.md` and `docs/runbooks/database.md`, not `docs/protocols/`.

---

## 5. PostgreSQL schema plan

### 5.1 Migration grouping

Use small forward-only migration families:

1. database roles, extensions, migration metadata;
2. tenants, principals, external identities, workspace memberships, world memberships, personas, roles/grants;
3. worlds/lifecycle, immutable world-pack artifacts, pack installations, provisioning cases, timelines, partition heads, spaces;
4. world objects, components, containment, rules, schedules;
5. streams, events, command receipts, snapshots;
6. dispatches, effect intents, artifacts;
7. actions, immutable attribution envelopes, authority decisions, and decision/evidence records needed by Wave 1 traces and inspector;
8. indexes, RLS policies, verification functions, and views.

Later cognitive/conversation/context tables may be created only if a current Wave 2 evidence path uses them. Preserve their planned namespace and migration seams without adding idle tables solely for completeness.

### 5.2 Required scope columns

Every tenant-owned row includes `tenant_id`. World state includes `world_id`; timeline-relative state includes `timeline_id`; partition-relative state includes `partition_id` and normally `space_id`.

Foreign keys or equivalent checked references must prevent accidental cross-scope links. Application validation does not replace database constraints where relational integrity can be expressed.

World creation persists `WorldProvisioningCase` and `WorldPackInstallation` independently of disposable Workflow state. The case has a unique tenant/idempotency key, declared state machine, attempt/failure evidence, and resumable seed/projection cursor. `worlds.lifecycle_status` gates ordinary entry/routing. Installation records pin pack/resource/asset/migration hashes and genesis provenance; they are never overwritten to represent an upgrade.

`WorldGenesisCreated`, stable seed-command receipts/events, `WorldProjectionVerified`, and `WorldReady` are canonical evidence. Clock mapping, named random-stream initial state, cognitive seed references, schedules, expected/actual seed hash, initial membership/persona/inventory, and installation ID are preserved sufficiently for replay and offline verification.

Amended (2026-11-07): provisioning seeds no initial membership, persona or inventory yet, so the §19 retry-safety item is proven only for birth, seed state, schedules and events. The owner moves the rest to Wave 9 (the Wave 9 §18 amendment of 2026-11-07): provisioning seeds the initial membership, persona and inventory, preserves them for replay and offline verification as above, and a retry in any crash window never duplicates them.

### 5.3 Journal constraints

Events require uniqueness on:

- `event_id`;
- `(tenant_id, timeline_id, stream_id, stream_sequence)`;
- `(tenant_id, timeline_id, partition_id, partition_sequence)`.

Command receipts require:

- unique `(tenant_id, command_id)`;
- immutable request hash;
- target actor address and expected revisions;
- status state machine;
- committed event IDs and stable result;
- created/committed/failed timestamps;
- correlation and causation identity;
- immutable attribution identity and authority-decision reference.

Amended (2026-10-19): 401s stay unrecorded. An unauthenticated request is refused before the journal and leaves no receipt or decision. An authenticated but unauthorized command (403) commits a rejected receipt with an immutable deny decision, and an exact retry returns it without deciding again.

### 5.4 Indexes

Minimum measured indexes:

- streams and partition heads by canonical identity;
- events by actor/object, simulation time, recorded time, command, causal-root action, initiator, effective actor, persona, authority decision, correlation, causation, decision trace, and privacy;
- schedules by `(tenant_id, timeline_id, partition_id, status, due_sim_time, priority, tie_break_key)`;
- dispatches by `(channel, status, next_attempt_at)`;
- artifacts by content hash and scope;
- decisions by actor/object, time, event, and action;
- snapshots by partition/timeline and covered sequence.

Do not physically partition tables or add HNSW merely because future scale is large. Preserve partition keys and add physical mechanisms only after representative measurements justify them.

Amended (2026-10-19): each index lands with its first query consumer, not up front. Decision-trace indexes go to Wave 4 RW-0407, with the traces.

### 5.5 RLS and roles

Roles:

- migration/owner role;
- runtime application role that cannot bypass RLS;
- constrained read/inspection role where useful;
- backup/recovery role separated from serving credentials.

With pooled connections, install scope transaction-locally:

```sql
BEGIN;
SELECT set_config('app.tenant_id', :tenant_id, true);
SELECT set_config('app.principal_id', :principal_id, true);
SELECT set_config('app.privacy_ceiling', :privacy_ceiling, true);
-- authorized work
COMMIT;
```

Never depend on session-level `SET`. Tests deliberately reuse pooled connections across alternating tenants and privacy ceilings.

---

## 6. Journal contract

### 6.1 Application interface

```ts
interface Journal {
  execute(command: AuthorizedCommand): Promise<CommittedCommand>;
  readStream(ref: StreamRef, range?: SequenceRange): Promise<DomainEvent[]>;
  loadAggregate<T>(ref: AggregateRef<T>): Promise<Versioned<T>>;
}
```

Supporting internal interfaces:

```ts
interface ProjectionWriter {
  validate(state: AuthoritativeState, command: AuthorizedCommand): DomainIssue[];
  apply(events: PersistedDomainEvent[], tx: Transaction): Promise<ProjectionDelta>;
}

interface SnapshotStore {
  create(request: SnapshotRequest): Promise<SnapshotRef>;
  load(ref: SnapshotRef): Promise<VerifiedSnapshot>;
}

interface ReplayEngine {
  rebuild(request: ReplayRequest): Promise<ReplayResult>;
  verify(request: ReplayVerificationRequest): Promise<ReplayVerification>;
}
```

### 6.2 Canonical execute transaction

`Journal.execute()` performs:

1. begin transaction and install RLS context;
2. canonicalize request bytes and compute request hash;
3. insert or lock command receipt by command ID;
4. on existing receipt, reject hash mismatch or return stable committed result;
5. resolve/lock required stream and partition heads in deterministic key order;
6. validate expected stream sequence, partition revision, and routing epoch where present;
7. load authoritative projection rows needed for validation;
8. call the pure kernel/domain handler;
9. allocate stream/partition sequences;
10. append semantic events with payload hashes and version metadata;
11. update validation-critical projections and durable schedules;
12. insert event dispatch rows and external effect intents;
13. persist decision/evidence records required synchronously;
14. store stable command result on the receipt;
15. commit;
16. publish best-effort dispatch hints after commit;
17. return committed events and projection delta.

Lock acquisition must use canonical sorted keys. A transaction never expands its lock set after writing.

### 6.3 Idempotency behavior

- Same tenant + command ID + same canonical request hash returns the same result.
- Same command ID + different hash returns stable invariant/security error.
- Retry after commit-before-response returns receipt result without re-executing kernel.
- Rejected optimistic concurrency does not masquerade as an idempotent success.
- Internal dispatch and effect IDs derive deterministically from source event/intent semantics.
- Command result serialization is stable across process restarts and compatible releases.

---

## 7. Projections and schedules

### 7.1 Synchronous authoritative projections

Within the append transaction, update only state needed to validate subsequent commands or schedule correctness:

- world/timeline/partition heads;
- object/component state;
- containment, resource, location, lifecycle, and movement state;
- active clock policy and schedules;
- rule/capability state when present;
- compact decision references needed by immediate explanation.

Search, analytics, expensive graph views, embeddings, and client-specific views are asynchronous/rebuildable.

Amended (2026-10-19): the live state is one hashed partition-state document per partition, plus the §7.3 schedule rows, instead of normalized object/component/containment projections. One document is enough to validate the next command and hashes directly. The normalized read models move to Wave 6 and rebuild from replay (issue 686 D3; Wave 6 named by issue 820, 2026-10-31).

### 7.2 Projection rules

- each projection handler is versioned and idempotent for an event identity;
- authoritative projection revision equals the covered partition/stream head; amended for world commands (issue 649, D1): the kernel's revision is the client-visible partition revision, the journal head stays internal, and the projection records the head it covers;
- no direct projection write exists outside command execution, replay/rebuild, or an explicit verified backfill;
- rebuild writes into isolated tables/schema or uses checkpointed replace strategy;
- projection hash is computed through Wave 1 canonical serialization;
- derived projection lag and checkpoints are observable.

### 7.3 Durable schedules

Schedule mutations returned by the kernel commit atomically with their events. Rows retain stable ID, due time, owner partition, priority/tie-break, payload version/hash, catch-up class, supersession, status, and claimed/completed identity.

Wave 2 implements storage and due-work queries but not Cloudflare alarms. The CLI/replay harness drains schedules through the same application use case that Wave 3 will call.

---

## 8. Dispatch and effect intent

`event_dispatches` is the transactional outbox for post-commit internal consequences. It records source event, logical channel, semantic dedupe ID, status, attempt count, next attempt time, claim/lease identity, error classification, and final disposition.

Initial logical channels:

- `world-reactions`;
- `cognitive-indexing`;
- `external-effects`.

`effect_intents` represents a policy-approved request for an external side effect. Wave 2 stores and inspects intent; it does not perform provider delivery.

Requirements:

- preview timelines block or simulate external effects by enforced policy;
- replay never redelivers effects;
- outbox reconciliation can identify committed-but-unpublished rows;
- dedupe is based on semantic action identity, not transport attempt;
- unknown/uncertain provider results remain explicit rather than converted to success/failure by guesswork.

Amended (2026-10-19): `effect_intents` is deferred to Wave 5, which brings the first external effects. In Wave 2 an external effect is an `external-effects` dispatch row, and the preview gate is enforced on it: such a row is refused unless its timeline is `live` (migration 0011).

---

## 9. Artifacts, snapshots, and replay

### 9.1 Artifact store

Inline encrypted/redacted text or JSON up to the configured 128 KiB threshold; store larger or binary immutable content in content-addressed R2 with PostgreSQL metadata.

Each artifact records tenant scope, content hash, byte size, media type, encryption/redaction metadata, producer/evidence identity, created time, retention class, and optional R2 key. Reads always reauthorize through `AccessContext`.

Local tests use a deterministic fake or S3-compatible/local adapter behind the same port. Production R2 behavior is cloud-qualified later.

Amended (2026-10-19): every class except `public_scene` is stored only as AES-256-GCM ciphertext under per tenant+world+class data keys wrapped by a versioned KEK; `credential` is refused (Wave 5 credential store); retention class is `durable | ephemeral`.

### 9.2 Snapshot contents

- tenant/world/timeline/partition/aggregate identity;
- covered stream and partition sequence/vector;
- canonical state hash;
- scheduler and named random state;
- schema, code, kernel, pack, rule, archetype, prompt/policy compatibility set;
- artifact hash, size, codec, compression, and encryption metadata.

Snapshot creation is asynchronous from a committed head. It cannot advance canonical state. Activation/replay verifies content hash before deserialization and state hash after replay.

Amended (2026-10-19): a snapshot is the verified partition document (world state, named random state, pending schedules) at a committed head, stored as one `public_scene` artifact, the same class as the events it copies. Wave 6 must split private cognition out of that document before private data lands there. Deferred: a snapshot schedule or background job, pruning and expiry, compression, multi-partition head vectors, CLI commands and `streams.snapshot_sequence`.

Amended: the snapshot background job landed in Wave 3 as the runtime's own 5-minute Cron Trigger sweep (`sweepPartitionSnapshots`), not a Workflow. It snapshots each partition with no compatible snapshot or whose head is 2,000 events past its latest one, up to 4 per run, least recently attempted first, and first verifies the partition by `exact` replay, which also emits `replay_events_per_second` (docs/runbooks/runtime.md, "Scheduled snapshots and verification replay"). Pruning and expiry, compression, multi-partition head vectors, CLI commands and `streams.snapshot_sequence` stay deferred.

### 9.3 Replay modes

Wave 2 supports:

- **exact replay:** recorded semantic events and recorded nondeterminism; must reproduce hash;
- **diagnostic replay:** additional assertions/inspection without changing results;
- **experimental re-execution:** new marked timeline/branch, never overwrites source history.

Amended (2026-10-19): experimental re-execution is deferred to Wave 7 preview branches,
which bring the fork manifest it needs. Wave 2 ships `exact` and `diagnostic`.

Upcasters are pure, deterministic, version-to-version functions. Historic payload bytes remain immutable.

### 9.4 Projection rebuild

Rebuild is checkpointed, resumable, and verifies:

- event/upcaster compatibility;
- sequence continuity;
- event payload hash;
- projection invariants;
- final covered head and state hash;
- no cross-tenant/privacy leakage.

A mismatch blocks release and pages in production. There is no “best effort” canonical replay.

Amended (2026-10-19): in Wave 2, rebuild of canonical state is verification only.
Checkpointed replay from the stored birth or a verified snapshot detects corruption, and nothing is
written back. Rebuild applies to derived read models when RW-0210 adds them; full canonical repair
arrives with Wave 7 re-execution.

Amended (2026-11-07): replay verification has no cursor, so it is not resumable. The owner moves the resumable part to Wave 9 (the Wave 9 §18 amendment of 2026-11-07): verification records a durable cursor, and a run interrupted part-way resumes from it and reaches the same verified head and state hash, with every check above, as an uninterrupted run.

---

## 10. Timeline and fork foundation

Wave 2 establishes first-class timeline identity and partition-head vectors sufficient for replay/export and later preview branches.

Implement:

- live, preview, archived, and experimental timeline kinds;
- parent timeline and fork manifest reference;
- timeline lifecycle state;
- partition-head vector and source snapshot manifest;
- inherited logical object identity rules;
- branch-local event/projection/schedule namespace;
- effect policy attached to timeline kind;
- APIs to inspect and export timeline history.

Full barrier coordination, semantic authoring diff, promotion/rebase, and branch UX belong to later waves. Wave 2 must not fake branches with database/provider branches or copy mutable live rows without a recorded fork manifest.

Amended (2026-10-19): the timeline and fork foundation is deferred to Wave 7, next to re-execution (§9.3) and preview branches, which are its first consumers. Today's `live` and `branch` timeline kinds stay. The effect policy is the §8 preview gate: only `live` timelines record external effects.

---

## 11. Inspector and export bundle

### 11.1 Inspector queries

Provide application APIs and CLI commands for:

- command receipt by command ID;
- event by event ID or ordered stream/partition range;
- object/aggregate state at current head;
- object history by simulation/recorded time;
- decision trace with candidates/inputs/events;
- schedules by owner/status/time;
- dispatch/effect state;
- snapshot and replay verification;
- correlation/causation traversal;
- timeline metadata and partition heads.

Inspector access uses the same tenant/privacy authorization as serving APIs. Operational access is audited; SQL-console access is not the product inspector.

Amended (2026-10-19): in Wave 2 the inspector is the application API for one command's causal chain (receipt, authority decision, verified events, schedules, dispatches, parent and child commands) under tenant and privacy authorization. Decisions are authority decisions; kernel decision traces, object state and object history move to Wave 4 RW-0407. There is no CLI and no audit table; audited access arrives with the first authenticated inspector service (Wave 3 or 4).

### 11.2 Export/replay bundle v1

The bundle contains a signed/hashed manifest, versions, pack references, timeline and partition heads, snapshots/artifacts, events, required evidence, upcaster identifiers, and expected final hashes. It supports offline verification without production credentials.

Private data is included only when the export principal has access and the bundle policy declares it. Redacted exports cannot claim to reproduce private cognitive state unless the manifest explicitly records the omitted scope.

Amended (2026-10-19): bundle v1 is one partition of one timeline: a hashed manifest (scope, head, compatibility set, included and omitted privacy classes, expected final state hash, section hashes), the stored birth and the event bytes. It holds public events only, is never redacted, and is unsigned; an offline verifier anchors authenticity on an independent final hash. Signing, snapshots or artifacts, upcaster identifiers and redacted exports are deferred.

Amended (2026-10-27): signing and upcaster identifiers have an owner, Wave 9 RW-0902 (privacy lifecycle), whose export (Wave 9 §6.2) now requires a signed manifest and the upcaster identifiers the included event versions need. Nothing is built for them in Wave 2, and bundle v1 and its golden stay as amended above. Snapshots or artifacts inside a bundle and redacted bundles keep the issue 686 deferral. Wave 9 §6.2 exports snapshots, artifacts and permitted private data as separate export items, not as bundle contents, and it does not define a redacted bundle.

---

## 12. Detailed work packets

### RW-0201 — Identity, tenant, authorization, roles, and RLS schema

Implement migrations, runtime/migration roles, transaction-local context helper, RLS policies, principal/external identity mapping stubs, audit records, and cross-tenant/privacy attack suite.

Exit: alternating tenants through one pooled connection cannot observe or mutate each other; runtime role cannot bypass RLS.

### RW-0202 — World lifecycle, pack installation, timeline, partition, object, component, and schedule schema

Map Wave 1 versioned state without leaking TypeScript implementation details. Define immutable pack artifacts/installations, provisioning case and world lifecycle constraints, genesis/seed cursor and readiness evidence, timelines, heads, spaces, objects/components, containment, rules, schedules, and required indexes.

Exit: install, interrupt/resume at every seed/projection boundary, and reconstruct both world packs with identical Wave 1 hashes; no non-ready world can be resolved for ordinary entry.

Amended (2026-11-07): the interrupt/resume test at every seed/projection boundary runs only the fixture pack (`worlds/fixture`). The owner moves the Raccoon World half to Wave 9 (the Wave 9 §18 amendment of 2026-11-07): the Raccoon World pack (`worlds/raccoons`) is installed, interrupted and resumed at every seed/projection boundary, and reconstructs with identical Wave 1 hashes.

### RW-0203 — Streams, events, command receipts, and envelope codecs

Implement append-only event persistence, receipt state machine, payload hash/codec, stream and partition heads, event registry/upcaster resolution, and stable result serialization.

Exit: historic/current envelope round trips preserve bytes and semantic identity.

### RW-0204 — Canonical Journal transaction

Implement deterministic locking, expected revisions, kernel execution, sequence allocation, event append, receipt reuse, stable errors, and complete crash injection hooks.

Exit: concurrency/idempotency suite passes under real PostgreSQL.

### RW-0205 — Projection and schedule transaction integration

Implement authoritative projection writers, invariant checks, schedule mutations, projection deltas, head revisions, and CLI due-work advancement.

Exit: every Wave 1 scenario through Journal matches the pure simulator's event/final-state hash.

### RW-0206 — Dispatch/effect intent and reconciliation

Implement outbox/effect schema, deterministic dispatch IDs, claim/lease states, post-commit hint interface, sweeper query, preview policy, and fake publisher.

Exit: committed events eventually produce one semantic dispatch despite lost hints and duplicate sweeps.

### RW-0207 — ArtifactStore and R2 adapter

Implement inline/spill decision, content addressing, integrity validation, authorized read, local fake, R2 adapter, retention metadata, and corruption tests.

Exit: bytes round-trip with verified hashes and denied cross-scope reads.

### RW-0208 — Snapshots, replay, projection rebuild, and hash verification

Implement snapshot codec, asynchronous creation, restore, event continuation, replay modes, rebuild checkpoints, corruption detection, and state-hash comparison.

Exit: snapshot + suffix events equals full replay and live projection for all named scenarios.

### RW-0209 — Migration and upcaster compatibility harness

Implement empty/current/prior-release migration matrix, resumable backfill test harness, historic event/component fixtures, forward reader compatibility, and contract-step safety checks.

Exit: each supported fixture reaches current schema and replays to its expected hash.

Amended (2026-10-19): deferred to Wave 3 as an entry condition, landing before the first deploy, when a prior-release database first exists to migrate. The §19 "prior fixture matrices" and "every supported historic fixture" items move with it.

Delivered: `db/fixtures/prior/wave-2` is captured from the `wave-2` tag by `scripts/database/capture-prior-release.mjs`, and `test:db` migrates every prior fixture to head. "Every historic event version" means every version present in a supported fixture (the maintainer may revisit). `routine.selected@1` and envelope v1 were never written to a database, so their goldens prove them.

Delivered: `apps/runtime/test/prior-release-fixtures.postgres.test.ts` proves, for every prior fixture migrated to head:

- every pre-existing row and event byte is kept, except the old-registry snapshot rows that the contract step 0029 deletes;
- replay from birth and the offline bundle reach the hash recorded at capture;
- the upgraded database then regains a snapshot. It takes one at that head with `createPartitionSnapshot` under the current registry, then commits one `world.advance` with the behavior installed in the upgraded database, which appends a suffix of kernel events (62 for `wave-2`). Diagnostic `verifyPartitionReplay` applies that whole suffix on top of the snapshot and reaches the new live hash, as full replay and the offline bundle do, with no mismatches; the snapshot's checkpoint still holds the recorded hash.

A snapshot artifact ID now carries its compatibility hash, so this snapshot does not collide with the retired artifact at the same head. The resumable backfill harness (`scripts/database/backfill.mjs`) records batches in `clockgrove.migration_backfill_checkpoints` and sets `verified_at` only after verification. `test:db` proves three things: a backfill killed between batches resumes and ends with the rows of an uninterrupted run; a verified backfill is a no-op when re-run; a failed verification stops with `BackfillVerificationError`. The contract-step check (`scripts/database/contract-steps.mjs`) runs in every migration path and in `pnpm check`. It refuses a migration that deletes, truncates or drops data, or rewrites an append-only table, unless `db/migrations/contract-steps.json` declares its bytes, statements, restore point and release approval. It reads the migration's statements, DO blocks, string literals and other dollar-quoted strings (so SQL passed to `EXECUTE`), and the routines the migration calls that this or an earlier migration created; it does not read SQL assembled at run time from pieces or trigger function bodies (docs/runbooks/database.md). 0019 and 0029 are declared with their bytes unchanged. Not built: hosted backups and restore points. The running service's snapshot job landed later, with issue 843 (§9.2).

### RW-0210 — Inspector, causal traversal, and export/replay bundle

Implement authorized application queries, CLI, first causal-chain view, bundle manifest/verification, and audit trail.

Exit: an operator can traverse command → events → projection/schedules → decisions/dispatch and verify the exported scenario offline.

Amended (2026-10-19): no CLI and no audit trail in Wave 2; normalized read models move to Wave 6 (rebuildable from replay; issue 820, 2026-10-31); decisions are authority decisions; the bundle is v1 as amended in §11.2.

---

## 13. Dependency graph and bounded execution

```text
RW-0201 ─┬─ RW-0202 ─┬─ RW-0205 ─┬─ RW-0208 ─ RW-0209 ─┐
         └─ RW-0203 ─ RW-0204 ────┼─ RW-0206            ├─ RW-0210
                                   └─ RW-0207 ────────────┘
```

Parallel lanes after schemas freeze:

- RLS attack fixtures and object/state mapping;
- artifact adapter and journal transaction implementation;
- inspector query design and replay bundle schema;
- fault harness and migration fixture authoring;
- pure upcaster/replay logic and database projection writers.

One migration family has one owner. Dependent work targets a committed migration version; agents must not maintain parallel incompatible schemas.

---

## 14. Failure-injection matrix

Inject failure:

- before/after receipt insert/claim;
- before/after head locks;
- after kernel execution but before writes;
- during event batch append;
- between event and projection/schedule/dispatch statements;
- after result stored but before commit;
- after commit before publish hint;
- after commit before process response;
- during snapshot artifact write and metadata commit;
- during replay checkpoint;
- on corrupt/truncated/wrong-hash artifact;
- during migration backfill and process restart;
- during export assembly and verification.

Every case asserts:

- canonical state and head sequences;
- stable receipt status/result;
- no duplicated semantic event/schedule/dispatch/effect;
- projection/event agreement;
- recoverable next action;
- complete causal evidence;
- safe user-visible status.

Amended (2026-11-07): two cases have no fault-injected test: "during replay checkpoint" and "during export assembly and verification". The owner moves both to Wave 9 (the Wave 9 §18 amendment of 2026-11-07), where each case asserts every item above.

---

## 15. Test and CI gates

```text
pnpm check
pnpm db:migrate:fresh
pnpm db:migrate:fixtures
pnpm db:verify
pnpm test:persistence
pnpm test:persistence:concurrency
pnpm test:persistence:rls
pnpm test:persistence:faults
pnpm test:replay
pnpm test:rebuild
pnpm test:export
pnpm verify:scenario-parity
```

Amended (2026-10-19): the gates are the real root scripts:

- `pnpm check`;
- `pnpm db:migrate` and `pnpm db:verify` (each verify run migrates a fresh owned cluster);
- `pnpm test:db`: migrations, the pooled RLS attack suite, the §14 fault stages, and the journal, dispatch, snapshot, parity, export and inspector tests against real PostgreSQL;
- `pnpm test:replay`: event goldens and upcaster replay;
- `pnpm test:long-run`: long-horizon scenarios, the source of §16 throughput;
- `pnpm qualify:*`: wave evidence manifests.

Dropped, because `test:db` already covers them on one owned cluster per run: `db:migrate:fresh`, `test:persistence*`, `test:rebuild`, `test:export` and `verify:scenario-parity`. Deferred with RW-0209: `db:migrate:fixtures`. Amended: RW-0209 was delivered without it, because `test:db` migrates every prior-release fixture to head.

Required proofs:

- real PostgreSQL, not mocked SQL;
- concurrent expected-revision conflict behavior;
- command ID/request-hash matrix;
- atomic event/projection/schedule/dispatch writes;
- pooled RLS cross-tenant denial;
- full replay, snapshot replay, and rebuild equality;
- migration from every supported fixture;
- offline export verification;
- deterministic parity with Wave 1 simulator.

CI retains database logs and evidence manifests only after redaction. Secrets and private payloads are denied by default.

---

## 16. Observability and evidence

Record structured metrics/evidence for:

- journal latency and lock wait by command family;
- optimistic conflicts and idempotent receipt hits;
- request-hash mismatches;
- events/projection rows/schedules/dispatches per command;
- transaction retries and stable error codes;
- outbox backlog age/status;
- snapshot age, size, creation duration, and verification result;
- replay/rebuild throughput, checkpoint, and mismatch;
- migration/backfill checkpoint and verification;
- RLS denial and audited inspector access;
- artifact inline/spill size and integrity failure.

Telemetry is not canonical. The causal inspector reads canonical/evidence tables and remains useful if external telemetry is unavailable.

Amended (2026-10-19): Wave 2 records replay throughput and journal latency in its qualification manifest, measured from the long runs. The live metrics exporter moves to Wave 3, the first wave that runs the real service. Audited inspector access arrives with the first authenticated inspector service (issue 686 D4).

Amended (2026-10-27): the live service emits these signals as Workers Analytics Engine metrics (docs/runbooks/runtime.md "Metrics"): journal latency and lock wait by command family; events, projection rows, schedules and dispatches written per command; transaction retries by failure class; optimistic conflicts of autonomous (alarm, catch-up, due-work) commands; outbox backlog age; snapshot age, size, creation duration and verification result; replay throughput and mismatches; artifact inline/spill size and integrity failure; and RLS denials in the artifact store. Optimistic conflicts, idempotent receipt hits, request-hash mismatches and failures by stable error code on Worker-answered requests are evidenced by issue 874's `world_command_answered` and `noop_command_answered` records (their outcome, code and failure class), not by metrics. Migration/backfill checkpoint and verification evidence is the migration harness's output.

---

## 17. Security and privacy gates

- RLS scope is transaction-local and reset by transaction completion.
- Every inspector/export path reauthorizes.
- Event payload and evidence redaction follows registered policy.
- Artifact keys and SQL rows contain opaque IDs, not display names or PII.
- Command IDs are tenant-scoped and request hashes use canonical bytes.
- Error responses never disclose existence across tenant/privacy scope.
- Preview timelines cannot create live effect intents.
- Export manifests declare included privacy categories and omissions.
- Runtime role cannot mutate migration metadata or disable RLS.
- Raw SQL is reviewed, parameterized, and tested under malicious identifiers/payloads.

---

## 18. Explicit non-goals

Wave 2 does not implement:

- Durable Object ownership, routing, alarms, sockets, or hibernation;
- actual Queue consumers/DLQs or Workflow orchestration;
- model calls, agent fibers, MCP, conversation UX, or memory extraction;
- browser scene/client projections;
- complete authoring/promotion/rebase;
- physical database table partitioning without evidence;
- Kafka, Redis, a second database, or a second canonical event store;
- global total causal ordering.

---

## 19. Exit evidence checklist

- [ ] RW-0201 through RW-0210 merged in dependency order.
- [ ] All migrations pass empty/current/prior fixture matrices.
- [ ] Runtime role and RLS attack suite pass under pooled connections.
- [ ] Pure Wave 1 scenarios and Journal-backed scenarios have identical semantic/final hashes.
- [ ] Complete command receipt and expected-revision matrix passes.
- [ ] Crash-window matrix proves no lost or duplicate acknowledged mutation.
- [ ] Event, projection, schedule, dispatch, and effect-intent atomicity is proven.
- [ ] Pack installation/genesis/readiness records survive every crash window; retry never duplicates seed state, cognition, schedules, membership, persona, or inventory.
- [ ] Snapshot plus suffix replay equals full replay and live state.
- [ ] Corrupt snapshot/event/bundle causes explicit verified failure.
- [ ] Replay/rebuild/upcasters pass every supported historic fixture.
- [ ] Export bundle verifies offline.
- [ ] Inspector traverses a complete causal chain with authorization.
- [ ] Main remains deployable and local bootstrap remains one-command reproducible.

Amended (2026-10-19): "Export bundle verifies offline" means every per-PR parity run's exported bundle replays with no database to the committed golden's final hash; the causal chain's decisions are authority decisions.

Amended (2026-10-19): "effect-intent atomicity" becomes dispatch-intent atomicity plus the preview gate (§8).

Amended (2026-10-19): "prior fixture matrices" and "every supported historic fixture" move to Wave 3 entry with RW-0209.

Evidence: for "All migrations pass empty/current/prior fixture matrices" and "Replay/rebuild/upcasters pass every supported historic fixture", `test:db` migrates every prior fixture to head and replays it. Replay from birth and in the offline bundle reaches the hash recorded at capture. A snapshot is then taken at that head under the current registry and one `world.advance` appends kernel events above it: replay from the snapshot plus that suffix, from birth and in the bundle reach the new live hash, and the snapshot's checkpoint holds the recorded hash. The fixtures are restored from the captured dumps, without hosted backups or restore points. `db:verify` covers the empty and current databases. Every migration path refuses an undeclared contract step.

Amended (2026-10-19): "Main remains deployable" is accepted under the readiness exception; no hosted deploy exists yet. The hosted proof is issue 693, a Wave 3 entry condition.

Amended: RW-0209 was delivered, so the evidence manifest no longer defers "prior fixture matrices" or "every supported historic fixture". It takes both from `test:db`'s prior-release fixture cases (`apps/runtime/test/prior-release-fixtures.postgres.test.ts`): passed only when the cases passed, `failed` when one failed and `missing` when one is absent. Only the timeline and re-execution part of "Replay/rebuild/upcasters pass every supported historic fixture" stays deferred, to Wave 7.

The wave qualification manifest records commit, migration head, schema hash, lockfile, test/fault results, scenario hashes, RLS evidence, replay throughput, and the exit decision.

Amended (2026-10-27): Qualification writes the manifest once a day on a schedule as well as on manual dispatch. A manifest is stale when its candidate commit is not main's head. The scheduled run detects that by looking for a retained Wave 2 manifest of main's head from a run that succeeded and qualifies the head when there is none, so the manifest trails main by at most a day and a failed run is retried the next day ([development runbook](../runbooks/development.md#acceptance-commands)).

---

## 20. Handoff to Wave 3

Wave 3 consumes:

- production `Journal` and authoritative projection adapters;
- actor-address and partition routing identities;
- timeline/partition heads and routing epoch fields;
- schedule due-work and next-deadline queries;
- dispatch/outbox claims and publisher reconciliation;
- snapshot/hydration/replay APIs;
- artifact and evidence ports;
- inspector queries and fault-injection hooks.

Durable Objects may cache these results for bounded execution. They may never replace, acknowledge ahead of, or conflict-resolve over PostgreSQL authority.

Amended (2026-10-19): Wave 3 also takes RW-0209 and the Wave 0 hosted half as entry conditions. It receives dispatch intents, not effect intents (Wave 5, issue 654 D3).
