# Components and the physical world adapter

The package root exports `createComponentRegistry`, `createDefinitionRegistry`,
`resolveEffectiveObject`, `serializeEffectiveObject`, `createInitialComponentCatalog`,
the nine catalog schemas/state types, and the supporting registry and definition types.
See [component composition](component-composition.md) and the
[bounded catalog](component-catalog.md) for precise field and codec contracts.

`createInitialComponentRegistry()` registers the production version-one Identity,
Archetype, SpatialTransform, Needs, WeatherExposure, Containment, Resource, Lifecycle and Portal descriptors. It preserves their
schemas and canonical codecs and bridges the catalog's `{ privacyCeiling }` argument
to the registry's `AccessPolicy` (`PrivacyCeiling`). Registry redaction explicitly checks
`public_scene`; canonical serialization is not a redacted observation. Package-root shared
types refer to the registry contract; the catalog's local shared types remain available
from its own module entrypoint. Schemas validate without changing canonical state: supply
aliases and trait pins already in UTF-16 order when composing through the registry.

Composition requires explicit `{ id, version }` pins. Defaults are followed by recursively
pinned traits, typed whole-component instance replacements, then timeline component state.
Distinct trait writes require identical versioned canonical values or an explicit participating
pinned writer; traversal order cannot choose a winner. No reference floats to a latest version,
and no arbitrary JSON Patch or implicit migration is supported. Bigint values cross codec
boundaries as canonical decimal text; effective-object serialization retains type tags.

`projectEffectiveObjectsToWorldState(base, objects, components?)` projects a complete
effective-object collection into the existing `WorldState`. `base` is the world envelope
without entities; the optional registry defaults to the initial production registry.
The adapter checks tenant/world/timeline/object identity, simulation time, expected pins,
component keys/versions, space, frame and ownership. Identity supplies `objectId`, Archetype
supplies the legacy `id@version` identifier, SpatialTransform supplies space/pose/location,
Needs supplies existing needs, and WeatherExposure supplies shelter protection. Identity,
Archetype and SpatialTransform are required; Needs and WeatherExposure are optional.
The resulting complete world is validated and copied by `createWorldState`, including
duplicate identities and cross-object shelter references. Registry/composition refusals expose
code, path and message; final world validation retains existing `DomainValidationError` diagnostics.

This adapter accepts the nine supported version-one components; Portal projects to the optional
`entity.portal` field ([portal component](component-catalog.md#portal-component-rw-0104)). Explicit Containment and
Lifecycle state must agree with timeline parentage and lifecycle metadata. Legacy objects
without those components retain their byte-identical projection; absent optional state never
materializes defaults. Resource has bounded food/water kinds and safe-integer material units.
The kernel enforces cross-object containment/capacity, lifecycle and conservation invariants. Definition, traits, ownership, capabilities, lifecycle and
timeline revision remain in the immutable effective object even where the legacy projection
has fewer fields. Projection never mutates source definitions or input state, and the existing
historical behavior-pack decoder remains a separate input path.

Pack build and migrations are the world-pack SDK's
([source and compatibility](../../world-pack-sdk/docs/source-and-compatibility.md)), genesis the
simulator's ([genesis](../../simulator/docs/genesis.md)); movement and lifecycle are kernel systems
([spatial movement](../../kernel/docs/spatial-movement.md), [lifecycle](../../kernel/docs/lifecycle.md)).
Cognition components are deferred to Wave 6 RW-0605 to RW-0607 (Wave 1 plan §5.2). This local component
checkpoint does not establish hosted readiness.
