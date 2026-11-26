import {
  decodeBrowserScope,
  decodeEntitySelection,
  decodeFlashbackMarks,
  decodeLivingScene,
  decodeRecordedWhy,
  type ObjectId,
} from "@clockgrove/contracts";
import { QueryObserver } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { WorldClockHud } from "../src/hud.js";
import type { SceneSession } from "../src/scene-api.js";
import { useSceneStateProjection, WORLD_STATUS_REFRESH_MS } from "../src/scene-queries.js";
import { useSceneView, useWhyView } from "../src/scene-state.js";
import { TextSceneSurfaces } from "../src/text-scene.js";
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

it("sends the selected entity's marks read once, over the selection's idle query, and shows its moments", async () => {
  const { session } = await observing();
  await reply(first, () => session.select(first.objectId));
  const key = session.getMarksKey();
  expect(session.queries.getQueryState(key)).toMatchObject({
    status: "pending",
    fetchStatus: "idle",
  });
  const marks = decodeFlashbackMarks(
    JSON.parse(
      '{"tenantId":"tenant-q","worldId":"world-q","timelineId":"timeline-q","spaceId":"space-q","version":1,"privacyClass":"public_scene","target":{"objectId":"a"},"bounds":{"moments":16,"scanEvents":4000},"status":"read","scanned":{"from":"1","to":"9"},"reachesStart":true,"zones":[{"zoneId":"bark","host":{"kind":"object","objectId":"a"},"marks":1,"moments":[{"eventId":"e","commandId":"c","partitionSequence":"9","simulationTime":"20","kind":"interacted","actorId":"b","interactionId":"scratch","leftMark":true}],"more":0}]}',
    ),
  );
  const pending = beginReply(() => session.loadMarks(key));
  session.loadMarks(key);
  await pending(marks);
  const calls = vi.mocked(fetch).mock.calls;
  expect(calls.map(([url]) => String(url).replace(/^.*(?=\/v1\/)/, ""))).toEqual([
    "/v1/runtime/entity",
    "/v1/runtime/flashback/marks",
  ]);
  expect(JSON.parse(calls[1]?.[1]?.body?.toString() ?? "null")).toEqual({
    version: 1,
    ...scope,
    objectId: "a",
  });
  expect(session.getMarksSnapshot()).toEqual({ status: "ready", value: marks });
  session.loadMarks(key);
  expect(calls).toHaveLength(2);
  session.replace(undefined, undefined);
});

it("opens a region-hosted zone's moments by zoneId from the text path, and closes them on sign-out", async () => {
  const { session } = await observing();
  const marks = decodeFlashbackMarks(
    JSON.parse(
      '{"tenantId":"tenant-q","worldId":"world-q","timelineId":"timeline-q","spaceId":"space-q","version":1,"privacyClass":"public_scene","target":{"zoneId":"porch-boards"},"bounds":{"moments":16,"scanEvents":4000},"status":"read","scanned":{"from":"1","to":"9"},"reachesStart":true,"zones":[{"zoneId":"porch-boards","host":{"kind":"region","regionId":"porch"},"marks":1,"moments":[{"eventId":"e","commandId":"c","partitionSequence":"9","simulationTime":"20","kind":"worn","actorId":"b","interactionId":"track","leftMark":true}],"more":0}]}',
    ),
  );
  // The text path's Surfaces list: a region-hosted zone's sentence with its moments button.
  const text = () =>
    renderToStaticMarkup(
      createElement(TextSceneSurfaces, {
        session,
        surfaces: {
          decals: { low: 0, medium: 0, high: 0 },
          zones: [{ zoneId: "porch-boards", sentence: "The porch is muddy." }],
        } as never,
      }),
    );
  expect(text()).toContain("The porch is muddy.");
  expect(text()).toContain('aria-pressed="false">Why: moments of porch-boards</button>');
  const pending = beginReply(() => session.openZoneMarks("porch-boards"));
  expect(session.getZoneMarksSnapshot().status).toBe("loading");
  await pending(marks);
  const calls = vi.mocked(fetch).mock.calls;
  expect(String(calls[0]?.[0])).toMatch(/\/v1\/runtime\/flashback\/marks$/);
  expect(JSON.parse(calls[0]?.[1]?.body?.toString() ?? "null")).toEqual({
    version: 1,
    ...scope,
    zoneId: "porch-boards",
  });
  expect(session.getZoneMarksSnapshot()).toEqual({ status: "ready", value: marks });
  expect(text()).toContain('aria-pressed="true">Why: moments of porch-boards</button>');
  expect(text()).toContain("worn by traffic; b; interaction track");
  expect(text()).toContain("Flashback moment 9");
  session.replace(undefined, undefined);
  expect(session.getZoneMarksSnapshot().status).toBe("none");
  expect(
    session.queries.getQueryCache().findAll({ queryKey: ["living-scene", "zone-marks"] }),
  ).toEqual([]);
});

it("shows a world mode set without a revision: the status is read again on an interval and after a world_mode_refused answer", async () => {
  const { session } = await observing();
  const status = (mode?: unknown) => ({
    ...scope,
    version: 1,
    privacyClass: "public_scene",
    revision: "10",
    clock: {
      simulationTime: "20",
      runState: "running",
      speed: 1,
      dayLengthMs: null,
      day: null,
      timeOfDayMs: null,
    },
    feed: [],
    ...(mode === undefined ? {} : { mode }),
  });
  const reads = () =>
    vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("/v1/runtime/world-status"))
      .length;
  const hud = () =>
    renderToStaticMarkup(
      createElement(WorldClockHud, { status: observer.getCurrentResult().data, scene }),
    );
  // The status query as the HUD holds it, at one revision throughout: a mode commits nothing.
  const observer = new QueryObserver(session.queries, {
    queryKey: ["living-scene", "status", session.getIntent(), scope, "10"],
    queryFn: ({ signal }) => session.readWorldStatus(session.getIntent(), scope, signal),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const first = beginReply(() => observer.subscribe(() => undefined));
  await first(status());
  expect([reads(), hud().includes("rw-world-mode")]).toEqual([1, false]);
  // The developer pauses the world; nothing commits, and the next interval shows it.
  const second = beginReply(() => vi.advanceTimersByTime(WORLD_STATUS_REFRESH_MS));
  await second(status({ mode: "paused", reason: "subscription_lapsed" }));
  expect(reads()).toBe(2);
  expect(hud()).toContain(
    '<span class="rw-world-mode" role="status" data-world-mode="paused">Play paused: no actions and no model or tool calls (subscription lapsed)</span>',
  );
  expect(hud()).toContain('data-run-state="running">Running</span>');
  // An Influence refused for the mode (here set to `read_only`) reads the status again at once.
  const refusal = beginReply(() => {
    void session.influence("a" as ObjectId, "water");
  });
  const refetch = beginReply(() => undefined);
  await refusal(
    Response.json(
      { error: "world_mode_refused", mode: "read_only", reason: "maintenance" },
      { status: 409 },
    ),
  );
  await refetch(status({ mode: "read_only", reason: "maintenance" }));
  expect(reads()).toBe(3);
  expect(hud()).toContain(
    'data-world-mode="read_only">Read-only: the world can be watched, not acted in (maintenance)</span>',
  );
  const third = beginReply(() => vi.advanceTimersByTime(WORLD_STATUS_REFRESH_MS));
  await third(status());
  expect([reads(), hud().includes("rw-world-mode")]).toEqual([4, false]);
  observer.destroy();
});
