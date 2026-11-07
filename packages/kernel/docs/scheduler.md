# Scheduler and offline aggregation (RW-0106)

`catchUpSchedules(registry, request)` is a pure, deterministic, engine-versioned function
(engine version `clockgrove-catch-up@1`, exported from the kernel index together with
`createCatchUpRegistry`). It returns `{ok:true, result}` or `{ok:false, error}` and never throws:
every malformed request is a returned, frozen `{code, path, check?}` refusal. It reads no clock,
random source or environment, and it never mutates its input.

**Inputs.** `engineVersion`, `queue` (schedule items), `start` and `target` (non-negative
signed 64-bit bigint simulation times, `start <= target`), `budget` (a positive safe integer),
`cursor` (`null` or the cursor of a previous call), `systems` (`{systemId, at, state}` for each
continuous system, where `systemId` is `kind@version` and `at` equals the cursor position or
`start`) and `results` (`{scheduleId, idempotencyKey, payload}` recorded results for
externally blocked items). Records have exactly these keys; extra or missing keys are refused.

**Outputs.** `engineVersion`, `dispatched` (scheduled kernel inputs), `thresholds`
(`{systemId, name, time}`), `skipped` (per-kind summaries), `blocked` (schedule ids),
`scheduleMutations` (a `cancel` for every consumed item), `remaining` (the queue left),
`systems` (advanced states), `complete`, `cursor` (`null` when complete) and `nextDueAt`
(the due time of the first remaining item or `null`). The result is deep-frozen.

**Ordering, budget and cursor.** Due items (`dueAt <= target`) are processed in the canonical
`(dueAt, priority, tieBreakKey)` order of the existing queue helpers, independent of input
order. Every continuous system advances together to each examined item's due time, so
thresholds are produced in global time order. Exact items, aggregate items and blocked items
with a recorded result each consume one unit of `budget`; skippable items and blocked items
without a result are free. When the budget is spent and a due item remains, the call returns
`complete: false` and a cursor `{engineVersion, start, target, position, queueDigest}`; the
caller feeds back `remaining`, `systems` and `cursor`. Chained bounded calls produce exactly the
concatenation of one unbounded call. A cursor that disagrees with the request (target, start or
queue digest) is refused.

**Classes.** `exact` items are dispatched once as scheduled kernel inputs. `aggregate` items
advance their continuous system and dispatch nothing. `skippable` items are removed and
summarised per kind (count, first and last due time) without dispatch. `externallyBlocked`
items stay queued and are reported in `blocked` until a result is recorded; with a result they
dispatch with payload `{payload, result}`. A superseded item (named by another item's
`supersedes`) is dropped without dispatch or mutation, as `upsertSchedule` drops it; a cancelled
item is simply absent. A consumed item is never dispatched twice because it leaves the queue
through its `cancel` mutation.

**Threshold API.** A continuous system is `{kind, version, integrate(state, from, to),
nextThreshold(state, at)}`. States are records of safe integers or bigints; floats, `NaN` and
other types are refused (`catch-up.system-integrate@1`). `nextThreshold` returns `null` or
`{name, time}` with `time` strictly after `at`; the engine integrates to each threshold and
asks again, so a call reports every threshold crossing and never one per step. A
non-forward threshold is refused (`catch-up.system-threshold@1`) and a throwing system is
refused (`catch-up.system@1`).

**Versioned dispatch.** Handlers are registered by `(kind, payloadVersion)` and map to a
kernel input `type` and `schemaVersion`; command ids come from the deterministic id source and
are stable. An unknown kind or system is `unsupported-input`; an unknown `payloadVersion` or
engine version is `unknown-command-version`.

**Differential pairs.** The tests prove six pairs with declared `exact` equivalence (identical
canonical bytes, using test-owned fixture systems and payloads): `continuous-steps-vs-aggregate`
(small steps versus one aggregate call), `sleep-reactivation-vs-uninterrupted` (state and queue
round-tripped through canonical bytes between calls), `pause-resume-vs-uninterrupted`,
`superseded-vs-replacement`, `retried-call-vs-first` (identical input, identical output, and
no idempotency key dispatched twice when results are fed back) and
`bounded-continuation-vs-unbounded`. Seeded generated sequences (named random stream
`scheduler`, seed `scheduler-catch-up-v1`) assert canonical order, no double, superseded or
cancelled dispatch, budget bounds, chained equals unbounded, and seed replay.

