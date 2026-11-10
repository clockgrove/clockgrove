# Clockgrove Wave 5: Durable Conversations, Actor Harness, Models, Capabilities, and MCP

**Status:** Coding-agent implementation specification  
**Version:** 1.10
**Date:** November 09, 2026
**Parent plan:** `clockgrove-cloudflare-implementation-plan.md` v3.10  
**Product source:** `clockgrove-prd-v0.5.md` v0.5.9  
**Wave:** 5 of 13  
**Assumptions:** Waves 0–4 are qualified; web projection and ActorAgentDO seams are stable  
**Development tooling:** external tools such as `clockgrove/factory` may execute this wave; their cognition, sessions, and state are separate from world/runtime cognition and authority.  

---

## 1. Outcome

Wave 5 implements the durable cognitive execution plane: independent conversation sessions, recoverable actor turns, bounded proactive wakeups, model routing, authorized context assembly, typed capabilities, governed MCP, replay-safe effect intents, streaming UI, and complete run evidence.

The wave exits only when:

> A user can maintain multiple durable conversations with Stevie or an explicitly interpreted object, survive provider/runtime failures, invoke governed internal and MCP capabilities, receive a grounded response, and trace every proposal and committed consequence—without model text becoming canonical world truth.

The actor harness is project-owned and inspired by persistent assistant runtimes: a cognitive actor has durable identity, policy, sessions, goals, subscriptions, schedules, skills, budgets, and evidence; each agent run is an ephemeral, recoverable activation.

An ephemeral run is not a lifetime limit on the actor. Wave 5 defines the `ActorProcess` extension contract: a stable process may own a long-lived objective, event/subscription cursors, checkpoint, lease epoch, budget policy, and a sequence of bounded run segments. Initial actors use reactive/scheduled processes. A later process may be continuously eligible or promoted to dedicated compute, including a long-lived provider session where supported, while preserving actor/process identity, authority, attribution, checkpoint, and recovery semantics.

Conversation and tool runs consume the Wave 0–2 `AttributionEnvelope`. A human message attributes initiation to the participant's world persona and execution to the addressed actor or interpreted system. Actor-to-actor, scheduler, rule, and tool activations preserve the same causal root while recording their immediate cause. A model or MCP server may propose an action but may never invent or broaden attribution or authority.

---

### 1.1 Objectives, sequencing, and checkpoints

This wave is a substantial workstream containing numerous Objectives and Work Items. The accepted [incremental-delivery ADR](../adr/clockgrove-adr-incremental-wave-delivery-and-evidence.md) governs capability scope, readiness, comparison rules, and proportionate qualification. The complete exit checklist below remains authoritative for full-wave qualification.

First deliver one durable, private, attributed Caretaker conversation with authorized perception/context, one bounded real model route, a typed proposal through the ordinary command validator/Journal, grounded Why/run evidence, and recovery. Predeclare the conversation-usefulness and disclosure rubric; scripted models remain deterministic test fixtures.

Then broaden independent sessions/channels, subscriptions/proactive wakes, governed read-only MCP research, installation/OAuth/schema/revocation, approval-gated effects, and broader failure/budget scenarios. Each callable feature must be fully authorized and safe before exposure; broader breadth can wait for its own Objective.

Establish governed versioned Markdown cognitive documents and atomic write classes/change sets here, backed by private canonical cognition and reconstructible runtime caches. Wave 6 owns actor-authored learned skills and the bounded policy compiler/evaluator. Do not make every model turn depend on future vector indexes or broad ingestion.

---

## 2. Entry conditions

These are the full-wave/default entry conditions. A named local-development Objective may consume only accepted prerequisite capabilities under the ADR's recorded readiness exception; its Issue must preserve pending qualification obligations and the selected path's mandatory safety evidence.

- Wave 4 qualification manifest is green.
- ActorAgentDO initialization, logical session routing, perception inbox, capability revision hook, and recovery metadata are stable.
- React entity rail and conversation region consume versioned placeholder contracts.
- Journal supports private cognitive streams, effect intents, dispatch, protected evidence, optimistic revision, and replay.
- Queue channels and Workflow/fiber evidence are qualified.
- R2 protected-artifact access, AI Gateway binding, one production model credential, and scripted model fixture exist.
- No production model or tool is needed for routine simulation continuity.

