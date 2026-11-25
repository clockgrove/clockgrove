import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  decodeConversationSession,
  decodeTalkReceipt,
  type UsageAdmissionHookRegistration,
  type UsageBudgetList,
  type UsagePage,
} from "@clockgrove/contracts";
import { Webhook } from "standardwebhooks";
import { expect, it } from "vitest";
import {
  isNativeWorldOwnerChild,
  runNativeWorldOwnerProcess,
  withNativeWorldOwner,
} from "./world-owner/native-harness.js";

const FILE = "apps/runtime/test/usage-admission.journey.postgres.test.ts";
const MEMBER = "local-reader-session";
const OPERATOR = "outsider-session-token";
const BUDGET = { scope: "player", category: "model_call", quantity: "calls", period: "day" };

it.skipIf(isNativeWorldOwnerChild())(
  "owns provider, PostgreSQL and workerd",
  async () => {
    await runNativeWorldOwnerProcess(FILE, "fixture/reference", {
      // The member talks; a second principal holds the inspect and operate grants and operator
      // evidence, and is no owner until the test makes it one.
      prepare: async (fixture) => {
        const { truthOf } = await import("./world-fixture.js");
        await truthOf(fixture)(
          `UPDATE clockgrove.world_memberships
              SET grants = array_append(grants, 'runtime:world-observe'),
                  privacy_ceiling = '{"version":1,"allowedCategories":["public_scene","conversation"]}';
           INSERT INTO clockgrove.tenant_principals (tenant_id, principal_id)
             SELECT DISTINCT tenant_id, 'principal-outsider' FROM clockgrove.world_memberships;
           INSERT INTO clockgrove.world_memberships (
             tenant_id, world_id, timeline_id, space_id, principal_id, membership_id, persona_id,
             roles, grants, privacy_ceiling, committed_at
           ) SELECT tenant_id, world_id, timeline_id, space_id, 'principal-outsider',
                    'membership-outsider', 'persona-outsider', ARRAY['member'],
                    array_append(array_remove(grants, 'runtime:world-operate'), 'runtime:world-inspect'),
                    '{"version":1,"allowedCategories":["public_scene","operator_evidence"]}', now()
               FROM clockgrove.world_memberships WHERE principal_id = 'principal-runtime'`,
        );
      },
    });
  },
  240_000,
);

it.skipIf(!isNativeWorldOwnerChild())(
  "refuses a model call before it is sent when a budget is spent or the developer's hook says no",
  async () => {
    const requests: { body: string; headers: Record<string, string> }[] = [];
    let secret = "";
    const hook = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = Buffer.concat(chunks).toString();
        const headers = request.headers as Record<string, string>;
        try {
          new Webhook(secret).verify(body, headers);
          requests.push({ body, headers });
          response.end(JSON.stringify({ admit: false, reason: "subscription_lapsed" }));
        } catch {
          response.writeHead(401).end();
        }
      });
    });
    await new Promise<void>((done) => hook.listen(0, "127.0.0.1", done));
    process.env.NATIVE_USAGE_ADMISSION_ORIGIN = `http://127.0.0.1:${(hook.address() as AddressInfo).port}`;
    try {
      await withNativeWorldOwner(async (owner) => {
        const post = (path: string, fields: object, credential = MEMBER) =>
          owner.request(path, { version: 1, ...owner.scope, ...fields }, credential);
        const setBudget = (limit: number) =>
          post("/v1/runtime/usage/budget", { budget: { ...BUDGET, limit } }, OPERATOR);
        const session = decodeConversationSession(
          (await post("/v1/runtime/conversations/create", { actorId: "fixture.keeper" })).body,
        ).sessionId;
        const talk = async (messageId: string) =>
          decodeTalkReceipt(
            (await post("/v1/runtime/talk", { sessionId: session, messageId, text: "Hello." }))
              .body,
          ).reply;

        // Operating the world is the grant a limit on spend needs.
        expect((await setBudget(1)).status).toBe(403);
        await owner.sql(
          `UPDATE clockgrove.world_memberships SET grants = array_append(grants, 'runtime:world-operate')
            WHERE principal_id = 'principal-outsider'`,
        );
        expect((await setBudget(1)).body as UsageBudgetList).toEqual({
          budgets: [{ ...BUDGET, limit: 1 }],
        });

        expect((await talk("m1")).serviceOutcome).toBeUndefined();
        const refused = await talk("m2");
        expect([refused.serviceOutcome, refused.text]).toEqual([
          "usage_refused",
          "Usage refused: usage_budget_exhausted. No model was called.",
        ]);
        expect(
          await owner.sql(
            `SELECT s.outcome_code || '|' || s.summary FROM clockgrove.run_steps s
               JOIN clockgrove.agent_runs r USING (tenant_id, run_id)
              WHERE r.input_message_id = 'm2' AND s.kind = 'model_attempt'`,
          ),
        ).toBe("usage_refused|Usage refused: usage_budget_exhausted");
        const events = (
          await post(
            "/v1/runtime/usage/query",
            { from: "2000-01-01T00:00:00Z", to: "2100-01-01T00:00:00Z" },
            OPERATOR,
          )
        ).body as UsagePage;
        expect(
          events.events
            .filter((event) => event.category === "model_call")
            .map((event) => [event.outcomeCode, event.quantities.calls]),
        ).toEqual([
          [null, 1],
          ["usage_refused", 0],
        ]);

        // A hook is registered by a usage-webhook holder: the world's owner.
        expect((await setBudget(100)).status).toBe(200);
        const url = "https://hooks.example.com/admit";
        const register = () => post("/v1/runtime/usage/admission-hook", { url }, OPERATOR);
        expect((await register()).status).toBe(403);
        await owner.sql(
          `UPDATE clockgrove.world_memberships SET roles = ARRAY['owner']
            WHERE principal_id = 'principal-outsider'`,
        );
        const registered = (await register()).body as UsageAdmissionHookRegistration;
        expect(registered.url).toBe(url);
        expect(registered.signingSecret).toMatch(/^whsec_/u);
        secret = registered.signingSecret ?? "";

        const lapsed = await talk("m3");
        expect([lapsed.serviceOutcome, lapsed.text]).toEqual([
          "usage_refused",
          "Usage refused: usage_admission_refused:subscription_lapsed. No model was called.",
        ]);
        expect(requests).toHaveLength(1);
        expect(requests[0]?.headers["webhook-id"]).toMatch(/^admission_/u);
        expect(JSON.parse(requests[0]?.body ?? "")).toEqual({
          type: "usage.admission",
          admission: {
            category: "model_call",
            resource: "scripted-fixture-v1",
            worldId: owner.scope.worldId,
            timelineId: owner.scope.timelineId,
            spaceId: owner.scope.spaceId,
            principalId: "principal-runtime",
            personaId: "persona-runtime",
            actorId: "fixture.keeper",
            sessionId: session,
            runId: expect.stringMatching(/^run/u),
          },
        });
      });
    } finally {
      hook.close();
    }
  },
  180_000,
);
