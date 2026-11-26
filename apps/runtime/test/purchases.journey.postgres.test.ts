import { decodePurchaseReceipt, decodeRecordedWhy } from "@clockgrove/contracts";
import { expect, it } from "vitest";
import { advanceCommand } from "./world-fixture.js";
import {
  isNativeWorldOwnerChild,
  runNativeWorldOwnerProcess,
  withNativeWorldOwner,
} from "./world-owner/native-harness.js";

const FILE = "apps/runtime/test/purchases.journey.postgres.test.ts";
const DEVELOPER = "outsider-session-token";

it.skipIf(isNativeWorldOwnerChild())(
  "owns provider, PostgreSQL and workerd",
  async () => {
    await runNativeWorldOwnerProcess(FILE, "fixture/reference", {
      // The member plays and reads Why; a second principal, the developer's server, is a member
      // without the purchase grant until the test gives it.
      prepare: async (fixture) => {
        const { truthOf } = await import("./world-fixture.js");
        await truthOf(fixture)(
          `UPDATE clockgrove.world_memberships
              SET grants = array_append(grants, 'runtime:world-observe');
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
  "a purchase the developer's server reports is granted once, journaled as an outside cause Why explains, and refunded as a recorded removal",
  async () => {
    await withNativeWorldOwner(async (owner) => {
      const purchase = (
        action: "grant" | "refund",
        fields: object = {},
        credential: string = DEVELOPER,
      ) =>
        owner.request(
          "/v1/runtime/purchases",
          {
            version: 1,
            ...owner.scope,
            action,
            purchaseId: "cs_test_1",
            principalId: "principal-runtime",
            objectId: "fixture.household-food",
            resourceKind: "food",
            quantity: 2,
            ...fields,
          },
          credential,
        );
      const count = (where: string) =>
        owner.sql(`SELECT count(*)::text FROM clockgrove.command_receipts WHERE ${where}`);

      // Granting is its own right: a member without it (and not the owner) is refused and the
      // purchase id stays free.
      expect(await purchase("grant")).toMatchObject({
        status: 403,
        body: { error: "authorization_refused" },
      });
      expect(await count("command_id LIKE 'purchase%'")).toBe("0");
      // Its refund is refused for the same reason, before anything is said about the purchase.
      expect(await purchase("refund")).toMatchObject({
        status: 403,
        body: { error: "authorization_refused" },
      });
      // Nor can anyone reach a purchase through the ordinary command route.
      expect(
        await owner.submit({
          ...advanceCommand(owner.world, "purchase:cs_test_1", 0n, null),
          type: "purchase.grant",
        }),
      ).toMatchObject({ status: 400, body: { error: "invalid_world_command" } });
      // A world's owner holds the grant by default: made the owner, with no explicit grant, the
      // developer's server grants purchases.
      await owner.sql(
        `UPDATE clockgrove.world_memberships
            SET roles = ARRAY['owner'], grants = grants || ARRAY['runtime:world-operate']
          WHERE principal_id = 'principal-outsider'`,
      );

      // A refund needs the purchase's grant.
      expect(await purchase("refund")).toMatchObject({
        status: 409,
        body: { error: "purchase_not_granted" },
      });

      // The grant commits once; the same purchase again replays its receipt.
      const granted = decodePurchaseReceipt((await purchase("grant")).body);
      expect(granted).toMatchObject({
        purchaseId: "cs_test_1",
        action: "grant",
        commandId: "purchase:cs_test_1",
        status: "committed",
        quantity: 2,
      });
      expect(decodePurchaseReceipt((await purchase("grant")).body)).toEqual(granted);
      // A second holder of the grant (here the player's own principal, delegated it) sending the
      // same purchase replays the same receipt: the purchase, not its sender, is the identity.
      await owner.sql(
        `UPDATE clockgrove.world_memberships
            SET grants = grants || ARRAY['runtime:world-purchase']
          WHERE principal_id = 'principal-runtime'`,
      );
      const PLAYER = "local-reader-session";
      expect(decodePurchaseReceipt((await purchase("grant", {}, PLAYER)).body)).toEqual(granted);
      expect(await purchase("grant", { quantity: 3 })).toMatchObject({
        status: 409,
        body: { error: "command_id_reused" },
      });
      expect(
        await owner.sql(
          `SELECT count(*)::text FROM clockgrove.events WHERE event_type = 'resource.purchase-granted'`,
        ),
      ).toBe("1");

      // Why explains the food by its cause, an outside purchase, without naming the player.
      const why = await owner.request("/v1/runtime/why", {
        version: 1,
        ...owner.scope,
        commandId: "purchase:cs_test_1",
        includeResourceCauses: true,
      });
      expect(why.status).toBe(200);
      expect(
        decodeRecordedWhy(why.body).resourceCauses?.map(({ cause, kind, quantity, objectId }) => ({
          cause,
          kind,
          quantity,
          objectId,
        })),
      ).toEqual([
        { cause: "purchase", kind: "food", quantity: 2, objectId: "fixture.household-food" },
      ]);
      expect(JSON.stringify(why.body)).not.toContain("principal-runtime");

      // A paused world still records the refund, once, though another holder than the grant's
      // sends it.
      expect(
        (
          await owner.request(
            "/v1/runtime/world-mode",
            { version: 1, ...owner.scope, mode: "paused", reason: "subscription_lapsed" },
            DEVELOPER,
          )
        ).status,
      ).toBe(200);
      const refunded = decodePurchaseReceipt((await purchase("refund", {}, PLAYER)).body);
      expect(refunded).toMatchObject({
        commandId: "purchase-refund:cs_test_1",
        status: "committed",
        quantity: 2,
      });
      expect(decodePurchaseReceipt((await purchase("refund")).body)).toEqual(refunded);
      expect(
        await owner.sql(
          `SELECT string_agg(event_type, ',' ORDER BY event_type) FROM clockgrove.events
            WHERE event_type LIKE 'resource.purchase-%'`,
        ),
      ).toBe("resource.purchase-granted,resource.purchase-refunded");
      expect(await count("command_id LIKE 'purchase%'")).toBe("2");

      // An actor never grants a purchase by ownership, even holding the grant explicitly, and its
      // refusal leaves the purchase id free.
      await owner.sql(
        `UPDATE clockgrove.world_memberships
            SET roles = ARRAY['owner', 'actor'],
                grants = grants || ARRAY['runtime:world-purchase']
          WHERE principal_id = 'principal-outsider'`,
      );
      expect(await purchase("grant", { purchaseId: "cs_test_2" })).toMatchObject({
        status: 403,
        body: { error: "authorization_refused" },
      });
      expect(await count("command_id = 'purchase:cs_test_2'")).toBe("0");
      // The owner delegates it: a member holding `runtime:world-purchase` grants a purchase.
      await owner.sql(
        `UPDATE clockgrove.world_memberships SET roles = ARRAY['member']
          WHERE principal_id = 'principal-outsider'`,
      );
      expect(
        decodePurchaseReceipt((await purchase("grant", { purchaseId: "cs_test_2" })).body),
      ).toMatchObject({ commandId: "purchase:cs_test_2", status: "committed", quantity: 2 });
    });
  },
  180_000,
);
