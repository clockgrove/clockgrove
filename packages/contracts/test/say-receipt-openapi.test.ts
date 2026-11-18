import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { decodeSayReceipt } from "../src/index.js";

interface Schema {
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly properties?: Record<string, Schema>;
  readonly items?: Schema;
}

const keys = (value: object | undefined) => Object.keys(value ?? {}).sort();

it("publishes the Say receipt's optional audience in the OpenAPI schema, key for key", async () => {
  const openapi = JSON.parse(
    await readFile(
      new URL("../../../docs/protocols/conversations.openapi.json", import.meta.url),
      "utf8",
    ),
  ) as { components: { schemas: Record<string, Schema> } };
  const schema = openapi.components.schemas.SayReceipt!;
  const audienceSchema = schema.properties?.audience;
  const observerSchema = audienceSchema?.properties?.observers?.items;

  // A receipt with an audience, as `/v1/runtime/say` answers, through its own decoder.
  const receipt = decodeSayReceipt({
    type: "public_say",
    speech: {
      type: "public_speech",
      messageId: "say-1",
      scope: {
        tenantId: "tenant-1",
        worldId: "world-1",
        timelineId: "timeline-1",
        spaceId: "space-1",
      },
      speakerId: "fixture.cedar",
      text: "hello",
      sentAt: "2026-11-18T00:00:00.000Z",
    },
    attribution: { principalId: "principal-1", personaId: null },
    audience: {
      resolverVersion: "clockgrove-audience-resolver@2",
      observers: [
        {
          observerId: "fixture.fox",
          reason: "same_space",
          detailLevel: "full",
        },
      ],
    },
  });

  // The schema closes each object and declares exactly the keys the receipt carries.
  expect(schema.additionalProperties).toBe(false);
  expect(keys(schema.properties)).toEqual(keys(receipt));
  expect(schema.required).not.toContain("audience");
  expect(audienceSchema?.additionalProperties).toBe(false);
  expect(keys(audienceSchema?.properties)).toEqual(keys(receipt.audience));
  expect([...(audienceSchema?.required ?? [])].sort()).toEqual(keys(receipt.audience));
  expect(observerSchema?.additionalProperties).toBe(false);
  expect(keys(observerSchema?.properties)).toEqual(keys(receipt.audience?.observers[0]));
  expect([...(observerSchema?.required ?? [])].sort()).toEqual(
    keys(receipt.audience?.observers[0]),
  );
});
