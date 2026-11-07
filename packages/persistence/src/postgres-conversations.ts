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
  type ConversationResponder,
  type ConversationStore,
  type DocumentProposal,
  documentDecisions,
  estimateTokens,
  type OpenConversation,
  type RuntimeAuthorizationContext,
  recordedInputs,
  renderPrompt,
} from "@clockgrove/application";
import {
  type BrowserScope,
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

  async talk(
    participant: ConversationParticipant,
    request: TalkRequest,
    respond: ConversationResponder,
  ): Promise<TalkReceipt> {
    const { scope, sessionId, messageId } = request;
    const stored = await this.stored(participant, scope, sessionId);
    const retried = await this.retried(participant, stored, request);
    if (retried !== undefined) return retried;
    if (stored.row.state !== "active")
      throw new ConversationRefusedError("conversation_not_active");
    const count = Number(stored.row.message_count);
    if (count + 2 > 1000) throw new ConversationRefusedError("conversation_full");
    const sequence = count + 1;
    const caretakerMessages = (sequence + 1) / 2;
    const before = await this.session(participant, stored.row);
    // The input artifact is keyed by message ID, so an exact retry after a lost connection rewrites
    // the same content and other text under that ID is a reuse. The reply's key is fresh: an
    // orphaned reply never collides with a later one.
    const inputArtifact = `${sessionId}:message:${messageId}`;
    await this.put(participant, stored, inputArtifact, request.text, "message_id_reused");
    const context = await this.assemble(participant, stored, request, count);
    const run = await this.beginRun(
      participant,
      stored,
      request,
      count,
      caretakerMessages,
      context,
    );
    const { tenantId } = scope;
    let written: Awaited<ReturnType<typeof this.commitTalk>>;
    let reply: string;
    try {
      const response = respond(before, caretakerMessages, request.text);
      reply = response.text;
      const replyArtifact = `${sessionId}:reply:${crypto.randomUUID()}`;
      await this.put(participant, stored, replyArtifact, reply, "conversation_busy");
      await this.transaction(participant, () =>
        closedRunRefused(this.runs.modelAnswered(tenantId, run, replyArtifact)),
      );
      written = await this.commitTalk(participant, stored, request, count, inputArtifact, {
        run,
        replyArtifact,
        ...(response.proposal === undefined ? {} : { proposal: response.proposal }),
      });
    } catch (error) {
      if (error instanceof ConversationRefusedError)
        await this.closeRun(participant, run, "failed", error.code);
      else await this.closeRun(participant, run, "abandoned", "attempt_failed");
      throw error;
    }
    if (written === undefined) {
      // A concurrent attempt at this message stored it first.
      await this.closeRun(participant, run, "superseded", "message_stored");
      const receipt = await this.retried(participant, stored, request);
      if (receipt === undefined) throw new ConversationRefusedError("conversation_busy");
      return receipt;
    }
    // The receipt is built from the rows just written and the texts already in hand: no re-read.
    const message = (row: Row, text: string) =>
      decodeConversationMessage({
        sessionId: row.session_id,
        sequence: Number(row.sequence),
        messageId: row.message_id,
        role: row.role,
        authorId: row.author_id,
        voiceMode: row.voice_mode,
        text,
        createdAt: row.created_at,
      });
    return Object.freeze({
      type: "private_caretaker_talk" as const,
      session: this.sessionOf(written.session, before.title),
      message: message(written.input, request.text),
      reply: message(written.output, reply),
      turn: turnOf(written.turn),
    });
  }

  /**
   * Assembles this turn's context (migration 0037, `docs/protocols/context-assembly.md`), all as
   * the participant, in one transaction: candidate metadata, the budget decided from it, then only
   * the admitted documents' text in a single read.
   */
  private async assemble(
    participant: ConversationParticipant,
    stored: StoredSession,
    request: TalkRequest,
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
      const texts = await this.admittedTexts(tenantId, inputs, estimateTokens(request.text));
      return { inputs, messages, texts };
    });
    return assembleContext(inputs, (source) =>
      this.source(participant, stored, messages, texts, source, async () => request.text),
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
   * Opens this attempt's run (migration 0036) with its protected model input, the exact prompt the
   * scripted model reads, as a `conversation` artifact, or `private_cognition` when it includes an
   * actor document, and its context step and manifest (0037).
   * A session at its run limit is full.
   */
  private async beginRun(
    participant: ConversationParticipant,
    stored: StoredSession,
    request: TalkRequest,
    count: number,
    caretakerMessages: number,
    context: AssembledContext,
  ): Promise<string> {
    // A full session is refused before its prompt is stored, so a refused Talk leaves no artifact.
    const full = await this.transaction(participant, () =>
      this.runs.full(participant.tenantId, request.sessionId),
    );
    if (full) throw new ConversationRefusedError("conversation_full");
    const runId = `run-${crypto.randomUUID()}`;
    const promptArtifactId = `${request.sessionId}:prompt:${runId}`;
    const prompt = renderPrompt(
      { model: SCRIPTED_MODEL, sessionId: request.sessionId, caretakerMessages },
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
    const start: TalkRunStart = {
      tenantId: String(row.tenant_id),
      worldId: String(row.world_id),
      timelineId: String(row.timeline_id),
      partitionId: stored.partitionId,
      spaceId: stored.spaceId,
      sessionId: request.sessionId,
      actorId: String(row.actor_id),
      principalId: participant.principalId,
      personaId: participant.personaId,
      runId,
      inputMessageId: request.messageId,
      inputRevision: count,
      caretakerMessages,
      promptArtifactId,
      promptPrivacyClass,
      contextSummary: `Assembled ${context.entries.filter((e) => e.decision === "included").length} of ${context.entries.length} context sources`,
    };
    const manifest: ContextManifest = {
      runId,
      sessionId: request.sessionId,
      actorId: String(row.actor_id),
      inputMessageId: request.messageId,
      inputRevision: count,
      tokenBudget: context.tokenBudget,
      tokensUsed: context.tokensUsed,
      manifestHash: context.manifestHash,
      entries: context.entries,
    };
    try {
      await this.transaction(participant, async () => {
        await this.runs.beginTalk(start);
        await this.manifests.record(
          {
            tenantId: start.tenantId,
            worldId: start.worldId,
            timelineId: start.timelineId,
            spaceId: start.spaceId,
          },
          manifest,
        );
      });
    } catch (error) {
      if ((error as { code?: unknown }).code === "CG021")
        throw new ConversationRefusedError("conversation_full");
      throw error;
    }
    return runId;
  }

  /**
   * Records a disposition other than completion. When the database itself failed this may fail
   * too; the run then stays open until the session's next attempt abandons it as stale.
   */
  private async closeRun(
    participant: ConversationParticipant,
    runId: string,
    status: "failed" | "abandoned" | "superseded",
    outcomeCode: string,
  ): Promise<void> {
    try {
      await this.transaction(participant, () =>
        this.runs.close(participant.tenantId, runId, status, outcomeCode),
      );
    } catch {
      // The original refusal or failure is what the caller answers.
    }
  }

  /**
   * Appends the Caretaker message, the reply and the turn, and completes the run, in one
   * transaction. Undefined when a concurrent attempt stored the message first. A run that a later
   * attempt superseded or abandoned cannot complete, so its messages are not committed.
   */
  private async commitTalk(
    participant: ConversationParticipant,
    stored: StoredSession,
    request: TalkRequest,
    count: number,
    inputArtifact: string,
    attempt: {
      readonly run: string;
      readonly replyArtifact: string;
      readonly proposal?: DocumentProposal;
    },
  ) {
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
      // A concurrent retry of this message stored it first; its receipt is read below.
      if (used.rows.length > 0) return undefined;
      if (Number(current.message_count) !== count)
        throw new ConversationRefusedError("conversation_busy");
      const messages = await this.client.query(
        `INSERT INTO clockgrove.conversation_messages (
           tenant_id, session_id, principal_id, sequence, message_id, role, author_id, voice_mode,
           content_artifact_id
         ) VALUES ($1, $2, $3, $4, $5, 'caretaker', $6, NULL, $7),
                  ($1, $2, NULL, $4 + 1, $8, 'actor', $9, $10, $11)
         RETURNING ${MESSAGE_COLUMNS}`,
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
      const turn = await this.client.query(
        `INSERT INTO clockgrove.conversation_turns (
           tenant_id, session_id, principal_id, turn, input_sequence, output_sequence, model, state
         ) VALUES ($1, $2, $3, $4, $5, $5 + 1, 'scripted-fixture-v1', 'completed')
         RETURNING ${TURN_COLUMNS}`,
        [scope.tenantId, sessionId, participant.principalId, (sequence + 1) / 2, sequence],
      );
      const session = await this.client.query(
        `UPDATE clockgrove.conversation_sessions
            SET message_count = message_count + 2, updated_at = statement_timestamp()
          WHERE ${SESSION_SCOPE}
          RETURNING ${SESSION_COLUMNS}`,
        [scope.tenantId, scope.worldId, scope.timelineId, sessionId],
      );
      let step = 3;
      if (attempt.proposal !== undefined) {
        await closedRunRefused(
          this.propose(participant, stored, request, attempt.run, attempt.proposal),
        );
        step = 4;
      }
      // A later attempt that closed this run refuses its commit, rolling the messages back.
      await closedRunRefused(
        this.runs.committed(
          scope.tenantId,
          sessionId,
          attempt.run,
          (sequence + 1) / 2,
          replyId,
          step,
        ),
      );
      const rows = (messages.rows as Row[]).sort((a, b) => Number(a.sequence) - Number(b.sequence));
      return {
        input: rows[0] as Row,
        output: rows[1] as Row,
        turn: turn.rows[0] as Row,
        session: session.rows[0] as Row,
      };
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
    request: TalkRequest,
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

  /** The stored receipt of this message ID, or undefined when it is new. Other text is a reuse. */
  private async retried(
    participant: ConversationParticipant,
    stored: StoredSession,
    request: TalkRequest,
  ): Promise<TalkReceipt | undefined> {
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
    if (message.text !== request.text) throw new ConversationRefusedError("message_id_reused");
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
    // The runtime writes a private prompt as the actor's cognition, not as the participant's
    // reading: the participant's ceiling gains `private_cognition` for this one write only, and
    // reading the prompt back still needs that class in the reader's own ceiling (0037).
    const writer =
      privacyClass === "conversation"
        ? participant
        : {
            ...participant,
            privacyCeiling: {
              ...participant.privacyCeiling,
              allowedCategories: [
                ...new Set([...participant.privacyCeiling.allowedCategories, privacyClass]),
              ],
            },
          };
    try {
      await this.artifacts.put(writer, {
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

  private async text(
    participant: ConversationParticipant,
    stored: StoredSession,
    artifactId: string,
  ): Promise<string> {
    const { bytes } = await this.artifacts.get(participant, this.locator(stored, artifactId));
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

/** CG020: a later attempt closed this run, so it may not move on; the attempt answers busy. */
async function closedRunRefused(move: Promise<void>): Promise<void> {
  try {
    await move;
  } catch (error) {
    if ((error as { code?: unknown }).code === "CG020")
      throw new ConversationRefusedError("conversation_busy");
    throw error;
  }
}
