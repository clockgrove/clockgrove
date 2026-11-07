# Spatial contracts

## Spatial encoding choices

The canonical sources require versioned 2D/3D semantic frames, declared fixed-point units and
axes, a fixed-point origin, an optional parent transform, and a gravity convention. They do not
prescribe the concrete field encodings. This package therefore makes these implementation choices:

- coordinates and transform coefficients are signed `bigint` values branded as `FixedPoint`;
- a unit declares a non-empty semantic name and a decimal `fractionalDigits` scale;
- vectors are dimension-specific tuples, and transforms use a translation tuple plus a square
  row-major basis matrix;
- axes are ordered, named positive directions with unique semantic names;
- gravity is a constant fixed-point vector (the zero vector represents no gravity);
- origin is an explicit vector in every frame.

These choices are provider-neutral and are not quotations from the product specifications.
Renderer nodes, tiles, quadtree cells, navmesh polygons, provider placement, and runtime placement
remain optional non-canonical references and never replace object, subject, or actor-process IDs.

## Regions, anchors and movement records (RW-0105a)

The domain owns the pure, deterministic spatial vocabulary; routing, the spatial index and
command execution live in the kernel. All data is fixed-point `bigint`:

- `SpatialFrame` is `{frameId, version, dimensions (2 or 3), unit {name, fractionalDigits},
  axes {axes[]}, origin, gravity {kind: "constant-vector", vector}, parentFrameId?,
  parentTransform? {version, translation, basis}}`. `validateSpatialFrame` throws
  `DomainValidationError` unless: the version is a positive safe integer; the unit name is
  non-empty and `fractionalDigits` is an integer from 0 through 18; origin, gravity vector and
  axes each have exactly `dimensions` entries; axis names and positive directions are non-empty
  and axis names are unique; `parentFrameId` and `parentTransform` are declared together; a
  frame is never its own parent; and the transform has a positive safe-integer version, a
  translation of `dimensions` entries and a square `dimensions` x `dimensions` basis. A region
  and an object pose refer to a frame by `frameId` and `frameVersion`.
- `SpatialRegion` is `{regionId, version, frameId, frameVersion, shape}` with a circle, an
  axis-aligned rectangle, a simple counter-clockwise polygon (at most 64 vertices) or a 3D box.
  Every boundary is inclusive. `parseSpatialRegion` throws `DomainValidationError` with a `path`
  property for clockwise, self-intersecting, degenerate, fractional or extra-field input.
- `AnchorGraph` holds sorted anchors and undirected edges; an edge cost must be at least the
  floor of the straight-line distance, so a straight-line heuristic stays admissible.
- `MovementRecord` (`entity.movement`) stores the waypoints, start time, speed, `initialInside`,
  `exitedAtStart`, the crossings emitted so far and the prior movement for lineage, plus
  `portalSteps` (`{portalId, from, to, waypoint}`) only when the route takes a portal.
  Leg duration is `ceil(floor(length) * 1000 / unitsPerSecond)` milliseconds; positions use
  floor interpolation; crossing times use exact rational parameters rounded half up once. A
  portal step is crossed when the mover leaves the near anchor of the leg into its `waypoint`
  (`legDeparture`: the first millisecond whose interpolated position differs from that anchor);
  emitted crossings are region records or `{kind: "portal", portalId, time}`, the portal crossing
  first at an equal time.
- A Portal (`entity.portal`, the `clockgrove.portal` component) joins two anchors or regions of
  the partition; `portalEdges` gives the open portals' links over one anchor graph,
  `portalSides` the anchor-edge components that portals separate and the anchor a point attaches
  to, and `validatePortals` refuses unknown places, self-links and other worlds or partitions (see
  the [component catalog](component-catalog.md#portal-component-rw-0104)).
- Eight `movement.*` events and `portal.opened`/`portal.closed` (version 1) are applied by
  `reduceWorldEvent`; each movement reducer refuses an event that is not the next expected
  crossing, or whose position or lineage disagrees, and `movement.portal-crossed` and new portal
  steps also need the portal open. `validateWorldState` re-derives every pose and crossing, so
  replay validates itself.

Region and graph collections are optional state fields; states without them keep their
previous canonical encoding and hash.

## Semantic hierarchy and dwell

The semantic place hierarchy is graph 5 of the Wave 1 spatial model (plan §5.5), kept apart from
containment (graph 1), portals (graph 3) and region geometry (graph 4): a region's place in it is
declared, never inferred from nested shapes.

- A `SpatialRegion` may carry `parent: {regionId, version, worldId?, timelineId?}`, a versioned
  reference to its semantic parent region; a region without one is a root. `parseSpatialRegion`
  refuses a malformed reference (`DomainValidationError` at `<region>.parent...`).
  `validateWorldState` runs `validateSemanticHierarchy`, which throws a `CompositionError` with a
  stable `code` and a `path` under `state.spatialRegions[i].parent`: `unknown-parent` at `.regionId`
  (no such region) or `.version` (another version), `cross-world` at `.worldId`, `cross-timeline` at
  `.timelineId` (when present they must name the state's world and timeline), and `parent-cycle` at
  `.parent` for a region on a cycle. `semanticHierarchyIssues(regions, scope, path)` returns all of
  them, ordered by region index as a number (`[2]` before `[10]`), then path and code, so the first
  is at the first offending region; the world-pack SDK checks the graph across a pack's spaces, where the world is not known yet.
- `regionAncestors(regions, regionId)` lists a region's semantic ancestors, nearest first.
  `placeOf(regions, frameId, frameVersion, coordinates)` is the place a point stands in: of the
  regions containing it, the one with the most ancestors, ties by ascending region id. Containment
  of the point stays geometric; which containing region is the place, and what encloses it, is
  semantic. The kernel's audience resolver takes its `ancestor-space` candidates from these.
- A pack space resource may carry `parent: {id, version}`, naming another space of the pack as its
  semantic parent ([collections](../../world-pack-sdk/docs/collections.md)). World state holds no
  space records, so this level of the hierarchy is pack data until spaces are partitioned (Wave 11).
- A region may declare `dwell: {durationMs}`, a positive simulation-time span. Staying inside the
  region that long after entering it fires the kernel's keyed remain-in-region schedule and
  `movement.region-remained {objectId, regionId, regionVersion, enteredAt}` (see
  [spatial movement](../../kernel/docs/spatial-movement.md#remain-in-region-schedules)). Its reducer
  changes only revision and time: it refuses the event unless the object is active, the region
  declares a dwell, the time is exactly one dwell after `enteredAt`, and the object
  `remainsInside` the region from `enteredAt` to the event time. `remainsInside` reads the
  movement record, not how far it was observed: the crossings by that time are the ones an active
  movement's route implies, journaled or not (else the journaled ones); the last entry among them
  is at `enteredAt` (or, with none in the current movement, `enteredAt` is not after its start); and
  the object is inside at that time, by those crossings while the movement is under way, else by
  the route's end or its pose.
  `isArrivalExit` names the exit a movement's crossing stream reports at completion for a region its
  last waypoint lies inside.

Regions without `parent` or `dwell` keep their canonical encoding.
