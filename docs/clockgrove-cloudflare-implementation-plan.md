# Clockgrove: Cloudflare-Native Implementation Plan

**Status:** Current implementation specification  
**Version:** 3.12  
**Date:** October 27, 2026  
**Target:** General-availability architecture delivered in cumulative development waves  
**Product basis:** `clockgrove-prd-v0.5.md`; every implementation-relevant product contract is incorporated below  
**Architecture inputs:** foundation research, the approved Cloudflare decision, the corrected adversarial review, the Waves 0–12 editorial review, the accepted persona/object-mobility ADR, and the accepted Management/Runtime/shared-wallet ADR  
**Audience:** maintainers, coding agents, reviewers, operators, and open-source contributors

---

## 1. How to use this document

This is the canonical, self-contained engineering handoff. It defines the product contract needed by implementers as well as the production architecture, code boundaries, persistence authority, runtime placement, infrastructure, protocols, tests, delivery waves and acceptance gates. A coding agent should not need the PRD open to understand the intended world, user loop or definition of correct behavior.

The PRD remains the source product record; this plan is authoritative for implementation. When a newly discovered conflict appears:

1. preserve the PRD's product invariant;
2. preserve this plan's authority and safety boundaries;
3. record an ADR before changing a fixed architectural decision;
4. prefer a new implementation behind an existing contract over changing the contract casually.

Every development wave exercises the production architecture through final interfaces. A wave may contain only one world, one space, or one actor, but it must use the same IDs, journals, actor routes, security, migrations, telemetry, and recovery rules intended for GA.

### 1.0 Reconciled scope

The v3.8 baseline incorporated the accepted post-v3.0 product/runtime decisions, the PRD 4.3 future-capability pressure test, the end-to-end Raccoon World provisioning/browser walkthrough, and the accepted Management Plane / World Runtime Plane boundary. Development automation is externalized to the separate `clockgrove/factory` project and is not a product/runtime dependency:

- Clockgrove is the platform for any world. Raccoon World, its first reference world, lives in its own repository, [clockgrove/raccoon-world](https://github.com/clockgrove/raccoon-world), and builds against Clockgrove at a pinned commit. Clockgrove's own test world is `worlds/fixture`, the platform's portability proof.
- Better Auth is the reference OSS authentication adapter; Clerk is optional.
- Workspace membership, world membership, world persona, and live presence are distinct records.
- Mutation attribution is required from Wave 0 onward, before billing exists.
- Personal inventory and object mobility are world- and timeline-local; cross-world runtime object portability is explicitly out of scope.
- Mobility policy inherits from world to space to role/persona to archetype to instance; children may narrow but not silently widen, and deny wins.
- One million logical actors per world is a qualification target. A loose quadtree and activity tiers prevent total population from implying total activation.
- Waves 0–9 are the technical/open-source track, Waves 10–11 are the shared hosted-world track, and Wave 12 is optional commercial hosting.
- One Management-owned `BillingAccount` wallet is shared across its worlds. PostgreSQL owns immutable accounting, Redis atomically allocates bounded world credit leases, Runtime consumes leases locally, and Stripe remains Management-only money infrastructure.
- Management owns identity/tenancy, world catalog/desired lifecycle, pack registry, provisioning cases, quotas, sponsorship, wallet/rating/accounting and Stripe. World Runtime owns journals, simulation, cognition, world participation, attribution and projection. They initially compose as a modular monolith/CLI and may split physically later without changing contracts.

If an older subsection conflicts with this reconciliation, this subsection, PRD v0.5, and the accepted ADR control in that order of specificity.

Version 3.9 accepts the [incremental-delivery ADR](adr/clockgrove-adr-incremental-wave-delivery-and-evidence.md): substantial sequential workstreams with numerous capability Objectives, early product checkpoints, a bounded local-readiness exception, and proportionate candidate qualification. It reconciles the accepted privacy category/set-ceiling contract and assigns governed cognitive documents, bounded compiled policies, external observations and actor research to their implementation owners. Full wave exits, release requirements and product/runtime authority boundaries remain intact.

Version 3.10 adds field guides and counterfactual Why under the accepted [topic ADR](adr/clockgrove-adr-field-guides-and-counterfactual-why.md). These reuse versioned cognitive documents/consolidation and existing isolated preview/evaluation respectively; neither creates an alternate store or world-truth authority. Wave 6 owns guides, Wave 7 bounded deterministic counterfactuals, Wave 8 integrated journeys, and Wave 9 release evidence.

### 1.1 Decision classes

| Class | Meaning | Change process |
| --- | --- | --- |
| Fixed | Required for coherent implementation | ADR plus maintainer approval |
| Tunable | Expected to change from evidence | Configuration or versioned policy |
| Deferred implementation | Contract exists; additional implementation is unnecessary yet | Add behind the contract after an explicit trigger |

Fixed decisions include Cloudflare production placement, PostgreSQL canonical authority, the deterministic kernel boundary, three physical Durable Object classes, typed commands/events, first-class timelines, provider-neutral human identity with Better Auth as the OSS reference adapter, governed capabilities, and causal evidence.

Tunable decisions include simulation speed, cognition budgets, model aliases, retrieval weights, patch batching, artifact spill threshold, snapshot cadence, retention, and sharding thresholds.

Deferred implementations include dedicated SessionDO or PresenceDO placement, specialized graph projections, additional MCP transports, additional telemetry destinations, and multiple spatial shards for worlds that fit within one.

### 1.2 Completion standard

A feature is complete only when it has:

- a versioned contract;
- authorization and privacy behavior;
- canonical persistence or an explicit statement that it is ephemeral/derived;
- deterministic or recorded nondeterminism semantics;
- correlation and causation identity;
- unit and integration tests;
- fault/retry tests at relevant boundaries;
- inspector visibility;
- migration and rollback/forward-fix behavior;
- local development support;
- an operational metric or evidence query;
- documentation in the owning package.

---

## 2. Executive architecture

Clockgrove runs persistent, multiplayer simulations where world state advances independently, every meaningful entity is logically addressable, selected subjects can be conversed with, memory can alter later decisions, and operators can author changes through isolated preview timelines.

The production stack is:

- **Cloudflare Workers** for the public HTTP boundary, authentication-provider session verification, authorization orchestration, request routing, provider events, static assets, and administrative endpoints.
- **Cloudflare Durable Objects** for globally addressable single-owner execution, spatial consistency, active actor state, hibernating WebSockets, and realtime projection.
- **Cloudflare Agents SDK** for `ActorAgentDO`, recoverable fibers, agent-client communication, and remote MCP connectivity.
- **Cloudflare Workflows** for long, multi-step, retry-heavy, approval-bound, or cross-owner jobs.
- **Cloudflare Queues** for three asynchronous failure domains: world reactions, cognitive indexing, and external effects.
- **Cloudflare R2** for large or binary immutable artifacts, world assets, exports, and replay bundles.
- **Cloudflare AI Gateway** plus the Vercel AI SDK for model routing, streaming, structured outputs, embeddings, accounting, and provider policy.
- **Neon PostgreSQL with pgvector**, accessed through Hyperdrive, as the canonical world and cognitive evidence ledger.
- **Better Auth** as the default OSS authentication/session/organization adapter, with Clerk as an optional hosted adapter behind the same project-owned port.
- **React, Vite, React Router, TanStack Query, Zustand, and Three.js WebGPURenderer with WebGL2 fallback** for the browser experience.
- **Cloudflare Workers Observability, OpenTelemetry export to Sentry, and PostHog** for operations, diagnostics, and product analytics. Canonical product evidence remains queryable in PostgreSQL.
- **OpenTofu, Wrangler, Drizzle migrations, and GitHub Actions** for infrastructure and delivery.

The authority rule is:

> A Durable Object owns serialized execution at a consistency boundary. PostgreSQL decides whether an action became canonical history.

No successful mutation is acknowledged before its PostgreSQL transaction commits. Durable Object storage, Workflow state, Queue delivery, model output, telemetry, or client state can never independently become world truth.

### 2.1 System shape

```text
Browser
  React shell
  Three.js lit isometric scene
  chat · inspector · timeline · authoring · operator UI
        │
        │ HTTPS / WebSocket
        ▼
Cloudflare Worker gateway
  Management API: identity · tenancy · world catalog/lifecycle
                  pack registry · provisioning · quotas · wallet · Stripe
  Runtime API: world authorization · commands · chat · inspection · projection
  one modular deployable initially; typed plane boundary internally
        │
        ├──────────────► WorldDO(tenant, world, timeline)
        │                 world runtime coordinator
        │                 clock policy and space directory
        │                 global rules and branch barriers
        │
        ├──────────────► SpaceDO(tenant, world, timeline, space)
        │                 physical serialization and simulation
        │                 scene WebSocket and ephemeral presence
        │                 passive-object actor facade
        │
        └──────────────► ActorAgentDO(tenant, world, timeline, subject)
                          cognition and interpreted perspective
                          multiple conversation sessions
                          fibers, model calls, MCP and tools

All canonical paths ── Hyperdrive ──► Neon PostgreSQL
                                      journals and projections
                                      schedules and timelines
                                      sessions, runs and cognition
                                      graph, FTS and pgvector

Long durable jobs ────────────────► Cloudflare Workflows
Committed async work ─────────────► Cloudflare Queues
Large/binary artifacts ───────────► Cloudflare R2
Models ───────────────────────────► AI SDK → AI Gateway
```

### 2.1.1 Logical plane boundary

The public gateway may be one deployable and the local `clockgrove` CLI may compose both planes in-process, but authority is logically split:

| Management Plane | World Runtime Plane |
| --- | --- |
| Principals, tenants/workspaces and workspace roles | World membership, personas, presence and inventory |
| World catalog and desired lifecycle | Applied runtime lifecycle and `WorldReady` truth |
| Pack registry and provisioning/upgrade/archive/delete cases | Genesis, migrations, journal commits and installation receipts |
| Billing accounts, shared wallets, sponsorship, quotas, rating, accounting and Stripe | Attributed raw usage, world-local credit-lease enforcement and execution modes |
| Administrative APIs and desired policy | Simulation, schedules, actors, cognition, conversations and scene/text projection |

No Management adapter writes world journal/state tables. No Runtime adapter imports authentication-provider, Stripe, invoice, payment, tax or global-wallet persistence. Cross-plane changes use versioned commands/cases, leases, usage receipts and applied-state projections with outbox/reconciliation semantics.

### 2.2 State classes

| State | Authority | Recovery |
| --- | --- | --- |
| Canonical domain state | PostgreSQL journal plus authoritative projections | Replay/snapshot/restore |
| Behavior-affecting cognition | PostgreSQL private semantic events and projections | Replay/snapshot/restore |
| Operational evidence | PostgreSQL run, step, model, tool, approval, dispatch tables | Direct query/retention policy |
| Active actor runtime | Durable Object SQLite and memory | Rehydrate from PostgreSQL; reconcile fibers/connections |
| Large immutable content | R2 with PostgreSQL metadata and content hash | Integrity check, backup/export |
| Search indexes | PostgreSQL FTS/pgvector/materialized projections | Rebuild from canonical evidence |
| Client state | Browser projection and transient UI | Snapshot plus ordered patches |
| Telemetry | Cloudflare/Sentry/PostHog | Operational retention; never canonical |

### 2.3 Product charter

Clockgrove is an open-source persistent artificial-life world and conversational-actor platform. Its reference world, Raccoon World, is a cozy, cartoonish, isometric Seattle neighborhood inhabited by raccoons, delivered in [clockgrove/raccoon-world](https://github.com/clockgrove/raccoon-world). Time, weather, resources, plants, relationships, reproduction, aging and death continue according to world policy whether or not a browser is connected.

The visible game is an emotionally legible proving ground, not the whole thesis:

> A user can observe a persistent world, talk to any meaningful thing, investigate why it behaved as it did, influence it through bounded natural language, and reshape the world through reviewed conversation without surrendering authoritative truth to an LLM.

The experience loop is:

```text
world advances
  → user observes a visible consequence or overnight history
  → user selects a character, object, space or system
  → user talks, investigates, influences or authors
  → the subject answers from a disclosed perspective
  → validated commands produce world consequences
  → the user can ask why and traverse the causal evidence
  → actors form memories, beliefs and relationships
  → those subjective changes affect later behavior
```

The product must feel simultaneously like:

- a perpetual Game-of-Life-style simulation;
- a text adventure wrapped in a visible, spatial world;
- a shared-world observation and intervention experience;
- a serious platform for creating arbitrary persistent actor worlds.

The graphical scene makes state and consequences legible. Conversation exposes subjective perspective. The journal makes causality inspectable and rewindable. Natural-language authoring turns intent into reviewable world changes.

Clockgrove is an independent project. Public code or ideas from any prior project may be reused only after normal license and provenance review. Reuse must be recorded in the repository provenance manifest; private code, data, assets, prompts, credentials, and identity are excluded. V-Worlds and MUD concepts are acknowledged design lineage, not a code dependency.

### 2.4 Falsifiable product theses

Every wave must identify which thesis it tests, the captured evidence and a failure threshold. Shipping infrastructure is not evidence that the thesis works.

| Thesis | Required product evidence | Falsifying signal |
| --- | --- | --- |
| Universal conversation is useful | users voluntarily select and converse with characters, objects and spaces to learn or act | chat is treated as decorative or users cannot tell what an entity can truthfully answer |
| Subjective memory creates legible change | a later decision differs because of a cited episode, belief, relationship or social lesson | retrieval produces prose but no observable behavior change |
| Grounded explanation creates trust | users can follow decision → evidence → perception/memory → source event and judge the answer coherent | explanations invent reasons or routinely disagree with stored decision inputs |
| Conversational authoring is materially easier and safer | an operator compiles, previews, fast-forwards, reviews and promotes a bounded change | raw data editing is faster or preview cannot expose assumptions and effects |
| The abstractions generalize | a tiny non-raccoon pack uses the same object, event, memory, rule, capability and client contracts | kernel or runtime code requires raccoon-specific branches |

### 2.5 Users, authority and interaction modes

The authorization model distinguishes four roles even when one developer holds all of them:

| Role | Product abilities |
| --- | --- |
| Visitor/player | observe authorized state, converse, investigate public evidence and exert bounded influence |
| World operator | control time, author and preview changes, inspect privileged state, manage worlds/timelines and repair problems |
| Developer | extend code/capabilities, inspect raw execution evidence, replay failures and operate infrastructure |
| World-pack author | define archetypes, spaces, seed state, rules, assets and presentation bindings |

The human is an observer/caretaker at GA, not an assumed embodied avatar. Adding embodiment later requires an ADR covering perception, permissions and social consequences.

Every selected entity declares one of these interaction modes:

| Mode | Meaning |
| --- | --- |
| Embodied dialogue | a communicating actor answers in character using its own permitted knowledge |
| Interpreted perspective | the system renders modeled nonverbal state from an object or space's disclosed perspective |
| Operator inspection | an authorized, explicitly labeled view of canonical or derived state |
| Influence | a suggestion, claim, promise, gift or bounded environmental action enters normal validation and agency; success is not guaranteed |
| Authoring | language compiles to a draft changeset; it never bypasses preview, validation, authorization or promotion |

The UI never disguises operator omniscience as actor knowledge, interpreted narration as literal speech, or intended action as completed action.

### 2.6 Required user journeys

The complete product supports these end-to-end journeys through both the visual UI and text-accessible controls:

1. **Observe:** open a running world; see simulated date/time, weather and current activity; review a compact account of material events that happened while away.
2. **Converse:** select any important visible character, object or space; start a new session or resume a prior one; ask about state, history, relationships, plans or reasons within that subject's perspective.
3. **Investigate:** start from “Why did you do that?” and traverse the decision, candidates, utility features, perceptions, beliefs, memories, source events, model/tool steps and consequences permitted to the viewer.
4. **Influence:** suggest, teach, promise, offer or give something; observe whether the target accepts, ignores or rejects the intervention and what follows.
5. **Author:** describe a bounded change; review assumptions and typed operations; render and fast-forward it on an isolated preview timeline; revise, approve or reject it.
6. **Rewind and branch:** select a journal point; inspect state there; create a mutable preview; try a changed rule/object/intervention; promote validated semantic intent rather than synthetic branch history.

### 2.7 Reference world and north-star scenario

The GA reference world is Raccoon World's `green-lake-yard@1` pack. It lives in [clockgrove/raccoon-world](https://github.com/clockgrove/raccoon-world), which owns its content, art, theme, goldens and browser journeys and runs them in its own CI against a pinned Clockgrove commit. Clockgrove proves each platform obligation of the scenario below on `worlds/fixture`: the beacon pack and the neutral reference variant under `worlds/fixture/reference`. Platform code never names the reference world's content.

The reference pack contains:

- hierarchy: Green Lake Neighborhood → Living Yard → Porch, Den, Garden and Cedar Area;
- navigation anchors: `den-mouth`, `porch-step`, `trash-front`, `tree-base`, `garden-edge` and `fence-gap`;
- nearby semantic regions: the yard, a street buffer and a favorite snack-house opportunity;
- actors: Stevie, Gracie, at least one kit and a small household with explicit parent/relationship links;
- objects/systems: den, porch, trash/food sources, cedar and growing plant, water source, shelter, weather, day/night and event feed;
- world behavior: needs, movement, resource depletion/decay, rain/wetness/comfort, growth, learning, reproduction, aging and death.

The canonical north-star test is one causal story:

1. Rain begins and changes resource availability and comfort.
2. Stevie perceives a snack-house or trash opportunity and investigates.
3. Other actors perceive different subsets because of location, senses and attention.
4. A user asks why Stevie went there and receives a grounded, perspective-correct explanation.
5. The experience creates an episode and may update a belief about the place.
6. Stevie later teaches or demonstrates the behavior to a kit.
7. The kit receives attributed testimony/demonstration evidence, not a copied firsthand memory.
8. Consolidation changes accessibility or summaries without fabricating evidence.
9. On a later day, that learning changes a choice.
10. Two clients converge on the same authorized consequences.
11. An injected crash at each durable boundary resumes without losing or duplicating accepted history.
12. A developer can search the full causal chain and fork a preview from a chosen event.

This scenario is the acceptance spine across kernel fixtures, persistence tests, actor/runtime tests, browser tests, memory evals and release qualification. Its world-content run passes in the reference world's repository; its platform obligations pass in Clockgrove on the fixture world.

### 2.8 Scope discipline

Required architectural seams support many worlds, neighborhoods, users, characters, spaces and future quests. The implementation does not prebuild unrelated product surface. The exclusions below are first-product sequencing choices, not extension limits; PRD 4.3 defines the preserved seams and the few permanent safety/authority invariants.

Out of scope unless added through an approved product change:

- photorealism, free-camera 3D or general-purpose physics;
- combat, competitive balance, a full economy/tycoon system or a complex quest campaign;
- continuously thinking LLMs for every object;
- unrestricted generated code in a live world;
- neural reinforcement learning as routine behavior;
- a secondary database, cache or search index as canonical truth;
- a public world-pack marketplace or arbitrary untrusted plugin host.

“MMO” means the architecture can support many authenticated observers and actors across persistent partitioned worlds, with interest-filtered realtime state and sleeping inactive actors. It does not require one undivided map, a global causal order or an avatar/economy at GA.

### 2.9 V-Worlds lineage translated into contracts

The design deliberately extends the event routing, containment and runtime-editing ideas of Microsoft Research's V-Worlds work:

| V-Worlds concept | Contract in this plan |
| --- | --- |
| Thing | `WorldObjectDefinition` plus logical subject facade |
| Exemplar | pinned `ArchetypeManifest` version |
| Dynamic property | registered component or typed instance override |
| Dynamic method | governed capability, behavior or MCP tool |
| Room/container/contents | first-class Space plus containment hierarchy |
| Portal | typed adjacency/traversal edge, potentially physical, social, informational or cognitive |
| Peer/content/container events | audience candidate sets and actor-relative perceptions |
| Bystander algorithm | deterministic audience, visibility, attention and interest resolution |
| Master object/cached proxy | server authority and recoverable client projection |
| Local/volatile property | derived projection or explicitly ephemeral presentation state |
| Property log/serialization | semantic journal, snapshots, versioning and replay |
| Runtime editing | changeset-based natural-language authoring on preview timelines |
| Owner/setuid security | principals, provenance, capability grants and delegated effect identity |

The modern extension is subjective cognition: selective perceptions become evidence-bearing episodes, claims, beliefs, relationships and summaries that can alter decisions while remaining causally inspectable.

---

## 3. Non-negotiable invariants

### 3.1 World truth and LLM boundaries

- The simulation kernel, not a model, decides canonical state transitions.
- Models may generate dialogue, plans, extraction candidates, memories, rules, and changesets.
- Every material action becomes a typed command and passes authentication, authorization, expected-revision, domain validation, budget, and effect policy.
- Generated language is canonical only as speech that occurred. Claims inside speech are not objective facts.
- Exact replay uses recorded nondeterministic outputs. Experimental re-execution creates a marked branch.

### 3.2 Actor identity and placement

- Every meaningful entity has a stable logical address.
- Logical identity does not imply a dedicated process, model, socket, or Durable Object.
- Placement can evolve without changing IDs or client protocols.
- Physical state and cognition have separate owners.
- No single world-global actor sits on the ordinary physical command path.

### 3.3 Determinism

- Kernel code performs no I/O and reads no wall clock, environment variable, provider, database, filesystem, or Cloudflare API.
- Simulation time is an integer branded value.
- Material quantities use integers or fixed-point representations; canonical kernel logic does not depend on floating-point equality.
- Randomness comes only from named, versioned streams whose algorithm and state are persisted.
- Stable input state, command, time, policies, versions, and random state must produce the same events and state hash.

### 3.4 Persistence and history

- PostgreSQL is the sole canonical database.
- Events are semantic and additive; history is never silently rewritten.
- Durable Object SQLite is rebuildable runtime storage.
- External effects are committed as intent and delivered after the canonical transaction.
- At-least-once delivery is accepted only with application-level idempotency.
- Every schema and payload has explicit versioning and deterministic upcasting.

### 3.5 Security and privacy

- Authorization and context scope are resolved before retrieval or actor routing.
- Every tenant-owned row, actor address, artifact, queue envelope, and budget includes tenant scope.
- Private cognition, conversations, credentials, and operator evidence never enter shared scene projections.
- Preview timelines block or simulate external effects by enforced policy.
- Untrusted text, documents, MCP descriptions, and tool results cannot modify system policy.

### 3.6 Realtime

- Clients submit intent and render projections.
- WebSocket messages may duplicate, arrive after reconnect, or be lost.
- Monotonic projection revisions plus snapshot fallback guarantee convergence.
- Render frames, interpolation, particles, cursor movement, and presence heartbeats are not journal events.

### 3.7 Future-proofing without machinery

- Stable IDs, partition keys, ports, logical channels, schemas, migrations, and security boundaries exist from the start.
- Renderer, spatial-index, runtime-placement, model, physics, policy, and storage implementation details never become durable domain identity.
- A deferred capability earns only the smallest contract and conformance fixture needed to prove that the current implementation has not made it impossible.
- The two explicit pressure-test fixtures are a full-3D spatial/presentation contract fixture and a selectively long-running `ActorProcess` fixture. They compile and validate from Wave 0 even though production 3D rendering and dedicated continuous compute are not implemented for any world.
- Additional services, stores, runtime actors, generalized frameworks, and duplicated caches do not exist until they do real work.

### 3.8 Deferred-capability compatibility matrix

| Deferred capability | Preserved seam |
| --- | --- |
| Large MMO-scale shared worlds | Provider-neutral tenancy/personas, opaque placement, routing/authority epochs, interest projections, handoff, moderation/privacy/rate-limit policy |
| Full 3D and photoreal presentation | Versioned 2D/3D `SpatialFrame`, renderer-neutral scene projection, opaque index cells, asset renditions and presentation bindings |
| Economy, combat and quests | Typed domain modules behind the existing command/event/capability/authority/attribution/replay boundary |
| Selectively long-running agents | Durable `ActorProcessId`, objective/cursors/checkpoint/lease/budget state, bounded run segments and optional dedicated-compute placement |
| Generated behavior/code | Reviewed, signed, sandboxed and previewed extension artifacts; untrusted prose never executes or mutates directly |
| General physics and learned policies | Versioned adapter/proposal interfaces whose accepted consequences still pass the physical kernel and journal |
| Specialized graph/storage/runtime providers | Project-owned ports and exportable semantic history; provider IDs and query languages stay private to adapters |
| Durable social presence | Journaled domain records when it becomes product truth; sockets and caches remain reconstructible delivery state |

A future implementation fails this compatibility test if it must reissue actor/object IDs, make renderer/index/provider IDs canonical, bypass the journal or authorization model, or reinterpret old semantic events.

---

## 4. Logical model and runtime placement

### 4.1 Canonical actor address

All logical actors use:

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
  | { kind: "process"; id: ActorProcessId }
  | { kind: "session"; id: SessionId }
  | { kind: "presence"; id: PresenceId }
);
```

`subject` covers characters, spaces viewed conversationally, passive objects with an interpreted voice, and future autonomous entity types. `process` addresses a durable actor responsibility independently of the runtime currently executing its bounded segments. `session` and `presence` are independently addressable even when routed inside another physical actor.

Every subject implements the same application facade regardless of placement:

```ts
interface SubjectFacade {
  inspect(query: Authorized<InspectSubject>): Promise<SubjectInspection>;
  describe(query: Authorized<DescribeSubject>): Promise<SubjectDescription>;
  listCapabilities(query: Authorized<ListCapabilities>): Promise<CapabilityView[]>;
  receiveMessage(command: Authorized<ReceiveMessage>): Promise<MessageReceipt>;
  submitIntent(command: Authorized<SubmitSubjectIntent>): Promise<IntentResult>;
}
```

Durable Object names are derived from a versioned SHA-256 hash of opaque canonical IDs. Display names, email addresses, document titles, and other PII never enter object names. The routing function is pure and has golden vectors.

### 4.2 Physical Durable Object classes

#### WorldDO

Identity: one per `(tenant, world, timeline)`.

Owns:

- world lifecycle and clock policy;
- running, paused, maintenance, and catch-up policy;
- spatial partition directory and routing epoch;
- global rule/configuration activation;
- branch barriers and snapshot-head vectors;
- cross-space transfer coordination;
- operator world-control channel.

Does not own:

- ordinary movement/resource/object commands;
- character cognition;
- conversation history;
- global per-frame or per-object ticking.

#### SpaceDO

Identity: one per `(tenant, world, timeline, space)`.

Owns:

- physical command serialization;
- authoritative active projection at a known PostgreSQL partition revision;
- containment, location, inventory, resources, weather, navigation and geofences;
- deterministic scheduled-work draining;
- scene WebSockets, visibility, interest filtering and projection fanout;
- passive object inspection and actor facade;
- ephemeral presence for connected viewers;
- participation in cross-space transfers.

The first neighborhood can occupy one `SpaceDO`, but every object and command still carries `space_id`.

#### ActorAgentDO

Identity: one per `(tenant, world, timeline, subject)`.

Owns:

- cognitive or interpreted subject policy;
- multiple conversation sessions;
- chat WebSockets and streaming state;
- ordinary recoverable turn fibers;
- perception intake and working cognitive cache;
- context assembly and model/tool orchestration;
- MCP connection reconciliation;
- cognition budget and durable-job status.

It never owns canonical physical position, inventory, resources, or world mutation.

### 4.3 Logical placement table

Logical world identity is never a synonym for a live server process. Placement is explicit:

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

`runtimeCellId` is an opaque, movable logical execution placement. It never embeds a quadtree/octree code in a public domain identifier. `runtimeInstanceId` identifies one disposable process/DO incarnation. `routingEpoch` invalidates stale routes, while `authorityEpoch` fences stale writers. PostgreSQL stores the canonical placement and epochs; replacement, migration, eviction, repartition, or spatial-index migration must not change durable world, timeline, space, actor, presence, or object identity.

| Logical kind | Current physical owner | Promotion seam |
| --- | --- | --- |
| World | WorldDO | Fixed |
| Space | SpaceDO | Fixed |
| Cognitive character | ActorAgentDO for cognition; SpaceDO for body | Fixed split |
| Durable actor process | Bounded ActorAgentDO fiber and/or typed Workflow | Dedicated process owner, worker pool or continuously eligible placement if measured need justifies it |
| Passive object | SpaceDO; ActorAgentDO created on demand for conversation | Dedicated autonomous subject later |
| Conversation session | Channel inside ActorAgentDO | Dedicated SessionDO if measured hot-session isolation is needed |
| Presence | Connection metadata inside SpaceDO | Dedicated PresenceDO if cross-space social presence requires it |

### 4.4 Concurrency rules

Durable Objects are single-threaded, but external I/O can allow request interleaving. Every owner therefore has an explicit application mailbox:

- `WorldDO`: one world-control mutation lane;
- `SpaceDO`: one physical mutation lane per object partition, implemented initially as one FIFO lane;
- `ActorAgentDO`: ordered turns per session, concurrent fibers across sessions, and one optimistic cognition-commit lane.

`blockConcurrencyWhile()` is used only for bounded initialization and runtime schema migration. It is not held across PostgreSQL, model, MCP, R2, or other network calls.

PostgreSQL expected revisions remain the final concurrency defense. A stale command receives a typed conflict; it is never silently applied to a newer state.

### 4.5 Hot-owner evolution

For a hot SpaceDO:

1. batch compatible client messages and simulation work;
2. eliminate unnecessary commands and transient events;
3. keep model/retrieval/indexing work off the mutation lane;
4. shorten PostgreSQL transactions;
5. split projection fanout if it dominates;
6. partition along stable spatial boundaries;
7. use the existing transfer protocol.

For a hot ActorAgentDO:

1. cap active sessions and background fibers;
2. use per-session turn ordering and optimistic cognition commits;
3. separate expensive durable jobs into Workflows;
4. promote selected session placement behind the logical session route if needed.
5. promote an eligible durable `ActorProcess` to dedicated compute or a process owner without changing actor identity, journal authority, event cursors, or checkpoint semantics.

No scale response changes canonical actor IDs.

---

## 5. Repository and package architecture

### 5.1 Repository

```text
/
├── apps/
│   ├── runtime/                 Cloudflare Worker, DOs, Workflows, Queues
│   ├── web/                     world-agnostic React + Three.js shell; each world themes it
│   └── cli/                     replay, inspect, seed, export, verify
├── packages/
│   ├── contracts/               branded IDs, Zod schemas, wire protocols
│   ├── domain/                  entities, components, policies, semantic types
│   ├── kernel/                  pure simulation, rules, spatial algorithms
│   ├── application/             use cases and provider/runtime ports
│   ├── persistence/             PostgreSQL, journal, projections, R2 adapters
│   ├── cognition/               sessions, agent loop, context, memory, MCP policy
│   ├── authoring/               changesets, preview, diff, promotion
│   ├── observability/           structured logs, trace/evidence helpers
│   ├── world-pack-sdk/          pack schema, validation, migration contract
│   └── testkit/                 fixtures, fakes, fault and replay harnesses
├── worlds/
│   └── fixture/                 Clockgrove's own test worlds: the beacon pack and
│                                the neutral reference variant (reference/)
├── assets/
│   └── brand/                   Clockgrove's own brand art; world art lives with each world
├── db/
│   ├── migrations/
│   ├── seeds/
│   ├── policies/
│   └── verification/
├── infra/
│   ├── opentofu/
│   ├── wrangler/
│   ├── environments/
│   └── dashboards/
├── tests/
│   ├── contract/
│   ├── cloud/
│   ├── e2e/
│   ├── load/
│   └── recovery/
├── docs/
│   ├── adr/
│   ├── protocols/
│   ├── runbooks/
│   └── world-packs/
└── tools/
    ├── assets/
    ├── fixtures/
    └── release/
```

World packs other than the fixture live in their own repositories, such as [clockgrove/raccoon-world](https://github.com/clockgrove/raccoon-world). They consume Clockgrove from a pinned commit, run Clockgrove's world-pack check in their own CI and keep their art, theme and goldens there.

Use pnpm workspaces and Turborepo for a reproducible task graph. Package versions are private and synchronized until an independently consumable SDK is published. The lockfile is authoritative; Renovate proposes dependency updates through the full validation suite.

### 5.2 Dependency direction

```text
contracts
   ▲
domain
   ▲
kernel
   ▲
application ◄──────── cognition ◄──────── authoring
   ▲                       ▲
persistence                │
   ▲                       │
apps/runtime ──────────────┘

apps/web ─────────► contracts
world packs ──────► world-pack-sdk + domain contracts
testkit may depend on all packages but production packages never depend on testkit
```

Rules:

- `contracts` imports only Zod and tiny serialization/hash utilities.
- `domain` and `kernel` contain no Cloudflare, SQL, model, browser, telemetry, or environment imports.
- `application` defines ports; adapter packages implement them.
- `apps/runtime` is the composition root. Provider SDKs do not leak inward.
- `apps/web` never imports persistence, application internals, Durable Object code, or world-pack implementation code.
- Platform code imports no world except `worlds/fixture`, and names no world's content. The world-boundary check in `pnpm check` fails the build otherwise.
- dependency direction is enforced with ESLint/import rules and dependency-cruiser in CI.

### 5.3 Core ports

```ts
interface Journal {
  execute(command: AuthorizedCommand): Promise<CommittedCommand>;
  readStream(ref: StreamRef, range?: SequenceRange): Promise<DomainEvent[]>;
  loadAggregate<T>(ref: AggregateRef<T>): Promise<Versioned<T>>;
}

interface ActorRouter {
  resolve(address: ActorAddress): Promise<ActorRoute>;
  send<C extends ActorCommand>(address: ActorAddress, command: C): Promise<ActorReply<C>>;
}

interface ArtifactStore {
  put(input: ArtifactInput): Promise<ArtifactRef>;
  get(ref: ArtifactRef, access: AccessContext): Promise<ReadableStream>;
}

interface SpatialIndexPort {
  query(frame: SpatialFrameRef, region: SpatialQuery): Promise<SpatialCandidate[]>;
  summarize(cell: SpatialIndexCellRef): Promise<SpatialCellSummary>;
  rebuild(input: SpatialIndexRebuild): Promise<SpatialIndexEpochRef>;
}

interface ModelGateway {
  stream(request: ModelRequest): Promise<ModelStream>;
  generateObject<T>(request: StructuredModelRequest<T>): Promise<ModelResult<T>>;
  embed(request: EmbeddingRequest): Promise<EmbeddingResult>;
}

interface CapabilityExecutor {
  discover(binding: CapabilityBindingRef): Promise<CapabilitySchema[]>;
  execute(call: AuthorizedCapabilityCall): Promise<CapabilityResult>;
}

interface EvidenceRecorder {
  startRun(input: RunStart): Promise<RunRef>;
  recordStep(input: StepEvidence): Promise<void>;
  finishRun(input: RunFinish): Promise<void>;
}
```

`SpatialIndexPort` begins with the loose-quadtree adapter. Returned cell references are opaque and epoch-scoped. A future 3D adapter can use an octree, BVH, scene graph, or 3D navmesh without changing world/object IDs or spatial event schemas.

Ports exist because they protect domain semantics or testing, not to imply support for multiple production platforms. Begin with one production adapter and one deterministic fake.

### 5.4 Coding conventions

- strict TypeScript with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and no implicit any;
- ESM only;
- Zod at trust and serialization boundaries; ordinary TypeScript types internally;
- exhaustive tagged unions and `assertNever`;
- no untyped JSON crossing package boundaries;
- no `Date.now()`, `Math.random()`, or floating random IDs inside kernel code;
- no catch-and-log without a typed disposition;
- errors use stable codes and carry correlation identity;
- structured logs only; secrets and private payloads are denied by default;
- exported APIs have TSDoc and package-level README examples;
- architectural decisions live in ADRs, not only comments.

### 5.5 Dependency baseline

| Concern | Selection |
| --- | --- |
| Runtime language | TypeScript, ESM, strictest practical compiler settings |
| Local/CI toolchain | Node.js 24 LTS and pnpm pinned by `packageManager`/toolchain file |
| Worker tooling | Wrangler 4.82.1+ baseline and Cloudflare Vite/Vitest integrations |
| HTTP | Hono |
| Validation/contracts | Zod and generated JSON Schema/OpenAPI |
| SQL | Drizzle ORM plus postgres.js/raw reviewed SQL |
| Canonical database | PostgreSQL with pgvector |
| IDs | `uuid` with UUIDv7 for external IDs and UUIDv5/derived IDs for deterministic execution |
| Deterministic randomness | pinned `pure-rand` algorithm behind NamedRandomState |
| Human auth | Better Auth reference adapter; optional Clerk adapter |
| Agent runtime | Cloudflare `agents` 0.20.0+ baseline, exact version pinned |
| Models | Vercel `ai` plus `ai-gateway-provider` |
| Rendering | React and Three.js WebGPURenderer; see the accepted [renderer ADR](adr/clockgrove-adr-renderer-bake-off.md) |
| Web state | React Router, TanStack Query and Zustand |
| Testing | Vitest, fast-check, Cloudflare test pool, Playwright and k6 |
| Infrastructure | OpenTofu, Wrangler and GitHub Actions |

Pin exact versions in the root lockfile and release manifest. New foundational dependencies require a maintenance, license, browser/runtime compatibility, bundle-size and security review. Prefer small focused libraries over frameworks that duplicate platform responsibilities.

Bootstrap Workers with compatibility date `2026-08-13` and `nodejs_compat`. Compatibility-date or major runtime upgrades are release-manifest changes and must pass cloud qualification before promotion.

---

## 6. IDs, execution context, and protocol envelopes

### 6.1 ID policy

All IDs are branded opaque strings. Externally initiated IDs use UUIDv7. IDs created during deterministic execution come from an injected deterministic `IdSource` derived from the command ID, event index, and named random stream.

Required IDs include tenant, principal, workspace membership, world membership, world persona, authority decision, action, world, timeline, partition, spatial frame, spatial-index epoch/cell, runtime cell, space, object, subject, actor process, session, turn, run, step, command, event, stream, schedule, rule, rule firing, decision trace, perception, episode, belief, claim, evidence, capability, installation, binding, tool call, model call, artifact, changeset, transfer, correlation, and causation.

IDs are never overloaded. A run ID is not a trace ID; an authentication-provider subject is not a principal ID.

### 6.2 Execution context

```ts
interface ExecutionContext {
  version: 1;
  tenantId: TenantId;
  principalId: PrincipalId;
  externalIdentity?: { provider: string; subject: string };
  workspaceMembershipId?: WorkspaceMembershipId;
  worldMembershipId?: WorldMembershipId;
  personaId?: WorldPersonaId;
  worldId?: WorldId;
  timelineId?: TimelineId;
  spaceId?: SpaceId;
  sessionId?: SessionId;
  subjectId?: SubjectId;
  roles: RoleId[];
  grants: GrantRef[];
  privacyCeiling: PrivacyCeiling;
  correlationId: CorrelationId;
  causationId?: CausationId;
  requestId: string;
  codeVersion: string;
  protocolVersion: number;
}
```

The Worker creates this object after authentication-provider verification and PostgreSQL authorization. Clients, models, tools, Queue messages, and MCP servers cannot supply or broaden it.

### 6.3 Command envelope

```ts
interface CommandEnvelope<TType extends string, TPayload> {
  schemaVersion: number;
  commandId: CommandId;
  type: TType;
  target: ActorAddress;
  expected: {
    streamSequence?: bigint;
    partitionRevision?: bigint;
    routingEpoch?: number;
  };
  simulationTime?: SimTimeMs;
  issuedAt: string;
  context: ExecutionContextRef;
  payload: TPayload;
}
```

Every mutation has a caller-supplied or gateway-issued command ID. Retries with the same ID return the stored result. Reuse with different bytes is a security/invariant error.

Each mutating command also carries an immutable attribution intent created by the trusted gateway or internal dispatcher. The authoritative validator seals it with an authority decision before any event is committed:

```ts
interface AttributionIntent {
  principalId?: PrincipalId;
  worldMembershipId?: WorldMembershipId;
  personaId?: WorldPersonaId;
  initiatorId?: string;
  effectiveActorId: string;
  causalRootActionId: ActionId;
  immediateCauseId?: string;
  sessionId?: SessionId;
}

interface AttributionEnvelope extends AttributionIntent {
  authorityDecisionId: AuthorityDecisionId;
}
```

Human, actor, rule, scheduler, workflow, and tool initiators all use the same intent/envelope pair. Absence of a human principal is valid for autonomous world actions; absence of an effective actor or recorded allow/deny decision is not valid for a completed action.

### 6.4 Event envelope

```ts
interface EventEnvelope<TType extends string, TPayload> {
  schemaVersion: number;
  eventId: EventId;
  type: TType;
  tenantId: TenantId;
  worldId: WorldId;
  timelineId: TimelineId;
  partitionId: PartitionId;
  streamId: StreamId;
  streamSequence: bigint;
  partitionSequence: bigint;
  journalPosition: bigint;
  simulationTime: SimTimeMs;
  recordedAt: string;
  commandId: CommandId;
  correlationId: CorrelationId;
  causationId?: CausationId;
  attribution: AttributionEnvelope;
  actor?: ActorAddress;
  principalId?: PrincipalId;
  decisionTraceId?: DecisionTraceId;
  ruleFiringId?: RuleFiringId;
  policyVersions: PolicyVersionSet;
  privacyClass: PrivacyClass;
  payloadHash: string;
  payload: TPayload;
}
```

Ordering guarantees:

- `streamSequence` orders one aggregate stream;
- `partitionSequence` orders one physical consistency partition;
- `journalPosition` is database ingestion order, useful for search and dispatch but not a global causal claim;
- `simulationTime` plus deterministic tie-break key orders scheduled simulation work;
- cross-partition causality uses explicit IDs and transfer/saga state.

A branch snapshot records a partition-head vector rather than requiring one global world sequence.

### 6.5 Queue envelope

```ts
interface QueueEnvelope<T> {
  schemaVersion: number;
  messageId: string;
  channel: "world-reactions" | "cognitive-indexing" | "external-effects";
  tenantId: TenantId;
  worldId?: WorldId;
  timelineId?: TimelineId;
  sourceEventId?: EventId;
  effectId?: EffectId;
  correlationId: CorrelationId;
  causationId?: CausationId;
  attemptHint: number;
  availableAt?: string;
  payload: T;
}
```

Consumers deduplicate by semantic action ID, not by delivery attempt.

### 6.6 Versioning

- additive optional fields may remain within a schema version when old consumers preserve meaning;
- semantic or required-field changes create a new version;
- event upcasters are pure and deterministic;
- command/API consumers support the current and one prior compatible version unless an ADR extends the window;
- world packs pin compatible engine, schema, rules, prompt/policy, and asset versions;
- golden fixtures contain every historic event version still supported.

### 6.7 Initial command and semantic-event catalog

Commands are registered by stable type, schema version, owning authority, required grants, expected-revision policy and handler. World packs add a command only through a reviewed versioned extension point.

| Family | Representative commands |
| --- | --- |
| Movement | `StartMovement`, `InterruptMovement`, `EnterPortal` |
| Needs/resources | `ConsumeResource`, `Rest`, `Drink`, `OfferResource` |
| Object interaction | `OpenObject`, `CloseObject`, `UseObject`, `TransferObject` |
| Social | `Say`, `Ask`, `Tell`, `Warn`, `Teach`, `Demonstrate`, `Invite`, `Lead`, `Promise` |
| Observation | `FocusAttention`, `InspectObject`, `RecordPerception` |
| Cognition | `FormEpisode`, `UpdateBelief`, `UpdateRelationship`, `ConsolidateMemory` |
| Environment | `ChangeWeather`, `AdvanceGrowth`, `ChangeResourceAvailability` |
| Scheduling | `ScheduleWakeup`, `CancelWakeup`, `ChangeClockPolicy` |
| Capability | `InstallCapability`, `BindCapability`, `InvokeCapability`, `DisableCapability` |
| Conversation | `CreateSession`, `SubmitTurn`, `CancelTurn`, `ArchiveSession` |
| Authoring | `CreateObject`, `UpdateComponents`, `MoveObject`, `LinkObjects`, `RetireObject` |
| Rules | `CreateRuleVersion`, `ActivateRule`, `DisableRule`, `BackfillRule` |
| Timeline | `CreatePreview`, `PauseTimeline`, `ResumeTimeline`, `PromoteChangeSet`, `ArchiveTimeline` |

Events express domain meaning rather than generic property diffs. The initial semantic vocabulary includes:

- lifecycle/environment: `ActorBorn`, `ActorDied`, `LifecycleStageChanged`, `WeatherChanged`, `GrowthStageChanged`;
- movement/spatial: `MovementStarted`, `MovementInterrupted`, `MovementCompleted`, `ActorEnteredRegion`, `ActorExitedRegion`;
- object/resource: `ObjectOpened`, `ObjectClosed`, `ResourceOffered`, `FoodConsumed`, `ResourceDepleted`, `ResourceSpoiled`;
- social/conversation: `ActorSpoke`, `ActorDemonstrated`, `PromiseMade`, `ConversationCompleted`;
- cognition: `PerceptionReceived`, `EpisodeFormed`, `BeliefFormed`, `BeliefReinforced`, `BeliefWeakened`, `BeliefContradicted`, `RelationshipUpdated`, `SummaryConsolidated`;
- context/capabilities: `ContextIngestionRequested`, `ContextDocumentReady`, `CapabilityInstalled`, `CapabilityBound`, `CapabilityDisabled`;
- rules/authoring/timelines: `RuleActivated`, `RuleFired`, `WorldChangeApplied`, `PreviewCreated`, `TimelineArchived`.

Each event type documents whether it is public or private canonical, its stream/partition owner, audience eligibility, synchronous projections, dispatch channels and upcasters. Projection diffs can be emitted to clients but never substitute for semantic journal history.

---

## 7. Deterministic world kernel

### 7.1 Kernel contract

The kernel is a pure, versioned state-transition system. It owns world semantics; it does not own persistence, actors, sockets, wall-clock scheduling, models or presentation.

```ts
interface KernelInput<C extends DomainCommand | ScheduledInput> {
  state: WorldPartitionState;
  input: C;
  simulationTime: SimTimeMs;
  versions: KernelVersionSet;
  random: NamedRandomState;
  idSource: DeterministicIdSource;
}

interface KernelResult {
  events: NewDomainEvent[];
  scheduleMutations: ScheduleMutation[];
  projectionDelta: PhysicalProjectionDelta;
  decisions: DecisionTraceDraft[];
  random: NamedRandomState;
}

function executeKernel(input: KernelInput): Result<KernelResult, DomainError>;
```

The kernel returns descriptions of work; it performs none. Reducers apply emitted events to produce the next authoritative projection. Command handlers do not mutate input state. A command can be accepted with zero events only when the contract defines an idempotent no-op; otherwise it is rejected with a typed domain reason.

### 7.2 World-model contract

“Everything is an actor” is an interface rule, not a process-allocation rule. Every meaningful thing has stable identity, addressability, versioned state, capabilities and message semantics. It does not imply a resident Durable Object, mailbox, LLM, socket or database connection.

Use typed component composition, not an ECS runtime framework or a closed inheritance hierarchy:

```ts
interface WorldObjectDefinition {
  id: WorldObjectId;
  worldId: WorldId;
  archetype: { id: ArchetypeId; version: number };
  traits: VersionedTraitRef[];
  overrides: TypedComponentPatch[];
  owner?: PrincipalId;
  capabilities: CapabilityBinding[];
}

interface TimelineObjectState {
  worldId: WorldId;
  timelineId: TimelineId;
  objectId: WorldObjectId;
  spaceId: SpaceId;
  containerId?: WorldObjectId;
  components: ComponentMap;
  lifecycleStatus: "active" | "dormant" | "retired" | "dead";
  revision: bigint;
}
```

The effective object is:

> pinned archetype version + pinned reusable trait versions + validated instance overrides + timeline-relative component state

Logical identity is stable across inherited branch state. Objects created only on a branch receive new globally unique IDs and do not exist on siblings unless an authored creation intent is separately promoted. Replay never silently reinterprets an object through a newer archetype or trait.

The reference world uses two broad behavior profiles—mobile social creature and stationary environmental object—but these are archetype compositions, not kernel subclasses. Spaces and systems are also world objects with specialized components.

### 7.3 Registered component catalog

The engine registry owns a Zod schema, version, reducer handlers, redaction policy, snapshot codec and optional presentation adapter for each component. World packs can define additional data components, but kernel code acts only on registered schemas. Runtime writes use typed component operations; arbitrary JSON Patch is forbidden on canonical state.

| Component | Canonical responsibility |
| --- | --- |
| Identity | stable ID, display name, aliases and ownership |
| Archetype | pinned archetype and trait versions |
| SpatialTransform | local fixed-point position, orientation, footprint, elevation and space |
| Containment | container, ordered/unordered contents, capacity and policy |
| Portal | adjacency edge, traversal requirements and target |
| Presentation | asset binding, layer, animation mapping and interaction bounds |
| Lifecycle | creation/birth, age, stage, health, retirement/death and remains policy |
| Needs | hunger, thirst, rest, safety, social connection and curiosity |
| Mobility | speed, route policy, current deterministic movement segment |
| Perception | senses, range, attention, visibility/occlusion profile |
| Personality | traits, preferences, aversions and communication style |
| Social | canonical family/household links and subjective relationship references |
| Cognition | goals, actor-policy link, beliefs and current decision state |
| Memory | episode/summary references and retrieval/consolidation policy |
| Conversation | embodied/interpreted mode and session capability |
| Resource | food/water quantity, quality, availability, spoilage and ownership |
| Growth | stage, rate, requirements and next material threshold |
| WeatherExposure | shelter, wetness, temperature and comfort effects |
| Schedule | simulation-time wakeups, routines and supersession keys |
| CapabilityBindings | governed internal tools, MCP providers, grants and versions |

Component invariants include:

- an active object belongs to exactly one physical space and at most one immediate container;
- containment is acyclic and capacity-conserving;
- inventory/resource quantities cannot become negative;
- a dead or retired actor cannot begin ordinary autonomous work;
- a movement segment has one owning space and a valid traversable route;
- relationship, parentage, evidence and memory references never point across tenant/world/timeline scope accidentally;
- component versions are explicit in snapshots and events.

### 7.4 Time, units and random streams

- `SimTimeMs` is signed 64-bit integer milliseconds represented as bigint internally and decimal text across JSON boundaries.
- durations and rates use branded integer/fixed-point types.
- canonical geometry uses integer world units or documented fixed-point scale.
- named random streams include `weather`, `lifecycle`, `behavior`, `rules`, and `world-pack-defined` streams.
- the PRNG library and algorithm are pinned; the manifest records algorithm/version and serialized state.
- adding a random draw to one subsystem cannot perturb another named stream.
- state hashes use canonical key-sorted serialization, normalized branded integers and SHA-256; maps/sets serialize through explicit ordered forms.

Each timeline has a deterministic simulation scheduler. A scheduled item contains:

```ts
interface ScheduledItem<T = unknown> {
  id: ScheduleId;
  tenantId: TenantId;
  worldId: WorldId;
  timelineId: TimelineId;
  ownerPartitionId: PartitionId;
  dueAt: SimTimeMs;
  priority: number;
  tieBreakKey: string;
  kind: string;
  payloadVersion: number;
  payload: T;
  idempotencyKey: string;
  catchUpClass: "exact" | "aggregate" | "skippable" | "externallyBlocked";
  supersedes?: ScheduleId;
}
```

Ordering is ascending by `dueAt`, then explicit priority, then canonical `tieBreakKey`. UUID creation order, row order and JavaScript object iteration never decide a tie.

### 7.5 Scheduling and offline progression

Scheduled inputs are canonical rows with stable ID, owner partition, due simulation time, deterministic tie-break, versioned payload, catch-up class, and idempotency key.

Catch-up classes:

- `exact`: every occurrence must execute;
- `aggregate`: elapsed duration is integrated and material thresholds emitted;
- `skippable`: cosmetic/nonmaterial occurrence may be summarized;
- `externallyBlocked`: cannot progress without a recorded external result/approval.

Examples:

- gestation schedules birth directly;
- hunger integrates elapsed time and schedules its next decision threshold;
- a tree aggregates growth and emits only stage changes;
- movement records a segment and material boundary crossings, not frame positions;
- weather advances through deterministic transitions and meaningful thresholds.

Continuous systems expose a deterministic integration function and a “next material threshold” function. Advancing one hour in sixty one-minute steps and one aggregated hour must end at the same material state and semantic threshold sequence under the same versioned policy. When exact equivalence is intentionally relaxed, the policy defines the permitted equivalence class and records the aggregation method.

### 7.6 Spatial, containment and navigation model

Five related graphs must remain distinct:

1. **Containment hierarchy:** World → neighborhood → yard/space → porch/den/garden/cedar area → object contents. It governs context inheritance and containment, not every travel route.
2. **Physical authority partition:** maps an object's current state to one SpaceDO. It can change without changing logical identity.
3. **Portal/adjacency graph:** defines traversable edges and requirements between anchors or spaces.
4. **Geometric regions:** circles, rectangles or polygons used for geofences, proximity, perception and presentation.
5. **Context/semantic hierarchy:** scopes actor, relationship, room/space, world and installed knowledge; it may reference physical containment but is not reducible to coordinates.

The server uses:

- spaces and nested containment;
- versioned `SpatialFrame` records declaring two or three dimensions, fixed-point units, axes, origin, optional parent transform, and gravity convention;
- stable navigation anchors/graph;
- polygonal regions/geofences in 2D or volumetric regions in 3D;
- integer/fixed-point poses in a declared semantic frame;
- explicit footprints and elevation layers;
- deterministic A* tie-breaking;
- movement segments with origin, destination, route, start time, speed, and crossing times.

The browser interpolates movement. Physics engines never define canonical simulation.

The starter pack uses anchors `den-mouth`, `porch-step`, `trash-front`, `tree-base`, `garden-edge` and `fence-gap`. A deterministic A* implementation orders equal-cost candidates by stable anchor ID. A later 2D or 3D navmesh can implement the same route contract without changing commands or journal semantics.

A `SpatialRegion` uses canonical local coordinates plus a versioned shape. Movement deterministically emits `ActorEnteredRegion` and `ActorExitedRegion`. “Remain in region for ten minutes” schedules one keyed item on entry and cancels/supersedes it on exit; it never polls every actor.

Large 2D/isometric spaces use a loose quadtree behind `SpatialIndexPort` as an interest, scheduling, and placement index. Its cell reference is `(indexKind, indexVersion, indexEpoch, level, mortonCode)`, stable only inside the index epoch. Leaf summaries record bounded counts, spatial bounds, earliest due work, visibility/fanout signals, and projection cursors; they remain reconstructible from canonical projections. Cells are classified `hot`, `warm`, or `dormant` using versioned thresholds.

The initial runtime keeps one authority owner for a small space. A hot leaf is promoted to a runtime cell or additional `SpaceDO` owner only after measurements show owner CPU, storage, scheduling, or fanout pressure. Promotion changes routing placement, not logical identity or canonical event ownership. Broad weather or neighborhood events advance through scoped cursors and cell summaries instead of per-actor fanout. No quadtree code appears in durable domain IDs. A future 3D index is rebuilt under a new index epoch and routed with the existing fencing contracts; it does not reinterpret world history.

### 7.7 Perception and audience resolution

Canonical truth, actor perception and client visibility are separate outputs.

```ts
interface Perception {
  id: PerceptionId;
  tenantId: TenantId;
  worldId: WorldId;
  timelineId: TimelineId;
  observerId: WorldObjectId;
  sourceEventId: EventId;
  sourcePartitionRevision: bigint;
  observerRevision: bigint;
  resolverVersion: string;
  perceivedAt: SimTimeMs;
  modality:
    | "sight" | "sound" | "smell" | "touch"
    | "social" | "system" | "interpreted";
  entities: EntityRef[];
  observation: StructuredObservation;
  certainty: Fixed01;
  attention: Fixed01;
  locationId?: WorldObjectId;
  access: AccessPolicy;
}
```

For each committed perceivable event, the deterministic resolver considers:

- direct target and initiator;
- containing space and its contents;
- nearby peers;
- ancestor spaces;
- explicit subscribers;
- connected client interest sets.

It then applies location, sensory range/modality, occlusion, attention, access policy and privacy. One event may yield different private perceptions or no perception for different actors. Optional model extraction can enrich already-authorized structured observations but cannot invent sensory access or retroactively grant knowledge.

Actor perceptions are private canonical cognitive inputs because they can change beliefs and behavior. Client projections are authorized derived views. Connected viewers do not automatically become perceiving world actors.

### 7.8 Environment, needs and lifecycle systems

The `green-lake-yard@1` pack implements these interacting systems:

| System | Required state and transitions | Material semantic events |
| --- | --- | --- |
| Day/night | local phase, light band and next boundary | dawn/dusk/day-band changes |
| Weather | state, temperature/comfort band, rain intensity and deterministic transition state | weather began/changed/ended |
| Moisture | rainfall, shelter exposure, wetness accumulation and drying | became wet/dry, comfort threshold |
| Food | source quantity/quality, appearance, consumption, ownership and decay | appeared, depleted, spoiled, consumed |
| Water | quantity/availability and drinking | available/unavailable, depleted, consumed |
| Growth | stage, accumulated growth, requirements and next threshold | sprouted/stage changed/matured/died |
| Needs | hunger, thirst, rest, safety, social and curiosity with next decision threshold | critical threshold or behavior-relevant change |
| Health/comfort | bounded state derived from needs, exposure and events | injured/recovered/critical |
| Reproduction | eligibility policy, parent links, gestation and birth schedule | conceived/gestation milestone/born |
| Aging | birth time, stage thresholds and policy | newborn/juvenile/adult/elder |
| Death | terminal transition, remains/retirement, stopped ordinary activation and social/knowledge consequences | died, session archived/restricted, successor rule intent |

Seasonal hooks are part of policy/versioning even if the starter content uses only one fully authored season. Reproduction can be rule-based; it is not a genetic simulator. Parentage and household links are explicit so social and generational learning can be evaluated.

Continuous numeric changes stay in authoritative projections and snapshots. The journal receives threshold and lifecycle meaning, not a per-tick flood.

### 7.9 Actor activation and sleeping-world contract

Spatial execution uses an activity-driven fidelity model inspired by proven multiplayer simulation-distance patterns, but it is not a fixed tick loop:

| Cell fidelity | Contract |
| --- | --- |
| Hot | Connected presence or material interaction; realtime projection and full relevant deterministic systems are active |
| Warm | No active viewer but near-term schedules, transfers, or material consequences require bounded sparse advancement |
| Dormant | No resident runtime required; journal, snapshots, schedules, and policy remain sufficient until wake |

Fidelity changes are policy decisions with evidence. Reactivation verifies placement/authority epochs, rehydrates canonical state, performs bounded exact or aggregate catch-up, and only then admits new commands. A hot spatial cell does not automatically wake every cognitive actor inside it. Spatial activity and cognitive activation remain independently budgeted.

A logical actor activates only for bounded work:

- direct message or validated command;
- a committed event resolved into one of its perceptions;
- simulation timer or scheduled wake;
- conversation snapshot/turn;
- rule or capability invocation;
- explicit authorized inspection;
- recovery/reconciliation of incomplete durable work.

Activation creates an `ActivationEnvelope` with cause ID, subject, timeline, input revision, priority, budget and deadline. It drains a bounded mailbox, persists effects/evidence, schedules future work if needed, and becomes idle. No actor polls time, a space or the database to feel alive.

Dormant actors remain correct because schedules, objective state and committed perceptions are durable. A provider outage degrades conversation or LLM escalation but never stops clocks, needs, weather, resources, lifecycle or deterministic routine decisions.

### 7.10 Canonical simulation execution order

Every partition advancement uses this order. Changing it is a kernel-version change with replay migration:

1. establish requested target simulation time and validate clock policy;
2. drain due scheduled inputs through target time in canonical order;
3. advance environment transitions to the next due/material boundary;
4. integrate continuous resource, growth, need, health and exposure functions;
5. emit material thresholds and schedule/cancel their next deadlines;
6. advance deterministic movement segments and emit material region/portal crossings;
7. evaluate due reflex/routine utility choices against the input projection; an LLM-dependent choice emits a durable planning request rather than blocking the kernel;
8. return semantic events, schedule mutations, physical projection delta, decision drafts and random state;
9. atomically append those events and synchronous projections/schedules plus compact post-commit dispatch rows;
10. after commit, resolve each perceivable event's audience against its recorded source revision and idempotently append private actor perceptions; independently derive authorized client patches;
11. enqueue bounded activations caused by committed perceptions, direct inputs, rules or routines;
12. convert activation decisions or model plans into new typed commands and validate them against the newest expected revision;
13. repeat through the owning mailbox while due work remains and the activation budget permits; otherwise persist the cursor and resume durably.

Inputs caused during a step do not recursively mutate state inside the same handler. They receive deterministic causal IDs and return through the command/schedule path. This prevents hidden recursion and rule/activation storms.

The originating physical transaction and later private-perception transactions are deliberately separate. `event_dispatches` makes the post-commit phase durable; deterministic perception IDs/idempotency prevent duplicate cognitive history. A perception that is required as an invariant of the same command must be modeled as same-partition semantic state explicitly, not smuggled through an asynchronous assumption.

Cross-partition work never assumes a global event order. A transfer or global rule uses its explicit protocol, causal references and partition revisions.

### 7.11 Routine decisions and LLM escalation

Routine choice order:

1. hard invariants and reflexes;
2. transparent utility scoring;
3. LLM escalation only for ambiguity, novel planning, meaningful social behavior, visible dialogue, tools, or reflection.

Utility candidates are bounded actions supplied by components and capabilities. A typical food choice may use:

```text
utility = expectedFood
        - perceivedDanger
        - travelCost
        + socialComfort
        + uncertaintyBonus
```

The scorer stores the versioned feature definitions and integer/fixed-point inputs, not only the winning number. Every material decision records candidates, exclusions, features, perceptions, beliefs, memories, relationship inputs, random draws, policy version, selected action and eventual outcome links.

An LLM produces a plan/proposal under `ActorPolicy`; it does not mutate state. The proposal is parsed into a typed intent, checked against capabilities and current revisions, and may be rejected or replanned. Dialogue asserting intended action remains canonical only as speech even if the action later fails.

### 7.12 Canonical movement and event granularity

Movement is a segment, not a stream of frame events:

- `MovementStarted`: origin, destination, anchor route, start time, speed policy and movement ID;
- material `ActorEnteredRegion`/`ActorExitedRegion` events at calculated simulation times;
- `MovementInterrupted` or `MovementReplanned` when the plan changes;
- `MovementCompleted` on arrival.

Position at simulation time is derived from the active segment. High-frequency render coordinates, animation frames, particles, rain drops, cursors and presence heartbeats are projection/transient data.

The same semantic-threshold rule applies throughout the kernel:

| Canonical | Derived/ephemeral |
| --- | --- |
| weather transition | every rain particle |
| food spoiled/depleted | each decay integration increment |
| growth stage changed | every millimeter of visual scale |
| need crossed decision threshold | every sub-threshold meter update |
| meaningful speech act/claim/commitment | each streamed token |
| decision and selected action | each utility recomputation that changed nothing |

### 7.13 Simulation acceptance scenarios

The kernel and reference pack must pass these named, executable scenarios:

1. **`favorite-snack-house`:** Stevie perceives repeated successful food access; episodes and evidence support a belief; later food choice changes; “why” links decision features to that evidence.
2. **`rain-shelter-comfort`:** rain changes wetness and comfort only for exposed actors; shelter and perception differ by location; the response is deterministic under live steps and fast-forward.
3. **`food-decay-and-conservation`:** food appears, decays, is consumed/depleted and never duplicates or becomes negative across retries.
4. **`cedar-growth`:** aggregated offline growth and continuous live growth cross the same material stages.
5. **`birth-and-parentage`:** gestation survives pause, deploy and offline catch-up; birth creates a new stable object with explicit parent/household links exactly once.
6. **`social-learning`:** Gracie or Stevie teaches a kit; the kit stores attributed evidence rather than a copied episode; later behavior changes within policy.
7. **`death-and-successor`:** death stops ordinary activation, preserves historical identity, applies session/privacy policy, changes relationships/knowledge accessibility and may trigger a distinct successor actor.

   Amended (2026-10-27): Wave 1 proves death, preserved identity and the successor intent; the session, private-memory, relationship and knowledge-access policy at death is Wave 8 RW-0802 (Wave 8 §5.1, "Death").

8. **`months-fast-forward`:** accelerated preview over simulated months remains bounded, replayable and coherent across weather, growth, resources, lifecycle, schedules and rule budgets.
9. **`differential-perception`:** one event produces different authorized perceptions for nearby, sheltered, inattentive and absent actors.

   Amended (2026-10-27): Wave 1 proves nearby, sheltered, privacy-reduced and absent outcomes; the inattentive outcome needs the attention factor, which Wave 6 RW-0605 builds.

10. **`non-raccoon-conformance`:** a minimal non-raccoon pack exercises object, space, need, rule, memory and capability contracts without engine changes.

### 7.14 Kernel test contract

Required:

- golden transition fixtures;
- property tests for containment, inventory conservation, lifecycle, schedules, and privacy audience invariants;
- determinism tests across Node and Workers runtime;
- replay state-hash tests;
- metamorphic tests for batching versus sequential elapsed-time advancement;
- fuzzed command sequences;
- no-I/O static import checks;
- historic world-pack compatibility fixtures;
- all named scenarios in 7.13 with journal, final projection, schedule set, decision trace and state-hash goldens;
- cross-version fixtures proving archetype/trait pinning and event/component upcasting;
- differential tests comparing live stepping, catch-up aggregation, restart and preview fast-forward;
- performance tests proving event volume grows with semantic changes rather than rendered time steps.

---

## 8. World-pack contract

The engine ships with `world-pack-sdk`. A pack is data and trusted, build-time code only; it is not arbitrary runtime JavaScript.

```ts
interface WorldPackManifest {
  schemaVersion: number;
  id: string;
  version: string;
  engineCompatibility: string;
  dependencies: WorldPackDependency[];
  components: ComponentSchemaRef[];
  archetypes: ArchetypeManifest[];
  traits: ResourceRef[];
  spaces: ResourceRef[];
  actors: ResourceRef[];
  rules: RuleManifest[];
  capabilities: CapabilityDeclaration[];
  policies: ResourceRef[];
  cognitiveSeeds: CognitiveSeedRef[];
  randomStreams: RandomStreamSeedRef[];
  assets: AssetManifest[];
  seedCommands: CommandEnvelope<string, unknown>[];
  migrations: WorldPackMigrationRef[];
  expectedSeedProjectionHash: string;
}

interface WorldPackArtifactRef {
  packId: string;
  version: string;
  contentHash: string;
  engineCompatibility: string;
  resourceManifestHash: string;
  assetManifestHash: string;
  migrationSetHash: string;
  buildToolVersion: string;
}
```

Rules:

- data-only packs can be validated and installed without deploying arbitrary code;
- trusted code extensions are compiled, reviewed, versioned, and deployed with the engine;
- every activation validates hashes and compatibility;
- migrations are explicit, deterministic, resumable, and tested from every supported version;
- assets carry provenance, license, generation/provider metadata, review status, dimensions, anchors, footprints, and hashes;
- every world pack passes the same conformance suite: the fixture world in Clockgrove, and each external world, the reference world included, in its own repository against a pinned Clockgrove commit.

The repository-owned CLI exposes `pack validate`, `pack build`, `pack test`, `pack publish`, `world install`, and previewed `world upgrade`. Build normalizes namespaced resources, validates schemas/references/capabilities/licenses, compiles reviewed bounded extensions, hashes assets/resources, runs conformance/goldens, and produces one immutable artifact. This is not a marketplace or arbitrary plugin system.

The reference world's `green-lake-yard@1` pack, committed in [clockgrove/raccoon-world](https://github.com/clockgrove/raccoon-world), is executable product specification, not sample decoration. It contains:

- the full spatial hierarchy, regions, anchors, portal graph and presentation map from 2.7;
- archetypes for a social raccoon, kit, den, porch, food/trash source, water source, shelter, cedar/tree, plant and weather/day-night systems;
- Stevie, Gracie and kit instances with deterministic seed data, parent/household links, preferences and actor policies;
- versioned policies for clock ratio, weather, needs, utilities, growth, resources, gestation, aging, death and consolidation;
- interaction/capability bindings for inspect, embodied dialogue, interpreted perspective, influence and operator authoring;
- the rules and schedules required to run every scenario in 7.13;
- isometric assets, anchors, animation mappings, accessibility names and provenance;
- expected seed projection hash and scenario golden outputs.

The pack contains no Cloudflare, PostgreSQL, React or Three.js implementation imports. The web shell consumes its presentation inputs (§20.8) and the kernel consumes only its validated engine-facing manifest.

Clockgrove's fixture world under `worlds/fixture` has two packs. The tiny `clockgrove.test-world@1.1.0` beacon pack deliberately differs in theme and nouns while exercising one space, mobile subject, stationary conversational object, resource, need, memory, rule and capability. The neutral `clockgrove.fixture-hall@1.2.0` variant under `worlds/fixture/reference` carries the reference scenarios' platform obligations with neutral identities. Their job is to prove the engine runs any world and to catch accidental reference-world assumptions, not to become a second content project.

Do not build a marketplace, dependency solver, public registry, arbitrary plugin host, or community trust/signing system until those become product requirements.

### 8.1 Installation and world genesis

`WorldPackInstallation` pins the immutable artifact to one world/timeline. It records installation ID, world/timeline IDs, artifact hashes, status, genesis event, resumable seed cursor, installed time, migration lineage, and failure evidence.

World creation is one durable idempotent `WorldProvisioningCase`:

```text
requested
  → pack_validating
  → world_claimed
  → timeline_created
  → genesis_seeding
  → schedules_initialized
  → projections_building
  → runtime_routable
  → ready

terminal/exception: blocked | failed | cleanup_pending | archived
```

The case reserves stable IDs; creates the owner world membership, Caretaker persona and inventory; commits `WorldGenesisCreated`; executes stable seed commands; installs cognitive artifacts, policies, named random-stream state and schedules; verifies the expected seed projection hash; establishes the wall/simulation clock mapping; and commits `WorldReady`. Ordinary presence, simulation and runtime routing reject worlds that are not ready. Retries resume from durable cursors and cannot duplicate entities, schedules, inventories, cognition, or random advancement.

Durable Object initialization never creates canonical world state. It only rehydrates a world already made runtime-routable by the provisioning case.

### 8.2 Upgrade and reusable authoring

A pack upgrade is a previewed, migration-backed lifecycle case pinned to the current installation. It validates compatibility, creates a preview timeline, applies deterministic migrations, verifies projections/scenarios, rebases against the live head, and promotes fresh live commands/events. It never changes the installed content hash in place or reinterprets old events.

Conversational authoring changes a world instance. Export to reusable pack source or a pack fragment is a separate explicit reviewed operation; ordinary live mutations are never automatically folded into a pack.

---

## 9. PostgreSQL data architecture

### 9.1 Database authority

PostgreSQL stores canonical physical state, behavior-affecting cognition, timelines, schedules, rules, capabilities, durable conversations, searchable run evidence, authorization, and derived search projections.

Neon is the managed production provider. Hyperdrive supplies pooled connectivity from Workers. Local development uses a supported isolated PostgreSQL/pgvector fixture (container or native where supported) and the same migrations. Provider-specific Neon branching is for development environments and recovery operations; player-visible timelines are application data.

Use Drizzle for schema declaration, migrations, ordinary typed queries, and transaction composition. Use reviewed raw SQL for locking, append, RLS context, recursive graph traversal, vector operators, and performance-critical bulk operations. SQL is not hidden behind a generic repository framework.

ArtifactStore initially inlines encrypted/redacted text or JSON up to 128 KiB and spills larger or binary content to content-addressed R2. The threshold is configuration, not a semantic distinction.

### 9.2 Table families

#### Identity and authorization

- `tenants`
- `principals`
- `external_identities(provider, subject, principal_id)`
- `tenant_memberships`
- `roles`, `role_grants`, `capability_grants`
- `audit_records`

#### Worlds and timelines

- `worlds(lifecycle_status, ready_at, failure_evidence_id)`
- `world_pack_artifacts`
- `world_pack_installations(world_id, timeline_id, content_hash, status, genesis_event_id, seed_cursor)`
- `world_provisioning_cases(idempotency_key, state, attempt, failure_evidence_id)`
- `timelines(parent_timeline_id, kind, state, fork_manifest_id)`
- `timeline_partitions(partition_id, routing_epoch, head_sequence)`
- `spaces`
- `world_objects`
- `object_components`
- `containment_edges`
- `rules` and `rule_versions`
- `schedules`

#### Canonical journal

- `streams(current_sequence, snapshot_sequence)`
- `events`
- `command_receipts(request_hash, status, result, committed_at)`
- `snapshots` and `snapshot_manifests`
- `event_dispatches(event_id, channel, status, attempts, next_attempt_at)`

#### Cognition and explanation

- `perceptions`
- `episodes`
- `claims` and `claim_evidence`
- `beliefs` and `belief_revisions`
- `relationships`
- `summaries`
- `decision_traces`, `decision_candidates`, `decision_inputs`

#### Conversation and execution evidence

- `conversation_sessions`
- `conversation_participants`
- `messages`
- `turns`
- `agent_runs` and `agent_steps`
- `model_calls`
- `tool_calls`
- `approvals`

#### Context and retrieval

- `documents` and `document_versions`
- `renditions`
- `chunks`
- `entities` and `aliases`
- `typed_edges`
- `embeddings`
- `retrieval_traces` and `retrieval_results`

#### Capabilities and effects

- `capability_installations`
- `capability_bindings`
- `tool_schema_versions`
- `credential_envelopes`
- `effect_intents` and `effect_attempts`

#### Authoring and operations

- `changesets` and `change_operations`
- `validation_results`
- `promotion_attempts`
- `artifacts`
- `release_manifests`
- `consumer_checkpoints`

### 9.3 Required columns and indexes

Every tenant-owned table includes `tenant_id`. World data includes `world_id`. Timeline-relative data includes `timeline_id`. Partition-relative physical data includes `partition_id` and normally `space_id`.

Events have unique constraints on:

- `event_id`;
- `(tenant_id, timeline_id, stream_id, stream_sequence)`;
- `(tenant_id, timeline_id, partition_id, partition_sequence)`.

Command receipts have:

- unique `(tenant_id, command_id)`;
- immutable request hash;
- target address;
- result status and canonical event IDs.

High-value indexes:

- event lookup by actor/object, simulation time, recorded time, correlation, causation, command and privacy;
- pending schedules by `(tenant, timeline, partition, status, due_sim_time, tie_break_key)`;
- pending dispatches by `(channel, status, next_attempt_at)`;
- active sessions by subject and principal;
- runs by actor/session/status/model/prompt;
- beliefs and episodes by owner actor, proposition/entity, accessibility and time;
- typed edges by source/predicate/target and validity interval;
- GIN full-text vectors on searchable text;
- BRIN on append-heavy recorded timestamps where useful.

Do not table-partition merely because the product may become large. Preserve partition columns and archival keys; introduce physical PostgreSQL partitioning after production-shaped tests show operational benefit.

Vector retrieval begins with exact cosine search over the authorized candidate set. Add an HNSW cosine index through a measured migration when production-shaped corpora require it; keep deterministic scope predicates and validate recall before enabling it.

### 9.4 RLS and pooled connections

RLS is defense in depth and part of correctness testing.

Because Hyperdrive pools connections, request context is applied transaction-locally:

```sql
BEGIN;
SELECT set_config('app.tenant_id', :tenant_id, true);
SELECT set_config('app.principal_id', :principal_id, true);
SELECT set_config('app.privacy_ceiling', :privacy_ceiling, true);
-- authorized statements
COMMIT;
```

Never depend on connection-session `SET` state. Administrative and migration roles are separate from runtime roles. Ordinary runtime roles cannot bypass RLS.

### 9.5 Canonical append transaction

`Journal.execute()` performs:

1. begin a short transaction and install RLS context;
2. insert/lock `command_receipts` by command ID;
3. reject request-hash mismatch or return an already committed result;
4. lock required stream and partition heads in deterministic key order;
5. verify expected revisions and routing epoch;
6. execute domain validation against authoritative projections;
7. allocate stream and partition sequences;
8. append semantic events;
9. update validation-critical projections and schedules;
10. insert internal dispatch rows and external effect intents;
11. store the stable command result;
12. commit;
13. publish Queue notifications best-effort after commit;
14. return committed events and projection delta.

No model, MCP, R2, Queue, telemetry, or long computation occurs inside this transaction.

Crash behavior:

- before commit: no canonical change;
- after commit but before reply: retry returns the command receipt;
- Queue publish failure: dispatcher reconciliation republishes;
- Durable Object cache disagreement: PostgreSQL revision wins.

### 9.6 Canonical versus evidence-only records

Event-source only behavior-affecting state:

- physical/environmental changes;
- schedules and clock policy;
- rules and authored changes;
- actor perceptions, episodes, claims, beliefs, relationships and summaries used by future decisions;
- capability installation/grant changes;
- timelines and promotions.

Keep append-only/versioned but not state-replayed:

- transcript messages;
- prompts and model outputs;
- retrieval traces;
- tool calls/results;
- Workflow/fiber lifecycle;
- approvals and diagnostics.

A semantic event references the evidence record when it changes behavior. `BeliefFormed` references the extraction/model run and source evidence; replay does not reconstruct the model-call table.

### 9.7 Snapshots and replay

Snapshots contain:

- aggregate/partition and timeline identity;
- covered head sequence/vector;
- canonical state hash;
- scheduler and named PRNG state;
- schema, code, pack, rule, archetype, prompt/policy compatibility;
- R2 artifact hash and encryption metadata.

Snapshot creation is asynchronous. Activation verifies the artifact hash, loads the snapshot, applies later events, and compares the resulting projection hash with the stored head. A mismatch is a release-blocking defect and page-worthy production event.

### 9.8 Schema migrations

Use expand → backfill → verify → switch → contract:

- migrations are forward-only in production;
- deploy readers that tolerate old/new before writers require new;
- backfills are resumable and checkpointed;
- event payloads are immutable; use upcasters, not data rewrites;
- projection rebuilds use explicit checkpoints;
- every migration runs on empty, representative, and prior-release databases in CI;
- destructive contract steps require a verified backup/restore point and release approval.

---

## 10. Durable actor implementation

### 10.1 Runtime composition

`apps/runtime` exports:

- the Hono Worker entrypoint;
- `WorldDO extends DurableObject`;
- `SpaceDO extends DurableObject`;
- `ActorAgentDO extends Agent`;
- typed Workflow classes;
- Queue consumers;
- scheduled reconciliation handler.

Use Workers RPC for internal actor calls. Use `fetch()` only for WebSocket upgrade or HTTP semantics that require it.

### 10.2 Initialization

Each DO has an explicit, idempotent `init` path:

1. validate the hashed route key against trusted initialization arguments;
2. verify the canonical world/timeline is `ready` and runtime-routable;
3. migrate local SQLite schema inside bounded initialization;
4. load canonical routing/projection metadata;
5. reconcile alarms/fibers/connections;
6. mark runtime schema version.

Initialization never creates canonical world state implicitly. World/space/subject creation is a PostgreSQL command first.

### 10.3 WorldDO RPC surface

```ts
interface WorldActorRpc {
  initialize(input: InitializeWorldActor): Promise<WorldActorState>;
  resolveSpace(input: ResolveSpaceRoute): Promise<SpaceRoute>;
  setClockPolicy(input: Authorized<SetClockPolicy>): Promise<CommandResult>;
  pause(input: Authorized<PauseWorld>): Promise<CommandResult>;
  resume(input: Authorized<ResumeWorld>): Promise<CommandResult>;
  beginBranchBarrier(input: Authorized<BranchBarrier>): Promise<BarrierResult>;
  coordinateTransfer(input: Authorized<TransferRequest>): Promise<TransferState>;
  inspect(input: Authorized<WorldInspectQuery>): Promise<WorldInspectResult>;
}
```

Routing responses include `routingEpoch`. Space commands with a stale epoch fail with a typed reroute response.

### 10.4 SpaceDO RPC and socket surface

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

The scene WebSocket accepts only versioned client messages for join, acknowledge, interest update, command intent and ping/application control. The Worker authenticates and authorizes the upgrade before forwarding trusted context.

### 10.5 ActorAgentDO surface

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

An ActorAgentDO can operate in:

- `cognitive` mode for autonomous characters with private memory and policy;
- `interpreted` mode for objects/spaces whose response is grounded in material state/history but has no invented private mind;
- `canonical` mode for explicitly labeled operator/system explanation.

### 10.6 Durable Object local storage

Persist only:

- Agents/Cloudflare framework tables;
- runtime schema and initialization marker;
- WebSocket attachments and acknowledgement cursors;
- alarm generation and next due timestamp;
- fiber/job reconciliation IDs;
- MCP connection state required by the Agents SDK;
- bounded runtime cache only after activation tests justify it.

Keep hydrated projections, connection indexes, interest maps, recent patch batches, and current command context in memory. On hibernation loss, reconstruct them.

### 10.7 Alarm discipline

Each DO has one physical alarm. Maintain a logical next-due heap in canonical schedules or rebuildable local metadata. Alarm handlers:

- are idempotent;
- verify alarm generation;
- drain bounded work;
- commit through normal commands;
- reschedule the earliest remaining due item;
- yield before platform limits;
- start a catch-up Workflow only when bounded batches cannot meet the configured policy.

Do not use `setInterval` or constant server ticks.

### 10.8 Cross-space transfer

Transfer states are `requested → source_prepared → destination_accepted → source_released → completed`, with `rejected` and `reconciling`.

The protocol:

1. source SpaceDO commits `TransferPrepared` with object snapshot hash and transfer ID;
2. WorldDO verifies routing epoch and destination;
3. destination SpaceDO idempotently validates and commits `TransferAccepted`;
4. source commits release;
5. destination/source project completion;
6. scheduled reconciliation advances or safely compensates incomplete states.

No distributed transaction is attempted. Until acceptance, source remains canonical owner. After destination acceptance, the transfer record defines ownership unambiguously.

### 10.9 World boundary and mobility policy

Cross-space transfer is intra-world routing. Runtime object portability between worlds is out of scope and no passport, federation, foreign-custody, or executable-import protocol is reserved in the initial contracts.

Inside one world and timeline, an object's effective mobility policy is the deny-wins intersection of world default, space restriction, persona/role restriction, archetype ceiling, and instance restriction. Descendants may narrow but cannot silently widen a parent. Mobility scopes are `anchored`, `space`, and `world`; object-use capabilities such as `tool.chop` are authorized separately. Every allow or deny emits an `AuthorityDecision` linked to the command attribution.

A `PersonaInventory` is a world/timeline-local logical container. Moving an object between persona inventory, actor inventory, room, fixture, or container always uses the normal authoritative command and transfer path. Administrative world export/import remains a separate offline operation.
- source escrow, destination admission, authority-epoch transfer, release, and reconciliation maintain one mutation authority.

This contract learns from Minecraft server networks and Roblox experience/server boundaries without making either system a compatibility target. The greenfield improvement is explicit causal history, single-custody authority, trust negotiation, and inspectable admission.

---

## 11. Simulation clock and perpetual-world execution

Each timeline stores:

- simulation time;
- wall-clock anchor;
- speed ratio;
- running/paused state;
- catch-up cap and policy;
- partition-head vector;
- named PRNG state references.

Wall clock is only a wake signal. Canonical simulation time changes through commands/scheduled advancement.

Live policy is configurable per world:

- observed worlds may advance at a faster ratio;
- empty worlds may continue, slow, pause, or cap catch-up;
- preview branches can accelerate aggressively within budget;
- no global ratio is hard-coded.

The WorldDO owns policy; each SpaceDO maps relevant deadlines to its own alarm. Global scheduled items route to WorldDO. Partition-local work routes to SpaceDO.

Catch-up produces the same material state/events as the defined aggregation policy, not necessarily one event per missed interval. Exact and aggregate semantics are part of the versioned kernel.

The reference world's pack begins with a tunable experience policy of one real minute to one simulated hour while actively observed, capped unobserved catch-up of 24 simulated hours per activation, and faster preview-only acceleration. These are versioned world-policy defaults, not engine constants.

Tests compare:

- continuous small-step progression;
- one large elapsed-time advancement;
- sleep/reactivation;
- alarm retry;
- catch-up Workflow batching.

---

## 12. Realtime and multiplayer

### 12.1 Connection topology

The browser normally holds:

- one scene WebSocket to the current SpaceDO;
- one chat WebSocket per actively open subject, capped by client policy and multiplexing that subject's sessions.

HTTP retrieves durable history and large snapshots when appropriate. WebSockets carry realtime deltas and streams.

The public Worker:

1. verifies the configured authentication-provider session;
2. resolves the internal principal and tenant;
3. authorizes world/timeline/space/subject access in PostgreSQL;
4. creates a short-lived internal signed join assertion;
5. forwards the upgrade to the correct DO.

The client cannot choose trusted principal, tenant, role, scope, or privacy claims.

### 12.2 Wire envelope

```ts
interface RealtimeEnvelope<T> {
  protocolVersion: number;
  messageId: string;
  lane: "projection" | "transient" | "conversation" | "operator";
  type: string;
  worldId: WorldId;
  timelineId: TimelineId;
  spaceId?: SpaceId;
  subjectId?: SubjectId;
  sessionId?: SessionId;
  projectionRevision?: bigint;
  correlationId?: CorrelationId;
  payload: T;
}
```

Messages are JSON initially. The envelope reserves an encoding/version field so a binary codec can be added without changing semantics. Logical messages are batched every 50–100 ms or by count for high-frequency lanes.

### 12.3 Scene lanes

- **Projection:** revisioned visible object state, movement plans, environment, world clock, interaction affordances.
- **Transient:** animation cues, particles, sound hints, selections and ephemeral presence.
- **Conversation:** tokens, citations, tool progress, approvals, interruption and final state.
- **Operator:** events, traces, diffs and replay progress for authorized roles.

Private cognition and transcripts never enter a shared projection batch.

### 12.4 Interest and audience

Client interest includes camera bounds, selected object, detail level, subscribed spaces and requested overlays. Server resolution applies:

- tenant/timeline authorization;
- containment and spatial visibility;
- geofences and audience rules;
- privacy class;
- actor perception policy;
- operator role.

The client may request less information, never more authority.

### 12.5 Revision and recovery

Projection state is keyed by `(timeline, space, projection_revision)`.

On reconnect the client sends its last applied revision:

- if the active in-memory patch buffer has a gap-free range, SpaceDO returns it;
- otherwise it returns or directs the client to a fresh authorized snapshot;
- stale/duplicate patches are discarded;
- transient messages may be lost by design;
- conversation turn state is recovered from PostgreSQL/fiber state, not token replay alone.

Hibernating WebSocket attachments contain only small routing and acknowledgement metadata and stay below platform limits.

### 12.6 Client convergence tests

- two clients receive identical authorized projections;
- different interests receive different subsets without privacy leakage;
- duplicate, delayed and reordered batches converge;
- hibernation and runtime restart recover;
- network loss selects patch or snapshot correctly;
- cross-space movement transfers subscriptions cleanly;
- reconnect storms respect admission control and database budgets.

---

## 13. Human identity and application authorization

### 13.1 Authentication-provider boundary

The selected provider owns:

- sign-up/sign-in;
- OAuth/passkeys/MFA and account recovery;
- human profile and verified identifiers;
- browser/application sessions;
- optional organization and invitation UX.

The browser and Worker consume a project-owned `AuthProviderPort`. Better Auth is the reference implementation and runs with the application/PostgreSQL stack. Clerk may be selected as a hosted adapter. Provider SDK types remain inside adapters and both implementations pass the same session, revocation, account-linking, invitation, organization-drift, event-ordering, and environment-isolation conformance suite.

### 13.2 Internal principal mapping

`external_identities(provider, environment, subject)` maps to a stable internal `principal_id`. Domain rows reference `principal_id`, never provider IDs directly.

If provider Organizations are enabled:

- the external organization ID maps to `tenant_id` through an explicit provider link;
- the active organization claim is required for that tenant context;
- webhooks project organization membership into PostgreSQL;
- the Worker still checks current `tenant_memberships` and domain grants;
- world, timeline, actor, MCP, privacy and operator permissions remain PostgreSQL authority.

Provider roles do not replace workspace or world authorization.

### 13.2.1 Workspace, world, persona, and presence

The durable participation chain is:

```text
Principal -> WorkspaceMembership -> WorldMembership -> WorldPersona
                                                    -> PersonaInventory
WorldPersona -> optional controlledActorId
WorldPersona + live socket -> Presence
```

Workspace membership controls administration and resource ownership. World membership controls entry and world-scoped roles. A visitor can join a friend's world without joining the owner's workspace. The persona stores durable in-world identity, disclosure mode, relationships, reputation, and policy roles. Presence stores only ephemeral connection and interest state. Authentication-provider organizations may assist onboarding but never replace these records.

### 13.3 Webhooks and revocation

Provider events/webhooks:

- verify signature and timestamp;
- deduplicate by provider event ID;
- update identity/membership projection transactionally;
- record an audit entry;
- trigger cache/session invalidation;
- never create domain grants from untrusted metadata alone.

Short token lifetime, local membership checks, and explicit revocation limit delayed-webhook exposure.

---

## 14. Conversations and agent execution

### 14.1 Session model

Every conversation session has:

- stable session ID and logical ActorAddress;
- tenant, world, timeline and subject;
- creator/participants;
- mode: in-character, interpreted, canonical/operator;
- visibility and retention;
- scoped capability grants;
- transcript and rolling summary;
- last grounded world/cognitive revisions;
- ordered turns and active-turn state;
- model/context budget policy.

Sessions are independent even when they share an ActorAgentDO. Death or retirement preserves identity/history, stops ordinary autonomous activation, and applies policy to new/existing sessions.

### 14.2 Ordinary turn state machine

```text
accepted
  → context_resolved
  → retrieving
  → generating
  ↔ awaiting_tool / awaiting_approval
  → validating_actions
  → committing_actions
  → extracting_memory
  → completed

terminal alternatives:
  rejected · canceled · budget_exceeded · dependency_failed · failed
```

An ordinary turn runs in a recoverable Agent fiber:

1. claim command/turn idempotently and call `startFiber("turn:" + turnId, ...)`;
2. capture input world and cognitive revisions;
3. resolve policy and allowed scopes;
4. assemble/retrieve authorized context;
5. record retrieval trace and hashes;
6. call the model through the AI SDK and AI Gateway;
7. stream safe text to the session channel;
8. execute allowed tools through CapabilityExecutor;
9. validate structured outputs;
10. submit proposed domain commands with expected revisions;
11. record accepted/rejected outcomes;
12. propose claims/memory changes;
13. finalize transcript, run evidence, usage and cost.

Fibers checkpoint phase and durable references, not large prompt/output bodies. PostgreSQL holds permanent evidence.

`onFiberRecovered` reloads the application run, completed steps and last checkpoint from PostgreSQL before continuing. Fiber names and recovery payloads are versioned contracts.

### 14.3 Fiber recovery and nondeterminism

Model and tool calls are not assumed exactly once.

Each nondeterministic operation has an application step ID:

- a completed persisted result is reused;
- an in-progress call after eviction is marked abandoned/uncertain;
- a safe read/model call may restart as a new attempt under the same step;
- a protected effect uses provider idempotency or enters explicit reconciliation;
- only one accepted result advances the run state.

Partial token streaming is presentation state. The final assistant message is persisted once. Recovery may notify the client that generation resumed.

### 14.4 Workflow boundary

Use typed Workflows for:

- long research/tool jobs expected to exceed an interactive fiber budget;
- human approvals that may wait hours/days;
- context ingestion;
- dreaming/consolidation;
- world authoring preview/promotion;
- cross-space or cross-owner sagas requiring compensation.

Do not wrap every turn in a Workflow. Do not build one generic workflow interpreter. Each Workflow has typed input, bounded steps, explicit retry policy, stable instance ID, and PostgreSQL run linkage.

#### Durable actor-process contract

Bounded fibers and Workflow steps are execution segments, not the maximum lifetime of an actor responsibility:

```ts
interface ActorProcess {
  processId: ActorProcessId;
  subject: SubjectRef;
  mode: "reactive" | "scheduled" | "continuously_eligible";
  status: "waiting" | "runnable" | "running" | "paused" | "completed" | "failed";
  objectiveRef: ObjectiveRef;
  subscriptionCursorRefs: EventCursorRef[];
  checkpointRef?: ArtifactRef;
  leaseEpoch: bigint;
  budgetPolicyRef: BudgetPolicyRef;
  lastRunSegmentId?: RunId;
}
```

Each execution segment remains bounded, attributable, budgeted, recoverable, and linked to the same durable process. The scheduler may immediately admit the next segment, wait for a relevant event, or promote the process to dedicated compute behind the same `ActorAddress`/`ActorProcessId`. A provider that supports long-lived streams or sessions may be used behind `ModelGateway`, but world correctness never depends on one connection, process, or isolate remaining resident.

### 14.5 Model policy

`ModelPolicy` resolves a versioned model alias by task, tenant/world policy, privacy, latency, budget and provider health. Code never hard-codes provider model strings outside configuration.

Each cognitive or interpreted subject also resolves an explicit actor policy:

```ts
interface ActorPolicy {
  id: ActorPolicyId;
  version: number;
  personaRef: string;
  communicationStyle: CommunicationStyle;
  cognitionStrategy: "reflex-utility" | "hybrid" | "scripted";
  modelRoute?: ModelRoute;
  promptVersion?: string;
  contextScopes: ScopeSelector[];
  capabilityPolicy: CapabilityPolicy;
  deliberationThresholds: DeliberationPolicy;
  budgets: ComputeBudgetPolicy;
  memoryWritePolicy: MemoryWritePolicy;
}
```

Archetypes supply defaults; versioned traits and instance configuration may override them through an explicit resolver. Each run stores the fully resolved policy artifact and hash.

Use:

- `ai` for streaming and structured outputs;
- `ai-gateway-provider` for Cloudflare AI Gateway;
- Zod schemas for structured model results;
- recorded prompt template, policy, model alias/provider/version, temperature/settings, token usage, latency and cost;
- deterministic scripted providers for CI;
- provider circuit breakers and deterministic behavior fallback.

Routine simulation remains functional with all model providers unavailable.

### 14.6 Stale state

Every proposed action references the world/cognitive revisions used to reason:

- harmless narration may complete against a stale world if labeled appropriately;
- state-dependent claims can be rechecked;
- canonical commands reject stale expected revisions;
- policy decides whether to retry context/model work, replan deterministically, or report that the world changed.

The transcript preserves what was said even if an action failed.

### 14.7 Searchable agent runs and steps

Runs are product evidence, not reconstructed logs:

```ts
interface AgentRun {
  id: AgentRunId;
  parentRunId?: AgentRunId;
  tenantId: TenantId;
  worldId: WorldId;
  timelineId: TimelineId;
  actorId: WorldObjectId;
  sessionId?: SessionId;
  policyVersion: string;
  inputWorldRevision: bigint;
  inputCognitiveRevision: bigint;
  status:
    | "queued" | "running" | "waiting_tool" | "waiting_approval"
    | "completed" | "failed" | "canceled" | "timed_out";
  correlationId: CorrelationId;
}

interface AgentStep {
  id: AgentStepId;
  runId: AgentRunId;
  kind:
    | "retrieve" | "model" | "tool" | "approval" | "extract"
    | "propose_command" | "commit_result" | "memory_update";
  attempt: number;
  status: RunStepStatus;
  inputRefs: ArtifactRef[];
  outputRefs: ArtifactRef[];
  startedAt: WallTimeIso;
  completedAt?: WallTimeIso;
}
```

Runs retain retrieval evidence and access decisions, prompt/model/tool/policy versions, structured outputs, proposed commands, accepted/rejected events, usage/cost, errors/retries and extracted entities/claims. Large or sensitive content uses protected, hashed artifacts and retention policy. A parent/child link relates conversational turns, delegated jobs, extraction and consolidation without collapsing them into one opaque trace.

### 14.8 Cognitive budgets and backpressure

Budgets apply by tenant, world, timeline kind, actor, session, wall-clock window, simulated day, model route, MCP provider and job class. Work priority is:

1. user-visible conversation and approval;
2. safety/invariant-related reasoning;
3. visible or consequential planning;
4. important social interaction;
5. extraction and belief revision;
6. consolidation and background reflection.

Policies cap calls, tokens, cost, duration, concurrent runs and tool invocations. Exhaustion queues, selects a cheaper allowed route, falls back to deterministic behavior, delays background work, or rejects optional work with an inspectable reason. It never silently exceeds a hard budget or stalls routine simulation.

### 14.9 Actor-to-actor communication

Actors can communicate without a user mediating every exchange. The first social action catalog is `Say`, `Ask`, `Tell`, `Warn`, `Teach`, `Demonstrate`, `Invite`, `Lead` and `Promise`.

Communication is a world action. Semantic events such as `ActorSpoke`, `ActorDemonstrated` or `PromiseMade` pass through the normal audience resolver, so nearby actors may hear different fragments or miss the interaction. A full generated dialogue can remain a private session/run artifact; behavior-affecting speech acts, extracted attributed claims, commitments and recipient perceptions become privacy-classed canonical events.

Routine social transmission uses structured actions and templated presentation. An LLM is reserved for novelty, ambiguity, relationship impact or user-visible dialogue. Listening creates testimony or demonstration evidence with provenance; it never copies the speaker's episode into the listener.

---

## 15. Asynchronous delivery and durable jobs

### 15.1 Queue topology

Production provisions:

- `world-reactions` plus DLQ;
- `cognitive-indexing` plus DLQ;
- `external-effects` plus DLQ.

#### World reactions

Carries rule evaluation, perception delivery, actor wakeups and internal notifications that follow committed events. Handlers are bounded and prioritize low lag.

#### Cognitive indexing

Carries extraction, embedding, chunk/index updates, memory accessibility, search maintenance and other expensive/retry-prone derived work. Poison data cannot block world reactions.

#### External effects

Carries approved MCP/network writes, webhooks and notifications with effect state and reconciliation. It has the strictest audit/idempotency policy.

### 15.2 Dispatch

The canonical transaction inserts a compact `event_dispatches` row for each required logical channel; it does not duplicate the event payload.

After commit:

1. runtime publishes the envelope best-effort;
2. successful publish marks dispatch;
3. a scheduled sweeper republishes due undispatched rows;
4. consumers load canonical event/effect data by ID;
5. handler result writes semantic dedupe/checkpoint state;
6. retries use exponential backoff within policy;
7. exhausted messages enter DLQ and create an operator evidence record.

Queues are at least once. Consumers never depend on FIFO ordering across independent messages. If ordering matters, route the action back through the owning DO and expected revisions.

### 15.3 Workflow classes

- `WorldProvisioningWorkflow`
- `WorldPackUpgradeWorkflow`
- `IngestionWorkflow`
- `ConsolidationWorkflow`
- `AuthoringWorkflow`
- `AgentJobWorkflow`
- `TransferRecoveryWorkflow`

Workflow history is operational. PostgreSQL stores permanent application runs/steps and artifact references. Workflow instance IDs are deterministic from application run IDs so launch retries do not create parallel jobs.

### 15.4 Cron jobs

Cron triggers only coarse maintenance:

- dispatch reconciliation;
- DLQ/operator summaries;
- orphaned run/fiber/effect reconciliation;
- snapshot/retention eligibility;
- index verification;
- backup/restore verification scheduling.

Simulation deadlines use DO alarms, not global cron polling.

---

## 16. Context, memory, graph, and explanation

### 16.1 Context scopes

Supported scopes are:

- session;
- actor/subject;
- relationship or family/group;
- space/room;
- neighborhood/world;
- tenant/global;
- operator-protected.

`ContextScopeResolver` first computes permitted scope from principal, subject, timeline, privacy, relationship, capability binding, and purpose. Retrieval only sees the allowed candidate set. Ranking cannot reintroduce denied material.

### 16.2 Ingestion

`IngestionWorkflow`:

1. validates source, owner, scope, grants, privacy and retention;
2. fetches/receives bytes under network and size policy;
3. hashes content;
4. stores small text/JSON inline or large/binary source in R2;
5. creates versioned renditions;
6. chunks with stable source-span IDs;
7. extracts candidates only from unstructured content;
8. embeds approved chunks through ModelGateway;
9. writes FTS/vector/entity/edge projections;
10. verifies source-to-index coverage;
11. commits `ContextDocumentReady`.

Refresh creates a new document version. Supersession, retirement and deletion explicitly invalidate derived retrieval entries and actor caches.

An actor can invoke a governed `request_context_ingestion` capability with a source, proposed scope and purpose. The request creates an approval/job record; it cannot grant the actor broader read access than its resolved policy. On completion the document is bound to the approved actor, relationship, space or world scope and becomes retrievable in later sessions/runs with source-version citations. Room knowledge never silently becomes global knowledge, and actor-private ingestion never leaks through a space summary.

### 16.3 Memory primitives

- **Perception:** actor-relative delivery of a canonical event or communication.
- **Episode:** retained experience with time, place, participants, salience and evidence.
- **Claim:** attributed proposition from speech, document, inference or extraction.
- **Belief:** actor-owned proposition with confidence, acquisition mode, evidence set, contradiction state and applicability.
- **Relationship:** objective or subjective temporal edge with evidence.
- **Summary:** versioned compression over a declared actor/relationship/space/world scope.

Objective fact, Gracie's perception, Gracie's belief, Gracie's testimony, and a kit's tentative belief remain distinct records.

The first-party memory contracts are:

```ts
interface Episode {
  id: MemoryId;
  ownerId: WorldObjectId;
  scopeId: ScopeId;
  occurredAt: SimTimeMs;
  formedAt: SimTimeMs;
  sourceEventIds: EventId[];
  participants: WorldObjectId[];
  locationId?: WorldObjectId;
  observation: StructuredObservation;
  salience: Fixed01;
  emotionalWeight?: EmotionVector;
  access: AccessPolicy;
  status: "active" | "forgotten";
}

interface Belief {
  id: BeliefId;
  ownerId: WorldObjectId;
  proposition: Proposition;
  confidence: Fixed01;
  evidence: EvidenceRef[];
  learnedFrom?: WorldObjectId;
  acquisition:
    | "observation" | "testimony" | "demonstration"
    | "imitation" | "inference" | "innate";
  validContext?: ContextPredicate;
  status: "active" | "contradicted" | "superseded";
}

interface MemorySummary {
  id: SummaryId;
  ownerId: WorldObjectId;
  scope: ScopeRef;
  sourceMemoryIds: MemoryId[];
  textArtifactId: ArtifactId;
  structuredClaims: Proposition[];
  validFrom: SimTimeMs;
  supersedes?: SummaryId;
}

interface Claim {
  id: ClaimId;
  proposition: Proposition;
  assertedBy: PrincipalId | WorldObjectId | ContextDocumentId;
  assertedAt: SimTimeMs | WallTimeIso;
  source: EvidenceRef;
  confidence?: Fixed01;
}

interface Evidence {
  id: EvidenceId;
  kind:
    | "perception" | "episode" | "testimony"
    | "demonstration" | "document" | "inference";
  sourceRef: string;
  weight: FixedPoint;
  provenance: ProvenanceRef;
}

interface Relationship {
  id: RelationshipId;
  subjectId: WorldObjectId;
  objectId: WorldObjectId;
  type: RelationshipType;
  ownerId?: WorldObjectId;
  strength?: FixedPoint;
  confidence?: Fixed01;
  validFrom: SimTimeMs;
  validTo?: SimTimeMs;
  evidence: EvidenceRef[];
}
```

Canonical kinship/household/containment edges have no subjective owner. Trust, affection, fear, familiarity, obligation and preference are actor-owned, asymmetric and possibly wrong. Entity/mention resolution is attributed, confidence-bearing and reversible; an extractor cannot silently merge canonical entities.

The domain operations are `observe`, `recall`, `formBeliefs`, `learnFrom`, `reinforce`, `contradict`, `consolidate`, `forget` and `explainBelief`. Each resolves to typed commands/queries with access policy and evidence; they are not direct database helpers.

### 16.4 Perception and learning

```text
canonical event
  → audience resolver
  → actor-specific perception
  → deterministic salience/episode policy
  → optional extraction for unstructured material
  → validated episode/claim/belief command
  → private semantic event
  → retrieval/index update
  → later decision trace cites exact evidence
```

Structured simulation events directly create typed perceptions and graph edges. Do not send known IDs/relations through an LLM extractor.

### 16.5 Retrieval

Retrieval combines:

- deterministic scope and privacy filter;
- structured entity/object/relationship predicates;
- FTS rank;
- pgvector similarity;
- containment/spatial proximity;
- recency and accessibility;
- salience/emotional weight;
- confidence and contradiction status;
- relationship trust;
- summary coverage.

Every returned item records score features, source span, evidence, access decision, timeline and revision. The model receives a cited context bundle, not anonymous chunks.

### 16.6 Graph-shaped operations

Use typed temporal edges in PostgreSQL:

```ts
interface TypedEdge {
  edgeId: EdgeId;
  subjectId: EntityId;
  predicate: PredicateId;
  objectId: EntityId;
  ownerActorId?: SubjectId;
  validFrom: SimTimeMs;
  validTo?: SimTimeMs;
  confidence?: FixedPoint;
  evidenceIds: EvidenceId[];
}
```

Bounded recursive SQL handles known traversals. Add closure/materialized projections behind `ContextGraph` only when a measured query misses its latency target. Do not add a general graph query language or another canonical database.

### 16.7 Dreaming and consolidation

`ConsolidationWorkflow` can operate at actor, relationship/family, space, neighborhood, or world scope. It:

- clusters episodes;
- proposes summaries;
- revises accessibility;
- identifies contradictions;
- proposes belief changes;
- extracts unresolved goals;
- records sources, prompt/model/policy, and evaluation.

Behavior-affecting outputs become private semantic commands/events. Consolidation cannot erase evidence or rewrite objective world facts.

### 16.8 Social and generational learning

`Tell`, `Teach`, `Demonstrate` and `Lead` create attributed evidence. Recipient confidence depends on trust, directness, repetition and later verification. Children inherit predispositions or taught beliefs only through explicit, versioned policies; they do not receive a blind copy of a parent's memory store.

For learned resource preference, actors keep transparent evidence such as successful/failed visits, expected quantity/quality, danger, travel cost, social comfort and time/weather context. A versioned Beta-like estimate may represent success probability as `alpha / (alpha + beta)`. Firsthand evidence can carry full policy weight; trusted testimony contributes fractional evidence. “Favorite house” emerges from evidence and current utility, never a static `favoriteHouseId`.

### 16.9 Decision traces and “why?”

`decision_trace_id` is the product evidence spine:

```text
trigger event / scheduled input
  → available perceptions
  → retrieved beliefs and evidence
  → candidates and utility features
  → named random draws
  → optional model/run
  → selected action
  → submitted command
  → accepted/rejected result events
  → later learning/outcome
```

Three views:

- in-world subjective explanation;
- player-facing structured explanation;
- authorized developer trace.

An explanation may not cite information unavailable to the actor at decision time.

### 16.10 Memory evaluation gates

Fixed fixtures measure:

- provenance and citation accuracy;
- observation versus hearsay;
- contradiction handling;
- privacy leakage;
- summary faithfulness;
- retrieval relevance;
- later behavioral effect;
- explanation grounding;
- latency, tokens and cost.

A memory feature does not ship because it stores impressive data. It ships only if it improves a later decision or explanation in the evaluation suite.

### 16.11 Field guides and governed knowledge sharing

Field guides use the versioned summary/context cognitive-document and consolidation paths. They are authored interpretations with linked sources, uncertainty, disagreement and revision history, not an omniscient wiki. Dreaming may propose them; governed sharing separately validates capability, permitted source disclosure, audience and exact world/timeline/document version. Read authority alone does not grant publication authority. Reading a guide supplies attributed testimony, and a recipient's own verification and guide edition retain distinct evidence/authorship.

Use existing document/access metadata and semantic events/audit rather than a new guide publication store. Source expansion reauthorizes access; private/unavailable provenance does not leak through references. Apply revocation, retention/deletion, derived-content rebuild/withdrawal and recorded-output replay. Guide content never becomes trusted instructions or canonical physical facts, and shared scene metadata remains separately authorized `public_scene` data. See the [accepted guide/counterfactual ADR](adr/clockgrove-adr-field-guides-and-counterfactual-why.md).

---

## 17. Capabilities and MCP

Installable MCP servers are governed providers, not ambient additions to a prompt. Their tools, resources and prompts enter different project-owned contracts.

### 17.1 Unified capability registry

Internal world tools and remote MCP tools share:

```ts
interface CapabilityDefinition {
  capabilityId: CapabilityId;
  version: string;
  name: string;
  provider: "internal" | "mcp";
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  effectClass: "read" | "world-write" | "external-write" | "destructive" | "network" | "cost";
  requiredGrants: GrantRequirement[];
  supportedScopes: CapabilityScope[];
  idempotency: "none" | "application" | "provider";
  approval: ApprovalPolicy;
  limits: CapabilityLimits;
  retention: RetentionPolicy;
}
```

### 17.2 Installation and binding

One `capability_installation` represents a server/provider. It can have bindings at:

- tenant/global;
- world;
- space;
- actor/subject;
- session;
- operator.

Resolution applies most-specific deny, then grants, then optional session approval overlay. One installation can serve many bindings; do not create separate installation subsystems per scope.

- discovered **tools** become disabled-by-default capability candidates;
- selected **resources** become provenance-bearing context-source candidates routed through `IngestionWorkflow` or a versioned read-through adapter;
- discovered **prompts** are untrusted template candidates and cannot replace system or actor policy without explicit review and versioning;
- an actor may request installation or resource ingestion, but authorization, network policy, scope, retention, budget and approval decide whether it happens.

### 17.3 MCP lifecycle

Production initially supports remote Streamable HTTP MCP. The transport port remains versioned.

Lifecycle:

1. register endpoint and ownership;
2. enforce URL/SSRF/host policy;
3. establish OAuth or token material;
4. discover tools/resources/prompts through the Agents SDK client;
5. snapshot and validate schemas;
6. classify effects and requested access;
7. approve a filtered set;
8. pin installation, protocol and schema versions;
9. activate bindings through semantic commands;
10. reconcile active ActorAgentDO connections;
11. audit calls, schema drift, errors and revocation.

Canonical installation, binding, policy and audit live in PostgreSQL. Agent SDK connection/OAuth state required for active use may live in ActorAgentDO SQLite and is rebuildable/re-authorizable according to provider constraints.

### 17.4 MCP execution

Tool input includes immutable execution context references, subject/session/run, grants, correlation/causation, and approval. Tool descriptions and results are untrusted. Validate:

- selected capability/version;
- argument schema and size;
- destination/host;
- data classification;
- output schema/size/content;
- allowed follow-on canonical commands.

Read-only results are evidence, not facts. External writes create `effect_intent` and route through the external-effects queue. Preview timelines default to simulated results and never replay an old preview call during promotion.

### 17.5 Credentials

- use OAuth where possible;
- envelope-encrypt stored service secrets with versioned KEKs;
- bind credentials to tenant/installation/principal as appropriate;
- never include plaintext in journal events, logs, traces, prompts, R2 keys, DO names or error messages;
- rotate and revoke with audit;
- make uncertain revocation/refresh state fail closed for writes.

### 17.6 First-party MCP exposure

Expose an authenticated, stateless MCP server for safe world operations using Cloudflare's current stateless MCP handler:

- search/inspect worlds, actors, events, decisions and memories;
- submit authorized typed commands;
- create/inspect changesets and previews;
- follow durable run status.

The MCP server calls the same application use cases as the web API. It does not bypass authorization or write SQL. Do not use deprecated stateful MCP server classes for new endpoints.

---

## 18. Rules, triggers, and natural-language authoring

### 18.1 Rule engine

Rules are versioned bounded ASTs, not JavaScript, SQL or prompts.

```ts
interface WorldRule {
  id: RuleId;
  version: number;
  enabled: boolean;
  scope: ScopeRef;
  trigger: RuleTrigger;
  conditions: RuleCondition[];
  actions: RuleAction[];
  priority: number;
  effectiveFromSequence: bigint;
  owner: PrincipalId;
  grants: GrantRef[];
}
```

Trigger classes:

- committed event;
- spatial enter/exit;
- scheduled time;
- threshold/transition.

The AST/versioning model anticipates delayed, duration, sequence, probabilistic and composite triggers without implementing them until a concrete rule requires them. A new rule version never retroactively fires over old history unless an explicit authorized backfill creates new causal work.

Rules bind typed values, read an allowlisted scoped view, evaluate pure expressions, optionally draw from a named random stream, and emit typed commands.

Every firing deduplicates by `(rule_id, rule_version, source_event_id, action_index)` and records bindings, condition results, draws, emitted commands and outcomes.

Limits:

- priority and deterministic tie-break;
- maximum fanout;
- causal depth;
- event/command budget;
- cooldown/rate;
- cycle detection;
- per-rule/world kill switches.

Invariants run synchronously in the command path. Durable reactions consume committed events from `world-reactions`.

Reference rules include:

- when a juvenile enters the street buffer, notify a nearby trusted adult;
- when an actor dies, schedule an authorized ecological/narrative successor;
- when rain accumulation crosses a threshold, fill an authored pond;
- at dusk, close a food source and update its risk/availability state.

### 18.2 Changesets

Natural-language authoring is a compiler into:

```ts
interface WorldChangeSet {
  changesetId: ChangeSetId;
  schemaVersion: number;
  tenantId: TenantId;
  worldId: WorldId;
  sourceTimelineId: TimelineId;
  baseHeadVector: PartitionHeadVector;
  promptArtifactId: ArtifactId;
  assumptions: Assumption[];
  operations: ChangeOperation[];
  requiredGrants: GrantRequirement[];
  validationPolicyVersion: string;
}
```

Initial operations:

- create/retire object;
- update typed component;
- move object;
- link/unlink objects;
- change archetype;
- activate/deactivate rule;
- schedule event;
- bind/install capability;
- bind presentation asset.

No arbitrary database patch operation exists.

### 18.3 Authoring Workflow

1. inspect current authorized state and available archetypes/assets/rules;
2. compile typed operations and explicit assumptions;
3. validate schemas, references, containment, collisions, navigation, grants and budgets;
4. create a preview timeline at a committed barrier;
5. apply commands to the preview;
6. render semantic and visual diff;
7. optionally fast-forward under preview budgets;
8. permit branch inspection and conversation;
9. collect approval;
10. rebase authored intent against current live heads;
11. apply new live commands or return typed conflicts.

Synthetic preview events are never merged into live history.

### 18.4 Authoring test scenarios

- create a pond with semantic and visual bindings;
- add a street-safety geofence rule;
- move an occupied object and detect containment/navigation conflict;
- create a death-triggered ecological successor;
- preview a rule loop and trip causal budget without affecting live;
- change the world during preview and verify semantic rebase/conflict.

### 18.5 Quest composition

Future quests are authored compositions over existing events, rules, schedules, relationships, capabilities and evidence queries. A quest can observe conditions, reveal goals, issue rewards or unlock interactions, but it does not create a second journal, scheduler or scripting authority. Do not build a generalized quest engine until product requirements exceed the bounded rule/changeset model.

---

## 19. Timelines, branches, replay, and promotion

### 19.1 Timeline model

A timeline is `live`, `preview` or `archived`. It has a stable ID, optional parent, fork manifest, world-pack/policy versions, retention, budget, and effect policy.

Hosted preview timelines default to seven-day retention and configurable per-tenant count/storage budgets. Pinning or promotion can extend retention; expiration never affects the live parent.

A fork manifest records:

- parent timeline;
- partition-head vector;
- compatible snapshot references;
- schedule and PRNG state;
- code/schema/pack/rule/prompt policies;
- artifact hashes.

Inherited logical object IDs remain stable. Branch-only IDs are globally unique.

### 19.2 Branch storage

Begin with a materialized compatible snapshot plus branch-local projections/events. The contract permits copy-on-write optimization later. Do not clone:

- Durable Object SQLite;
- active sockets/presence;
- in-flight runs;
- operational telemetry;
- old chat sessions.

New sessions/runs carry the branch timeline ID. Behavior-affecting cognition inherited at the fork is timeline-relative and available according to policy.

### 19.3 Effect isolation

Preview policy is enforced at CapabilityExecutor/effect dispatch:

- no purchase, email, webhook, destructive MCP or external mutation by default;
- credentials are not automatically inherited;
- allowed read results become branch-local recorded inputs;
- any exceptional live call is explicitly approved and labeled non-rewindable;
- preview budgets and expiration are independent.

### 19.4 Replay modes

- **Exact:** recorded nondeterministic results, supported versions, canonical hash verification.
- **Diagnostic:** same inputs with additional instrumentation.
- **Experimental:** different code/model/prompt/policy on a new marked branch.

Replay bundles include events, snapshots, artifact hashes, versions, redacted configuration and expected state hashes.

### 19.5 Promotion

Promotion takes the changeset's semantic intent, revalidates it against current live partition heads, and submits new commands. It does not copy preview event IDs, cognition, tool calls, or future consequences.

### 19.6 Counterfactual Why

Reuse the decision trace/input manifest, compatible pre-decision snapshot/cognitive versions, deterministic evaluator and existing preview/evaluation path. First reproduce a supported kernel utility or bounded compiled-policy baseline with the same evaluator, policy/documents, clock and named random state. Apply one declared typed hypothetical input, keep other inputs fixed, and record compared candidates/features/results plus source/branch/input hashes and resource disposition.

One request means one selected bounded comparison, not stochastic model search. An unchanged action is a valid result. Missing/deleted/unauthorized/incompatible inputs or unsupported evaluators/interventions return unavailable/unsupported; baseline mismatch fails qualification. Authorization gates both source inspection and preview execution; no hypothetical may alter grants, credentials or privacy. Initial delivery uses existing scoped preview authority.

Label actual versus hypothetical results and their limited evaluator scope in visual and text views. Never claim hidden model reasoning or broad causal proof. Preview effect isolation blocks real delivery, including guide sharing and synthetic memories; synthetic history cannot enter the live journal. Any subsequent live change uses ordinary current-head promotion. The [topic ADR](adr/clockgrove-adr-field-guides-and-counterfactual-why.md) owns acceptance and deferred stochastic/multi-variable scope.

---

## 20. Browser and presentation architecture

### 20.1 Ownership

React owns:

- provider-neutral authentication and world selection;
- routing and application shell;
- object/subject interaction card;
- chat and multiple sessions;
- event/decision/memory/run inspector;
- timeline, branch and diff UI;
- authoring and approvals;
- settings, accessibility and operator controls.

The Three.js adapter owns:

- fixed isometric world rendering;
- depth sorting and sprite/elevation layers;
- animations, particles, weather and day/night;
- camera, zoom, pan, picking and highlights;
- movement interpolation;
- application of projection deltas and transient cues.

The bridge is a typed renderer-neutral adapter. `SceneProjection` exposes semantic object IDs, spatial-frame references, poses/regions, presentation-role bindings, animation state, and authorized cues—not Three.js scene nodes or quadtree cells:

```ts
interface WorldSceneAdapter {
  loadSnapshot(snapshot: SceneProjection): void;
  applyPatch(patch: SceneProjectionPatch): void;
  emitCue(cue: TransientCue): void;
  setSelection(id?: WorldObjectId): void;
  onIntent(handler: (intent: SceneIntent) => void): Unsubscribe;
}
```

The renderer never imports runtime, persistence or cognition code. Three.js WebGPURenderer replaces the initial Phaser implementation under the accepted [renderer ADR](adr/clockgrove-adr-renderer-bake-off.md). Future VR or other full-3D adapters consume the same semantic projection and submit the same typed intents.

### 20.2 Information architecture and visible loop

The default desktop composition contains:

- isometric world canvas as the primary visual surface;
- persistent simulated date/time, speed, running state and weather;
- material event/overnight feed;
- selected-entity card with public state, relationships and available actions;
- Talk, Observe/Inspect, Remember/History, Influence and Why actions filtered by capability and permission;
- conversation panel with explicit session selector and new-session action;
- world-level natural-language input for accessible observation and authorized authoring;
- timeline/branch controls for operators;
- optional developer inspector with raw projections and causal evidence.

On a small screen, panels may become drawers or tabs, but selection, chat, event history and clock/weather remain reachable without losing scene state.

The scene communicates activity without continuous LLM narration. Day/night, weather, movement, routines, resource/growth changes, event summaries and visible needs provide background life while cognitive actors sleep.

The selection-to-understanding path is:

1. selection immediately highlights the object and opens cached/public summary;
2. capability and permission resolution labels available actions;
3. Inspect returns canonical/derived state appropriate to the disclosed mode;
4. Talk opens the chosen durable session and states the voice mode;
5. Why starts from a selected action/event and progressively reveals authorized evidence;
6. Influence shows an intent lifecycle—proposed, accepted/rejected and consequential events—rather than implying direct control.

#### Browser readiness

The client exposes `resolving_route → authorizing → joining → snapshot_ready → critical_assets_ready → scene_ready`, with `text_ready` as an alternate usable state and explicit `world_not_ready`, `incompatible`, `forbidden`, `recovering`, and `failed` outcomes. The scene-ready metric requires a committed authorized reducer snapshot plus the critical asset set and renderer acknowledgement. Deferred assets may stream later. WebGL or asset failure preserves the text-first projection where possible.

Snapshot/asset compatibility is pinned by world-pack installation and asset-manifest hashes. Tenant/world/timeline changes clear reducer, selection, scene, HTTP caches, and sockets before the next scope becomes visible.

### 20.3 Client state

- TanStack Query: HTTP server state, history and inspector queries;
- Zustand: transient cross-panel UI state and React/renderer bridge;
- Three.js scene graph: visual state only;
- IndexedDB: optional cached assets and last projection metadata, never authority.

### 20.4 Lit isometric rules

- fixed camera angle;
- limited zoom;
- discrete elevation;
- explicit sprite footprint and anchor;
- deterministic depth key;
- navigation anchors/polygons shared as presentation metadata;
- no free rotation or general 3D physics.

Three.js is pinned through the lockfile and uses `WebGPURenderer` (`three/webgpu`), selecting WebGPU where available and automatically falling back to WebGL2. Materials and post-processing use TSL (`three/tsl`) and node materials; raw GLSL `ShaderMaterial` and `onBeforeCompile` patches are excluded so both backends share the shader graph. Lit quads live in an orthographic 3D scene, preserving the fixed 2:1 view while keeping materials, lights and geometry ready for 3D. Materials and dynamic lights come only from the presentation contract and committed projection; existing bindings use flat albedo until the material model (issue 66) lands. Quality tiers bound local effects; reduced motion freezes animation. Bloom and grading preserve warm source color, with per-tier golden comparison through qualify-wave4. The [scene contract](../apps/web/docs/scene.md) records policy and budgets. CI checks WebGPU and forced WebGL2 under SwiftShader and records the backend and adapter with each check. Real-GPU WebGPU, ANGLE D3D11 and ANGLE GL over D3D12 validation, plus product GPU-complete timing on the owner's box, remain explicit maintainer steps; software rendering supplies correctness evidence only.

#### Observer navigation

The initial Caretaker is not an avatar. Camera pan/zoom changes only the view inside one space. `ChangeViewedSpace` changes authorized presence, interest, and scene subscription without moving an object. Embodied movement remains a normal physical command. Cross-space selection has explicit stay, prompt-to-follow, follow, and denied outcomes. `green-lake-yard@1` initially uses one viewed authority space with nested selectable regions; a typed portal/breadcrumb handoff is required before a second viewed space ships.

### 20.5 Universal interaction

Every selectable entity uses one interaction contract:

- visible name/type/state;
- inspect;
- talk/ask;
- why/history;
- capabilities;
- operator authoring actions when allowed.

The UI clearly labels cognitive character voice, interpreted object/space voice, and canonical operator explanation.

The initial human is an observer/caretaker, not an embodied avatar. Private `Talk` is an attributed Caretaker-to-actor channel and is not spatial sound; nearby actors do not hear it unless a separate public speech action commits through audience resolution. Influence is explicit: conversation can create suggestions, claims, promises or offers; authorized UI actions can give an item or change the environment; operator inspection/authoring is separately labeled. Characters retain bounded autonomy and may decline ordinary suggestions.

### 20.6 Accessibility

- every scene action has an equivalent React/text command;
- a fully usable text-adventure path can observe a space, enumerate perceivable entities, issue permitted interactions and inspect consequences;
- object selection and spatial summaries are keyboard accessible;
- chat, inspector and authoring work without canvas interaction;
- reduced motion, contrast, scalable UI and screen-reader labels are supported;
- important information is never conveyed only by animation/color.

### 20.7 Asset pipeline

Blender and image generation, through [Assetforge](https://github.com/clockgrove/assetforge), can assist authoring. Each world's art lives in that world's repository, under its own style bible. Clockgrove owns the pipeline and proves it on the fixture world's placeholder art. Runtime assets are reviewed 2D outputs:

- sprite sheets/atlases;
- animation manifests;
- masks/footprints;
- map and anchor metadata;
- optional audio.

Pipeline stages:

1. source/import;
2. provenance/license capture;
3. automated validation;
4. human visual review;
5. optimization/atlas build;
6. content-addressed upload;
7. world-pack binding;
8. screenshot/golden-scene test.

Generated assets are never accepted without provenance and review state.

#### Issue 66 amendment: lit 2.5D materials

The direction is lit 2.5D now, with renderer-neutral contracts ready for a future 3D adapter.
World tools produce the lossless material maps and pixel-density renditions; Clockgrove never
derives, paints, estimates or upscales them. Clockgrove owns source acceptance, channel and
rendition atlas packing, and deterministic GPU-compressed delivery with a fallback. Compression
belongs to the atlas build because packing creates new textures, not to per-asset generation.
Dynamic lights, weather intensity and grading keys must arrive through scene projection data,
never be inferred from artwork. Renderers consume supported channels and retain albedo fallback,
the text path and reduced-motion behaviour.

The [material source and style-policy contracts](protocols/shared-contracts.md#lit-material-source-declarations)
connect world-supplied sources to owning asset roles and frame metadata. Image acceptance checks
coverage, ranges and temporal stability before aligned channel/rendition packing. Packed output
includes deterministic KTX2 (Basis Universal UASTC) textures and PNG fallbacks. Scene delivery exposes every channel;
the product adapter can draw albedo while ignoring unsupported maps. Projected light parameters,
weather intensity and grading provide the renderer-neutral lighting seam without inspecting art.

### 20.8 World theme and presentation seam

The shell, the renderer and the renderer-neutral scene protocol are Clockgrove's and name no world. A world supplies its own presentation as inputs at composition: its name and wordmark, design tokens and copy (a versioned shell document), its reviewed static assets and atlas binding, its scene presentation bindings and its model configuration. The [world presentation protocol](protocols/world-presentation.md) defines each input and its version.

- A composition root passes the inputs in; platform modules never import a world directory. Omitted inputs select the neutral platform theme.
- The inputs carry no authority. They change no canonical state and grant no capability; observation, conversation and command grants still apply.
- A world's style bible and DESIGN.md live in its own repository and reach the shell only as its tokens and assets. `STYLE.md` and `BRAND.md` govern Clockgrove's own brand art, not world art.
- The fixture world exercises the seam with its own name, copy and placeholder atlas, and a neutral run with no atlas, so the platform's browser suites need no reference-world content.
- An external world builds and runs the themed shell from a Clockgrove checkout at a pinned commit, as the protocol describes.

---

## 21. Public API and internal contracts

### 21.1 HTTP API

Hono exposes versioned APIs for:

- world/timeline list and metadata;
- world create/provision status/retry/archive and pack installation/upgrade status;
- authorized world/subject/space inspection;
- command submission and receipt lookup;
- session creation/history/turn state;
- context ingestion and status;
- capability installation/binding/approval/revocation;
- changeset compile/validate/preview/promote;
- event/run/decision/memory/rule search;
- branch/replay/export;
- operator budgets and kill switches;
- short-lived artifact access.

OpenAPI is generated from the same Zod contracts. Every mutation accepts a command/idempotency ID. Pagination uses opaque stable cursors.

### 21.2 Internal contracts

The same schema registry covers:

- DO RPC inputs/replies;
- Queue envelopes;
- Workflow inputs and persisted step results;
- realtime envelopes;
- MCP-facing operations;
- effect intents;
- snapshots and replay manifests;
- world-pack manifests.

Unknown incompatible versions fail visibly and enter evidence/DLQ where relevant. Consumers never silently drop unknown event types.

### 21.3 Error model

```ts
type ErrorClass =
  | "validation"
  | "authentication"
  | "authorization"
  | "not_found"
  | "conflict"
  | "budget"
  | "dependency"
  | "retryable_infrastructure"
  | "invariant"
  | "internal";
```

Errors carry stable code, safe message, retry disposition, correlation ID and operator diagnostic reference. Sensitive details stay in protected evidence.

### 21.4 Inspector queries are product APIs

The inspector is built through authorized application APIs, not direct production SQL from the browser. It can traverse:

- command → events → projections;
- event → perceptions → episodes/beliefs;
- decision → inputs → action → outcome;
- turn → retrieval → model/tools → proposed/accepted commands;
- rule source → firing → commands;
- timeline fork → diff → promotion.

---

## 22. Infrastructure architecture

### 22.1 Environment topology

| Environment | Purpose | Isolation |
| --- | --- | --- |
| Local | Credential-free development and deterministic tests | Local Wrangler state, isolated PostgreSQL/pgvector, fake providers |
| CI | Parallel automated validation | Ephemeral PostgreSQL; local Cloudflare runtime; unique test IDs |
| Development | Shared integration | Dedicated Cloudflare resources, Neon project/branch, Better Auth reference environment or selected provider dev app |
| Staging | Production-equivalent qualification | Dedicated account/resources/project/app and sanitized fixtures |
| Production | Hosted GA | Isolated resources, protected credentials and release controls |

Pull-request web previews use fixture data. Full stateful cloud qualification uses the development/staging environments with unique test tenants/worlds; do not create a fragile production-like infrastructure stack per PR.

### 22.2 Cloudflare resources per deployed environment

- one Worker deployment for gateway, static assets, DO exports, Workflows, Queue consumers and cron;
- three SQLite-backed DO namespaces: `WORLD_DO`, `SPACE_DO`, `ACTOR_AGENT_DO`;
- five Workflow bindings: Ingestion, Consolidation, Authoring, AgentJob, TransferRecovery;
- three Queues and three DLQs;
- R2 buckets for artifacts/assets and exports/backups, or isolated prefixes where account policy permits;
- Hyperdrive configuration using a dedicated least-privileged PostgreSQL runtime role;
- AI Gateway with stored provider keys, model policy and budgets;
- Workers Observability logs/traces and Sentry OTLP destination;
- WAF/rate-limit/Turnstile policies for public abuse surfaces;
- environment-specific secrets and service tokens.

One Worker is the initial deployment unit. Package and RPC boundaries allow later Worker/service-binding separation if blast radius or release cadence justifies it.

### 22.3 Neon resources

- separate production and nonproduction projects at minimum;
- dedicated database/branch per staging and production;
- roles for migrations, runtime, read-only support and backup verification;
- pgvector extension;
- PITR/retention configured and tested;
- connection limits and autoscaling set from load evidence;
- Hyperdrive connection uses the runtime role;
- migrations connect directly through controlled CI, not through the public Worker.

### 22.4 Authentication-provider resources

- Better Auth reference schema/migrations and secrets separated across development, staging, and production;
- optional hosted-provider applications/instances separated across environments;
- allowed origins/callbacks pinned per environment;
- production MFA/session/security policy;
- provider event/webhook authenticity and secrets per environment;
- recovery/email/OAuth/session storage and rate-limit policy owned by deployment configuration;
- organization features enabled only if tenant invitation UX uses them.

### 22.5 Observability and analytics

- Cloudflare stores/query runtime logs and traces;
- Cloudflare exports OTel logs/traces to Sentry for correlated application diagnostics;
- Sentry browser SDK correlates release, trace and user-safe principal references;
- PostHog receives only approved product events and non-sensitive properties;
- PostgreSQL stores full authorized product evidence.

Cloudflare's current OTel export covers logs and traces, not custom metrics. Platform metrics use Cloudflare-native telemetry; application counters/histograms are emitted as bounded structured events and derived in the selected operations backend until native custom-metric export is available.

The OTel exporter boundary remains available if operations later justify another destination.

### 22.6 Infrastructure source of truth

- OpenTofu: Cloudflare account resources, DNS/routes, queues, buckets, Hyperdrive, policies, service tokens and provider-supported observability resources;
- Wrangler: Worker entry, bindings, compatibility date/flags, DO migrations, Workflow classes, Queue consumers, cron and static assets;
- Drizzle migrations: PostgreSQL schema/RLS/indexes/extensions;
- checked-in environment manifests: resource names/IDs, domains, model aliases, budgets and retention without secrets;
- provider setup scripts: only for resources lacking reliable IaC support, idempotent and documented.

Infrastructure changes are reviewed like code. Drift checks run on a schedule and before production release.

### 22.7 Naming

Use `rw-{environment}-{resource}` externally. Never include customer names or private world titles in Cloudflare resource names, DO keys, R2 keys, telemetry datasets or database roles.

### 22.8 Secrets

- GitHub Actions uses short-lived/OIDC credentials where supported;
- production secrets are not copied to development;
- model keys are stored in AI Gateway where possible;
- app secrets use Cloudflare secret bindings;
- MCP user/service credentials use the credential-envelope system;
- secret rotation has a runbook and dual-key transition where necessary;
- no secret appears in checked-in `.dev.vars.example`.

---

## 23. Local development

### 23.1 One-command environment

`pnpm dev` starts:

- Wrangler local Worker, Durable Objects, Workflows, Queues, R2 and WebSockets;
- supported isolated PostgreSQL with pgvector;
- database migrations and deterministic seed;
- React/Vite development server or Cloudflare Vite integration;
- scripted model gateway and fake MCP servers;
- local authentication bypass only in explicit development mode;
- local inspector and structured trace output.

The local authentication bypass issues a clearly marked `DevelopmentPrincipal` through a separate composition binding. It cannot compile into staging/production configuration, and a CI test asserts the production gateway has no bypass route.

Hyperdrive local configuration points directly to local PostgreSQL. A separate `pnpm dev:cloud` profile uses real nonproduction Cloudflare/Hyperdrive behavior for qualification.

Local hibernatable WebSocket handlers are testable, but true eviction-with-socket-preservation is a cloud-qualification assertion. Workflow development runs in local Wrangler; remote-development mode is not treated as its substitute.

### 23.2 Developer commands

```text
pnpm install
pnpm dev
pnpm check                 format + lint + types + boundaries
pnpm test                  deterministic unit/package tests
pnpm test:db               PostgreSQL integration and RLS
pnpm test:runtime          local Cloudflare DO/Workflow/Queue tests
pnpm test:e2e              Playwright browser tests
pnpm test:replay           golden replay and state hashes
pnpm test:eval             scripted agent/memory evaluations
pnpm test:cloud            staging qualification; credentials required
pnpm db:migrate
pnpm db:verify
pnpm dev:world
pnpm world:simulate --days 30 --seed ...
pnpm replay:verify <bundle>
pnpm infra:plan <environment>
```

Every command is noninteractive in CI and documented in the root README.

### 23.3 Fixtures

The repository includes:

- the fixture world's beacon pack and neutral reference variant;
- fixed weather/lifecycle histories;
- the social-learning scenario on the neutral reference variant;
- fake external identities/principals/tenants;
- scripted model outputs;
- fake safe, failing, malicious and schema-drifting MCP servers;
- R2 artifact fixtures;
- historic schema/world-pack/replay bundles;
- fault-injection schedules.

CI correctness never depends on a live model or MCP provider.

---

## 24. CI/CD and release engineering

### 24.1 Pull-request pipeline

Required jobs:

1. dependency installation from frozen lockfile;
2. formatting/linting/strict typecheck;
3. package boundary and forbidden-import checks;
4. unit, golden, property and deterministic tests;
5. fresh-database migration plus RLS/integration tests;
6. migration from prior supported release;
7. local DO/Workflow/Queue fault tests;
8. API/event/world-pack compatibility tests;
9. Playwright fixture smoke and accessibility tests;
10. license, SBOM, vulnerability and secret scanning;
11. production bundle size/compatibility check;
12. documentation links and generated contract drift check.

No live model credentials are available to untrusted pull requests.

### 24.2 Main-branch pipeline

- build signed release candidate;
- deploy development;
- run cloud qualification;
- run end-to-end causal trace and north-star subset;
- publish web preview and inspector evidence link;
- retain release manifest and test results.

### 24.3 Staging release

1. verify OpenTofu plan;
2. apply additive infrastructure/database changes;
3. deploy code compatible with old/new schema;
4. run replay fixtures;
5. run two-client/reconnect/hibernation tests;
6. run provider, Workflow, Queue and Hyperdrive fault suites;
7. run security and privacy suite;
8. run production-shaped load/soak;
9. verify dashboards and alerts;
10. approve release manifest.

### 24.4 Production release

- canary by internal tenant/world and feature flag;
- compare SLOs, errors, replay hashes and costs;
- expand gradually;
- use forward fixes for canonical-schema/event issues;
- roll executable code back only when compatible;
- never delete canonical events to imitate rollback.

Release manifest pins:

- git commit and build digest;
- Node/pnpm/TypeScript and lockfile hash;
- Workers compatibility date/flags;
- PostgreSQL migration;
- DO migration tag;
- protocol/event schema set;
- world-pack versions;
- rule/prompt/model policies;
- asset manifest;
- infrastructure revision.

### 24.5 Scheduled validation

- nightly: long simulation, replay, fuzz, memory eval, dependency drift;
- weekly: load/soak, DLQ/reconciliation, provider failure, schema upgrade;
- monthly: backup restore, replay bundle restore and credential-rotation exercise;
- quarterly: disaster, cross-tenant security, deletion/export and hot-space partition rehearsal.

---

## 25. Observability and product evidence

### 25.1 Correlation vocabulary

Every boundary carries the applicable:

- tenant, world, timeline, partition and space;
- subject/object and principal;
- session, turn, run and step;
- command, event, correlation and causation;
- decision, perception, belief and evidence;
- rule/version/firing;
- capability/installation/tool/effect;
- model/provider/prompt/policy;
- release, schema and world-pack version.

Telemetry uses opaque IDs. Authorized operators follow them into PostgreSQL evidence.

### 25.2 Structured event names

Logs use stable names such as:

- `command.received|committed|rejected|deduplicated`;
- `actor.activated|hibernated|rehydrated|conflict`;
- `simulation.advance|late|catchup`;
- `projection.snapshot|patch|gap|reconnect`;
- `fiber.started|recovered|completed|failed`;
- `workflow.started|waiting|completed|failed`;
- `queue.published|retried|dead_lettered`;
- `model.started|completed|abandoned|budget_denied`;
- `tool.requested|approved|completed|uncertain`;
- `memory.formed|revised|contradicted`;
- `rule.fired|suppressed|budget_tripped`;
- `branch.created|replayed|promoted|conflicted`.

Private payloads are never interpolated into log strings.

### 25.3 Operational metrics

Required:

- request/command rate, latency, reject, conflict and dedupe;
- PostgreSQL transaction/query latency, pool saturation and error;
- actor activation, mailbox wait, hibernation and hot-key load;
- simulation lateness and catch-up work;
- projection bytes, fanout, reconnect and snapshot fallback;
- fiber/Workflow duration, recovery, retry and wait;
- Queue age, retry, DLQ and reconciliation;
- model/tool latency, tokens, cost, denial and circuit state;
- memory formation/retrieval/contradiction and evaluation quality;
- rule fanout/causal depth/kill-switch;
- branch creation/replay/hash/retention;
- R2 bytes/hash failures;
- tenant/world cost allocation.

### 25.4 Product and simulation evidence

Product analytics record opaque entity/category identifiers and interaction outcomes, not conversation or private-memory text. The following metrics are release evidence, with targets established through baseline playtests rather than invented percentages:

**Experience**

- proportion of visits that select and converse with an entity;
- distinct entity categories conversed with per visit/cohort;
- Why-trace opens and successful causal traversals per meaningful decision;
- interpreted-perspective disclosure comprehension and user-rated usefulness;
- influence attempts with clear accepted/rejected/consequence lifecycle;
- authored changes successfully compiled, previewed, revised and promoted;
- return visits made to observe later consequences or learned behavior;
- user-rated actor consistency and explanation trust.

**Simulation quality**

- repetitive-action rate and decision diversity under comparable state;
- share of routine decisions completed without a model;
- rate at which an episode, belief, relationship or teaching event measurably changes a later candidate score or action;
- perception/evidence provenance accuracy;
- belief-contradiction handling accuracy;
- live-step versus catch-up/fast-forward material-equivalence rate;
- semantic events per simulated actor-day and threshold-to-noise ratio;
- dormant-world activations and material changes per simulated day.

**Reliability**

- lost acknowledged events, duplicate protected effects and replay mismatches;
- recovery success at every injected crash boundary;
- projection convergence, timer lateness, rule-budget trips and unresolved dispatch age;
- cross-scope and cross-tenant privacy failures.

**Cost**

- model cost per actor-day and conversation turn;
- consolidation cost per actor-week;
- storage and event growth per world-day;
- preview cost per simulated day;
- active and dormant Cloudflare compute per world-hour;
- retrieval, ingestion, graph and vector query cost.

Every dashboard can segment by release, world-pack, timeline kind, actor policy and model route. Thesis metrics are compared to predeclared scenario/cohort baselines; a favorable anecdote cannot replace a failing evaluation.

### 25.5 Inspector

The inspector ships alongside early kernel/journal work. It supports:

- search by every correlation identity;
- before/after canonical state;
- event parents/children;
- actor audiences and perceptions;
- decision candidates and selected action;
- retrieval evidence and access decisions;
- redacted model/tool data;
- run/fiber/Workflow/Queue state;
- rule bindings and budget;
- projection/client acknowledgement;
- branch/replay/hash comparison.

### 25.6 Alert classes

Page:

- possible lost/inconsistent canonical event;
- replay/state-hash mismatch;
- cross-tenant assertion;
- protected-effect uncertainty;
- sustained canonical database outage;
- widespread actor activation failure;
- runaway rule/model-cost breaker;
- simulation lateness beyond policy.

Ticket:

- growing Queue age/DLQ;
- elevated conflicts/reconnect fallback;
- index coverage drift;
- snapshot/backup age;
- provider degradation;
- retention/deletion lag.

---

## 26. Security, privacy, and safety

### 26.1 Trust zones

1. browser/user input;
2. authenticated Worker boundary;
3. authorized application use cases;
4. actor runtime;
5. canonical PostgreSQL/R2;
6. model providers and MCP/external systems;
7. operational telemetry.

Data crossing each zone is schema-validated, scoped and labeled.

### 26.2 Authorization

Initial roles:

- observer;
- participant;
- creator;
- operator;
- developer.

Capabilities narrow privileges. Roles never override timeline, world, subject, privacy or effect policy.

Authorization applies to:

- API and socket connection;
- actor routing/message;
- command;
- session/transcript;
- context/retrieval;
- model inclusion;
- artifact;
- capability/MCP;
- changeset/branch/promotion;
- inspector/export/delete.

### 26.3 Privacy categories and independent authority

Use the accepted [shared-contracts](protocols/shared-contracts.md) representation:

```ts
type PrivacyCategory =
  | "public_scene"
  | "private_cognition"
  | "conversation"
  | "credential"
  | "operator_evidence";

type PrivacyClass = PrivacyCategory;

interface PrivacyCeiling {
  version: 1;
  allowedCategories: PrivacyCategory[];
}
```

A ceiling is a category set; descendants may only narrow it by subset. Categories have no scalar ordering and do not grant audience or application authority. Only `public_scene` may enter shared scene projection. Actor-private, relationship, group, user/session and operator restrictions describe independent audience/scope/access policies rather than additional category enum values. Credential secrecy and telemetry-safe payload rules remain enforced even where categories overlap in a permitted context.

Privacy controls storage, retrieval, model inclusion, projection, inspector access, encryption, retention, export and deletion. Cognitive documents, learned skills, policy artifacts/bindings/evaluations and their source manifests remain private canonical cognition; runtime evaluator caches are reconstructible.

### 26.4 Prompt injection and excessive agency

- system policy and grants are loaded from protected stores;
- user/document/tool text is labeled untrusted;
- retrieved instructions cannot change capability policy;
- tools are minimized per turn;
- arguments/results are independently validated;
- external writes require effect policy and often approval;
- domain commands reauthorize and validate regardless of model claim;
- causal depth, time, token, call, output and dollar budgets are enforced outside prompts.

### 26.5 Network and MCP safety

- allowlisted protocols and destination policy;
- Cloudflare/SDK SSRF protections plus application host policy;
- no link-local/metadata/private targets through remote HTTP;
- redirect and DNS rebinding controls;
- response size/time/content limits;
- OAuth state/PKCE, issuer and tenant-bound callback validation;
- schema drift disables affected tools until reviewed;
- per-server circuit breaker and global kill switch.

### 26.6 Retention, deletion, and export

Separate public world history from personal/private payloads.

Deletion workflow:

1. authorize and create deletion case;
2. identify PostgreSQL, vector, R2, DO cache and provider data;
3. tombstone identity where public causal history must remain;
4. delete/crypto-shred protected payloads;
5. rebuild affected summaries/indexes;
6. invalidate actor/runtime caches;
7. wait for backup-expiration policy;
8. produce verified audit result.

Exports contain authorized world data, sessions/evidence, manifests, asset references and replay bundles in documented formats.

Hosted defaults begin with 30-day retention for raw prompts/model/tool payloads, longer durable retention for user-visible transcripts subject to tenant policy, and reconstruction-safe deletion of derived embeddings/summaries. Every class is configurable and surfaced in administration; release tests pin the active policy.

Canonical world replay never depends on retained raw model/tool payloads: behavior-affecting results are represented by semantic events. Exact replay of an individual agent execution is available only while its protected artifacts remain; after retention, hashes and semantic outcomes remain but deleted private payloads are not reconstructable.

### 26.7 Abuse and spend

- WAF, Turnstile and per-IP/principal rate limits;
- tenant/world/session/actor token and dollar budgets;
- concurrent run/fiber limits;
- Queue backpressure;
- branch size/age limits;
- MCP and model circuit breakers;
- rule kill switches;
- operator pause/read-only mode;
- budget reservation before expensive Workflow launch.

---

## 27. Testing and evaluation architecture

### 27.1 Test layers

| Layer | Tooling | Required proof |
| --- | --- | --- |
| Contract | Vitest, Zod goldens | schema compatibility, round trips, unknown-version failure |
| Kernel | Vitest, fast-check | determinism and domain invariants |
| Persistence | Vitest + real PostgreSQL/pgvector | append atomicity, locks, RLS, replay, migration |
| Actor runtime | Cloudflare Vitest pool/Wrangler | lifecycle, interleaving, alarms, hibernation, RPC |
| Fibers/Workflows | Cloudflare test APIs | recovery, retry, approval, cancellation |
| Queues | local/runtime tests | duplicate, delay, poison, DLQ, reconciliation |
| Agent/eval | scripted model/MCP | grounding, stale state, safety, budgets |
| Realtime | Vitest + Playwright | convergence, interest, reconnect, privacy |
| UI | Testing Library + Playwright | interactions, inspector, authoring, accessibility |
| Load | k6 plus scenario drivers | hot space/actor, fanout, catch-up, cost |
| Recovery | fault harness | database/provider/runtime/deploy failures |
| Cloud qualification | staging | behaviors local emulation cannot prove |

### 27.2 Package test obligations

#### contracts

- branded ID validation and deterministic address hashing;
- schema golden files;
- compatibility matrix;
- redaction and safe error serialization.

#### domain/kernel

- transition examples;
- property invariants;
- canonical serialization/hash;
- named random stream stability;
- exact versus aggregate time;
- non-raccoon world-pack conformance.

#### application/persistence

- command idempotency and request-hash mismatch;
- concurrent expected-revision conflicts;
- event/projection/schedule/dispatch atomicity;
- RLS cross-tenant denial;
- snapshot/replay;
- event upcasters and projection rebuild.

#### runtime

- explicit initialization;
- request interleaving/mailbox order;
- PostgreSQL commit/response crash windows;
- alarm generation and retry;
- socket attachment recovery;
- actor routing epoch and transfer states.

#### cognition

- multiple session ordering;
- fiber recovery in every phase;
- authorization-first retrieval;
- scripted model/tool retries;
- stale proposal handling;
- memory provenance/privacy/behavioral effects.

#### authoring

- changeset validation;
- branch effect isolation;
- fast-forward;
- semantic diff;
- live-head rebase/conflict;
- rule loop budgets.

#### web

- projection reducer;
- duplicate/stale patch behavior;
- scene adapter contract;
- object selection/chat/why;
- branch switching;
- canvas-independent accessibility.

### 27.3 Fault matrix

Inject failure:

- before/after command receipt claim;
- before/after event append/commit;
- after commit before DO cache/broadcast/reply;
- during DO hibernation/redeploy;
- during model stream and after provider completion;
- before/after tool side effect;
- before/after Queue publish/ack;
- during Workflow step and approval wait;
- during R2 upload/read;
- during snapshot creation/replay;
- during cross-space transfer state;
- during branch promotion.

Each test asserts canonical state, idempotency, user-visible status, evidence completeness, and safe recovery.

### 27.4 Cloud qualification

Staging verifies:

- real DO placement/restart and hibernating sockets;
- real Hyperdrive interruption/connection behavior;
- Workflows replay, wait, pause/resume/terminate and deployment compatibility;
- Queue redelivery and DLQ;
- R2 integrity;
- AI Gateway routing/failure;
- authentication-provider session/event/revocation behavior;
- OTel propagation/export;
- production bundle/runtime limits.

### 27.5 Thesis evaluations

- users converse with multiple entity types;
- interpreted objects remain grounded rather than gimmicky;
- “why?” explanations improve understanding;
- memory/social learning causes recognizable later behavior;
- authoring preview is faster/safer than raw editing;
- sleeping worlds remain legible/interesting;
- the non-raccoon fixture needs no engine changes.

---

## 28. Reliability and capacity objectives

Initial GA design budgets:

| Objective | Target |
| --- | --- |
| Lost acknowledged canonical events | Zero |
| Duplicate protected effect | Zero within declared idempotency domain |
| Supported replay mismatch | Zero |
| Cross-tenant authorization failure | Zero |
| Command API availability | 99.9% monthly |
| p95 accepted command commit | < 300 ms excluding deliberate durable jobs |
| p95 visible projection after commit | < 750 ms |
| p95 reconnect to usable state | < 3 seconds |
| p95 ordinary chat first token | < 3 seconds excluding provider outage |
| World-reaction dispatch p95 | < 2 seconds |
| Ordinary oldest dispatch age | < 30 seconds |
| Live simulation lateness | < 5 seconds under supported load |
| PostgreSQL RPO | Zero for committed transactions |
| Service recovery objective | < 15 minutes for ordinary platform incident |

Capacity fixtures represent:

- 50 active cognitive characters;
- 500–2,000 visible/passive objects per neighborhood;
- up to one million logical actors/world objects in target-scale fixtures, with only a bounded active/visible subset;
- multiple concurrent preview timelines;
- two to hundreds of viewers per space;
- bursty conversation and model work;
- accelerated preview simulation.

These are qualification fixtures, not hard product caps. “One million” is a world target, not a guarantee of simultaneous activation, visibility, or cognition. Record the measured limit, active-density envelope, hot-leaf behavior, and cost curve for each release.

---

## 29. Development waves

Waves are cumulative, substantial, mostly sequential workstreams containing numerous capability Objectives and Work Items. Each full wave exits through its declared evidence and leaves the main branch deployable. Detailed packets are responsibility/dependency guidance rather than a one-packet/one-Objective mandate. The accepted [incremental-delivery ADR](adr/clockgrove-adr-incremental-wave-delivery-and-evidence.md) governs Objective acceptance, bounded local-readiness exceptions, early product checkpoints, and qualification.

Prove the living yard along Waves 1–4, one durable cognitive actor in Wave 5, recognizable learning and bounded policy reuse in Wave 6, and typed safe authoring before natural-language compilation in Wave 7. Integrate these already exercised slices in Wave 8. An accepted Objective does not qualify its entire wave, and pending full-wave obligations remain explicit.

Freeze one capability and intended final candidate, use one qualification owner and independent review, and run ordinary acceptance sequentially. Parallelism is optional and limited to independent work with explicit ownership and isolated resources. Compare immutable provenance, canonical replay/ordering and required literal citations exactly; compare other outcomes through declared semantic invariants. The ADR specifies the comparison boundaries and proportional rerun rules.

### Development tooling

Clockgrove product delivery begins at Wave 0. External development tools such as `clockgrove/factory` may operate this repository through GitHub Issues, branches, pull requests, checks, and repository guidance. Clockgrove remains buildable, testable, deployable, and operable without them, and their state is never world/runtime authority.

### Wave 0 — Repository, contracts, and production skeleton

**Purpose:** Establish the final seams and executable topology before domain volume accumulates.

**Execution boundary:** Wave 0 has no product/runtime dependency on Factory. If `clockgrove/factory` is used to execute the work, it operates through ordinary repository interfaces and its state does not become product/runtime authority.

Deliver:

- pnpm/Turborepo monorepo and package dependency enforcement;
- strict TypeScript, lint/format, CI and root `AGENTS.md`;
- Apache-2.0, contribution/security policies, SBOM and provenance inventory;
- `contracts` package: IDs, actor addresses, execution context, privacy, errors, command/event/queue/realtime envelopes;
- `application` ports and fake adapters;
- explicit decision coverage through accepted ADRs/contracts and focused new ADRs when needed;
- supported isolated local PostgreSQL/pgvector and Wrangler runtime;
- OpenTofu/Wrangler environment skeleton;
- Better Auth reference integration, adapter conformance, and production-safe local bypass separation;
- empty WorldDO, SpaceDO and ActorAgentDO exports;
- Cloudflare/Sentry/PostHog configuration skeleton;
- one authenticated no-op request with correlation identity.

Amended (2026-10-27): the project license is MIT, not Apache-2.0. `LICENSE` holds the standard MIT text with `Copyright (c) 2026 Clockgrove`; `CONTRIBUTING.md` accepts contributions under the MIT License; `SECURITY.md` describes private vulnerability reporting. `provenance.json` is the repository provenance manifest of §2.3: it records content that is not original Clockgrove work and names the CycloneDX SBOM that `scripts/supply-chain.mjs` writes for npm dependencies, and `pnpm check` validates it.

Tests:

- dependency boundaries;
- schema/address golden vectors;
- production build proves no auth bypass;
- fresh local setup on clean machine/container;
- staging no-op path browser → Worker → DO RPC → PostgreSQL evidence.

Exit:

> The final production topology can be deployed, authenticated, traced and tested even though the world is not yet simulated.

### Wave 1 — Pure world model and world-pack foundation

**Purpose:** Build the reusable deterministic engine without infrastructure dependencies.

Deliver:

- `domain`, `kernel` and `world-pack-sdk`;
- component/archetype model;
- canonical time, units, hashing, named PRNG and deterministic IDs;
- commands/events for world, objects, components and schedules;
- containment, navigation anchors, polygon geofences and movement segments;
- deterministic audience/perception resolver with private cognitive outputs and client-view inputs;
- weather/rain, food/water, tree growth, needs and utility decisions;
- lifecycle, reproduction, birth, aging and death state machines;
- bounded rule AST/evaluator primitives;
- the fixture world's packs; the reference world's pack in its own repository;
- headless simulator CLI and decision-trace output.

Tests:

- all kernel properties and golden transitions;
- all named `green-lake-yard@1` scenario kernels with scripted cognition where needed;
- 30-day/one-year accelerated deterministic runs;
- small-step versus aggregate progression;
- stable hashes across Node and Workers;
- world-pack conformance and migration fixtures;
- no forbidden I/O imports.

Exit:

> The same seed, inputs and versions produce identical world state, decisions and hashes; the fixture world and the external reference world require no engine modification.

### Wave 2 — Canonical journal, projections, replay, and evidence

**Purpose:** Make the headless world durable, searchable and rewindable through final database semantics.

Deliver:

- PostgreSQL table families, RLS and roles;
- Journal append/command receipt/stream and partition heads;
- authoritative physical projections and schedules;
- event dispatch ledger and effect intents;
- snapshots, artifact metadata and R2 adapter;
- replay/upcasters/projection rebuild;
- timeline and partition-head vector model;
- inspector APIs/CLI for commands, events, state and decisions;
- export/replay bundle v1.

Tests:

- concurrent append/expected revision;
- request-hash/idempotency behavior;
- commit crash-window matrix;
- event/projection/schedule/dispatch atomicity;
- RLS cross-tenant attacks;
- snapshot corruption and replay mismatch;
- migrations from every supported fixture;
- restore/export/replay verification.

Exit:

> No acknowledged mutation is lost or duplicated under injected failures, and a snapshot plus events reproduces the live state hash.

### Wave 3 — Cloudflare actor fabric and perpetual scheduling

**Purpose:** Place final ownership boundaries around the durable headless world.

Deliver:

- Worker gateway and actor router;
- WorldDO runtime coordinator and routing epochs;
- SpaceDO mutation mailbox, hydration, command path and alarm scheduler;
- ActorAgentDO initialization/session skeleton;
- Queue publishers/consumers/DLQs and reconciliation;
- typed Workflows and run linkage skeletons;
- cross-space transfer protocol with two fixture spaces;
- actor/runtime inspector state;
- hibernation-compatible connection metadata.

Tests:

- DO init/restart/migration;
- request interleaving and mailbox order;
- alarm retry/catch-up/one-alarm behavior;
- PostgreSQL/Hyperdrive outage boundaries;
- Queue duplicates, poison and DLQ;
- transfer crash at every state;
- actor key privacy and routing epoch changes;
- live-versus-sleep progression equivalence.

Exit:

> A world sleeps, wakes, advances and survives deployment/failure through the production actor path with PostgreSQL remaining canonical.

Amended (2026-10-19): the cross-space transfer protocol with two fixture spaces and its "transfer crash at every state" tests move after GA to Wave 11, with the per-space state split (§35). Wave 3 runs one SpaceDO per world partition with awake/asleep fidelity. Its other scope decisions are in the Wave 3 plan.

### Wave 4 — Shared visual projection and inspector UI

**Purpose:** Render the real world and make causality inspectable before adding LLM complexity.

Deliver:

- React shell and provider-neutral authentication UI;
- Three.js lit isometric scene and typed adapter, under the accepted [renderer ADR](adr/clockgrove-adr-renderer-bake-off.md);
- scene WebSocket upgrade through SpaceDO;
- authorized snapshot, patch and transient lanes;
- interest/audience resolution;
- movement interpolation, weather and day/night;
- selectable universal interaction card;
- event/decision inspector;
- timeline metadata and text-first scene alternative;
- asset pipeline proven on the fixture world's art; the reference world's first reviewed set is delivered in its own repository.

Tests:

- projection reducer/golden scenes;
- two-client convergence;
- privacy-different interest sets;
- duplicate/reordered/stale patches;
- hibernation/restart/reconnect/snapshot fallback;
- Playwright accessibility and visual regressions;
- connection/fanout load.

Amended (2026-11-06): cross-space connection transfer leaves the Wave 4 tests. PRD §33 item 4 (v0.5.10) runs one space owner per world partition and moves cross-space transfer to Wave 11.

Exit:

> Multiple browsers converge on the same authorized living world through hibernation, interruption and deployment, and a user can inspect why one deterministic action occurred.

### Wave 5 — Durable conversations, models, capabilities, and MCP

**Purpose:** Add the actor interaction thesis without letting model execution become world authority.

Deliver:

- complete session/message/turn/run evidence model;
- multiple sessions per subject;
- ActorAgentDO session channels and recoverable turn fibers;
- context assembly, streaming and stale-revision policy;
- ModelGateway using Vercel AI SDK and Cloudflare AI Gateway;
- scripted provider and one production model alias;
- internal inspect/why/world-command capabilities;
- installation/binding/grant/approval model;
- remote HTTP MCP discovery, OAuth/token path, schema pinning and revocation;
- one read-only remote MCP fixture and one approval-gated external effect;
- stateless first-party world MCP endpoint.

Tests:

- turn recovery at every state;
- concurrent sessions and cognition commit conflicts;
- model interruption/duplicate attempt;
- tool idempotency/uncertain effect;
- malicious prompt/tool/schema/SSRF fixtures;
- capability scope and revocation;
- provider outage and deterministic fallback;
- token/cost/concurrency budgets.

Exit:

> A user can hold multiple durable conversations with Stevie or an interpreted object, survive failures, use governed tools, and trace every response/action to authorized evidence.

### Wave 6 — Context ingestion, memory, relationships, and learning

**Purpose:** Make accumulated experience alter future behavior with provenance.

Deliver:

- IngestionWorkflow and document/rendition/chunk model;
- authorization-first FTS/vector/entity retrieval;
- perceptions, episodes, claims/evidence, beliefs and relationships;
- cognitive event streams/projections;
- memory proposal and validation pipeline;
- ConsolidationWorkflow at actor and family/space scope;
- contradiction and accessibility revision;
- `Tell/Teach/Demonstrate/Lead`;
- memory/relationship/decision inspector;
- privacy and retention behaviors;
- resident-authored field guides through governed consolidation, attributed testimony/verification/revision, separately authorized sharing and source-aware reading;
- governed versioned Markdown documents/change sets, actor-authored `SKILL.md`, and private canonical cognitive versions;
- total bounded policy DSL/validator, immutable artifact, scope-specific binding, evaluation evidence including abstention, governed adoption, source invalidation/expiry and novelty fallback;
- scoped raw/normalized/interpreted external observations with provenance, time mapping and replay modes.

Tests:

- fixed retrieval/provenance corpus;
- structured-event direct graph projection;
- observation/hearsay distinction;
- contradiction and trust;
- actor/session/world scope leakage;
- consolidation faithfulness;
- branch/replay of behavior-affecting cognition;
- Gracie teaches a kit, later verification changes confidence, later decision changes;
- controlled learning versus an unchanged control, contradiction/revision, stable policy reuse without a model call, source-change invalidation, novelty fallback and sampled shadow comparison.

Exit:

> A later decision is reproducibly changed by attributed experience or teaching and can be explained without exposing unauthorized cognition.

### Wave 7 — Rules, preview timelines, and conversational authoring

**Purpose:** Let operators safely modify and experiment with the world through the final rewindable-journal model.

Deliver:

- complete event/geofence/schedule/threshold rule triggers;
- fanout/depth/cooldown/cycle budgets and kill switches;
- first-class preview timeline creation;
- snapshot-plus-overlay branch storage;
- branch-local actors/schedules/cognition;
- enforced external-effect isolation;
- AuthoringWorkflow and typed changesets;
- visual/semantic diff and fast-forward;
- semantic rebase/promotion;
- one bounded counterfactual Why comparison over reproduced deterministic kernel/compiled-policy decisions;
- branch retention/export.

Tests:

- deterministic rule ordering/dedupe;
- rule-loop containment;
- fork independence and PRNG divergence;
- preview credential/effect leakage attacks;
- branch conversations/memories;
- pond and street-safety scenarios;
- live-head conflict/rebase;
- promotion proves no synthetic event/tool result copied.

Exit:

> An operator prompts a change, validates it, previews and accelerates consequences, talks to branch actors, and promotes only newly authorized intent.

### Wave 8 — Complete living neighborhood

**Purpose:** Fill out the product experience on top of proven foundations.

Deliver:

- full lifecycle UX for births, growth, aging and death;
- household/family/social routines and relationships;
- richer weather, resources, shelter and vegetation;
- world-interest feed and overnight summaries;
- object/space conversation disclosure and polish;
- authored rules and ecological reactions;
- complete reviewed cartoon-isometric asset set, in the reference world's repository;
- north-star rain → decision → explanation → memory → teaching → later behavior → policy reuse/novelty fallback chain;
- provenance-recorded live external observation and governed actor-initiated MCP research, with captured replay fixtures for deterministic tests;
- observer/caretaker influence modes without forced avatar embodiment;
- readable field-guide learning/revision and controlled counterfactual Why journeys with truthful disclosure;

Tests:

- long soak and ecological balance fixtures;
- all ten scenarios in 7.13 through their full deployed product paths;
- model-free world remains active/legible;
- repetition/diversity metrics;
- death/session/memory/successor policy;
- user experience evaluations;
- complete causal/replay/privacy/recovery qualification.

Exit:

> The whole product thesis is visible in one continuously operating neighborhood, not merely in disconnected subsystem demos.

The neighborhood is Raccoon World, delivered in [clockgrove/raccoon-world](https://github.com/clockgrove/raccoon-world) against the platform at a pinned commit. Clockgrove delivers the platform capabilities world-agnostically and proves them on the fixture world; the reference world's repository delivers the pack, art, theme and demo journeys. The exit needs both.

### Wave 9 — GA operations and open-source release

**Purpose:** Prove the system can be operated, trusted and extended.

Deliver:

- tenant admin, invitations, moderation hooks and quotas;
- retention, deletion, export and audit workflows;
- billing meters without coupling world semantics to a billing vendor;
- production SLO dashboards/alerts;
- feature, rule, model, MCP and world kill switches;
- backup/restore/DR and replay verification;
- load/soak/hot-space partition procedures;
- security review and abuse controls;
- browser/accessibility support matrix;
- public API, MCP, world-pack and architecture docs, including how an external world builds against Clockgrove;
- release automation, support runbooks and contribution workflow.

Tests:

- full cloud qualification and north-star suite;
- restore into clean environment;
- deletion/export verification;
- cross-tenant penetration suite;
- provider/platform outage exercises;
- cost ceilings by tenant/world/actor/session;
- license/dependency/asset audit.

Exit:

> All GA objectives have measured evidence, P0/P1 runbooks are rehearsed, and the repository can reproduce the hosted architecture locally and in a clean Cloudflare/Neon environment.

GA ships the platform. Raccoon World ships beside it as a separate reference world from its own repository, pinned to the released Clockgrove commit.

### Wave 10 — Self-service multitenancy, signup, and workspace onboarding

**Purpose:** Add the provider-neutral Management Plane after technical/open-source GA.

Deliver public signup, personal/shared workspaces, invitations, tenant-scoped resource ownership, onboarding, lifecycle/deletion, and Better Auth reference integration with Clerk conformance as an optional adapter. Keep authentication identity separate from Clockgrove tenant and world authority.

Exit:

> A new principal can create or join a workspace and provision a bounded starter world without any provider-specific identifier becoming a domain key.

### Wave 11 — Multiuser worlds, personas, attribution, and world-local inventory

**Purpose:** Make a world a durable social place with MUD/MOO-style participation.

Deliver world invitations and memberships, durable world personas, ephemeral presence, foundational action/authority attribution, concurrent mutation rules, persona inventory, inherited mobility policy, moderation, and the axe scenario inside one world. Do not implement cross-world object portability.

Exit:

> A visitor joins a friend's world, drops a permitted axe, and the friend later picks it up and chops a permitted tree; identity, possession, authority, action, and consequences remain inspectable across disconnects and retries.

### Wave 12 — Optional metering, prepaid credits, and billing

**Purpose:** Add commercially safe admission for variable-cost hosted work without changing world truth.

Deliver one shared wallet per billing account, immutable attributed usage, versioned rating, Redis atomic world-credit-lease allocation, PostgreSQL accounting/rebuild, Runtime-local lease enforcement, execution entitlements, budgets, purchases, auto-recharge, Management-only Stripe collection, refunds/chargebacks, and explicit zero-balance/nonpayment behavior.

Exit:

> Every charged unit is traceable to immutable world attribution and rated usage; one shared wallet safely leases bounded authority across many worlds; Redis, Runtime receipts and PostgreSQL reconcile after retries/outages; and no payment-provider callback can create a world event directly.

---

## 30. Coding-agent execution protocol

`clockgrove/factory` may be used to execute packets in Waves 0–12, but it is external development tooling rather than a product/runtime control plane. The packet definitions, repository guidance, CI, GitHub checks, human approvals, and committed evidence below remain the portable project interfaces regardless of which development automation is used.

### 30.1 Root guidance

Create a root `AGENTS.md` containing:

- fixed decisions and forbidden shortcuts;
- package dependency graph;
- canonical developer commands;
- test expectations by changed path;
- migration/event compatibility rules;
- privacy/logging rules;
- how to use fixtures and fault injection;
- when an ADR is required;
- definition of done.

Each package has a concise README and optional local `AGENTS.md` for package-specific invariants.

### 30.2 Work-packet template

A work packet states product intent. It becomes a Factory Objective, and Factory's compiler reads the repository and decides the Work Items, files, tests, commands, migrations and evidence layout, so the packet does not pre-plan them. Every packet includes:

```text
ID and title
Owning wave and plan sections
Goal: the user-visible or architectural outcome
Exit items: observable facts that must be true when it is done
Invariants: canonical vs derived/ephemeral state, authorization/privacy, failure and idempotency
Dependencies and readiness conditions
Explicit non-goals
Canonical sources
```

When an exit item needs a specific proof, such as an exact value, an independent recomputation or a golden, state that in the exit item.

Avoid broad tasks such as “implement memory.” Prefer independently reviewable capability Objectives with one owner and explicit contracts; Factory splits them into Work Items or child Objectives. Declare Objective acceptance separately from full-wave qualification. Record exact prerequisite evidence and pending obligations for any local-readiness exception under the accepted delivery ADR.

Add the acceptance surface, explicit non-goals, evidence comparison rules, and existing resource/provider bounds to the Objective.

### 30.3 Agent permissions

Coding agents may:

- implement behind approved ports;
- add tests/fixtures;
- improve internals without changing semantics;
- tune configuration in declared ranges;
- propose ADRs.

They may not silently:

- add a managed service/database/runtime actor class;
- bypass Journal for canonical mutation;
- let model/tool code write canonical tables;
- introduce an unversioned wire/event payload;
- weaken tenant/privacy scope;
- change event meaning or rewrite history;
- persist a second canonical projection in DO SQLite;
- route ordinary chat through Workflow;
- merge preview history;
- add arbitrary plugin execution.

### 30.4 Review boundaries

Use small changesets:

- one contract change and its consumers;
- one migration family;
- one kernel capability plus fixtures;
- one actor RPC path;
- one fault scenario;
- one UI vertical interaction.

Contract/migration changes land before dependent parallel work. Generated OpenAPI/JSON Schema and golden fixtures change in the same commit as their sources.

### 30.5 Merge gate

Before merge:

- `pnpm check`;
- affected unit/property/integration suites;
- migration verification if schema changed;
- replay compatibility if event/kernel changed;
- generated-contract drift check;
- privacy/authorization tests if data path changed;
- evidence/telemetry assertion if runtime path changed;
- docs/ADR updated;
- clean local bootstrap remains valid.

### 30.6 Decision coverage

These topics require explicit decision coverage, not fourteen new ADRs before the next Objective. Reuse the accepted ADRs, contracts and implemented foundation decisions; create a focused ADR only for an unresolved cross-wave decision. License, simulation-time mapping, provider/feed routes, pilot rubric, and cognitive-document limits/inspection remain human-owned choices at their first consumer.

1. canonical PostgreSQL authority and rebuildable runtime state;
2. logical actor identity versus physical placement;
3. WorldDO/SpaceDO partitioning and cross-space ownership;
4. stream/partition ordering and absence of global causal order;
5. deterministic time, fixed-point units, PRNG and state hashing;
6. model/tool mutation boundary and recorded nondeterminism;
7. fibers versus typed Workflows;
8. Queue channels, dispatch and external-effect idempotency;
9. authentication-provider identity versus PostgreSQL authorization;
10. privacy classes, RLS, retention and deletion;
11. first-class timelines, effect isolation and semantic promotion;
12. world-pack/data versus trusted code-extension policy;
13. product evidence versus operational telemetry;
14. open-source license and Cloudflare production dependency.

### 30.7 Requirement traceability

| Product requirement | Implementation sections | Primary proof wave |
| --- | --- | --- |
| Product thesis, interaction loop, roles and non-goals | 2.3–2.8, 27.5, 35 | every wave |
| V-Worlds/MUD lineage without legacy coupling | 2.3, 2.9, 4, 7 | 0–1 |
| Reference neighborhood and north-star story | 2.7, 7.13, 8, 23.3 | 1–9 |
| Formal object/component/archetype model | 4, 7.2–7.3, 8 | 1 |
| Perpetual time, offline catch-up and sleeping actors | 7.4–7.5, 7.9–7.10, 11 | 1–3, 8 |
| Weather, resources, growth, needs and lifecycle | 7.8, 7.13, 11 | 1–3, 8 |
| Movement, containment, portals, regions and geofences | 7.6, 7.12, 18 | 1, 7–8 |
| Subjective perception and V-Worlds-style audiences | 7.7, 12.4, 16.4 | 1, 4, 6 |
| Reflex/utility/LLM cognition escalation | 7.11, 14.5, 14.8 | 1, 5, 8 |
| Every object logically addressable/chat-capable | 4, 10, 14, 20 | 3–5 |
| Disclosed embodied, interpreted and operator voices | 2.5, 14.1, 20.2–20.5 | 4–5 |
| Multiple sessions per actor | 4, 14 | 5 |
| Searchable agent runs/model/tool evidence | 9, 14.7, 21.4, 25 | 2, 5 |
| Bounded influence and validated actor agency | 2.5–2.6, 3, 14.6, 20.2–20.5 | 4–5 |
| Scoped ingested context | 16 | 6 |
| MCP installation and tools | 17 | 5 |
| First-party episodes, claims, beliefs, summaries and provenance | 16.3–16.5 | 6 |
| Dreaming/consolidation by actor, relationship, space and world | 15.3, 16.7 | 6 |
| Social/generational learning and emerging favorite places | 7.13, 16.8 | 6, 8 |
| Resident-authored field guides, governed sharing and testimony/verification | 16.7–16.8, 16.11, 26 | 6, 8–9 |
| Grounded three-level Why/explanation | 7.11, 16.9, 20.2, 21.4 | 1–6 |
| Graph-shaped entities, relationships and facts on PostgreSQL | 9, 16.3, 16.6 | 6 |
| Event-sourced physical/cognitive journal and triggers | 9, 15, 18 | 2–3, 7 |
| Rewindable preview branches and exact/experimental replay | 19 | 2, 7 |
| Counterfactual Why with one controlled deterministic intervention | 16.9, 19.6 | 7–9 |
| Natural-language world CRUD through typed changesets | 18.2–18.4 | 7 |
| Death-triggered successors and dynamic geofenced events | 7.8, 7.13, 18.1, 18.4 | 1, 7–8 |
| Multiplayer client convergence and interest filtering | 12, 20 | 4 |
| Cartoon isometric browser world | 20 | 4, 8 |
| Text-adventure-equivalent accessible interaction | 20.2, 20.5–20.6 | 4–5 |
| Telemetry, causal inspector and product evidence | 21.4, 25 | every wave |
| Multitenancy/privacy/security | 13, 22, 26 | every wave, 9 |
| Open source and local execution | 5, 23, 29 | 0, 9 |
| MMO-scale evolution | 4, 10, 12, 28 | 3–4, 9 |
| Product metrics and falsifiable evaluation | 2.4, 25.4, 27.5 | 4–9 |
| Future quests/gamification reuse existing primitives | 18.5 | after rule/authoring foundation |
| World-local personal inventory and inherited object mobility | 6, 7.6, 10.8–10.9, 13 | 1–4, 7, 10–11 |
| Immutable action and authority attribution | 6, 9, 13, 25 | every wave; full multiuser UX in 11 |
| Provider-neutral signup and world personas | 13, 20, 22 | 0, 4, 10–11 |
| Redis-backed prepaid admission and PostgreSQL accounting | 25, 33 | 12 |
| Crash recovery and distributed failure correctness | 9, 10, 15, 27.3–27.4, 32 | every wave |

---

## 31. Ordered work-packet backlog

These are responsibility/dependency scopes for the full GA system, grouped into numerous capability Objectives within the substantial sequential wave workstreams. IDs are not a fixed Objective count or a mandate for maximum parallel execution; reuse accepted capabilities and instantiate only remaining work. Before execution, each item is instantiated with the template in 30.2, exact owned paths, frozen input contracts and test commands.

### Foundation

1. **RW-0001 — Bootstrap monorepo:** workspace, Turbo tasks, strict TS, lint/format, dependency-cruiser, CI.
2. **RW-0002 — Architecture guardrails:** root `AGENTS.md`, ADR template, fixed-decision ADRs, package READMEs.
3. **RW-0003 — Branded identity package:** all ID types, UUIDv7/deterministic ID sources, actor address hashing and golden vectors.
4. **RW-0004 — Execution/privacy/error contracts:** Zod schemas, redaction and safe serialization.
5. **RW-0005 — Command/event/queue/realtime schemas:** registry, `AttributionEnvelope`, `AuthorityDecision`, JSON Schema generation, compatibility fixtures.
6. **RW-0006 — Application ports and fakes:** Journal, Router, Artifact, Model, Capability, Evidence, Clock.
7. **RW-0007 — Local data stack:** supported isolated PostgreSQL/pgvector fixture, migration runner and health checks.
8. **RW-0008 — Cloudflare skeleton:** Worker, three DO namespaces/classes, Workflow/Queue bindings and local smoke.
9. **RW-0009 — Authentication-provider boundary:** project-owned port/conformance suite, Better Auth reference adapter, optional Clerk adapter, React sign-in, Worker verification, internal principal mapping and dev-bypass isolation tests.
10. **RW-0010 — Correlation path:** no-op authorized request through Worker/DO/PostgreSQL/Sentry-safe telemetry.

### Kernel

11. **RW-0101 — Canonical time/units/random/hash:** cross-runtime deterministic fixtures.
12. **RW-0102 — Components/archetypes/world-pack manifest:** validators and fixture pack.
13. **RW-0103 — Kernel executor:** command/result contract and state reducer.
14. **RW-0104 — Containment/inventory invariants:** world/timeline-local persona containers, inherited mobility policy, property tests.
15. **RW-0105 — Spatial/geofence/navigation/audiences:** deterministic path, crossing, loose-quadtree index, interest and differential-perception fixtures.
16. **RW-0106 — Scheduler/offline aggregation:** exact/aggregate/skippable policies.
17. **RW-0107 — Weather/resources/growth:** rain, food, water and tree lifecycle.
18. **RW-0108 — Needs/utility/movement:** decision traces and movement segments.
19. **RW-0109 — Reproduction/aging/death:** lifecycle state machine.
20. **RW-0110 — Reference and fixture packs:** conformance suite, all named scenario goldens and simulator CLI; the reference pack's goldens run in its own repository.

### Canonical data

21. **RW-0201 — Identity/tenant/RLS schema.**
22. **RW-0202 — World/timeline/partition/object schema.**
23. **RW-0203 — Streams/events/command receipts.**
24. **RW-0204 — Journal transaction with concurrency/idempotency tests.**
25. **RW-0205 — Projection/schedule transaction integration.**
26. **RW-0206 — Dispatch/effect intent schema and publisher reconciliation.**
27. **RW-0207 — ArtifactStore inline/R2 threshold and hash validation.**
28. **RW-0208 — Snapshots/replay/state-hash verification.**
29. **RW-0209 — Migration/upcaster compatibility harness.**
30. **RW-0210 — Inspector API/CLI first causal chain.**

### Cloudflare actor runtime

31. **RW-0301 — Actor routing and DO names:** pure address routing, opaque names, logical/runtime identity separation, routing/authority epochs, namespace migrations and golden vectors.
32. **RW-0302 — WorldDO runtime coordinator:** applied lifecycle, clock policy, partition/runtime-cell directory, routing/authority epochs, credit-lease/execution-entitlement application, fidelity transitions and operator RPC.
33. **RW-0303 — SpaceDO command owner:** hydration, hot/warm/dormant transitions, epoch fencing, mailbox, PostgreSQL commit path, cache reconciliation and RPC.
34. **RW-0304 — Simulation alarms:** fidelity-aware deadline mapping, pause/speed changes, dormant reactivation, bounded catch-up and alarm recovery.
35. **RW-0305 — Queue dispatch runtime:** three channels, consumers, semantic dedupe, sweeper, DLQs and replay tooling.
36. **RW-0306 — Typed Workflow skeletons:** durable linkage, step policy, cancellation, deployment compatibility and evidence.
37. **RW-0307 — ActorAgentDO foundation:** initialization, cognition cache, session routes, hibernation metadata and recovery hooks.
38. **RW-0308 — Cross-space transfer:** routing epoch, prepared/accepted/completed states, crash matrix and reconciliation.
39. **RW-0309 — Runtime inspector:** actor placement, revision, alarm, mailbox, fiber/Workflow/Queue and reconciliation views.
40. **RW-0310 — Runtime qualification:** local and Cloudflare tests for restart, interleaving, Hyperdrive outage, queues and sleep/wake equivalence.

Amended (2026-10-19): RW-0308 moves after GA to Wave 11 with the per-space state split, and RW-0307 to Wave 5. RW-0302 to RW-0304 implement awake/asleep fidelity, not hot/warm/dormant tiers or runtime cells (§35).

### Realtime browser and visual world

41. **RW-0401 — Scene projection schemas:** authorized snapshots, monotonic patches, transient cues, interest descriptors and compatibility.
42. **RW-0402 — Space WebSocket runtime:** authenticated upgrade, hibernation attachments, fanout, revision acknowledgements and admission control.
43. **RW-0403 — Client convergence reducer:** gap detection, dedupe, reordering, reconnect/backfill and snapshot fallback.
44. **RW-0404 — React product shell:** provider-neutral authentication, routing, world selector, clock/weather, event feed, responsive panels and state boundaries.
45. **RW-0405 — Three.js isometric scene:** fixed camera, depth/anchors, picking, interpolation, weather/day-night and typed adapter.
46. **RW-0406 — Interest and client audience filtering:** camera, selection, conversation, privacy and operator overlays.
47. **RW-0407 — Universal interaction and inspector:** selectable card, Inspect/Why/Influence, causal traversal and mode disclosure.
48. **RW-0408 — Timeline and text-access path:** timeline metadata, event navigation and canvas-independent world interaction.
49. **RW-0409 — Deterministic asset pipeline:** provenance, Blender/export automation, atlases, manifests, upload and golden scene.
50. **RW-0410 — Realtime qualification:** two-client convergence, privacy-different views, hibernation/redeploy, load and accessibility.

### Conversations, models, capabilities and MCP

51. **RW-0501 — Conversation domain/API:** sessions, participants, retention, messages, turns, mode and independent histories.
52. **RW-0502 — Run/step evidence:** state machines, parent-child runs, protected artifacts, search and inspector queries.
53. **RW-0503 — Recoverable turn fibers:** phase checkpoints, streaming channel, recovery, cancellation and abandoned attempt reconciliation.
54. **RW-0504 — ModelGateway:** Vercel AI SDK, AI Gateway, aliases, structured output, accounting, scripted model and breakers.
55. **RW-0505 — Authorized context assembly:** session/actor/relationship/space/world inputs, citations, revision capture and token budgets; governed versioned cognitive documents and atomic write-class change sets.
56. **RW-0506 — Capability registry and internal tools:** schemas, binding resolution, grants, approvals and inspect/why/command capabilities.
57. **RW-0507 — MCP installation lifecycle:** remote HTTP discovery, OAuth/token state, tool/resource/prompt classification, schema pinning and drift.
58. **RW-0508 — MCP execution/effects:** validation, network policy, effect intents, idempotency, uncertain results, preview policy and revocation.
59. **RW-0509 — First-party world MCP:** authenticated stateless search, inspection, command, changeset and durable-run operations.
60. **RW-0510 — Conversation/MCP qualification:** concurrent sessions, stale revisions, provider/tool failures, malicious fixtures, budgets and recovery.

### Context, memory, graph and learning

61. **RW-0601 — IngestionWorkflow:** source policy, hashing, renditions, chunk spans, artifacts, refresh/supersession and coverage verification; raw/normalized/interpreted external observations and declared time mapping.
62. **RW-0602 — Scope-first retrieval:** authorization candidate set, FTS, ranking features, citations, cache invalidation and traces.
63. **RW-0603 — Vector projection:** embeddings, authorized exact search, measured HNSW migration seam and recall/cost evaluation.
64. **RW-0604 — Entity/fact graph projection:** attributed resolution, claims/evidence, typed temporal edges and bounded traversal.
65. **RW-0605 — Perception and episode pipeline:** event-time audience state, private cognitive events, salience and owner-specific episodes.
66. **RW-0606 — Belief domain:** propositions, acquisition, reinforcement, contradiction, context, forgetting and explanation.
67. **RW-0607 — Relationship domain:** objective/subjective edges, asymmetry, trust/family evidence, revisions and retrieval features.
68. **RW-0608 — ConsolidationWorkflow:** actor/relationship/space/world summaries, accessibility, contradictions, source preservation and replay; governed field-guide generation/revision.
69. **RW-0609 — Social/generational learning:** Tell/Teach/Demonstrate/Lead, fractional evidence, favorite-place learning and later decisions; governed SKILL.md and bounded compiled-policy artifacts/bindings/evaluations/adoption/invalidation/fallback; governed field-guide sharing, testimony, firsthand verification and attributed next editions.
70. **RW-0610 — Memory qualification and inspector:** fixed corpus, privacy/provenance/faithfulness/behavior evals and causal UI, including field-guide testimony/verification/revision and sharing/privacy lifecycle.

### Rules, timelines and natural-language authoring

71. **RW-0701 — Rule AST and evaluator:** typed bindings, pure expressions, event/geofence/schedule/threshold triggers and deterministic order.
72. **RW-0702 — Durable rule reactions:** dispatch, causal IDs, dedupe, cooldown/fanout/depth budgets, cycle controls and kill switches.
73. **RW-0703 — Timeline fork barrier:** partition-head vector, snapshot manifest, branch identities and inherited logical IDs.
74. **RW-0704 — Branch storage/replay:** branch-local events/projections/schedules/cognition, snapshots, hashes and exact/diagnostic/experimental modes.
75. **RW-0705 — Preview isolation:** capabilities, credentials, external effects, budgets, TTL and adversarial leakage tests.
76. **RW-0706 — Changeset schema/compiler:** assumptions, typed operations, grants, references, asset/archetype selection and validation.
77. **RW-0707 — AuthoringWorkflow:** compile, validate, create preview, apply, inspect, approve, resume and reject.
78. **RW-0708 — Semantic/visual diff and fast-forward:** branch comparison, scheduled consequences, cost bounds and operator UI, including scoped deterministic counterfactual Why.
79. **RW-0709 — Promotion/rebase:** current-head validation, typed conflicts, semantic intent replay and no synthetic-history merge.
80. **RW-0710 — Authoring qualification:** pond, street buffer, occupied move, death successor, rule loop and live-head conflict scenarios.

### Complete reference neighborhood

81. **RW-0801 — Full `green-lake-yard@1` content:** all spaces, regions, anchors, archetypes, actors, systems, policies, rules and seeds.
82. **RW-0802 — Lifecycle product UX:** birth, stages, parentage, aging, death, remains/retirement, sessions and successor consequences.
83. **RW-0803 — Household/social routines:** needs, relationships, teaching, promises, invitations, leading and family behavior.
84. **RW-0804 — Environment/ecology depth:** weather, wetness/shelter, food/water cycles, growth, balance and long-run thresholds.
85. **RW-0805 — Overnight/world-interest summaries:** material event selection, space/world consolidation, return experience and provenance.
86. **RW-0806 — Object/space conversation polish:** interpreted perspective, canonical inspection, disclosure, grounding and capability-specific behavior.
87. **RW-0807 — Complete visual/audio pack (reference world's repository):** character variants, animation families, environment, weather/time effects, provenance and accessibility.
88. **RW-0808 — North-star causal integration:** live observation and governed actor MCP research through learning, skill revision, bounded policy reuse/novelty fallback across UI, runtime, journal, cognition and inspector, including field-guide reading/revision and counterfactual Why.
89. **RW-0809 — Full scenario/soak suite:** all ten named scenarios, months/year acceleration, model-free continuity and ecological bounds.
90. **RW-0810 — Product thesis evaluation:** moderated tasks, analytics, rubrics, declared thresholds, findings and corrective work.

### GA operations and open-source release

91. **RW-0901 — Tenant/world administration:** provider-neutral invitations, internal grants, quotas, lifecycle and operator audit.
92. **RW-0902 — Privacy lifecycle:** access classes, retention, export, deletion, derived-index cleanup and crypto-erasure.
93. **RW-0903 — Abuse/cost controls:** rate limits, simulation/model/tool budgets, moderation hooks, breakers and metering.
94. **RW-0904 — Production observability:** dashboards, SLOs, alerts, trace export, product evidence and cost allocation.
95. **RW-0905 — Backup/restore/DR:** PostgreSQL/R2 restoration, replay verification, regional/platform response and exercises.
96. **RW-0906 — Capacity/hot-owner qualification:** load curves, hibernation scale, catch-up storms, partition procedure and admission control.
97. **RW-0907 — Security qualification:** threat-model review, RLS/cross-tenant tests, MCP/SSRF/injection, secrets and dependency supply chain.
98. **RW-0908 — Public documentation:** local setup, architecture, APIs, world-pack SDK, MCP, operations, deployment constraints and examples.
99. **RW-0909 — Open-source release engineering:** Apache-2.0 notices, provenance, SBOM, contribution/security process and reproducible build.
100. **RW-0910 — GA evidence gate:** execute section 35, archive release manifest/evidence and block release on unresolved invariant failures.

Amended (2026-10-27): RW-0909's notices are MIT notices, not Apache-2.0; the license is MIT (Wave 0 amendment). RW-0909 keeps notices, provenance, SBOM, contribution/security process and reproducible build.

Before starting any packet, its consumed contract packets must be merged and golden fixtures frozen. A packet that discovers a contract defect stops and proposes the contract change before implementing local workarounds.

---

## 32. Operational runbooks required before GA

Each runbook contains detection, severity, containment, evidence queries, customer impact, recovery, reconciliation, validation, communication and follow-up tests.

Required:

- PostgreSQL/Hyperdrive unavailable or degraded;
- transaction committed but actor response lost;
- DO runtime state incompatible/corrupt;
- hot SpaceDO and emergency partition;
- WorldDO routing epoch failure;
- alarm backlog/catch-up;
- Queue backlog, poison message and DLQ replay;
- Workflow/fiber stuck, canceled or limit exceeded;
- projection divergence/reconnect storm;
- replay/state-hash mismatch;
- authentication-provider outage/session/event issue;
- AI provider outage, bad model rollout or cost spike;
- MCP compromise, schema drift or uncertain effect;
- runaway rule/geofence storm;
- preview effect-isolation assertion;
- cross-tenant authorization assertion;
- R2 artifact corruption/loss;
- migration/deployment incompatibility;
- backup restore and regional/platform incident;
- privacy deletion/export failure;
- credential rotation/revocation.

---

## 33. Cost model and controls

Attribute cost by tenant, world, timeline, space, subject, session, simulated day, branch, model, MCP server, Workflow, Queue channel, R2 class and PostgreSQL workload.

In optional commercial hosting, attribution and sponsorship remain separate. `AttributionEnvelope` answers who acted and why; a versioned sponsorship decision selects one Management-owned billing-account wallet. One wallet may fund many worlds. Redis atomically allocates bounded, expiring, epoch-fenced `WorldCreditLease` authority from that wallet; each Runtime owner reserves/consumes locally inside its lease and emits raw usage plus idempotent capture/release receipts. PostgreSQL stores rated usage, immutable double-entry accounting, purchases, grants, refunds, disputes, leases and reconciliation checkpoints and can rebuild operational projections. Stripe or another payment provider only collects and reconciles money inside Management; worlds never require distinct provider customers, subscriptions or meters.

If the allocator is unavailable, no new leases issue. A world may finish work only inside its valid outstanding lease, then applies its epoch/versioned `active`, `credit_restricted`, `frozen`, `read_only`, or `archived` mode. Empty prepaid wallets normally restrict variable-cost work; nonpayment may freeze simulation time at a safe journal boundary without unbounded catch-up. Redis and local lease counters are never canonical world or accounting truth.

Controls:

- hibernation and semantic scheduling;
- deterministic behavior before model escalation;
- bounded retrieval/context and reusable summaries;
- concurrency/backpressure priority;
- model aliases and hard budget reservations;
- branch TTL/size/speed caps;
- artifact inline/spill, compression, dedupe and retention;
- batched Queue/index/projection work;
- sampled operational telemetry with complete canonical evidence;
- per-world simulation/catch-up policy;
- provider/tool/rule circuit breakers.

Unit metrics:

- model cost per actor-day and conversation turn;
- consolidation cost per actor-week;
- Cloudflare compute per active/dormant world-hour;
- Cloudflare compute per hot/warm/dormant runtime-cell hour and cell transition;
- socket cost per connection-hour;
- PostgreSQL bytes/query time per world-day;
- event bytes per semantic action;
- branch cost per simulated day;
- ingestion/index cost per document;
- external tool cost/effect.

---

## 34. Risk register

| Risk | Fixed mitigation |
| --- | --- |
| Platform precedes compelling experience | the north-star scenario is the cross-layer acceptance spine; Wave 4 exposes real kernel/journal evidence before platform breadth |
| World appears idle or repetitive | environment/routine/event-summary activity, semantic schedules and decision-diversity metrics; never constant model chatter |
| Universal conversation feels gimmicky | disclosed embodied/interpreted/operator modes, capability-specific prompts and grounding/utility playtests |
| User influence destroys actor agency | distinct suggestion/claim/gift/operator commands, visible intent outcome and actor policy right to decline |
| Explanation hallucinates rationale | decision-time inputs and evidence are canonical; model only renders an authorized trace |
| Memory collapses into generic RAG | first-party epistemic types, provenance, contradiction and required downstream behavioral-effect evaluation |
| Generational learning copies identity | testimony/demonstration evidence and relationship-weighted belief updates; episodes remain owner-specific |
| Authoring hides unsafe assumptions | explicit assumptions, typed operations, validation, preview fast-forward, semantic diff and live-head rebase |
| Art pipeline dominates engineering | fixed isometric camera, small coherent asset vocabulary, directional sprite automation and committed deterministic exports |
| Death corrupts references/history | stable historical identity, terminal activation/session policies, explicit knowledge/social effects and distinct successor identity |
| MMO expectations distort semantics | partitioned persistent shared worlds and measured capacity goals; no global ordering/avatar/economy assumptions |
| Premature generic engine design | registered concrete component catalog plus one deliberately different conformance pack |
| Cloudflare coupling | Pure contracts/domain/kernel/application ports; portable PostgreSQL/R2 export; coupling accepted at runtime |
| DO/PostgreSQL dual authority | PostgreSQL wins; DO state rebuildable; acknowledge after commit |
| Global world bottleneck | WorldDO off ordinary path; partition sequences and explicit space routing |
| Cross-owner transaction | Typed saga, routing epoch, idempotent states, reconciliation |
| World identity coupled to runtime | Separate durable IDs from runtime cell/instance; canonical placement plus routing/authority epochs; stale writers fenced |
| Cross-world object movement expands scope and security surface | Runtime object portability is out of scope; enforce world/timeline IDs on every container and transfer command |
| Event volume | Semantic thresholds/segments; transient presentation excluded |
| Workflow/fiber retention | Permanent application evidence in PostgreSQL |
| LLM unpredictability | typed output, recorded results, command validation, budgets, evals and fallback |
| Memory complexity without value | behavioral-effect and grounding gates |
| MCP/prompt injection | scoped grants, untrusted labels, schema/result validation, approvals, network policy |
| Preview leakage | enforced effect policy at executor/dispatcher |
| Private cognition versus replay | privacy-classed streams, authorized replay, retention/crypto-erasure |
| Queue duplication/order | semantic idempotency and route ordered work to owner |
| Hot actor/session | concurrency budgets and logical placement seam |
| Schema/model/pack drift | release manifest, compatibility suite, preview regression |
| Debugging fragmentation | one correlation vocabulary and product inspector |
| OSS/hosted mismatch | complete local stack and explicit Cloudflare production dependency |

---

## 35. Definition of GA complete

### Experience and thesis

- a first-time visitor can understand the clock/weather, select a visible entity, identify its interaction mode, start/resume a session and observe a consequence without developer instruction;
- a user can talk meaningfully to a cognitive actor, interpreted object and space, and can distinguish those voices from operator truth;
- the full observe → converse/investigate/influence → consequence → why → memory → later changed behavior loop operates in `green-lake-yard@1`;
- the north-star scenario in 2.7 passes end to end with two clients and injected failures;
- the falsifiable evaluations in 2.4 and metrics in 25.4 have recorded baselines, declared release thresholds and reviewed results;
- the accessible text path can operate and understand the world without the world canvas;
- the world remains legible while actors sleep and after a user returns from an unobserved period.

### Simulation and world

- world runs continuously according to explicit clock/catch-up policy;
- weather, resources, growth, reproduction, aging, death, schedules and rules survive restart/deploy;
- model outage does not stop routine simulation;
- the fixture world and the external reference world share the engine unchanged;
- every component in 7.3 has versioned schema/reducer/snapshot/redaction behavior;
- live stepping, restart/catch-up and preview fast-forward satisfy their declared material-equivalence policy;
- all ten named scenarios in 7.13 pass their journal/projection/schedule/decision/hash goldens;
- event volume follows material semantic transitions rather than ticks or render frames.

### Actors and realtime

- logical addresses work for worlds, spaces, subjects, sessions and presence;
- durable world/space/object identity survives runtime-cell migration and disposable-instance replacement;
- hot/warm/dormant spatial fidelity changes preserve declared material equivalence;
- WorldDO/SpaceDO/ActorAgentDO ownership is enforced;
- clients receive authorized interest-filtered projections;
- hibernation/reconnect/duplicate delivery converge;
- cross-space transfer and hot-space partition procedures are tested.

Amended (2026-10-19): GA is narrowed to one space owner per world partition and awake/asleep fidelity. Runtime-cell migration, hot/warm/dormant fidelity changes, cross-space transfer and hot-space partition procedures move after GA to Wave 11, with the per-space state split. Reason: no GA scenario needs a second authority owner (the PRD defers more than one authoritative zone, §26.4), and this plan partitions only after measurement.

### Conversations, models and tools

- multiple sessions per subject persist/recover;
- session history remains distinct from actor memory and supports independent participants, scopes and retention;
- every model/tool turn has searchable evidence and input revisions;
- fibers and Workflows recover according to policy;
- MCP can be installed, scoped, approved, audited, revoked and upgraded;
- stale state, interruption, provider outage and protected effects fail safely.

### Memory and explainability

- perception is actor-relative;
- objective fact, perception, episode, claim, testimony, belief, relationship and summary remain distinguishable;
- episodes/beliefs/evidence/summaries/relationships replay and branch;
- social/generational learning retains attribution;
- later behavior changes due to memory;
- explanations cite only decision-time evidence.

### Journal, rules, branches and authoring

- no acknowledged event is lost or silently rewritten;
- supported replay reproduces hashes;
- rules are bounded and inspectable;
- event-, geofence-, scheduled- and threshold-triggered rules issue commands rather than direct writes;
- preview timelines isolate physical, cognitive, scheduled and external effects;
- NL authoring produces typed validated changesets;
- promotion rebases intent without merging synthetic history.

### Operations and trust

- SLOs/dashboards/alerts/inspector/runbooks operate;
- authentication-provider conformance, RLS, privacy, retention, deletion, abuse and cost controls pass review;
- backup/restore/chaos/provider-outage exercises pass;
- licenses, reused code, dependencies and assets have provenance;
- public docs reproduce local and hosted deployment.

---

## 36. Glossary

| Term | Meaning in this system |
| --- | --- |
| Actor | stable, addressable world interface with state/capabilities; not necessarily a resident process or LLM |
| Actor process | durable logical objective/responsibility with stable identity, cursors, checkpoints, leases and bounded run segments; independent of any one resident runtime |
| Actor policy | resolved, versioned persona, cognition, model, context, capability, budget and memory-write policy |
| Activation | bounded work caused by a message, perception, schedule, conversation, rule, capability, inspection or recovery |
| Agent run/step | searchable durable evidence for retrieval, model, tool, approval, command and memory work |
| Archetype | pinned reusable object definition; traits and instance overrides compose its effective state |
| Belief | actor-owned proposition with confidence, evidence, acquisition mode, context and contradiction state |
| Capability | typed, permissioned operation bound to a subject/session/space/world, including governed MCP tools |
| Canonical truth | authoritative physical or behavior-affecting cognitive state derived from accepted semantic events |
| Claim | attributed proposition from speech, document, extraction or inference; never automatically objective fact |
| Command | typed, authorized and revision-checked request to change canonical state |
| Consolidation/dreaming | scheduled evidence-preserving compression, contradiction and accessibility work at an actor/relationship/space/world scope |
| Decision trace | stored trigger, evidence, candidates, features, draws, policy, action and outcome behind a choice |
| Episode | actor-owned memory of a perceived or experienced occurrence |
| Event | immutable semantic statement that an accepted canonical domain change occurred |
| Evidence | provenance-bearing support for a claim, belief, relationship or explanation |
| Fiber | recoverable bounded agent execution used for ordinary turns; PostgreSQL remains permanent evidence |
| Interpreted perspective | disclosed narration of a nonverbal object/space's modeled state, not literal embodied speech |
| Logical object ID | stable world identity shared by inherited timeline states; independent of runtime placement |
| Perception | private actor-relative structured information resolved from an event and the observer's senses/access |
| Preview timeline | isolated mutable branch used to inspect, simulate and review change without mutating live history/effects |
| Projection | read-optimized or client-visible state derived from canonical history |
| Relationship | objective or actor-owned subjective typed temporal edge with causal evidence |
| Rule | versioned bounded trigger/condition/action AST that reacts to committed history by issuing commands |
| Session | durable conversation transcript and execution scope; distinct from the actor's memory and identity |
| Space | first-class containment, context, perception and physical-authority scope |
| Spatial frame | versioned semantic 2D or 3D coordinate system independent of renderer and spatial-index implementation |
| Spatial-index cell reference | opaque, epoch-scoped, rebuildable index/placement state; never durable world, space, object or actor identity |
| Subject | character, object, space or system addressed through the common actor facade |
| Timeline | live, preview or archived world history with its own clock policy, partition heads and cognition |
| World changeset | reviewed typed operations and assumptions compiled from authoring intent |
| World journal | PostgreSQL semantic event streams plus snapshots/projections, schedules and causal evidence |
| World pack | versioned spaces, archetypes, assets, policies, rules, seed commands and migrations for a world |

---

## 37. Primary technical references

- [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/)
- [Rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
- [Durable Object RPC](https://developers.cloudflare.com/durable-objects/best-practices/create-durable-object-stubs-and-send-requests/)
- [Durable Object WebSocket hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [Durable Object alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)
- [Cloudflare Agents durable fibers](https://developers.cloudflare.com/agents/runtime/execution/durable-execution/)
- [Cloudflare Agents and Workflows](https://developers.cloudflare.com/agents/runtime/execution/run-workflows/)
- [Cloudflare Agents MCP client](https://developers.cloudflare.com/agents/tools/mcp/)
- [Cloudflare Workflows local development](https://developers.cloudflare.com/workflows/build/local-development/)
- [Cloudflare Queues](https://developers.cloudflare.com/queues/)
- [Queue delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)
- [Queue dead-letter queues](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/)
- [Cloudflare Hyperdrive local development](https://developers.cloudflare.com/hyperdrive/configuration/local-development/)
- [Cloudflare Neon integration](https://developers.cloudflare.com/workers/databases/third-party-integrations/neon/)
- [Cloudflare AI Gateway with Vercel AI SDK](https://developers.cloudflare.com/ai-gateway/integrations/vercel-ai-sdk/)
- [Cloudflare Workers OpenTelemetry export](https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/)
- [Better Auth documentation](https://www.better-auth.com/docs)
- [Better Auth Organization plugin](https://www.better-auth.com/docs/plugins/organization)
- [Better Auth Hono integration](https://www.better-auth.com/docs/integrations/hono)
- [Optional Clerk adapter](https://clerk.com/docs/guides/organizations/overview)
- [Three.js WebGPURenderer](https://threejs.org/docs/#api/en/renderers/webgpu/WebGPURenderer)
- [Neon pgvector](https://neon.com/docs/extensions/pgvector)
- [The Architecture of a Distributed Virtual Worlds System](https://www.usenix.org/legacy/publications/library/proceedings/coots98/vellon/vellon_html/vellon.html)
- [PaperMC server simulation distance](https://docs.papermc.io/paper/reference/server-properties/)
- [PaperMC namespaced persistent data containers](https://docs.papermc.io/paper/dev/pdc/)
- [Velocity player identity forwarding](https://docs.papermc.io/velocity/player-information-forwarding/)
- [Roblox server-authority model](https://create.roblox.com/docs/projects/server-authority)
- [Roblox persistent DataStores across places and servers](https://create.roblox.com/docs/cloud-services/data-stores)
- [Roblox teleport between places and server instances](https://create.roblox.com/docs/projects/teleport)

Minecraft/Paper and Roblox are comparative systems evidence, not product templates, compatibility requirements, or named competitors. Clockgrove incorporates patterns that fit its thesis and deliberately improves the areas enabled by a greenfield event-sourced architecture.

---

## 38. Final directive

Build the final conceptual system from the first commit:

> Stable logical actors and versioned contracts; WorldDO for world coordination; SpaceDO for physical consistency; ActorAgentDO for thinking and conversation; PostgreSQL for truth; fibers for ordinary agent work; Workflows for long durable jobs; Queues for asynchronous failure isolation; provider-neutral human identity with Better Auth as the OSS reference; React and Three.js WebGPURenderer for the visible world.

Do not build a throwaway parallel architecture. Do not prebuild generalized infrastructure. Each wave must add tested production capability through these final seams and leave behind evidence that the layer is correct, recoverable, secure, observable and reusable.
