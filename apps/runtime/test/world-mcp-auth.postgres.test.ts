import { createHash } from "node:crypto";
import { PostgreSqlManagementReaders } from "@clockgrove/persistence";
import { expect, it } from "vitest";
import {
  applyMigrations,
  psqlQuery,
  withDisposableDatabase,
  // @ts-expect-error -- repository-local JavaScript helper has no declaration file.
} from "../../../scripts/database/lib.mjs";
import { composeWorldMcpAuthentication } from "../src/better-auth-adapter.js";
import { connectionString, type DatabaseFixture, withClient } from "./world-fixture.js";

it("issues PKCE OAuth and member keys with fresh mapped authority and immediate revocation", async () => {
  await withDisposableDatabase(async (fixture: DatabaseFixture) => {
    await applyMigrations(fixture.tools, fixture.environment);
    const sql = (query: string) => psqlQuery(fixture.tools, fixture.environment, query);
    const sessionCredential = "fixture-member".repeat(2);
    await sql(`INSERT INTO clockgrove_auth."user" VALUES ('member-subject','Member','member@example.test',true,null,now(),now());
      INSERT INTO clockgrove_auth.session VALUES ('member-session',now()+interval '1 hour','${sessionCredential}',now(),now(),null,null,'member-subject');
      INSERT INTO clockgrove_management.principals VALUES ('member-principal',null);
      INSERT INTO clockgrove_management.identity_links VALUES ('ci','member-subject','member-identity','member-principal',null);`);
    await withClient(
      fixture.environment,
      async (client) => {
        for (const statement of [
          "UPDATE clockgrove_management.principals SET revoked_at=now()",
          "DELETE FROM clockgrove.world_memberships",
          "UPDATE clockgrove_auth.session SET token='refused'",
          "SELECT clockgrove.execute_journal(''::bytea, '{}'::jsonb, 'refused')",
        ])
          await expect(client.query(statement)).rejects.toMatchObject({ code: "42501" });
      },
      "clockgrove",
      "clockgrove_mcp_auth_writer",
    );
    const authentication = composeWorldMcpAuthentication("fixture-secret".repeat(4), {
      baseURL: "https://clockgrove.test",
      resourceURL: "https://clockgrove.test/mcp",
      environment: "ci",
      connectionString: connectionString(
        fixture.environment,
        "clockgrove",
        "clockgrove_mcp_auth_writer",
      ),
      resolveIdentity: (environment, subject) =>
        withClient(
          fixture.environment,
          (client) =>
            new PostgreSqlManagementReaders(client, environment).resolveIdentity(
              environment,
              subject,
            ),
          "clockgrove",
          "clockgrove_management_reader",
        ),
    });
    const request = (path: string, body?: unknown, session = true, method = "POST") =>
      authentication.handle(
        new Request(`https://clockgrove.test/api/auth${path}`, {
          method,
          headers: {
            "content-type": ["/oauth2/token", "/oauth2/revoke"].includes(path)
              ? "application/x-www-form-urlencoded"
              : "application/json",
            origin: "https://clockgrove.test",
            ...(session ? { authorization: `Bearer ${sessionCredential}` } : {}),
          },
          ...(method === "GET"
            ? {}
            : {
                body: ["/oauth2/token", "/oauth2/revoke"].includes(path)
                  ? new URLSearchParams(body as Record<string, string>).toString()
                  : JSON.stringify(body ?? {}),
              }),
        }),
      );
    const json = async (response: Response, expected = 200) => {
      expect(response.status).toBe(expected);
      return (await response.json()) as {
        key: string;
        id: string;
        total: number;
        client_id: string;
        url: string;
        access_token: string;
        scope: string;
        expires_in: number;
      };
    };
    const key = await json(await request("/api-key/create", { name: "Fixture client" }));
    expect(typeof key.key === "string" && key.key.startsWith("cg_member_")).toBe(true);
    expect(
      (
        await sql(
          'SELECT extract(epoch FROM ("expiresAt" - "createdAt"))::integer FROM clockgrove_auth.apikey',
        )
      ).trim(),
    ).toBe("2592000");
    expect((await sql("SELECT key FROM clockgrove_auth.apikey")).trim() === key.key).toBe(false);
    expect(
      (
        await request("/api-key/create", {
          name: "x",
          userId: "foreign",
          permissions: { world: ["admin"] },
        })
      ).status,
    ).toBe(400);
    expect((await request("/api-key/create", { name: "x".repeat(16384) })).status).toBe(413);
    expect(await authentication.provider.authenticate(key.key)).toEqual({
      externalIdentityId: "member-identity",
    });
    expect((await json(await request("/api-key/list", undefined, true, "GET"))).total).toBe(1);
    await json(await request("/api-key/delete", { keyId: key.id }));
    await expect(authentication.provider.authenticate(key.key)).rejects.toThrow(
      "authentication refused",
    );

    const client = await json(
      await request("/oauth2/register", {
        client_name: "Fixture MCP",
        redirect_uris: ["https://client.test/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code"],
        response_types: ["code"],
        scope: "clockgrove:mcp",
      }),
      201,
    );
    const verifier = "fixture-pkce-verifier-abcdefghijklmnopqrstuvwxyz0123456789";
    const query = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: "https://client.test/callback",
      response_type: "code",
      scope: "clockgrove:mcp",
      state: "fixture-state",
      resource: "https://clockgrove.test/mcp",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    });
    const authorizeCode = async (requireConsent = false) => {
      const authorize = await request(`/oauth2/authorize?${query}`, undefined, true, "GET");
      expect([200, 302]).toContain(authorize.status);
      const redirect =
        authorize.headers.get("location") ?? ((await authorize.json()) as { url: string }).url;
      let callback = new URL(redirect, "https://clockgrove.test");
      if (requireConsent) expect(callback.pathname).toBe("/mcp/consent");
      if (callback.pathname === "/mcp/consent") {
        const approved = await json(
          await request("/oauth2/consent", { accept: true, oauth_query: callback.search.slice(1) }),
        );
        callback = new URL(approved.url);
      }
      expect(callback.origin).toBe("https://client.test");
      expect(callback.searchParams.get("state")).toBe("fixture-state");
      return callback.searchParams.get("code")!;
    };
    let code = await authorizeCode(true);
    const exchange = (codeVerifier: string) =>
      request(
        "/oauth2/token",
        {
          grant_type: "authorization_code",
          client_id: client.client_id,
          redirect_uri: "https://client.test/callback",
          code,
          code_verifier: codeVerifier,
          resource: "https://clockgrove.test/mcp",
        },
        false,
      );
    expect((await exchange("incorrect-verifier".repeat(4))).status).toBe(400);
    code = await authorizeCode();
    const token = await json(await exchange(verifier));
    expect(token.scope).toBe("clockgrove:mcp");
    expect(token.expires_in).toBe(3600);
    expect(await authentication.provider.authenticate(token.access_token)).toEqual({
      externalIdentityId: "member-identity",
    });
    expect(
      (
        await request(
          "/oauth2/revoke",
          {
            token: token.access_token,
            client_id: client.client_id,
            token_type_hint: "access_token",
          },
          false,
        )
      ).status,
    ).toBe(200);
    expect((await exchange(verifier)).status).toBe(400);
    await expect(authentication.provider.authenticate(token.access_token)).rejects.toThrow(
      "authentication refused",
    );

    const second = await json(await request("/api-key/create", { name: "Revoked principal" }));
    await sql('UPDATE clockgrove_auth.apikey SET "expiresAt"=now()');
    await expect(authentication.provider.authenticate(second.key)).rejects.toThrow(
      "authentication refused",
    );
    const third = await json(await request("/api-key/create", { name: "Revoked link" }));
    code = await authorizeCode();
    const sessionToken = await json(await exchange(verifier));
    expect(await authentication.provider.authenticate(sessionToken.access_token)).toEqual({
      externalIdentityId: "member-identity",
    });
    await sql("DELETE FROM clockgrove_auth.session WHERE id='member-session'");
    await expect(authentication.provider.authenticate(sessionToken.access_token)).rejects.toThrow(
      "authentication refused",
    );
    expect(await authentication.provider.authenticate(third.key)).toEqual({
      externalIdentityId: "member-identity",
    });
    await sql(
      `INSERT INTO clockgrove_auth.session VALUES ('new-member-session',now()+interval '1 hour','${sessionCredential}',now(),now(),null,null,'member-subject')`,
    );
    await sql("UPDATE clockgrove_management.identity_links SET revoked_at=now()");
    await expect(authentication.provider.authenticate(third.key)).rejects.toThrow(
      "authentication refused",
    );
    expect((await request("/api-key/create", { name: "Refused" })).status).toBe(401);
    expect((await request("/sign-up/email", {}, false)).status).toBe(404);
    expect((await sql("SELECT count(*) FROM clockgrove.world_memberships")).trim()).toBe("0");
    await sql(`DELETE FROM clockgrove_auth."user" WHERE id='member-subject'`);
    expect((await sql("SELECT count(*) FROM clockgrove_auth.apikey")).trim()).toBe("0");
  });
}, 240_000);
