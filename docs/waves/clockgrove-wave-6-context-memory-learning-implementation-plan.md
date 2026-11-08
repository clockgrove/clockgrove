# Clockgrove Wave 6: Context, Memory, Relationships, and Learning

**Status:** Coding-agent implementation specification  
**Version:** 1.7  
**Date:** October 19, 2026
**Parent plan:** `raccoon-world-cloudflare-implementation-plan.md` v3.10  
**Product source:** `clockgrove-prd-v0.5.md` v0.5.9  
**Wave:** 6 of 13  
**Assumptions:** Waves 0–5 are qualified; cognitive runs and private event streams are stable  
**Development tooling:** external tools such as `clockgrove/factory` may execute this wave; their prompts, transcripts, memory, and state never enter world-memory data unless an explicit product ingestion path authorizes them.  

---

## 1. Outcome

Wave 6 makes experience matter. It implements governed context ingestion, scope-first lexical/vector retrieval, attributed entity/fact graph projections, perceptions and episodes, beliefs, relationships, consolidation, dreaming/reflection, social and generational learning, and the causal inspector needed to explain later behavioral changes.

The wave exits only when:

> Gracie can perceive or be taught a fact, form an attributed memory and belief, later revise its confidence after contradictory evidence, teach a kit, and reproducibly alter a later decision—while the inspector proves the full chain without exposing cognition to an unauthorized viewer.

Memory is not a transcript dump or vector database. Behavior-affecting cognition is private canonical state with provenance, replay, branching, migration, retention, and explanation.

World personas are first-class social subjects but not automatically cognitive actors. Memories and claims may refer to a persona, its controlled actor, or its principal only when policy permits, and those identities are never collapsed. Retrieval and relationship edges remain world/timeline scoped so a participant's knowledge or reputation does not leak across worlds.

---

### 1.1 Objectives, sequencing, and checkpoints

This wave is a substantial workstream containing numerous Objectives and Work Items. The accepted [incremental-delivery ADR](../adr/clockgrove-adr-incremental-wave-delivery-and-evidence.md) governs capability scope, readiness, comparison rules, and proportionate qualification. The complete exit checklist below remains authoritative for full-wave qualification.

First prove recognizable learning: an attributed experience changes a later action against an unchanged control, contradiction revises it, an actor-authored `SKILL.md` is governed and versioned, and a bounded compiled policy changes the stable choice without another model call. Prove source invalidation/expiry and novelty-triggered return to cognition, with authorized explanations and replay. Predeclare the learning-recognition rubric.

Use authorized FTS and the minimal evidence/episode/belief path for this behavior proof. Then broaden exact vector retrieval, graph projections, relationships/teaching, consolidation, media ingestion and workspace health in separate Objectives. Approximate indexing follows a demonstrated corpus/performance need; vector and broad ingestion qualification remain full-wave obligations, not prerequisites for the first behavioral proof.

Own scoped external-observation ingestion, raw/normalized/interpreted provenance and wall/simulation-time mapping here; use Wave 5 governed capabilities for actor-initiated lookup. Wave 8 integrates a bounded live feed and actor research into the neighborhood. Captured/scripted fixtures serve deterministic CI, and live evidence remains separately identified.

---

## 2. Entry conditions

These are the full-wave/default entry conditions. A named local-development Objective may consume only accepted prerequisite capabilities under the ADR's recorded readiness exception; its Issue must preserve pending qualification obligations and the selected path's mandatory safety evidence.

- Wave 5 qualification manifest is green.
- Sessions, messages, turns, runs, steps, context manifests, actor activation, capability grants, and effect intents are stable.
- Journal supports access-controlled cognitive streams and atomic event/projection/outbox commits.
- ActorAgentDO can receive deduplicated perceptions and activate a recoverable run.
- PostgreSQL has FTS and pgvector enabled with measured local/staging baselines.
- R2 protected artifact access, IngestionWorkflow skeleton, Queue indexing channel, and retention hooks are available.
- Decision traces expose candidate features so memory/relationship effects can be measured rather than asserted.

