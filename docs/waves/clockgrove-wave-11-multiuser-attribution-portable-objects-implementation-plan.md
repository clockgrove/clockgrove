# Clockgrove Wave 11: Multiuser Worlds, Action Attribution, World Personas, and Inventory

**Status:** Optional post-GA implementation specification  
**Version:** 2.5  
**Date:** October 19, 2026
**Parent plan:** `clockgrove-cloudflare-implementation-plan.md` v3.9 plus Waves 0–10  
**Product source:** `clockgrove-prd-v0.5.md` v0.5.8  
**Decision source:** `clockgrove-adr-world-personas-and-object-mobility-policy.md`  
**Wave:** 11, after provider-neutral signup and workspace tenancy  
**Assumptions:** Wave 10 is qualified; shared worlds follow a MUD/MOO model; billing is not required  
**Filename note:** the historical filename is retained for Library identity; “portable objects” now means world-local mobility, never cross-world runtime portability  
**Development tooling:** development-tool identities, sessions, evidence, and audit remain external delivery-system state. They never become world personas, action authority, inventory owners, or causal authors unless a separately authenticated product command crosses that boundary.

---

## 1. Outcome

Wave 11 turns a tenant-owned world into a persistent social place. People can invite others into a world without adding them to the owning workspace, participate through durable world personas, appear through ephemeral presences, act concurrently, carry permitted objects among rooms inside that world, and inspect who or what caused a change.

The wave exits only when:

> Alice invites Bob into Alice's Raccoon World. Bob enters as a disclosed Caretaker persona, places a world-local axe in the yard, and disconnects. Alice later picks up that same axe and uses it to chop a permitted tree. Clockgrove preserves the axe's identity and provenance, serializes each mutation, applies inherited mobility and use policy, and attributes every allow, deny, command, and consequence without requiring billing.

Attribution is foundational world truth. Wave 12 may decide who sponsors variable-cost work, but payment policy cannot redefine who initiated, acted, authorized, possessed, or caused an event.

---

### 1.1 Objectives, sequencing, and checkpoints

This wave is a substantial workstream containing numerous Objectives and Work Items. The accepted [incremental-delivery ADR](../adr/clockgrove-adr-incremental-wave-delivery-and-evidence.md) governs capability scope, readiness, comparison rules, and proportionate qualification. The complete exit checklist below remains authoritative for full-wave qualification.

First qualify two independently authenticated people: one invites the other into a world, each resolves a separate world membership/persona, and attributed world-local inventory/actions remain correct across disconnect/retry. Two browsers attached to one principal prove client convergence, not multiuser participation.

Then broaden membership/persona modes, mobility/use policy, concurrency, moderation and audit/inspection as complete capability Objectives. Workspace administration never implicitly grants world participation or object authority.

Preserve no-money and no-cross-world-runtime-portability boundaries. Immutable attribution, narrow-only inherited mobility and deny-wins remain exact correctness requirements; these are not incidental comparison fields.

---

## 2. Product decisions

### 2.1 A world is a social place, not an auth organization

The layers are distinct:

| Layer | Purpose | Canonical owner |
| --- | --- | --- |
| External identity | Prove a browser or service identity | Better Auth reference adapter; optional Clerk adapter |
| Principal | Stable Clockgrove identity | PostgreSQL |
| Workspace membership | Administer resources and ownership | PostgreSQL |
| World membership | Participate in one world | PostgreSQL |
| World persona | Durable in-world identity and policy subject | PostgreSQL journal/projections |
| Presence | Current connection and interest | SpaceDO, reconstructible |
| Controlled actor | Optional embodied world object | World journal |

A person may visit a friend's world without joining its workspace. A provider Organization may help administer a workspace, but it never stands in for a world, room, persona, or presence.

### 2.2 Personas support observer, visitor, resident, and embodiment modes

Every active human participant resolves to one `WorldPersona`. A persona may be:

- `unrendered`: durable identity with no scene object;
- `represented`: a visible marker/avatar that is not an ordinary world actor;
- `embodied`: bound to a controlled actor under explicit policy.

