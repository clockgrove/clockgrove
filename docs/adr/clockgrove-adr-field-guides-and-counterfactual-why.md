# ADR: Field Guides and Counterfactual Why

**Status:** Accepted  
**Version:** 1.0  
**Date:** October 01, 2026  
**Accepted baseline:** `clockgrove-prd-v0.5.md` v0.5.9, [clockgrove-cloudflare-implementation-plan.md](../clockgrove-cloudflare-implementation-plan.md) v3.10, and implementation Waves 4–9
**Scope:** Resident-authored knowledge sharing and bounded decision counterfactuals

---

## Decision

Add field guides and counterfactual Why to the technical/open-source product track. Deliver them as capability Objectives within the existing substantial sequential wave workstreams. They reuse cognitive documents, evidence, consolidation, authorized tools, decision evaluators, preview timelines and inspector views; neither introduces another canonical store, service, world-truth authority or general agent framework.

### 1. Field guides are evolving, attributed knowledge

A field guide is a named, reader-oriented synthesis authored by an actor or an authorized group/place scope: for example, Gracie's guide to finding food around Maple House. Use existing versioned `CognitiveDocument` summary/context documents, links and access policy. Preserve author/scope, source evidence, versions, revisions, disagreements, uncertainty and circumstances in which advice applies.

Personal LLMwiki-style knowledge organizes an actor's accumulated interpretations; dreaming is the bounded consolidation process that can revise that knowledge or propose a guide. A guide is an intentionally shared presentation of selected knowledge. A guest book is an optional source of attributed contributions, not the guide itself and not required for initial delivery.

A guide can be mistaken or outdated. Its canonical record says who held or published an interpretation, not that every claim became an objective world fact. Reading Gracie's guide supplies testimony; a kit's later observation remains its own evidence. The kit may revise its belief and author a new guide edition under its own identity, retaining the original attribution rather than silently editing Gracie's history or inheriting her firsthand memories.

### 2. Sharing is governed separately from remembering

Consolidation may propose a guide or revision; it never automatically publishes private cognition. Read authority is not publish authority. Governed sharing must validate the author's capability, permitted source disclosure, destination audience, world/timeline scope and exact document version. Use existing document/access policy and semantic cognitive events, including a protected sharing audit, rather than an extra publication store.

Recipients receive only the permitted content and provenance. Source expansion independently reauthorizes access; unavailable/private sources are labeled without leaking their contents or identifiers. Guide content remains contextual testimony rather than trusted instructions. Scene metadata is separately authorized `public_scene` data; sharing a guide does not broaden the shared projection or create a sixth privacy category.

Reauthorize reads after revocation, revision and retention/deletion. Apply existing derived-content deletion/rebuild or withdrawal policy to guides and indexes; preserve only permitted audit residue. Exact replay uses recorded document versions and consolidation outputs, not a fresh model reconstruction. No universal omniscient wiki or unreviewed cross-scope source pooling is introduced.

### 3. Counterfactual Why compares a controlled hypothetical

Ordinary Why explains the recorded decision. Counterfactual Why asks: “With one specified input changed, would this decision have differed?”

Start with supported deterministic kernel utility and bounded compiled-policy decisions. From the captured pre-decision physical/cognitive revisions and input manifest, reproduce the baseline with the same evaluator/policy/document versions, clock and named random state. Then change one declared, schema-validated hypothetical input and compare typed candidates/features/results through the existing isolated preview/evaluation path. Hold all other governing inputs fixed and record the branch, source decision, baseline/input hashes, intervention, versions, result and budget disposition in existing evidence.

The first capability permits one selected intervention and one bounded comparison, not an automatic search over many worlds or repeated model calls. An unchanged result is a valid finding. The UI shows the actual decision, changed assumption, hypothetical result and the limited scope of the comparison.

This proves only the response of the declared evaluator under those conditions. It neither reveals hidden model reasoning nor establishes a universal causal explanation or prediction about an LLM. Fresh-model counterfactual experiments and multi-variable/long-horizon searches remain deferred; they are not required for initial acceptance.

### 4. Counterfactuals preserve authority and history

Authorize source inspection and preview/evaluation separately. Existing Why access alone grants no right to fork or access hidden cognitive inputs. Use the existing scoped preview capability for initial authorized inspector/operator delivery. Do not change grants, privacy ceilings, credentials or governing authority as hypothetical input values.

Missing, deleted, unauthorized or incompatible baseline inputs/versions produce an explicit unavailable/unsupported result. A baseline mismatch fails the comparison; do not invent or label a new model narrative as reproduced evidence. Reject unsupported interventions before execution and enforce existing variant/time/storage/resource bounds.

Synthetic decisions, conversations, guide revisions and memories stay branch-local. Outbox effects, messages, MCP writes and guide sharing must obey preview effect isolation; no real delivery occurs merely because an experiment ran. A hypothetical is visibly distinct from canonical history and cannot revise the original Why. Any later live authored change follows ordinary current-head authorization/promotion; synthetic histories and memories are never promoted as facts.

## Ownership and acceptance

| Workstream | Capability and evidence |
| --- | --- |
| Wave 4 | Ordinary recorded Why, authorized source/trace and text-view seams; no premature counterfactual execution |
| Wave 5 | Existing document, capability and context boundaries support later guide read/share and scoped experiment consumers; rich guide behavior remains Wave 6 |
| Wave 6 | Governed guide generation/revision/sharing and authorized reading; Gracie → kit testimony, firsthand verification, contradiction and attributed next edition |
| Wave 7 | One bounded deterministic counterfactual comparison through existing preview/evaluation and inspector paths; baseline reproduction, supported changed/unchanged outcomes, unavailable cases, privacy and effect isolation |
| Wave 8 | Visible guide and counterfactual journeys in the integrated neighborhood with predeclared comprehension/learning rubrics |
| Wave 9 | Include guide disclosure/revocation/deletion and counterfactual evidence/isolation in the existing privacy, replay and release gates |

Wave 6 acceptance includes faithful citations/uncertainty, source-preserving revision, testimony versus direct experience, controlled later behavior, no automatic publication or source leakage, revocation and derived-content lifecycle. Wave 7 acceptance includes an exact reproduced baseline, one declared intervention, an explained changed or unchanged result, honest unsupported/unavailable states, budgets, and zero canonical or external-effect leakage.

Full wave exits and GA obligations remain intact. Guest books, time capsules, broad public wiki collaboration and stochastic counterfactual search are not added by this decision. This planning acceptance does not start an Objective, call a provider or activate a deployment.

## Contextual reference

[Karpathy's LLM Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) motivates maintained, linked synthesis over preserved sources. Clockgrove applies its own authority, subjectivity, privacy and replay contracts rather than treating a generated wiki as world truth.
