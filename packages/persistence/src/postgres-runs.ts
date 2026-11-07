import type { ArtifactStore, RuntimeAuthorizationContext } from "@clockgrove/application";
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
export const SCRIPTED_PROMPT_VERSION = "scripted-prompt-v1";
/**
 * Decision: an attempt still running 60 s after it started is abandoned when its session next
 * talks. A Talk attempt is one request whose scripted model answers in-process, so only a dead
 * request leaves one open that long. RW-0503's turn fibers replace this with leases.
 */
export const STALE_RUN_SECONDS = 60;
/** Decision: a walk returns at most this many runs, as one conversation read page. */
const MAX_WALK_RUNS = 100;

const timestamp = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${column}`;
const RUN_COLUMNS = `run_id, session_id, actor_id, principal_id, persona_id, activation,
  input_message_id, parent_run_id, parent_step, root_run_id, model, prompt_version, input_revision,
  status, outcome_code, turn, summary, prompt_artifact_id, partition_id, space_id,
  ${timestamp("started_at")}, ${timestamp("ended_at")},
  (SELECT count(*) FROM clockgrove.run_steps AS step
    WHERE step.tenant_id = agent_runs.tenant_id AND step.run_id = agent_runs.run_id) AS step_count`;
const STEP_COLUMNS = `run_id, step, kind, status, outcome_code, model, tool, command_id,
  output_message_id, input_artifact_id, output_artifact_id, input_tokens, output_tokens,
  cost_microusd, summary, ${timestamp("started_at")}, ${timestamp("ended_at")}`;
const RUN_SCOPE = "tenant_id = $1 AND world_id = $2 AND timeline_id = $3";

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
}

/**
 * Run evidence statements (migration 0035), each run inside the caller's transaction under the
 * participant's authorization. The guards in SQL hold the state machine; these only name moves.
 */
export class PostgreSqlRunRecorder {
  constructor(private readonly client: PostgreSqlClient) {}

  /**
   * Closes the session's attempts that will never close themselves, then opens a Talk run with its
   * running model attempt. An open attempt at the same message is superseded by this retry; any
   * other still running after `STALE_RUN_SECONDS` is abandoned.
   */
  async beginTalk(start: TalkRunStart): Promise<void> {
    await this.client.query(
      `UPDATE clockgrove.agent_runs
          SET status = CASE WHEN input_message_id = $3 THEN 'superseded' ELSE 'abandoned' END,
              outcome_code = CASE WHEN input_message_id = $3 THEN 'retried' ELSE 'stale' END
        WHERE tenant_id = $1 AND session_id = $2 AND status = 'running'
          AND (input_message_id = $3
               OR started_at < statement_timestamp() - make_interval(secs => $4))`,
      [start.tenantId, start.sessionId, start.inputMessageId, STALE_RUN_SECONDS],
    );
    await this.client.query(
      `INSERT INTO clockgrove.agent_runs (
         tenant_id, run_id, world_id, timeline_id, partition_id, space_id, session_id, actor_id,
         principal_id, persona_id, activation, input_message_id, root_run_id, model,
         prompt_version, input_revision, summary, prompt_artifact_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'conversation_message', $11, $2, $12,
                 $13, $14, $15, $16)`,
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
      ],
    );
    await this.client.query(
      `INSERT INTO clockgrove.run_steps (
         tenant_id, run_id, session_id, step, kind, model, input_artifact_id, summary
       ) VALUES ($1, $2, $3, 1, 'model_attempt', $4, $5, 'Scripted model attempt')`,
      [start.tenantId, start.runId, start.sessionId, SCRIPTED_MODEL, start.promptArtifactId],
    );
  }

  /** The model answered: its output is the reply artifact. The fixture is free and counts no tokens. */
  async modelAnswered(tenantId: string, runId: string, outputArtifactId: string): Promise<void> {
    await this.client.query(
      `UPDATE clockgrove.run_steps
          SET status = 'succeeded', output_artifact_id = $3, cost_microusd = 0,
              summary = 'Scripted model answered'
        WHERE tenant_id = $1 AND run_id = $2 AND step = 1`,
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
  ): Promise<void> {
    await this.client.query(
      `INSERT INTO clockgrove.run_steps (
         tenant_id, run_id, session_id, step, kind, status, output_message_id, summary
       ) VALUES ($1, $2, $3, 2, 'commit', 'succeeded', $4, $5)`,
      [tenantId, runId, sessionId, replyMessageId, `Committed turn ${turn}`],
    );
    await this.client.query(
      `UPDATE clockgrove.agent_runs SET status = 'completed', turn = $3
        WHERE tenant_id = $1 AND run_id = $2`,
      [tenantId, runId, turn],
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
 * Reads runs for an inspector. Row visibility is the policy of 0035 (a participant's own runs, or
 * any run under an `operator_evidence` ceiling); this adds the world and timeline scope. A payload's
 * text is read only when the ceiling holds its class, and metadata search never reads one.
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
          `SELECT ${RUN_COLUMNS} FROM clockgrove.agent_runs
            WHERE ${RUN_SCOPE} AND root_run_id IN (
              SELECT root_run_id FROM clockgrove.agent_runs
               WHERE ${RUN_SCOPE} AND ${match})
            ORDER BY started_at, run_id LIMIT ${MAX_WALK_RUNS}`,
          [scope.tenantId, scope.worldId, scope.timelineId, ...values],
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
    const readable = authorization.privacyCeiling.allowedCategories.includes("conversation");
    const views: RunView[] = [];
    for (const row of runs) {
      const payload = (id: unknown) => this.payload(authorization, scope, row, id, readable);
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
          input: await payload(step.input_artifact_id),
          output: await payload(step.output_artifact_id),
        });
      views.push({
        ...summaryOf(row),
        prompt: await payload(row.prompt_artifact_id),
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
          WHERE ${RUN_SCOPE} AND ($4::text IS NULL OR actor_id = $4)
            AND ($5::text IS NULL OR session_id = $5) AND ($6::text IS NULL OR status = $6)
          ORDER BY started_at DESC, run_id LIMIT $7`,
        [
          scope.tenantId,
          scope.worldId,
          scope.timelineId,
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
    readable: boolean,
  ): Promise<ProtectedPayload | null> {
    if (typeof artifactId !== "string") return null;
    if (!readable) return { artifactId, privacyClass: "conversation", text: null };
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
      privacyClass: "conversation",
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    };
  }
}

/** The runs an entry names directly, as a condition over `agent_runs` after `$1`–`$3`. */
function entryMatch(entry: RunEntry): readonly [string, readonly unknown[]] {
  if ("runId" in entry) return ["run_id = $4", [entry.runId]];
  if ("commandId" in entry)
    return [
      `run_id IN (SELECT run_id FROM clockgrove.run_steps WHERE tenant_id = $1 AND command_id = $4)`,
      [entry.commandId],
    ];
  if ("turn" in entry)
    // Every attempt at the turn's input message, whichever of them committed it.
    return [
      `session_id = $4 AND input_message_id IN (
         SELECT input_message_id FROM clockgrove.agent_runs
          WHERE tenant_id = $1 AND session_id = $4 AND turn = $5)`,
      [entry.sessionId, entry.turn],
    ];
  // A message is a run's input, or what one of its steps produced.
  return [
    `session_id = $4 AND (input_message_id = $5 OR run_id IN (
       SELECT run_id FROM clockgrove.run_steps
        WHERE tenant_id = $1 AND session_id = $4 AND output_message_id = $5))`,
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
