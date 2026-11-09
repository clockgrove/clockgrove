# Clockgrove Wave 0: Project Foundation and Production Skeleton

**Status:** Current implementation specification  
**Version:** 2.2  
**Date:** October 19, 2026
**Parent plan:** `clockgrove-cloudflare-implementation-plan.md` v3.9  
**Product source:** `clockgrove-prd-v0.5.md` v0.5.8  
**Development tooling:** `clockgrove/factory` may operate this repository but is not a product/runtime dependency
**Wave:** 0 of 13 — foundation workstream for product implementation waves 1–12

---

## 1. Outcome

Wave 0 establishes the publication-ready, reproducible engineering and production skeleton that every later Clockgrove wave extends.

The wave produces:

- a TypeScript/pnpm monorepo with explicit package boundaries;
- stable project contracts, IDs, schemas, commands, events, attribution, and extension seams;
- a local/CI-compatible PostgreSQL foundation with migrations and pgvector support;
- the Cloudflare Worker/Durable Object/Workflow/Queue/R2 composition skeleton required by later waves;
- provider-neutral authentication and authorization boundaries;
- deterministic local test doubles for model, MCP, external data, and authentication dependencies;
- a renderer-neutral browser diagnostic shell;
- observability, correlation, evidence, and release-manifest vocabulary;
- reproducible local, CI, development, staging, and production environment definitions;
- supply-chain, security, migration, recovery, and release controls;
- a green authenticated no-op path through the final production seams without implementing world simulation yet.

Wave 0 exits when:

> A clean supported Linux environment can bootstrap the repository from documented commands; CI proves package boundaries, contracts, migrations, authorization isolation, runtime compatibility, and deterministic fixtures; and an authenticated staging request can traverse the public gateway, runtime composition boundary, PostgreSQL, and observability path with one correlation identity.

Wave 0 is not throwaway scaffolding. It establishes contracts and boundaries that later waves extend rather than replace.

---

### 1.1 Objectives, sequencing, and checkpoints

This wave is a substantial workstream containing numerous Objectives and Work Items. The accepted [incremental-delivery ADR](../adr/clockgrove-adr-incremental-wave-delivery-and-evidence.md) governs capability scope, readiness, comparison rules, and proportionate qualification. The complete exit checklist below remains authoritative for full-wave qualification.

Reuse the accepted workspace, contracts, pure kernel/testkit seams, and real PostgreSQL journal. Foundation delivery contains multiple Objectives; it is not one scaffold task.

1. Complete the ordinary local runtime composition and authenticated command/read path over the existing application ports.
2. Complete provider-neutral identity/authorization and browser diagnostics with truthful readiness and safe logs.
3. Complete model/MCP adapter seams and deterministic fake providers without introducing live cognition as a foundation dependency.
4. Qualify clean bootstrap, migrations, CI/supply chain, deployment, recovery and portability on the intended stable candidate.

Pure kernel consumers may use accepted local foundation contracts under the ADR's recorded readiness exception while full staging qualification remains pending. The production skeleton and all Section 20 exits still require their own evidence. Use supported isolated PostgreSQL fixtures; the acceptance property is real database semantics and reproducibility, not a mandatory container host.

---

## 2. Publication and project-independence rules

Canonical repository content is written as if it may be public.

Do not commit:

- personal hardware inventories or workstation setup instructions;
- private account identifiers, recovery paths, billing details, receipts, or addresses;
- credentials, recovery codes, private keys, or secret values;
- home/private-network topology;
- private source code, data, prompts, assets, or configuration from unrelated projects or employers.

Deployment-private notes belong outside this repository. Secrets belong in the configured secret-management system, never in Git.

`clockgrove/factory` is an external development tool. It may read this repository, maintain GitHub Issues, launch coding attempts, and collect evidence. Clockgrove packages must not import Factory code or require Factory services to build, test, run, deploy, replay, export, or restore a world.

---