Raccoon World starts with the disclosed, unrendered `caretaker` mode. Raccoons can attribute private Talk, public speech, gifts, influence, and physical actions to a visitor without pretending that the visitor is a raccoon or an invisible omniscient god. Those action kinds remain distinct in audience, authority, evidence, and consequence.

### 2.3 Inventory is world- and timeline-local

A persona inventory is a logical container scoped to `(worldId, timelineId, personaId)`. An object may move among permitted rooms, fixtures, containers, actors, and persona inventories within that world and timeline. The object keeps one logical ID and its provenance.

No live command moves an object to another world. Cross-world passports, federation, custody, foreign archetype admission, and player-carried world transfer are out of scope. Administrative world export/import is a separate offline lifecycle operation.

### 2.4 Mobility and use are independent

Possession does not imply every use. An axe may be movable but unable to chop a protected tree; a key may be anchored but usable in place; a moderator may remove an object they may not personally use.

### 2.5 Multiuser authority stays server-side

Clients submit typed intents. The current authoritative owner validates membership, persona, expected revisions, mobility, use, containment, and world invariants. A selected sprite, optimistic inventory, provider claim, or WebSocket presence never grants authority.

---

## 3. Entry conditions

These are the full-wave/default entry conditions. A named local-development Objective may consume only accepted prerequisite capabilities under the ADR's recorded readiness exception; its Issue must preserve pending qualification obligations and the selected path's mandatory safety evidence.

- Wave 10 qualification is green.
- Every mutating Wave 0–10 command and event already accepts the v1 `AttributionEnvelope` or has a reviewed compatibility upcaster.
- PostgreSQL remains canonical for world state, membership, persona, actions, authority decisions, and audit.
- Better Auth and any enabled Clerk adapter pass the same principal/session conformance suite.
- World, timeline, space, object, action, authority-decision, membership, persona, and presence IDs are distinct branded types.
- SpaceDO routing, expected-revision checks, cross-space handoff, WebSocket recovery, RLS, privacy, export, and deletion are qualified.
- The world-pack manifest can declare mobility defaults, archetype ceilings, persona modes, and role capabilities.

Amended (2026-10-19): GA ships with one space owner per world partition and awake/asleep fidelity (parent §35). This wave delivers, after GA and before RW-1108: world state split per space across the kernel, journal, snapshots, bundles and goldens; the cross-space transfer saga (Wave 3 RW-0308) and its crash matrix; and the hot/warm/dormant tiers with runtime cells, quadtree promotion, partition rehearsal and the one-million-actor fixture (from Wave 9). Reason: RW-1108 is the first consumer of a second authority owner. An earlier wave may pull the split forward if it needs one.

Amended (2026-10-27): the per-space state split inherits from Wave 1 (Wave 1 §5.5, graph 2) the physical authority partition mapping, which Wave 1 did not build. Until it lands each world partition is one authority, Wave 3's one SpaceDO per world partition, and `partitionId` is a scope field only.

---

## 4. Canonical domain model

```ts
interface WorldMembership {
  worldMembershipId: WorldMembershipId;
  tenantId: TenantId;
  worldId: WorldId;
  principalId: PrincipalId;
  status: "invited" | "active" | "suspended" | "removed" | "left";
  roles: WorldRoleId[];
  invitedByPrincipalId?: PrincipalId;
  joinedAt?: string;
  revision: bigint;
}

interface WorldPersona {
  personaId: WorldPersonaId;
  worldMembershipId: WorldMembershipId;
  worldId: WorldId;
  displayName: string;
  mode: "unrendered" | "represented" | "embodied";
  disclosure: "identified" | "pseudonymous" | "hidden-from-peers";
  presentationBindingId?: PresentationBindingId;
  controlledActorId?: WorldObjectId;
  inventoryContainerId: WorldObjectId;
  policyRoles: WorldRoleId[];
  revision: bigint;
}

interface Presence {
  presenceId: PresenceId;
  personaId: WorldPersonaId;
  worldId: WorldId;
  timelineId: TimelineId;
  spaceId: SpaceId;
  connectionId: string;
  interestRevision: bigint;
  connectedAt: string;
  lastAcknowledgedProjectionRevision: bigint;
}
```

