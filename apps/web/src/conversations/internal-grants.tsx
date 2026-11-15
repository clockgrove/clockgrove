import { useEffect, useState } from "react";
import type { ActorGrants, SceneSession } from "../scene-api.js";

type ObjectId = Parameters<SceneSession["actorGrants"]>[0];

/** Shown only when the server returned grants, which it does only for an operator. */
export function InternalGrants({
  session,
  actorId,
}: {
  readonly session: SceneSession;
  readonly actorId: ObjectId;
}) {
  const [view, setView] = useState<ActorGrants>();
  const [refusal, setRefusal] = useState("");
  useEffect(() => {
    let active = true;
    setView(undefined);
    void session.actorGrants(actorId).then((result) => {
      if (active && result && !("refused" in result)) setView(result);
    });
    return () => {
      active = false;
    };
  }, [session, actorId]);
  if (!view) return null;
  const revoke = async (capability: string) => {
    setRefusal("");
    const result = await session.revokeCapability(actorId, capability);
    if ("refused" in result) setRefusal(result.refused);
    else setView(result);
  };
  return (
    <section aria-label="Internal grants">
      <h3>Internal grants</h3>
      <p>
        Model budget: {view.modelCallsReserved} of {view.policy.modelBudget} used
        {view.policy.allowModel ? "" : " (model off)"}
      </p>
      <ul aria-label="Internal capabilities">
        {view.grants.map((grant) => (
          <li key={grant.capability}>
            {[
              grant.capability,
              grant.effect,
              `${grant.callsPerTurn} ${grant.callsPerTurn === 1 ? "call" : "calls"} per turn`,
              ...(grant.commandTypes ? [grant.commandTypes.join(", ")] : []),
              ...(grant.revoked ? ["revoked"] : []),
            ].join(" · ")}
            {!grant.revoked && (
              <button type="button" onClick={() => void revoke(grant.capability)}>
                Revoke {grant.capability}
              </button>
            )}
          </li>
        ))}
      </ul>
      {refusal && <p role="status">Revoke refused: {refusal}</p>}
    </section>
  );
}
