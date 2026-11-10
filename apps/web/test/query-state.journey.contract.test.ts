import {
  decodeBrowserScope,
  decodeEntitySelection,
  decodeLivingScene,
  decodeRecordedWhy,
} from "@clockgrove/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import type { SceneSession } from "../src/scene-api.js";
import { useSceneStateProjection } from "../src/scene-queries.js";
import { useSceneView, useWhyView } from "../src/scene-state.js";
import { sceneSession, selectionOf } from "./scene-socket-fixture.js";

const scope = decodeBrowserScope({
  tenantId: "tenant-q",
  worldId: "world-q",
  timelineId: "timeline-q",
  spaceId: "space-q",
});
const first = decodeEntitySelection(
  JSON.parse(
    '{"tenantId":"tenant-q","worldId":"world-q","timelineId":"timeline-q","spaceId":"space-q","version":1,"privacyClass":"public_scene","evidence":{"entity":"canonical","physical":"canonical","derived":"derived","history":"canonical"},"objectId":"a","revision":"10","simulationTime":"20","entity":{"objectId":"a","archetypeId":"resident","pose":{"frameId":"f","frameVersion":1,"coordinates":["1","2"]},"presentation":{"kind":"placeholder","label":"A"}},"physical":{"needs":null,"wellbeing":null,"plant":null,"resource":null,"shelter":null,"locationId":null,"selectedAction":null,"lifecycle":null},"derived":{"canonical":false,"simulationTime":"20","needs":null,"wellbeing":null,"plant":null},"history":{"observedRevision":"10","beforeSequence":"8","actions":[{"eventId":"e","actionId":"a","commandId":"c","type":"routine","partitionSequence":"9","simulationTime":"20","recordedAt":"2026-10-31T00:00:00.000Z"}]}}',
  ),
);
const second = decodeEntitySelection({
  ...first,
  objectId: "b",
  entity: { ...first.entity, objectId: "b" },
});
const scene = decodeLivingScene({
  ...scope,
  version: 1,
  privacyClass: "public_scene",
  revision: "10",
  simulationTime: "20",
  weather: { rainIntensity: 0 },
  frames: JSON.parse(
    '[{"frameId":"f","version":1,"dimensions":2,"axes":{"axes":[{"name":"x","positiveDirection":"east"},{"name":"y","positiveDirection":"north"}]},"unit":{"name":"metre","fractionalDigits":0},"origin":["0","0"],"gravity":{"kind":"constant-vector","vector":["0","-1"]}}]',
  ),
  entities: [first.entity, second.entity],
});
const why = decodeRecordedWhy(
  JSON.parse(
    '{"tenantId":"tenant-q","worldId":"world-q","timelineId":"timeline-q","spaceId":"space-q","version":1,"privacyClass":"public_scene","evidence":{"receipt":"canonical","traces":"canonical","schedules":"canonical","links":"derived"},"entry":{"kind":"command"},"commandId":"c","actionId":"a","receiptStatus":"committed","traces":{"status":"redacted","drafts":[]},"schedules":[],"links":{"parents":["parent"],"children":["child"]}}',
  ),
);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function beginReply(action: () => void) {
  const pending = Promise.withResolvers<Response>();
  vi.mocked(fetch).mockReturnValueOnce(pending.promise);
  action();
  return async (value: unknown) => {
    pending.resolve(value instanceof Response ? value : Response.json(value));
    await vi.advanceTimersByTimeAsync(0);
  };
}
const reply = (value: unknown, action: () => void) => beginReply(action)(value);
const Projection = ({ session }: { readonly session: SceneSession }) =>
  createElement("output", null, useSceneStateProjection(session).scene?.revision);
async function observing() {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn());
  const fixture = sceneSession();
  fixture.session.replace("observer", scope);
  await fixture.deliver(scene);
  return fixture;
}

it("makes committed projection and entity query state authoritative, refreshing and continuing history", async () => {
  const { session } = await observing();
  const { queries } = session;
  const committed = session.getSnapshot();
  expect(committed.scene).toEqual(scene);
  expect([Object.keys(useSceneView.getState()), Object.keys(useWhyView.getState())]).toEqual([
    ["selected", "select"],
    ["commandId", "explain"],
  ]);
  const updated = { ...committed, scene: { ...scene, revision: "11" } };
  queries.setQueryData(["living-scene", "projection"], updated);
  expect(renderToStaticMarkup(createElement(Projection, { session }))).toBe("<output>11</output>");
  queries.setQueryData(["living-scene", "projection"], committed);
  const pending = beginReply(() => session.select(first.objectId));
  expect(queries.getQueryState(session.getSelectionKey())?.status).toBe("pending");
  expect(session.getSelectionSnapshot().status).toBe("loading");
  await pending(first);
  expect(session.getSelectionSnapshot()).toEqual(selectionOf(first));
  const refreshed = decodeEntitySelection({
    ...first,
    revision: "11",
    history: { ...first.history, observedRevision: "11" },
  });
  queries.setQueryData(session.getSelectionKey(), refreshed);
  expect(session.getSelectionSnapshot()).toEqual(selectionOf(refreshed));
  await reply(first, () => session.refreshSelection());
  expect(session.getSelectionSnapshot()).toEqual(selectionOf(first));
  await reply(refreshed, () => session.earlierActions());
  expect(JSON.parse(vi.mocked(fetch).mock.calls[2]?.[1]?.body?.toString() ?? "null")).toEqual(
    JSON.parse(
      '{"version":1,"tenantId":"tenant-q","worldId":"world-q","timelineId":"timeline-q","spaceId":"space-q","objectId":"a","cursor":{"observedRevision":"10","beforeSequence":"8"}}',
    ),
  );
  expect(session.getSelectionSnapshot()).toEqual(selectionOf(refreshed));
  await reply(new Response(null, { status: 503 }), () => session.refreshSelection());
  expect(queries.getQueryState(session.getSelectionKey())).toMatchObject({
    status: "error",
    data: undefined,
    error: { status: 503 },
  });
  expect(session.getSelectionSnapshot().status).toBe("unavailable");
  const stale = beginReply(() => session.select(first.objectId));
  await reply(second, () => session.select(second.objectId));
  await stale(first);
  expect(session.getSelectionSnapshot()).toEqual(selectionOf(second));
  session.replace(undefined, undefined);
});