Amended (2026-11-07, issue 16): the "AI Gateway binding" is Vercel AI Gateway with the provisioned `AI_GATEWAY_API_KEY`, and the "one production model credential" is satisfied by it or by `ANTHROPIC_API_KEY` for Anthropic direct. Cloudflare AI Gateway is not required (owner decision).

Amended (2026-10-19): effect intents are built in this wave, not inherited from Wave 2. Wave 2 delivers dispatch intents, and its preview gate refuses `external-effects` dispatch rows on non-live timelines; effect intents keep that guarantee.

Amended (2026-10-19): Wave 3 does not deliver the `ActorAgentDO` foundation or the `external-effects` channel. This wave builds them, as their first consumer: RW-0307 (initialization, session routing, perception inbox, capability revision hook, recovery metadata) with the Agents SDK pin, and `external-effects` with its fake adapters on Wave 3's generic Queue path.

---

## 3. Non-negotiable cognition boundaries

1. The LLM can propose speech, memories, plans, tool calls, and world commands; it cannot commit physical truth.
2. Every behavior-affecting result becomes a typed canonical cognitive or physical event through Journal.
3. Raw prompts, transcripts, model payloads, and tool artifacts are protected evidence with retention policy, not universal context.
4. A session is a durable transcript/execution scope; it is not the actor’s memory or identity.
5. ActorAgentDO and local SQLite contain reconstructible execution/runtime state only.
6. All context retrieval and capabilities are authorization-first.
7. External effects use intent, outbox, idempotency, policy, and recorded disposition.
8. Historical replay never resends an external effect.
9. Preview timelines block or simulate effects by default.
10. Model unavailability degrades cognition; it does not stop the living world.

---

## 4. Owned code and configuration

```text
apps/runtime/src/durable-objects/actor-agent/
apps/runtime/src/cognition/
apps/runtime/src/model-gateway/
apps/runtime/src/capabilities/
apps/runtime/src/mcp/
apps/runtime/src/channels/
apps/runtime/src/effects/
apps/web/src/conversations/
apps/web/src/runs/
apps/web/src/approvals/
apps/web/src/capabilities/
packages/contracts/src/conversations/
packages/contracts/src/runs/
packages/contracts/src/models/
packages/contracts/src/capabilities/
packages/contracts/src/mcp/
packages/contracts/src/channels/
packages/application/src/conversations/
packages/application/src/cognition/
packages/application/src/capabilities/
packages/application/src/effects/
packages/cognition/
packages/model-gateway/
packages/mcp/
packages/testkit/src/models/
packages/testkit/src/mcp/
packages/testkit/src/channels/
tests/evals/cognition/
tests/security/mcp/
docs/protocols/{actor-harness,conversation-fibers,capabilities,mcp,channels}.md
```

Provider SDK types remain inside adapters. Domain/application packages depend on project ports and Zod contracts.

---

## 5. Actor policy and harness

### 5.1 Durable actor policy

Each cognitive/interpreted subject resolves a versioned policy containing:

- identity/archetype and voice mode;
- goals, current commitments, boundaries, and allowed initiative;
- context-scope ceiling and privacy policy;
- model alias and escalation/fallback routes;
- tool/capability bindings and approvals;
- per-turn, daily, and world budgets;
- session, concurrency, and retention policy;
- event subscriptions, scheduled intentions, threshold wakes, and optional heartbeat;
- compiled-policy references and governed adoption hooks; Wave 6 implements bounded learned-policy compilation and evaluation;
- proactive-delivery permissions and quiet-hour defaults;
- prompt/template/policy versions.

Policy is protected configuration loaded through application authorization. Retrieved content cannot alter it.

