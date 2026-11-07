# Versioned components and pinned composition

This is the component/object foundation checkpoint of RW-0102. The production
implementation is pure domain code: it performs no I/O, reads no ambient clock,
and does not mutate a physical world. Registrations supply validation contracts;
the deterministic simulation and typed application paths continue to own
canonical physical mutation.

The module entrypoints are `src/components/registry/index.ts` and
`src/archetypes/index.ts`. They expose `createComponentRegistry`,
`createDefinitionRegistry`, `resolveEffectiveObject`, and
`serializeEffectiveObject`, together with the supporting types. Package-root
re-exports and the scenario adapter belong to the downstream integration item.

## Registration

A `ComponentSnapshot<T>` is readonly `{ type, version, state }`.
`ComponentMap` is a record keyed by component type; its values are snapshots and
each key must equal the corresponding snapshot's type. Versions are positive
safe integers. Type names and definition identities are nonempty strings without
outer whitespace. Each lookup requires both type and version; there is no latest
version lookup.

`ComponentRegistration<T>` retains the wave-plan contract: `type`, `version`,
`schema: ZodType<T>`, `canonicalCodec: CanonicalCodec<T>`,
`validateState(value, context): DomainIssue[]`, `redact(value, access): unknown`,
and `upcasters`. `CanonicalCodec<T>` has `encode(value: T): string` and
`decode(canonical: string): T`. A registration must use a strict, versioned,
lossless canonical JSON codec. `createCanonicalCodec(type, version, schema)`
provides one such codec. Schemas validate state without coercion, defaults,
stripping, or transformation. Registration callbacks must be pure.

For example, a test or extension author can provide a registration independent
of the initial catalog:

```ts
const schema = z.strictObject({ amount: z.bigint().nonnegative() });
const registry = createComponentRegistry();
registry.register({
  type: "example.quantity",
  version: 1,
  schema,
  canonicalCodec: createCanonicalCodec("example.quantity", 1, schema),
  validateState: () => [],
  redact: (value, access) =>
    access.allowedCategories.includes("public_scene") ? value : null,
  upcasters: [],
});
```

The validation context explicitly carries tenant, world, timeline, object,
simulation time, semantic spatial frames, the expected archetype pin, and all
expected transitive trait pins. Component invariant validators check their own
identity, spatial, time, and quantity semantics against that context. The resolver
also checks object/world/timeline consistency and exact expected definition pins.
Simulation time is nonnegative signed-64-bit bigint milliseconds; timeline
revision is a nonnegative bigint. `AccessPolicy` is the existing `PrivacyCeiling`.
Each registration declares its redaction behavior; the public scene example
returns null when `public_scene` is disallowed. Redaction is an explicit registry
operation, separate from canonical effective-object serialization.

Registry methods are `register`, `lookup`, `validate`, `encode`, `decode`,
`upcast`, and `redact`. State, context, and access values supplied to callbacks
are owned immutable copies. Codec encoding verifies exact state round-trip and
re-encoding; decoding refuses alternative representations. Errors expose `code`,
`path`, and `message` through `CompositionError`, a `DomainValidationError`
subclass. Schema failures use `INVALID_STATE`; invariant failures retain the
declared `DomainIssue.code`, with the component-state path prefixed. When several
issues exist, the first is selected by UTF-16 path, code, and message order.

Each destination registration declares upcasters as
`{ fromVersion, toVersion, upcast(value) }`, with `toVersion` equal to that
registration's version and `fromVersion < toVersion`. Duplicate edges are refused.
`upcast` requires an explicit target version and registered source and target.
It searches only declared increasing edges, trying destination versions in
ascending numeric order, and validates every intermediate result. Unsupported
routes and downgrades refuse. Composition never invokes upcasting automatically.

## Canonical representation and ownership

The domain encoding is independent of the kernel's historical serializer. The
encoding envelope is `{ "version": 1, "value": <tagged node> }`. A scalar node
is `["string", text]`, `["boolean", boolean]`, `["number", integer]`,
`["bigint", canonicalDecimalText]`, or `["null"]`. Arrays are
`["array", nodes]`; records are `["object", [[key, node], ...]]`, ordered by
explicit UTF-16 code units. Numbers must be safe integers excluding negative
zero. Bigint text is `0` or a signed nonzero decimal without leading zeroes;
ordinary decimal strings retain the string tag.

The helper codec encodes a tagged `{ type, version, state }` snapshot inside
that envelope. It refuses whitespace variations, alternative decimal forms,
duplicate record keys, incorrect type/version pins, and other noncanonical
encodings. Plain records and dense arrays are supported; cyclic values,
accessors, symbol keys, undefined, nonenumerable properties, and exotic objects
are refused. Input accessors are never invoked.

