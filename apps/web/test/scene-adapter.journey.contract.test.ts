import {
  decodeEntitySelection,
  decodeLivingScene,
  decodeOpaqueId,
  encodeObserverSceneMessage,
} from "@clockgrove/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { followEmphasis, useEntityFocus, useYardView } from "../src/yard-state.js";
import { ackMessage, patch, resumeMessage } from "./convergence-fixture.js";
import { Headless3DAdapter } from "./headless-3d-adapter.js";
import { sceneSession } from "./scene-socket-fixture.js";

const scene = decodeLivingScene({
  version: 1,
  privacyClass: "public_scene",
  tenantId: "tenant-yard",
  worldId: "green-lake-yard",
  timelineId: "timeline-yard",
  spaceId: "space-yard",
  revision: "9007199254740993",
  simulationTime: "9007199254740995",
  weather: { rainIntensity: 400 },
  frames: [
    {
      frameId: "frame-yard",
      version: 2,
      dimensions: 3,
      axes: {
        axes: [
          { name: "x", positiveDirection: "east" },
          { name: "y", positiveDirection: "north" },
          { name: "z", positiveDirection: "up" },
        ],
      },
      unit: { name: "millimetre", fractionalDigits: 2 },
      origin: ["0", "0", "0"],
      gravity: { kind: "constant-vector", vector: ["0", "0", "-981"] },
    },
  ],
  entities: [
    {
      objectId: "object-raccoon",
      archetypeId: "raccoon",
      pose: { frameId: "frame-yard", frameVersion: 2, coordinates: ["125", "250", "375"] },
      presentation: { kind: "placeholder", label: "Raccoon" },
    },
  ],
});
const scope = {
  tenantId: scene.tenantId,
  worldId: scene.worldId,
  timelineId: scene.timelineId,
  spaceId: scene.spaceId,
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  useYardView.getState().select(undefined);
  useEntityFocus.getState().focus(undefined);
});

