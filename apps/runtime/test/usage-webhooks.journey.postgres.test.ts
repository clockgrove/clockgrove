import { createHmac } from "node:crypto";
import {
  decodeConversationSession,
  type UsageWebhookBody,
  type UsageWebhookRegistration,
} from "@clockgrove/contracts";
import { PostgreSqlUsageWebhooks } from "@clockgrove/persistence";
import { Webhook } from "standardwebhooks";
import { expect, it } from "vitest";
import { sweepUsageWebhooks } from "../src/usage-webhooks.js";
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
      // The member talks; a second principal, not an owner, holds the inspect and operate grants and
      // operator evidence; during the test it registers as an owner, then as a delegate of
      // `runtime:usage-webhook`.
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
               FROM clockgrove.world_memberships WHERE principal_id = 'principal-runtime';
           UPDATE clockgrove.world_memberships
              SET roles = ARRAY['member'],
                  grants = array_append(array_remove(grants, 'runtime:world-operate'),
                                        'runtime:world-operate')
            WHERE principal_id = 'principal-outsider';`,
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

      // Operating the world is not enough: the registration is refused until the owner delegates
      // `runtime:usage-webhook` to the inspector.
      const unauthorized = await owner.request(
        "/v1/runtime/usage/webhook",
        { version: 1, ...owner.scope, url: "https://hooks.example/usage" },
        INSPECTOR,
      );
      expect(unauthorized.status).toBe(403);
      // A world's owner holds `runtime:usage-webhook` by default: made an owner, with no explicit
      // webhook grant, the same principal registers through the route.
      await owner.sql(
        `UPDATE clockgrove.world_memberships SET roles = ARRAY['owner']
          WHERE principal_id = 'principal-outsider'`,
      );
      const asOwner = await owner.request(
        "/v1/runtime/usage/webhook",
        { version: 1, ...owner.scope, url: "https://hooks.example/usage" },
        INSPECTOR,
      );
      expect(asOwner.status).toBe(200);
      // No longer the owner, the principal is delegated the grant instead.
      await owner.sql(
        `UPDATE clockgrove.world_memberships
            SET roles = ARRAY['member'], grants = array_append(grants, 'runtime:usage-webhook')
          WHERE principal_id = 'principal-outsider'`,
      );
      // The delegate registers through the route and receives the webhook's signing secret; the
      // re-registration keeps the webhook.
      const registered = await owner.request(
        "/v1/runtime/usage/webhook",
        { version: 1, ...owner.scope, url: "https://hooks.example/usage" },
        INSPECTOR,
      );
      expect(registered.status).toBe(200);
      expect((registered.body as UsageWebhookRegistration).webhookId).toBe(
        (asOwner.body as UsageWebhookRegistration).webhookId,
      );
      // Each registration commits with its audit row, naming where the export now goes.
      expect(
        await owner.sql(
          `SELECT string_agg(concat_ws('|', principal_id, subject, entry_id, decision, reason_code), ',')
             FROM clockgrove.inspector_accesses WHERE subject = 'usage-webhook'`,
        ),
      ).toBe(
        [1, 2]
          .map(() => "principal-outsider|usage-webhook|https://hooks.example|allow|served")
          .join(","),
      );
      const { webhookId, signingSecret } = registered.body as UsageWebhookRegistration;
      // Derived here, independently of the code under test: the deployment secret's HMAC of this
      // webhook's id, so one secret for every webhook, or one ignoring the deployment's, fails.
      const secret = `whsec_${createHmac("sha256", NATIVE_USAGE_WEBHOOK_SECRET).update(webhookId).digest("base64")}`;
      expect(signingSecret).toBe(secret);
      const answers = [500, 204];
      const posts: { url: string; headers: Record<string, string>; body: string }[] = [];
      let duringPost: (() => Promise<unknown>) | undefined;
      const sweep = (pageSize?: number) =>
        withClient(owner.fixture.environment, (client) =>
          sweepUsageWebhooks(client, {
            secret: NATIVE_USAGE_WEBHOOK_SECRET,
            ...(pageSize === undefined ? {} : { pageSize }),
            fetch: async (url, init) => {
              posts.push({
                url: String(url),
                headers: init?.headers as Record<string, string>,
                body: String(init?.body),
              });
              await duringPost?.();
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

      // A webhook that is behind is drained in one sweep, a page at a time, not a page per cron run.
      await owner.request(
        "/v1/runtime/talk",
        { version: 1, ...owner.scope, sessionId: session, messageId: "m2", text: "Again." },
        MEMBER,
      );
      const later = (
        await owner.sql(
          `SELECT string_agg(sequence::text, ',' ORDER BY sequence) FROM clockgrove.usage_events
            WHERE sequence > ${sequences[1]}`,
        )
      ).split(",");
      expect(later).toHaveLength(2);
      expect(await sweep(1)).toEqual({ delivered: 2, failed: 0 });
      expect(posts.slice(2).map((post) => post.headers["webhook-id"])).toEqual(
        later.map((sequence) => `${webhookId}:${sequence}:${sequence}`),
      );
      expect(await state()).toBe(`0,delivered,${later[1]},true`);

      // The registrar loses `runtime:usage-webhook` after the due listing, here during the post:
      // the settle is refused as not due, so the sweep ends cleanly with the cursor kept.
      await owner.request(
        "/v1/runtime/talk",
        { version: 1, ...owner.scope, sessionId: session, messageId: "m3", text: "Once more." },
        MEMBER,
      );
      duringPost = () =>
        owner.sql(
          `UPDATE clockgrove.world_memberships
              SET grants = array_remove(grants, 'runtime:usage-webhook')
            WHERE principal_id = 'principal-outsider'`,
        );
      expect(await sweep()).toEqual({ delivered: 1, failed: 0 });
      expect(await state()).toBe(`0,delivered,${later[1]},false`);
      // Its lease run out, the webhook is not listed again, and a claim racing the loss is refused
      // as not due rather than failing.
      await owner.sql("UPDATE clockgrove.usage_webhooks SET lease_until = NULL");
      expect(await sweep()).toEqual({ delivered: 0, failed: 0 });
      expect(posts).toHaveLength(5);
      expect(
        await withClient(owner.fixture.environment, (client) =>
          new PostgreSqlUsageWebhooks(client).claim(
            { ...owner.scope, principalId: "principal-outsider" },
            1_000,
          ),
        ),
      ).toBeNull();
    });
  },
  180_000,
);
