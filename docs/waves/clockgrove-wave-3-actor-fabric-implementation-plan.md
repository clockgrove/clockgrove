# Clockgrove Wave 3: Cloudflare Actor Fabric and Perpetual Scheduling

**Status:** Coding-agent implementation specification  
**Version:** 1.11  
**Date:** October 27, 2026
**Parent plan:** `clockgrove-cloudflare-implementation-plan.md` v3.11  
**Product source:** `clockgrove-prd-v0.5.md` v0.5.10  
**Wave:** 3 of the first three substantive implementation waves  
**Assumptions:** Waves 0–2 are complete; Journal, replay, schedules, and evidence are production contracts
**Development tooling:** external tools such as `clockgrove/factory` may execute this wave; this wave defines only product/runtime work and does not depend on them.  

---

> **Revision note:** v1.7 preserves the complete v1.6 product/runtime specification and changes only the development-tooling boundary after Factory moved to its own repository.

## 1. Outcome

Wave 3 places the final Cloudflare execution and ownership boundaries around the durable headless world. It introduces the authenticated Worker gateway, actor router, `WorldDO`, `SpaceDO`, `ActorAgentDO` foundation, explicit logical-world versus runtime-instance identity, activity-driven spatial cells, perpetual scheduling through alarms, three Queue failure domains, typed Workflow skeletons, cross-space transfer, hibernation-compatible connection metadata, and runtime inspection.

It also supplies the first production-shaped installer over the Wave 1 artifact and Wave 2 lifecycle records. CLI, tests, and later self-service UX all invoke the same `WorldProvisioningCase`; no Durable Object constructor or route lookup creates world truth.

The wave exits only when:

> A world can sleep, wake, catch up, accept commands, cross a space boundary, survive Durable Object restart and deployment, tolerate PostgreSQL/Hyperdrive and Queue failures, and converge to the same state as continuous headless execution—while PostgreSQL remains the sole canonical authority.

This wave proves distributed correctness before realtime rendering or LLM cognition is added.

Amended (2026-10-19): Wave 3 runs one SpaceDO per world partition, so the exit drops "cross a space boundary"; cross-space transfer is deferred (§13). Spatial fidelity is awake/asleep only (§10.2). Later-wave parts are built with their first consumers (§9, §11, §12). There is no CLI (issue 686 D4): wherever this plan says CLI, read the authenticated inspector or application API.

---

### 1.1 Objectives, sequencing, and checkpoints

This wave is a substantial workstream containing numerous Objectives and Work Items. The accepted [incremental-delivery ADR](../adr/clockgrove-adr-incremental-wave-delivery-and-evidence.md) governs capability scope, readiness, comparison rules, and proportionate qualification. The complete exit checklist below remains authoritative for full-wave qualification.

First qualify the ordinary runtime ownership path: authenticated routing, current owner/revision checks, Journal-backed hydration/commit, bounded alarms, sleep/wake and restart. This is the prerequisite runtime consumer for a living yard.

Then deliver cross-space transfer, Queue reconciliation/DLQ, typed Workflow linkage, broader failure scenarios and measured capacity as separate complete capabilities with real dependencies. These remain full-wave obligations. A rare combined outage does not expand the first ownership Objective merely because it was discovered during qualification.

Use one owner for shared runtime/staging resources. Run independent capability work concurrently only when edits and resources are isolated; do not invoke the entire fault/load matrix after each repair.

---

## 2. Entry conditions

These are the full-wave/default entry conditions. A named local-development Objective may consume only accepted prerequisite capabilities under the ADR's recorded readiness exception; its Issue must preserve pending qualification obligations and the selected path's mandatory safety evidence.

- Wave 2 qualification manifest is green.
- `Journal.execute()`, replay, snapshots, schedules, dispatch/effect intents, and inspector APIs are stable.
- Wave 1 scenarios execute through Journal with matching hashes.
- Worker, three DO namespace bindings/classes, Queue/Workflow bindings, Wrangler environments, and authenticated no-op path exist from Wave 0.
- Cloudflare compatibility date and exact Agents SDK/Wrangler versions are pinned in the release manifest.
- Authentication-provider verification and internal principal mapping are available at the Worker boundary.
- Local Wrangler/Miniflare tests and a staging Cloudflare environment are operational.
- OTel/correlation helpers and structured safe logging exist.

Amended (2026-10-19):

- The Wave 0 hosted half is an entry condition: real staging deploy, authenticated staging browser path, Queue/webhook duplicate safety and an accepted Wave 0 manifest. It delivers the staging environment and hosted no-op path listed above.
- RW-0209 migration and upcaster compatibility is an entry condition, landing before the first deploy. Delivered: `test:db` migrates each prior-release fixture (`db/fixtures/prior`) to head and replays it to its recorded hashes.
- Wave 2 delivers dispatch intents with a preview gate, not effect intents; those are built in Wave 5.
- The live metrics exporter deferred from Wave 2 §16 lands in this wave.

Amended (2026-10-19):

- issue 694 captures its prior-release fixtures from a `wave-2` tag on the Wave 2 close commit.
- The Wave 2 §16 metrics go to Cloudflare-native analytics (§20), with no external OTel collector account. Correlation helpers and safe structured logging are built in this wave by issue 701.
- The Agents SDK pin moves to Wave 5 with the `ActorAgentDO` foundation (§9.3).

Runtime code must consume application ports. It must not reach into persistence internals or create a second state path for convenience.

---

## 3. Fixed runtime topology

### 3.1 Physical classes

Exactly three physical Durable Object classes exist in this wave:

- `WorldDO(tenant, world, timeline)`;
- `SpaceDO(tenant, world, timeline, space)`;
- `ActorAgentDO(tenant, world, timeline, subject)`.

Do not add SessionDO, PresenceDO, RuleDO, ObjectDO, SchedulerDO, or one DO per passive object. Logical identity and addressability do not imply physical allocation.

### 3.2 Authority split

- A DO serializes execution within its declared consistency boundary.
- PostgreSQL decides whether the mutation committed.
- DO memory and SQLite are runtime state, not canonical world truth.
- A response is successful only after Journal commit.
- On cache/database disagreement, database revision wins and the runtime rehydrates.
- Queues, Workflows, alarms, and telemetry wake or transport work; none are canonical evidence by themselves.

