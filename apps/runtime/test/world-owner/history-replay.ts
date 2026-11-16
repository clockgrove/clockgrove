import {
  JOURNAL_EVENT_REGISTRY,
  JournalRangeReader,
  type RuntimeAuthorizationContext,
  verifyPartitionReplay,
  type WorldPartitionScope,
} from "@clockgrove/application";
import { decodeOpaqueId, decodePrivacyCeiling, PRIVACY_CATEGORIES } from "@clockgrove/contracts";
import {
  PostgreSqlArtifactStore,
  PostgreSqlJournalRangeSource,
  PostgreSqlSnapshotStore,
  PostgreSqlWorldProvisioningStore,
} from "@clockgrove/persistence";
import { decodeResource } from "@clockgrove/world-pack-sdk";
import { expect } from "vitest";
import type { NativeWorldOwner } from "./native-harness.js";

/** Every row an external effect or a delivery leaves, counted per table. */
const LEDGER = `SELECT ${[
  "effect_intents",
  "effect_attempts",
  "deliveries",
  "delivery_sink_receipts",
  "event_dispatches",
]
  .map((table) => `(SELECT count(*) FROM clockgrove.${table})`)
  .join(" || '/' || ")}`;

/**
 * Replays the owner's world history, every partition from its stored birth through its live head,
 * and proves the replay reproduces the live state and leaves no external trace: the effect ledger,
 * deliveries, sink receipts and dispatches are unchanged, and so is `external()`, the count an
 * outside fixture server keeps of the calls it received. Wave 5 §20, "Preview/replay cannot produce
 * live external delivery" (issue 169).
 */
export async function expectHistoryReplayInert(
  owner: Pick<NativeWorldOwner, "scope" | "sql" | "withSqlClient">,
  external: () => Promise<number> = async () => 0,
): Promise<{ partitions: number; eventsApplied: number; ledger: string }> {
  const { tenantId, worldId, timelineId } = owner.scope;
  const partitions = (
    await owner.sql(
      `SELECT partition_id FROM clockgrove.partition_states WHERE tenant_id='${tenantId}' AND world_id='${worldId}' AND timeline_id='${timelineId}' ORDER BY partition_id`,
    )
  )
    .split("\n")
    .filter(Boolean);
  expect(partitions.length).toBeGreaterThan(0);
  const principal = await owner.sql(
    `SELECT principal_id FROM clockgrove.world_memberships WHERE tenant_id='${tenantId}' AND world_id='${worldId}' AND revoked_at IS NULL ORDER BY principal_id LIMIT 1`,
  );
  // The replay's ceiling covers every class in the partition: a hidden row is a sequence gap.
  const authorization: RuntimeAuthorizationContext = {
    tenantId: decodeOpaqueId(tenantId, "TenantId"),
    principalId: decodeOpaqueId(principal, "PrincipalId"),
    privacyCeiling: decodePrivacyCeiling({
      version: 1,
      allowedCategories: [...PRIVACY_CATEGORIES],
    }),
  };
  const ledger = await owner.sql(LEDGER);
  const calls = await external();
  let eventsApplied = 0;
  for (const partitionId of partitions) {
    const scope: WorldPartitionScope = {
      tenantId: authorization.tenantId,
      worldId: decodeOpaqueId(worldId, "WorldId"),
      timelineId: decodeOpaqueId(timelineId, "TimelineId"),
      partitionId: decodeOpaqueId(partitionId, "PartitionId"),
    };
    const verification = await owner.withSqlClient((client) =>
      verifyPartitionReplay(authorization, scope, "exact", {
        snapshots: new PostgreSqlSnapshotStore(client),
        artifacts: new PostgreSqlArtifactStore(client),
        events: new JournalRangeReader(
          new PostgreSqlJournalRangeSource(client, authorization),
          JOURNAL_EVENT_REGISTRY,
        ),
        birth: new PostgreSqlWorldProvisioningStore(client),
        decodeResource,
      }),
    );
    expect(verification.mismatches).toEqual([]);
    eventsApplied += verification.full.eventsApplied;
  }
  // Exactly zero new effect attempts, deliveries, sink receipts, dispatches or outside calls.
  expect(await owner.sql(LEDGER)).toBe(ledger);
  expect(await external()).toBe(calls);
  return { partitions: partitions.length, eventsApplied, ledger };
}