## 3. Fixed technology baseline

| Concern | Initial decision |
| --- | --- |
| Language | TypeScript, ESM, strict compiler settings |
| Package management | pnpm workspaces |
| Task graph | Turborepo |
| Public runtime | Cloudflare Workers |
| Serialized active runtime | Cloudflare Durable Objects |
| Durable jobs | Cloudflare Workflows |
| Async delivery | Cloudflare Queues |
| Large/binary artifacts | Cloudflare R2 |
| Canonical database | PostgreSQL with pgvector |
| Managed PostgreSQL reference | Neon through Hyperdrive |
| Human authentication | provider-neutral port; Better Auth reference adapter, optional Clerk adapter |
| Model integration | project-owned model/harness ports; AI SDK/AI Gateway adapters may implement them |
| Browser | React + Vite + Phaser through renderer-neutral scene contracts |
| Schema/migrations | Zod contracts + Drizzle migrations + reviewed SQL where needed |
| Infrastructure | OpenTofu + Wrangler + GitHub Actions |
| Testing | Vitest, fast-check, Cloudflare test tooling, Playwright, k6 |
| Observability | structured logs, OpenTelemetry-compatible correlation, Sentry/PostHog adapters where configured |

Provider SDK types must remain inside adapters. Durable product/domain contracts may not depend on a hosted vendor's object model.

Amended (2026-11-07): the owner accepts the testing tools as built. Property and fuzz tests use seeded generators that draw from a named random stream (for example `packages/kernel/test/rules-fuzz.test.ts`), not fast-check. Load tests are Vitest tests (`tests/load/` and `apps/runtime/test/load-curves.long-run.test.ts`), not k6. Wherever a plan names fast-check or k6, read the seeded generators and Vitest load tests. The Sentry and PostHog adapters come later (§14).

---

## 4. Repository layout

Wave 0 establishes this shape:

```text
apps/
  runtime/                 Cloudflare Worker, Durable Objects, Workflows, Queues
  web/                     React application and renderer adapter
  cli/                     inspect, replay, seed, export, verify

packages/
  contracts/               branded IDs, schemas, commands, events, wire protocols
  domain/                  product/domain types and policies
  kernel/                  pure deterministic simulation boundary
  application/             use cases and ports
  persistence/             PostgreSQL journal/projection and R2 adapters
  cognition/               cognition contracts and harness ports, no world behavior yet
  authoring/               changeset/timeline contracts, no full authoring implementation yet
  observability/           correlation/evidence helpers
  world-pack-sdk/          pack schemas and validation contracts
  testkit/                 fakes, clocks, IDs, fixtures, fault helpers

worlds/
  fixture/                 Clockgrove's own test worlds: the tiny non-raccoon conformance
                           pack and the neutral reference variant (reference/)

db/
  migrations/
  seeds/
  policies/
  verification/

infra/
  opentofu/
  wrangler/
  environments/
  dashboards/

tests/
  contract/
  cloud/
  e2e/
  load/
  recovery/

docs/
  adr/
  protocols/
  runbooks/
  world-packs/

tools/
  assets/
  fixtures/
  release/
```

The layout may grow only when a package or deployable owns a real responsibility.

Amended (2026-11-07): the owner accepts that there is no `apps/cli`. The simulator CLI (`packages/simulator/cli/`, documented in [CLI](../../packages/simulator/docs/cli.md)) covers seed and verify, and the application API stands in for inspect, replay and export, as Wave 2 §4 and Wave 3 §1 already read "CLI".

---

## 5. Dependency direction

