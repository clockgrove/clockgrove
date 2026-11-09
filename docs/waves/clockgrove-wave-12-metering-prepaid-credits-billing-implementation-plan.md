# Clockgrove Wave 12: Usage Metering, Prepaid Credits, and Billing

**Status:** Optional future commercial-hosting implementation specification  
**Version:** 1.5  
**Date:** October 01, 2026
**Parent plan:** `clockgrove-cloudflare-implementation-plan.md` v3.9 plus Waves 0–11  
**Product source:** `clockgrove-prd-v0.5.md` v0.5.8  
**Wave:** 12, optional after multiuser attribution qualification  
**Assumptions:** Waves 10 and 11 are qualified; usage/cost data exists; pricing is not yet fixed
**Development tooling:** development-tool model/compute cost remains operational project spend and is never rated as a customer's world usage unless a separately approved commercial contract is introduced.  

---

## 1. Outcome

Wave 12 completes the Management Plane's commercially safe usage system without putting money, customers, payment-provider state, or a global wallet inside World Runtime semantics. It consumes Wave 11's immutable action/causal attribution, resolves sponsorship separately, and implements one shared wallet per billing account, bounded world credit leases, Runtime-local admission and quota enforcement, immutable usage receipts, versioned Management rating, PostgreSQL accounting, Redis-backed global allocation, purchases and promotional grants, automatic recharge, customer billing UI, Management-only Stripe collection/reconciliation, refunds/chargebacks, execution entitlements, and zero-balance/nonpayment behavior.

The wave exits only when:

> A billing owner can fund one wallet shared across many worlds, see exactly what each world/actor/action consumes, allocate bounded leases and budgets, configure automatic recharge, and reconcile every balance change to rated usage or money movement—while Runtime never handles money or Stripe and duplicate events, partitions, retries, refunds, and chargebacks cannot create or destroy value incorrectly.

The recommended launch model is prepaid usage credits, not an unlimited flat subscription.

Entry is blocked until Wave 11 proves that every mutating or variable-cost operation has action, authority, causal-root, and immediate-cause evidence. Billing may enrich that record with a sponsor/payer decision, but cannot rewrite who initiated, acted, owned, possessed, authorized, or caused the underlying event.

---

### 1.1 Objectives, sequencing, and checkpoints

This wave is a substantial workstream containing numerous Objectives and Work Items. The accepted [incremental-delivery ADR](../adr/clockgrove-adr-incremental-wave-delivery-and-evidence.md) governs capability scope, readiness, comparison rules, and proportionate qualification. The complete exit checklist below remains authoritative for full-wave qualification.

Keep this optional commercial workstream separate from the technical and shared-world tracks. Begin with measured actual usage/cost and immutable attribution, then deliver rating/ledger reconciliation, bounded shared-wallet lease admission, and customer controls before payment collection.

Money movement, Stripe, Redis allocation, zero-balance/nonpayment and refund/dispute behavior require their own complete Objectives and existing product/financial authority. Do not select prices from guessed usage or drag the commercial dependency stack into earlier waves. Broader hybrid subscriptions remain demand-driven.

Financial conservation, exact ledger/rating identities, duplicate suppression and reconciliation remain strict invariants. The semantic-comparison rule cannot normalize away a charge, reservation, credit, debt or missing receipt. Full commercial-wave exit requirements remain applicable before commercial qualification.

---

## 2. Pricing judgment

Prepaid usage credits are the mechanism this wave builds, because Clockgrove's hosted work has variable marginal cost (model tokens, cognition, ingestion, tool calls, previews, media, delivery and scale). Pricing, packaging and the commercial sequence are decided outside this plan.

---

## 3. Terminology and legal posture

Customer-facing language says **Clockgrove usage credits**; "wallet" is an internal implementation term. Credits are closed-loop, non-transferable and not redeemable for cash, and are recorded by source (paid, promotional, adjustment, refund, committed). Legal, tax and accounting review precedes charging real customers.

---

## 4. Plane and authority split

### 4.1 Management Plane is authoritative for

- raw usage/evidence identity;
- billable-unit derivation;
- rate-card version and rating result;
- credit grants, reservations, debits, releases, adjustments, and available balance;
- admission decisions and budgets;
- billing accounts and one shared wallet across their sponsored worlds;
- world credit-lease allocation and execution-entitlement policy;
- tenant/world/actor/session budgets and reporting;
- sponsorship resolution and policy version, separately from action authorship;
- customer-visible usage detail;
- reconciliation cases and audit.

Authority is intentionally split inside Management:

