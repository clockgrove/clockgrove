import {
  decodeConversationSession,
  type UsageWebhookBody,
  type UsageWebhookRegistration,
} from "@clockgrove/contracts";
import { Webhook } from "standardwebhooks";
import { expect, it } from "vitest";
import { sweepUsageWebhooks, usageWebhookSecret } from "../src/usage-webhooks.js";
import { withClient } from "./world-fixture.js";
import {
  isNativeWorldOwnerChild,
  NATIVE_USAGE_WEBHOOK_SECRET,
  runNativeWorldOwnerProcess,
  withNativeWorldOwner,
} from "./world-owner/native-harness.js";

const FILE = "apps/runtime/test/usage-webhooks.journey.postgres.test.ts";
const MEMBER = "local-reader-session";
const INSPECTOR = "outsider-session-token";

it.skipIf(isNativeWorldOwnerChild())(
  "owns provider, PostgreSQL and workerd",
  async () => {
    await runNativeWorldOwnerProcess(FILE, "fixture/reference", {
      // The member talks; a second principal holds the inspect grant and operator evidence.
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
                    'membership-outsider', 'persona-outsider', roles,
                    array_append(grants, 'runtime:world-inspect'),
                    '{"version":1,"allowedCategories":["public_scene","operator_evidence"]}', now()
               FROM clockgrove.world_memberships WHERE principal_id = 'principal-runtime'`,
        );
      },
    });
  },
  240_000,
);

it.skipIf(!isNativeWorldOwnerChild())(
  "posts usage as signed webhooks, retries a refused delivery with the same events and never repeats a delivered one",
  async () => {
    await withNativeWorldOwner(async (owner) => {
      const session = decodeConversationSession(
        (
          await owner.request(
            "/v1/runtime/conversations/create",
            { version: 1, ...owner.scope, actorId: "fixture.keeper" },
            MEMBER,
          )
        ).body,
      ).sessionId;
      await owner.request(
        "/v1/runtime/talk",
        { version: 1, ...owner.scope, sessionId: session, messageId: "m1", text: "Hello." },
        MEMBER,
      );

      // The inspector registers through the route and receives the webhook's signing secret once.
      const registered = await owner.request(
        "/v1/runtime/usage/webhook",
        { version: 1, ...owner.scope, url: "https://hooks.example/usage" },
        INSPECTOR,
      );
      expect(registered.status).toBe(200);
      const { webhookId, signingSecret } = registered.body as UsageWebhookRegistration;
      const secret = await usageWebhookSecret(NATIVE_USAGE_WEBHOOK_SECRET, webhookId);
      expect(signingSecret).toBe(secret);
      const answers = [500, 204];
      const posts: { url: string; headers: Record<string, string>; body: string }[] = [];
      const sweep = () =>
        withClient(owner.fixture.environment, (client) =>
          sweepUsageWebhooks(client, {
            secret: NATIVE_USAGE_WEBHOOK_SECRET,
            fetch: async (url, init) => {
              posts.push({
                url: String(url),
                headers: init?.headers as Record<string, string>,
                body: String(init?.body),
              });
              return new Response(null, { status: answers.shift() ?? 204 });
            },
          }),
        );
      const state = () =>
        owner.sql(
          `SELECT attempts || ',' || last_status || ',' || delivered_through || ',' || (lease_until IS NULL)
             FROM clockgrove.usage_webhooks`,
        );
      const sequences = (
        await owner.sql(
          "SELECT string_agg(sequence::text, ',' ORDER BY sequence) FROM clockgrove.usage_events",
        )
      ).split(",");
      expect(sequences).toHaveLength(2);

      // The endpoint refuses: the cursor stays and the retry waits.
      expect(await sweep()).toEqual({ delivered: 0, failed: 1 });
      expect(await state()).toBe("1,http_500,0,true");
      expect(await sweep()).toEqual({ delivered: 0, failed: 0 });
      expect(posts).toHaveLength(1);

      // Due again, it re-sends the same events under the same message ID, and the signature verifies.
      await owner.sql(
        "UPDATE clockgrove.usage_webhooks SET next_attempt_at = now() - interval '1 second'",
      );
      expect(await sweep()).toEqual({ delivered: 1, failed: 0 });
      const [refused, accepted] = posts;
      expect(accepted?.url).toBe("https://hooks.example/usage");
      expect(accepted?.headers["webhook-id"]).toBe(`${webhookId}:${sequences[0]}:${sequences[1]}`);
      expect(accepted?.headers["webhook-id"]).toBe(refused?.headers["webhook-id"]);
      expect(accepted?.body).toBe(refused?.body);
      expect(new Webhook(secret).verify(accepted?.body ?? "", accepted?.headers ?? {})).toEqual(
        JSON.parse(accepted?.body ?? ""),
      );
      const body = JSON.parse(accepted?.body ?? "") as UsageWebhookBody;
      expect(body.type).toBe("usage.events");
      expect(body.events.map((event) => [event.category, event.sequence])).toEqual([
        ["model_call", sequences[0]],
        ["delivery", sequences[1]],
      ]);
      expect(body.events[0]?.eventId).toMatch(/^run_step:.+:2$/u);
      expect(await state()).toBe(`0,delivered,${sequences[1]},true`);

      // Nothing is left to send, so a delivered event is never posted again.
      expect(await sweep()).toEqual({ delivered: 0, failed: 0 });
      expect(posts).toHaveLength(2);
    });
  },
  180_000,
);
