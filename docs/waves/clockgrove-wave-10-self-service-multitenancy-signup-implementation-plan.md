# Clockgrove Wave 10: Self-Service Multitenancy, Signup, and Workspace Onboarding

**Status:** Optional future hosted-platform implementation specification  
**Version:** 1.6  
**Date:** October 01, 2026
**Parent plan:** `raccoon-world-cloudflare-implementation-plan.md` v3.9 plus Waves 0–9  
**Product source:** `clockgrove-prd-v0.5.md` v0.5.8  
**Wave:** 10, optional after technical/open-source GA  
**Assumptions:** Wave 9 is qualified; consumer-first signup is desired; commercialization is not time-critical  
**Development tooling:** development-tool identities, sessions, credentials, and state remain external and never become hosted Clockgrove tenant, workspace, or user identity.

---

## 1. Outcome

Wave 10 establishes the initial Management Plane and turns the single-owner/invited-tester deployment into a safe self-service hosted platform. It implements public signup, internal principals, personal and shared workspaces, organization membership, invitations, tenant-scoped worlds and resources, onboarding, one billing-account placeholder shared by a workspace's worlds, free promotional credits as an entitlement seam, lifecycle/deletion, and cross-tenant qualification.

The wave exits only when:

> A new person can create one Clockgrove identity, receive a private personal workspace, enter a bounded starter experience, create or join shared workspaces, switch contexts safely, invite collaborators, and manage or delete their account—while every world, session, actor, memory, capability, usage event, and future wallet remains unambiguously tenant-owned.

Authentication comes through a provider-neutral port. Better Auth is the reference OSS implementation because it can run with the application and its PostgreSQL database; Clerk remains an optional hosted adapter. Tenancy, world ownership, authorization, billing ownership, and canonical user lifecycle remain Clockgrove domain concepts.

---

### 1.1 Objectives, sequencing, and checkpoints

This wave is a substantial workstream containing numerous Objectives and Work Items. The accepted [incremental-delivery ADR](../adr/clockgrove-adr-incremental-wave-delivery-and-evidence.md) governs capability scope, readiness, comparison rules, and proportionate qualification. The complete exit checklist below remains authoritative for full-wave qualification.

First qualify personal signup, provider-neutral principal/workspace mapping and a bounded starter world through the existing Management provisioning lifecycle. Observe first-run completion before expanding shared-workspace administration.

Then complete invitations, shared roles, tenancy isolation, account/workspace lifecycle and broader provider conformance in subsequent Objectives. Reuse world birth, attribution, privacy and runtime contracts rather than implementing a second provisioning or identity path.

Wave 9 technical/open-source GA remains independently complete. This hosted continuation has its own full exit evidence; starter entitlement is not money collection or authorization to activate commercial billing.

---

## 2. Product and rollout decision

Clockgrove serves individuals first and teams later. Therefore:

- every verified user gets one internal personal workspace;
- a user may create or join shared workspaces;
- one principal can belong to multiple provider organizations and Clockgrove workspaces;
- an active workspace is explicit on every application request;
- worlds belong to exactly one workspace/tenant;
- a workspace normally references one billing account and shared credit wallet across all of its worlds; no world receives a separate provider customer, subscription, or authoritative wallet merely for attribution;
- personal and shared workspaces use the same internal tenant contract;
- team/enterprise surface is optional and cannot complicate the first-run consumer experience.

Better Auth's Organization plugin supplies organizations, members, invitations, roles, and access control that are useful at the application edge. Clockgrove does not make any provider object its canonical tenant record; it maps provider identities and organization events into stable internal principals, tenants, memberships, and grants. Provider organization membership is a reconciliation input, not runtime authorization.

---

## 3. Entry conditions

These are the full-wave/default entry conditions. A named local-development Objective may consume only accepted prerequisite capabilities under the ADR's recorded readiness exception; its Issue must preserve pending qualification obligations and the selected path's mandatory safety evidence.