- **PostgreSQL** is canonical for raw/rated usage, grants, immutable double-entry accounting, sponsorship decisions, purchase/refund mappings, reconciliation checkpoints, and audit.
- **Redis** is the operational shared-wallet allocator for atomic lease issue/renew/revoke/reconcile, global available balance, outstanding leased authority, wallet epoch, and idempotency. It is rebuildable from PostgreSQL and never stores world truth.

### 4.2 World Runtime Plane is authoritative for

- action, actor, initiator, causal and authority attribution;
- raw resource usage at the execution source;
- atomic reservations and consumption inside a valid `WorldCreditLease`;
- more restrictive world/actor/session/action quotas;
- application of an epoch/versioned world execution entitlement;
- idempotent usage, capture, release and unused-lease receipts to Management.

Runtime knows internal credits, resource ceilings, lease expiry, entitlement epoch and effective execution mode. It never stores or receives dollars, prices paid, invoices, payment methods, provider customer/subscription IDs, tax, refunds, disputes, chargebacks, or the commercial reason a payment failed.

### 4.3 Stripe is authoritative for

- payment methods and card/bank details;
- Checkout/PaymentIntent/Invoice payment state;
- successful collection, refunds, disputes, chargebacks, and payment receipts;
- tax calculation/collection where configured;
- provider-side customer/payment artifacts.

Stripe meter events and credit features may support billing-account-level reporting, but customer-level asynchronous aggregates cannot partition or admit individual worlds. Clockgrove's internal meters remain authoritative. A future postpaid adapter may create summarized invoice items from those meters.

### 4.4 World semantics remain independent

No kernel reducer, event meaning, actor identity, action attribution, object ownership/possession, memory, rule, or replay result depends on Stripe IDs, prices, invoices, sponsor selection, Redis availability, or wallet balance. The application layer checks entitlements/budgets before costly work and records denials separately from world truth.

---

## 5. Usage event model

### 5.1 Immutable event

```ts
interface UsageEvent {
  usageEventId: UsageEventId;
  idempotencyKey: string;
  tenantId: TenantId;
  worldId?: WorldId;
  timelineId?: TimelineId;
  actionId?: ActionId;
  causalRootId?: ActionId;
  initiatingPrincipalId?: PrincipalId;
  initiatingPresenceId?: PresenceId;
  actorId?: SubjectId;
  sessionId?: SessionId;
  runId?: RunId;
  category: UsageCategory;
  quantity: DecimalString;
  unit: string;
  source: UsageSourceRef;
  occurredAt: string;
  receivedAt: string;
  metadataVersion: number;
}

interface SponsorshipResolution {
  sponsorshipId: SponsorshipId;
  actionId: ActionId;
  tenantId: TenantId;
  beneficiaryPrincipalId?: PrincipalId;
  billingAccountId?: BillingAccountId;
  policy: "world_host" | "initiator" | "shared_pool" | "explicit_grant" | "platform" | "denied";
  policyVersion: string;
  resolvedAt: string;
}

interface SponsorshipEnvelope {
  sponsorshipEnvelopeId: SponsorshipEnvelopeId;
  causalRootId: ActionId;
  billingAccountId?: BillingAccountId;
  policy: SponsorshipResolution["policy"];
  allowedCategories: UsageCategory[];
  maximumCredits: DecimalString;
  maximumCausalDepth: number;
  reservedCredits: DecimalString;
  expiresAt: string;
  policyVersion: string;
}
```

Usage events are append-only and derived from durable provider receipts, committed runs/steps, Wave 11 attribution envelopes, storage/compute measurements, or deterministic aggregation. Client-reported usage is never trusted directly.

The Runtime event carries native resource quantities, never money. Management may join separately protected provider invoices or cost receipts during rating and margin analysis; those commercial records never flow back into world contracts.

Attribution answers who or what caused the work. Sponsorship answers which account, if any, agreed to fund its variable cost. A visitor may initiate an action sponsored by the host; a host-owned actor may act autonomously under a shared pool; deterministic actions may remain attributed while producing no billable usage.

### 5.2 Default sponsorship posture

Existing game platforms provide a useful economic pattern without defining Clockgrove's product: the host normally absorbs baseline world operation, while monetized or premium actions are explicit. Clockgrove sharpens that into policy:

| Work | Initial default sponsor |
|---|---|
| Deterministic movement, pickup/drop, ordinary chop, local projection | No direct usage debit; covered by hosted baseline/quota |
| Host-configured ambient cognition | World host or shared world pool |
| Visitor explicitly requests premium cognition/tool/media | Initiator, explicit grant, or deny before execution |
| Host explicitly offers “world pays” interaction | World host within a disclosed cap |
| Platform showcase/promotion | Platform promotional grant |
| Use of another person's world-local object | Never the object owner merely because they own it |

