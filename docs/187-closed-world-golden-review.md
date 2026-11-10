# Issue 187: closed-world physical golden review

This final migration follows the [golden review workflow](../packages/simulator/docs/conformance.md#golden-review-workflow). Generated `.actual.json` bundles are reviewed for physical changes, passing assertions, material equivalence and replay before their exact bytes replace committed goldens. No visual/media golden changes.

## Pack version and identity reseed

The committed reference pack content change raises its minor version from `1.1.0` to `1.2.0`, as required by the maintainer's 2026-10-27 issue 802 decision in the [SDK compatibility contract](../packages/world-pack-sdk/docs/source-and-compatibility.md#compatibility-rules). Its major `@1` pin stays; the independent beacon pack stays `1.1.0`. Scenario, long-run and presentation metadata name the new reference version.

The re-seeded projection is `7d5566d2618ab656c01a6187cb412c52311ac26250b8ec43816d35aa441e7522`. Derived command, planning, movement and lifecycle identities change with the pack version. Embedded planning selectors and exact snapshots are re-recorded using corresponding native runs; their actor, instant, features and selected-action claims remain unchanged. The two decision-shadow final-state hash literals become `596e793addb709bb59d87f0d28e2f29ecd2ab318dbe48ce70e8428767f1447ad`; replay and all other shadow expectations stay intact. All fourteen reference goldens are regenerated and reviewed through `.actual.json` for this version, retaining every cause and parity assertion. Every run retains exactly the reviewed closed-world `1.1.0` event counts and final per-holder resource quantities; the version reseed changes identities and hashes.

## Authored inventory and causes

The reference fixture declares a household store in its own disconnected `fixture.zz-household-store` space, with finite initial food and water inventories of 4096 units each. This is an explicit authoring choice: sufficient to exercise a simulated year of the existing daily quantities, while transfers always debit it and exhaustion refuses rather than regenerates material. The separate space keeps off-screen household stores outside resident perception and routes.

Four household food processes and one water process retain the old source cadence and requested quantities, attributed to `fixture.household`, using ordinary `resource.transfer` from the matching store. Transfers into an occupied perishable batch refuse normally. The water bowl additionally collects rain at one water unit per hour at full rainfall, capped at six units; no evaporation is declared in this fixture. Existing non-yielding fixture plants retain their growth policy; finite plant yield is proved by the native plant journey. The old rule intents now transfer from the finite household food store; simulator rules remain recorded, not executed.

Every accepted native simulator transition runs the kernel's registered post-state invariants, including the per-holder resource balance, in full and summarised recording. External driver results are independently rechecked before recording; native results already pass that identical registry inside the executor. Both boundary-walk and walk-crossings keep their existing final-state equivalence and add a separate physical-causes event equivalence over process attempts, transfers, weather collection/removal, spoilage and growth yield. Material equivalence includes process attempts, transfers and weather collection/removal; zero-delta weather integration is incidental bookkeeping and is excluded equally from full and summarised material event views.

## Native ecology reference

The native food reference uses finite food/water reserves of 20/12 units. It transfers 10 food and six water at time 0, consumes four food and six water at 2000 ms, spoils the six remaining food at 3000 ms, transfers the remaining ten food and six water at 4500 ms, and consumes ten food at 6000 ms and six water at 7000 ms. All four holders contain zero at 10000 ms. Rain changes no water because this native fixture declares no collector. Spoilage is earlier than the old source fixture because arrival is now time 0 rather than 1000 ms. The food material hash includes transfer events as physical causes.

Reviewed native food material hash: `4b1cec5f49e5de4a73ca09c54c6c0a3956226434082aebf0c29da9885680a195`; state hash: `0d16048f434a14072b36c38396fbcde2df4ca40972739debf004719321005640`. Cedar material/state hashes remain unchanged. Source-specific schema cases now assert stable legacy-source refusal; finite stage yield retains hostile quantity exception coverage.

## Scenario review

Every generated reference bundle passed all authored assertions, all declared equivalences and native replay before copying. All runs contain zero `resource.appeared` and zero `resource.offered` events. Initial state, policy and artifact hashes change because the household stores, processes and collector are declared pack content. Every derived bundle hash changes accordingly. The independent beacon fixture and its golden are unchanged.

The counts below are the main run: old scheduled appearances → new finite transfers, and new weather integrations (including zero-delta bookkeeping). They are review evidence, not a claim that appearances and transfers are interchangeable.

| Scenario / golden | Old appearances → finite transfers | Weather integrations | Reviewed physical change |
| --- | --- | --- | --- |
| [birth-and-parentage](../worlds/fixture/reference/goldens/birth-and-parentage.json) | 48 → 48 | 93 | Birth, parentage and replay claims remain exact; household debit events and collector integration are added. |
| [boundary-walk](../worlds/fixture/reference/goldens/boundary-walk.json) | 11 → 3 | 116 | Ordinary household transfers refuse during manual movement under the same utility precondition as actor commands (five at 8661600000, four at 8748000000). No unbacked batch spoils or triggers consumption decisions. Exact event counts include process attempts and collector bookkeeping. Live/aggregate physical events and final state agree after bounding speculative threshold lookahead at movement completion. |
| [cedar-growth](../worlds/fixture/reference/goldens/cedar-growth.json) | 81 → 81 | 163 | Plant thresholds and stage counts are unchanged. Planning snapshots move to the same named actors at their new finite-inventory decision instants; exact snapshots/call indices are re-recorded. |
| [death-and-successor](../worlds/fixture/reference/goldens/death-and-successor.json) | 91 → 91 | 163 | Death, successor and attribution assertions remain exact; finite household causes replace appearances. |
| [differential-perception](../worlds/fixture/reference/goldens/differential-perception.json) | 5 → 5 | 3 | Existing differential audience assertions remain exact; household transfers now have their own finite source. |
| [favorite-snack-house](../worlds/fixture/reference/goldens/favorite-snack-house.json) | 11 → 11 | 26 | Keeper still chooses the same snack dish using the same belief and all three memories. Decision indices shift, and the dependent belief is also used within this run; selectors retain the same named snack candidate. |
| [fence-gap-portal](../worlds/fixture/reference/goldens/fence-gap-portal.json) | 11 → 11 | 26 | Keeper still crosses the gate for the snack dish and reroutes to trash when it is closed. The main observation ends one millisecond before the dependent starts another gate transit, retaining the original idle-gate close/open checks. Candidate assertions select the snack action by identity. |
| [food-decay-and-conservation](../worlds/fixture/reference/goldens/food-decay-and-conservation.json) | 18 → 18 | 47 | Two pantry deliveries of four units are ordinary transfers debited from the finite household food store; consumption, spoilage, retries, overdraw and final depletion retain exact values. |
| [months-fast-forward](../worlds/fixture/reference/goldens/months-fast-forward.json) | 205 → 205 | 344 | The total consumption-event count becomes 143 (formerly 142), including an additional water consumption enabled by collection. Rule trace count becomes 311 (formerly 310); lifecycle, plant, replay and cross-shape claims remain exact. |
| [rain-shelter-comfort](../worlds/fixture/reference/goldens/rain-shelter-comfort.json) | 8 → 8 | 18 | The branch fall is still perceived by the exposed observer and out of range of the sheltered observer. Perception assertions select object.created because preceding finite household transfers are now perceivable too; wetness/comfort values remain exact. |
| [social-learning](../worlds/fixture/reference/goldens/social-learning.json) | 15 → 15 | 37 | The dependent still switches from den stash without a belief to the snack dish using the companion-attributed belief and expectation6000. The finite-food cadence puts those decisions at 8812800000 and 8899200000; exact candidate identity is retained. |
| [street-dwell](../worlds/fixture/reference/goldens/street-dwell.json) | 0 → 0 | 26 | One additional dwell record is emitted inside the slow movement as weather collection integration adds a physical scheduling boundary; exact containment, threshold and equivalence claims remain. |
| [walk-crossings](../worlds/fixture/reference/goldens/walk-crossings.json) | 85 → 85 | 235 | Exact crossing/conception/death behavior remains; command event totals increase by the journaled household/weather integration events. |
| [walk-out-of-den](../worlds/fixture/reference/goldens/walk-out-of-den.json) | 5 → 5 | 36 | Existing movement, food-resource, replay and equivalence claims remain exact with finite household and weather causes. |

## Long-run review

The 30-day run proves exact replay and small-step/aggregate event and final-state parity including collection, finite transfers and process attempts. The one-year fixture replaces its scheduled-refill assertion with two journaled rain units at 8989600000 and 8993600000 ms and the household's ordinary capacity refusal at 9007200000 ms. Both execution shapes retain the exact three preceding water consumptions and agree on all material events and final state. The refusal is `ecology.state-matches-policy@1` at `policy.ecology.waterHolders[0].capacity`; the household has no authority to exceed the collector's capacity.


Validation: reference conformance, native simulator cause/genesis/scenario proofs, runtime selection/status/Influence and native Keeper Talk refusal proofs pass. Before the version reseed, the native reference `1.1.0` one-year run passed all nine assertions, material event and final-state parity, and replay (206.9 seconds; peak RSS 540860416 bytes). That `1.1.0` 30-day native run passed its three replay/parity assertions (13.2 seconds).

The coordinator independently decoded all 14 generated reference goldens (25 runs) and accumulated
per-holder food/water deltas from the declared 4096-unit stores. Every intermediate balance was
nonnegative and every final holder exactly matched its accumulated balance; no offer or appearance
event occurred. This review also checked every authored assertion, equivalence and replay result.

Before version reseeding, the closed-world `1.1.0` decision-shadow reference's exact final-state hash was
`b9a6bae6d546261c114cab76ab4c729c9a9033adb068c723821e039ead76cd8d`, replacing
`66fe54f533fbcae9ac8a2b17de71ff310503c5512489f3a41e65b3a43f158455` because the
reference pack includes the finite stores and processes. Its labelled choices, sampling, cost,
privacy and replay assertions remain unchanged. The small CLI diff fixture no longer schedules
sources; its eighth reported differing path is now `needs.changed` rather than
`movement.started`, retaining the exact ordered eight-path diff assertion.

Final `1.2.0` conformance, shadow/genesis and short-horizon Node/workerd qualifier proofs pass after reseeding. Integrated native Node horizon results also pass all observable long-run checks, all assertions, material-event/final-state equivalence and replay:

| Horizon | Duration | Peak resident memory | Existing budget |
| --- | --- | --- | --- |
| 30 days | 7.708 s | 344039424 bytes | 12.8 s / 448 MiB: within |
| One year | 115.805 s | 516292608 bytes | 134.4 s / 760 MiB: within |

The timing and memory limits are unchanged from `WAVE1_LONG_RUN_BUDGETS`. Full Node/workerd Wave qualification remains its existing separate workflow; these are native Node full-horizon observations and Node/workerd conformance/short-horizon proofs.

Native process-verdict reuse retains no world snapshots, is limited to actual validated nested
commands within one execution, and never authorizes a command. Standalone verification disables
the private cache and independently replays/checks the journal. Before the minor-version reseed,
pre/post-optimization 30-day/year bundle bytes were identical.