- Wave 9 qualification manifest is green.
- Better Auth reference deployment and any enabled provider adapter have qualified schema, migrations, session verification, event/reconciliation, and environment isolation.
- Existing `tenant_id`/`principal_id` contracts, RLS, grants, audit, quotas, export, and deletion paths are stable.
- `green-lake-yard@1` can be instantiated or referenced without duplicating engine code.
- Resource metering from Wave 9 is live even though payment collection is not.
- Wave 12 wallet/billing contracts may be stubbed, but signup cannot depend on Stripe availability.
- Abuse controls can prevent automated creation of users, workspaces, worlds, models, tools, and external effects.

---

## 4. Identity and tenancy model

### 4.1 Canonical entities

```ts
interface Principal {
  principalId: PrincipalId;
  kind: "human" | "service" | "system";
  status: "pending" | "active" | "suspended" | "deleting" | "deleted";
  createdAt: string;
}

interface ExternalIdentity {
  provider: "better-auth" | "clerk" | string;
  environment: "dev" | "staging" | "prod";
  externalSubject: string;
  principalId: PrincipalId;
  verifiedAt?: string;
}

interface ExternalOrganizationLink {
  provider: string;
  environment: "dev" | "staging" | "prod";
  externalOrganizationId: string;
  tenantId: TenantId;
  lastReconciledAt?: string;
}

interface TenantWorkspace {
  tenantId: TenantId;
  kind: "personal" | "shared";
  status: "provisioning" | "active" | "suspended" | "archiving" | "deleted";
  displayName: string;
  ownerPrincipalId: PrincipalId;
  billingAccountId?: BillingAccountId;
  policyVersion: string;
}

interface Membership {
  tenantId: TenantId;
  principalId: PrincipalId;
  role: "owner" | "admin" | "creator" | "participant" | "observer";
  status: "invited" | "active" | "suspended" | "removed";
}

interface WorldCatalogEntry {
  worldId: WorldId;
  tenantId: TenantId;
  lifecycleStatus: "requested" | "validating" | "installing" | "seeding" | "verifying" | "ready" | "failed" | "archiving" | "archived";
  requestedPackArtifact: WorldPackArtifactRef;
  activeInstallationId?: WorldPackInstallationId;
  provisioningCaseId: WorldProvisioningCaseId;
}
```

Provider user/org IDs are references, never primary keys in workspace, world, attribution, or billing tables. Multiple external identities may link to one principal only through a verified account-linking workflow; one external identity cannot silently relink between principals.

### 4.2 Ownership hierarchy

```text
Principal
├── Personal workspace membership
└── Shared workspace memberships

Tenant workspace
├── Billing account and shared credit wallet (Wave 12)
├── Worlds and timelines
├── Members, roles, grants and invitations
├── Context, assets, capabilities and channel bindings
├── Usage, quotas and budgets
└── Audit, export and deletion cases
```

Actors and sessions belong to a world/timeline within a tenant. A human may participate in many worlds but cannot own cross-tenant actor state.

World budgets, usage reports, leases and execution modes are scoped projections beneath the shared billing account; they are not independent money ledgers. The billing account is also not necessarily the human principal: a shared workspace may have a delegated billing owner while visitors retain separate attribution.

Wave 10 reserves provider-neutral identifiers and foreign keys for `WorldMembership` and `WorldPersona` but does not treat them as workspace memberships. Starter-world provisioning creates an owner world-membership and a disclosed unrendered Caretaker persona idempotently. Wave 11 completes invitations, roles, presence, inventory, and social UX on those records.

---

## 5. Signup and session state machine

### 5.1 Public entry modes

- Public marketing/product explanation without authentication.
- Optional read-only showcase world using isolated public principal and projection; no private sessions or costly tools.
- Sign up/sign in to create or enter a private workspace.
- Invitation link to sign up/sign in and join a shared workspace.

### 5.2 Signup states

```text
anonymous
  → authenticating
  → identity_verified
  → principal_provisioning
  → personal_workspace_provisioning
  → onboarding_pending
  → active

terminal/exception: blocked | suspended | deleting | deleted
```

Authentication success alone does not grant world access. The internal principal, membership, tenant, quota, and policy must exist and be active.

### 5.3 Idempotent provisioning