### 5.3 Bounded causal inheritance

Child runs may inherit a sponsorship envelope only when category, expiry, causal depth, and remaining reservation permit it. Inheritance preserves the original action/causal links but never creates open-ended financial responsibility.

When a reaction exceeds the envelope, policy must choose one explicit outcome: deterministic fallback, delay, summarized/coarse processing, request a new sponsor authorization, or deny the variable-cost work. It must not silently charge the initiator, host, object owner, or last payer.

### 5.4 Initial categories

- model input/output/cached tokens by alias/tier;
- model image/audio seconds or generated assets where used;
- transcription/extraction pages/minutes/bytes;
- embedding units and retained vector/storage;
- MCP/tool call class and external provider pass-through;
- cognitive/background activation class;
- preview/fast-forward simulated time or bounded compute class;
- hosted storage/egress/realtime above included baseline;
- external messaging/media delivery;
- operator adjustment or promotional activity is not usage and stays in the credit ledger.

Do not expose dozens of raw infrastructure meters as the only customer model. Preserve raw usage, then rate it into a small understandable catalog.

---

## 6. Rate cards and customer units

### 6.1 Versioned rate card

Each rated event pins:

- product meter/version;
- effective date and tenant/plan applicability;
- source-unit conversion;
- unit price in credits;
- included/free allowance interaction;
- rounding and minimum increment;
- provider pass-through/markup policy;
- tax category/reference;
- promotional exclusions;
- sunset/migration policy.

Rate changes apply prospectively. Re-rating old usage requires an explicit correction case; never mutate an old debit invisibly.

### 6.2 Credit denomination

Recommended customer experience: display credits with a stable simple monetary relationship, such as a cent-denominated usage balance, while keeping raw metering units visible in drill-down. Do not finalize `1 credit = $X` until tax/accounting and pricing research are complete.

Benefits:

- users understand remaining spend;
- auto-recharge thresholds are intuitive;
- model/provider price changes can alter prospective burn rates without redenominating balances;
- product can show “estimated 18–25 credits” before expensive work.

Avoid a fictional token that obscures margin or makes users perform exchange-rate math.

### 6.3 Rating pipeline

```text
raw usage received
  → deduplicated
  → validated/attributed
  → rate card resolved
  → rated usage committed
  → reservation captured or debit posted
  → balance/projection updated
  → Stripe mirror/reconciliation queued
```

Raw usage, rated usage, and credit ledger are separate immutable layers.

---

## 7. Credit ledger

### 7.1 Billing account and shared wallet

```ts
interface BillingAccount {
  billingAccountId: BillingAccountId;
  status: "active" | "grace" | "suspended" | "closing" | "closed";
  billingOwnerPrincipalId: PrincipalId;
  providerCustomerRefs: ProviderCustomerRef[];
  walletEpoch: number;
  policyVersion: string;
}
```

One billing account owns one authoritative credit wallet. A personal or shared workspace normally references one billing account, and all of its worlds draw from that wallet through leases. A world never receives a separate Stripe Customer, subscription, provider meter, or authoritative wallet merely to preserve its own budget or usage report.

### 7.2 Double-entry structure

Use balanced immutable journal entries, not a mutable `balance` column as authority.

Accounts include:

- billing-account available credits;
- credits leased to worlds;
- reserved credits;
- consumed credits/revenue clearing;
- paid-credit liability;
- promotional-credit contra/expense account;
- refund/dispute/chargeback clearing;
- adjustment/suspense.

Each transaction has stable ID, tenant, type, amount, currency/credit unit, grant, usage/reservation/payment/refund source, timestamps, effective time, idempotency key, policy/rate version, actor/principal, and audit.

The displayed accounting balance is rebuilt and reconciled from ledger entries. Redis maintains the low-latency shared-wallet and outstanding-lease projection; drift is observable and repaired from PostgreSQL.

### 7.3 Grants

```ts
type CreditGrantKind =
  | "paid"
  | "promotional"
  | "bonus"
  | "subscription_included"
  | "contract_commit"
  | "adjustment"
  | "refund";
```

Each grant declares amount, remaining, availability/effective time, expiry if legally/product-approved, applicability, priority, source payment/invoice, refundability, and status.

Recommended default:

- purchased principal credits do not expire at self-serve launch unless counsel/accounting approve and the customer disclosure is clear;
- promotional/bonus credits may expire with conspicuous terms;
- burn earliest-expiring eligible promotional/bonus credits first, then paid credits, unless accounting/legal policy requires another priority;
- paid and promotional balances are displayed separately enough to explain expiration/refund behavior.

---

## 8. Reservations and admission control

Variable work must not create postpaid debt accidentally.

