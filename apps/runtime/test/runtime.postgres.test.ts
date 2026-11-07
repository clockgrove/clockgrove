import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  computePayloadHash,
  InMemoryRuntimeLogger,
  type Journal,
  type JournalExecuteRequest,
  type JournalOutcomeReader,
  type RuntimeAuthorizationContext,
} from "@clockgrove/application";
import { type CommandId, decodeOpaqueId, type SubjectId } from "@clockgrove/contracts";
import {
  type PostgreSqlClient,
  PostgreSqlJournal,
  PostgreSqlPersistenceTransactionPort,
} from "@clockgrove/persistence";
import { describe, expect, it, vi } from "vitest";
// The accepted helper is JavaScript and intentionally remains outside this package.
// biome-ignore format: @ts-expect-error covers only the next line, so the import stays on one line.
// @ts-expect-error -- repository-local JavaScript helper has no declaration file.
import { applyMigrations, psql, psqlQuery, withDisposableDatabase } from "../../../scripts/database/lib.mjs";
// @ts-expect-error -- repository-local JavaScript recovery helper has no declaration file.
import { canonicalSnapshot, withRestoredHistory } from "../../../scripts/database/restore.mjs";
import { withHyperdrivePostgreSqlClient } from "../src/hyperdrive-postgres.js";
import type { RuntimeLocalState, RuntimeScope } from "../src/index.js";
import {
  LocalRuntimeOwnerBindings,
  PostgreSqlCanonicalRuntimeStateSource,
  RuntimeWorker,
  runtimeRouteName,
  stableRuntimeRouteName,
} from "../src/index.js";
import { authenticationFixture } from "./auth-fixture.js";
import { trustedTestContext } from "./trusted-context.js";
import { connectionString } from "./world-fixture.js";

async function completeCanonicalSnapshot(
  tools: DatabaseFixture["tools"],
  environment: DatabaseFixture["environment"],
) {
  // Compare every canonical row, including journal/receipt/dispatch families, not only head counts.
  const tables = (
    await psqlQuery(
      tools,
      environment,
      "SELECT tablename FROM pg_tables WHERE schemaname = 'clockgrove' ORDER BY tablename",
    )
  )
    .trim()
    .split("\n");
  const snapshots = [];
  for (const table of tables) {
    if (!/^[a-z_]+$/u.test(table)) throw new Error("unexpected table name");
    snapshots.push(
      await psqlQuery(
        tools,
        environment,
        `SELECT COALESCE(jsonb_agg(row_data ORDER BY row_data::text), '[]'::jsonb) FROM (SELECT to_jsonb(t) AS row_data FROM clockgrove.${table} AS t) AS rows`,
      ),
    );
  }
  return JSON.stringify(snapshots);
}

