import type { WorldState } from "@clockgrove/domain";
import type { ScheduleQueue, WorldScheduledPayload } from "@clockgrove/kernel";
import { expect, it } from "vitest";

import {
  decodePartitionState,
  encodePartitionState,
  PartitionStateIntegrityError,
  worldStateHash,
} from "../src/index.js";

// The codec does not interpret the state, so a small stand-in exercises every stored field.
const state = {
  schemaVersion: 1,
  partitionId: "partition-1",
  tenantId: "tenant-1",
  worldId: "world-1",
  timelineId: "timeline-1",
  revision: 7n,
  simulationTime: 120_000n,
  weather: { rainIntensity: 0 },
  spatialFrames: [],
  entities: [{ objectId: "object-1", coordinates: [3n, -4n] }],
} as unknown as WorldState;
const item = (objectId: string, dueAt: bigint) => ({
  id: `decision:${objectId}`,
  tenantId: "tenant-1",
  worldId: "world-1",
  timelineId: "timeline-1",
  ownerPartitionId: "partition-1",
  dueAt,
  priority: 10,
  tieBreakKey: objectId,
  kind: "world.decision",
  payloadVersion: 1,
  payload: { schemaVersion: 1, objectId },
  idempotencyKey: `decision:${objectId}:${dueAt}`,
  catchUpClass: "exact",
});
const schedules = [
  item("object-1", 180_000n),
  item("object-2", 240_000n),
] as unknown as ScheduleQueue<WorldScheduledPayload>;
const encoded = encodePartitionState({ state, schedules, randomState: '[1,["array",[]]]' });

it("round-trips a stored partition document and keeps the simulator's state hash", () => {
  const stored = JSON.parse(JSON.stringify(encoded.document)) as readonly unknown[];
  const decoded = decodePartitionState({ ...encoded, document: stored });
  expect(worldStateHash(decoded.state)).toBe(encoded.stateHash);
  expect(encodePartitionState(decoded).documentHash).toBe(encoded.documentHash);
});

it("reports tampered documents, state hashes, revisions and schedule rows", () => {
  const reason = (input: Parameters<typeof decodePartitionState>[0]) => {
    try {
      decodePartitionState(input);
    } catch (error) {
      if (error instanceof PartitionStateIntegrityError) return error.reason;
      throw error;
    }
    return "verified";
  };
  const tampered = JSON.parse(
    JSON.stringify(encoded.document).replace("object-1", "object-2"),
  ) as readonly unknown[];
  expect(reason({ ...encoded, document: tampered })).toBe("document-hash-mismatch");
  expect(reason({ ...encoded, stateHash: "0".repeat(64) })).toBe("state-hash-mismatch");
  expect(reason({ ...encoded, revision: 8n })).toBe("revision-mismatch");
  const [first, second] = encoded.schedules;
  expect(
    reason({ ...encoded, schedules: [first!, { ...second!, itemHash: "0".repeat(64) }] }),
  ).toBe("schedule-mismatch");
});
