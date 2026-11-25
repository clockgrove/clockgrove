import {
  InspectorRateLimitedError,
  type RuntimeAuthorizationContext,
} from "@clockgrove/application";
import type { ActorMuteView, BrowserScope } from "@clockgrove/contracts";
import { type PostgreSqlClient, withClientTransaction } from "./postgres-transaction.js";

/**
 * The mute names an actor with no conversation session in the world timeline, or a conversation
 * that is not one of the actor's.
 */
export class ActorMuteTargetNotFoundError extends Error {
  constructor() {
    super("conversation not found");
    this.name = "ActorMuteTargetNotFoundError";
  }
}

/** The caller holds no live `runtime:actor-govern` membership of the world's space. */
export class ActorMuteRefusedError extends Error {
  constructor() {
    super("actor mute refused");
    this.name = "ActorMuteRefusedError";
  }
}

/**
 * The refusal code of a start of a muted actor or conversation: a turn answers it as
 * `409 conversation_muted`, a delivery and an effect record it as their reason.
 */
export const ACTOR_MUTED = "actor_muted";

/**
 * Whether the actor, or its conversation `sessionId`, is muted (0078). Runs in the caller's open
 * transaction, so a mute committed before it is always seen; it calls no model and reads one row.
 */
export async function actorMuted(
  client: PostgreSqlClient,
  scope: { readonly tenantId: string; readonly worldId: string; readonly timelineId: string },
  actorId: string,
  sessionId: string | null,
): Promise<boolean> {
  const result = await client.query("SELECT clockgrove.actor_muted($1,$2,$3,$4,$5) AS muted", [
    scope.tenantId,
    scope.worldId,
    scope.timelineId,
    actorId,
    sessionId ?? "",
  ]);
  return (result.rows[0] as { muted?: boolean } | undefined)?.muted === true;
}

/**
 * Operator mutes (issue 374, G8), written only through `clockgrove.set_actor_mute`, which appends
 * each change to `actor_mute_changes` and admits at most 300 changes per principal an hour (0078),
 * apart from the inspector's budget.
 */
export class PostgreSqlActorMutes {
  constructor(private readonly client: PostgreSqlClient) {}

  async set(
    authorization: RuntimeAuthorizationContext,
    scope: BrowserScope,
    actorId: string,
    sessionId: string | null,
    muted: boolean,
  ): Promise<ActorMuteView> {
    try {
      return await withClientTransaction(this.client, { authorization }, async () => {
        const result = await this.client.query(
          `SELECT session_id, muted, version, principal_id, changed_at
             FROM clockgrove.set_actor_mute($1,$2,$3,$4,$5,$6)`,
          [scope.worldId, scope.timelineId, scope.spaceId, actorId, sessionId ?? "", muted],
        );
        const row = result.rows[0] as {
          session_id: string;
          muted: boolean;
          version: number;
          principal_id: string;
          changed_at: Date | string;
        };
        return {
          actorId,
          sessionId: row.session_id === "" ? null : row.session_id,
          muted: row.muted,
          version: Number(row.version),
          changedBy: row.principal_id,
          changedAt: new Date(row.changed_at).toISOString(),
        };
      });
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === "P0002") throw new ActorMuteTargetNotFoundError();
      if (code === "42501") throw new ActorMuteRefusedError();
      if (code === "CG013") throw new InspectorRateLimitedError();
      throw error;
    }
  }
}
