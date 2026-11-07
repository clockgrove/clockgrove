#!/usr/bin/env node
// Wave 3 load curves (plan §19; issue 851): the hot-space and catch-up-storm curves of the native
// workerd/PostgreSQL owner path, and where each runtime budget trips.
// Usage: pnpm run qualify:wave3:load-curves [<evidence-dir>]
// It runs apps/runtime/test/load-curves.long-run.test.ts alone (vitest.load-curves.config.ts), so
// no other suite shares the host while it measures, and writes wave3-load-curves.json: host facts,
// the candidate, wall time and peak memory, `loadCurves`, `resourceCounters`, every budget with the
// measured load at which it trips, and the partition-seam thresholds. The Wave 3 manifest
// takes `loadCurves` and `resourceCounters` as they are. Exit 0 only if the fixture passed within
// its wall-time bound. The curves are read from the §20 metrics and the `*_answered` records
//; the fixture adds no instrumentation to the runtime.
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ownedSubprocess } from "../lib/subprocess.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const LOAD_CURVES_FILE = "wave3-load-curves.json";
/** The directory the fixture writes its result to; set by this command. */
export const LOAD_CURVES_DIRECTORY = "CLOCKGROVE_WAVE3_LOAD_CURVES";
/**
 * Decision: 10 minutes, about four times the slowest local run with the keepers sweep (143.2 s;
 * five times the 120.7 s before it; listed in docs/runbooks/runtime.md "Runtime budgets and load
 * curves"). The fixture runs its points one after another, so a host with slower cores (the
 * QUALITY_RUNNER class) stretches it. The first run of Qualification's wave3-load-curves job
 * re-sources it.
 */
export const WALL_TIME_BOUND_MS = 600_000;
export const WALL_TIME_BOUND_SOURCE =
  "decision: about 4x the slowest local run with the keepers sweep, 143.2 s (docs/runbooks/runtime.md#runtime-budgets-and-load-curves), until the first run of Qualification's wave3-load-curves job re-sources it";

/** Nearest-rank percentiles (the smallest value with at least q of the values at or below it). */
export function summary(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  const rank = (q) => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] ?? null;
  return { count: sorted.length, p50: rank(0.5), p95: rank(0.95), max: sorted.at(-1) ?? null };
}

const values = (points, name, label) =>
  points
    .filter((point) => point.name === name && (label === undefined || point.label === label))
    .map((point) => point.value);
const total = (points, name, field = "value") =>
  points
    .filter((point) => point.name === name)
    .reduce((sum, point) => sum + (point[field] ?? 0), 0);
const labels = (points, name) =>
  Object.fromEntries(
    [...new Set(points.filter((p) => p.name === name).map((p) => p.label))]
      .sort()
      .map((label) => [label, values(points, name, label).length]),
  );

/** The activation resource counters (§20 `activation_*`) of one curve point, summed. */
function counters(curve, key, points) {
  return {
    curve,
    ...key,
    activations: values(points, "activation_commands").length,
    commands: total(points, "activation_commands"),
    advances: total(points, "activation_commands", "count"),
    journalMs: total(points, "activation_journal_ms"),
    events: total(points, "activation_journal_ms", "count"),
    transactions: total(points, "activation_db_transactions"),
    statements: total(points, "activation_db_transactions", "count"),
  };
}

const hotSpacePoint = ({ points, answered, ...run }) => ({
  ...run,
  answered,
  committedPerSecond: Math.round((run.committed / run.burstMs) * 1000),
  refusals: Object.fromEntries(
    ["owner_mailbox_full", "owner_mailbox_expired", "owner_mailbox_timeout"].map((code) => [
      code,
      answered[code] ?? 0,
    ]),
  ),
  waitMs: summary(values(points, "mailbox_wait_ms", "command")),
  serviceMs: summary(values(points, "mailbox_service_ms", "command")),
  transactionMs: summary(values(points, "journal_latency_ms", "world")),
  lockWaitMs: summary(values(points, "lock_wait_ms", "world")),
});

const stormPoint = ({ points, caughtUpMs, ...run }) => {
  const steps = values(points, "catch_up_step_ms");
  const advances = total(points, "activation_commands", "count");
  const caughtUp = summary(caughtUpMs);
  return {
    ...run,
    alarmLatenessMs: summary(values(points, "alarm_lateness_ms")),
    batches: {
      ...summary(values(points, "alarm_batch_ms")),
      commands: total(points, "alarm_batch_ms", "count"),
      stopped: labels(points, "alarm_batch_ms"),
    },
    catchUpSteps: {
      ...summary(steps),
      totalMs: steps.reduce((sum, ms) => sum + ms, 0),
      commands: total(points, "catch_up_step_ms", "count"),
      dispositions: labels(points, "catch_up_step_ms"),
    },
    advances,
    // Per autonomous kernel call (an advance or its continuation chunk): inputs and transaction ms.
    inputsPerAdvance: summary(
      points
        .filter((p) => p.name === "command_events_written" && p.label === "autonomous")
        .map((p) => p.count),
    ),
    advanceMs: summary(values(points, "journal_latency_ms", "autonomous")),
    caughtUpMs: caughtUp,
    advancesPerSecond: caughtUp.max ? Math.round((advances / caughtUp.max) * 1000) : null,
  };
};

