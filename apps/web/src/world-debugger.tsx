import type {
  EntitySelection,
  EventId,
  LivingScene,
  ObjectId,
  PublicDecisionTrace,
  PublicRoutineCandidate,
  RecordedWhy,
  RunSummary,
  RunView,
  RunWalk,
} from "@clockgrove/contracts";
import { useEffect, useState } from "react";
import { ApiRefusal } from "./api.js";
import { playgroundHosted } from "./playground-pack.js";
import type { DebuggerJournalPage, SceneSession } from "./scene-api.js";
import { whyOpener } from "./why.js";

type Refused = { readonly refused: string };
interface PackChecks {
  readonly metadata: { readonly name: string; readonly version: string };
  readonly checks: {
    readonly status: string;
    readonly results: readonly {
      readonly name: string;
      readonly scenario: string | null;
      readonly status: string;
    }[];
  };
}

/**
 * At most 20 entity reads per Show decisions, each with one history window (100 journal positions,
 * `PostgreSqlObjectHistoryReader`'s window), so at most 2,000 positions. Every read counts: the
 * first, each older window, and each current-revision re-read after the world's moving revision
 * refused a cursor (a refused read returns no window, so it is not counted as one). The public entity
 * read is not rate limited, so this is the whole bound on one click.
 */
const DECISION_PAGES = 20;
const ACTOR_NEEDS = ["hunger", "thirst", "wetness", "health", "rain", "uncomfortable", "U"];

/** The step kinds that carry a cost (the ones issue 329 meters); a null cost elsewhere is no cost. */
const PRICED_KINDS: ReadonlySet<string> = new Set(["model_attempt", "tool_execution"]);

/** The run's cost from its priced steps; says so when a step that carries a cost has none known. */
export function cost(
  steps: readonly { readonly kind: string; readonly costMicrousd: number | null }[],
): string {
  const priced = steps.filter((step) => step.costMicrousd !== null || PRICED_KINDS.has(step.kind));
  const known = priced.filter((step) => step.costMicrousd !== null);
  if (known.length === 0) return "unknown";
  const total = `$${(known.reduce((sum, step) => sum + (step.costMicrousd ?? 0), 0) / 1e6).toFixed(6)}`;
  return known.length === priced.length
    ? total
    : `at least ${total} (${priced.length - known.length} of ${priced.length} priced steps without a known cost)`;
}

const refusalOf = (error: unknown) =>
  error instanceof ApiRefusal ? `status ${error.status}` : "runtime unavailable";
const list = (ids: readonly string[]) => (ids.length === 0 ? "None" : ids.join(", "));
const describe = (action: {
  readonly kind: string;
  readonly targetObjectId: string | null;
}): string => `${action.kind} → ${action.targetObjectId ?? "None"}`;
const featureOf = (candidate: PublicRoutineCandidate, name: string) =>
  candidate.features.find((feature) => feature.name === name)?.value;

/** Whether this page asked for the debugger: the playground host, or `?debugger` on any world. */
function requested(): boolean {
  return playgroundHosted || new URLSearchParams(location.search).has("debugger");
}

type JournalEvent = DebuggerJournalPage["events"][number];
interface JournalState {
  readonly head: string;
  readonly events: readonly JournalEvent[];
  readonly beforeSequence: string | null;
}

/**
 * Owner-only, read-only evidence. Asked for only by the playground host or `?debugger`, so ordinary
 * play makes no owner read; it renders nothing unless the runtime-state read answers 200, nothing
 * for a 401 or 403, and a retry for any other refusal.
 */
