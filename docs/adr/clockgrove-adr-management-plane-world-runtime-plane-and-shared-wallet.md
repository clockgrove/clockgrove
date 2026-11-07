# ADR: Management Plane, World Runtime Plane, and Shared Credit Wallet

**Status:** Accepted  
**Version:** 1.0  
**Date:** August 17, 2026  
**Scope:** Provisioning, world management, runtime authority, failure isolation, metering, shared-wallet admission, and future deployment seams  
**Accepted baseline:** `clockgrove-prd-v0.5.md` v0.5.6; `raccoon-world-cloudflare-implementation-plan.md` v3.7; Waves 0–12

---

## 1. Decision

Clockgrove formalizes two **logical planes now**:

1. the **Management Plane**, which manages principals, tenants, world catalog and desired lifecycle, immutable pack artifacts, provisioning and upgrade cases, quotas, sponsorship/wallet admission, and administrative operations; and
2. the **World Runtime Plane**, which owns each world's canonical journal, simulation, timelines, actors, cognition, conversations, spatial authority, in-world membership/personas/inventory, scene projection, and causal evidence.

Clockgrove does **not require two physical deployments, two databases, or a distributed control protocol on day one**. It begins with explicit package/API/schema/role boundaries in one repository and, where operationally useful, one process/CLI, one Worker surface, and one PostgreSQL cluster. The same contracts preserve the ability to split compute, credentials, database roles or clusters, queues, and release cadence later.

The initial implementation is a modular monolith. The `clockgrove` CLI is a composition root that may invoke both planes in-process, but plane modules communicate through the same typed ports used by later HTTP, Queue, or Workflow adapters. CLI convenience never authorizes cross-plane persistence writes.

The term **Management Plane** is preferred over “control plane” in product-runtime documentation because external development tooling also uses that term. If “control plane” is used, it must be qualified as **world-management control plane**.

---

## 2. Why the boundary is valuable

The end-to-end Raccoon World path reveals two different kinds of work:

- “Create a world from this signed artifact, under this tenant and budget, then report when it is ready.”
- “Advance rain, let Stevie perceive it, accept Alice's action, move an axe, commit evidence, and project the result.”

The first is desired-state and lifecycle orchestration. The second is world truth. Separating their ownership:

- lets ready worlds continue if signup, billing, or administrative services are degraded;
- prevents an admin UI or pack registry from mutating simulation state directly;
- gives provisioning, upgrades, export, archival, and deletion durable resumable cases;
- keeps tenant quotas and credit admission outside deterministic simulation;
- supports later regional placement, dedicated worlds, enterprise isolation, and independent runtime scaling;
- makes it possible to replace Better Auth, Stripe, Redis, or a management UI without rewriting world semantics;
- gives each fact one authoritative owner and one reconciliation direction.

---

## 3. Authority map

| Concern | Authoritative owner | Runtime projection or handshake |
| --- | --- | --- |
| External identity links and canonical principals | Management Plane | Short-lived verified principal assertion |
| Tenant/workspace membership and roles | Management Plane | Scoped authorization claims and revocation projection |
| World catalog, owning tenant, desired lifecycle | Management Plane | Runtime reports applied lifecycle and health |
| Pack artifact registry, signatures, licenses, provenance | Management Plane | Runtime pins immutable artifact hash/install receipt |
| Provisioning and upgrade case | Management Plane orchestration | Runtime commits genesis/migrations and returns receipts |
| Billing accounts, shared wallets, grants, rate cards, sponsorship, money and Stripe | Management Plane | Bounded world credit lease and execution entitlement |
| World-local quota/lease consumption | World Runtime Plane | Usage/capture/release receipts returned to Management |
| World/timeline journal and physical truth | World Runtime Plane | Read models and status exposed to management/UI |
| Simulation time, schedules, rules, spatial state | World Runtime Plane | Operational health only to Management Plane |
| Actor cognition, conversations, memories, relationships | World Runtime Plane | Metered resource events and redacted admin status |
| World membership, persona, presence, inventory | World Runtime Plane | Catalog summary may be projected to Management Plane |
| In-world permissions, attribution, authority decisions | World Runtime Plane | Immutable evidence; never reconstructed from billing |
| Scene and text projection | World Runtime Plane | Browser readiness references catalog/lifecycle status |
| Administrative export, archive and deletion case | Management Plane orchestration | Runtime creates/validates artifacts and tombstone receipts |

