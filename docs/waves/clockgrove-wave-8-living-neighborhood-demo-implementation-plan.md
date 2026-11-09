# Clockgrove Wave 8: Complete Living Neighborhood and Demo-Quality Web App

**Status:** Coding-agent implementation specification  
**Version:** 1.6  
**Date:** October 01, 2026
**Parent plan:** `clockgrove-cloudflare-implementation-plan.md` v3.10  
**Product source:** `clockgrove-prd-v0.5.md` v0.5.9  
**Visual reference:** `6897ED26-A7B5-4F5E-8D90-B6524B538626.jpeg`  
**Wave:** 8 of 13  
**Assumptions:** Waves 0–7 are qualified; all platform subsystems exist behind production contracts  
**Development tooling:** external tools such as `clockgrove/factory` may execute and verify this wave through replaceable browser-capable execution environments. No specific workstation, operating system, or tool state is a product/runtime dependency.

---

## 1. Outcome

Wave 8 integrates the platform into one continuously operating, coherent, emotionally legible neighborhood. It completes `green-lake-yard@1`, lifecycle and household behavior, ecology, return summaries, object/space interaction, the reviewed visual/audio pack, demo onboarding and polish, and the complete north-star causal chain.

The wave exits only when:

> A new visitor can enter a cozy rainy Seattle yard, understand that it is alive, watch Stevie and the family behave without constant narration, converse and investigate, influence the world, leave and return, understand what happened, and later see attributed memory or teaching change behavior—with the full causal chain replayable and failure-qualified.

