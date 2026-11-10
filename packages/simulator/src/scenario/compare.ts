import type {
  AssertionResult,
  EquivalenceAssertionResult,
  EquivalenceResult,
  EventCountAssertionResult,
  PathAssertionResult,
  ScenarioRun,
} from "./bundle.js";
import type {
  CompareOperator,
  EquivalenceField,
  EventCountAssertion,
  ScenarioAssertion,
  ScenarioEquivalence,
} from "./document.js";
import { canon, isRecord, plain, type Rec, readPath, withoutPath } from "./support.js";

const records = (value: unknown): readonly Rec[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];

function omitCall(entry: Rec): Rec {
  const { call: _call, ...rest } = entry;
  return rest;
}

export function materialEvent(event: Rec): boolean {
  if (event.type !== "resource.weather-integrated") return true;
  const payload = event.payload as Rec;
  return payload.collected !== 0 || payload.evaporated !== 0;
}

/** The comparable view of one run for one field under the declared ignore lists. */
function view(
  run: ScenarioRun,
  field: EquivalenceField,
  equivalence: ScenarioEquivalence,
): unknown {
  if (
    run.recording === "summarised" &&
    (field === "events" || field === "decisions" || field === "rules")
  ) {
    // A summarised run keeps, per equivalence it takes part in, the digest of exactly this view.
    const entry = records(run.summary?.equivalenceViews).find(
      (candidate) => candidate.id === equivalence.id,
    );
    return entry?.[field] ?? null;
  }
  const ignored = new Set(equivalence.ignoreEventTypes);
  const only = new Set(equivalence.eventTypes);
  const compared = (type: string): boolean =>
    !ignored.has(type) && (only.size === 0 || only.has(type));
  switch (field) {
    case "events":
      return records(run.events)
        .filter(
          (event) => materialEvent(event) && typeof event.type === "string" && compared(event.type),
        )
        .map((event) => ({
          type: event.type,
          simulationTime: event.simulationTime,
          payload: event.payload,
        }));
    case "eventCounts":
      return Object.fromEntries(Object.entries(run.eventCounts).filter(([type]) => compared(type)));
    case "finalState":
      return equivalence.ignoreStatePaths.reduce<unknown>(
        (state, path) => withoutPath(state, path),
        run.finalState,
      );
    case "decisions":
      return records(run.decisions).map((decision) => ({
        kind: decision.kind,
        decision: decision.decision,
      }));
    case "rules":
      return {
        intents: records(run.rules.intents).map(omitCall),
        trace: records(run.rules.trace).map(omitCall),
        cooldowns: run.rules.cooldowns,
      };
  }
}

/** Whether a recorded event record matches an `eventCount` assertion's type, time window and clauses. */
export function eventMatches(assertion: EventCountAssertion, event: Rec): boolean {
  if (assertion.eventType !== null && event.type !== assertion.eventType) return false;
  const time = event.simulationTime;
  if (typeof time !== "bigint") throw new TypeError("a recorded event has no simulation time");
  if (assertion.from !== null && time < assertion.from) return false;
  if (assertion.to !== null && time > assertion.to) return false;
  return assertion.where.every((clause) => {
    const hit = readPath(event, clause.path);
    return hit.found && canon(hit.value) === canon(clause.value);
  });
}

/** A run the decoded document names; the decoder guarantees it exists, so a miss is an internal defect. */
function runOf(runs: ReadonlyMap<string, ScenarioRun>, name: string): ScenarioRun {
  const run = runs.get(name);
  if (run === undefined) throw new TypeError(`the document names no run ${name}`);
  return run;
}

