# Clockgrove Architecture Decision: World Personas and Inherited Object Mobility

**Status:** Accepted  
**Decision date:** August 16, 2026  
**Applies to:** PRD v0.5.3, implementation plan v3.4, and Waves 0–12 where identity, attribution, containment, timelines, UI, or billing consume these contracts  
**Supersedes:** Wave 11 cross-world portable-object and federation design  

---

## 1. Context

Clockgrove needs a human user model that supports observer/caretaker play, MUD/MOO-style participation, durable identity, room-local interaction, inventory, privacy, and immutable action attribution.

It also needs ordinary object movement without requiring policy edits on every object. World owners should be able to establish defaults once, let rooms and roles inherit them, and add sparse restrictions for exceptional spaces, actors, archetypes, or instances.

Cross-world runtime object portability is not in scope. An object may move among rooms, containers, actors, and persona inventories inside one world. It does not retain live identity while crossing to another world.

---

## 2. Decision

Clockgrove will implement:

1. a durable `WorldPersona` for each participating principal and world membership;
2. a world- and timeline-scoped `PersonaInventory` represented through the ordinary containment model;
3. object mobility inside one world, including room-to-room and SpaceDO-to-SpaceDO handoff;
4. inherited, monotonic mobility policy beginning at the world and narrowing through spaces, subject roles/personas, archetypes, and rare instance restrictions;
5. immutable `AuthorityDecision` evidence for every accepted or denied movement command;
6. no cross-world passports, federation trust domains, issuer signatures, live custody transfer, or cross-tenant object authority protocol.

---

## 3. Human identity model

```text
Principal (global account identity)
  └─ WorldMembership (authorization to participate)
       └─ WorldPersona (durable identity inside this world)
            ├─ Presence (ephemeral connection)
            ├─ Space anchor (current room/space)
            ├─ PersonaInventory (world/timeline container)
            └─ controlledActorId? (optional embodied actor)
```

The persona, membership, inventory, and attribution survive disconnects. Presence does not.

A persona has a space anchor even when it has no walking avatar. This is the minimum embodiment needed for coherent audience, speech, perception, pickup, drop, and room-transition rules.

Initial persona modes:

| Mode | Intended use | Actor perception |
| --- | --- | --- |
| Caretaker | Initial Raccoon World observer/operator | Explicitly disclosed, normally unrendered; world policy determines whether actors perceive its actions |
| Visitor | MUD/MOO-style invited participant | Named world persona with a space anchor and world-local inventory |
| Resident | Persistent participant with broader world capabilities | May be rendered or attached to an actor later |
| Controlled actor | Optional future embodiment | Persona delegates actions through a specific actor subject to both policy sets |

The external authentication profile is not automatically the world persona. A person may use a world-specific display identity subject to moderation and disclosure policy while remaining internally attributable to the same principal.

---

## 4. Object mobility scope

Use `mobility` for movement inside a world. Reserve `portability` for cross-world or cross-installation transfer, which is out of scope.

```ts
type MobilityScope =
  | "anchored" // cannot change physical containment through ordinary play
  | "space"    // movable within the current room/space only
  | "world";   // may enter inventory and move between rooms in this world
```

Examples:

| Object | Default mobility |
| --- | --- |
| House, tree, trash can | `anchored` |
| Chair, garden rock, movable room fixture | `space` |
| Axe, food, note, ordinary carried item | `world` |

Mobility does not grant use. Carrying an axe and invoking `tool.chop` are separate authorization decisions. The target tree and destination world rules still determine whether chopping is valid.

---

## 5. Inherited policy model

### 5.1 Policy chain

```text
World defaults
  → Space/room restrictions
    → Role/persona restrictions
      → Object archetype ceiling
        → Rare object-instance restriction
```

Most rooms, personas, and object instances store no custom mobility policy. They inherit the resolved parent policy and the object archetype’s intrinsic mobility scope.

Each layer may narrow inherited authority. It may not silently widen a parent denial or exceed the object archetype ceiling. This monotonic rule makes policy resolution predictable, cacheable, and safe.

If a world needs an exception, define it intentionally at the governing parent as a named, versioned policy condition or capability grant. Do not repair a broad denial by editing hundreds of child objects.

### 5.2 Actions

The initial mobility actions are:

- `object.pickup`
- `object.drop`
- `object.give`
- `object.move_within_space`
- `object.cross_space`
- `object.place_in_container`
- `object.remove_from_container`

Object use remains separately authorized, such as `tool.chop`, `container.open`, or `food.consume`.

### 5.3 Sparse policy contract