### 3.1 Important boundary inside “membership”

Workspace membership is administrative and belongs to the Management Plane. World membership and persona are replayable, world-local participation facts and belong to the World Runtime Plane. A Management Plane invitation may request activation, but access exists only after the runtime commits the authorized world-membership transition.

### 3.2 Important boundary inside “configuration”

The Management Plane may hold desired policy or pack version. Any setting that changes world behavior—clock policy, installed pack, world permission, rule, actor, object, or migration—must cross the boundary as a typed command, provisioning step, or previewed upgrade. Management code never edits runtime tables as a shortcut.

---

## 4. Provisioning handshake

The recommended birth path is:

```text
Management Plane
  validate tenant/grant/quota
  reserve WorldId + TimelineId
  pin WorldPackArtifactRef
  create WorldProvisioningCase
  publish ProvisionWorld request
          |
          v
World Runtime Plane
  verify request + artifact
  create immutable installation receipt
  commit genesis metadata
  execute idempotent seed commands
  derive schedules/random streams/cognitive seeds
  build and verify seed projection hash
  commit WorldReady
          |
          v
Management Plane
  consume applied receipt
  project ready status and routable endpoint
```

Every step carries stable case, request, world, timeline, artifact, and idempotency identifiers. The request transport is at-least-once; both sides deduplicate. An outbox or equivalent durable dispatch follows the local authoritative commit. A reconciler compares desired and applied state and safely resumes missing work.

`WorldReady` is a runtime fact. The Management Plane may project it but cannot declare it optimistically. Conversely, the runtime cannot invent tenant ownership or a different requested artifact.

---

## 5. Upgrade, archive, and deletion

Pack upgrades use the same boundary:

1. Management Plane pins the candidate artifact and creates an upgrade case.
2. World Runtime Plane compiles migrations into a previewable changeset against current world state.
3. An authorized creator reviews semantic and visual diff.
4. Runtime promotes fresh commands and records the new installation receipt.
5. Management Plane projects the applied version; the old artifact hash remains inspectable.

Archive and deletion are sagas, not direct table operations. Management owns request, retention policy, legal/tenant authorization, and case status. Runtime owns a consistent export/snapshot, dispatch quiescence, world tombstone, and evidence that no canonical mutation remains accepted. Physical erasure waits for declared retention and backup-expiration policy.

---

## 6. Browser and API surfaces

The browser may use one public gateway while the logical APIs remain distinct:

- Management API: signup, workspaces, world list/create/status, invitations, pack registry, upgrades, quotas, billing, archive/export/delete.
- Runtime gateway: world entry, projection WebSocket, conversations, commands, inspection, authoring previews, timelines, presence, and inventory.

After authenticating, the gateway resolves the canonical principal and creates a short-lived, audience- and world-scoped runtime assertion. Runtime verifies the assertion and its own world-membership/policy state. A valid provider session alone never grants world access.

The create-world screen polls or subscribes to Management Plane case status. On `WorldReady`, the browser enters the existing runtime boot sequence:

```text
route_resolving → identity_resolved → membership_authorized
→ joining_space → snapshot_ready → critical_assets_ready → scene_ready
```

---

## 7. Billing and attribution

Usage and causal attribution flow in opposite directions without becoming the same concept:

- Runtime commits who acted, which authority allowed or denied it, what work occurred, and the causal consequences.
- Runtime emits immutable, deduplicated raw resource-usage events referencing that evidence.
- Management resolves sponsor policy, rates usage, allocates wallet authority, and accounts for captured credits.

### 7.1 One shared wallet per billing account

Each Clockgrove `BillingAccount` maps to at most one provider customer per provider environment and owns one authoritative credit wallet. A personal or shared workspace normally points to one billing account. Its worlds do not receive independent Stripe Customers, Stripe subscriptions, or authoritative wallets merely to separate usage.