export function WorldDebugger({
  session,
  scene,
}: {
  readonly session: SceneSession;
  readonly scene: LivingScene;
}) {
  const [access, setAccess] = useState<"allowed" | "denied" | { readonly unavailable: string }>();
  const [journal, setJournal] = useState<JournalState | Refused>();
  useEffect(() => {
    if (!requested()) return;
    let live = true;
    void session.debuggerAccess().then((answer) => {
      if (live) setAccess(answer);
    });
    return () => {
      live = false;
    };
  }, [session]);
  if (access === undefined || access === "denied") return null;
  if (typeof access === "object")
    return (
      <section aria-label="World debugger">
        <p>World debugger unavailable ({access.unavailable}).</p>
        <button type="button" onClick={() => void session.debuggerAccess().then(setAccess)}>
          Retry world debugger
        </button>
      </section>
    );
  const loadJournal = (older: boolean) => {
    const cursor =
      older && journal !== undefined && !("refused" in journal)
        ? journal.beforeSequence
        : undefined;
    void session
      .readJournal(cursor === undefined || cursor === null ? {} : { beforeSequence: cursor })
      .then((page) => {
        if ("refused" in page) return setJournal(page);
        setJournal((current) => ({
          head: page.journalHead,
          events:
            older && current !== undefined && !("refused" in current)
              ? [...current.events, ...page.events]
              : page.events,
          beforeSequence: page.beforeSequence,
        }));
      });
  };
  return (
    <details>
      <summary>World debugger</summary>
      <p>
        Owner-only and read-only: every value here is recorded evidence read with your credential;
        nothing here changes the world.
      </p>
      <DebuggerJournal session={session} journal={journal} load={loadJournal} />
      <DebuggerTimeline session={session} journal={journal} />
      <DebuggerRuns session={session} />
      <DebuggerChecks session={session} />
      <DebuggerActors session={session} scene={scene} />
    </details>
  );
}

function causeOf(event: JournalEvent): string {
  return [
    `command ${event.commandId}`,
    `causation ${event.causationId ?? "none"}`,
    `actor ${event.effectiveActorId}`,
    `root action ${event.causalRootActionId}`,
    ...(event.ruleFiringId === null ? [] : [`rule firing ${event.ruleFiringId}`]),
    ...(event.decisionTraceId === null ? [] : [`decision trace ${event.decisionTraceId}`]),
  ].join("; ");
}

function DebuggerJournal({
  session,
  journal,
  load,
}: {
  readonly session: SceneSession;
  readonly journal: JournalState | Refused | undefined;
  readonly load: (older: boolean) => void;
}) {
  const [causes, setCauses] = useState<Readonly<Record<string, string>>>({});
  const read = (eventId: EventId) => {
    setCauses((current) => ({ ...current, [eventId]: "Reading cause." }));
    session.readEventWhy(eventId).then(
      (why: RecordedWhy) =>
        setCauses((current) => ({
          ...current,
          [eventId]: `Caused by command ${why.commandId}; receipt ${why.receiptStatus}; parent commands ${list(why.links.parents)}; child commands ${list(why.links.children)}`,
        })),
      () => setCauses((current) => ({ ...current, [eventId]: "Recorded Why unavailable." })),
    );
  };
  return (
    <section aria-label="Debugger journal">
      <h3>Debugger journal</h3>
      <button type="button" onClick={() => load(false)}>
        Load journal
      </button>
      {journal !== undefined && "refused" in journal && <p>Journal refused: {journal.refused}</p>}
      {journal !== undefined && !("refused" in journal) && (
        <>
          <p>
            {`Journal head ${journal.head}; ${journal.events.length} events read, newest first${journal.beforeSequence === null ? ", back to the start of the journal" : ""}.`}
          </p>
          <ol aria-label="Journal events">
            {journal.events.map((event) => (
              <li key={event.eventId}>
                {`#${event.partitionSequence} ${event.type} at simulation time ${event.simulationTime} (${event.privacyClass})`}
                <p>{`Recorded cause: ${causeOf(event)}`}</p>
                {event.privacyClass === "public_scene" && (
                  <>
                    <button type="button" onClick={() => read(event.eventId)}>
                      {`Cause of event ${event.eventId}`}
                    </button>
                    {causes[event.eventId] !== undefined && <p>{causes[event.eventId]}</p>}
                    {causes[event.eventId]?.startsWith("Caused by") && (
                      <button
                        type="button"
                        data-why-opener={`debugger:${event.eventId}`}
                        onClick={(click) => {
                          whyOpener.current = click.currentTarget;
                          session.explainEvent(event.eventId);
                        }}
                      >
                        {`Open Why for event ${event.eventId}`}
                      </button>
                    )}
                  </>
                )}
              </li>
            ))}
          </ol>
          {journal.beforeSequence !== null && (
            <button type="button" onClick={() => load(true)}>
              Older journal events
            </button>
          )}
        </>
      )}
    </section>
  );
}

