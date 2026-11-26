import { createHash } from "node:crypto";
import { CloudEvent } from "cloudevents";
import { expect, it } from "vitest";
import { toCloudEvent, toLagoEvent, toStripeMeterEvents, type UsageEvent } from "../src/index.js";

const event: UsageEvent = {
  eventId: "step:run-1:2",
  sequence: "7",
  worldId: "world-1",
  timelineId: "main",
  spaceId: "space-1",
  category: "model_call",
  source: "run_step",
  resource: "model-a",
  status: "completed",
  outcomeCode: null,
  principalId: "player-1",
  personaId: null,
  actorId: "actor-1",
  sessionId: "session-1",
  runId: "run-1",
  rootRunId: "run-1",
  quantities: { inputTokens: 120, outputTokens: 30, reasoningTokens: null, calls: 1 },
  occurredAt: "2026-11-20T10:00:00.500000Z",
  worldTime: null,
};
const id = (name: string) => createHash("sha256").update(`${event.eventId}:${name}`).digest("hex");

it("maps one usage event to Stripe, CloudEvents and Lago bodies without inventing a quantity", async () => {
  const timestamp = 1_795_168_800;
  expect(
    await toStripeMeterEvents(event, {
      customer: "cus_1",
      meters: { inputTokens: "in", reasoningTokens: "think", calls: "calls", deliveries: "d" },
    }),
  ).toEqual([
    {
      event_name: "in",
      identifier: id("inputTokens"),
      timestamp,
      payload: { stripe_customer_id: "cus_1", value: "120" },
    },
    {
      event_name: "calls",
      identifier: id("calls"),
      timestamp,
      payload: { stripe_customer_id: "cus_1", value: "1" },
    },
  ]);
  expect(
    toLagoEvent(event, { externalSubscriptionId: "sub_1", codes: { model_call: "llm" } }),
  ).toEqual({
    transaction_id: event.eventId,
    external_subscription_id: "sub_1",
    code: "llm",
    timestamp,
    properties: { inputTokens: 120, outputTokens: 30, calls: 1 },
  });
  expect(toLagoEvent(event, { externalSubscriptionId: "sub_1", codes: {} })).toBeNull();

  const mapped = toCloudEvent(event);
  // The unknown reasoning tokens are left out, never sent as null.
  expect(mapped.data.quantities).toEqual({ inputTokens: 120, outputTokens: 30, calls: 1 });
  const official = new CloudEvent(mapped as never, true);
  // The SDK normalises `time` to millisecond precision.
  expect(JSON.parse(JSON.stringify(official.toJSON()))).toEqual({
    ...JSON.parse(JSON.stringify(mapped)),
    time: "2026-11-20T10:00:00.500Z",
  });
  expect([official.source, official.type, official.subject]).toEqual([
    "clockgrove/world-1/main",
    "clockgrove.usage.model_call",
    "player-1",
  ]);
});

it("meters an offer event's `offers` quantity through the Stripe helper", async () => {
  const chosen: UsageEvent = {
    ...event,
    eventId: "offer_chosen:abc",
    category: "offer_chosen",
    source: "offer_presentation",
    resource: "lantern",
    status: "chosen",
    runId: null,
    rootRunId: null,
    quantities: { offers: 1 },
  };
  expect(
    await toStripeMeterEvents(chosen, { customer: "cus_1", meters: { offers: "offers" } }),
  ).toEqual([
    {
      event_name: "offers",
      identifier: createHash("sha256").update("offer_chosen:abc:offers").digest("hex"),
      timestamp: 1_795_168_800,
      payload: { stripe_customer_id: "cus_1", value: "1" },
    },
  ]);
});
