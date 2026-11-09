import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import {
  ContractDecodeError,
  decodeObserverSceneMessage,
  decodeOperatorSceneMessage,
  decodeScenePatch,
  decodeSceneTransientCue,
  encodeObserverSceneMessage,
  encodeOperatorSceneMessage,
} from "../src/index.js";

it("round trips the operator connection diagnostic, which only the operator decoder accepts", async () => {
  const golden = (
    await readFile(
      new URL("./fixtures/realtime-projection/operator.golden.json", import.meta.url),
      "utf8",
    )
  ).trimEnd();
  const operator = JSON.parse(golden);
  const decoded = decodeOperatorSceneMessage(operator);
  expect(encodeOperatorSceneMessage(decoded)).toBe(golden);
  expect(decoded.payload.connections.map((connection) => connection.acknowledgedRevision)).toEqual([
    null,
    9007199254740993n,
  ]);
  expect(() => decodeObserverSceneMessage(operator)).toThrow("not an observer projection");
  const [connection] = operator.payload.connections;
  for (const message of [
    { ...operator, type: "diagnostic" },
    { ...operator, lane: "projection" },
    { ...operator, payload: { ...operator.payload, rawEvent: "forbidden" } },
    ...["audience", "credential", "providerIdentity"].map((field) => ({
      ...operator,
      payload: { connections: [{ ...connection, [field]: "forbidden" }] },
    })),
  ])
    expect(() => decodeOperatorSceneMessage(message)).toThrow(ContractDecodeError);
});

it("round trips literal snapshot and ordered closed patch goldens through public wire APIs", async () => {
  for (const name of ["snapshot", "patch"]) {
    const golden = (
      await readFile(
        new URL(`./fixtures/realtime-projection/${name}.golden.json`, import.meta.url),
        "utf8",
      )
    ).trimEnd();
    const input = JSON.parse(golden);
    const decoded = decodeObserverSceneMessage(input);
    const actual = encodeObserverSceneMessage(decoded);
    expect(actual, `actual serialized bytes: ${actual}`).toBe(golden);
    expect(decoded.projectionRevision).toBe(
      name === "snapshot" ? 9007199254740993n : 9007199254740994n,
    );
    if (decoded.type === "snapshot") {
      expect(decoded.payload.simulationTime).toBe(9007199254740995n);
      expect(decoded.payload.entities[0]?.pose.coordinates).toEqual(["-9007199254740993", "2"]);
    } else if (decoded.type === "patch") {
      expect(decoded.payload.fromRevision).toBe(9007199254740993n);
      expect(decoded.payload.toRevision).toBe(9007199254740994n);
      expect(decoded.payload.sourceEventIds).toEqual(["event-rain", "event-rest"]);
      expect(decoded.payload.operations.map((operation) => operation.op)).toEqual([
        "upsert_entity",
        "remove_entity",
        "upsert_frame",
        "remove_frame",
        "set_clock",
        "set_weather",
        "upsert_space",
        "remove_space",
        "upsert_presentation",
        "remove_presentation",
        "upsert_interaction",
        "remove_interaction",
        "set_effects",
        "set_feed_cursor",
        "set_compatibility",
      ]);
      for (const toRevision of ["9007199254740993", "0"])
        expect(() => decodeScenePatch({ ...input.payload, toRevision })).toThrow(
          "revision must advance",
        );
      for (const operation of input.payload.operations)
        expect(() =>
          decodeScenePatch({
            ...input.payload,
            operations: [{ ...operation, payload: { rawEvent: "forbidden" } }],
          }),
        ).toThrow(ContractDecodeError);
      expect(() => decodeScenePatch({ ...input.payload, entities: [] })).toThrow(
        ContractDecodeError,
      );
      expect(() =>
        decodeScenePatch({
          ...input.payload,
          operations: [{ op: "replace_entities", entities: [] }],
        }),
      ).toThrow("unknown operation");
    }
    const traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
    const changedIdentity = {
      ...input,
      messageId: "message-alternate",
      sentAt: "2026-10-30T23:00:00.123Z",
      traceparent,
    };
    const changedWire = JSON.parse(
      encodeObserverSceneMessage(decodeObserverSceneMessage(changedIdentity)),
    );
    expect([changedWire.messageId, changedWire.sentAt, changedWire.traceparent]).toEqual([
      "message-alternate",
      "2026-10-30T23:00:00.123Z",
      traceparent,
    ]);
    expect(() => decodeObserverSceneMessage({ ...input, projectionRevision: "0" })).toThrow(
      ContractDecodeError,
    );
    expect(() =>
      decodeObserverSceneMessage({
        ...input,
        payload: { ...input.payload, revision: 9007199254740992 },
      }),
    ).toThrow(ContractDecodeError);
  }
});

