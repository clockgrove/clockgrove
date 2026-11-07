import {
  type ArtifactStore,
  CONTEXT_PROMPT_VERSION,
  type RuntimeAuthorizationContext,
} from "@clockgrove/application";
import {
  type BrowserScope,
  decodeOpaqueId,
  type ProtectedPayload,
  type RunEntry,
  type RunSearchRequest,
  type RunStatus,
  type RunStepView,
  type RunSummary,
  type RunView,
} from "@clockgrove/contracts";
import { type PostgreSqlClient, withClientTransaction } from "./postgres-transaction.js";

type Row = Record<string, unknown>;

/** The scripted model fixture's identity on its runs (Wave 5 §17). */
export const SCRIPTED_MODEL = "scripted-fixture-v1";
export const SCRIPTED_PROMPT_VERSION = CONTEXT_PROMPT_VERSION;
/** Decision: a walk returns at most this many runs, as one conversation read page. */
const MAX_WALK_RUNS = 100;

const timestamp = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${column}`;
const RUN_COLUMNS = `run_id, session_id, actor_id, principal_id, persona_id, activation,
  input_message_id, parent_run_id, parent_step, root_run_id, model, prompt_version, input_revision,
  status, outcome_code, turn, summary, prompt_artifact_id, prompt_privacy_class, partition_id,
  space_id,
  ${timestamp("started_at")}, ${timestamp("ended_at")},
  (SELECT count(*) FROM clockgrove.run_steps AS step
    WHERE step.tenant_id = agent_runs.tenant_id AND step.run_id = agent_runs.run_id) AS step_count`;
const STEP_COLUMNS = `run_id, step, kind, status, outcome_code, model, tool, command_id,
  output_message_id, input_artifact_id, input_privacy_class, output_artifact_id, input_tokens,
  output_tokens,
  cost_microusd, summary, ${timestamp("started_at")}, ${timestamp("ended_at")}`;
/** The caller's whole browser scope: an inspect grant for one space reads only that space's runs. */
const RUN_SCOPE = "tenant_id = $1 AND world_id = $2 AND timeline_id = $3 AND space_id = $4";
/** Decision: as `guard_agent_run` (0036), four attempts for each of a session's 500 turns. */
export const MAX_SESSION_RUNS = 2000;

export interface TalkRunStart {
  readonly tenantId: string;
  readonly worldId: string;
  readonly timelineId: string;
  readonly partitionId: string;
  readonly spaceId: string;
  readonly sessionId: string;
  readonly actorId: string;
  readonly principalId: string;
  readonly personaId: string;
  readonly runId: string;
  readonly inputMessageId: string;
  readonly inputRevision: number;
  readonly caretakerMessages: number;
  readonly promptArtifactId: string;
  /** `private_cognition` when the prompt includes any actor document (0037), else `conversation`. */
  readonly promptPrivacyClass: ProtectedPayload["privacyClass"];
  /** The context step's safe summary: how many candidates were included. */
  readonly contextSummary: string;
}

/**
 * Run evidence statements (migration 0036), each run inside the caller's transaction under the
 * participant's authorization. The guards in SQL hold the state machine; these only name moves.
 */
export class PostgreSqlRunRecorder {
  constructor(private readonly client: PostgreSqlClient) {}

  /** Whether the session already holds its limit of runs, checked before the prompt is stored. */
  async full(tenantId: string, sessionId: string): Promise<boolean> {
    const found = await this.client.query(
      `SELECT count(*) >= $3 AS full FROM clockgrove.agent_runs
        WHERE tenant_id = $1 AND session_id = $2`,
      [tenantId, sessionId, MAX_SESSION_RUNS],
    );
    return (found.rows[0] as Row | undefined)?.full === true;
  }

  /**
   * Opens a Talk run with its running model attempt. The turn fiber that claims it (0037) closes
   * its previous attempt first, so no attempt is left open.
   */
  async beginTalk(start: TalkRunStart): Promise<void> {
    await this.client.query(
      `INSERT INTO clockgrove.agent_runs (
         tenant_id, run_id, world_id, timeline_id, partition_id, space_id, session_id, actor_id,
         principal_id, persona_id, activation, input_message_id, root_run_id, model,
         prompt_version, input_revision, summary, prompt_artifact_id, prompt_privacy_class
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'conversation_message', $11, $2, $12,
                 $13, $14, $15, $16, $17)`,
      [
        start.tenantId,
        start.runId,
        start.worldId,
        start.timelineId,
        start.partitionId,
        start.spaceId,
        start.sessionId,
        start.actorId,
        start.principalId,
        start.personaId,
        start.inputMessageId,
        SCRIPTED_MODEL,
        SCRIPTED_PROMPT_VERSION,
        start.inputRevision,
        `Scripted reply to Caretaker message ${start.caretakerMessages}`,
        start.promptArtifactId,
        start.promptPrivacyClass,
      ],
    );
    // The context was assembled before the run opened; its manifest is written with this step.
    await this.client.query(
      `INSERT INTO clockgrove.run_steps (
         tenant_id, run_id, session_id, step, kind, status, summary
       ) VALUES ($1, $2, $3, 1, 'context_retrieval', 'succeeded', $4)`,
      [start.tenantId, start.runId, start.sessionId, start.contextSummary],
    );
    await this.client.query(
      `INSERT INTO clockgrove.run_steps (
         tenant_id, run_id, session_id, step, kind, model, input_artifact_id, input_privacy_class,
         summary
       ) VALUES ($1, $2, $3, 2, 'model_attempt', $4, $5, $6, 'Scripted model attempt')`,
      [
        start.tenantId,
        start.runId,
        start.sessionId,
        SCRIPTED_MODEL,
        start.promptArtifactId,
        start.promptPrivacyClass,
      ],
    );
  }

  /** The model answered: its output is the reply artifact. The fixture is free and counts no tokens. */
  async modelAnswered(tenantId: string, runId: string, outputArtifactId: string): Promise<void> {
    await this.client.query(
      `UPDATE clockgrove.run_steps
          SET status = 'succeeded', output_artifact_id = $3, cost_microusd = 0,
              summary = 'Scripted model answered'
        WHERE tenant_id = $1 AND run_id = $2 AND step = 2`,
      [tenantId, runId, outputArtifactId],
    );
  }

  /** The turn and its reply are committed in this transaction: the run completes with them. */
  async committed(
    tenantId: string,
    sessionId: string,
    runId: string,
    turn: number,
    replyMessageId: string,
    step: number,
  ): Promise<void> {
    await this.client.query(
      `INSERT INTO clockgrove.run_steps (
         tenant_id, run_id, session_id, step, kind, status, output_message_id, summary
       ) VALUES ($1, $2, $3, $6, 'commit', 'succeeded', $4, $5)`,
      [tenantId, runId, sessionId, replyMessageId, `Committed turn ${turn}`, step],
    );
    await this.client.query(
      `UPDATE clockgrove.agent_runs SET status = 'completed', turn = $3
        WHERE tenant_id = $1 AND run_id = $2`,
      [tenantId, runId, turn],
    );
  }

  /** The model's document proposal and its validation outcome, as one ended step. */
  async validated(
    tenantId: string,
    sessionId: string,
    runId: string,
    step: number,
    outcome: { readonly refused: string | undefined; readonly summary: string },
  ): Promise<void> {
    await this.client.query(
      `INSERT INTO clockgrove.run_steps (
         tenant_id, run_id, session_id, step, kind, status, outcome_code, summary
       ) VALUES ($1, $2, $3, $4, 'validation', $5, $6, $7)`,
      [
        tenantId,
        runId,
        sessionId,
        step,
        outcome.refused === undefined ? "succeeded" : "failed",
        outcome.refused ?? null,
        outcome.summary,
      ],
    );
  }

  /** Records a disposition other than completion, if the run is still open. */
  async close(
    tenantId: string,
    runId: string,
    status: Exclude<RunStatus, "running" | "completed">,
    outcomeCode: string,
  ): Promise<void> {
    await this.client.query(
      `UPDATE clockgrove.agent_runs SET status = $3, outcome_code = $4
        WHERE tenant_id = $1 AND run_id = $2 AND status = 'running'`,
      [tenantId, runId, status, outcomeCode],
    );
  }
}

/**
 * Reads runs for an inspector. Row visibility is the policy of 0036 (a participant's own runs, or
 * any run under an `operator_evidence` ceiling); this adds the world, timeline and space scope. A
 * payload's text is read only when the inspector is a participant of the run's session whose
 * ceiling holds `conversation`, as conversation text is (0034), and the payload's own class (a
 * private prompt's `private_cognition`, 0037); metadata search never reads one.
 */
export class PostgreSqlRunReader {
  constructor(
    private readonly client: PostgreSqlClient,
    private readonly artifacts: ArtifactStore,
  ) {}

  /** Every run of the causal trees the entry touches, oldest first; empty when it touches none. */
  async walk(
    authorization: RuntimeAuthorizationContext,
    scope: BrowserScope,
    entry: RunEntry,
  ): Promise<readonly RunView[]> {
    const { runs, steps } = await withClientTransaction(
      this.client,
      { authorization },
      async () => {
        const [match, values] = entryMatch(entry);
        const found = await this.client.query(
          `SELECT ${RUN_COLUMNS},
                  clockgrove.runtime_conversation_participant(tenant_id, session_id) AS participant
             FROM clockgrove.agent_runs
            WHERE ${RUN_SCOPE} AND root_run_id IN (
              SELECT root_run_id FROM clockgrove.agent_runs
               WHERE ${RUN_SCOPE} AND ${match})
            ORDER BY started_at, run_id LIMIT ${MAX_WALK_RUNS}`,
          [scope.tenantId, scope.worldId, scope.timelineId, scope.spaceId, ...values],
        );
        const runRows = found.rows as Row[];
        const stepRows = await this.client.query(
          `SELECT ${STEP_COLUMNS} FROM clockgrove.run_steps
            WHERE tenant_id = $1 AND run_id = ANY($2::text[]) ORDER BY run_id, step`,
          [scope.tenantId, runRows.map((row) => row.run_id)],
        );
        return { runs: runRows, steps: stepRows.rows as Row[] };
      },
    );
    const allowed = authorization.privacyCeiling.allowedCategories;
    const views: RunView[] = [];
    for (const row of runs) {
      // Every payload draws on the session's conversation; a private prompt adds the actor's
      // documents, so its text needs both classes (issue 17, owner's answer 1).
      const readable = (privacyClass: ProtectedPayload["privacyClass"]) =>
        row.participant === true &&
        allowed.includes("conversation") &&
        allowed.includes(privacyClass);
      const payload = (id: unknown, privacyClass: unknown = "conversation") =>
        this.payload(authorization, scope, row, id, privacyClassOf(privacyClass), readable);
      const runSteps: RunStepView[] = [];
      for (const step of steps.filter((s) => s.run_id === row.run_id))
        runSteps.push({
          step: Number(step.step),
          kind: step.kind as RunStepView["kind"],
          status: step.status as RunStepView["status"],
          outcomeCode: nullable(step.outcome_code),
          model: nullable(step.model),
          tool: nullable(step.tool),
          commandId: nullable(step.command_id),
          outputMessageId: nullable(step.output_message_id),
          inputTokens: count(step.input_tokens),
          outputTokens: count(step.output_tokens),
          costMicrousd: count(step.cost_microusd),
          summary: String(step.summary),
          startedAt: String(step.started_at),
          endedAt: nullable(step.ended_at),
          input: await payload(step.input_artifact_id, step.input_privacy_class),
          output: await payload(step.output_artifact_id),
        });
      views.push({
        ...summaryOf(row),
        prompt: await payload(row.prompt_artifact_id, row.prompt_privacy_class),
        steps: runSteps,
      });
    }
    return views;
  }

  /** Safe metadata of the scope's runs, newest first. No payload is read. */
  async search(
    authorization: RuntimeAuthorizationContext,
    request: RunSearchRequest,
  ): Promise<readonly RunSummary[]> {
    const { scope } = request;
    const rows = await withClientTransaction(this.client, { authorization }, async () => {
      const found = await this.client.query(
        `SELECT ${RUN_COLUMNS} FROM clockgrove.agent_runs
          WHERE ${RUN_SCOPE} AND ($5::text IS NULL OR actor_id = $5)
            AND ($6::text IS NULL OR session_id = $6) AND ($7::text IS NULL OR status = $7)
          ORDER BY started_at DESC, run_id LIMIT $8`,
        [
          scope.tenantId,
          scope.worldId,
          scope.timelineId,
          scope.spaceId,
          request.actorId ?? null,
          request.sessionId ?? null,
          request.status ?? null,
          request.limit,
        ],
      );
      return found.rows as Row[];
    });
    return rows.map(summaryOf);
  }

  private async payload(
    authorization: RuntimeAuthorizationContext,
    scope: BrowserScope,
    run: Row,
    artifactId: unknown,
    privacyClass: ProtectedPayload["privacyClass"],
    readable: (privacyClass: ProtectedPayload["privacyClass"]) => boolean,
  ): Promise<ProtectedPayload | null> {
    if (typeof artifactId !== "string") return null;
    if (!readable(privacyClass)) return { artifactId, privacyClass, text: null };
    const { bytes } = await this.artifacts.get(authorization, {
      tenantId: scope.tenantId,
      worldId: scope.worldId,
      timelineId: scope.timelineId,
      partitionId: decodeOpaqueId(run.partition_id, "PartitionId"),
      spaceId: decodeOpaqueId(run.space_id, "SpaceId"),
      artifactId: decodeOpaqueId(artifactId, "ArtifactId"),
    });
    return {
      artifactId,
      privacyClass,
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    };
  }
}

function privacyClassOf(value: unknown): ProtectedPayload["privacyClass"] {
  if (value === "conversation" || value === "private_cognition") return value;
  throw new Error("run payload privacy class unknown");
}

/** The runs an entry names directly, as a condition over `agent_runs` after `$1`–`$4`. */
function entryMatch(entry: RunEntry): readonly [string, readonly unknown[]] {
  if ("runId" in entry) return ["run_id = $5", [entry.runId]];
  if ("commandId" in entry)
    return [
      `run_id IN (SELECT run_id FROM clockgrove.run_steps WHERE tenant_id = $1 AND command_id = $5)`,
      [entry.commandId],
    ];
  if ("turn" in entry)
    // Every attempt at the turn's input message, whichever of them committed it.
    return [
      `session_id = $5 AND input_message_id IN (
         SELECT input_message_id FROM clockgrove.agent_runs
          WHERE tenant_id = $1 AND session_id = $5 AND turn = $6)`,
      [entry.sessionId, entry.turn],
    ];
  // A message is a run's input, or what one of its steps produced.
  return [
    `session_id = $5 AND (input_message_id = $6 OR run_id IN (
       SELECT run_id FROM clockgrove.run_steps
        WHERE tenant_id = $1 AND session_id = $5 AND output_message_id = $6))`,
    [entry.sessionId, entry.messageId],
  ];
}

function summaryOf(row: Row): RunSummary {
  return {
    runId: String(row.run_id),
    sessionId: String(row.session_id),
    actorId: String(row.actor_id),
    principalId: String(row.principal_id),
    personaId: String(row.persona_id),
    activation: "conversation_message",
    inputMessageId: String(row.input_message_id),
    parentRunId: nullable(row.parent_run_id),
    parentStep: count(row.parent_step),
    rootRunId: String(row.root_run_id),
    model: String(row.model),
    promptVersion: String(row.prompt_version),
    inputRevision: Number(row.input_revision),
    status: row.status as RunStatus,
    outcomeCode: nullable(row.outcome_code),
    turn: count(row.turn),
    summary: String(row.summary),
    stepCount: Number(row.step_count),
    startedAt: String(row.started_at),
    endedAt: nullable(row.ended_at),
  };
}

function nullable(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function count(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}