### 3.3 Ownership

`WorldDO` is the **world runtime coordinator**. It owns applied runtime lifecycle, clock/catch-up policy, spatial directory, routing epoch, global configuration/rule activation, branch barriers, transfer coordination, future world-credit-lease/execution-entitlement application, and the operator runtime channel. The Management Plane owns desired lifecycle, pack/provisioning cases, billing accounts, global wallets, rating and Stripe; it reaches WorldDO only through typed application commands and receipts.

WorldDO is addressable for ordinary runtime work only after PostgreSQL reports `WorldReady` and runtime-routable placement. Before readiness, entry/scene/actor routes return a typed `world_not_ready` result; an authorized provisioning inspector remains available through the application API.

`SpaceDO` owns physical command serialization, active authoritative projection at a known PostgreSQL revision, schedules, physical systems, passive-object facade, scene-connection metadata, and transfer participation.

`ActorAgentDO` owns cognitive/interpreted policy, multiple session routes, recoverable-turn foundation, perception intake, working cognitive cache, capability/MCP reconciliation metadata, and cognition budgets. In Wave 3 it is a durable skeleton; full LLM agent execution arrives later.

It never owns canonical physical position, inventory, resources, weather, or lifecycle.

### 3.4 Logical identity and disposable runtime placement

Minecraft server networks and Roblox places demonstrate a durable boundary: the world/player identity outlives any one live server process. Clockgrove makes that boundary explicit rather than inferring it from deployment.

```ts
interface RuntimePlacement {
  worldId: WorldId;
  timelineId: TimelineId;
  spaceId: SpaceId;
  runtimeCellId: RuntimeCellId;
  runtimeInstanceId: RuntimeInstanceId;
  routingEpoch: bigint;
  authorityEpoch: bigint;
  fidelity: "hot" | "warm" | "dormant";
}
```

- `worldId`, `timelineId`, and `spaceId` are durable domain identity.
- `runtimeCellId` is the current opaque logical execution placement and may change after partitioning, spatial-index migration, or runtime promotion; it never exposes a quadtree/octree code as domain identity.
- `runtimeInstanceId` is a Clockgrove-generated diagnostic identifier for one disposable DO/process incarnation; it is not a Cloudflare platform primitive and is never stored as world identity.
- `routingEpoch` invalidates stale routes.
- `authorityEpoch` fences stale writers after eviction, migration, failover, or reconciliation.
- PostgreSQL records the canonical current placement/epochs; DO memory and SQLite only cache them.

World correctness cannot depend on a specific process remaining resident.

A durable `ActorProcessId` is also independent of placement. Wave 3 does not run perpetual model loops, but its routing, checkpoint, lease-epoch, alarm/Workflow, and evidence seams must allow a later process to be `reactive`, `scheduled`, or `continuously_eligible` and to move from bounded ActorAgentDO fibers to dedicated compute without changing the subject or process identity.

Amended (2026-10-27): `authorityEpoch` equals `routingEpoch`. The single durable `routing_epoch` of the partition fences both routes and writers; requests and placement keep both fields, and both must equal it. Stale runtime incarnations are fenced by owner generation, which each SpaceDO incarnation claims on the partition row before its first command, alarm or catch-up step. No separate authority epoch or migration is planned. Reason: the shared epoch already fences stale epochs and is tested, and owner generation fences the incarnations an authority epoch was meant to fence.

---

## 4. Owned code and configuration

```text
apps/runtime/
  src/gateway/
  src/auth/
  src/routing/
  src/durable-objects/world/
  src/durable-objects/space/
  src/durable-objects/actor-agent/
  src/mailbox/
  src/alarms/
  src/queues/
  src/workflows/
  src/transfers/
  src/reconciliation/
  src/inspection/
  src/telemetry/
packages/application/src/actors/
packages/application/src/scheduling/
packages/application/src/transfers/
packages/observability/
packages/testkit/src/cloudflare/
tests/cloud/
tests/recovery/
infra/wrangler/
infra/opentofu/
docs/protocols/{actor-routing,alarms,transfers,queues}.md
docs/runbooks/{runtime-reconciliation,queue-dlq}.md
```

Amended (2026-10-19): paths follow the repository. `apps/runtime/src` is flat (`routing.ts`, `owners.ts`, `queues.ts`, `workflows.ts`, …), and the Wave 0 Workflow shells already exist there. Runtime tests live in `apps/runtime/test`, and application use cases in a flat `packages/application/src`. There is no `packages/observability`, `tests/cloud` or `tests/recovery`. Wrangler config is `infra/wrangler/*.json`. The runtime contract doc is `docs/runbooks/runtime.md`, not `docs/protocols/`. Transfer paths wait for §13.

`apps/runtime` is the composition root. Provider SDK types remain inside runtime adapters. Application/domain/kernel/persistence contracts must not import Cloudflare SDKs.

---

## 5. Actor addressing and routing

### 5.1 Canonical address

All routes begin with the versioned logical actor address from Wave 0:

```ts
interface ActorAddressBase {
  version: 1;
  tenantId: TenantId;
  worldId: WorldId;
  timelineId: TimelineId;
}

type ActorAddress = ActorAddressBase & (
  | { kind: "world"; id: WorldId }
  | { kind: "space"; id: SpaceId }
  | { kind: "subject"; id: SubjectId }
  | { kind: "session"; id: SessionId }
  | { kind: "presence"; id: PresenceId }
);
```

Session/presence logical addresses currently route within ActorAgentDO/SpaceDO. Placement can change later without changing logical IDs or external protocols.

### 5.2 DO names

- Derive namespace names from a versioned SHA-256 hash of canonical opaque IDs.
- Never include display names, email, authentication-provider IDs, document titles, or other PII.
- Maintain golden route vectors and explicit name-version migration policy.
- Reject initialization arguments whose trusted canonical address does not match the route name.

### 5.3 Routing epochs

WorldDO resolves a `SpaceRoute` containing namespace/key metadata, `runtimeCellId`, `routingEpoch`, and `authorityEpoch`. Physical commands carry both epochs. A stale route or authority epoch returns a typed reroute/fenced response; it does not guess, forward indefinitely, or commit against the wrong owner.

