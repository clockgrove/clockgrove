import assert from "node:assert/strict";
import net from "node:net";

// Called only by the active disposable fixture's closure, never from discovered connection data.
export async function withOwnedPostgresWireBridge(socketPath, operation, maxConnections = 16) {
  assert(socketPath.startsWith("\0clockgrove-"), "owned abstract fixture socket required");
  const sockets = new Set();
  const server = net.createServer((incoming) => {
    const upstream = net.createConnection(socketPath);
    for (const socket of [incoming, upstream]) {
      sockets.add(socket);
      // Longer than one kernel call may hold a transaction idle (WORLD_COMMAND_TIMEOUTS, 30 s), so
      // the bridge never ends a session PostgreSQL would keep.
      socket.setTimeout(35_000, () => socket.destroy());
      socket.on("error", () => {
        incoming.destroy();
        upstream.destroy();
      });
      socket.on("close", () => {
        sockets.delete(socket);
        incoming.destroy();
        upstream.destroy();
      });
    }
    // No protocol interpretation, SQL, synthetic replies or credential substitution.
    incoming.pipe(upstream);
    upstream.pipe(incoming);
  });
  server.maxConnections = maxConnections;
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port: 0 }, resolve);
    });
    const address = server.address();
    assert(address && typeof address !== "string", "owned loopback endpoint missing");
    return await operation(address.port);
  } finally {
    for (const socket of sockets) socket.destroy();
    if (server.listening)
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
  }
}
