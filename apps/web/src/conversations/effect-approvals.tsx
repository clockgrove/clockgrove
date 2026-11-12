import { useCallback, useEffect, useState } from "react";
import type { SceneSession } from "../scene-api.js";

interface ApprovalPreview {
  readonly approval: {
    readonly approvalId: string;
    readonly worldId: string;
    readonly timelineId: string;
    readonly spaceId: string;
    readonly effectId: string;
    readonly state: string;
    readonly expiresAt: string;
    readonly decidedBy: string | null;
  };
  readonly capability?: string;
  readonly arguments: unknown;
}
interface UncertainWrite {
  readonly effectId: string;
  readonly callId: string;
  readonly attemptId: string;
  readonly outcomeCode: string;
  readonly retryAllowed: boolean;
}

/** Previews and decisions are server-authorized anew on every request. */
export function EffectApprovals({
  session,
  sessionId,
  operator = false,
}: {
  readonly session: SceneSession;
  readonly sessionId?: string | undefined;
  readonly operator?: boolean;
}) {
  const [approvals, setApprovals] = useState<ApprovalPreview[]>([]);
  const [uncertain, setUncertain] = useState<UncertainWrite[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    const result = await session.effectRequest<{ approvals: ApprovalPreview[] }>(
      "approvals",
      sessionId ? { sessionId } : {},
    );
    setApprovals(result.approvals);
    if (operator) {
      const unresolved = await session.effectRequest<{ uncertain: UncertainWrite[] }>("uncertain");
      setUncertain(unresolved.uncertain);
    }
  }, [session, sessionId, operator]);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        await refresh();
      } catch {
        if (active) setError("Effect controls unavailable");
      }
      // Match turn status cadence without overlapping slow protected-preview reads.
      if (active) timer = setTimeout(() => void read(), 1_000);
    };
    void read();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [refresh]);
  const act = async (action: string, payload: object) => {
    setBusy(true);
    setError("");
    try {
      await session.effectRequest(action, payload);
      await refresh();
    } catch {
      setError("Effect controls unavailable. Refresh to read the recorded decision.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <aside aria-label={operator ? "Operator approvals" : "Call approvals"}>
      {operator && <h2>Approvals and uncertain writes</h2>}
      {approvals.map(({ approval, capability, arguments: args }) => (
        <section key={approval.approvalId} aria-label={`Approval ${approval.approvalId}`}>
          <p>Proposed call: {capability ?? approval.effectId}</p>
          <p>Effect: {approval.effectId}</p>
          <p>
            Scope: {approval.worldId} / {approval.timelineId} / {approval.spaceId}
          </p>
          <p>{approval.state === "pending" ? "Awaiting approval" : `Approval ${approval.state}`}</p>
          <section aria-label="Exact call arguments">
            <pre>{JSON.stringify(args, null, 2)}</pre>
          </section>
          <p>
            Expires <time dateTime={approval.expiresAt}>{approval.expiresAt}</time>
          </p>
          {approval.state === "pending" && (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void act("decide", { approvalId: approval.approvalId, decision: "approved" })
                }
              >
                Approve exact call
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void act("decide", { approvalId: approval.approvalId, decision: "denied" })
                }
              >
                Deny call
              </button>
            </>
          )}
          {(approval.state === "pending" || approval.state === "approved") && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void act("revoke", { approvalId: approval.approvalId })}
            >
              Revoke approval
            </button>
          )}
        </section>
      ))}
      {uncertain.map((write) => (
        <section key={write.effectId} aria-label={`Uncertain write ${write.callId}`}>
          <p>
            Uncertain write: {write.callId} ({write.outcomeCode}). Check the provider before
            recording a resolution.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void act("resolve", { ...write, disposition: "done" })}
          >
            Mark done after checking provider
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void act("resolve", { ...write, disposition: "failed" })}
          >
            Mark failed after checking provider
          </button>
          {write.retryAllowed ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void act("retry", { effectId: write.effectId })}
            >
              Propose safe retry for fresh approval
            </button>
          ) : (
            <p>Retry unavailable: this call has no safe idempotency declaration.</p>
          )}
        </section>
      ))}
      {error && <p role="status">{error}</p>}
    </aside>
  );
}