Router caching is bounded and invalidated by epoch. PostgreSQL retains the canonical partition/space mapping.

Amended (2026-10-27): `authorityEpoch` equals `routingEpoch` (§3.4). Physical commands still carry both, and each is checked against the single durable `routing_epoch`, which fences both routes and writers; a stale value of either refuses before physical execution with 409 `world_command_conflict` (kind `routing-epoch`), as in `docs/protocols/runtime-world-commands.md`, while no-op probes report `stale_epoch`. Stale runtime incarnations are fenced by owner generation. No separate authority epoch or migration is planned.

---

## 6. Worker gateway

Responsibilities:

1. terminate HTTP/WebSocket boundary;
2. verify the configured authentication-provider token/session or strictly isolated test identity;
3. resolve internal principal, roles, grants, tenant, privacy ceiling, and quotas from PostgreSQL;
4. construct trusted `ExecutionContext` and correlation identity;
5. validate API/protocol version and Zod schema;
6. authorize before actor routing;
7. apply request, actor, world, cost, and abuse policy;
8. route through Workers RPC;
9. map typed results/errors to stable HTTP responses;
10. emit redacted operational telemetry.

Clients cannot provide or broaden `ExecutionContext`. Actor keys and trusted internal RPC endpoints are never public.

The production bundle must contain no development auth bypass path. CI scans and integration-tests this invariant.

Amended (2026-11-07): world commands have no quota or cost policy; only mailbox admission and inspector rate limits exist. The owner moves the quota part of step 3 and the cost part of step 7 to Wave 9 (the Wave 9 §18 amendment of 2026-11-07): the gateway resolves the caller's quotas from PostgreSQL and applies cost policy to world commands before routing, as steps 3 and 7 state.

---

## 7. Durable Object initialization and local state

### 7.1 Idempotent initialization

Each class follows:

1. validate route key and trusted initialization address;
2. run bounded local SQLite schema migrations;
3. load canonical routing/projection metadata from PostgreSQL;
4. reconcile alarms, jobs/fibers, and connection metadata;
5. record runtime schema and hydration revision;
6. become ready or return typed unavailable/retry state.

Initialization never creates canonical world/space/subject state. Creation is a Journal command first.

Use `blockConcurrencyWhile()` only for bounded initialization/local migration. Remote I/O must have explicit timeout/recovery and may not indefinitely block all requests.

### 7.2 Allowed local SQLite state

- framework/Agents SDK tables;
- runtime schema and initialization markers;
- WebSocket attachments and acknowledged revisions;
- alarm generation and next mapped wall timestamp;
- Workflow/fiber/reconciliation IDs;
- MCP connection state required by the Agents SDK;
- bounded, explicitly rebuildable runtime cache only after measurement.

Hydrated physical projections, interest maps, recent patches, mailbox execution state, and command context stay in memory unless a later measured need justifies rebuildable persistence.

Prohibited local state:

- a second canonical physical projection;
- canonical conversation/memory tables independent of PostgreSQL;
- independent schedule truth;
- committed world events not yet in Journal;
- secrets that belong in managed secret/credential storage.

---

## 8. Mailboxes and interleaving

Durable Objects are single-threaded, but awaited I/O permits request interleaving. Each owner uses an explicit application mailbox:

- WorldDO: one FIFO control mutation lane;
- SpaceDO: one physical FIFO lane per current object partition, initially one lane per SpaceDO;
- ActorAgentDO: ordered turns per session, concurrent work across sessions, one optimistic cognitive-commit lane.

Mailbox entries include request/command identity, route epoch, context reference, enqueue order, deadline, cancellation, and trace context.

Rules:

- authorization occurs before enqueue;
- mailbox order cannot become canonical order until Journal commit assigns sequences;
- reads declare whether they require mailbox drain, a known revision, or can use a stale bounded snapshot;
- timeouts do not imply command failure after Journal may have committed;
- recovery queries command receipts before retrying;
- bounded queue depth and admission policy prevent hot-owner collapse;
- no nested same-owner RPC that can deadlock the lane.

Amended: in Wave 3, SpaceDO cancellation means dropping a waiting entry when its deadline passes. A started entry always runs to its journal outcome, since stopping it could hide a commit. A disconnected caller does not stop a waiting entry either: the SpaceDO RPCs take no abort signal, and its deadline drops it. The trusted request and correlation IDs stand in for the context reference. A client command carries its route epoch; resume and inspection carry their scope and trace context but no route epoch, catch-up its Workflow run, and alarm work only its kind (`docs/runbooks/runtime.md` "Physical owner mailbox"). Reason: these entries have no route epoch in hand without another read, and alarm work runs one at a time.

Amended (2026-11-07): `WorldDO` has no FIFO control mutation lane of its own; clock controls run in the SpaceDO lane. Reads declare no drain, known-revision or stale-snapshot mode. The owner moves both to Wave 9 (the Wave 9 §18 amendment of 2026-11-07): WorldDO control mutations run in their own FIFO lane under the rules above, and every read declares whether it requires mailbox drain, a known revision, or can use a stale bounded snapshot, and is served as it declares.

---

## 9. Runtime class contracts

### 9.1 WorldDO

```ts
interface WorldActorRpc {
  initialize(input: InitializeWorldActor): Promise<WorldActorState>;
  resolveSpace(input: ResolveSpaceRoute): Promise<SpaceRoute>;
  setClockPolicy(input: Authorized<SetClockPolicy>): Promise<CommandResult>;
  pause(input: Authorized<PauseWorld>): Promise<CommandResult>;
  resume(input: Authorized<ResumeWorld>): Promise<CommandResult>;
  applyExecutionEntitlement(input: Authorized<ApplyWorldExecutionEntitlement>): Promise<ExecutionEntitlementReceipt>;
  beginBranchBarrier(input: Authorized<BranchBarrier>): Promise<BarrierResult>;
  coordinateTransfer(input: Authorized<TransferRequest>): Promise<TransferState>;
  inspect(input: Authorized<WorldInspectQuery>): Promise<WorldInspectResult>;
}
```

Wave 3 implements applied lifecycle, clock policy, directory/epoch, transfer coordination, and inspection. Branch-barrier and execution-entitlement RPCs may return typed not-enabled states until their later waves, but their plane-neutral contracts and authorization boundaries are final. No Runtime RPC accepts money, Stripe customer, invoice, payment-method, tax, or global-wallet state.

