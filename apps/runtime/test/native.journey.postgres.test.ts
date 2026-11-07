import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { deserialize, serialize } from "node:v8";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- repository-local evidence helper has no declarations.
import { digest } from "../../../scripts/ci/evidence.mjs";
// @ts-expect-error -- repository-local JavaScript helper has no declarations.
import { psql, psqlQuery } from "../../../scripts/database/lib.mjs";
// @ts-expect-error -- repository-local recovery helper has no declarations.
import { completeAuthoritySnapshot as canonicalSnapshot } from "../../../scripts/database/restore.mjs";
import { authenticationRequest } from "./auth-fixture.js";

const require = createRequire(import.meta.url);
const wranglerPackage = require.resolve("wrangler/package.json");
const runtimeRequire = createRequire(wranglerPackage);
const { Miniflare, convertV4MiniflareOptions } = runtimeRequire("miniflare");

interface Fixture {
  tools: { psql: string; postgres: string };
  environment: Record<string, string>;
  withLoopbackTransport<T>(operation: (port: number) => Promise<T>): Promise<T>;
}

describe("native Durable Object PostgreSQL recovery journey", () => {
  const context = process.env.CLOCKGROVE_NATIVE_FIXTURE;
  it.skipIf(!context)(
    "rehydrates actual lost storage through production authentication without canonical mutation",
    async () => {
      expect(process.env.MINIFLARE_WORKERD_PATH).toBeUndefined();
      let proof: Record<string, unknown> | undefined;
      const inherited = JSON.parse(context!);
      const owner: string = inherited.owner;
      let runtime: InstanceType<typeof Miniflare> | undefined;
      const persistence = path.join(owner, "storage");
      const stop = async () => {
        const current = runtime;
        runtime = undefined;
        await current?.dispose();
      };
      try {
        const output: string = inherited.output;
        const entries: string[] = inherited.entries;
        const fixture: Fixture = {
          tools: inherited.tools,
          environment: inherited.environment,
          withLoopbackTransport: (operation) => operation(inherited.port),
        };
        await (async () => {
          const { tools, environment } = fixture;

          await fixture.withLoopbackTransport(async (port) => {
            const fixturePassword = ["local", "fixture"].join("-");
            const fixtureSecret = "local-reader-verification".repeat(2);
            const connection = (role: string) => {
              const url = new URL(`postgres://${role}@127.0.0.1:${port}/clockgrove`);
              url.password = fixturePassword;
              return url.toString();
            };
            const start = () => {
              runtime = new Miniflare(
                convertV4MiniflareOptions({
                  name: "native-recovery",
                  host: "127.0.0.1",
                  rootPath: owner,
                  modulesRoot: output,
                  modules: true,
                  scriptPath: path.join(output, entries[0]!),
                  compatibilityDate: "2026-10-01",
                  compatibilityFlags: ["nodejs_compat"],
                  resourcePersistencePath: persistence,
                  cf: false,
                  durableObjects: {
                    WORLD_DO: { className: "WorldDO", useSQLite: true },
                    SPACE_DO: { className: "SpaceDO", useSQLite: true },
                    ACTOR_AGENT_DO: { className: "ActorAgentDO", useSQLite: true },
                  },
                  hyperdrives: { HYPERDRIVE: connection("clockgrove_runtime") },
                  bindings: {
                    AUTH_DATABASE_URL: connection("clockgrove_auth_verifier"),
                    MANAGEMENT_DATABASE_URL: connection("clockgrove_management_reader"),
                    WORLD_AUTHORIZATION_DATABASE_URL: connection("clockgrove_world_reader"),
                    BETTER_AUTH_SECRET: fixtureSecret,
                    AUTH_ORIGIN: "https://auth.example.test",
                    PROVIDER_ENVIRONMENT: "local",
                  },
                }),
              );
            };
            const fetch = async (
              inspect = false,
              overrides = {},
              credential = "local-reader-session",
            ) => {
              const request = authenticationRequest(overrides, credential);
              const response = await runtime!.dispatchFetch(
                `http://local.invalid/${inspect ? "inspect" : "v1/runtime/no-op"}`,
                {
                  method: "POST",
                  headers: {
                    "content-type": "application/json",
                    authorization: request.headers.get("authorization")!,
                    "x-correlation-id": "correlation-runtime",
                  },
                  body: await request.text(),
                  signal: AbortSignal.timeout(10_000),
                },
              );
              return { status: response.status, body: await response.json() };
            };
            try {
              start();
              const empty = await canonicalSnapshot(tools, environment);
              const initialized = await fetch(true);
              expect(initialized.status).toBe(200);
              expect(
                initialized.body.map((value: { disposition: string }) => value.disposition),
              ).toEqual(["rehydrated", "rehydrated", "rehydrated"]);
              expect(await canonicalSnapshot(tools, environment)).toBe(empty);
              const first = await fetch();
              expect(first.status).toBe(200);
              expect(first.body).toEqual({
                accepted: true,
                correlationId: "correlation-runtime",
                disposition: "unchanged",
              });
              expect(await fetch()).toEqual(first);
              // An authorization refusal for a non-ready world of this tenant is recorded: exactly one
              // rejected receipt and one deny decision, and every other row unchanged.
              await psql(
                tools,
                environment,
                "UPDATE clockgrove.worlds SET lifecycle_status = 'provisioning'",
              );
              const missing = await canonicalSnapshot(tools, environment);
              expect((await fetch(false, { commandId: "non-ready-world" })).status).toBe(403);
              expect(
                withoutCommand(await canonicalSnapshot(tools, environment), "non-ready-world"),
              ).toBe(withoutCommand(missing, "non-ready-world"));
              expect(
                (
                  await psqlQuery(
                    tools,
                    environment,
                    "SELECT (SELECT string_agg(status, ',') FROM clockgrove.command_receipts WHERE command_id = 'non-ready-world'), (SELECT string_agg(outcome || ':' || reason_code, ',') FROM clockgrove.authority_decisions WHERE command_id = 'non-ready-world'), (SELECT count(*) FROM clockgrove.events WHERE command_id = 'non-ready-world')",
                  )
                ).trim(),
              ).toBe("rejected|deny:world-participation-absent|0");
              await psql(
                tools,
                environment,
                "UPDATE clockgrove.worlds SET lifecycle_status = 'ready'",
              );
              expect(await fetch()).toEqual(first);
              const before = await canonicalSnapshot(tools, environment);
              await stop();
              const files = (await storageFiles(persistence)).filter(
                (file) =>
                  /native-recovery-(WorldDO|SpaceDO|ActorAgentDO)\//u.test(file) &&
                  localState(file) !== undefined,
              );
              expect(files.length).toBe(3);
              const persisted = files.map((file) => localState(file));
              expect(persisted.map((state) => state.owner).sort()).toEqual([
                "actor-agent",
                "space",
                "world",
              ]);
              // A full runtime restart must see the same persisted storage before loss.
              start();
              expect(
                (await fetch(true)).body.map((value: { disposition: string }) => value.disposition),
              ).toEqual(["reconciled", "reconciled", "reconciled"]);
              await stop();
              await rm(persistence, { recursive: true });
              expect(await storageFiles(persistence)).toEqual([]);
              start();
              const recovered = await fetch(true);
              expect(recovered.status).toBe(200);
              expect(
                recovered.body.map((value: { disposition: string }) => value.disposition),
              ).toEqual(["rehydrated", "rehydrated", "rehydrated"]);
              for (const { state } of recovered.body) {
                expect(state.placement).toMatchObject({
                  worldId: "world-runtime",
                  timelineId: "timeline-runtime",
                  spaceId: "space-runtime",
                  runtimeCellId: "partition-runtime",
                  routingEpoch: "7",
                  authorityEpoch: "7",
                  fidelity: "hot",
                });
                expect(state.projectionRevision).toBe("1");
              }
              expect(await canonicalSnapshot(tools, environment)).toBe(before);
              expect(await fetch()).toEqual(first);
              expect(await canonicalSnapshot(tools, environment)).toBe(before);
              await stop();
              for (const file of (await storageFiles(persistence)).filter(
                (file) =>
                  /native-recovery-(WorldDO|SpaceDO|ActorAgentDO)\//u.test(file) &&
                  localState(file) !== undefined,
              )) {
                const state = localState(file);
                state.placement = {
                  ...state.placement,
                  runtimeCellId: "stale-cell",
                  routingEpoch: 1n,
                  authorityEpoch: 2n,
                  fidelity: "dormant",
                };
                state.projectionRevision = 999n;
                state.partitionId = "stale-partition";
                state.primaryStreamId = "stale-stream";
                localState(file, state);
                expect(localState(file)).toEqual(state);
              }
              start();
              const reconciled = await fetch(true);
              expect(
                reconciled.body.map((value: { disposition: string }) => value.disposition),
              ).toEqual(["reconciled", "reconciled", "reconciled"]);
              for (let index = 0; index < 3; index++) {
                const state = reconciled.body[index].state;
                const prior = recovered.body[index].state;
                expect(state.placement.runtimeInstanceId).not.toBe(
                  prior.placement.runtimeInstanceId,
                );
                expect({
                  ...state,
                  placement: {
                    ...state.placement,
                    runtimeInstanceId: prior.placement.runtimeInstanceId,
                  },
                }).toEqual(prior);
              }
              // The owner's refusal crosses Durable Object RPC as its stable code.
              for (const field of ["routingEpoch", "authorityEpoch"]) {
                expect(await fetch(false, { commandId: `stale-${field}`, [field]: "6" })).toEqual({
                  status: 409,
                  body: { error: "stale_epoch", kind: field.replace("Epoch", "") },
                });
                expect(await canonicalSnapshot(tools, environment)).toBe(before);
              }
              // A space that is not ready yet is 404 across RPC; the owner survives it.
              await psql(tools, environment, "UPDATE clockgrove.timelines SET state = 'archived'");
              expect(await fetch(false, { commandId: "non-ready-space" })).toEqual({
                status: 404,
                body: { error: "space_not_found" },
              });
              await psql(tools, environment, "UPDATE clockgrove.timelines SET state = 'active'");
              expect(await canonicalSnapshot(tools, environment)).toBe(before);
              expect((await fetch(false, {}, "invalid-local-session")).status).toBe(401);
              expect(await canonicalSnapshot(tools, environment)).toBe(before);
              expect((await fetch(false, { commandId: "non-ready-world" })).status).toBe(403);
              expect(await fetch()).toEqual(first);
              const after = await canonicalSnapshot(tools, environment);
              expect(after).toBe(before);
              const counts = (
                await psqlQuery(
                  tools,
                  environment,
                  "SELECT (SELECT count(*) FROM clockgrove.command_receipts WHERE status = 'committed'), (SELECT count(*) FROM clockgrove.events), (SELECT count(*) FROM clockgrove.event_dispatches), (SELECT correlation_id FROM clockgrove.events)",
                )
              ).trim();
              expect(counts).toBe("1|1|1|correlation-runtime");
              await stop();
              expect(
                (
                  await psqlQuery(
                    tools,
                    environment,
                    "SELECT count(*) FROM pg_stat_activity WHERE usename IN ('clockgrove_runtime','clockgrove_auth_verifier','clockgrove_management_reader','clockgrove_world_reader')",
                  )
                ).trim(),
              ).toBe("0");
              if (process.env.WAVE0_NATIVE_RECOVERY === "1" && process.env.CI_EVIDENCE_DIR) {
                const git = (...args: string[]) =>
                  execFileSync("git", args, { encoding: "utf8" }).trim();
                expect(git("status", "--porcelain", "--untracked-files=normal")).toBe("");
                const miniflare = runtimeRequire("miniflare/package.json");
                const workerd = createRequire(runtimeRequire.resolve("miniflare/package.json"))(
                  "workerd",
                );
                proof = {
                  commit: git("rev-parse", "HEAD"),
                  tree: git("rev-parse", "HEAD^{tree}"),
                  surface: "native-local",
                  lockfileDigest: digest(
                    await readFile(new URL("../../../pnpm-lock.yaml", import.meta.url)),
                  ),
                  bundleDigest: digest(await readFile(path.join(output, entries[0]!))),
                  schemas: ["clockgrove", "clockgrove_auth", "clockgrove_management"],
                  tools: {
                    pnpm: execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim(),
                    pgvector: (
                      await psqlQuery(
                        tools,
                        environment,
                        "SELECT extversion FROM pg_extension WHERE extname = 'vector'",
                      )
                    ).trim(),
                    workerdPackage: workerd.version,
                    node: process.versions.node,
                    wrangler: require(wranglerPackage).version,
                    miniflare: miniflare.version,
                    workerd: execFileSync(workerd.default, ["--version"], {
                      encoding: "utf8",
                    }).trim(),
                    postgres: execFileSync(tools.postgres, ["--version"], {
                      encoding: "utf8",
                    }).trim(),
                  },
                  storageLoss: {
                    persistedOwners: ["world", "space", "actor-agent"],
                    persistedFiles: files.length,
                    removedFiles: files.length,
                    absentBeforeRestart: true,
                  },
                  comparison: "exact-all-world-auth-management-rows",
                  beforeDigest: digest(before),
                  afterDigest: digest(after),
                  canonicalPreserved: true,
                  duplicateCounts: counts,
                  staleLocalReconciled: true,
                  missingReadyRouteRefused: true,
                  staleRequestEpochsRefused: true,
                  pending: [
                    "Actual missed/duplicate/reordered Queue or webhook effects",
                    "Hosted qualification",
                    "Independent exact-candidate review",
                    "Full Wave 0 acceptance",
                  ],
                };
              }
            } finally {
              await stop();
            }
          });
        })();
      } finally {
        await stop();
      }
      if (proof && process.env.CI_EVIDENCE_DIR) {
        const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
        expect(git("status", "--porcelain", "--untracked-files=normal")).toBe("");
        expect(git("rev-parse", "HEAD")).toBe(proof.commit);
        expect(git("rev-parse", "HEAD^{tree}")).toBe(proof.tree);
        await mkdir(process.env.CI_EVIDENCE_DIR, { recursive: true });
        await writeFile(
          path.join(process.env.CI_EVIDENCE_DIR, "native-recovery.json"),
          JSON.stringify(proof),
        );
        console.log("Native recovery observed evidence: " + JSON.stringify(proof));
      }
    },
    60_000,
  );
});

/** The snapshot without the rows of one command, so the rest can be compared exactly. */
function withoutCommand(snapshot: string, commandId: string): string {
  const tables = JSON.parse(snapshot) as Array<[string, string]>;
  return JSON.stringify(
    tables.map(([table, rows]) => [
      table,
      (JSON.parse(rows) as Array<Record<string, unknown>>).filter(
        (row) => row.command_id !== commandId,
      ),
    ]),
  );
}

async function storageFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await storageFiles(file)));
    else if (entry.name.endsWith(".sqlite")) files.push(file);
  }
  return files.sort();
}
function localState(file: string, replacement?: ReturnType<typeof deserialize>) {
  const database = new DatabaseSync(file);
  try {
    if (!database.prepare("SELECT name FROM sqlite_master WHERE name = '_cf_KV'").get())
      return undefined;
    const row = database
      .prepare("SELECT value FROM _cf_KV WHERE key = ?")
      .get("runtime-local-state");
    if (!row) return undefined;
    const state = deserialize(row!.value as Uint8Array);
    if (replacement)
      database
        .prepare("UPDATE _cf_KV SET value = ? WHERE key = ?")
        .run(serialize(replacement), "runtime-local-state");
    return state;
  } finally {
    database.close();
  }
}