Required dependency direction:

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
```

Rules:

- `contracts` contains no Cloudflare, SQL, browser, model, or target-provider imports;
- `domain` and `kernel` perform no I/O;
- `kernel` reads no wall clock, environment variables, network, filesystem, database, model, or Cloudflare API;
- `application` defines ports and orchestration semantics;
- adapters point inward; provider types do not leak inward;
- `apps/runtime` is the server composition root;
- `apps/web` consumes public contracts/projections, never persistence/runtime internals;
- production packages never depend on `testkit`;
- dependency direction is statically checked in CI.

---

## 6. Toolchain and reproducibility

Pin or constrain the repository toolchain rather than relying on workstation-global versions.

Required root files include:

```text
package.json
pnpm-lock.yaml
pnpm-workspace.yaml
turbo.json
tsconfig.base.json
mise.toml or equivalent toolchain declaration
vitest.workspace.ts
playwright.config.ts
wrangler configuration
.env.example
.dev.vars.example
```

Example environment files contain names and safe descriptions only. They contain no plausible secret values.

Amended (2026-10-27): the browser test configuration is `tests/ci/vitest.browser.config.ts`, in place of `playwright.config.ts`. The browser journey is a Vitest test, `tests/ci/browser.test.mjs`, that launches Playwright's Chromium itself, so there is no `playwright.config.ts`. `.env.example` and `.dev.vars.example` are generated from and checked against the secret catalog `requiredSecrets` in `infra/check-configuration.mjs`, as `docs/runbooks/development.md` describes.

Canonical commands established by Wave 0:

```text
pnpm install
pnpm dev
pnpm check
pnpm test
pnpm test:db
pnpm test:runtime
pnpm test:e2e
pnpm test:replay
pnpm test:cloud
pnpm verify
pnpm db:migrate
pnpm db:verify
pnpm infra:plan <environment>
```

All required CI commands are noninteractive and runnable from a clean checkout.

Amended (2026-10-19): the list matches the real root scripts, with their order and coverage in `docs/runbooks/development.md`.

- `pnpm infra:plan <environment>` makes a read-only plan; Quality runs the zero-resource `ci` plan. `pnpm test:cloud [environment]` checks that the plan is reproducible with no pending change and probes a hosted environment's deployed origin. Their staging passes belong to the hosted half (issue 2), since they need a staging deploy. `pnpm infra:validate` runs the backend-free OpenTofu validation and Wrangler dry-runs, with no credentials.
- `pnpm test:e2e` is the browser journey Quality runs with `tests/ci/vitest.browser.config.ts`. It stays out of offline `pnpm test`, so it has no root script.
- `pnpm verify` is dropped: the gate is the ordered command list in the development runbook, which Quality records in one evidence manifest.
- `pnpm dev` is dropped at the root: the shell runs with `pnpm --filter @clockgrove/web dev`, and the runtime runs through `pnpm test:runtime`.
- The real list adds `pnpm format`, `pnpm test:long-run`, `pnpm verify:docs`, `pnpm verify:supply-chain` and `pnpm qualify:*`.

---

## 7. Contract foundation

Wave 0 defines and golden-tests the stable vocabulary later waves consume.

### 7.1 Identity and scope

Define branded opaque IDs for at least:

- tenant/workspace;
- principal and external identity;
- workspace membership;
- world membership and world persona;
- world, timeline, partition, space, object and subject;
- presence and session;
- actor process, run and step;
- command, event, action and authority decision;
- correlation and causation;
- rule, schedule, artifact, evidence and changeset.

External provider IDs never substitute for Clockgrove domain IDs.

### 7.2 Execution context

Create a versioned trusted execution context carrying tenant, principal, world/timeline scope, persona, roles/grants, privacy ceiling, correlation/causation, protocol version, and code version.

Only trusted gateway/application code constructs or broadens it.

### 7.3 Commands and events

All canonical mutation uses typed versioned commands with:

- stable command ID;
- target logical address;
- expected revisions/epochs;
- trusted execution-context reference;
- attribution intent;
- typed payload.

Semantic events include:

- stable event/type/version identity;
- world/timeline/partition/stream scope;
- stream and partition sequence;
- simulation time and recorded time;
- command/correlation/causation identity;
- sealed attribution including authority decision;
- privacy classification;
- content hash and typed payload.

No generic property-patch event becomes the primary history model.

### 7.4 Attribution from day one

Wave 0 establishes the chain needed by later shared-world and billing waves:

```text
Principal / autonomous source
  → action
  → authority decision
  → effective actor
  → causal root
  → immediate cause
  → semantic events