describe("attributed receipts and recorded denials through RuntimeWorker over real PostgreSQL", () => {
  it("records allow and deny decisions once and answers exact retries without deciding again", async () => {
    await withDisposableDatabase(async ({ tools, environment }: DatabaseFixture) => {
      await applyMigrations(tools, environment);
      await psql(tools, environment, seedSql);
      // Real pg connections, so refused journal statements surface their SQLSTATE.
      const url = connectionString(environment);
      await withHyperdrivePostgreSqlClient(url, (client) =>
        withHyperdrivePostgreSqlClient(url, async (retryClient) => {
          const fixture = authenticationFixture();
          const journal = new CountingJournal(new PostgreSqlJournal(client));
          const logger = new InMemoryRuntimeLogger();
          const worker = new RuntimeWorker(
            fixture.authenticator,
            new LocalRuntimeOwnerBindings(
              new PostgreSqlCanonicalRuntimeStateSource(client),
              journal,
            ),
            logger,
          );
          const receipts = new PostgreSqlPersistenceTransactionPort(client);
          const authority: RuntimeAuthorizationContext = {
            tenantId: decodeOpaqueId("tenant-runtime", "TenantId"),
            principalId: decodeOpaqueId("principal-runtime", "PrincipalId"),
            privacyCeiling: { version: 1, allowedCategories: ["operator_evidence"] },
          };
          const stored = (commandId: string) =>
            receipts.withAuthorization(authority, async (transaction) => {
              const receipt = await transaction.getCommandReceipt(
                decodeOpaqueId(commandId, "CommandId"),
              );
              const decision =
                receipt?.authorityDecisionId === undefined
                  ? undefined
                  : await transaction.getAuthorityDecision(receipt.authorityDecisionId);
              return { receipt, decision };
            });

          // An allowed command: an attributed receipt and one allow decision minted by trusted code,
          // whatever authorityDecisionId the client sent, sealed by the committed event.
          const allowedBody = {
            ...noOpBody(),
            commandId: "command-allowed",
            eventId: "event-allowed",
            authorityDecisionId: "client-chosen",
          };
          const allowed = await worker.fetch(request(allowedBody));
          expect(allowed.status).toBe(200);
          const allowedText = await allowed.text();
          expect(fixture.worldResolutions()).toBe(1);
          expect(journal.executions).toBe(1);
          const allowedRecord = await stored("command-allowed");
          expect(allowedRecord.receipt).toMatchObject({
            provenance: "attributed",
            status: "committed",
            attribution: {
              principalId: "principal-runtime",
              effectiveActorId: "space-runtime",
              causalRootActionId: "action-runtime-no-op",
            },
            actionId: "action-runtime-no-op",
            correlationId: "correlation-runtime",
            expected: { partitionRevision: 0n, routingEpoch: 7 },
            authorityDecisionId: "authority:command-allowed",
            committedEventIds: ["event-allowed"],
          });
          expect(allowedRecord.decision).toMatchObject({
            outcome: "allow",
            commandId: "command-allowed",
            actionId: "action-runtime-no-op",
            inputs: {
              principalId: "principal-runtime",
              worldMembershipId: "world-membership",
              personaId: "world-persona",
              roles: [],
              grants: ["runtime:no-op"],
            },
          });
          expect(allowedRecord.decision).not.toHaveProperty("reasonCode");
          expect(
            (
              await psqlQuery(
                tools,
                environment,
                "SELECT attribution->>'authorityDecisionId' FROM clockgrove.events WHERE command_id = 'command-allowed'",
              )
            ).trim(),
          ).toBe("authority:command-allowed");

          // Its exact retry returns the stored response byte-identically, on another connection too,
          // without resolving authority, building a decision or reaching the journal again.
          expect(await (await worker.fetch(request(allowedBody))).text()).toBe(allowedText);
          const retryFixture = authenticationFixture();
          const retryWorker = new RuntimeWorker(
            retryFixture.authenticator,
            new LocalRuntimeOwnerBindings(
              new PostgreSqlCanonicalRuntimeStateSource(retryClient),
              new PostgreSqlJournal(retryClient),
            ),
          );
          expect(await (await retryWorker.fetch(request(allowedBody))).text()).toBe(allowedText);
          expect(fixture.worldResolutions()).toBe(1);
          expect(retryFixture.worldResolutions()).toBe(0);
          expect(journal.executions).toBe(1);
          expect(await decisionCount(tools, environment, "command-allowed")).toBe("1");

          // The same client authorityDecisionId on another command yields a distinct minted decision.
          const second = await worker.fetch(
            request({
              ...allowedBody,
              commandId: "command-second",
              eventId: "event-second",
              expectedProjectionRevision: "1",
            }),
          );
          expect(second.status).toBe(200);
          expect(
            (
              await psqlQuery(
                tools,
                environment,
                "SELECT string_agg(authority_decision_id, ',' ORDER BY authority_decision_id) FROM clockgrove.authority_decisions",
              )
            ).trim(),
          ).toBe("authority:command-allowed,authority:command-second");

          // An authorization refusal of a decodable command in this tenant's world: 403, a rejected
          // receipt and a deny decision with the refused inputs, no events and unchanged heads.
          const heads = await headsOf(tools, environment);
          fixture.setWorldGrants([]);
          const deniedBody = {
            ...noOpBody(),
            commandId: "command-denied",
            eventId: "event-denied",
            expectedProjectionRevision: "2",
          };
          const denied = await worker.fetch(request(deniedBody));
          expect(denied.status).toBe(403);
          const deniedText = await denied.text();
          expect(JSON.parse(deniedText)).toEqual({ error: "authorization_refused" });
          // A recorded denial is logged as a rejected receipt, not a refusal before any command.
          expect(logger.records.at(-1)).toMatchObject({
            event: "noop_command_answered",
            commandId: "command-denied",
            authorization: "denied",
            outcome: "rejected",
            code: "authorization_refused",
            status: 403,
          });
          expect(fixture.worldResolutions()).toBe(3);
          const deniedRecord = await stored("command-denied");
          expect(deniedRecord.receipt).toMatchObject({
            provenance: "attributed",
            status: "rejected",
            authorityDecisionId: "authority:command-denied",
            committedEventIds: [],
            result: {
              value: { error: "authorization_refused" },
              events: [],
              outcome: "rejected",
            },
          });
          expect(deniedRecord.decision).toMatchObject({
            outcome: "deny",
            reasonCode: "runtime-grant-missing",
            inputs: {
              principalId: "principal-runtime",
              worldMembershipId: "world-membership",
              personaId: "world-persona",
              roles: [],
              grants: [],
            },
          });
          expect(
            (
              await psqlQuery(
                tools,
                environment,
                "SELECT count(*) FROM clockgrove.events WHERE command_id = 'command-denied'",
              )
            ).trim(),
          ).toBe("0");
          expect(await headsOf(tools, environment)).toBe(heads);

          // Its exact retry returns the stored rejection even after the grants return, without
          // resolving authority again or recording another decision.
          fixture.setWorldGrants([decodeOpaqueId("runtime:no-op", "GrantRef")]);
          const retried = await worker.fetch(request(deniedBody));
          expect(retried.status).toBe(403);
          expect(await retried.text()).toBe(deniedText);
          expect(fixture.worldResolutions()).toBe(3);
          expect(await decisionCount(tools, environment, "command-denied")).toBe("1");
          expect(await headsOf(tools, environment)).toBe(heads);

          // Refusals that are not recorded keep their status and write nothing: another tenant or
          // another world than the member's, an authentication provider outage, and, with no world
          // authority, a scope naming no world of the tenant, an undecodable request and an
          // authentication refusal.
          const unrecorded = await completeCanonicalSnapshot(tools, environment);
          for (const scope of [{ tenantId: "tenant-other" }, { worldId: "world-other" }]) {
            const response = await worker.fetch(
              request({ ...deniedBody, ...scope, commandId: "command-cross-scope" }),
            );
            expect([response.status, await response.json()]).toEqual([
              403,
              { error: "authorization_refused" },
            ]);
          }
          fixture.provider.available = false;
          const outage = await worker.fetch(
            request({ ...deniedBody, commandId: "command-outage" }),
          );
          expect([outage.status, await outage.json()]).toEqual([
            401,
            { error: "authentication_refused" },
          ]);
          fixture.provider.available = true;
          fixture.removeWorld();
          for (const [body, credential, status] of [
            [
              { ...deniedBody, commandId: "command-missing-world", worldId: "world-missing" },
              "valid",
              403,
            ],
            [
              { ...deniedBody, commandId: "command-other-tenant", tenantId: "tenant-other" },
              "valid",
              403,
            ],
            [
              { ...deniedBody, commandId: "command-undecodable", routingEpoch: "not-a-number" },
              "valid",
              403,
            ],
            [{ ...deniedBody, commandId: "command-unauthenticated" }, "invalid", 401],
          ] as const) {
            const response = await worker.fetch(request(body, credential));
            expect(response.status).toBe(status);
          }
          expect(await completeCanonicalSnapshot(tools, environment)).toBe(unrecorded);
        }),
      );
    });
  }, 60_000);
});

