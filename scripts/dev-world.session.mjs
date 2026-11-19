// The session of `pnpm dev:world` (issue 1002, launched by scripts/dev-world.mjs) and of
// `pnpm playground` (issue 327, launched by scripts/playground.mjs through it). It reuses the
// browser-journey harness (apps/runtime/test/world-owner/native-harness.ts): a disposable
// PostgreSQL, the explicitly selected pack provisioned, the native runtime in workerd, and
// the web app on Vite proxying /v1 to it. It prints the world URL and the credential (the observer's,
// or the world owner's for the playground), and
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
const pack = process.env.CLOCKGROVE_DEV_WORLD_PACK ?? "fixture/reference";
const CONFIG = "scripts/dev-world.vitest.config.ts";
/**
 * One session's bound (issue 1002 decision: 4 h covers a pilot session; restart for more), overridden by
 * CLOCKGROVE_DEV_WORLD_HOURS, which scripts/dev-world.mjs validates.
 */
const SESSION_MS = Number(process.env.CLOCKGROVE_DEV_WORLD_HOURS ?? 4) * 60 * 60_000;
/**
 * The playground signs in as the world's owner (issue 327): the existing observation, inspection,
 * command, clock and operator grants, with the public-scene and operator-evidence privacy categories
 * the harness already gives its member, and no private cognition. `pnpm dev:world` keeps its observer.
 */
const OWNER = process.env.CLOCKGROVE_DEV_WORLD_ROLE === "owner";
const CREDENTIAL = OWNER ? "playground-owner" : "hall-observer";
const GRANTS = OWNER
  ? [
      "runtime:world-observe",
      "runtime:world-inspect",
      "runtime:world-command",
      "runtime:world-clock",
      "runtime:world-operate",
    ]
  : ["runtime:world-observe"];
/** Names the file whose existence asks the session to stop; scripts/dev-world.mjs sets it. */
const STOP_VARIABLE = "CLOCKGROVE_DEV_WORLD_STOP";

/** Resolves when the launcher asks to stop (checked every 500 ms) or the session bound passes. */
async function stopped() {
  const stopFile = process.env[STOP_VARIABLE];
  for (const deadline = Date.now() + SESSION_MS; Date.now() < deadline; await delay(500))
    if (stopFile !== undefined && existsSync(stopFile)) return;
}

it("serves the living hall", async () => {
  if (!isNativeWorldOwnerChild()) {
    await runNativeWorldOwnerProcess("scripts/dev-world.session.mjs", pack, {
      vitestConfig: CONFIG,
      timeoutMs: SESSION_MS + 60_000,
      inheritOutput: true,
      // The issue 800 journey's observer (observation only) or the playground's owner, signed in
      // with one local credential.
      prepare: (fixture) =>
        truthOf(fixture)(
          `UPDATE clockgrove.world_memberships SET grants=ARRAY[${GRANTS.map((grant) => `'${grant}'`).join(",")}] WHERE principal_id='principal-runtime';
          UPDATE clockgrove_auth.session SET token='${CREDENTIAL}', "expiresAt"=now() + interval '${Math.ceil(SESSION_MS / 60_000)} minutes' WHERE token='local-reader-session'`,
        ),
    });
    return;
  }
  await withNativeWorldOwner(async (native) => {
    // A pack without a shell.json of its own is shown in the neutral shell.
    const packShell = path.resolve(root, "worlds", pack, "shell.json");
    if (existsSync(packShell)) process.env.CLOCKGROVE_WORLD_SHELL ??= packShell;
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
        `\n${OWNER ? "Playground" : "Living world"}: ${native.world.artifact.packId}@${native.world.artifact.version} (${native.scope.worldId} / ${native.scope.spaceId})\n` +
          `  Open:    http://127.0.0.1:${port}${worldRoutePath(native.scope)}\n` +
          `  Sign in: local session credential "${CREDENTIAL}" (${OWNER ? "the world's owner" : "observation only"})\n` +
          `  Stop:    Ctrl-C; the database and runtime storage are temporary and removed on exit.\n\n`,
      );
      await stopped();
    } finally {
      await server.close();
    }
  });
});
