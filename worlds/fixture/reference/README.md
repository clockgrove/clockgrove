# Platform reference fixture

A neutral integration fixture covering nested spaces, portals, needs, resources, weather,
lifecycle, cognition, rules and capability commands. The independent beacon fixture remains
at `worlds/fixture`, so conformance continues to prove that different actors and capabilities
work with the same engine.

The pack ID is `clockgrove.fixture-hall@1.6.0`. Mobile actors are `fixture.companion`,
`fixture.dependent` and `fixture.keeper`; their lexical order preserves deterministic scheduling.
Their archetypes declare the `cognitive` Conversation mode, the cedar's the `interpreted` one and the fence gate's the `canonical` one,
so those are the entities Talk addresses, each in its declared voice.
Scenario assertions retain exact physical values. Derived child, successor, command and planning
identities change with their neutral input identities.

The porch, den and cedar hollow are shelters because their archetypes declare `clockgrove.shelter`;
the porch also declares a `coverRadius` of 1000 units, so an actor anywhere within that distance of it is
under it, walking or standing. A keeper setting out from the porch stays under it until its walk crosses
that boundary (`boundary-walk`'s `dawn-walk` and `rain-stop`), and one walking past is under it while it is
within that distance, which delays its uncomfortable wetness crossing mid-walk (`walk-crossings`). The behaviour policy declares its wet-weather reflex, `shelterReflexThreshold: 9000`. The
`favorite-snack-house` keeper's remembered snack dish is familiar, so choosing it out of view raises no
`unperceived-target` planning request (see `cedar-growth`'s `keeper-remembered-*` assertions).

Resources are closed-world: five declared household processes move finite initial food/water
inventory from a disconnected household store through ordinary transfers. The water bowl also
collects rainfall up to its authored capacity. No scheduled source or unbacked offer refills a
holder. Physical changes and authored values are recorded in the
[closed-world golden review](../../../docs/187-closed-world-golden-review.md).

Presentation uses synthetic rectangle placeholders from `../assets`. Their fixture review records
are test data, not approval of artwork for a deployed external world. Normal license, manifest,
atlas, golden and upload refusal checks still apply.

See [conformance](../../../packages/simulator/docs/conformance.md),
[asset pipeline](../../../packages/assets/docs/pipeline.md) and
[world presentation](../../../docs/protocols/world-presentation.md).