### 8.1 Shared-wallet lease allocation

Management allocates rather than mirrors the global balance:

1. resolve billing account, sponsor, grant applicability, world budget and entitlement epoch;
2. estimate a bounded world allocation and resource ceilings;
3. atomically reserve that amount from the shared wallet in Redis;
4. durably record and issue a signed/versioned `WorldCreditLease` with lease ID, world, billing account, sponsor, credit limit, rate-card version, ceilings, epoch and expiry;
5. project the lease to the current WorldDO/runtime coordinator;
6. renew, top up, narrow, revoke or expire only through idempotent Management operations;
7. reconcile unused and captured authority from Runtime receipts before returning credits to global availability.

One wallet may have many simultaneous world leases, but their outstanding limits cannot exceed eligible available credits plus an explicitly configured risk buffer. A lease is spend authority, not a transfer of money or a second authoritative wallet. Short TTL and entitlement epochs bound use during a Management/Runtime partition or suspension race.

### 8.2 Runtime-local reservation and capture

Within a valid lease, the authoritative runtime owner atomically:

1. checks lease epoch/expiry, execution mode and more restrictive world/actor/session/action/category quotas;
2. reserves the maximum local credit requirement under a stable operation ID;
3. starts the run/tool/Workflow only after the local reservation commits;
4. records native resource usage and attributed evidence;
5. captures actual local credits and releases unused reservation;
6. emits immutable, idempotent usage/capture/release receipts to Management;
7. stops at a safe boundary or requests a new lease when remaining authority cannot cover continued work.

WorldDO/runtime SQLite may implement this atomic local counter behind `LocalCreditAdmissionPort`. It never queries Redis or Stripe per actor turn. Child reactions remain bounded by the original sponsorship envelope and local lease; only Management can authorize broader sponsorship or additional global credit authority.

### 8.3 Estimate UX

Before expensive authoring, fast-forward, ingestion, generation, or external tool actions, show an estimated range and maximum cap when material. Ordinary short conversation may use an account-configured per-turn cap without modal friction.

### 8.4 Real-time gate

`WorldCreditLeasePort` calls Management only for issue/renew/revoke/reconcile. `LocalCreditAdmissionPort` handles the hot path inside Runtime. Stripe is never called synchronously for a model token, actor wake, or world lease.

If Management/Redis is unavailable, no new leases issue. Already leased work may continue only within an unexpired, current-epoch lease. When it is exhausted or expires, Runtime applies the projected execution mode. Operators may not bypass admission by trusting a stale client, provider balance, or copied global-wallet value.

### 8.5 Rebuild and reconciliation

Management PostgreSQL is the accounting and rebuild authority. A versioned rebuilder replays wallet, grant and lease state into a new Redis namespace, verifies totals and active authority, then swaps routing under a fenced wallet epoch. Runtime-local counters rebuild from issued leases, runs and immutable receipts. Periodic bidirectional reconciliation detects missing/duplicate/stale leases or captures and creates explicit correction cases; it never mutates posted ledger entries or world evidence.

---

## 9. Purchases, top-ups, and automatic recharge

### 9.1 One-time purchase

1. owner/billing manager selects credit pack;
2. server creates Stripe Checkout/PaymentIntent with internal purchase ID, tenant/customer mapping, price/version, tax/address requirements, and idempotency;
3. return page shows pending, never assumes success;
4. signed Stripe webhook records payment state;
5. successful, non-duplicated payment releases one paid credit grant;
6. failed/expired payment releases no credits;
7. reconciliation catches lost/out-of-order events.

### 9.2 Automatic recharge

Workspace owner configures:

- enabled/disabled;
- trigger balance;
- recharge amount/pack;
- monthly recharge count and monetary ceiling;
- payment method;
- low-balance/charge/failure notifications;
- optional approval above a threshold.

Auto-recharge trigger is deduplicated and serialized per billing account. Multiple simultaneous runs cannot generate duplicate charges. Credits release only after confirmed payment success.

### 9.3 Credit-pack bonuses

Bonus packs, if any, are a later pricing decision; the ledger records a bonus as a separate promotional grant.

---

## 10. Stripe integration strategy

### 10.1 Launch adapter

Use Stripe for:

- at most one Customer per Clockgrove billing account and provider environment;
- hosted Checkout or Payment Element for one-time credit purchases;
- saved payment method for auto-recharge with required consent;
- webhook-driven payment/refund/dispute state;
- Tax and receipts/invoices as legally/accounting appropriate;
- Customer Portal for payment-method/receipt management if its configured surface fits.

Maintain an internal provider mapping and reconciliation table. Do not put Stripe Customer IDs in authentication-provider public/unsafe metadata, attribution records, or world records.

