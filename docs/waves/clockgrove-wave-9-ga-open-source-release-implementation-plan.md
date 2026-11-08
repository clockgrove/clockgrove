# Clockgrove Wave 9: GA Operations and Open-Source Release

**Status:** Coding-agent implementation specification  
**Version:** 1.9  
**Date:** October 27, 2026
**Parent plan:** `raccoon-world-cloudflare-implementation-plan.md` v3.12  
**Product source:** `clockgrove-prd-v0.5.md` v0.5.9  
**Wave:** 9 of 13; technical/open-source GA  
**Assumptions:** Waves 0–8 are qualified; Raccoon World is already demo-quality  
**Development tooling:** external tools such as `clockgrove/factory` may execute this wave; the released Clockgrove product does not depend on them.

---

## 1. Outcome

Wave 9 proves Clockgrove can be trusted, reproduced, extended, and operated as an open-source project with a hosted reference deployment. It implements administration, privacy lifecycle, resource controls, production observability, backup/restore/DR, capacity qualification, security review, public documentation, release engineering, and the final evidence gate.

The wave exits only when:

> A clean contributor can reproduce the stack and demo; an operator can detect, contain, recover, export, delete, and explain failures; the hosted reference meets declared SLO/security/cost bounds; and the public repository ships with complete provenance, documentation, and no unresolved invariant failure.

“GA” is a technical quality gate, not a commitment to monetize, form a company, add enterprise features, or collect payment.

---

### 1.1 Objectives, sequencing, and checkpoints

This wave is a substantial workstream containing numerous Objectives and Work Items. The accepted [incremental-delivery ADR](../adr/clockgrove-adr-incremental-wave-delivery-and-evidence.md) governs capability scope, readiness, comparison rules, and proportionate qualification. The complete exit checklist below remains authoritative for full-wave qualification.

Qualify technical/open-source GA on one frozen final candidate, owned by one qualification coordinator with independent review. Build and install the exact passing artifact; bind each receipt to candidate, host, scenario and provenance.

Deliver security/privacy lifecycle, clean restore/replay, runbooks/SLOs, supported measured capacity and release engineering as complete Objectives. Distinguish ordinary north-star acceptance, fault injection and load/capacity scenarios. One million logical actors is a qualification target, not a claim of one million active model conversations.

Use focused checks while implementing/repairing; run the full applicable release gate at the stable candidate boundary and rerun invalidated evidence after change. Share compatible evidence without relabeling it. The maintenance cadence below applies to operation of the accepted release and is not a demand to rerun every broad suite during every intermediate fix.

Waves 10–11 remain the separate hosted/shared-world continuation; Wave 12 is optional commercial hosting. They do not block technical/open-source GA or pull Redis/Stripe into its local stack.

---

## 2. Entry conditions

These are the full-wave/default entry conditions. A named local-development Objective may consume only accepted prerequisite capabilities under the ADR's recorded readiness exception; its Issue must preserve pending qualification obligations and the selected path's mandatory safety evidence.

- Wave 8 qualification manifest approves the demo.
- All ten scenario manifests and the north-star trace are green.
- Wave 0 clean-room provenance, repository, environments, reproducibility, and source/asset evidence remain intact.
- No private code, assets, prompts, infrastructure, credentials, or product identity from unrelated projects are present.
- Hosted deployment has development/staging/production isolation, but production contains no irreplaceable manual state outside documented stores/configuration.
- SLOs, retention, cost, privacy, browser, support, and release targets are proposed and reviewable.

---

## 3. Release principles

1. PostgreSQL/Journal remain canonical in operations and recovery.
2. Every runbook uses product inspector/evidence, not undocumented provider-console intuition.
3. Local/OSS and hosted paths share core code and contracts; hosted Cloudflare/Neon dependencies are explicit.
4. Security/privacy controls apply to operators and developers as well as users.
5. Backups are not trusted until restore/replay verification passes.
6. Deletion includes derived projections/indexes/caches/provider artifacts and verified audit.
7. Resource metering controls cost; it does not couple simulation semantics to a payment vendor.
8. Kill switches are scoped, audited, reversible, and tested.
9. Public docs contain no secrets or private architecture assumptions.
10. Release is blocked by invariant, cross-tenant, replay, protected-effect, or provenance failures.

