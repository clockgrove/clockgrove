import {
  decodeCanonicalNode,
  encodeCanonicalNode,
  NO_PRIVACY_CEILING,
} from "@clockgrove/application";
import { decodeOpaqueId } from "@clockgrove/contracts";
import { PostgreSqlWorldAuthorizationReader } from "@clockgrove/persistence";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";
import { TrustedRuntimeRequestAuthenticator } from "../src/trusted-composition.js";
import { RuntimeWorker } from "../src/worker.js";
import { PostgreSqlCommandOwner } from "../src/world-commands.js";
import { handleWorldMcpRequest } from "../src/world-mcp-server.js";
import { sessionStoreAuthentication } from "./living-hall-fixture.js";
import { advanceCommand, withClient } from "./world-fixture.js";
import {
  isNativeWorldOwnerChild,
  runNativeWorldOwnerProcess,
  withNativeWorldOwner,
} from "./world-owner/native-harness.js";

const FILE = "apps/runtime/test/world-mcp-commands.postgres.test.ts";
it.skipIf(isNativeWorldOwnerChild())(
  "owns SDK, runtime and PostgreSQL command proof",
  async () => runNativeWorldOwnerProcess(FILE, "fixture/reference"),
  240_000,
);
it.skipIf(!isNativeWorldOwnerChild())(
  "submits ordinary commands with trusted MCP provenance, exact retries and current inspector authority",
  async () => {
    await withNativeWorldOwner(async (native) => {
      await native.sql(
        "UPDATE clockgrove.world_memberships SET persona_id='persona-mcp', grants=array_append(grants,'runtime:world-observe')",
      );
      const environment = native.fixture.environment;
      const authentication = sessionStoreAuthentication(environment);
      const authenticator = new TrustedRuntimeRequestAuthenticator({
        ...authentication,
        workspace: { resolveWorkspace: async () => undefined },
        world: {
          resolveWorld: (principal, scope) =>
            withClient(
              environment,
              (client) =>
                new PostgreSqlWorldAuthorizationReader(client).resolveWorld(principal, scope),
              "clockgrove",
              "clockgrove_world_reader",
            ),
        },
        codeVersion: "mcp-command-proof",
        requestMetadata: () => ({
          requestId: "mcp-command",
          correlationId: decodeOpaqueId("mcp-command", "CorrelationId"),
        }),
      });
      const commandOwner = <T>(run: (owner: PostgreSqlCommandOwner) => Promise<T>) =>
        native.withSqlClient((client) => run(new PostgreSqlCommandOwner(client)));
      const worker = new RuntimeWorker(authenticator, {
        getSpace: () => {
          throw new Error("world command uses its ordinary owner");
        },
        worldCommands: {
          prepare: (input, principalId) =>
            commandOwner(async (owner) => {
              const authorization = {
                tenantId: input.scope.tenantId,
                principalId,
                privacyCeiling: NO_PRIVACY_CEILING,
              };
              if (!(await owner.reader.isTenantMember(authorization, input.scope)))
                return { tenantMember: false, ready: false };
              const stored = await owner.stored(input, principalId);
              return {
                tenantMember: true,
                ready: await owner.reader.isReady(authorization, input.scope),
                ...(stored && { stored }),
              };
            }),
          submit: (input, context) => commandOwner((owner) => owner.submit(input, context)),
          deny: (input, principal, denial) =>
            commandOwner((owner) => owner.deny(input, principal, denial)),
        },
      });
      let credential = "local-reader-session";
      const application = {
        fetch: async (request: Request) => {
          const result = await native.request(
            new URL(request.url).pathname,
            await request.json(),
            request.headers.get("authorization")!.slice(7),
          );
          return Response.json(result.body, { status: result.status });
        },
        submitCommand: (request: Request) =>
          worker.fetchMcpCommand(request, "member-key:fixture-key"),
      };
      const client = new Client(
        { name: "untrusted-client-name", version: "1.0" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } },
      );
      await client.connect(
        new StreamableHTTPClientTransport(new URL("https://world-mcp.internal/mcp"), {
          authProvider: { token: async () => credential },
          fetch: (url, init) => handleWorldMcpRequest(application, new Request(url, init)),
        }),
      );
      const call = async (name: string, args: Record<string, unknown>) => {
        const result = await client.callTool({ name, arguments: args });
        return JSON.parse((result.content as { text: string }[])[0]!.text);
      };
      const command = (id: string, target: bigint) => ({
        schemaVersion: 1,
        ...native.scope,
        routingEpoch: "1",
        authorityEpoch: "1",
        command: encodeCanonicalNode({
          ...advanceCommand(native.world, id, target, null),
          attribution: {
            effectiveActorId: "spoofed-actor",
            initiatorId: "spoofed-persona",
            channel: "spoofed-channel",
            causalRootActionId: "preserved-causal-root",
          },
        }),
      });
      try {
        const first = command(
          "mcp-command-commit",
          native.world.birth.state.simulationTime + 1000n,
        );
        const committed = await call("command_submit", first);
        expect(committed).toMatchObject({ ok: true, status: 200 });
        expect(decodeCanonicalNode(committed.value)).toMatchObject({
          commandId: "mcp-command-commit",
          outcome: "committed",
        });
        const attribution = await native.sql(
          "SELECT attribution::text FROM clockgrove.command_receipts WHERE command_id='mcp-command-commit'",
        );
        expect(JSON.parse(attribution)).toMatchObject({
          principalId: "principal-runtime",
          personaId: "persona-mcp",
          initiatorId: "persona-mcp",
          effectiveActorId: "persona-mcp",
          channel: "mcp:member-key:fixture-key",
          causalRootActionId: "preserved-causal-root",
        });
        expect(await call("command_submit", first)).toEqual(committed);
        expect(
          await native.sql(
            "SELECT count(*) FROM clockgrove.command_receipts WHERE command_id='mcp-command-commit'",
          ),
        ).toBe("1");
        const refused = await call("command_submit", command("mcp-command-refused", 0n));
        expect(refused).toMatchObject({ ok: true, status: 409 });
        expect(decodeCanonicalNode(refused.value)).toMatchObject({
          outcome: "rejected",
          value: { status: "refused" },
        });
        expect(await call("command_submit", { ...first, channel: "forged" })).toEqual({
          ok: false,
          status: 400,
          code: "invalid_tool_input",
        });
        expect(
          await call("command_submit", { ...first, command: ["string", "x".repeat(65536)] }),
        ).toEqual({ ok: false, status: 400, code: "invalid_tool_input" });
        expect(
          await call("command_receipt", {
            schemaVersion: 1,
            ...native.scope,
            commandId: "mcp-command-commit",
          }),
        ).toEqual({ ok: false, status: 403, code: "authorization_refused" });
        await native.sql(
          "UPDATE clockgrove.world_memberships SET grants=array_append(grants,'runtime:world-inspect')",
        );
        expect(
          await call("command_receipt", {
            schemaVersion: 1,
            ...native.scope,
            commandId: "mcp-command-commit",
          }),
        ).toMatchObject({ ok: true, status: 200 });
        await native.sql(
          "UPDATE clockgrove.world_memberships SET grants=ARRAY['runtime:world-observe']",
        );
        const denied = await call("command_submit", command("mcp-command-denied", 2000n));
        expect(denied).toMatchObject({ ok: true, status: 403 });
        expect(decodeCanonicalNode(denied.value)).toMatchObject({
          outcome: "rejected",
          value: { status: "denied", reasonCode: "runtime-grant-missing" },
        });
        credential = "outsider-session-token";
        expect(await call("command_submit", command("mcp-command-outsider", 2000n))).toEqual({
          ok: false,
          status: 403,
          code: "authorization_refused",
        });
        expect(
          await native.sql(
            "SELECT count(*) FROM clockgrove.command_receipts WHERE command_id='mcp-command-outsider'",
          ),
        ).toBe("0");
      } finally {
        await client.close();
      }
    });
  },
  240_000,
);
