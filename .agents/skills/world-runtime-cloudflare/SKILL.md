---
name: world-runtime-cloudflare
description: Rules for Clockgrove's hosted runtime on Cloudflare. Use when designing or changing apps/runtime, the WorldDO, SpaceDO or ActorAgentDO owners, Workers routing, alarms, Queues, Workflows, scene WebSockets, hibernation and reconstruction, cross-space handoff, actor activation or the Cloudflare composition root.
---

# World runtime on Cloudflare

Cloudflare is the execution substrate. It never becomes Clockgrove identity or a second canonical history.

## Read first

These are the authority; where this page and they differ, they win.

- `apps/runtime/README.md` and `docs/runbooks/runtime.md`: the endpoint, owners, Queue lifecycle, provisioning, recovery matrix and budgets.
- `docs/runbooks/development.md` (Runtime composition): the Cloudflare entry, portable shells and the binding manifest.
- `docs/clockgrove-cloudflare-implementation-plan.md`: §3 invariants, §4 placement and owner classes, §9 PostgreSQL authority.
- `docs/waves/clockgrove-wave-3-actor-fabric-implementation-plan.md` and `docs/adr/clockgrove-adr-management-plane-world-runtime-plane-and-shared-wallet.md`.
- `docs/protocols/runtime-world-commands.md` and `docs/protocols/realtime-projection.md` for the wire surfaces.

## Owners

- **WorldDO** `(tenant, world, timeline)`: lifecycle, clock policy, routing epoch, partition directory, cross-space transfer coordination. Not ordinary physical commands, cognition or per-object ticking.
- **SpaceDO** `(tenant, world, timeline, space)`: serialized physical commands, active projection, scheduled-work draining, scene WebSockets, interest filtering, presence.
- **ActorAgentDO** `(tenant, world, timeline, subject)`: cognition, conversation sessions, turn fibers, context assembly, model and tool calls. Never position, inventory or world mutation.

These are execution owners. The product term is World Runtime Plane; the Management Plane is separate (identity, tenancy, provisioning, money).

## Rules

- **PostgreSQL is canonical.** Durable Object storage holds only reconstructible state: routing metadata, leases, schedule indexes, connection state, cached projections. Reason: losing it must never change accepted world truth.
- **Assume eviction.** Every owner rebuilds from PostgreSQL. Constructors do no canonical reads or writes. Never rely on in-memory state, one instance staying leader, or socket identity as persona identity. `runtimeInstanceId` is diagnostic; fence with persisted routing and authority epochs.
- **Alarms wake, they do not schedule.** One alarm per owner covers many logical deadlines; process bounded due work, then recompute the next alarm from canonical schedule state. No timer per actor.
- **Commit before delivery.** Queues and Workflows deliver after the journal transaction and its dispatch record; they never bypass it. Consumers verify committed batches and tolerate duplicates and reordering.
- **Use the right primitive.** Queue for at-least-once fan-out with backpressure; Workflow for durable multi-step processes; the owner for tight serialized mutation.
- **Logical identity is not placement.** An actor or object does not imply a resident DO, process or model call. Activate cognition on demand; keep cold actors as journal, snapshot and schedule data. Stable IDs survive eviction, routing change and provider change.
- **Hibernating sockets are an optimization.** Scene streams are revisioned with gap recovery from the last acknowledged revision; client presentation events never mutate canon.
- **Spatial index is rebuildable.** Loose-quadtree cells are epoch-scoped references behind `SpatialIndexPort`; no durable identity depends on a leaf. Promote hot regions to their own partitions only after measured pressure.
- **Cross-space moves are sagas.** Prepare, accept, release and complete idempotently, with the same identity, expected revisions and attribution. A crash at any step neither duplicates nor loses the object.
- **Runtime never holds money.** It may know execution mode, entitlement epoch and a bounded credit lease, never payment details, invoices, provider customer IDs or tax and dispute state. If Management is down, ready worlds continue only within applied policy and valid leases.
- **Contain the provider.** Cloudflare types stay in `apps/runtime/src/cloudflare-entry.ts` and its adapters; portable shells (`owners.ts`, `worker.ts`) and all packages stay free of them (`scripts/check-boundaries.mjs`). Missing composition fails closed; there is no fallback identity or store.
- **Authenticate before routing.** The Worker authenticates, then passes trusted context only over internal DO RPC; unnamed routes fail closed.

## Validation

Run `pnpm run infra:validate` after infrastructure or runtime entry changes. The Wave 3 commands (`test:runtime:interleaving`, `:alarms`, `:queues`, `:workflows`, `:recovery`) exercise owners in workerd against real PostgreSQL; prove a claim there rather than with mocks, per `docs/runbooks/testing.md`.

## Reject

One DO per dormant object, DO storage as sole history, client-to-DO authority without application validation, a global coordinator on every mutation, unbounded alarm batches, Cloudflare IDs as durable world identity.