---

## 4. Owned code and configuration

```text
apps/admin/
apps/runtime/src/admin/
apps/runtime/src/privacy/
apps/runtime/src/quotas/
apps/runtime/src/moderation/
apps/runtime/src/operations/
packages/contracts/src/admin/
packages/contracts/src/privacy/
packages/contracts/src/metering/
packages/application/src/admin/
packages/application/src/privacy/
packages/application/src/operations/
packages/observability/
infra/opentofu/
infra/wrangler/
infra/dashboards/
infra/alerts/
infra/backups/
scripts/release/
scripts/qualification/
tests/load/
tests/chaos/
tests/security/
tests/recovery/
docs/getting-started/
docs/architecture/
docs/api/
docs/mcp/
docs/world-packs/
docs/operations/
docs/security/
docs/contributing/
.github/
LICENSE
NOTICE
SECURITY.md
CONTRIBUTING.md
CODE_OF_CONDUCT.md
```

Generated public docs derive from versioned OpenAPI/Zod/world-pack/MCP contracts where possible and are verified for drift.

---

## 5. Administration and tenancy

### 5.1 Admin functions

- create/archive/restore/delete world within policy;
- invite/remove principals through the configured authentication provider and internal grant mapping;
- assign observer/participant/creator/operator/developer roles and narrower capabilities;
- inspect tenant/world/timeline status, versions, budgets, costs, schedules, queues, actors, sessions, providers, and kill switches;
- pause/resume/read-only a world;
- manage retention/export/deletion cases;
- view moderation/report cases and audit;
- initiate qualified recovery/reconciliation jobs.

All mutations use application commands, require idempotency, and create operator audit evidence. Admin UI never writes provider or database state directly.

### 5.2 Default hosted deployment

The initial hosted reference may be operated by a small maintainer group with invited testers. Multi-tenant contracts and tests remain real because they are security boundaries, not because enterprise sales are planned.

Enterprise SSO, procurement, invoicing, CRM, sales analytics, and customer-specific deployment modes remain out of scope.

---

## 6. Privacy lifecycle

### 6.1 Data inventory

Maintain machine-readable mapping for every class:

- canonical public world events and projections;
- actor-private cognitive events;
- relationship/group/private session data;
- prompts, model/tool payloads, media, transcripts, artifacts;
- embeddings, summaries, graph edges, caches, snapshots, backups;
- field-guide editions, permitted sharing/audiences/source links and counterfactual manifests/branch-local decisions;
- authentication/provider mappings and audit;
- operational telemetry and product analytics.

For each: owner, purpose, authority, privacy class, encryption, retention, exportability, deletion action, rebuildability, provider locations, and tests.

### 6.2 Export

Authorized export contains documented JSON/JSONL event/replay bundles, snapshots/manifests, world-pack/version references, permitted sessions/cognition/runs, artifacts, assets references, and audit summary. It uses stable schemas, checksums, pagination/streaming, expiration, and resumable Workflow.

Amended (2026-10-27): exported event/replay bundles also carry what Wave 2 deferred from its unsigned bundle v1 (Wave 2 §11.2):

- **a signed manifest.** The manifest names the key that signed it, records that key's provenance (the deployment and release that issued it and its validity period) and records the bundle's export time, all under the signature. The private key is a managed secret, rotated by the §9.1 procedures and never written to a bundle or backup. RW-0902 publishes the signing public keys, each with its validity period, with every release. An offline verifier checks the signature over the manifest bytes against the named published key, with no database and no production credentials, before it checks the section hashes and replays. A signature is expired when the recorded export time falls outside the named key's validity period, so a bundle exported before a later rotation still verifies. A missing, unknown, expired or mismatched signature refuses the bundle.
- **the upcaster identifiers needed to replay the included event versions.** For each historic event type and version in the bundle, the manifest names the upcaster that reads it as its current version (Wave 2 §9.3). A verifier that lacks a named upcaster refuses the bundle instead of replaying it differently.

Both change the bundle bytes, so they ship as a new bundle version; Wave 2's v1 and its golden are unchanged.

### 6.3 Deletion

Deletion case:

