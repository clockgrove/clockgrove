import { useEffect, useRef } from "react";
import type { YardSession } from "./yard-api.js";
import { useWhyQuery } from "./yard-queries.js";

/** The control that opened the Why, so closing it returns focus there. */
export const whyOpener: { current: HTMLElement | null } = { current: null };

export function RecordedWhyPanel({ session }: { readonly session: YardSession }) {
  const why = useWhyQuery(session);
  const heading = useRef<HTMLHeadingElement>(null);
  const open = why.status !== "none";
  const loading = why.status === "loading";
  useEffect(() => {
    if (open || loading) heading.current?.focus();
  }, [open, loading]);
  if (!open) return null;
  const value = why.value;
  const onClose = () => {
    session.explain(undefined);
    const opener = whyOpener.current;
    // A breakpoint change can rebuild the rail while its recorded evidence stays open.
    const target = opener?.isConnected
      ? opener
      : [...document.querySelectorAll<HTMLButtonElement>(".rw-shell button")].find(
          (button) => button.textContent === opener?.textContent,
        );
    target?.focus();
  };
  return (
    <section
      id="rw-recorded-why"
      tabIndex={-1}
      aria-label="Recorded Why"
      aria-busy={why.status === "loading"}
    >
      <h3 ref={heading} tabIndex={-1}>
        Recorded Why: {why.commandId ?? "loading"}
      </h3>
      <p>
        This is retained evidence for the recorded command, not a new explanation of current state.
        Later canonical revisions and derived current-time values do not change this receipt.
      </p>
      <p role="status" aria-live="polite" aria-atomic="true">
        {why.status === "loading"
          ? "Loading recorded evidence."
          : why.status === "refused"
            ? "Recorded evidence request refused. Try again later."
            : why.status === "unavailable"
              ? "Recorded evidence unavailable."
              : "Recorded evidence loaded."}
      </p>
      <button type="button" onClick={onClose}>
        Close Why
      </button>
      {value && (
        <>
          <p>
            Started from{" "}
            {value.entry.kind === "command"
              ? `command ${value.commandId}`
              : value.entry.kind === "event"
                ? `event ${value.entry.eventId}`
                : `scheduled action ${value.entry.scheduleId}`}
          </p>
          <h4>Evidence classes</h4>
          <ul>
            {Object.entries(value.evidence).map(([part, label]) => (
              <li key={part}>
                {part}: {label}
              </li>
            ))}
          </ul>
          <dl>
            <dt>Recorded command</dt>
            <dd>{value.commandId}</dd>
            <dt>Recorded action</dt>
            <dd>{value.actionId ?? "None"}</dd>
            <dt>Receipt status</dt>
            <dd>{value.receiptStatus}</dd>
          </dl>
          {value.traces.status === "unavailable" ? (
            <p>Decision evidence unavailable. This does not mean an empty decision.</p>
          ) : value.traces.status === "redacted" ? (
            <p>Decision evidence redacted. This does not mean an empty decision.</p>
          ) : value.traces.drafts.length === 0 ? (
            <p>No routine decisions recorded for this receipt.</p>
          ) : (
            value.traces.drafts.map((trace) => (
              <section key={trace.draftIndex} aria-label={`Decision ${trace.draftIndex + 1}`}>
                <h4>
                  Recorded decision {trace.draftIndex + 1} for {trace.objectId}
                </h4>
                <dl>
                  <dt>Input revision</dt>
                  <dd>{trace.inputRevision}</dd>
                  <dt>Recorded simulation time</dt>
                  <dd>{trace.simulationTime}</dd>
                  <dt>Policy version</dt>
                  <dd>{trace.policyVersion}</dd>
                  <dt>Selection tier</dt>
                  <dd>{trace.selectionTier}</dd>
                  <dt>Selected action</dt>
                  <dd>
                    {trace.selectedAction.kind}; target{" "}
                    {trace.selectedAction.targetObjectId ?? "None"}
                  </dd>
                </dl>
                <h5>Candidates and score evidence</h5>
                {trace.candidates.length === 0 ? (
                  <p>No candidates recorded.</p>
                ) : (
                  <ol>
                    {trace.candidates.map((candidate) => (
                      <li key={`${candidate.action.kind}:${candidate.action.targetObjectId}`}>
                        <p>
                          {candidate.action.kind}; target{" "}
                          {candidate.action.targetObjectId ?? "None"}; score {candidate.score}
                          {"; "}
                          exclusion {candidate.excludedReason ?? "None"}
                        </p>
                        {candidate.features.length === 0 ? (
                          <p>No score features recorded.</p>
                        ) : (
                          <dl>
                            {candidate.features.map((feature) => (
                              <div key={feature.name}>
                                <dt>{feature.name}</dt>
                                <dd>{feature.value}</dd>
                              </div>
                            ))}
                          </dl>
                        )}
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            ))
          )}
          <h4>Scheduled actions</h4>
          {value.schedules.length === 0 ? (
            <p>No scheduled actions recorded for this command.</p>
          ) : (
            <ul>
              {value.schedules.map((row) => (
                <li key={`${row.scheduleId}:${row.idempotencyKey}`}>
                  {`${row.kind}; due at ${row.dueAt}; ${row.status}; scheduled by ${row.scheduledBy}; completed by ${row.completedBy ?? "pending"}`}{" "}
                  <button
                    type="button"
                    onClick={(event) => {
                      whyOpener.current = event.currentTarget;
                      session.explainSchedule(row.scheduleId, row.idempotencyKey);
                    }}
                  >
                    Trace scheduled action {row.scheduleId}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <h4>Authorized causal links</h4>
          <p>Parent commands: {value.links.parents.join(", ") || "None"}</p>
          <p>Child commands: {value.links.children.join(", ") || "None"}</p>
        </>
      )}
    </section>
  );
}
