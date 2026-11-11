import type { ConversationParticipant } from "@clockgrove/application";
import { decodeBrowserScope, decodeConversationSession } from "@clockgrove/contracts";
import { PostgreSqlGovernedDelivery } from "@clockgrove/persistence";
import { expect, it } from "vitest";
import { truthOf } from "./world-fixture.js";
import {
  isNativeWorldOwnerChild,
  runNativeWorldOwnerProcess,
  withNativeWorldOwner,
} from "./world-owner/native-harness.js";

const FILE = "apps/runtime/test/delayed-delivery.journey.postgres.test.ts";
it("automatically resumes quiet-hour delivery after actor replacement without another turn or duplicate send", async () => {
  if (!isNativeWorldOwnerChild()) {
    await runNativeWorldOwnerProcess(FILE, "fixture/reference", {
      // Two real minute boundaries and alarm cadence fit inside this native child deadline.
      timeoutMs: 330_000,
      prepare: async (fixture) => {
        await truthOf(fixture)(`UPDATE clockgrove.world_memberships
          SET grants=array_append(grants,'runtime:world-observe'),
          privacy_ceiling='{"version":1,"allowedCategories":["public_scene","conversation"]}'`);
      },
    });
    return;
  }
  await withNativeWorldOwner(async (owner) => {
    const actorId = "fixture.keeper";
    const post = async (path: string, fields: object) => {
      const result = await owner.request(path, { version: 1, ...fields });
      expect(result.status).toBe(200);
      return result.body;
    };
    const activation = (op: string, fields: object) =>
      post(`/v1/runtime/activations/${op}`, { scope: owner.scope, actorId, ...fields });
    const agent = (op: string) => post("/actor-agent", { scope: owner.scope, actorId, op });
    const session = decodeConversationSession(
      await post("/v1/runtime/conversations/create", {
        ...owner.scope,
        actorId,
        channel: "fake",
        threadId: "delayed-thread",
      }),
    );
    const participant: ConversationParticipant = {
      tenantId: session.scope.tenantId,
      ...session.participants[0]!,
      privacyCeiling: { version: 1, allowedCategories: ["conversation"] },
    };
    const target = {
      scope: decodeBrowserScope(owner.scope),
      actorId,
      sessionId: session.sessionId,
    };
    const configureConsent = (enabled: boolean, startMinute: number, endMinute: number) =>
      owner.withSqlClient((client) =>
        new PostgreSqlGovernedDelivery(client).configureConsent(participant, target, {
          enabled,
          timezone: "UTC",
          quietHours: { startMinute, endMinute },
          budgetLimit: 10,
        }),
      );
    const configuration = {
      id: "note",
      sessionId: session.sessionId,
      kind: "operator",
      nextWakeAt: null,
      intervalMs: null,
      input: "Send a quiet private note",
      priority: 1,
      enabled: true,
      compiledRoutine: "escalate",
      delivery: { urgency: "normal", quietHoursBehavior: "delay" },
    };
    const configure = () =>
      activation("configure", { configuration, policy: { allowModel: true, modelBudget: 10 } });
    const wake = (causalRoot: string) =>
      activation("wake", {
        wake: {
          configurationId: "note",
          causalRoot,
          reason: { kind: "operator", commandId: causalRoot },
          evidence: "fixture",
        },
      });
    const now = new Date();
    const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
    // Decision: end two minutes ahead so admission cannot race the next minute boundary.
    await configureConsent(true, minute, (minute + 2) % 1440);
    await configure();
    const first = await wake("quiet-note");
    expect(await owner.sql("SELECT status FROM clockgrove.deliveries")).toBe("delayed");
    expect(await owner.sql("SELECT count(*) FROM clockgrove.delivery_sink_receipts")).toBe("0");
    expect(await owner.sql("SELECT status FROM clockgrove.actor_activations WHERE leader")).toBe(
      "completed",
    );
    expect(((await agent("alarms")) as string[]).length).toBeGreaterThan(0);
    await owner.replace();
    // Real SDK alarm, wall clock and recipient UTC quiet-hour boundary; no explicit resume call.
    await expect
      .poll(() => owner.sql("SELECT status FROM clockgrove.deliveries"), { timeout: 180_000 })
      .toBe("approved");
    expect(
      await owner.sql(
        "SELECT sink||':'||count(*) FROM clockgrove.delivery_sink_receipts GROUP BY sink",
      ),
    ).toBe("fake:1");
    expect(await wake("quiet-note")).toEqual(first);
    const replay = await owner.withSqlClient((client) =>
      new PostgreSqlGovernedDelivery(client).replay(
        participant,
        target,
        `activation:${(first as { activationId: string }).activationId}`,
      ),
    );
    expect(replay?.status).toBe("approved");
    expect(await owner.sql("SELECT count(*) FROM clockgrove.delivery_sink_receipts")).toBe("1");
    expect(
      await owner.sql("SELECT count(*) FROM clockgrove.conversation_messages WHERE role='actor'"),
    ).toBe("1");
    const later = new Date();
    const laterMinute = later.getUTCHours() * 60 + later.getUTCMinutes();
    await configureConsent(true, (laterMinute + 1434) % 1440, (laterMinute + 6) % 1440);
    await wake("revoked-note");
    expect(
      await owner.sql("SELECT count(*) FROM clockgrove.deliveries WHERE status='delayed'"),
    ).toBe("1");
    await configureConsent(false, 0, 0);
    // An explicit configuration change requests an early check, but never resumes a delivery itself.
    await configure();
    await expect
      .poll(
        () =>
          owner.sql(
            "SELECT count(*) FROM clockgrove.deliveries WHERE receipt->>'reason'='consent_required'",
          ),
        { timeout: 90_000 },
      )
      .toBe("1");
    expect(await owner.sql("SELECT count(*) FROM clockgrove.delivery_sink_receipts")).toBe("1");
    expect(await owner.sql("SELECT reserved_units FROM clockgrove.delivery_consent")).toBe("2");
  });
}, 360_000);