const overduePoint = ({ points, ...run }) => ({
  ...run,
  serviceMs: values(points, "mailbox_service_ms", "command")[0] ?? null,
});

/** A budget's status from the measured load at which it trips (null: not reached). */
const measured = (tripsAt) => ({ status: tripsAt ? "tripped" : "not-reached", tripsAt });

/**
 * Each budget's default, its status (`tripped`, `not-reached`, `not-observable`: the fixture cannot
 * see it, or `hint`: not a bound), the measured load at which it trips (null unless tripped) and what
 * was seen.
 */
function budgetTrips(budgets, curves, raw) {
  const { hotSpace, catchUpStorm, overdueInline } = curves;
  const { maxCommands, startWithinMs } = budgets.activation;
  const firstHot = (code) => hotSpace.find((point) => point.refusals[code] > 0);
  const deadline = firstHot("owner_mailbox_expired") ?? firstHot("owner_mailbox_timeout");
  const bySleep = catchUpStorm.filter((point) => point.sweep === "sleep");
  // A batch or catch-up step stopped with work left: at maxCommands, or short of it on the time
  // bound. A batch stops short only on that bound; a step may also have drained its admitted work,
  // so a short step counts only once its time (from enqueue, as the bound's) reached the bound.
  // The batches and steps of one storm point that stopped so.
  const stops = (full, point) =>
    raw.catchUpStorm[catchUpStorm.indexOf(point)].points.filter((p) =>
      full
        ? ((p.name === "alarm_batch_ms" && ["continued", "catch-up"].includes(p.label)) ||
            (p.name === "catch_up_step_ms" && p.label === "continue")) &&
          p.count >= maxCommands
        : p.count < maxCommands &&
          ((p.name === "alarm_batch_ms" && ["continued", "catch-up"].includes(p.label)) ||
            (p.name === "catch_up_step_ms" && p.label === "continue" && p.value >= startWithinMs)),
    ).length;
  const stopped = (full) => (point) => stops(full, point) > 0;
  // The shortest sleep of one world, and the fewest worlds waking together, at which it trips.
  const storm = (test) => {
    const sleep = bySleep.find(test);
    const worlds = catchUpStorm.find((point) => point.sweep === "worlds" && test(point));
    return sleep || worlds
      ? { sleepMs: sleep?.sleepMs ?? null, worlds: worlds?.worlds ?? null }
      : null;
  };
  const catchingUp = overdueInline.find((point) => point.code === "world_catching_up");
  const passed = overdueInline.filter((point) => point.status === 200);
  const autonomousEvents = raw.catchUpStorm.flatMap(({ points }) =>
    values(points, "command_events_written", "autonomous"),
  );
  const maxEvents = Math.max(0, ...autonomousEvents);
  // A kernel call stopped at maxInputs with work left: a keepers level's decisions fall due together,
  // one per keeper, so a call that dispatched maxInputs of more stopped and a continuation chunk ran
  // the rest. With exactly maxInputs due, each call dispatches them all and completes.
  const { maxInputs } = budgets.dueWorkAdvance;
  const inputs = catchUpStorm.find(
    (point) =>
      point.inputsPerAdvance.max >= maxInputs && point.keepers > point.inputsPerAdvance.max,
  );
  const full = hotSpace.find((point) => point.mailboxDepthMax >= budgets.spaceMailbox.maxDepth);
  return [
    {
      name: "SPACE_MAILBOX_BOUNDS.maxDepth",
      default: budgets.spaceMailbox.maxDepth,
      ...measured(
        firstHot("owner_mailbox_full") ? { clients: firstHot("owner_mailbox_full").clients } : null,
      ),
      observed: { maxDepth: Math.max(...hotSpace.map((point) => point.mailboxDepthMax)) },
    },
    {
      name: "SPACE_MAILBOX_BOUNDS.requestDeadlineMs",
      default: budgets.spaceMailbox.requestDeadlineMs,
      ...measured(deadline ? { clients: deadline.clients } : null),
      observed: { oldestEntryAgeMs: Math.max(...hotSpace.map((point) => point.oldestAgeMaxMs)) },
    },
    {
      name: "SPACE_MAILBOX_BOUNDS.retryAfterSeconds",
      default: budgets.spaceMailbox.retryAfterSeconds,
      status: "hint",
      tripsAt: null,
      observed: {
        note: "a retry hint, not a bound: the entries a full mailbox frees per second",
        entriesFreedPerSecond: full?.serviceMs.p50 ? Math.round(1000 / full.serviceMs.p50) : null,
      },
    },
    {
      name: "OWNER_ACTIVATION_BUDGET.maxCommands",
      default: maxCommands,
      ...measured(storm(stopped(true))),
      observed: {
        alarmBatches: bySleep.map(({ sleepMs, batches }) => ({
          sleepMs,
          stopped: batches.stopped,
        })),
      },
    },
    {
      name: "OWNER_ACTIVATION_BUDGET.startWithinMs",
      default: startWithinMs,
      ...measured(storm(stopped(false))),
      observed: {
        // Per point: the slowest step, and the batches and steps that stopped short on this bound.
        catchUpSteps: catchUpStorm.map((point) => ({
          sweep: point.sweep,
          sleepMs: point.sleepMs,
          worlds: point.worlds,
          ...(point.keepers === undefined ? {} : { keepers: point.keepers }),
          maxMs: point.catchUpSteps.max,
          stoppedShort: stops(false, point),
        })),
      },
    },
    {
      name: "DUE_WORK_ADVANCE_BUDGET.maxEvents",
      default: budgets.dueWorkAdvance.maxEvents,
      ...measured(
        maxEvents >= budgets.dueWorkAdvance.maxEvents ? { eventsPerAdvance: maxEvents } : null,
      ),
      observed: { maxEventsPerAdvance: maxEvents },
    },
    {
      name: "DUE_WORK_ADVANCE_BUDGET.maxInputs",
      default: maxInputs,
      ...measured(
        inputs ? { keepers: inputs.keepers, inputsPerAdvance: inputs.inputsPerAdvance.max } : null,
      ),
      observed: {
        keepers: catchUpStorm
          .filter((point) => point.sweep === "keepers")
          .map(({ keepers, inputsPerAdvance, advanceMs }) => ({
            keepers,
            inputsPerAdvance: inputsPerAdvance.max,
            advanceMs: advanceMs.max,
          })),
      },
    },
    {
      name: "OVERDUE_DEADLINE_LIMIT",
      default: budgets.overdueDeadlineLimit,
      ...measured(catchingUp ? { sleepMs: catchingUp.sleepMs, steps: catchingUp.steps } : null),
      observed: {
        admitted: passed.map(({ sleepMs, steps, serviceMs }) => ({ sleepMs, steps, serviceMs })),
      },
    },
  ];
}