1. authorize and freeze target inventory;
2. tombstone identity where public causal history must remain;
3. delete/crypto-shred protected PostgreSQL/R2/provider payloads;
4. delete/rebuild embeddings, summaries, graph edges, search, feeds, caches, and DO runtime state;
5. revoke channel/MCP/model credentials and bindings where target-owned;
6. invalidate sessions/tokens and actor caches;
7. verify queries/retrieval/export no longer expose deleted content;
8. track backup expiration and exceptions;
9. produce an audited completion report.

Canonical replay never depends on deleted raw model/tool payloads; retained semantic outcomes and hashes remain only where policy permits.

---

## 7. Abuse, moderation, budgets, and metering

### 7.1 Controls

- WAF/Turnstile and IP/principal rate limits;
- session/actor/world/tenant concurrent-run limits;
- simulation/catch-up/preview/rule/model/tool/storage/delivery budgets;
- Queue backpressure and admission control;
- model/MCP/channel/rule/world/global kill switches;
- actor proactive-contact mute/block/report and quiet hours;
- content/media size/type/rate limits;
- moderation/report hooks for public/shared content;
- operator pause/read-only/emergency effect block.

### 7.2 Resource ledger

Meter compute, storage, egress, model tokens/cost, tool calls, ingestion, embeddings, consolidation, preview, external delivery, and active/dormant actor work by tenant/world/timeline/actor/session where feasible.

The ledger supports quotas, cost attribution, anomaly detection, and future optional pricing analysis. It does not collect money, import Stripe, or change kernel behavior based on a billing vendor.

---

## 8. Production observability and SLOs

### 8.1 Dashboards

- canonical command/event correctness and revision conflicts;
- PostgreSQL/Hyperdrive latency, saturation, failure;
- DO activation/hibernation/mailbox/alarm/catch-up/hot owners;
- Queue/Workflow/fiber age, retry, DLQ, recovery;
- realtime connections, fanout, gaps, reconnect, snapshot fallback;
- model/tool/context/memory/rule/branch usage, cost, quality signals;
- external effects/delivery and uncertain results;
- privacy cases, deletion/export lag, moderation reports;
- asset/client performance, browser/accessibility failures;
- north-star/product evidence and cost allocation.

### 8.2 Initial SLO classes

Declare measured objectives for API/command availability and latency, acknowledged-event durability, simulation lateness, projection convergence/reconnect, conversation durable-status recovery, protected-effect duplication, replay hash correctness, export/deletion completion, backup age/restore, and operator acknowledgement.

Zero-tolerance invariants:

- lost acknowledged canonical event;
- cross-tenant/private-scope disclosure;
- duplicate protected effect;
- replay mismatch for a supported pinned bundle;
- preview effect leakage;
- unreconciled ambiguous ownership after transfer.

Amended (2026-10-19): "unreconciled ambiguous ownership after transfer" moves to Wave 11 with cross-space transfer. GA runs one space owner per world partition (parent §35).

Targets are pinned in release policy after staging/load baselines, not invented in prose.

### 8.3 Alerts

Page on invariant/replay/cross-tenant/protected-effect/database/widespread activation/runaway-cost conditions. Ticket on Queue/DLQ/index/snapshot/provider/retention drift. Every alert links one runbook and evidence query.

---

## 9. Backup, restore, and disaster recovery

### 9.1 Backup scope

- PostgreSQL canonical/events/projections/identity/configuration;
- R2 artifacts, snapshot/replay bundles, reviewed assets/manifests;
- world-pack and schema/migration versions from Git/releases;
- Cloudflare/Neon/auth-provider infrastructure and configuration source references;
- secrets are recovered through managed rotation procedures, not copied into backup bundles.

### 9.2 Restore qualification

Monthly and before release:

1. create an isolated clean environment;
2. restore database and R2 data to a declared recovery point;
3. deploy pinned code/infrastructure/schema/world-pack;
4. rebuild derived indexes/caches;
5. reconcile DO/Queue/Workflow runtime state from canonical records;
6. replay selected timelines and compare hashes;
7. run north-star and critical read/write paths;
8. verify privacy, credentials, and external effects remain isolated;
9. record RPO/RTO and discrepancies;
10. destroy isolated environment through audited cleanup.

Provider/platform regional failure procedures define pause/read-only, effect blocking, user-visible status, recovery choice, and reconciliation.

---

## 10. Capacity and hot-owner qualification