The shared wallet may sponsor many worlds. World, actor, action, initiator, beneficiary, and sponsor remain separate attributed dimensions. World-local reports, budgets, alerts, and suspension do not require separate provider billing objects.

### 7.2 Hierarchical credit leases

Management atomically reserves a bounded portion of the shared wallet and issues it to a world as a short-lived, epoch-fenced `WorldCreditLease`:

```ts
interface WorldCreditLease {
  leaseId: CreditLeaseId;
  billingAccountId: BillingAccountId;
  sponsorId: SponsorshipId;
  worldId: WorldId;
  creditLimit: DecimalString;
  rateCardVersion: string;
  resourceCeilings: ResourceCeiling[];
  entitlementEpoch: number;
  issuedAt: string;
  expiresAt: string;
}
```

Runtime may reserve and consume locally only within that lease, its resource ceilings, and more restrictive world/actor/session/action quotas. Local atomic accounting avoids a Management round trip for every actor turn. Runtime emits raw usage plus idempotent capture/release receipts; Management validates/rates them, posts immutable accounting, and renews or denies the lease. Unused authority expires and reconciles safely. Maximum disconnected financial exposure is bounded by outstanding unexpired leases.

This is not a mirrored global balance. Runtime knows authorized credits, applicable quota and effective execution mode. It does not know dollars, prices paid, invoices, cards, provider customers, tax, refunds, disputes, or why a payment failed.

### 7.3 Runtime execution entitlement

Management projects an epoch/versioned world execution entitlement with one effective mode:

```text
active | credit_restricted | frozen | read_only | archived
```

- `active`: normal work within lease and quota.
- `credit_restricted`: variable-cost cognition, tools, media, delivery and acceleration stop; declared free/deterministic behavior may continue.
- `frozen`: simulation clock and new world mutations stop at a safe journal boundary; viewing, history, billing recovery and export remain available.
- `read_only`: no live execution; authorized projection/history/settings/export remain.
- `archived`: no routable runtime placement.

An empty prepaid wallet normally yields `credit_restricted`; nonpayment, risk, or administrative suspension may yield `frozen` or `read_only` according to policy. The runtime receives a safe reason code and entitlement epoch, not commercial details. Frozen time does not silently accrue an unbounded catch-up obligation.

### 7.4 Accounting and Stripe boundary

PostgreSQL in Management owns immutable raw/rated usage copies, double-entry credits, grants, purchases, refunds, disputes, reconciliation, and rebuild authority. Redis in Management is a reconstructible atomic allocator for the shared wallet and outstanding leases. The runtime's local lease counters are also reconstructible from leases, run evidence, and receipts.

All Stripe integration is Management-only. Stripe collects money, stores payment methods, and reports provider-side payment/refund/dispute state. Clockgrove does not depend on Stripe customer-level meters to separate worlds. For prepaid launch, Stripe sells/recharges credits and Clockgrove meters their use internally. A future postpaid adapter may create summarized invoice items from Clockgrove's authoritative meters; Stripe never becomes usage, wallet, sponsorship, quota, or admission authority.

A failed wallet service or payment provider may block new leases and costly work, but it cannot invalidate committed world events or rewrite attribution.

---

## 8. Failure semantics

| Failure | Required behavior |
| --- | --- |
| Management Plane unavailable | Existing ready worlds continue; signup, provisioning, upgrades and admin changes pause safely |
| World Runtime Plane unavailable | Management shows degraded/applied status; it never reports false readiness |
| Provisioning dispatch duplicated | Runtime deduplicates by case/request IDs; one genesis and one ready event |
| Receipt lost after runtime commit | Reconciler redelivers/re-reads applied receipt without rerunning genesis |
| Auth provider unavailable | Existing valid assertions may continue for bounded duration; no new implied access |
| Wallet allocator/Redis unavailable | New leases stop; worlds may consume only valid outstanding leases, then apply their execution mode |
| Shared wallet depleted | No new leases; each world independently applies its configured restricted/frozen policy |
| Nonpayment or provider dispute | Management changes entitlement epoch/mode; Runtime never interprets Stripe state directly |
| Management desired state differs from runtime applied state | Reconciler surfaces drift; no direct database repair across ownership boundary |
| Runtime region/placement changes | Stable world/timeline identity and routing epoch hide physical placement from domain contracts |