Worlds do not receive separate Stripe Customers, subscriptions, or meters. Stripe customer objects follow the billing account, while Clockgrove's internal dimensions preserve world/actor/action attribution and budgets.

### 10.2 Stripe meters and credits

Stripe supports meter events for usage-based billing and credit-grant/balance APIs for metered prices, but meter aggregation is customer-oriented and asynchronous. That cannot independently allocate usage among multiple worlds or enforce their local execution policy.

Therefore:

- launch with Clockgrove’s ledger as authoritative;
- for prepaid launch, use Stripe to sell/recharge credits and keep consumption entirely in Clockgrove's internal meters/ledger;
- do not mirror per-world authoritative balances into Stripe meters;
- for future postpaid accounts, optionally create summarized invoice items or billing-account-level meter events from finalized internal statements;
- evaluate Stripe Credit Grants only as a Management-side payment/accounting feature after API stability and tax/accounting fit are proven;
- avoid dual-authority by treating any Stripe credit balance as a reconciled mirror;
- add Metronome or another billing platform only after measured contract/rating complexity exceeds the in-house model.

---

## 11. Zero-balance and delinquency behavior

Management wallet states:

```text
funded
→ low_balance
→ recharge_pending
→ depleted
→ payment_failed_grace
→ suspended
```

Runtime execution modes are independently projected per world:

```text
active | credit_restricted | frozen | read_only | archived
```

At shared-wallet depletion:

- issue no new world leases;
- allow a world to finish only within its current unexpired lease;
- move each dependent world to its configured `credit_restricted` or `frozen` mode when its lease is exhausted/expired;
- keep account, billing, export, deletion, world history, and settings available;
- allow narrowly budgeted free deterministic observation in `credit_restricted` when product policy supports it;
- freeze simulation time and new mutations at a safe journal boundary when baseline hosted execution is no longer entitled;
- suppress proactive contact that would incur cost unless emergency/product policy explicitly grants it;
- show precise balance, blocked operation, estimate, and top-up action.

For nonpayment, dispute/risk suspension, or explicit administrative suspension, Management advances the entitlement epoch and normally projects `frozen` or `read_only`. Runtime sees only the safe reason code and effective mode. A frozen world resumes from the frozen simulation instant unless an explicitly funded, bounded catch-up policy is selected; it never silently accrues unlimited catch-up debt.

Do not delete a cherished world merely because a card fails. Long-term storage/archival policy, notice, export, and deletion are separate explicit lifecycle decisions.

---

## 12. Refunds, disputes, and chargebacks

### 12.1 Refund

Refund calculation distinguishes unconsumed paid principal, consumed usage, promotional bonus, taxes/fees, and legally required exceptions. A refund creates reversing/adjustment ledger transactions; it never edits or deletes history.

### 12.2 Chargeback/dispute

- record Stripe dispute event idempotently;
- freeze equivalent remaining paid grant where possible;
- if already consumed, move account to explicit negative/suspense state without rewriting usage;
- suspend new paid work according to risk policy;
- retain world/export/account access as legally/product appropriate;
- resolve on dispute outcome with balanced entries;
- prevent promotional/referral abuse and repeated account creation.

### 12.3 Failed auto-recharge

Do not retry endlessly. Follow declared retry count/cadence, notify billing owners, retain payment-failure evidence, and move to depleted/grace behavior.

---

## 13. Budgets and customer controls

Workspace controls:

- low-balance alerts;
- auto-recharge threshold/amount/monthly ceiling;
- maximum daily/monthly credit burn;
- per-world/user/actor/session/run/tool/model/channel limits;
- background cognition/heartbeat/consolidation allowance;
- preview/fast-forward maximum;
- external effect approval thresholds;
- model quality versus cost policy;
- hard stop versus downgrade/delay preference where safe.

Budget exhaustion creates an inspectable admission result, never a fabricated character refusal. Actor UX may phrase inability naturally only after the system clearly identifies platform cost policy to the user.

---

## 14. Customer billing and usage UX

Required surfaces:

- current available, reserved, promotional, paid, and expiring balance;
- estimated run/operation cost where material;
- recent usage grouped by understandable category, world, actor/session, and time;
- raw/provider detail for developer billing owners;
- credit purchases and receipts;
- auto-recharge settings and history;
- budgets, alerts, denials, downgrades, and cost anomalies;
- rate-card/effective-date disclosures;
- promotional grant terms/expiry;
- refunds/disputes/support case;
- monthly export/statement and reconciliation status;
- optional future plan/included-credit summary.

The Raccoon World HUD shows only unobtrusive low-balance/blocked-action state. Detailed billing lives in workspace settings, not the character panel.

