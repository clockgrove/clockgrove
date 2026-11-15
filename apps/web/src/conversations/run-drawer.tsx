import type { RunWalk } from "@clockgrove/contracts";
import { useEffect, useState } from "react";
import type { SceneSession } from "../scene-api.js";

function cost(steps: readonly { readonly costMicrousd: number | null }[]): string {
  const known = steps.filter((step) => step.costMicrousd !== null);
  if (known.length === 0) return "unknown";
  return `$${(known.reduce((sum, step) => sum + (step.costMicrousd ?? 0), 0) / 1e6).toFixed(6)}`;
}

/** Run evidence for one turn, read through the authorized runs route; a refusal closes it. */
export function RunDrawer({
  session,
  sessionId,
  inputMessageId,
  onClose,
  onRevoked,
  refresh = "",
}: {
  readonly session: SceneSession;
  readonly sessionId: string;
  readonly inputMessageId: string;
  readonly onClose: () => void;
  readonly onRevoked: () => void;
  /** Changes as the open turn moves, so the drawer re-reads its run while it is shown. */
  readonly refresh?: string;
}) {
  const [walk, setWalk] = useState<RunWalk>();
  useEffect(() => {
    let live = true;
    void refresh;
    void session.inspectConversationRun(sessionId, inputMessageId).then((result) => {
      if (!live) return;
      if ("refused" in result) onRevoked();
      else setWalk(result);
    });
    return () => {
      live = false;
    };
  }, [session, sessionId, inputMessageId, onRevoked, refresh]);
  return (
    <aside aria-label="Run drawer">
      <h3>Run drawer</h3>
      <button type="button" onClick={onClose}>
        Close run drawer
      </button>
      {walk?.runs.map((run) => (
        <div key={run.runId}>
          <p>Status: {run.status}</p>
          <p>Outcome: {run.outcomeCode ?? "none"}</p>
          <p>Model: {run.model}</p>
          <p>World revision: {run.inputRevision}</p>
          <p>Steps</p>
          <ol aria-label="Steps">
            {run.steps.map((step) => (
              <li key={step.step}>
                {step.kind} · {step.status}
                {step.model !== null && ` · ${step.model}`}
                {step.tool !== null && ` · ${step.tool}`}
                {step.outcomeCode !== null && ` · ${step.outcomeCode}`}
              </li>
            ))}
          </ol>
          <p>Model attempts: {run.steps.filter((step) => step.kind === "model_attempt").length}</p>
          <p>
            Tool calls:{" "}
            {run.steps.some((step) => step.kind === "tool_execution")
              ? run.steps.filter((step) => step.kind === "tool_execution").length
              : run.steps.filter((step) => step.kind === "tool_proposal").length}
          </p>
          <p>Cost: {cost(run.steps)}</p>
        </div>
      ))}
    </aside>
  );
}