Amended (2026-10-19): the branch-barrier and execution-entitlement stubs are built with their consumers, Wave 7 and Wave 12, not stubbed here. `coordinateTransfer` and the SpaceDO transfer RPCs (§9.2) wait for §13. Reason: a stub with no caller freezes a contract before anything uses it.

### 9.2 SpaceDO

```ts
interface SpaceActorRpc {
  initialize(input: InitializeSpaceActor): Promise<SpaceActorState>;
  submit(command: AuthorizedPhysicalCommand): Promise<CommittedCommand>;
  advance(input: AdvanceDueWork): Promise<AdvanceResult>;
  prepareTransfer(input: PrepareTransfer): Promise<TransferState>;
  acceptTransfer(input: AcceptTransfer): Promise<TransferState>;
  finalizeTransfer(input: FinalizeTransfer): Promise<TransferState>;
  snapshot(query: AuthorizedProjectionQuery): Promise<ProjectionSnapshot>;
  inspect(query: AuthorizedObjectQuery): Promise<ObjectInspection>;
}
```

Submission path:

1. validate trusted route/epoch and authorization context;
2. enqueue in physical mailbox;
3. ensure hydrated projection revision or reload;
4. call Journal.execute with expected revision;
5. on commit, apply returned delta only if revision-contiguous;
6. otherwise rehydrate from PostgreSQL;
7. map schedules to next alarm;
8. emit post-commit runtime evidence;
9. return stable committed result.

### 9.3 ActorAgentDO

```ts
interface SubjectAgentRpc {
  initialize(input: InitializeSubjectAgent): Promise<SubjectAgentState>;
  createSession(input: Authorized<CreateSession>): Promise<SessionView>;
  submitTurn(input: Authorized<SubmitTurn>): Promise<TurnAccepted>;
  cancelTurn(input: Authorized<CancelTurn>): Promise<TurnState>;
  receivePerception(input: PerceptionDelivery): Promise<void>;
  reconcileCapabilities(input: CapabilityRevision): Promise<void>;
  inspect(query: AuthorizedSubjectQuery): Promise<SubjectInspection>;
}
```

Wave 3 implements initialization, logical session routing/storage skeleton, perception inbox dedupe, working-cache boundaries, hibernation/recovery metadata, mode (`cognitive`, `interpreted`, `canonical`), and inspector state.

The actual LLM-native cognitive turn, model router, SKILL.md workspace, memory extraction, MCP execution, and proactive heartbeats are later work. Wave 3 must leave explicit activation and run-link contracts for them.

Amended (2026-10-19): the `ActorAgentDO` foundation (RW-0307) moves to Wave 5, its first consumer. Wave 3 keeps today's Wave 0 shell and opaque route. Reason: nothing produces perceptions or sessions until Wave 5.

---

## 10. Perpetual scheduling and alarms

### 10.1 Clock model

Each timeline stores simulation time, wall anchor, speed ratio, running/paused state, catch-up cap/policy, partition-head vector, and named random-state references. Wall time is only a wake signal; canonical simulation time changes through Journal commands.

WorldDO owns policy. Each SpaceDO maps its earliest relevant simulation deadline to a wall timestamp under the current policy.

### 10.2 Activity-driven spatial fidelity

The runtime scales with activity and interest, not total world population:

| Fidelity | Runtime behavior |
|---|---|
| Hot | Connected presence or material interaction; authoritative cell resident, realtime projection active, full relevant deterministic systems |
| Warm | No active viewer but near-term schedules/transfers exist; bounded projection and sparse deterministic advancement |
| Dormant | No resident runtime required; durable schedules, journal, snapshots, and policy are sufficient until wake |

Transitions are policy-driven and journal-linked. Entering hot/warm rehydrates from PostgreSQL, verifies both epochs, drains bounded exact/aggregate catch-up, then admits new commands. Leaving hot persists canonical work/cursors before local state is discarded. Cognitive actors are a separately budgeted subset; a hot spatial cell does not wake every contained mind.

This borrows the proven simulation-distance/activation-range pattern without inheriting a fixed server tick. Clockgrove retains semantic deadlines, material-equivalence policy, and sleeping worlds.

Activity placement uses the Wave 1 `SpatialIndexPort` with the loose-quadtree adapter. One small space starts with one authority owner. Leaf summaries and broad scoped-event cursors determine which bounded cells need work; a hot leaf is promoted to a runtime cell or additional `SpaceDO` only after measured owner CPU, storage, schedule, or fanout pressure. A target-scale fixture contains up to one million logical actors while proving that active/visible work remains bounded. Shipping an octree and arbitrary early sharding are Wave 3 non-goals, but index cell references remain opaque and epoch-scoped so a future 3D index can be rebuilt and routed without identity changes.

Amended (2026-10-19): spatial fidelity is awake/asleep only. An owner is either running, or asleep with its alarm set. Hot/warm/dormant tiers, runtime cells, quadtree promotion, the §3.4 `fidelity` field and the one-million-actor fixture wait until measurements show pressure, and move after GA to Wave 11 (parent §35). Reason: this plan forbids sharding before measurement (§19, §22).

### 10.3 One-alarm discipline

Each DO has one physical alarm. It records an `alarmGeneration`; stale handlers exit without changing state.

Alarm handler:

1. load/verify current generation and world policy;
2. query canonical next due work and current partition head;
3. drain a bounded number/time budget through ordinary `advance` commands;
4. commit every mutation through Journal;
5. if due work remains, persist continuation evidence and schedule near-term continuation;
6. otherwise map the next due simulation deadline to one alarm;
7. on excessive catch-up, start the typed catch-up Workflow and record linkage;
8. finish idempotently.

Never use `setInterval`, global polling, one alarm per logical schedule, or client presence as the source of world time.

### 10.4 Policy changes

Pause/resume/speed/catch-up changes:

- commit canonically first;
- increment/recompute alarm generation;
- update mapped deadlines idempotently;
- never skip due exact work;
- preserve Wave 1 exact/material-equivalence policy;
- produce inspectable reason and old/new policy versions.

### 10.5 Equivalence proof

