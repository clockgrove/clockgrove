// Labelled wakes for evaluating wake triage (issue 259). Each case is written in code from a
// situation (a need and the resource that answers it) and one of five cohorts. The label is the
// answer a careful reviewer gives; it never reaches the model, only `subject` does.

import type { WakeTriageLabel, WakeTriageRecord, WakeTriageSubject } from "./wake-triage.js";

export type WakeTriageCohort =
  | "routine_holds"
  | "routine_condition_fails"
  | "no_routine"
  | "nothing_material"
  | "direct_message";
export type WakeTriageExpected = Exclude<WakeTriageLabel, "cant_tell">;
export type WakeTriageCaseSubject = Pick<
  WakeTriageSubject,
  "reason" | "input" | "prompt" | "wakes" | "routines"
>;
export interface WakeTriageCase {
  readonly id: string;
  readonly cohort: WakeTriageCohort;
  readonly expected: WakeTriageExpected;
  readonly subject: WakeTriageCaseSubject;
}

interface Situation {
  readonly key: string;
  readonly need: string;
  readonly resource: string;
  readonly unit: string;
  readonly act: string;
  readonly message: string;
}
const SITUATIONS: readonly Situation[] = [
  {
    key: "thirst",
    need: "thirst",
    resource: "water store",
    unit: "portions",
    act: "drink",
    message: "Are you thirsty? I can fetch some water.",
  },
  {
    key: "hunger",
    need: "hunger",
    resource: "food store",
    unit: "meals",
    act: "eat",
    message: "Have you eaten today?",
  },
  {
    key: "cold",
    need: "cold",
    resource: "firewood pile",
    unit: "logs",
    act: "stoke the fire",
    message: "It is freezing out, are you warm enough?",
  },
  {
    key: "tiredness",
    need: "tiredness",
    resource: "bed",
    unit: "free beds",
    act: "sleep",
    message: "You look worn out. Why not rest?",
  },
  {
    key: "dark",
    need: "darkness",
    resource: "lamp oil",
    unit: "measures",
    act: "light the lamp",
    message: "Can you see anything in there?",
  },
  {
    key: "rain",
    need: "wetness",
    resource: "shelter",
    unit: "dry places",
    act: "take cover",
    message: "It is pouring, do you have cover?",
  },
  {
    key: "garden",
    need: "dry soil",
    resource: "watering can",
    unit: "fills",
    act: "water the garden",
    message: "How is the garden doing?",
  },
  {
    key: "injury",
    need: "injury",
    resource: "bandage box",
    unit: "bandages",
    act: "dress the wound",
    message: "I heard you were hurt. Are you all right?",
  },
];

function build(situation: Situation, cohort: WakeTriageCohort): WakeTriageCase {
  const { key, need, resource, unit, act } = situation;
  const id = `${cohort}-${String(SITUATIONS.indexOf(situation) + 1).padStart(2, "0")}`;
  const prompt = `You are a villager tending a home. Your ${resource} is how you ${act}.`;
  const threshold = { kind: "threshold", conditionId: `${key}-high` };
  const routine = {
    id: `${key}-routine`,
    kind: "threshold",
    eventType: null,
    input: `${act} when ${need} is high`,
    condition: `The ${resource} still has ${unit}`,
  };
  const wake = (evidence: string, reason: Record<string, unknown> = threshold) => [
    { reason, evidence },
  ];
  const level = 6000 + SITUATIONS.indexOf(situation) * 400;
  const base = { reason: "threshold", input: "", prompt };
  switch (cohort) {
    case "routine_holds":
      return {
        id,
        cohort,
        expected: "compiled_routine",
        subject: {
          ...base,
          wakes: wake(`${need} ${level}/10000; ${resource}: 5 ${unit}`),
          routines: [routine],
        },
      };
    case "routine_condition_fails":
      return {
        id,
        cohort,
        expected: "full_turn",
        subject: {
          ...base,
          wakes: wake(`${need} ${level}/10000; ${resource}: 0 ${unit}`),
          routines: [routine],
        },
      };
    case "no_routine":
      return {
        id,
        cohort,
        expected: "full_turn",
        subject: {
          ...base,
          wakes: wake(`${need} ${level}/10000; ${resource}: 2 ${unit}`),
          routines: [],
        },
      };
    case "nothing_material":
      return {
        id,
        cohort,
        expected: "suppress",
        subject: {
          reason: "heartbeat",
          input: "",
          prompt,
          wakes: wake(
            `${need} ${level - 5500}/10000; ${resource}: 6 ${unit}; nothing needs doing`,
            {
              kind: "heartbeat",
              heartbeatId: `${key}-check`,
            },
          ),
          routines: [],
        },
      };
    case "direct_message":
      return {
        id,
        cohort,
        expected: "full_turn",
        subject: {
          reason: "direct_message",
          input: situation.message,
          prompt,
          wakes: [],
          routines: [],
        },
      };
  }
}

