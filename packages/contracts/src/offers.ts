import { type BrowserScope, decodeBrowserScope } from "./browser-protocol.js";
import { decodeOpaqueId } from "./ids.js";
import { decodeOutsideUrl } from "./usage-webhooks.js";
import { ContractDecodeError, exactKeys, record, string } from "./validation.js";

// Offers: see docs/protocols/usage.md, "Offers". The developer's server defines in-world offers,
// each presented by an actor; the world shows them in a player's conversation with that actor and
// records `offer_shown` and `offer_chosen` usage events. Checkout stays the developer's: no price,
// currency, balance or payment account is part of any shape here.

/** An offer id: the developer's own identifier. */
export const OFFER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
/** Decision: a card's line. */
export const MAX_OFFER_TITLE = 80;
/** Decision: a short paragraph. */
export const MAX_OFFER_TEXT = 280;
/** Decision: at most 100 offers a space, a page. */
export const MAX_SPACE_OFFERS = 100;

/** One offer as the developer defined it. */
export interface WorldOffer {
  readonly offerId: string;
  /** The actor that presents it: a character, or an object standing for a shop. */
  readonly actorId: string;
  readonly title: string;
  readonly text: string;
  /** The developer's own checkout page, linked after a choice; `null` when they act on the event. */
  readonly checkoutUrl: string | null;
}

/** Sets one offer of the caller's space, or withdraws it with `offer: null`. */
export interface WorldOfferRequest {
  readonly version: 1;
  readonly scope: BrowserScope;
  readonly offerId: string;
  readonly offer: Omit<WorldOffer, "offerId"> | null;
}

/** The space's offers that are not withdrawn, in `offerId` order. */
export interface WorldOfferList {
  readonly offers: readonly WorldOffer[];
}

/** Asks for the offers the session's actor presents, as the session's participant. */
export interface OfferShowRequest {
  readonly scope: BrowserScope;
  readonly sessionId: string;
}

/** Chooses one offer shown in the session. */
export interface OfferChooseRequest {
  readonly scope: BrowserScope;
  readonly sessionId: string;
  readonly offerId: string;
}

/** An offer as a player is shown it, with whether they chose it in this session. */
export interface ShownOffer extends WorldOffer {
  readonly chosen: boolean;
}

export interface OfferList {
  readonly offers: readonly ShownOffer[];
}

/**
 * A recorded choice: the offer and the `offer_chosen` usage event's ID, which the developer's
 * checkout receives as `clockgrove_choice` to match the event.
 */
export interface OfferChoice {
  readonly offer: ShownOffer;
  readonly eventId: string;
}

export function decodeOfferId(value: unknown, path: string): string {
  const id = string(value, path);
  if (!OFFER_ID_PATTERN.test(id))
    throw new ContractDecodeError(path, "1 to 128 of A-Z, a-z, 0-9, '.', '_', ':' or '-'");
  return id;
}

function text(value: unknown, path: string, min: number, max: number): string {
  const s = string(value, path);
  const length = [...s].length;
  if (length < min || length > max || s.trim() !== s)
    throw new ContractDecodeError(path, `${min} to ${max} characters, not padded`);
  return s;
}

const SCOPE_KEYS = ["version", "tenantId", "worldId", "timelineId", "spaceId"] as const;

function scoped(value: unknown, path: string, keys: readonly string[]) {
  const v = record(value, path);
  exactKeys(v, [...SCOPE_KEYS, ...keys], [], path);
  if (v.version !== 1) throw new ContractDecodeError(`${path}.version`, "expected 1");
  const { tenantId, worldId, timelineId, spaceId } = v;
  return { v, scope: decodeBrowserScope({ tenantId, worldId, timelineId, spaceId }) };
}

function sessionId(value: unknown, path: string): string {
  const id = string(value, path);
  if (id === "" || id.trim() !== id || new TextEncoder().encode(id).length > 1024)
    throw new ContractDecodeError(path, "ID length out of range");
  return id;
}