class CountingJournal implements Journal, JournalOutcomeReader {
  executions = 0;

  constructor(private readonly inner: PostgreSqlJournal) {}

  execute<TResult>(requestValue: JournalExecuteRequest<string, unknown, TResult>) {
    this.executions += 1;
    return this.inner.execute(requestValue);
  }

  storedOutcome<TResult>(
    authorization: RuntimeAuthorizationContext,
    commandId: CommandId,
    commandBytes: Uint8Array,
  ) {
    return this.inner.storedOutcome<TResult>(authorization, commandId, commandBytes);
  }
}

async function decisionCount(
  tools: DatabaseFixture["tools"],
  environment: DatabaseFixture["environment"],
  commandId: string,
) {
  return (
    await psqlQuery(
      tools,
      environment,
      `SELECT count(*) FROM clockgrove.authority_decisions WHERE command_id = '${commandId}'`,
    )
  ).trim();
}

async function headsOf(
  tools: DatabaseFixture["tools"],
  environment: DatabaseFixture["environment"],
) {
  return (
    await psqlQuery(
      tools,
      environment,
      "SELECT (SELECT current_sequence FROM clockgrove.streams), (SELECT head_sequence FROM clockgrove.timeline_partitions)",
    )
  ).trim();
}

describe("local runtime composition over real PostgreSQL", () => {
  it("crosses Worker, runtime owner, accepted journal, recovery, and response exactly once", async () => {
    await withDisposableDatabase(async (fixture: DatabaseFixture) => {
      const { tools, environment } = fixture;
      await applyMigrations(tools, environment);
      await psql(tools, environment, seedSql);

      const runtimeEnvironment = { ...environment, PGUSER: "clockgrove_runtime" };
      const client = new PersistentPsqlClient(tools.psql, runtimeEnvironment);
      await client.start();
      try {
        const canonical = new PostgreSqlCanonicalRuntimeStateSource(client);
        const journal = new PostgreSqlJournal(client);
        const bindings = new LocalRuntimeOwnerBindings(canonical, journal);
        const worker = new RuntimeWorker(authenticationFixture().authenticator, bindings);
        const context = trustedTestContext();
        const scope = {
          tenantId: context.tenantId,
          worldId: context.worldId!,
          timelineId: context.timelineId!,
          spaceId: context.spaceId!,
        };
        // Golden version-1 route vectors: literals from coreutils `sha256sum` over the documented
        // framing, never from `stableRuntimeRouteName`. A change here renames every Durable Object;
        // see the route-name version policy in docs/runbooks/runtime.md.
        const spaceDigest = "ee190bc34ae27c9863dde032bb2fc676544aa8a6c23e5422eab98c507445850a";
        const routeName = `v1-space-${spaceDigest}`;
        // Each kind's tuple, through the one route function every call site uses.
        const vectorScope = {
          tenantId: "tenant-route-vector",
          worldId: "world-route-vector",
          timelineId: "timeline-route-vector",
          spaceId: "space-route-vector",
        } as RuntimeScope;
        const subject = "subject-route-vector" as SubjectId;
        expect([
          await runtimeRouteName("world", vectorScope),
          await runtimeRouteName("space", vectorScope),
          await runtimeRouteName("actor-agent", vectorScope, subject),
        ]).toEqual([
          "v1-world-a430f68e31f560f2780cd4b7ec10c64e94d2778b3d693aefb5a701b7138eaae7",
          "v1-space-6fb1e8945e789805fe55f7bb3ae989263567512379236bbbe740d8ae461b2fe6",
          "v1-actor-agent-1dec1c1ed9eb7fb4ff5e3c9e1fd1790bf215b791e03fd580a93e927b85ae02ed",
        ]);
        const ids = ["tenant-route-vector", "world-route-vector", "timeline-route-vector"];
        const vectors = [
          ["space", Object.values(scope), spaceDigest],
          // Multi-byte UTF-8 (2-, 3- and 4-byte): frames count 15 bytes, not 10 UTF-16 code units.
          [
            "space",
            [...ids, "space-é雪🦝"],
            "225aa5b38697245a2f30bb984299a5ac3fa38180621b9bda65b573bb591ded5f",
          ],
          // A framing-ambiguity pair: the same characters, split differently, name different objects.
          [
            "space",
            ["a|b", "c"],
            "bd7c5e75e5ff9ed866a8c74aaccb98e3ed0c0257a4503a5dd6b5b0a5f0e4f2b6",
          ],
          [
            "space",
            ["a", "b|c"],
            "75abdd5bb93f30d393e5f99c1e5e0f38f0898e5f0117c5d4cdfa6c62776c3a08",
          ],
        ] as const;
        for (const [kind, vectorIds, digest] of vectors) {
          expect(await stableRuntimeRouteName(kind, vectorIds)).toBe(`v1-${kind}-${digest}`);
        }
        // The Worker and the owner both name the space through runtimeRouteName; both must reach the literal name.
        const routed = vi.spyOn(bindings, "getSpace");

        // Starting condition 1: runtime-local state is absent/destroyed.
        bindings.destroyRuntimeLocalState(routeName);
        const beforeDestroyedRecovery = await completeCanonicalSnapshot(tools, environment);
        const destroyedRecovery = await bindings.getSpace(routeName, scope).initialize(context);
        expect(destroyedRecovery.disposition).toBe("rehydrated");
        expect(destroyedRecovery.state.projectionRevision).toBe(0n);
        expect(await completeCanonicalSnapshot(tools, environment)).toBe(beforeDestroyedRecovery);

        const requestBody = noOpBody();
        const first = await worker.fetch(request(requestBody));
        const repeated = await worker.fetch(request(requestBody));
        expect(first.status).toBe(200);
        expect(repeated.status).toBe(200);
        expect(routed.mock.calls.map(([name]) => name)).toEqual([routeName, routeName]);
        expect(await first.json()).toEqual({
          accepted: true,
          correlationId: "correlation-runtime",
          disposition: "unchanged",
        });
        expect(await repeated.json()).toEqual({
          accepted: true,
          correlationId: "correlation-runtime",
          disposition: "unchanged",
        });
        expect(await canonicalCounts(tools, environment)).toBe("1|1|1|correlation-runtime");
        expect(
          (
            await psqlQuery(tools, environment, "SELECT payload_hash FROM clockgrove.events")
          ).trim(),
        ).toBe(computePayloadHash({}));

        if (process.env.WAVE0_RECOVERY === "1") {
          await withRestoredHistory(
            fixture,
            async (restored: DatabaseFixture["environment"], proof: Record<string, unknown>) => {
              const restoredClient = new PersistentPsqlClient(tools.psql, {
                ...restored,
                PGUSER: "clockgrove_runtime",
              });
              await restoredClient.start();
              try {
                const restoredBindings = new LocalRuntimeOwnerBindings(
                  new PostgreSqlCanonicalRuntimeStateSource(restoredClient),
                  new PostgreSqlJournal(restoredClient),
                );
                const restoredWorker = new RuntimeWorker(
                  authenticationFixture().authenticator,
                  restoredBindings,
                );
                const before = await canonicalSnapshot(tools, restored);
                restoredBindings.destroyRuntimeLocalState(routeName);
                expect(
                  (await restoredBindings.getSpace(routeName, scope).initialize(context))
                    .disposition,
                ).toBe("rehydrated");
                expect(await canonicalSnapshot(tools, restored)).toBe(before);
                const duplicate = await restoredWorker.fetch(request(requestBody));
                expect(duplicate.status).toBe(200);
                expect(await duplicate.json()).toEqual({
                  accepted: true,
                  correlationId: "correlation-runtime",
                  disposition: "unchanged",
                });
                expect(await canonicalCounts(tools, restored)).toBe("1|1|1|correlation-runtime");
                expect(await canonicalSnapshot(tools, restored)).toBe(before);
                if (process.env.CI_EVIDENCE_DIR) {
                  await mkdir(process.env.CI_EVIDENCE_DIR, { recursive: true });
                  await writeFile(
                    path.join(process.env.CI_EVIDENCE_DIR, "local-recovery.json"),
                    JSON.stringify({
                      commit: execFileSync("git", ["rev-parse", "HEAD"], {
                        encoding: "utf8",
                      }).trim(),
                      tree: execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
                        encoding: "utf8",
                      }).trim(),
                      surface: "local/emulated RuntimeWorker over restored real PostgreSQL",
                      ...proof,
                      duplicateCounts: "1|1|1|correlation-runtime",
                      canonicalPreserved: true,
                      pending: [
                        "Native runtime-local loss",
                        "Actual missed/duplicate/reordered Queue or webhook effects",
                        "Hosted qualification",
                      ],
                    }),
                  );
                }
              } finally {
                await restoredClient.close();
              }
            },
          );
        }

        // Starting condition 2: persisted local placement/projection/epochs are stale.
        const stale: RuntimeLocalState = {
          ...destroyedRecovery.state,
          placement: {
            ...destroyedRecovery.state.placement,
            runtimeCellId: "stale-cell" as RuntimeLocalState["placement"]["runtimeCellId"],
            routingEpoch: 1n,
            authorityEpoch: 2n,
            fidelity: "dormant",
          },
          projectionRevision: 999n,
          partitionId: "stale-partition" as RuntimeLocalState["partitionId"],
          primaryStreamId: "stale-stream" as RuntimeLocalState["primaryStreamId"],
        };
        bindings.seedRuntimeLocalState(routeName, stale);
        const beforeStaleRecovery = await completeCanonicalSnapshot(tools, environment);
        const staleRecovery = await bindings.getSpace(routeName, scope).initialize(context);
        expect(staleRecovery.disposition).toBe("reconciled");
        expect(staleRecovery.state.placement.runtimeCellId).toBe("partition-runtime");
        expect(staleRecovery.state.placement.routingEpoch).toBe(7n);
        expect(staleRecovery.state.placement.authorityEpoch).toBe(7n);
        expect(staleRecovery.state.projectionRevision).toBe(1n);
        expect(await completeCanonicalSnapshot(tools, environment)).toBe(beforeStaleRecovery);
        expect((await bindings.getSpace(routeName, scope).initialize(context)).disposition).toBe(
          "unchanged",
        );
        expect(await canonicalCounts(tools, environment)).toBe("1|1|1|correlation-runtime");

        // Stale request epochs are rejected independently and prove no recovery behavior.
        const staleRouting = await worker.fetch(
          request({ ...requestBody, commandId: "command-stale-routing", routingEpoch: "6" }),
        );
        const staleAuthority = await worker.fetch(
          request({ ...requestBody, commandId: "command-stale-authority", authorityEpoch: "6" }),
        );
        expect([staleRouting.status, await staleRouting.json()]).toEqual([
          409,
          { error: "stale_epoch", kind: "routing" },
        ]);
        expect([staleAuthority.status, await staleAuthority.json()]).toEqual([
          409,
          { error: "stale_epoch", kind: "authority" },
        ]);
        expect(await canonicalCounts(tools, environment)).toBe("1|1|1|correlation-runtime");
      } finally {
        await client.close();
      }
    });
  }, 60_000);
});

