import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { replayJournal } from "../../packages/application/src/index.js";
import { decodeOpaqueId, upcastEventBytes } from "../../packages/contracts/src/index.js";

const fixtureDirectory = new URL("../../packages/contracts/test/fixtures/", import.meta.url);

describe("journal replay", () => {
  it("uses the accepted v1-to-v2 upcaster and deterministically preserves WeatherChanged", async () => {
    const v1 = await readFile(new URL("event-v1.json", fixtureDirectory));
    const v2 = await readFile(new URL("event-v2.json", fixtureDirectory));
    const acceptedV1 = upcastEventBytes(v1);
    expect(acceptedV1).toMatchObject({
      schemaVersion: 2,
      type: "WeatherChanged",
      policyVersions: { default: "weather-policy@1" },
      payload: { from: "clear", to: "rain" },
    });

    const reader = {
      async *readEventBytes() {
        yield new Uint8Array(v1);
        yield new Uint8Array(v2);
      },
    };
    const scope = {
      tenantId: decodeOpaqueId("tenant-a", "TenantId"),
      timelineId: decodeOpaqueId("timeline-main", "TimelineId"),
    };
    const reduce = (state: { readonly weather: string }, event: { readonly payload: unknown }) => {
      const payload = event.payload as { readonly to: string };
      return { weather: payload.to };
    };
    const first = await replayJournal(reader, scope, { weather: "unknown" }, reduce);
    const second = await replayJournal(reader, scope, { weather: "unknown" }, reduce);

    expect(first).toEqual(second);
    expect(first).toEqual({
      state: { weather: "clear" },
      eventCount: 2,
      lastJournalPosition: 30n,
      serializedState: '{"weather":"clear"}',
    });
  });

  it("rejects a reader that violates canonical ingestion order", async () => {
    const v1 = await readFile(new URL("event-v1.json", fixtureDirectory));
    const reader = {
      async *readEventBytes() {
        yield new Uint8Array(v1);
        yield new Uint8Array(v1);
      },
    };
    await expect(
      replayJournal(
        reader,
        {
          tenantId: decodeOpaqueId("tenant-a", "TenantId"),
          timelineId: decodeOpaqueId("timeline-main", "TimelineId"),
        },
        {},
        (state) => state,
      ),
    ).rejects.toThrow("non-increasing ingestion positions");
  });
});
