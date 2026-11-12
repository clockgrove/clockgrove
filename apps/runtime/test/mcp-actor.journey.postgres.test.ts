import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type {
  McpBinding,
  McpDiscoverySnapshot,
  McpNetworkPort,
  RuntimeAuthorizationContext,
} from "@clockgrove/application";
import {
  decodeConversationSession,
  decodeOpaqueId,
  decodePrivacyCeiling,
  decodeTalkReceipt,
  type RunWalk,
} from "@clockgrove/contracts";
import {
  PostgreSqlMcpBindings,
  PostgreSqlMcpInstallations,
  PostgreSqlWorldAuthorizationReader,
  withClientTransaction,
} from "@clockgrove/persistence";
import { expect, it } from "vitest";
import { actorSystem } from "../src/actor-model.js";
import { McpRuntimeOperator, openPostgreSqlMcpProvider } from "../src/mcp.js";
import {
  readActorMcpCapabilities,
  resolveActorCapabilities,
} from "../src/mcp-actor-capabilities.js";
import { TrustedRuntimeRequestAuthenticator } from "../src/trusted-composition.js";
import { RuntimeWorker } from "../src/worker.js";
import { sessionStoreAuthentication } from "./living-hall-fixture.js";
import { connect } from "./world-fixture.js";
import {
  isNativeWorldOwnerChild,
  runNativeWorldOwnerProcess,
  withNativeWorldOwner,
} from "./world-owner/native-harness.js";

