---
name: world-pack-design
description: Rules for designing Clockgrove world packs. Use when creating or changing a pack under worlds/, the world-pack SDK, archetypes, traits, components, spaces, rules, capabilities, seed commands, genesis, migrations, pack assets and presentation bindings, conformance goldens, world provisioning, or natural-language authoring that produces pack changes.
---

# World pack design

Packs make worlds expressive without leaking any one world into the engine or turning a pack into trusted code.

## Read first

These are the authority; where this page and they differ, they win.

- `packages/world-pack-sdk/docs/`: source and compatibility, collections (spaces, rules, capabilities, seed commands, closed-world authoring), migrations, hashing and output, refusal codes.
- `packages/simulator/docs/genesis.md`, `conformance.md` and `cli.md`: seeding, the conformance suite, golden review, the `clockgrove pack` commands.
- `packages/assets/docs/pipeline.md` and `docs/protocols/world-presentation.md`: asset manifests, style profiles, atlases and what a world supplies to the shell.
- `docs/runbooks/runtime.md` (Durable world provisioning and readiness) and `docs/clockgrove-cloudflare-implementation-plan.md` §8.
- `worlds/fixture/README.md`: the fixture packs.

## World-agnostic platform

Clockgrove is a platform for any world. Platform code imports no world except `worlds/fixture` and names no world's content; `pnpm check` fails otherwise. A real world's pack, art, style bible, theme and goldens live in that world's repository and run against a pinned Clockgrove commit (`scripts/check-world-pack.mjs`).

When adding a concept, ask: is it intrinsic to every world, or only to one? Could the fixture express the same engine contract with different nouns? The `beacon.` test world exists to catch engine code that depends on reference-world names.

## Rules

- **Source builds one immutable artifact.** `buildWorldPack` turns source into a content-addressed `WorldPackArtifact`; installation pins it. Never install a mutable "latest". Reason: every world derives its identity from the artifact hash.
- **Closed world.** No resource appears by magic. Food and water come only from declared genesis inventory, rain collection, finite plant-stage yield, transfers from existing holders or declared finite boundary exchanges. Ecology `sources` are refused; off-screen agents are declared world processes using ordinary validated commands.
- **Genesis is deterministic.** Pin the clock policy, named random streams, seed commands and their order, schedules, cognitive seeds and `expectedSeedProjectionHash`. Reason: replay, goldens and Why all rely on a reproducible start.
- **Birth is idempotent.** Provisioning installs the pinned artifact, commits genesis and seed commands through the journal and verifies the seed projection; only runtime-committed `WorldReady` makes a world routable. A retry reuses the same case and never seeds twice. Never insert seed rows directly.
- **Content change, version bump.** Changing committed pack content raises the minor version, re-records `expectedSeedProjectionHash`, updates the pack version in its scenario and long-run documents, and regenerates goldens through the golden review workflow. The `@1` major pin stays.
- **Archetypes for shape, instances for identity.** Archetypes and traits declare reusable defaults and ceilings; instances hold identity, containment, condition and exceptional restrictions. Mobility narrows world to space to role to archetype to instance, deny wins.
- **Bounded behaviour.** Use declarative rules, known component operations and declared capabilities. No arbitrary code uploaded into a live world.
- **Presentation is not simulation.** Semantic presentation roles bind to reviewed assets; renderer texture IDs never become domain state. Assets carry license, provenance, hash, dimensions, anchors and footprint. `reference/asset-style.json` is versioned apart from the pack and does not change its content hash.
- **Upgrades are not reinterpretation.** Migrations are validated and planned by the SDK; applying them to installed worlds is later-wave work (Wave 7). History stays inspectable under the version it was made with.
- **Authoring produces typed changes.** Natural-language authoring compiles to a validated changeset applied to a preview timeline, then promoted as fresh intent (Wave 7 plan). Exporting live changes into reusable pack source is a separate, deliberate step.

## Proving a pack

The shared conformance suite (`packages/simulator/test/conformance/`) runs under `pnpm test`: validation and build, reproducibility, immutability, seeding and golden match. Get the values to commit from the failure output (see "Authoring values from failures" in `conformance.md`); goldens are reviewed, never written by the suite.

## Reject

Mutable "latest" installs, direct seed inserts, world-specific engine conditionals, magic resource sources, renderer IDs as domain state, live code upload, non-idempotent genesis, auto-exporting world history into pack source.
