import {
  ArtifactConflictError,
  type ArtifactStore,
  type AssembledContext,
  assembleContext,
  CONTEXT_HISTORY_WINDOW,
  CONTEXT_TOKEN_BUDGET,
  type ContextInputs,
  type ContextSource,
  type ConversationParticipant,
  ConversationRefusedError,
  type ConversationResponse,
  type ConversationStore,
  type DocumentProposal,
  documentDecisions,
  estimateTokens,
  type OpenConversation,
  type RuntimeAuthorizationContext,
  recordedInputs,
  renderPrompt,
  type TurnAcceptance,
  type TurnFiber,
  type TurnInput,
} from "@clockgrove/application";
import {
  type BrowserScope,
  CANCELLABLE_TURN_PHASES,
  type ContextManifest,
  type ConversationMessage,
  type ConversationSession,
  type ConversationTranscript,
  type ConversationTurn,
  decodeConversationMessage,
  decodeConversationSession,
  decodeConversationTurn,
  decodeOpaqueId,
  type ObjectId,
  type PartitionId,
  type SpaceId,
  type TalkReceipt,
  type TalkRequest,
  TERMINAL_TURN_PHASES,
  type TurnPhase,
  type TurnRequest,
  type TurnStatus,
  VOICE_DISCLOSURES,
  type VoiceMode,
} from "@clockgrove/contracts";
import {
  PostgreSqlActorDocuments,
  PostgreSqlContextManifests,
} from "./postgres-actor-documents.js";
import { PostgreSqlRunRecorder, SCRIPTED_MODEL, type TalkRunStart } from "./postgres-runs.js";
import { type PostgreSqlClient, withClientTransaction } from "./postgres-transaction.js";

type Row = Record<string, unknown>;