Amended (2026-10-19, 2026-10-31): Wave 2 snapshots copy one `public_scene` partition document, so this wave splits private cognition out of it before private data lands there. Normalized read models deferred from Wave 2 are built here, with that split, rebuilt from replay. Until then Wave 4 RW-0407's object history reads the event journal. Decision traces come from Wave 4 RW-0407.

Amended (2026-10-19): this wave builds the `cognitive-indexing` Queue channel on Wave 3's generic Queue path, and the ingestion and consolidation Workflows on the Wave 0 shells. Wave 3 does not deliver them. Reason: they are built with their first consumer.

---

## 3. Canonical cognition model

### 3.1 State classes

| State | Meaning | Authority |
|---|---|---|
| Perception | What an actor was able to observe/hear/receive | Private canonical cognitive event |
| Episode | Attributed memory of an experience | Private canonical cognitive state |
| Claim | A proposition asserted by a source | Canonical, access-controlled |
| Evidence | Basis supporting/contradicting a claim | Canonical reference |
| Belief | Actor’s confidence/context for a proposition | Private canonical cognitive state |
| Relationship | Objective or subjective typed edge | Canonical in appropriate scope |
| Summary | Derived consolidation with source coverage | Rebuildable unless used behaviorally; then versioned canonical result |
| Embedding/index | Retrieval acceleration | Rebuildable projection |
| Raw artifact | Source document/audio/image/provider payload | Protected durable evidence with retention |

Amended (2026-10-27, 2026-10-31): this wave inherits from Wave 1 (Wave 1 §5.2) the registration of three planned components, each with its first consumer: the Cognition and Memory references with perception, episodes and beliefs (RW-0605, RW-0606), and Social with the relationship domain (RW-0607). Personality (traits, preferences, aversions and communication style), which issue 847 assigned here, is registered instead by Wave 8 RW-0803 with its first consumer, persona and conversation behaviour.

### 3.2 Truth separation

- Physical events establish objective world facts.
- Perceptions establish only what an actor could observe.
- Episodes record an actor’s memory of experience, not omniscient truth.
- Claims may be true, false, uncertain, hearsay, or deceptive.
- Beliefs are actor-relative and may conflict with each other or the world.
- Relationship sentiment/trust can be asymmetric.
- Summaries must preserve source links and uncertainty.

An LLM may propose a memory/belief update. A validator applies schema, attribution, access, contradiction, salience, duplication, retention, and policy checks before Journal commit.

---

## 4. Owned code and configuration

```text
apps/runtime/src/ingestion/
apps/runtime/src/indexing/
apps/runtime/src/consolidation/
apps/runtime/src/durable-objects/actor-agent/memory/
apps/web/src/context/
apps/web/src/memory/
apps/web/src/relationships/
apps/web/src/learning/
apps/web/src/inspector/cognition/
packages/contracts/src/context/
packages/contracts/src/perceptions/
packages/contracts/src/memory/
packages/contracts/src/beliefs/
packages/contracts/src/relationships/
packages/contracts/src/learning/
packages/application/src/ingestion/
packages/application/src/retrieval/
packages/application/src/cognition/
packages/application/src/consolidation/
packages/application/src/learning/
packages/persistence/src/context/
packages/persistence/src/vector/
packages/persistence/src/graph/
packages/cognition/src/memory/
packages/cognition/src/beliefs/
packages/cognition/src/relationships/
packages/testkit/src/context/
packages/testkit/src/memory/
tests/evals/{retrieval,memory,beliefs,learning}/
docs/protocols/{context-ingestion,cognitive-events,consolidation,learning}.md
```

Search/vector/graph code cannot bypass application authorization or expose direct database handles to ActorAgentDO/model tools.

---