Rules:

- one active world membership per `(worldId, principalId)` unless an ADR adds explicit multi-membership;
- one default persona per active membership in v1; later alternate personas require an explicit switch policy;
- a controlled actor may be bound to at most one active persona unless cooperative control is deliberately modeled;
- presence disappears on disconnect and is recreated from durable membership/persona state;
- persona inventory is a world object/container so normal containment, journal, replay, timeline, and privacy rules apply;
- deleting or removing a membership invokes an explicit inventory disposition policy instead of orphaning objects.

---

## 5. World entry, invitations, and presence

### 5.1 Invitation state machine

```text
created -> delivered -> accepted -> membership_active
       \-> revoked
       \-> expired
accepted -> rejected_if_world_or_principal_policy_changed
```

Invitation tokens are single-use, hashed at rest, time-bounded, world-specific, and idempotent. Acceptance checks the current inviter authority and destination world policy; it never grants workspace membership.

### 5.2 Entry state machine

```text
authenticate
  -> resolve principal
  -> resolve active world membership
  -> resolve/create default world persona
  -> authorize timeline and entry space
  -> create reconstructible presence
  -> return authorized snapshot and effective actions
```

Suspension or removal invalidates new entry and active mutation immediately. Existing sockets receive a typed revocation/close result and cannot continue with cached grants.

### 5.3 Presence behavior

SpaceDO owns live connection membership, acknowledgements, and interest. Presence is never used to answer durable questions such as who owns an object, who joined the world, or who caused an event. Reconnection creates a new presence that resumes the same persona.

---

## 6. Foundational action attribution

### 6.1 Attribution intent and sealed envelope

```ts
interface AttributionIntent {
  version: 1;
  principalId?: PrincipalId;
  worldMembershipId?: WorldMembershipId;
  personaId?: WorldPersonaId;
  initiatorId?: string;
  effectiveActorId: string;
  causalRootActionId: ActionId;
  immediateCauseId?: string;
  sessionId?: SessionId;
}

interface AttributionEnvelope extends AttributionIntent {
  authorityDecisionId: AuthorityDecisionId;
}
```

Semantics:

- `principalId` is the authenticated or internal human/service principal when one exists;
- `personaId` is the human's in-world policy subject;
- `initiatorId` is the entity that requested the action: persona, actor, rule, scheduler, workflow, tool, or operator;
- `effectiveActorId` is the entity whose authority and agency executed the action;
- `authorityDecisionId` is added only after the authority owner creates immutable allow/deny evidence;
- `causalRootActionId` remains stable across derived reactions;
- `immediateCauseId` points to the command, event, rule firing, tool result, or action that directly triggered this record;
- `sessionId` links a conversation or channel without making it the author.

### 6.2 Action and authority records

```ts
interface ActionRecord {
  actionId: ActionId;
  worldId: WorldId;
  timelineId: TimelineId;
  type: string;
  status: "proposed" | "allowed" | "denied" | "committed" | "failed";
  attribution: AttributionEnvelope;
  commandId?: CommandId;
  eventIds: EventId[];
  requestedAt: string;
  committedAt?: string;
}

interface AuthorityDecision {
  authorityDecisionId: AuthorityDecisionId;
  worldId: WorldId;
  timelineId: TimelineId;
  actionId: ActionId;
  outcome: "allow" | "deny";
  capability: string;
  policyInputs: PolicyInputRef[];
  policyVersion: string;
  reasons: string[];
  decidedAt: string;
}
```

The trusted gateway creates the initial human attribution intent and action ID. The authority owner evaluates policy, records the decision, and seals the envelope before committing any resulting event. Internal dispatchers inherit the causal root and replace only the immediate cause and effective actor as work passes to an actor, rule, scheduler, workflow, or tool. Clients, models, and MCP servers cannot submit trusted identity or authority fields.