/** The thresholds at which the partition and promotion seams (§19) would be needed, as measured. */
function seams(curves, trips) {
  const single = curves.hotSpace.find((point) => point.clients === 1);
  const full = trips.find((budget) => budget.name === "SPACE_MAILBOX_BOUNDS.maxDepth").tripsAt;
  const sleeps = curves.catchUpStorm.filter((point) => point.sweep === "sleep");
  return {
    spacePartition: {
      basis:
        "one FIFO lane per SpaceDO (§8): a space whose sustained command rate reaches the lane's capacity, or whose bursts reach the depth bound, needs its partition seam",
      laneCapacityCommandsPerSecond: single?.serviceMs.p50
        ? Math.round(1000 / single.serviceMs.p50)
        : null,
      peakCommittedPerSecond: Math.max(...curves.hotSpace.map((p) => p.committedPerSecond)),
      depthBoundReachedAtClients: full?.clients ?? null,
    },
    catchUp: {
      basis:
        "a world whose clock earns due-work advances faster than its owner drains them never catches up; such a world needs the promotion seam (a dedicated process owner)",
      drainAdvancesPerSecond: sleeps.at(-1)?.advancesPerSecond ?? null,
      byWorlds: curves.catchUpStorm
        .filter((point) => point.sweep === "worlds")
        .map(({ worlds, advancesPerSecond, caughtUpMs }) => ({
          worlds,
          advancesPerSecond,
          caughtUpMs: caughtUpMs.max,
        })),
    },
  };
}

/** The lockfile-selected Miniflare and workerd the native harness ran. */
function runtimeVersions() {
  const wrangler = createRequire(createRequire(import.meta.url).resolve("wrangler/package.json"));
  const miniflare = createRequire(wrangler.resolve("miniflare"));
  return {
    miniflare: wrangler("miniflare/package.json").version,
    workerd: miniflare("workerd/package.json").version,
  };
}

function candidate() {
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  return {
    commit: git("rev-parse", "HEAD"),
    tree: git("rev-parse", "HEAD^{tree}"),
    clean: git("status", "--porcelain", "--untracked-files=no") === "",
  };
}

