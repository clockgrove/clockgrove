import { decodeCanonicalNode } from "@clockgrove/application";
import { decodeConversationSession, decodeTalkReceipt, type RunWalk } from "@clockgrove/contracts";
import { expect, it } from "vitest";
import { readWorldMcpTool, WORLD_MCP_READ_TOOLS } from "../src/world-mcp-reads.js";
import {
  canonicalResponse,
  isNativeWorldOwnerChild,
  runNativeWorldOwnerProcess,
  withNativeWorldOwner,
} from "./world-owner/native-harness.js";

const FILE = "apps/runtime/test/world-mcp-reads.postgres.test.ts";
const MEMBER = "local-reader-session";
const OUTSIDER = "outsider-session-token";

it.skipIf(isNativeWorldOwnerChild())(
  "owns the first-party read adapter PostgreSQL and native runtime proof",
  async () => runNativeWorldOwnerProcess(FILE, "fixture/reference"),
  240_000,
);

it.skipIf(!isNativeWorldOwnerChild())(
  "reads only current member authority through bounded application tools and inspector receipts",
  async () => {
    await withNativeWorldOwner(async (owner) => {
      let dispatches = 0;
      const application = {
        async fetch(request: Request) {
          dispatches += 1;
          const result = await owner.request(
            new URL(request.url).pathname,
            await request.json(),
            request.headers.get("authorization")!.slice("Bearer ".length),
          );
          return Response.json(result.body, { status: result.status });
        },
      };
      const read = (name: string, args: unknown, credential = MEMBER) =>
        readWorldMcpTool(application, { name, arguments: args }, credential);
      const scope = { version: 1, ...owner.scope };
      const refused = { ok: false, status: 403, code: "authorization_refused" };
      expect(WORLD_MCP_READ_TOOLS).toEqual([
        "world_directory",
        "world_status",
        "entity_inspect",
        "command_receipt",
        "run_receipt",
        "run_search",
      ]);
      await owner.sql(
        "UPDATE clockgrove.world_memberships SET grants=array_append(grants,'runtime:world-observe')",
      );
      const directory = await read("world_directory", { version: 1 });
      expect(directory).toMatchObject({ ok: true, status: 200 });
      if (!directory.ok) throw new Error("directory unavailable");
      expect(
        (directory.value as { entries: object[] }).entries.map(({ ...entry }) => {
          const { tenantId, worldId, timelineId, spaceId } = entry as typeof owner.scope;
          return { tenantId, worldId, timelineId, spaceId };
        }),
      ).toEqual([owner.scope]);
      expect(await read("world_directory", { version: 1 }, OUTSIDER)).toEqual({
        ok: true,
        status: 200,
        value: { version: 1, entries: [] },
      });
      expect(await read("world_status", scope)).toMatchObject({
        ok: true,
        status: 200,
        value: { ...scope, revision: "0", privacyClass: "public_scene" },
      });
      expect(await read("entity_inspect", { ...scope, objectId: "fixture.keeper" })).toMatchObject({
        ok: true,
        status: 200,
        value: { entity: { objectId: "fixture.keeper" } },
      });
      expect(await read("world_status", scope, OUTSIDER)).toEqual(refused);
      const commandId = await owner.sql(
        "SELECT command_id FROM clockgrove.events WHERE event_type='WorldReady'",
      );
      const command = { schemaVersion: 1, ...owner.scope, commandId };
      expect(await read("command_receipt", command)).toEqual(refused);
      expect(await read("run_search", scope)).toEqual(refused);
      await owner.sql(
        "UPDATE clockgrove.world_memberships SET grants=array_append(grants,'runtime:world-inspect')",
      );
      const receipt = await read("command_receipt", command);
      expect(receipt).toMatchObject({ ok: true, status: 200 });
      if (!receipt.ok) throw new Error("receipt unavailable");
      expect(decodeCanonicalNode(canonicalResponse(receipt.value))).toMatchObject({
        receipt: { commandId, status: "committed" },
      });
      expect(await read("run_search", scope)).toEqual({
        ok: true,
        status: 200,
        value: { runs: [] },
      });
      await owner.sql(
        `UPDATE clockgrove.world_memberships SET privacy_ceiling =
          '{"version":1,"allowedCategories":["public_scene","conversation","operator_evidence"]}'`,
      );
      const created = await owner.request("/v1/runtime/conversations/create", {
        ...scope,
        actorId: "fixture.keeper",
      });
      expect(created.status).toBe(200);
      const session = decodeConversationSession(created.body).sessionId;
      decodeTalkReceipt(
        (
          await owner.request("/v1/runtime/talk", {
            ...scope,
            sessionId: session,
            messageId: "mcp-read-fixture",
            text: "private-read-canary",
          })
        ).body,
      );
      await owner.sql(
        `UPDATE clockgrove.world_memberships SET privacy_ceiling =
          '{"version":1,"allowedCategories":["public_scene","operator_evidence"]}'`,
      );
      const runId = await owner.sql(
        "SELECT run_id FROM clockgrove.agent_runs WHERE input_message_id='mcp-read-fixture'",
      );
      const run = await read("run_receipt", { ...scope, runId });
      expect(run).toMatchObject({ ok: true, status: 200 });
      if (!run.ok) throw new Error("run unavailable");
      expect(
        (run.value as RunWalk).runs.map((item) => [
          item.runId,
          item.principalId,
          item.personaId,
          item.status,
          item.rootRunId,
          item.prompt?.text,
        ]),
      ).toEqual([[runId, "principal-runtime", "persona-runtime", "completed", runId, null]]);
      expect(JSON.stringify(run)).not.toContain("private-read-canary");
      expect(await read("run_receipt", { ...scope, runId }, OUTSIDER)).toEqual(refused);
      expect(await read("command_receipt", { ...command, worldId: "other-world" })).toEqual(
        refused,
      );
      await owner.sql(
        "UPDATE clockgrove.world_memberships SET grants=ARRAY['runtime:world-observe']",
      );
      expect(await read("run_receipt", { ...scope, runId })).toEqual(refused);
      await owner.sql("DELETE FROM clockgrove_auth.session WHERE token='local-reader-session'");
      expect(await read("world_directory", { version: 1 })).toEqual({
        ok: false,
        status: 401,
        code: "authentication_refused",
      });
      const before = dispatches;
      for (const invocation of [
        { name: "unknown", arguments: scope },
        { name: "world_status", arguments: { ...scope, extra: true } },
        { name: "world_status", arguments: { ...scope, spaceId: "x".repeat(65_536) } },
        { name: "run_search", arguments: { ...scope, limit: 0 } },
        { name: "command_receipt", arguments: { schemaVersion: 1, ...owner.scope, eventId: "e" } },
        { name: "world_directory", arguments: { version: 1 }, path: "/private" },
      ])
        expect(await readWorldMcpTool(application, invocation, MEMBER)).toEqual({
          ok: false,
          status: 400,
          code: "invalid_tool_input",
        });
      expect(dispatches).toBe(before);
      // Fake failure injection checks the adapter's fixed error vocabulary, not authorization.
      expect(
        await readWorldMcpTool(
          {
            fetch: async () => {
              throw new Error("private-read-canary");
            },
          },
          { name: "world_directory", arguments: { version: 1 } },
          MEMBER,
        ),
      ).toEqual({
        ok: false,
        status: 503,
        code: "read_unavailable",
      });
      expect(
        await readWorldMcpTool(
          {
            fetch: async () =>
              Response.json(
                {
                  secret: "private-read-canary",
                },
                { status: 429 },
              ),
          },
          { name: "world_directory", arguments: { version: 1 } },
          MEMBER,
        ),
      ).toEqual({
        ok: false,
        status: 429,
        code: "read_rate_limited",
      });
    });
  },
  180_000,
);
