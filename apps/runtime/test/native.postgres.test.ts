import { once } from "node:events";
import { access, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createConnection, type NetConnectOpts } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
// biome-ignore format: @ts-expect-error covers only the next line, so the import stays on one line.
// @ts-expect-error -- repository-local JavaScript helper has no declarations.
import { applyMigrations, psql, psqlQuery, withDisposableDatabase } from "../../../scripts/database/lib.mjs";
// @ts-expect-error -- repository-local JavaScript helper has no declarations.
import { ownedSubprocess, withSubprocessDeadline } from "../../../scripts/lib/subprocess.mjs";

const require = createRequire(import.meta.url);
const wranglerPackage = require.resolve("wrangler/package.json");
interface Fixture {
  tools: { psql: string; postgres: string };
  environment: Record<string, string>;
  temporaryRoot: string;
  transport: "socket" | "loopback";
  withLoopbackTransport<T>(operation: (port: number) => Promise<T>): Promise<T>;
}

// The parent owns storage, PostgreSQL and its bridge. The bounded child owns only
// the native runtime and its descendants, so even a wedged dispose cannot strand them.
describe("native Durable Object PostgreSQL recovery ownership", () => {
  it("settles native execution before closing the fixture", async () => {
    expect(process.env.CLOCKGROVE_NATIVE_FIXTURE).toBeUndefined();
    expect(process.env.MINIFLARE_WORKERD_PATH).toBeUndefined();
    await withSubprocessDeadline(async () => {
      const owner = await mkdtemp(path.join(tmpdir(), "clockgrove-native-recovery-"));
      try {
        const config = path.join(owner, "wrangler.json");
        const output = path.join(owner, "bundle");
        await writeFile(
          config,
          JSON.stringify({
            name: "native-recovery",
            main: path.join(import.meta.dirname, "native-recovery.worker.ts"),
            compatibility_date: "2026-10-01",
            compatibility_flags: ["nodejs_compat"],
          }),
        );
        const bundled = await ownedSubprocess(
          process.execPath,
          [
            path.join(path.dirname(wranglerPackage), "bin/wrangler.js"),
            "deploy",
            "--dry-run",
            "--config",
            config,
            "--outdir",
            output,
          ],
          {
            env: {
              PATH: process.env.PATH,
              HOME: owner,
              XDG_CONFIG_HOME: owner,
              WRANGLER_SEND_METRICS: "false",
              CI: "true",
            },
          },
        );
        expect(bundled.error, bundled.stderr).toBeUndefined();
        expect(bundled.status, bundled.stderr).toBe(0);
        const entries = (await readdir(output)).filter((name) => name.endsWith(".js"));
        expect(entries).toHaveLength(1);
        await withDisposableDatabase(async (fixture: Fixture) => {
          await applyMigrations(fixture.tools, fixture.environment);
          await psql(fixture.tools, fixture.environment, seedSql);
          await psql(
            fixture.tools,
            fixture.environment,
            await readFile(
              new URL("../../../db/fixtures/authentication-readers.sql", import.meta.url),
              "utf8",
            ),
          );
          let port = 0;
          await fixture.withLoopbackTransport(async (ownedPort: number) => {
            port = ownedPort;
            const result = await ownedSubprocess(
              process.execPath,
              [
                path.join(path.dirname(require.resolve("vitest/package.json")), "vitest.mjs"),
                "run",
                "--config",
                "apps/runtime/vitest.runtime.config.ts",
                "apps/runtime/test/native.journey.postgres.test.ts",
              ],
              {
                timeoutMs: 70_000,
                env: {
                  ...process.env,
                  CLOCKGROVE_NATIVE_FIXTURE: JSON.stringify({
                    tools: fixture.tools,
                    environment: fixture.environment,
                    owner,
                    output,
                    entries,
                    port,
                  }),
                },
              },
            );
            process.stdout.write(result.stdout + result.stderr);
            expect(result.error, result.stderr).toBeUndefined();
            expect(result.status, result.stderr).toBe(0);
          });
          // Loopback mode connects to PostgreSQL's own listener: there is no bridge to close.
          if (fixture.transport === "loopback") return;
          await expectPortClosed(port);
          const failure = new Error("deliberate native bridge cleanup probe");
          await expect(
            fixture.withLoopbackTransport(async (ownedPort: number) => {
              port = ownedPort;
              const socket = createConnection({ host: "127.0.0.1", port });
              socket.on("error", () => undefined);
              await once(socket, "connect");
              throw failure;
            }),
          ).rejects.toBe(failure);
          await expectPortClosed(port);
        });
        // A real stalled server query fails the callback, then stops the database
        // before removing its owned directory. Killing only psql is insufficient.
        let stalledRoot = "";
        let stalledSocket: NetConnectOpts = { path: "" };
        await expect(
          withDisposableDatabase(async (fixture: Fixture & { socketDirectory?: string }) => {
            stalledRoot = fixture.temporaryRoot;
            stalledSocket =
              fixture.socketDirectory === undefined
                ? { host: "127.0.0.1", port: Number(fixture.environment.PGPORT) }
                : {
                    path: `\0${fixture.socketDirectory.slice(1)}/.s.PGSQL.${fixture.environment.PGPORT}`,
                  };
            await psqlQuery(fixture.tools, fixture.environment, "SELECT pg_sleep(60)", {
              timeoutMs: 200,
            });
          }),
        ).rejects.toMatchObject({ code: "ETIMEDOUT" });
        await expect(access(stalledRoot)).rejects.toMatchObject({ code: "ENOENT" });
        const socket = createConnection(stalledSocket);
        socket.setTimeout(1_000, () =>
          socket.destroy(new Error("stalled database remains active")),
        );
        try {
          expect((await once(socket, "error"))[0].code).toBe("ECONNREFUSED");
        } finally {
          socket.destroy();
        }
      } finally {
        await rm(owner, { recursive: true, force: true });
      }
    }, 120_000);
  }, 150_000);
});

async function expectPortClosed(port: number) {
  const socket = createConnection({ host: "127.0.0.1", port });
  socket.setTimeout(1_000, () => socket.destroy(new Error("bridge remains open")));
  try {
    const [error] = await once(socket, "error");
    expect(error.code).toBe("ECONNREFUSED");
  } finally {
    socket.destroy();
  }
}
const seedSql = `
INSERT INTO clockgrove.tenants VALUES ('tenant-runtime', 'Runtime Test');
INSERT INTO clockgrove.tenant_principals VALUES ('tenant-runtime', 'principal-runtime');
INSERT INTO clockgrove.worlds (tenant_id, world_id, lifecycle_status) VALUES ('tenant-runtime', 'world-runtime', 'ready');
INSERT INTO clockgrove.timelines (tenant_id, world_id, timeline_id) VALUES ('tenant-runtime', 'world-runtime', 'timeline-runtime');
INSERT INTO clockgrove.timeline_partitions (tenant_id, world_id, timeline_id, partition_id, space_id, routing_epoch) VALUES ('tenant-runtime', 'world-runtime', 'timeline-runtime', 'partition-runtime', 'space-runtime', 7);
INSERT INTO clockgrove.streams (tenant_id, world_id, timeline_id, partition_id, space_id, stream_id) VALUES ('tenant-runtime', 'world-runtime', 'timeline-runtime', 'partition-runtime', 'space-runtime', 'stream-runtime');`;