---

## 15. Hybrid subscription seam

Do not implement a subscription until usage data shows fixed recurring value. Preserve contracts for:

```ts
interface PlanEntitlement {
  planId: PlanId;
  tenantId: TenantId;
  effectiveRange: EffectiveRange;
  privateWorldLimit?: number;
  memberLimit?: number;
  storageBaseline?: Quantity;
  retentionPolicy?: string;
  concurrencyPolicy?: string;
  supportClass?: string;
  recurringCreditGrant?: CreditGrantTemplate;
}
```

If launched, a monthly plan should grant durable entitlements and possibly monthly credits. It should not promise unlimited variable usage. Credits remain the common burn mechanism across free, membership, and committed accounts.

---

## 16. Owned code and configuration

```text
apps/web/src/billing/
apps/web/src/usage/
apps/management/src/billing/
apps/management/src/metering/
apps/management/src/rating/
apps/management/src/wallet/
apps/management/src/wallet/redis/
apps/management/src/webhooks/stripe/
apps/runtime/src/usage-receipts/
apps/runtime/src/credit-leases/
apps/runtime/src/execution-entitlements/
packages/contracts/src/billing/
packages/contracts/src/usage/
packages/contracts/src/rating/
packages/contracts/src/credits/
packages/management/src/billing/
packages/management/src/metering/
packages/management/src/rating/
packages/management/src/credits/
packages/management/src/wallet-allocation/
packages/runtime/src/local-credit-admission/
packages/persistence/src/billing/
packages/testkit/src/billing/
tests/reconciliation/billing/
tests/reconciliation/wallet-redis/
tests/security/billing/
tests/e2e/billing/
docs/protocols/{usage,rating,credit-ledger,world-credit-lease,execution-entitlement,wallet-rebuild,stripe-reconciliation}.md
docs/product/pricing-and-credits.md
```

---

## 17. Detailed work packets

### RW-1201 — Usage event and attribution ledger

Implement immutable idempotent Runtime usage receipts, source evidence, Wave 11 action/causal links, tenant/world/principal/presence/actor/session/run attribution, native resource categories/quantities, Management-side provider-cost joins, aggregation, correction events, coverage checks, sponsorship-resolution records, and Wave 9 meter migration.

Exit: every billable unit traces to protected durable execution evidence, one Wave 11 causal root, and one resolved sponsor or explicit denial; authorship is never inferred from payer.

### RW-1202 — Versioned rating engine

Implement rate-card schemas/effective versions, unit conversions, included/free allowances, rounding, estimates, prospective price changes, corrections, deterministic fixtures, and customer catalog projection.

Exit: the same pinned usage/rate inputs always produce the same rated output.

### RW-1203 — Double-entry credit ledger and grants

Implement `BillingAccount`, exactly one authoritative shared wallet per account, balanced transactions, paid/promotional/bonus/adjustment/refund grants, leased-credit accounts, priorities/expiry/applicability, balance projections, rebuild/reconciliation, constraints, and audit.

Exit: property tests prove value conservation and no mutation of posted entries.

### RW-1204 — World credit leases and local admission

Implement Management `WorldCreditLeasePort`, atomic Redis lease issue/renew/revoke/reconcile, wallet and entitlement epochs, bounded sponsorship envelopes, Runtime `LocalCreditAdmissionPort`, atomic WorldDO-local reserve/capture/release, usage/capture/release receipts, category/depth/expiry inheritance, durable PostgreSQL accounting intents, abandoned-run reconciliation, insufficient funds, bounded partition exposure, execution-mode transitions, and UI receipts.

Exit: concurrent worlds and actor turns cannot overspend beyond the shared wallet's outstanding leases or strand balance; Runtime performs no per-turn Management/Redis/Stripe call.

### RW-1205 — Stripe customer, Checkout, and payment webhooks

Implement Management-only billing-account/customer mapping, at most one provider customer per billing account/environment, one-time purchases, hosted payment flow, webhook signatures/idempotency/order, payment success→grant, failures, Tax/receipt seams, provider reconciliation, and secrets. Create no per-world provider customer/subscription/meter.

Exit: exactly one paid grant follows one successful settled purchase.

### RW-1206 — Automatic recharge and notifications

Implement threshold/amount/monthly ceiling, saved-method consent, serialized trigger, duplicate-charge prevention, success/failure transitions, low-balance notifications, revoke, and abuse/risk controls.

Exit: simultaneous balance crossings produce at most one intended recharge.

### RW-1207 — Refund, dispute, chargeback, and adjustment lifecycle

Implement eligible-balance calculation seam, refund/reversal entries, bonus treatment, disputes, negative/suspense state, suspension/grace, support/admin UI, reconciliation, and legal-policy configuration.

