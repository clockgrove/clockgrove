# clockgrove.green-lake-yard@1.1.0

The Wave 1 reference world: a data-only pack. It holds no code and no engine behaviour. Its
versioned presentation metadata, `presentation.json` (`presentationVersion` 1, issue 813), binds the stable actor
IDs and the scene effects to reviewed asset manifests under `assets/manifests/`
([asset pipeline](../../packages/assets/docs/pipeline.md)); it sits outside the pack source, so no pack or
state hash depends on it. Every value below is a resource the shared conformance suite
([conformance](../../packages/simulator/docs/conformance.md)) builds, runs and checks on Node and on Workers.

## Contents

- **Space** `grove.neighborhood`: one 2-D frame in millimetres. Its rectangle regions declare the semantic
  hierarchy through their `parent` references: Green Lake Neighborhood (`green-lake-neighborhood`, the root)
  → Living Yard (`living-yard`) → Porch (`porch`), Den (`den`), Garden (`garden`) and Cedar Area
  (`cedar-area`); `street-buffer` and `snack-house` are children of the neighborhood. The shapes also nest,
  but perception reads the declared hierarchy, not the geometry. `street-buffer` declares a ten-minute dwell
  (`dwell.durationMs` 600000): an object that stays in it that long gets one `movement.region-remained`. No
  routine route reaches the street, so only the `street-dwell` scenario does. The anchor graph holds
  `den-mouth`, `porch-step`, `trash-front`, `tree-base`, `garden-edge`, `fence-gap` and `snack-door`, joined by
  anchor edges; `snack-door` has none. The only way to it is the portal (`clockgrove.portal`) of the fence gate,
  which joins the `fence-gap` anchor to the `snack-house` region and starts open. Because the gate separates
  `snack-door` from the other anchors, every route to `snack-door` or to a point inside the snack house goes
  through the gate, also from a start that is not on an anchor.
- **Archetypes**: social raccoon (`grove.raccoon-kind`), kit (`grove.kit-kind`), den, porch, food/trash source,
  water source, a cedar hollow shelter, cedar, herb (plant), the weather/day-night sky and a gate
  (`grove.gate-kind`). Both raccoon archetypes carry the `grove.needs` trait.
- **Actors**: Stevie, Gracie and a kit with `lifecycle` seeds (one household; the kit names Gracie and Stevie as
  parents), plus the placed objects: trash can, snack dish, den stash, pantry bin, water bowl, den, porch, cedar
  hollow, cedar, herb, sky and the fence gate (`grove.fence-gate`, carrying the portal).
- **Policies**: one clock policy and one `clockgrove.world-behavior-policy` (`grove-yard-1`) covering the clock
  ratio, a three-day weather cycle with day and night, needs, utility, growth and resources, gestation, aging and
  death. Its utility record declares ambiguity (`score-margin` with `maxMargin` 0, so exact score ties are
  ambiguous, and the novelty condition `unperceived-target`): such a decision still takes its routine choice and
  records one planning request beside its trace, never executed
  ([utility decisions](../../packages/kernel/docs/utility-decisions.md)).
- **Scripted cognition** (`grove.learning`): Stevie's repeated snack-house food access and resulting belief, the
  kit's belief attributed to Gracie, and two kit beliefs attributed to Stevie, one effective before his death and
  one after.
- **Rules**: five rules with event, schedule, threshold and geofence triggers and fanout, depth and cooldown
  budgets. Their intents are recorded with disposition `recorded-not-executed`; none runs.
- **Capabilities**: one binding of each kind (`inspect`, `embodied-dialogue`, `interpreted-perspective`,
  `influence`, `operator-authoring`), each bound to at least one actor.

## Scenarios

Each scenario in `scenarios/` has a golden of the same name in `goldens/`.

