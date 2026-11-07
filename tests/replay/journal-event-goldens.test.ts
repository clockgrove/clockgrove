import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { computePayloadHash } from "../../packages/application/src/index.js";
import { upcastEventBytes } from "../../packages/contracts/src/index.js";

const directory = new URL(
  "../../packages/contracts/test/fixtures/journal-events/",
  import.meta.url,
);

describe("hash-correct journal event goldens", () => {
  it.each([
    ["event-v1.json", "event-weather-1", "7"],
    ["event-v2.json", "event-weather-2", "8"],
  ])("%s carries the hash of its payload", async (name, eventId, streamSequence) => {
    const event = upcastEventBytes(await readFile(new URL(name, directory)));
    expect(event.eventId).toBe(eventId);
    expect(event.streamSequence).toBe(BigInt(streamSequence));
    expect(event.payloadHash).toBe(computePayloadHash(event.payload));
  });
});
