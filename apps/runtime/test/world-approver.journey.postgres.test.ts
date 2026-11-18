import { decodeConversationSession } from "@clockgrove/contracts";
import { expect, it } from "vitest";
import {
  ACTOR,
  CAPABILITY,
  seedWriteResearch,
  withResearchFixture,
} from "./research-node-fixture.js";
import {
  isNativeWorldOwnerChild,
  runNativeWorldOwnerProcess,
  withNativeWorldOwner,
} from "./world-owner/native-harness.js";

// The world's approver (issue 359): a second operator, `principal-second`, sorts after the
// fixture's `principal-runtime`, so routing by id alone would pick the wrong one.
const FILE = "apps/runtime/test/world-approver.journey.postgres.test.ts";
const CASES = {
  principal: { approver: { principal: "principal-second" }, routed: "principal-second" },
  role: { approver: { role: "write-approver" }, routed: "principal-second" },
  unconfigured: { approver: null, routed: undefined },
} as const;
type Case = keyof typeof CASES;

async function journey(name: Case) {
  const { approver, routed } = CASES[name];
  await withNativeWorldOwner(
    async (owner) => {
      await seedWriteResearch(owner);
      const { tenantId: t, worldId: w, timelineId: tl, spaceId: s } = owner.scope;
      await owner.sql(`INSERT INTO clockgrove.tenant_principals(tenant_id,principal_id) VALUES('${t}','principal-second');
        INSERT INTO clockgrove.world_memberships(tenant_id,world_id,timeline_id,space_id,principal_id,membership_id,persona_id,roles,grants,privacy_ceiling,committed_at)
        VALUES('${t}','${w}','${tl}','${s}','principal-second','member-second','persona-second',ARRAY['write-approver'],
        ARRAY['runtime:world-operate'],'{"version":1,"allowedCategories":["conversation","operator_evidence"]}',statement_timestamp());`);
      const post = (path: string, fields: object) =>
        owner.request(path, {
          version: 1,
          ...(path.startsWith("/v1/runtime/activations/")
            ? { scope: owner.scope, actorId: ACTOR }
            : owner.scope),
          ...fields,
        });
      const sessionId = decodeConversationSession(
        (await post("/v1/runtime/conversations/create", { actorId: ACTOR })).body,
      ).sessionId;
      expect(
        (
          await post("/v1/runtime/activations/configure", {
            configuration: {
              id: "write",
              sessionId,
              kind: "heartbeat",
              nextWakeAt: null,
              intervalMs: null,
              input: `fixture:research 1 ${CAPABILITY} ${JSON.stringify({ q: "archive" })}`,
              priority: 1,
              enabled: true,
              compiledRoutine: "escalate",
            },
            policy: { allowModel: true, modelBudget: 10 },
          })
        ).status,
      ).toBe(200);
      const wake = () =>
        post("/v1/runtime/activations/wake", {
          wake: {
            configurationId: "write",
            causalRoot: "write-root",
            reason: { kind: "heartbeat", heartbeatId: "write" },
            evidence: "fixture",
          },
        });
      if (routed !== undefined) {
        expect((await wake()).body).toMatchObject({ status: "pending" });
        expect(
          await owner.sql(
            "SELECT approver_principal_id||'/'||state FROM clockgrove.effect_approvals",
          ),
        ).toBe(`${routed}/pending`);
        return;
      }
      await expect
        .poll(async () => (await wake()).body, { timeout: 90000 })
        .toMatchObject({ status: "completed" });
      const read = await post("/v1/runtime/conversations/read", { sessionId });
      expect(JSON.stringify(read.body)).toContain(
        "Fixture research refused: Tool refused: approver_unconfigured",
      );
      expect(
        await owner.sql(
          "SELECT (SELECT count(*) FROM clockgrove.effect_approvals)||'/'||(SELECT count(*) FROM clockgrove.effect_attempts)",
        ),
      ).toBe("0/0");
      expect(await fetch(`${process.env.NATIVE_RESEARCH_ORIGIN}/count`).then((r) => r.text())).toBe(
        "0",
      );
    },
    { approver },
  );
}

for (const name of Object.keys(CASES) as Case[]) {
  it(`routes a proactive write's approval by the world's approver: ${name}`, async () => {
    if (isNativeWorldOwnerChild()) {
      if (process.env.WORLD_APPROVER_CASE === name) await journey(name);
      return;
    }
    process.env.WORLD_APPROVER_CASE = name;
    try {
      await withResearchFixture(() =>
        runNativeWorldOwnerProcess(FILE, "fixture/reference", {
          queues: true,
          timeoutMs: 240000,
          inheritOutput: true,
        }),
      );
    } finally {
      delete process.env.WORLD_APPROVER_CASE;
    }
  }, 300000);
}