Measure curves for:

- concurrent authenticated observers per SpaceDO;
- projection fanout/bytes/revision rate;
- hot SpaceDO mailbox and command rate;
- active/dormant ActorAgentDO population;
- one-million-logical-actor target fixture with bounded hot/warm/dormant activity;
- loose-quadtree lookup, leaf-summary, scoped-cursor, promotion, and routing-epoch behavior;
- concurrent conversations/model runs;
- alarm lateness and catch-up storms after outage;
- Queue/Workflow backlog recovery;
- snapshot/replay/rebuild/export/deletion load;
- context/vector/graph corpus growth;
- branch/fast-forward and rule fanout;
- asset/client load.

Amended (2026-10-19): the one-million-logical-actor fixture with hot/warm/dormant activity and the quadtree promotion curves move to Wave 11 with the fidelity tiers. GA measures awake/asleep owners (parent §35).

Define admission and degradation before overload. Use existing logical address/routing epoch seams to qualify hot-leaf runtime-cell or SpaceDO promotion only when measured thresholds require it. Report total logical population separately from visible, scheduled, physically active, and cognitively active populations. Do not add speculative distributed topology merely to claim scale.

---

## 11. Security qualification

### 11.1 Threat model review

Review browser/input, authenticated Worker, actor runtime, PostgreSQL/R2, model providers, MCP/external systems, channel adapters, authoring/preview, CI/CD/supply chain, and operator access.

### 11.2 Required attacks

- cross-tenant/world/timeline/session/object direct-reference access;
- forged provider/internal assertions and revoked membership;
- DO route/name inference and trusted-context injection;
- RLS bypass and pooled-connection scope contamination;
- prompt injection through user/document/tool/media/channel content;
- capability/grant/approval escalation;
- MCP SSRF, redirect, DNS rebinding, metadata/private targets, oversized results, schema drift;
- external-effect replay/duplication/uncertainty;
- preview credential/effect and promotion smuggling;
- branch/private-memory/search/vector leakage;
- export/deletion target confusion;
- secrets in logs, bundles, source maps, artifacts, fixtures, docs, history;
- dependency/build/release provenance and compromised package simulation.

Security findings have severity, owner, fix/evidence, regression test, and release disposition. Unresolved critical/high invariant issues block release.

---

## 12. Public documentation

Required public set:

- product thesis and current scope;
- architecture and authority boundaries;
- zero-to-local-demo setup;
- dedicated clean Cloudflare/Neon/Better Auth reference deployment guide, with optional hosted-provider adapters;
- repository/package map and coding-agent workflow;
- event/kernel/world-pack contracts and examples;
- HTTP/OpenAPI and realtime protocols;
- sessions, actor harness, memory, capabilities, MCP, channels;
- rules, timelines, authoring, replay, export;
- security/privacy/retention model and threat model summary;
- operations, dashboards, alerts, recovery, runbooks;
- asset/content provenance workflow;
- `green-lake-yard@1` and `mirror-room@1` walkthroughs;
- contribution, testing, release, compatibility, and support policy;
- explicit hosted dependencies and local limitations.

All quickstarts run in CI. Code samples compile. Architecture diagrams and schemas carry versions. Docs distinguish implemented, experimental, and future capabilities.

---

## 13. Open-source release engineering

### 13.1 Repository hygiene

- license selection and headers/notices;
- third-party/reused/generated code provenance;
- asset/audio/font/model/tool license and redistribution rights;
- SBOM and dependency/license audit;
- no secrets/PII/private fixtures or large untracked artifacts;
- stable issue/PR templates, CODEOWNERS, branch protection, signed releases;
- vulnerability reporting and disclosure policy;
- contribution license policy and code of conduct;
- generated files and migrations reproducible from source.

Amended (2026-10-27): the license is selected: MIT. `LICENSE` at the repository root holds the standard MIT text with `Copyright (c) 2026 Clockgrove`, added in Wave 0 with `CONTRIBUTING.md`, `SECURITY.md` and the provenance inventory `provenance.json`. Wave 9 keeps headers/notices and the rest of this list.

### 13.2 Reproducible release

Release pipeline pins lockfile/toolchain/runtime/compatibility/schema/world-pack/asset versions; runs all checks; builds deterministic artifacts where supported; produces SBOM, checksums, provenance attestation, migration/replay compatibility matrix, evidence manifest, container/local bundles where declared, docs site, and changelog.

