// The Wave 1 plan §9.3 long-run invariants and the declared small-step versus aggregate equivalence,
// read from one decoded summarised scenario bundle (packages/simulator/docs/scenarios.md). Pure: no
// clock, I/O or randomness; bigints stay bigints.
import { createHash } from "node:crypto";

export const SMALL_STEP_RUN = "main";
export const AGGREGATE_RUN = "aggregate";
export const EQUIVALENCE_ID = "small-step-vs-aggregate";
/** Ordinary autonomous action events; a dead actor must emit none after its death. */
export const ACTION_EVENT_TYPES = ["routine.selected", "movement.started"];
export const RESOURCE_EVENT_TYPES = [
  "resource.consumed",
  "resource.spoiled",
  "resource.transferred",
  "resource.weather-integrated",
];

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value) =>
  JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? `${item}n` : item));
export const summaryHash = (value) =>
  `sha256:${createHash("sha256").update(text(value)).digest("hex")}`;

function subjectEvents(run) {
  const table = new Map();
  for (const subject of run.summary.subjects)
    table.set(subject.objectId, new Map(subject.events.map((entry) => [entry.type, entry])));
  return table;
}

function deathTimes(run) {
  const deaths = new Map();
  for (const [objectId, events] of subjectEvents(run)) {
    const died = events.get("lifecycle.died");
    if (died) deaths.set(objectId, died.first);
  }
  return deaths;
}

/** Checks one run; each problem is a short text naming the run and the object. */
const perRun = (bundle, check) =>
  bundle.runs.flatMap((run) => check(run).map((problem) => `${run.name}: ${problem}`));