Provisioning Workflow:

1. validate a provider session or signed provider event and environment through `AuthProviderPort`;
2. claim `(provider, environment, externalSubject)` idempotently;
3. create or reconcile internal principal;
4. create exactly one personal workspace and owner membership;
5. attach baseline quota/policy and future billing-account placeholder;
6. issue optional promotional-credit intent for Wave 12;
7. create onboarding state and starter-world entitlement;
8. publish safe analytics/audit;
9. activate the session only when required records exist.

Webhook order, duplication, delay, and loss are tolerated by reconciliation. A client callback cannot mint a tenant directly.

---

## 6. Authentication-provider boundary

### 6.1 Provider responsibilities

- authentication factors and verified identifiers;
- sessions/tokens and sign-in/sign-up UI primitives;
- user profile/recovery;
- optional Organizations, invitations, and organization membership events;
- provider-side roles/permissions used as input to mapping;
- bot/abuse signals available from the provider.

### 6.2 Clockgrove responsibilities

- principal and tenant identity;
- active workspace selection and trusted execution context;
- world/member/capability authorization;
- internal role/grant mapping;
- billing ownership, wallet and usage;
- data lifecycle, audit, export, deletion, suspension;
- webhook reconciliation and provider drift;
- preventing a provider metadata field from becoming security authority.

### 6.3 Provider-neutral port and conformance

```ts
interface AuthProviderPort {
  verifyRequest(request: Request): Promise<VerifiedExternalSession | null>;
  getIdentity(subject: ExternalSubject): Promise<ExternalIdentityProfile>;
  listOrganizationMemberships(subject: ExternalSubject): Promise<ExternalOrgMembership[]>;
  createOrganizationInvitation(input: ProviderInviteInput): Promise<ProviderInviteReceipt>;
  revokeSession(sessionId: string): Promise<void>;
  consumeEvent(request: Request): Promise<ProviderEventEnvelope>;
}
```

Every adapter must pass one conformance suite for session expiry, revocation, account linking, organization drift, invitation races, duplicate/out-of-order events, environment separation, and degraded provider behavior. Application use cases consume only verified port values and canonical IDs.

Better Auth is the default/reference adapter. It runs in the Hono/Cloudflare Workers boundary using Web Standard `Request`/`Response`, with PostgreSQL and a supported adapter such as Drizzle. Its schema and migrations are generated, reviewed, pinned, and applied during deployment; production processes never auto-migrate on startup. Email delivery, OAuth credentials, recovery, rate limits, secrets, session persistence, and upgrade testing are operator-owned.

The Clerk adapter is optional for operators who prefer hosted identity UI and lifecycle services. It must map into the same contracts and cannot add Clerk-only assumptions to domain or application packages.

### 6.4 Session tasks

Some providers support pending session tasks such as choosing an Organization. Clockgrove owns application onboarding tasks after internal provisioning:

- accept terms/privacy and age/eligibility policy where required;
- choose display name and notification preferences;
- acknowledge AI/world persistence and actor-contact disclosures;
- select or create active workspace when arriving through an invitation;
- optionally create starter world;
- choose promotional model/contact budgets;
- optionally add a payment method or buy credits in Wave 12.

Billing is never required merely to finish identity signup unless abuse data later justifies a card gate for costly features.

---

## 7. Personal and shared workspace behavior

### 7.1 Personal workspace

- created exactly once per principal;
- cannot be invited into or shared directly in the first implementation;
- contains private worlds and user-scoped billing/usage;
- can later transfer a world to a shared workspace through a governed export/import or ownership-transfer Workflow;
- deleting the user drives personal-workspace data lifecycle.

### 7.2 Shared workspace

- created explicitly by an authorized user;
- optionally mapped to one provider Organization and always mapped to one internal tenant;
- creator becomes owner through internal policy;
- members join by invitation; verified-domain/automatic enrollment remains disabled initially;
- member removal immediately revokes new access and initiates session/cache reconciliation;
- ownership transfer requires explicit acceptance and audit;
- organization deletion is a Clockgrove lifecycle Workflow, not immediate provider deletion.

