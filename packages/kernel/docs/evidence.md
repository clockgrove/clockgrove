# Component evidence

The rain/needs harness also runs independent raccoon and garden typed component fixtures.
Both Node and local workerd instantiate the domain's production initial catalog registry,
resolve explicit archetype/trait version pins, and project effective objects through
`projectEffectiveObjectsToWorldState`. Kernel routines consume that validated physical
projection; historical schema-v1 JSON continues through the separate existing decoder.
Whole-component WeatherExposure overrides reduce primary shelter protection from 10000
to 1000 and change the selected shelter to the secondary cover without changing sources.
Archetype defaults precede recursive pinned traits, typed instance replacements and timeline
state. Conflicting trait writers require identical canonical versioned values or an explicit
participating pinned writer; traversal order supplies no precedence. Versions never float.

The long-run evidence test (`test/weather-needs.long-run.test.ts`, `pnpm test:long-run`) preserves bounded continuation, replay, named random stream and
historical golden controls. It independently captures resolved canonical objects, semantic
events, decisions, schedules, final states and SHA-256 comparisons in twelve per-section report
files (`node.json`, `workers.json`, `comparison.json`, `spatial.json`, `perception.json`,
`scheduler.json`, `environment.json`, `ecology.json`, `decisions.json`, `lifecycle.json`,
`wellbeing-node.json` and `wellbeing-workers.json`), each bounded to 1 MiB; see [Evidence report files](#evidence-report-files).
The single stdout marker `Clockgrove component evidence: ` identifies their absolute directory
under validator TMPDIR.
The reports remain for external capture while workerd, bundling and other temporary resources
are disposed. Review must inspect complete current-candidate report bodies; command exits or
cached output alone do not establish runtime evidence. Wave 1 exit evidence is the manifest
that `pnpm run qualify:wave1` writes (Wave 1 plan §13; see the
[development runbook](../../../docs/runbooks/development.md)).

## Evidence report files

The long-run evidence test writes exactly twelve files into one fresh directory under `TMPDIR`:

- `node.json` and `workers.json`: `{ runtime, evidence }` with `schemaVersion`, `composition`,
  `components`, `historical`, `packs`, `executor` and `containment` for that runtime.
- `comparison.json`: the top-level comparison fields plus `comparisons`, `packComparisons`,
  `containment`, `executor` and the `wellbeing` summary.
- `spatial.json`, `perception.json`, `scheduler.json`, `environment.json`, `ecology.json`,
  `decisions.json` and `lifecycle.json`:
  `schemaVersion` 1, `section`, `node` and `workers` (each `{ runtime, evidence }` with that
  runtime's section body) and the section's `comparison` summary. `lifecycle.json` is
  `{schemaVersion: 1, section: "lifecycle", node: {runtime, evidence}, workers: {runtime, evidence},
  comparison}`; its comparison holds `equal`, `nodeHash`, `workersHash`, the run, long-run, pair and
  assertion counts and the golden name and hashes.
- `wellbeing-node.json` and `wellbeing-workers.json`: `schemaVersion` 1, `section` `wellbeing`,
  `runtime` and `evidence` (that runtime's wellbeing body).

Every file is checked against 1048576 UTF-8 bytes before it is written and read back at most that
size. An oversized file fails the run, naming the file; nothing is sampled, capped or truncated to
fit. `reportDirectoryProblems` in `test/spatial-evidence.ts` validates the whole directory listing
and bodies, and the test asserts it returns no problems. The run prints one marker line beginning
`Clockgrove component evidence: ` followed by the absolute directory.

A new section gets its own `<section>.json`, or per-runtime files when both bodies exceed 768 KiB.
Each new file must be added to the installation's `reviewArtifacts` `files` list.
