# Perception and audiences (RW-0105b)

`resolveAudience(event, sourceState, policy, options?)` is a pure, versioned function (resolver
version `clockgrove-audience-resolver@2`, exported from the kernel index). It returns
`{ok:true, value}` or `{ok:false, error}` and never throws, including when an injected
`spatialIndexFactory` (never hashed) throws. The `event` has exactly the keys `version` (1),
`type` (a perceivable movement, containment, object or resource event), `eventId`, `modality`
(`sight`, `sound`, `smell`, `touch`, `social`, `system`, `interpreted`), `sourceRevision`
(bigint), `spaceId`, `actorId`, `targetId` (at least one set) and `regionIds`. The `policy` has
exactly `version` (2), `modalities` (declared integer ranges), `occlusions`, `access` (`deny` or
`reduce` per observer), `subscribers` and `viewers`. Policy version 1 also carried `spaces`, parent
links the policy author declared; version 2 drops them because ancestor places now come from the
state's declared semantic hierarchy, and a version 1 policy is `unknown-event-version`. Only the
state at the event's `sourceRevision` is read; any other revision is a `revision-conflict`.

The value holds `perceptions` (one per included world observer, each with a SHA-256
`hash` of the canonical resolver version, event identity, observer, modality, detail level and
reason), `reasons` (one record per candidate: outcome, a single reason code, every naming source,
detail level and reduction) and `clientInterest` (inputs for subscribed viewers plus a hash).
All lists are sorted by observer id and the value is deep-frozen with byte-identical canonical
output for identical input.

Candidate sources, each also the inclusion reason code: `direct-target`, `event-actor`,
`containing-space` (the container of the actor, else target), `space-contents` (active entities
in the event space), `nearby-peer` (entities inside the event's regions, by exact region
membership via the spatial index), `ancestor-space` (entities standing in an ancestor place of the
subject's place in the state's semantic hierarchy, see below) and `explicit-subscriber`. Exclusion
codes: `modality-range` (a non-participant outside the declared range, or with no declared range;
the range applies to every observer named only by `space-contents`, `nearby-peer` or
`ancestor-space`, the sources that depend on where it stands), `declared-occlusion` (observer and modality),
`privacy-excluded` (`deny` access) and `viewer-unsubscribed`. Access `reduce` keeps the observer
included at detail level `reduced` with reduction code `privacy-reduced`. Inactive (dead or
retired) entities are never candidates.

Ancestor places use graph 5, the semantic hierarchy the state's regions declare through their
`parent` references ([spatial contracts](../../domain/docs/spatial.md#semantic-hierarchy-and-dwell)).
The subject (the actor, else the target) stands in `placeOf` its pose; its ancestor places are that
place's `regionAncestors`. An observer is an `ancestor-space` candidate when the place it stands in is
one of them: in the reference fixture, an observer in the neighbourhood outside the living hall, for an
event in the living hall. A source state whose hierarchy has an unknown parent or a cycle is
`invalid-input` at `sourceState.spatialRegions[i].parent...`.

A viewer is not a world observer: viewers produce only client-interest inputs and never
perceptions, and an unsubscribed viewer is excluded with `viewer-unsubscribed`.

Refusals (frozen `{code, path, check?}`, never thrown):

| Code | Path | Check |
| --- | --- | --- |
| `invalid-input` | `event`, `sourceState`, `policy` or the offending field path | none |
| `unsupported-input` | `event.type`, `event.modality`, `policy.modalities[i].modality`, `policy.occlusions[i].modality` | none |
| `unknown-event-version` | `event.version`, `policy.version` | none |
| `revision-conflict` | `event.sourceRevision` | `perception.source-revision@1` |
| `precondition-failed` | `event.actorId`, `event.targetId`, `policy.subscribers[i].observerId`, `policy.occlusions` (an occlusion names an unknown observer), `policy.access` (an access entry names an unknown observer) | `perception.observer@1` |
| `precondition-failed` | `event.spaceId` (no entity of the state is in that space) | `perception.space@1` |
| `precondition-failed` | `event.regionIds[i]` | `perception.region@1` |
| `handler-failed` | `resolver` (any non-refusal exception) | `perception.resolver@1` |

The shared `fullRuntimeEvidence` adds a `perception` section built from the named `perception`
random stream (seed `perception-audience-v1`), identical in Node and Workers, with a bounded
`comparison` summary, all in `perception.json` and validated by `test/spatial-evidence.ts`; see
[Evidence report files](evidence.md#evidence-report-files).

Consumer: the scene stream decides each socket's audience through the viewer path (issue 810, see
[server-decided audiences](../../../docs/protocols/realtime-projection.md#server-decided-audiences)).

Deferred (not part of RW-0105b): client delivery and networking (Wave 4 RW-0402, "Space WebSocket
runtime"); cognition and memory (Wave 6 RW-0605 and RW-0606); rule dispatch (Wave 7 RW-0702,
"Durable rule reactions"); rendering (Wave 4 RW-0405, "Phaser isometric scene"). The attention factor
is built by Wave 6 RW-0605; partition mapping belongs to Wave 11's per-space state split.