### 7.3 Active workspace

The active workspace is carried in trusted session context and verified on every request. Browser local state may remember a preference but cannot authorize it. Multiple tabs may use different active workspaces; every API/socket/DO route includes resolved tenant.

---

## 8. Roles and permissions

Initial internal roles:

| Role | Intended scope |
|---|---|
| Owner | Workspace lifecycle, billing, members, exports/deletion, all admin actions |
| Admin | Members, worlds, policies, budgets, capabilities; no ownership transfer by default |
| Creator | Create/edit/preview/promote worlds within grants |
| Participant | Converse, inspect, influence, use permitted capabilities |
| Observer | View authorized worlds and public evidence |

Roles are presets. Capabilities/grants remain the actual authorization checks. Provider roles are mapped inputs and cannot bypass internal workspace/world/timeline/privacy/effect policy.

Membership and billing roles are separate: an owner can delegate payment management without granting access to private actor memories, and a creator can author worlds without changing payment methods.

---

## 9. Starter experience and promotional entitlement

### 9.1 Recommended first run

- Do not clone a fully active cognitive world before the user asks to start.
- Let the user enter the shared read-only showcase immediately.
- Offer “Create my Raccoon World” as an explicit action.
- On creation, invoke the already-qualified idempotent `WorldProvisioningCase` with a pinned starter `WorldPackArtifactRef`, conservative budgets, and owner membership/Caretaker-persona seed commands. Self-service signup does not introduce a second import or genesis path.
- Grant a small, non-purchased promotional credit allocation sufficient to experience conversation, Why, one preview, and later memory.
- Explain that deterministic world life and dormant catch-up are inexpensive, while models/tools/fast-forward consume credits.

No numeric pack size is fixed until Wave 12 cost measurements exist.

### 9.2 Zero-balance behavior seam

Signup must work with no card and no paid credits. At zero balance:

- identity, worlds, history, export, settings, and public/showcase access remain available;
- deterministic local/hosted viewing operates within free resource policy;
- costly cognition, ingestion, tools, previews, fast-forward, media, and external delivery can be denied, delayed, or use a clearly labeled free quota;
- a dormant world can catch up deterministically on a later funded/authorized visit rather than burning continuous model compute;
- the UI explains the exact blocked resource and estimated credit need.

Wave 10 enforces entitlements and budgets; Wave 12 supplies monetary credit.

---

## 10. Invitations and joining

Invitation records bind provider invitation, internal tenant, inviter, intended role, expiry, email/identifier assertion, status, and audit.

Flow:

1. authorized member creates invitation;
2. Clockgrove records the internal invitation before/with an optional provider invitation;
3. recipient follows link and authenticates or signs up;
4. provider membership event arrives;
5. internal use case validates invitation, tenant state, membership limits, role policy, and abuse controls;
6. membership becomes active;
7. existing sockets/sessions refresh grants;
8. duplicate, expired, revoked, wrong-environment, or wrong-identity attempts fail visibly.

Invitations never expose world/private content before membership activation.

---

## 11. Tenant-scoped routing and data isolation

Every table, object key, actor address, Queue/Workflow envelope, cache key, vector/FTS query, graph traversal, R2 path, WebSocket assertion, capability/MCP installation, channel binding, usage event, and future wallet entry carries canonical `tenant_id` or derives it through an unambiguous parent protected by constraints.

Requirements:

- composite uniqueness includes tenant where IDs are not globally opaque;
- PostgreSQL RLS denies cross-tenant access even after application bugs;
- pooled connections set/reset tenant context safely or use parameterized RLS claims;
- provider/org/user IDs never substitute for tenant IDs;
- objects cannot change tenant by direct update;
- world transfer is a typed saga with export/import/rekey/re-authorization;
- search, embeddings, summaries, caches, snapshots, backups, exports, analytics, and logs follow the same isolation;
- tenant deletion cleans derived and provider state.

---

## 12. Workspace and account lifecycle

### 12.1 Workspace states

`provisioning → active → suspended/read_only → archiving → deleted`.

Suspension can block costly or mutating operations while preserving authorized export and payment resolution. It cannot silently erase world state.