interface DatabaseFixture {
  readonly tools: { readonly psql: string };
  readonly environment: Readonly<Record<string, string>>;
}

function request(body: Record<string, unknown>, credential = "valid"): Request {
  return new Request("http://runtime.test/v1/runtime/no-op", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${credential}` },
    body: JSON.stringify(body),
  });
}

function noOpBody(): Record<string, unknown> {
  return {
    tenantId: "tenant-runtime",
    worldId: "world-runtime",
    timelineId: "timeline-runtime",
    spaceId: "space-runtime",
    commandId: "command-runtime-no-op",
    actionId: "action-runtime-no-op",
    eventId: "event-runtime-no-op",
    authorityDecisionId: "authority-runtime-no-op",
    routingEpoch: "7",
    authorityEpoch: "7",
    expectedProjectionRevision: "0",
    issuedAt: "2026-10-01T00:00:00.000Z",
  };
}

async function canonicalCounts(
  tools: DatabaseFixture["tools"],
  environment: DatabaseFixture["environment"],
) {
  return (
    await psqlQuery(
      tools,
      environment,
      `SELECT
         (SELECT count(*) FROM clockgrove.command_receipts
           WHERE tenant_id = 'tenant-runtime' AND command_id = 'command-runtime-no-op'),
         (SELECT count(*) FROM clockgrove.events
           WHERE tenant_id = 'tenant-runtime' AND command_id = 'command-runtime-no-op'),
         (SELECT count(*) FROM clockgrove.event_dispatches AS dispatch
           JOIN clockgrove.events AS event
             ON event.tenant_id = dispatch.tenant_id AND event.event_id = dispatch.event_id
          WHERE event.tenant_id = 'tenant-runtime'
            AND event.command_id = 'command-runtime-no-op'),
         (SELECT correlation_id FROM clockgrove.events
           WHERE tenant_id = 'tenant-runtime' AND command_id = 'command-runtime-no-op')`,
    )
  ).trim();
}

class PersistentPsqlClient implements PostgreSqlClient {
  private child?: ChildProcessWithoutNullStreams;
  private output = "";
  private waiters: Array<() => void> = [];
  private sequence = 0;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly executable: string,
    private readonly environment: Readonly<Record<string, string>>,
  ) {}

  async start(): Promise<void> {
    this.child = spawn(
      this.executable,
      ["--no-psqlrc", "--quiet", "--set=ON_ERROR_STOP=1", "--tuples-only", "--no-align"],
      { env: { ...process.env, ...this.environment }, stdio: ["pipe", "pipe", "pipe"] },
    );
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.output += chunk;
      for (const wake of this.waiters.splice(0)) wake();
    });
  }

  query(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<{ readonly rows: readonly unknown[] }> {
    const operation = this.pending.then(() => this.runQuery(text, values));
    this.pending = operation.catch(() => undefined);
    return operation;
  }

  async close(): Promise<void> {
    if (this.child === undefined) return;
    this.child.stdin.end("\\q\n");
    await once(this.child, "exit");
  }

  private async runQuery(text: string, values: readonly unknown[]) {
    if (this.child === undefined) throw new Error("psql client was not started");
    const marker = `clockgrove_query_${this.sequence++}`;
    const sql = interpolate(text, values);
    const control = /^(?:BEGIN|COMMIT|ROLLBACK)$/u.test(sql.trim());
    const statement = control
      ? `${sql};\n\\echo ${marker}\n`
      : `COPY (SELECT encode(convert_to(row_to_json(clockgrove_row)::text, 'UTF8'), 'hex') FROM (${sql}) AS clockgrove_row) TO STDOUT;\n\\echo ${marker}\n`;
    this.child.stdin.write(statement);
    const captured = await this.readThrough(marker);
    if (control) return { rows: [] };
    return {
      rows: captured
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => /^(?:[0-9a-f]{2})+$/u.test(line))
        .map((line) => JSON.parse(Buffer.from(line, "hex").toString("utf8")) as unknown),
    };
  }

  private async readThrough(marker: string): Promise<string> {
    for (;;) {
      const index = this.output.indexOf(`${marker}\n`);
      if (index >= 0) {
        const captured = this.output.slice(0, index);
        this.output = this.output.slice(index + marker.length + 1);
        return captured;
      }
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
}

function interpolate(text: string, values: readonly unknown[]): string {
  return text.replace(/\$(\d+)/gu, (_match, digits: string) =>
    sqlLiteral(values[Number(digits) - 1]),
  );
}

function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (value instanceof Uint8Array) {
    return `decode('${Buffer.from(value).toString("hex")}', 'hex')`;
  }
  return `'${String(value).replaceAll("'", "''")}'`;
}

const seedSql = `
INSERT INTO clockgrove.tenants (tenant_id, display_name)
VALUES ('tenant-runtime', 'Runtime Test');
INSERT INTO clockgrove.tenant_principals (tenant_id, principal_id)
VALUES ('tenant-runtime', 'principal-runtime');
INSERT INTO clockgrove.worlds (tenant_id, world_id, lifecycle_status)
VALUES ('tenant-runtime', 'world-runtime', 'ready');
INSERT INTO clockgrove.timelines (tenant_id, world_id, timeline_id)
VALUES ('tenant-runtime', 'world-runtime', 'timeline-runtime');
INSERT INTO clockgrove.timeline_partitions (
  tenant_id, world_id, timeline_id, partition_id, space_id, routing_epoch
) VALUES (
  'tenant-runtime', 'world-runtime', 'timeline-runtime', 'partition-runtime', 'space-runtime', 7
);
INSERT INTO clockgrove.streams (
  tenant_id, world_id, timeline_id, partition_id, space_id, stream_id
) VALUES (
  'tenant-runtime', 'world-runtime', 'timeline-runtime', 'partition-runtime',
  'space-runtime', 'stream-runtime'
);`;