For each scenario, compare:

- continuous CLI/Journal advancement;
- frequent alarm advancement;
- one long sleep and bounded catch-up;
- alarm redelivery;
- DO restart between batches;
- deployment/version-compatible rehydration;
- catch-up Workflow continuation.

All must reach the same declared material state/events/hash.

---

## 11. Queue topology and reconciliation

Three queues are separate failure/cost domains:

1. `world-reactions` for post-commit perception/rule/activation work;
2. `cognitive-indexing` for later memory/context/search projection work;
3. `external-effects` for governed side effects.

Wave 3 implements publishers, consumers, semantic dedupe, retries, poison classification, DLQs, replay/admin tooling, and scheduled outbox sweeper.

Consumer procedure:

1. validate envelope/version/scope;
2. resolve dispatch/effect canonical row;
3. claim/lease semantic work idempotently;
4. execute bounded adapter/use case;
5. persist result/evidence;
6. acknowledge transport only after durable disposition;
7. retry typed transient failure with policy delay;
8. dead-letter typed permanent/poison failure and alert.

Transport delivery count is diagnostic. Semantic attempt state in PostgreSQL governs correctness.

Preview and replay effects remain simulated/blocked. Wave 3 uses fake external effect adapters; it does not send messages or mutate third-party systems.

Amended (2026-10-19): Wave 3 proves one generic publish, sweep, consume and DLQ path on `world-reactions`, the only channel with a producer. `external-effects` and its fake adapters go to Wave 5, and `cognitive-indexing` to Wave 6; both keep refusing consumers until then.

---

## 12. Typed Workflow skeletons

Use Workflows only for long, multi-step, retry-heavy, approval-bound, or cross-owner jobs. Ordinary command turns and alarms do not become Workflows.

Wave 3 provides typed skeletons and run/evidence linkage for:

- catch-up simulation;
- snapshot/projection rebuild;
- ingestion/consolidation/authoring future classes;
- recovery/reconciliation job base.

Each Workflow defines input/output schema, step names, idempotency, retry/timeout, cancellation, deployment compatibility, evidence IDs, and status reconciliation. Skeletons may exercise deterministic fixture work; they must not introduce unused generalized orchestration frameworks.

Amended (2026-10-19): Wave 3 builds only the provisioning, readiness and catch-up Workflows. The other skeletons go to the waves that use them: ingestion and consolidation to Wave 6, authoring and pack upgrade (§12.1) to Wave 7, transfer recovery with §13, and agent jobs to the wave that first runs one. The Wave 0 shells stay as they are.

Amended: the snapshot/projection-rebuild skeleton that issue 702 dropped has owners. Snapshots and the verification replay run on the runtime's own 5-minute Cron Trigger, not a Workflow nor a SpaceDO alarm: a Cron Trigger needs no new binding, its own invocation keeps a replay cut off at the CPU limit away from the scheduled recoveries, and each partition's work is one idempotent step (issue 843; docs/runbooks/runtime.md, "Scheduled snapshots and verification replay"). Rebuild of canonical state stays verification only (Wave 2 §9.4), and that same sweep performs it; canonical repair by re-execution is Wave 7. Rebuild of derived read models goes with the waves that add them (Waves 4 and 6).

### 12.1 World provisioning and upgrade skeletons

`WorldProvisioningWorkflow` claims an existing canonical case, validates the pinned artifact, advances only the next durable case step, submits stable genesis/seed commands through Journal, initializes schedules/cognition/random state, verifies expected projections, creates runtime placement, and commits readiness. Workflow history is not provisioning truth; PostgreSQL case/install/receipt records allow a replacement Workflow or CLI reconciler to resume safely.

`WorldPackUpgradeWorkflow` is a typed skeleton only in Wave 3. It preserves installation identity/history and hands preview/migration/promotion behavior to Wave 7.

---

## 13. Cross-space transfer

### 13.1 State machine

```text
requested
  → source_prepared
  → destination_accepted
  → source_released
  → completed

terminal/exception: rejected | reconciling
```

### 13.2 Protocol

1. Source SpaceDO commits `TransferPrepared` with transfer ID, source revision, object snapshot hash, destination, and routing epoch.
2. WorldDO validates epoch/destination and coordinates the logical saga.
3. Destination SpaceDO idempotently validates and commits `TransferAccepted`.
4. Source commits release.
5. Source/destination project completion.
6. Scheduled reconciler advances or safely resolves incomplete states.

No distributed transaction is attempted. Until destination acceptance, source remains canonical. After acceptance, the canonical transfer state unambiguously determines owner and allowed operations.

### 13.3 Fixture

Extend the headless world with two physical spaces connected by a portal. Move one actor with containment/inventory state across the boundary. Test commands directed at source, destination, stale epoch, and every crash point.

Amended (2026-10-19): cross-space transfer (RW-0308) is deferred. Wave 3 runs one SpaceDO per world partition. Transfer needs world state split per space across the kernel, journal, snapshots, bundles and goldens, which is its own later Objective, built once a real multi-space world needs it: Wave 11, after GA (parent §35).

---

## 14. Runtime inspector

Authorized inspection must expose:

- logical actor address and current physical placement;
- DO key version without revealing source PII;
- initialized/runtime schema/code version;
- canonical hydration revision and database head;
- mailbox depth, oldest age, active entry, and admission state;
- alarm generation, mapped wall time, next sim deadline, and catch-up cursor;
- connection/session metadata safe for the caller;
- Queue dispatch/effect status, DLQ reason, and replay action;
- Workflow/fiber IDs and reconciliation state;
- transfer saga state;
- last restart/rehydration/revision mismatch;
- correlation links to commands, events, evidence, and traces.

Inspector values may be operationally stale and must say so. They never supersede canonical Journal inspection.

Amended (2026-11-07): the inspector shows catch-up Workflow IDs but not provisioning or readiness ones. The owner moves those to Wave 9 (the Wave 9 §18 amendment of 2026-11-07): the inspector shows the provisioning and readiness Workflow IDs and their reconciliation state, as this list requires for every Workflow.

---

## 15. Detailed work packets

Amended (2026-10-19): the Wave 3 Objectives are filed:

