import { type BrowserScope, SCENE_CREDENTIAL_PREFIX, SCENE_PROTOCOL } from "@clockgrove/contracts";
import type { ProjectionSocket } from "./projection.js";
/** Browser transport adapter; protocol client and fakes remain renderer/environment neutral. */
export function browserProjectionSocket(url: URL, protocols?: string[]): ProjectionSocket {
  const socket = new WebSocket(url, protocols);
  const closed = new Promise<void>((resolve) =>
    socket.addEventListener("close", () => resolve(), { once: true }),
  );
  const adapter: ProjectionSocket = {
    closed,
    get protocol() {
      return socket.protocol;
    },
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send: (data) => socket.send(data),
    close: () => socket.close(),
  };
  socket.addEventListener("open", () => adapter.onopen?.());
  socket.addEventListener("message", (event) => {
    if (typeof event.data === "string") adapter.onmessage?.({ data: event.data });
    else adapter.onerror?.();
  });
  socket.addEventListener("close", () => adapter.onclose?.());
  socket.addEventListener("error", () => adapter.onerror?.());
  return adapter;
}

export type SceneSocketFactory = (scope: BrowserScope, credential: string) => ProjectionSocket;

export function browserSceneSocket(
  scope: BrowserScope,
  credential: string,
  origin: string,
): ProjectionSocket {
  const url = new URL("/v1/projection", origin.replace(/^http/u, "ws"));
  for (const key of ["tenantId", "worldId", "timelineId", "spaceId"] as const)
    url.searchParams.set(key, scope[key]);
  return browserProjectionSocket(url, [SCENE_PROTOCOL, `${SCENE_CREDENTIAL_PREFIX}${credential}`]);
}