Exit: every provider money reversal has balanced internal disposition without deleting usage.

### RW-1208 — Billing, usage, budget, and credit UX

Implement wallet/usage statements, paid/promo/expiry, purchases, receipts, estimates, auto-recharge, budgets/alerts, rate disclosures, blocked-operation UX, exports, accessibility, and support links.

Exit: moderated users can predict, monitor, limit, and explain their credit burn.

### RW-1209 — Hybrid plan seam and commercial policy gates

Implement plan-entitlement/recurring-grant contracts behind disabled feature flags, pricing experiments, legal/tax/accounting launch checklist, geographic/product availability, terms versioning, and no-unlimited-use invariant.

Exit: future membership can add fixed value without replacing or corrupting the credit ledger.

### RW-1210 — Billing qualification and reconciliation

Run shared-wallet/multiworld lease concurrency, Runtime-local admission, Redis failover/rebuild, PostgreSQL/Runtime-receipt reconciliation, duplicate/out-of-order webhook, Stripe outage, meter/rating correction, auto-recharge, refund/dispute, cross-tenant, zero-balance/nonpayment execution modes, tax/test-clock, load, statement, and clean-environment suites.

Exit: publish Wave 12 qualification manifest and satisfy the outcome before real-money launch.

---

## 18. Dependency graph and bounded execution

```text
RW-1201 ─ RW-1202 ─┬─ RW-1203 ─ RW-1204 ──────────┐
                    ├─ RW-1205 ─ RW-1206 ─ RW-1207 ┤
                    └─ RW-1208 ─ RW-1209 ──────────┼─ RW-1210
```

Safe lanes: Runtime usage/lease receipts; Management metering/rating; shared-wallet ledger/allocator; Stripe adapter/fixtures; UX; legal/accounting policy configuration. Freeze usage, rated-event, ledger, grant, world-lease, execution-entitlement, local-reservation, and provider-mapping contracts before dependent work.

---

## 19. Test and qualification strategy

```text
pnpm test:usage
pnpm test:rating
pnpm test:credits
pnpm test:wallet:redis
pnpm test:wallet:rebuild
pnpm test:world-credit-leases
pnpm test:runtime:local-admission
pnpm test:billing:property
pnpm test:stripe-webhooks
pnpm test:billing:reconciliation
pnpm test:e2e:billing
pnpm test:security:billing
pnpm test:load:billing
pnpm qualify:wave12:staging
```

Required scenarios:

- duplicated/reordered/corrected raw usage;
- provider charge received after run finalization;
- two worlds concurrently lease the last shared-wallet credits and cannot exceed the global balance;
- two actor turns concurrently reserve the last credits inside one world lease;
- Redis restart/eviction/failover before and after lease issue, renew, revoke and reconciliation;
- PostgreSQL ledger capture commits but Runtime/Redis finalization response is lost, plus lease-issue/renew response loss after commit;
- clean Redis rebuild from PostgreSQL ledger/leases and clean Runtime-local counter rebuild from lease/run/receipt evidence;
- run fails before/after provider usage and capture;
- local reservation or world lease expires while a Workflow is legitimately waiting;
- Management is partitioned while Runtime consumes only the bounded remainder of a valid lease;
- entitlement epoch advances during an actor turn and prevents new local reservations under the stale lease;
- payment succeeds but webhook is delayed/duplicated;
- return page lies/fails while webhook is canonical;
- simultaneous auto-recharge threshold crossings;
- auto-recharge succeeds, fails, requires action, or is disputed;
- promotional credit expires while paid credit remains;
- refund with partially consumed paid grant and bonus grant;
- chargeback after credits consumed;
- Stripe and the configured authentication provider unavailable independently;
- one Stripe customer/billing account funds multiple worlds without per-world provider subscriptions/meters;
- visitor-authored action sponsored by host, visitor, shared pool, explicit grant, platform, and denial policies;
- autonomous and triggered action trees retain Wave 11 responsibility labels while being sponsored separately;
- causal child within and beyond sponsorship category/depth/expiry/credit caps;
- premium visitor request under initiator-pay, host-pay, explicit-grant, platform, and deny policies;
- world-local object use never charges its owner implicitly;
- tenant ID/provider customer mapping attack;
- rate change while long-running job is active;
- empty shared wallet stops new leases and each world applies its configured restricted/frozen mode;
- nonpayment freezes time at a journal boundary, preserves history/export, and resumes without unbounded catch-up;
- statement/reconciliation rebuild from immutable ledgers;
- clean Stripe test-mode environment reproduces and tears down flow.

---

## 20. Security, privacy, and observability