### 6.3 Required coverage

Attribution is mandatory for:

- human commands, speech, gifts, and operator changes;
- autonomous actor actions and actor-to-actor messages;
- scheduled simulation work and rule reactions;
- tool/MCP proposals, approvals, executions, and external effects;
- containment, inventory, mobility, placement, and object-use decisions;
- moderation, removal, restoration, and policy changes;
- denials, not only successful mutations.

Telemetry may sample operational spans. Canonical action and authority evidence is not sampled.

---

## 7. Object mobility and personal inventory

Amended (2026-10-27): this section inherits from Wave 1 (Wave 1 §5.2 and §5.5) the inherited mobility policy, the distinct `pickup`, `drop`, `give`, `place`, `remove`, `move_within_space` and `cross_space` verbs and the Mobility component, which Wave 1 did not build; Wave 1 provides the `persona-inventory` container kind.

### 7.1 Mobility scopes

```ts
type MobilityScope = "anchored" | "space" | "world";
type MobilityAction =
  | "pickup"
  | "drop"
  | "give"
  | "move_within_space"
  | "cross_space"
  | "place"
  | "remove";
```

- `anchored`: ordinary actions cannot move the object;
- `space`: movement is permitted only inside the current space;
- `world`: movement may cross authorized spaces in the same world.

No mobility scope includes another world.

### 7.2 Sparse inherited policy

Policy layers are evaluated in order but combined by restriction:

1. world default;
2. containing space/room restriction;
3. persona or world-role restriction;
4. object-archetype ceiling;
5. object-instance restriction.

Rules:

- a missing child rule inherits its parent;
- a child may narrow an inherited allow;
- a child cannot widen a parent deny without an explicit privileged policy change to the parent scope;
- deny wins at the effective intersection;
- the evaluation returns reasons and all contributing policy versions;
- changing policy does not retroactively rewrite prior authority decisions.

### 7.3 Separate use authorization

Mobility and use are evaluated independently. The reference axe requires:

- `inventory.pickup` to enter a persona inventory;
- `inventory.cross_space` to pass a portal if its scope is `world`;
- `tool.chop` for the persona/actor and object;
- `tree.modify` for the target tree;
- any required space safety or operator policy.

A denial records which capability failed without leaking private policy details to unauthorized clients.

### 7.4 Containment invariants

- Every object has exactly one canonical container or placement state per timeline.
- Container and object `worldId` and `timelineId` must match.
- Containment is acyclic and depth-bounded.
- Capacity, mass, slot, lock, and privacy constraints are deterministic.
- Ownership, possession, custody, and authorship are distinct projections.
- Duplicate command IDs return the stored result; concurrent pickups yield one winner and a typed stale/conflict result.
- Cross-space movement uses the existing transfer saga and preserves the same attribution and action ID.

### 7.5 Removal and membership lifecycle

A world policy chooses one explicit disposition when a membership ends:

- drop movable persona inventory into a configured safe room;
- transfer eligible objects to a world operator escrow container;
- return objects to recorded world owners where defined;
- freeze disputed/anchored items pending moderation.

The system never exports the inventory to another world or deletes objects merely because a user left.

---

## 8. Concurrency and runtime authority

The current `SpaceDO` serializes physical mutation for objects in its authority partition. Persona inventory operations route to the owner of the inventory/object placement, not to a browser session. Cross-space transfer remains the current saga:

```text
requested -> source_prepared -> destination_accepted
          -> source_released -> completed
```

Every step is idempotent and fenced by routing/authority epoch. `runtimeInstanceId` is a Clockgrove diagnostic ID for a disposable incarnation, not a durable identity or Cloudflare platform primitive.

The loose quadtree controls interest and measured runtime-cell promotion for large spaces. It does not change membership, persona, inventory, or attribution semantics. A million logical actors may exist while only hot/warm cells and due work are activated.

---

## 9. Privacy, moderation, and abuse controls

World policy defines who may see:

- principal-backed identity versus pseudonymous persona name;
- presence and current room;
- inventory contents;
- object ownership/provenance;
- action and authority details;
- moderation evidence.

Participants receive a safe explanation of their own denied actions. Operators with explicit grants receive full policy and causal evidence. Peers do not automatically receive principal IDs, private inventory, hidden presence, IP/device data, private cognition, or moderation notes.

Required controls:

- world invite rate limits and revocation;
- join, chat, command, pickup/drop, and transfer rate limits;
- per-persona and per-space action budgets;
- block/mute/kick/suspend/remove with durable audit;
- item quarantine/escrow inside the same world;
- chat and object-name content policy hooks;
- command-size, containment-depth, and transfer-hop bounds;
- kill switches for world entry, object mobility, use capabilities, and actor cognition;
- export and deletion behavior for memberships, personas, messages, actions, and evidence.

---

## 10. Product and web experience

### 10.1 World entry and persona disclosure

The entry surface shows world name, owner, invite status, persona display name/mode, visible rules, and privacy expectations. It distinguishes “join world” from “join workspace.” Raccoon World explains that the participant is a Caretaker who can be recognized by name but is not rendered.

Observer navigation remains distinct from persona embodiment, actor movement, and object mobility. `ChangeViewedSpace` may rebind the Caretaker's ephemeral connection presence, interest, and projection subscription, but it does not move a durable persona object; following an actor may be denied or stop at a hidden/unauthorized boundary without moving an actor or inventory.

### 10.2 Presence and participant list

The participant list shows only policy-visible personas and status. It does not display auth-provider organizations or workspace administration as social membership.

Private Caretaker Talk is visible only to the session audience and the addressed actor's authorized cognition. Public Say is projected through ordinary spatial audience rules. Neither is inferred from simple presence in a room.

### 10.3 Inventory and effective actions

The UI provides:

- world-local inventory with capacity and privacy disclosure;
- pickup, drop, give, place, remove, and use actions returned by server evaluation;
- clear disabled/denied reasons at the user's disclosure level;
- pending/committed/conflict states keyed by command/action ID;
- provenance and ownership inspection where authorized;
- accessible text equivalents for every drag/drop or scene action.

Drag-and-drop is presentation sugar for typed commands. The scene cannot mutate inventory locally.

### 10.4 Reference axe journey

1. Alice creates or opens her Raccoon World.
2. Alice invites Bob to the world, not her workspace.
3. Bob accepts, receives a Caretaker persona, and enters the yard.
4. Bob authors or receives a locally valid axe from a permitted source fixture.
5. Bob places the axe in the yard; the world records action, authority, containment, and provenance.
6. Bob disconnects; his presence disappears but the axe remains.
7. Alice enters, sees the axe, and picks it up.
8. Alice tries a protected tree and receives a safe `tree.modify` denial.
9. Alice uses the axe on a permitted tree.
10. The tree, debris/resources, actor perceptions, event feed, and inspector all link to the same causal root.
11. Replay reproduces the same possession and world-state transitions.

No step moves the axe between worlds.

---

## 11. Owned code and data

```text
packages/contracts/
  world-membership.ts
  world-persona.ts
  attribution.ts
  authority-decision.ts
  mobility-policy.ts

packages/domain/
  participation/
  persona/
  inventory/
  mobility/

packages/application/
  world-entry/
  invitations/
  participation/
  actions/
  mobility/

packages/persistence/
  schema/participation.ts
  schema/actions.ts
  schema/mobility.ts
  repositories/

apps/runtime/src/
  world-entry/
  presence/
  mobility/

apps/web/src/features/
  world-entry/
  participants/
  persona/
  inventory/
  action-inspector/

world-packs/raccoon-world/
  personas/
  policies/mobility/
  fixtures/axe-journey/
```

Required canonical tables/projections include world invitations, world memberships, world personas, persona inventory bindings, actions, authority decisions, object provenance/ownership where modeled, and mobility policies. Presence remains reconstructible runtime state.

---

## 12. Detailed work packets

### RW-1101 — World invitation and membership domain