const CHECKS = [
  {
    id: "no-negative-or-conjured-resources",
    invariant: "no negative/conjured resources",
    run(bundle) {
      return perRun(bundle, (run) => {
        const problems = [];
        for (const type of ["resource.appeared", "resource.offered"])
          if ((run.eventCounts[type] ?? 0) > 0)
            problems.push(`closed world contains unbacked ${type}`);
        const entities = new Map(
          run.finalState.entities.map((entity) => [entity.objectId, entity]),
        );
        for (const entity of entities.values())
          if (
            entity.resource &&
            !(Number.isSafeInteger(entity.resource.quantity) && entity.resource.quantity >= 0)
          )
            problems.push(`${entity.objectId} holds quantity ${text(entity.resource.quantity)}`);
        for (const [objectId, events] of subjectEvents(run))
          if (
            RESOURCE_EVENT_TYPES.some((type) => events.has(type)) &&
            !entities.get(objectId)?.resource
          )
            problems.push(`resource events on ${objectId}, which is not a resource object`);
        return problems;
      });
    },
  },
  {
    id: "no-orphans-or-containment-cycles",
    invariant: "no orphan active objects or containment cycles",
    run(bundle) {
      return perRun(bundle, (run) => {
        const problems = [];
        const { entities, lifecycle, wellbeing } = run.finalState;
        const ids = new Set(entities.map((entity) => entity.objectId));
        if (ids.size !== entities.length) problems.push("entity ids are not unique");
        const container = new Map(
          entities
            .filter((entity) => entity.locationId !== undefined)
            .map((e) => [e.objectId, e.locationId]),
        );
        for (const [objectId, locationId] of container) {
          if (!ids.has(locationId)) problems.push(`${objectId} is inside missing ${locationId}`);
          const seen = new Set([objectId]);
          for (let at = container.get(objectId); at !== undefined; at = container.get(at)) {
            if (seen.has(at)) {
              problems.push(`${objectId} is in a containment cycle through ${at}`);
              break;
            }
            seen.add(at);
          }
        }
        const lifecycleIds = new Set((lifecycle?.entries ?? []).map((entry) => entry.objectId));
        for (const entry of lifecycle?.entries ?? []) {
          if (!ids.has(entry.objectId))
            problems.push(`lifecycle entry ${entry.objectId} has no object`);
          for (const parent of entry.parentIds)
            if (!lifecycleIds.has(parent))
              problems.push(`${entry.objectId} names missing parent ${parent}`);
        }
        for (const entry of wellbeing?.entries ?? [])
          if (!ids.has(entry.objectId))
            problems.push(`wellbeing entry ${entry.objectId} has no object`);
        for (const objectId of subjectEvents(run).keys())
          if (!ids.has(objectId)) problems.push(`events name ${objectId}, which is no object`);
        return problems;
      });
    },
  },
  {
    id: "no-duplicate-births-deaths-schedules",
    invariant: "no duplicate births/deaths/schedules",
    run(bundle) {
      return perRun(bundle, (run) => {
        const problems = [];
        const entries = new Map(
          (run.finalState.lifecycle?.entries ?? []).map((e) => [e.objectId, e]),
        );
        if (entries.size !== (run.finalState.lifecycle?.entries ?? []).length)
          problems.push("lifecycle entries are not unique");
        const died = new Set();
        for (const [objectId, events] of subjectEvents(run)) {
          const born = events.get("lifecycle.born");
          const death = events.get("lifecycle.died");
          if (born && born.count !== 1) problems.push(`${objectId} was born ${born.count} times`);
          if (born && entries.get(objectId)?.bornAt !== born.first)
            problems.push(`${objectId} birth event disagrees with its lifecycle entry`);
          if (death && death.count !== 1) problems.push(`${objectId} died ${death.count} times`);
          if (death) died.add(objectId);
          if (death && entries.get(objectId)?.death?.diedAt !== death.first)
            problems.push(`${objectId} death event disagrees with its lifecycle entry`);
        }
        for (const [objectId, entry] of entries)
          if (entry.death !== null && !died.has(objectId))
            problems.push(`${objectId} is dead without a lifecycle.died event`);
        if (run.summary.scheduleDuplicateIds !== 0)
          problems.push(`${run.summary.scheduleDuplicateIds} duplicate schedule ids`);
        const remaining = run.schedule.remaining.map((item) => item.scheduleId);
        if (new Set(remaining).size !== remaining.length)
          problems.push("remaining schedule ids are not unique");
        return problems;
      });
    },
  },
  {
    id: "event-volume-bounded",
    invariant: "bounded event volume relative to semantic transitions",
    run(bundle) {
      const problems = [];
      const [small, aggregate] = [SMALL_STEP_RUN, AGGREGATE_RUN].map((name) =>
        bundle.runs.find((run) => run.name === name),
      );
      if (!small || !aggregate) return [`runs ${SMALL_STEP_RUN} and ${AGGREGATE_RUN} are required`];
      // Stepping finely adds integration events only: at most a tenth more, or one final group per
      // step (needs/wellbeing per actor, one per plant/water holder, and time.advanced). Since unchanged
      // decisions journal nothing, the final groups can be most of a short run's events.
      const { entities, wellbeing, ecology } = aggregate.finalState;
      const actors = entities.filter((entity) => entity.needs !== undefined).length;
      const finalGroup =
        actors * (wellbeing ? 2 : 1) +
        (ecology?.plants.length ?? 0) +
        (ecology?.waterHolders?.length ?? 0) +
        1;
      const allowance = Math.max(
        Math.ceil(aggregate.events.count / 10),
        small.commands.length * finalGroup,
      );
      if (small.events.count - aggregate.events.count > allowance)
        problems.push(
          `${small.commands.length} small steps emitted ${small.events.count} events, the aggregate ${aggregate.events.count}`,
        );
      for (const run of bundle.runs)
        for (const command of run.commands)
          if (
            command.role === "advance" &&
            command.outcome.events > command.payload.maxEvents * command.outcome.calls
          )
            problems.push(
              `${run.name}: ${command.step}:${command.chunk} exceeded its event budget`,
            );
      return problems;
    },
  },
  {
    id: "scheduler-queue-bounded",
    invariant: "bounded scheduler queue under world policy",
    run(bundle, context) {
      return perRun(bundle, (run) => {
        const problems = [];
        const deaths = deathTimes(run);
        const born = [...subjectEvents(run).values()].filter((events) =>
          events.has("lifecycle.born"),
        );
        // One decision entry per actor: the initial actors plus every actor born in the run. A keyed
        // remain-in-region entry is at most one per object and dwell region of the final state.
        const dwellRegions = (run.finalState.spatialRegions ?? []).filter(
          (region) => region.dwell !== undefined,
        ).length;
        const bound =
          run.schedule.initial.length + born.length + run.finalState.entities.length * dwellRegions;
        if (run.summary.schedulePeak > bound)
          problems.push(`schedule peaked at ${run.summary.schedulePeak}, above ${bound}`);
        for (const item of run.schedule.remaining) {
          const objectId = isRecord(item.payload) ? item.payload.objectId : undefined;
          if (objectId !== undefined && deaths.has(objectId))
            problems.push(`dead ${objectId} still has ${item.kind} queued`);
        }
        const living = (run.finalState.lifecycle?.entries ?? []).filter((e) => e.death === null);
        if (context.maxPopulation !== null && living.length > context.maxPopulation)
          problems.push(
            `${living.length} living actors exceed maxPopulation ${context.maxPopulation}`,
          );
        return problems;
      });
    },
  },
  {
    id: "deterministic-summaries",
    invariant: "deterministic population, resource, and lifecycle summary hashes",
    run(bundle) {
      const problems = perRun(bundle, (run) =>
        run.replay.matches ? [] : ["replay does not match"],
      );
      if (bundle.replayVerified !== true) problems.push("replayVerified is not true");
      return problems;
    },
  },
  {
    id: "decision-references-resolve",
    invariant: "all decision/action references resolve",
    run(bundle) {
      const scripted = new Set(bundle.scriptedInputs.map((input) => input.ref));
      return perRun(bundle, (run) => {
        const problems = [];
        const ids = new Set(run.finalState.entities.map((entity) => entity.objectId));
        if (run.summary.undispatchedDecisions !== 0)
          problems.push(`${run.summary.undispatchedDecisions} decisions could not be dispatched`);
        for (const ref of run.scriptedInputsUsed)
          if (!scripted.has(ref)) problems.push(`scripted input ${ref} is not declared`);
        for (const entity of run.finalState.entities) {
          const target = entity.selectedAction?.targetObjectId;
          if (target !== undefined && !ids.has(target))
            problems.push(`${entity.objectId} targets missing ${target}`);
        }
        return problems;
      });
    },
  },
  {
    id: "dead-actors-inactive",
    invariant: "no inactive/dead actor performs ordinary autonomous actions",
    run(bundle) {
      return perRun(bundle, (run) => {
        const problems = [];
        const events = subjectEvents(run);
        for (const [objectId, diedAt] of deathTimes(run))
          for (const type of ACTION_EVENT_TYPES) {
            const action = events.get(objectId).get(type);
            if (action && action.last > diedAt)
              problems.push(`${objectId} emitted ${type} after its death`);
          }
        return problems;
      });
    },
  },
  {
    id: "no-private-perception-in-public-view",
    invariant: "no private perception appears in public client-view input",
    // A summarised run keeps only the perception count and digest, so the record contents are not
    // observable here; full recordings (differential-perception, kernel long-run probe) prove it.
    observable: false,
    run: () => [],
  },
  {
    id: "declared-equivalence",
    invariant: "small-step and aggregate progression meet the declared equivalence",
    run(bundle) {
      const declared = bundle.equivalences.find((item) => item.id === EQUIVALENCE_ID);
      if (!declared) return [`equivalence ${EQUIVALENCE_ID} is not declared`];
      if (declared.left !== SMALL_STEP_RUN || declared.right !== AGGREGATE_RUN)
        return [`${EQUIVALENCE_ID} does not compare ${SMALL_STEP_RUN} with ${AGGREGATE_RUN}`];
      return declared.equivalent === true
        ? []
        : [`${EQUIVALENCE_ID} differs in ${declared.differences.join(", ")}`];
    },
  },
  {
    id: "scenario-assertions",
    invariant: "every assertion of the scenario document passes",
    run: (bundle) =>
      bundle.assertions.filter((item) => item.passed !== true).map((item) => `${item.id} failed`),
  },
];