Zero tolerance:

- credits granted without confirmed authorized payment/policy;
- unbalanced or mutable ledger entry;
- double debit or double grant from retry;
- one tenant charged for another’s usage;
- payer/sponsor confused with author, actor, owner, possessor, or beneficiary;
- client-authored usage or balance;
- money, price paid, invoice, payment method, provider customer/subscription, tax, refund or dispute state entering Runtime contracts/storage/logs;
- payment method/card data entering Clockgrove stores/logs;
- leaked Stripe secrets/webhook payload PII;
- preview/replay generating billable external effects without declared policy;
- billing suspension deleting or rewriting world history.

Measure raw/rated event lag and coverage, provider cost versus rated credits, reservations/capture/release/age, balances/grant composition, low/depleted accounts, purchases/success/failure, auto-recharge, refunds/disputes, reconciliation drift, cost/gross-margin bands, credits per experience unit, denials/downgrades, support cases, and fraud signals using protected billing telemetry.

---

## 21. Explicit non-goals

Wave 12 does not implement:

- transferable currency, cash redemption, creator payouts, or a marketplace economy;
- unlimited flat-rate model/tool/simulation usage;
- postpaid debt for ordinary self-serve users;
- Stripe as world, usage, rating, or admission authority;
- per-world Stripe customers, subscriptions or authoritative meters solely to separate world usage;
- a mirrored global wallet balance inside Runtime;
- Redis as canonical accounting or world authority;
- final price points before measured cost and willingness-to-pay evidence;
- enterprise contracts, net terms, procurement, or custom invoices at launch;
- cryptocurrency, tokens on-chain, or user-to-user credit transfer;
- hiding rates behind an intentionally confusing virtual exchange;
- automatic deletion of worlds after payment failure.

---

## 22. Exit evidence checklist

- [ ] RW-1201 through RW-1210 are merged.
- [ ] Raw usage is immutable, idempotent, attributed, and evidence-linked.
- [ ] Every billable event retains its Wave 11 action and causal root, and every sponsorship decision is separate, versioned, and explainable.
- [ ] Rating is deterministic, versioned, prospective, and customer-explainable.
- [ ] Double-entry credit ledger conserves value under property/concurrency tests.
- [ ] Paid/promotional/bonus/refund grants remain distinguishable.
- [ ] One authoritative wallet per billing account funds many worlds through bounded leases.
- [ ] Redis lease issue/renew/revoke/reconcile operations are atomic, idempotent, epoch-fenced, and fail closed.
- [ ] Runtime-local reservations prevent accidental overage debt without per-turn Management/Redis/Stripe calls.
- [ ] PostgreSQL ledger/lease evidence rebuilds Redis, and lease/run/receipt evidence rebuilds Runtime-local counters.
- [ ] Sponsorship envelopes bound inherited causal spend by category, depth, expiry, and maximum credits.
- [ ] One successful Stripe payment releases exactly one credit grant.
- [ ] Auto-recharge is consented, bounded, serialized, and duplicate-safe.
- [ ] Refund/dispute/chargeback handling uses balanced reversal/adjustment entries.
- [ ] Zero-balance behavior preserves identity/world/history and clearly gates costly work.
- [ ] Nonpayment can freeze world time without exposing commercial details to Runtime or creating unbounded catch-up debt.
- [ ] All Stripe/customer/money integration is Management-only; worlds require no provider billing objects.
- [ ] Cross-tenant billing/customer/usage isolation passes.
- [ ] Tax, accounting, legal, consumer-disclosure, geography, refund, and expiration gates are approved before live money.
- [ ] Billing UI explains balance, burn, estimates, budgets, rates, grants, and transactions.
- [ ] Local/OSS operation remains payment-free and provider-independent.
- [ ] Stripe outage cannot corrupt world state or already-funded internal balance.
- [ ] Redis outage stops new leases; valid outstanding leases remain bounded and accounting/world history stay correct.

The manifest records commit, schema/rate/policy/terms/provider API versions, usage-coverage and rating goldens, ledger property/concurrency results, Stripe test-clock/webhook/reconciliation evidence, auto-recharge/refund/dispute results, cross-tenant/security suite, statements/UI/accessibility findings, legal/accounting gate status, load/cost/margin analysis, and launch decision.

---

## 23. Current primary references

- Stripe meter events: https://docs.stripe.com/api/billing/meter-event
- Stripe Billing credit grants: https://docs.stripe.com/api/billing/credit-grant/create
- Stripe billing for LLM tokens and hybrid/credit-pack models: https://docs.stripe.com/billing/token-billing
- Stripe Checkout: https://docs.stripe.com/api/checkout/sessions/create