- issue 698 world commands run through the real owner path (RW-0301, RW-0302 directory and lifecycle, RW-0303);
- issue 699 the world keeps time by itself (RW-0302 clock, RW-0304);
- issue 700 committed dispatches flow through Queues (RW-0305);
- issue 701 operators inspect and observe the running service (RW-0309, §19, §20);
- issue 702 provisioning, readiness and catch-up run as durable Workflows (RW-0306);
- entry issues issue 2 (Wave 0 hosted half) and issue 694 (RW-0209).

RW-0307 moves to Wave 5 and RW-0308 is deferred (§9.3, §13). RW-0310 qualification, the §17 fault matrix, §19 load and the §18.3 soak are Tasks run against a frozen candidate, not Objectives.

Amended (2026-10-28): the RW-0310 manifest builder exists. `pnpm qualify:wave3` builds and validates the Wave 3 evidence manifest from one Qualification run, and Qualification's `wave3-manifest` job runs it ([development runbook](../runbooks/development.md#acceptance-commands)). The §17 fault matrix and §19 load curves are delivered and feed it. The Qualification run of the frozen candidate and the §23 exit review remain Tasks.

### RW-0301 — Actor routing, opaque DO names, and namespace evolution

Implement pure router, address→class mapping, SHA-256 naming, durable domain/runtime placement separation, route vectors, routing/authority epochs, Workers RPC client adapters, namespace/version migration seams, authorization-before-routing tests, and stale/fenced types.

Exit: identical addresses route identically across runtimes; no PII appears in names/logs; logical session/presence routes preserve future promotion seams.

### RW-0302 — WorldDO runtime coordinator

Implement initialization, applied runtime lifecycle, clock policy, partition/runtime-cell directory, routing and authority epochs, fidelity transitions, pause/resume/speed, future execution-entitlement seam, transfer coordinator entrypoint, operator inspection, mailbox, and rehydration.

Exit: world policy survives eviction/deploy and stale space routes fail deterministically.

### RW-0303 — SpaceDO command owner

Implement initialization, projection hydration, hot/warm/dormant transitions, physical mailbox, epoch fencing, Journal submission, commit/response crash recovery, revision-contiguous cache update, mismatch rehydrate, snapshot/inspect RPC, and bounded admission.

Exit: all Wave 1 scenarios can execute through Worker→SpaceDO→Journal without semantic/hash divergence.

### RW-0304 — Simulation alarms and bounded catch-up

Implement fidelity-aware deadline mapping, one-alarm generation, handler, pause/speed recomputation, bounded drain, dormant reactivation, continuation, Workflow escalation, and complete alarm/restart matrix.

Exit: live/sleep/retry/redeploy progress is materially equivalent.

### RW-0305 — Queue dispatch runtime

Implement three bindings/channels, post-commit publisher, outbox sweeper, consumers, claims, semantic dedupe, retry policy, poison handling, DLQs, replay/admin commands, and evidence.

Exit: lost publish hints, duplicate messages, consumer crashes, and poison payloads reach one safe semantic disposition.

### RW-0306 — Typed Workflow foundations

Implement typed base, world-provisioning/install fixture, upgrade skeleton, catch-up and recovery fixture workflows, input/output validation, step evidence, retries, timeouts, cancellation, deployment compatibility tests, and reconciliation.

Exit: interrupted/deployed workflows resume or fail with explicit durable status and no duplicated canonical mutation; provisioning can resume at every seed/projection/readiness boundary and produces one ready world.

### RW-0307 — ActorAgentDO foundation

Implement mode-aware initialization, subject policy reference, logical multi-session routing skeleton, ordered session mailbox metadata, perception dedupe inbox, working-cache bounds, capability revision hook, hibernation metadata, recovery/inspection, future activation contract, and a placement-neutral `ActorProcessId`/lease/checkpoint routing fixture.

Exit: multiple session identities remain independent, duplicate perceptions do not duplicate intake, and no physical state becomes actor-local authority.

### RW-0308 — Cross-space transfer

Implement transfer schema/use cases, WorldDO coordination, source/destination RPCs, routing epoch, reconciliation, fixtures, and crash matrix.

Exit: exactly one canonical owner exists at every protocol state and recovery completes safely.

### RW-0309 — Runtime inspector and reconciliation views

Implement authorized endpoints/CLI for DO/runtime, mailbox, alarm, Queue, Workflow, actor, and transfer state with canonical evidence links, staleness labels, audit, and redaction.

Exit: an operator can diagnose every injected Wave 3 failure without raw provider consoles.

### RW-0310 — Runtime qualification

Assemble local and real-Cloudflare suites: pack install/provision retry and readiness gating, init/restart/migration, disposable-instance replacement, stale-authority fencing, spatial-index epoch and actor-process placement migration, hot/warm/dormant transitions, interleaving, commit crash windows, Hyperdrive outage, alarm catch-up, Queue/DLQ, Workflow deployment, actor key privacy, routing epochs, transfer saga, and sleep/wake equivalence.

Exit: publish Wave 3 qualification manifest and satisfy the wave outcome.

---

## 16. Dependency graph and bounded execution

```text
RW-0301 ─┬─ RW-0302 ─┬─ RW-0304 ─┐
         ├─ RW-0303 ─┼─ RW-0308 ─┼─ RW-0309 ─ RW-0310
         └─ RW-0307  │            │
RW-0305 ─────────────┤            │
RW-0306 ─────────────┴────────────┘
```

Parallel lanes:

- router/name vectors and Queue runtime;
- WorldDO and SpaceDO after common initialization/mailbox contracts freeze;
- ActorAgentDO skeleton and Workflow typed base;
- alarm mapping and transfer fixture authoring;
- runtime inspector schema and fault harness against frozen status contracts.

Changes to an RPC, queue, transfer, or runtime-inspection contract land before dependent agents. Agents own distinct runtime paths and test fixtures; Wrangler binding/config changes have one coordinating owner.

---

## 17. Failure and recovery matrix

Inject:

