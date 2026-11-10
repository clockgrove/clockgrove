# Clockgrove Documentation Index

**Status:** Canonical product/runtime baseline map  
**Baseline date:** October 01, 2026  
**Product baseline:** PRD v0.5.10  
**Architecture baseline:** Cloudflare-native implementation plan v3.12  
**Delivery baseline:** Product Waves 0–12

---

## 1. Purpose

This index identifies the documents that define the current Clockgrove product/runtime baseline, the order in which to read them, and the status of supporting and historical material.

Clockgrove is the reusable platform/runtime for any world. Raccoon World, the first reference world and demo-quality application, lives in [clockgrove/raccoon-world](https://github.com/clockgrove/raccoon-world) and builds against Clockgrove at a pinned commit. Clockgrove keeps `worlds/fixture` as its own test world, the platform's portability proof.

External development tools such as `clockgrove/factory` may operate this repository. Their state and implementation are not Clockgrove product/runtime authority.

---

## 2. Decision hierarchy

When product/runtime documents appear to conflict, resolve them in this order:

1. latest accepted topic-specific product/runtime ADR;
2. `docs/clockgrove-prd-v0.5.md` v0.5.10 for product intent and scope;
3. `docs/clockgrove-cloudflare-implementation-plan.md` v3.12 for cross-wave implementation architecture and authority boundaries;
4. the current wave plan for implementation sequencing and exit evidence inside that wave;
5. supporting editorial/adversarial review for reconciliation rationale;
6. historical product research only for context.

Do not silently choose whichever file is most convenient. Record a successor ADR or explicitly versioned baseline change when a real conflict remains.

An Objective for this repository follows the Clockgrove product/runtime hierarchy above.

---

## Closed-world resource decision

Kirk's recorded decision of 2026-11-09 (issue 187) requires a closed world for **all resources**,
food and water alike: water in a bowl must come from rain or someone filling it. Resource increases
must have journaled platform causes: weather collection, plant yield, character commands or
explicitly declared world processes. Off-screen people are allowed only as declared processes
acting through ordinary validated commands. Scheduled ecology sources are being replaced in
sequential parts of issue 187; journal accounting, optional plant-stage yield and opt-in rain collection/evaporation are available,
while declared processes, source removal and fixture migration remain pending. The
[kernel ecology contract](../packages/kernel/docs/ecology.md) records implemented behavior.

---

## 3. Recommended reading order

For product/runtime work:

1. `README.md`
2. `docs/clockgrove-prd-v0.5.md` v0.5.10
3. `docs/clockgrove-cloudflare-implementation-plan.md` v3.12
4. accepted ADRs relevant to the task
5. the current wave plan and immediately preceding handoff

The independent `clockgrove/skills` package provides product and engineering guidance, not product/runtime authority.

Agents start from the documentation map in [`../AGENTS.md`](../AGENTS.md); package and subsystem contracts live under each package's docs directory.

How Clockgrove discloses AI-made content to players is in [`docs/policy/ai-content-disclosure.md`](policy/ai-content-disclosure.md).

For contributor workflow (required tools, acceptance commands, workspace and runtime composition facts), see [`docs/runbooks/development.md`](runbooks/development.md). For W0-008 environment manifests, credential-free infrastructure validation, named secrets and authorized planning/applying, see [`docs/runbooks/infrastructure.md`](runbooks/infrastructure.md).

---

## 4. Canonical product/runtime specifications

| Document | Version | Status | Authority |
| --- | ---: | --- | --- |
| `docs/clockgrove-prd-v0.5.md` | 0.5.10 | Current | Product thesis, users, shared-world model, scope, acceptance, delivery boundary |
| `docs/clockgrove-cloudflare-implementation-plan.md` | 3.12 | Current | Cross-wave engineering architecture and fixed product/runtime boundaries |
| `docs/adr/clockgrove-adr-world-personas-and-object-mobility-policy.md` | Accepted | Current | World personas, world-local inventory and inherited mobility policy |
| `docs/adr/clockgrove-adr-management-plane-world-runtime-plane-and-shared-wallet.md` | 1.0 | Accepted | Management/Runtime authority, provisioning, shared-wallet leases and Management-only billing-provider boundary |
| `docs/adr/clockgrove-adr-incremental-wave-delivery-and-evidence.md` | 1.0 | Accepted | Substantial sequential workstreams, Objective checkpoints/readiness, proportionate qualification and comparison rules |
| `docs/adr/clockgrove-adr-field-guides-and-counterfactual-why.md` | 1.0 | Accepted | Resident-authored evolving knowledge, governed sharing/testimony, and bounded deterministic counterfactual Why |
| `docs/adr/clockgrove-adr-actor-decision-ladder.md` | 1.0 | Accepted | Actor decision ladder: reflex, utility, compiled policy, bounded decision model, LLM; decision points in actor policy, models propose never commit, journal replay, deterministic fallback, distillation into compiled policy, dreaming steps as decision points |
| `docs/adr/clockgrove-adr-renderer-bake-off.md` | 1.0 | Accepted | Three.js WebGPURenderer with automatic WebGL2 fallback and TSL; supersedes Phaser rendering in architecture §20 and PRD stack rows (issues 67, 74) |


---

## 5. Canonical product delivery waves

| Wave | Document | Version | Exit theme |
| ---: | --- | ---: | --- |
| 0 | `clockgrove-wave-0-project-foundation-implementation-plan.md` | 2.2 | Publication-ready repository, contracts, production skeleton, CI/security/recovery foundation |
| 1 | `clockgrove-wave-1-world-kernel-implementation-plan.md` | 1.6 | Deterministic kernel, immutable world packs/genesis and renderer-neutral spatial/index contracts |
| 2 | `clockgrove-wave-2-journal-replay-implementation-plan.md` | 1.7 | PostgreSQL journal, world lifecycle, replay and attribution persistence |
| 3 | `clockgrove-wave-3-actor-fabric-implementation-plan.md` | 1.11 | Cloudflare actor fabric, runtime coordinator, perpetual scheduling and provisioning |
| 4 | `clockgrove-wave-4-visual-projection-web-client-implementation-plan.md` | 1.9 | Demo-quality, world-agnostic React/Three.js projection, readiness/navigation and full-3D adapter compatibility |
| 5 | `clockgrove-wave-5-conversations-models-capabilities-mcp-implementation-plan.md` | 1.10 | Durable conversations, Caretaker semantics, models, tools, MCP and long-running process contract |
| 6 | `clockgrove-wave-6-context-memory-learning-implementation-plan.md` | 1.7 | Memory, relationships, governed cognitive documents, bounded compiled-policy learning, field guides and provenance |
| 7 | `clockgrove-wave-7-rules-timelines-authoring-implementation-plan.md` | 1.8 | Rules, preview timelines, bounded counterfactual Why, previewed pack upgrades and reusable exports |
| 8 | `clockgrove-wave-8-living-neighborhood-demo-implementation-plan.md` | 1.6 | Complete provisioned Raccoon World demo with Caretaker persona, delivered in clockgrove/raccoon-world against the platform |
| 9 | `clockgrove-wave-9-ga-open-source-release-implementation-plan.md` | 1.9 | Technical/open-source GA of the platform, with Raccoon World as a separate reference world |
| 10 | `clockgrove-wave-10-self-service-multitenancy-signup-implementation-plan.md` | 1.6 | Provider-neutral Management Plane, workspaces, billing-account seam and starter-world provisioning |
| 11 | `clockgrove-wave-11-multiuser-attribution-portable-objects-implementation-plan.md` | 2.5 | Multiuser worlds, personas, attribution and world-local inventory |
| 12 | `clockgrove-wave-12-metering-prepaid-credits-billing-implementation-plan.md` | 1.5 | Shared-wallet leases, Runtime-local admission and Management-only commercial billing |

The Wave 11 filename is retained for historical identity. Its current content explicitly rejects cross-world runtime object portability.

Current authority is architecture v3.12 and PRD v0.5.10. The affected Waves 4–9 reference the accepted guide/counterfactual baseline (v3.10); v3.11 narrows GA to one space owner per world partition and awake/asleep fidelity; v3.12 records the MIT license. Unchanged wave headers retain their v3.9/v3.10/v3.11/v0.5.8 authoring baseline and remain compatible, subject to the current ADR hierarchy. Waves are substantial, mostly sequential workstreams containing numerous Objectives and Work Items. Wave-local sequencing notes identify early capability checkpoints; detailed packets and full exits remain required. The [incremental-delivery ADR](adr/clockgrove-adr-incremental-wave-delivery-and-evidence.md) defines the bounded local-readiness exception, Objective versus wave acceptance, independent review, one qualification owner, and exact versus semantic evidence comparisons.

GitHub retains current Objective/Work Item status and exact evidence. This index records document authority and versions rather than duplicating that live status.

---

## 6. Track boundaries

### Technical/open-source track: Waves 0–9

Produces a secure, reproducible, demo-quality, open-source Clockgrove platform and a hosted reference world delivered from its own repository. It does not require self-service commercialization, customer billing or public MMO operations.

### Shared hosted-world track: Waves 10–11

Adds self-service identity/tenancy and shared-world participation. Workspace administration remains distinct from world membership. Attribution exists before billing.

### Optional commercial-hosting track: Wave 12

Adds Management-side usage rating, one authoritative wallet per billing account, bounded world credit leases, Runtime-local enforcement, payment collection and customer billing controls. It does not redefine world truth or put payment-provider state inside Runtime semantics.

### Development tooling

External tools such as `clockgrove/factory` may plan and deliver work through GitHub. Clockgrove remains buildable, testable, deployable and operable without them. Their configuration, logs, and run state stay outside this repository.

---

## 7. Reconciled non-negotiable product/runtime decisions

- Clockgrove separates deterministic physical truth from subjective/model-backed cognition.
- Models and tools propose; typed authorized application paths mutate canonical state.
- PostgreSQL is canonical world history and canonical Management accounting truth.
- Durable Objects, Queues, Workflows, Redis, indexes and browser state are serialized execution, delivery or reconstructible projections rather than alternate histories.
- Clockgrove has a logical Management Plane and World Runtime Plane. They may compose in one deployable initially while preserving the authority boundary.
- Management owns identity/tenancy, catalog/desired lifecycle, packs/provisioning, quotas, sponsorship, rating/accounting, money and payment-provider integration. Runtime owns world truth, participation, attribution, raw usage origination and projection.
- One billing account may own one authoritative wallet shared across its worlds. Redis may allocate bounded world credit leases; Runtime consumes only valid local lease authority without a per-turn Management call.
- World birth is an explicit idempotent provisioning case over one immutable pack artifact; only runtime-committed `WorldReady` makes the world routable.
- Genesis pins simulation epoch, clock policy, named random streams, cognition seeds, schedules, seed commands, asset/provenance metadata and expected seed-projection hash.
- Browser arrival uses one truthful readiness contract with compatibility handling, critical-asset readiness and an accessible text fallback.
- Viewing a space, camera movement, persona embodiment/presence, actor movement and object mobility are distinct concepts.
- Caretaker Talk is private and attributed to the addressed actor/session; public speech, Influence, gifts/physical actions and operator authoring are separate commands.
- `Principal -> WorldMembership -> WorldPersona -> Presence`; workspace membership remains separate.
- Raccoon World begins with a disclosed, unrendered Caretaker persona.
- Clockgrove is world-agnostic. Platform code imports and names no world except `worlds/fixture`. Each world's pack, art, style bible, theme, goldens and browser journeys live in that world's repository and run against a pinned Clockgrove commit. Acceptance obligations sit with the repository that owns the content.
- Every material mutation and denial has action, attribution, authority, causal-root and immediate-cause evidence.
- Inventory and runtime object mobility are local to one world and timeline. Cross-world live object portability is out of scope.
- Effective mobility inherits world → space → role/persona → archetype → instance, narrow-only and deny-wins. Mobility and use capabilities are independent.
- Logical actor identity does not imply a resident process, model call or Durable Object.
- One million logical actors per world is a qualification target; active, visible and cognitive work remains bounded.
- Initial loose-quadtree indexing, Three.js rendering and bounded reactive runs are implementations behind durable spatial, scene and `ActorProcess` contracts.
- Future 3D and selectively long-running agent capabilities are protected by conformance seams rather than prebuilt machinery.
- All payment/customer/invoice/refund/dispute/tax integration is Management-only. Worlds do not require separate payment-provider customers, subscriptions or meters.
- Factory cognition and Clockgrove runtime cognition are separate systems and data planes.
- Privacy uses five accepted categories and a subset-narrowed set ceiling; scope, audience and authority remain independent. Only `public_scene` enters shared projection.
- Waves 5–6 own governed cognitive documents, actor-authored SKILL.md and bounded compiled-policy artifacts/bindings/evaluations, adoption, invalidation and fallback; arbitrary generated code remains deferred.
- Waves 5–6 own governed actor research and external-observation ingestion; Wave 8 proves a bounded live feed and actor-initiated MCP lookup in the integrated causal trace.
- Early product checkpoints precede complete demo integration, but partial Objective acceptance never substitutes for a full-wave exit or GA release gate.
- Field guides reuse cognitive documents/consolidation; governed sharing is separate from memory access. Readers receive attributed testimony and may verify/revise it under their own authorship; guides never become world truth or automatically public cognition.
- Counterfactual Why first reproduces a supported deterministic baseline, changes one declared input in an isolated bounded preview/evaluation, and distinguishes hypothetical results from actual history. Inspection alone grants no preview authority; missing/private/incompatible inputs fail honestly.

---

## 8. Historical material

Historical material never overrides current authority. Private working history, conversation-derived narrative and operator-specific setup plans live outside this repository.

---

## 9. Terminology guardrails

- **Clockgrove:** reusable platform/runtime for any world; its code names no world's content.
- **Raccoon World:** first reference world/world pack and demo application, in [clockgrove/raccoon-world](https://github.com/clockgrove/raccoon-world).
- **World repository:** a world's own repository, holding its pack, art, style bible, theme, goldens and journeys, and building against Clockgrove at a pinned commit.
- **Fixture world:** `worlds/fixture`, Clockgrove's own test world: the beacon pack and the neutral reference variant under `worlds/fixture/reference`. It is the platform's portability proof.
- **Factory:** separate engineering plugin and CLI in `clockgrove/factory`; not a world/runtime subsystem.
- **Workspace:** administrative and resource-ownership boundary.
- **World membership:** participation boundary for one world.
- **World persona:** durable in-world human identity and policy subject.
- **Presence:** ephemeral connection in a space.
- **Mobility:** object movement within one world.
- **Portability:** administrative data/code portability or an explicitly future concept; not current cross-world runtime object movement.
- **Logical actor:** durable addressable entity; not a resident process or guaranteed LLM.
- **Runtime instance ID:** diagnostic identity for one disposable runtime incarnation, never product identity.
- **Attribution:** authorship, agency and causation evidence.
- **Field guide:** versioned, attributed knowledge prepared for an authorized audience; a presentation of cognitive synthesis, not an omniscient wiki or required guest book.
- **Counterfactual Why:** a scoped hypothetical decision comparison, not a rewrite of history or a claim to know hidden model reasoning.
- **Sponsorship:** separate decision about which account funds variable-cost work.
- **Billing account wallet:** one Management-owned authoritative credit wallet that may sponsor many worlds.
- **World credit lease:** bounded, expiring, epoch-fenced spend authority allocated from a shared wallet and enforced locally by Runtime.

---

## 10. Baseline revision rule

A baseline change is complete only when it updates every affected authority surface:

1. PRD/product decision summary when product semantics changed;
2. parent architecture when a cross-wave boundary changed;
3. affected wave contracts, tests, handoffs and non-goals when substantive contracts changed;
4. relevant ADRs;
5. this index/version table;
6. cross-document consistency and qualification checks.

Development-system state can influence engineering work; it cannot become world truth without passing ordinary Clockgrove source, release and application authority.
