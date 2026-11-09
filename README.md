# Clockgrove

Clockgrove is an open-source persistent artificial-life world and conversational-actor platform. [Raccoon World](https://github.com/clockgrove/raccoon-world) is its first reference world and demo-quality application.

The core thesis is simple:

> Build persistent worlds from deterministic physical truth plus subjective, agentic cognition.

A Clockgrove world can keep time, change while nobody is watching, remember what happened, support many logically addressable actors and objects, expose causal explanations, and let people converse with meaningful subjects without allowing an LLM to become the authority for physical world state.

## Try it

There is no hosted demo yet. To explore the neutral fixture world on your own machine, follow the bootstrap below, then run `pnpm dev:world`: it needs PostgreSQL 18.6 with pgvector 0.8.7 (the set `pnpm test:db` uses), and it prints a URL and a sign-in credential. See [development.md](docs/runbooks/development.md#local-living-yard-checkpoint).

## What Clockgrove is exploring

- deterministic simulation with persistent time, weather, resources, movement, growth, lifecycle and schedules;
- event-sourced semantic history, replay, timelines and causal evidence;
- actor perception, episodes, beliefs, relationships, memory and social learning;
- conversations with characters plus clearly disclosed interpreted perspectives for objects and spaces;
- bounded model/tool/MCP capabilities behind typed application authority;
- natural-language authoring through validated preview timelines rather than direct live mutation;
- realtime browser projection over persistent world state;
- reusable world packs and a neutral fixture conformance path;
- shared-world identity, attribution and world-local inventory without coupling world truth to billing or provider state.

## Repository map

This repository contains the **Clockgrove product/runtime** and its canonical product specifications.

Other repositories in the Clockgrove organization have separate responsibilities:

- `clockgrove/factory` — external agent-orchestration tooling used to develop Clockgrove. Clockgrove does not depend on Factory to build or run.
- `clockgrove/skills` — reusable Clockgrove product/engineering skills.
- `clockgrove/raccoon-world` — Raccoon World, the reference world: its pack, art, style bible, theme and goldens, built against a pinned Clockgrove commit.
- `clockgrove/.github` — public organization profile, shared GitHub metadata, and the Clockgrove Copilot capability marketplace.

Factory develops Clockgrove through GitHub Issues, pull requests and checks (`.github/workflows/factory.yml`); it is not a build or runtime dependency. The independent Skills package is enabled through `.github/copilot/settings.json`.

## Contributor bootstrap

The supported local baseline is a Linux environment with Node.js 24.21.0 LTS, Corepack, pnpm 12.9.1, Python 3, Git, and Git LFS. The repository pins Node and pnpm in `mise.toml`; mise is convenient but not required. From a clean checkout, verify the tools before installing dependencies:

```bash
command -v node >/dev/null || { echo 'Node.js 24.21.0 LTS is required; install it from https://nodejs.org/ or with mise.' >&2; exit 1; }
node -e "if (process.versions.node !== '24.21.0') { console.error('Node.js 24.21.0 LTS is required; found ' + process.version); process.exit(1) }"
command -v corepack >/dev/null || { echo 'Corepack is required; install it using the official Node.js Corepack instructions.' >&2; exit 1; }
command -v python3 >/dev/null || { echo 'Python 3 is required for documentation validation; install your distribution Python 3 package.' >&2; exit 1; }
command -v git >/dev/null || { echo 'Git is required; install your distribution Git package.' >&2; exit 1; }
command -v git-lfs >/dev/null || { echo 'Git LFS is required; install it from https://git-lfs.com/ or your distribution package.' >&2; exit 1; }
corepack enable
pnpm --version | grep -qx '12.9.1' || { echo 'pnpm 12.9.1 is required; let Corepack activate the packageManager version declared in package.json.' >&2; exit 1; }
pnpm install --frozen-lockfile --ignore-scripts
```

The complete local entrypoint is `node scripts/bootstrap.mjs /absolute/owned/evidence-directory`. Install the prerequisites in [development.md](docs/runbooks/development.md) first, including PostgreSQL 18.6 server and client tools (`pg_dump`, `pg_restore`) with pgvector 0.8.7, and OpenTofu 1.13.1. It verifies the pins and the hydrated Git LFS inputs, then runs the frozen, script-disabled install and the checks; it needs no hosted credentials. Keep its evidence directory outside the checkout.

The install deliberately disables dependency lifecycle scripts. Run `pnpm check`, `pnpm test` and `pnpm run verify:docs` before proposing a change. `pnpm check` is read-only: formatting, lint, strict TypeScript, package boundaries and their negative fixture.

## Documentation

Start with [`docs/clockgrove-documentation-index.md`](docs/clockgrove-documentation-index.md). It defines the current product/runtime authority order, accepted ADRs, implementation waves, supporting reviews and historical material.

Current top-level product baselines are:

- [`docs/clockgrove-prd-v0.5.md`](docs/clockgrove-prd-v0.5.md) — **PRD v0.5.10**;
- [`docs/clockgrove-cloudflare-implementation-plan.md`](docs/clockgrove-cloudflare-implementation-plan.md) — **architecture v3.12**.

Key public-facing documents also include:

- [`BRAND.md`](BRAND.md) — Clockgrove's brand identity, voice and creative principles;
- [`STYLE.md`](STYLE.md) — Clockgrove's own visual language and image-generation direction (each world's art follows that world's style bible);
- [`AI content disclosure policy`](docs/policy/ai-content-disclosure.md) — how players are told which content AI made, before shipping and live;
- [`docs/adr/`](docs/adr/) — accepted product/runtime architectural decisions;
- [`docs/waves/`](docs/waves/) — substantial sequential workstreams containing numerous capability Objectives and Work Items;
- [`incremental-delivery ADR`](docs/adr/clockgrove-adr-incremental-wave-delivery-and-evidence.md) — early checkpoints, readiness versus full qualification, and proportionate evidence;
- [`field guides and counterfactual Why ADR`](docs/adr/clockgrove-adr-field-guides-and-counterfactual-why.md) — evolving resident-authored knowledge and controlled hypothetical decision comparisons.

## Architecture principles

A few boundaries are intentionally strong:

- **The simulation kernel owns physical semantics.** Models may reason, speak, plan and propose actions, but canonical mutations pass typed authorization and validation.
- **PostgreSQL is canonical durable world truth.** Runtime actors, queues, caches, indexes and client state are recoverable execution/projection state.
- **Logical identity is not runtime placement.** An actor or object does not imply a permanently resident process or LLM.
- **Objective state and subjective cognition remain distinct.** Perception, testimony, belief and memory are evidence-bearing actor-relative state rather than disguised global facts.
- **Replay and explanation are product features.** Important behavior should be causally inspectable.
- **Provider boundaries stay replaceable.** Cloud, authentication, model, tool, renderer and infrastructure SDKs remain behind project-owned contracts where they affect durable semantics.
- **Clockgrove remains independently operable.** Development capabilities such as `clockgrove/factory` and `clockgrove/skills` may operate the repository but cannot become runtime dependencies.

## Reference world

Clockgrove supplies the platform for any world. The committed `worlds/fixture` inputs exercise
engine, runtime and browser behavior without product-world content. The reference world lives in
[clockgrove/raccoon-world](https://github.com/clockgrove/raccoon-world), which consumes a pinned
Clockgrove source checkout through the [external-world commands](docs/protocols/world-presentation.md#external-local-session).

## Clean-room and publication boundary

Clockgrove is independently developed. Do not copy private source code, repository history, credentials, data, prompts, proprietary assets or implementation artifacts from unrelated projects or employers into this repository.

Canonical repository content is written as if it may be public. Personal deployment details, private account/recovery information, credentials and unpublished working history do not belong here.

## Status

Clockgrove is in active development. The foundation, deterministic kernel, journal and replay, and actor runtime are built, and the visual projection and web client (Wave 4) are underway; hosted qualification is still pending. Later waves add conversations and capabilities, memory and learning, authoring, the reference-world demo and optional hosted-world features. Each wave's plan is in [`docs/waves/`](docs/waves/).

## License, contributing and security

Clockgrove is licensed under the [MIT License](LICENSE). [CONTRIBUTING.md](CONTRIBUTING.md) explains how to contribute, and [SECURITY.md](SECURITY.md) how to report a vulnerability privately. [provenance.json](provenance.json) records the repository content that is not original Clockgrove work.
