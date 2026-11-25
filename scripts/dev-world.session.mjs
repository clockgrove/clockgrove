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
 * command, clock and operator grants, and a privacy ceiling of the public-scene, operator-evidence and
 * conversation categories on its membership, never private cognition. `pnpm dev:world` keeps its observer.
 * With command and operate, `conversation` admits what the existing rules give any such member: Talk,
 * actor activations, operator effect approval and retry, delivery consent, and conversation reassembly
 * in the cognition inspector. The world is local and disposable and the owner is its only member.
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
      "runtime:world-repair",
    ]
  : ["runtime:world-observe"];
const OWNER_CEILING =
  '{"version":1,"allowedCategories":["public_scene","operator_evidence","conversation"]}';
/** The playground host's control server (issue 327); set only for `pnpm playground`. */
const PLAYGROUND_HOST = process.env.CLOCKGROVE_PLAYGROUND_HOST;
const PLAYGROUND_BODY_LIMIT = 64 * 1024;
/**
 * How long a credential the runtime accepted stays accepted here. The runtime-state inspection that
 * authorizes it is rate-limited to 300 per principal per trailing hour and audited
 * (db/migrations/0028_inspector_rate_limit_routed_space.sql, `inspector_access_admitted`); one check a
 * minute spends at most 60 of those, however often the panel polls.
 */
const PLAYGROUND_AUTHORIZED_MS = 60_000;
/** Names the file whose existence asks the session to stop; scripts/dev-world.mjs sets it. */
const STOP_VARIABLE = "CLOCKGROVE_DEV_WORLD_STOP";

/** Reads a request body, or null past the limit. */
async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > PLAYGROUND_BODY_LIMIT) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const reply = (response, status, body) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

/**
 * The browser's door to the playground host (issue 327): a request is forwarded only when the runtime
 * accepts the caller's credential for this world, so the host never sees an unauthorized caller.
 */
function playgroundHandler(native) {
  /** Credential -> time its acceptance lapses; only accepted credentials are kept. */
  const accepted = new Map();
  /** The runtime's answer for this credential: 200 accepts, 429 is passed on, all else refuses. */
  const authorize = async (authorization) => {
    const now = Date.now();
    if ((accepted.get(authorization) ?? 0) > now) return 200;
    accepted.delete(authorization);
    const { tenantId, worldId, timelineId, spaceId } = native.scope;
    const authorized = await fetch(`${await native.origin()}/v1/runtime/runtime-state`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, tenantId, worldId, timelineId, spaceId }),
    });
    await authorized.body?.cancel();
    if (authorized.status === 200) accepted.set(authorization, now + PLAYGROUND_AUTHORIZED_MS);
    return authorized.status;
  };
  return async (request, response) => {
    if (request.method !== "POST") return reply(response, 405, { error: "method_not_allowed" });
    const body = await readBody(request);
    if (body === null) return reply(response, 413, { error: "too_large" });
    const authorization = request.headers.authorization;
    const refused = () => reply(response, 403, { error: "playground_refused" });
    if (authorization === undefined) return refused();
    try {
      const status = await authorize(authorization);
      if (status === 429)
        return reply(response, 429, {
          error: "playground_rate_limited",
          message: "The runtime's inspection limit for this credential is spent; try again later.",
        });
      if (status !== 200) return refused();
    } catch {
      return refused();
    }
    try {
      const forwarded = await fetch(`${PLAYGROUND_HOST}${request.url}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-playground-secret": process.env.CLOCKGROVE_PLAYGROUND_SECRET ?? "",
          "x-playground-world": process.env.CLOCKGROVE_PLAYGROUND_WORLD ?? "",
        },
        body,
      });
      response.writeHead(forwarded.status, { "content-type": "application/json" });
      response.end(Buffer.from(await forwarded.arrayBuffer()));
    } catch {
      reply(response, 502, { error: "playground_host_unavailable" });
    }
  };
}

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
          `UPDATE clockgrove.world_memberships SET grants=ARRAY[${GRANTS.map((grant) => `'${grant}'`).join(",")}]${OWNER ? `, privacy_ceiling='${OWNER_CEILING}'` : ""} WHERE principal_id='principal-runtime';
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
      // Inline plugins are added to those of the config file. The preferred port 5173 moves to the
      // next free one (strictPort is off), so a second session can run beside the first.
      plugins:
        PLAYGROUND_HOST === undefined
          ? []
          : [
              {
                name: "clockgrove-playground",
                configureServer(vite) {
                  vite.middlewares.use("/playground/v1", playgroundHandler(native));
                },
              },
            ],
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