it("keeps Why query evidence and failures authoritative across close and history replacement", async () => {
  const { session } = await observing();
  const { queries } = session;
  await reply(first, () => session.select(first.objectId));
  const pending = beginReply(() => session.explain(why.commandId));
  expect(queries.getQueryState(session.getWhyKey())?.status).toBe("pending");
  expect(session.getWhySnapshot().status).toBe("loading");
  await pending(why);
  expect(session.getWhySnapshot()).toEqual({
    commandId: why.commandId,
    status: "ready",
    value: why,
  });
  const unavailable = decodeRecordedWhy({ ...why, traces: { status: "unavailable", drafts: [] } });
  queries.setQueryData(session.getWhyKey(), unavailable);
  expect(session.getWhySnapshot().value).toEqual(unavailable);
  const closed = beginReply(() => session.explain(why.commandId));
  session.explain(undefined);
  await closed(why);
  expect(session.getWhySnapshot().status).toBe("none");
  expect(queries.getQueryCache().findAll({ queryKey: ["living-scene", "why"] })).toEqual([]);
  const obsolete = beginReply(() => session.explain(why.commandId));
  await reply(first, () => session.earlierActions());
  await reply(new Response(null, { status: 429 }), () => session.explain(why.commandId));
  await obsolete(new Response(null, { status: 401 }));
  expect(session.getWhySnapshot().status).toBe("refused");
  expect(queries.getQueryState(session.getWhyKey())).toMatchObject({
    status: "error",
    data: undefined,
    error: { status: 429 },
  });
  expect(session.getSnapshot().scene).toEqual(scene);
  await reply(new Response(null, { status: 503 }), () => session.explain(why.commandId));
  expect(session.getWhySnapshot().status).toBe("unavailable");
  session.replace(undefined, undefined);
});

it("retires scope and credential lifetimes, refusal and sign-out without late interference", async () => {
  const fixture = await observing();
  const { session } = fixture;
  const { queries } = session;
  const keys = () =>
    queries
      .getQueryCache()
      .getAll()
      .map((q) => q.queryKey);
  const view = () => [
    session.getSnapshot().scene,
    session.getSelectionSnapshot().status,
    session.getWhySnapshot().status,
  ];
  for (const [status, nextScene] of [
    [401, scene],
    [403, decodeLivingScene({ ...scene, spaceId: "other" })],
  ] as const) {
    session.replace("observer", scope);
    const current = await fixture.deliver(scene);
    await reply(first, () => session.select(first.objectId));
    await reply(why, () => session.explain(why.commandId));
    const { tenantId, worldId, timelineId, spaceId } = nextScene;
    const late = Promise.withResolvers<Response>();
    vi.mocked(fetch).mockReturnValueOnce(late.promise);
    if (status === 401) session.select(first.objectId);
    else session.explain(why.commandId);
    const closed = Promise.withResolvers<void>();
    Object.defineProperty(current.socket, "closed", { value: closed.promise });
    const oldClose = current.socket.onclose;
    session.replace("intermediate", scope);
    session.replace("replacement", { tenantId, worldId, timelineId, spaceId });
    expect(view()).toEqual([undefined, "none", "none"]);
    closed.reject(new Error("retired socket close failed"));
    oldClose?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(session.getSnapshot().status).toBe("connecting");
    await fixture.deliver(nextScene);
    const next = decodeEntitySelection({ ...second, spaceId });
    await reply(next, () => session.select(second.objectId));
    late.resolve(status === 401 ? Response.json(first) : new Response(null, { status: 403 }));
    current.deny();
    await vi.advanceTimersByTimeAsync(0);
    expect([session.getSnapshot().scene, session.getSelectionSnapshot()]).toEqual([
      nextScene,
      selectionOf(next),
    ]);
    await reply({ ...first, spaceId }, () => session.select(first.objectId));
    await reply({ ...why, spaceId }, () => session.explain(why.commandId));
    await reply(new Response(null, { status }), () =>
      status === 401 ? session.refreshSelection() : session.explain(why.commandId),
    );
    expect([session.getSnapshot().status, ...view()]).toEqual([
      "Authorization lost",
      undefined,
      "none",
      "none",
    ]);
    expect(keys()).toEqual([["living-scene", "projection"]]);
  }
  session.replace("observer", scope);
  await fixture.deliver(scene);
  const late = beginReply(() => session.select(first.objectId));
  session.replace(undefined, undefined);
  await late(first);
  expect(view()).toEqual([undefined, "none", "none"]);
  expect(keys()).toEqual([["living-scene", "projection"]]);
});
