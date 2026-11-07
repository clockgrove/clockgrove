# Pure kernel

`@clockgrove/kernel` is the deterministic, side-effect-free core of the world simulation. It
binds registered commands, events, reducers, preconditions and invariants into an executor,
and it holds the pure subsystems built on that executor: containment, movement, perception,
scheduling, environment, ecology, wellbeing, utility decisions, lifecycle and rules. It reads
no clock, entropy or environment, and it returns refusals instead of throwing.

## Usage

Import from `@clockgrove/kernel`; the package entry is `src/index.ts`. The main entrypoints are:

- `createKernel` builds an executor from its registries.
- `executeWorldKernel` is the production world kernel.
- `catchUpSchedules` is the offline scheduler and aggregation engine.
- `resolveAudience` resolves who perceives an event.
- `evaluateRules` turns a transition into typed command intents.
- The named random stream functions initialize, draw, serialize and restore project-owned
  random state.

## Subsystem contracts

Each contract lives in its own document under [`docs/`](docs/):

- [Named random streams](docs/random-streams.md): the seeded, serializable random stream contract.
- [Component evidence](docs/evidence.md): the component fixtures and the evidence report files.
- [Executor, reducers and invariants](docs/executor.md): registries, revision policy, refusal codes.
- [Containment and resource conservation](docs/containment.md): objects, containers and resource totals (RW-0104).
- [Spatial frames and movement](docs/spatial-movement.md): regions, routing and movement (RW-0105a).
- [Perception and audiences](docs/perception.md): audience resolution for events (RW-0105b).
- [Scheduler and offline aggregation](docs/scheduler.md): bounded catch-up of schedules (RW-0106).
- [Environment](docs/environment.md): day/night, weather and exposure (RW-0107a).
- [Resources and growth](docs/ecology.md): food, water, spoilage and cedar growth (RW-0107b).
- [Needs, comfort and health](docs/wellbeing.md): wellbeing systems and scheduled decisions (RW-0108a).
- [Utility decisions](docs/utility-decisions.md): scored decisions and movement choice (RW-0108b).
- [Lifecycle](docs/lifecycle.md): reproduction, aging and death (RW-0109).
- [Rule evaluation](docs/rules.md): rule firing, cooldowns and intents (RW-0110).

## Documentation convention

New or extended subsystem contracts belong in `packages/kernel/docs/`, in the document for
that subsystem or a new one linked from the list above, not in this README.