/**
 * Runs every check on a decoded summarised bundle. `context.maxPopulation` is the pack lifecycle
 * policy's bound, or null when the pack declares none. Each result is `passed`, `failed` or
 * `not-observable` (the evidence is not in a summarised recording; never counted as passed).
 */
export function checkLongRunBundle(bundle, context = { maxPopulation: null }) {
  const recorded = bundle.runs.every(
    (run) => run.recording === "summarised" && isRecord(run.summary),
  );
  return CHECKS.map(({ id, invariant, observable = true, run }) => {
    if (!recorded)
      return { id, invariant, status: "failed", problems: ["every run must be summarised"] };
    if (!observable) return { id, invariant, status: "not-observable", problems: [] };
    let problems;
    try {
      problems = run(bundle, context);
    } catch (error) {
      problems = [`the bundle does not have the expected shape: ${error.message}`];
    }
    return {
      id,
      invariant,
      status: problems.length ? "failed" : "passed",
      problems: problems.slice(0, 20),
    };
  });
}

/** Population, resource and lifecycle summary hashes of the small-step run's final state. */
export function summaryHashes(bundle) {
  const run = bundle.runs.find((item) => item.name === SMALL_STEP_RUN);
  const { entities, lifecycle } = run.finalState;
  return {
    finalStateHash: run.finalStateHash,
    population: summaryHash(
      (lifecycle?.entries ?? []).map((entry) => [entry.objectId, entry.death === null]),
    ),
    resources: summaryHash(
      entities
        .filter((entity) => entity.resource)
        .map((entity) => [entity.objectId, entity.resource]),
    ),
    lifecycle: summaryHash(
      run.summary.subjects.map((subject) => [
        subject.objectId,
        subject.events.filter((entry) => entry.type.startsWith("lifecycle.")),
      ]),
    ),
  };
}
