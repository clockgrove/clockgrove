import { createHash } from "node:crypto";
import { decodeCanonicalNode, encodeCanonicalNode } from "@clockgrove/application";
import { decodeConversationSession, type RunWalk } from "@clockgrove/contracts";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";
import { advanceCommand } from "./world-fixture.js";
import {
  isNativeWorldOwnerChild,
  runNativeWorldOwnerProcess,
  withNativeWorldOwner,
} from "./world-owner/native-harness.js";

const FILE = "apps/runtime/test/world-mcp-public.postgres.test.ts";
const ORIGIN = "https://auth.example.test";
it.skipIf(isNativeWorldOwnerChild())(
  "owns the authenticated public MCP native isolation attack proof",
  async () => runNativeWorldOwnerProcess(FILE, "fixture/reference"),
  240_000,
);
it.skipIf(!isNativeWorldOwnerChild())(
  "connects issued OAuth and member keys to native application APIs with current isolation",
  async () => {
    await withNativeWorldOwner(
      async (owner) => {
        const auth = async (
          path: string,
          body?: Record<string, unknown>,
          credential = "local-reader-session",
          method = "POST",
        ) => {
          const form = path.startsWith("/oauth2/token") || path.startsWith("/oauth2/revoke");
          return owner.fetch(
            new Request(`${ORIGIN}/api/auth${path}`, {
              method,
              headers: {
                origin: ORIGIN,
                ...(credential === "" ? {} : { authorization: `Bearer ${credential}` }),
                "content-type": form ? "application/x-www-form-urlencoded" : "application/json",
              },
              ...(method === "GET"
                ? {}
                : {
                    body: form
                      ? new URLSearchParams(body as Record<string, string>).toString()
                      : JSON.stringify(body),
                  }),
            }),
          );
        };
        const issueKey = async (credential: string) => {
          const response = await auth("/api-key/create", { name: "Native fixture" }, credential);
          expect(response.status).toBe(200);
          return (await response.json()) as { key: string; id: string };
        };
        const member = await issueKey("local-reader-session");
        const outsider = await issueKey("outsider-session-token");
        let credential = member.key;
        const responses: Response[] = [];
        const client = new Client(
          { name: "untrusted-client-name", version: "1.0.0" },
          { versionNegotiation: { mode: { pin: "2026-07-28" } } },
        );
        const call = async (name: string, args: Record<string, unknown>) => {
          const result = await client.callTool({ name, arguments: args });
          return JSON.parse((result.content as { text: string }[])[0]!.text);
        };
        try {
          await client.connect(
            new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
              authProvider: { token: async () => credential },
              fetch: async (url, init) => {
                const response = await owner.fetch(new Request(url, init));
                responses.push(response.clone());
                return response;
              },
            }),
          );
          expect((await client.listTools()).tools.map((tool) => tool.name)).toContain(
            "command_submit",
          );
          await owner.sql(
            "UPDATE clockgrove.world_memberships SET grants=array_append(grants,'runtime:world-observe')",
          );
          const scope = { version: 1, ...owner.scope };
          expect(await call("world_directory", { version: 1 })).toEqual({
            ok: true,
            status: 200,
            value: { version: 1, entries: [expect.objectContaining(owner.scope)] },
          });
          expect(await call("world_status", scope)).toMatchObject({
            ok: true,
            value: { ...scope },
          });
          const commandId = "public-mcp-command";
          const command = {
            ...advanceCommand(
              owner.world,
              commandId,
              owner.world.birth.state.simulationTime + 1000n,
              null,
            ),
            attribution: {
              effectiveActorId: "spoofed-actor",
              initiatorId: "spoofed-persona",
              channel: "spoofed-channel",
              causalRootActionId: "public-mcp-root",
            },
          };
          const submitted = await call("command_submit", {
            schemaVersion: 1,
            ...owner.scope,
            routingEpoch: "1",
            authorityEpoch: "1",
            command: encodeCanonicalNode(command),
          });
          expect(submitted).toMatchObject({ ok: true, status: 200 });
          expect(decodeCanonicalNode(submitted.value)).toMatchObject({
            commandId,
            outcome: "committed",
          });
          const attribution = JSON.parse(
            await owner.sql(
              `SELECT attribution::text FROM clockgrove.command_receipts WHERE command_id='${commandId}'`,
            ),
          );
          expect(attribution).toMatchObject({
            principalId: "principal-runtime",
            personaId: "persona-runtime",
            initiatorId: "persona-runtime",
            effectiveActorId: "persona-runtime",
            channel: `mcp:member-key:${member.id}`,
            causalRootActionId: "public-mcp-root",
          });
          const why = await owner.request("/v1/runtime/why", { ...scope, commandId });
          expect(why.status).toBe(200);
          expect(why.body).toMatchObject({ commandId, channel: `mcp:member-key:${member.id}` });
          for (const [field, value] of [
            ["tenantId", "foreign-tenant"],
            ["worldId", "foreign-world"],
            ["timelineId", "foreign-timeline"],
          ]) {
            expect(await call("world_status", { ...scope, [field!]: value })).toEqual({
              ok: false,
              status: 403,
              code: "authorization_refused",
            });
          }
          await owner.sql(`UPDATE clockgrove.world_memberships SET
          grants=array_append(grants,'runtime:world-inspect'),
          privacy_ceiling='{"version":1,"allowedCategories":["public_scene","conversation","operator_evidence"]}'`);
          const sessionId = decodeConversationSession(
            (
              await owner.request("/v1/runtime/conversations/create", {
                ...scope,
                actorId: "fixture.keeper",
              })
            ).body,
          ).sessionId;
          expect(
            (
              await owner.request("/v1/runtime/talk", {
                ...scope,
                sessionId,
                messageId: "public-mcp-private",
                text: "native-private-mcp-canary",
              })
            ).status,
          ).toBe(200);
          const runId = await owner.sql(
            "SELECT run_id FROM clockgrove.agent_runs WHERE input_message_id='public-mcp-private'",
          );
          await owner.sql(`UPDATE clockgrove.world_memberships SET
          privacy_ceiling='{"version":1,"allowedCategories":["public_scene","operator_evidence"]}'`);
          const receipt = await call("run_receipt", { ...scope, runId });
          expect(receipt.ok).toBe(true);
          expect(
            (receipt.value as RunWalk).runs.map((run) => [
              run.runId,
              run.principalId,
              run.prompt?.text,
            ]),
          ).toEqual([[runId, "principal-runtime", null]]);
          expect(JSON.stringify(receipt)).not.toContain("native-private-mcp-canary");
          credential = outsider.key;
          expect(await call("world_directory", { version: 1 })).toEqual({
            ok: true,
            status: 200,
            value: { version: 1, entries: [] },
          });
          expect(await call("run_receipt", { ...scope, runId })).toEqual({
            ok: false,
            status: 403,
            code: "authorization_refused",
          });
          await owner.sql(`INSERT INTO clockgrove.tenant_principals (tenant_id,principal_id)
            VALUES ('${owner.scope.tenantId}','principal-outsider');
            INSERT INTO clockgrove.world_memberships
              (tenant_id,world_id,timeline_id,space_id,principal_id,membership_id,persona_id,roles,grants,privacy_ceiling,committed_at)
            SELECT tenant_id,world_id,timeline_id,space_id,'principal-outsider','membership-outsider','persona-outsider',
              roles,ARRAY['runtime:world-observe','runtime:world-inspect'],
              '{"version":1,"allowedCategories":["public_scene","conversation","operator_evidence"]}',now()
            FROM clockgrove.world_memberships WHERE principal_id='principal-runtime'`);
          const secondMemberReceipt = await call("run_receipt", { ...scope, runId });
          expect(secondMemberReceipt.ok).toBe(true);
          expect(
            (secondMemberReceipt.value as RunWalk).runs.map((run) => [run.runId, run.prompt?.text]),
          ).toEqual([[runId, null]]);
          expect(JSON.stringify(secondMemberReceipt)).not.toContain("native-private-mcp-canary");
          credential = member.key;
          await owner.sql(
            "UPDATE clockgrove.world_memberships SET grants=ARRAY['runtime:world-observe']",
          );
          expect(await call("run_receipt", { ...scope, runId })).toEqual({
            ok: false,
            status: 403,
            code: "authorization_refused",
          });
          const registration = await auth(
            "/oauth2/register",
            {
              client_name: "Native OAuth fixture",
              redirect_uris: ["https://client.test/callback"],
              token_endpoint_auth_method: "none",
              grant_types: ["authorization_code"],
              response_types: ["code"],
              scope: "clockgrove:mcp",
            },
            "",
          );
          expect(registration.status).toBe(201);
          const registered = (await registration.json()) as { client_id: string };
          const verifier = "native-fixture-verifier-abcdefghijklmnopqrstuvwxyz0123456789";
          const query = new URLSearchParams({
            client_id: registered.client_id,
            redirect_uri: "https://client.test/callback",
            response_type: "code",
            scope: "clockgrove:mcp",
            state: "native-state",
            resource: `${ORIGIN}/mcp`,
            code_challenge: createHash("sha256").update(verifier).digest("base64url"),
            code_challenge_method: "S256",
          });
          const authorize = await auth(
            `/oauth2/authorize?${query}`,
            undefined,
            "local-reader-session",
            "GET",
          );
          expect([200, 302]).toContain(authorize.status);
          const consentURL = new URL(
            authorize.headers.get("location") ?? ((await authorize.json()) as { url: string }).url,
            ORIGIN,
          );
          expect(consentURL.pathname).toBe("/mcp/consent");
          const consent = await auth("/oauth2/consent", {
            accept: true,
            oauth_query: consentURL.search.slice(1),
          });
          expect(consent.status).toBe(200);
          const callback = new URL(((await consent.json()) as { url: string }).url);
          expect(callback.searchParams.get("state")).toBe("native-state");
          const tokenResponse = await auth(
            "/oauth2/token",
            {
              grant_type: "authorization_code",
              client_id: registered.client_id,
              redirect_uri: "https://client.test/callback",
              code: callback.searchParams.get("code")!,
              code_verifier: verifier,
              resource: `${ORIGIN}/mcp`,
            },
            "",
          );
          expect(tokenResponse.status).toBe(200);
          credential = ((await tokenResponse.json()) as { access_token: string }).access_token;
          expect(await call("world_status", scope)).toMatchObject({ ok: true });
          await owner.sql(
            "UPDATE clockgrove.world_memberships SET grants=array_append(grants,'runtime:world-command')",
          );
          const oauthCommandId = "public-oauth-command";
          const oauthCommand = advanceCommand(
            owner.world,
            oauthCommandId,
            owner.world.birth.state.simulationTime + 2000n,
            null,
          );
          const oauthReceipt = await call("command_submit", {
            schemaVersion: 1,
            ...owner.scope,
            routingEpoch: "1",
            authorityEpoch: "1",
            command: encodeCanonicalNode(oauthCommand),
          });
          expect(oauthReceipt).toMatchObject({ ok: true, status: 200 });
          expect(decodeCanonicalNode(oauthReceipt.value)).toMatchObject({
            commandId: oauthCommandId,
            outcome: "committed",
          });
          expect(
            JSON.parse(
              await owner.sql(
                `SELECT attribution::text FROM clockgrove.command_receipts WHERE command_id='${oauthCommandId}'`,
              ),
            ),
          ).toMatchObject({
            initiatorId: "persona-runtime",
            channel: `mcp:oauth:${registered.client_id}`,
            causalRootActionId: `action-${oauthCommandId}`,
          });

          expect((await client.listTools()).tools.some((tool) => tool.name === "talk")).toBe(false);
          const revoke = await auth(
            "/oauth2/revoke",
            {
              token: credential,
              client_id: registered.client_id,
              token_type_hint: "access_token",
            },
            "",
          );
          expect(revoke.status).toBe(200);
          await expect(client.listTools()).rejects.toThrow();
          expect(responses.at(-1)!.status).toBe(401);
          credential = member.key;
          expect((await auth("/api-key/delete", { keyId: member.id })).status).toBe(200);
          await expect(client.listTools()).rejects.toThrow();
          expect(responses.at(-1)!.status).toBe(401);
          credential = outsider.key;
          await owner.sql(
            "UPDATE clockgrove_management.identity_links SET revoked_at=now() WHERE principal_id='principal-outsider'",
          );
          await expect(client.listTools()).rejects.toThrow();
          expect(responses.at(-1)!.status).toBe(401);
          expect(
            responses.every((response) => response.headers.get("mcp-session-id") === null),
          ).toBe(true);
        } finally {
          await client.close();
        }
      },
      { mcp: true },
    );
  },
  180_000,
);
