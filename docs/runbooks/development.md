# Development reference

Stable repository facts for contributors, human or agent. Each rule has its reason.

## Tools

- Node 24.21.0 and pnpm 12.9.1 on `PATH`. They are pinned in `mise.toml` and `package.json`.
- PostgreSQL 18.6 with pgvector 0.8.7 on `PATH`, for `test:db`, `test:runtime` and `db:verify`. See [database.md](database.md) for the exact supported set; no other version is compatible.
- Python 3, for `verify:docs`.
- OpenTofu 1.13.1 on `PATH`, required by `scripts/infra-validate.mjs` for the configuration in `infra/`. Wrangler 4.147.0 is pinned in the root development dependencies.
- On Ubuntu 26.04, `scripts/ci/toolchain.sh` installs or verifies the pinned PostgreSQL, pgvector, OpenTofu, OpenTofu provider mirror and Playwright Chromium. It installs only a component that is missing or not the exact pinned version, and `--check` only verifies. Quality's toolchain action uses it, so CI and developer machines share one set of pins. The action caches the staged pgvector build per pinned pgvector and PostgreSQL version and runner image (`PGVECTOR_STAGE`); the script reuses it only when its library digest matches its stamp.
- Run `pnpm install --frozen-lockfile --ignore-scripts` before any check. The lockfile is the dependency contract. Dependency lifecycle scripts must remain disabled for adapter work; if an install script that is not approved under `allowBuilds` runs, stop and report to the maintainer (approved builds are listed in [Dependency install scripts](#dependency-install-scripts)). Work in the checkout you were given: don't create extra git worktrees, because pnpm installs in each one.

## Acceptance commands

- The root `package.json` scripts `check`, `test`, `test:db`, `test:runtime` and `verify:docs` are the canonical acceptance commands. Do not edit their bodies. Every contributor and CI must mean the same thing by "passes".
- Add a check by extending what those scripts already run:
  - `scripts/check-boundaries.mjs`, run by `pnpm check`, for repository-wide boundary rules, including the test budget of [testing.md](testing.md) and the retention registry `db/retention.json` of [design-checklist.md](design-checklist.md) (every table with a BEFORE DELETE or TRUNCATE trigger needs an entry);
  - the `check` and `test` scripts in each package's own `package.json`, which Turbo discovers;
  - `vitest.workspace.ts` and `turbo.json`, for test discovery and task inputs.
  W0-010 additionally declares `qualify:wave0` for the named local evidence capability; it consumes canonical receipts rather than redefining these gates.
- `pnpm test:long-run` runs the long-horizon simulations: the one-year lifecycle run, the full Node/workerd evidence differential and full committed-scenario sets in several runtimes. They live in `*.long-run.test.ts` files that each package's `vitest.long-run.config.ts` includes and its `vitest.config.ts` excludes. `pnpm test` keeps a short variant of each (the 30-day run, a small fixture-pack Node/workerd parity check), so a PR stays fast while the long runs still execute in qualification.
- `pnpm run qualify:wave1:long-runs [<evidence-dir>] [--concurrency <n>]` runs the Wave 1 30-day and one-year scenarios of fixture-hall@1 and test-world@1 (`worlds/<pack>/long-runs/`, summarised recording) on Node and on workerd, each in its own process. It checks the plan §9.3 invariants and the declared small-step versus aggregate equivalence, requires byte-identical Node and workerd bundles, and writes `wave1-long-runs.json` with each run's wall time and peak memory per runtime (workerd's read from the host), outside the compared bundles, plus the bundles. Each runtime's counters are recorded beside its declared budget (`WAVE1_LONG_RUN_BUDGETS`, keyed by pack id, run and runtime; 2x the run's maximum in Qualification run 39604752325, except test-world's one-year workerd peak memory, 6534 MiB, 2x the highest peak across seven Qualification runs); a counter above its budget, or one that was not measured, fails the run. Without a directory it creates one under the system temp directory and prints it. The one-year test-world runs take about 4 to 8 minutes each on the `QUALITY_RUNNER` class (budget 851.2 s on Node, 849.6 s on workerd); qualification runs them in its `wave1-long-runs` job. `tests/ci/qualify-wave1-long-runs.test.mjs` runs the same qualifier on short horizons per PR. A check that a summarised recording cannot observe (private perception) is reported `not-observable`, never passed.
- `pnpm run qualify:wave1 [--qualification <dir>] [--long-runs <dir>] [--out <dir>]` writes and validates `wave1-evidence-manifest.json`, the Wave 1 evidence manifest of plan §13. It records the commit and tree, lockfile digest, toolchain pins, the qualification receipts (canonical commands, `test-long-run`, `qualify-wave0`, each authenticated by log digest and candidate), every golden's file digest and bundle hash, the long-run results with their time and memory counters, the RW-0101 to RW-0110 merge record (`scripts/ci/qualify-wave1-packets.json`, checked against the candidate's history), one disposition per literal §13 item and the exit decision. It re-authenticates the long-run bundles, reads each run's horizon from its bundle and re-runs the checks. Items that need independent review stay `pending`, and missing evidence stays missing, so the decision is `not-qualified` until every item passes. Validation recomputes every disposition from the manifest's own facts and refuses any that claim more. Qualification's `wave1-manifest` job runs it on both jobs' retained evidence.
- `pnpm run qualify:wave2 [--qualification <dir>] [--wave2 <dir>] [--out <dir>]` writes and validates `wave2-evidence-manifest.json`, the Wave 2 evidence manifest of plan §19. It records the commit and tree, lockfile digest, migration head and every migration's digest, the schema hash (`pg_dump --schema-only` of a fresh database migrated to head, comment lines removed), the qualification receipts, test:db's per-case results for the crash-window, RLS and prior-release fixture suites (`test-db.vitest.json`), every golden's digest and per-run final hash, and the journal long-run results (`journal-long-runs.json`, from `test:long-run`): each scenario run's checks, which must end on its golden's final hash, and each long run's replay throughput and per-call journal latency on the recorded host. Each literal §19 item is `passed` from receipts, `review` with the named review it needs, or `deferred` with the issue that owns it (issue 2, issue 654, issue 677). The two RW-0209 items, "prior fixture matrices" and "every supported historic fixture", pass only when test:db's report holds `PRIOR_RELEASE`'s cases (`scripts/ci/qualify-wave2-manifest.mjs`) as passed; a failed case makes them `failed` and an absent or unrun case `missing`. The exit decision is `qualified`, `pending-review` or `not-qualified`. Validation recomputes every disposition and refuses any that claim more. `test:db` and `test:long-run` write both files to the `--wave2` directory only when `CLOCKGROVE_WAVE2_EVIDENCE` names it, which only Qualification does, outside `CI_EVIDENCE_DIR`, so the Wave 0 evidence manifest is unchanged. Qualification's `wave2-manifest` job runs it on the qualification job's evidence.
- CI is split in two. Quality (`.github/workflows/quality.yml`, required check `quality`) runs one pass of the canonical commands, the browser journey and the build on every PR and main push; main pushes also run `qualify:wave0`. Parallel jobs (`checks`, `tests`, `database`, `browser-build`) each record a share of the commands with `node scripts/bootstrap.mjs <dir> --only <names>`, and `test:runtime` runs in the `runtime-1` to `runtime-4` jobs, one shard each, with `node scripts/bootstrap.mjs <dir> --runtime-shard <n>`. The `quality` job merges their receipts into one evidence manifest and fails unless every job passed and the manifest's `extensions.missingCommands` is empty. Qualification (`.github/workflows/qualification.yml`, daily schedule and manual dispatch, never a required check, with nothing released or deployed after it) runs the full gate: the disposal/re-bootstrap journey, `test:long-run` and `qualify:wave0`, and retains its evidence for 90 days. Both run on the `QUALITY_RUNNER` repository variable, defaulting to `ubuntu-26.04`.
- A Wave 1 or Wave 2 evidence manifest is stale when its `candidate.commit` is not main's head. Qualification's daily scheduled run (03:17 UTC) detects that: its `stale` job, on the standard `ubuntu-26.04` runner, lists the retained `wave2-evidence-manifest` artifacts and qualifies main's head only when none belongs to that commit from a run that succeeded, so main is requalified within a day of moving. A failed run's manifest does not count: the next day's run qualifies the same commit again. A successful run's manifest counts whatever its exit decision, since a rerun of the same commit cannot change it. That is at most seven paid runs a week, one per day on which main moved or the last run failed. A full run took about 41 `QUALITY_RUNNER` minutes (`ubuntu-latest-m`) in run 39604752325, so at most about 290 a week; the job timeouts (120 + 150 + 30 + 30 + 30 + 30 minutes) cap one run at 390. The `wave3-load-curves` and `wave3-manifest` jobs came after that run, so their minutes are not in the 41: the load fixture took about 2 minutes 20 seconds on a 24-thread local host (with issue 900's keepers sweep) and is bounded at 10, and the Wave 3 manifest, like the Wave 2 one, installs, migrates one disposable database and reads the evidence. A day that is skipped costs one short standard-runner job, billed as one minute. A manual dispatch always runs, on any ref.
- `pnpm run qualify:wave3:load-curves [<evidence-dir>]` runs the Wave 3 §19 load fixture (`apps/runtime/test/load-curves.long-run.test.ts`) alone and writes `wave3-load-curves.json`: the hot-space and catch-up-storm curves through the native workerd/PostgreSQL owner path, resource counters, each runtime budget with its status (`tripped`, `not-reached` or `not-observable`) and the load at which it trips, host facts, the candidate, wall time and peak memory. It fails over its 10-minute wall-time bound. Neither Quality nor `test:long-run` runs it. Qualification's `wave3-load-curves` job runs it alone on its runner, through `scripts/ci/evidence.mjs run` so its receipt carries the candidate and log digest, and retains the receipt and the result as `wave3-load-curve-evidence` for the Wave 3 evidence manifest. See [runtime.md](runtime.md#runtime-budgets-and-load-curves).
- `pnpm run qualify:wave3 [--qualification <dir>] [--load-curves <dir>] [--out <dir>]` writes and validates `wave3-evidence-manifest.json`, the Wave 3 evidence manifest of plan §23. It records the commit and tree, lockfile digest, migration head, every migration's digest and the schema hash (measured as `qualify:wave2` does); the Wrangler, Miniflare and workerd versions, each `infra/wrangler/*.json` environment's compatibility date and flags, and the binding manifest's digest over those files; the qualification receipts (the Wave 1 set and the `qualify-wave3-load-curves` receipt, each authenticated by log digest, command and candidate); the §18.1 commands; every §17 case of `scripts/ci/wave3-fault-matrix.json` with the status of its command's receipt; native-owner scenario parity, read from the `native-owner parity` lines in the authenticated `test:long-run` log, each golden run's final hash compared with the committed golden and each pack's 30-day soak with its pure run; and `wave3-load-curves.json`'s `loadCurves`, `resourceCounters`, budgets and partition seams as they are. A budget the fixture cannot observe is `pending` on its issue, never measured (none since issue 900 made `DUE_WORK_ADVANCE_BUDGET.maxInputs` observable). Each literal §23 item is `passed` from candidate-bound evidence, `review` naming the review it needs, `deferred` to the wave the plan's amendments name, `pending` naming what is missing and its issue, or `failed`. Items that need real Cloudflare and every §18.2 item stay `pending` on issue 3, and "Main remains deployable" on issue 2; the validator refuses them marked passed, recomputes every disposition and the exit decision (`qualified`, `pending-review` or `not-qualified`), and refuses any that claim more. Qualification's `wave3-manifest` job runs it on the `qualification` and `wave3-load-curves` jobs' evidence and retains `wave3-evidence-manifest`.
- The Wave 4 §15.1 suites: `pnpm run test:projection` (scene contracts in `packages/contracts/test`), `test:realtime` (the scene socket's admission, delivery, observer authority, viewed-space and interaction-card PostgreSQL files), `test:web` (the convergence reducer and query contracts in `apps/web/test`) and `test:scene` (the scene adapter, headless 3D fixture and React/Phaser boundaries) name files that `pnpm test`, `test:runtime` and `test:db` already run. `test:e2e` (`tests/e2e`), `test:visual` (`tests/visual`), `test:a11y` (`tests/accessibility`) and `test:realtime:load` (`tests/load/realtime`) run their files through `tests/ci/vitest.browser.config.ts`, so they need `env CI=true` and the pinned Chromium, and Quality's `browser-build` share and Qualification run them in that config. `qualify:wave4:staging` does not exist yet; it is pending on issue 881.
- `pnpm run qualify:wave4 [--out <dir>]` runs those eight suites once on the checkout, with `CLOCKGROVE_WAVE4_EVIDENCE` set, and writes `wave4-manifest.json`, the Wave 4 manifest of plan §19, with its evidence beside it. The default directory is `.qualification/wave4-<ms>/`. The evidence is the suite logs, the 78 §15.3 captures (13 states at 3 viewports, on WebGPU and on forced WebGL2) with their `captures.json`, the axe report, Web Vitals and the fanout load. The manifest records the commit and whether the tree is clean. It records the scene protocol, migration and asset-tree digests, the pinned Chromium matrix, and each suite's result. It maps every §15.2 scenario and §16 item in `scripts/ci/qualify-wave4-scenarios.json` to its literal test markers, re-checked in their files. Each capture's SHA-256 is compared with the human approvals in `tests/visual/approved-captures.json`. A full-coverage row whose cited file no §15.1 suite runs is a `deviation`, not `passed`. A `not_applicable` row is an item the owner ruled out of Wave 4: it needs a `reason` and no evidence, is listed under `notApplicable` and is neither a deviation nor a blocker. The thirteen literal §19 items each carry a disposition: `passed`/`failed` from their suites, `pending` (Cloudflare on issue 3, main deployable on issue 2) or `review` for a person. A reviewer records a `review` item in `scripts/ci/qualify-wave4-review.json` with the candidate commit, the qualification run, the reviewer and the evidence; the item is `reviewed`, and no longer a blocker, only on a manifest of that same candidate with a `checked` result. Otherwise the record is attached as `lastReview` and the item stays `review`. The file's `scenarioRowsNotReviewedFull` attaches a reviewer's finding to a §15.2 row without changing its suite status. The Cloudflare items stay `pending` on issue 3. The manifest also lists known deviations and the exit decision. It refuses a directory that already holds a manifest and makes every file it wrote read-only. Capture hashes depend on the renderer and the machine, so the record comes from CI: Wave 4 qualification (`.github/workflows/qualify-wave4.yml`, manual dispatch only, on the `QUALITY_RUNNER` class) runs it and retains the output directory as the artifact `qualify-wave4-<commit>` for 90 days, whatever the exit decision. Golden reviews use that artifact's `evidence/visual/` images, and `tests/visual/approved-captures.json` pins the hashes from its `captures.json`; a capture from another machine is not an approval candidate. The daily Qualification workflow does not run it.
- The Wave 3 plan §18.1 commands are root scripts that run named `apps/runtime` test files: `test:runtime:interleaving` (the owner mailbox), `test:runtime:alarms`, `test:runtime:queues`, `test:runtime:workflows` and `test:runtime:recovery` through the `test:runtime` config, and `verify:runtime-scenario-parity` (the native-owner and autonomous scenario parity long runs) through the long-run config. They are focused reruns of files `test:runtime`, `test:db` and `test:long-run` already run, and no file is in two of them. `test:runtime:actors` and `test:runtime:transfers` are removed by a plan amendment (RW-0307 is in Wave 5, RW-0308 in Wave 11). `pnpm check` runs `scripts/check-runtime-commands.mjs`, which refuses a §18.1 command with neither a script nor a removing amendment, a script that names no file or a file that is not such a test, and a file two scripts name.
- `test:db` runs the runtime `*.postgres.test.ts` files that `scripts/database/test.mjs` names. A bare `test:runtime` excludes exactly those files, so none runs twice; a run that names its files, as `test:db` and the recovery journeys do, excludes nothing.
- Quality shards the bare `test:runtime` (`scripts/ci/runtime-shards.mjs`, issue 975): it packs the files Vitest lists for that run, longest first, by the per-file seconds in `scripts/ci/runtime-shard-durations.json` (an unlisted file counts as their mean), and each shard runs `pnpm run test:runtime --no-file-parallelism <its files>`, serially like the bare run, as its own receipt `test-runtime-<n>-of-<count>`. Every file runs in exactly one shard: the shard jobs, the evidence collector and `qualify:wave0` each recompute the partition and refuse a lost or doubled file, or a shard for which Vitest lists any file but its own (a name can match another file's path, `test:db`'s files included), and the receipts count as `test:runtime` only as a complete set, recorded in the manifest's `extensions.runtimeShards`. Qualification still runs the bare command once. To rebalance, run a bare `pnpm run test:runtime --reporter=default --reporter=json --outputFile.json=<report>` on the `QUALITY_RUNNER` class and `node scripts/ci/runtime-shards.mjs <report>`.
- `pnpm check` runs `scripts/check-browser-tests.mjs`, which refuses Playwright or a browser launch outside the `include` of `tests/ci/vitest.browser.config.ts`; see [testing.md](testing.md#lasting-tests).
- `verify:docs` validates ADRs and wave plans only. Runbooks are not schema-checked.
- Documentation links are checked by `pnpm check`, in Quality's `checks` job on every PR: `scripts/check-doc-links.mjs`, run by `scripts/check-boundaries.mjs`, requires every repository-relative link in the checkout's Markdown files to reach a path in the checkout and its `#anchor` to match a heading of the target as GitHub renders it. It runs offline; external links such as `https:` and `mailto:` are never fetched.
- `.env.example` (operator and tooling names) and `.dev.vars.example` (the Worker secret bindings) at the root list every secret name of the catalog `requiredSecrets`, with no values. Read them to see which names a hosted environment needs; `local` and `ci` need none. Credentials come from the operator's secret manager session, never a committed file; `.env`, `.dev.vars` and their variants are git-ignored. `scripts/check-env-examples.mjs` generates both from the catalog and the secret table of [infrastructure.md](infrastructure.md), and `pnpm check`, through `scripts/check-boundaries.mjs`, refuses a missing or extra name, a name in the wrong file, any value or any other byte of drift, after proving that on an inline fixture. Run `node scripts/check-env-examples.mjs --write` after a reviewed catalog change.
- `provenance.json` at the root is the repository provenance inventory: every file or directory that is not original Clockgrove work (reused, vendored, third-party-licensed or generated from a third-party source), with its source, SPDX license expression and reason. Add an entry in the change that brings such content in. Third-party npm dependencies are not listed there; it names the CycloneDX SBOM that `scripts/supply-chain.mjs` writes. `pnpm check`, through `scripts/check-boundaries.mjs`, refuses an entry whose path is not in the checkout or that lacks a source, license or reason, after proving that on an inline fixture; `verify:supply-chain` runs the same check.
- `REUSE.toml` at the root gives every file its licence and copyright under [REUSE 3.3](https://reuse.software/spec-3.3/), by path glob, so files carry no headers; the licence texts are in `LICENSES/`. Content that gets a `provenance.json` entry also gets its own `REUSE.toml` annotation with the same licence, after the broader ones (the last match wins). The REUSE workflow (`.github/workflows/reuse.yml`) runs `reuse lint` on every PR and merge-queue entry; run it locally with `reuse lint` from the `reuse` Python package.
- `pnpm test` runs offline, including manifest schema, secret declaration and Wrangler configuration checks against the runtime entry. Testkit discovers `tests/infra/`; its test task is uncached so the repository secret scan always inspects the current checkout.
- Run `pnpm run infra:validate` after infrastructure or runtime entry changes. It installs the pinned providers into a fresh directory, then runs backend-free OpenTofu validation and Wrangler dry-runs for all five environments. Without network, it needs the provider mirror that `scripts/ci/toolchain.sh opentofu-providers` fills beside the `tofu` on `PATH` (`<prefix>/share/opentofu-providers`); with no complete mirror it downloads from the public OpenTofu registry, as CI does. A mirror is allowed only because `tofu init -lockfile=readonly` checks every package against the hashes in `infra/opentofu/.terraform.lock.hcl` and refuses a mismatch; no other mirror, cache or user CLI configuration is used. Agent sandboxes without network rely on it. It uses no cloud credentials and creates no resources. The Quality workflow runs it as a separate step; see [infrastructure.md](infrastructure.md) for details.
- `pnpm infra:plan <environment>` makes a read-only OpenTofu plan of `local`, `ci`, `development` or `staging` and never applies; `local` and `ci` plan offline with no credentials and must stay empty. `pnpm test:cloud [environment]` (default `staging`) checks that the plan is reproducible with no pending change and, on a hosted environment, probes the deployed origin. Quality's `checks` job runs both for `ci`. `pnpm infra:state <command> <environment>` reports a hosted environment's state lock, clears a stale one by its ID, and lists or restores its dated state backups. See [infrastructure.md](infrastructure.md).

## Workspace layout

- List every new workspace package in `pnpm-workspace.yaml`. Unlisted packages are not installed or checked.
- Give every new app its own `.gitignore` for `node_modules/`, `dist/` and `.turbo/`. The root `.gitignore` covers only `packages/*`, not apps.

## Dependency install scripts

- pnpm 12 refuses install scripts that are not approved under `allowBuilds` in `pnpm-workspace.yaml`. Install fails with `ERR_PNPM_IGNORED_BUILDS`. `onlyBuiltDependencies` is ignored. Approved today: `esbuild`, `workerd`.
- Approving a dependency's build is a maintainer decision made on `main` before work that needs it. It lets third-party code run on every machine and CI.

## Runtime composition

- `apps/runtime/src/cloudflare-entry.ts` is the Cloudflare entry, exported as `@clockgrove/runtime/cloudflare`. It holds the default handler, the native Durable Object and Workflow classes, and the binding manifest `runtimeBindingManifest`. The manifest is the exact deployment surface: bindings and queue-name variables are declared once there.
- Portable shells (`apps/runtime/src/owners.ts`, `worker.ts` and the packages) stay free of Cloudflare types. `scripts/check-boundaries.mjs` enforces this, so provider types stay replaceable.
- Fresh Worker and World/Space/Actor isolates compose directly from scalar bindings. `injectRuntimeComposition` remains an explicit local/test override for readers, consumers and optional PostgreSQL services; it is not a deployed initializer. Hyperdrive supplies the default canonical PostgreSQL journal and state reader. Cloudflare composition always selects the Better Auth reference adapter or a refusing provider; it never uses an injected deterministic authentication provider. The default world-reactions consumer verifies committed batches durably; cognitive-indexing and external-effects keep refusing consumers. The post-commit notifier and scheduled handler run the canonical dispatch sweep through WORLD_REACTIONS_QUEUE; the post-commit notifier also hints the actors subscribed to the committed events ([proactive activation](../protocols/conversation-fibers.md#proactive-activation)). The scheduled handler also runs the snapshot sweep (verification replay, then a snapshot) over the artifact store that `composeArtifactStore` builds on the `ARTIFACTS_BUCKET` R2 binding, with no artifact keyring. Native local Queue evidence extends the existing world-owner fixture with operation-owned Queue storage, PostgreSQL and process cleanup; it does not claim hosted deployment or full Wave 3 qualification. Scene admission and bounded projection delivery are available locally ([realtime projection](../protocols/realtime-projection.md#bounded-native-delivery-and-recovery)); hosted hibernation and redeploy qualification remain pending on issue 881.
- Default metadata uses the decoded command ID as its logical request ID. Clients retain `x-correlation-id` when retrying exact command bytes; request correlation is otherwise generated per invocation.
- The runtime gateway answers an authentication refusal with 401, an authorization refusal with 403, and other request conflicts with 409. Browser and API clients rely on the distinction.

## Local living-yard checkpoint

`pnpm dev:world` brings up the living yard for interactive use. It needs the PostgreSQL 18.6 and pgvector 0.8.7 set from [Tools](#tools). It reuses the browser journeys' native harness (`runNativeWorldOwnerProcess` and `withNativeWorldOwner` in `apps/runtime/test/world-owner/native-harness.ts`), so it composes the same stack those journeys do:

- a disposable PostgreSQL cluster in a new temporary directory, migrated to head;
- `fixture-hall@1` (`worlds/fixture/reference`) provisioned, with the fixture principal `principal-runtime` as its observer, holding `runtime:world-observe` only, as in the issue 800 journey;
- the native runtime in workerd (Miniflare) on that database, and `apps/web` on Vite at `127.0.0.1:5173` (or the next free port), proxying `/v1` and the scene socket to the runtime.

When the stack is up, it prints the world route to open (`/worlds/{tenant}/{world}/{timeline}/{space}`) and the local session credential to sign in with, `hall-observer`. The route opens the provisioned world directly after sign-in, so no identifier needs typing. Ctrl-C, SIGTERM or closing the terminal stops everything and removes the database and runtime storage; nothing persists between runs. Only a SIGKILL of the launcher leaves the temporary cluster behind. One session lasts at most 4 hours, the credential's lifetime too (a decision: it covers one pilot session; restart for more); `CLOCKGROVE_DEV_WORLD_HOURS` sets another positive bound. `scripts/dev-world.mjs` is the launcher. It runs the session, `scripts/dev-world.session.mjs`, through Vitest in its own process group, because Vitest exits at once on Ctrl-C, before the harness could stop PostgreSQL. The launcher turns Ctrl-C, SIGTERM or SIGHUP into a stop file that the session watches. `tests/ci/dev-world.journey.browser.test.mjs`, in the browser journey config, runs the command. It signs in at the printed URL with the printed credential, expects `Arrival: scene ready at revision 0.`, and checks that Ctrl-C exits 0 with the database directory removed. It is a local checkpoint, not hosted deployment or qualification evidence.

## Better Auth reference composition

- The runtime pins Better Auth 1.7.7. Its adapter uses `better-auth`, Kysely 0.29.6's built-in `PostgresDialect` and `pg` 8.23.1. Each authentication request owns a `Pool` limited to one connection, destroyed in `finally`. Request-owned Client and Pool error listeners retain connection failures through cleanup and refuse authentication before returning an identity. Ending a connection can discard a termination the request has not read yet (issue 983; per-transport results in issue 1004): on Workers, `pg-cloudflare` 1.4.1 `CloudflareSocket.end()` calls the workerd socket's `close()`, which drops data its read loop has not delivered, and passes a failed write only to its callback; on a Unix socket `pg` ignores its Terminate write's EPIPE while ending. Node over TCP, with or without TLS, read the termination first. So once the identity is resolved the adapter sends one `SELECT 1` on the connection it used (the pool's idle timeout is off, so that connection is still the one), and a termination fails that round trip on every transport. It costs one round trip per successful authentication. A termination that reaches the connection only while it closes, after every read, is not observed. SDK types remain in `apps/runtime/src/better-auth-adapter.ts`; the composition root consumes project-owned configuration and ports.
- The existing named secret is `BETTER_AUTH_SECRET`. Supply it through the environment's secret binding, never a committed value. It must contain at least 32 characters with no surrounding whitespace. No default or process-environment secret discovery is used by the adapter.
- The five manifests declare `AUTH_ORIGIN` as the exact HTTPS runtime origin and `PROVIDER_ENVIRONMENT` as the canonical environment. Default composition consumes `AUTH_DATABASE_URL` (`clockgrove_auth_verifier`), `MANAGEMENT_DATABASE_URL` (`clockgrove_management_reader`) and `WORLD_AUTHORIZATION_DATABASE_URL` (`clockgrove_world_reader`) through direct PostgreSQL transport. These generated connections stay in the existing protected handoff; no function-valued deployment binding or process-environment discovery is used. Hyperdrive retains `clockgrove_runtime` exclusively for canonical state/journal traffic.
- Forward migration `0002_authentication_authority.sql` owns the pinned Better Auth core schema in `clockgrove_auth`, Management principals/identity links/optional workspace administration in `clockgrove_management`, and Runtime committed participation in `clockgrove.world_memberships`. Verification can SELECT only user/session storage; it cannot enroll, refresh, link accounts or write canonical participation. Management and World readers use separate request-owned clients, read-only transactions, exact transaction-local scopes and forced RLS. Runtime World access requires committed membership/persona, explicit grants and decoded privacy categories; workspace administration never supplies World authority.
- Explicit injection may supply project-owned `referenceAuthentication` configuration for local integration, with a Management `resolveIdentity(environment, subject)` seam. Production SDK subjects/types terminate at the adapter and that Management lookup; only opaque identity/principal IDs proceed inward. Configuration and connection information remain in memory; never commit credentials.
- Missing/invalid configuration refuses authentication with 401 before routing or canonical mutation, even if an injected composition includes a test provider. A configured storage outage also refuses new authentication. No cloud calls or credentials are needed to validate this work.
- Scene WebSocket upgrades at `/v1/projection` use the dedicated
  `clockgrove.bearer.<session-credential>` subprotocol carrier alongside `clockgrove.scene.v1`.
  The gateway verifies the current provider session on every upgrade, using the same
  `TrustedRuntimeRequestAuthenticator` and principal/authorization readers as HTTP requests.
  Only the protocol name is selected in the response. URL credentials and cookie-only sessions
  are refused. The existing `BETTER_AUTH_SECRET` also signs domain-separated internal scene join
  assertions with a 30-second engineering expiry, bounding a single gateway-to-owner hop.
- Runtime bearer credentials are passed to Better Auth's bearer plugin and `getSession` API. Cookie caching and session refresh are disabled for verification; each request checks the current stored session, including expiry and revocation. Unmapped subjects fail closed. Better Auth user/account/session IDs stay in the adapter and the Management link reader; only an opaque `ExternalIdentityId` enters application authorization. Better Auth supplies no canonical `PrincipalId`, so `PrincipalMappingPort` uses the durable Management reader by default. Linking provider accounts does not provision principals, worlds, memberships, roles or grants.
- Local/test compositions explicitly instantiate `DeterministicTestAuthProvider` from `apps/runtime/local/test-auth.ts` with `TrustedRuntimeRequestAuthenticator`, outside the Cloudflare production selector. There is no environment flag that permits production to select the deterministic provider.
- `apps/runtime/test/auth-conformance.ts` registers the same cases for both adapters. Better Auth uses its real memory storage and server APIs with local synthetic test data; no hosted service or network is used. Its organization plugin is enabled only in the conformance fixture to demonstrate that provider organization drift cannot replace canonical participation. Production does not enable provider organizations or invitations. Better Auth has no external session-event ingestion here: duplicate/reordered notifications are read-only hints and cannot rewrite the authoritative session store; the deterministic adapter additionally exercises versioned events and conflicting duplicates.

Hyperdrive uses one request-owned `pg` Client from the binding connection string.
Cleanup rolls back unfinished transactions and closes the connection. Its error listener
retains connection failures through cleanup so the operation rejects instead of returning
success. Ending can discard a termination the operation has not read yet: Workers'
`pg-cloudflare` 1.4.1 socket drops unread data on close, and `pg` ignores EPIPE on a Unix
socket while ending; Node over TCP, with or without TLS, reads it first. Authentication and
authorization reads therefore confirm their session with one `SELECT 1` on the same
connection before release, which a termination fails on every transport (08006 when the
server's error is not seen), at one round trip per successful read: an authority read that
observes a termination refuses. Canonical state and journal results stay valid
after a later termination, which would only cause a retry, so they do not confirm; that
includes the canonical read behind the scene-join assertion's `authorityEpoch`. The
local NUL-prefixed abstract socket URL uses pg's declared `stream`
configuration with a real Node socket; ordinary Hyperdrive URLs retain default transport.
All five Wrangler configurations enable `nodejs_compat`.

## Pinned dependency selection

Official npm publication metadata was read at `2026-10-06T06:17:05.204Z`; the unchanged
1440-minute release-age cutoff was `2026-10-05T06:17:05.204Z`. These are the newest
eligible stable releases; Node typings stay on the supported Node 24 major. All resolved
dependencies must also pass pnpm's unchanged age, provenance and build controls during
`pnpm install --frozen-lockfile --ignore-scripts`. No release-age exclusions are authorized.

| Official package | Exact selection | Publication time (UTC) |
| --- | --- | --- |
| [@ai-sdk/anthropic](https://registry.npmjs.org/%40ai-sdk%2Fanthropic) | `4.0.97` | `2026-11-05T01:11:40.981Z` |
| [@biomejs/biome](https://registry.npmjs.org/%40biomejs%2Fbiome) | `2.5.15` | `2026-09-30T15:23:18.673Z` |
| [@types/node](https://registry.npmjs.org/%40types%2Fnode) | `24.19.1` | `2026-10-01T22:38:02.894Z` |
| [@types/react](https://registry.npmjs.org/%40types%2Freact) | `19.3.0` | `2026-09-09T18:08:49.750Z` |
| [@types/react-dom](https://registry.npmjs.org/%40types%2Freact-dom) | `19.3.0` | `2026-09-09T18:07:51.886Z` |
| [@typescript/typescript6](https://registry.npmjs.org/%40typescript%2Ftypescript6) | `6.0.2` | `2026-07-06T18:06:47.459Z` |
| [ai](https://registry.npmjs.org/ai) | `7.0.163` | `2026-11-05T01:12:02.967Z` |
| [better-auth](https://registry.npmjs.org/better-auth) | `1.7.7` | `2026-09-30T21:30:55.572Z` |
| [dependency-cruiser](https://registry.npmjs.org/dependency-cruiser) | `18.5.0` | `2026-09-30T19:18:29.691Z` |
| [drizzle-orm](https://registry.npmjs.org/drizzle-orm) | `0.45.3` | `2026-09-21T10:06:39.969Z` |
| [kysely](https://registry.npmjs.org/kysely) | `0.29.6` | `2026-09-16T00:59:27.614Z` |
| [@types/pg](https://registry.npmjs.org/%40types%2Fpg) | `8.23.1` | `2026-08-17T20:10:18.296Z` |
| [pnpm](https://registry.npmjs.org/pnpm) | `12.9.1` | `2026-10-03T20:48:16.304Z` |
| [pg](https://registry.npmjs.org/pg) | `8.23.1` | `2026-09-30T15:39:58.489Z` |
| [react](https://registry.npmjs.org/react) | `19.3.0` | `2026-09-09T17:21:30.071Z` |
| [react-dom](https://registry.npmjs.org/react-dom) | `19.3.0` | `2026-09-09T17:17:39.744Z` |
| [turbo](https://registry.npmjs.org/turbo) | `2.11.7` | `2026-10-02T14:58:24.627Z` |
| [typescript](https://registry.npmjs.org/typescript) | `7.0.2` | `2026-07-08T15:55:18.431Z` |
| [vite](https://registry.npmjs.org/vite) | `8.3.2` | `2026-10-01T10:17:44.767Z` |
| [vitest](https://registry.npmjs.org/vitest) | `5.0.3` | `2026-09-30T11:30:42.429Z` |
| [wrangler](https://registry.npmjs.org/wrangler) | `4.147.0` | `2026-10-02T11:30:47.699Z` |
| [zod](https://registry.npmjs.org/zod) | `4.6.6` | `2026-10-11T16:18:23.878Z` |

Advisories published after `2026-10-22` moved three locked packages to their patched releases on
`2026-10-27`, all older than the unchanged 1440-minute cutoff: `zod` 4.6.6 (direct; `better-auth` 1.7.7
pins 4.6.5, so `pnpm-workspace.yaml` overrides `zod@<4.6.6`), and through scoped overrides `fast-uri`
3.1.9 (`2026-10-19T23:05:26.357Z`, via `ajv` 8.20.0) and `undici` 7.30.1 (`2026-10-15T14:18:31.283Z`,
via `miniflare`); `undici` 8.12.3 is unchanged. The domain's declared Zod path pin in
`dependency-cruiser.config.mjs` follows the `zod` version.

The driver swap reconfirmed official npm metadata at `2026-10-06T10:50:38Z`:
`pg` and `@types/pg` latest stable releases remain 8.23.1. pg supplies no TypeScript
declarations, so `@types/pg` is a runtime development dependency. The added closure
has no install lifecycle scripts; unrelated locked versions and toolchain policy are retained.

Issue 16 added `ai` 7.0.163 and `@ai-sdk/anthropic` 4.0.97 to `packages/model-gateway`, with `zod` 4.6.6
(already pinned) as a direct dependency. Their closure added `@ai-sdk/gateway` 4.0.136,
`@ai-sdk/provider` 4.0.36, `@ai-sdk/provider-utils` 5.0.75, `@vercel/oidc` 3.2.0, `@workflow/serde` 4.1.0,
and `eventsource-parser` 3.1.1. They were resolved on `2026-11-07` by `pnpm add` under
the unchanged release-age and supply-chain policy; `ai` 7.0.164 and `@ai-sdk/anthropic` 4.0.98, published
`2026-11-06T19:44Z` and `19:46Z`, were inside the 1440-minute window and are not selected. Registry metadata
shows no `preinstall`, `install` or `postinstall` script in the closure.
`@ai-sdk/provider` also declares `json-schema` 0.4.0, licensed `(AFL-2.1 OR BSD-3-Clause)`. The supply-chain
check reads an SPDX `OR` as any one alternative, and BSD-3-Clause is allowed, so the package stays in the tree.

Issue 19 makes `apps/runtime` depend on `@clockgrove/model-gateway` (workspace link, no new external package):
the actor owner builds the gateway and the pack-configured responder (`apps/runtime/src/actor-model.ts`) from it. The runtime reads
`ANTHROPIC_API_KEY` and `AI_GATEWAY_API_KEY` from its environment; without either it answers from the scripted fixture.

Issue 18 pins the Cloudflare Agents SDK for `ActorAgentDO`, as the implementation plan §10.1 and the
Wave 5 plan §2 amendment require. [agents](https://registry.npmjs.org/agents) `0.33.0` was published
at `2026-11-03T13:16:52.689Z`, past the unchanged 1440-minute cutoff on `2026-11-07`. It is the
newest stable release and the exact selection in `apps/runtime/package.json`. Its closure has no
install lifecycle scripts. Node-side Vitest configurations alias `agents` to the local fake, because
only workerd runs the owner.

Issue 67 added `three` 0.187.0 (MIT, published `2026-10-30T08:09:24Z`, no dependencies and no install
scripts) to the throwaway `spikes/renderer-bakeoff` workspace package only. It was resolved on `2026-11-07`
under the unchanged release-age and supply-chain policy. No product package depends on it. The spike
types it with a local `declare module` shim instead of `@types/three`, whose dependency closure a
spike does not need.

Issue 77 added the 3D Stevie spike's ship tools (`spikes/renderer-bakeoff/scripts/ship.mjs`) as exact
devDependencies of the throwaway `spikes/renderer-bakeoff` workspace package only, resolved on `2026-11-08` through
pnpm under the unchanged release-age, provenance, build and licence controls. No product package depends on them.
`sharp` runs no install script: its prebuilt `@img/sharp-*` binaries are optional dependencies, and the lockfile
already carried `sharp` 0.35.5 through the `miniflare` override. The Khronos validator publishes only `-dev`
versions on npm; `2.0.0-dev.3.10` is its newest.

| Official package | Exact selection | Publication time (UTC) | License |
| --- | --- | --- | --- |
| [@gltf-transform/core](https://registry.npmjs.org/%40gltf-transform%2Fcore) | `4.5.1` | `2026-09-28T12:51:13.194Z` | MIT |
| [@gltf-transform/extensions](https://registry.npmjs.org/%40gltf-transform%2Fextensions) | `4.5.1` | `2026-09-28T12:48:44.869Z` | MIT |
| [@gltf-transform/functions](https://registry.npmjs.org/%40gltf-transform%2Ffunctions) | `4.5.1` | `2026-09-28T12:49:17.189Z` | MIT |
| [meshoptimizer](https://registry.npmjs.org/meshoptimizer) | `1.3.0` | `2026-09-25T15:42:07.109Z` | MIT |
| [gltf-validator](https://registry.npmjs.org/gltf-validator) | `2.0.0-dev.3.10` | `2024-10-22T14:21:47.401Z` | Apache-2.0 |
| [ktx2-encoder](https://registry.npmjs.org/ktx2-encoder) | `0.6.0` | `2026-07-19T12:09:02.909Z` | MIT |
| [sharp](https://registry.npmjs.org/sharp) | `0.35.5` | `2026-09-27T13:46:24.509Z` | Apache-2.0 |

Issue 163 makes `packages/assets` depend on [ktx2-encoder](https://registry.npmjs.org/ktx2-encoder)
`0.6.0` (MIT, published `2026-07-19T12:09:02.909Z`, the newest release on `2026-11-09`), which the
lockfile already carried for the spike above, so no new package or version enters the tree. It
bundles a single-threaded Basis Universal encoder wasm (Apache-2.0, upstream commit
`1b33fd5098c6e7b58324146b8f5518cbb4cdfb72`, per its `THIRD_PARTY_NOTICES.md`) and depends on
`ktx-parse` 1.1.0 (MIT); neither runs an install script. The asset build encodes material pages
with it (see the [asset pipeline](../../packages/assets/docs/pipeline.md#lit-material-rollout)).
The web app transcodes them with the Basis transcoder that `three` 0.187.0 ships
(`examples/jsm/libs/basis`, Apache-2.0), built into the app's assets from the lockfile.

Vite 8.3.3 was published at `2026-10-06T04:10:19.326Z` and was ineligible at this
cutoff. Vite 8.3.2 is selected without a workspace policy exception.

The official side-by-side TypeScript declarations are exactly
`@typescript/native: npm:typescript@7.0.2` and
`typescript: npm:@typescript/typescript6@6.0.2`. The first owns the sole `tsc`
executable; the API compatibility package exposes only `tsc6`, so installation order
cannot select a different `tsc`. Existing `typescript` imports resolve the supported
JavaScript compiler API implementation 6.0.3. `pnpm check` verifies the installed
`tsc` target/version, package identities, and shared API resolution for repository AST
consumers and dependency-cruiser before exercising the existing boundary checks.

## W0-009 CI controls

The only additional root command is `pnpm run verify:supply-chain`. It enforces the retained
license allowlist, inventories the full workspace lockfile in a CycloneDX SBOM, checks npm's
bulk vulnerability advisory endpoint without suppression, and scans the complete repository
secret surface. It needs the npm registry (license metadata and advisories), so it runs in CI's
Quality job, not in offline agent or Factory validation; don't list it as a Work Item
validation command. A package's licence is its registry `license` string; without one, npm's
legacy `licenses` array, whose types become one `OR` expression; without either, an entry in
`verifiedLicenses` in `scripts/supply-chain.mjs`. That entry is keyed by exact `name@version`
and names the upstream licence file it was verified from, so a version bump fails until someone
re-verifies it. Every expression still goes through the allowlist, and a malformed array counts
as no licence. Dependency policy and contract inventory drift also run through the existing
boundary checker. `pnpm check` proves the boundary rules reject their negative fixtures, and
`tests/infra/secrets.test.mjs` proves the scanner finds a constructed credential in the
committed tree, the index and untracked files. `tests/ci/regressions.test.mjs` proves the
contract checker refuses drift, evidence never promotes an unobserved outcome, `test:runtime`
shards run each file once and count only as a complete set, Quality measures
a pull request against the main its merge commit was built on, and CI deadlines settle
termination-resistant descendants. Contract drift requires
both regeneration and a version increase relative to the CI base. Drift is measured on the parsed
syntax, so formatting, comments and import order never count; `node scripts/contract-drift.mjs .
--generate` bumps the version only when the meaning differs from `HEAD`. No fixture is exempted.

Offline root tests discover those controls through testkit, but never discover the real
browser journey. Quality installs the exact lockfile-pinned Playwright Chromium and native
libraries with `scripts/ci/toolchain.sh browser-deps browser`. `browser-deps` installs the
system packages that Chromium needs with that Playwright's `install-deps chromium` (sudo, no
`pnpm install` needed) unless the pinned Chromium already launches or none is missing.
`browser` runs `pnpm exec playwright install chromium` into the user's Playwright cache, with no
sudo, unless that Chromium is already installed and launches. Factory's setup step runs
`browser-deps` and its unprivileged install step runs `browser`. Quality then explicitly invokes
`node node_modules/vitest/vitest.mjs run --config tests/ci/vitest.browser.config.ts` in CI.
This runs the retained browser/RuntimeWorker/PostgreSQL smoke and accessibility journey.
A private browser cache or locally excluded test is not CI browser evidence.

Quality keeps its required `quality` job, minimum read permissions and all previous checks.
`recordCommand` captures actual candidate-bound command outcomes; the schema-validated
manifest binds their output hashes, browser outcome, migration inventory, security outcomes,
fixture hashes and immutable build inventory. Absent evidence remains missing or pending.
Only declared ordinary artifacts are accepted; state/plan files, secret-shaped output and
symlinks are refused. Artifact upload requires successful evidence validation. No manifest
created by these scripts establishes an independent focused review or hosted qualification.

Official metadata checked on 2026-10-06 UTC selected these newest eligible stable additions:

| Source | Version | Official publication (UTC) |
| --- | --- | --- |
| [ajv](https://registry.npmjs.org/ajv) | 8.20.0 | 2026-04-24T15:22:16.529Z |
| [axe-core](https://registry.npmjs.org/axe-core) | 4.14.0 | 2026-10-05T17:43:36.099Z |
| [playwright](https://registry.npmjs.org/playwright) | 1.63.0 | 2026-09-04T22:45:21.732Z |

The unchanged 1440-minute cutoff at selection was 2026-10-05T22:26:41Z. Frozen installation
verified their complete closure under the unchanged release-age, provenance and build policy.
The existing Wrangler/Sharp remediation and other tool pins are retained exactly.
Official Actions release and tag-ref endpoints confirmed the pinned commit identities for
checkout v7.0.1, setup-node v7.0.0, upload-artifact v7.0.1 and download-artifact v8.0.1.

Run `pnpm format` first: it applies Biome's formatting and safe fixes, which `pnpm check` only verifies. Then run the complete local gate on one frozen candidate in this order:

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
pnpm test
pnpm run test:db
pnpm run test:runtime
pnpm run verify:docs
pnpm run infra:validate
pnpm run verify:supply-chain
```

These are account-independent implementation checks. Final Objective acceptance separately
requires actual exact-candidate CI logs/artifacts proving license enforcement, SBOM,
vulnerability/tree-secret scanning, generated validated evidence and the installed real
browser journey, plus verified external independent focused review. Owner setup (issue 1),
the authenticated staging path and full Wave 0 exit (issue 2) remain pending.

## W0-010 local bootstrap and qualification

The command list starts with `pnpm install --frozen-lockfile --ignore-scripts`.
Use `node scripts/bootstrap.mjs /absolute/owned/evidence-directory` on Linux. It verifies
Node 24.21.0, pnpm 12.9.1, Corepack, Python 3, Git/Git LFS, curl, OpenTofu 1.13.1 and every
PostgreSQL executable, including actual `pg_dump`/`pg_restore` 18.6. Migrations verify available
and installed pgvector 0.8.7. Git LFS inputs must match their committed pointer size/digest.
No LFS filters, tool prefixes, package-manager policy or cloud configuration are changed.

The shared entrypoint records install, check, offline test, test:db, test:replay, db:verify,
test:runtime, verify:docs, infra:validate and verify:supply-chain through the integrated recorder.
Quality retains `Quality/quality`, credentials-disabled checkout, pinned browser installation
and separate recorded browser invocation. The browser remains outside offline `pnpm test`.

On a separately owned isolated source checkout, add `--dispose-derived`; the qualification
workflow does this, Quality does not. The explicit disposal
list comprises root/workspace node_modules and .turbo, apps/web/dist, apps/runtime/dist and
apps/runtime/.wrangler. Tracked paths and symlinks refuse disposal. Evidence must be outside
the source root. The journey hashes all tracked working source bytes and prior evidence, deletes
only the declared derived paths, verifies source/LFS/evidence preservation, and repeats the same
canonical entrypoint exactly once in after-disposal/. Failed histories remain available.

At a clean frozen candidate, run the standalone local entrypoint:

```bash
pnpm run qualify:wave0
```

Without `CI_EVIDENCE_DIR`, it creates an owned evidence directory and runs the existing portable
runtime journey over real restored PostgreSQL history. It records missing bootstrap/disposal,
browser and published CI facts as pending; it never repeats canonical gates or invents receipts.
When actual hydrated LFS inputs are available, it builds two separately owned local clones with
independent frozen script-disabled installs and hydrated read-only LFS copies. Unhydrated pointer
bytes make this build comparison pending, never passed. The evidence directory is printed and
retained for inspection.

Quality on main pushes and the qualification workflow supply `CI_EVIDENCE_DIR`, actual canonical
command receipts and hydrated LFS inputs; only qualification adds disposal receipts. Quality on
pull requests does not run `qualify:wave0`. Both record the real browser journey and build the
complete immutable candidate before qualification, with one build invocation. In GitHub Actions
the same qualifier requires every canonical command receipt, records a missing bootstrap/disposal
proof as pending, and requires the passing browser command/candidate/tree/log receipt, actual
run/run-attempt/candidate identities and complete Worker/web build inventory. It runs the full
recovery/build comparison and requires both independent inventories to equal that actual CI
build; missing or mismatched receipts, LFS inputs, run identity or build facts fail. Supplied local
receipts are also checked against actual command identities, candidate and log hashes.
It invokes scripts/ci/build.mjs in each source root and compares the complete worker/ and web/
relative-path/digest inventories and build digests exactly. Compiled bytes, README, maps and
secret scanning remain intact. The build producer changes only pinned Wrangler metadata inputs
before production: sourceRoot is relative/empty, and README generation time uses Git's commit time.
The scoped Node loader refuses drift in those exact pinned producer expressions; installed tool
contents and dependencies remain fixed. Qualification removes only its unique source/build owner.

The collector validates exactly one disposition for each literal section 20 item. Current command
receipts establish observed local behavior; historical commands do not establish acceptance.
Unverified prior capability acceptance/boundary applicability remains a named pending fact.
Native local runtime-loss evidence is collected separately by the genuine pinned Workers
journey. Actual missed/duplicate/reordered Queue/webhook effects, owner setup (issue 1), and
full Wave 0 (issue 2) remain pending.

Before integration, an operator-appointed independent reviewer must examine the exact collected
commit/tree for backup/restore ownership, PostgreSQL persisted-state authority and evidence/
credential handling. The worker never creates this external acceptance fact. Missing review is
needs-human; negative review refuses integration. Later phase review cannot substitute. Final
Objective review verifies fresh exact published-head Quality/browser/artifact facts and compares
the exact candidate CI build manifest wherever its source/build contract applies. The required
quality check blocks integration; a local manifest does not waive these obligations. Disposal,
long-run and reproduction facts come from a qualification workflow run at the frozen candidate,
not from per-PR Quality.

The authentication composition packet is account-independent preparation. Controlled local rows
exercise stored-session and authority readers only. Enrollment/World-participation handoff, hosted
configuration, authenticated staging and full Wave 0 qualification remain pending until an authorized
bounded enrollment/provisioning path declares grants/privacy, or the planned provisioning path exists.
Before integration, the operator must supply a passing independent review of the exact collected
commit/tree covering every changed credential, authority and schema boundary. Missing review prevents
integration; a negative review refuses integration. Final Objective review also requires fresh protected
Quality evidence with applicable browser and artifact facts. Local commands establish no hosted execution.

The qualifier records a separate native recovery command through existing `test:runtime`
discovery, alongside the delivered portable restored-history proof. See [runtime.md](runtime.md)
and [database.md](database.md) for its storage-loss, complete authority-comparison and loopback
transport boundaries. Receipt production requires a clean frozen commit/tree; an uncommitted
implementation checkout can run behavior checks but cannot claim candidate-bound qualification.
Native local evidence never supplies external review, published CI or hosted acceptance facts.

When those whole-Objective facts remain unavailable, retain their pending dispositions and ask:
"Which retained, authenticated, candidate-bound receipts satisfy each still-pending whole-Objective criterion, including real missed/duplicate Queue or webhook effects, approved owner setup and enrollment/World-grant/privacy handoff, protected staging deployment, authenticated staging correlation and the complete Wave 0 evidence manifest?"