Amended (2026-10-27): the release pipeline inherits from Wave 1 (Wave 1 RW-0102 step 7) the world-pack compatibility matrix, which Wave 1 did not build. Wave 1 provides the pack conformance entrypoint and each pack's `engineCompatibility` range.

Release candidate deploys to staging, runs full cloud qualification, restores a clean environment, then promotes the same verified commit/artifacts. No manual production edit exists outside audited configuration.

---

## 14. Operational runbooks

Every runbook includes detection, severity, containment, evidence queries, user impact, recovery, reconciliation, validation, communication, and follow-up tests.

Required:

- PostgreSQL/Hyperdrive unavailable/degraded;
- DO routing/activation/hibernation or hot-space failure;
- simulation lateness/catch-up storm;
- Queue backlog/poison/DLQ and Workflow/fiber stuck;
- projection divergence/reconnect storm;
- model/AI Gateway outage or runaway spend;
- MCP/tool uncertainty or suspected compromise;
- external delivery duplication/leakage;
- rule loop or authoring/preview isolation incident;
- replay/state-hash mismatch;
- R2 artifact/snapshot corruption;
- auth-provider/grant/revocation issue;
- privacy/cross-tenant exposure;
- export/deletion failure;
- backup restore/disaster;
- malicious content/abuse/moderation;
- secret/dependency/supply-chain compromise.

At least P0/P1 runbooks are rehearsed in staging with time-stamped evidence.

---

## 15. Detailed work packets

### RW-0901 — Tenant and world administration

Implement invites/internal grants, role/capability lifecycle, world lifecycle, status/budgets/kill switches, pause/read-only, operator audit, admin UI/API, and small-installation defaults.

Exit: every administrative mutation is authorized, idempotent, audited, and recoverable.

### RW-0902 — Privacy lifecycle

Implement data inventory, retention policies, export Workflow/formats/checksums, deletion/crypto-shred/derived cleanup, provider/cache invalidation, backup-expiry tracking, verification reports, and adversarial target tests.

Exit: an authorized case can prove what was exported/deleted/retained and why.

Amended (2026-10-27): RW-0902 also implements the §6.2 bundle manifest signing, with the signing key's provenance and the recorded export time; publishes the signing public keys and their validity periods with each release; and implements the offline verifier's signature check and the upcaster identifiers for the included event versions. Its exit adds: an exported bundle's signature verifies offline against the published key whose validity period contains the bundle's recorded export time, including after that key has rotated, and a bundle whose signature or named upcaster the verifier cannot check is refused.

### RW-0903 — Abuse, cost controls, and resource metering

Implement rate/admission limits, budgets, moderation/report hooks, proactive-contact controls, circuit/kill switches, resource ledger, anomaly detection, and safe degradation.

Exit: runaway simulation/model/tool/rule/preview/delivery scenarios stop within declared bounds without corrupting truth.

### RW-0904 — Production observability

Implement dashboards, SLO computations, alerts, trace/evidence links, cost allocation, product-thesis views, safe telemetry schemas, retention, and alert tests.

Exit: every required P0/P1 condition is detectable from supported signals and links a runbook.

### RW-0905 — Backup, restore, and disaster recovery

Implement backup policies/inventory, isolated restore automation, index/runtime reconciliation, replay verification, credential/effect isolation, monthly exercise, RPO/RTO evidence, and DR runbooks.

Exit: a clean environment restores the hosted architecture and passes hashes/north-star.

### RW-0906 — Capacity and hot-owner qualification

Implement k6/scenario drivers, fanout/hot space/actor/catch-up/Queue/Workflow/search/branch curves, admission thresholds, partition procedure rehearsal, degradation evidence, and cost envelopes.

Exit: supported capacity and first bottlenecks are measured, documented, and protected by controls.

Amended (2026-10-19): the partition procedure rehearsal, and the quarterly hot-space partition rehearsal in §17, move to Wave 11 with the per-space state split. GA has one space owner per world partition (parent §35).

### RW-0907 — Security qualification

Complete threat model, RLS/cross-tenant suite, auth/routing, model/MCP/injection, preview/effects, privacy/export/delete, secrets, dependency/supply-chain review, penetration fixes, and regression evidence.

