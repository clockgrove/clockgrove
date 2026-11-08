import { access, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  type CanonicalNode,
  decodeCanonicalNode,
  encodeCanonicalNode,
} from "@clockgrove/application";
import { type CommandEnvelope } from "@clockgrove/contracts";
import type { HydratedWorldOwner, PostgreSqlClient } from "@clockgrove/persistence";
import { Agent, fetch, type Response, type WebSocket } from "undici";
import { expect } from "vitest";
import { REPO_ROOT } from "../../../../packages/simulator/cli/repo.js";
// biome-ignore format: @ts-expect-error covers only the next line.
// @ts-expect-error -- repository-local JavaScript helper has no declarations.
import { applyMigrations, psql, withDisposableDatabase } from "../../../../scripts/database/lib.mjs";
// @ts-expect-error -- repository-local JavaScript helper has no declarations.
import { ownedSubprocess, withSubprocessDeadline } from "../../../../scripts/lib/subprocess.mjs";
import type { LifecycleWorkflowInstance } from "../../src/cloudflare-entry.js";
import type { RuntimeInitializationResult } from "../../src/types.js";
import {
  type DatabaseFixture,
  provisionTestWorld,
  testWorld,
  truthOf,
  withClient,
} from "../world-fixture.js";

const require = createRequire(import.meta.url);
const wranglerPackage = require.resolve("wrangler/package.json");
const { Miniflare, convertV4MiniflareOptions } = createRequire(wranglerPackage)("miniflare");
const fixtureVariable = "CLOCKGROVE_WORLD_OWNER_FIXTURE";
// One connection per request. workerd closes an idle keep-alive connection after 5 s; a request
// that reuses it after the test's event loop was blocked longer (an in-process kernel step) races
// that close and fails with "other side closed".
const freshConnections = new Agent({ pipelining: 0 });

interface NativeFixture extends DatabaseFixture {
  readonly owner: string;
  readonly output: string;
  readonly entry: string;
  readonly port: number;
  readonly packName: string;
  readonly queues: boolean;
}
interface BridgedFixture extends DatabaseFixture {
  withLoopbackTransport<T>(
    operation: (port: number) => Promise<T>,
    bridgeConnections?: number,
  ): Promise<T>;
}
interface NativeRuntime {
  readonly ready: Promise<URL>;
  dispose(): Promise<void>;
  dispatchFetch(
    url: string,
    init: { readonly headers: Readonly<Record<string, string>> },
  ): Promise<NativeUpgradeResponse>;
  getWorker(): Promise<{ scheduled(options: { readonly cron: string }): Promise<unknown> }>;
}
export interface NativeResponse {
  readonly status: number;
  readonly body: unknown;
}
export interface NativeSocket extends Pick<WebSocket, "send" | "close" | "addEventListener"> {
  accept(): void;
}
export interface NativeUpgradeResponse extends Pick<Response, "status" | "headers" | "json"> {
  readonly webSocket: NativeSocket | null;
}
export interface NativeWorldOwner {
  readonly fixture: DatabaseFixture;
  origin(): Promise<string>;
  readonly world: Awaited<ReturnType<typeof testWorld>>;
  readonly packName: string;
  readonly scope: {
    readonly tenantId: string;
    readonly worldId: string;
    readonly timelineId: string;
    readonly spaceId: string;
  };
  readonly sql: (sql: string) => Promise<string>;
  withSqlClient<T>(operation: (client: PostgreSqlClient) => Promise<T>): Promise<T>;
  submit(
    command: CommandEnvelope<string, unknown>,
    overrides?: Readonly<Record<string, unknown>>,
    credential?: string,
  ): Promise<NativeResponse>;
  request(
    path: string,
    body: unknown,
    credential?: string,
    signal?: AbortSignal,
  ): Promise<NativeResponse>;
  upgrade(path: string, headers?: Readonly<Record<string, string>>): Promise<NativeUpgradeResponse>;
  replace(
    loseLocalStorage?: boolean,
    disableProvisioningFaults?: boolean,
    disableProvisioningLaunch?: boolean,
  ): Promise<void>;
  /** Restores the database to its provisioned state and starts a runtime with empty local storage. */
  reset(): Promise<void>;
  durable(): Promise<string>;
  enqueue(body: unknown): Promise<void>;
  logs(): readonly string[];
  /** Fires one Cron Trigger: the recoveries by default. */
  reconcileDispatches(cron?: string): Promise<unknown>;
}

