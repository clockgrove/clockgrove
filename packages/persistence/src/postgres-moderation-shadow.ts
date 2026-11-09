import {
  type ConversationParticipant,
  type ModerationShadowObservation,
  type ModerationShadowRecord,
  moderationShadowReport,
  type TurnFiber,
} from "@clockgrove/application";
import type { BrowserScope } from "@clockgrove/contracts";
import { type PostgreSqlClient, withClientTransaction } from "./postgres-transaction.js";

export interface ModerationShadowReservation {
  readonly existing: boolean;
  readonly record: ModerationShadowRecord | null;
  readonly simulationTime: string;
  readonly partitionId: string;
  readonly streamId: string;
}
export class PostgreSqlModerationShadow {
  constructor(private readonly client: PostgreSqlClient) {}
  reserve(
    participant: ConversationParticipant,
    fiber: TurnFiber,
  ): Promise<ModerationShadowReservation> {
    return withClientTransaction(this.client, { authorization: participant }, async () => {
      const result = await this.client.query(
        "SELECT clockgrove.reserve_moderation_shadow($1,$2,$3) AS reservation",
        [fiber.scope.tenantId, fiber.sessionId, fiber.messageId],
      );
      return (result.rows[0] as { reservation: ModerationShadowReservation }).reservation;
    });
  }
  finish(
    participant: ConversationParticipant,
    fiber: TurnFiber,
    record: ModerationShadowRecord,
  ): Promise<ModerationShadowRecord> {
    return withClientTransaction(this.client, { authorization: participant }, async () => {
      const result = await this.client.query(
        "SELECT clockgrove.finish_moderation_shadow($1,$2,$3,$4::jsonb) AS record",
        [fiber.scope.tenantId, fiber.sessionId, fiber.messageId, JSON.stringify(record)],
      );
      return (result.rows[0] as { record: ModerationShadowRecord }).record;
    });
  }
  report(participant: ConversationParticipant, scope: BrowserScope, actorId: string) {
    return withClientTransaction(this.client, { authorization: participant }, async () => {
      const result = await this.client.query(
        `SELECT msg.session_id, msg.message_id, q.record
        FROM (
          SELECT tenant_id,session_id,message_id,created_at FROM clockgrove.conversation_turn_fibers
          UNION ALL
          SELECT old.tenant_id,old.session_id,old.message_id,old.created_at
            FROM clockgrove.conversation_messages old
            WHERE old.role='caretaker' AND NOT EXISTS (
              SELECT 1 FROM clockgrove.conversation_turn_fibers f
                WHERE f.tenant_id=old.tenant_id AND f.session_id=old.session_id AND f.message_id=old.message_id)
        ) msg
        JOIN clockgrove.conversation_sessions sess ON sess.tenant_id=msg.tenant_id AND sess.session_id=msg.session_id
        LEFT JOIN clockgrove.moderation_shadow q ON q.tenant_id=msg.tenant_id AND q.session_id=msg.session_id AND q.message_id=msg.message_id
        WHERE sess.tenant_id=$1 AND sess.world_id=$2 AND sess.timeline_id=$3 AND sess.space_id=$4 AND sess.actor_id=$5
          AND sess.state<>'deleted' AND NOT starts_with(msg.message_id,'activation:')
        ORDER BY msg.created_at,msg.session_id,msg.message_id`,
        [scope.tenantId, scope.worldId, scope.timelineId, scope.spaceId, actorId],
      );
      const observations: ModerationShadowObservation[] = result.rows.map((value) => {
        const row = value as {
          session_id: string;
          message_id: string;
          record: ModerationShadowRecord | null;
        };
        return { sessionId: row.session_id, messageId: row.message_id, record: row.record };
      });
      return moderationShadowReport(observations);
    });
  }
}
