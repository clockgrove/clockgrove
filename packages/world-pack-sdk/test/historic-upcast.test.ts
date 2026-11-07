import { readFileSync } from "node:fs";
import { decodeOpaqueId, upcastEventBytes } from "@clockgrove/contracts";
import { createInitialComponentRegistry } from "@clockgrove/domain";
import { describe, expect, it } from "vitest";
import { decodeResource, encodeResource, upcastWorldPackManifest } from "../src/index.js";

const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(`fixtures/historic/${name}`, import.meta.url)));

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Committed literals: any drift in an upcaster changes these, and no golden holds a historic input.
const MANIFEST_V2_SHA256 = "bbd3f56aeb0eeb2a04de0060ebc87a6aff479ac9a965a6136916640b2d7afb15";
const NEEDS_V1_SHA256 = "22111f24aebe0cdb6a348a2f454bf443493ff89850b4fd57bb2c92193f3c6ab2";
const EVENT_V2_SHA256 = "523be5596449f2807b571ca65f7ac686af1546a83f6390e503ce3783cc89b9e4";

type Registry = ReturnType<typeof createInitialComponentRegistry>;
type Context = Parameters<Registry["upcast"]>[2];

const context = {
  tenantId: decodeOpaqueId("historic-tenant", "TenantId"),
  worldId: decodeOpaqueId("historic-world", "WorldId"),
  timelineId: decodeOpaqueId("historic-timeline", "TimelineId"),
  objectId: decodeOpaqueId("historic-object", "ObjectId"),
  simulationTime: (1n << 62n) as never,
  spatialFrames: [],
  expectedArchetype: { id: "historic.resident", version: 1 },
  expectedTraits: [],
} as unknown as Context;

describe("historic fixtures", () => {
  it("upcasts the schema-1 manifest to a committed digest", async () => {
    const manifest = decodeResource(fixture("world-pack-manifest-v1.json"), "fixture") as Record<
      string,
      unknown
    >;
    const output = upcastWorldPackManifest(manifest);
    expect(output.schemaVersion).toBe(2);
    expect(await sha256(encodeResource(output))).toBe(MANIFEST_V2_SHA256);
  });

  it("keeps the clockgrove.needs version-1 snapshot at version 1 through the production registry", async () => {
    const snapshot = decodeResource(fixture("component-needs-v1.json"), "fixture") as Parameters<
      Registry["upcast"]
    >[0];
    const result = createInitialComponentRegistry().upcast(snapshot, 1, context);
    expect(result.version).toBe(1);
    expect(await sha256(encodeResource(result))).toBe(NEEDS_V1_SHA256);
  });

  it("upcasts the version-1 event twice to a committed digest", async () => {
    const first = upcastEventBytes(fixture("event-v1.json"));
    const second = upcastEventBytes(fixture("event-v1.json"));
    for (const event of [first, second]) {
      expect(event.schemaVersion).toBe(2);
      expect(event.policyVersions.default).toBe("weather-policy@1");
      expect(await sha256(encodeResource(event))).toBe(EVENT_V2_SHA256);
    }
  });
});