Implement world-scoped invites, acceptance, roles, revocation, lifecycle, RLS, APIs, and audit. Prove that world participation never grants workspace membership.

### RW-1102 — World persona and entry pipeline

Implement durable persona creation, disclosure/mode, default Caretaker provisioning, optional controlled-actor binding seam, entry state machine, and accessibility copy.

### RW-1103 — Presence and participant projection

Implement reconstructible SpaceDO presence, visible participant list, reconnect/revocation, interest handoff, and privacy-filtered projection.

### RW-1104 — Action and attribution ledger

Implement `ActionRecord`, `AttributionEnvelope` validation/upcasters, causal propagation, initiator/effective-actor rules, indexes, inspector, and coverage assertions across every mutating command family.

### RW-1105 — Authority decision evidence

Implement immutable allow/deny records, policy input/version capture, safe reason projection, and links to actions, commands, events, tools, and moderation.

### RW-1106 — Persona inventory and containment

Implement world/timeline-local inventory containers, capacity/privacy, membership-lifecycle disposition, replay, branch behavior, and property tests preventing cross-world or cross-timeline containment.

### RW-1107 — Inherited mobility and use policy

Implement sparse policy resolution, deny-wins intersection, world/space/role/archetype/instance layers, separate use capability checks, effective-action API, and editor/inspector surfaces.

### RW-1108 — Concurrent object actions and cross-space handoff

Implement pickup/drop/give/place/remove commands, expected revisions, one-winner conflicts, existing transfer-saga integration, recovery, and idempotency.

### RW-1109 — Multiuser safety, moderation, and lifecycle

Implement rate limits, block/mute/kick/suspend/remove, item quarantine/escrow, privacy, deletion/export, kill switches, and adversarial suites.

### RW-1110 — Axe journey and Wave 11 qualification

Ship the full Alice/Bob reference journey through browser, runtime, journal, replay, inspector, failures, and accessibility. Archive a signed qualification manifest.

---

## 13. Test and qualification strategy

### 13.1 Domain and property tests

- membership and invitation state machines;
- one default persona per membership;
- identity separation and controlled-actor uniqueness;
- containment acyclicity and conservation;
- no cross-world/timeline container edges;
- sparse policy inheritance, narrow-only behavior, and deny precedence;
- mobility/use independence;
- immutable attribution and authority decisions;
- causal-root preservation through arbitrary bounded reaction chains;
- duplicate/idempotent and concurrent one-winner behavior.

### 13.2 Integration and RLS tests

- join a world without workspace membership;
- workspace admin without world membership cannot enter by implication;
- provider-organization drift does not create world access;
- removed member loses command authority and reconnect;
- principal/persona/private inventory isolation;
- cross-tenant, cross-world, and cross-timeline attacks;
- replay and export preserve action/persona/object references;
- deletion redacts or removes personal data without corrupting world history.

### 13.3 Browser and accessibility tests

- invite/accept/enter/reconnect;
- Caretaker disclosure and participant list;
- observer space navigation and actor-follow outcomes without implied persona/object movement;
- private Talk versus public Say audience isolation and attribution;
- inventory keyboard and screen-reader path;
- pickup/drop/give/use success, denial, stale conflict, and retry;
- two clients converge on object and tree state;
- causal inspector explains action and authority safely;
- mobile layout and reduced-motion behavior.

### 13.4 Fault matrix

Inject failure:

- after invite acceptance before persona response;
- after action reservation before command dispatch;
- before/after journal commit and before response;
- at every cross-space transfer state;
- during SpaceDO restart, hibernation, or deploy;
- after membership removal with a live socket;
- during policy revision and stale command retry;
- during export/deletion and inventory disposition.

No failure may duplicate an object, lose an acknowledged mutation, broaden a permission, change an attribution root, or leave a stale member able to act.

### 13.5 Capacity evidence

Qualify:

- large dormant membership/persona sets;
- one million logical actors/objects in target-scale world fixtures with bounded hot cells;
- invitation and reconnect bursts;
- hot-room chat/action fanout;
- inventory query and effective-policy latency;
- quadtree leaf promotion and SpaceDO routing under measured pressure.

