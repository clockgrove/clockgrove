# Bounded component catalog

The owned entrypoint `src/components/catalog/index.ts` exports
`createInitialComponentCatalog()` and the eleven production state schemas and inferred
state types. The factory returns an immutable tuple in the order below. Each descriptor
has `type`, `version`, `schema`, `canonicalCodec`, `validateState`, `redact` and
`upcasters`. Descriptors are self-contained and import no registry or resolver. Public
package re-exports and the WorldState adapter belong to the integration consumer.

| Stable type | Supported version | Complete supported state |
| --- | --- | --- |
| `clockgrove.identity` | 1 | `objectId: ObjectId`, `displayName: string`, `aliases: readonly string[]`, optional `owner: PrincipalId` |
| `clockgrove.archetype` | 1 | `archetype: {id: string, version: number}`, `traits: readonly {id: string, version: number}[]` |
| `clockgrove.spatial-transform` | 1 | `spaceId: SpaceId`, `pose: SemanticPose`, optional `locationId: ObjectId` |
| `clockgrove.needs` | 1 | Existing `WorldNeeds`: `hunger`, `wetness`, `integratedAt`, `hungerRemainder`, `wetnessRemainder` |
| `clockgrove.weather-exposure` | 1 | `rainProtection: number`, the existing shelter protection quantity |
| `clockgrove.containment` | 1 | `kind: "object" \| "persona-inventory"`, `capacity: number`, optional `containerId: ObjectId` |
| `clockgrove.resource` | 1 | `kind: "food" \| "water"`, `quantity: number` |
| `clockgrove.lifecycle` | 1 | `status: "active" \| "retired" \| "dead"` |
| `clockgrove.portal` | 1 | `status: "open" \| "closed"`, `endpoints`: a tuple of two places (see [Portal component](#portal-component-rw-0104)) |
| `clockgrove.presentation` | 1 | `assetId`: kebab-case string, `animationFamily`: `idle`, `walk`, `sniff`, `eat`, `play`, `shelter`, `static` or `loop`, `accessibilityLabel: string` |
| `clockgrove.conversation-mode` | 1 | `mode: "cognitive" \| "interpreted" \| "canonical"` (see [Conversation mode component](#conversation-mode-component-rw-0501)) |

All object schemas are closed, including nested references and poses. Missing required
fields, extra fields, explicit undefined, accessors, symbols, cyclic values and non-data
prototypes refuse. IDs reuse `decodeOpaqueId`: nonempty strings without outer whitespace;
ownership is an existing opaque PrincipalId, never a provider identity. Display names,
aliases and reference IDs are nonempty strings of at most 512 UTF-16 code units without
outer whitespace. Alias and trait arrays have at most 10,000 entries. Aliases must be
unique; traits must have unique IDs, including across versions. Versions in pinned
references and poses are positive safe integers. Collections sort by explicit UTF-16
lexicographic comparison, with reference version as the secondary numeric key. Sorting,
parsing, encoding and redaction copy data and never mutate or freeze caller objects.
Returned states and their nested collections are frozen.

`pose` has exactly `frameId: SpatialFrameId`, `frameVersion: number`, and
`coordinates`: a readonly two- or three-element tuple of existing bigint `FixedPoint`
values. Coordinate units, axes and fractional digits come from the declared frame;
the catalog invents no coordinate unit. Fixed-point values can be negative. The codec
and schema retain the existing scenario decoder's maximum decimal length of 256
characters, including a negative sign. The context frame must match ID, version and
dimension; existing `validateSpatialBinding` validates its frame declaration. Space
and location IDs remain opaque references; this slice does not prove containment,
movement, shelter existence or cross-object referential integrity.

Needs and rain protection are integer basis points in the inclusive range 0–10,000.
Numbers must be safe integers and negative zero refuses. `integratedAt` is existing
`SimTimeMs`, bigint internally, bounded to 0 through `2^63 - 1` and no later than the
context's simulation time. Both remainders are nonnegative bigint. Hunger remainder
is strictly less than `2^63 - 1`; wetness remainder is strictly less than
`(2^63 - 1) * 100,000,000`. These preserve `validateWorldState`'s existing integration
denominator bounds. They do not claim validation against an unspecified policy's
particular decision interval.

`CanonicalCodec<T>` exposes `encode(value: T): string` and
`decode(canonical: string): T`. It operates on the registered state and emits compact
versioned JSON with the envelope keys in the exact order `type`, `version`, `state`.
State keys follow the table's order; pose keys are `frameId`, `frameVersion`,
`coordinates`, and reference keys are `id`, `version`. Optional fields are omitted
when absent. Bigint fields use canonical decimal strings: `0`, positive decimal
digits without leading zeros, or a minus sign followed by nonzero digits. Numeric
quantities and versions use JSON integer numbers. No bigint JSON numbers, plus signs,
negative zero, decimal fractions, exponents, padding, alternative escapes, duplicate
JSON keys, extra fields or alternative key/collection order are accepted. Decoding
validates and compares the complete re-encoded string exactly. For example:

```json
{"type":"clockgrove.needs","version":1,"state":{"hunger":10000,"wetness":0,"integratedAt":"99","hungerRemainder":"1","wetnessRemainder":"2"}}
```

`ComponentSnapshot<T>` is readonly `{type, version, state}`.
`ComponentValidationContext` carries tenant, world, timeline and object IDs,
simulation time and spatial frames, with optional `expectedArchetype` and
`expectedTraits` pins. Identity must equal the context object ID. When expected
pins are supplied, Archetype must match them exactly; trait ordering is immaterial.
The components contain no separate tenant/world/timeline fields. The enclosing
composition/application owner must establish that scope, and must supply expected
pins when pin matching is required. These descriptors never resolve references.

Invariant failures have deterministic `{code, path, message}` issues. Schema/data
failures use `invalid-state` with `state` or `state.<field>` paths. Object and expected
pin mismatches use `identity-mismatch`; undeclared frame IDs/versions use
`scope-mismatch` at `state.pose`. Frame validity/dimension failures use
`invalid-state` at `state.pose`, and future integration time uses
`invalid-state` at `state.integratedAt`. Invalid context simulation time uses
`invalid-state` at `context.simulationTime`. Codec/schema parse failures throw;
the registry consumer owns its external refusal envelope.

All eleven descriptors declare `privacyClass: public_scene`. `AccessPolicy` wraps the
existing `PrivacyCeiling` as `privacyCeiling`. `redact` returns a validated immutable
copy only when `allowedCategories` includes `public_scene`, otherwise null. This
includes Identity ownership; this slice has no field-level redaction. Version-one
`upcasters` arrays are explicitly empty and frozen: no predecessor, automatic latest
version or migration compatibility is supported.

The catalog holds descriptors only; registry and composition are [components](components.md)
and [component composition](component-composition.md). What a component does not carry is built
elsewhere: movement in the kernel's [spatial movement](../../kernel/docs/spatial-movement.md),
lifecycle stages, birth and death in `state.lifecycle` ([lifecycle](lifecycle.md)), thirst, comfort
and health in `state.wellbeing` ([wellbeing](wellbeing.md)), pack building and pack migrations in the
world-pack SDK ([source and compatibility](../../world-pack-sdk/docs/source-and-compatibility.md),
[migrations](../../world-pack-sdk/docs/migrations.md)) and genesis in the simulator
([genesis](../../simulator/docs/genesis.md)). Deferred: rest, safety, social and curiosity needs and
temperature effects (Wave 8 RW-0801, RW-0803 and RW-0804; the parent plan §7.8 Needs and Weather rows);
cognition components (the owners the Wave 1 plan §5.2 names: Wave 6 RW-0605 to RW-0607). Presentation is registered by RW-0409; its state is one presentation binding's asset, animation family and
accessibility label, and its first consumer is the runtime's decoding of a world pack's `presentation.json`
bindings. It is not projected into WorldState, so pack state hashes do not depend on it. Not scheduled: SpatialTransform orientation and footprint, which the
parent plan §7.3 lists for this component. No wave plan assigns them to SpatialTransform (Wave 4 §9.2
gives visual entities their own footprint).

`test/canonical-codecs.test.ts` fixes the canonical bytes of a production codec and its
refusal of alternative encodings; pack conformance exercises the rest end to end.


## Containment and material components (RW-0104)

The three appended descriptors retain the closed schema, version-one codec, frozen output,
`validateState`, empty frozen upcasters and `public_scene` redaction contracts above.
Their state keys encode in table order. Containment capacity is a positive safe integer
(1 through 9007199254740991); Resource quantity is a nonnegative safe integer
(0 through 9007199254740991). Fractions, negative zero, bigint quantities, unknown
resource kinds and extra fields refuse. The bounded kinds are `food` and `water`; a
pack cannot declare another kind, and no wave plan adds one. These are material units, without
implicit conversion, quality, decay or ecological behavior. Aggregate conservation uses
bigint totals even when many safe-integer holders exceed the safe-number aggregate range.

Containment's `containerId` is the optional immediate parent, independent of
SpatialTransform's existing `locationId`. An absent parent encodes no `containerId` key.
PersonaInventory uses the same container semantics as an object and remains local to the
partition's world and timeline. `validateState` rejects self-parentage as `invalid-state`
at `state.containerId`. Cross-object cycles, space consistency, capacity, referential
integrity and lifecycle restrictions are enforced by the registered kernel checks.
Lifecycle's single field is the explicit terminal/active status; absent lifecycle in a
legacy physical object means active for checks and adds no field to its projection.
The adapter requires any supplied Lifecycle status and Containment parent to agree with
the effective object's existing timeline metadata; missing components never synthesize
these values. Dormant lifecycle projection remains unsupported.

Exact examples (no additional whitespace):

```json
{"type":"clockgrove.containment","version":1,"state":{"kind":"persona-inventory","capacity":2,"containerId":"parent"}}
{"type":"clockgrove.resource","version":1,"state":{"kind":"food","quantity":0}}
{"type":"clockgrove.lifecycle","version":1,"state":{"status":"retired"}}
```

Each component is optional in partition-state JSON decoding and effective-object projection.
The decoder accepts the same closed state shapes and bounds; new component versions are
selected through catalog snapshots, with unsupported versions refused. Version-one component
states introduce no embedded tenant/world/timeline/partition fields: enclosing scope remains
authoritative. Old component encodings and projections without these fields remain identical.
No implicit upcast or default component materialization occurs. Lifecycle birth, aging and death
transitions are now owned by `state.lifecycle` and the kernel (RW-0109); Lifecycle component version 1 is
unchanged. Mobility policy and the Mobility component are built by Wave 11 §7 ("Object mobility and
personal inventory"); the Wave 1 plan §5.2 names the owner of every other planned component that is
not registered here. `object.retire` is
the explicit fixture retirement operation described in the kernel.

## Portal component (RW-0104)

`clockgrove.portal` version 1 is the ninth descriptor, appended last; it keeps the closed schema,
version-one codec, frozen output, empty frozen upcasters and `public_scene` redaction contracts
above. Its state is `status` then `endpoints`, a tuple of exactly two places. A place is
`{kind: "anchor", anchorId}` or `{kind: "region", regionId}` (names as above), each with optional
`worldId` and `partitionId`; when present they must name the enclosing world and partition,
because a version-one portal never crosses worlds or partitions (cross-space transfer is
Wave 11). Endpoint keys encode in that order and optional keys are omitted when absent:

```json
{"type":"clockgrove.portal","version":1,"state":{"status":"open","endpoints":[{"kind":"anchor","anchorId":"fence-gap"},{"kind":"region","regionId":"snack-house"}]}}
```

`ComponentValidationContext` gains an optional `partitionId`, which the WorldState adapter
supplies. `validateState` (`portalScopeIssues`) returns `cross-world` at
`state.endpoints[i].worldId`, `cross-partition` at `state.endpoints[i].partitionId` (when the
context names a partition) and `self-link` at `state.endpoints[1]` for two equal places.
Unknown places need the partition's anchors and regions, which the context does not carry:
`validateWorldState` runs `validatePortals`, which throws a `CompositionError` whose `code` is
`unknown-endpoint`, `cross-world`, `cross-partition` or `self-link` and whose `path` is under
`state.entities[i].portal.endpoints[j]` (`.anchorId`, `.regionId`, `.worldId`, `.partitionId`
or the endpoint itself). The adapter projects the component to the optional `entity.portal`
field, so states without portals keep their encoding. Open/close/use and the portal navigation
graph are in the kernel's [spatial movement](../../kernel/docs/spatial-movement.md#portals-graph-3).

## Conversation mode component (RW-0501)

`clockgrove.conversation-mode` version 1 is the eleventh descriptor, appended last; it keeps the closed
schema, version-one codec, frozen output, empty frozen upcasters and `public_scene` redaction
contracts above and has no invariants. Its state is `mode`, drawn from `VOICE_MODES` in
`@clockgrove/contracts`, the same vocabulary as a conversation session's voice mode
(`packages/persistence/src/postgres-conversations.ts` and the runtime conversations). The meanings
are Wave 5 §6.3: `cognitive` is the actor's subjective communication, `interpreted` is a narrated
interpretation where the object is not sentient, and `canonical` is an authorized explanation from
world evidence.

```json
{"type":"clockgrove.conversation-mode","version":1,"state":{"mode":"interpreted"}}
```

The adapter accepts an object carrying it and does not project it to a `WorldEntity` field, so
world state and hashes are unchanged; no pack declares it yet.