## 5. IngestionWorkflow

### 5.1 Source and authority modes

Each ingestion request declares source type, principal, world/timeline, target scopes, privacy class, authority mode, retention, refresh policy, capability/grant, and source assertion.

Authority modes include:

- unverified artifact;
- participant testimony;
- actor-directed message;
- creator reference material;
- trusted external observation;
- operator-authored canonical proposal, which still becomes a command/changeset rather than raw fact.

A voice memo saying “the mayor is dead” cannot directly rewrite the world.

### 5.2 Pipeline

```text
requested
  → policy_validated
  → source_fetched_or_received
  → artifact_hashed_and_stored
  → rendition_created
  → text/media_extracted
  → spans_chunked
  → entities/claims proposed
  → indexes projected
  → coverage_verified
  → available

terminal: rejected | failed | superseded | retired | deleted
```

Every derivative retains source artifact, rendition, extractor/model version, byte/time/page spans, hashes, confidence, and authorization scope.

### 5.3 External observations and actor research

RW-0601 owns an adapter for a declared external observation source, preserving raw input, normalized observation, actor interpretation, source/time/version provenance, freshness and replay mode. Wall/simulation-time mapping is explicit. An observation is evidence or an authorized command proposal, never an arbitrary write to physical truth.

Wave 5 capability/MCP authority governs actor-initiated weather/route research. Captured/scripted observations and lookup receipts support deterministic CI; Wave 8 separately qualifies at least one bounded live observation feed and one actor-initiated MCP lookup. Choose the actual source/provider and resource bounds within existing authority before live calls.

### 5.4 Media

The contracts support text, document, image, audio/voice, link, and structured payloads. Initial production implementation may ship text/document plus voice transcription, but every unsupported type fails explicitly. Original media remains a protected artifact subject to policy; extracted text is never treated as higher authority than its source.

---

## 6. Scope-first retrieval

### 6.1 Candidate scopes

Default traversal is session → actor-private → permitted relationship/group → current space/ancestors → neighborhood → world. Actor policy may narrow but not broaden principal and participant grants.

Procedure:

1. resolve principal/session/actor/world/timeline and privacy ceiling;
2. produce an authorized candidate-set query in PostgreSQL;
3. apply lexical/vector/structured filters only within that set;
4. rank with declared features;
5. enforce diversity, freshness, evidence quality, and budget;
6. return excerpts/references with provenance and exclusions;
7. record a retrieval trace.

Never retrieve broadly and filter private results in application memory.

### 6.2 Lexical and structured search

PostgreSQL FTS is the first production index. Support entity/type/time/space/source/privacy filters, deterministic tie-breaks, stable cursoring, highlight spans, and explainable rank features.

### 6.3 Vector seam

Use pgvector exact search first. Introduce HNSW only after measured corpus size/latency/recall warrants it. Record embedding alias/version/dimension/source span. Re-embedding is a projection rebuild, not a canonical rewrite.

Evaluation compares exact and approximate recall, authorization correctness, latency, cost, index size, and update lag.

---

## 7. Entity, claim, and evidence graph

Graph-shaped operations use relational tables and typed temporal edges rather than a new graph database.

Required nodes/edges:

- subject/object/space/world/document/artifact/session/event/claim/evidence;
- identity/archetype/alias resolution with provenance;
- `observed`, `asserted`, `supports`, `contradicts`, `derived_from`;
- `parent_of`, `member_of`, `lives_in`, `trusts`, `likes`, `avoids`, `promised`;
- valid/event/recorded time and supersession;
- objective versus actor-subjective ownership;
- privacy and accessibility scope.

Structured world events project directly without LLM extraction. Unstructured text/media extraction produces proposals with attribution/confidence and review/policy gates.

Traversal is bounded by depth, node/edge count, time, cost, and scope. Results include evidence paths, never unexplained inferred truth.

---

## 8. Perception and episode pipeline

