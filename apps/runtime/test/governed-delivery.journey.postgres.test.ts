import type { RuntimeAuthorizationContext } from "@clockgrove/application";
import {
  type DeliveryRequested,
  decodeBrowserScope,
  decodeConversationSession,
  decodeOpaqueId,
  decodeTalkReceipt,
} from "@clockgrove/contracts";
import { PostgreSqlGovernedDelivery, withClientTransaction } from "@clockgrove/persistence";
import { expect, it } from "vitest";
import { truthOf } from "./world-fixture.js";
import {
  isNativeWorldOwnerChild,
  runNativeWorldOwnerProcess,
  withNativeWorldOwner,
} from "./world-owner/native-harness.js";

const FILE = "apps/runtime/test/governed-delivery.journey.postgres.test.ts";
it("reserves before governed delivery, preserves private provenance and isolates fake/preview replay", async () => {
  if (!isNativeWorldOwnerChild()) {
    await runNativeWorldOwnerProcess(FILE, "fixture/reference", {
      prepare: async (fixture) => {
        await truthOf(
          fixture,
        )(`UPDATE clockgrove.world_memberships SET grants=array_append(grants,'runtime:world-observe'),
        privacy_ceiling='{"version":1,"allowedCategories":["public_scene","conversation"]}';`);
      },
    });
    return;
  }
  await withNativeWorldOwner(async (owner) => {
    const post = async (path: string, fields: object) => {
      const r = await owner.request(path, { version: 1, ...owner.scope, ...fields });
      expect(r.status).toBe(200);
      return r.body;
    };
    const session = decodeConversationSession(
      await post("/v1/runtime/conversations/create", {
        actorId: "fixture.keeper",
        channel: "fake",
        threadId: "delivery-thread",
      }),
    );
    const talk = decodeTalkReceipt(
      await post("/v1/runtime/talk", {
        sessionId: session.sessionId,
        messageId: "source",
        text: "a private note",
      }),
    );
    expect(talk.reply.text).toBe(
      "Scripted fixture reply: you have said 1 thing to me in this conversation.",
    );
    const authorization: RuntimeAuthorizationContext = {
      tenantId: session.scope.tenantId,
      principalId: session.participants[0]!.principalId,
      privacyCeiling: { version: 1, allowedCategories: ["conversation"] },
    };
    const target = {
      scope: decodeBrowserScope(owner.scope),
      actorId: session.actorId,
      sessionId: session.sessionId,
    };
    const artifact = await owner.sql(
      `SELECT content_artifact_id FROM clockgrove.conversation_messages WHERE session_id='${session.sessionId}' AND role='actor'`,
    );
    let instant = "2026-11-09T20:00:00.000Z";
    const store = <T>(op: (s: PostgreSqlGovernedDelivery) => Promise<T>) =>
      owner.withSqlClient((c) => op(new PostgreSqlGovernedDelivery(c, () => new Date(instant))));
    const configure = (enabled: boolean, budgetLimit = 30) =>
      store((s) =>
        s.configureConsent(authorization, target, {
          enabled,
          timezone: "America/Los_Angeles",
          quietHours: { startMinute: 22 * 60, endMinute: 7 * 60 },
          budgetLimit,
        }),
      );
    let consentVersion = 0;
    const request = (
      dedupeKey: string,
      fields: Partial<DeliveryRequested> = {},
    ): DeliveryRequested => ({
      type: "DeliveryRequested",
      version: 1,
      ...target,
      recipientPrincipalId: authorization.principalId,
      channelBinding: { channel: "fake", threadId: "delivery-thread" },
      reason: { kind: "event", id: "fixture-event" },
      urgency: "urgent",
      contentArtifactId: artifact,
      privacyClass: "conversation",
      consentVersion,
      policyVersion: "delivery-policy-v1",
      dedupeKey,
      quietHoursBehavior: "delay",
      budgetReservation: { id: `reservation-${dedupeKey}`, units: 1 },
      ...fields,
    });
    const send = (r: DeliveryRequested) => store((s) => s.request(authorization, r));
    expect((await send(request("no-budget"))).receipt).toMatchObject({
      status: "rejected",
      reason: "budget_exhausted",
      reservedUnits: 0,
      sink: null,
    });
    consentVersion = (await configure(false)).version;
    expect((await send(request("no-consent"))).receipt).toMatchObject({
      status: "rejected",
      reason: "consent_required",
      reservedUnits: 1,
      sink: null,
    });
    consentVersion = (await configure(true)).version;
    const live = request("live");
    const sent = await send(live);
    expect(sent).toMatchObject({
      disposition: "recorded",
      receipt: {
        status: "approved",
        reservedUnits: 1,
        sink: "fake",
        effectiveUrgency: "urgent",
        request: { privacyClass: "conversation" },
      },
    });
    expect(await send(live)).toEqual({ disposition: "deduplicated", receipt: sent.receipt });
    await expect(send({ ...live, reason: { kind: "goal", id: "changed" } })).rejects.toMatchObject({
      code: "delivery_key_reused",
    });
    const other = decodeConversationSession(
      await post("/v1/runtime/conversations/create", {
        actorId: "fixture.keeper",
        channel: "fake",
        threadId: "other-thread",
      }),
    );
    await post("/v1/runtime/talk", {
      sessionId: other.sessionId,
      messageId: "other-source",
      text: "other private note",
    });
    const otherArtifact = await owner.sql(
      `SELECT content_artifact_id FROM clockgrove.conversation_messages WHERE session_id='${other.sessionId}' AND role='actor'`,
    );
    await expect(
      send(request("cross-session", { contentArtifactId: otherArtifact })),
    ).rejects.toMatchObject({ code: "delivery_target_invalid" });
    await expect(
      send(
        request("wrong-binding", {
          channelBinding: { channel: "cli", threadId: "delivery-thread" },
        }),
      ),
    ).rejects.toMatchObject({ code: "delivery_target_invalid" });
    await expect(
      store((s) =>
        s.request(
          { ...authorization, principalId: decodeOpaqueId("other-member", "PrincipalId") },
          request("other-member"),
        ),
      ),
    ).rejects.toMatchObject({ code: "delivery_target_invalid" });
    await expect(
      send(request("invalid-units", { budgetReservation: { id: "invalid", units: 0 } })),
    ).rejects.toMatchObject({ code: "delivery_policy_invalid" });
    // UTC Nov 10 is still Nov 9 at 22:30 for the recipient, after the DST transition.
    instant = "2026-11-10T06:30:00.000Z";
    const waiting = await send(request("waiting"));
    expect(waiting.receipt).toMatchObject({
      status: "delayed",
      reason: "quiet_hours",
      reservedUnits: 1,
      sink: null,
    });
    expect(await store((s) => s.resume(authorization, target, "waiting"))).toEqual(waiting.receipt);
    expect((await send(request("silent", { quietHoursBehavior: "silent" }))).receipt).toMatchObject(
      {
        status: "downgraded",
        effectiveUrgency: "silent",
        sink: "fake",
        request: { privacyClass: "conversation" },
      },
    );
    expect(
      (await send(request("quiet-reject", { quietHoursBehavior: "reject" }))).receipt,
    ).toMatchObject({ status: "rejected", reason: "quiet_hours", sink: null });
    instant = "2026-11-10T15:00:00.000Z";
    expect(await store((s) => s.resume(authorization, target, "waiting"))).toMatchObject({
      status: "approved",
      reservedUnits: 1,
      sink: "fake",
    });
    instant = "2026-11-11T06:30:00.000Z";
    expect((await send(request("revoked-wait"))).receipt.status).toBe("delayed");
    await configure(false);
    instant = "2026-11-11T15:00:00.000Z";
    expect(await store((s) => s.resume(authorization, target, "revoked-wait"))).toMatchObject({
      status: "rejected",
      reason: "consent_required",
      sink: null,
    });
    await configure(true);
    expect((await send(request("stale-consent"))).receipt).toMatchObject({
      status: "rejected",
      reason: "consent_changed",
      sink: null,
    });
    consentVersion = 4;
    expect(
      (await send(request("exhausted", { budgetReservation: { id: "over-capacity", units: 31 } })))
        .receipt,
    ).toMatchObject({ status: "rejected", reason: "budget_exhausted", reservedUnits: 0 });
    await expect(configure(true, 0)).rejects.toThrow();
    await owner.sql("UPDATE clockgrove.timelines SET kind='branch'");
    const preview = await send(request("preview"));
    expect(preview.receipt).toMatchObject({
      status: "approved",
      sink: "preview",
      reservedUnits: 1,
    });
    expect(await store((s) => s.replay(authorization, target, "preview"))).toEqual(preview.receipt);
    expect(await store((s) => s.replay(authorization, target, "absent"))).toBeUndefined();
    expect(await store((s) => s.resume(authorization, target, "preview"))).toEqual(preview.receipt);
    expect(
      await owner.sql(
        "SELECT sink||':'||count(*) FROM clockgrove.delivery_sink_receipts WHERE dedupe_key NOT LIKE 'response:%' GROUP BY sink ORDER BY sink",
      ),
    ).toBe("fake:3\npreview:1");
    expect(await owner.sql("SELECT reserved_units FROM clockgrove.delivery_consent")).toBe("8");
    expect(
      await owner.sql(
        "SELECT count(*) FROM clockgrove.deliveries WHERE request->'reason'->>'kind'<>'response'",
      ),
    ).toBe("10");
    expect(
      await owner.sql("SELECT count(*) FROM clockgrove.deliveries WHERE status='reserved'"),
    ).toBe("0");
    await owner.sql("UPDATE clockgrove.world_memberships SET revoked_at=now()");
    await expect(store((s) => s.replay(authorization, target, "preview"))).rejects.toMatchObject({
      code: "delivery_target_invalid",
    });
    await owner.sql("UPDATE clockgrove.world_memberships SET revoked_at=NULL");
    // Consent and its cumulative reservations outlive the original space's sessions.
    await owner.sql(`BEGIN;
      INSERT INTO clockgrove.timeline_partitions
        (tenant_id,world_id,timeline_id,partition_id,space_id)
        SELECT tenant_id,world_id,timeline_id,'delivery-second-partition','delivery-second-space'
        FROM clockgrove.conversation_sessions WHERE session_id='${session.sessionId}';
      INSERT INTO clockgrove.world_memberships
        SELECT tenant_id,world_id,timeline_id,'delivery-second-space',principal_id,
          'delivery-second-membership',persona_id,roles,grants,privacy_ceiling,committed_at,revoked_at
        FROM clockgrove.world_memberships WHERE principal_id='${authorization.principalId}'
          AND space_id='${owner.scope.spaceId}';
      INSERT INTO clockgrove.conversation_participants
        (tenant_id,session_id,principal_id,persona_id)
        SELECT tenant_id,'delivery-second-session',principal_id,persona_id
        FROM clockgrove.conversation_participants WHERE session_id='${session.sessionId}';
      INSERT INTO clockgrove.conversation_sessions
        (tenant_id,session_id,world_id,timeline_id,partition_id,space_id,actor_id,channel,voice_mode)
        SELECT tenant_id,'delivery-second-session',world_id,timeline_id,
          'delivery-second-partition','delivery-second-space',actor_id,channel,voice_mode
        FROM clockgrove.conversation_sessions WHERE session_id='${session.sessionId}';
      INSERT INTO clockgrove.channel_bindings
        (tenant_id,world_id,timeline_id,principal_id,session_id,channel,thread_id)
        SELECT tenant_id,world_id,timeline_id,principal_id,'delivery-second-session',channel,'second-thread'
        FROM clockgrove.channel_bindings WHERE session_id='${session.sessionId}';
      UPDATE clockgrove.conversation_sessions SET state='deleted'
        WHERE space_id='${owner.scope.spaceId}';
      COMMIT;`);
    const secondTarget = {
      ...target,
      scope: decodeBrowserScope({ ...owner.scope, spaceId: "delivery-second-space" }),
      sessionId: decodeOpaqueId("delivery-second-session", "SessionId"),
    };
    const reconfigure = (budgetLimit: number) =>
      store((s) =>
        s.configureConsent(authorization, secondTarget, {
          enabled: true,
          timezone: "America/Los_Angeles",
          quietHours: null,
          budgetLimit,
        }),
      );
    const visibleConsent = () =>
      owner.withSqlClient((c) =>
        withClientTransaction(c, { authorization }, async () => {
          await c.query("SET LOCAL ROLE clockgrove_runtime");
          return (await c.query("SELECT reserved_units FROM clockgrove.delivery_consent")).rows;
        }),
      );
    expect(await visibleConsent()).toEqual([{ reserved_units: "8" }]);
    expect(await reconfigure(8)).toMatchObject({ version: 5, reservedUnits: 8, budgetLimit: 8 });
    await expect(reconfigure(7)).rejects.toThrow();
    expect(await reconfigure(9)).toMatchObject({ version: 6, reservedUnits: 8, budgetLimit: 9 });
    expect(await owner.sql("SELECT count(*) FROM clockgrove.delivery_consent")).toBe("1");
    await owner.sql(
      "UPDATE clockgrove.conversation_sessions SET state='deleted' WHERE session_id='delivery-second-session'",
    );
    await expect(reconfigure(9)).rejects.toMatchObject({ code: "delivery_target_invalid" });
    expect(await visibleConsent()).toEqual([]);
  });
}, 240_000);
