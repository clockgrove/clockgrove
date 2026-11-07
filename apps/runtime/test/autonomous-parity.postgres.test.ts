import {
  decodeCanonicalNode,
  encodeCanonicalNode,
  type WorldCommandResult,
} from "@clockgrove/application";
import { describe, expect, it } from "vitest";
import {
  AUTONOMOUS_MODES,
  type AutonomousCommandObservation,
  autonomousScenarioParity,
  autonomousSemanticResponse,
  reportAutonomousParity,
} from "./world-owner/autonomous-parity.js";
import {
  isNativeWorldOwnerChild,
  type NativeWorldOwner,
  runNativeWorldOwnerProcess,
  withNativeWorldOwner,
} from "./world-owner/native-harness.js";

const FILE = "apps/runtime/test/autonomous-parity.postgres.test.ts";
const REPRESENTATIVES = [
  ["fixture", "non-raccoon-conformance"],
  ["raccoons", "food-decay-and-conservation"],
] as const;

it.skipIf(isNativeWorldOwnerChild())(
  "omits only recordedAt while retaining exact semantic responses",
  () => {
    const event = {
      schemaVersion: 2,
      eventId: "semantic-event",
      type: "ResourceChanged",
      tenantId: "semantic-tenant",
      worldId: "semantic-world",
      timelineId: "semantic-timeline",
      partitionId: "semantic-partition",
      streamId: "semantic-stream",
      streamSequence: 3n,
      partitionSequence: 4n,
      journalPosition: 5n,
      simulationTime: 6n,
      commandId: "semantic-command",
      correlationId: "semantic-correlation",
      attribution: {
        effectiveActorId: "semantic-actor",
        causalRootActionId: "semantic-action",
        authorityDecisionId: "semantic-authority",
      },
      policyVersions: { routine: "1" },
      privacyClass: "public_scene",
      payloadHash: "semantic-payload",
      payload: { quantity: 1 },
    };
    const command = {
      commandId: "semantic-command",
      outcome: "committed",
      value: {
        status: "committed",
        revision: "7",
        simulationTime: "6",
        complete: true,
        eventCount: 1,
        stateHash: "semantic-state-hash",
      },
    };
    const expected = { status: 200, body: encodeCanonicalNode({ ...command, events: [event] }) };
    for (const recordedAt of ["2026-10-20T00:00:00.000Z", "2026-10-21T00:00:00.000Z"]) {
      expect(
        autonomousSemanticResponse({
          status: 200,
          body: encodeCanonicalNode({ ...command, events: [{ ...event, recordedAt }] }),
        }),
      ).toEqual(expected);
    }
    const refusal = {
      ...command,
      outcome: "rejected",
      value: {
        status: "refused",
        refusal: {
          code: "precondition-failed",
          check: "resource.available-and-bounded@1",
          path: "payload.quantity",
        },
      },
      events: [],
    };
    expect(autonomousSemanticResponse({ status: 409, body: encodeCanonicalNode(refusal) })).toEqual(
      { status: 409, body: encodeCanonicalNode(refusal) },
    );
    const changed = { ...event, payloadHash: "changed-payload", payload: { quantity: 2 } };
    expect(
      autonomousSemanticResponse({
        status: 200,
        body: encodeCanonicalNode({
          ...command,
          events: [{ ...changed, recordedAt: "2026-10-20T00:00:00.000Z" }],
        }),
      }),
    ).toEqual({ status: 200, body: encodeCanonicalNode({ ...command, events: [changed] }) });
  },
);

describe("autonomous native parity representative", () => {
  for (const [pack] of REPRESENTATIVES) {
    it.skipIf(isNativeWorldOwnerChild())(
      `owns bounded ${pack} native runtime and disposable PostgreSQL`,
      async () => {
        await runNativeWorldOwnerProcess(FILE, pack);
      },
      210_000,
    );
  }
  it.skipIf(!isNativeWorldOwnerChild())(
    "compares actual alarm delivery, semantic responses and state hashes with headless execution and the pure reference",
    async () => {
      await withNativeWorldOwner(async (owner) => {
        const representative = REPRESENTATIVES.find(([pack]) => pack === owner.packName);
        if (representative === undefined) throw new Error("native representative pack missing");
        const [, scenario] = representative;
        const observations: AutonomousCommandObservation[] = [];
        const runs = await autonomousScenarioParity(owner, scenario, (observation) =>
          observations.push(observation),
        );
        expect(runs.map((run) => run.mode)).toEqual([
          "headless",
          "frequent-alarms",
          "long-sleep",
          "workflow-catch-up",
          "redelivery",
          "restart",
          "replacement",
        ]);
        expect(reportAutonomousParity(runs)).toEqual([]);
        const first = runs[0];
        if (first === undefined) throw new Error("missing headless comparator");
        const wrong = "0".repeat(64);
        const extra = first.revision + 1n;
        expect(
          reportAutonomousParity([
            { ...first, expected: wrong, reference: wrong, journalRevision: extra },
          ]),
        ).toEqual([
          `${owner.packName}/${scenario}:main:headless actual ${first.actual} != expected ${wrong}`,
          `${owner.packName}/${scenario}:main:headless semantic ${first.semantic} != reference ${wrong}`,
          `${owner.packName}/${scenario}:main:headless revision ${first.revision} != journal ${extra}`,
        ]);
        if (owner.packName === "raccoons") {
          const commandId = "commandid_2561a54f3536fd00";
          // Caught up through the first delivery (an environment boundary) and run at earned
          // time, the scenario's first consume is accepted in every mode.
          expect(
            observations
              .filter((observation) => observation.commandId === commandId)
              .map((observation) => {
                const result = decodeCanonicalNode(
                  observation.response.body as never,
                ) as WorldCommandResult;
                return [
                  observation.mode,
                  observation.response.status,
                  result.outcome,
                  result.events.map((event) => event.type),
                ];
              }),
          ).toEqual(
            AUTONOMOUS_MODES.map((mode) => [mode, 200, "committed", ["resource.consumed"]]),
          );
        } else {
          let semanticCalls = 0;
          let expectedResponse: Awaited<ReturnType<NativeWorldOwner["submit"]>> | undefined;
          const mismatch = { status: 409, body: { error: "semantic-response-negative-control" } };
          const failure = await autonomousScenarioParity(
            {
              ...owner,
              submit: async (...args) => {
                const response = await owner.submit(...args);
                if (args[0].type === "world.weather.set") {
                  semanticCalls += 1;
                  if (semanticCalls === 1) expectedResponse = autonomousSemanticResponse(response);
                  if (semanticCalls === 2) return mismatch;
                }
                return response;
              },
            },
            scenario,
          ).catch((error: unknown) => error);
          expect(semanticCalls).toBe(2);
          expect(expectedResponse?.status).toBe(200);
          expect(failure).toMatchObject({ actual: mismatch, expected: expectedResponse });
        }
      });
    },
    180_000,
  );
});