### 12.2 User deletion

- remove/reassign shared-workspace memberships according to ownership rules;
- require ownership transfer or workspace deletion decision;
- delete personal workspace through Wave 9 privacy Workflow;
- tombstone public causal references where policy permits;
- revoke sessions, channel bindings, API keys, and credentials;
- coordinate Stripe/customer data later through Wave 12;
- wait for backup-expiration policy and issue verified result.

Provider deletion alone never performs best-effort asynchronous data loss without a Clockgrove deletion case.

---

## 13. Signup and workspace UX

Required surfaces:

- branded sign-up/sign-in and recovery;
- pending/provisioning/retry states;
- first-run explanation and showcase;
- create private world action;
- active-workspace switcher integrated into the top HUD/menu;
- personal versus shared workspace labeling;
- create shared workspace, invite, accept/revoke, member/role management;
- current workspace privacy, budgets, usage, and billing-owner summary;
- leave workspace, transfer ownership, archive/delete;
- data export and account deletion;
- errors that distinguish authentication, pending onboarding, membership, suspension, quota, and future insufficient credits.

Create-world UX shows the truthful lifecycle (`requested`, validating, installing, seeding, verifying, ready, or failed), preserves the world URL while work resumes, exposes safe retry/support details, and opens scene/text projection only after `WorldReady`. Signup completion does not wait for the world to become ready.

Switching workspaces closes/reconnects scene and conversation channels, clears tenant-scoped caches, resets selection, and never flashes the prior tenant’s data.

---

## 14. Owned code and configuration

```text
apps/web/src/auth/
apps/web/src/onboarding/
apps/web/src/workspaces/
apps/web/src/invitations/
apps/web/src/account/
apps/management/src/identity/
apps/management/src/tenancy/
apps/management/src/provisioning/
apps/management/src/auth-providers/better-auth/
apps/management/src/auth-providers/clerk/
apps/runtime/src/management-assertions/
packages/contracts/src/identity/
packages/contracts/src/tenancy/
packages/contracts/src/onboarding/
packages/contracts/src/auth-provider/
packages/application/src/identity/
packages/application/src/tenancy/
packages/application/src/invitations/
packages/application/src/provisioning/
packages/adapters/src/auth/{better-auth,clerk}/
packages/persistence/src/tenancy/
packages/testkit/src/tenancy/
packages/testkit/src/auth-provider-conformance/
tests/security/multitenancy/
tests/e2e/signup/
tests/e2e/workspaces/
docs/protocols/{identity,tenancy,provisioning,auth-provider}.md
docs/product/signup-and-workspaces.md
```

---

## 15. Detailed work packets

### RW-1001 — Canonical identity and tenancy contracts

Implement principal, external identity, tenant workspace, membership, one shared billing-account reference per workspace by default, billing-owner seam, lifecycle, migrations, constraints, RLS, and provider-neutral Management ports.

Exit: no domain record requires a raw provider user/org ID as canonical ownership.

### RW-1002 — Provider-neutral authentication adapters and reconciliation

Define `AuthProviderPort` and its conformance kit. Implement Better Auth as the reference adapter and Clerk as optional: sign-up/sign-in, session verification, event authenticity, idempotent intake, ordering/duplicate/loss reconciliation, pending/error states, environment isolation, account linking, revocation, schema/migration ownership, and degraded-provider behavior.

Exit: either adapter can be selected without changing domain/application packages, and provider/internal identity converges safely under session and event faults.

### RW-1003 — Personal workspace provisioning

Implement exactly-once Workflow, owner membership, policies/quotas, billing placeholder, starter entitlement, onboarding record, retries, cleanup, and admin reconciliation.

Exit: every active principal has exactly one usable personal workspace.

### RW-1004 — Shared workspaces and organization mapping

Implement optional provider-Organization mapping, internal tenant creation, active workspace selection, create/switch/rename/archive, ownership transfer, limits, and lifecycle reconciliation.

Exit: one user safely switches among personal and shared contexts across tabs.

### RW-1005 — Invitations, memberships, and roles

