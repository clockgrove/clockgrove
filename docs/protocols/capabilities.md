# Capability registry and grants

Contract of RW-0506's first subset (issue 19): the typed registry, per-actor grants and the
`world.command` path. MCP, subscriptions, schedules, delivery and document-write capabilities
come later and add to the same registry.

## Registry

`packages/application/src/capability-registry.ts` holds `CAPABILITY_REGISTRY`. A capability has a
name, an effect (`read` or `world_command`), the runtime grant its member must hold and a `parse`
function that accepts one exact input shape and refuses everything else.

| Capability      | Effect          | Member must hold         | Input                                |
| --------------- | --------------- | ------------------------ | ------------------------------------ |
| `inspect`       | `read`          | `runtime:world-observe`  | none                                 |
| `why`           | `read`          | `runtime:world-observe`  | `commandId`                          |
| `world.command` | `world_command` | `runtime:world-command`  | `type`, `objectId`, `kind`           |

The read capabilities are registered and grantable. Nothing executes them in this checkpoint: a
model proposal for one is refused as `not_executable`.

## Grants, budgets and revocation

`registry.grantsFor(memberGrants)` returns one `CapabilityGrant` per capability whose required
runtime grant the member holds. An actor therefore never holds more than the member it talks with.
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
server (`apps/runtime/src/actor-model.ts`), never taken from the model's text:

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

The [MCP installation protocol](mcp.md) describes the remote HTTP discovery and isolated
credential ports. They do not register callable capabilities or change the three internal grants
above. Discovered tools/resources/prompts carry untrusted data and disabled state; discovery
alone supplies no authority. Canonical installation review is persisted internally; dynamic registry versions, scoped
bindings and actor revision invalidation remain the next integration work of issue 164.

The owner-decided remote effect classes are `read`, `world-write`, `external-write`, `destructive`,
`network` and `cost`. Unreviewed tools start at `external-write`, regardless of provider hints.
This additive vocabulary does not rename the existing internal `world_command` effect.

The isolated PostgreSQL credential provider stores sealed envelopes under a dedicated role and
forced scope RLS. It does not confer capability authority or alter registry grants. Provider
session loss fences existing credentials and requires reconnect; see the [provider contract](mcp.md#postgresql-secret-provider).

The internal MCP governance service now persists installation snapshots, exact-hash tool
reviews and drift/revocation state under the separate owner-defaulted `runtime:mcp-install`
grant. These are canonical governance records, not dynamic actor grants: the three internal
registry entries above remain the only registered capabilities. Reviewed MCP tools require the
remaining scoped binding/resolution and revision-hook integration before any actor can see them.