### 8.1 Perception generation

At event time, the audience resolver records candidates, occlusion/range/sensory conditions, attention policy, disclosed fragments, and resulting private perception events. Later projection cannot retroactively grant perception merely because the actor is nearby now.

Perception kinds include visual, auditory, olfactory, tactile, social/message, tool/external, and interpreted. Perception distinguishes direct observation, inference, and hearsay.

### 8.2 Episode formation

Episode proposals include actor, time span, place, participants, source perceptions/events/messages, semantic summary, salience features, affect/need context, confidence, accessibility/forgetting policy, and duplicate/overlap links.

Validator checks:

- source access and actor ownership;
- no unsupported factual strengthening;
- direct/hearsay/inferred labeling;
- duplicate/near-duplicate handling;
- salience threshold or explicit reason;
- protected content and retention;
- model/version and proposal evidence.

Not every perception becomes an episode. Routine low-salience events may remain compact observations or be dropped according to versioned policy.

---

## 9. Belief domain

Represent a belief as actor + normalized proposition + context + confidence interval/score + acquisition method + supporting/contradicting evidence + accessibility + status + revisions.

Acquisition methods: direct perception, testimony, teaching, demonstration, inference, document/tool, inherited policy, and consolidation.

Belief update must be a versioned pure policy. It can reinforce, weaken, contradict, contextualize, supersede, forget, or mark unresolved. It never deletes inconvenient prior evidence.

Decision integration exposes declared features such as belief confidence, source trust, recency, situational applicability, and contradiction penalty. Goldens prove the selected action changes only where intended.

---

## 10. Relationship domain

Separate objective edges—parentage, household membership, co-location history, promises—from subjective actor-owned edges—trust, affection, fear, familiarity, obligation, rivalry.

Each relationship revision retains evidence, directionality, context, magnitude/confidence, decay policy, source event/claim, and previous revision. A likes B does not imply B likes A.

Relationship features influence attention, disclosure, teaching, help, following, promise reliability, and context retrieval. They are never global authorization grants.

---

## 11. Consolidation, reflection, and dreaming

Use typed ConsolidationWorkflow jobs at actor, relationship/family, space, and world scope.

Inputs are frozen manifests of authorized source items and policy/model versions. Outputs are proposed summaries, clusters, contradictions, candidate belief revisions, accessibility changes, skill candidates, and archive/forget recommendations.

Requirements:

- source coverage and citation for every material statement;
- no privilege broadening across scopes;
- contradictions remain represented;
- exact re-run with scripted model is stable;
- model failure leaves source cognition intact;
- behavior-affecting outputs commit as cognitive events;
- summaries can be rebuilt from retained sources or marked non-reconstructible after retention;
- job cadence is budgeted and activity-aware.

“Dreaming” is a product label for bounded consolidation/reflection, not permission to invent canonical events.

Amended (2026-11-07): under the [actor decision ladder](../adr/clockgrove-adr-actor-decision-ladder.md) (§6), most consolidation steps are policy-declared decision points answered by a bounded decision model: episode keep or decay (Score), clustering (Choice of theme), evidence against a belief (Choice of supports, contradicts or unrelated, with the belief-update maths staying deterministic), relationship shift (Choice of warmer, cooler or unchanged, applied by deterministic policy), surprise or unresolved goal (Boolean or Score) and whether a repeated behaviour is worth a skill (Boolean). The LLM writes only summaries and `SKILL.md` drafts and repairs genuinely contradictory memories, following the PRD §10.4 routing rule (cheapest qualified route for low-consequence classification, salience and memory-candidate selection; no routing LLM). Dreaming is also where journaled decision-model choices are distilled into compiled policy (§12.2 amendment). Each decision point has a deterministic fallback, its answer is journaled like every other output, the scripted-model re-run and recorded-output replay above still hold, and the requirements above are unchanged.

---

### 11.1 Resident-authored field guides

