import { decodeEntitySelection, type EntitySelection } from "@clockgrove/contracts";
import { expect, it } from "vitest";
import { ApiRefusal } from "../src/api.js";
import { recentDecisions } from "../src/world-debugger.js";

// The selection's history is one window of the space's journal filtered to this actor, so the
// actor's decisions can all lie below the first window while the world keeps moving.
const page = (revision: string, before: string | null, decisions: number): EntitySelection =>
  decodeEntitySelection(
    JSON.parse(
      `{"tenantId":"t","worldId":"w","timelineId":"l","spaceId":"s","version":1,"privacyClass":"public_scene","evidence":{"entity":"canonical","physical":"canonical","derived":"derived","history":"canonical"},"objectId":"a","revision":"${revision}","simulationTime":"20","entity":{"objectId":"a","archetypeId":"rock","pose":{"frameId":"f","frameVersion":1,"coordinates":["1","2"]},"presentation":{"kind":"placeholder","label":"A"}},"physical":{"needs":null,"wellbeing":null,"plant":null,"resource":null,"shelter":null,"locationId":null,"selectedAction":null,"lifecycle":null},"derived":{"canonical":false,"simulationTime":"20","needs":null,"wellbeing":null,"plant":null},"history":{"observedRevision":"${revision}","beforeSequence":${before === null ? "null" : `"${before}"`},"actions":${JSON.stringify(
        Array.from({ length: decisions }, (_, index) => ({
          eventId: `e${before}-${index}`,
          actionId: "x",
          commandId: "c",
          type: "routine.selected",
          partitionSequence: String(Number(before ?? 0) + decisions - index),
          simulationTime: "20",
          recordedAt: "2026-10-31T00:00:00.000Z",
          decision: true,
        })),
      )}}}`,
    ),
  );

it("follows the history cursor past a moving revision until 5 decisions are found", async () => {
  let revision = 10;
  const reads: (string | undefined)[] = [];
  const result = await recentDecisions(async (cursor) => {
    reads.push(cursor && `${cursor.observedRevision}@${cursor.beforeSequence}`);
    if (cursor === undefined) return page(String(++revision), "300", 0);
    // The world ticked after the first read, so the server refuses a cursor at revision 11.
    if (cursor.observedRevision === "11") throw new ApiRefusal(409);
    if (cursor.beforeSequence === "300") return page(cursor.observedRevision, "200", 0);
    return page(cursor.observedRevision, cursor.beforeSequence === "200" ? "100" : null, 3);
  });
  expect(result.stopped).toBeUndefined();
  expect(result.decisions).toHaveLength(5);
  // The refused page is read again from the same cursor at the current revision.
  expect(reads).toEqual([undefined, "11@300", undefined, "12@300", "12@200", "12@100"]);
});

it("says it stopped rather than reporting no decisions when a read is refused", async () => {
  const result = await recentDecisions(async (cursor) => {
    if (cursor === undefined) return page("10", "300", 0);
    throw new ApiRefusal(503);
  });
  expect(result.decisions).toHaveLength(0);
  expect(result.stopped).toBe("History read refused (status 503); older decisions were not read.");
});
