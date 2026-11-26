import type { WorldModeState } from "@clockgrove/contracts";
import type { PostgreSqlClient } from "./postgres-transaction.js";

/**
 * A space's mode (0085, `docs/protocols/usage.md`, "World modes"): `active` with no reason when the
 * developer's server never set one. Runs in the caller's connection, or its open transaction, so a
 * mode committed before it is seen; it reads one row.
 */
export async function worldMode(
  client: PostgreSqlClient,
  scope: {
    readonly tenantId: string;
    readonly worldId: string;
    readonly timelineId: string;
    readonly spaceId: string;
  },
): Promise<WorldModeState> {
  const result = await client.query("SELECT * FROM clockgrove.world_mode($1,$2,$3,$4)", [
    scope.tenantId,
    scope.worldId,
    scope.timelineId,
    scope.spaceId,
  ]);
  const row = result.rows[0] as { mode?: string; reason?: string | null } | undefined;
  return {
    mode: (row?.mode ?? "active") as WorldModeState["mode"],
    reason: row?.reason ?? null,
  };
}

/** A world command, Influence or new turn refused by the space's mode (`read_only` or `paused`). */
export class WorldModeRefusedError extends Error {
  constructor(readonly state: WorldModeState) {
    super(`world mode refused: ${state.mode}`);
    this.name = "WorldModeRefusedError";
  }
}

/** Whether the mode takes no world command and starts no turn. */
export function worldModeRefusesActions(state: WorldModeState): boolean {
  return state.mode === "read_only" || state.mode === "paused";
}