This is the demo-quality Raccoon World application, delivered in [clockgrove/raccoon-world](https://github.com/clockgrove/raccoon-world) against the platform at a pinned Clockgrove commit. It is not a collection of subsystem pages, a static mockup, or a preprogrammed story.

The default participant is a disclosed, unrendered Caretaker persona. Raccoons can attribute speech, gifts, and influence to that persona even though no avatar is rendered. The demo must not present the participant as an omniscient deity or silently treat the selected raccoon as the user's body. World-local inventory may be exposed minimally for authored fixtures, but full social transfer UX is completed in Wave 11.

---

### 1.1 Objectives, sequencing, and checkpoints

This wave is a substantial workstream containing numerous Objectives and Work Items. The accepted [incremental-delivery ADR](../adr/clockgrove-adr-incremental-wave-delivery-and-evidence.md) governs capability scope, readiness, comparison rules, and proportionate qualification. The complete exit checklist below remains authoritative for full-wave qualification.

Integrate the previously exercised living yard, conversation, learning/policy and typed authoring checkpoints. Wave 8 is the substantial complete-neighborhood workstream, not the first attempt to discover whether the product works.

Complete lifecycle/family/ecology depth, useful return summaries, interaction polish and reviewed art as bounded capabilities over those accepted paths. Extend the north-star trace with a provenance-recorded live observation, governed actor-initiated MCP research, actor-authored skill revision, compiled-policy adoption/reuse and novelty fallback. Keep deterministic captured fixtures and a separately bounded live demonstration.

Use the earlier observation, conversation and learning pilots to set the complete demo rubric before the final evaluation; do not change it after observing results. Full ten-scenario, deployed-path, privacy/replay/recovery and visual/accessibility exits remain required.

---

### 1.2 Platform and reference-world ownership

Clockgrove is world-agnostic, so this wave has two halves with one exit.

- **[clockgrove/raccoon-world](https://github.com/clockgrove/raccoon-world)** delivers the demo: the `green-lake-yard@1` pack (RW-0801), its reviewed art and audio and reference-layout goldens (RW-0807), its theme, its demo journeys and the demo manifest. Its CI runs them against a pinned Clockgrove commit.
- **Clockgrove** delivers every platform capability the demo uses (lifecycle, household, ecology, summaries, interaction, onboarding, return UX, north-star integration, soak and evaluation harnesses) without naming the reference world's content. It proves them on its fixture world, `worlds/fixture`, the platform's portability proof.

Every exit item below still holds and is proven in the repository that owns it. A platform change found through content work lands in Clockgrove with its own fixture-world test, and the reference world moves its pin to pick it up.

---

## 2. Entry conditions

These are the full-wave/default entry conditions. A named local-development Objective may consume only accepted prerequisite capabilities under the ADR's recorded readiness exception; its Issue must preserve pending qualification obligations and the selected path's mandatory safety evidence.

- Wave 7 qualification manifest is green.
- The live world, realtime client, durable conversations, actor harness, memory, learning, rules, previews, authoring, and inspector pass their individual gates.
- `green-lake-yard@1` minimal fixture and its Wave 1 scenario goldens exist in the reference world's repository, and the fixture world's scenario goldens pass in Clockgrove.
- Asset pipeline, provenance review, R2 delivery, Phaser scene, responsive shell, and accessibility path are qualified.
- North-star scenario IDs, seeds, model routes, scripted-provider variants, and failure points are frozen.
- Demo content changes use world-pack/changeset review; application code cannot special-case Stevie by display name.

---

## 3. Demo product charter

The demo must make five ideas obvious without explanation from a developer:

1. **The world keeps living.** Time, weather, needs, movement, resources, growth, relationships, and material events progress while the user watches or is away.
2. **Actors have perspectives.** Stevie and family perceive, remember, believe, decide, and communicate from bounded subjective context.
3. **Everything meaningful is addressable.** Characters, the den, tree, feeder, trash can, porch, garden, and yard expose capability-appropriate interaction.
4. **History has causality.** Event feed and Why connect state, decision, evidence, memory, teaching, and consequence.
5. **Language can influence or author without owning truth.** Suggestions may be declined; operator changes are typed, previewed, and promoted.

The raccoons are the approachable expression. All implementation remains world-pack generic and passes `mirror-room@1` and the fixture world's (`worlds/fixture`) conformance.

---

## 4. `green-lake-yard@1` content contract

### 4.1 Spatial hierarchy

```text
Green Lake Neighborhood
└── Living Yard
    ├── Porch
    ├── Den
    ├── Garden
    ├── Cedar Area
    ├── Trash/Feeder Area
    └── Fence/Street Buffer
```

Required navigation anchors: `den-mouth`, `porch-step`, `trash-front`, `tree-base`, `garden-edge`, `fence-gap`. Add explicit shelter, visibility, scent, sound, elevation, wetness, resource, and camera metadata.

### 4.2 Actors

- Stevie.
- Gracie.
- At least one kit with explicit parent/household links.
- A small household sufficient to show differentiated routines, attention, relationships, and social learning.
- Environmental/reactive/cognitive/interpreted entities declared by capabilities, not inheritance.

Each actor has stable ID, archetype, physical traits, lifecycle stage, needs, senses, movement/routine policy, social links, subjective policy, model/budget route, initial knowledge, allowed initiative, and visual/audio binding.

The canonical pack artifact also pins schema/dependencies, fixed genesis epoch, clock policy, cognitive seeds, named random-stream inputs, seed commands, migration set, asset manifest, license/provenance metadata, and expected seed-projection hash.

### 4.3 Objects and systems

- den and shelters;
- porch and favorite snack-house opportunity;
- trash/food sources and feeder;
- water source/puddles;
- cedar and growing plant/garden;
- weather, temperature, rain, wetness, comfort, day/night;
- food appearance, decay, consumption, depletion, and regeneration;
- movement, sleep, play, grooming, investigation, feeding, sheltering;
- reproduction, birth, growth, aging, death, and successor consequences;
- material-event and overnight-summary policies;
- authored ecological/social rules.

---

## 5. Lifecycle experience

### 5.1 Stages

Represent gestation/birth, kit stages, juvenile, adult, elder, death/retirement, and remains/history according to world-pack policy. Stage transitions are semantic events driven by simulation time and conditions.

Birth:

- creates one stable identity exactly once;
- records parentage/household relationships;
- binds versioned archetype/traits/visual variant;
- schedules lifecycle/needs/routine work;
- applies privacy and player-notification policy;
- survives pause, catch-up, retry, deploy, and replay.

Death:

- stops ordinary activation and physical routine;
- preserves historical identity and causal references;
- applies session and private-memory access/retention policy;
- updates relationships, household knowledge, commitments, subscriptions, and summaries;
- may trigger a distinct ecological/narrative successor without identity substitution;
- is presented respectfully and clearly, not as a silent despawn.

### 5.2 UI

Show age/lifecycle only to permitted viewers. Provide history, family tree/household relation, major life events, archived sessions, and explanation of changes. Do not turn biological state into a dashboard of raw hidden numbers for ordinary players.

---

## 6. Household and social routines

Routines combine deterministic schedules/needs, learned preferences, relationships, commitments, environmental conditions, and bounded cognition.

Required behaviors:

- leave/return to den;
- forage, investigate, eat, drink, shelter, rest, groom, play;
- parent/kit proximity and safety responses;
- invite/follow/lead/wait/refuse;
- Tell/Teach/Demonstrate/Lead;
- promise and deadline handling;
- competition or sharing over limited resources according to policy;
- differentiated favorite places and trust;
- routine continuation with all models unavailable.

Avoid synchronized “NPC parade” schedules. World-pack variation and named deterministic random streams produce diversity without making replay unstable.

---

## 7. Environment and ecology depth

### 7.1 Weather and shelter

Weather transitions change light, rain intensity, wetness, puddles, scent/noise conditions, visibility, resource availability, comfort, shelter utility, and presentation. Effects resolve spatially; actors under shelter do not receive exposed wetness.

### 7.2 Resources and vegetation

Track food/water availability, decay, consumption, replenishment rules, plant growth stages, damage/recovery, and carrying thresholds. Conservation invariants prevent duplication/negative quantities under retry and catch-up.

### 7.3 Long-run bounds

Define acceptable envelopes—not one hand-tuned trajectory—for population, food availability, average unmet needs, shelter use, event volume, model calls, dormant activations, and storage growth over simulated months/year.

World packs include explicit intervention/kill-switch policies for runaway population, starvation, event storms, or content distress during a public demo.

---

## 8. Return experience and material-event feed

### 8.1 World-interest selection

Material events are scored by semantic importance, relationship/user relevance, novelty, consequence, unresolved promise, lifecycle, safety, and current interest—not by raw event count or model narration.

The feed supports:

- icon/category, concise summary, world time, actor/location references;
- unread/read cursor by user/world/timeline;
- focus/select and causal traversal;
- privacy-safe variants;
- grouping of repetitive resource/movement events;
- link to overnight/day summary and exact supporting events.

### 8.2 Overnight/away summary

On return, show a compact “while you were away” account with simulated interval, weather/lifecycle/social/ecology changes, promises needing attention, and current notable activity. Every summary item cites authorized source events; failure to consolidate falls back to deterministic material-event grouping.

The summary does not imply the user missed continuous model-generated prose.

### 8.3 Proactive-contact seam

Important promises, deadlines, safety events, or explicitly subscribed changes may produce consent-governed `DeliveryRequested` records. Wave 8 demo proves policy and the browser/fake inbox; a real external provider is not required for the web demo. The causal inspector shows why contact was requested and why policy approved, delayed, deduplicated, or rejected it.

---

## 9. Object, place, and actor interaction polish

### 9.1 Required modes in the yard

- **Cognitive actor:** Stevie/Gracie/kit answer from perceptions, memories, beliefs, goals, and disclosure policy.
- **Inspectable object:** footprint, food scrap, plant, trash item, or structural element returns canonical/derived observations and traces.
- **Reactive object:** feeder/door/light/trap-like fixture exposes typed deterministic behavior where included.
- **Interpreted entity:** tree, den, garden, or yard narrates modeled state/history while explicitly disclosing nonsentience.
- **Canonical operator explanation:** inspector answers from authorized world evidence.

### 9.2 Grounding

Every response carries mode, grounded revision, citations/evidence, uncertainty, and session scope. Cognitive actors can be mistaken or conceal information; interpreted surfaces cannot claim private perception; inspection cannot invent traces; operator explanation never masquerades as character speech.

### 9.3 Universal card

The selected-entity rail from the reference mockup is finalized with portrait/icon, name/type/mode, current public activity, relationship/household snippet, Talk, Observe/Inspect, Remember/History, Influence, Why, session selector, transcript, and causal links. Actions appear only when permitted and meaningful.

For cognitive actors, Talk is a private attributed Caretaker session. It is not public spatial speech. An explicit public Say action, Influence, and gifts/physical commands remain separate governed operations with distinct audience and receipts.

---

## 10. Demo-quality visual and audio system

### 10.1 Visual target

Match the supplied composition’s feel:

- fixed isometric 16:9 yard as the dominant surface;
- dense but readable Pacific Northwest garden/wood textures;
- warm den/window/lantern light against cool rain and dusk;
- charcoal/olive translucent UI, aged-brass borders, sage selection/accent;
- visibly wet paths, puddles, foliage, feeder, cedar, trash area, porch, den;
- selected Stevie outlined with green ground ring and label;
- compact lower-left event feed and persistent right interaction rail;
- quiet, mature, storybook realism rather than children’s-cartoon saturation or photorealism.

### 10.2 Complete reviewed asset set

- raccoon body/face/age/size variants and portraits;
- idle, walk, run, climb where supported, sniff, forage, eat, drink, groom, play, lead/follow, shelter, sleep, converse/emote;
- den/porch/tree/fence/mailbox/trash can/feeder/garden/paths/plants/water/shelter props;
- dry/rain/wetness/puddle/fog/cloud/day/dusk/night/light effects;
- lifecycle visual variants and non-distressing historical/death treatment;
- icons for weather, material events, entity modes, actions, relationships, privacy, status;
- responsive panel artwork and empty/loading/error states.

Assets remain modular layers/sprites/atlases, not one flattened illustration.

### 10.3 Audio

Optional but included for demo polish:

- rain intensity loops, distant neighborhood ambience, birds, rustling, water, subtle den/porch sounds;
- restrained actor/object cues;
- user-controlled mute and volume groups;
- no critical information conveyed only through sound;
- provenance/license manifest and reduced/sensory-safe defaults.

---

## 11. Onboarding and default demo journey

The first visit starts in observer mode without requiring an avatar.

1. The browser resolves identity/membership, joins the initial authorized space, receives a compatible snapshot and critical assets, and exposes one truthful loading/readiness state before scene or text readiness.
2. World loads with current day/time/weather and a short “this world keeps running” explanation.
3. A guided highlight points to one moving raccoon and one recent material event.
4. User selects Stevie; the rail explains subjective cognitive mode and private Caretaker Talk.
5. User observes or asks one grounded question.
6. User opens Why from a visible action.
7. User makes one bounded suggestion/offer and sees accepted/rejected/pending consequence semantics.
8. User is shown the event feed/return-summary affordance.
9. Creator-only authoring is introduced separately and never confused with ordinary influence.

Onboarding is dismissible, replayable, accessible, and does not freeze simulation. The demo also supports a seeded showcase world/time so reviewers can reliably encounter the north-star chain. That showcase is a real pinned timeline/snapshot using the scripted model provider and ordinary runtime paths; it may prearrange conditions but never fabricates committed events, hotspots, conversations, or causal evidence.

---

## 12. North-star causal integration

Required end-to-end story:

1. A provenance-recorded external observation drives an authorized rain input and changes resources/comfort under a declared wall/simulation-time mapping.
2. Stevie perceives a snack-house/trash opportunity and investigates.
3. Other actors perceive different subsets.
4. User asks why and receives perspective-correct explanation.
5. Experience creates an episode and updates a belief.
6. Stevie teaches or demonstrates to a kit.
7. Kit receives attributed testimony/demonstration, not copied firsthand memory.
8. Consolidation changes accessibility without fabricating evidence.
9. On a later day, learning changes the kit’s choice against an unchanged control; a governed actor-authored SKILL.md evolves from that experience.
10. Two clients converge on authorized consequences.
11. Crash at each durable boundary loses/duplicates no accepted history.
12. Developer searches the full chain and forks a preview from a selected event.
13. Governed actor-initiated MCP weather/route research is cited in authorized context and explanation; lookup cannot broaden capability or world authority.
14. A bounded compiled policy is validated and adopted from the skill/source evidence, makes a stable later choice without a model call, and records its input manifest/evaluation.
15. Source change, contradiction or novelty invalidates/abstains/falls back to cognition; replay and sampled shadow comparison preserve the causal trace.
16. Gracie's guide is generated/revised from retained evidence and deliberately shared; the kit reads it as testimony, verifies a claim firsthand, discovers an exception and authors its own next edition with Gracie's provenance retained.
17. An authorized inspector selects a supported deterministic decision, reproduces its baseline and changes one declared input in counterfactual Why; the actual/hypothetical outcomes are distinguishable and the live world, memories, guide audience and external-effect delivery remain unchanged.

Captured/scripted observation and tool receipts support deterministic CI. The live demonstration must separately prove at least one live observation feed and one actor-initiated MCP lookup within recorded source/provider/resource bounds; a captured weather fixture is not live-feed evidence.

Ship three routes:

- deterministic scripted-model qualification;
- pinned production-model demo route with declared variance budget;
- model-off route showing routine living behavior and deterministic explanations where possible.

---


The guide and counterfactual journeys reuse the existing north-star harness, inspector and product rubric. They do not require a guest-book system, public collaborative wiki or fresh-model counterfactual search.

## 13. Owned code and content

In clockgrove/raccoon-world:

```text
worlds/raccoons/        the green-lake-yard@1 pack: manifest, spaces, archetypes, actors,
                        systems, rules, policies, seeds, scenarios, goldens and theme
assets/                 reviewed art and audio
tests/e2e/demo/
docs/demo/
docs/world-packs/green-lake-yard.md
```

In Clockgrove:

```text
apps/web/src/onboarding/
apps/web/src/return-summary/
apps/web/src/lifecycle/
apps/web/src/relationships/
apps/web/src/demo/
apps/web/src/audio/
apps/web/src/polish/
packages/domain/src/lifecycle/
packages/domain/src/ecology/
packages/application/src/summaries/
packages/testkit/src/soak/
tests/e2e/north-star/
tests/soak/
tests/evals/product/
worlds/fixture/
```

Engine changes discovered by content work require independent contracts and non-raccoon tests. No `if (name === "Stevie")` behavior is permitted.

---

## 14. Detailed work packets

### RW-0801 — Complete `green-lake-yard@1` world pack

Implement the canonical immutable pack artifact: schema/dependencies, hierarchy, regions/anchors/portals, archetypes, actors, components, initial relationships/knowledge, systems, policies, rules, schedules, cognitive seeds, fixed epoch/clock policy, named random streams, seed commands, migrations, assets/provenance/licenses, expected seed-projection hash, real showcase timeline, validation, and pack docs.

Delivered in the reference world's repository against a pinned Clockgrove commit.

Exit: a clean environment validates/builds/publishes the artifact, provisions it through the real idempotent lifecycle to `WorldReady`, verifies the seed projection hash, and starts it deterministically; no engine code depends on its names.

### RW-0802 — Lifecycle product UX

Implement gestation/birth/stages/growth/aging/death/successor semantics, parentage/household consequences, actor activation/session/memory/subscription policy, UI/history, replay, catch-up, and sensitive presentation.

Exit: birth/death scenarios survive every failure path with stable identity and comprehensible history.

Amended (2026-10-27): RW-0802 inherits from Wave 1 (Wave 1 §9.2; parent §7.13 scenario 7) the session, private-memory, relationship and knowledge-access policy at death (§5.1, "Death"), which Wave 1 did not build.

### RW-0803 — Household and social routines

Implement differentiated schedules/needs, family safety/proximity, play/groom/share/compete, invite/follow/lead/refuse, promises, teaching, relationship effects, deterministic fallback, and diversity metrics.

Exit: household behavior remains coherent and non-repetitive across model-on/off runs.

Amended (2026-10-31): RW-0803 inherits from Wave 1 (Wave 1 §5.2) the registration of the Personality component (traits, preferences, aversions and communication style), together with its first consumer, persona and conversation behaviour: the §6 differentiated routines, favorite places, trust and Tell/Teach read it.

### RW-0804 — Environment and ecology depth

Implement richer weather/wetness/shelter, food/water cycles, decay/conservation, vegetation/growth, long-run envelopes, intervention policies, visual projections, and accelerated fixtures.

Exit: months/year soaks stay within declared ecological/event/cost bounds or trip explicit controls.

### RW-0805 — World-interest feed and away summaries

Implement materiality/relevance policy, per-user cursors, grouping, deterministic fallback summaries, provenance, promises/deadlines, return UX, proactive-delivery reasons, fake/browser inbox, privacy, and evals.

Exit: a returning user can understand material change without raw event overload or invented summary facts.

### RW-0806 — Object/space conversation and interaction polish

Implement cognitive/inspectable/reactive/interpreted/canonical mode coverage, private Talk versus public Say semantics, Influence/gift receipts, grounding/citations, disclosure, session UI, universal card, object/space perspectives, Why links, and `mirror-room@1` regression.

Exit: moderated users can correctly identify the source/limits of each response mode.

### RW-0807 — Complete visual/audio pack and reference UI polish

Produce reviewed raccoon/environment/lifecycle/weather/time/action assets, atlases/manifests, audio, responsive shell, states/animations, selection/effects, reference-layout visual goldens, performance optimization, provenance/license review.

The art, audio, atlases/manifests and reference-layout goldens are produced in the reference world's repository. The responsive shell, animation states, selection/effects and performance work are platform code in Clockgrove, proven on the fixture world.

Exit: the live app reaches the reference composition and mood using data-driven original assets at target performance/accessibility budgets.

Amended (2026-11-07): RW-0807 inherits from Wave 4 (Wave 4 §4.3) the top HUD's navigation icons for journal, residents, ecology, home, tasks/authoring when authorized, and settings, and its capture, safety/privacy and menu utilities, which Wave 4 did not build. Each icon opens the screen this wave delivers for it.

### RW-0808 — North-star causal integration

Connect rain → decision → explanation → episode/belief → teaching → consolidation → later changed choice across runtime, UI, journal, cognition, inspector, replay, branch, scripted/production/model-off routes, including the guide testimony/verification/revision journey and one supported deterministic counterfactual Why comparison.

Exit: one trace manifest links every required ID and passes two-client/fault qualification.

### RW-0809 — Full scenario and soak suite

Run all ten named scenarios through deployed product paths plus create/provision/return-to-world, months/year acceleration, model-off continuity, browser readiness/convergence, asset/compatibility fallback, observer navigation, hibernation/deploy, provider outages, ecological bounds, event/storage growth, and resource/cost budgets.

Exit: no subsystem-only shortcut is accepted as scenario completion.

### RW-0810 — Product thesis evaluation and demo gate

Run first-use, observe, converse, investigate, influence, return, author/preview, accessibility, disclosure, trust, delight, repetition, and performance studies with predeclared rubrics; fix release blockers and publish evidence.

Exit: publish Wave 8 qualification manifest and approve the demo-quality application. The demo manifest is published from the reference world's repository and names the Clockgrove commit and platform manifest it ran against.

---

## 15. Dependency graph and bounded execution

```text
RW-0801 ─┬─ RW-0802 ─ RW-0803 ─┐
         ├─ RW-0804 ────────────┤
         ├─ RW-0805 ─ RW-0806 ─┼─ RW-0808 ─ RW-0809 ─ RW-0810
         └─ RW-0807 ────────────┘
```

Safe lanes: world-pack content; lifecycle policy/UI; ecology fixtures; return feed/summaries; interaction copy/evals; asset/audio production; north-star fault harness; product research plan. One integrator owns pack version and one art director/reviewer owns visual acceptance.

---

## 16. Test and evaluation strategy

```text
pnpm test:world-pack:green-lake
pnpm test:lifecycle
pnpm test:ecology
pnpm test:social
pnpm test:summaries
pnpm test:e2e:demo
pnpm test:e2e:north-star
pnpm test:visual
pnpm test:a11y
pnpm test:soak
pnpm eval:product
pnpm qualify:wave8:staging
```

`test:world-pack:green-lake`, the demo journeys and the reference-layout visual goldens run in the reference world's repository against its pinned Clockgrove commit. The other suites run in Clockgrove, on the fixture world where they need a world.

### 16.1 All ten named scenarios

1. `favorite-snack-house`
2. `rain-shelter-comfort`
3. `food-decay-and-conservation`
4. `cedar-growth`
5. `birth-and-parentage`
6. `social-learning`
7. `death-and-successor`
8. `months-fast-forward`
9. `differential-perception`
10. `non-raccoon-conformance`

Each passes Journal, projection, schedule, decision, cognition where applicable, client, replay, branch, privacy, recovery, and state-hash obligations. Scenarios 1–9 run on the reference pack in its repository and on the neutral reference variant (`worlds/fixture/reference`) in Clockgrove; scenario 10 runs in Clockgrove.

### 16.2 Product rubrics

Use the Wave 4–6 checkpoint pilots as baseline evidence, then predeclare the final demo thresholds before running the final evaluation for:

- first-time comprehension of clock/weather/world persistence;
- successful selection and interaction without assistance;
- cognitive versus interpreted/canonical disclosure comprehension;
- ability to answer “why did Stevie do that?” from the UI;
- perceived actor consistency and world aliveness;
- influence acceptance/rejection/consequence comprehension;
- away-summary trust and usefulness;
- later-learning recognition;
- guide authorship/source/uncertainty comprehension, testimony versus firsthand learning and recognition of an attributed next edition;
- actual versus hypothetical Why comprehension and ability to identify the one changed assumption without mistaking the result for world history;
- return intention/delight without manipulative outreach;
- accessibility completion parity;
- repetition/action diversity and model-free legibility.

User studies use consented nonproduction worlds and redact/private-retain recordings according to policy.

---

## 17. Performance, reliability, and cost gates

Measure:

- app load, scene-ready, Web Vitals, frame time, texture memory, asset bytes/cache;
- socket connect/reconnect, patch apply, fanout, snapshot fallback;
- commands/events/schedules per world day;
- actor activations, no-op heartbeats, model/tool/consolidation calls;
- north-star latency and cost by phase;
- event/index/artifact/storage growth per simulated day/month/year;
- catch-up/fast-forward duration and equivalence;
- ecology and population envelope;
- model-off continuity and provider recovery;
- hot-space and concurrent-observer curves.

Demo loading and costly cognition have explicit graceful states. No hidden unlimited provider route is allowed for a showcase.

---

## 18. Failure and recovery matrix

Inject every Wave 0–7 durable boundary into the north-star chain: Worker/DO deploy, socket hibernation, PostgreSQL/Hyperdrive interruption, Queue duplicate/DLQ, Workflow retry/deploy, model stream failure, tool uncertainty, context/index lag, memory/consolidation failure, rule storm, branch isolation, asset failure, browser context loss, and summary failure.

Assert accepted history, state, actor identity, session, memory attribution, teaching, later decision, client convergence, causal inspector, effect isolation, user-visible status, and safe model-off continuation.

---

## 19. Explicit non-goals

Wave 8 does not implement:

- combat, economy, quests/campaign, full MMO avatars, or global chat;
- photorealism, free 3D camera, or general physics;
- a marketplace or untrusted world-pack hosting;
- a full murder-mystery product;
- production iMessage/Slack/email/voice adapters;
- enterprise SSO, billing collection, sales dashboards, or commercialization;
- unlimited actor cognition or perfect ecological realism;
- replacing measured demo scope with a large empty map.

---

## 20. Exit evidence checklist

- [ ] RW-0801 through RW-0810 are merged.
- [ ] `green-lake-yard@1` imports and runs without name-specific engine code.
- [ ] The reference world's demo manifest passes in clockgrove/raccoon-world against a pinned Clockgrove commit, and the platform manifest passes in Clockgrove on the fixture world with no reference-world content.
- [ ] The living yard matches the supplied visual hierarchy and mood with original data-driven assets.
- [ ] First-time observe/converse/investigate/influence/return journeys are complete.
- [ ] Lifecycle, household, ecology, rules, and model-off routines remain coherent.
- [ ] Away summaries are useful, attributed, private, and deterministically degradable.
- [ ] All four entity interaction modes are distinguishable and grounded.
- [ ] North-star chain passes scripted, production-demo, and model-off variants as declared.
- [ ] At least one bounded live observation feed and actor-initiated MCP lookup have separate provenance, time-mapping, authority and actual-usage evidence.
- [ ] Learned document revision, policy adoption/reuse, invalidation/novelty fallback and shadow/control comparisons appear in the integrated private causal trace.
- [ ] All ten scenarios pass full deployed paths.
- [ ] The field-guide testimony/verification/next-edition journey and one bounded counterfactual Why comparison are visible and understandable through authorized visual/text views.
- [ ] Guide source disclosure/revocation and hypothetical effect/memory/sharing isolation pass the existing privacy/replay gates.
- [ ] Two-client, privacy, replay, branch, hibernation, deploy, and fault suites pass.
- [ ] Visual, audio, performance, responsive, and accessibility gates pass.
- [ ] Product thesis evaluation meets predeclared demo thresholds or records approved limitations.
- [ ] Main remains deployable and clean setup remains reproducible.

The manifest records commit, world-pack/schema/policy/model/asset versions, scenario seeds/hashes, north-star trace manifest including document/policy/evaluation versions and external observation/research provenance, visual captures, provenance/license report, soak/ecology/cost data, fault results, accessibility/performance reports, product-eval findings, known limitations, staging URL reference, and exit decision.

---

## 21. Handoff to Wave 9

Wave 9 does not add a new product thesis. It makes this exact demo operable, recoverable, secure, documented, reproducible, and open-source releasable. Any Wave 9 operational abstraction must prove itself against the completed yard and must not couple world semantics to a commercial plan.