const TEXT_MEDIA_TYPE = "text/plain;charset=utf-8";
const JSON_MEDIA_TYPE = "application/json";
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const timestamp = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${column}`;
// Read from `clockgrove.conversation_sessions` unaliased (a SELECT or an UPDATE's RETURNING); the
// participant set comes with the row, ordered by principal.
const SESSION_COLUMNS = `session_id, tenant_id, world_id, timeline_id, partition_id, space_id,
  actor_id, voice_mode, state, title_artifact_id, message_count,
  ${timestamp("created_at")}, ${timestamp("updated_at")},
  (SELECT json_agg(json_build_object('principalId', participant.principal_id,
                                     'personaId', participant.persona_id)
                   ORDER BY participant.principal_id)
     FROM clockgrove.conversation_participants AS participant
    WHERE participant.tenant_id = conversation_sessions.tenant_id
      AND participant.session_id = conversation_sessions.session_id) AS participants`;
const MESSAGE_COLUMNS = `session_id, sequence, message_id, role, author_id, voice_mode,
  content_artifact_id, ${timestamp("created_at")}`;
const TURN_COLUMNS = `session_id, turn, input_sequence, output_sequence, model, state,
  ${timestamp("created_at")}`;
/** Same scope filter for every session read; RLS admits only sessions the caller participates in. */
const SESSION_SCOPE = "tenant_id = $1 AND world_id = $2 AND timeline_id = $3 AND session_id = $4";

interface StoredSession {
  readonly row: Row;
  readonly partitionId: PartitionId;
  readonly spaceId: SpaceId;
}

/**
 * Conversations over migration 0034. Row visibility is the participant policy; this adapter adds
 * the world/timeline scope and keeps text out of the rows: every message and title is a
 * `conversation` artifact in the session's partition and space, stored encrypted by the artifact
 * store. A deleted session reads as not found.
 */
export class PostgreSqlConversationStore implements ConversationStore {
  private readonly runs: PostgreSqlRunRecorder;
  private readonly documents: PostgreSqlActorDocuments;
  private readonly manifests: PostgreSqlContextManifests;
  constructor(
    private readonly client: PostgreSqlClient,
    private readonly artifacts: ArtifactStore,
    private readonly newSessionId: () => string = () => `conversation-${crypto.randomUUID()}`,
  ) {
    this.runs = new PostgreSqlRunRecorder(client);
    this.documents = new PostgreSqlActorDocuments(client);
    this.manifests = new PostgreSqlContextManifests(client);
  }

  async open(
    participant: ConversationParticipant,
    input: OpenConversation,
  ): Promise<ConversationSession> {
    const sessionId = this.newSessionId();
    const { tenantId, worldId, timelineId, spaceId } = input.scope;
    await this.transaction(participant, async () => {
      try {
        // The participant set first: the session's policy admits only a participant's session.
        await this.client.query(
          `INSERT INTO clockgrove.conversation_participants (
             tenant_id, session_id, principal_id, persona_id
           ) VALUES ($1, $2, $3, $4)`,
          [tenantId, sessionId, participant.principalId, participant.personaId],
        );
        const inserted = await this.client.query(
          `INSERT INTO clockgrove.conversation_sessions (
             tenant_id, session_id, world_id, timeline_id, partition_id, space_id, actor_id,
             voice_mode
           ) SELECT tenant_id, $5, world_id, timeline_id, partition_id, space_id, $6, $7
               FROM clockgrove.timeline_partitions
              WHERE tenant_id = $1 AND world_id = $2 AND timeline_id = $3 AND space_id = $4
              LIMIT 1
           RETURNING session_id`,
          [tenantId, worldId, timelineId, spaceId, sessionId, input.actorId, input.voiceMode],
        );
        if (inserted.rows.length !== 1)
          throw new ConversationRefusedError("conversation_not_found");
      } catch (error) {
        if ((error as { code?: unknown }).code === "CG021")
          throw new ConversationRefusedError("conversation_limit_reached");
        throw error;
      }
    });
    if (input.title !== undefined)
      return this.title(participant, input.scope, sessionId, input.title);
    return this.session(participant, (await this.stored(participant, input.scope, sessionId)).row);
  }

  async list(
    participant: ConversationParticipant,
    scope: BrowserScope,
    actorId?: ObjectId,
  ): Promise<readonly ConversationSession[]> {
    const rows = await this.transaction(participant, async () => {
      const found = await this.client.query(
        `SELECT ${SESSION_COLUMNS} FROM clockgrove.conversation_sessions
          WHERE tenant_id = $1 AND world_id = $2 AND timeline_id = $3 AND state <> 'deleted'
            AND ($4::text IS NULL OR actor_id = $4)
            AND session_id IN (
              SELECT participant.session_id FROM clockgrove.conversation_participants AS participant
               WHERE participant.tenant_id = $1 AND participant.principal_id = $5)
          ORDER BY updated_at DESC, session_id`,
        [scope.tenantId, scope.worldId, scope.timelineId, actorId ?? null, participant.principalId],
      );
      return found.rows as Row[];
    });
    const sessions: ConversationSession[] = [];
    for (const row of rows) sessions.push(await this.session(participant, row));
    return sessions;
  }

  async read(
    participant: ConversationParticipant,
    scope: BrowserScope,
    sessionId: string,
    afterSequence: number,
    limit: number,
  ): Promise<ConversationTranscript> {
    const stored = await this.stored(participant, scope, sessionId);
    const { messageRows, turnRows } = await this.transaction(participant, async () => {
      const messages = await this.client.query(
        `SELECT ${MESSAGE_COLUMNS} FROM clockgrove.conversation_messages
          WHERE tenant_id = $1 AND session_id = $2 AND sequence > $3
          ORDER BY sequence LIMIT $4`,
        [scope.tenantId, sessionId, afterSequence, limit + 1],
      );
      const turns = await this.client.query(
        `SELECT ${TURN_COLUMNS} FROM clockgrove.conversation_turns
          WHERE tenant_id = $1 AND session_id = $2 AND output_sequence > $3
            AND output_sequence <= $3 + $4
          ORDER BY turn`,
        [scope.tenantId, sessionId, afterSequence, limit],
      );
      return { messageRows: messages.rows as Row[], turnRows: turns.rows as Row[] };
    });
    const page = messageRows.slice(0, limit);
    const messages: ConversationMessage[] = [];
    for (const row of page) messages.push(await this.message(participant, stored, row));
    return Object.freeze({
      session: await this.session(participant, stored.row),
      messages,
      turns: turnRows.map(turnOf),
      nextAfterSequence: messageRows.length > limit ? (messages.at(-1)?.sequence ?? null) : null,
    });
  }

  async title(
    participant: ConversationParticipant,
    scope: BrowserScope,
    sessionId: string,
    title: string,
  ): Promise<ConversationSession> {
    const stored = await this.stored(participant, scope, sessionId);
    const artifactId = `${sessionId}:title:${crypto.randomUUID()}`;
    await this.put(participant, stored, artifactId, title, "conversation_busy");
    return this.update(participant, scope, sessionId, "title_artifact_id = $5", artifactId);
  }

  async archive(
    participant: ConversationParticipant,
    scope: BrowserScope,
    sessionId: string,
    archived: boolean,
  ): Promise<ConversationSession> {
    return this.update(
      participant,
      scope,
      sessionId,
      "state = $5",
      archived ? "archived" : "active",
      "AND state IN ('active', 'archived')",
    );
  }

  async delete(
    participant: ConversationParticipant,
    scope: BrowserScope,
    sessionId: string,
  ): Promise<void> {
    await this.update(participant, scope, sessionId, "state = $5", "deleted");
  }

  async acceptTurn(
    participant: ConversationParticipant,
    request: TalkRequest,
  ): Promise<TurnAcceptance> {
    const { scope, sessionId, messageId } = request;
    const stored = await this.stored(participant, scope, sessionId);
    const receipt = await this.retried(participant, stored, request.messageId, request.text);
    if (receipt !== undefined) return { receipt };
    // The input artifact is keyed by message ID, so a duplicate delivery rewrites the same content
    // and other text under that ID is a reuse, whether or not its turn was accepted.
    const inputArtifact = `${sessionId}:message:${messageId}`;
    const existing = await this.fiberOf(participant, scope, sessionId, messageId);
    if (existing === undefined) {
      if (stored.row.state !== "active")
        throw new ConversationRefusedError("conversation_not_active");
      if (Number(stored.row.message_count) + 2 > 1000)
        throw new ConversationRefusedError("conversation_full");
    }
    await this.put(participant, stored, inputArtifact, request.text, "message_id_reused");
    if (existing !== undefined) return { fiber: existing };
    try {
      const inserted = await this.transaction(participant, () =>
        this.client.query(
          `INSERT INTO clockgrove.conversation_turn_fibers (
             tenant_id, session_id, message_id, world_id, timeline_id, actor_id, principal_id,
             persona_id, input_artifact_id
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (tenant_id, session_id, message_id) DO NOTHING
           RETURNING ${FIBER_COLUMNS}`,
          [
            scope.tenantId,
            sessionId,
            messageId,
            scope.worldId,
            scope.timelineId,
            stored.row.actor_id,
            participant.principalId,
            participant.personaId,
            inputArtifact,
          ],
        ),
      );
      const row = inserted.rows[0] as Row | undefined;
      if (row !== undefined) return { fiber: fiberOf(row, scope) };
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      // Another turn of this session is open: turns are ordered within a session.
      if (code === "23505") throw new ConversationRefusedError("conversation_busy");
      if (code === "CG021") throw new ConversationRefusedError("conversation_full");
      throw error;
    }
    // A concurrent delivery of the same message accepted it first.
    const raced = await this.fiberOf(participant, scope, sessionId, messageId);
    if (raced === undefined) throw new ConversationRefusedError("conversation_busy");
    return { fiber: raced };
  }

  async claimTurn(
    participant: ConversationParticipant,
    fiber: TurnFiber,
    holder: string,
    capabilityRevision: number,
  ): Promise<TurnFiber | undefined> {
    if (TERMINAL_TURN_PHASES.includes(fiber.phase)) return undefined;
    const stored = await this.stored(participant, fiber.scope, fiber.sessionId);
    // A turn that already committed only finalizes: it needs no new attempt.
    const needsRun = fiber.phase !== "finalizing";
    const start = needsRun ? await this.prepareRun(participant, stored, fiber) : undefined;
    try {
      return await this.transaction(participant, async () => {
        const current = await this.lockedFiber(fiber);
        if (current === undefined || TERMINAL_TURN_PHASES.includes(current.phase)) return undefined;
        if (current.runId !== null)
          await this.runs.close(fiber.scope.tenantId, current.runId, "abandoned", "owner_lost");
        if (start !== undefined) {
          await this.runs.beginTalk(start.run);
          await this.manifests.record(
            {
              tenantId: start.run.tenantId,
              worldId: start.run.worldId,
              timelineId: start.run.timelineId,
              spaceId: start.run.spaceId,
            },
            start.manifest,
          );
          // A checkpointed answer is not asked for again: this attempt commits it.
          if (current.replyArtifactId !== null)
            await this.runs.modelAnswered(
              fiber.scope.tenantId,
              start.run.runId,
              current.replyArtifactId,
            );
        }
        const claimed = await this.client.query(
          `UPDATE clockgrove.conversation_turn_fibers
              SET lease_epoch = lease_epoch + 1, attempt = attempt + 1, lease_holder = $4,
                  run_id = coalesce($5, run_id), capability_revision = $6,
                  phase = CASE phase WHEN 'accepted' THEN 'context_pending' ELSE phase END
            WHERE ${FIBER_KEY}
            RETURNING ${FIBER_COLUMNS}`,
          [...fiberKey(fiber), holder, start?.run.runId ?? null, capabilityRevision],
        );
        return fiberOf(claimed.rows[0] as Row, fiber.scope);
      });
    } catch (error) {
      if ((error as { code?: unknown }).code === "CG021")
        throw new ConversationRefusedError("conversation_full");
      throw error;
    }
  }

  async assembleTurn(
    participant: ConversationParticipant,
    fiber: TurnFiber,
  ): Promise<TurnFiber | undefined> {
    const stored = await this.stored(participant, fiber.scope, fiber.sessionId);
    const inputRevision = Number(stored.row.message_count);
    return this.moveTurn(participant, fiber, "context_ready", { inputRevision });
  }

  async actorOf(
    participant: ConversationParticipant,
    scope: BrowserScope,
    sessionId: string,
  ): Promise<string> {
    return String((await this.stored(participant, scope, sessionId)).row.actor_id);
  }

  advanceTurn(
    participant: ConversationParticipant,
    fiber: TurnFiber,
    to: TurnPhase,
  ): Promise<TurnFiber | undefined> {
    return this.moveTurn(participant, fiber, to);
  }

  async turnInput(participant: ConversationParticipant, fiber: TurnFiber): Promise<TurnInput> {
    const stored = await this.stored(participant, fiber.scope, fiber.sessionId);
    return {
      session: await this.session(participant, stored.row),
      caretakerMessages: ((fiber.inputRevision ?? Number(stored.row.message_count)) + 2) / 2,
      input: await this.text(participant, stored, fiber.inputArtifactId),
    };
  }

  async answerTurn(
    participant: ConversationParticipant,
    fiber: TurnFiber,
    response: ConversationResponse,
  ): Promise<TurnFiber | undefined> {
    const stored = await this.stored(participant, fiber.scope, fiber.sessionId);
    // The answer's keys are fresh: an orphaned answer never collides with a later one.
    const answer = crypto.randomUUID();
    const replyArtifact = `${fiber.sessionId}:reply:${answer}`;
    await this.put(participant, stored, replyArtifact, response.text, "conversation_busy");
    // A proposal is checkpointed with the reply, so a recovered attempt commits the same one. It
    // holds actor document content, so it is the actor's private cognition (issue 17).
    let proposalArtifact: string | undefined;
    if (response.proposal !== undefined) {
      proposalArtifact = `${fiber.sessionId}:proposal:${answer}`;
      await this.put(
        participant,
        stored,
        proposalArtifact,
        JSON.stringify({ path: response.proposal.path, content: response.proposal.content }),
        "conversation_busy",
        JSON_MEDIA_TYPE,
        "private_cognition",
      );
    }
    return this.fenced(() =>
      this.transaction(participant, async () => {
        if (fiber.runId !== null)
          await this.runs.modelAnswered(fiber.scope.tenantId, fiber.runId, replyArtifact);
        return this.moveTurnHere(fiber, "proposal_validating", {
          replyArtifactId: replyArtifact,
          ...(proposalArtifact === undefined ? {} : { proposalArtifactId: proposalArtifact }),
        });
      }),
    );
  }

  async commitTurn(
    participant: ConversationParticipant,
    fiber: TurnFiber,
  ): Promise<TurnFiber | undefined> {
    const stored = await this.stored(participant, fiber.scope, fiber.sessionId);
    if (fiber.runId === null || fiber.replyArtifactId === null)
      throw new Error("a committing turn has a run and an answer");
    const { runId, replyArtifactId } = fiber;
    const count = Number(stored.row.message_count);
    const proposal =
      fiber.proposalArtifactId === null
        ? undefined
        : (JSON.parse(
            await this.text(participant, stored, fiber.proposalArtifactId, "private_cognition"),
          ) as DocumentProposal);
    return this.fenced(async () => {
      const written = await this.commitTalk(
        participant,
        stored,
        fiber,
        count,
        `${fiber.sessionId}:message:${fiber.messageId}`,
        {
          run: runId,
          replyArtifact: replyArtifactId,
          ...(proposal === undefined ? {} : { proposal }),
        },
        () => this.moveTurnHere(fiber, "finalizing"),
      );
      return written;
    });
  }

  async endTurn(
    participant: ConversationParticipant,
    fiber: TurnFiber,
    phase: "completed" | "failed",
    outcomeCode?: string,
  ): Promise<TurnFiber | undefined> {
    return this.fenced(() =>
      this.transaction(participant, async () => {
        if (phase === "failed" && fiber.runId !== null)
          await this.runs.close(
            fiber.scope.tenantId,
            fiber.runId,
            "failed",
            outcomeCode ?? "failed",
          );
        return this.moveTurnHere(fiber, phase, { outcomeCode: outcomeCode ?? null });
      }),
    );
  }

  async turnReceipt(participant: ConversationParticipant, fiber: TurnFiber): Promise<TalkReceipt> {
    const stored = await this.stored(participant, fiber.scope, fiber.sessionId);
    const receipt = await this.retried(participant, stored, fiber.messageId);
    if (receipt === undefined) throw new ConversationRefusedError("turn_not_found");
    return receipt;
  }

  async turnStatus(
    participant: ConversationParticipant,
    request: TurnRequest,
  ): Promise<TurnStatus> {
    await this.stored(participant, request.scope, request.sessionId);
    const fiber = await this.fiberOf(
      participant,
      request.scope,
      request.sessionId,
      request.messageId,
    );
    if (fiber === undefined) throw new ConversationRefusedError("turn_not_found");
    return statusOf(fiber);
  }

  async cancelTurn(
    participant: ConversationParticipant,
    request: TurnRequest,
  ): Promise<TurnStatus> {
    await this.stored(participant, request.scope, request.sessionId);
    const key = {
      scope: request.scope,
      sessionId: request.sessionId,
      messageId: request.messageId,
    };
    const fiber = await this.transaction(participant, async () => {
      const current = await this.lockedFiber(key);
      if (current === undefined) throw new ConversationRefusedError("turn_not_found");
      if (!CANCELLABLE_TURN_PHASES.includes(current.phase)) return current;
      if (current.runId !== null)
        await this.runs.close(
          request.scope.tenantId,
          current.runId,
          "cancelled",
          "cancel_requested",
        );
      const cancelled = await this.client.query(
        `UPDATE clockgrove.conversation_turn_fibers
            SET phase = 'cancelled', outcome_code = 'cancel_requested', lease_holder = NULL
          WHERE ${FIBER_KEY}
          RETURNING ${FIBER_COLUMNS}`,
        fiberKey(key),
      );
      return fiberOf(cancelled.rows[0] as Row, request.scope);
    });
    return statusOf(fiber);
  }

  async openTurns(
    participant: ConversationParticipant,
    scope: BrowserScope,
    actorId: string,
  ): Promise<readonly TurnFiber[]> {
    const rows = await this.transaction(participant, async () => {
      const found = await this.client.query(
        `SELECT ${FIBER_COLUMNS} FROM clockgrove.conversation_turn_fibers
          WHERE tenant_id = $1 AND world_id = $2 AND timeline_id = $3 AND actor_id = $4
            AND principal_id = $5 AND phase NOT IN (${TERMINAL_SQL})
          ORDER BY created_at, session_id`,
        [scope.tenantId, scope.worldId, scope.timelineId, actorId, participant.principalId],
      );
      return found.rows as Row[];
    });
    return rows.map((row) => fiberOf(row, scope));
  }

  private async fiberOf(
    participant: ConversationParticipant,
    scope: BrowserScope,
    sessionId: string,
    messageId: string,
  ): Promise<TurnFiber | undefined> {
    const row = await this.transaction(participant, async () => {
      const found = await this.client.query(
        `SELECT ${FIBER_COLUMNS} FROM clockgrove.conversation_turn_fibers WHERE ${FIBER_KEY}`,
        [scope.tenantId, sessionId, messageId],
      );
      return found.rows[0] as Row | undefined;
    });
    return row === undefined ? undefined : fiberOf(row, scope);
  }

  /** The fiber's current row, locked for this transaction. */
  private async lockedFiber(fiber: {
    readonly scope: BrowserScope;
    readonly sessionId: string;
    readonly messageId: string;
  }): Promise<TurnFiber | undefined> {
    const found = await this.client.query(
      `SELECT ${FIBER_COLUMNS} FROM clockgrove.conversation_turn_fibers WHERE ${FIBER_KEY}
        FOR UPDATE`,
      fiberKey(fiber),
    );
    const row = found.rows[0] as Row | undefined;
    return row === undefined ? undefined : fiberOf(row, fiber.scope);
  }

  private moveTurn(
    participant: ConversationParticipant,
    fiber: TurnFiber,
    to: TurnPhase,
    changes: FiberChanges = {},
  ): Promise<TurnFiber | undefined> {
    return this.fenced(() =>
      this.transaction(participant, () => this.moveTurnHere(fiber, to, changes)),
    );
  }

  /**
   * Moves the turn from the phase this holder last saw, under its lease epoch, inside the caller's
   * transaction. Undefined when either moved on: a cancel, or a newer incarnation's claim.
   */
  private async moveTurnHere(
    fiber: TurnFiber,
    to: TurnPhase,
    changes: FiberChanges = {},
  ): Promise<TurnFiber | undefined> {
    const terminal = TERMINAL_TURN_PHASES.includes(to);
    const moved = await this.client.query(
      `UPDATE clockgrove.conversation_turn_fibers
          SET phase = $6,
              input_revision = coalesce($7, input_revision),
              reply_artifact_id = coalesce($8, reply_artifact_id),
              outcome_code = coalesce($9, outcome_code),
              lease_holder = CASE WHEN $10 THEN NULL ELSE lease_holder END,
              proposal_artifact_id = coalesce($11, proposal_artifact_id)
        WHERE ${FIBER_KEY} AND lease_epoch = $4 AND phase = $5
        RETURNING ${FIBER_COLUMNS}`,
      [
        ...fiberKey(fiber),
        fiber.leaseEpoch,
        fiber.phase,
        to,
        changes.inputRevision ?? null,
        changes.replyArtifactId ?? null,
        changes.outcomeCode ?? null,
        terminal,
        changes.proposalArtifactId ?? null,
      ],
    );
    const row = moved.rows[0] as Row | undefined;
    return row === undefined ? undefined : fiberOf(row, fiber.scope);
  }

  /** A closed run (CG020) means a cancel or a newer claim overtook this holder: it is fenced. */
  private async fenced<T>(move: () => Promise<T | undefined>): Promise<T | undefined> {
    try {
      return await move();
    } catch (error) {
      if (error instanceof TurnFencedError || (error as { code?: unknown }).code === "CG020")
        return undefined;
      throw error;
    }
  }

  /**
   * Assembles this turn's context (migration 0037, `docs/protocols/context-assembly.md`), all as
   * the participant, in one transaction: candidate metadata, the budget decided from it, then only
   * the admitted documents' text in a single read.
   */
  private async assemble(
    participant: ConversationParticipant,
    stored: StoredSession,
    request: TurnFiber,
    text: string,
    count: number,
  ): Promise<AssembledContext> {
    const { tenantId } = request.scope;
    const { inputs, messages, texts } = await this.transaction(participant, async () => {
      const messages = await this.historyRows(tenantId, request.sessionId, count);
      const inputs: ContextInputs = {
        sessionId: request.sessionId,
        inputMessageId: request.messageId,
        inputRevision: count,
        tokenBudget: CONTEXT_TOKEN_BUDGET,
        documents: await this.documents.candidates(tenantId, request.sessionId),
        messages: messages.map((row) => ({
          messageId: String(row.message_id),
          sequence: Number(row.sequence),
          role: row.role as "caretaker" | "actor",
        })),
      };
      const texts = await this.admittedTexts(tenantId, inputs, estimateTokens(text));
      return { inputs, messages, texts };
    });
    return assembleContext(inputs, (source) =>
      this.source(participant, stored, messages, texts, source, async () => text),
    );
  }

  /**
   * Assembles a recorded manifest's context again from its recorded inputs: its budget, the cited
   * document versions, the session's messages up to its input revision and the stored input
   * message. The caller reads them under its own authorization, so it must be able to read the
   * session's text.
   */
  async reassemble(
    authorization: RuntimeAuthorizationContext,
    scope: BrowserScope,
    manifest: ContextManifest,
  ): Promise<string> {
    const reader = authorization as ConversationParticipant;
    const stored = await this.stored(reader, scope, manifest.sessionId);
    const input = await this.text(
      reader,
      stored,
      `${manifest.sessionId}:message:${manifest.inputMessageId}`,
    );
    const inputs = recordedInputs(manifest);
    const { messages, texts } = await this.transaction(reader, async () => ({
      messages: await this.historyRows(scope.tenantId, manifest.sessionId, manifest.inputRevision),
      texts: await this.admittedTexts(scope.tenantId, inputs, estimateTokens(input)),
    }));
    const context = await assembleContext(inputs, (source) =>
      this.source(reader, stored, messages, texts, source, async () => input),
    );
    return context.manifestHash;
  }

  /** The admitted documents' texts, keyed `documentId@version`, in one read. */
  private admittedTexts(tenantId: string, inputs: ContextInputs, inputTokens: number) {
    return this.documents.contents(
      tenantId,
      documentDecisions(inputs, inputTokens)
        .filter(({ rule }) => rule === null)
        .map(({ document }) => ({ documentId: document.documentId, version: document.version })),
    );
  }

  /** The newest history-window messages at or before a revision. */
  private async historyRows(tenantId: string, sessionId: string, revision: number) {
    const found = await this.client.query(
      `SELECT sequence, message_id, role, content_artifact_id FROM clockgrove.conversation_messages
        WHERE tenant_id = $1 AND session_id = $2 AND sequence > $3::integer - $4::integer
          AND sequence <= $3::integer
        ORDER BY sequence`,
      [tenantId, sessionId, revision, CONTEXT_HISTORY_WINDOW],
    );
    return found.rows as Row[];
  }

  /** One admitted source's text. A source the caller cannot read fails the assembly. */
  private async source(
    participant: ConversationParticipant,
    stored: StoredSession,
    messages: readonly Row[],
    documents: ReadonlyMap<string, string>,
    source: ContextSource,
    input: () => Promise<string>,
  ): Promise<string> {
    if (source.source === "input") return input();
    if (source.source === "message") {
      const row = messages.find((message) => Number(message.sequence) === source.sequence);
      if (row === undefined) throw new Error("context message unreadable");
      return this.text(participant, stored, String(row.content_artifact_id));
    }
    const text = documents.get(`${source.documentId}@${source.version}`);
    if (text === undefined) throw new Error("context document unreadable");
    return text;
  }

  /**
   * Prepares an attempt's run (migration 0036): it assembles the attempt's context (0037,
   * `docs/protocols/context-assembly.md`) and stores the exact prompt the scripted model reads, as a
   * `conversation` artifact, or `private_cognition` when it includes an actor document, with the
   * manifest the claim records beside the run. A session at its run limit is full.
   */
  private async prepareRun(
    participant: ConversationParticipant,
    stored: StoredSession,
    fiber: TurnFiber,
  ): Promise<{ readonly run: TalkRunStart; readonly manifest: ContextManifest }> {
    // A full session is refused before its prompt is stored, so a refused attempt leaves no artifact.
    const full = await this.transaction(participant, () =>
      this.runs.full(participant.tenantId, fiber.sessionId),
    );
    if (full) throw new ConversationRefusedError("conversation_full");
    const count = Number(stored.row.message_count);
    const caretakerMessages = (count + 2) / 2;
    const runId = `run-${crypto.randomUUID()}`;
    const promptArtifactId = `${fiber.sessionId}:prompt:${runId}`;
    const input = await this.text(participant, stored, fiber.inputArtifactId);
    const context = await this.assemble(participant, stored, fiber, input, count);
    const prompt = renderPrompt(
      { model: SCRIPTED_MODEL, sessionId: fiber.sessionId, caretakerMessages },
      context,
    );
    // Decision (issue 17, owner's answer 1): a prompt that includes any actor document holds
    // private cognition, so it is stored as that class, never copied into a conversation artifact.
    const promptPrivacyClass = context.entries.some(
      (entry) => entry.source === "document" && entry.decision === "included",
    )
      ? "private_cognition"
      : "conversation";
    await this.put(
      participant,
      stored,
      promptArtifactId,
      prompt,
      "conversation_busy",
      JSON_MEDIA_TYPE,
      promptPrivacyClass,
    );
    const row = stored.row;
    return {
      run: {
        tenantId: String(row.tenant_id),
        worldId: String(row.world_id),
        timelineId: String(row.timeline_id),
        partitionId: stored.partitionId,
        spaceId: stored.spaceId,
        sessionId: fiber.sessionId,
        actorId: String(row.actor_id),
        principalId: fiber.principalId,
        personaId: fiber.personaId,
        runId,
        inputMessageId: fiber.messageId,
        inputRevision: count,
        caretakerMessages,
        promptArtifactId,
        promptPrivacyClass,
        contextSummary: `Assembled ${context.entries.filter((e) => e.decision === "included").length} of ${context.entries.length} context sources`,
      },
      manifest: {
        runId,
        sessionId: fiber.sessionId,
        actorId: String(row.actor_id),
        inputMessageId: fiber.messageId,
        inputRevision: count,
        tokenBudget: context.tokenBudget,
        tokensUsed: context.tokensUsed,
        manifestHash: context.manifestHash,
        entries: context.entries,
      },
    };
  }

  /**
   * Appends the Caretaker message, the reply and the turn, and completes the run, in one
   * transaction. Undefined when a concurrent attempt stored the message first. A run that a later
   * attempt superseded or abandoned cannot complete, so its messages are not committed.
   */
  private async commitTalk(
    participant: ConversationParticipant,
    stored: StoredSession,
    request: {
      readonly scope: BrowserScope;
      readonly sessionId: string;
      readonly messageId: string;
    },
    count: number,
    inputArtifact: string,
    attempt: {
      readonly run: string;
      readonly replyArtifact: string;
      readonly proposal?: DocumentProposal;
    },
    checkpoint: () => Promise<TurnFiber | undefined>,
  ): Promise<TurnFiber | undefined> {
    const { scope, sessionId, messageId } = request;
    const replyId = `${messageId}:reply`;
    const sequence = count + 1;
    const replyArtifact = attempt.replyArtifact;
    return this.transaction(participant, async () => {
      const locked = await this.client.query(
        `SELECT message_count, state FROM clockgrove.conversation_sessions
          WHERE ${SESSION_SCOPE} FOR UPDATE`,
        [scope.tenantId, scope.worldId, scope.timelineId, sessionId],
      );
      const current = locked.rows[0] as Row | undefined;
      if (current === undefined || current.state === "deleted")
        throw new ConversationRefusedError("conversation_not_found");
      if (current.state !== "active") throw new ConversationRefusedError("conversation_not_active");
      const used = await this.client.query(
        `SELECT 1 FROM clockgrove.conversation_messages
          WHERE tenant_id = $1 AND session_id = $2 AND message_id = $3`,
        [scope.tenantId, sessionId, messageId],
      );
      // Only this turn commits its message, so it is already stored only if this turn moved on.
      if (used.rows.length > 0) return undefined;
      if (Number(current.message_count) !== count)
        throw new ConversationRefusedError("conversation_busy");
      await this.client.query(
        `INSERT INTO clockgrove.conversation_messages (
           tenant_id, session_id, principal_id, sequence, message_id, role, author_id, voice_mode,
           content_artifact_id
         ) VALUES ($1, $2, $3, $4, $5, 'caretaker', $6, NULL, $7),
                  ($1, $2, NULL, $4 + 1, $8, 'actor', $9, $10, $11)`,
        [
          scope.tenantId,
          sessionId,
          participant.principalId,
          sequence,
          messageId,
          participant.personaId,
          inputArtifact,
          replyId,
          stored.row.actor_id,
          stored.row.voice_mode,
          replyArtifact,
        ],
      );
      await this.client.query(
        `INSERT INTO clockgrove.conversation_turns (
           tenant_id, session_id, principal_id, turn, input_sequence, output_sequence, model, state
         ) VALUES ($1, $2, $3, $4, $5, $5 + 1, 'scripted-fixture-v1', 'completed')`,
        [scope.tenantId, sessionId, participant.principalId, (sequence + 1) / 2, sequence],
      );
      await this.client.query(
        `UPDATE clockgrove.conversation_sessions
            SET message_count = message_count + 2, updated_at = statement_timestamp()
          WHERE ${SESSION_SCOPE}`,
        [scope.tenantId, scope.worldId, scope.timelineId, sessionId],
      );
      let step = 3;
      if (attempt.proposal !== undefined) {
        await this.propose(participant, stored, request, attempt.run, attempt.proposal);
        step = 4;
      }
      // A cancel or newer claim that closed this run refuses its commit (CG020), rolling it back.
      await this.runs.committed(
        scope.tenantId,
        sessionId,
        attempt.run,
        (sequence + 1) / 2,
        replyId,
        step,
      );
      const moved = await checkpoint();
      if (moved === undefined) throw new TurnFencedError();
      return moved;
    });
  }

  /**
   * The model's document proposal, as a change set of its run inside the turn's transaction: it
   * creates the path or patches its head. A refusal is recorded as a refused change set and a failed
   * validation step; the turn still commits.
   */
  private async propose(
    participant: ConversationParticipant,
    stored: StoredSession,
    request: { readonly sessionId: string },
    runId: string,
    proposal: DocumentProposal,
  ): Promise<void> {
    const row = stored.row;
    const head = await this.client.query(
      `SELECT current_version FROM clockgrove.actor_documents
        WHERE tenant_id = $1 AND world_id = $2 AND timeline_id = $3 AND actor_id = $4 AND path = $5`,
      [row.tenant_id, row.world_id, row.timeline_id, row.actor_id, proposal.path],
    );
    const current = (head.rows[0] as Row | undefined)?.current_version;
    const outcome = await this.documents.apply({
      tenantId: String(row.tenant_id),
      worldId: String(row.world_id),
      timelineId: String(row.timeline_id),
      actorId: String(row.actor_id),
      changeSetId: `${runId}:documents`,
      principalId: participant.principalId,
      personaId: participant.personaId,
      proposer: { kind: "model", runId, sessionId: request.sessionId },
      operations: [
        current === undefined
          ? { op: "create", path: proposal.path, content: proposal.content }
          : {
              op: "patch",
              path: proposal.path,
              expectedVersion: Number(current),
              content: proposal.content,
            },
      ],
    });
    await this.runs.validated(participant.tenantId, request.sessionId, runId, 3, {
      refused: outcome.status === "refused" ? outcome.code : undefined,
      summary:
        outcome.status === "refused"
          ? `Document proposal refused: ${outcome.code}`
          : `Document proposal committed: ${outcome.documents.map((d) => `version ${d.version}`).join(", ")}`,
    });
  }

  /**
   * The stored receipt of this message ID, or undefined when it is not committed. Other text than
   * the expected text is a reuse.
   */
  private async retried(
    participant: ConversationParticipant,
    stored: StoredSession,
    messageId: string,
    text?: string,
  ): Promise<TalkReceipt | undefined> {
    const request = {
      scope: { tenantId: String(stored.row.tenant_id) },
      sessionId: String(stored.row.session_id),
      messageId,
    };
    const rows = await this.transaction(participant, async () => {
      const found = await this.client.query(
        `SELECT ${MESSAGE_COLUMNS} FROM clockgrove.conversation_messages
          WHERE tenant_id = $1 AND session_id = $2 AND message_id IN ($3, $3 || ':reply')
          ORDER BY sequence`,
        [request.scope.tenantId, request.sessionId, request.messageId],
      );
      const turn = await this.client.query(
        `SELECT ${TURN_COLUMNS} FROM clockgrove.conversation_turns AS turn
          WHERE turn.tenant_id = $1 AND turn.session_id = $2 AND turn.input_sequence = (
            SELECT sequence FROM clockgrove.conversation_messages
             WHERE tenant_id = $1 AND session_id = $2 AND message_id = $3)`,
        [request.scope.tenantId, request.sessionId, request.messageId],
      );
      return { messages: found.rows as Row[], turn: turn.rows[0] as Row | undefined };
    });
    const [input, output] = rows.messages;
    if (input === undefined || output === undefined || rows.turn === undefined) return undefined;
    const message = await this.message(participant, stored, input);
    if (text !== undefined && message.text !== text)
      throw new ConversationRefusedError("message_id_reused");
    return Object.freeze({
      type: "private_caretaker_talk" as const,
      session: await this.session(participant, stored.row),
      message,
      reply: await this.message(participant, stored, output),
      turn: turnOf(rows.turn),
    });
  }

  private async update(
    participant: ConversationParticipant,
    scope: BrowserScope,
    sessionId: string,
    assignment: string,
    value: string,
    condition = "",
  ): Promise<ConversationSession> {
    const row = await this.transaction(participant, async () => {
      const updated = await this.client.query(
        `UPDATE clockgrove.conversation_sessions
            SET ${assignment}, updated_at = statement_timestamp()
          WHERE ${SESSION_SCOPE} AND state <> 'deleted' ${condition}
          RETURNING ${SESSION_COLUMNS}`,
        [scope.tenantId, scope.worldId, scope.timelineId, sessionId, value],
      );
      return updated.rows[0] as Row | undefined;
    });
    if (row === undefined) throw new ConversationRefusedError("conversation_not_found");
    return this.session(participant, row);
  }

  private async stored(
    participant: ConversationParticipant,
    scope: BrowserScope,
    sessionId: string,
  ): Promise<StoredSession> {
    const row = await this.transaction(participant, async () => {
      const found = await this.client.query(
        `SELECT ${SESSION_COLUMNS} FROM clockgrove.conversation_sessions
          WHERE ${SESSION_SCOPE} AND state <> 'deleted'`,
        [scope.tenantId, scope.worldId, scope.timelineId, sessionId],
      );
      return found.rows[0] as Row | undefined;
    });
    if (row === undefined) throw new ConversationRefusedError("conversation_not_found");
    return {
      row,
      partitionId: decodeOpaqueId(row.partition_id, "PartitionId"),
      spaceId: decodeOpaqueId(row.space_id, "SpaceId"),
    };
  }

  private async session(
    participant: ConversationParticipant,
    row: Row,
  ): Promise<ConversationSession> {
    const titleId = row.title_artifact_id;
    const stored = {
      row,
      partitionId: decodeOpaqueId(row.partition_id, "PartitionId"),
      spaceId: decodeOpaqueId(row.space_id, "SpaceId"),
    };
    return this.sessionOf(
      row,
      typeof titleId === "string" ? await this.text(participant, stored, titleId) : "",
    );
  }

  private sessionOf(row: Row, title: string): ConversationSession {
    const voiceMode = row.voice_mode as VoiceMode;
    return decodeConversationSession({
      sessionId: row.session_id,
      scope: {
        tenantId: row.tenant_id,
        worldId: row.world_id,
        timelineId: row.timeline_id,
        spaceId: row.space_id,
      },
      actorId: row.actor_id,
      participants: row.participants,
      channel: "browser",
      privacyClass: "conversation",
      voiceMode,
      disclosure: VOICE_DISCLOSURES[voiceMode],
      title,
      state: row.state,
      messageCount: Number(row.message_count),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  private async message(
    participant: ConversationParticipant,
    stored: StoredSession,
    row: Row,
  ): Promise<ConversationMessage> {
    return decodeConversationMessage({
      sessionId: row.session_id,
      sequence: Number(row.sequence),
      messageId: row.message_id,
      role: row.role,
      authorId: row.author_id,
      voiceMode: row.voice_mode,
      text: await this.text(participant, stored, String(row.content_artifact_id)),
      createdAt: row.created_at,
    });
  }

  private async put(
    participant: ConversationParticipant,
    stored: StoredSession,
    artifactId: string,
    text: string,
    collision: "message_id_reused" | "conversation_busy",
    mediaType = TEXT_MEDIA_TYPE,
    privacyClass: "conversation" | "private_cognition" = "conversation",
  ): Promise<void> {
    // The runtime writes a private prompt or proposal as the actor's cognition, not as the participant's
    // reading: the participant's ceiling gains `private_cognition` for this one write only, and
    // reading the prompt back still needs that class in the reader's own ceiling (0037).
    try {
      await this.artifacts.put(cognition(participant, privacyClass), {
        ...this.locator(stored, artifactId),
        bytes: encoder.encode(text),
        mediaType,
        privacyClass,
        retentionClass: "durable",
      });
    } catch (error) {
      // This artifact ID already holds other content.
      if (error instanceof ArtifactConflictError) throw new ConversationRefusedError(collision);
      throw error;
    }
  }

  /**
   * An artifact's text. A `private_cognition` artifact is the actor's, read back only by the
   * runtime's own turn (its checkpointed proposal) under the same one-call ceiling as its write.
   */
  private async text(
    participant: ConversationParticipant,
    stored: StoredSession,
    artifactId: string,
    privacyClass: "conversation" | "private_cognition" = "conversation",
  ): Promise<string> {
    const { bytes } = await this.artifacts.get(
      cognition(participant, privacyClass),
      this.locator(stored, artifactId),
    );
    return decoder.decode(bytes);
  }

  private locator(stored: StoredSession, artifactId: string) {
    return {
      tenantId: decodeOpaqueId(stored.row.tenant_id, "TenantId"),
      worldId: decodeOpaqueId(stored.row.world_id, "WorldId"),
      timelineId: decodeOpaqueId(stored.row.timeline_id, "TimelineId"),
      partitionId: stored.partitionId,
      spaceId: stored.spaceId,
      artifactId: decodeOpaqueId(artifactId, "ArtifactId"),
    };
  }

  private transaction<T>(
    participant: ConversationParticipant,
    operation: () => Promise<T>,
  ): Promise<T> {
    const { tenantId, principalId, privacyCeiling } = participant;
    return withClientTransaction(
      this.client,
      { authorization: { tenantId, principalId, privacyCeiling } },
      operation,
    );
  }
}

function turnOf(row: Row): ConversationTurn {
  return decodeConversationTurn({
    sessionId: row.session_id,
    turn: Number(row.turn),
    inputSequence: Number(row.input_sequence),
    outputSequence: Number(row.output_sequence),
    model: row.model,
    state: row.state,
    createdAt: row.created_at,
  });
}

/**
 * The participant's authorization for one artifact call of a class: `private_cognition` adds that
 * class to its ceiling for this call only, since the runtime acts as the actor's cognition there.
 */
function cognition(
  participant: ConversationParticipant,
  privacyClass: "conversation" | "private_cognition",
): ConversationParticipant {
  if (privacyClass === "conversation") return participant;
  const { allowedCategories } = participant.privacyCeiling;
  return {
    ...participant,
    privacyCeiling: {
      ...participant.privacyCeiling,
      allowedCategories: [...new Set([...allowedCategories, privacyClass])],
    },
  };
}

/** The turn moved on under this holder (a cancel or a newer claim): its commit rolls back. */
class TurnFencedError extends Error {}

type FiberChanges = {
  readonly inputRevision?: number;
  readonly replyArtifactId?: string;
  readonly outcomeCode?: string | null;
  readonly proposalArtifactId?: string;
};

const FIBER_COLUMNS = `session_id, message_id, actor_id, principal_id, persona_id, phase, attempt,
  lease_epoch, run_id, input_artifact_id, reply_artifact_id, proposal_artifact_id, input_revision,
  outcome_code`;
const FIBER_KEY = "tenant_id = $1 AND session_id = $2 AND message_id = $3";
const TERMINAL_SQL = TERMINAL_TURN_PHASES.map((phase) => `'${phase}'`).join(", ");

function fiberKey(fiber: {
  readonly scope: BrowserScope;
  readonly sessionId: string;
  readonly messageId: string;
}): [string, string, string] {
  return [fiber.scope.tenantId, fiber.sessionId, fiber.messageId];
}

function fiberOf(row: Row, scope: BrowserScope): TurnFiber {
  return Object.freeze({
    scope,
    sessionId: String(row.session_id),
    messageId: String(row.message_id),
    actorId: String(row.actor_id),
    principalId: String(row.principal_id),
    personaId: decodeOpaqueId(row.persona_id, "WorldPersonaId"),
    phase: row.phase as TurnPhase,
    attempt: Number(row.attempt),
    leaseEpoch: Number(row.lease_epoch),
    runId: row.run_id === null ? null : String(row.run_id),
    inputArtifactId: String(row.input_artifact_id),
    replyArtifactId: row.reply_artifact_id === null ? null : String(row.reply_artifact_id),
    proposalArtifactId: row.proposal_artifact_id === null ? null : String(row.proposal_artifact_id),
    inputRevision: row.input_revision === null ? null : Number(row.input_revision),
    outcomeCode: row.outcome_code === null ? null : String(row.outcome_code),
  });
}

function statusOf(fiber: TurnFiber): TurnStatus {
  return Object.freeze({
    sessionId: fiber.sessionId,
    messageId: fiber.messageId,
    phase: fiber.phase,
    attempt: fiber.attempt,
    outcomeCode: fiber.outcomeCode,
  });
}
