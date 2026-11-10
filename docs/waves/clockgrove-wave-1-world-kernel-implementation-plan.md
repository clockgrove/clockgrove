# Clockgrove Wave 1: Pure World Model and World-Pack Foundation

**Status:** Coding-agent implementation specification  
**Version:** 1.6  
**Date:** October 01, 2026
**Parent plan:** `clockgrove-cloudflare-implementation-plan.md` v3.9  
**Product source:** `clockgrove-prd-v0.5.md` v0.5.8  
**Wave:** 1 of the first three substantive implementation waves  
**Assumption:** Wave 0 repository, contracts, ports, CI, local database, and Cloudflare skeleton are complete  
**Development tooling:** external tools such as `clockgrove/factory` may execute this wave; their state is not product/runtime authority.  

---

## 1. Outcome

Wave 1 produces Clockgrove's reusable deterministic physical kernel and its first two executable world packs. It proves that a world can advance, make routine decisions, create perceptions, grow, reproduce, age, die, and fast-forward without a database, Cloudflare runtime, browser, model provider, or wall clock.

The wave exits only when:

> Given the same world-pack hash, initial state, command/schedule sequence, simulation-time target, kernel version, and named random-stream state, Node and Workers produce identical semantic events, decisions, schedules, final state, and SHA-256 state hash. The non-raccoon fixture requires no engine changes.

This wave is not a toy simulation that will be replaced later. Its APIs, identities, event semantics, scheduler contract, state hashing, component versioning, and world-pack boundary are the production contracts consumed by every later wave.

---

### 1.1 Objectives, sequencing, and checkpoints

This wave is a substantial workstream containing numerous Objectives and Work Items. The accepted [incremental-delivery ADR](../adr/clockgrove-adr-incremental-wave-delivery-and-evidence.md) governs capability scope, readiness, comparison rules, and proportionate qualification. The complete exit checklist below remains authoritative for full-wave qualification.

This workstream contains multiple kernel capability Objectives. Begin with a deterministic rain/hunger/shelter slice, bounded schedules and direct decision/Why evidence; extend the tiny non-raccoon and renderer-neutral fixtures at that first consumer.

Then complete movement/containment/audiences, resources and weather, lifecycle/reproduction/death, rule primitives, immutable pack/genesis and CLI conformance in dependency order. Long accelerated runs qualify the complete wave after these capabilities settle; they do not make every early Objective implement the whole ecological system.

Reuse the implemented `domain`, `kernel` and `testkit` foundation instead of recreating empty packages or copying contracts. Canonical ordering, named randomness and replay/state hashes remain exact.

---

## 2. Entry conditions

These are the full-wave/default entry conditions. A named local-development Objective may consume only accepted prerequisite capabilities under the ADR's recorded readiness exception; its Issue must preserve pending qualification obligations and the selected path's mandatory safety evidence.

The following Wave 0 evidence must exist before RW-0101 begins:

- the accepted pnpm workspace and current task graph run on a clean machine;
- strict ESM TypeScript with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`;
- package dependency rules enforced by the repository's current boundary checks;
- branded ID, actor-address, execution-context, privacy, error, command, event, and queue contracts;
- deterministic fake implementations of application ports;
- accepted `domain`, `kernel`, and `testkit` foundation implementations, with `world-pack-sdk` and CLI responsibilities introduced when needed;
- Node and Workers-compatible test projects;
- root `AGENTS.md`, ADR template, and fixed-decision ADRs;
- generated JSON Schema/golden contract drift check;
- CI commands `pnpm check`, `pnpm test`, and affected-package test selection.

If a Wave 0 contract is inadequate, the implementing agent stops and proposes a versioned contract correction. It must not create a private Wave 1 alternative.

---

## 3. Fixed boundaries

### 3.1 Kernel purity

`packages/kernel` and `packages/domain` must not import:

- Cloudflare APIs or SDKs;
- SQL clients, ORM code, PostgreSQL types, or migration code;
- filesystem, network, environment, or process APIs;
- model, agent, MCP, browser, React, Phaser, telemetry, or auth libraries;
- wall-clock time, `Date.now()`, `Math.random()`, random UUID creation, or locale-sensitive formatting.

Static import tests enforce the boundary. Runtime determinism tests supplement but do not replace it.

### 3.2 Canonical truth

- The kernel validates a typed command or scheduled input against an immutable state value.
- It returns semantic events, schedule mutations, a physical projection delta, decision-trace drafts, and updated named random state.
- Reducers derive the next state by applying emitted events.
- The kernel performs no persistence or side effects.
- An LLM-dependent decision emits a durable planning request description; it never blocks kernel execution and never mutates state.
- Generated dialogue, future memories, and model plans are inputs to later commands, not privileged truth.

### 3.3 Actor abstraction

“Everything is an actor” means stable identity, addressability, versioned state, capabilities, and typed message semantics. It does not imply one process, Durable Object, model, socket, mailbox, or row per object.

Wave 1 represents entities with registered components and archetypes. It must support:

- inspectable entities with no cognition;
- reactive deterministic entities;
- mobile social/cognitive subjects whose physical behavior remains deterministic here;
- stationary entities that may later receive an interpreted natural-language perspective;
- spaces and systems as addressable world objects.

### 3.4 Numeric and ordering rules

- `SimTimeMs` is signed 64-bit integer milliseconds, bigint internally and decimal text at JSON boundaries.
- Material quantities and geometry use branded integers or documented fixed point.
- Canonical logic never depends on floating-point equality.
- All collection traversal that can affect output uses explicit canonical ordering.
- Scheduled work orders by `(dueAt, priority, tieBreakKey)`.
- A named random stream change in `weather` must not perturb `lifecycle` or `behavior`.
- Event order cannot depend on JavaScript property order, row order, UUID sort order, or test-run concurrency.

---

## 4. Owned code and dependency direction

Wave 1 primarily owns:

```text
packages/
  domain/
    src/components/
    src/archetypes/
    src/commands/
    src/events/
    src/policies/
    src/rules/
    src/spatial/
    src/schedules/
    src/decisions/
  kernel/
    src/execute/
    src/reducers/
    src/systems/
    src/scheduler/
    src/random/
    src/hash/
    src/spatial/
    src/perception/
    src/rules/
  world-pack-sdk/
    src/manifest/
    src/registry/
    src/validation/
    src/migrations/
    src/conformance/
  testkit/
    src/builders/
    src/generators/
    src/goldens/
    src/scenarios/
    src/differential/
  simulator/
    cli/
worlds/
  fixture/
tests/
  contract/
  kernel/
docs/
  protocols/shared-contracts.md
packages/*/docs/
```

Subsystem contracts live beside their package in `packages/*/docs/` (kernel, domain, world-pack SDK and simulator, including the world-pack and CLI contracts); only cross-package protocol contracts stay under `docs/protocols/`. The root `AGENTS.md` documentation map lists them.

Allowed dependency direction:

```text
contracts ← domain ← kernel
                  ↖ world-pack-sdk
contracts + domain + kernel + world-pack-sdk ← CLI/testkit
```

Production packages never import `testkit`. World packs import only world-pack SDK and declared domain contracts. The CLI composes packages but owns no world semantics.

---

## 5. Core contracts to implement

### 5.1 Kernel executor

```ts
interface KernelInput<C extends DomainCommand | ScheduledInput> {
  state: WorldPartitionState;
  input: C;
  simulationTime: SimTimeMs;
  versions: KernelVersionSet;
  random: NamedRandomState;
  idSource: DeterministicIdSource;
  attribution: AttributionEnvelope;
}

interface KernelResult {
  events: NewDomainEvent[];
  scheduleMutations: ScheduleMutation[];
  projectionDelta: PhysicalProjectionDelta;
  decisions: DecisionTraceDraft[];
  random: NamedRandomState;
}