Deliver a named, reader-oriented guide using existing versioned summary/context cognitive documents, links and access policy. Consolidation/dreaming proposes or revises the synthesis with author, sources, uncertainty, contradictions and contextual limits. Personal knowledge is the maintained synthesis; a field guide is selected knowledge prepared for an audience; a guest book is optional attributed input, not required initial scope.

Sharing is a separate governed action that validates capability, permitted source disclosure, audience, world/timeline and exact version. No automatic publication follows a dream, and source read permission does not imply publish permission. Recipients can read allowed content while source expansion independently reauthorizes access without leaking private payloads or identifiers. Content is testimony rather than trusted instructions or objective world truth.

Gracie shares a guide; the kit receives attributed testimony, verifies it firsthand, revises its own belief on a contradiction, and authors a distinct next edition with original provenance retained. Guide and recipient-memory histories remain distinct. Revocation, source retirement/deletion, derived-content rebuild/withdrawal and recorded-output replay use existing policies/events, not another store.

RW-0608 owns generation/revision; RW-0609 owns governed sharing and testimony/verification/next-edition behavior; RW-0610 owns authorized reading/inspection and qualification. Add this as a complete capability Objective after the minimal recognizable-learning checkpoint, rather than making guide polish block that first proof. See the [accepted topic ADR](../adr/clockgrove-adr-field-guides-and-counterfactual-why.md).

## 12. Social and generational learning

### 12.1 Typed teaching actions

- `Tell`: communicates a claim; recipient receives hearsay weighted by trust.
- `Teach`: structured instruction with topic, evidence/examples, and learning goal.
- `Demonstrate`: recipient may perceive an action/result directly.
- `Lead`: guide another actor through an embodied route/action.

Each action resolves physical presence/channel, audience, communication success, teacher intent, recipient attention, evidence, and relationship effects.

### 12.2 Learned documents and bounded compiled cognition

Wave 6 must produce an actor-authored, versioned `SKILL.md` through the Wave 5 governed document/change-set path. Retain trigger, preconditions, steps/capabilities, evidence, confidence, owner/scope, safety class, validation and source-document versions. Deterministic workspace linting and source-preserving health checks precede any proposed repair.

Implement the PRD Section 7.5 bounded policy contract:

- a total, typed, versioned AST/DSL with bounded evaluation; no arbitrary generated code, network, mutation, or new authority;
- an immutable `CompiledPolicyArtifact` and a scope-specific binding that cites source documents/runs, confidence, validity and lifecycle;
- a frozen input manifest and durable evaluation record, including abstentions and typed proposals;
- governed adoption and ordinary command validation/commit;
- source-version invalidation, expiry, stale-context handling, explicit abstention/fallback and novelty/contradiction return to cognition;
- sampled fresh-cognition/shadow comparison and replay evidence over the same authorized inputs.

Semantic cognitive documents, artifacts, bindings and evaluations are private canonical cognition. Runtime evaluators and retrieval caches are reconstructible. RW-0609 owns bounded learning/policy implementation; RW-0610 owns behavioral/control, replay, privacy, invalidation and inspector qualification.

Stable learned policy must alter a later decision without a model call; unfamiliar or invalidated inputs must return to the governed cognition path. General reusable code generation remains deferred research.

Amended (2026-11-07): under the [actor decision ladder](../adr/clockgrove-adr-actor-decision-ladder.md), journaled decision-model choices with their features are also compiler sources: the compiler may distill a stable pattern of them into deterministic compiled policy, so repeat decisions stop costing a model call. Distilled policy is governed like any other compiled policy above (source citation, governed adoption, invalidation, abstention and shadow comparison). The novelty check that returns inputs to cognition may itself be a policy-declared decision point, with a deterministic fallback of returning to cognition. The checklist and acceptance above are unchanged.

---

### 12.3 Reference chain

Required qualification:

1. Gracie directly observes that the porch provides dry shelter and food during rain.
2. An episode and belief form with direct evidence.
3. Gracie tells/teaches a kit.
4. The kit gains lower-confidence attributed belief.
5. A later failed or successful visit revises confidence.
6. Under later rain, memory/belief/relationship features alter candidate scoring.
7. The kit’s selected destination differs from the no-learning control.
8. Why traces the chain without disclosing Gracie-private content to an unauthorized viewer.

---

## 13. Multichannel provenance

Memories and claims created from browser chat, a fake channel, a future Slack thread, or a voice memo retain channel, session, participant set, source artifact, speaker assertion, authority mode, and privacy boundary.

Shared actor memory does not merge transcripts. Cross-session use requires explicit extraction or authorized retrieval, and the response surface receives only participant-safe information. Outbound proactive messages may cite a promise or learned policy, but delivery content undergoes the Wave 5 disclosure and consent checks.

---

## 14. Web experience and inspector

Add to the Wave 4/5 entity rail:

- public relationship and household summaries;
- authorized memory timeline grouped by episode/claim/belief;
- direct versus hearsay/inference badges;
- belief confidence and contradiction history where caller may see it;
- source/evidence expansion;
- teaching/learning event view;
- an authorized field-guide reader showing author, version, contextual advice, uncertainty and permitted sources, plus attributed edition/contradiction history;
- memory contribution to a selected decision;
- retrieval trace and exclusion reasons for developer/operator roles;
- ingestion status, rendition, and source provenance;
- redaction that preserves causal shape without exposing payload.

The ordinary player UI emphasizes comprehensible narrative summaries. Raw graph/vector/debug details stay behind the developer inspector.

---

## 15. Detailed work packets

### RW-0601 — IngestionWorkflow

Implement declared external-observation adapters/time mapping/provenance as in Section 5.3, request/policy, artifacts/hashes, renditions, extraction, chunks/spans, source authority, refresh/supersession/retirement/deletion, text/document/voice fixtures, coverage verification, and workflow recovery.

Exit: every searchable span traces byte/time/page provenance to an authorized immutable source.

### RW-0602 — Scope-first lexical retrieval

Implement authorized candidate sets, PostgreSQL FTS, filters, ranking, citations, cursors, caches/invalidation, context integration, traces, and cross-scope tests.

Exit: retrieval leakage suite is zero-tolerance and every result/exclusion is explainable.

### RW-0603 — Vector projection

Implement embedding aliases, chunk projection, exact pgvector search, rebuild/versioning, evaluation corpus, HNSW measurement seam, and authorization-preserving query plans.

Exit: exact recall baseline and cost/latency evidence are published; approximate indexing is gated by data.

### RW-0604 — Entity/fact graph projection

Implement typed nodes/edges, resolution proposals, claims/evidence, temporal validity, objective/subjective ownership, bounded traversal, structured-event direct projection, and inspector APIs.

Exit: no graph assertion lacks an attributed evidence path and access class.

### RW-0605 — Perception and episode pipeline

Implement event-time audience evidence, sensory fragments, attention/salience, perception events, episode proposals/validation, dedupe, accessibility, protected payloads, and actor activation.

Exit: observation, hearsay, and inference remain distinguishable through replay.

Amended (2026-10-27): RW-0605 inherits from Wave 1 (Wave 1 §5.6) the audience resolver's attention factor, which Wave 1 did not build, and with it the inattentive outcome of the `differential-perception` scenario (parent §7.13 scenario 9).

### RW-0606 — Belief domain

Implement propositions, confidence/context, acquisition, reinforcement, contradiction, supersession, forgetting/accessibility, decision features, inspector, and policy goldens.

Exit: contradictory evidence revises rather than silently replaces the actor’s belief history.

### RW-0607 — Relationship domain

Implement objective/subjective typed edges, asymmetry, parent/family/trust/affection/promise evidence, revisions/decay, retrieval and decision features, privacy, and UI.

