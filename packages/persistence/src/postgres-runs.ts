import {
  type ArtifactStore,
  type CapabilityEvidence,
  CONTEXT_PROMPT_VERSION,
  type ModelUsage,
  type RuntimeAuthorizationContext,
  type TurnCommandRecord,
  type TurnToolCall,
} from "@clockgrove/application";
import {
  type BrowserScope,
  decodeOpaqueId,
  type ProtectedPayload,
  type RunBreakerTransition,
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
  cost_microusd, summary, tool_evidence, capability_evidence, ${timestamp("started_at")}, ${timestamp("ended_at")}`;
/** The caller's whole browser scope: an inspect grant for one space reads only that space's runs. */
const RUN_SCOPE = "tenant_id = $1 AND world_id = $2 AND timeline_id = $3 AND space_id = $4";
/** Decision: as `guard_agent_run` (0036), four attempts for each of a session's 500 turns. */
export const MAX_SESSION_RUNS = 2000;

export interface TalkRunStart {
  /** The model the run records: the fixture, or the route alias answering. */
  readonly model: string;
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
/** The scripted fixture answers without a provider: one free call that counts no tokens. */
const FIXTURE_USAGE: ModelUsage = {
  inputTokens: 0,
  outputTokens: 0,
  costMicrousd: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningTokens: 0,
  calls: 1,
};

/** A checkpointed answer committed again by a new attempt: no provider was called for it. */
export const NO_CALL_USAGE: ModelUsage = { ...FIXTURE_USAGE, calls: 0 };

/** Parameters $4 to $10 of a model step's end: what the call used, `null` when unknown. */
const USAGE_COLUMNS = `cost_microusd = $4, input_tokens = $5, output_tokens = $6,
  cached_input_tokens = $7, cache_write_input_tokens = $8, reasoning_tokens = $9,
  model_calls = $10`;

function usageValues(usage: ModelUsage | undefined): (number | null)[] {
  return [
    usage?.costMicrousd ?? null,
    usage?.inputTokens ?? null,
    usage?.outputTokens ?? null,
    usage?.cachedInputTokens ?? null,
    usage?.cacheWriteInputTokens ?? null,
    usage?.reasoningTokens ?? null,
    usage?.calls ?? null,
  ];
}

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
   * Opens a Talk run with its running model attempt. The turn fiber that claims it (0038) closes
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
        start.model,
        SCRIPTED_PROMPT_VERSION,
        start.inputRevision,
        `Reply to Caretaker message ${start.caretakerMessages}`,
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
       ) VALUES ($1, $2, $3, 2, 'model_attempt', $4, $5, $6, 'Model attempt')`,
      [
        start.tenantId,
        start.runId,
        start.sessionId,
        start.model,
        start.promptArtifactId,
        start.promptPrivacyClass,
      ],
    );
  }

  /** The model answered: its output is the reply artifact. The fixture is free and counts no tokens. */
  async modelAnswered(
    tenantId: string,
    runId: string,
    outputArtifactId: string,
    usage: ModelUsage = FIXTURE_USAGE,
  ): Promise<void> {
    await this.client.query(
      `UPDATE clockgrove.run_steps
          SET status = 'succeeded', output_artifact_id = $3, ${USAGE_COLUMNS},
              summary = 'Model answered'
        WHERE tenant_id = $1 AND run_id = $2 AND kind='model_attempt' AND status='running'`,
      [tenantId, runId, outputArtifactId, ...usageValues(usage)],
    );
  }

  /**
   * The step ended as a system disposition. A call that reached a provider still records what it
   * used (issue 329); without a call record its usage stays unknown.
   */
  async systemOutcome(
    tenantId: string,
    sessionId: string,
    runId: string,
    code: string,
    usage?: ModelUsage,
    summary = "Model unavailable or research bound reached",
  ): Promise<void> {
    await this.client.query(
      `UPDATE clockgrove.run_steps SET status='failed',outcome_code=$3,${USAGE_COLUMNS},
              summary=$11
        WHERE tenant_id=$1 AND run_id=$2 AND kind='model_attempt' AND status='running'`,
      [tenantId, runId, code, ...usageValues(usage), summary],
    );
    const found = await this.client.query(
      `SELECT coalesce(max(step),0)+1 AS step FROM clockgrove.run_steps WHERE tenant_id=$1 AND run_id=$2`,
      [tenantId, runId],
    );
    await this.validated(tenantId, sessionId, runId, Number((found.rows[0] as Row).step), {
      refused: code,
      summary: "System disposition; no actor behavior claimed",
    });
  }

  async nextModelAttempt(
    tenantId: string,
    sessionId: string,
    runId: string,
    model: string,
    promptArtifactId?: string,
  ): Promise<void> {
    const found = await this.client.query(
      `SELECT step,input_artifact_id,input_privacy_class FROM clockgrove.run_steps
        WHERE tenant_id=$1 AND run_id=$2 AND kind='model_attempt' ORDER BY step DESC LIMIT 1`,
      [tenantId, runId],
    );
    const running = await this.client.query(
      `SELECT 1 FROM clockgrove.run_steps WHERE tenant_id=$1 AND run_id=$2 AND kind='model_attempt' AND status='running'`,
      [tenantId, runId],
    );
    if (running.rows.length > 0 && promptArtifactId === undefined) return;
    if (running.rows.length > 0)
      await this.client.query(
        `UPDATE clockgrove.run_steps SET status='abandoned',outcome_code='research_context_replaced'
        WHERE tenant_id=$1 AND run_id=$2 AND kind='model_attempt' AND status='running'`,
        [tenantId, runId],
      );
    const prior = found.rows[0] as Row;
    await this.client.query(
      `INSERT INTO clockgrove.run_steps(tenant_id,run_id,session_id,step,kind,model,input_artifact_id,input_privacy_class,summary)
        SELECT $1,$2,$3,coalesce(max(step),0)+1,'model_attempt',$4,$5,$6,'Model attempt after tool'
          FROM clockgrove.run_steps WHERE tenant_id=$1 AND run_id=$2`,
      [
        tenantId,
        runId,
        sessionId,
        model,
        promptArtifactId ?? prior.input_artifact_id,
        promptArtifactId === undefined ? prior.input_privacy_class : "private_cognition",
      ],
    );
  }

  async toolStep(
    tenantId: string,
    sessionId: string,
    runId: string,
    kind: "tool_proposal" | "tool_execution" | "approval",
    call: TurnToolCall,
  ): Promise<void> {
    await this.client.query(
      `INSERT INTO clockgrove.run_steps(tenant_id,run_id,session_id,step,kind,status,outcome_code,tool,
          output_artifact_id,cost_microusd,summary,tool_evidence)
        SELECT $1,$2,$3,coalesce(max(step),0)+1,$4,$5,$6,$7,$8,$11,$9,$10::jsonb
          FROM clockgrove.run_steps WHERE tenant_id=$1 AND run_id=$2`,
      [
        tenantId,
        runId,
        sessionId,
        kind,
        call.status === "waiting" || call.status === "succeeded" || call.status === "simulated"
          ? "succeeded"
          : "failed",
        call.code,
        call.capability,
        call.resultArtifactId,
        kind === "approval"
          ? "Awaiting human approval"
          : kind === "tool_proposal"
            ? "Tool proposal checkpointed"
            : call.refusalCause !== undefined
              ? `Usage refused: ${call.refusalCause}`.slice(0, 256)
              : "Tool result recorded as untrusted evidence",
        JSON.stringify({
          callId: call.callId,
          effectId: call.effectId,
          grantId: call.grantId,
          resultArtifactId: call.resultArtifactId,
          status: call.status,
          queueLatencyMs: call.queueLatencyMs ?? null,
        }),
        call.costMicrousd ?? null,
      ],
    );
  }

  /**
   * The model's capability call and what became of it, as one ended step: `commandId` names the
   * receipt the ordinary validator and Journal wrote (a committed or a rejected one), and a call the
   * registry refused names none.
   */
  async commandProposed(
    tenantId: string,
    sessionId: string,
    runId: string,
    record: TurnCommandRecord,
  ): Promise<void> {
    const next = await this.client.query(
      `SELECT coalesce(max(step), 0) + 1 AS next FROM clockgrove.run_steps
        WHERE tenant_id = $1 AND run_id = $2`,
      [tenantId, runId],
    );
    await this.client.query(
      `INSERT INTO clockgrove.run_steps (
         tenant_id, run_id, session_id, step, kind, status, outcome_code, tool, command_id, summary,
         capability_evidence
       ) VALUES ($1, $2, $3, $4, 'world_command_proposal', $5, $6, $7, $8, $9, $10::jsonb)`,
      [
        tenantId,
        runId,
        sessionId,
        Number((next.rows[0] as Row).next),
        record.status === "committed" ? "succeeded" : "failed",
        record.code,
        record.capability,
        record.commandId,
        record.summary.slice(0, 256),
        record.evidence === undefined ? null : boundedEvidence(record.evidence),
      ],
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
    outcomeCode: string | null = null,
  ): Promise<void> {
    await this.client.query(
      `INSERT INTO clockgrove.run_steps (
         tenant_id, run_id, session_id, step, kind, status, output_message_id, summary
       ) VALUES ($1, $2, $3, $6, 'commit', 'succeeded', $4, $5)`,
      [tenantId, runId, sessionId, replyMessageId, `Committed turn ${turn}`, step],
    );
    await this.client.query(
      `UPDATE clockgrove.agent_runs SET status = CASE WHEN $4::text IS NULL THEN 'completed' ELSE 'failed' END, turn = CASE WHEN $4::text IS NULL THEN $3::integer ELSE NULL END, outcome_code=$4
        WHERE tenant_id = $1 AND run_id = $2`,
      [tenantId, runId, turn, outcomeCode],
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

  /**
   * The breaker changes one model call caused, under the participant's authorization, on the run
   * that made the call; the guard (0077) refuses a run that is not running in this session and
   * world. A retried write of the same call adds nothing.
   */
  async breakerTransitions(
    tenantId: string,
    worldId: string,
    sessionId: string,
    runId: string,
    call: { readonly callId: string; readonly alias: string },
    transitions: readonly (Omit<RunBreakerTransition, "alias" | "recordedAt"> & {
      readonly at: number;
    })[],
  ): Promise<void> {
    for (const [ordinal, move] of transitions.entries())
      await this.client.query(
        `INSERT INTO clockgrove.model_breaker_transitions (
           tenant_id, world_id, session_id, run_id, call_id, ordinal, route_id, alias, from_state,
           to_state, consecutive_failures, recorded_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
           to_timestamp($12::double precision / 1000))
         ON CONFLICT DO NOTHING`,
        [
          tenantId,
          worldId,
          sessionId,
          runId,
          call.callId,
          ordinal,
          move.routeId,
          call.alias,
          move.from,
          move.to,
          move.consecutiveFailures,
          move.at,
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
    const { runs, steps, breakers } = await withClientTransaction(
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
        const breakerRows = await this.client.query(
          `SELECT run_id, route_id, alias, from_state, to_state, consecutive_failures,
                  ${timestamp("recorded_at")}
             FROM clockgrove.model_breaker_transitions
            WHERE tenant_id = $1 AND run_id = ANY($2::text[])
            ORDER BY run_id, recorded_at, call_id, ordinal`,
          [scope.tenantId, runRows.map((row) => row.run_id)],
        );
        return {
          runs: runRows,
          steps: stepRows.rows as Row[],
          breakers: breakerRows.rows as Row[],
        };
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
          ...(step.tool_evidence == null
            ? {}
            : { toolEvidence: step.tool_evidence as NonNullable<RunStepView["toolEvidence"]> }),
          ...(step.capability_evidence == null
            ? {}
            : {
                capabilityEvidence: step.capability_evidence as NonNullable<
                  RunStepView["capabilityEvidence"]
                >,
              }),
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
      const breakerTransitions: RunBreakerTransition[] = breakers
        .filter((move) => move.run_id === row.run_id)
        .map((move) => ({
          routeId: String(move.route_id),
          alias: String(move.alias),
          from: move.from_state as RunBreakerTransition["from"],
          to: move.to_state as RunBreakerTransition["to"],
          consecutiveFailures: Number(move.consecutive_failures),
          recordedAt: String(move.recorded_at),
        }));
      views.push({
        ...summaryOf(row),
        prompt: await payload(row.prompt_artifact_id, row.prompt_privacy_class),
        steps: runSteps,
        ...(breakerTransitions.length === 0 ? {} : { breakerTransitions }),
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
    // Every attempt at the turn's input, using metadata only: inspectors cannot read transcripts.
    // A service failure keeps run.turn NULL; each private turn appends exactly one message pair.
    return [
      `session_id = $5 AND input_message_id IN (
         SELECT candidate.input_message_id FROM clockgrove.agent_runs candidate
          WHERE candidate.tenant_id=$1 AND candidate.session_id=$5 AND (
            candidate.turn=$6 OR candidate.turn IS NULL
              AND candidate.outcome_code IN ('model_unavailable','model_steps_exhausted','cost_budget_exhausted','tool_calls_exhausted','usage_refused')
              AND candidate.input_revision=($6::integer-1)*2 AND EXISTS (
                SELECT 1 FROM clockgrove.run_steps committed WHERE committed.tenant_id=candidate.tenant_id
                  AND committed.run_id=candidate.run_id AND committed.kind='commit' AND committed.status='succeeded')))`,
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

/** One of the actor's recorded self capability calls, as its next prompt reads it (issue 322). */
export interface SelfCapabilityResult {
  readonly capability: string;
  readonly status: string;
  readonly code: string | null;
  readonly result: unknown;
}

/** Decision (issue 322): a prompt carries the newest 4 results, at most 16 KiB of them together. */
const SELF_RESULTS = 4;
const SELF_RESULT_OCTETS = 16_384;

/**
 * The newest recorded results of `capabilities` in the participant's session, from completed runs
 * only, newest first: an abandoned attempt's evidence never reaches a prompt. Run steps are read
 * under the participant's own authorization (migration 0036's `run_reader`).
 */
export function sessionSelfResults(
  client: PostgreSqlClient,
  authorization: RuntimeAuthorizationContext,
  sessionId: string,
  capabilities: readonly string[],
): Promise<readonly SelfCapabilityResult[]> {
  return withClientTransaction(client, { authorization }, async () => {
    const found = await client.query(
      `SELECT s.tool, s.status, s.outcome_code, s.capability_evidence->'result' AS result
         FROM clockgrove.run_steps s JOIN clockgrove.agent_runs r
           ON r.tenant_id = s.tenant_id AND r.run_id = s.run_id
        WHERE s.tenant_id = $1 AND s.session_id = $2 AND s.kind = 'world_command_proposal'
          AND s.capability_evidence IS NOT NULL AND s.tool = ANY($3::text[])
          AND r.status = 'completed'
        ORDER BY s.started_at DESC, s.run_id DESC LIMIT ${SELF_RESULTS}`,
      [authorization.tenantId, sessionId, [...capabilities]],
    );
    const results: SelfCapabilityResult[] = [];
    let octets = 0;
    for (const row of found.rows as Row[]) {
      const entry = {
        capability: String(row.tool),
        status: String(row.status),
        code: nullable(row.outcome_code),
        result: row.result ?? null,
      };
      octets += new TextEncoder().encode(JSON.stringify(entry)).length;
      if (octets > SELF_RESULT_OCTETS) break;
      results.push(entry);
    }
    return results;
  });
}

/** The column's CHECK (migration 0067) on the stored jsonb text form. */
const MAX_EVIDENCE_OCTETS = 16_384;

/**
 * Decision (issue 322): evidence whose stored form would exceed the column's 16 KiB keeps its
 * grant and a bounded marker. The bound is on the jsonb text the CHECK measures, not compact JSON.
 */
export function boundedEvidence(evidence: CapabilityEvidence): string {
  const text = JSON.stringify(evidence);
  if (storedOctets(JSON.parse(text)) <= MAX_EVIDENCE_OCTETS) return text;
  return JSON.stringify({
    grant: evidence.grant,
    arguments: { truncated: true },
    result: { truncated: true },
  });
}

/**
 * The octets of `value`'s jsonb text form (`capability_evidence::text`): a space follows every
 * `:` and `,`. A number jsonb may print in full decimal (1e21 and beyond, or tiny fractions) is
 * counted at the most it can print, so the measure never undercounts.
 */
function storedOctets(value: unknown): number {
  if (value === null || typeof value === "boolean") return String(value).length;
  if (typeof value === "number") {
    const text = String(value);
    return /e/iu.test(text) ? 400 : text.length;
  }
  if (typeof value === "string") return new TextEncoder().encode(JSON.stringify(value)).length;
  if (Array.isArray(value))
    return (
      2 + value.reduce<number>((sum, item, index) => sum + storedOctets(item) + (index ? 2 : 0), 0)
    );
  const entries = Object.entries(value as Record<string, unknown>);
  return (
    2 +
    entries.reduce<number>(
      (sum, [key, item], index) =>
        sum + storedOctets(key) + 2 + storedOctets(item) + (index ? 2 : 0),
      0,
    )
  );
}