- DO creation, eviction, restart, local migration, and deployment;
- concurrent requests around awaited PostgreSQL I/O;
- timeout before and after Journal commit;
- hydrated cache behind/ahead/corrupt relative to PostgreSQL;
- Hyperdrive connection refusal, interruption, latency, and pool reuse;
- stale routing epoch and namespace version;
- alarm duplicate, late, stale generation, crash mid-batch, and catch-up overflow;
- Queue publish failure, duplicate delivery, delayed delivery, consumer crash, poison message, and DLQ replay;
- Workflow step crash, retry, cancel, deploy, and result reconciliation;
- ActorAgentDO duplicate perception, session contention, eviction, and capability revision;
- transfer crash before/after each state transition;
- inspector request during degraded state.

For every case assert canonical Journal state, command receipt, local runtime disposition, eventual schedule/dispatch/transfer state, evidence completeness, safe user result, and absence of duplicate semantic effects.

---

## 18. Test and qualification strategy

### 18.1 Local/runtime tests

Use Cloudflare Vitest pool/Wrangler with real PostgreSQL where supported. Mocks are acceptable only for targeted provider fault injection and must not replace end-to-end ownership tests.

```text
pnpm check
pnpm test:runtime
pnpm test:runtime:actors
pnpm test:runtime:interleaving
pnpm test:runtime:alarms
pnpm test:runtime:queues
pnpm test:runtime:workflows
pnpm test:runtime:transfers
pnpm test:runtime:recovery
pnpm verify:runtime-scenario-parity
```

Amended (2026-10-28): `test:runtime:actors` and `test:runtime:transfers` are removed. Their subjects left the wave with the maintainer's 2026-10-19 amendments, the `ActorAgentDO` foundation (RW-0307) to Wave 5 (§9.3) and cross-space transfer (RW-0308) to Wave 11 (§13), so no Wave 3 test has either subject. Each other command is a root script that runs a named set of `apps/runtime` test files, and no file is in two of them; `verify:runtime-scenario-parity` runs the native-owner and autonomous scenario parity long runs that §18.3 relies on ([development runbook](../runbooks/development.md#acceptance-commands)). `pnpm check` refuses a command listed here that has neither a script nor an amendment.

### 18.2 Staging cloud qualification

Real Cloudflare tests verify behavior local emulation cannot prove:

- DO placement, eviction/restart, deployment, and hibernation metadata;
- Workers RPC and namespace migration behavior;
- Hyperdrive interruptions/pooling;
- alarm delivery/limits;
- Queue redelivery, delay, and DLQ;
- Workflow replay/wait/cancel/deployment compatibility;
- OTel trace propagation/export;
- bundle size, CPU, memory, subrequest, and wall-time limits.

Qualification creates isolated tenant/world/timeline IDs and cleans up through audited commands. It never targets production user worlds.

### 18.3 Scenario parity

Run at minimum:

- `rain-shelter-comfort` under frequent alarms and one sleep;
- `food-decay-and-conservation` with commit/response and Queue duplicates;
- `cedar-growth` through catch-up Workflow;
- `birth-and-parentage` across deploy/restart;
- two-space movement/transfer crash matrix;
- 30-day accelerated runtime soak.

Compare semantic events and final hashes to Wave 1/2 goldens.

Amended (2026-11-07): `food-decay-and-conservation` runs with commit/response duplicates but has no Queue-duplicate mode. The owner moves that mode to Wave 9 (the Wave 9 §18 amendment of 2026-11-07): the run with Queue duplicates matches the Wave 1/2 golden semantic events and final hash.

---

## 19. Runtime budgets and load evidence

Establish configurable budgets and measure rather than assume:

- mailbox depth, oldest age, and command service time;
- hydrated state size and rehydration duration;
- commands/advancements per activation;
- alarm lateness and catch-up batch duration;
- Worker/DO CPU, memory, subrequests, and wall time;
- database transaction and Hyperdrive wait time;
- dispatch backlog and DLQ rate;
- Workflow steps and duration;
- transfer completion/reconciliation time;
- active ActorAgentDO count and per-session ordering contention.
- hot/warm/dormant cell counts, transition rates, wake latency, and compute per fidelity-hour;
- stale route/authority rejections and runtime-instance replacement rate.

Load fixtures identify the first hot-space and catch-up-storm curves. Wave 3 does not prematurely add shards, but records the thresholds that would trigger the existing partition/promotion seams.

Amended (2026-10-19): fidelity-tier and `ActorAgentDO` counts leave this list with §10.2 and §9.3.

---

## 20. Observability

Every external request and internal hop propagates correlation and causation IDs without treating a run ID as a trace ID.

Structured telemetry includes:

- gateway authorization/routing result and stable error code;
- DO class, hashed route fingerprint, runtime schema, and hydration revision;
- mailbox wait/service/timeout;
- Journal command/receipt/event IDs;
- alarm generation, target, lateness, batch, and continuation;
- Queue channel, semantic dispatch ID, transport attempt, disposition, and DLQ;
- Workflow/run/step IDs and status;
- transfer ID/state/source/destination/epoch;
- rehydrate/reconcile cause and result;
- resource/cost counters.

Private payloads, prompts, messages, tokens, credentials, display names, and raw actor keys are denied by default. Canonical causality remains queryable through the inspector even if Sentry/PostHog/OTel export fails.

Amended (2026-10-19): metrics, including the Wave 2 §16 metrics deferred here, go to Cloudflare-native analytics. There is no external OTel collector account, so §18.2 "OTel trace propagation/export" reads as correlation propagation and analytics export. Reason: no new vendor account or secret.

Amended (2026-10-27): the deferred Wave 2 §16 signals are live Workers Analytics Engine metrics (docs/runbooks/runtime.md "Metrics"), except optimistic conflicts, idempotent receipt hits, request-hash mismatches and failures by stable error code on Worker-answered requests, which issue 874's `world_command_answered` and `noop_command_answered` records evidence through their outcome, code and failure class. Conflicts of alarm and autonomous commands, which answer no request, are the `autonomous_conflicts` metric. The §20 runtime signals above (alarm lateness, admission wait and service time, rehydration cause, Workflow steps, cost) are issue 848.

Amended (2026-10-27): the gateway authorization/routing result and stable error code, stale route and authority-epoch rejections included, and the mailbox timeout and refusal counts above are evidenced by issue 874's `world_command_answered` and `noop_command_answered` records, not by metrics. The remaining §20 runtime signals (alarm lateness, batch and continuation; mailbox wait and service time; rehydrate/reconcile cause; catch-up step duration and outcome; per-activation resource counters) are live Workers Analytics Engine metrics (docs/runbooks/runtime.md "Metrics").

