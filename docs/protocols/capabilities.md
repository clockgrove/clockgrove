# Capability registry and grants

Contract of RW-0506's first subset (issue 19): the typed registry, per-actor grants and the
`world.command` path, plus issue 164’s additive MCP admission snapshots. Issue 168 adds an explicitly configured proactive `delivery.request` producer. Subscription, schedule and document-write capabilities remain separate additions to the same registry.

## Registry

`packages/application/src/capability-registry.ts` holds `CAPABILITY_REGISTRY`. A capability has a
name, an effect (`read` or `world_command`), the runtime grant its member must hold and a `parse`
function that accepts one exact input shape and refuses everything else.

| Capability      | Effect          | Member must hold         | Input                                |
| --------------- | --------------- | ------------------------ | ------------------------------------ |
| `inspect`       | `read`          | `runtime:world-observe`  | none                                 |
| `why`           | `read`          | `runtime:world-observe`  | `commandId`                          |
| `world.command` | `world_command` | `runtime:world-command`  | `type`, `objectId`, `kind`           |
| `delivery.request` | `external-write` | Authorized proactive activation only; current `runtime:world-command` and delivery authority | `urgency`, `quietHoursBehavior` |

The read capabilities are registered and grantable. Nothing executes them in this checkpoint: a
model proposal for one is refused as `not_executable`.

## Grants, budgets and revocation

`registry.grantsFor(memberGrants)` returns one `CapabilityGrant` per capability whose required
runtime grant the member holds. An actor therefore never holds more than the member it talks with. `delivery.request` is excluded from default grants; only the authorized proactive producer constructs its one-call grant, and recipient-owned consent and budget still govern the request.
Decisions:

- Each grant allows one call per turn. Stevie proposes at most one command a turn.
- `world.command` names the command types it allows. Only `resource.offer` is granted.
- `grants.revoke(name)` returns grants without that capability; its proposals are refused `revoked`.

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

An accepted `world.command` proposal becomes the ordinary command `resource.offer`, built by the
server (`apps/runtime/src/actor-model.ts`), never taken from the model's text. Under the
[closed-world contract](../../packages/kernel/docs/ecology.md), this unbacked offer is refused by
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

## Evidence

The turn's run records one `world_command_proposal` step: `tool` is the capability, `command_id` the
receipt (null when the grants refused it before the world), `status` `succeeded` or `failed` and
`outcome_code` the refusal code. The Talk receipt's optional `command` carries the same facts
(`TalkCommandOutcome`, `docs/protocols/conversations.md`). The model step records the model name,
tokens and cost.

## Remote MCP installation foundation

The [MCP installation protocol](mcp.md) describes remote HTTP discovery, isolated encrypted
PostgreSQL credentials, canonical installation reviews and scoped binding policy. Discovered
metadata remains untrusted; discovery alone grants no access. Effect classes are `read`,
`world-write`, `external-write`, `destructive`, `network` and `cost`. The unreviewed class is
`external-write`, regardless of server hints. The internal `world_command` name is preserved.

The separate owner-defaulted `runtime:mcp-install` grant governs installation and binding
changes. The isolated secret-provider role confers no installation or capability authority.
Provider-session loss fences old credentials and requires reconnect; see the
[provider contract](mcp.md#postgresql-secret-provider). Credential-backed discovery now has an
owned internal coordinator, including OAuth, but deployed routes and provider ownership remain
pending. The deployed actor path still has only the internal capabilities above.

## MCP binding admission (part 5)

`resolveMcpCapabilityRegistry` now builds reviewed remote versions in this same registry from
canonical installation and binding snapshots. It preserves the internal definitions and their existing default grants. The proactive-only `delivery.request` definition has no default grant. Remote discovery alone adds no grant. Scoped deny, exact review
pins, drift, input/destination/effect/call/budget/expiry limits and a narrowing session overlay
govern admission; see the [binding contract](mcp.md#scoped-binding-policy-and-registry-admission).
Remote metadata is data, never registry instructions. Version names encode the full pin.

`CapabilityGrants.authorize` accepts optional trusted use metadata for destination and cost
constraints; internal capability behavior is unchanged. Grants with such constraints refuse
missing metadata. Runtime counters and reservations must be canonical at the executor boundary;
this stateless check does not reserve spend or execute remote tools. The deployed actor path
still uses only internal definitions. Loading these snapshots before new use and invalidating
them via the actor capability revision hook remain final-part integration, so these proofs do
not yet establish immediate deployed actor revocation.

## Proactive delivery producer

An activation configuration may explicitly request private delivery of the actor reply with `delivery: {urgency, quietHoursBehavior}`. Omitting it preserves ordinary activation behavior. This is a compiled producer, not a general model-selected delivery tool. It cannot select a foreign recipient, artifact, session or provider. The activation snapshots this intent at admission, and coalesced wakes inherit the canonical leader’s intent.

The native actor owner commits its ordinary recoverable turn, then asks `delivery.request` to deliver the stored actor reply before settling the activation. The producer rechecks current activation authority and existing private session/binding provenance. It derives a stable request and reservation identity from the activation. A retry reads the durable receipt before constructing a new request, preserving the original consent version and spending no second reservation. All delivery decisions go through the [governed boundary](channels.md#governed-outbound-delivery). Automatic quiet-hour resumption remains Part 5 of issue 168.
