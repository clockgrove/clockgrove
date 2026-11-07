# Clockgrove development instructions

Start from the `Documentation map` below and read only the contract document for the package or subsystem you touch, instead of whole READMEs. Use `README.md` and `docs/clockgrove-documentation-index.md` for product/runtime authority, then read the current canonical specification, accepted ADRs, and wave plan relevant to the task.

This repository owns Clockgrove product/runtime truth. Resolve product/runtime authority in the order defined by the documentation index; do not silently choose a convenient older document when current authorities differ.

## Documentation map

- `packages/contracts`: [shared contracts](docs/protocols/shared-contracts.md).
- `packages/application`: no contract document.
- `packages/assets`: [asset pipeline](packages/assets/docs/pipeline.md).
- `packages/domain`: [spatial](packages/domain/docs/spatial.md), [environment](packages/domain/docs/environment.md), [ecology](packages/domain/docs/ecology.md), [wellbeing](packages/domain/docs/wellbeing.md), [utility](packages/domain/docs/utility.md), [lifecycle](packages/domain/docs/lifecycle.md), [rules](packages/domain/docs/rules.md), [components](packages/domain/docs/components.md), [component catalog](packages/domain/docs/component-catalog.md), [component composition](packages/domain/docs/component-composition.md).
- `packages/kernel`: [random streams](packages/kernel/docs/random-streams.md), [evidence](packages/kernel/docs/evidence.md), [executor](packages/kernel/docs/executor.md), [containment](packages/kernel/docs/containment.md), [spatial movement](packages/kernel/docs/spatial-movement.md), [perception](packages/kernel/docs/perception.md), [scheduler](packages/kernel/docs/scheduler.md), [environment](packages/kernel/docs/environment.md), [ecology](packages/kernel/docs/ecology.md), [wellbeing](packages/kernel/docs/wellbeing.md), [utility decisions](packages/kernel/docs/utility-decisions.md), [lifecycle](packages/kernel/docs/lifecycle.md), [rules](packages/kernel/docs/rules.md).
- `packages/model-gateway`: [model gateway](packages/model-gateway/docs/model-gateway.md).
- `packages/persistence`: [database runbook](docs/runbooks/database.md).
- `packages/simulator`: [genesis](packages/simulator/docs/genesis.md), [verification](packages/simulator/docs/verification.md), [scenarios](packages/simulator/docs/scenarios.md), [pack conformance](packages/simulator/docs/conformance.md), [CLI](packages/simulator/docs/cli.md), [refusal codes](packages/simulator/docs/refusal-codes.md).
- `packages/testkit`: no contract document.
- `packages/world-pack-sdk`: [source and compatibility](packages/world-pack-sdk/docs/source-and-compatibility.md), [collections](packages/world-pack-sdk/docs/collections.md), [migrations](packages/world-pack-sdk/docs/migrations.md), [hashing and output](packages/world-pack-sdk/docs/hashing-and-output.md), [refusal codes](packages/world-pack-sdk/docs/refusal-codes.md), [fixtures](packages/world-pack-sdk/docs/fixtures.md).
- `apps/runtime`: [README](apps/runtime/README.md), [runtime runbook](docs/runbooks/runtime.md).
- `apps/web`: [README](apps/web/README.md), [isometric scene](apps/web/docs/scene.md).

## Documentation conventions

- Write a new or extended subsystem contract in `packages/<package>/docs/<subsystem>.md` (the existing subsystem document when one exists), not in the package README.
- Adding a subsystem document also adds its link to the package README's `Subsystem contracts` list and to the Documentation map above.
- Package READMEs stay short human overviews of about 150 lines at most and change only for user-facing usage changes.
- Cross-package protocol contracts stay under `docs/protocols/`.

## Product and capability boundaries

- The deterministic simulation and typed application paths own canonical physical mutation. Models and tools may reason and propose, but do not become world-truth authority.
- PostgreSQL is canonical durable world history. Runtime actors, queues, caches, indexes, browser state, and provider sessions are recoverable execution or projection state.
- Keep provider SDK types behind project-owned adapters and composition roots. Preserve provider-neutral durable contracts.
- `clockgrove/factory` and `clockgrove/skills` are external development capabilities. They may operate this repository, but must not become product/runtime dependencies or override accepted Clockgrove authority.
- Treat Copilot Memory and agent-session history as derived context. Reconstruct consequential state from current repository and GitHub evidence.
- Preserve the clean-room and publication boundaries in `README.md`; do not introduce private source, credentials, unpublished operational history, or unrelated proprietary artifacts.