Implement invite/create/accept/revoke/expire, signup-through-invite, provider/internal reconciliation, role/capability mapping, member removal, cache/socket revocation, and audit.

Exit: no invited identity sees tenant data before valid membership activation.

### RW-1006 — Tenant-scoped routing and storage hardening

Audit/modify every table, R2 key, actor address, Queue/Workflow, realtime assertion, search/vector/graph query, cache, capability/channel/usage record, export and delete path; add static/runtime guards.

Exit: automated architecture test proves every governed resource has one tenant path.

### RW-1007 — Signup, onboarding, and starter-world UX

Implement public showcase, first-run tasks, create-world action over the qualified `WorldProvisioningCase`, lifecycle/status/retry UI, return-to-pending-world behavior, promotional entitlement seam, mode/cost disclosure, workspace switcher, responsive/accessibility states, analytics, and recovery.

Exit: a first-time user reaches a meaningful private interaction without developer help or required card.

### RW-1008 — Workspace/account administration and lifecycle

Implement member/settings/privacy/budget summaries, suspend/read-only, leave/transfer/archive/delete, account deletion, export links, support/reconciliation tooling, and audit.

Exit: every lifecycle transition is durable, reversible where declared, and privacy-complete.

### RW-1009 — Multitenant abuse, quota, and load controls

Implement signup/workspace/world/invite rate limits, starter-credit anti-abuse hooks, concurrent tenant load, noisy-neighbor isolation, admission, suspension, and public showcase protection.

Exit: abusive tenant activity remains within declared cost/fanout/provider bounds.

### RW-1010 — Signup and multitenancy qualification

Run cross-tenant/RLS/direct-reference, webhook, invitation, switching, revocation, deletion, signup abuse, accessibility, clean-environment, and load suites; publish evidence.

Exit: publish Wave 10 qualification manifest and satisfy the outcome.

---

## 16. Dependency graph and bounded execution

```text
RW-1001 ─┬─ RW-1002 ─ RW-1003 ─┬─ RW-1007 ─┐
         ├─ RW-1004 ─ RW-1005 ──┤           │
         └─ RW-1006 ─────────────┼─ RW-1008 ┼─ RW-1010
RW-1009 ──────────────────────────┘           │
```

Safe lanes: identity/provider integration; workspace UI; invitation/membership; database/RLS audit; abuse/load harness. Freeze canonical principal/tenant/membership schemas before dependent work.

---

## 17. Test and qualification strategy

```text
pnpm test:identity
pnpm test:tenancy
pnpm test:auth-provider-conformance
pnpm test:auth:better-auth
pnpm test:auth:clerk
pnpm test:invitations
pnpm test:e2e:signup
pnpm test:e2e:workspaces
pnpm test:security:multitenancy
pnpm test:load:tenants
pnpm qualify:wave10:staging
```

Required scenarios:

- new user signup with duplicate/out-of-order/missing webhooks;
- interrupted provisioning resumes exactly once;
- create-world pins one artifact, creates owner membership/persona once, reaches `WorldReady`, and returns through the normal browser-readiness contract;
- provisioning failure exposes stable status/retry and resumes without duplicate genesis, seed events, membership, or promotional credits;
- invitation for new user versus existing multi-workspace user;
- revoked/expired invitation race;
- member removal during active scene/chat/model run;
- two browser tabs using different workspaces;
- guessed world/actor/session/artifact/run/wallet IDs across tenants;
- search/vector/graph/cache leakage attempts;
- shared-workspace ownership transfer and owner deletion;
- personal-workspace deletion with shared memberships retained;
- public showcase abuse and starter-entitlement farming;
- noisy tenant cannot starve another tenant’s realtime/cognition;
- clean Better Auth/staging environment reproduces signup and teardown;
- optional Clerk adapter passes the same conformance and application suites when enabled;
- a staged Better Auth-to-Clerk or Clerk-to-Better Auth link migration preserves canonical principal and tenant IDs.

---

## 18. Security, privacy, and observability

Zero tolerance:

- provider identity mapped to the wrong principal;
- world/resource mapped to the wrong tenant;
- cross-tenant read, retrieval, socket, artifact, or model context;
- removed member retaining access;
- duplicate personal workspaces or starter entitlements;
- deletion affecting the wrong tenant;
- billing-owner confusion that could charge one tenant for another.

Measure signup conversion/state/failure, webhook/reconciliation lag, provisioning duration, active/pending/suspended principals, workspace creation/switching, invitations, membership churn, starter-world creation, quotas, public-showcase usage, cross-tenant denial, noisy-neighbor signals, deletion/export, and support cases using opaque IDs.

---

## 19. Explicit non-goals

Wave 10 does not implement:

- payment collection or customer-facing monetary balances;
- enterprise SSO, verified-domain auto-enrollment, SCIM, procurement, or contracts;
- public user directory or social graph across tenants;
- runtime object transfer between worlds; administrative world export/import remains a separate lifecycle operation;
- one provider Organization per world;
- using provider metadata as canonical authorization, attribution, or billing state;
- mandatory card collection for basic signup;
- unlimited free cognitive usage;
- pricing plans or subscription packaging.

---

## 20. Exit evidence checklist

- [ ] RW-1001 through RW-1010 are merged.
- [ ] Every verified user maps to one internal principal and personal workspace.
- [ ] Personal/shared workspaces share one canonical tenant contract.
- [ ] Better Auth reference deployment passes schema, session, recovery, rate-limit, event, and adapter conformance tests.
- [ ] Any enabled provider data is reconciled but not canonical workspace/world/attribution/billing authority.
- [ ] Signup/provisioning/invitation/lifecycle operations are idempotent and auditable.
- [ ] Active workspace is trusted and explicit on every API/socket/runtime route.
- [ ] Cross-tenant RLS, search, vector, graph, cache, R2, Queue, Workflow, actor, session, channel, usage, export, and deletion suites pass.
- [ ] Member revocation removes effective access promptly and safely.
- [ ] First-time user reaches a bounded private starter experience without a card.
- [ ] Abuse/noisy-neighbor/load controls pass.
- [ ] Account/workspace export, transfer, deletion, and ownership rules pass.
- [ ] Local/OSS single-owner operation remains unchanged and independent.

The manifest records commit, selected adapter, provider/settings/schema/migration/policy versions, adapter conformance, RLS/tenant-coverage inventory, signup/provisioning/invitation fault results, cross-tenant suite, load/abuse evidence, accessibility/product funnel findings, deletion/export results, staging qualification, and exit decision.

---

## 21. Handoff to Waves 11 and 12

Wave 11 adds MUD/MOO-style world membership, durable world personas, visitor presence, immutable action attribution, world-local personal inventory, and inherited object-mobility policy. Workspace membership does not imply membership in every world, and joining another person's world does not join its owning workspace. Runtime object portability between worlds is out of scope.

Wave 12 then attaches one governed shared wallet and credit grants to each configured billing account. It consumes Wave 9 resource events, Wave 10 tenant/billing-owner contracts, and Wave 11 causal attribution while resolving sponsorship separately. Management uses Redis to atomically allocate bounded world credit leases and PostgreSQL for immutable accounting/rebuild; Runtime consumes leases locally and returns attributed usage receipts. All Stripe/customer/money state remains Management-only. Authentication, tenancy, world truth and attribution remain functional if Stripe is unavailable; only collection, new funding and reconciliation degrade.

---

## 22. Current primary references

- Better Auth documentation and plugin model: https://www.better-auth.com/docs
- Better Auth installation and database adapters: https://www.better-auth.com/docs/installation
- Better Auth Organization plugin: https://www.better-auth.com/docs/plugins/organization
- Better Auth Hono/Cloudflare Workers integration: https://www.better-auth.com/docs/integrations/hono
- Better Auth database and migration model: https://www.better-auth.com/docs/concepts/database
- Better Auth session management: https://www.better-auth.com/docs/concepts/session-management
- Better Auth rate limiting: https://www.better-auth.com/docs/concepts/rate-limit
- Optional Clerk Organizations adapter: https://clerk.com/docs/guides/organizations/overview