This evidence is a supported envelope, not a claim that all actors can be active or visible simultaneously.

---

## 14. Observability and evidence

Canonical queries must answer:

- Which principal and persona initiated this action?
- Which actor, rule, scheduler, workflow, or tool executed it?
- Which authority decision allowed or denied it, under which policies?
- What is the causal root and immediate cause?
- Who owned and possessed this object before and after the action?
- Which room/cell/authority owner serialized the mutation?
- Did retry, reconnect, or transfer recovery change the result?
- Which data is safe for the requester to see?

Metrics include invitation/entry state, active presences, reconnects, actions by type/outcome, policy-evaluation latency, denial reasons by safe code, inventory depth/capacity, transfer recovery, stale conflicts, moderation events, and attribution coverage. Alert on any committed mutation lacking valid attribution or authority evidence.

---

## 15. Explicit non-goals

Wave 11 does not implement:

- cross-world runtime object portability, passports, federation, foreign custody, or player-carried imports;
- cross-world persona reputation, inventory, memory, currency, or social graph;
- a global public user directory;
- marketplace, trading economy, escrow for money, or object monetization;
- unrestricted arbitrary scripts attached to objects;
- one process or Durable Object per logical actor;
- billing, pricing, sponsorship, payment collection, or wallet balances;
- provider Organizations as worlds;
- default visible avatars or forced embodiment;
- global chat or global event order.

---

## 16. Exit evidence checklist

- [ ] World and workspace membership are independently authorized and tested.
- [ ] Better Auth reference and optional Clerk adapters resolve the same internal principal behavior.
- [ ] Every active participant has a durable world persona; Raccoon World defaults to disclosed Caretaker.
- [ ] Presence is reconstructible and never owns durable membership/persona/inventory truth.
- [ ] Every committed or denied mutation has valid action, attribution, authority, causal root, and immediate-cause evidence.
- [ ] Persona inventory is world/timeline local and survives disconnect/replay.
- [ ] Effective mobility inherits world → space → role/persona → archetype → instance, narrow-only, deny-wins.
- [ ] Mobility and use capabilities are independent.
- [ ] Cross-world container and transfer attempts are rejected by schema, application, and database constraints.
- [ ] Concurrent pickup/drop/use and cross-space transfer pass idempotency and crash recovery.
- [ ] Removal/suspension invalidates active authority and applies an explicit inventory disposition policy.
- [ ] Alice/Bob axe journey passes through deployed browser/runtime/journal/replay/inspector paths.
- [ ] Privacy, moderation, RLS, deletion/export, accessibility, load, and fault suites pass.
- [ ] The Wave 11 qualification manifest is archived.

---

## 17. Handoff to Wave 12

Wave 12 consumes immutable action and authority evidence but adds a separate sponsorship decision:

```text
authorship/causation -> Wave 11 attribution
permission           -> Wave 11 authority decision
variable-cost units  -> metering/rating
who pays             -> Wave 12 sponsorship policy
admission            -> Redis operational wallet
accounting truth     -> PostgreSQL immutable ledger
money collection     -> Stripe adapter
```

The sponsor may be the world owner, participant workspace, promotional grant, operator fund, or no one. A sponsor decision never changes who performed the action or who owns the object. Deterministic simulation remains independent of billing availability.

---

## 18. Current primary references

- `clockgrove-prd-v0.5.md`
- `clockgrove-cloudflare-implementation-plan.md` v3.9
- `clockgrove-adr-world-personas-and-object-mobility-policy.md`
- Better Auth documentation: https://www.better-auth.com/docs
- Cloudflare Durable Objects documentation: https://developers.cloudflare.com/durable-objects/
- Cloudflare WebSocket hibernation API: https://developers.cloudflare.com/durable-objects/best-practices/websockets/

This plan is complete only when the qualified social-world path preserves identity, authority, causation, and object conservation under concurrency and failure—without introducing cross-world object transfer or depending on billing.
