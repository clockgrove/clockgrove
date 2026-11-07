import { readFile } from "node:fs/promises";
import type { WorldState } from "@clockgrove/domain";
import type { ScheduleQueue, WorldScheduledPayload } from "@clockgrove/kernel";
import { sha256Hex } from "@clockgrove/kernel";
import { expect, it } from "vitest";

import type {
  PartitionSnapshotContent,
  PartitionSnapshotPorts,
  SnapshotCompatibility,
  SnapshotRef,
} from "../src/index.js";
import {
  createPartitionSnapshot,
  decodePartitionSnapshot,
  encodePartitionSnapshot,
  encodePartitionState,
  requireSnapshotCompatibility,
  SnapshotIncompatibleError,
  SnapshotIntegrityError,
  worldStateHash,
} from "../src/index.js";

// The stand-in state and schedules of partition-state.test.ts; the codec does not interpret them.
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
const compatibility: SnapshotCompatibility = {
  codec: 1,
  documentVersion: 2,
  canonicalEncoding: "clockgrove-canonical-v1",
  randomContract: "clockgrove-random-v1",
  kernelRegistryHash: "1".repeat(64),
  packContentHash: "2".repeat(64),
};
const content = {
  scope: {
    tenantId: "tenant-1",
    worldId: "world-1",
    timelineId: "timeline-1",
    partitionId: "partition-1",
    spaceId: "space-1",
  },
  streamId: "stream-1",
  coveredPartitionSequence: 9n,
  coveredStreamSequence: 4n,
  compatibility,
  stored: encodePartitionState({ state, schedules, randomState: '[1,["array",[]]]' }),
} as unknown as PartitionSnapshotContent;

const golden = JSON.parse(
  await readFile(new URL("goldens/partition-snapshot-v1.json", import.meta.url), "utf8"),
);
const bytes = (text: string) => new TextEncoder().encode(text);

it("reproduces the pinned format v1 bytes and decodes them to the recorded state hash", () => {
  const encoded = encodePartitionSnapshot(content);
  expect(new TextDecoder().decode(encoded)).toBe(golden.content);
  expect(sha256Hex(encoded)).toBe(golden.bytesSha256);
  const decoded = decodePartitionSnapshot("snapshot-1", bytes(golden.content));
  expect(worldStateHash(decoded.document.state)).toBe(golden.worldStateHash);
  expect(decoded.content).toEqual(content);
});

it("rejects a flipped document byte and a changed kernel registry", () => {
  const flipped = bytes(golden.content.replace("object-1", "object-3"));
  expect(() => decodePartitionSnapshot("snapshot-1", flipped)).toThrow(
    expect.objectContaining({
      constructor: SnapshotIntegrityError,
      reason: "document-hash-mismatch",
    }),
  );
  const { content: decoded } = decodePartitionSnapshot("snapshot-1", bytes(golden.content));
  const current = { ...compatibility, kernelRegistryHash: "3".repeat(64) };
  expect(() => requireSnapshotCompatibility("snapshot-1", decoded.compatibility, current)).toThrow(
    expect.objectContaining({
      constructor: SnapshotIncompatibleError,
      field: "kernelRegistryHash",
    }),
  );
});

it("snapshots the verified read it is given, never a head committed since", async () => {
  const { compatibility: _compatibility, ...covered } = content;
  const read = { ...covered, packContentHash: "2".repeat(64), continuationOpen: false };
  const ports = {
    snapshots: {
      readCommitted: () => Promise.reject(new Error("read again")),
      record: async (_authorization: unknown, ref: SnapshotRef) => ref,
    },
    artifacts: { put: async (_authorization: unknown, input: unknown) => input },
  } as unknown as PartitionSnapshotPorts;
  const ref = await createPartitionSnapshot({} as never, content.scope, ports, read);
  expect([ref.snapshotId, ref.coveredPartitionSequence, ref.stateHash]).toEqual([
    "snapshot:timeline-1:partition-1:9",
    9n,
    read.stored.stateHash,
  ]);
});
