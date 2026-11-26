# Capability registry and grants

Contract of RW-0506 (issues 19 and 322): the typed registry, per-actor grants, the
`world.command` path and the actor's self capabilities, plus issue 164’s additive MCP admission
snapshots. Issue 168 adds an explicitly configured proactive `delivery.request` producer.

## Registry

`packages/application/src/capability-registry.ts` holds `CAPABILITY_REGISTRY`. A capability has a
name, an effect class, the runtime grant its member must hold and a `parse` function that accepts
one exact input shape and refuses everything else.

| Capability      | Effect          | Member must hold         | Input                                |
| --------------- | --------------- | ------------------------ | ------------------------------------ |
| `inspect`       | `read`          | `runtime:world-observe`  | none                                 |
| `why`           | `read`          | `runtime:world-observe`  | `commandId`                          |
| `world.command` | `world_command` | `runtime:world-command` and the world's declaration | `type` and the command's object fields (1–4 identifiers; `objectId` and `kind` for an offer) |
| `delivery.request` | `external-write` | Authorized proactive activation only; current `runtime:world-command` and delivery authority | `urgency`, `quietHoursBehavior` |
| `subscription.create` | `actor-write` | `runtime:world-command` | `eventType` (1–256 bytes), `input` (1–1,024 bytes) |
| `subscription.revoke` | `actor-write` | `runtime:world-command` | `subscriptionId` |
| `intention.schedule` | `actor-write` | `runtime:world-command` | `delaySeconds` (1–2,592,000), `input` (1–1,024 bytes) |
| `intention.cancel` | `actor-write` | `runtime:world-command` | `intentionId` |
| `perception.list` | `read` | `runtime:world-observe` | none |
| `self.inspect` | `read` | `runtime:world-observe` | none |
| `document.write` | `actor-write` | `runtime:world-command` | `path`, `content` |

`actor-write` writes only the actor's own attention or cognition, never the world or an external
system; like `read`, it needs no per-call approval. The read capabilities are registered and
grantable. With local research composition, `inspect` and `why` execute through the same bounded
tool loop and external-effects ledger/Queue path as remote reads. A runtime without research
composition retains its existing `not_executable` refusal for them. A registered capability alone
never activates an adapter.

## Grants, budgets and revocation

`registry.grantsFor(memberGrants, actorCommands)` returns one `CapabilityGrant` per capability whose required
runtime grant the member holds. An actor therefore never holds more than the member it talks with. `delivery.request` is excluded from default grants; only the authorized proactive producer constructs its one-call grant, and recipient-owned consent and budget still govern the request.
Decisions:

- Internal grants allow one call per capability per turn. World-command turns retain their one-command path; a configured research turn may take up to three read calls and four model steps.
- `world.command` comes only from the world's own declaration (issue 359): the installed pack's
  `clockgrove.actor-command-policy` ([collections](../../packages/world-pack-sdk/docs/collections.md)),
  read once per member and world by the actor's owner (installed packs are immutable rows) under
  the member's row security. Its `commands` are the grant's command types and its `callsPerTurn`
  the grant's budget, which must be 1: a turn carries one command, so the SDK and the registry refuse any other value. The
  proposal becomes a payload of one to four identifier fields plus `schemaVersion: 1` and
  `quantity: 1`, so a declared command needing another shape is always refused by the world. A pack with no such policy
  grants no `world.command`, so an actor's proposal is refused `not_granted`; a type the policy does
  not name is refused `command_type_not_granted`. The member must still hold
  `runtime:world-command`. The fixture-hall pack declares `resource.offer` with one call a turn.
