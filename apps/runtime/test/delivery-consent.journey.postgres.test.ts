import { decodeConversationSession } from "@clockgrove/contracts";
import { expect, it } from "vitest";
import { truthOf } from "./world-fixture.js";
import {
  isNativeWorldOwnerChild,
  runNativeWorldOwnerProcess,
  withNativeWorldOwner,
} from "./world-owner/native-harness.js";

const FILE = "apps/runtime/test/delivery-consent.journey.postgres.test.ts";
it("configures only the authenticated recipient's scoped actor consent over HTTP", async () => {
  if (!isNativeWorldOwnerChild()) {
    await runNativeWorldOwnerProcess(FILE, "fixture/reference", {
      prepare: async (fixture) => {
        await truthOf(fixture)(`UPDATE clockgrove.world_memberships SET
          grants=array_append(grants,'runtime:world-observe'),
          privacy_ceiling='{"version":1,"allowedCategories":["public_scene","conversation"]}';
          INSERT INTO clockgrove.tenant_principals (tenant_id,principal_id)
            SELECT DISTINCT tenant_id,'principal-outsider' FROM clockgrove.world_memberships;
          INSERT INTO clockgrove.world_memberships
            (tenant_id,world_id,timeline_id,space_id,principal_id,membership_id,persona_id,roles,grants,privacy_ceiling,committed_at)
            SELECT tenant_id,world_id,timeline_id,space_id,'principal-outsider','membership-outsider','persona-outsider',roles,grants,privacy_ceiling,now()
            FROM clockgrove.world_memberships WHERE principal_id='principal-runtime';`);
      },
    });
    return;
  }
  await withNativeWorldOwner(async (owner) => {
    const post = (path: string, fields: object, token = "local-reader-session") =>
      owner.request(path, { version: 1, ...owner.scope, ...fields }, token);
    const opened = await post("/v1/runtime/conversations/create", { actorId: "fixture.keeper" });
    expect(opened.status).toBe(200);
    const session = decodeConversationSession(opened.body);
    const target = { actorId: session.actorId, sessionId: session.sessionId };
    const consent = {
      enabled: true,
      timezone: "America/Los_Angeles",
      quietHours: { startMinute: 1320, endMinute: 420 },
      budgetLimit: 20,
    };
    const configure = (fields: object, token?: string) =>
      post("/v1/runtime/deliveries/consent", { ...target, consent, ...fields }, token);
    expect(await owner.sql("SELECT count(*) FROM clockgrove.delivery_consent")).toBe("0");
    expect(await configure({})).toEqual({
      status: 200,
      body: { ...consent, version: 1, reservedUnits: 0 },
    });
    expect(await configure({ consent: { ...consent, enabled: false } })).toEqual({
      status: 200,
      body: { ...consent, enabled: false, version: 2, reservedUnits: 0 },
    });
    expect(await configure({}, "outsider-session-token")).toEqual({
      status: 404,
      body: { error: "delivery_target_invalid" },
    });
    expect(await configure({ actorId: "other-actor" })).toEqual({
      status: 404,
      body: { error: "delivery_target_invalid" },
    });
    expect(await configure({ sessionId: "absent-session" })).toEqual({
      status: 404,
      body: { error: "delivery_target_invalid" },
    });
    expect((await configure({ principalId: "principal-outsider" })).status).toBe(400);
    expect(
      (await configure({ consent: { ...consent, principalId: "principal-outsider" } })).status,
    ).toBe(400);
    expect(await configure({ consent: { ...consent, timezone: "invalid-zone" } })).toEqual({
      status: 400,
      body: { error: "delivery_policy_invalid" },
    });
    expect(await configure({ consent: { ...consent, timezone: "america/los_angeles" } })).toEqual({
      status: 400,
      body: { error: "delivery_policy_invalid" },
    });
    expect(
      (
        await configure({
          consent: { ...consent, quietHours: { startMinute: 1440, endMinute: 0 } },
        })
      ).status,
    ).toBe(400);
    expect((await configure({}, "invalid-session")).status).toBe(401);
    await owner.sql("UPDATE clockgrove.delivery_consent SET reserved_units=3");
    expect(await configure({ consent: { ...consent, budgetLimit: 2 } })).toEqual({
      status: 400,
      body: { error: "delivery_policy_invalid" },
    });
    await owner.sql(
      'UPDATE clockgrove.world_memberships SET privacy_ceiling=\'{"version":1,"allowedCategories":["public_scene"]}\' WHERE principal_id=\'principal-runtime\'',
    );
    expect((await configure({})).status).toBe(403);
    await owner.sql(
      "UPDATE clockgrove.world_memberships SET revoked_at=now() WHERE principal_id='principal-runtime'",
    );
    expect((await configure({})).status).toBe(403);
    expect(
      await owner.sql(
        "SELECT principal_id||':'||version||':'||enabled FROM clockgrove.delivery_consent",
      ),
    ).toBe("principal-runtime:2:false");
  });
}, 240_000);