The strongest independence test is: **a ready world can keep living while the Management Plane is down**, subject to its already-applied runtime policies and budgets.

---

## 9. Initial implementation shape

Adopt these seams before any physical split:

```text
apps/
  management-api/
  runtime-gateway/
  cli/
packages/
  management-domain/
  runtime-domain/
  plane-contracts/
  provisioning-client/
  provisioning-handler/
  credit-lease-client/
  credit-lease-handler/
```

The exact repository layout may differ, but dependency direction must be enforced. Management packages cannot import runtime persistence adapters. Runtime packages cannot import auth-provider, Stripe, or management database adapters. Shared packages contain identifiers and messages, not a second copy of domain authority.

In PostgreSQL, begin with distinct schemas and least-privilege roles even if one cluster is used. Cross-plane reads use explicit views or APIs; writes use commands/cases. Use separate queue topics and correlation fields. Maintain one local developer command that starts both planes so the boundary does not damage contributor ergonomics.

The Wave 3 phrase **“WorldDO control plane”** becomes **“WorldDO runtime coordinator.”** WorldDO coordinates runtime placement, clock, catch-up, leases and reconciliation; it is not the administrative Management Plane.

---

## 10. When to split physically

Keep the initial logical boundary, then split only when evidence supports one or more of:

- independent availability or deployment cadence is required;
- world runtime load harms signup/admin latency or vice versa;
- dedicated/enterprise worlds need regional, network, or compliance isolation;
- database write patterns or RLS blast radius warrant separate clusters;
- runtime credentials must exclude billing/identity systems at infrastructure level;
- multiple runtime regions or substrates need one global world catalog;
- incident data shows correlated failure is materially costly.

Physical separation should not change domain identifiers, provisioning messages, browser semantics, pack artifacts, or runtime authority.

---

## 11. Risks and rejected extremes

### One undifferentiated application forever

Rejected. It invites direct database shortcuts, unclear lifecycle truth, excessive credential reach, and difficult future regional/dedicated-world placement.

### Independent microservices and databases immediately

Rejected for the initial implementation. It adds distributed transactions, local-development burden, operational cost, and failure recovery before they buy measurable isolation.

### Management Plane owns world membership and persona

Rejected. That would make replay, attribution, world-local privacy, and participation dependent on administrative availability and risks conflating workspace administration with social membership.

### Runtime owns tenant billing and external identity

Rejected. It couples deterministic world behavior to replaceable commercial/identity providers and expands runtime credential blast radius.

---

## 12. Accepted invariants

This ADR freezes:

- names of the two planes and avoidance of development-tooling control-plane ambiguity;
- one authoritative owner for every row/event family;
- provisioning/upgrade request and applied-receipt schemas;
- desired versus applied lifecycle state and reconciliation rules;
- membership/invitation activation handshake;
- short-lived runtime assertion and revocation behavior;
- management/runtime database roles and prohibited cross-plane writes;
- failure matrix and “ready worlds continue” qualification;
- local monolith/modular-deploy path and physical split triggers;
- migration of Wave 3 terminology and work-packet ownership;
- one shared wallet per billing account, with world-local leased authority rather than per-world provider billing objects;
- Management-only money, customer, invoice, payment, refund, dispute, tax and Stripe integration;
- Runtime-only local lease enforcement, raw usage origination, causal attribution and world execution-mode application;
- frozen-time semantics that do not create unbounded catch-up debt.

---

## 13. Final assessment

A formal Management Plane / World Runtime Plane distinction clarifies provisioning and world management while protecting the most important Clockgrove invariant: administrative intent, billing, and provider state may request or constrain work, but only the runtime's authorized journal path can create world truth.

The best greenfield choice is a **modular monolith with a hard logical plane boundary**, durable asynchronous lifecycle handshakes, and least-privilege schemas. That gives Clockgrove the operational simplicity needed for the demo and the architectural escape hatch needed for millions of logical actors, regional placement, dedicated worlds, and later commercial hosting.