/** A material-equivalence declaration and whether it holds between two recorded runs. */
export function evaluateEquivalence(
  equivalence: ScenarioEquivalence,
  runs: ReadonlyMap<string, ScenarioRun>,
): EquivalenceResult {
  const left = runOf(runs, equivalence.left);
  const right = runOf(runs, equivalence.right);
  const differences = equivalence.fields.filter(
    (field) => canon(view(left, field, equivalence)) !== canon(view(right, field, equivalence)),
  );
  return plain({
    id: equivalence.id,
    left: equivalence.left,
    right: equivalence.right,
    fields: [...equivalence.fields],
    eventTypes: [...equivalence.eventTypes],
    ignoreEventTypes: [...equivalence.ignoreEventTypes],
    ignoreStatePaths: equivalence.ignoreStatePaths.map((path) => [...path]),
    equivalent: differences.length === 0,
    differences,
  });
}

const isInteger = (value: unknown): value is bigint | number =>
  typeof value === "bigint" || (typeof value === "number" && Number.isSafeInteger(value));

function holds(operator: CompareOperator, observed: unknown, expected: unknown): boolean {
  if (operator === "eq" || operator === "ne") {
    const same =
      isInteger(observed) && isInteger(expected)
        ? BigInt(observed) === BigInt(expected)
        : canon(observed) === canon(expected);
    return operator === "eq" ? same : !same;
  }
  if (!isInteger(observed) || !isInteger(expected)) return false;
  const left = BigInt(observed);
  const right = BigInt(expected);
  switch (operator) {
    case "lt":
      return left < right;
    case "lte":
      return left <= right;
    case "gt":
      return left > right;
    default:
      return left >= right;
  }
}

const scalar = (value: unknown): boolean =>
  value === null || ["string", "number", "bigint", "boolean"].includes(typeof value);

/** The count a summarised run took, while recording, for the `eventCount` assertion `id`. */
function summarisedCount(run: ScenarioRun, id: string): number {
  const entry = records(run.summary?.eventCountAssertions).find((candidate) => candidate.id === id);
  if (typeof entry?.observed !== "number")
    throw new TypeError(`a summarised run holds no count for assertion ${id}`);
  return entry.observed;
}

/** Evaluates one declarative assertion; a failing assertion is a recorded result, never a refusal. */
export function evaluateAssertion(
  assertion: ScenarioAssertion,
  runs: ReadonlyMap<string, ScenarioRun>,
  equivalences: ReadonlyMap<string, EquivalenceResult>,
): AssertionResult {
  switch (assertion.kind) {
    case "path": {
      const { found, value } = readPath(runs.get(assertion.run), assertion.path);
      const passed = found && holds(assertion.operator, value, assertion.value);
      const result: PathAssertionResult = plain({
        id: assertion.id,
        kind: "path",
        run: assertion.run,
        path: assertion.path.map((segment) =>
          typeof segment === "object" ? { ...segment } : segment,
        ),
        operator: assertion.operator,
        expected: assertion.value,
        found,
        observedKind: !found ? "missing" : scalar(value) ? "scalar" : "composite",
        observed: found && scalar(value) ? value : null,
        passed,
      });
      return result;
    }
    case "eventCount": {
      const run = runOf(runs, assertion.run);
      // A summarised run counted matching events while recording; a full run counts them now.
      const observed =
        run.recording === "summarised"
          ? summarisedCount(run, assertion.id)
          : records(run.events).filter((event) => eventMatches(assertion, event)).length;
      const result: EventCountAssertionResult = plain({
        id: assertion.id,
        kind: "eventCount",
        run: assertion.run,
        eventType: assertion.eventType,
        from: assertion.from,
        to: assertion.to,
        operator: assertion.operator,
        expected: assertion.value,
        observed,
        passed: holds(assertion.operator, observed, assertion.value),
      });
      return result;
    }
    case "equivalence": {
      const declared = equivalences.get(assertion.equivalence);
      const observed = declared?.equivalent === true;
      const result: EquivalenceAssertionResult = plain({
        id: assertion.id,
        kind: "equivalence",
        equivalence: assertion.equivalence,
        expected: assertion.expect,
        observed,
        passed: observed === assertion.expect,
      });
      return result;
    }
  }
}
