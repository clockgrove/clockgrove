# Executor, reducers and invariants

`createKernel(definition)` binds a pure executor to a command registry, an event registry, a
reducer registry, a precondition registry and an invariant registry. `executeWorldKernel` is
the production world kernel built from those registries. Every outcome is
`{ ok: true, result }` or `{ ok: false, error }`.

## Registering

- **Command**: `commands.register({ type, version, owner, expectedRevision, idempotentNoOp?,
  validatePayload, handler })`. The key is the type plus an integer version of at least 1; the
  version is the command payload `schemaVersion`. The handler emits events through
  `context.emit`, reads `context.workingState()`, and returns a declared `projectionDelta`.
- **Event**: `events.register({ type, version, owner })`.
- **Reducer**: `reducers.register({ type, version, reduce })`. There is exactly one pure
  reducer per registered event type and version, and the reducer defines the authoritative
  state. `verifyReducers` runs inside `createKernel`.
- **Precondition**: `preconditions.register({ name, version, commands?, check })`. The check
  receives the decoded state, command and payload, and returns the offending canonical path
  or `undefined`. It runs before the handler.
- **Invariant**: `invariants.register({ name, version, commands?, check })`. The check receives
  `{ initial, state, events }` after the reducers and returns the offending path or
  `undefined`.

Preconditions and invariants run in canonical `name@version` UTF-16 order. The first failure
is returned and its `check` field names it. The reducers for `weather.changed`,
`needs.changed`, `routine.selected` and `time.advanced` are registered in
`src/reducers/world.ts` and are equivalent to `reduceWorldEvent`. Each world event type is
registered at its current version only (`routine.selected@2`, every other type `@1`); historic
versions reach the reducers through `upcastWorldEvent` (see [utility decisions](utility-decisions.md)).

## Expected-revision policy kinds

- `none`: the command expected revision is ignored.
- `optional`: when present it must equal the partition revision.
- `required`: it must be present and equal the partition revision.
- `continuation-or-optional`: a continuation's `expectedRevision` is used when a continuation
  is supplied; otherwise the command's optional value is used.

The policy is checked before any handler code runs. A mismatch is `revision-conflict`.

## Idempotent no-op rule

A result with zero events is refused with `empty-result` unless the command registration
declares `idempotentNoOp: true`. In the world kernel `world.advance` and the scheduled
`world.decision` are declared, so an advance to the current time with nothing due, an advance
whose decisions all repeat their routines and an unchanged scheduled decision succeed with no
events. A no-op emits no event and so does not advance `simulationTime`; projections integrate forward from
`integratedAt` (see [utility decisions](utility-decisions.md)).

## Provisional event identity

For the event emitted when the partition revision is `r`, `eventIndex` is `r` and
`eventId = createDeterministicIdSource({ ...ids.seed, eventIndex: r }).next("EventId")`.
`commandId` is the originating command's id. Nothing reads time, entropy or the environment;
the same input produces the same identities. The persisted identity is assigned later by the
commit owner.

## Purity and delta verification

The executor compares canonical snapshots of the partition state, payload, random state and
id seed before and after the handler and reducers; any difference is `mutation-detected`.
In `development` and `test` mode (passed explicitly through `{ mode }`, never read from the
environment) the handler's declared projection delta is compared with the delta derived from
the reducers, and a difference is `delta-mismatch`. `production` mode skips that comparison.

## Refusal codes

A refusal is a frozen `{ code, path, check? }`. `path` is a canonical path string and `check`
is `name@version`. Messages, stacks and exception text are never forwarded.

- `invalid-input`: the input, options or payload failed decoding or validation.
- `unsupported-input`: the stimulus kind is neither `command` nor the scheduled `world.decision`
  input (RW-0108a); the path is `input.kind`.
- `unknown-command-version`: no command is registered for the type, or for that version.
- `unknown-event-version`: a handler emitted an event type or version that is not registered.
- `revision-conflict`: the expected revision does not match the partition revision.
- `precondition-failed`: a named precondition returned an offending path.
- `invariant-violated`: a named invariant returned an offending path.
- `delta-mismatch`: declared and reducer-derived deltas differ (development and test).
- `mutation-detected`: an immutable input changed during execution.
- `empty-result`: zero events from a command that is not an idempotent no-op.
- `handler-failed`: the handler threw or returned a malformed output.
- `reducer-failed`: a reducer threw.
- `check-error`: a precondition or invariant threw.
- `duplicate-registration`: the same type or name and version was registered twice.
- `missing-registration-part`: a registration lacks a required part or has an invalid one.
- `unknown-policy-kind`: the expected-revision policy kind is not one of the four above.
- `missing-reducer`: a registered event has no reducer.
- `orphan-reducer`: a reducer exists for no registered event.

Refusals are returned and never thrown; the executor is total for malformed input.
Registration refusals are returned from `register` and `createKernel`.

## Systems, persistence and evidence

Spatial navigation and region crossing ([Spatial movement](spatial-movement.md)), ecology
([Resources and growth](ecology.md)), and portals and open/close/use
([Portals](spatial-movement.md#portals-graph-3)) are implemented. Persistence is outside the kernel,
which performs none (Wave 1 plan §3.2); Wave 2's canonical journal persists its results. The evidence
reports carry an `executor` section with golden and seeded fuzz identities, produced from named random
streams only ([Evidence report files](evidence.md#evidence-report-files)).

## Deferred

- Mobility policy: Wave 11 §7 ("Object mobility and personal inventory").
- Durable rule dispatch: Wave 7 RW-0702 ("Durable rule reactions"). The kernel only evaluates rules
  into command intents ([Rule evaluation](rules.md)).