`serializeEffectiveObject` encodes
`{ type: "clockgrove.effective-object", version: 1, object }` with this same
domain representation. The effective object includes tenant, simulation time,
the normalized logical definition, every resolved trait pin, and the timeline
state with its final component map. Definition pins, component versions,
lifecycle status, space/container identity, and revision remain explicit.
Output values are recursively copied, sorted, and frozen; caller-owned objects
are neither modified nor frozen. Definition registration also owns a copy, so
later edits to an author's source definition cannot reinterpret existing pins.

## Composition and conflict resolution

Definitions use pinned `{ id, version }` identities. Archetypes contain
`traits` and default `components`; traits contain recursively pinned `traits`
and their own component writes. Register them through `registerArchetype` and
`registerTrait`, or initialize `createDefinitionRegistry({ archetypes, traits })`.
Separate archetype and trait namespaces permit the same text identity in each;
duplicates within a namespace and version refuse. Forward trait references can
be registered, but every reachable pin must exist when resolving. Cycles refuse
before component resolution. A shared trait in a diamond graph contributes once.

Call `resolveEffectiveObject({ components, definitions, definition, state,
context })`. `WorldObjectDefinition` preserves `id`, `worldId`, `archetype`,
`traits`, `overrides`, optional `owner`, and `capabilities`.
`TimelineObjectState` preserves `worldId`, `timelineId`, `objectId`, `spaceId`,
optional `containerId`, `components`, `lifecycleStatus`, and `revision`.
Capabilities are bounded durable declarations `{ id, capabilityId, version }`;
this checkpoint does not install or execute them.

The precedence is:

1. Pinned archetype component defaults.
2. All recursively composed pinned trait writes, including archetype and object traits.
3. Validated instance whole-component replacements (`TypedComponentPatch` snapshots).
4. Explicit timeline component state, validated using the same registrations.

Distinct traits writing one component conflict unless their component versions
and codec canonical values are identical. Trait traversal order cannot select
a winner. Archetypes and object definitions can declare
`conflictResolutions: { [componentType]: { id, version } }`. Every resolution
must name a participating trait that actually writes that component at the
declared pin. An object declaration cannot contradict an archetype declaration.
Unknown components, nonwriters, and wrong writer versions refuse. Even later
instance or timeline replacements cannot hide an unresolved trait conflict.
Duplicate instance replacements refuse; replacements contain a complete state,
never a partial object or arbitrary JSON Patch. A valid replacement may add a
registered component. Omitted timeline components inherit the composed value.

Trait pins, object trait references, overrides, capability bindings, component
maps, and record keys are normalized deterministically. Collections use explicit
UTF-16 ordering, with numeric version as the secondary definition key. Expected
trait pins include the transitive closure, once each. Registering newer component,
archetype, or trait versions never changes an older pinned interpretation.
Branch state may preserve logical object IDs with a different explicit timeline
and matching context, without rewriting source definitions.

Stable boundary codes include `DUPLICATE_REGISTRATION`, `UNKNOWN_COMPONENT_TYPE`,
`UNKNOWN_COMPONENT_VERSION`, `INVALID_STATE`, `UNSUPPORTED_UPCAST`,
`DUPLICATE_DEFINITION`, `MISSING_DEFINITION`, `DEFINITION_CYCLE`,
`TRAIT_CONFLICT`, `INVALID_OVERRIDE`, and `IDENTITY_SCOPE_MISMATCH`.
Invalid instance replacements use `INVALID_OVERRIDE` while retaining the failing
state path. Paths identify pinned traits and quoted component keys; malformed
values fail before participating in composition.

## Bounded evidence

Pack conformance composes every object of the committed packs end to end. The unit
tests (`test/archetypes/`, `test/canonical-codecs.test.ts`) keep only what no pack
reaches: hostile override data, trait conflicts and cycles, prototype-named keys,
UTF-16 ordering, and the canonical codec bytes and refusals.

Composition covers definitions and component state only. The catalog is
[component catalog](component-catalog.md); pack artifacts and genesis are the
world-pack SDK's and the simulator's; containment, capacity and conservation are the
kernel's [containment](../../kernel/docs/containment.md) checks; movement is
[spatial movement](../../kernel/docs/spatial-movement.md). Cognition is deferred to
Wave 6 RW-0605 to RW-0607 (Wave 1 plan §5.2). Local self-containment is refused here;
broader physical invariants belong to those systems. Historical behavior-pack encodings
and kernel semantics are unchanged.
