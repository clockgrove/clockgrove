# Platform reference fixture

A neutral integration fixture covering nested spaces, portals, needs, resources, weather,
lifecycle, cognition, rules and capability commands. The independent beacon fixture remains
at `worlds/fixture`, so conformance continues to prove that different actors and capabilities
work with the same engine.

The pack ID is `clockgrove.fixture-hall@1.2.0`. Mobile actors are `fixture.companion`,
`fixture.dependent` and `fixture.keeper`; their lexical order preserves deterministic scheduling.
Scenario assertions retain exact physical values. Derived child, successor, command and planning
identities change with their neutral input identities.

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