function executeKernel(
  input: KernelInput<DomainCommand | ScheduledInput>,
): Result<KernelResult, DomainError>;
```

Requirements:

- command handlers cannot mutate `input.state`;
- reducers are exhaustive by event version;
- successful no-event commands are allowed only for specified idempotent no-ops;
- failures have stable error codes and contain no private or nondeterministic text;
- each emitted event has a deterministic provisional identity derived from command/schedule identity and event index;
- schedule mutations are explicit `create`, `cancel`, or `supersede` operations;
- projection deltas are derived convenience outputs and must equal reducer results in tests.

### 5.2 Component registry

Each registered component declares:

```ts
interface ComponentRegistration<T> {
  type: string;
  version: number;
  schema: ZodType<T>;
  canonicalCodec: CanonicalCodec<T>;
  validateState(value: T, context: ComponentValidationContext): DomainIssue[];
  redact(value: T, access: AccessPolicy): unknown;
  upcasters: ComponentUpcaster[];
}
```

Initial components:

- Identity, Archetype, SpatialTransform, Containment, Portal, Presentation;
- Lifecycle, Needs, Mobility, Perception, Personality, Social;
- Cognition and Memory references without implementing the LLM-native cognitive store;
- Conversation mode metadata;
- Resource, Growth, WeatherExposure, Schedule, CapabilityBindings.

Canonical component writes use typed operations. Arbitrary JSON Patch is forbidden.

Amended (2026-10-27): Wave 1 registers nine of these components in `createInitialComponentCatalog` (`packages/domain/src/components/catalog/index.ts`): Identity, Archetype, SpatialTransform, Needs, WeatherExposure, Containment (with the `persona-inventory` container kind), Resource, Lifecycle and Portal. Each of the other ten is registered by the work that first consumes it, or its data is already carried by existing state:

- Presentation: Wave 4 RW-0409, with the pack's presentation bindings.
- Mobility: Wave 11 §7 ("Object mobility and personal inventory").
- Cognition and Memory references: Wave 6 RW-0605 and RW-0606, with perception, episodes and beliefs (Wave 6 §3.1 state classes).
- Social: Wave 6 RW-0607, with the relationship domain.
- Personality: Wave 8 RW-0803, with its first consumer, persona and conversation behaviour (amended issue 893, 2026-10-31).
- Conversation mode: Wave 5 RW-0501 (§6.1 session voice mode).
- Growth: carried by the ecology plant stages in the pack behaviour policy (`packages/kernel/docs/ecology.md`).
- Schedule: carried by the kernel scheduler (§5.4, `packages/kernel/docs/scheduler.md`).
- CapabilityBindings: carried by the actor capability references in the pack (`packages/world-pack-sdk/docs/collections.md`).
- Perception: carried by the perception policy's modalities and occlusions (§5.6, `packages/kernel/docs/perception.md`).

### 5.3 Effective object model

The effective object is:

> pinned archetype version + pinned trait versions + validated instance overrides + timeline-relative component state

The implementation must prove:

- archetype/trait versions do not silently float;
- an active object has one physical space and at most one immediate container;
- containment is acyclic and capacity-conserving;
- quantities never become negative;
- dead/retired actors cannot start ordinary autonomous work;
- component and object snapshots carry all required versions;
- future branches can preserve logical IDs without rewriting source state.

### 5.4 Scheduler

```ts
interface ScheduledItem<T = unknown> {
  id: ScheduleId;
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

The pure scheduler supports:

- deterministic insertion, cancellation, supersession, and drain-through-time;
- exact, aggregate, skippable, and externally blocked catch-up;
- bounded batches and a continuation cursor;
- versioned payload dispatch;
- deterministic threshold calculation for continuous systems;
- equivalent material results for supported small-step and aggregate progression.

### 5.5 Spatial model

Keep five graphs distinct:

1. containment hierarchy;
2. physical authority partition mapping;
3. portal/adjacency navigation graph;
4. geometric regions and geofences;
5. semantic/context hierarchy references.

Wave 1 defines versioned semantic `SpatialFrame` records for two or three dimensions, fixed-point poses, transforms, and 2D polygon or 3D volume regions. The reference pack implements a 2D ground-plane frame, stable anchors, deterministic A* tie-breaking, movement segments, portal traversal, region crossing times, and keyed remain-in-region schedules. A non-rendered 3D fixture validates schema, hashing, serialization, containment/transforms, and spatial events without implementing a renderer or physics engine.

It also implements `SpatialIndexPort` and the pure loose-quadtree adapter for 2D/isometric spaces: epoch-scoped opaque cell references, deterministic insertion/removal/query order, leaf summaries, and hot/warm/dormant classification inputs. The kernel does not assign Durable Objects or make the index canonical authority. A conformance fake demonstrates that another index kind can return the same semantic candidates without changing object IDs, commands, events, or state hashes.

Containment includes a world/timeline-local `PersonaInventory` container type. Mobility policy evaluates world → space → role/persona → archetype → instance restrictions; descendants may narrow but not silently widen and deny wins. `pickup`, `drop`, `give`, `move_within_space`, `cross_space`, `place`, and `remove` remain distinct from use capabilities such as `tool.chop`. No command can change an object's `worldId`.

Amended (2026-10-27): the inherited mobility policy and the `pickup`, `drop`, `give`, `place`, `remove`, `move_within_space` and `cross_space` verbs are built by Wave 11 §7 ("Object mobility and personal inventory"), as the world-personas ADR §11 already assigns them. Wave 1 provides the `persona-inventory` container kind (`packages/domain/src/components/catalog/index.ts`) and keeps every command inside one world.

Amended (2026-10-27): graph 2, physical authority partition mapping, moves to Wave 11's per-space state split (the Wave 11 plan's §3 amendment of 2026-10-19). Until then each world partition is one authority, matching Wave 3's one SpaceDO per world partition, and `partitionId` is a scope field only. The other four graphs and the keyed remain-in-region schedules are built in Wave 1: portals and their open/close/use commands (graph 3) by issue 833, the semantic place hierarchy (graph 5) and the dwell schedules by issue 841 (`packages/kernel/docs/spatial-movement.md`).