const FILE = "apps/runtime/test/mcp-actor.journey.postgres.test.ts";
const ACTOR = "fixture.keeper";
const REMOTE = `mcp:fixture:lookup:2025-11-25:${"1".repeat(64)}`;
it.skipIf(isNativeWorldOwnerChild())(
  "owns PostgreSQL and workerd",
  async () => {
    await runNativeWorldOwnerProcess(FILE, "fixture/reference", {
      prepare: async (fixture) => {
        const { truthOf } = await import("./world-fixture.js");
        await truthOf(fixture)(`UPDATE clockgrove.world_memberships SET
        grants=grants||ARRAY['runtime:world-observe'],
        privacy_ceiling='{"version":1,"allowedCategories":["public_scene","conversation","operator_evidence"]}'`);
      },
    });
  },
  240_000,
);
it.skipIf(!isNativeWorldOwnerChild())(
  "refreshes canonical MCP admission before actor use without executing remote tools",
  async () => {
    await withNativeWorldOwner(async (owner) => {
      const post = (path: string, fields: object) =>
        owner.request(path, { version: 1, ...owner.scope, ...fields });
      const sessionId = decodeConversationSession(
        (await post("/v1/runtime/conversations/create", { actorId: ACTOR })).body,
      ).sessionId;
      const authorization: RuntimeAuthorizationContext = {
        tenantId: decodeOpaqueId(owner.scope.tenantId, "TenantId"),
        principalId: decodeOpaqueId("principal-runtime", "PrincipalId"),
        privacyCeiling: decodePrivacyCeiling({
          version: 1,
          allowedCategories: ["conversation", "operator_evidence"],
        }),
      };
      const route = JSON.parse(
        await owner.sql(
          `SELECT jsonb_build_object('partitionId',partition_id,'streamId',stream_id,'spaceId',space_id)::text FROM clockgrove.streams WHERE world_id='${owner.scope.worldId}' AND space_id<>'${owner.scope.spaceId}' ORDER BY stream_id LIMIT 1`,
        ),
      );
      const scope = { ...owner.scope, ...route };
      expect(scope.spaceId).not.toBe(owner.scope.spaceId);
      await owner.sql(`INSERT INTO clockgrove.world_memberships
        SELECT tenant_id,world_id,timeline_id,'${scope.spaceId}',principal_id,membership_id,persona_id,roles,grants,privacy_ceiling,committed_at,revoked_at
        FROM clockgrove.world_memberships WHERE principal_id='principal-runtime' AND space_id='${owner.scope.spaceId}' ON CONFLICT DO NOTHING`);
      const context = {
        ...owner.scope,
        actorId: ACTOR,
        sessionId,
        runtimeGrants: ["runtime:world-observe"],
      };
      const read = () =>
        owner.withSqlClient((client) => readActorMcpCapabilities(client, authorization, context));
      const snapshot: McpDiscoverySnapshot = {
        protocolVersion: "2025-11-25",
        serverIdentity: { name: "fixture" },
        protocolMetadata: { tools: {} },
        candidates: [
          {
            kind: "tool",
            id: "lookup",
            schemaHash: "1".repeat(64),
            schema: {
              type: "object",
              properties: {
                type: { type: "string" },
                objectId: { type: "string" },
                kind: { type: "string" },
              },
            },
            metadata: {},
            enabled: false,
            effectClass: "external-write",
          },
        ],
      };
      const binding: McpBinding = {
        bindingId: "actor-allow",
        installationId: "fixture",
        candidateId: "lookup",
        schemaHash: "1".repeat(64),
        protocolVersion: "2025-11-25",
        scopeType: "actor",
        scopeId: ACTOR,
        effect: "allow",
        enabled: true,
        constraints: { callsPerTurn: 1, effectClasses: ["read"] },
      };
      // Only governance runs with the installing operator grant. Actor turns remain ordinary members.
      const govern = async (
        operation: (
          installations: PostgreSqlMcpInstallations,
          bindings: PostgreSqlMcpBindings,
        ) => Promise<unknown>,
        notify = true,
      ) => {
        await owner.sql(
          "UPDATE clockgrove.world_memberships SET grants=array_append(grants,'runtime:mcp-install')",
        );
        try {
          await owner.withSqlClient((client) =>
            operation(new PostgreSqlMcpInstallations(client), new PostgreSqlMcpBindings(client)),
          );
          const targets = await owner.withSqlClient((client) =>
            withClientTransaction(client, { authorization }, async () => {
              const result = await client.query(
                "SELECT clockgrove.mcp_actor_revision_targets($1,$2,$3,$4) AS targets",
                [owner.scope.tenantId, owner.scope.worldId, owner.scope.timelineId, scope.spaceId],
              );
              return (result.rows[0] as { targets: { revision: string; actorIds: string[] } })
                .targets;
            }),
          );
          expect(targets.actorIds).toEqual([ACTOR]);
          if (notify)
            for (const actorId of targets.actorIds) {
              expect(
                (
                  await post("/actor-agent", {
                    scope: owner.scope,
                    actorId,
                    op: "capabilities",
                    revision: Number(targets.revision),
                  })
                ).status,
              ).toBe(200);
            }
        } finally {
          await owner.sql(
            "UPDATE clockgrove.world_memberships SET grants=array_remove(grants,'runtime:mcp-install')",
          );
        }
      };
      const issued = "2026-11-10T00:00:00.000Z";
      await govern(async (installations, bindings) => {
        await installations.change(
          authorization,
          scope,
          {
            action: "install",
            installationId: "fixture",
            url: "https://fixture.example/mcp",
            snapshot,
          },
          "actor-install",
          issued,
        );
        await installations.change(
          authorization,
          scope,
          {
            action: "review",
            installationId: "fixture",
            candidateId: "lookup",
            schemaHash: "1".repeat(64),
            protocolVersion: "2025-11-25",
            enabled: true,
            effectClass: "read",
          },
          "actor-review",
          issued,
        );
        await bindings.change(authorization, scope, binding, "actor-bind", issued);
      });
      expect(
        (await post("/actor-agent", { scope: owner.scope, actorId: ACTOR, op: "inspect" })).body,
      ).toMatchObject({ recovery: { capabilityRevision: 3 } });
      expect(
        (await post("/actor-agent", { scope: owner.scope, actorId: ACTOR, op: "model-calls" }))
          .body,
      ).toBe(0);
      const admission = await read();
      const hosted = await resolveActorCapabilities(
        "production",
        context.runtimeGrants,
        async () => {
          throw new Error("hosted actor must not read remote admission");
        },
      );
      expect(hosted.registry.names()).toEqual(
        "delivery.request inspect why world.command".split(" "),
      );
      expect(hosted.grants.available()).toEqual(["inspect", "why"]);
      expect(hosted.grants.authorize({ capability: REMOTE, input: {} })).toEqual({
        accepted: false,
        code: "unknown_capability",
      });
      expect(admission.revision).toBe(3);
      expect(admission.registry.names()).toEqual(
        `delivery.request inspect ${REMOTE} why world.command`.split(" "),
      );
      expect(admission.grants.available()).toEqual(["inspect", "why", REMOTE]);
      const say = async (messageId: string) => {
        const response = await post("/v1/runtime/talk", {
          sessionId,
          messageId,
          text: `fixture:call ${REMOTE} resource.offer`,
        });
        expect(response.status).toBe(200);
        return decodeTalkReceipt(response.body);
      };
      expect((await say("admitted")).command).toMatchObject({
        capability: REMOTE,
        code: "not_executable",
        commandId: null,
      });
      const agent = (fields: object) =>
        post("/actor-agent", { scope: owner.scope, actorId: ACTOR, ...fields });
      await agent({ op: "fault", phase: "proposal_validating" });
      expect(
        (
          await post("/v1/runtime/talk", {
            sessionId,
            messageId: "revoked",
            text: `fixture:call ${REMOTE} resource.offer`,
          })
        ).status,
      ).toBe(503);
      await govern(async (_installations, bindings) => {
        await bindings.change(
          authorization,
          scope,
          { ...binding, enabled: false },
          "actor-unbind",
          issued,
        );
      }, false);
      // No revision notification is delivered: the restarted owner's canonical read fences new use.
      expect((await say("revoked")).command).toMatchObject({
        capability: REMOTE,
        code: "not_granted",
        commandId: null,
      });
      expect((await agent({ op: "model-calls" })).body).toBe(2);
      expect((await agent({ op: "inspect" })).body).toMatchObject({
        recovery: { capabilityRevision: 4 },
      });
      expect((await read()).grants.available()).toEqual(["inspect", "why"]);
      await expect(
        owner.withSqlClient((client) =>
          readActorMcpCapabilities(client, authorization, { ...context, actorId: "other-actor" }),
        ),
      ).rejects.toMatchObject({ code: "42501" });
      expect(
        await owner.sql(
          "SELECT count(*) FROM clockgrove.command_receipts WHERE command_id LIKE 'actor:%'",
        ),
      ).toBe("0");
    });
  },
  240_000,
);
it.skipIf(!isNativeWorldOwnerChild())(
  "keeps an owned credential out of actor prompts, populated run evidence, R2 keys and allocated owner names",
  async () => {
    await withNativeWorldOwner(async (owner) => {
      const canary = "actor-install-secret-canary";
      const outputs: unknown[] = [];
      const logs: unknown[] = [];
      let fail = false;
      let credentialRequests = 0;
      const server = createServer(async (request, response) => {
        let body = "";
        for await (const chunk of request) body += chunk;
        if (request.headers.authorization !== `Bearer ${canary}`) {
          response.writeHead(401);
          response.end();
          return;
        }
        credentialRequests++;
        if (fail) {
          response.writeHead(500, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: canary }));
          return;
        }
        const rpc = JSON.parse(body);
        if (rpc.method === "notifications/initialized") {
          response.writeHead(202);
          response.end();
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: rpc.id,
            result:
              rpc.method === "initialize"
                ? {
                    protocolVersion: "2025-11-25",
                    serverInfo: { name: "credential-fixture", version: "1" },
                    capabilities: { tools: {} },
                  }
                : {
                    tools: [
                      {
                        name: "lookup",
                        inputSchema: {
                          type: "object",
                          properties: {
                            type: { type: "string" },
                            objectId: { type: "string" },
                            kind: { type: "string" },
                          },
                        },
                      },
                    ],
                  },
          }),
        );
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const network: McpNetworkPort = {
        resolve: async () => ["93.184.216.34"],
        request: (url, init) => fetch(`${origin}${new URL(url).pathname}`, init),
      };
      const key = await crypto.subtle.importKey(
        "raw",
        new Uint8Array(32).fill(7),
        "AES-GCM",
        false,
        ["encrypt", "decrypt"],
      );
      const operator = new McpRuntimeOperator({
        withClient: (operation) => owner.withSqlClient(operation),
        network,
        maxInstallations: 1,
        changed: async () => undefined,
        oauthClient: () => {
          throw new Error("static credential fixture");
        },
        openProvider: async (scope) => {
          const secret = connect(owner.fixture.environment, "clockgrove", "clockgrove_admin");
          await secret.query("SET ROLE clockgrove_mcp_secrets");
          return openPostgreSqlMcpProvider(
            secret,
            scope,
            { activeVersion: "v1", keys: new Map([["v1", key]]) },
            network,
          );
        },
      });
      const auth = new TrustedRuntimeRequestAuthenticator({
        ...sessionStoreAuthentication(owner.fixture.environment),
        workspace: { resolveWorkspace: async () => undefined },
        world: {
          resolveWorld: (principal, scope) =>
            owner.withSqlClient((client) =>
              new PostgreSqlWorldAuthorizationReader(client).resolveWorld(principal, scope),
            ),
        },
        codeVersion: "fixture",
        requestMetadata: () => ({
          requestId: crypto.randomUUID(),
          correlationId: decodeOpaqueId(crypto.randomUUID(), "CorrelationId"),
        }),
      });
      const worker = new RuntimeWorker(
        auth,
        {
          mcp: operator,
          getSpace: () => {
            throw new Error("unexpected owner");
          },
        },
        { log: (record) => logs.push(record) },
      );
      let sequence = 0;
      const mcp = async (action: string, fields: object = {}) => {
        await owner.sql(
          "UPDATE clockgrove.world_memberships SET grants=array_append(grants,'runtime:mcp-install')",
        );
        try {
          const response = await worker.fetch(
            new Request(`https://operator.example/v1/runtime/mcp/${action}`, {
              method: "POST",
              headers: {
                authorization: `Bearer ${"local-reader-session"}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                ...owner.scope,
                commandId: `canary-op-${++sequence}`,
                installationId: "credential",
                ...fields,
              }),
            }),
          );
          const body = await response.json();
          outputs.push(body);
          return { status: response.status, body };
        } finally {
          await owner.sql(
            "UPDATE clockgrove.world_memberships SET grants=array_remove(grants,'runtime:mcp-install')",
          );
        }
      };
      const post = (path: string, fields: object) =>
        owner.request(path, { version: 1, ...owner.scope, ...fields });
      try {
        expect(
          await mcp("connect-static", { url: "https://fixture.example/mcp", token: canary }),
        ).toEqual({ status: 200, body: { ok: true } });
        const listed = await mcp("list");
        const candidate = (
          listed.body as { installations: { snapshot: McpDiscoverySnapshot }[] }
        ).installations.find((row) => row.snapshot.serverIdentity.name === "credential-fixture")!
          .snapshot.candidates[0]!;
        expect(
          (
            await mcp("review", {
              candidateId: candidate.id,
              schemaHash: candidate.schemaHash,
              protocolVersion: "2025-11-25",
              enabled: true,
              effectClass: "read",
            })
          ).status,
        ).toBe(200);
        expect(
          (
            await mcp("bind", {
              binding: {
                bindingId: "credential-actor",
                installationId: "credential",
                candidateId: candidate.id,
                schemaHash: candidate.schemaHash,
                protocolVersion: "2025-11-25",
                scopeType: "actor",
                scopeId: ACTOR,
                effect: "allow",
                enabled: true,
                constraints: { callsPerTurn: 1, effectClasses: ["read"] },
              },
            })
          ).status,
        ).toBe(200);
        expect((await mcp("refresh")).status).toBe(200);
        expect(credentialRequests).toBe(6);
        const sessionId = decodeConversationSession(
          (await post("/v1/runtime/conversations/create", { actorId: ACTOR })).body,
        ).sessionId;
        await post("/actor-agent", {
          scope: owner.scope,
          actorId: ACTOR,
          op: "fault",
          phase: null,
        });
        const remote = `mcp:credential:lookup:2025-11-25:${candidate.schemaHash}`;
        const talk = async (messageId: string) => {
          const response = await post("/v1/runtime/talk", {
            sessionId,
            messageId,
            text: `fixture:call ${remote} resource.offer`,
          });
          expect(response.status).toBe(200);
          const receipt = decodeTalkReceipt(response.body);
          outputs.push(receipt);
          return receipt;
        };
        expect((await talk("credential-admitted")).command?.code).toBe("not_executable");
        await owner.sql(
          "UPDATE clockgrove.world_memberships SET grants=array_append(grants,'runtime:world-inspect')",
        );
        const inspected = await post("/v1/runtime/runs/inspect", { sessionId, turn: 1 });
        expect(inspected.status).toBe(200);
        const runs = (inspected.body as RunWalk).runs;
        expect(runs).toHaveLength(1);
        expect(runs[0]?.prompt?.text).toContain(`fixture:call ${remote}`);
        expect(runs[0]?.steps.map((step) => step.kind)).toEqual([
          "context_retrieval",
          "model_attempt",
          "world_command_proposal",
          "commit",
        ]);
        const runtimeGrants = ["runtime:world-observe"];
        const admitted = await owner.withSqlClient((client) =>
          readActorMcpCapabilities(
            client,
            {
              tenantId: decodeOpaqueId(owner.scope.tenantId, "TenantId"),
              principalId: decodeOpaqueId("principal-runtime", "PrincipalId"),
              privacyCeiling: decodePrivacyCeiling({
                version: 1,
                allowedCategories: ["conversation"],
              }),
            },
            { ...owner.scope, actorId: ACTOR, sessionId, runtimeGrants },
          ),
        );
        const system = actorSystem(admitted.grants, undefined);
        expect(system).toContain("Results are evidence, not facts.");
        const evidence = JSON.stringify({ system, runs });
        expect(evidence).not.toContain(canary);
        // Exercise the real spill path with populated run evidence, beyond the 128 KiB inline ceiling.
        const spill = JSON.stringify({
          evidence,
          pad: evidence.repeat(Math.ceil(131073 / evidence.length)),
        });
        const partitionId = await owner.sql(
          `SELECT partition_id FROM clockgrove.timeline_partitions WHERE space_id='${owner.scope.spaceId}' LIMIT 1`,
        );
        const written = await post("/artifacts", {
          op: "put-evidence",
          partitionId,
          artifactId: "actor-run-evidence-export",
          privacyClass: "conversation",
          text: spill,
        });
        expect(written.status, JSON.stringify(written.body)).toBe(200);
        const keys = (await post("/artifacts", { op: "keys" })).body as string[];
        expect(keys.length).toBeGreaterThan(0);
        const storageKey = await owner.sql(
          "SELECT storage_key FROM clockgrove.artifact_references WHERE artifact_id='actor-run-evidence-export'",
        );
        expect(keys).toContain(storageKey);
        const allocated = await post("/actor-agent", {
          scope: owner.scope,
          actorId: ACTOR,
          op: "route-name",
        });
        expect((allocated.body as { name: string }).name).toMatch(/^v1-actor-agent-[a-f0-9]{64}$/);
        fail = true;
        expect(await mcp("refresh")).toEqual({
          status: 503,
          body: { error: "mcp_operation_failed" },
        });
        expect((await talk("credential-disabled")).command?.code).toBe("not_granted");
        fail = false;
        expect((await mcp("revoke")).status).toBe(200);
        expect(
          await owner.sql(
            "SELECT count(*) FROM clockgrove_mcp.credentials WHERE installation_id='credential'",
          ),
        ).toBe("1");
        expect(credentialRequests).toBe(7);
        const canonical = await owner.durable();
        expect(canonical).toContain("McpInstallation");
        const runRows = await owner.sql(
          `SELECT jsonb_agg(to_jsonb(r))::text FROM clockgrove.agent_runs r WHERE session_id='${sessionId}'`,
        );
        expect(JSON.parse(runRows)).toHaveLength(2);
        expect(
          JSON.stringify([
            evidence,
            keys,
            allocated.body,
            outputs,
            logs,
            owner.logs(),
            canonical,
            runRows,
          ]),
        ).not.toContain(canary);
      } finally {
        await owner.sql(
          "UPDATE clockgrove.world_memberships SET grants=array_append(grants,'runtime:mcp-install')",
        );
        await operator.close();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    });
  },
  240_000,
);
