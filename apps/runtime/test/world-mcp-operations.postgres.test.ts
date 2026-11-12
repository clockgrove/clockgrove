import { decodeCanonicalNode } from "@clockgrove/application";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";
import type { RuntimeStateView } from "../src/inspector.js";
import { handleWorldMcpRequest } from "../src/world-mcp-server.js";
import { advanceCommand } from "./world-fixture.js";
import {
  canonicalResponse,
  isNativeWorldOwnerChild,
  runNativeWorldOwnerProcess,
  waitForOwnerSql,
  withNativeWorldOwner,
} from "./world-owner/native-harness.js";

const FILE = "apps/runtime/test/world-mcp-operations.postgres.test.ts";
it.skipIf(isNativeWorldOwnerChild())(
  "owns MCP operator client/native PostgreSQL proof",
  async () => runNativeWorldOwnerProcess(FILE, "fixture", { queues: true }),
  240_000,
);
it.skipIf(!isNativeWorldOwnerChild())(
  "keeps MCP operator authority canonical and changesets unavailable",
  async () => {
    await withNativeWorldOwner(async (owner) => {
      let credential = "local-reader-session";
      const paths: string[] = [];
      const application = {
        async fetch(request: Request) {
          const path = new URL(request.url).pathname;
          paths.push(path);
          const response = await owner.request(
            path,
            await request.json(),
            request.headers.get("authorization")!.slice(7),
          );
          return Response.json(response.body, { status: response.status });
        },
      };
      const client = new Client(
        { name: "fixture-operator", version: "1.0.0" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } },
      );
      const transport = new StreamableHTTPClientTransport(
        new URL("https://world-mcp.internal/mcp"),
        {
          authProvider: { token: async () => credential },
          fetch: async (url, init) => handleWorldMcpRequest(application, new Request(url, init)),
        },
      );
      const call = async (name: string, args: Record<string, unknown>) => {
        const result = await client.callTool({ name, arguments: args });
        return {
          error: result.isError === true,
          value: JSON.parse((result.content as { text: string }[])[0]!.text),
        };
      };
      const scope = { schemaVersion: 1, ...owner.scope };
      const action = {
        ...scope,
        action: "repair-publication",
        messageId: "mcp-repair:dispatch:world-reactions",
      };
      const refused = {
        error: true,
        value: { ok: false, status: 403, code: "authorization_refused" },
      };
      try {
        await client.connect(transport);
        const catalog = (await client.listTools()).tools;
        expect(
          catalog.slice(6).map(({ name, annotations }) => [name, annotations?.readOnlyHint]),
        ).toEqual([
          ["runtime_state", true],
          ["runtime_action", false],
          ["changeset_prepare", true],
          ["changeset_apply", true],
        ]);
        expect(catalog.every(({ inputSchema }) => inputSchema.additionalProperties === false)).toBe(
          true,
        );
        expect(await call("runtime_state", scope)).toEqual(refused);
        expect(await call("runtime_action", action)).toEqual(refused);
        expect(await call("runtime_action", { ...action, action: "replay-message" })).toEqual(
          refused,
        );
        await owner.sql(
          "UPDATE clockgrove.world_memberships SET grants=array_append(grants,'runtime:world-inspect')",
        );
        const view = await call("runtime_state", scope);
        expect(view.error).toBe(false);
        expect(
          (decodeCanonicalNode(canonicalResponse(view.value.value)) as RuntimeStateView).authority,
        ).toBe("journal");
        expect(await call("runtime_action", action)).toEqual(refused);
        await owner.sql(
          "UPDATE clockgrove.world_memberships SET grants=array_append(grants,'runtime:world-operate')",
        );
        // Force an actual Queue publication failure, then recover it through the MCP action.
        await owner.sql(
          `CREATE FUNCTION clockgrove.mcp_oversize() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.dispatch_id='${action.messageId}' THEN NEW.payload := NEW.payload || jsonb_build_object('pad', repeat('x', 130000)); END IF; RETURN NEW; END $$; CREATE TRIGGER mcp_oversize BEFORE INSERT ON clockgrove.event_dispatches FOR EACH ROW EXECUTE FUNCTION clockgrove.mcp_oversize()`,
        );
        const advance = await owner.submit(
          advanceCommand(owner.world, "mcp-repair", 120_000n, null),
        );
        expect(advance.status, JSON.stringify(advance.body)).toBe(200);
        // The post-commit hint uses waitUntil; the command response does not settle attempt one.
        await waitForOwnerSql(
          owner.sql,
          `SELECT status || '|' || attempts FROM clockgrove.event_dispatches WHERE dispatch_id='${action.messageId}'`,
          "pending|1",
          500,
        );
        for (let attempt = 2; attempt <= 4; attempt++) {
          await owner.sql(
            `UPDATE clockgrove.event_dispatches SET next_attempt_at=now()-interval '1 second' WHERE dispatch_id='${action.messageId}'`,
          );
          await owner.reconcileDispatches();
        }
        expect(
          await owner.sql(
            `SELECT status || '|' || attempts FROM clockgrove.event_dispatches WHERE dispatch_id='${action.messageId}'`,
          ),
        ).toBe("failed|4");
        await owner.sql(
          "DROP TRIGGER mcp_oversize ON clockgrove.event_dispatches; DROP FUNCTION clockgrove.mcp_oversize(); UPDATE clockgrove.event_dispatches SET payload=payload-'pad'",
        );
        expect(await call("runtime_action", action)).toEqual({
          error: false,
          value: {
            ok: true,
            status: 200,
            value: {
              action: "repair-publication",
              messageId: action.messageId,
              outcome: "repaired",
            },
          },
        });
        expect(
          await owner.sql(
            `SELECT status || '|' || attempts FROM clockgrove.event_dispatches WHERE dispatch_id='${action.messageId}'`,
          ),
        ).toBe("pending|4");
        expect(
          await owner.sql(
            "SELECT principal_id || '|' || action || '|' || decision || '|' || reason_code FROM clockgrove.runtime_operator_actions WHERE reason_code='repaired'",
          ),
        ).toBe("principal-runtime|repair-publication|allow|repaired");
        credential = "outsider-session-token";
        expect(await call("runtime_state", scope)).toEqual(refused);
        expect(await call("runtime_action", action)).toEqual(refused);
        credential = "local-reader-session";
        await owner.sql(
          "UPDATE clockgrove.world_memberships SET grants=array_remove(grants,'runtime:world-operate')",
        );
        expect(await call("runtime_action", action)).toEqual(refused);
        for (const name of ["changeset_prepare", "changeset_apply"]) {
          const before = paths.length;
          expect(await call(name, scope)).toEqual({
            error: true,
            value: { ok: false, status: 409, code: "changesets_unavailable_until_wave_7" },
          });
          expect(paths.slice(before)).toEqual(["/v1/runtime/world-directory"]);
          expect(await call(name, { ...scope, payload: "private-canary" })).toEqual({
            error: true,
            value: { ok: false, status: 400, code: "invalid_tool_input" },
          });
        }
        expect(
          await call("runtime_action", { ...action, messageId: "x".repeat(65 * 1024) }),
        ).toEqual({ error: true, value: { ok: false, status: 400, code: "invalid_tool_input" } });
        expect(await call("runtime_action", { ...action, action: "grant-access" })).toEqual({
          error: true,
          value: { ok: false, status: 400, code: "invalid_tool_input" },
        });
        await owner.sql("DELETE FROM clockgrove_auth.session WHERE token='local-reader-session'");
        await expect(
          client.callTool({ name: "changeset_apply", arguments: scope }),
        ).rejects.toThrow();
      } finally {
        await client.close();
      }
    });
  },
  180_000,
);