/** The result document from the fixture's raw runs; the raw metric points stay out of it. */
export function loadCurvesResult(raw) {
  const loadCurves = {
    hotSpace: raw.hotSpace.map(hotSpacePoint),
    catchUpStorm: raw.catchUpStorm.map(stormPoint),
    overdueInline: raw.overdueInline.map(overduePoint),
  };
  const budgets = budgetTrips(raw.budgets, loadCurves, raw);
  return {
    kind: "clockgrove.wave3-load-curves",
    version: 1,
    // Each budget's default and source, and how to read and rerun these curves.
    documentation: "docs/runbooks/runtime.md#runtime-budgets-and-load-curves",
    candidate: candidate(),
    execution: {
      provider: process.env.GITHUB_ACTIONS ? "github-actions" : "local",
      runId: process.env.GITHUB_RUN_ID ?? null,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    },
    host: {
      platform: process.platform,
      arch: process.arch,
      cpuModel: os.cpus()[0]?.model ?? null,
      cpus: os.availableParallelism(),
      totalMemoryBytes: os.totalmem(),
      node: process.version,
      ...runtimeVersions(),
      harness: raw.harness,
    },
    startedAt: raw.startedAt,
    completedAt: raw.completedAt,
    peakMemory: raw.peakMemory,
    loadCurves,
    resourceCounters: [
      ...raw.hotSpace.map(({ clients, points }) => counters("hotSpace", { clients }, points)),
      ...raw.catchUpStorm.map(({ points, caughtUpMs, ...key }) =>
        counters("catchUpStorm", key, points),
      ),
    ],
    budgets,
    partitionSeams: seams(loadCurves, budgets),
  };
}

/** Called by the fixture: writes the result where this command asked, or under the temp directory. */
export async function writeLoadCurves(raw) {
  const directory =
    process.env[LOAD_CURVES_DIRECTORY] ||
    (await mkdtemp(path.join(os.tmpdir(), "clockgrove-wave3-load-curves-")));
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, LOAD_CURVES_FILE);
  await writeFile(file, `${JSON.stringify(loadCurvesResult(raw), null, 2)}\n`);
  return file;
}

/** Runs the fixture alone and adds its wall time beside the bound; returns the result document. */
export async function qualifyLoadCurves(directory) {
  const file = path.join(directory, LOAD_CURVES_FILE);
  await access(file).then(
    () => {
      throw new Error(
        "refuse overwriting prior load-curve evidence; use a separately owned directory",
      );
    },
    (error) => {
      if (error.code !== "ENOENT") throw error;
    },
  );
  const vitest = path.join(
    path.dirname(createRequire(import.meta.url).resolve("vitest/package.json")),
    "vitest.mjs",
  );
  const started = performance.now();
  const run = await ownedSubprocess(
    process.execPath,
    [vitest, "run", "--config", "apps/runtime/vitest.load-curves.config.ts"],
    {
      cwd: root,
      env: { ...process.env, [LOAD_CURVES_DIRECTORY]: directory },
      inherit: true,
      timeoutMs: WALL_TIME_BOUND_MS + 60_000,
    },
  );
  const ms = Math.round(performance.now() - started);
  // A fixture that failed before writing its result leaves a failed one with no curves.
  const written = await readFile(file, "utf8").then(JSON.parse, () => null);
  const result = written ?? {
    kind: "clockgrove.wave3-load-curves",
    version: 1,
    candidate: candidate(),
    loadCurves: null,
    resourceCounters: null,
  };
  const passed = run.status === 0 && !run.error && written !== null;
  const within = ms <= WALL_TIME_BOUND_MS;
  result.wallTime = {
    ms,
    boundMs: WALL_TIME_BOUND_MS,
    source: WALL_TIME_BOUND_SOURCE,
    status: within ? "within" : "exceeded",
  };
  result.status = passed && within ? "passed" : "failed";
  await writeFile(file, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argument = process.argv.slice(2).find((value) => value !== "--");
  const directory = argument
    ? path.resolve(argument)
    : await mkdtemp(path.join(os.tmpdir(), "clockgrove-wave3-load-curves-"));
  await mkdir(directory, { recursive: true });
  const result = await qualifyLoadCurves(directory);
  const { ms, boundMs } = result.wallTime;
  process.stdout.write(
    `${result.status}: wall time ${(ms / 1000).toFixed(1)} s (bound ${boundMs / 1000} s)\n`,
  );
  for (const budget of result.budgets ?? [])
    process.stdout.write(
      `  ${budget.name} ${budget.default}: ${budget.status}${budget.tripsAt ? ` at ${JSON.stringify(budget.tripsAt)}` : ""}\n`,
    );
  process.stdout.write(`Wave 3 load curves: ${path.join(directory, LOAD_CURVES_FILE)}\n`);
  process.exitCode = result.status === "passed" ? 0 : 1;
}