/** A parent owns the database/bridge/storage; its bounded child owns workerd and all descendants. */
export async function runNativeWorldOwnerProcess(
  testFile: string,
  packName = "fixture",
  {
    vitestConfig = "apps/runtime/vitest.runtime.config.ts",
    timeoutMs = 120_000,
    inheritOutput = false,
    queues = false,
    provision = true,
    /** Runs on the provisioned database before it becomes the pristine copy `reset` restores. */
    prepare = async (_fixture: DatabaseFixture): Promise<void> => undefined,
    /** Concurrent loopback connections to PostgreSQL (16 by default); the server allows 16 more. */
    connections = undefined as number | undefined,
  } = {},
): Promise<void> {
  await withSubprocessDeadline(async () => {
    const owner = await mkdtemp(path.join(tmpdir(), "clockgrove-world-owner-"));
    try {
      const config = path.join(owner, "wrangler.json");
      const output = path.join(owner, "bundle");
      await writeFile(
        config,
        JSON.stringify({
          name: "world-owner",
          main: path.join(import.meta.dirname, "native.worker.ts"),
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
      expect(entries.length).toBe(1);
      const entry = entries[0];
      if (entry === undefined) throw new Error("native bundle entry missing");
      await withDisposableDatabase(
        async (fixture: BridgedFixture) => {
          await applyMigrations(fixture.tools, fixture.environment);
          const world = await testWorld(packName);
          if (provision) await provisionTestWorld(fixture, world, "principal-runtime");
          else
            await truthOf(fixture)(
              `INSERT INTO clockgrove.tenants (tenant_id, display_name) VALUES ('${world.birth.world.tenantId}', 'test');
             INSERT INTO clockgrove.tenant_principals (tenant_id, principal_id) VALUES ('${world.birth.world.tenantId}', 'principal-runtime')`,
            );
          await truthOf(fixture)("UPDATE clockgrove.timeline_partitions SET routing_epoch=1");
          const scope = world.birth.world;
          const space = world.birth.spaces[0];
          if (space === undefined) throw new Error("native pack requires a space");
          const authentication = (
            await readFile(
              new URL("../../../../db/fixtures/authentication-readers.sql", import.meta.url),
              "utf8",
            )
          )
            .replaceAll("tenant-runtime", scope.tenantId)
            .replaceAll("world-runtime", scope.worldId)
            .replaceAll("timeline-runtime", scope.timelineId)
            .replaceAll("space-runtime", space.spaceId)
            .replace(
              "ARRAY['runtime:no-op']",
              "ARRAY['runtime:no-op','runtime:world-command','runtime:world-clock']",
            )
            .replace('["operator_evidence"]', '["public_scene","operator_evidence"]');
          await psql(
            fixture.tools,
            fixture.environment,
            provision
              ? authentication
              : authentication.split("INSERT INTO clockgrove.world_memberships")[0],
          );
          const identityRows = authentication.split("INSERT INTO clockgrove.world_memberships")[0];
          if (identityRows === undefined)
            throw new Error("authentication identity fixture missing");
          await psql(
            fixture.tools,
            fixture.environment,
            identityRows
              .replaceAll("local-subject", "outsider-subject")
              .replaceAll("local-reader-session", "outsider-session-token")
              .replaceAll("local-session", "outsider-session")
              .replaceAll("reader@example.test", "outsider@example.test")
              .replaceAll("principal-runtime", "principal-outsider")
              .replaceAll("identity-runtime", "identity-outsider"),
          );
          await prepare(fixture);
          // The provisioned database, for reset between scenario runs (no connection is open here).
          await truthOf(
            fixture,
            "postgres",
          )("CREATE DATABASE clockgrove_pristine TEMPLATE clockgrove");
          // The child must not write the parent's Qualification evidence.
          const { CLOCKGROVE_WAVE2_EVIDENCE: _evidence, ...inherited } = process.env;
          await fixture.withLoopbackTransport(async (port) => {
            const result = await ownedSubprocess(
              process.execPath,
              [
                path.join(path.dirname(require.resolve("vitest/package.json")), "vitest.mjs"),
                "run",
                "--config",
                vitestConfig,
                testFile,
              ],
              {
                cwd: REPO_ROOT,
                timeoutMs,
                inherit: inheritOutput,
                env: {
                  ...inherited,
                  [fixtureVariable]: JSON.stringify({
                    tools: fixture.tools,
                    environment: fixture.environment,
                    owner,
                    output,
                    entry,
                    port,
                    packName,
                    queues,
                  }),
                },
              },
            );
            process.stdout.write(result.stdout + result.stderr);
            expect(result.error, result.stderr).toBeUndefined();
            expect(result.status, result.stderr).toBe(0);
          }, connections);
          expect(
            await truthOf(fixture)(
              "SELECT count(*) FROM pg_stat_activity WHERE usename IN ('clockgrove_runtime','clockgrove_auth_verifier','clockgrove_management_reader','clockgrove_world_reader')",
            ),
          ).toBe("0");
        },
        {
          deadlineMs: timeoutMs + 30_000,
          ...(connections === undefined ? {} : { maxConnections: connections + 16 }),
        },
      );
    } finally {
      await rm(owner, { recursive: true, force: true });
      await expect(access(owner)).rejects.toMatchObject({ code: "ENOENT" });
    }
  }, timeoutMs + 60_000);
}

export function isNativeWorldOwnerChild(): boolean {
  return process.env[fixtureVariable] !== undefined;
}

/** Finite real-provider surface reused by owner safety and downstream scenario parity. */
export async function withNativeWorldOwner(
  operation: (owner: NativeWorldOwner) => Promise<void>,
): Promise<void> {
  const inherited = process.env[fixtureVariable];
  if (inherited === undefined)
    throw new Error("run this journey through runNativeWorldOwnerProcess");
  const fixture = JSON.parse(inherited) as NativeFixture;
  const presentationSource = JSON.parse(
    await readFile(path.join(REPO_ROOT, "worlds", fixture.packName, "runtime.json"), "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "{}";
        throw error;
      },
    ),
  );
  const worldBindings = {
    WORLD_PRESENTATION: JSON.stringify(presentationSource.presentations ?? []),
    ...(presentationSource.model === undefined
      ? {}
      : { WORLD_MODEL_CONFIG: JSON.stringify(presentationSource.model) }),
  };
  const world = await testWorld(fixture.packName);
  const space = world.birth.spaces[0];
  if (space === undefined) throw new Error("native pack requires a space");
  const scope = {
    tenantId: world.birth.world.tenantId,
    worldId: world.birth.world.worldId,
    timelineId: world.birth.world.timelineId,
    spaceId: space.spaceId,
  };
  const sql = truthOf(fixture);
  const cluster = truthOf(fixture, "postgres");
  const persistence = path.join(fixture.owner, "storage");
  const fixtureSecret = "local-reader-verification".repeat(2);
  let runtime: NativeRuntime | undefined;
  let provisioningFaultsDisabled = false;
  let provisioningLaunchDisabled = false;
  const connection = (role: string) => {
    const url = new URL(`postgres://${role}@127.0.0.1:${fixture.port}/clockgrove`);
    url.password = fixture.environment.PGPASSWORD ?? ["local", "fixture"].join("-");
    return url.toString();
  };
  const logs: string[] = [];
  const start = () => {
    runtime = new Miniflare(
      convertV4MiniflareOptions({
        name: "world-owner",
        host: "127.0.0.1",
        rootPath: fixture.owner,
        modulesRoot: fixture.output,
        modules: true,
        scriptPath: path.join(fixture.output, fixture.entry),
        compatibilityDate: "2026-10-01",
        compatibilityFlags: ["nodejs_compat"],
        resourcePersistencePath: persistence,
        cf: false,
        handleStructuredLogs: (log: { readonly message: string }) => logs.push(log.message),
        durableObjects: {
          WORLD_DO: { className: "WorldDO", useSQLite: true },
          SPACE_DO: { className: "SpaceDO", useSQLite: true },
          ACTOR_AGENT_DO: { className: "ActorAgentDO", useSQLite: true },
        },
        ...(fixture.queues
          ? {
              queueProducers: { WORLD_REACTIONS_QUEUE: "rw-production-world-reactions" },
              queueConsumers: {
                "rw-production-world-reactions": {
                  maxBatchTimeout: 0,
                  maxRetries: 3,
                  deadLetterQueue: "rw-production-world-reactions-dlq",
                },
                "rw-production-world-reactions-dlq": { maxBatchTimeout: 0 },
              },
            }
          : {}),
        serviceBindings: {
          PROVISIONING_ENTRY: { name: "world-owner", entrypoint: "WorldProvisioningEntrypoint" },
        },
        workflows: {
          WORLD_CATCH_UP_WORKFLOW: {
            name: "native-world-catch-up",
            className: "WorldCatchUpWorkflow",
          },
          ...(!provisioningLaunchDisabled
            ? {
                WORLD_PROVISIONING_WORKFLOW: {
                  name: "native-world-provisioning",
                  className: "WorldProvisioningWorkflow",
                },
              }
            : {}),
          WORLD_READINESS_WORKFLOW: {
            name: "native-world-readiness",
            className: "WorldReadinessWorkflow",
          },
        },
        hyperdrives: { HYPERDRIVE: connection("clockgrove_runtime") },
        r2Buckets: { ARTIFACTS_BUCKET: "rw-local-artifacts" },
        bindings: {
          ...worldBindings,
          NATIVE_PROVISIONING_FAULTS_DISABLED: provisioningFaultsDisabled,
          AUTH_DATABASE_URL: connection("clockgrove_auth_verifier"),
          MANAGEMENT_DATABASE_URL: connection("clockgrove_management_reader"),
          WORLD_AUTHORIZATION_DATABASE_URL: connection("clockgrove_world_reader"),
          BETTER_AUTH_SECRET: fixtureSecret,
          ARTIFACT_KEYRING: JSON.stringify({
            version: 1,
            current: "native-kek-1",
            keys: { "native-kek-1": Buffer.alloc(32, 7).toString("base64url") },
          }),
          AUTH_ORIGIN: "https://auth.example.test",
          PROVIDER_ENVIRONMENT: "local",
          WORLD_REACTIONS_QUEUE_NAME: "rw-production-world-reactions",
          COGNITIVE_INDEXING_QUEUE_NAME: "rw-production-cognitive-indexing",
          EXTERNAL_EFFECTS_QUEUE_NAME: "rw-production-external-effects",
        },
      }),
    );
  };
  const stop = async () => {
    const previous = runtime;
    runtime = undefined;
    await previous?.dispose();
  };
  const request: NativeWorldOwner["request"] = async (
    pathname,
    body,
    credential = "local-reader-session",
    // Longer than one kernel call may hold its transaction (30 s), so the owner's bound decides.
    signal = AbortSignal.timeout(45_000),
  ) => {
    if (runtime === undefined) throw new Error("native runtime stopped");
    const response = await fetch(new URL(pathname, await runtime.ready), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${credential}`,
        "x-correlation-id": "native-world-owner",
      },
      body: JSON.stringify(body),
      signal,
      dispatcher: freshConnections,
    });
    if (!response.headers.get("content-type")?.includes("application/json"))
      throw new Error(await response.text());
    return { status: response.status, body: await response.json() };
  };
  start();
  try {
    await operation({
      fixture,
      origin: async () => {
        if (runtime === undefined) throw new Error("native runtime stopped");
        return (await runtime.ready).origin;
      },
      world,
      packName: fixture.packName,
      scope,
      sql,
      request,
      upgrade: async (pathname, headers = {}) => {
        if (runtime === undefined) throw new Error("native runtime stopped");
        return runtime.dispatchFetch(new URL(pathname, await runtime.ready).toString(), {
          headers: { upgrade: "websocket", ...headers },
        });
      },
      logs: () => logs,
      enqueue: async (body) => {
        if (runtime === undefined || !fixture.queues) throw new Error("native Queue unavailable");
        const response = await request("/dispatches/enqueue", body);
        expect(response).toEqual({ status: 200, body: { disposition: "enqueued" } });
      },
      reconcileDispatches: async (cron = "*/5 * * * *") => {
        if (runtime === undefined) throw new Error("native runtime stopped");
        return (await runtime.getWorker()).scheduled({ cron });
      },
      withSqlClient: (operation) =>
        withClient(fixture.environment, operation, "clockgrove", "clockgrove_admin"),
      submit: (command, overrides = {}, credential) =>
        request(
          "/v1/runtime/commands",
          {
            schemaVersion: 1,
            ...scope,
            routingEpoch: "1",
            authorityEpoch: "1",
            command: encodeCanonicalNode(command),
            ...overrides,
          },
          credential,
        ),
      replace: async (
        loseLocalStorage = false,
        disableProvisioningFaults = false,
        disableProvisioningLaunch = false,
      ) => {
        await stop();
        provisioningFaultsDisabled = disableProvisioningFaults;
        provisioningLaunchDisabled = disableProvisioningLaunch;
        if (loseLocalStorage) await rm(persistence, { recursive: true, force: true });
        start();
      },
      reset: async () => {
        await stop();
        provisioningFaultsDisabled = false;
        provisioningLaunchDisabled = false;
        await cluster("DROP DATABASE clockgrove WITH (FORCE)");
        await cluster("CREATE DATABASE clockgrove TEMPLATE clockgrove_pristine");
        await rm(persistence, { recursive: true, force: true });
        start();
      },
      durable: () =>
        sql(
          "SELECT jsonb_build_object('states',(SELECT jsonb_agg(to_jsonb(s) ORDER BY partition_id) FROM clockgrove.partition_states s),'schedules',(SELECT jsonb_agg(to_jsonb(s) ORDER BY schedule_id,idempotency_key) FROM clockgrove.partition_schedules s),'receipts',(SELECT jsonb_agg(to_jsonb(r) ORDER BY command_id) FROM clockgrove.command_receipts r),'decisions',(SELECT jsonb_agg(to_jsonb(d) ORDER BY authority_decision_id) FROM clockgrove.authority_decisions d),'events',(SELECT jsonb_agg(to_jsonb(e) ORDER BY partition_sequence) FROM clockgrove.events e),'dispatches',(SELECT jsonb_agg(to_jsonb(d) ORDER BY dispatch_id) FROM clockgrove.event_dispatches d),'partitionHeads',(SELECT jsonb_agg(jsonb_build_array(tenant_id,timeline_id,partition_id,head_sequence) ORDER BY tenant_id,timeline_id,partition_id) FROM clockgrove.timeline_partitions),'streamHeads',(SELECT jsonb_agg(jsonb_build_array(tenant_id,stream_id,current_sequence) ORDER BY tenant_id,stream_id) FROM clockgrove.streams))::text",
        ),
    });
  } finally {
    await stop();
  }
}

export function canonicalResponse(body: unknown): CanonicalNode {
  if (!Array.isArray(body)) throw new Error("expected a canonical-node response");
  return body;
}

export async function waitForOwnerSql(
  sql: NativeWorldOwner["sql"],
  query: string,
  expected: string,
  attempts = 100,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if ((await sql(query)) === expected) return;
    await delay(10);
  }
  expect(await sql(query)).toBe(expected);
}

/** Observe real provider completion under the same finite polling budget as owner recovery tests. */
export async function waitForNativeWorkflow(
  owner: NativeWorldOwner,
  id: string,
  expected: "complete" | "errored",
  workflow?: "readiness" | "catch-up",
): Promise<Awaited<ReturnType<LifecycleWorkflowInstance["status"]>>> {
  let status: Awaited<ReturnType<LifecycleWorkflowInstance["status"]>> = { status: "running" };
  for (let attempt = 0; attempt < 1000 && status.status !== expected; attempt++) {
    const response = await owner.request("/provisioning/status", { id, workflow });
    expect(response.status).toBe(200);
    status = response.body as typeof status;
    if (status.status !== expected) await delay(10);
  }
  expect(status.status).toBe(expected);
  return status;
}

export interface NativeWorldInspection {
  readonly worldId: string;
  readonly spaceId: string;
  readonly worldName: string;
  readonly spaceName: string;
  readonly local: RuntimeInitializationResult;
  readonly partition: HydratedWorldOwner;
}

export async function inspectNativeWorldOwner(
  owner: NativeWorldOwner,
): Promise<NativeWorldInspection> {
  const response = await owner.request("/inspect", { ...owner.scope, commandId: "inspection" });
  expect(response.status).toBe(200);
  return decodeCanonicalNode(canonicalResponse(response.body)) as NativeWorldInspection;
}
