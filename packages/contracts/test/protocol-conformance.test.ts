import { expect, it } from "vitest";

import {
  decodeActorTargetBinding,
  decodeCommandEnvelope,
  decodeEventEnvelope,
} from "../src/index.js";

const binding = decodeActorTargetBinding({
  tenantId: "tenant-a",
  worldId: "world-a",
  timelineId: "timeline-main",
  kind: "space",
  id: "space-hall",
});
const attribution = { effectiveActorId: "persona-caretaker", causalRootActionId: "action-1" };
const identity = (payload: unknown) => payload;

it("accepts the current and one prior command schema and refuses others", () => {
  const command = {
    commandId: "command-1",
    type: "OpenObject",
    target: { version: 1, ...binding },
    expected: {},
    issuedAt: "2026-08-18T11:59:59.000Z",
    context: { version: 1, correlationId: "correlation-1", requestId: "request-1" },
    attribution,
    payload: {},
  };
  for (const schemaVersion of [1, 2])
    expect(decodeCommandEnvelope({ schemaVersion, ...command }, binding, identity)).toBeDefined();
  expect(() => decodeCommandEnvelope({ schemaVersion: 3, ...command }, binding, identity)).toThrow(
    "unsupported schema version",
  );
});

it("refuses an event whose actor scope differs from the event scope", () => {
  const event = {
    schemaVersion: 2,
    eventId: "event-1",
    type: "ObjectOpened",
    tenantId: "tenant-a",
    worldId: "world-b",
    timelineId: "timeline-main",
    partitionId: "partition-hall",
    streamId: "stream-chest",
    streamSequence: "4",
    partitionSequence: "9",
    journalPosition: "22",
    simulationTime: "1000",
    recordedAt: "2026-08-18T12:00:00.000Z",
    commandId: "command-1",
    correlationId: "correlation-1",
    attribution: { ...attribution, authorityDecisionId: "authority-1" },
    actor: { version: 1, ...binding },
    policyVersions: {},
    privacyClass: "public_scene",
    payloadHash: "sha256:object-opened",
    payload: {},
  };
  expect(() => decodeEventEnvelope(event, identity, { actorBinding: binding })).toThrow(
    "actor scope does not match event scope",
  );
});