**Scale.** `test/scheduler.test.ts` builds a queue of 8192 exact schedules due over 8 s with
`createScheduleQueue` and drains it in chained catch-up calls of 1024 inputs (the kernel's per-call
`maxInputs` maximum; decision: 8 x 1024 schedules). It asserts exactly 8192 kernel inputs, 8
continuation chunks, a queue high-water mark of 8192 (a drain never grows the queue) and an empty
queue at the end. The counts follow from the declared workload, not from a measured run, so they do
not depend on host speed.

**Refusals** (frozen, returned; `-` means no `check`):

| Code | Path | Check |
| --- | --- | --- |
| `invalid-input` | `request`, or the offending field such as `request.budget`, `request.queue[i].dueAt`, `request.cursor.position`, `request.results[i].payload` (null, wrong type, missing or extra key; negative, out-of-range or non-bigint time; non-integer or non-positive budget) | - |
| `invalid-input` | `request.target` | `catch-up.time-order@1` |
| `invalid-input` | `request.queue[i]` | `catch-up.queue-scope@1` |
| `invalid-input` | `request.queue[i].id` | `catch-up.queue-duplicate@1` |
| `invalid-input` | `request.queue` | `catch-up.queue-ordering@1` |
| `invalid-input` | `request.cursor.queueDigest`, `request.cursor.target` | `catch-up.cursor@1` |
| `invalid-input` | `request.results[i].scheduleId` | `catch-up.result-target@1`, `catch-up.result-blocked@1`, `catch-up.result-duplicate@1` |
| `invalid-input` | `request.systems[i].systemId` | `catch-up.systems-duplicate@1` |
| `invalid-input` | `request.queue[i].kind` | `catch-up.system-state@1` |
| `invalid-input` | `request.systems[i].at` | `catch-up.systems-time@1` |
| `unknown-command-version` | `request.engineVersion`, `request.cursor.engineVersion`, `request.queue[i].payloadVersion` | - |
| `unsupported-input` | `request.queue[i].catchUpClass`, `request.queue[i].kind`, `request.systems[i].systemId` | - |
| `unsupported-input` | `request.queue[i].catchUpClass` | `catch-up.dispatch-class@1` |
| `check-error` | `request.systems[i].state.<name>` | `catch-up.system-integrate@1` |
| `check-error` | `request.systems[i]` | `catch-up.system-threshold@1`, `catch-up.system@1` |
| `handler-failed` | `engine` | `catch-up.engine@1` |
| `duplicate-registration`, `missing-registration-part` | `payloads[i]`, `systems[i]` (from `createCatchUpRegistry`) | - |

**Unchanged.** The queue helpers in `scheduler.ts` (`createScheduleQueue`, `upsertSchedule`,
`cancelSchedule`, `drainSchedulesThrough`), the `world.advance` and `world.weather.set`
outputs are not changed. Scheduled `world.decision` inputs are accepted from RW-0108a; see
[`## Needs, comfort and health (RW-0108a)`](wellbeing.md).

**Evidence.** The shared `fullRuntimeEvidence` adds a `scheduler` section (engine version, seed,
targeted, refusal and generated entries with input identity and output identity, and the six
pairs with equivalence and equal hashes), identical in Node and Workers, plus a bounded
`comparison` summary, all in `scheduler.json` and validated by `test/spatial-evidence.ts`; see
[Evidence report files](evidence.md#evidence-report-files).

Outside this pure scheduler, and built on main: durable schedules in PostgreSQL (Wave 2 §7.3,
"Durable schedules"), and the timeline clock policy, its wall-clock mapping, alarms and the catch-up
Workflow in the runtime (Wave 3 §10, "Perpetual scheduling and alarms"; see the
[runtime runbook](../../../docs/runbooks/runtime.md)). The kernel's continuous systems are
[environment](environment.md), [resources and growth](ecology.md), [needs, comfort and
health](wellbeing.md) and [lifecycle](lifecycle.md).
