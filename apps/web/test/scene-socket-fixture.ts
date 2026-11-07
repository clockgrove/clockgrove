import * as contracts from "@clockgrove/contracts";
import { vi } from "vitest";
import type { ProjectionSocket } from "../src/projection.js";
import { YardSession } from "../src/yard-api.js";

export function sceneSocket() {
  const messages: unknown[] = [];
  const close = vi.fn(() => socket.onclose?.());
  const socket: ProjectionSocket = {
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send: (message) => {
      messages.push(JSON.parse(message));
    },
    close,
  };
  const deliver = (message: string) => {
    socket.onmessage?.({ data: message });
    return message;
  };
  return {
    socket,
    messages,
    close,
    deliver,
    deny: () =>
      deliver(JSON.stringify({ protocolVersion: 1, type: "disconnect", reason: "unauthorized" })),
    receive: (
      scene: contracts.LivingScene,
      presentationBindings: contracts.SceneProjection["presentationBindings"] = [],
    ) => {
      const { version: _version, ...fields } = scene;
      return deliver(
        contracts.encodeObserverSceneMessage({
          protocolVersion: contracts.SCENE_PROTOCOL_VERSION,
          messageId: `snapshot-${scene.revision}`,
          sentAt: "2026-10-31T00:00:00.000Z",
          tenantId: scene.tenantId,
          worldId: scene.worldId,
          timelineId: scene.timelineId,
          spaceId: scene.spaceId,
          projectionRevision: BigInt(scene.revision),
          lane: "projection",
          type: "snapshot",
          payload: {
            ...fields,
            revision: BigInt(scene.revision),
            simulationTime: BigInt(scene.simulationTime),
            compatibility: {
              projectionVersion: contracts.SCENE_PROJECTION_VERSION,
              assetManifestVersion: contracts.SCENE_ASSET_MANIFEST_VERSION,
              clientVersion: contracts.SCENE_CLIENT_VERSION,
            },
            hierarchy: [{ spaceId: scene.spaceId, label: scene.spaceId }],
            presentationBindings,
            interactions: [],
            feedCursor: scene.revision,
            audienceHash: "session-test-audience",
          },
        }),
      );
    },
  };
}

export function sceneSession(onClear = () => {}) {
  const sockets: ReturnType<typeof sceneSocket>[] = [];
  const session = new YardSession("http://local.test", onClear, () => {
    const fixture = sceneSocket();
    sockets.push(fixture);
    return fixture.socket;
  });
  return {
    session,
    sockets,
    async deliver(
      scene: contracts.LivingScene,
      bindings: contracts.SceneProjection["presentationBindings"] = [],
    ) {
      await vi.advanceTimersByTimeAsync(0);
      const current = sockets.at(-1);
      if (!current) throw new Error("scene socket not opened");
      current.socket.onopen?.();
      current.receive(scene, bindings);
      await vi.advanceTimersByTimeAsync(0);
      return current;
    },
  };
}

export function selectionOf(value?: contracts.EntitySelection) {
  return { objectId: value?.objectId, status: value ? "ready" : "none", value };
}
