import {
  ArtifactConflictError,
  type ArtifactStore,
  type ConversationParticipant,
  ConversationRefusedError,
  type ConversationResponder,
  type ConversationStore,
  type OpenConversation,
} from "@clockgrove/application";
import {
  type BrowserScope,
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
import { type PostgreSqlClient, withClientTransaction } from "./postgres-transaction.js";

type Row = Record<string, unknown>;

const TEXT_MEDIA_TYPE = "text/plain;charset=utf-8";
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const timestamp = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${column}`;
const SESSION_COLUMNS = `session_id, tenant_id, world_id, timeline_id, partition_id, space_id,
  principal_id, persona_id, actor_id, voice_mode, state, title_artifact_id, message_count,
  ${timestamp("created_at")}, ${timestamp("updated_at")}`;
const MESSAGE_COLUMNS = `session_id, sequence, message_id, role, author_id, voice_mode,
  content_artifact_id, ${timestamp("created_at")}`;
const TURN_COLUMNS = `session_id, turn, input_sequence, output_sequence, model, state,
  ${timestamp("created_at")}`;
/** Same scope filter for every session read: the participant's own row of this world timeline. */
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
  constructor(
    private readonly client: PostgreSqlClient,
    private readonly artifacts: ArtifactStore,
    private readonly newSessionId: () => string = () => `conversation-${crypto.randomUUID()}`,
  ) {}

  async open(
    participant: ConversationParticipant,
    input: OpenConversation,
  ): Promise<ConversationSession> {
    const sessionId = this.newSessionId();
    const { tenantId, worldId, timelineId, spaceId } = input.scope;
    await this.transaction(participant, async () => {
      try {
        const inserted = await this.client.query(
          `INSERT INTO clockgrove.conversation_sessions (
             tenant_id, session_id, world_id, timeline_id, partition_id, space_id, principal_id,
             persona_id, actor_id, voice_mode
           ) SELECT tenant_id, $5, world_id, timeline_id, partition_id, space_id, $6, $7, $8, $9
               FROM clockgrove.timeline_partitions
              WHERE tenant_id = $1 AND world_id = $2 AND timeline_id = $3 AND space_id = $4
              LIMIT 1
           RETURNING session_id`,
          [
            tenantId,
            worldId,
            timelineId,
            spaceId,
            sessionId,
            participant.principalId,
            participant.personaId,
            input.actorId,
            input.voiceMode,
          ],
        );
        if (inserted.rows.length !== 1) throw new ConversationRefusedError("conversation_not_found");
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
          ORDER BY updated_at DESC, session_id`,
        [scope.tenantId, scope.worldId, scope.timelineId, actorId ?? null],
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
    await this.put(participant, stored, artifactId, title);
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
    const replyId = `${messageId}:reply`;
    const stored = await this.stored(participant, scope, sessionId);
    const retried = await this.retried(participant, stored, request);
    if (retried !== undefined) return retried;
    if (stored.row.state !== "active") throw new ConversationRefusedError("conversation_not_active");
    const count = Number(stored.row.message_count);
    if (count + 2 > 1000) throw new ConversationRefusedError("conversation_full");
    const sequence = count + 1;
    const before = await this.session(participant, stored.row);
    const reply = respond(before, (sequence + 1) / 2);
    // Artifacts are keyed by sequence, so a retry after a crash rewrites the same content; a lost
    // race leaves its two artifacts unreferenced and is refused as busy.
    const contentId = (at: number) => `${sessionId}:message:${at}`;
    await this.put(participant, stored, contentId(sequence), request.text);
    await this.put(participant, stored, contentId(sequence + 1), reply);
    await this.transaction(participant, async () => {
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
      if (used.rows.length > 0) return;
      if (Number(current.message_count) !== count)
        throw new ConversationRefusedError("conversation_busy");
      await this.client.query(
        `INSERT INTO clockgrove.conversation_messages (
           tenant_id, session_id, principal_id, sequence, message_id, role, author_id, voice_mode,
           content_artifact_id
         ) VALUES ($1, $2, $3, $4, $5, 'caretaker', $6, NULL, $7),
                  ($1, $2, $3, $4 + 1, $8, 'actor', $9, $10, $11)`,
        [
          scope.tenantId,
          sessionId,
          participant.principalId,
          sequence,
          messageId,
          participant.personaId,
          contentId(sequence),
          replyId,
          stored.row.actor_id,
          stored.row.voice_mode,
          contentId(sequence + 1),
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
    });
    const receipt = await this.retried(
      participant,
      await this.stored(participant, scope, sessionId),
      request,
    );
    if (receipt === undefined) throw new ConversationRefusedError("conversation_busy");
    return receipt;
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
    const voiceMode = row.voice_mode as VoiceMode;
    const titleId = row.title_artifact_id;
    const stored = {
      row,
      partitionId: decodeOpaqueId(row.partition_id, "PartitionId"),
      spaceId: decodeOpaqueId(row.space_id, "SpaceId"),
    };
    return decodeConversationSession({
      sessionId: row.session_id,
      scope: {
        tenantId: row.tenant_id,
        worldId: row.world_id,
        timelineId: row.timeline_id,
        spaceId: row.space_id,
      },
      actorId: row.actor_id,
      participant: { principalId: row.principal_id, personaId: row.persona_id },
      channel: "browser",
      privacyClass: "conversation",
      voiceMode,
      disclosure: VOICE_DISCLOSURES[voiceMode],
      title: typeof titleId === "string" ? await this.text(participant, stored, titleId) : "",
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
  ): Promise<void> {
    try {
      await this.artifacts.put(participant, {
        ...this.locator(stored, artifactId),
        bytes: encoder.encode(text),
        mediaType: TEXT_MEDIA_TYPE,
        privacyClass: "conversation",
        retentionClass: "durable",
      });
    } catch (error) {
      // Another request holds this sequence with other content: it won the race.
      if (error instanceof ArtifactConflictError)
        throw new ConversationRefusedError("conversation_busy");
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