export function decodeWorldOfferRequest(value: unknown): WorldOfferRequest {
  const path = "worldOffer";
  const { v, scope } = scoped(value, path, ["offerId", "offer"]);
  const offerId = decodeOfferId(v.offerId, `${path}.offerId`);
  if (v.offer === null) return Object.freeze({ version: 1, scope, offerId, offer: null });
  const o = record(v.offer, `${path}.offer`);
  exactKeys(o, ["actorId", "title", "text", "checkoutUrl"], [], `${path}.offer`);
  return Object.freeze({
    version: 1,
    scope,
    offerId,
    offer: Object.freeze({
      actorId: String(decodeOpaqueId(o.actorId, "ObjectId", `${path}.offer.actorId`)),
      title: text(o.title, `${path}.offer.title`, 1, MAX_OFFER_TITLE),
      text: text(o.text, `${path}.offer.text`, 0, MAX_OFFER_TEXT),
      checkoutUrl:
        o.checkoutUrl === null
          ? null
          : decodeOutsideUrl(o.checkoutUrl, `${path}.offer.checkoutUrl`),
    }),
  });
}

export function decodeOfferShowRequest(value: unknown): OfferShowRequest {
  const path = "showOffers";
  const { v, scope } = scoped(value, path, ["sessionId"]);
  return Object.freeze({ scope, sessionId: sessionId(v.sessionId, `${path}.sessionId`) });
}

export function decodeOfferChooseRequest(value: unknown): OfferChooseRequest {
  const path = "chooseOffer";
  const { v, scope } = scoped(value, path, ["sessionId", "offerId"]);
  return Object.freeze({
    scope,
    sessionId: sessionId(v.sessionId, `${path}.sessionId`),
    offerId: decodeOfferId(v.offerId, `${path}.offerId`),
  });
}

function decodeShownOffer(value: unknown, path: string): ShownOffer {
  const o = record(value, path);
  exactKeys(o, ["offerId", "actorId", "title", "text", "checkoutUrl", "chosen"], [], path);
  if (typeof o.chosen !== "boolean") throw new ContractDecodeError(`${path}.chosen`, "boolean");
  return Object.freeze({
    offerId: decodeOfferId(o.offerId, `${path}.offerId`),
    actorId: string(o.actorId, `${path}.actorId`),
    title: text(o.title, `${path}.title`, 1, MAX_OFFER_TITLE),
    text: text(o.text, `${path}.text`, 0, MAX_OFFER_TEXT),
    checkoutUrl: o.checkoutUrl === null ? null : decodeOutsideUrl(o.checkoutUrl, `${path}.url`),
    chosen: o.chosen,
  });
}

/** Decodes the runtime's answer to a show request (the browser reads it). */
export function decodeOfferList(value: unknown): OfferList {
  const path = "offerList";
  const v = record(value, path);
  exactKeys(v, ["offers"], [], path);
  if (!Array.isArray(v.offers) || v.offers.length > MAX_SPACE_OFFERS)
    throw new ContractDecodeError(`${path}.offers`, "at most 100 offers");
  return Object.freeze({
    offers: Object.freeze(v.offers.map((o, i) => decodeShownOffer(o, `${path}.offers.${i}`))),
  });
}

/** Decodes the runtime's answer to a choice (the browser reads it). */
export function decodeOfferChoice(value: unknown): OfferChoice {
  const path = "offerChoice";
  const v = record(value, path);
  exactKeys(v, ["offer", "eventId"], [], path);
  const eventId = string(v.eventId, `${path}.eventId`);
  if (!/^offer_chosen:[0-9a-f]{64}$/u.test(eventId))
    throw new ContractDecodeError(`${path}.eventId`, "an offer_chosen event ID");
  return Object.freeze({ offer: decodeShownOffer(v.offer, `${path}.offer`), eventId });
}

/**
 * The developer's checkout link for a choice: their URL with `clockgrove_choice` set to the
 * `offer_chosen` event's ID, so they match the visit to the event they receive.
 */
export function offerCheckoutHref(choice: OfferChoice): string | null {
  if (choice.offer.checkoutUrl === null) return null;
  const url = new URL(choice.offer.checkoutUrl);
  url.searchParams.set("clockgrove_choice", choice.eventId);
  return url.href;
}