Exit: no unresolved release-blocking finding or missing critical regression exists.

### RW-0908 — Public documentation

Write and verify setup, architecture, API, realtime, world-pack, actor/memory, MCP/channel, authoring, security/privacy, operations, examples, and clean-deployment docs; compile/run all samples.

Exit: a clean contributor reproduces the local demo and understands hosted dependencies without private help.

### RW-0909 — Open-source release engineering

Implement license/notices/provenance/SBOM, repository policies, contribution/security process, deterministic builds, signed release/checksums/attestations, changelog, docs publishing, RC promotion, and rollback.

Exit: release artifacts are traceable to one qualified commit and all redistributable content is licensed/provenanced.

### RW-0910 — GA evidence gate

Execute the full definition of complete, north-star/all-scenario/cloud/recovery/security/accessibility/browser/cost suites, rehearse P0/P1 runbooks, archive immutable evidence, record known limitations, and block on invariant failure.

Exit: publish Wave 9/GA manifest and approve or reject release with explicit evidence.

---

## 16. Dependency graph and bounded execution

```text
RW-0901 ─ RW-0902 ─┐
RW-0903 ─ RW-0904 ─┤
RW-0905 ─ RW-0906 ─┼─ RW-0910
RW-0907 ────────────┤
RW-0908 ─ RW-0909 ─┘
```

Safe lanes: admin/privacy; budgets/observability; backup/capacity; security; documentation/release. RW-0910 consumes frozen outputs from all lanes. One release owner coordinates version/manifest and one independent reviewer verifies evidence completeness.

---

## 17. Qualification cadence

- Per PR: contracts, unit/property, package integration, security lint, docs/code sample, asset/provenance deltas.
- Per main deploy: staging smoke, migrations, north-star core, browser/accessibility smoke, replay sample.
- Nightly: long simulation, replay/fuzz, memory/authoring eval, dependency drift.
- Weekly: load/soak, DLQ/reconciliation, provider failures, schema/world-pack upgrade.
- Monthly: clean restore, replay bundle, credential rotation, deletion/export.
- Quarterly while maintained: disaster, cross-tenant security, hot-space partition, P0/P1 runbooks.

If the maintainer cadence cannot sustain a frequency, the hosted scope is narrowed or labeled experimental; the test is not silently deleted.

---

## 18. Final release gate

Release requires:

- experience and thesis journeys/evaluations;
- all ten scenarios and north-star chain;
- model-off continuity;
- physical/cognitive replay and branch correctness;
- realtime convergence and privacy-different audiences;
- model/tool/session recovery and evidence;
- rules/authoring/preview/promotion isolation;
- guide faithful provenance, governed source disclosure/read/sharing/revocation/deletion, and bounded counterfactual baseline/isolation/unavailable-state evidence;
- SLO/load/cost/abuse controls;
- export/delete/backup/restore;
- cross-tenant/security/supply-chain review;
- browser/accessibility/performance matrix;
- license/code/asset provenance;
- clean local and hosted reproduction;
- rehearsed P0/P1 runbooks;
- immutable release/qualification manifest.

Any zero-tolerance invariant failure blocks release regardless of demo quality.

Amended (2026-11-07): the owner moves these Wave 1–3 hardening gaps here. Release also requires each, built and proven as its source amendment states:

- Wave 1 §13: a historic component fixture at an earlier version upcasts through the registered chain to the current version deterministically, which tests the registry's upcast walk.
- Wave 1 §13: current READMEs for `packages/contracts`, `packages/testkit`, `packages/application` and `packages/persistence`.
- Wave 2 §5.2 and §19: provisioning seeds the initial membership, persona and inventory, preserves them for replay and offline verification, and a retry in any crash window never duplicates them.
- Wave 2 RW-0202: the Raccoon World pack is interrupted and resumed at every seed/projection boundary and reconstructs with identical Wave 1 hashes.
- Wave 2 §9.4: replay verification is resumable from a durable cursor and reaches the same verified head and state hash as an uninterrupted run.
- Wave 2 §14: fault-injected tests "during replay checkpoint" and "during export assembly and verification", each asserting every §14 item.
- Wave 3 §6: quota and cost policy for world commands (gateway steps 3 and 7).
- Wave 3 §8: a `WorldDO` FIFO control mutation lane of its own, and reads that declare and are served by mailbox drain, a known revision or a stale bounded snapshot.
- Wave 3 §20: telemetry carries the DO class, the hashed route fingerprint and the runtime schema.
- Wave 3 §18.3: `food-decay-and-conservation` with Queue duplicates matches the Wave 1/2 golden semantic events and final hash.
- Wave 3 §14: the inspector shows provisioning and readiness Workflow IDs and their reconciliation state.