| Scenario | What it shows |
| --- | --- |
| `favorite-snack-house` | Stevie's scripted memories and belief; his hungry decision before they take effect picks the trash can, a later one picks the snack dish, with a non-zero `expectation` feature linked to the scripted refs |
| `rain-shelter-comfort` | An exposed raccoon gets wetter and less comfortable under rain, a sheltered one does not get wetter, perception differs by location, and a live run equals a fast-forward run |
| `food-decay-and-conservation` | Food appears, decays and is consumed until depleted; a retried command does nothing twice; quantities never go negative and consumed plus remaining is conserved |
| `cedar-growth` | A continuous live run and an aggregated fast-forward run cross the same cedar stages; Stevie's and the kit's `unperceived-target` planning requests, raised in calls 2 and 6 of the live run (12-hour steps) and in the fast-forward run's one call, are identical in both progressions |
| `birth-and-parentage` | A gestation that spans a restart and a fast-forward ends in exactly one `lifecycle.born`; the child's lifecycle entry names its parents and household; an uninterrupted run is equivalent |
| `social-learning` | The kit holds a belief attributed to Gracie, not a copied memory, and its decision changes once the belief takes effect |
| `death-and-successor` | Stevie dies, takes no later decision, keeps his `objectId` and `archetypeId`, and the successor intent names a distinct id that is no entity; a belief attributed to him and effective after his death never reaches a decision, one effective before it still does |
| `months-fast-forward` | Over 61 simulated days weather changes, plant growth stages, resource consumption and decay, lifecycle stage changes, remaining schedules and rule budget outcomes are recorded, and differently stepped runs are equivalent |
| `differential-perception` | One event gives a nearby, a sheltered, a privacy-reduced (access `reduce`) and an absent actor four distinct perception outcomes; the inattentive case waits for the attention factor (Wave 6 RW-0605) |
| `street-dwell` | Four visitors step into the street buffer: the stroller's remain falls ten minutes after its entry, during its own slow 12-minute stroll along the street; the lingerer stays put and gets one `movement.region-remained` ten minutes after entering; the passer steps back out first, so its dwell is cancelled and never fires; the returner leaves and re-enters, and its one remain counts from the second entry. Live (5-minute steps) and fast-forward progression give equal movement events. Gracie's first decision ties staying with seeking the den she is in: she takes the fallback (the den) and each run records exactly one planning request, the same record in both runs (both reach it in their opening fast-forward step) |
| `fence-gap-portal` | Stevie routes to the snack dish through the open fence gate and crosses it as he steps off `fence-gap`; closing, reopening and using it refuse with stable checks when they do not apply; with the gate closed from the start the snack dish is `unreachable`, he reroutes to the trash can, and the kit's moves from off the anchor graph to `snack-door` and into the snack house are refused; interrupted on the gate hop, Stevie keeps his crossing and the gate can close behind him |
| `boundary-walk` | Stevie's moves pass world time across boundaries, and each boundary lands inside the move at its exact time: a slow street stroll across 6:00 as food appears, his dwell falls due and every deferred decision waits for its end; walks across dusk, across midnight as the rain begins and across dawn as food spoils and reappears (`movement.start`); an interrupt after the rain ends (`movement.interrupt`); a replan as the herb reaches its next stage (`movement.replan`); and a slow trip through the fence gate at dusk as rain begins again (`portal.use`). A replan two days ahead and a walk across the other raccoons' decision time are refused (`movement.passed-time@1`). Live (1-hour steps) and fast-forward runs end in equal final states, revision aside |

`long-runs/` holds the 30-day and one-year qualification scenarios (summarised recording, no goldens, not in
the pack artifact). They run only in the qualification workflow, through `pnpm run qualify:wave1:long-runs`.

## Deferred

Session, private-memory, relationship and knowledge-access policy at death is built by Wave 8 RW-0802 (Wave 8
§5.1, "Death") and is not implemented in Wave 1. The pack and the `death-and-successor` scenario only record that an actor died and that
a successor was intended.

## Regenerating goldens

Goldens are generated once, after all pack content is final, because every golden hashes the same artifact.
Follow the golden review workflow in the conformance document; never edit a golden by hand and never commit an
`*.actual.json` file.
