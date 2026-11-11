import {
  type ActivationAddress,
  CAPABILITY_REGISTRY,
  type ConversationParticipant,
} from "@clockgrove/application";
import {
  decodeBrowserScope,
  decodeConversationSession,
  decodeConversationTranscript,
} from "@clockgrove/contracts";
import { PostgreSqlGovernedDelivery } from "@clockgrove/persistence";
import { expect, it } from "vitest";
import { truthOf } from "./world-fixture.js";
import {
  isNativeWorldOwnerChild,
  runNativeWorldOwnerProcess,
  withNativeWorldOwner,
} from "./world-owner/native-harness.js";

const FILE = "apps/runtime/test/proactive-delivery.journey.postgres.test.ts";
it("delivers a canonical proactive reply once with snapshotted intent, consent and quiet-hour governance", async () => {
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
    const actorId = "fixture.keeper";
    const post = async (path: string, fields: object) => {
      const r = await owner.request(path, {
        version: 1,
        ...(path.startsWith("/v1/runtime/conversations/") ? owner.scope : {}),
        ...fields,
      });
      expect(r.status).toBe(200);
      return r.body as Record<string, unknown>;
    };
    const activationPost = (op: string, fields: object) =>
      post(`/v1/runtime/activations/${op}`, { scope: owner.scope, actorId, ...fields });
    const agent = (fields: object) =>
      post("/actor-agent", { scope: owner.scope, actorId, ...fields });
    const session = decodeConversationSession(
      await post("/v1/runtime/conversations/create", {
        actorId,
        channel: "fake",
        threadId: "proactive-thread",
      }),
    );
    const participant: ConversationParticipant = {
      tenantId: session.scope.tenantId,
      ...session.participants[0]!,
      privacyCeiling: { version: 1, allowedCategories: ["conversation"] },
    };
    const address: ActivationAddress = {
      scope: decodeBrowserScope(owner.scope),
      actorId,
      participant,
    };
    const target = { scope: address.scope, actorId, sessionId: session.sessionId };
    const consent = (
      enabled: boolean,
      quietHours: { startMinute: number; endMinute: number } | null = null,
    ) =>
      owner.withSqlClient((c) =>
        new PostgreSqlGovernedDelivery(c).configureConsent(participant, target, {
          enabled,
          timezone: "UTC",
          quietHours,
          budgetLimit: 20,
        }),
      );
    const configure = (
      id: string,
      delivery: object = { urgency: "normal", quietHoursBehavior: "delay" },
    ) =>
      activationPost("configure", {
        configuration: {
          id,
          sessionId: session.sessionId,
          kind: "operator",
          nextWakeAt: null,
          intervalMs: null,
          input: "Please send a private note",
          priority: 1,
          enabled: true,
          compiledRoutine: "escalate",
          delivery,
        },
        policy: { allowModel: true, modelBudget: 10 },
      });
    const wake = (configurationId: string, causalRoot: string) =>
      activationPost("wake", {
        wake: {
          configurationId,
          causalRoot,
          reason: { kind: "operator", commandId: causalRoot },
          evidence: "fixture event",
        },
      });
    expect(
      CAPABILITY_REGISTRY.grantsFor(["runtime:world-observe", "runtime:world-command"]).available(),
    ).not.toContain("delivery.request");
    expect(
      await owner.sql(
        `SELECT clockgrove.lock_activation_delivery_authority('${owner.scope.tenantId}','${owner.scope.worldId}','${owner.scope.timelineId}','${owner.scope.spaceId}','${participant.principalId}')`,
      ),
    ).toBe("f");
    await consent(true);
    await configure("note");
    await configure("alias", { urgency: "urgent", quietHoursBehavior: "reject" });
    await agent({ op: "fault", phase: "hold:context_ready" });
    const first = wake("note", "note-root");
    await expect
      .poll(() =>
        owner.sql(
          "SELECT count(*) FROM clockgrove.conversation_turn_fibers WHERE phase='context_ready'",
        ),
      )
      .toBe("1");
    const joined = wake("alias", "alias-root");
    await expect
      .poll(() =>
        owner.sql("SELECT count(*) FROM clockgrove.actor_activations WHERE status='pending'"),
      )
      .toBe("2");
    // Configuration edits cannot rewrite a committed admission's delivery intent.
    await configure("note", { urgency: "urgent", quietHoursBehavior: "reject" });
    await agent({ op: "fault", phase: null });
    await agent({ op: "release" });
    const [sent, alias] = await Promise.all([first, joined]);
    expect(sent.activationId).toBe(alias.activationId);
    expect(await wake("note", "note-root")).toEqual(sent);
    const transcript = decodeConversationTranscript(
      await post("/v1/runtime/conversations/read", { sessionId: session.sessionId }),
    );
    expect(transcript.messages.map((message) => message.text)).toEqual([
      "Please send a private note",
      "Scripted fixture reply: you have said 1 thing to me in this conversation.",
    ]);
    expect(await owner.sql("SELECT count(*) FROM clockgrove.deliveries")).toBe("1");
    expect(await owner.sql("SELECT count(*) FROM clockgrove.delivery_sink_receipts")).toBe("1");
    expect(
      await owner.sql(
        "SELECT receipt->>'status'||'/'||(request->>'urgency')||'/'||(request->>'quietHoursBehavior')||'/'||(receipt->>'sink') FROM clockgrove.deliveries",
      ),
    ).toBe("approved/normal/delay/fake");
    expect(
      await owner.sql(`SELECT count(*) FROM clockgrove.deliveries d JOIN clockgrove.conversation_messages m
      ON m.tenant_id=d.tenant_id AND m.session_id=d.session_id AND m.content_artifact_id=d.content_artifact_id
      WHERE m.role='actor' AND m.author_id='fixture.keeper' AND d.principal_id='principal-runtime'
        AND d.request->>'privacyClass'='conversation' AND d.request->'channelBinding'->>'channel'='fake'`),
    ).toBe("1");
    await expect(
      owner.sql("UPDATE clockgrove.actor_activations SET delivery_intent=NULL"),
    ).rejects.toThrow("activation delivery intent is immutable");
    await consent(false);
    await wake("note", "no-consent-root");
    expect(
      await owner.sql(
        "SELECT count(*) FROM clockgrove.deliveries WHERE receipt->>'reason'='consent_required' AND status='rejected'",
      ),
    ).toBe("1");
    const now = new Date();
    const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
    // Decision: a 20-minute window surrounds now so this short native journey cannot cross a boundary.
    await consent(true, {
      startMinute: (minute + 1440 - 10) % 1440,
      endMinute: (minute + 10) % 1440,
    });
    await configure("quiet");
    await wake("quiet", "quiet-root");
    expect(
      await owner.sql("SELECT count(*) FROM clockgrove.deliveries WHERE status='delayed'"),
    ).toBe("1");
    expect(await owner.sql("SELECT count(*) FROM clockgrove.delivery_sink_receipts")).toBe("1");
    expect(
      await owner.sql("SELECT count(*) FROM clockgrove.conversation_messages WHERE role='actor'"),
    ).toBe("3");
    expect(
      await owner.sql("SELECT count(DISTINCT actor_id) FROM clockgrove.conversation_sessions"),
    ).toBe("1");
    // The internal retry reads the original receipt even after consent changes.
    expect(
      (
        await owner.withSqlClient((c) =>
          new PostgreSqlGovernedDelivery(c).requestActivation(address, String(sent.activationId)),
        )
      )?.disposition,
    ).toBe("deduplicated");
    expect(await owner.sql("SELECT reserved_units FROM clockgrove.delivery_consent")).toBe("3");
    expect(
      (
        await owner.withSqlClient(async (c) => {
          await c.query("SET ROLE clockgrove_runtime");
          try {
            return await new PostgreSqlGovernedDelivery(c).requestActivation(
              address,
              String(sent.activationId),
            );
          } finally {
            await c.query("RESET ROLE");
          }
        })
      )?.disposition,
    ).toBe("deduplicated");
    await owner.sql(
      "UPDATE clockgrove.world_memberships SET grants=array_remove(grants,'runtime:world-command')",
    );
    await expect(
      owner.withSqlClient((c) =>
        new PostgreSqlGovernedDelivery(c).requestActivation(address, String(sent.activationId)),
      ),
    ).rejects.toMatchObject({ code: "delivery_target_invalid" });
    expect(await owner.sql("SELECT count(*) FROM clockgrove.delivery_sink_receipts")).toBe("1");
  });
}, 240_000);