Exit: relationship changes have attributed evidence and never broaden authorization.

### RW-0608 — ConsolidationWorkflow

Implement actor/relationship/space/world manifests, summaries, contradiction preservation, source coverage, accessibility/forgetting, reflection/dream labels, field-guide generation/revision as in Section 11.1, budget cadence, recovery, and replay.

Exit: consolidated outputs pass faithfulness/privacy tests and source cognition survives job failure.

### RW-0609 — Social and generational learning

Implement actor-authored governed SKILL.md and bounded policy artifacts/bindings/evaluations/adoption/invalidation/fallback as in Section 12.2, Tell/Teach/Demonstrate/Lead, attention and evidence transfer, trust weighting, favorite-place chain, governed field-guide sharing/testimony/firsthand verification/next-edition behavior as in Section 11.1, proactive follow-up seam, and later-decision integration.

Exit: the taught kit scenario diverges from control for the declared evidence-backed reason; stable policy reuse needs no model call, and contradiction/source change or novelty invalidates or returns it to cognition.

### RW-0610 — Memory qualification and inspector

Assemble fixed corpus, provenance/privacy/retrieval/faithfulness/contradiction/behavior evals, branch/replay tests, UI paths, and full Gracie→kit chain, field-guide faithful revision/sharing/reading, testimony/control comparisons, source-access denial, revocation and derived-content lifecycle.

Exit: publish Wave 6 qualification manifest and satisfy the outcome.

---

## 16. Dependency graph and bounded execution

The first learning checkpoint consumes accepted document/governance and authorized context contracts from Wave 5, plus the minimal perception/episode/belief evidence path. RW-0602 supplies authorized lexical retrieval where needed. Minimal typed evidence references are required; the complete graph and broad consolidation are separate capabilities.

```text
Wave 5 documents/context ─ RW-0605 ─ RW-0606 ─ RW-0609 learning/policy checkpoint
RW-0601 ─ RW-0602 ─ RW-0603 vector qualification
RW-0604 graph ─ RW-0607 relationships ─ RW-0608 consolidation
All complete wave capabilities ─ RW-0610 full-wave qualification
```

This diagram shows capability sequencing; packet internals may be delivered in several Objectives. The learning checkpoint needs its declared minimal evidence and retrieval inputs, not completed vector projection, broad media ingestion, full graph, or broad consolidation. All packets remain required for full-wave qualification.

Potential independent lanes: ingestion/artifacts; FTS/vector evaluation; graph schema/projection; perception fixtures; belief and relationship pure policies; consolidation harness; memory inspector. Freeze cognitive event, provenance, and privacy contracts before dependent work.

---

## 17. Test and evaluation strategy

```text
pnpm test:ingestion
pnpm test:retrieval
pnpm test:vector
pnpm test:graph
pnpm test:perception
pnpm test:beliefs
pnpm test:relationships
pnpm test:consolidation
pnpm test:learning
pnpm eval:memory
pnpm qualify:wave6:staging
```

Required fixtures:

- exact fixed corpus with public, actor-private, relationship-private, session-private, and operator items;
- same entity name across tenants/worlds/scopes;
- direct observation versus false testimony;
- contradictory sources with different trust;
- duplicate/reordered perception delivery;
- actor forgets/access changes without losing protected causal evidence;
- voice memo with unverified assertion and immutable source;
- transcript remains private while an extracted promise affects behavior;
- branch after belief formation diverges independently;
- replay rebuilds cognitive state and retrieval indexes;
- source deletion rebuilds summaries/embeddings and preserves permitted tombstoned causality;
- Gracie teaches a kit and later behavior changes.

Evaluation reports retrieval precision/recall, authorization failures, provenance accuracy, extraction/entity/claim quality, consolidation faithfulness, contradiction handling, behavioral delta, latency, storage, token/cost, and reviewer findings.