### 5.6 Perception and audiences

The deterministic resolver receives an event and source-revision state and emits:

- zero or more private actor perceptions;
- authorized client-view inputs;
- explicit reasons for inclusion/exclusion usable in tests and inspection.

It evaluates direct targets, containing space, nearby peers, ancestor spaces, subscribers, sensory modality/range, occlusion, attention, access policy, and privacy. Connected viewers do not become world observers merely by watching.

Amended (2026-10-27): Wave 6 RW-0605 builds the attention factor, as Wave 6 §8.1 already plans ("attention policy"). The Wave 1 resolver evaluates every other factor here and has no attention exclusion (`packages/kernel/docs/perception.md`); ancestor spaces come from the declared semantic hierarchy.

### 5.7 Routine decisions

Routine choice order is:

1. invariant/reflex;
2. bounded utility scoring;
3. LLM-planning request only for policy-declared ambiguity or novelty.

Every material choice records candidate actions, exclusions, fixed-point features, perception/belief/memory references, random draws, policy versions, selected action, and later outcome-link slots. Wave 1 may use scripted cognition references but must produce the final decision-trace shape.

Amended (2026-11-07): the owner adopts the [actor decision ladder](../adr/clockgrove-adr-actor-decision-ladder.md). A planning request on policy-declared ambiguity may first go to a decision point that the actor's policy declares: a decision model picks one of the kernel's own valid candidates, and the request's deterministic fallback (utility's top pick) applies whenever the model abstains, falls below its confidence threshold, exceeds its budget or is unavailable. The answer is journaled as cognitive evidence, any resulting command passes the ordinary validator and Journal, and replay reads the journal without calling a model. Steps 1 and 2 above stay deterministic. The first decision point runs in shadow mode (issue 92). This order and this checklist are otherwise unchanged.

### 5.8 Rule primitives

Wave 1 implements only pure bounded rule primitives:

- versioned typed AST;
- event, schedule, threshold, and geofence predicates;
- deterministic variable binding and expression evaluation;
- typed command-intent output;
- static validation for unknown fields/types;
- declared fanout/depth/cooldown budget metadata.

Durable reaction dispatch, loop ledgers, authoring, and live activation belong to later waves.

---

## 6. Canonical system execution order

Each partition advance must follow this order:

1. validate target simulation time and policy;
2. drain due scheduled inputs in canonical order;
3. advance environment transitions to the next due/material boundary;
4. integrate resources, growth, needs, health, and exposure;
5. emit material thresholds and update next deadlines;
6. advance movement and emit region/portal crossings;
7. evaluate due reflex/utility choices;
8. return events, schedule mutations, projection delta, decision drafts, and random state.

Inputs caused by a result never recurse into the same handler. The simulator feeds them back through the same command/schedule boundary with deterministic causation identity.

Changing this order is a kernel-version change and requires new compatibility fixtures.

---

## 7. Detailed work packets

### RW-0101 — Canonical time, units, randomness, IDs, serialization, and hash

**Consumes:** Wave 0 branded IDs and serialization boundaries.  
**Produces:** `SimTimeMs`, fixed-point quantity/geometry types, `NamedRandomState`, deterministic `IdSource`, canonical serializer, state hasher.

Implementation:

1. Define branded bigint/fixed-point types and JSON codecs.
2. Pin the PRNG implementation and algorithm identifier.
3. Define independent random-stream creation, draw, fork prohibition, serialization, and migration policy.
4. Define a versioned installation seed input and golden derivation of every initial named stream; retries reuse recorded state and never derive a second seed.
5. Derive deterministic IDs from command/schedule ID, event index, purpose, and stream where applicable.
6. Canonically encode records, unions, maps, sets, bigints, absent optionals, and version tags.
7. Hash canonical bytes with SHA-256.
8. Publish golden vectors runnable in Node and Workers.

Tests:

- cross-runtime byte/hash equality;
- stream independence after extra draws in another stream;
- map/insertion-order invariance;
- bigint and fixed-point boundary values;
- deterministic ID collision property within the declared domain;
- explicit failure for unknown versions and noncanonical numeric values.

### RW-0102 — Components, archetypes, traits, and world-pack manifest

**Consumes:** RW-0101.  
**Produces:** registries, schemas, effective-object resolver, pack manifest validator, minimal fixture pack.

Implementation:

1. Implement component registry and initial catalog.
2. Implement the one canonical source manifest from PRD 24.5, including dependencies, components, archetypes, traits, spaces, actors, rules, capabilities, policies, cognitive-seed references, random-stream seeds, assets, stable seed commands, migrations, and expected seed projection hash.
3. Resolve effective objects without mutating source definitions.
4. Compile a normalized immutable `WorldPackArtifactRef` with resource/asset/migration hashes and build-tool version.
5. Validate cross-references, initial simulation epoch/clock policy, cognitive seed hashes, deterministic schedule/random inputs, licenses/provenance, and content hash.
6. Emit human-readable validation paths and stable machine codes.
7. Add pack conformance entrypoint and compatibility matrix.

   Amended (2026-10-27): the pack compatibility matrix is produced by the Wave 9 release pipeline (Wave 9 §13.2, "Reproducible release"). Wave 1 keeps the conformance entrypoint (`packages/simulator/test/conformance/`) and each pack's `engineCompatibility` range, which genesis checks (`ENGINE_INCOMPATIBLE`).

Tests include duplicate registration, unknown component/version, trait conflicts, invalid overrides, missing references, cyclic definitions, content-hash changes, and pinning across pack upgrades.

### RW-0103 — Kernel executor, reducers, and invariant framework

**Consumes:** RW-0101–0102 and Wave 0 command/event contracts.  
**Produces:** command registry, executor, reducer registry, invariant runner, delta verification.

Implementation:

1. Register commands by stable type/version, owner, expected revision policy, validator, and handler.
2. Execute against immutable state.
3. Register semantic events and exhaustive reducers.
4. Run preconditions before execution and post-state invariants after reduction.
5. Compare declared delta against reducer-derived delta in development/test.
6. Produce stable error envelopes.

Tests cover success, rejection, idempotent no-op, unknown versions, event ordering, immutable input detection, reducer exhaustiveness, and fuzzed command sequences.

### RW-0104 — Containment, inventory, ownership, and conservation

**Consumes:** RW-0103.  
**Produces:** containment/resource commands, events, reducers, invariants.

Commands include create/retire object fixture operations, put/remove/transfer contained object, offer/consume/transfer resource, open/close/use where domain-relevant.

Property tests prove acyclicity, one-parent constraint, capacity, quantity conservation, no duplication on retries at the kernel contract, no negative values, and correct retirement/death restrictions.

### RW-0105 — Spatial frames, regions, indexes, navigation, movement, and audiences

**Consumes:** RW-0103–0104.  
**Produces:** versioned 2D/3D frame and region schemas, opaque `SpatialIndexPort`, deterministic route planner, movement segments, region crossings, perception resolver.

Implementation must include the starter anchors `den-mouth`, `porch-step`, `trash-front`, `tree-base`, `garden-edge`, and `fence-gap`; polygon boundary conventions; the non-rendered 3D conformance fixture; loose-quadtree and alternate-index fakes; equal-cost A* tie ordering; segment interpolation; crossing event times; interruption/replan semantics; differential-perception fixtures; client-interest inputs without client networking.

### RW-0106 — Scheduler and offline aggregation

**Consumes:** RW-0101 and RW-0103.  
**Produces:** pure schedule index, threshold API, catch-up engine, continuation cursor.

