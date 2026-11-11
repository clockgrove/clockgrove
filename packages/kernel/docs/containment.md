# Containment and resource conservation (RW-0104)

`executeWorldKernel` accepts `ContainmentKernelInput` alongside existing world input. The
shared `CommandEnvelope` and attribution/target/policy/pack/random/id-seed validation remain
in force. The existing eight commands have payload `schemaVersion: 1`, closed field validation, owner
`clockgrove.containment` (object/containment commands) or `clockgrove.resource` (resource
commands), and `expectedRevision: required`. Missing revision is `invalid-input` at
`command.expected.partitionRevision`; a stale revision, including retry against successful
post-state, is `revision-conflict` at that path. There is no zero-event success or implicit retry
application. Version-two payloads refuse as `unknown-command-version` at
`command.payload.schemaVersion`; unknown types use `command.type`. Events carry version 1,
unchanged scope, simulation time, policy versions, sealed attribution and deterministic IDs.
Registered reducers alone derive physical state; each event advances the revision once.

| Command | Complete payload beyond schemaVersion | Semantic event and complete payload |
| --- | --- | --- |
| `object.create` | `object: {objectId, archetypeId, spatial: {spaceId, pose}, containment?, resource?}` | `object.created {object, quantityAdded}`; quantityAdded is zero, object has explicit active Lifecycle |
| `object.retire` | `objectId, disposition: "discard"` | `object.retired {objectId, disposition, kind, quantityRemoved}`; kind is null for nonresource fixtures |
| `containment.put` | `objectId, containerId` | `containment.put {objectId, containerId}` |
| `containment.remove` | `objectId, containerId` | `containment.removed {objectId, containerId}` |
| `containment.transfer` | `objectId, fromContainerId, toContainerId` | `containment.transferred {objectId, fromContainerId, toContainerId}` |
| `resource.offer` | `objectId, kind, quantity` | Stable refusal: unbacked resource creation is forbidden |
| `resource.consume` | `objectId, kind, quantity` | `resource.consumed {objectId, kind, quantity}` |
| `resource.transfer` | `fromObjectId, toObjectId, kind, quantity` | `resource.transferred {fromObjectId, toObjectId, kind, quantity}` |

Object IDs/archetype identifiers are nonempty strings of at most 512 UTF-16 units without
outer whitespace. Pose is the catalog's versioned two/three-dimensional bigint fixed-point
pose in a declared frame. Fixture creation permits only absent or zero-quantity resources and requires a pinned archetype already in the pack,
a distinct identity, a supported space/frame binding, and fewer than 128 existing entities.
It cannot create Needs, Shelter, selected actions, schedules or `locationId`; fixture retirement
refuses Needs actors. This avoids adding later lifecycle/scheduling systems. Containment and
Resource shapes/bounds/redaction are defined in the domain catalog; Lifecycle becomes active
at creation. Optional absent components stay absent. Capacity counts immediate objects,
including nested containers as one child; descendants keep their own space and capacity.
No operation changes physical space. Retiring a shelter evicts whatever active object is in it
(`locationId` names it): each is first integrated through the retirement time under the protection
still in force (`needs.changed`, `wellbeing.integrated`, `growth.integrated` as they change), then
journals `location.changed` to null with the retiring command's id as `planId`, all before
`object.retired`. A retired shelter protects nothing. No other operation changes `locationId`. A put requires an uncontained object;
remove and transfer require the exact current parent. Destination must be an active container
in the same physical space with spare capacity and cannot be self or a descendant. Persona
inventory is an ordinary container kind. Remove detaches only the immediate parent.

Resource command quantity must be a positive safe integer; zero, negative, fractional,
negative-zero, bigint and oversized numbers refuse. Kinds are `food` and `water`, and must
match each holder's existing Resource. Offer is refused under the closed-world contract;
consume subtracts from an active holder with sufficient quantity; transfer
atomically subtracts/adds equal units between distinct compatible active holders with source
availability and target headroom. Exhaustion retains the zero-quantity holder. Retire requires
an active empty fixture, marks it retired, discards its entire recorded quantity and leaves a
zero-quantity Resource. It never deletes identity or transfers ownership. No dead/retired
participant may be put, removed, transferred, offered to, consumed from or retired again.
Terminal objects cannot contain active children or change through later commands.

For each resource kind, exact bigint `after - before` must equal journaled physical additions
(plant yield, weather collection and declared boundary imports) minus consume, retire, spoilage, evaporation and declared boundary export removals.
Transfers balance each source and destination independently. New `object.created.quantityAdded`
is zero; historical creation and offer events retain their reducers for replay only. `object.retired.quantityRemoved` is the entire
prior quantity and records its kind and explicit discard disposition. Transfers and all
containment/world commands have zero net change. Per-command event authority restricts the
allowed event type, so another command cannot mint or destroy through a resource event.

All preconditions return `precondition-failed` with the following `check` names (version 1):

| Check | Stable offending paths and conditions |
| --- | --- |
| `containment.fixture-and-references@1` | `continuation` for unsupported continuation; `state.entities` for create budget; `payload.object.objectId` for duplicate; `payload.object.archetypeId` for unpinned fixture; `payload.object.spatial.locationId` for fixture location; `payload.object.spatial.pose` for invalid binding; `payload.object.containment.containerId` for absent/inactive/noncontainer/full parent; `payload.object.spatial.spaceId` for parent-space mismatch; `payload.<reference-field>` for unknown/dead/retired participant |
| `containment.operation@1` | `payload.objectId` for retiring Needs/nonempty fixtures, missing Containment, or put of an already contained object; `payload.containerId` / `payload.fromContainerId` for wrong source; `payload.containerId` / `payload.toContainerId` for incompatible destination, capacity, self or cycle |
| `resource.closed-world@1` | `payload.quantity` for every offer; `payload.object.resource.quantity` for positive resource creation |
| `resource.available-and-bounded@1` | `payload.kind` for holder-kind mismatch; `payload.quantity` for shortage/overflow; `payload.toObjectId` for self-transfer |