it("observes socket revisions, recovers gaps and supplies renderer-neutral 3D selection", async () => {
  vi.useFakeTimers();
  const transport = vi.fn();
  vi.stubGlobal("fetch", transport);
  const fixture = sceneSession(() => useYardView.getState().select(undefined));
  const { session, sockets } = fixture;
  const notifications: string[] = [];
  const unsubscribe = session.subscribe(() => {
    const state = session.getSnapshot();
    notifications.push(`${state.status}|${state.scene?.revision}|${state.projection?.revision}`);
  });
  session.replace("inspect-only", scope);
  await vi.advanceTimersByTimeAsync(0);
  const establishing = sockets[0];
  if (!establishing) throw new Error("scene socket not opened");
  const snapshotRequired = JSON.stringify({
    protocolVersion: 1,
    type: "recovery",
    reason: "snapshot_required",
  });
  notifications.length = 0;
  establishing.deliver(snapshotRequired);
  expect(notifications.join(",")).toBe(
    "connecting|undefined|undefined,connecting|undefined|undefined,connecting|undefined|undefined",
  );
  const first = await fixture.deliver(
    scene,
    JSON.parse(
      '[{"objectId":"object-raccoon","assetId":"raccoon-mesh","animationFamily":"rest","accessibilityLabel":"Resting raccoon"}]',
    ),
  );
  expect(session.getSnapshot().scene).toEqual(scene);
  expect(first.messages[1]).toEqual(ackMessage(scene.revision, 1));
  expect(notifications.at(-1)).toBe("ready|9007199254740993|9007199254740993");
  const adapter = new Headless3DAdapter();
  const committed = session.getSnapshot().projection;
  if (!committed) throw new Error("missing committed projection");
  const stop = adapter.onIntent(({ objectId }) => useYardView.getState().select(objectId));
  adapter.loadSnapshot(committed);
  expect(adapter.revision).toBe(9007199254740993n);
  adapter.pick(decodeOpaqueId("object-unknown", "ObjectId"));
  expect(useYardView.getState().selected).toBeUndefined();
  adapter.pick(decodeOpaqueId("object-raccoon", "ObjectId"));
  expect(useYardView.getState().selected).toBe("object-raccoon");
  // Shared selection and keyboard focus reach the 3D consumer as emphasis on its existing nodes.
  const stopEmphasis = followEmphasis(({ selected, focused }) => {
    adapter.setSelection(selected);
    adapter.focus(focused);
  });
  useEntityFocus.getState().focus(decodeOpaqueId("object-unknown", "ObjectId"));
  expect(adapter.emphasized).toEqual({ selected: "object-raccoon", focused: undefined });
  useEntityFocus.getState().focus(decodeOpaqueId("object-raccoon", "ObjectId"));
  // The headless consumer builds a 3D scene graph: frame groups, and nodes at frame-local x, y, z.
  expect([...adapter.groups]).toEqual([
    ["frame-yard@2", { frame: scene.frames[0], children: ["object-raccoon"] }],
  ]);
  expect([...adapter.nodes.values()]).toEqual([
    {
      objectId: "object-raccoon",
      group: "frame-yard@2",
      position: [1.25, 2.5, 3.75],
      presentation: { kind: "placeholder", label: "Raccoon" },
      material: { resource: "raccoon-mesh", animation: "rest", label: "Resting raccoon" },
    },
  ]);
  await vi.advanceTimersByTimeAsync(11000);
  expect(transport.mock.calls).toEqual([]);
  const advanced = decodeLivingScene({
    ...scene,
    revision: "9007199254740997",
    simulationTime: "9007199254741000",
    weather: { rainIntensity: 0 },
    entities: scene.entities.map((entity) => ({
      ...entity,
      pose: { ...entity.pose, coordinates: ["125", "250", "500"] },
    })),
  });
  first.receive(advanced);
  const advancedProjection = {
    ...committed,
    revision: 9007199254740997n,
    simulationTime: 9007199254741000n,
    weather: { rainIntensity: 0 },
    entities: advanced.entities,
  };
  adapter.loadSnapshot(advancedProjection);
  first.receive(scene);
  first.receive(advanced);
  expect(session.getSnapshot().scene).toEqual(advanced);
  adapter.loadSnapshot(committed);
  expect(adapter.scene?.revision).toBe("9007199254740997");
  expect(adapter.emphasized).toEqual({ selected: "object-raccoon", focused: "object-raccoon" });
  expect(adapter.nodes.get(decodeOpaqueId("object-raccoon", "ObjectId"))?.position).toEqual([
    1.25, 2.5, 5,
  ]);
  // A contiguous patch moves the node; replaying it is stale and changes nothing.
  const [raccoon] = advanced.entities;
  if (!raccoon) throw new Error("missing raccoon");
  const move = {
    fromRevision: 9007199254740997n,
    toRevision: 9007199254740998n,
    audienceHash: "session-test-audience",
    sourceEventIds: [],
    operations: [
      {
        op: "upsert_entity" as const,
        entity: { ...raccoon, pose: { ...raccoon.pose, coordinates: ["125", "250", "600"] } },
      },
    ],
  };
  for (let replay = 0; replay < 2; replay++) {
    adapter.applyPatch(move);
    expect([adapter.revision, adapter.nodes.get(raccoon.objectId)?.position[2]]).toEqual([
      9007199254740998n,
      6,
    ]);
  }
  const gap = encodeObserverSceneMessage({
    protocolVersion: 1,
    messageId: "gap",
    sentAt: "2026-10-31T00:00:00.000Z",
    ...scope,
    projectionRevision: 9007199254741000n,
    lane: "projection",
    type: "patch",
    payload: {
      fromRevision: 9007199254740999n,
      toRevision: 9007199254741000n,
      audienceHash: "session-test-audience",
      sourceEventIds: [],
      operations: [],
    },
  });
  notifications.length = 0;
  first.deliver(snapshotRequired);
  first.deliver(gap);
  await vi.advanceTimersByTimeAsync(1000);
  expect(sockets.length).toBe(1);
  const recovered = first;
  expect(recovered.messages.at(-1)).toEqual(resumeMessage(advanced.revision));
  expect(first.messages.length).toBe(4);
  first.deliver(
    gap
      .replace('"messageId":"gap"', '"messageId":"partial"')
      .replaceAll("9007199254740999", "9007199254740997")
      .replaceAll("9007199254741000", "9007199254740998"),
  );
  first.deliver(
    gap
      .replace('"messageId":"gap"', '"messageId":"predecessor"')
      .replaceAll("9007199254740999", "9007199254740998")
      .replaceAll("9007199254741000", "9007199254740999"),
  );
  expect(notifications.join(",")).toBe(
    "degraded|9007199254740997|9007199254740997,degraded|9007199254740997|9007199254740997,degraded|9007199254740997|9007199254740997,degraded|9007199254740998|9007199254740998,ready|9007199254741000|9007199254741000",
  );
  // Partial repair acknowledges its committed endpoint; the outstanding backfill covers the rest.
  expect(JSON.stringify(first.messages.slice(4))).toBe(
    '[{"protocolVersion":1,"type":"ack","revision":"9007199254740998","connectionVersion":2}]',
  );
  first.deliver(gap);
  expect(first.messages.at(-1)).toEqual(ackMessage("9007199254741000", 2));
  // A server that lost its delivery ledger refuses the ack; only a fresh connection resumes.
  recovered.receive(advanced);
  const ignored = [9007199254740997n, 9007199254741000n].map((toRevision) =>
    encodeObserverSceneMessage({
      ...patch,
      ...scope,
      projectionRevision: toRevision,
      payload: {
        ...patch.payload,
        fromRevision: toRevision - 1n,
        toRevision,
        audienceHash: "session-test-audience",
        operations: [],
      },
    }),
  );
  notifications.length = 0;
  first.deliver(snapshotRequired);
  first.receive(advanced);
  for (const message of ignored) first.deliver(message);
  expect([...new Set(notifications)]).toEqual(["degraded|9007199254741000|9007199254741000"]);
  first.receive({ ...advanced, revision: "9007199254741000" });
  expect(notifications.at(-1)).toBe("ready|9007199254741000|9007199254741000");
  const retired = {
    open: first.socket.onopen,
    message: first.socket.onmessage,
    close: first.socket.onclose,
    error: first.socket.onerror,
  };
  notifications.length = 0;
  recovered.deliver(
    JSON.stringify({ protocolVersion: 1, type: "recovery", reason: "revision_unavailable" }),
  );
  await vi.advanceTimersByTimeAsync(1000);
  sockets[1]?.socket.onopen?.();
  expect(sockets[1]?.messages).toEqual([resumeMessage("9007199254741000")]);
  // Pressure is retryable; with nothing applied since, the jittered delay doubles to (1 s, 2 s].
  sockets[1]?.deliver(
    JSON.stringify({ protocolVersion: 1, type: "recovery", reason: "backpressure" }),
  );
  await vi.advanceTimersByTimeAsync(1000);
  expect(sockets.length).toBe(2);
  await vi.advanceTimersByTimeAsync(1000);
  expect(sockets.length).toBe(3);
  const resumed = sockets[2];
  if (!resumed) throw new Error("scene socket not opened");
  resumed.socket.onopen?.();
  resumed.deliver(snapshotRequired);
  expect(resumed.messages).toEqual([resumeMessage("9007199254741000")]);
  expect(notifications.filter((value, index) => value !== notifications[index - 1]).join(",")).toBe(
    "degraded|9007199254741000|9007199254741000,connecting|undefined|undefined,degraded|9007199254741000|9007199254741000,connecting|undefined|undefined",
  );
  notifications.length = 0;
  for (const ready of [false, true]) {
    if (ready) resumed.receive({ ...advanced, revision: "9007199254741000" });
    retired.open?.();
    retired.message?.({ data: snapshotRequired });
    retired.message?.({
      data: JSON.stringify({ protocolVersion: 1, type: "disconnect", reason: "unauthorized" }),
    });
    retired.close?.();
    retired.error?.();
    expect(notifications).toEqual(ready ? ["ready|9007199254741000|9007199254741000"] : []);
    expect(resumed.messages).toEqual(
      ready
        ? [resumeMessage("9007199254741000"), ackMessage("9007199254741000", 1)]
        : [resumeMessage("9007199254741000")],
    );
    if (!ready) {
      resumed.receive(advanced);
      for (const message of ignored) resumed.deliver(message);
      expect([...new Set(notifications)]).toEqual(["connecting|undefined|undefined"]);
      notifications.length = 0;
    }
  }
  notifications.length = 0;
  resumed.socket.onclose?.();
  await vi.advanceTimersByTimeAsync(1000);
  const rejoined = await fixture.deliver({ ...advanced, revision: "9007199254741000" });
  expect(rejoined.messages).toEqual([
    resumeMessage("9007199254741000"),
    ackMessage("9007199254741000", 1),
  ]);
  expect(notifications.filter((value, index) => value !== notifications[index - 1]).join(",")).toBe(
    "degraded|9007199254741000|9007199254741000,connecting|undefined|undefined,ready|9007199254741000|9007199254741000",
  );
  // An unanswered request escalates after its 30 s lifetime: backfill, snapshot, then reconnect.
  notifications.length = 0;
  rejoined.deliver(
    gap
      .replace('"messageId":"gap"', '"messageId":"stalled"')
      .replaceAll("9007199254741000", "9007199254741002")
      .replaceAll("9007199254740999", "9007199254741001"),
  );
  await vi.advanceTimersByTimeAsync(1000);
  await vi.advanceTimersByTimeAsync(30000);
  await vi.advanceTimersByTimeAsync(30000);
  expect(rejoined.messages.slice(2)).toEqual([
    resumeMessage("9007199254741000"),
    resumeMessage(null),
  ]);
  await vi.advanceTimersByTimeAsync(1000);
  const escalated = await fixture.deliver({ ...advanced, revision: "9007199254741002" });
  expect(escalated.messages).toEqual([resumeMessage(null), ackMessage("9007199254741002", 1)]);
  // A reconnect's resume of the retained projection has the same lifetime.
  escalated.socket.onclose?.();
  await vi.advanceTimersByTimeAsync(1000);
  await vi.advanceTimersByTimeAsync(0);
  const unanswered = sockets.at(-1);
  unanswered?.socket.onopen?.();
  await vi.advanceTimersByTimeAsync(30000);
  expect([sockets.length, unanswered?.messages]).toEqual([6, [resumeMessage("9007199254741002")]]);
  // The second reconnect in a row waits (1 s, 2 s].
  await vi.advanceTimersByTimeAsync(2000);
  expect(sockets.length).toBe(7);
  expect(notifications.filter((value, index) => value !== notifications[index - 1]).join(",")).toBe(
    "degraded|9007199254741000|9007199254741000,connecting|undefined|undefined,ready|9007199254741002|9007199254741002,degraded|9007199254741002|9007199254741002,connecting|undefined|undefined,degraded|9007199254741002|9007199254741002,connecting|undefined|undefined",
  );
  unsubscribe();
  for (const [protocolVersion, type, reason] of [
    [1, "recovery", "asset_manifest_changed"],
    [1, "disconnect", "unsupported_protocol"],
  ]) {
    session.replace("replacement-session", scope);
    const refused = await fixture.deliver(advanced);
    refused.deliver(JSON.stringify({ protocolVersion, type, reason }));
    expect(session.getSnapshot().status).toBe("unavailable");
    expect(session.getSnapshot().scene).toBeUndefined();
    expect(refused.close.mock.calls.length).toBe(1);
    expect(refused.messages.length).toBe(2);
  }
  const selection = decodeEntitySelection({
    ...scope,
    entity: scene.entities[0],
    ...JSON.parse(
      '{"version":1,"privacyClass":"public_scene","evidence":{"entity":"canonical","physical":"canonical","derived":"derived","history":"canonical"},"objectId":"object-raccoon","revision":"9007199254740993","simulationTime":"9007199254740995","physical":{"needs":null,"wellbeing":null,"plant":null,"resource":null,"shelter":null,"locationId":null,"selectedAction":null,"lifecycle":null},"derived":{"canonical":false,"simulationTime":"9007199254740995","needs":null,"wellbeing":null,"plant":null},"history":{"observedRevision":"9007199254740993","beforeSequence":null,"actions":[{"eventId":"event-yard","actionId":"action-yard","commandId":"command-yard","type":"routine","partitionSequence":"1","simulationTime":"9007199254740995","recordedAt":"2026-10-31T00:00:00.000Z"}]}}',
    ),
  });
  for (const type of ["snapshot", "patch"] as const)
    for (const field of ["audienceHash", "tenantId", "worldId", "timelineId", "spaceId"] as const) {
      session.replace("observer", scope);
      const current = await fixture.deliver(scene);
      const late = Promise.withResolvers<Response>();
      transport.mockReturnValue(late.promise);
      useYardView.getState().select(selection.objectId);
      session.select(selection.objectId);
      const selectionKey = session.getSelectionKey();
      session.queries.setQueryData(selectionKey, selection);
      session.explain(decodeOpaqueId("command-yard", "CommandId"));
      expect([session.getSelectionSnapshot().status, session.getWhySnapshot().status]).toEqual([
        "ready",
        "loading",
      ]);
      const whyKey = session.getWhyKey();
      const message =
        type === "snapshot"
          ? current.receive(scene)
          : encodeObserverSceneMessage({
              ...patch,
              ...scope,
              payload: { ...patch.payload, audienceHash: "session-test-audience" },
            });
      // Replace the same semantic identity everywhere in the wire fixture, including snapshot scope.
      const previous = field === "audienceHash" ? "session-test-audience" : scope[field];
      current.deliver(message.replaceAll(`"${field}":"${previous}"`, `"${field}":"other"`));
      if (field === "audienceHash") expect(current.messages.at(-1)).toEqual(resumeMessage(null));
      expect(
        `${session.getSnapshot().status}|${session.getSnapshot().scene}|${session.getSnapshot().projection}|${session.getSelectionSnapshot().status}|${session.getWhySnapshot().status}|${useYardView.getState().selected}`,
      ).toBe(
        `${field === "audienceHash" ? "degraded" : "unavailable"}|undefined|undefined|none|none|undefined`,
      );
      expect(
        `${session.queries.getQueryState(selectionKey)}|${session.queries.getQueryState(whyKey)}`,
      ).toBe("undefined|undefined");
      late.resolve(new Response(null, { status: 403 }));
      await vi.advanceTimersByTimeAsync(0);
      expect(session.getSnapshot().status).toBe(
        field === "audienceHash" ? "degraded" : "unavailable",
      );
    }
  session.replace(undefined, undefined);
  stopEmphasis();
  stop();
  adapter.destroy();
  expect([adapter.scene, adapter.emphasized]).toEqual([
    undefined,
    { selected: undefined, focused: undefined },
  ]);
  adapter.pick(decodeOpaqueId("object-raccoon", "ObjectId"));
  expect(useYardView.getState().selected).toBeUndefined();
  session.replace(undefined, undefined);
});
