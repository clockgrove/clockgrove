import type { RuntimeAuthorizationContext } from "@clockgrove/application";
import {
  type DeliveryReceipt,
  decodeConversationSession,
  decodeTalkReceipt,
} from "@clockgrove/contracts";
import { PostgreSqlGovernedDelivery } from "@clockgrove/persistence";
import { expect, it } from "vitest";
import { truthOf } from "./world-fixture.js";
import {
  isNativeWorldOwnerChild,
  runNativeWorldOwnerProcess,
  withNativeWorldOwner,
} from "./world-owner/native-harness.js";

const FILE = "apps/runtime/test/reply-governance.journey.postgres.test.ts";
it("commits each solicited private reply with one governed reservation independently of proactive consent", async () => {
  if (!isNativeWorldOwnerChild()) {
    await runNativeWorldOwnerProcess(FILE, "fixture/reference", {
      prepare: async (fixture) => {
        await truthOf(
          fixture,
        )(`UPDATE clockgrove.world_memberships SET grants=array_append(grants,'runtime:world-observe'),
          privacy_ceiling='{"version":1,"allowedCategories":["public_scene","conversation"]}'`);
      },
    });
    return;
  }
  await withNativeWorldOwner(async (owner) => {
    const post = async (path: string, fields: object) => {
      const response = await owner.request(path, { version: 1, ...owner.scope, ...fields });
      expect(response.status).toBe(200);
      return response.body;
    };
    const session = decodeConversationSession(
      await post("/v1/runtime/conversations/create", {
        actorId: "fixture.keeper",
        channel: "browser",
        threadId: "private-response-thread",
      }),
    );
    const input = {
      sessionId: session.sessionId,
      messageId: "solicited",
      text: "Keep this reply private.",
    };
    const first = decodeTalkReceipt(await post("/v1/runtime/talk", input));
    expect(first.reply.text).toBe(
      "Scripted fixture reply: you have said 1 thing to me in this conversation.",
    );
    const readReceipt = async () =>
      JSON.parse(
        await owner.sql(
          "SELECT receipt::text FROM clockgrove.deliveries ORDER BY dedupe_key LIMIT 1",
        ),
      ) as DeliveryReceipt;
    const receipt = await readReceipt();
    expect(receipt).toMatchObject({
      status: "approved",
      reason: "allowed",
      reservedUnits: 1,
      sink: "fake",
      request: {
        reason: { kind: "response", id: "solicited" },
        recipientPrincipalId: "principal-runtime",
        privacyClass: "conversation",
        consentVersion: 0,
        channelBinding: { channel: "browser", threadId: "private-response-thread" },
        budgetReservation: { units: 1 },
      },
    });
    expect(receipt.request.dedupeKey).toMatch(/^response:[0-9a-f]{64}$/);
    expect(receipt.request.budgetReservation.id).toBe(receipt.request.dedupeKey);
    expect(await owner.sql("SELECT count(*) FROM clockgrove.delivery_consent")).toBe("0");
    const authorization: RuntimeAuthorizationContext = {
      tenantId: session.scope.tenantId,
      principalId: session.participants[0]!.principalId,
      privacyCeiling: { version: 1, allowedCategories: ["conversation"] },
    };
    const target = { scope: session.scope, actorId: session.actorId, sessionId: session.sessionId };
    const delivery = <T>(run: (store: PostgreSqlGovernedDelivery) => Promise<T>) =>
      owner.withSqlClient((c) => run(new PostgreSqlGovernedDelivery(c)));
    await owner.replace(true);
    expect(decodeTalkReceipt(await post("/v1/runtime/talk", input)).reply).toEqual(first.reply);
    expect(
      await delivery((s) => s.replay(authorization, target, receipt.request.dedupeKey)),
    ).toEqual(receipt);
    expect(await delivery((s) => s.request(authorization, receipt.request))).toEqual({
      disposition: "deduplicated",
      receipt,
    });
    // A second key cannot mint another allowance, even for the same genuine committed pair.
    await expect(
      delivery((s) =>
        s.request(authorization, {
          ...receipt.request,
          dedupeKey: "forged-response",
          budgetReservation: { id: "forged-response", units: 1 },
        }),
      ),
    ).rejects.toThrow("PostgreSQL query failed");
    await expect(
      delivery((s) =>
        s.request(authorization, {
          ...receipt.request,
          reason: { kind: "response", id: "nonexistent" },
          dedupeKey: `response:${session.sessionId}:nonexistent`,
          budgetReservation: { id: `response:${session.sessionId}:nonexistent`, units: 1 },
        }),
      ),
    ).rejects.toThrow("PostgreSQL query failed");
    await delivery((s) =>
      s.configureConsent(authorization, target, {
        enabled: false,
        timezone: "UTC",
        quietHours: { startMinute: 0, endMinute: 1439 },
        budgetLimit: 0,
      }),
    );
    await owner.sql("UPDATE clockgrove.timelines SET kind='branch'");
    decodeTalkReceipt(await post("/v1/runtime/talk", { ...input, messageId: "preview" }));
    const longId = "m".repeat(1000);
    expect(
      decodeTalkReceipt(await post("/v1/runtime/talk", { ...input, messageId: longId })).message
        .messageId,
    ).toBe(longId);
    expect(
      await owner.sql(
        "SELECT sink||':'||count(*) FROM clockgrove.delivery_sink_receipts GROUP BY sink ORDER BY sink",
      ),
    ).toBe("fake:1\npreview:2");
    expect(
      await owner.sql(
        "SELECT enabled||'/'||reserved_units||'/'||budget_limit FROM clockgrove.delivery_consent",
      ),
    ).toBe("false/0/0");
    expect(
      await owner.sql(
        "SELECT count(*) FROM clockgrove.deliveries WHERE status='approved' AND reserved_units=1",
      ),
    ).toBe("3");
    expect(
      await owner.sql(
        "SELECT count(*) FROM clockgrove.events WHERE payload::text LIKE '%Keep this reply private%'",
      ),
    ).toBe("0");
    expect(
      await owner.sql(`SELECT count(*) FROM clockgrove.deliveries d JOIN clockgrove.artifact_references ar
      ON ar.tenant_id=d.tenant_id AND ar.artifact_id=d.content_artifact_id WHERE ar.encryption='aes-256-gcm-v1' AND ar.privacy_class='conversation'`),
    ).toBe("3");
  });
}, 240_000);
