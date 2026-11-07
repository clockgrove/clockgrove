# Genesis

## Genesis bundle

Top-level fields, all always present (the bundle is the canonical document hashed into `bundleHash`):

- `kind`: `clockgrove.genesis-bundle`.
- `version`: `1`.
- `simulatorVersion`: `SIMULATOR_VERSION`.
- `engineVersion`: the world-pack engine version the bundle was seeded with.
- `artifact`: the eight fields of the pack artifact reference (`packId`, `version`, `contentHash`,
  `engineCompatibility`, `resourceManifestHash`, `assetManifestHash`, `migrationSetHash`,
  `buildToolVersion`).
- `world`: `{ tenantId, worldId, timelineId, partitionId }`, pure functions of `packId` and `version`
  (never of `contentHash`, which covers the expected seed projection hash).
- `clock`: the pack clock policy.
- `cognitiveSeeds`: the pack cognitive seed entries.
- `genesisCommandId`: the id of the genesis step, derived from `packId` and `version`.
- `seedCommands`: `{ key, type, version, commandId }` for each seed command in manifest order; each
  `commandId` is derived from `packId`, `version` and the seed key, so it is pairwise distinct from
  `genesisCommandId` and every other id.
- `events`: every kernel event in seed command execution order.
- `decisionTraces`: the kernel decision drafts of the seed commands, in execution order.
- `schedules`: the schedule queue after seeding.
- `counters`: `{ seedCommands, events, schedules }`.
- `state`: the world state after the last seed command.
- `initialStateHash`: SHA-256 of the canonical bytes of the state before any seed command.
- `seedProjection`: `{ expected, actual }`, equal in every successful bundle.
- `randomState`: the kernel `serializeNamedRandomState` string of the pack random streams after
  seeding.
- `finalStateHash`: SHA-256 of the canonical bytes of `state`.
- `bundleHash`: SHA-256 of the canonical bytes of the bundle without this field.

The initial state has revision 0, simulation time equal to the clock policy epoch, a frame for every
declared space (plus their regions and anchor graphs) and exactly one entity for each actor with a
`placement`, in actor id order, resolved by the domain from the pack definitions.

When the behaviour policy declares optional sections, the initial state also carries their records, each
produced by the domain rules and checked with the domain `*Disagreement` helpers (a disagreement is
`INVALID_INITIAL_STATE` at `manifest`). Packs without these sections are unchanged.

- `environment`: `deriveEnvironmentState(policy.environment, epoch)`. `weather.rainIntensity` stays 0 until a
  seed command or the kernel changes it.
- `ecology`: one `perishables` entry per policy holder, in policy order, with `arrivedAt` equal to the epoch
  when the holder entity holds a positive food quantity and `null` otherwise; one `plants` entry per policy
  plant with `stage` 0 (`plantStageIndex` at 0), `growingMs` 0, `wetness` 0, `wetnessRemainder` 0 and
  `integratedAt` equal to the epoch.
- `wellbeing`: one entry per needs actor in object id order with `thirst` 0, `thirstRemainder` 0,
  `health` 10000, `healthRemainder` 0, `comfort` from `deriveComfort` (with thirst 0 and the actor's needs)
  and `integratedAt` equal to the actor's `needs.integratedAt`.
- `utility`: no state of its own; see scripted cognition below.
- `lifecycle`: one entry per needs actor in object id order. `householdId`, `parentIds`, `generation` and
  `bornAt` come from the actor document `lifecycle` seed; `stageIndex` is
  `deriveLifecycleStage(policy.lifecycle, bornAt, epoch)`; `conceptions` is 0, `lastBirthAt`, `gestation`
  and `death` are `null`. `households` lists the distinct household ids, sorted. A needs actor without a
  seed is `INVALID_INITIAL_STATE` at `manifest.actors[<index>]#lifecycle`; `parentIds` that name an
  undeclared actor, an actor without needs, the actor itself or more than two parents are refused at
  `manifest.actors[<index>]#lifecycle.parentIds`; a `bornAt` after the clock epoch at
  `manifest.actors[<index>]#lifecycle.bornAt`.

**Actor lifecycle seed.** An actor document may carry
`lifecycle: { householdId, parentIds, generation, bornAt }` (the SDK checks its shape). Only actors with
needs use it, and only when the policy declares `lifecycle`.

**Scripted cognition.** A cognitive seed document `{ type: "clockgrove.scripted-cognition",
schemaVersion: 1, entries }` seeds `state.scriptedCognition` (`{ schemaVersion: 1, source: "scripted",
entries }`) when the policy declares `utility`: the entries of all such seeds are merged and sorted by
`ref`. Without any such seed the state has no `scriptedCognition`. Seeds of any other `type` do not change
the state. Refusals are `INVALID_COGNITIVE_SEED`; see `refusal-codes.md`.

An entry may carry an optional `attributedTo` (an object id: the actor the evidence came from). It is accepted
only on `belief` entries, never equal to the entry's `actorId`, and must name an actor with needs. Otherwise
genesis refuses `INVALID_COGNITIVE_SEED` at the entry's field path (`manifest.cognitiveSeeds[i]#...attributedTo`
or `#entries[j].attributedTo`). An attributed entry is never effective when its `effectiveAt` is after the
attributing actor's death (see the kernel `utility-decisions.md`). Session, private-memory, relationship and
knowledge-access policy at death is built by Wave 8 RW-0802 (Wave 8 §5.1, "Death").

## Seeding

`seedGenesis` runs these checks in order and stops at the first refusal:

1. Input shape: a plain record with exactly `artifact` and `source`; the artifact has exactly its eight
   string fields.
2. `artifact.engineCompatibility` contains the engine version.
3. The SDK builds `source`; SDK refusals pass through unchanged.
4. Each artifact field is compared with the built artifact (`packId`, `version`, `contentHash`,
   `engineCompatibility`, `resourceManifestHash`, `assetManifestHash`, `migrationSetHash`,
   `buildToolVersion`).
5. A pack with seed commands needs a behaviour policy. Scripted cognition seeds are read and checked.
   Seed payloads are checked to be plain data with a `schemaVersion` equal to the seed version, then the
   initial world state, schedules and random streams are built.
6. Seed commands run in manifest order through `executeWorldKernel` at the epoch, each expecting the
   revision the previous one produced.
7. The seed projection is computed and compared with `expectedSeedProjectionHash`.
8. The bundle is assembled, hashed and encoded.

## Seed projection

The seed projection hash is the SHA-256 of `canonicalBytes` of this document:

```
{
  kind: "clockgrove.seed-projection",
  version: 1,
  state,        // the world state after seeding
  schedules,    // the schedule queue after seeding
  randomState   // serializeNamedRandomState of the manifest streams after seeding
}
```

A pack records the hash in `expectedSeedProjectionHash`; seeding refuses when it differs.
