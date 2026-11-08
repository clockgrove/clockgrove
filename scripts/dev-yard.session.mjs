// The session of `pnpm dev:yard` (issue 1002, launched by scripts/dev-yard.mjs). It reuses the
// browser-journey harness (apps/runtime/test/world-owner/native-harness.ts): a disposable
// PostgreSQL, the explicitly selected pack provisioned, the native runtime in workerd, and
// the web app on Vite proxying /v1 to it. It prints the world URL and the observer credential, and
// stops when the launcher writes its stop file or after SESSION_MS; the harness then removes the
// database and runtime storage.
import { existsSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import { truthOf } from "../apps/runtime/test/world-fixture.ts";
import {
  isNativeWorldOwnerChild,
  runNativeWorldOwnerProcess,
  withNativeWorldOwner,
} from "../apps/runtime/test/world-owner/native-harness.ts";
import { createServer } from "../apps/web/node_modules/vite/dist/node/index.js";
import { worldRoutePath } from "../apps/web/src/world-route.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const pack = process.env.CLOCKGROVE_DEV_WORLD_PACK ?? "raccoons";
const CONFIG = "scripts/dev-yard.vitest.config.ts";
/**
 * One session's bound (issue 1002 decision: 4 h covers a pilot session; restart for more), overridden by
 * CLOCKGROVE_DEV_YARD_HOURS, which scripts/dev-yard.mjs validates.
 */
const SESSION_MS = Number(process.env.CLOCKGROVE_DEV_YARD_HOURS ?? 4) * 60 * 60_000;
const CREDENTIAL = "yard-observer";
/** Names the file whose existence asks the session to stop; scripts/dev-yard.mjs sets it. */
const STOP_VARIABLE = "CLOCKGROVE_DEV_YARD_STOP";

/** Resolves when the launcher asks to stop (checked every 500 ms) or the session bound passes. */
async function stopped() {
  const stopFile = process.env[STOP_VARIABLE];
  for (const deadline = Date.now() + SESSION_MS; Date.now() < deadline; await delay(500))
    if (stopFile !== undefined && existsSync(stopFile)) return;
}

it("serves the living yard", async () => {
  if (!isNativeWorldOwnerChild()) {
    await runNativeWorldOwnerProcess("scripts/dev-yard.session.mjs", pack, {
      vitestConfig: CONFIG,
      timeoutMs: SESSION_MS + 60_000,
      inheritOutput: true,
      // The issue 800 journey's observer: observation only, signed in with one local credential.
      prepare: (fixture) =>
        truthOf(fixture)(
          `UPDATE clockgrove.world_memberships SET grants=ARRAY['runtime:world-observe'] WHERE principal_id='principal-runtime';
          UPDATE clockgrove_auth.session SET token='${CREDENTIAL}', "expiresAt"=now() + interval '${Math.ceil(SESSION_MS / 60_000)} minutes' WHERE token='local-reader-session'`,
        ),
    });
    return;
  }
  await withNativeWorldOwner(async (native) => {
    process.env.CLOCKGROVE_WORLD_SHELL ??= path.resolve(root, "worlds", pack, "shell.json");
    const server = await createServer({
      root: path.join(root, "apps/web"),
      configFile: path.join(root, "apps/web/vite.config.ts"),
      server: {
        host: "127.0.0.1",
        port: 5173,
        proxy: { "/v1": { target: await native.origin(), ws: true } },
      },
    });
    try {
      await server.listen();
      const { port } = server.httpServer.address();
      process.stdout.write(
        `\nLiving world: ${native.world.artifact.packId}@${native.world.artifact.version} (${native.scope.worldId} / ${native.scope.spaceId})\n` +
          `  Open:    http://127.0.0.1:${port}${worldRoutePath(native.scope)}\n` +
          `  Sign in: local session credential "${CREDENTIAL}" (observation only)\n` +
          `  Stop:    Ctrl-C; the database and runtime storage are temporary and removed on exit.\n\n`,
      );
      await stopped();
    } finally {
      await server.close();
    }
  });
});
