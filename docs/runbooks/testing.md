# Testing

Rules for what tests to keep, for contributors human or agent. Each rule has its reason.

## Unit tests are scaffolding

- Write unit tests freely while building a change, test-first if it helps. They give fast feedback while the code is still moving.
- Before handoff, delete them. Keep only the lasting tests below. Once a feature ships, a unit test's value decays quickly: it pins implementation details, slows CI and must be maintained, while the integration tests already protect the behaviour.
- Exception: code that keeps changing (high churn), or a pure, tricky algorithm the integration path cannot reach well (canonical hashing, codecs, random streams). These keep focused unit tests. Their directories are listed in `scripts/test-budget.json` `unitTestAreas`; adding one is a reviewed change.

## Lasting tests

- **One integration test per claim.** Each acceptance or exit claim gets one test through the real path: the native owner, PostgreSQL, the HTTP surface. It asserts exact values, not presence. Don't add a second test for a claim already covered, and don't loop over variants unless the variant is the claim.
- **Goldens and parity.** Scenario goldens and replay/parity runs prove determinism across every scenario at once.
- **The database attack suite** (`tests/database/`) proves authorization and isolation.
- Reuse existing fixtures and harnesses. Don't build new helper frameworks.

Integration test files carry their kind in the name: `*.postgres.test.ts`, `*.long-run.test.ts` or `*.journey.*.test.ts`. Any other `*.test.ts` or `*.test.mjs` is a unit test.

A test that imports Playwright or launches a browser lives in the `include` of `tests/ci/vitest.browser.config.ts`, not merely under `tests/ci/`: only that config runs where CI installs Chromium (Quality's `browser-build` share and Qualification), so anywhere else it passes on a host with browsers and fails in CI. `scripts/check-browser-tests.mjs`, run by `pnpm check`, refuses a Playwright or `@vitest/browser` import or a `chromium`/`firefox`/`webkit` launch or connect in any other source file, test or support module, except the `browser-build` toolchain probe and the Factory benchmark graders (`.factory/bench/graders/`, run on a host, never in CI), naming its file and line.

Vitest timeouts have a 30 s floor, since its 5 s test and 1 s `expect.poll` defaults time out tests on CI's 2-core runners that pass locally: every Vitest config (the root `vitest.config.ts`, `vitest.workspace.ts` and its inline projects, each package's and app's configs, `tests/ci/`) sets `testTimeout`, `hookTimeout` and `expect.poll.timeout` to at least 30,000 ms, and a test, suite, hook or `expect.poll` call passes no shorter timeout. `scripts/check-test-timeouts.mjs`, run by `pnpm check`, refuses a config that omits any of the three or sets it lower, a missing root `vitest.config.ts` (`pnpm test:replay` runs a bare `vitest run`), and a timeout below 30,000 ms passed to `it`, `test`, `describe`, a hook, `expect.poll` or `vi.setConfig`, naming its file and line. It reads a timeout given as a literal, arithmetic on literals or a constant from the same file (a shorthand `{ timeout }` included) and follows aliased Vitest imports; one computed any other way it can't see, and it doesn't cover `vi.waitFor` or `vi.waitUntil`, which share the 1 s default and which nothing uses yet. A test that polls sets its own timeout above its poll windows, or at the 30 s defaults the test times out first and loses the poll's assertion message. The benchmark graders' `node:test` self-tests are outside it.

## Budget, checked by `pnpm check`

`scripts/check-test-budget.mjs` compares the change with its base (`CONTRACT_BASE_COMMIT` in CI: a pull request's merge-commit first parent, a push's previous `main`; else the merge base with `origin/main`). It counts code lines in `.ts`, `.tsx`, `.mjs`, `.js` and `.sql` files, including uncommitted and untracked ones:

- Net test lines (added minus deleted) must not exceed added production lines, beyond a small allowance (`testLineAllowance`) for test-only fixes. Aim for about half. A change that shrinks the tests, such as rewriting them smaller, always passes this rule.
- A new unit-test file is refused outside `unitTestAreas`.

The only way over the line budget is a recorded exception, never a larger `testLineAllowance`. Each `testLineExceptions` entry in `scripts/test-budget.json` names one test `file` that the change creates, the most added lines of that file it excuses (`lines`, set to the change's overrun), the owner's `decision` with its date and issue, and the `reason`. Adding one is a reviewed change. The check prints every excused file, and an entry lapses once its change has merged, because the file is no longer created against later bases.

Test code is anything under a `test/` or `tests/` directory or in a `*.test.*` file. Migrations and `db/` are production code.

## Pruning

Shipped unit tests outside `unitTestAreas` are removed over time. A recurring maintenance task ranks the remaining unit-test files by how often their subject code changed recently and by CI time, and deletes the ones guarding stable code whose behaviour an integration test already covers.