---

## 19. Explicit non-goals

Wave 9 does not implement:

- payment collection, pricing, sales, CRM, enterprise SSO, procurement, or compliance theater;
- a company/business launch;
- arbitrary deployment targets beyond documented local and Cloudflare/Neon reference paths;
- public marketplace or untrusted plugin/world-pack host;
- 24/7 commercial support guarantees;
- every possible messaging channel;
- speculative scale machinery unsupported by measured load;
- new gameplay systems that bypass Wave 8 product evaluation.

---

## 20. Exit evidence checklist

- [ ] RW-0901 through RW-0910 are merged.
- [ ] Field-guide privacy lifecycle and one-input deterministic counterfactual Why evidence/isolation are qualified within the existing release scenarios.
- [ ] Administration, roles, grants, quotas, and kill switches are audited and tested.
- [ ] Retention/export/deletion cover canonical, cognitive, derived, cached, artifact, provider, and backup state.
- [ ] Resource meters and cost/abuse controls stop runaway work safely.
- [ ] Dashboards/SLOs/alerts link to tested evidence and runbooks.
- [ ] Clean restore/replay/north-star qualification passes.
- [ ] Capacity, hot-owner, catch-up-storm, and admission curves are documented.
- [ ] Cross-tenant, RLS, auth, MCP, injection, preview, effect, secret, and supply-chain suites pass.
- [ ] Public docs reproduce local and clean hosted deployment.
- [ ] License, dependency, code, model/tool, asset, audio, and font provenance are complete.
- [ ] Signed/reproducible release artifacts and SBOM are produced.
- [ ] P0/P1 runbooks are rehearsed.
- [ ] All Wave 0–8 manifests, ten scenarios, and north-star evidence are archived.
- [ ] No unresolved zero-tolerance or release-blocking finding exists.

Amended (2026-10-27): the checklist adds "Exported event/replay bundles carry a signed manifest and the upcaster identifiers for their event versions, and verify offline (§6.2, RW-0902)."

Amended (2026-11-07): the checklist adds "The Wave 1–3 hardening items moved here (§18) pass."

The final manifest records commit/tag, toolchain/runtime/compatibility versions, dependency lock/SBOM/checksums, schema/migration/world-pack/asset/model/capability versions, environment/infrastructure hashes, all qualification manifests, replay/scenario hashes, SLO/load/cost results, restore/delete/export evidence, security/provenance reports, docs verification, runbook rehearsals, known limitations, and release decision.

---

## 21. Completion

At the end of Wave 9, Clockgrove has one coherent proof:

> A deterministic and inspectable living world can host durable subjective actors, learning, governed tools, safe language-based authoring, multiple interface portals, and a polished realtime presentation while preserving canonical truth, privacy, replay, and operational recovery.

Further work—additional worlds, richer messaging/voice adapters, a complete murder mystery, multiplayer embodiment, creator ecosystem, or a future paid hosted platform—begins only from measured use and a new approved plan. None is required to validate the original project thesis.

The approved hosted/shared-world continuation and optional commercial track are specified separately:

- **Wave 10:** provider-neutral identity, self-service multitenancy, signup, workspaces, invitations, and onboarding, with Better Auth as the OSS reference adapter;
- **Wave 11:** MUD/MOO-style world membership, durable world personas, presence, immutable action attribution, world-local personal inventory, and inherited object-mobility policy;
- **Wave 12:** usage metering, Redis-backed prepaid admission, PostgreSQL accounting, automatic recharge, payment collection, and commercial reconciliation built on—but kept distinct from—Wave 11 attribution.

Wave 9 remains independently complete. A public open-source/demo release does not require Waves 10–12, and their hosted, multiuser, and commercial concerns may not leak backward into world semantics or the local stack.
