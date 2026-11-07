import { expect, it } from "vitest";

import { decodeActorAddress, decodeActorTargetBinding } from "../src/index.js";

const scope = { tenantId: "tenant-a", worldId: "world-a", timelineId: "timeline-main" };

it("rejects an actor address outside its tenant, world, timeline or identity binding", () => {
  const binding = decodeActorTargetBinding({ ...scope, kind: "space", id: "space-yard" });
  expect(decodeActorAddress({ version: 1, ...binding }, binding)).toEqual({
    version: 1,
    ...binding,
  });
  for (const conflicting of [
    { tenantId: "tenant-b" },
    { worldId: "world-b" },
    { timelineId: "timeline-preview" },
    { id: "space-house" },
  ]) {
    expect(() => decodeActorAddress({ version: 1, ...binding, ...conflicting }, binding)).toThrow(
      "do not match",
    );
  }
});
