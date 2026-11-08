# Spatial frames, regions, routing and movement (RW-0105a)

Three commands at version 1, owner `clockgrove.movement`, `expectedRevision: required`:
`movement.start {objectId, destination, unitsPerSecond, observeUntil?}`,
`movement.interrupt {objectId, at}` and
`movement.replan {objectId, at, destination, unitsPerSecond, observeUntil?}`. A destination is
`{kind:"anchor", anchorId, graphVersion}` or `{kind:"pose", pose}`. All numbers are bigint
fixed point (units per second, coordinates) or bigint simulation milliseconds; fractional or
`undefined` values never reach the domain. Eight events (`movement.started`,
`movement.region-entered`, `movement.region-exited`, `movement.region-remained`,
`movement.portal-crossed`, `movement.interrupted`, `movement.replanned`, `movement.completed`) each
have exactly one reducer; movement state is the `entity.movement` record, an optional field so
existing state hashes are unchanged.

Regions are circles, axis-aligned rectangles, simple counter-clockwise polygons and 3D boxes
with inclusive boundaries. Crossing times are exact rational segment parameters rounded half up
once (`legStart + round(duration * n / d)`); a boundary touch emits entered then exited at the
same time. Interruption and replan keep lineage (`priorMovementId`, `initialInside`,
`exitedAtStart`) so a replan never repeats an entry or exit. Routing is A* over the anchor graph
joined with the open portals (fixed-point costs, ties by ascending anchor id, see
[Portals](#portals-graph-3)); an unreachable goal is a refusal. The
`SpatialIndexPort` has exactly three operations, all taking the index epoch first:
`update(epoch, {op: "insert"|"remove", binding})` (binding = object id plus semantic pose;
returns the ids whose binding changed), `query(epoch, region)` (ascending ids of bindings whose
pose lies within the region's inclusive bounds) and `summarize(epoch, cellRef)`. A
`SpatialIndexFactory` takes an epoch and returns a fresh, empty index: a new epoch means a new
instance, and any other epoch passed to an instance throws `RangeError`. The production
adapter is the loose quadtree (`createQuadtreeSpatialIndex`, kind `loose-quadtree`, version 1,
32 levels over the fixed-point plane); the alternate implementations are test-owned.

A cell reference is structured and scoped to one index epoch:
`{indexKind, indexVersion, indexEpoch, level, mortonCode}`. `summarize` throws `RangeError` for
a reference of another kind, version, epoch, level or malformed code. A summary is
`{cellRef, bounds, count, countBound, inputs: {objectCount, mutationCount}, thresholdsVersion,
classification}`, where `classification` is `hot`, `warm` or `dormant`, derived only from
`inputs` by the versioned `SPATIAL_THRESHOLDS` (version 1: countBound 1024; hot at 8 objects or
16 mutations; warm at 2 objects or 4 mutations). Cell references and summaries never enter
canonical state, events, commands or object identity. Movement narrows region candidates by
binding each region at its bounds' centre and querying the route bounds widened by the largest
region half-extent. `WorldKernelInput.spatialIndexFactory` selects the adapter and is not
hashed. The domain reducers validate against every region, so a faulty index is refused
(`handler-failed` when it throws, `reducer-failed` when it misses a crossing), not trusted.

| Command | Payload | Events | Preconditions | Invariants |
| --- | --- | --- | --- | --- |
| `movement.start` | `objectId`, `destination`, `unitsPerSecond`, `observeUntil?` | `movement.started`, then crossings up to `observeUntil`, then `movement.completed` if reached | `movement.active-object@1` (object active, no active movement), `movement.route@1`, `movement.timing@1` (`observeUntil` not before start) | `movement.event-authority.movement.start@1`, `movement.events-ordered-and-unique@1`, `movement.crossings-consistent@1`, `movement.scope@1` |
| `movement.interrupt` | `objectId`, `at` | crossings up to `at`, then `movement.interrupted` | `movement.active-object@1` (active movement), `movement.timing@1` (`at` inside the active segment) | `movement.event-authority.movement.interrupt@1` plus the shared three |
| `movement.replan` | `objectId`, `at`, `destination`, `unitsPerSecond`, `observeUntil?` | crossings of the prior movement up to `at`, `movement.replanned`, new crossings, `movement.completed` if reached | `movement.active-object@1` (unfinished movement), `movement.route@1`, `movement.timing@1` | `movement.event-authority.movement.replan@1` plus the shared three |

Refusals (always returned, never thrown):

| Code | Path | Check |
| --- | --- | --- |
| `invalid-input` | `payload`, `payload.<field>[.<nested>]` for any malformed, extra, fractional or out-of-range field | none |
| `unknown-command-version` | `command.payload.schemaVersion` | none |
| `revision-conflict` | `command.expected.partitionRevision` | none |
| `precondition-failed` | `payload.objectId` (unknown, retired or dead object; start while active; interrupt without an active movement; replan without an unfinished movement) | `movement.active-object@1` |
| `precondition-failed` | `payload.destination.anchorId`, `payload.destination.graphVersion`, `payload.destination.pose.frameId` (unknown frame or frame mismatch with the object), `payload.destination.pose.frameVersion`, `payload.destination.pose.coordinates`, `payload.destination` (unreachable) | `movement.route@1` |
| `precondition-failed` | `payload.at` (before world time or outside the active segment), `payload.observeUntil` (before the start) | `movement.timing@1` |
| `invariant-violated` | `events[i].type` (event authority per command), `events[i].simulationTime` or `events[i]` or `state.simulationTime` (ordering and uniqueness), `state.entities[i].movement.emitted[j]` (duplicate or reversed crossing), `events`, `state.<collection>`, `state.entities` (scope) | `movement.event-authority.<command>@1`, `movement.events-ordered-and-unique@1`, `movement.crossings-consistent@1`, `movement.scope@1` |

`parseSpatialRegionAtBoundary`, `parseAnchorGraphAtBoundary`, `parseMovementRecordAtBoundary`
and `parseMovementPayloadAtBoundary` wrap the throwing domain validators and return an
`invalid-input` refusal whose path is the validator's canonical path, or `input`.

The shared `fullRuntimeEvidence` adds a `spatial` section built from the named `movement`
random stream. Every entry carries `input` (type, version, commandId, encoding, inputHash,
preStateHash, randomStateHash, indexImplementation) and `output` (success: eventTypes,
eventIds, crossings; refusal: code, path, check; query: candidates; always postStateHash).
Every command and region query is emitted once per index implementation (`loose-quadtree`,
`linear-test`) and the paired outcomes must be equal. The fixed named refusal cases
(unknown anchor/frame/frame version, unreachable, retired, dead, frame mismatch, malformed
payloads, invalid regions and graphs, `handler-failed`, `reducer-failed`) and a 3D climber
crossing the `tree-box` are always present. `spatial.json` holds the Node and Workers `spatial`
bodies and its bounded `comparison` summary (`equal`, `nodeHash`, `workersHash`, `registryHash`, `finalStateHash`, `entryCount`);
the executable schema (`test/spatial-evidence.ts`) validates this file with the rest of the report
directory; see [Evidence report files](evidence.md#evidence-report-files).

## Portals (graph 3)

The portal navigation graph is graph 3 of the Wave 1 spatial model (plan §5.5), kept apart from
containment, regions and the anchor graph's own edges. A portal is an object carrying the
`clockgrove.portal` component ([component catalog](../../domain/docs/component-catalog.md#portal-component-rw-0104))
that joins two places of one partition, each an anchor or a region, and is `open` or `closed`.
For routing over an anchor graph an anchor endpoint stands for itself and a region endpoint for
every anchor of that graph inside the region. `portalEdges` lists, for one graph, the links of the
open portals of active objects, each costing the floor of the straight-line distance (so the A*
heuristic stays admissible); a closed portal, a retired or dead portal object and two anchors at
the same coordinates contribute none. The router walks anchor edges and these links alike. Among
equal-cost routes it takes the smallest next anchor id, then an anchor edge before a portal, then
the smallest portal id. A closed portal therefore gives a deterministic reroute when another route
exists, and otherwise the existing `unreachable` refusal (`precondition-failed` at
`payload.destination`, `movement.route@1`; routine decisions exclude the target as
`unreachable`).

Portals also bound moves that do not start on an anchor or that end at a pose, which otherwise
travel straight. `portalSides` splits a graph into its anchor-edge components ("sides"); a side
is guarded when a portal, open or closed, joins it to another side. A point attaches to the
anchor at its coordinates; else, inside portal-endpoint regions, to the nearest of their anchors;
else to the nearest anchor outside those regions (ties by ascending id). When a move's start and
destination attach to different sides and either side is guarded, the move goes straight to the
start's anchor, then over the anchor and open-portal graph to the destination's anchor (and
straight on to a pose destination), or is refused as unreachable as above. A move between points
of one side, or between unguarded sides, still travels straight: regions are not obstacles (see
the out-of-scope list below), so a pack keeps a portal's region off such lines.

A route that takes a portal records `portalSteps` (`{portalId, from, to, waypoint}`, in route
order) on its movement record; records without one keep their encoding. The mover crosses a
portal when it leaves the step's near waypoint: at the first millisecond of that hop at which its
interpolated position has moved off the near anchor (`legDeparture`), where it emits
`movement.portal-crossed {objectId, movementId, portalId}`. A mover on the near anchor has
therefore never crossed, and one anywhere past it always has, so an interruption, replan or death
during the hop leaves the crossing recorded exactly when the mover has passed the portal.
Crossings are emitted where region crossings are, in the §6 step 6 position of every command and
`world.advance` group; at an equal time the portal crossing comes first, so the hop's region
crossings follow it. The domain reducer accepts a crossing only as the next one the route
implies and only while the portal is open, and accepts a new movement's portal steps only when
each is a hop of its anchor path through a portal that is open then.

Three commands at version 1, owner `clockgrove.portal`, `expectedRevision: required`:

| Command | Payload | Events |
| --- | --- | --- |
| `portal.open` | `portalId` | `portal.opened {portalId}` |
| `portal.close` | `portalId` | `portal.closed {portalId}` |
| `portal.use` | `objectId`, `portalId`, `unitsPerSecond`, `observeUntil?` | as `movement.start`: `movement.started` (a one-hop route from the anchor the actor stands on, through the portal, to the anchor it joins; the smallest id when a region endpoint offers several), `movement.portal-crossed`, the hop's region crossings, `movement.completed` if reached |

Refusals are `precondition-failed` with the `portal.<check>@1` check (malformed payloads are
`invalid-input` at `payload.<field>`, as for movement):

| Check | Path | Condition |
| --- | --- | --- |
| `portal.active-object@1` | `payload.portalId` | the portal object is retired or dead |
| `portal.active-object@1` | `payload.objectId` | `use`: the actor is unknown, retired, dead or already moving |
| `portal.known@1` | `payload.portalId` | no object with a Portal component has that id |
| `portal.reachable@1` | `payload.portalId` | `use`: the portal is closed, or does not lead away from where the actor stands |
| `portal.state@1` | `payload.portalId` | `open` of an open portal, `close` of a closed one |
| `portal.timing@1` | `payload.observeUntil` | `use`: before the world time |
| `portal.transit@1` | `payload.portalId` | `close` while an active movement still has to cross the portal |

Invariants: `portal.event-authority.<command>@1` (`events[i].type`); `portal.use` also runs
`movement.events-ordered-and-unique@1` and `movement.scope@1`; and the global
`portal.transit-open@1` refuses any command after which an active movement still has to cross a
portal that is not open (`state.entities[i].movement.portalSteps[j]`), for example retiring the
portal object mid-route. A portal can close behind a mover that has crossed it, even while it is
still on the hop. Actors therefore cross only through open portals, and reach a guarded side
only through them. The raccoon pack's `fence-gap-portal` scenario routes through, closes and
reopens the yard's gate, refuses the kit's moves into the snack house while the gate is closed,
and interrupts Stevie on the gate hop.

## Remain-in-region schedules

A region that declares a dwell (`dwell: {durationMs}`, see the
[spatial contracts](../../domain/docs/spatial.md#semantic-hierarchy-and-dwell)) gets one keyed
schedule per object inside it. Its id is `dwellScheduleId(objectId, regionId)` (`dwell_` and the
FNV-1a 64 of the pair, independent of any command), kind `movement.region-dwell`, priority 20 (after a
`world.decision` due at the same time), tie-break key the canonical `[objectId, regionId]`, class
`exact`, payload `{schemaVersion: 1, objectId, regionId, regionVersion, enteredAt}` and due time
`enteredAt + durationMs`. The kernel keeps these items current from the events it emits, in every
command and in `world.advance`, and records each change as a schedule mutation:

- `movement.region-entered` into a dwell region upserts the object's item; a re-entry supersedes a
  pending item under the same key, so an object never has two dwells in one region.
- `movement.region-exited` cancels it, except the exit a movement's crossing stream reports at its
  completion for a region its last waypoint lies inside (`isArrivalExit`): arriving is not leaving.
- `movement.region-remained`, `lifecycle.died` and `object.retired` cancel it.

An item falls due after every other event at its due time. If the object has stayed inside since
`enteredAt` (`remainsInside`, read from its movement record at the due time: an active movement's
route decides, whether or not its crossings were observed that far, so `observeUntil` never changes
the answer), the kernel emits `movement.region-remained {objectId, regionId, regionVersion,
enteredAt}` at the due time; otherwise it only cancels the item. `world.advance` drains to the
earliest queued dwell as it does to a lifecycle time, fires it, and continues; a drain whose groups
arm a dwell inside it restarts there. A movement or portal command fires every object's dwells
inside its event stream: before any of its events at a later time, and, when it moved the world
time, at its end for those due by its final time. A command therefore never leaves a dwell due in
the past. It does not run the utility system, so a `world.decision` due before its final time is
moved to that time, with the matching idempotency key, and the next `world.advance` runs it first;
no decision is left due in the past either. `movement.scope@1` lets a remain event name an object
other than the mover, since the event changes only revision and time. The
reducer accepts the event only for an active object that has stayed inside a declared dwell region
for exactly one dwell since the entry its movement lineage last made, by the same rule, so replay
validates itself. The queue check accepts these items beside one
`world.decision` per living actor, each well formed against the state and not yet due in the past.
The raccoon pack's `street-dwell` scenario covers an object that dwells, one that leaves first and
one that re-enters, with equal events under live and fast-forward progression.

## World time a move passes

A movement or portal command that moves the world time also applies every environment and ecology
time it passes, inside its own events: day/night phase changes, weather transitions (with every
actor and plant integrated first), spoilage, appearance and plant stage changes. They come from a
run of the phase, weather and ecology systems over the command's span and are emitted by the same
group emitter `world.advance` uses, so each lands at its exact time, before the command's own
events at that time, and live stepping and fast-forward stay identical. The actors' exposure and
wellbeing crossings, routine movers, lifecycle and decisions stay with `world.advance`. The event
authority of every moving command (`movement.start`, `movement.interrupt`, `movement.replan`,
`portal.use`) allows these events (`environment.phase-changed`, `weather.transitioned`,
`needs.changed`, `wellbeing.integrated`, `growth.integrated`, `growth.stage-changed`,
`resource.spoiled`, `resource.appeared`), and `movement.scope@1` lets them name other objects and
change their needs or resource, and the weather. The raccoon pack's `boundary-walk` scenario moves
Stevie across dusk (`movement.start`), dawn with spoilage and appearance (`movement.interrupt`), the
end of a rain segment (`movement.replan`) and a herb stage change (`portal.use`), live and
fast-forward, with equal final states.

Perception and audiences are built ([Perception and audiences](perception.md), RW-0105b).

Deferred (not part of RW-0105a): portal and dwell rule triggers (Wave 7 RW-0701, whose plan §5.1
lists "geofence/portal enter/leave/dwell" triggers; the Wave 1 [rule primitives](rules.md) trigger on
events, schedules, thresholds and geofences only); client networking (Wave 4 RW-0402) and rendering
(Wave 4 RW-0405). Partition mapping (graph 2), placement and
promotion, and crossing between partitions or spaces belong to Wave 11's per-space state split (the
Wave 11 plan's §3 amendment of 2026-10-19): until it lands, each world partition is one
authority, as Wave 3 runs one SpaceDO per world partition, and `partitionId` is a scope field only.
Mobility policy and the `pickup`, `drop`, `give`, `place`, `remove`, `move_within_space` and
`cross_space` verbs are built by Wave 11 §7 ("Object mobility and personal inventory").

Not scheduled by any wave plan: continuous collision and obstacle avoidance (Wave 1 §12 excludes
navmesh tooling and physics-engine authority), dynamic edge costs, persistence of the index, and
cross-frame transforms of regions.