```ts
type PolicyValue = "inherit" | "allow" | "deny";

interface ObjectMobilityPolicy {
  pickup: PolicyValue;
  drop: PolicyValue;
  give: PolicyValue;
  moveWithinSpace: PolicyValue;
  crossSpace: PolicyValue;
  placeInContainer: PolicyValue;
  removeFromContainer: PolicyValue;
}

interface MobilityPolicyBinding {
  policyId: PolicyId;
  policyVersion: string;
  scopeType: "world" | "space" | "role" | "persona" | "archetype" | "object";
  scopeId: EntityId;
  rules: Partial<ObjectMobilityPolicy>;
}
```

Omitted values mean `inherit`. An object instance should carry a binding only when it is genuinely exceptional.

---

## 6. Resolution algorithm

For a requested pickup, drop, give, containment change, or room crossing, the server:

1. resolves the authenticated principal, world membership, world persona, and optional controlled actor;
2. loads the world’s default policy version;
3. applies restrictions from the source space ancestry and destination space ancestry;
4. intersects the persona/role/controlled-actor capabilities;
5. applies the object archetype mobility ceiling;
6. applies any explicit object-instance restriction;
7. validates ownership/possession, current containment, expected revisions, capacity, lifecycle, and physical invariants;
8. records one allow or deny `AuthorityDecision` with the complete version set and reason code;
9. commits an allowed transition as an attributed command/event through the ordinary journal boundary.

An explicit denial or failed invariant wins. Client-supplied ownership, role, policy, or permission claims are ignored.

The result should be explainable in plain language, for example:

> Denied: visitors cannot drop carried objects in this private room under `private-bedroom-policy@3`.

---

## 7. Default policy profile

The starter profile should minimize configuration:

- the world allows ordinary world-mobile objects to be picked up, carried between public rooms, and dropped;
- room policies inherit without storing a row;
- private or protected rooms add sparse visitor restrictions;
- visitor personas can manipulate public/unclaimed objects but not owner-locked objects;
- residents receive broader defaults through their role;
- anchored and space-local archetypes enforce their intrinsic ceiling everywhere;
- gifts require an explicit `object.give` command and acceptance/transfer policy;
- dropping an object changes possession/containment but does not silently transfer ownership;
- object use requires its own capability and target authorization.

---

## 8. Example: the axe

1. `axe_01` is created inside Alice’s world from an archetype with `mobility: "world"`.
2. Bob joins Alice’s world using a visitor `WorldPersona`.
3. Bob legitimately obtains `axe_01`; it enters Bob’s inventory for Alice’s world.
4. Bob crosses from the porch to the yard. World and room policies inherit; `object.cross_space` is allowed.
5. Bob drops the axe. The yard accepts ordinary world-mobile objects, so containment changes from Bob’s inventory to the yard.
6. Alice picks it up after an expected-revision check.
7. Alice invokes `tool.chop` on a tree. This is evaluated separately against Alice, the axe, the tree, and the yard policy.
8. The journal can answer who picked up, carried, dropped, and used the axe, which policies allowed each action, and what downstream events followed.

The axe never crosses `worldId`. Entering another world gives Bob a different world persona and inventory for that world.

---

## 9. Timelines and replay

Persona inventories and object containment are canonical world/timeline state:

- a preview timeline receives branch-local inventory and containment projections;
- preview pickup/drop/use cannot modify live inventory;
- intent-only promotion revalidates new live commands against current possession, containment, and policy;
- replay uses the recorded policy/version inputs and `AuthorityDecision` evidence;
- world export/import may copy data administratively, but imported objects receive semantics appropriate to the destination world and are not live portable objects.

---

## 10. Consequences

### Benefits

- No per-object permission maintenance for ordinary items.
- One policy mechanism governs rooms, personas, roles, archetypes, and exceptional instances.
- World owners can establish defaults and add sparse restrictions.
- The same model supports an unrendered caretaker and later embodied visitors.
- Inventory, movement, use, and attribution remain deterministic and inspectable.
- Removing federation and cross-world custody materially reduces Wave 11 scope and security risk.

### Costs and constraints

- A persona needs a durable space anchor even without an avatar.
- Policy/version resolution must be available in the authoritative command path.
- Cached resolutions require invalidation when any ancestor policy changes.
- Monotonic inheritance intentionally prevents child scopes from casually widening parent denials.
- Cross-world object travel would require a new ADR and protocol rather than an incremental flag.

---

## 11. Required document changes

- **PRD v0.5:** add the world-persona model, world-local inventory, mobility terminology, inherited policy, and no-cross-world-portability decision.
- **Wave 1:** make mobility scope, containment, inventory, and policy-resolution inputs foundational kernel contracts.
- **Wave 2:** record attribution and `AuthorityDecision` evidence with movement commands/events.
- **Wave 4:** expose policy-aware disabled actions and understandable denial reasons.
- **Wave 10:** provision world personas through world membership, not authentication-provider organizations.
- **Wave 11:** remove federation/passports/cross-world custody and implement personas, inherited mobility, room handoff, world-local inventory, concurrency, moderation, and the local axe demonstration.
