import { type OfferChoice, offerCheckoutHref, type ShownOffer } from "@clockgrove/contracts";
import { useEffect, useState } from "react";
import type { SceneSession } from "../scene-api.js";

/**
 * The offers the developer defined for this conversation's actor (issue 329). Asking for them is
 * what records each as shown; choosing one records the choice, and checkout stays the developer's:
 * their page is linked, never called, with the choice's event ID.
 */
export function ConversationOffers({
  session,
  sessionId,
}: {
  readonly session: SceneSession;
  readonly sessionId: string;
}) {
  const [offers, setOffers] = useState<readonly ShownOffer[]>([]);
  const [choices, setChoices] = useState<Readonly<Record<string, OfferChoice>>>({});
  const [refused, setRefused] = useState<string>();
  useEffect(() => {
    let live = true;
    void session.showOffers(sessionId).then((answer) => {
      if (!live) return;
      if ("refused" in answer) return setRefused(answer.refused);
      setOffers(answer.offers);
      // An offer chosen earlier in this session (before a reload, or in another visit to this
      // conversation) keeps its checkout link: a repeated choice records nothing new and answers
      // the same event ID.
      for (const offer of answer.offers)
        if (offer.chosen)
          void session.chooseOffer(sessionId, offer.offerId).then((choice) => {
            if (live && !("refused" in choice))
              setChoices((current) => ({ ...current, [offer.offerId]: choice }));
          });
    });
    return () => {
      live = false;
    };
  }, [session, sessionId]);
  if (refused !== undefined) return <p role="status">Offers unavailable ({refused}).</p>;
  if (offers.length === 0) return null;
  const choose = async (offerId: string) => {
    setRefused(undefined);
    const answer = await session.chooseOffer(sessionId, offerId);
    if ("refused" in answer) return setRefused(answer.refused);
    setChoices((current) => ({ ...current, [offerId]: answer }));
    setOffers((current) =>
      current.map((offer) => (offer.offerId === offerId ? answer.offer : offer)),
    );
  };
  return (
    <section aria-label="Offers" className="rw-offers">
      <h3>Offers</h3>
      <ul>
        {offers.map((offer) => {
          const choice = choices[offer.offerId];
          const href = choice === undefined ? null : offerCheckoutHref(choice);
          return (
            <li key={offer.offerId}>
              <strong>{offer.title}</strong>
              {offer.text !== "" && <p>{offer.text}</p>}
              {offer.chosen ? (
                <p role="status">Chosen.</p>
              ) : (
                <button type="button" onClick={() => void choose(offer.offerId)}>
                  {`Choose ${offer.title}`}
                </button>
              )}
              {href !== null && (
                <a href={href} target="_blank" rel="noopener noreferrer">
                  Continue to checkout
                </a>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