/**
 * The timeline as the journal records it, oldest first, and its replay: replaying the journal from
 * the world's birth (or its latest snapshot) to the chosen position rebuilds the world as it was.
 */
function DebuggerTimeline({
  session,
  journal,
}: {
  readonly session: SceneSession;
  readonly journal: JournalState | Refused | undefined;
}) {
  const events =
    journal !== undefined && !("refused" in journal) ? [...journal.events].reverse() : [];
  // The chosen journal position, not its index: loading older events or a newer head moves indexes.
  const [chosen, setChosen] = useState<string>();
  const [replay, setReplay] = useState<DebuggerJournalPage["replay"] | Refused>();
  const found = events.findIndex((event) => event.partitionSequence === chosen);
  const index = found === -1 ? events.length - 1 : found;
  const current = events[index];
  const step = (to: number) => {
    const event = events[Math.max(0, Math.min(events.length - 1, to))];
    if (event !== undefined) setChosen(event.partitionSequence);
  };
  const replayTo = (sequence: string) => {
    void session
      .readJournal({ replayTo: sequence })
      .then((page) => setReplay("refused" in page ? page : page.replay));
  };
  return (
    <section aria-label="Debugger timeline">
      <h3>Debugger timeline</h3>
      {current === undefined ? (
        <p>Load the journal to step through the timeline and replay it.</p>
      ) : (
        <>
          <p>{`Position ${index + 1} of ${events.length}: #${current.partitionSequence} ${current.type} at simulation time ${current.simulationTime}.`}</p>
          <button type="button" aria-disabled={index === 0} onClick={() => step(index - 1)}>
            Earlier position
          </button>
          <button
            type="button"
            aria-disabled={index === events.length - 1}
            onClick={() => step(index + 1)}
          >
            Later position
          </button>
          <button type="button" onClick={() => replayTo(current.partitionSequence)}>
            {`Replay to #${current.partitionSequence}`}
          </button>
        </>
      )}
      {replay !== undefined && "refused" in replay && <p>Replay refused: {replay.refused}</p>}
      {replay !== undefined && !("refused" in replay) && replay.status === "unavailable" && (
        <p>{`Replay to #${replay.to} unavailable: ${replay.reason}.`}</p>
      )}
      {replay !== undefined && !("refused" in replay) && replay.status === "replayed" && (
        <section aria-label="Replay result">
          <p>
            {`Replayed to #${replay.to} from ${replay.start}: ${replay.eventsApplied} events applied; revision ${replay.revision}; simulation time ${replay.simulationTime}; rain ${replay.rainIntensity}; state hash ${replay.stateHash}${replay.matchesLive === undefined ? "" : replay.matchesLive ? "; matches the live projection" : "; differs from the live projection"}.`}
          </p>
          <ul>
            {replay.entities.map((entity) => (
              <li key={entity.objectId}>
                {`${entity.objectId}: location ${entity.locationId ?? "None"}; action ${entity.selectedAction ?? "None"}`}
              </li>
            ))}
          </ul>
        </section>
      )}
      <p>The Timeline panel beside the scene steps through the recent material events.</p>
      <button
        type="button"
        onClick={() => {
          const target =
            document.getElementById("rw-timeline-earlier") ??
            document.getElementById("rw-timeline");
          target?.setAttribute("tabindex", "-1");
          target?.focus();
        }}
      >
        Go to Timeline
      </button>
    </section>
  );
}