Amended (2026-11-07): telemetry lacks the DO class, the hashed route fingerprint and the runtime schema. The owner moves them to Wave 9 (the Wave 9 §18 amendment of 2026-11-07): structured telemetry carries all three, under the redaction rule above (no raw actor keys).

---

## 21. Security gates

- Authentication-provider verification and PostgreSQL authorization precede actor routing.
- DO names contain only hashed opaque canonical IDs.
- RPC payloads distinguish trusted internal context from user input.
- Runtime cannot broaden roles, grants, tenant, timeline, or privacy ceiling.
- Production bundle contains no auth bypass.
- Queue/Workflow envelopes are versioned, tenant-scoped, validated, and deduplicated.
- Preview/experimental timelines cannot send external effects.
- ActorAgentDO private session/perception metadata never enters space/public inspection.
- Runtime inspector is grant-controlled, audited, redacted, and staleness-labeled.
- Abuse/admission limits protect hot owners and catch-up storms.
- Secrets are bindings/credential references, never local SQLite or logs.

---

## 22. Explicit non-goals

Wave 3 does not implement:

- Phaser/React scene, realtime projection patches, or user multiplayer UX;
- full LLM-native actor turn, model routing, SKILL.md learning, memory, dreaming, or MCP execution;
- proactive external messaging or channel adapters;
- dedicated SessionDO/PresenceDO/ObjectDO or generalized actor framework;
- Kafka, Redis, Temporal, Restate, Rivet, or a second canonical state service;
- full branch barriers, authoring, promotion, or rule reaction engine;
- horizontal spatial sharding before measured hot-owner evidence;
- unbounded catch-up or one alarm per actor/object.

The actor/cognition and channel concepts remain architectural contracts, not prematurely implemented machinery.

---

## 23. Exit evidence checklist

- [ ] RW-0301 through RW-0310 merged with frozen contracts.
- [ ] Worker verifies/authorizes before actor routing; no production bypass exists.
- [ ] DO names and routing vectors are deterministic and PII-free.
- [ ] WorldDO policy/directory/routing epoch survives eviction and deploy.
- [ ] Logical world/space identity survives runtime-cell migration and disposable-instance replacement.
- [ ] Stale runtime instances are fenced by authority epoch before mutation.
- [ ] Hot/warm/dormant fidelity transitions preserve material equivalence and bounded wake latency.
- [ ] SpaceDO command path acknowledges only after Journal commit.
- [ ] Cache mismatch always resolves in favor of PostgreSQL.
- [ ] Mailbox interleaving and timeout matrix passes.
- [ ] One-alarm scheduling, pause/speed changes, retry, and catch-up pass.
- [ ] Queue duplicate/poison/DLQ/reconciliation suite passes.
- [ ] Workflow retry/cancel/deploy/reconciliation suite passes.
- [ ] ActorAgentDO session/perception skeleton preserves privacy and independent ordering.
- [ ] Cross-space transfer has one owner in every crash state.
- [ ] Live/sleep/restart/deploy execution matches headless semantic hashes.
- [ ] Runtime inspector diagnoses every injected failure with causal links.
- [ ] Local and real Cloudflare qualification passes.
- [ ] Main remains deployable and local development remains reproducible.

Amended (2026-10-19): RW-0307 and RW-0308 are out of this wave, so their items (`ActorAgentDO` skeleton, cross-space transfer, and the §17 and §18.3 transfer cases) leave the checklist. "Hot/warm/dormant fidelity" reads as awake/asleep, and "runtime-cell migration" waits with runtime cells (§10.2). The Queue suite runs on `world-reactions` (§11).

Amended (2026-10-27): `authorityEpoch` equals `routingEpoch` (§3.4, §5.3), and the single durable `routing_epoch` fences both routes and writers. No separate authority epoch or migration is planned. "Stale runtime instances are fenced by authority epoch before mutation" reads as: stale supplied epochs are refused against that shared routing epoch before mutation, and stale runtime incarnations are fenced by owner generation before mutation.

The qualification manifest records commit, runtime/compatibility versions, binding manifest hash, migration head, test/fault results, scenario hashes, Cloudflare qualification evidence, load curves, resource/cost counters, and the exit decision.

Amended (2026-10-28): `pnpm qualify:wave3` writes that manifest. Each item above resolves to `passed` from candidate-bound receipts, `review` naming its review, `deferred` to the wave the amendments name, or `pending` naming what is missing and its issue. "Local and real Cloudflare qualification passes", every §18.2 item and the Cloudflare half of any other item stay pending on issue 3, and "Main remains deployable" on issue 2, until hosted evidence exists; the validator refuses them marked passed.

---

## 24. Handoff to Wave 4 and later cognition waves

Wave 4 can now attach scene WebSockets, authorized snapshots/patches, interest filtering, Phaser rendering, and the causal inspector UI to `SpaceDO` without changing canonical authority.

Later cognitive waves can implement the project-owned actor harness inside `ActorAgentDO` using its existing activation/session/perception/capability seams. The harness may add heartbeats, triggers, skills, model routing, MCP, memory, and proactive delivery intents, but it must continue to propose typed commands through Journal rather than becoming a second world authority.

Amended (2026-10-19): Wave 5 builds those `ActorAgentDO` seams itself (§9.3), with the `external-effects` channel. Wave 6 receives `cognitive-indexing`, Wave 7 the branch barrier and the authoring and upgrade Workflows, and Wave 11, after GA, the per-space state split with cross-space transfer and the fidelity tiers.

---

## 25. Comparative systems references

- PaperMC simulation distance and server-side activation boundaries: https://docs.papermc.io/paper/reference/server-properties/
- PaperMC world ticking controls: https://docs.papermc.io/paper/reference/world-configuration/
- Roblox server-authority model: https://create.roblox.com/docs/projects/server-authority
- Roblox persistent DataStores across disposable place/server instances: https://create.roblox.com/docs/cloud-services/data-stores

These are implementation lessons, not compatibility or product-positioning requirements. Clockgrove deliberately improves on them where a greenfield event-sourced architecture can make sleep/wake equivalence, epoch fencing, and causality explicit.