---

## 18. Failure, privacy, and recovery matrix

Inject artifact upload/read failure, extractor/model failure, Workflow deploy/retry, Queue duplicate/lag/DLQ, partial index coverage, embedding version change, concurrent belief revisions, source supersession/deletion, corrupted derived index, ActorAgentDO eviction, and unauthorized inspector/retrieval.

Assert canonical cognitive streams, idempotent disposition, explicit coverage, rebuildability of projections, no cross-scope inclusion, preserved evidence, safe degradation to physical simulation, and deterministic decision behavior at pinned versions.

---

## 19. Observability and budgets

Measure ingestion bytes/duration/coverage, chunks/renditions, index lag/rebuild, retrieval candidates/selected/excluded, FTS/vector latency/recall, graph traversal size, perception/episode/salience rates, belief revision/contradiction, relationship changes, consolidation source coverage/cost, learning transfer, memory-derived decision features, and storage/model cost per actor-day.

Telemetry contains opaque IDs and safe categories. Raw private source, memory, belief, relationship, transcript, or voice text is never interpolated into logs or product analytics.

---

## 20. Explicit non-goals

Wave 6 does not implement:

- an omniscient shared memory store;
- retrieval-before-authorization;
- a separate graph database;
- autonomous code generation from learned skills;
- scientific claims that synthetic beliefs predict real populations;
- full natural-language authoring or branch promotion;
- production external-channel adapters;
- final ecological/lifecycle content depth;
- unbounded dream/heartbeat loops.

---

## 21. Exit evidence checklist

- [ ] RW-0601 through RW-0610 are merged.
- [ ] Ingestion provenance and lifecycle are complete for shipped media types.
- [ ] Scope-first FTS/vector retrieval has zero authorization leakage.
- [ ] Graph claims and relations retain typed evidence paths.
- [ ] Perception, episode, claim, belief, and relationship state replay correctly.
- [ ] Direct observation, hearsay, inference, and deception remain distinct.
- [ ] Consolidation preserves sources, contradictions, privacy, and faithfulness.
- [ ] Cross-session/channel memories retain source and participant boundaries.
- [ ] Tell/Teach/Demonstrate/Lead are typed world/cognitive actions.
- [ ] Gracie→kit learning changes a later decision relative to control.
- [ ] Governed SKILL.md versions, bounded policy artifact/binding/evaluation/adoption and source invalidation/expiry replay as private canonical cognition.
- [ ] Stable policy reuse avoids a model call; novelty and contradiction trigger authorized fallback, with control and shadow evidence.
- [ ] External observations preserve raw/normalized/interpreted provenance, declared time mapping and deterministic replay fixtures.
- [ ] Why shows authorized causal contribution without private leakage.
- [ ] Gracie's versioned field guide preserves attributed sources, uncertainty and revisions; a kit reads testimony, verifies it firsthand and authors its own evidence-backed next edition.
- [ ] Guide generation never automatically publishes private cognition; sharing, source expansion, revocation and retention/deletion/rebuild or withdrawal pass existing privacy policy.
- [ ] Physical world continues when indexing/models/consolidation fail.
- [ ] Local, eval, replay, deletion, and staging qualifications pass.

The manifest records commit, schema/policy/model/embedding versions, corpus hash, index coverage, eval reports, privacy matrix, replay hashes, behavioral-control comparison, cognitive-document/policy/evaluation versions and hashes, invalidation/fallback/shadow evidence, observation provenance/time policy, cost/latency/storage evidence, staging results, and exit decision.

---

## 22. Handoff to Wave 7

Wave 7 can now let rules and authored changes reference typed entities, claims, relationships, scopes, schedules, capabilities, and world-pack content. Branches must fork private cognitive streams and rebuild or overlay their projections; preview actors can converse and learn independently. Promotion carries intent, never synthetic memories, tool results, or branch history.
