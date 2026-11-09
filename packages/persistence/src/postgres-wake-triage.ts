import {
  type ConversationParticipant,
  type TurnFiber,
  type WakeTriageObservation,
  type WakeTriagePolicy,
  type WakeTriageRecord,
  wakeTriageReport,
} from "@clockgrove/application";
import type { BrowserScope } from "@clockgrove/contracts";
import { type PostgreSqlClient, withClientTransaction } from "./postgres-transaction.js";

type Row = Record<string, unknown>;
export interface WakeTriageReservation {
  readonly existing: boolean;
  readonly record?: WakeTriageRecord | null;
  readonly reserved?: boolean;
  readonly simulationTime?: string;
  readonly reason?: string;
  readonly partitionId?: string;
  readonly streamId?: string;
}
export class PostgreSqlWakeTriage {
  constructor(private readonly client: PostgreSqlClient) {}
  reserve(
    participant: ConversationParticipant,
    fiber: TurnFiber,
    policy: WakeTriagePolicy,
    dayLengthMs: bigint,
  ): Promise<WakeTriageReservation> {
    return withClientTransaction(this.client, { authorization: participant }, async () => {
      const result = await this.client.query(
        "SELECT clockgrove.reserve_wake_triage($1,$2,$3,$4,$5,$6) AS reservation",
        [
          fiber.scope.tenantId,
          fiber.sessionId,
          fiber.messageId,
          policy.maxCostMicrousd,
          policy.dailyBudgetMicrousd,
          dayLengthMs.toString(),
        ],
      );
      return (result.rows[0] as Row).reservation as WakeTriageReservation;
    });
  }
  finish(
    participant: ConversationParticipant,
    fiber: TurnFiber,
    record: WakeTriageRecord,
  ): Promise<void> {
    return withClientTransaction(this.client, { authorization: participant }, async () => {
      await this.client.query("SELECT clockgrove.finish_wake_triage($1,$2,$3,$4::jsonb)", [
        fiber.scope.tenantId,
        fiber.sessionId,
        fiber.messageId,
        JSON.stringify(record),
      ]);
    });
  }
  report(participant: ConversationParticipant, scope: BrowserScope) {
    return withClientTransaction(this.client, { authorization: participant }, async () => {
      const result = await this.client.query(
        `SELECT clockgrove.read_wake_triage_report($1,$2,$3,$4) AS observation`,
        [scope.tenantId, scope.worldId, scope.timelineId, scope.spaceId],
      );
      const rows = result.rows.map((row) => (row as Row).observation as Row);
      const observations: WakeTriageObservation[] = rows.flatMap((row) => {
        if (row.record === null) return [];
        const decision = row.record as WakeTriageRecord;
        const proposedCommand = row.proposedCommand === true;
        const outputMessage = row.outputMessage === true;
        const replyToPerson = outputMessage && decision.reason === "direct_message";
        return [
          {
            decision,
            truth: {
              disposition: String(row.phase),
              proposedCommand,
              outputMessage,
              replyToPerson,
              material: proposedCommand || replyToPerson,
              costMicrousd: row.costMicrousd === null ? null : Number(row.costMicrousd),
            },
          },
        ];
      });
      return {
        ...wakeTriageReport(observations),
        interrupted: rows.filter((row) => row.record === null).length,
      };
    });
  }
}