Malformed payloads return `invalid-input` at `payload` or `payload.<field>[.<nested-field>]`;
canonical-data failures use `payload`. The shared executor owns remaining input/refusal paths.
Unknown event versions and injected handler/reducer exceptions retain the existing frozen
refusal envelope, without exception messages or escaping throws.

Globally registered post-state checks run for every command, including `world.advance` and
`world.weather.set`, in the existing canonical check order:

| Invariant | Stable path |
| --- | --- |
| `containment.structure@1` | `state.entities[i].spaceId` for missing/mismatched physical space; `.containment.capacity` for invalid/exceeded capacity; `.containment.containerId` for unknown/inactive/noncontainer parent or cycle (scalar parentage guarantees at most one immediate parent) |
| `object.immutable-scope@1` | `state.tenantId`, `.worldId`, `.timelineId`, `.partitionId` for changed partition scope; `state.entities` for removed identity; `state.entities[i].<scope-field>` for attempted per-object scope injection |
| `object.lifecycle@1` | `state.entities[i]` for changing a terminal object; `.lifecycle.status` for terminal containers with active contents; `.resource.quantity` for retirement without disposition |
| `resource.closed-world@1` | `events[i].type` for offered, appeared or positive-inventory created events in new execution |
| `resource.quantity-conservation@1` | `state.entities[i].resource.quantity` for invalid kind/quantity; `state.resources.food` or `state.resources.water` for unrecorded total change |
| `resource.event-authority.<command-type>@1` (`object.retire@2`) | `events[i].type` for an event outside that command's authorized set (for `object.retire`: `object.retired`, and a shelter's evictions with their integrations) |

Existing world validity/revision/time/needs invariants remain registered. Violations return
`invariant-violated` with `check` and `path`; thrown checks return `check-error` per the shared
executor. Scope lives exclusively on the immutable partition envelope and is inherited by
objects; no new command accepts tenant/world/timeline/partition fields.

## Open, close and use (RW-0104)

The domain-relevant open/close/use commands of RW-0104 act on portals: `portal.open`,
`portal.close` and `portal.use` (owner `clockgrove.portal`, payloads in
`packages/domain/src/commands/portal-commands.ts`, beside the containment payloads). Open and close
change a Portal component's `status` through `portal.opened` and `portal.closed`; use moves an
actor through an open portal. They never change containment, resources, physical space or
`locationId`, and a portal never joins two partitions or worlds. Their events, preconditions,
invariants and the portal navigation graph are specified in
[spatial movement](spatial-movement.md#portals-graph-3).

The shared `fullRuntimeEvidence` entrypoint adds `containment` to Node and real local Workers
reports. Each generated/targeted/retry entry binds command type/version/id, input/pre-state/random
hashes, outcome/refusal or event identities, post-state hash and per-kind before/after totals.
The full registry identity and its canonical SHA-256 accompany it. `comparison.json` retains the
complete containment section as well as runtime equality hashes; every report file stays bounded
to 1 MiB UTF-8. Kernel tests are uncached and receive validator `TMPDIR`, so the single existing
marker always names fresh captured reports. Temporary runtime cleanup and old evidence remain.

Canonical v1 rejects fractional numbers. For malformed inputs only, the evidence declares
`clockgrove-malformed-input-v1`: a lossless recursively tagged tree (record keys sorted by
UTF-16; every primitive tagged by its JavaScript type, numbers spelled with `String` except
negative zero spelled `-0`). Its full `canonicalInput` is recorded and `inputHash` hashes those
exact canonical v1 UTF-8 bytes. Canonically encodable inputs retain the direct canonical-input
hash. There are no missing/sentinel hashes. This test-only representation does not change
production encoding. Fixed-seed generated sequences assert every successful post-state,
resource delta, replay, input retention and retry conflict in both runtimes. Independent final
review must inspect complete fresh report bodies and retained historical comparisons.

## Finite boundary trips

`boundary.exchange` extends the ordinary revision-checked resource command path. Its version-1
payload is `{schemaVersion: 1, boundaryId, actorId, objectId, kind, direction, quantity}`;
`direction` is `import` or `export`. The world must explicitly declare that boundary and eligible
actor, with finite supply and absorption quotas. See [domain ecology](../../domain/docs/ecology.md#declared-boundary-exchanges)
for declaration and balance fields.

One accepted command journals `boundary.departed`, `resource.boundary-exchanged`, and
`boundary.returned`, in that order. The exchange carries `{boundaryId, boundaryName, actorId,
objectId, kind, direction, quantity}`; travel markers carry `{boundaryId, actorId}`. All retain
sealed command attribution and simulation time. The complete trip is atomic and returns to the
same in-world location, so no scheduler observes an actor temporarily outside the map.
The actor must be active and match effective attribution; the resource holder must be the actor
or its contained inventory. A boundary import is a checked journal cause in per-holder and global
resource accounting; an export is a checked removal. Quota exhaustion refuses the command and
changes nothing. Replayed exchange events reproduce both quantities and remaining quotas.

The native boundary journey proves exact finite imports/exports, ordinary actor/carrier checks,
forged-journal rejection, no-declaration refusal and replay/advance parity using fixture-world
inputs. Boundary declarations grant no application permission and introduce no external service.