const COHORTS: readonly WakeTriageCohort[] = [
  "routine_holds",
  "routine_condition_fails",
  "no_routine",
  "nothing_material",
  "direct_message",
];
export const WAKE_TRIAGE_CASES: readonly WakeTriageCase[] = COHORTS.flatMap((cohort) =>
  SITUATIONS.map((situation) => build(situation, cohort)),
);

export type WakeTriageCaseRecord = Pick<
  WakeTriageRecord,
  "status" | "choice" | "costMicrousd" | "latencyMs"
> & { readonly caseId: string };

const count = (values: readonly (string | null)[]) =>
  values.reduce<Record<string, number>>((table, value) => {
    if (value !== null) table[value] = (table[value] ?? 0) + 1;
    return table;
  }, {});
const ratio = (part: number, whole: number) => (whole === 0 ? null : part / whole);

/**
 * Scores a model's records against the labelled cases. Decisions:
 * - Only a non-abstaining choice is an answer; `cant_tell`, failures and low-confidence picks still
 *   carry their status, so they show in `statuses` and `confusion` but never count as correct.
 * - `blindSpot` is the share of `routine_condition_fails` wakes answered `compiled_routine`, over all
 *   cases of the cohort, so an unanswered wake counts as not taking the routine.
 * - Latency percentiles are nearest rank over the measured latencies; cost sums only known costs.
 */
export function wakeTriageEvaluation(
  cases: readonly WakeTriageCase[],
  records: readonly WakeTriageCaseRecord[],
) {
  const byId = new Map(cases.map((item) => [item.id, item]));
  const rows = records.flatMap((record) => {
    const item = byId.get(record.caseId);
    const isAnswer = record.choice !== null && record.choice !== "cant_tell";
    return item === undefined
      ? []
      : [{ item, record, isAnswer, correct: isAnswer && record.choice === item.expected }];
  });
  const summary = (subset: typeof rows) => {
    const answered = subset.filter((row) => row.isAnswer).length;
    const correct = subset.filter((row) => row.correct).length;
    return { answered, correct, accuracy: ratio(correct, answered) };
  };
  const confusion: Record<string, Record<string, number>> = {};
  for (const { item, record } of rows) {
    const row = (confusion[item.expected] ??= {});
    const column = record.choice ?? record.status;
    row[column] = (row[column] ?? 0) + 1;
  }
  const cohorts = Object.fromEntries(
    COHORTS.map((cohort) => {
      const subset = rows.filter((row) => row.item.cohort === cohort);
      return [
        cohort,
        {
          cases: cases.filter((item) => item.cohort === cohort).length,
          ...summary(subset),
          compiledRoutine: subset.filter((row) => row.record.choice === "compiled_routine").length,
        },
      ];
    }),
  );
  const { cases: blindCases, compiledRoutine } = cohorts.routine_condition_fails as {
    cases: number;
    compiledRoutine: number;
  };
  const latencies = rows
    .flatMap((row) => (row.record.latencyMs === null ? [] : [row.record.latencyMs]))
    .sort((a, b) => a - b);
  const percentile = (p: number) => latencies[Math.ceil(latencies.length * p) - 1] ?? null;
  return {
    statuses: count(rows.map((row) => row.record.status)),
    labels: count(rows.map((row) => (row.isAnswer ? row.record.choice : null))),
    ...summary(rows),
    confusion,
    cohorts,
    blindSpot: { cases: blindCases, compiledRoutine, rate: ratio(compiledRoutine, blindCases) },
    knownCostMicrousd: rows.reduce((sum, row) => sum + (row.record.costMicrousd ?? 0), 0),
    unknownCostCalls: rows.filter((row) => row.record.costMicrousd === null).length,
    p50LatencyMs: percentile(0.5),
    p95LatencyMs: percentile(0.95),
  };
}