## Delivery record

- GitHub Issues, sub-issues, pull requests, checks, and merges are the durable delivery record. Agent-session memory is not.
- Explicitly set native issue types: `Feature` for product capabilities, Objectives included; `Task` for Work Items, maintenance, investigation and qualification; and `Bug` for standalone defects. A corrective Work Item remains `Task`; record its underlying defect separately when needed.
- An Objective is a role, not a type. The `factory:objective` label marks a wave's product outcome for Factory to compile into Work Items. Give that role only to new product work from a wave plan. A `Feature` need not be an Objective. Leftover wave gaps, regressions, maintenance, plan amendments, re-qualification and cleanup are plain `Bug`, `Task` or `Feature` issues, done directly, even when they cite a wave plan.
- Use labels for area, priority or Factory role, not issue classification. Do not add redundant `bug`, `enhancement`, `feature` or `task` labels. Preserve `factory:objective` and `factory:work-item` role labels. Issue forms must set top-level `type`; CLI/API authors must supply it and verify the returned issue's type and labels.
- When creating or triaging an open issue, assign exactly one priority: `P0` for urgent security/data loss, duplicate effects or stranded work; `P1` for current critical-path delivery or incorrect behavior with a supported workaround; `P2` for minor, optional or deferred work. Work Items normally inherit their Objective's priority. Verify after creation or Factory projection and preserve existing priorities unless evidence supports a change. Priority does not grant execution authority or change approved queue order, dependencies or held owner decisions.
- Factory's one workflow is `.github/workflows/factory.yml`; do not add other development-tool orchestration workflows, vendored tool code, or tool secrets to this repository. Preserve existing repository and platform protections.

## Validation and completion

- Commands, required tools, workspace rules and runtime composition facts live in [`docs/runbooks/development.md`](docs/runbooks/development.md). Read it before adding a package, check or dependency.
- Tests follow [`docs/runbooks/testing.md`](docs/runbooks/testing.md): unit tests are scaffolding while building and are deleted before handoff; keep one integration test per claim, goldens and the database attack suite. `pnpm check` enforces the test budget.
- Tests that launch a browser live in the `include` of `tests/ci/vitest.browser.config.ts`, which runs only in the CI jobs that install Chromium (Quality's `browser-build` share and Qualification); `pnpm check` refuses Playwright anywhere else.
- Answer the six questions of [`docs/runbooks/design-checklist.md`](docs/runbooks/design-checklist.md) (authority, growth, attribution, hot-path cost, test independence, sourced numbers) in a design note before writing code, and again at handoff with `file:line` evidence. Reviewers check the answers.
- Run `pnpm format` before finishing a change. It applies Biome's formatting and safe fixes, which `pnpm check` only verifies.
- Use the current wave's commands and exit evidence. Do not implement later-wave behavior merely to make an earlier wave appear complete.
- Validate package boundaries, deterministic contracts, migrations, authorization isolation, clean bootstrap, and recovery in proportion to the affected Work Item.
- Waves are substantial, mostly sequential workstreams containing numerous Objectives and Work Items. Use the accepted [incremental-delivery ADR](docs/adr/clockgrove-adr-incremental-wave-delivery-and-evidence.md) for checkpoint entry, scope, and qualification.
- Closing every child Issue is not sufficient Objective evidence. Verify the declared Objective capability against the applicable wave contracts; qualify the whole wave only when its full exit evidence passes.
- Freeze acceptance and the intended candidate before coordinated qualification. Use focused checks during implementation, one qualification owner, independent review, and parallel work only for independent outcomes with isolated resources.
- Compare immutable artifacts, protected contents, deterministic replay, and required literal citations exactly. Compare other outcomes through declared semantic invariants; incidental timestamps, host paths, or legitimate unrelated rebase changes are not correctness requirements.
- Keep implemented, integrated, locally accepted, and fully qualified evidence distinct in GitHub. Do not make a checkpoint into a release or omit pending wave-exit obligations.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
