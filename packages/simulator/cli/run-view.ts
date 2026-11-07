import type { ScenarioRun } from "../src/scenario/bundle.js";
import { isRecord, type Rec } from "../src/scenario/support.js";

/**
 * The parts of a scenario run record the session commands report. The record comes from `runScenario`,
 * so a missing or mistyped member is an internal defect and throws.
 */
export interface RunView {
  readonly raw: Rec;
  readonly commands: readonly Rec[];
  readonly events: readonly unknown[];
  readonly decisions: readonly unknown[];
  readonly scheduleMutations: readonly unknown[];
  readonly scheduledInputs: readonly unknown[];
  readonly ruleEvaluations: readonly unknown[];
  readonly ruleIntents: readonly unknown[];
  readonly ruleDisposition: unknown;
  /** The named random state after the run. */
  readonly randomState: unknown;
  readonly remainingSchedule: readonly unknown[];
  readonly nextDueAt: unknown;
  readonly simulationTime: bigint;
  readonly finalStateHash: string;
}

function member(record: Rec, key: string): unknown {
  if (!Object.hasOwn(record, key)) throw new Error(`the run record has no ${key}`);
  return record[key];
}

function recordOf(value: unknown): Rec {
  if (!isRecord(value)) throw new Error("the run record member is not a record");
  return value;
}

function listOf(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error("the run record member is not a list");
  return value as readonly unknown[];
}

export function viewRun(run: ScenarioRun): RunView {
  const raw: Rec = { ...run };
  const rules = recordOf(member(raw, "rules"));
  const schedule = recordOf(member(raw, "schedule"));
  const simulationTime = member(recordOf(member(raw, "finalState")), "simulationTime");
  const finalStateHash = member(raw, "finalStateHash");
  if (typeof simulationTime !== "bigint") throw new Error("the final state has no simulation time");
  if (typeof finalStateHash !== "string") throw new Error("the run record has no final state hash");
  return {
    raw,
    commands: listOf(member(raw, "commands")).map(recordOf),
    events: listOf(member(raw, "events")),
    decisions: listOf(member(raw, "decisions")),
    scheduleMutations: listOf(member(raw, "scheduleMutations")),
    scheduledInputs: listOf(member(raw, "scheduledInputs")),
    ruleEvaluations: listOf(member(rules, "evaluations")),
    ruleIntents: listOf(member(rules, "intents")),
    ruleDisposition: member(rules, "disposition"),
    randomState: member(recordOf(member(raw, "randomState")), "after"),
    remainingSchedule: listOf(member(schedule, "remaining")),
    nextDueAt: member(schedule, "nextDueAt"),
    simulationTime,
    finalStateHash,
  };
}

/** What one more step appended to the run; run records only ever grow at their end. */
export interface RunDelta {
  readonly commands: readonly Rec[];
  readonly events: readonly unknown[];
  readonly decisions: readonly unknown[];
  readonly scheduleMutations: readonly unknown[];
  readonly scheduledInputs: readonly unknown[];
  readonly ruleEvaluations: readonly unknown[];
  readonly ruleIntents: readonly unknown[];
}

export function deltaSince(previous: RunView, next: RunView): RunDelta {
  return {
    commands: next.commands.slice(previous.commands.length),
    events: next.events.slice(previous.events.length),
    decisions: next.decisions.slice(previous.decisions.length),
    scheduleMutations: next.scheduleMutations.slice(previous.scheduleMutations.length),
    scheduledInputs: next.scheduledInputs.slice(previous.scheduledInputs.length),
    ruleEvaluations: next.ruleEvaluations.slice(previous.ruleEvaluations.length),
    ruleIntents: next.ruleIntents.slice(previous.ruleIntents.length),
  };
}

/** Cumulative counts of the run. */
export function countersOf(steps: number, run: RunView) {
  return {
    steps,
    commands: run.commands.length,
    events: run.events.length,
    decisions: run.decisions.length,
    scheduleMutations: run.scheduleMutations.length,
    scheduledInputs: run.scheduledInputs.length,
    ruleEvaluations: run.ruleEvaluations.length,
    remainingSchedule: run.remainingSchedule.length,
  };
}