Required differential tests compare continuous small steps, one aggregate step, sleep/reactivation, pause/resume, schedule supersession, retry, and bounded continuation. Tests must declare exact equivalence or an approved material-equivalence class.

### RW-0107 — Weather, moisture, resources, and growth

**Consumes:** RW-0104–0106.  
**Produces:** deterministic day/night, rain/weather, exposure/drying, food/water lifecycle, spoilage, and cedar growth systems.

Kirk's 2026-11-09 closed-world decision (issue 187) applies to food and water: increases must have
journaled weather, growth or ordinary character/process command causes. Off-screen agents must be
explicitly declared world processes with no special command authority. Initial genesis inventory
is accounted separately. Per-holder accounting, finite plant-stage yield and optional rain
collection/evaporation and declared process resource transfers through ordinary validated commands
are implemented inside native advances. Durable runtime wakes include process deadlines, including
actorless worlds. Removal of legacy scheduled sources, fixture migration and complete reference/long-run
cause proof remain for the final part of that Objective.
The [kernel ecology contract](../../packages/kernel/docs/ecology.md) describes the current policy.

Journal-facing outputs are semantic thresholds, not numeric tick noise. Required goldens: `rain-shelter-comfort`, `food-decay-and-conservation`, and `cedar-growth`.

### RW-0108 — Needs, utility decisions, health/comfort, and movement choice

**Consumes:** RW-0105–0107.  
**Produces:** needs integration, next-decision thresholds, utility candidate/scoring registry, routine movement plans, decision traces.

Use fixed-point features with named policy versions. The `favorite-snack-house` scenario uses scripted belief/memory inputs at this wave; later waves replace the script with real cognition without changing the physical decision contract.

### RW-0109 — Reproduction, birth, aging, death, and terminal behavior

**Consumes:** RW-0103, RW-0106, RW-0108.  
**Produces:** lifecycle state machines, gestation schedules, deterministic child identity, parent/household links, death restrictions, successor intent primitive.

Prove birth exactly once across repeated inputs, stage threshold ordering, death terminality, historical identity preservation, and long-run population bounds under fixture policy.

### RW-0110 — Raccoon pack, non-raccoon conformance fixture, simulator CLI, and wave qualification

**Consumes:** all prior Wave 1 packets.  
**Produces:** `green-lake-yard@1`, `test-world@1`, immutable pack artifacts, headless simulator, deterministic genesis bundle, complete golden/evidence bundle.

