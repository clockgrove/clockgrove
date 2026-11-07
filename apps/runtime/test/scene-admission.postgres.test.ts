import { decodeCanonicalNode } from "@clockgrove/application";
import {
  ContractDecodeError,
  decodeObserverSceneMessage,
  decodeSceneConnectionControl,
  encodeSceneConnectionControl,
  NO_SCENE_INTEREST,
  parseSceneClientControl,
  SCENE_CREDENTIAL_PREFIX,
  SCENE_PROTOCOL,
  SceneCompatibilityError,
} from "@clockgrove/contracts";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeStateView } from "../src/inspector.js";
import { SPACE_MAILBOX_BOUNDS } from "../src/mailbox.js";
import { advanceCommand, truthOf } from "./world-fixture.js";
import {
  canonicalResponse,
  isNativeWorldOwnerChild,
  runNativeWorldOwnerProcess,
  waitForOwnerSql,
  withNativeWorldOwner,
} from "./world-owner/native-harness.js";

describe("native authenticated hibernatable scene admission", () => {
  it.skipIf(isNativeWorldOwnerChild())(
    "owns provider, PostgreSQL and workerd",
    async () => {
      await runNativeWorldOwnerProcess(
        "apps/runtime/test/scene-admission.postgres.test.ts",
        "fixture",
        {
          prepare: async (fixture) => {
            await truthOf(fixture)(
              "UPDATE clockgrove.world_memberships SET grants = array_append(grants, 'runtime:world-observe')",
            );
          },
        },
      );
    },
    180_000,
  );

  it.skipIf(!isNativeWorldOwnerChild())(
    "gates every upgrade and exposes only safe operational metadata",
    async () => {
      await withNativeWorldOwner(async (owner) => {
        const resume = {
          protocolVersion: 1,
          type: "resume",
          lastAppliedRevision: null,
          assetManifestVersion: 1,
        } as const;
        expect(encodeSceneConnectionControl(resume)).toBe(
          '{"protocolVersion":1,"type":"resume","lastAppliedRevision":null,"assetManifestVersion":1}',
        );
        expect(
          parseSceneClientControl(
            '{"protocolVersion":1,"type":"resume","lastAppliedRevision":"0","assetManifestVersion":1}',
          ),
        ).toEqual({ ...resume, lastAppliedRevision: 0n });
        expect(
          parseSceneClientControl(
            '{"protocolVersion":1,"type":"ack","revision":"9007199254740993","connectionVersion":7}',
          ),
        ).toEqual({
          protocolVersion: 1,
          type: "ack",
          revision: 9007199254740993n,
          connectionVersion: 7,
        });
        expect(
          encodeSceneConnectionControl({
            protocolVersion: 1,
            type: "ack",
            revision: 9007199254740993n,
            connectionVersion: 7,
          }),
        ).toBe(
          '{"protocolVersion":1,"type":"ack","revision":"9007199254740993","connectionVersion":7}',
        );
        for (const wire of [
          "{",
          '{"protocolVersion":1,"type":"ack","revision":"1","connectionVersion":1,"extra":true}',
          '{"protocolVersion":1,"type":"recovery","reason":"snapshot_required"}',
          '{"protocolVersion":1,"type":"ack","revision":9007199254740992,"connectionVersion":1}',
        ])
          expect(() => parseSceneClientControl(wire)).toThrow(ContractDecodeError);
        expect(() =>
          parseSceneClientControl(
            '{"protocolVersion":2,"type":"resume","lastAppliedRevision":null,"assetManifestVersion":1}',
          ),
        ).toThrow(SceneCompatibilityError);
        expect(
          decodeSceneConnectionControl({
            protocolVersion: 1,
            type: "disconnect",
            reason: "internal_error",
          }),
        ).toEqual({ protocolVersion: 1, type: "disconnect", reason: "internal_error" });
        const defect = new TypeError("native parser defect");
        const parse = vi.spyOn(JSON, "parse").mockImplementationOnce(() => {
          throw defect;
        });
        try {
          expect(() => parseSceneClientControl("{}")).toThrow(defect);
        } finally {
          parse.mockRestore();
        }
        const query = new URLSearchParams(owner.scope).toString();
        const route = `/v1/projection?${query}`;
        const carrier = {
          "sec-websocket-protocol": `${SCENE_PROTOCOL}, ${SCENE_CREDENTIAL_PREFIX}local-reader-session`,
        };
        const attachments = async () => (await owner.upgrade(`/scene/attachments?${query}`)).json();
        const refuse = async (
          url: string,
          headers: Readonly<Record<string, string>>,
          status: number,
          error: string,
        ) => {
          const response = await owner.upgrade(url, headers);
          expect([response.status, response.webSocket, await response.json()]).toEqual([
            status,
            null,
            { error },
          ]);
          expect(await attachments()).toEqual([]);
        };
        await refuse(route, {}, 401, "authentication_refused");
        await owner.sql(
          "UPDATE clockgrove.world_memberships SET grants=array_remove(array_append(grants,'runtime:world-inspect'),'runtime:world-observe')",
        );
        await refuse(route, carrier, 403, "authorization_refused");
        await owner.sql(
          "UPDATE clockgrove.world_memberships SET grants=array_remove(array_append(grants,'runtime:world-observe'),'runtime:world-inspect')",
        );
        await refuse(
          route,
          {
            cookie: "better-auth.session_token=local-reader-session",
            "sec-websocket-protocol": SCENE_PROTOCOL,
          },
          401,
          "authentication_refused",
        );
        await refuse(
          `${route}&token=local-reader-session`,
          { "sec-websocket-protocol": SCENE_PROTOCOL },
          400,
          "invalid_scene_scope",
        );
        await refuse(
          route,
          {
            "sec-websocket-protocol": `clockgrove.scene.v0, ${SCENE_CREDENTIAL_PREFIX}local-reader-session`,
          },
          426,
          "unsupported_protocol",
        );
        await refuse(
          route,
          {
            "sec-websocket-protocol": `${SCENE_PROTOCOL}, ${SCENE_CREDENTIAL_PREFIX}outsider-session-token`,
          },
          403,
          "authorization_refused",
        );
        for (const [field, value] of [
          ["worldId", "world-unapproved"],
          ["timelineId", "timeline-unapproved"],
          ["spaceId", "space-unapproved"],
        ] as const) {
          const unapproved = new URLSearchParams(owner.scope);
          unapproved.set(field, value);
          await refuse(`/v1/projection?${unapproved}`, carrier, 403, "authorization_refused");
        }
        await owner.sql(
          `UPDATE clockgrove.world_memberships SET privacy_ceiling='{"version":1,"allowedCategories":["operator_evidence"]}'`,
        );
        await refuse(route, carrier, 403, "authorization_refused");
        await owner.sql(
          `UPDATE clockgrove.world_memberships SET privacy_ceiling='{"version":1,"allowedCategories":["public_scene","operator_evidence"]}'`,
        );
        for (const fault of ["expired", "forged"])
          await refuse(
            `/scene/internal?${query}&fault=${fault}`,
            {},
            401,
            "authentication_refused",
          );
        await refuse(`/scene/internal?${query}&fault=stale`, {}, 409, "stale_authority_epoch");
        await refuse(`/scene/internal?${query}&fault=protocol`, {}, 426, "incompatible_protocol");

        // One physical command occupies the existing lane while PostgreSQL blocks its read.
        await owner.request("/mailbox", {
          scope: owner.scope,
          bounds: { ...SPACE_MAILBOX_BOUNDS, maxDepth: 1 },
        });
        await owner.withSqlClient(async (client) => {
          await client.query("BEGIN");
          await client.query("SELECT partition_id FROM clockgrove.partition_states FOR UPDATE");
          const pending = owner.submit(
            advanceCommand(owner.world, "scene-mailbox-held", 120_000n, null),
          );
          try {
            await waitForOwnerSql(
              owner.sql,
              "SELECT count(*) FROM pg_stat_activity WHERE usename='clockgrove_runtime' AND wait_event_type='Lock'",
              "1",
            );
            expect((await owner.request("/mailbox", { scope: owner.scope })).body).toMatchObject({
              depth: 1,
              admission: "full",
              active: { kind: "command", commandId: "scene-mailbox-held" },
            });
            expect(
              await owner.submit(advanceCommand(owner.world, "scene-mailbox-full", 120_000n, null)),
            ).toEqual({ status: 503, body: { error: "owner_mailbox_full", retryAfterSeconds: 1 } });
            await refuse(route, carrier, 503, "owner_mailbox_full");
          } finally {
            await client.query("COMMIT");
            expect((await pending).status).toBe(200);
          }
        });
        await owner.request("/mailbox", { scope: owner.scope, bounds: null });

        await owner.sql("UPDATE clockgrove.timeline_partitions SET routing_epoch=7");
        expect(
          await owner.sql(
            "SELECT p.routing_epoch::text || '|' || s.clock_owner_generation::text FROM clockgrove.timeline_partitions p JOIN clockgrove.partition_states s USING (tenant_id, timeline_id, partition_id)",
          ),
        ).toBe("7|1");
        const admitted = await owner.upgrade(route, carrier);
        expect([admitted.status, admitted.headers.get("sec-websocket-protocol")]).toEqual([
          101,
          SCENE_PROTOCOL,
        ]);
        const socket = admitted.webSocket;
        if (socket === null) throw new Error("native scene upgrade returned no socket");
        socket.accept();
        try {
          const canonicalScopeAndRevision = await owner.sql(
            `SELECT tenant_id || '|' || world_id || '|' || timeline_id || '|' || space_id || '|' || revision::text
             FROM clockgrove.partition_states WHERE tenant_id='${owner.scope.tenantId}'
             AND world_id='${owner.scope.worldId}' AND timeline_id='${owner.scope.timelineId}'
             AND space_id='${owner.scope.spaceId}'`,
          );
          // Capture before resume: its snapshot may arrive before the ack is sent.
          const recovered = Promise.withResolvers<unknown>();
          const following = Promise.withResolvers<unknown>();
          const afterSnapshot = Promise.withResolvers<unknown>();
          const pendingFrames = [recovered, following, afterSnapshot];
          socket.addEventListener("message", (event) => pendingFrames.shift()?.resolve(event.data));
          socket.send(encodeSceneConnectionControl(resume));
          expect(await recovered.promise).toBe(
            '{"protocolVersion":1,"type":"recovery","reason":"snapshot_required"}',
          );
          socket.send(
            '{"protocolVersion":1,"type":"ack","revision":"9007199254740993","connectionVersion":1}',
          );
          const unavailable =
            '{"protocolVersion":1,"type":"recovery","reason":"revision_unavailable"}';
          let unacknowledged = await following.promise;
          // Admission alone sends no snapshot; delivery may insert exactly one RW-0401 snapshot.
          if (unacknowledged !== unavailable) {
            if (typeof unacknowledged !== "string") throw new Error("expected a scene wire frame");
            const snapshot = decodeObserverSceneMessage(JSON.parse(unacknowledged));
            expect([snapshot.lane, snapshot.type]).toEqual(["projection", "snapshot"]);
            if (snapshot.type !== "snapshot") throw new Error("expected a resume snapshot");
            expect(snapshot.payload.privacyClass).toBe("public_scene");
            expect(
              [
                snapshot.tenantId,
                snapshot.worldId,
                snapshot.timelineId,
                snapshot.spaceId,
                snapshot.projectionRevision,
              ].join("|"),
            ).toBe(canonicalScopeAndRevision);
            // The observer decoder also checks payload/envelope scope and revision equality.
            unacknowledged = await afterSnapshot.promise;
          }
          expect(unacknowledged).toBe(unavailable);
          expect(await attachments()).toEqual([
            {
              principalId: "principal-runtime",
              audience: {
                ...owner.scope,
                privacyClass: "public_scene",
                interest: NO_SCENE_INTEREST,
              },
              acknowledgedRevision: null,
              connectionVersion: 1,
            },
          ]);
          // The same credential ceases to work immediately after revocation or provider expiry.
          await owner.sql(
            `UPDATE clockgrove_auth.session SET "expiresAt"=now()-interval '1 second' WHERE id='local-session'`,
          );
          const expired = await owner.upgrade(route, carrier);
          expect([expired.status, expired.webSocket, await expired.json()]).toEqual([
            401,
            null,
            { error: "authentication_refused" },
          ]);
          await owner.sql(
            `UPDATE clockgrove_auth.session SET "expiresAt"=now()+interval '1 hour' WHERE id='local-session'`,
          );
          await owner.sql("DELETE FROM clockgrove_auth.session WHERE id='local-session'");
          const revoked = await owner.upgrade(route, carrier);
          expect([revoked.status, revoked.webSocket, await revoked.json()]).toEqual([
            401,
            null,
            { error: "authentication_refused" },
          ]);
          await owner.sql(
            `INSERT INTO clockgrove_auth.session (id,token,"userId","expiresAt","createdAt","updatedAt") VALUES ('local-session','local-reader-session','local-subject',now()+interval '1 hour',now(),now())`,
          );

          const input = { schemaVersion: 1, ...owner.scope };
          const state = () => owner.request("/v1/runtime/runtime-state", input);
          await owner.sql(
            "UPDATE clockgrove.world_memberships SET grants=array_remove(grants,'runtime:world-inspect')",
          );
          expect(await state()).toEqual({ status: 403, body: { error: "authorization_refused" } });
          await owner.sql(
            "UPDATE clockgrove.world_memberships SET grants=array_append(grants,'runtime:world-inspect')",
          );
          const inspected = await state();
          expect(inspected.status).toBe(200);
          const view = decodeCanonicalNode(canonicalResponse(inspected.body)) as RuntimeStateView;
          expect(view.owner.value.connections).toEqual([
            { principalId: "principal-runtime", acknowledgedRevision: null, connectionVersion: 1 },
          ]);
          expect(
            await owner.sql(
              "SELECT string_agg(decision || '|' || reason_code, ',' ORDER BY access_id) FROM clockgrove.inspector_accesses WHERE subject='runtime-state'",
            ),
          ).toBe("deny|runtime-grant-missing,allow|served");
          // Fill the existing 300/hour audit bound (migration 0028) without 298 network requests.
          await owner.sql(`INSERT INTO clockgrove.inspector_accesses (tenant_id,principal_id,world_id,timeline_id,space_id,decision,reason_code,subject)
          SELECT '${owner.scope.tenantId}','principal-runtime','${owner.scope.worldId}','${owner.scope.timelineId}','${owner.scope.spaceId}','allow','served','runtime-state' FROM generate_series(1,298)`);
          const limited = await state();
          expect(limited).toEqual({ status: 429, body: { error: "inspection_rate_limited" } });
          expect(
            await owner.sql(
              "SELECT count(*) FROM clockgrove.inspector_accesses WHERE subject='runtime-state'",
            ),
          ).toBe("300");
        } finally {
          socket.close(1000, "finished");
        }
        await expect.poll(attachments).toEqual([]);
        for (const [wire, reason] of [
          [
            '{"protocolVersion":1,"type":"ack","revision":"-1","connectionVersion":1}',
            "malformed_control",
          ],
          [
            '{"protocolVersion":2,"type":"resume","lastAppliedRevision":null,"assetManifestVersion":1}',
            "unsupported_protocol",
          ],
        ] as const) {
          const response = await owner.upgrade(route, carrier);
          expect(response.status).toBe(101);
          const invalid = response.webSocket;
          if (invalid === null) throw new Error("native scene upgrade returned no socket");
          invalid.accept();
          const notice = new Promise<unknown>((resolve) =>
            invalid.addEventListener("message", (event) => resolve(event.data), { once: true }),
          );
          try {
            invalid.send(wire);
            expect(await notice).toBe(
              JSON.stringify({ protocolVersion: 1, type: "disconnect", reason }),
            );
          } finally {
            invalid.close(1000, "finished");
          }
          await expect.poll(attachments).toEqual([]);
        }
      });
    },
    120_000,
  );
});