Amended (2026-11-07): under the [actor decision ladder](../adr/clockgrove-adr-actor-decision-ladder.md), actor policy also declares decision points as pack data: the trigger (score margin, policy-declared ambiguity or a gate such as wake triage), the candidate source (always the kernel's valid candidates), the features shown, the model alias, a confidence threshold, a budget and a deterministic fallback. A decision point sits between compiled policy and model escalation, so the "policy checks and compiled routines run before model escalation" order of §5.2 still holds. Its answer is cognitive evidence; it proposes and never commits. The first decision point runs in shadow mode (issue 92).

### 5.2 Activation reasons

```ts
type ActivationReason =
  | { kind: "direct_message"; sessionId: SessionId; messageId: MessageId }
  | { kind: "perception"; perceptionId: PerceptionId }
  | { kind: "scheduled_intention"; scheduleId: ScheduleId }
  | { kind: "subscription"; subscriptionId: SubscriptionId; eventId: EventId }
  | { kind: "threshold"; conditionId: string }
  | { kind: "heartbeat"; heartbeatId: string }
  | { kind: "tool_completed"; effectId: EffectId }
  | { kind: "operator"; commandId: CommandId };
```

Wakeups are deduplicated, coalesced, prioritized, and budgeted. A heartbeat is an optional opportunity, not a guaranteed LLM turn. Policy checks and compiled routines run before model escalation. No-op wakes are recorded cheaply and suppressed.

Amended (owner decision, 2026-11-09; issue 111): wake triage runs in shadow mode after those checks,
for every wake that reaches model escalation, including direct messages. Through the existing
`decide` port it chooses `suppress`, `compiled_routine`, `full_turn` or the explicit abstention
`cant_tell`; the full turn still follows today's path. Disabling triage, removing the gateway key,
abstention, low confidence, an exhausted per-world simulated-day budget or a model error cannot
suppress that turn. Each result is journaled as cognitive evidence and replay never calls the model.
**Any later enforcing mode will never suppress a person's direct message.** Shadow reports mark
those wakes apart, including any proposed suppression. No enforcement is enabled by this amendment.

The report compares each shadow answer with deterministic turn records: proposed commands,
output messages and final dispositions. It shows counts, labels, confidence, latency and cost per
activation reason; agreement and counterfactual savings; and misses where `suppress` or
`compiled_routine` accompanied a material command or reply to a person. Abstentions and low
confidence remain separate. Signatures include the activation reason, actor, suppression cause,
and policy/model versions; repeated misses or low-confidence signatures are flagged for human
review. See the [wake-triage contract](../protocols/decision-shadow.md#wake-triage) and
[runtime report procedure](../runbooks/runtime.md#wake-triage-shadow-report).

### 5.3 Actor workspace abstraction

Expose versioned logical resources, not an uncontrolled filesystem:

```text
identity
policy
goals
active plans and commitments
heartbeat/subscriptions
session summaries
working context
skills and compiled policies
memory/relationship ports (Wave 6)
run evidence
```

Implement logical Markdown documents with stable IDs, immutable versions, source hashes, and protected/governed/actor-writable path classes. Atomic create/patch/archive change sets validate expected versions, authority, write class, size limits and provenance before canonical commit. Context manifests cite exact document versions; an arbitrary model-returned path cannot select a privileged write target. Inspector and retention policy must preserve authorized access without turning private cognition into scene state.

Wave 5 owns this document/governance foundation in RW-0505 and write capabilities in RW-0506. Wave 6 extends it with actor-authored `SKILL.md`, workspace health, bounded policy artifacts/bindings/evaluations and invalidation.

Do not instantiate an OpenClaw daemon or repository per actor. The structure is a durable domain abstraction backed by PostgreSQL/R2 and activated inside ActorAgentDO.

---

## 6. Conversation domain

### 6.1 Session identity

A session is scoped by world, timeline, subject, participant set, channel surface, external-thread reference when present, privacy boundary, voice mode, and retention policy.

Required states:

```text
active | archived | locked | deleted
```

Sessions retain independent ordered transcripts. A user can create, title, list, switch, archive, and resume sessions. Actor memory extraction later may cross sessions only through attributed canonical events and authorization.

### 6.2 Messages and turns

Messages are immutable user/actor/system artifacts with source, channel, content parts, media references, privacy, moderation disposition, and created world/wall time. Edits create revisions or supersession; they never rewrite evidence invisibly.

Turns declare input message, actor policy/model version, grounded world revision, context manifest, run, stream state, cancellation, output message, proposed commands/effects, final disposition, and cost.

Decision (Kirk, 2026-11-09, issue 162): moderation and prompt-injection judging run in shadow mode through the configured decision-model tier for inbound messages. The message carries its explicitly marked shadow judgement (`allow`, `flag` or `block`, plus the injection judgement), confidence and model/policy evidence. It does not replace the delivered message or alter the actor turn. Disabled judging, missing credentials and model failure preserve today's delivery and execution. A false `block` remains visible as evidence; any later enforcing mode must make it reversible through an attributed correction or supersession, never an invisible rewrite of the original judgement. Enforcement awaits owner review of the measurements. Tool-result screening waits for MCP execution and is outside issue 162. See the [moderation shadow contract](../protocols/decision-shadow.md#moderation-and-prompt-injection) and [report procedure](../runbooks/runtime.md#moderation-shadow-report).

### 6.3 Voice disclosure

- Cognitive: answer is the actor’s subjective communication.
- Interpreted: answer is a narrated interpretation of modeled state; object is not sentient.
- Canonical/operator: answer is an authorized explanation from world evidence.

The UI labels the mode at session creation and on each answer where ambiguity exists.

### 6.4 Caretaker communication semantics

The selected-actor **Talk** action opens a private, attributed Caretaker-to-actor session. The actor may perceive and later remember it according to cognition, privacy, and retention policy, but it is not spatial audio, a public utterance, telepathy, or a world-state mutation. Nearby actors do not receive it merely because they share a space.

Public in-world speech is a separate typed action with spatial audience and acoustics. **Influence** proposes an intent; gifts and physical interactions submit governed world commands; operator/authoring actions use separate authority modes. Each path has its own authorization, attribution, audit, and UI disclosure.

---

## 7. Recoverable turn fiber

### 7.1 State machine

```text
accepted
  → context_pending
  → context_ready
  → model_running
  ↔ tool_waiting / approval_waiting
  → proposal_validating
  → committing
  → finalizing
  → completed

terminal: rejected | cancelled | failed | abandoned
```

Every phase has a durable checkpoint and idempotency key. Streams are disposable presentation; committed messages, run steps, commands, effects, and status are durable.

### 7.2 Recovery

On activation/restart:

1. resolve session and turn canonical state;
2. reconcile current/abandoned provider attempt;
3. inspect command/effect receipts before retry;
4. resume from the first incomplete safe phase;
5. never duplicate an acknowledged message, world command, or external effect;
6. mark uncertain provider/tool results explicitly;
7. notify the UI through current state rather than replaying arbitrary tokens.

Concurrent turns are ordered within a session. Separate sessions may run concurrently subject to actor/world budgets. Cognitive commits use expected revisions and typed stale-state resolution.

---

## 8. Run and step evidence

`AgentRun` records actor/session/turn/activation, parent run, policy/model/prompt versions, input revision, status, start/end, budgets, usage, cost, safe summary, and protected artifact references.

`RunStep` records ordered type and status for context retrieval, model attempt, tool proposal, approval, tool execution, world-command proposal, validation, commit, and delivery.

Protected artifacts store exact inputs/outputs only under retention and access policy. Search indexes safe metadata and summaries, never secrets or raw private text by default.

Inspector traversals:

- message → turn → run → steps;
- run → context sources and exclusions;
- tool call → grant/approval/effect/result;
- proposal → command validation → committed/rejected events;
- output claim → cited world or session evidence;
- activation → cause and scheduled next wake.

---

## 9. Authorized context assembly

Wave 5 assembles context from current session history, actor public/private policy, current physical state, permitted recent perceptions, relationship/space/world summaries available before Wave 6, active goals/plans, capability catalog, and selected event/inspection evidence.

The context manifest records every candidate source, scope, authorization decision, selected span/artifact hash, token estimate, ordering, truncation, and grounded revision.

Rules:

- authorization precedes text/vector ranking;
- untrusted content is labeled and cannot change policy;
- private scopes never enter shared sessions unless an explicit rule permits them;
- all world facts used to propose actions carry revision/evidence references;
- token/cost budgets are reserved before model execution;
- context assembly is reproducible with the scripted provider fixture.

---

## 10. ModelGateway

Use Vercel AI SDK behind a project-owned port, with Vercel AI Gateway as the production routing layer and Anthropic direct as the same-model fallback route.

```ts
interface ModelGateway {
  stream(request: ModelRequest, signal?: AbortSignal, onText?: (delta: string) => void): Promise<ModelOutcome<string>>;
  generateObject<T>(request: StructuredModelRequest<T>, signal?: AbortSignal): Promise<ModelOutcome<T>>;
  inspect(alias: string): ModelRouteStatus;
}
```

Aliases, not provider/model strings, appear in actor policies. Alias resolution pins provider, model, settings, structured-output schema, timeout, retry, max tokens, cost ceiling, and fallback.

Providers:

- deterministic scripted provider for CI/evals;
- one production text/structured-output alias;
- explicit unavailable/timeout/rate-limit/safety responses;
- no silent switch that changes policy/eval identity.

Record attempt identity, latency, tokens, cost, finish reason, cache/gateway metadata, and protected payload hashes.

Amended (2026-11-07, issue 16): owner decision: the production alias uses the provider keys already provisioned, Anthropic directly or Vercel AI Gateway; Cloudflare AI Gateway is not required, and a gateway is the expected routing layer for generation models (#27). One AI SDK adapter (`packages/model-gateway/src/ai-sdk.ts`) serves both: `stevie.conversation` routes first to Vercel AI Gateway `anthropic/claude-opus-5.5` and falls back to Anthropic direct `claude-opus-5-5`, the same model, so policy and eval identity do not change; the fallback is recorded in the per-call accounting record. Credentials are references (`AI_GATEWAY_API_KEY`, `ANTHROPIC_API_KEY`) resolved only inside the adapter. The opt-in real-route check `CLOCKGROVE_MODEL_LIVE=1 pnpm --filter @clockgrove/model-gateway test:live` never runs in CI by default; a manual `workflow_dispatch` qualification run using a repository secret is pending owner wiring (a `.github/` change). See the [model gateway contract](../../packages/model-gateway/docs/model-gateway.md).

Amended (2026-11-07): under the [actor decision ladder](../adr/clockgrove-adr-actor-decision-ladder.md), `ModelGateway` gains `decide`: a bounded Choice, Score or Boolean request over options the caller supplies, for example through Vercel AI Gateway's decisions endpoint. Its alias is configuration like every other alias, a scripted decider serves CI and evals, and every call records the alias, model, latency, cost, label and confidence. An unavailable, timed-out or over-budget call returns an explicit outcome so the decision point takes its deterministic fallback. `stream`, `generateObject` and `inspect` are unchanged.

---

## 11. Capabilities and internal tools

### 11.1 Unified registry

A capability has stable ID/version, source, kind, input/output schema, effect class, scopes, authorization function, approval policy, idempotency semantics, timeout/size budget, credential reference, and revocation state.

Initial internal capabilities:

- inspect perceived/current object state;
- query authorized event/Why evidence;
- list visible entities and routes;
- speak or send a session response;
- propose a typed world command;
- create/revoke event subscription;
- schedule/cancel a future intention;
- request proactive delivery into the fake sink;
- inspect current goals/budgets/run state.

Every world command is reauthorized and kernel-validated independently of model claims.

Amended (2026-11-09, issue 164, owner decisions): remote tools enter this same registry as
**disabled** candidates. The unreviewed effect class is `external-write`; provider annotations and
descriptions cannot lower it. Review assigns `read`, `world-write`, `external-write`, `destructive`,
`network` or `cost`. Resources remain disabled candidates until Wave 6 ingestion; provider prompts
never become system or actor policy. One installation has many scoped bindings, resolved by
most-specific deny, then grants, then the session approval overlay. Installation authority is a new,
separate installation grant held by world owners by default, never actor/model authority. These
are the required integration contract; the [MCP foundation](../protocols/mcp.md) does not yet add
remote candidates to the running registry.

### 11.2 Grants and approvals

Bindings connect capability to tenant/world/timeline/actor/session scope. Grants can narrow input fields, destinations, call counts, effect class, budget, and expiry. Approval records bind exact normalized arguments, scope, effect hash, principal, and expiry. Argument changes require new approval.

### 11.3 Guide and counterfactual consumers

Field-guide read/share in Wave 6 consumes these governed document, capability, context and channel boundaries. Its destination audience, permitted source disclosure and exact version must be validated independently of an actor's source read access. Guide text remains untrusted contextual testimony, not a new instruction hierarchy. Actual guide synthesis/sharing behavior and qualification belong to Wave 6; counterfactual preview execution belongs to Wave 7. See the [accepted topic ADR](../adr/clockgrove-adr-field-guides-and-counterfactual-why.md).

---

## 12. MCP lifecycle and execution

### 12.1 Installation

Support remote HTTP MCP only in this wave. Installation validates URL/network policy, discovers tools/resources/prompts, records server identity and protocol metadata, classifies effects, captures schema hashes, binds credential reference, and requires explicit enablement/grants.

Schema drift disables affected capability versions until reviewed. Revocation stops new calls immediately and reconciles in-flight attempts.

Amended (2026-11-09, issue 164, owner decisions): support the full OAuth connect flow and static
tokens, with one credential per installation owned by the installing operator. Use a separate,
versioned credential keyring, never `ARTIFACT_KEYRING`; plaintext stays outside canonical events
and evidence in the isolated secret provider. Uncertain refresh/revocation fails closed. Check
schema drift at each connection listing and operator refresh, not on a schedule. Production has
no loopback allowance; fixtures use a test-only network port. Before Cloudflare composition, verify
DNS answers and the platform's private-egress behavior, documenting residual rebinding risk;
use pinned egress if that leaves a real hole. The transport and credential foundation and its
remaining integration work are described in the [installation protocol](../protocols/mcp.md).
Amended (2026-11-09, issue 164, part 2): the isolated PostgreSQL secret adapter uses a dedicated
non-login role and forced installation/owner RLS. Provider-session takeover fences old references
and requires reconnect, preserving fail-closed uncertainty without granting ordinary runtime
access. It remains uncomposed; canonical installation and operator OAuth composition are pending.
Canonical records, scoped grants, runtime revision invalidation and the operator browser journey
remain required before the installation outcome can be accepted.
Amended (2026-11-09, issue 164, part 3): an internal PostgreSQL governance service records
installation snapshots, reviewed tool hashes, drift and terminal revocation through attributed
Journal events under the separate owner-defaulted `runtime:mcp-install` grant. This is not
production installation composition or callable actor access. Authenticated HTTP/OAuth,
dynamic registry versions, scoped bindings, revision invalidation and the browser journey
remain required.

### 12.2 Execution

1. resolve installation/binding/grant;
2. validate normalized arguments;
3. apply network/SSRF/redirect/DNS/content limits;
4. reserve call/time/output/cost budget;
5. require approval for protected effect classes;
6. create effect intent and idempotency key;
7. execute through the external-effects channel;
8. persist result or explicit uncertainty;
9. validate/sanitize result before model inclusion;
10. emit safe run evidence and citations.

Initial fixtures:

- one deterministic read-only remote MCP server;
- one approval-gated external-write fixture with crash/uncertain-result simulation;
- malicious schema, prompt injection, oversized response, redirect, SSRF, and DNS-rebinding fixtures.

### 12.3 First-party world MCP

Expose a stateless authenticated MCP surface over application APIs for world/timeline list, authorized search/inspection, command submission, run receipt, and changeset placeholders. It does not host actor memory or session state inside the MCP connection.

---

## 13. Channel-neutral session and delivery contracts

Wave 5 freezes the evergreen portal boundary while implementing browser and deterministic fake adapters only.

Normalized inbound data includes provider/source identity assertions, resolved Clockgrove principal, world/timeline/actor, participant set, channel/thread, privacy policy, content parts/media refs, reply metadata, authority mode, and idempotency key.

`DeliveryRequested` includes actor/session/recipient, channel binding, reason event/goal/promise/subscription, urgency, content artifact, privacy classification, consent/policy version, dedupe key, quiet-hour behavior, and budget reservation.

Delivery policy may approve, delay, deduplicate, downgrade, or reject. Actors never call a provider directly. Replay records historical delivery but never sends again. Preview timelines use an isolated sink.

Browser chat is the production surface in this wave. CLI and fake adapters prove the contract. Slack/Discord/email/messaging/voice providers remain later adapters, not alternate minds.

Channel adapters preserve the semantic action selected at ingress. A private Caretaker Talk message cannot silently become public speech, and a public Say action cannot silently become a private session message.

---


## 14. Web experience

Replace the Wave 4 placeholder with:

- session selector, new session, title/archive controls;
- mode disclosure and participant/privacy summary;
- durable message history with pagination;
- durable user-visible turn states: queued, thinking, using tool, awaiting approval, delayed, model unavailable, budget blocked, recovered, completed, cancelled, and failed;
- tool progress, argument preview where allowed, approval/deny UI;
- cancel and stale-world handling;
- citations/Why links into the causal inspector;
- run status drawer for developer/operator roles;
- budget/provider degradation that does not masquerade as actor behavior;
- cross-space continuation without losing the actor/session identity.

The scene remains usable while a turn runs. Tokens do not directly animate or mutate the world.

---

## 15. Detailed work packets

### RW-0501 — Conversation domain and API

Implement session scope, participant/privacy/channel metadata, private Caretaker Talk versus public Say discriminants, messages, turns, titles, archive/delete/retention, ordering, multiple independent histories, HTTP APIs, OpenAPI, RLS, and UI integration.

Exit: two sessions with Stevie remain independent across browser restart and ActorAgentDO eviction.

Amended (2026-10-27): RW-0501 inherits from Wave 1 (Wave 1 §5.2) the registration of the Conversation mode component, whose first consumer is the session's voice mode (§6.1, §6.3).

### RW-0502 — Run and step evidence

Implement run/step state machines, parent-child linkage, protected artifacts, safe metadata search, inspector APIs, retention hooks, and causal traversal.

Exit: every model/tool/command attempt has one inspectable durable disposition.

### RW-0503 — Recoverable turn fibers and proactive activation

Implement phase checkpoints, per-session ordering, cross-session concurrency, streaming, cancellation, recovery, abandoned attempts, activation coalescing, schedules/subscriptions/optional heartbeats, no-op suppression, next-wake evidence, and the `ActorProcess` contract with a multi-segment long-objective fixture.

Exit: crashes at every phase and duplicate wakeups cannot duplicate a message, command, or effect.

### RW-0504 — ModelGateway

Implement AI SDK port/adapters, Vercel AI Gateway routing with an Anthropic direct fallback route, aliases, structured output, scripted provider, one production alias, breakers, accounting, policy/fallback visibility, and fault fixtures.

Exit: deterministic provider passes CI and production-provider failures yield explicit recoverable states.

Amended (2026-11-07, issue 16): routing, credentials and live-check policy are as in §10; Cloudflare AI Gateway is not required.

### RW-0505 — Authorized context assembly

Implement governed versioned Markdown documents and atomic write-class change sets as in Section 5.3, scope candidates, authorization-first selection, context manifests, revision capture, token ordering/truncation, untrusted labels, citations, cache invalidation, and reproducibility tests.

Exit: a response can show what context was included and why every excluded private source stayed out.

### RW-0506 — Capability registry and internal tools

Implement registry, schemas, installation/binding/grants, approvals, budgets, revocation, inspect/Why/world-command/subscription/schedule/delivery and governed cognitive-document write capabilities, and UI.

Exit: model proposals cannot exceed grants and every accepted world command passes ordinary Journal validation.

### RW-0507 — MCP installation lifecycle

Implement remote HTTP discovery, OAuth/token credential references where required, classification, schema pinning/drift, enable/disable/revoke, network policy, and operator UI.

Exit: malicious/unreviewed/schema-drifted servers expose no callable capability.

### RW-0508 — MCP execution and effects

Implement validation, effect intent/outbox, idempotency, approvals, uncertainty, retries, preview/replay policy, result sanitization, evidence, fixtures, and kill switch.

Exit: read fixture is reliable; write fixture never duplicates and surfaces uncertainty safely.

### RW-0509 — First-party world MCP and channel contracts

Implement stateless MCP endpoint, normalized inbound/delivery envelopes, semantic-action preservation across browser/CLI/fake channel adapters, identity/session resolution seams, consent/quiet-hour/dedupe policy, and isolated preview sink.

Exit: the same actor/session can be addressed through browser and fake adapter without cloned identity or transcript leakage.

### RW-0510 — Conversation, harness, and MCP qualification

Run concurrent sessions, stale revisions, provider/tool interruption, prompt/schema/SSRF attacks, approvals, revocation, heartbeat/coalescing, budgets, delivery replay, and staging provider tests.

Exit: publish Wave 5 qualification manifest and satisfy the outcome.

---

## 16. Dependency graph and bounded execution

```text
RW-0501 ─┬─ RW-0502 ─┬─ RW-0503 ───────────────────┐
         │            └─ RW-0505 ─┐                │
RW-0504 ───────────────────────────┼─ RW-0510       │
RW-0506 ─┬─ RW-0507 ─ RW-0508 ────┤                │
         └─ RW-0509 ───────────────┴────────────────┘
```

Safe lanes: conversation persistence/UI; run evidence; model gateway; capability registry; MCP security fixtures; channel/fake adapter; turn-fault harness. Freeze session, run, capability, and effect contracts before dependent implementations.

---

## 17. Test and qualification strategy

Required suites:

```text
pnpm test:conversations
pnpm test:cognition:fibers
pnpm test:model-gateway
pnpm test:capabilities
pnpm test:mcp
pnpm test:channels
pnpm test:security:mcp
pnpm test:e2e:chat
pnpm test:e2e:approvals
pnpm qualify:wave5:staging
```

Qualification scenarios:

- two independent Stevie sessions with conflicting topics;
- cognitive Stevie versus interpreted tree disclosure;
- world revision changes during a turn;
- actor moves spaces while streaming;
- private Caretaker Talk is perceived by the selected actor but never projected as public spatial speech;
- explicit public Say reaches only its authorized spatial audience and remains distinct from Talk;
- Influence, gift/physical command, and operator action each preserve their distinct receipts and authority;
- provider timeout before/after bytes and structured output;
- ActorAgentDO eviction at every fiber phase;
- duplicate direct message, perception, subscription, and heartbeat wake;
- no-op heartbeat and budget-deferred background work;
- read-only tool, approval wait, revoke during wait, write uncertainty;
- malicious retrieved instruction/tool result cannot expand grants;
- browser reconnect recovers durable status without replaying tokens as truth;
- replay and preview never dispatch recorded external effects;
- a `continuously_eligible` actor process survives eviction and deployment through bounded segments, checkpoints, lease epochs, budgets, and one stable process ID without requiring a resident isolate.

---

## 18. Budgets, observability, and security

Measure actor/session queue depth, activation reason, coalescing/no-op rate, turn duration, phase time, recovery, model attempts/tokens/cost, context tokens/sources/exclusions, tool calls/approvals/uncertainty, effect age, delivery policy result, provider breakers, and spend by tenant/world/timeline/actor/session.

Security gates:

- protected policy/grants never enter untrusted prompt sections;
- context and result text cannot alter capabilities;
- tenant/timeline/session privacy is enforced in SQL and application paths;
- credentials are references, never model-visible or logged;
- outbound network policy blocks private/link-local/metadata targets and unsafe redirects;
- external writes require governed effects and often approval;
- all costly work reserves budget outside prompts;
- mute/revoke/kill switches act without waiting for actor cognition.

---

## 19. Explicit non-goals

Wave 5 does not implement:

- rich episodic memory, beliefs, relationships, consolidation, or learned skills;
- a production Slack/iMessage/email/voice provider;
- autonomous unbounded heartbeats or a continuous process for every actor; selectively long-running logical processes remain supported through the bounded `ActorProcess` contract;
- direct provider calls from actors;
- local/stdio MCP in hosted production;
- natural-language world authoring or branch promotion;
- model-driven routine simulation as a requirement;
- a general agent framework replacing Clockgrove’s domain/runtime.

---

## 20. Exit evidence checklist

- [ ] RW-0501 through RW-0510 are merged.
- [ ] Governed cognitive documents/versioned atomic change sets enforce write classes, authority, limits, provenance, inspector and retention policy.
- [ ] Multiple sessions are independent, durable, participant-scoped, and resumable.
- [ ] Cognitive/interpreted/canonical voice disclosure is visible.
- [ ] Turn fiber recovers at every injected phase boundary.
- [ ] Actor activation is triggered, coalesced, budgeted, and no-op suppressible.
- [ ] Model aliases, attempts, fallback, usage, and cost are inspectable.
- [ ] Context assembly is authorization-first and revision-grounded.
- [ ] Capabilities, grants, approvals, revocation, and world-command validation pass.
- [ ] MCP lifecycle, network safety, schema drift, result sanitization, and effect idempotency pass.
- [ ] Browser, CLI, and fake channel address one canonical actor/session model.
- [ ] Preview/replay cannot produce live external delivery.
- [ ] World remains active with model/MCP unavailable.
- [ ] Local and real-provider/staging qualification pass.

The manifest records commit, schema/policy/model/tool versions, provider and scripted eval results, crash matrix, security fixtures, token/cost distributions, effect/delivery evidence, UI/accessibility results, staging qualification, and exit decision.

---

## 21. Handoff to Wave 6

Wave 6 replaces the shallow Wave 5 context placeholders with provenance-bearing perceptions, episodes, claims/evidence, beliefs, relationships, retrieval, consolidation, and social learning. It consumes the same session, run, context-manifest, activation, event, and inspector contracts. Memory changes future candidate scoring only through canonical cognitive events and versioned decision policy.
