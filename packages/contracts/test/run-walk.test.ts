import { expect, it } from "vitest";

import { ContractDecodeError, decodeRunWalk } from "../src/index.js";

// The browser inspector reads a run walk only through decodeRunWalk (apps/web/src/scene-api.ts),
// so the run's durable breaker record (issue 374, O-breaker) must survive the decoder.
const transition = (from: string, to: string, consecutiveFailures: number) => ({
  routeId: "route-primary",
  alias: "actor-default",
  from,
  to,
  consecutiveFailures,
  recordedAt: "2026-11-18T12:00:00.000Z",
});
const walk = (extra: Record<string, unknown>) => ({
  entry: { runId: "run-1" },
  runs: [
    {
      runId: "run-1",
      sessionId: "session-1",
      actorId: "actor-1",
      principalId: "principal-1",
      personaId: "persona-1",
      activation: "conversation_message",
      inputMessageId: "m1",
      parentRunId: null,
      parentStep: null,
      rootRunId: "run-1",
      model: "scripted-fixture-v1",
      promptVersion: "v1",
      inputRevision: 1,
      status: "completed",
      outcomeCode: null,
      turn: 1,
      summary: "",
      stepCount: 0,
      startedAt: "2026-11-18T12:00:00.000Z",
      endedAt: "2026-11-18T12:00:01.000Z",
      prompt: null,
      steps: [],
      ...extra,
    },
  ],
});

it("keeps a run's breaker transitions for the inspector", () => {
  const transitions = [
    transition("closed", "open", 3),
    transition("open", "half_open", 3),
    transition("half_open", "closed", 0),
  ];
  const decoded = decodeRunWalk(walk({ breakerTransitions: transitions }));
  expect(decoded.runs[0]?.breakerTransitions).toEqual(transitions);
  expect(decodeRunWalk(walk({})).runs[0]).not.toHaveProperty("breakerTransitions");
});

it("refuses a malformed or unbounded breaker record", () => {
  expect(() =>
    decodeRunWalk(walk({ breakerTransitions: [transition("closed", "ajar", 1)] })),
  ).toThrow(ContractDecodeError);
  expect(() =>
    decodeRunWalk(
      walk({
        breakerTransitions: Array.from({ length: 65 }, () => transition("closed", "open", 3)),
      }),
    ),
  ).toThrow(ContractDecodeError);
});