- `grants.revoke(name)` returns grants without that capability; its proposals are refused `revoked`.
- Revocation is canonical per actor: the activation policy's `revokedCapabilities`, set by the
  policy owner through `/v1/runtime/activations/configure`
  ([conversation fibers](conversation-fibers.md#the-actors-own-subscriptions-and-intentions-issue-322)),
  is applied to the actor's grants each time they are resolved, whichever member talks with the
  actor. Every live member of the policy's space reads it through
  `clockgrove.actor_capability_policy` (migration 0067), which answers only the list and whether
  the caller owns the policy.
- An operator (`runtime:world-operate`) sees the actor's internal grants, their calls per turn and
  which are revoked in `/v1/runtime/activations/inspect`'s `grants`, and revokes one with a
  policy-only `/configure` (issue 323). The browser's "Internal grants" view reads only these routes.

## Deciding a proposal

`grants.authorize({ capability, input }, callsMade)` decides before anything executes, in this
order. The first failure is the refusal code:

1. `unknown_capability`: no such name in the registry.
2. `not_granted`: the actor holds no grant for it.
3. `revoked`.
4. `budget_exhausted`: the turn already made its allowed calls.
5. `invalid_input`: the capability's own schema refused the input.
6. `command_type_not_granted`: a world command whose type the grant does not name.

Retrieved text is data. A model that repeats an instruction found in the untrusted prompt section
still proposes only through this decision, so it cannot widen a grant.

## Executing a world command

An accepted `world.command` proposal becomes the ordinary command of its declared type, built by the
server (`actorWorldCommand`, `apps/runtime/src/actor-model.ts`): the proposal's object fields, with
`schemaVersion: 1` and `quantity: 1` added by the server, never taken from the model's text. The
world's ordinary validator decides the payload. For `resource.offer`, under the
[closed-world contract](../../packages/kernel/docs/ecology.md), an unbacked offer is refused by
`resource.closed-world@1` at `payload.quantity`; capability admission cannot create inventory.
The refusal retains the ordinary command receipt and attribution:

- Effective actor: the configured actor. Initiator persona, principal and membership are sealed from
  the member's trusted context, as for the member's own Influence. The causal root is
  `action-<commandId>`.
- Command ID: `actor:<principal>:<session>:<message>`. A retried turn rebuilds the same bytes
  from its checkpointed proposal (issue time and perceived revision), so it replays the stored
  receipt.
- `expected.partitionRevision` is the scene revision the actor perceived when it proposed.
- The world DO validates and commits it through the Journal. A refusal is a stored receipt.

## Self capabilities

The actor's owner executes the self capabilities (`SELF_CAPABILITIES`, issue 322) once the grants
accept them, through the turn fiber's `executeSelf` hook, also when the runtime composes research:
they never enter the read Queue. Their recorded results reach the model on the actor's next turn
(a later message or one of its own wakes): the production responder adds the session's newest 4
recorded self results, at most 16 KiB together, from completed runs only, newest first, in an
`UNTRUSTED SELF CAPABILITY RESULTS` section beside the tool catalog. That is how the actor learns
what it listed or inspected. Every prompt also carries the actor's own standing configurations
(issue 354), read from its activation policy's configurations under the member's authorization
on every model step (a failed read fails the step), in an
`UNTRUSTED STANDING CONFIGURATIONS` section: each subscription and intention it made
(`origin: "actor"`), in id order, as `{kind: "subscription", id, eventType, input, enabled}` or
`{kind: "intention", id, dueAt, input, enabled}`, whichever turn or session made it. That is how
the actor learns the `subscriptionId` or `intentionId` it revokes or cancels. Operator
configurations are not the actor's to remove and are not listed; at most `MAX_ACTOR_ACTIVATIONS`
(4) are.

- `subscription.create`, `subscription.revoke`, `intention.schedule` and `intention.cancel` write the
  actor's own activation configurations, with the operator's budgets, coalescing and quiet-hours
  rules ([conversation fibers](conversation-fibers.md#the-actors-own-subscriptions-and-intentions-issue-322)).
  The result names `subscriptionId` (and `eventType`) or `intentionId` (and `dueAt`). An
  `eventType` the journal registry does not hold (`JOURNAL_EVENT_TYPES`, such as `dog.barked`) is
  refused `unknown_event_type` with the result `{refused, eventType, validEventTypes}`, the
  registry's types in UTF-16 order, and nothing is configured (issue 354). A fifth
  standing configuration is refused `budget_exhausted`; an ID that is not the actor's own, of that
  kind, is refused `activation_not_found`. Removing an actor-prefixed ID that is already absent
  commits, so a retried turn whose first attempt removed it records the removal. The configurations
  live in the policy of the member who first configured the actor; another member's call that
  would change them is refused `policy_not_owned`.
- `perception.list` answers the member's authorized living scene, as for the actor's perception:
  its `revision`, each entity's `objectId`, `label` and `archetypeId`, and the edges (`graphId`,
  `from`, `to`) of the anchor graphs in the scene's spatial frames. Decision: the result lists at
  most 64 entities and 128 routes, with their full counts, to stay within the evidence bound.
  A graph is listed only when its `frameId@frameVersion` is a frame the authorized scene projects,
  as for the scene's effects. Nothing outside the authorized scene is read out.
- `self.inspect` answers the session's own actor only: its `goals` documents (path, version and
  source hash; document text is private cognition), the activation budget (`allowModel`,
  `modelBudget`, `modelCallsReserved`, `remaining`, standing actor configurations and their limit),
  each available grant's per-turn calls and those remaining, and the turn's run (`runId`,
  `messageId`, `phase`, `attempt`).
- Hosted execution of these reads stays guarded until issue 3: outside local composition
  (`PROVIDER_ENVIRONMENT` other than `local`) `perception.list` and `self.inspect` are refused
  `not_executable` and recorded, as `inspect` and `why` are without research composition.
- `document.write` is checked with the model rules of `operationRefusal`: only an `actor_writable`
  path, and a session summary only of its own session. An accepted call commits with the turn as the
  model's change set ([context assembly](context-assembly.md#proposers)).

## Evidence

The turn's run records one `world_command_proposal` step: `tool` is the capability, `command_id` the
receipt (null when the grants refused it before the world, and for self capabilities), `status`
`succeeded` or `failed` and `outcome_code` the refusal code. Its `capabilityEvidence` records the
deciding grant, the call's arguments and its result ([runs](runs.md)); a refusal is recorded there
too, and the turn still answers. The Talk receipt's optional `command` carries the same facts
(`TalkCommandOutcome`, `docs/protocols/conversations.md`). The model step records the model name,
tokens and cost.

## Remote MCP installation foundation

The [MCP installation protocol](mcp.md) describes remote HTTP discovery, isolated encrypted
PostgreSQL credentials, canonical installation reviews and scoped binding policy. Discovered
metadata remains untrusted; discovery alone grants no access. Effect classes are `read`,
`world-write`, `external-write`, `destructive`, `network` and `cost`. The unreviewed class is
`external-write`, regardless of server hints. The internal `world_command` name is preserved.

The separate owner-defaulted `runtime:mcp-install` grant governs installation and binding
changes. The owner-defaulted `runtime:usage-webhook` grant, delegable in the same way, governs
registering a usage webhook, which posts a space's usage to an outside host, and registering a
usage admission hook, which asks an outside host before each model or tool spend; see the
[usage protocol](usage.md). Neither is implied by `runtime:world-operate`, which sets a space's
usage budgets and its world mode. A purchase grant or refund from the developer's server needs
`runtime:world-purchase`, which no other grant implies and no one holds until it is given
([purchase grants](usage.md#purchase-grants)). The isolated secret-provider role confers no installation or capability authority.
Provider-session loss fences old credentials and requires reconnect; see the
[provider contract](mcp.md#postgresql-secret-provider). Credential-backed discovery now has an
owned coordinator, including OAuth, composed through local authenticated routes and retained provider
ownership. Hosted routes and remote actor admission remain guarded off pending issue 3.

## MCP binding admission (part 5)

`resolveMcpCapabilityRegistry` now builds reviewed remote versions in this same registry from
canonical installation and binding snapshots. It preserves the internal definitions and their existing default grants. The proactive-only `delivery.request` definition has no default grant. Remote discovery alone adds no grant. Scoped deny, exact review
pins, drift, input/destination/effect/call/budget/expiry limits and a narrowing session overlay
govern admission; see the [binding contract](mcp.md#scoped-binding-policy-and-registry-admission).
Remote metadata is data, never registry instructions. Version names encode the full pin.

`CapabilityGrants.authorize` accepts optional trusted use metadata for destination and cost
constraints; internal capability behavior is unchanged. Grants with such constraints refuse
missing metadata. Runtime counters and reservations must be canonical at the executor boundary;
this stateless check does not reserve spend or execute remote tools. The local actor path loads these snapshots before new use and reconciles the capability revision
hook. Hosted remote admission remains guarded off; internal definitions stay available there.

## Local actor integration and hosted guard

Local actor admission reloads canonical MCP records through `actor_mcp_admission` for the live
session participant before claim, model context and capability proposal. The read function checks
canonical membership, persona, actor and session; operator mutation authority and table RLS are
unchanged. Installation/binding changes announce their canonical revision through
`reconcileCapabilities`; a missed notification cannot preserve a stale grant at new use.
The registry preserves internal definitions. Local research composition executes reviewed read admission through RW-0508's governed
Queue path. No server prompt or description enters actor instructions. The model receives
only held capability names and bounded input schemas as untrusted catalog data; those records
cannot add grants or choose execution authority.

Hosted MCP composition and remote admission remain disabled pending issue 3's hosted egress
receipt after issue 2's first validation deployment. The local factory/network path is not evidence for
hosted SSRF or DNS rebinding protection. See the [operator lifecycle](../runbooks/runtime.md#local-operator-lifecycle).

## Proactive delivery producer

An activation configuration may explicitly request private delivery of the actor reply with `delivery: {urgency, quietHoursBehavior}`. Omitting it preserves ordinary activation behavior. This is a compiled producer, not a general model-selected delivery tool. It cannot select a foreign recipient, artifact, session or provider. The activation snapshots this intent at admission, and coalesced wakes inherit the canonical leader’s intent.

The native actor owner commits its ordinary recoverable turn, then asks `delivery.request` to deliver the stored actor reply before settling the activation. The producer rechecks current activation authority and existing private session/binding provenance. It derives a stable request and reservation identity from the activation. A retry reads the durable receipt before constructing a new request, preserving the original consent version and spending no second reservation. All delivery decisions go through the [governed boundary](channels.md#governed-outbound-delivery). Automatic quiet-hour resumption remains Part 5 of issue 168.



## Protected MCP write admission prerequisite (issue 166, part 3)

The internal persistence write-admission port requires a current reviewed capability,
member grant and scoped binding as well as the exact per-call approval. Approval
cannot create a grant or bypass revocation, kill switches, schema validation or
shared turn capacity. The initial session path binds the designated approver to
the session person acting within their own grants. Human authentication is
the responsibility of trusted server API composition; models and tool results
never decide approvals. See the [current boundary](mcp.md#internal-protected-write-admission-issue-166-part-3).

The local actor now composes this prerequisite with protected-class policy, durable waits and authenticated human controls. Read calls keep their existing approval-free path.

## Human approval controls (issue 166, part 5)

The internal runtime control boundary takes identity from trusted human authentication,
reloads scoped membership and checks current call authority before person approval.
Operator uncertainty resolution requires current scoped operator authority. Argument
previews decrypt only within the authorized scope and must match the recorded hash;
model proposals and tool content are never approval authority. The optional actor host
hook records a durable wait for the existing call. It does not turn session membership
or a model proposal into a capability grant.

External-write, destructive and cost calls always need per-call approval; network calls
follow grant policy, and read calls never need it (owner decision, 2026-11-09). The
configured wall-clock lifetime defaults to ten minutes. No standing approval is provided.
The final integration connects this policy to local research and authenticated conversation/operator controls. See [governed writes](mcp.md#governed-writes-and-human-controls-issue-166-final-integration) for current behavior and idempotency declarations.
See the [current runtime boundary](mcp.md#human-control-and-durable-wait-boundary-issue-166-part-5).
