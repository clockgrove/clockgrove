import * as scene from "@clockgrove/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { SceneProjectionClient } from "../src/projection.js";
import { emptyScene, sceneStatusText } from "../src/scene-projection.js";
import { later, scope, snapshot } from "./convergence-fixture.js";
import { sceneSocket } from "./scene-socket-fixture.js";

afterEach(() => vi.useRealTimers());

it("commits before notification and fences retired transport work", async () => {
  vi.useFakeTimers();
  const wire = sceneSocket();
  const successor = sceneSocket();
  const closed = Promise.withResolvers<void>();
  const retiring = { ...wire.socket, closed: closed.promise };
  const open = vi.fn().mockReturnValueOnce(retiring).mockReturnValue(successor.socket);
  let reconnected: Promise<void> | undefined;
  const client = new SceneProjectionClient(scope, open, (_status, _scene, projection) => {
    if (projection?.revision === 9007199254741100n && !reconnected) reconnected = client.connect();
  });
  await client.connect();
  retiring.onopen?.();
  const obsoleteMessage = retiring.onmessage;
  const obsoleteFailure = retiring.onerror;
  const patchWire = scene.encodeObserverSceneMessage(
    scene.decodeObserverSceneMessage(later(1008n)),
  );
  const decode = vi.spyOn(scene, "decodeObserverSceneMessage");
  obsoleteMessage?.({ data: scene.encodeObserverSceneMessage(snapshot) });
  expect(decode.mock.calls.length).toBe(1);
  obsoleteMessage?.({
    data: scene.encodeObserverSceneMessage({
      ...snapshot,
      payload: { ...snapshot.payload, revision: 9007199254741100n },
      projectionRevision: 9007199254741100n,
    }),
  });
  // A new transport's resume reads the already committed endpoint.
  await vi.advanceTimersByTimeAsync(32000);
  expect(open.mock.calls.length).toBe(1);
  closed.resolve();
  await reconnected;
  successor.socket.onopen?.();
  expect(JSON.stringify(successor.messages.at(-1))).toBe(
    '{"protocolVersion":1,"type":"resume","lastAppliedRevision":"9007199254741100","assetManifestVersion":1}',
  );
  obsoleteFailure?.();
  obsoleteMessage?.({ data: "invalid" });
  expect(open.mock.calls.length).toBe(2);
  expect(successor.close.mock.calls.length).toBe(0);
  successor.deliver(patchWire);
  expect(decode.mock.calls.length).toBe(3);
  decode.mockRestore();
  await client.disconnect();
  await vi.advanceTimersByTimeAsync(32000);
  expect(open.mock.calls.length).toBe(2);
  const losses: ReturnType<typeof sceneSocket>[] = [];
  const lossStatuses: string[] = [];
  const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
  const bounded = new SceneProjectionClient(
    scope,
    () => {
      const socket = sceneSocket();
      losses.push(socket);
      return socket.socket;
    },
    (status) => lossStatuses.push(status),
  );
  await bounded.connect();
  for (const [index, delay] of [750, 1500, 3000, 6000, 12000].entries()) {
    losses[index]?.socket.onerror?.();
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(losses.length).toBe(index + 1);
    await vi.advanceTimersByTimeAsync(1);
    expect(losses.length).toBe(index + 2);
  }
  losses[5]?.socket.onclose?.();
  expect(lossStatuses.join(",")).toBe(
    "connecting,recovering,connecting,recovering,connecting,recovering,connecting,recovering,connecting,recovering,connecting,unavailable",
  );
  await vi.advanceTimersByTimeAsync(32000);
  expect(losses.length).toBe(6);
  random.mockRestore();
  await bounded.disconnect();
  expect(sceneStatusText({ ...emptyScene, status: "Authorization lost" })).toBe(
    "unavailable. Authorization lost",
  );
});