it("serializes every droppable cue family with exact expiry and dedupe identity, without repair payloads", async () => {
  const cues = JSON.parse(
    await readFile(new URL("./fixtures/realtime-projection/cues.json", import.meta.url), "utf8"),
  );
  expect(cues.map(decodeSceneTransientCue)).toEqual([
    ...[
      "footstep",
      "splash",
      "particle",
      "sound",
      "emote",
      "hover_hint",
      "animation_transition",
    ].map((kind) => ({
      kind,
      objectId: "keeper",
      reference: `cue-${kind}`,
      expiresAt: "2026-10-30T22:00:01Z",
      dedupeKey: `dedupe-${kind}`,
    })),
  ]);
  for (const cue of cues) {
    const message = {
      tenantId: "tenant-scene",
      worldId: "world-hall",
      timelineId: "timeline-main",
      spaceId: "hall",
      protocolVersion: 1,
      messageId: `message-${cue.kind}`,
      sentAt: "2026-10-30T22:00:00Z",
      lane: "transient",
      type: "cue",
      payload: cue,
    };
    expect(JSON.parse(encodeObserverSceneMessage(decodeObserverSceneMessage(message)))).toEqual(
      message,
    );
    for (const field of ["entities", "operations", "revision"])
      expect(() => decodeSceneTransientCue({ ...cue, [field]: [] })).toThrow(ContractDecodeError);
    const { expiresAt: _expiresAt, ...noExpiry } = cue;
    const { dedupeKey: _dedupeKey, ...noDedupe } = cue;
    expect(() => decodeSceneTransientCue(noExpiry)).toThrow(ContractDecodeError);
    expect(() => decodeSceneTransientCue(noDedupe)).toThrow(ContractDecodeError);
  }
});

it("refuses invalid timestamps, traceparents and snapshots whose collections disagree", async () => {
  const snapshot = JSON.parse(
    await readFile(
      new URL("./fixtures/realtime-projection/snapshot.golden.json", import.meta.url),
      "utf8",
    ),
  );
  const [cue] = JSON.parse(
    await readFile(new URL("./fixtures/realtime-projection/cues.json", import.meta.url), "utf8"),
  );
  const { projectionRevision: _revision, ...envelope } = snapshot;
  const sent = { ...envelope, lane: "transient", type: "cue", payload: cue };
  const projection = snapshot.payload;
  const [binding] = projection.presentationBindings;
  const [interaction] = projection.interactions;
  // Expiry is compared at the timestamps' full precision, not Date.parse milliseconds.
  const brief = { ...cue, expiresAt: "2026-10-30T22:00:00.0002Z" };
  const briefCue = { ...sent, sentAt: "2026-10-30T22:00:00.0001Z", payload: brief };
  expect(decodeObserverSceneMessage(briefCue).payload).toEqual(brief);
  const spaces = (...hierarchy: object[]) => ({
    ...snapshot,
    payload: { ...projection, hierarchy },
  });
  for (const [message, error] of [
    [{ ...snapshot, sentAt: "yesterday" }, "message.sentAt: expected an RFC 3339 UTC timestamp"],
    [{ ...snapshot, sentAt: "2026-02-30T22:00:00Z" }, "message.sentAt: expected an RFC 3339"],
    [{ ...snapshot, sentAt: "2026-10-30T22:00:00+00:00" }, "message.sentAt: expected an RFC 3339"],
    [{ ...snapshot, traceparent: "x" }, "message.traceparent: expected a W3C traceparent"],
    [{ ...snapshot, traceparent: `00-${"0".repeat(32)}-0000000000000001-01` }, "W3C traceparent"],
    [{ ...sent, payload: { ...cue, expiresAt: "never" } }, "cue.expiresAt: expected an RFC 3339"],
    [{ ...sent, sentAt: cue.expiresAt }, "cue.expiresAt: cue must expire after it is sent"],
    [{ ...briefCue, sentAt: "2026-10-30T22:00:00.00021Z" }, "cue must expire after it is sent"],
    [
      { ...snapshot, payload: { ...projection, presentationBindings: [binding, binding] } },
      "projection.presentationBindings[1]: duplicate entity",
    ],
    [
      {
        ...snapshot,
        payload: { ...projection, presentationBindings: [{ ...binding, objectId: "hidden" }] },
      },
      "projection.presentationBindings[0]: entity is not projected",
    ],
    [
      { ...snapshot, payload: { ...projection, interactions: [interaction, interaction] } },
      "projection.interactions[1]: duplicate entity",
    ],
    [
      {
        ...snapshot,
        payload: { ...projection, interactions: [{ ...interaction, entityId: "x" }] },
      },
      "projection.interactions[0]: entity is not projected",
    ],
    [spaces({ spaceId: "den", label: "Den" }), "projection.hierarchy: missing the projected space"],
    [spaces(projection.hierarchy[0], projection.hierarchy[0]), "hierarchy[1].spaceId: duplicate"],
    [spaces({ spaceId: "hall", label: "Hall", parentSpaceId: "hall" }), "cyclic hierarchy"],
    [
      spaces(
        { spaceId: "hall", label: "Hall", parentSpaceId: "den" },
        { spaceId: "den", label: "Den", parentSpaceId: "hall" },
      ),
      "projection.hierarchy[0]: cyclic hierarchy",
    ],
    [spaces({ spaceId: "hall", label: "Hall", parentSpaceId: "vault" }), "unknown parent"],
  ] as [unknown, string][])
    expect(() => decodeObserverSceneMessage(message), error).toThrow(error);
});

it("documents exactly the golden bytes, which the first test proves are the encoder's", async () => {
  const documentation = await readFile(
    new URL("../../../docs/protocols/realtime-projection.md", import.meta.url),
    "utf8",
  );
  const examples = [...documentation.matchAll(/```json\n([\s\S]*?)\n```/gu)].map(
    (example) => example[1],
  );
  const goldens = ["snapshot", "patch"].map(async (name) =>
    (
      await readFile(
        new URL(`./fixtures/realtime-projection/${name}.golden.json`, import.meta.url),
        "utf8",
      )
    ).trimEnd(),
  );
  expect(examples).toEqual(await Promise.all(goldens));
});