function DebuggerRuns({ session }: { readonly session: SceneSession }) {
  const [runs, setRuns] = useState<readonly RunSummary[] | Refused>();
  const [walks, setWalks] = useState<Readonly<Record<string, RunWalk | Refused>>>({});
  const load = () => {
    void session.searchRuns(20).then(setRuns);
  };
  const inspect = (runId: string) => {
    void session
      .inspectRun(runId)
      .then((walk) => setWalks((current) => ({ ...current, [runId]: walk })));
  };
  return (
    <section aria-label="Debugger runs">
      <h3>Debugger runs</h3>
      <button type="button" onClick={load}>
        Load runs
      </button>
      {runs !== undefined && "refused" in runs && <p>Runs refused: {runs.refused}</p>}
      {runs !== undefined && !("refused" in runs) && runs.length === 0 && <p>No runs recorded.</p>}
      {runs !== undefined && !("refused" in runs) && runs.length > 0 && (
        <ul>
          {runs.map((run) => {
            const walk = walks[run.runId];
            return (
              <li key={run.runId}>
                {`Run ${run.runId}: ${run.status}, model ${run.model}, actor ${run.actorId}, ${run.stepCount} steps`}{" "}
                <button type="button" onClick={() => inspect(run.runId)}>
                  {`Inspect run ${run.runId}`}
                </button>
                {walk !== undefined && "refused" in walk && <p>Runs refused: {walk.refused}</p>}
                {walk !== undefined &&
                  !("refused" in walk) &&
                  walk.runs
                    .filter((view) => view.runId === run.runId)
                    .map((view) => <RunDetail key={view.runId} run={view} />)}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function RunDetail({ run }: { readonly run: RunView }) {
  const calls = (kind: string) => run.steps.filter((step) => step.kind === kind).length;
  return (
    <div>
      <p>Status: {run.status}</p>
      <p>Outcome: {run.outcomeCode ?? "none"}</p>
      <p>Model: {run.model}</p>
      <ol aria-label="Run steps">
        {run.steps.map((step) => (
          <li key={step.step}>
            {step.kind} · {step.status}
            {step.model !== null && ` · ${step.model}`}
            {step.tool !== null && ` · ${step.tool}`}
            {(step.inputTokens !== null || step.outputTokens !== null) &&
              ` · ${step.inputTokens ?? "unknown"} in / ${step.outputTokens ?? "unknown"} out tokens`}
            {step.costMicrousd !== null && ` · $${(step.costMicrousd / 1e6).toFixed(6)}`}
          </li>
        ))}
      </ol>
      <p>Model calls: {calls("model_attempt")}</p>
      <p>
        Tool calls: {calls("tool_execution") > 0 ? calls("tool_execution") : calls("tool_proposal")}
      </p>
      <p>Approvals: {calls("approval")}</p>
      <p>Cost: {cost(run.steps)}</p>
    </div>
  );
}

function DebuggerChecks({ session }: { readonly session: SceneSession }) {
  const [pack, setPack] = useState<PackChecks | "unavailable">();
  return (
    <section aria-label="Debugger checks">
      <h3>Debugger checks</h3>
      {playgroundHosted ? (
        <>
          <button
            type="button"
            onClick={() =>
              void session
                .playgroundRequest<PackChecks>("pack")
                .then(setPack, () => setPack("unavailable"))
            }
          >
            Load checks
          </button>
          {pack === "unavailable" && <p>Checks unavailable.</p>}
          {typeof pack === "object" && (
            <>
              <p>Checks: {pack.checks.status}</p>
              <ul>
                {pack.checks.results.map((result) => (
                  <li key={`${result.name}/${result.scenario ?? ""}`}>
                    {result.name}
                    {result.scenario !== null && ` (${result.scenario})`}: {result.status}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      ) : (
        <p>
          Pack checks run with the pack CLI: clockgrove pack build and clockgrove pack test
          (packages/simulator/docs/cli.md). This host serves no pack checks.
        </p>
      )}
    </section>
  );
}

type Decisions =
  | { readonly kind: "failed" }
  | {
      readonly kind: "read";
      readonly selection: EntitySelection;
      /** Why the history read stopped before its start, when it did. */
      readonly stopped?: string;
      readonly traces: readonly {
        readonly status: string;
        readonly drafts: readonly PublicDecisionTrace[];
      }[];
    };

type PublicAction = EntitySelection["history"]["actions"][number];

/**
 * An actor's newest decisions, at most 5. Each history page is one window of the space's journal
 * filtered to this actor, so follow the cursor until 5 are found, the history ends or the page bound
 * is reached; `stopped` says why the read ended short of the history's start.
 */
export async function recentDecisions(
  read: (cursor?: { observedRevision: string; beforeSequence: string }) => Promise<EntitySelection>,
): Promise<{
  readonly selection: EntitySelection;
  readonly decisions: readonly PublicAction[];
  readonly stopped?: string;
}> {
  const selection = await read();
  const decisions = selection.history.actions.filter((action) => action.decision === true);
  let cursor = selection.history.beforeSequence;
  let revision = selection.history.observedRevision;
  // Entity reads made (the bound) and history windows actually read (what the stop text reports).
  let reads = 1;
  let windows = 1;
  let stopped: string | undefined;
  const bounded = () =>
    `Read ${windows} history windows in ${reads} entity reads; older decisions were not read.`;
  while (decisions.length < 5 && cursor !== null) {
    if (reads >= DECISION_PAGES) {
      stopped = bounded();
      break;
    }
    reads += 1;
    try {
      const older = await read({ observedRevision: revision, beforeSequence: cursor });
      windows += 1;
      decisions.push(...older.history.actions.filter((action) => action.decision === true));
      cursor = older.history.beforeSequence;
    } catch (error) {
      // A cursor names the revision it was read at; the world moving on answers 409
      // (selection_unavailable). The journal below the cursor does not change, so read the
      // current revision and go on from the same cursor. Any other refusal stops and says so.
      // The refused read returned no window, so it is counted as a read and not as a window.
      if (!(error instanceof ApiRefusal) || error.status !== 409) {
        stopped = `History read refused (${refusalOf(error)}); older decisions were not read.`;
        break;
      }
      if (reads >= DECISION_PAGES) {
        stopped = bounded();
        break;
      }
      reads += 1;
      try {
        // The current revision's newest window was already read, so this adds no window.
        revision = (await read()).history.observedRevision;
      } catch (current) {
        stopped = `History read refused (${refusalOf(current)}); older decisions were not read.`;
        break;
      }
    }
  }
  return {
    selection,
    decisions: decisions.slice(0, 5),
    ...(stopped === undefined ? {} : { stopped }),
  };
}

function DebuggerActors({
  session,
  scene,
}: {
  readonly session: SceneSession;
  readonly scene: LivingScene;
}) {
  const [actor, setActor] = useState<ObjectId | undefined>(scene.entities[0]?.objectId);
  const [result, setResult] = useState<Decisions>();
  const show = async () => {
    const objectId = actor ?? scene.entities[0]?.objectId;
    if (!objectId) return;
    try {
      const { selection, decisions, stopped } = await recentDecisions((cursor) =>
        session.readEntity(objectId, cursor),
      );
      const whys = await Promise.all(
        decisions.map((action) => session.readEventWhy(action.eventId)),
      );
      setResult({
        kind: "read",
        selection,
        traces: whys.map((why) => why.traces),
        ...(stopped === undefined ? {} : { stopped }),
      });
    } catch {
      setResult({ kind: "failed" });
    }
  };
  const physical = result?.kind === "read" ? result.selection.physical : undefined;
  const derived = result?.kind === "read" ? result.selection.derived : undefined;
  const values = [
    ["hunger", physical?.needs?.hunger],
    ["thirst", derived?.wellbeing?.thirst ?? physical?.wellbeing?.thirst],
    ["wetness", physical?.needs?.wetness],
    ["health", derived?.wellbeing?.health ?? physical?.wellbeing?.health],
  ].filter(([, value]) => value !== undefined);
  const owned =
    result?.kind === "read"
      ? result.traces.map((evidence) => ({
          status: evidence.status,
          drafts: evidence.drafts.filter((draft) => draft.objectId === result.selection.objectId),
        }))
      : [];
  const drafts = owned.flatMap((evidence) => evidence.drafts);
  return (
    <section aria-label="Debugger actors">
      <h3>Debugger actors</h3>
      <label>
        Actor{" "}
        <select value={actor ?? ""} onChange={(event) => setActor(event.target.value as ObjectId)}>
          {scene.entities.map((entity) => (
            <option key={entity.objectId} value={entity.objectId}>
              {entity.presentation.label || entity.objectId}
            </option>
          ))}
        </select>
      </label>{" "}
      <button type="button" onClick={() => void show()}>
        Show decisions
      </button>
      {result?.kind === "failed" && <p>Actor evidence unavailable.</p>}
      {physical && (
        <>
          <p>
            Location {physical.locationId ?? "None"}; current action{" "}
            {physical.selectedAction ? describe(physical.selectedAction) : "None"}
          </p>
          {values.length > 0 && (
            <p>{values.map(([name, value]) => `${name} ${String(value)}`).join(", ")}</p>
          )}
          {owned.some((evidence) => evidence.status === "redacted") && (
            <p>Decision evidence redacted.</p>
          )}
          {owned.some((evidence) => evidence.status === "unavailable") && (
            <p>Decision evidence unavailable.</p>
          )}
          {result?.kind === "read" && result.stopped !== undefined && <p>{result.stopped}</p>}
          {drafts.length === 0 &&
            result?.kind === "read" &&
            result.stopped === undefined &&
            owned.every((evidence) => evidence.status === "available") && (
              <p>No decisions recorded for this actor.</p>
            )}
          {drafts.map((draft) => (
            <Decision key={`${draft.simulationTime}:${draft.draftIndex}`} draft={draft} />
          ))}
        </>
      )}
    </section>
  );
}

function Decision({ draft }: { readonly draft: PublicDecisionTrace }) {
  const { selectedAction, candidates } = draft;
  const chosen = candidates.find(
    (candidate) =>
      candidate.action.kind === selectedAction.kind &&
      candidate.action.targetObjectId === selectedAction.targetObjectId,
  );
  const believed = candidates.filter(
    (candidate) => featureOf(candidate, "expectation") || featureOf(candidate, "freshness"),
  );
  return (
    <section aria-label={`Decision at ${draft.simulationTime}`}>
      <h4>Decision at simulation time {draft.simulationTime}</h4>
      <h5>Perception</h5>
      <ul>
        {candidates.map((candidate) => {
          const perceived = featureOf(candidate, "perceived");
          const text =
            perceived !== undefined && perceived !== "0" && perceived !== "no"
              ? "perceived"
              : candidate.excludedReason === "not-perceived"
                ? "not perceived"
                : (perceived ?? "not recorded");
          return (
            <li key={describe(candidate.action)}>{`${describe(candidate.action)}: ${text}`}</li>
          );
        })}
      </ul>
      <h5>Beliefs</h5>
      {believed.length === 0 ? (
        <p>No beliefs recorded.</p>
      ) : (
        <ul>
          {believed.map((candidate) => (
            <li key={describe(candidate.action)}>
              {`${describe(candidate.action)}: expectation ${featureOf(candidate, "expectation") ?? "not recorded"}, freshness ${featureOf(candidate, "freshness") ?? "not recorded"}`}
            </li>
          ))}
        </ul>
      )}
      <h5>Goals</h5>
      <p>
        {chosen?.features
          .filter((feature) => ACTOR_NEEDS.includes(feature.name))
          .map((feature) => `${feature.name} ${feature.value}`)
          .join(", ")}
      </p>
      <p>Candidates: {candidates.map((candidate) => describe(candidate.action)).join(", ")}</p>
      <h5>Choice</h5>
      <p>
        {`Chose ${describe(selectedAction)} (tier ${draft.selectionTier}, score ${chosen?.score ?? "n/a"})`}
      </p>
    </section>
  );
}
