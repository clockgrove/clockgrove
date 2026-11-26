import {
  decodeConversationSession,
  decodeOfferChoice,
  decodeOfferList,
  offerCheckoutHref,
  type UsagePage,
} from "@clockgrove/contracts";
import { expect, it } from "vitest";
import {
  isNativeWorldOwnerChild,
  runNativeWorldOwnerProcess,
  withNativeWorldOwner,
} from "./world-owner/native-harness.js";

const FILE = "apps/runtime/test/offers.journey.postgres.test.ts";
const MEMBER = "local-reader-session";
const OPERATOR = "outsider-session-token";

it.skipIf(isNativeWorldOwnerChild())(
  "owns provider, PostgreSQL and workerd",
  async () => {
    await runNativeWorldOwnerProcess(FILE, "fixture/reference", {
      // The member plays; a second principal, the developer's server, holds the inspect grant and
      // operator evidence, and operates the world once the test grants it.
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
  "the developer's offers are shown in a conversation with their actor, and shown and chosen become events",
  async () => {
    await withNativeWorldOwner(async (owner) => {
      const post = (path: string, fields: object, credential = MEMBER) =>
        owner.request(path, { version: 1, ...owner.scope, ...fields }, credential);
      const setOffer = (offerId: string, offer: object | null) =>
        post("/v1/runtime/offers", { offerId, offer }, OPERATOR);
      const upgrade = {
        actorId: "fixture.keeper",
        title: "Lantern upgrade",
        text: "A brighter lantern for the hall.",
        checkoutUrl: "https://shop.example/checkout?item=lantern",
      };
      const session = decodeConversationSession(
        (await post("/v1/runtime/conversations/create", { actorId: "fixture.keeper" })).body,
      ).sessionId;
      const show = async () =>
        decodeOfferList(
          (await post("/v1/runtime/conversations/offers", { sessionId: session })).body,
        ).offers;
      const choose = (offerId: string) =>
        post("/v1/runtime/conversations/offers/choose", { sessionId: session, offerId });
      const offerEvents = async () =>
        ((await post("/v1/runtime/usage/query", {}, OPERATOR)).body as UsagePage).events.filter(
          (event) => event.source === "offer_presentation",
        );

      // Defining an offer is the purchase's grant, which the operator's grant never implies.
      expect((await setOffer("lantern", upgrade)).status).toBe(403);
      await owner.sql(
        `UPDATE clockgrove.world_memberships SET grants = array_append(grants, 'runtime:world-operate')
          WHERE principal_id = 'principal-outsider'`,
      );
      expect((await setOffer("lantern", upgrade)).status).toBe(403);
      await owner.sql(
        `UPDATE clockgrove.world_memberships SET grants = array_append(grants, 'runtime:world-purchase')
          WHERE principal_id = 'principal-outsider'`,
      );
      expect((await setOffer("lantern", upgrade)).body).toEqual({
        offers: [{ offerId: "lantern", ...upgrade }],
      });
      expect(
        (await setOffer("elsewhere", { ...upgrade, actorId: "fixture.other", checkoutUrl: null }))
          .status,
      ).toBe(200);

      // Shown in the keeper's conversation, once per session however often it is asked.
      expect(await show()).toEqual([{ offerId: "lantern", ...upgrade, chosen: false }]);
      expect((await show()).length).toBe(1);
      const [player, persona] = (
        await owner.sql(
          `SELECT principal_id || '|' || persona_id FROM clockgrove.conversation_participants
            WHERE session_id = '${session}'`,
        )
      ).split("|");
      const attribution = {
        principalId: player,
        personaId: persona,
        actorId: "fixture.keeper",
        sessionId: session,
        runId: null,
        resource: "lantern",
        quantities: { offers: 1 },
      };
      const shown = await offerEvents();
      expect(shown).toMatchObject([{ category: "offer_shown", status: "shown", ...attribution }]);
      expect(shown[0]?.eventId).toMatch(/^offer_shown:[0-9a-f]{64}$/u);

      // Another actor's offer is not shown here, so it cannot be chosen here.
      expect(await choose("elsewhere")).toMatchObject({
        status: 409,
        body: { error: "offer_not_available" },
      });

      // A paused world still shows and takes offers: they are the developer's way back to play.
      expect(
        (
          await post(
            "/v1/runtime/world-mode",
            { mode: "paused", reason: "subscription_lapsed" },
            OPERATOR,
          )
        ).status,
      ).toBe(200);
      const choice = decodeOfferChoice((await choose("lantern")).body);
      expect(choice.offer.chosen).toBe(true);
      expect(decodeOfferChoice((await choose("lantern")).body).eventId).toBe(choice.eventId);
      expect(offerCheckoutHref(choice)).toBe(
        `https://shop.example/checkout?item=lantern&clockgrove_choice=${choice.eventId.replaceAll(":", "%3A")}`,
      );
      const events = await offerEvents();
      expect(events.map((event) => event.category)).toEqual(["offer_shown", "offer_chosen"]);
      expect(events[1]).toMatchObject({
        eventId: choice.eventId,
        status: "chosen",
        ...attribution,
      });
      expect(await show()).toEqual([{ offerId: "lantern", ...upgrade, chosen: true }]);

      // Withdrawn: no longer shown, its events stay.
      expect((await setOffer("lantern", null)).body).toEqual({
        offers: [{ offerId: "elsewhere", ...upgrade, actorId: "fixture.other", checkoutUrl: null }],
      });
      expect(await show()).toEqual([]);
      expect((await offerEvents()).length).toBe(2);
      expect(
        await owner.sql(
          `SELECT count(*) FROM clockgrove.inspector_accesses WHERE subject = 'world-offer'`,
        ),
      ).toBe("3");
    });
  },
  120_000,
);