The reference pack `green-lake-yard@1`, with its goldens and long runs, moved with [raccoon-world#1](https://github.com/clockgrove/raccoon-world/issues/1) to [clockgrove/raccoon-world](https://github.com/clockgrove/raccoon-world). That repository runs Clockgrove's world-pack check on it in its own CI against a pinned Clockgrove commit. Clockgrove's qualification scripts (`qualify:wave1`, `qualify:wave1:long-runs` and the later waves' `qualify:*`) reference no reference-world path. They run on `worlds/fixture`: the `test-world@1` beacon pack and the neutral reference variant under `worlds/fixture/reference`, which carries every named scenario with its exact physical values.

CLI commands:

```text
clockgrove pack validate --pack <source>
clockgrove pack build --pack <source> --out <artifact>
clockgrove pack test --artifact <artifact>
clockgrove simulate seed --pack <pack> --out <bundle>
clockgrove simulate command --state <bundle> --command <json>
clockgrove simulate advance --state <bundle> --to <sim-time>
clockgrove simulate scenario <name> --runtime node|workers
clockgrove simulate verify --bundle <bundle>
clockgrove simulate diff <bundle-a> <bundle-b>
```

The CLI outputs artifact/manifest hashes, fixed simulation epoch, clock-policy input, cognitive-seed references, stable genesis/seed command IDs, schedules, events, decision traces, expected/actual seed projection, named random state, timing/counters, and final state hash. It never injects hidden wall-clock values. `pack publish`, `world install`, and `world upgrade` are application/runtime commands added later over the same artifact.

---

## 8. Dependency graph and bounded execution

```text
RW-0101
  ├─ RW-0102 ─ RW-0103 ─ RW-0104 ─┬─ RW-0105 ─┐
  │                                └─ RW-0106 ─┼─ RW-0107 ─ RW-0108 ─ RW-0109
  └─────────────────────────────────────────────┘
all packets ────────────────────────────────────────────────► RW-0110
```

Permitted parallelism after contracts freeze:

- component/archetype validation fixtures and canonical serialization tests;
- containment/inventory and scheduler implementation after executor contracts merge;
- spatial geometry and perception fixture authoring after schemas merge;
- weather/resources/growth and lifecycle policy fixture authoring against frozen system ports;
- Node and Workers differential harnesses.

One agent owns each packet and its allowed paths. Contract changes merge before dependent work. A downstream agent must not copy or locally redefine an unmerged upstream type.

---

## 9. Test architecture

### 9.1 Required layers

| Layer | Proof |
| --- | --- |
| Contract | schemas, codecs, historic versions, unknown-version failure |
| Example unit | named command/system transitions and error codes |
| Property | containment, conservation, lifecycle, schedules, audience privacy |
| Metamorphic | small-step vs aggregate, insertion order, unrelated random draws |
| Differential | Node vs Workers, live vs restart bundle, pack migration |
| Fuzz | generated valid/invalid command sequences and bounded rule ASTs |
| Golden scenario | events, schedules, projection, decisions, PRNG, state hash |
| Long run | 30 simulated days and one simulated year |
| Performance | semantic event volume, scheduler scale, memory and runtime budgets. Each long run's wall-time and peak-memory budget per runtime is 2x the run's maximum in Qualification run 39604752325 on b58578a (2026-10-27), except test-world's one-year workerd peak memory: 6534 MiB, 2x the highest peak (3267 MiB in Qualification run 39525850979) across seven Qualification runs (2026-10-27). They are declared in `scripts/ci/qualify-wave1-long-runs.mjs`; a run above its budget fails. Scheduler scale drains 8192 exact schedules in calls of 1024 inputs, the kernel's per-call input maximum (decision: 8 x 1024); its kernel-call, chunk and queue high-water budgets follow from that arithmetic (`packages/kernel/test/scheduler.test.ts`). |

### 9.2 Named scenario status at Wave 1

All ten parent-plan scenarios execute. `favorite-snack-house` and `social-learning` use explicit scripted cognitive evidence; the kernel still proves that those inputs alter later deterministic choices. Every scripted input is marked so it cannot be mistaken for a production memory implementation.

Amended (2026-10-27): two scenarios prove less at Wave 1 than their parent-plan names. `death-and-successor` (parent §7.13 scenario 7) proves death, preserved identity and the successor intent; session, private-memory, relationship and knowledge-access policy at death is built by Wave 8 RW-0802 (Wave 8 §5.1, "Death"). `differential-perception` (scenario 9) proves nearby, sheltered, privacy-reduced and absent outcomes; the inattentive outcome needs the attention factor that Wave 6 RW-0605 builds (§5.6).

### 9.3 Long-run assertions

The 30-day and one-year fixtures assert:

- no negative/conjured resources;
- no orphan active objects or containment cycles;
- no duplicate births/deaths/schedules;
- bounded event volume relative to semantic transitions;
- bounded scheduler queue under world policy;
- deterministic population, resource, and lifecycle summary hashes;
- all decision/action references resolve;
- no inactive/dead actor performs ordinary autonomous actions;
- no private perception appears in public client-view input.

### 9.4 Canonical commands

The canonical commands are the root `package.json` scripts below; `scripts/ci/canonical-commands.mjs` and [the development reference](../runbooks/development.md) are authoritative, and this plan does not define separate per-area scripts.

```text
pnpm check
pnpm test
pnpm test:long-run
pnpm run verify:docs
pnpm run qualify:wave1
pnpm run qualify:wave1:long-runs
```

- `pnpm check` runs Biome, the per-package type checks, the dependency-direction rules (including the forbidden-import checks) and `scripts/check-boundaries.mjs`.
- `pnpm test` runs every package's tests through Turbo: contracts, kernel, world-pack SDK and simulator (scenarios, pack conformance, goldens and the CLI), each long-horizon test keeping a short variant, including a small Node/workerd parity check.
- `pnpm test:long-run` runs the long-horizon simulations; `qualify:wave1:long-runs` and `qualify:wave1` run and record the Wave 1 evidence.

Per-PR CI runs the short deterministic commands. The manually dispatched qualification workflow runs `pnpm test:long-run`, not per-PR CI.

---

## 10. Evidence and observability

Wave 1 has no distributed runtime, but it must produce inspectable evidence rather than opaque test success.

Each scenario bundle records:

- pack/schema/kernel/policy/PRNG versions and content hashes;
- seed and named random-stream states before/after;
- ordered commands and scheduled inputs;
- semantic events and reducer versions;
- decision candidates, features, exclusions, draws, and selection;
- perception inclusion/exclusion decisions;
- schedule mutations and remaining deadlines;
- final canonical projection and state hash;
- runtime identifier, duration, peak memory, event counts by type;
- assertion results and any material-equivalence declaration.

Goldens are reviewed artifacts. Updating one requires a semantic diff, explanation, and compatibility decision—not `--update` without inspection.

---

## 11. Security, privacy, and abuse cases

Wave 1 tests:

- component and pack inputs as untrusted data;
- bounded size/depth/count for pack manifests and rule ASTs;
- cross-tenant/world/timeline reference rejection even in memory-only fixtures;
- privacy-class propagation into perceptions and client-view inputs;
- no PII or display names in derived actor/runtime keys;
- denial of unknown capabilities or commands;
- deterministic rejection of malformed or incompatible versions;
- decision and error evidence redaction behavior.

World-pack trusted code extensions are build-time reviewed engine code. Wave 1 does not implement arbitrary runtime plugins.

---

## 12. Explicit non-goals

Wave 1 does not implement:

- PostgreSQL, migrations, journal transactions, R2, or snapshots;
- Durable Objects, Workers, alarms, Queues, Workflows, or sockets;
- model calls, agent fibers, MCP, memory extraction, or conversation sessions;
- React, Phaser, browser projection transport, or multiplayer;
- durable rule dispatch, preview timelines, authoring, or promotion;
- genetic simulation, realistic ecology, navmesh tooling, or physics-engine authority;
- world-pack marketplace, arbitrary code host, dependency solver, or signing ecosystem.

Interfaces required by later waves may be declared, but empty machinery is not added.

---

## 13. Exit evidence checklist

- [ ] RW-0101 through RW-0110 merged in dependency order.
- [ ] `green-lake-yard@1` and `test-world@1` validate and hash reproducibly.
- [ ] All named scenarios pass with committed golden bundles.
- [ ] 30-day and one-year runs pass deterministic long-run invariants.
- [ ] Small-step and aggregate progression meet declared equivalence.
- [ ] Node and Workers outputs are byte/hash equivalent.
- [ ] Historic pack/component/event fixtures upcast deterministically.
- [ ] No forbidden imports or nondeterministic APIs enter domain/kernel packages.
- [ ] Decision traces and perception evidence are inspectable from the CLI.
- [ ] Event volume scales with semantic changes, not render/tick frequency.
- [ ] The non-raccoon pack requires zero engine source changes.
- [ ] Package READMEs, protocol docs, and any ADRs are current.
- [ ] Main is deployable even though Wave 1 itself is headless.

Amended (2026-11-07): the owner moves two parts of this checklist to Wave 9 (the Wave 9 §18 amendment of 2026-11-07). First, the component part of "Historic pack/component/event fixtures upcast deterministically": every Wave 1 component is version 1 with no upcasters, so the registry's upcast walk (`upcast` in `packages/domain/src/components/registry/index.ts`) has no test. Wave 9 proves that a historic component fixture at an earlier version upcasts through the registered chain to the current version deterministically. Second, the READMEs of `packages/contracts`, `packages/testkit`, `packages/application` and `packages/persistence`, which have none, under "Package READMEs, protocol docs, and any ADRs are current". The pack and event upcasts and the other READMEs, protocol docs and ADRs stay Wave 1 evidence.

The qualification job publishes one immutable Wave 1 evidence manifest containing commit, lockfile hash, toolchain, test results, golden bundle hashes, performance counters, and the exit decision.

---

## 14. Handoff to Wave 2

Wave 2 consumes these frozen contracts:

- command and semantic-event registries;
- stream/partition ownership metadata on event types;
- reducer and projection APIs;
- schedule schema and catch-up classes;
- canonical serializer/state hash;
- snapshot codec inputs;
- pack/component/archetype/policy version sets;
- decision-trace draft and perception shapes;
- simulator replay bundles and scenario goldens.

Wave 2 may add persistence metadata to envelopes through compatible versioning. It must not change kernel semantics merely to simplify SQL.