```

Billing does not exist in Wave 0, but later billing must be able to consume attribution without redefining authorship or causation.

---

## 8. Deterministic kernel seam

Wave 0 does not implement the full simulation, but it creates and tests the pure kernel contract.

The contract receives:

- versioned partition state;
- one typed command or scheduled input;
- integer/fixed-point simulation time;
- versioned policy/pack inputs;
- injected named random state;
- deterministic ID source.

It returns:

- semantic events;
- schedule mutations;
- projection delta;
- decision/evidence drafts where applicable;
- updated named random state.

Static and runtime tests prove the kernel cannot perform external I/O or ambient nondeterminism.

Two extension-pressure fixtures are introduced immediately:

1. a spatial contract that can represent 2D or 3D semantic frames without changing object identity;
2. a durable `ActorProcess` contract that can represent reactive, scheduled, or continuously eligible responsibilities without assuming a permanently resident process.

These fixtures prevent initial 2D/reactive implementations from becoming accidental architecture ceilings.

---

## 9. Persistence foundation

Create PostgreSQL migrations for the minimal identity, environment, protocol, and journal skeleton required to exercise the production boundaries.

Wave 0 must prove:

- clean database creation;
- forward migrations;
- upgrade from the previous supported schema fixture once one exists;
- transaction-local authorization context compatible with pooled connections;
- idempotent command receipts;
- semantic append with expected revisions;
- short transactions with no provider/network calls;
- transactional outbox/dispatch records;
- snapshots/artifact references as acceleration, never replacements for the journal;
- replayable/golden event serialization;
- RLS or equivalent defense-in-depth isolation for tenant-owned rows.

PostgreSQL is canonical. Durable Object storage, caches, queues, search indexes, and browser state are reconstructible.

---

## 10. Runtime skeleton

Wave 0 creates deployable shells for the three initial physical Durable Object classes:

- `WorldDO` — world/timeline coordination and clock/routing policy;
- `SpaceDO` — physical serialization boundary and scene projection owner;
- `ActorAgentDO` — cognition/conversation execution boundary.

They contain only enough behavior to prove:

- stable hashed route identities derived from opaque canonical IDs;
- idempotent initialization;
- trusted routing from the public Worker;
- no implicit creation of canonical world state in Durable Object initialization;
- PostgreSQL remains final mutation authority;
- runtime storage can be destroyed and rehydrated;
- stale routing/authority epochs are rejected;
- correlation identity survives Worker → DO → PostgreSQL → response.

Wave 0 also defines typed Workflow and Queue composition seams without implementing later domain jobs.

---

## 11. Authentication and authorization boundary

Human authentication is provider-neutral.

Define `AuthProviderPort` and internal principal mapping so the authentication provider owns authentication/session mechanics while Clockgrove owns:

- tenant/workspace membership;
- world membership;
- world persona;
- roles and grants;
- actor/world authorization;
- attribution;
- later commercial/billing semantics.

The reference OSS adapter is Better Auth. Hosted adapters may be added behind the same conformance suite.

Required tests cover:

- valid/invalid/revoked session;
- account linking;
- organization/membership drift where supported;
- duplicate/reordered provider events;
- tenant isolation;
- provider outage independent from existing canonical world state;
- absence of provider-specific subject IDs from domain contracts.

Local and CI use an explicit deterministic test-auth adapter. No production bypass exists.

---

## 12. Model, cognition, and MCP seams

Wave 0 defines interfaces but does not implement product cognition.

Create project-owned ports for:

- model execution/streaming/structured output;
- semantic model-route policy;
- tool execution;
- MCP transport/discovery;
- run checkpoints;
- context compilation;
- evidence recording.

Deterministic scripted adapters are mandatory for local/CI correctness tests.

No model, MCP server, fetched document, or tool result receives mutation authority. Later cognition always produces typed proposals that re-enter ordinary validation.

---

## 13. Browser diagnostic shell

The initial browser is intentionally minimal but uses final seams.

It proves:

- authentication through the provider-neutral boundary;
- world/runtime readiness states;
- HTTP request/response correlation;
- WebSocket connection/reconnect envelope;
- typed snapshot/patch protocol;
- renderer-neutral `SceneProjection` adapter boundary;
- accessible text fallback independent of Phaser;
- no private cognition or operator-only data enters shared projection types.

The shell may render a diagnostic fixture rather than a living world.

---

## 14. Observability and evidence

Every boundary carries stable correlation identity.

Establish structured events/logs for:

- request and authorization result;
- routing/authority epoch;
- command receipt and commit result;
- SQL transaction/retry classification;
- Workflow/Queue envelope identity;
- model/tool adapter call when exercised by fixtures;
- browser projection revision;
- release/environment identity.

Operational telemetry is not canonical world truth.

Create an evidence-manifest schema that later waves can extend with:

- commit/build digest;
- contract/schema versions;
- commands/tests executed;
- fixture and state hashes;
- migration results;
- security/recovery checks;
- cloud qualification evidence;
- known risks/waivers.

Amended (2026-11-07): there are no Sentry or PostHog adapters yet, and the owner accepts that they come later. Each arrives behind a project-owned adapter contract, as every third-party service does: the provider's SDK types stay inside the adapter and no product contract depends on them (§3). Until then operational telemetry is the structured logs above and Cloudflare-native analytics (Wave 3 §20).

---

## 15. CI and supply chain

Pull-request CI initially requires:

1. frozen-lockfile installation;
2. formatting/linting;
3. strict TypeScript checking;
4. package-boundary/forbidden-import checks;
5. unit/golden/property tests;
6. clean PostgreSQL migration;
7. PostgreSQL integration and tenant-isolation tests;
8. Cloudflare runtime skeleton tests;
9. contract/schema compatibility tests;
10. browser diagnostic smoke/accessibility tests;
11. license/dependency policy checks;
12. SBOM generation;
13. vulnerability and secret scanning;
14. production bundle/compatibility check;
15. documentation-link and generated-contract drift checks.

CI principles:

- minimum GitHub token permissions;
- reviewed/pinned third-party Actions where practical;
- no production credentials in untrusted pull-request jobs;
- ephemeral isolated state;
- useful failure artifacts;
- superseded runs cancel safely;
- dependency updates pass the same qualification as product changes.

---

## 16. Environment and infrastructure contract

Canonical environment names are:

```text
local
ci
development
staging
production
```

Environment manifests may contain non-secret resource names, domains, IDs documented as safe, retention, budgets, compatibility dates, and model aliases. Secret values remain outside Git.

Infrastructure responsibilities:

- OpenTofu: supported cloud/DNS/account resources and policies;
- Wrangler: Worker entrypoints, bindings, compatibility, Durable Object migrations, Workflow/Queue configuration and assets;
- Drizzle/reviewed SQL: PostgreSQL schema and verification;
- GitHub Actions: build, test, qualification and release orchestration.

Provider environment naming may abbreviate only where provider limits require it; canonical application data keeps the full names.

---

## 17. Deployment and release progression

Wave 0 proves the release path without granting unattended production authority.

### Development

A qualified `main` commit may deploy automatically to the development environment.

Amended (2026-11-09): development deploys only once its environment is configured with its own zone; until then a qualified `main` commit deploys nowhere automatically, and staging is the only hosted environment.

### Staging

A release candidate deploys through a protected environment and runs production-shaped qualification.

Amended (2026-11-09): the owner's required-reviewer approval on the protected `staging` environment is the only staging sign-off. Staging needs no independent reviewer, signed review or recovery evidence, acceptance key or configuration digest. The deploy runs on a GitHub-hosted runner, a fresh VM per job, and keeps OpenTofu state in a Cloudflare R2 bucket with no OpenTofu state encryption: R2 encrypts at rest and a bucket-scoped token limits access. The zone stays on Cloudflare's Free plan, so its rate-limit rule matches paths with 10-second periods. [Infrastructure](../runbooks/infrastructure.md#w0-009-protected-deployment-and-recovery) has the details.

### Production

Production deployment requires the release policy in force at that time, including explicit human approval until a later accepted ADR narrows that gate.

Amended (2026-11-09): production, still disabled, keeps the stricter design the staging amendment drops: an independent reviewer's signed review of the exact candidate, verified against an offline Ed25519 acceptance key; signed recovery evidence for persisted state; and OpenTofu state and plans encrypted with a managed key, pinned by a configuration digest.

A release manifest pins at least:

- Git commit/build digest;
- toolchain/lockfile hash;
- runtime compatibility date/flags;
- PostgreSQL and Durable Object migration versions;
- API/wire/event schema versions;
- world-pack/policy versions when introduced;
- infrastructure revision.

Canonical world history is never deleted to imitate rollback. Use compatible code rollback only when safe; otherwise use forward fixes and migrations.

---

## 18. Recovery and portability

Wave 0 establishes recovery as a product requirement rather than a workstation procedure.

Prove that:

- a clean supported Linux environment can bootstrap the repository;
- local caches/build outputs are disposable;
- the database can be recreated from migrations and deterministic fixtures;
- runtime-local state can be destroyed and rebuilt from declared authorities;
- backup/restore procedures have testable integrity checks;
- one missed/duplicate Queue or webhook delivery cannot create duplicate logical effects;
- a release can be reproduced from its manifest and source artifacts.

Later world exports/replay bundles must not require provider runtime caches or Factory state.

---

## 19. Wave 0 work packets

The W0-001 through W0-010 keys identify the canonical work packets for this wave. Their outcomes, exit conditions, ordering, scope, and non-goals guide each new implementation Objective; they are not bound to a historical GitHub Objective or Work Item graph. The current Objective and its GitHub Issues own delivery identity and progress.

### W0-001 — Establish repository and toolchain foundation

Create workspace/task graph, strict TS/ESM configuration, canonical commands, formatting/linting, dependency-boundary tooling, deterministic testkit, and clean-install proof.

**Exit:** clean checkout runs `pnpm install`, `pnpm check`, and foundational tests reproducibly.

### W0-002 — Define contract and authority skeleton

Create branded IDs, execution context, command/event/attribution envelopes, versioning/upcasting rules, privacy categories and set-based ceilings, deterministic ID/random/time contracts, and goldens.

**Exit:** unknown/invalid versions and illegal scope/authority inputs fail deterministically.

### W0-003 — Build PostgreSQL journal skeleton

Create migrations, command receipts, streams/events, tenant authorization context, transaction/outbox pattern, replay/golden verification, and test fixtures.

**Exit:** duplicate command and crash/retry scenarios produce one canonical result.

### W0-004 — Create runtime composition skeleton

Create Worker gateway, `WorldDO`, `SpaceDO`, `ActorAgentDO`, typed routing and epoch contracts, Workflow/Queue shells, and destroy/rehydrate tests.

**Exit:** no-op command crosses the production seams and runtime-local loss is recoverable.

### W0-005 — Establish authentication and authorization boundary

Create provider-neutral auth port, internal principal mapping, reference/test adapter, tenant roles/grants, revocation/event-ordering fixtures, and gateway authorization.

**Exit:** provider-specific identity types do not leak into domain contracts and cross-tenant access fails.

### W0-006 — Define cognition and tool provider seams

Create model, route-policy, tool, MCP, context, checkpoint and evidence ports plus deterministic fakes.

**Exit:** a fixture can exercise a bounded fake model/tool run without adding provider authority.

### W0-007 — Build browser diagnostic shell

Create React shell, typed API/WebSocket client, readiness state, renderer-neutral scene adapter, diagnostic projection, reconnect behavior, and accessible text fallback.

**Exit:** authenticated staging browser path reaches the runtime skeleton with correlated evidence.

### W0-008 — Define infrastructure and environments

Create OpenTofu/Wrangler/database environment configuration and safe configuration schemas for local/ci/development/staging/production.

**Exit:** infrastructure plan is reproducible and no secret values are committed.

### W0-009 — Integrate CI supply chain and release controls

Create required CI jobs, dependency/license/SBOM/security checks, evidence manifest, development deploy and staging/production gates.

**Exit:** a deliberately broken boundary, migration, secret fixture, and contract drift each fail visibly.

### W0-010 — Qualify clean environment and recovery

Bootstrap from a clean Linux environment, recreate databases/fixtures, destroy runtime-local state, exercise duplicate/reordered delivery, and reproduce a release candidate from its manifest.

**Exit:** publish Wave 0 evidence manifest and handoff to Wave 1.

Amended (2026-10-19): the hosted half of W0-004, W0-005, W0-007, W0-008, W0-009 and W0-010 moves to Wave 3 entry, owned by issue 2. It covers the real staging deploy, the authenticated staging browser path with enrollment and the world-grant/privacy handoff, Queue and webhook duplicate safety on real infrastructure, a reproducible real infrastructure plan, and acceptance of the Wave 0 evidence manifest. The staging deploy was already deferred until accounts and secrets exist; issue 2 now owns it. Wave 3 is the first wave that runs the real service.

---

## 20. Exit checklist

- [ ] Repository layout and dependency rules are enforced.
- [ ] Toolchain and lockfile are reproducible from a clean checkout.
- [ ] Canonical commands are documented and noninteractive in CI.
- [ ] Branded IDs, execution context, command/event/attribution contracts are golden-tested.
- [ ] Kernel seam rejects ambient I/O/time/randomness.
- [ ] 3D spatial and durable-ActorProcess pressure fixtures compile and validate.
- [ ] PostgreSQL migrations and command/event transaction skeleton pass duplicate/restart tests.
- [ ] Tenant isolation and provider-neutral authentication tests pass.
- [ ] Worker/DO composition route is deployed and correlated.
- [ ] Runtime-local state can be destroyed and rehydrated without changing canonical truth.
- [ ] Model/MCP/tool ports have deterministic test adapters and no mutation authority.
- [ ] Browser diagnostic shell has readiness, reconnect, renderer-neutral projection and text fallback.
- [ ] CI checks types, boundaries, contracts, migrations, security, supply chain and browser smoke tests.
- [ ] No secret/private deployment material exists in repository source.
- [ ] Development/staging/production environment and release-manifest contracts are defined.
- [ ] Clean Linux bootstrap and recovery qualification pass.
- [ ] Wave 0 evidence manifest is accepted before Wave 1 product work begins.

Amended (2026-10-19): the hosted items ("Worker/DO composition route is deployed", the staging browser path and "Wave 0 evidence manifest is accepted") are Wave 3 entry conditions owned by issue 2, with staging accounts tracked in issue 1. Waves 1 and 2 proceed under the readiness exception.

---

## 21. Handoff to Wave 1

Wave 1 consumes:

- pure kernel interfaces and deterministic fixtures;
- stable command/event/attribution/ID contracts;
- PostgreSQL journal and replay skeleton;
- runtime route/authority seams;
- provider-neutral auth and application ports;
- CI/release/evidence vocabulary;
- renderer-neutral spatial/presentation pressure fixture.

Wave 1 adds the deterministic world kernel and first real world semantics. It must not reopen Wave 0 authority boundaries simply to simplify an implementation.
