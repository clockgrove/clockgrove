import { sql } from "drizzle-orm";
import {
  bigint,
  customType,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const clockgrove = pgSchema("clockgrove");
const bytea = customType<{ data: Uint8Array }>({ dataType: () => "bytea" });

export const tenants = clockgrove.table("tenants", {
  tenantId: text("tenant_id").primaryKey(),
  displayName: text("display_name").notNull(),
});

export const tenantPrincipals = clockgrove.table(
  "tenant_principals",
  {
    tenantId: text("tenant_id").notNull(),
    principalId: text("principal_id").notNull(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.principalId] })],
);

export const streams = clockgrove.table(
  "streams",
  {
    tenantId: text("tenant_id").notNull(),
    worldId: text("world_id").notNull(),
    timelineId: text("timeline_id").notNull(),
    partitionId: text("partition_id").notNull(),
    spaceId: text("space_id").notNull(),
    streamId: text("stream_id").notNull(),
    currentSequence: bigint("current_sequence", { mode: "bigint" }).notNull().default(0n),
    snapshotSequence: bigint("snapshot_sequence", { mode: "bigint" }).notNull().default(0n),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.timelineId, table.streamId] })],
);

export const events = clockgrove.table(
  "events",
  {
    eventId: text("event_id").notNull(),
    tenantId: text("tenant_id").notNull(),
    worldId: text("world_id").notNull(),
    timelineId: text("timeline_id").notNull(),
    partitionId: text("partition_id").notNull(),
    spaceId: text("space_id").notNull(),
    streamId: text("stream_id").notNull(),
    streamSequence: bigint("stream_sequence", { mode: "bigint" }).notNull(),
    partitionSequence: bigint("partition_sequence", { mode: "bigint" }).notNull(),
    journalPosition: bigint("journal_position", { mode: "bigint" }).notNull(),
    eventType: text("event_type").notNull(),
    commandId: text("command_id").notNull(),
    privacyClass: text("privacy_class").notNull(),
    payload: jsonb("payload").notNull(),
    actorAddress: jsonb("actor_address"),
    policyVersions: jsonb("policy_versions").notNull(),
    eventBytes: bytea("event_bytes").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.eventId] }),
    uniqueIndex("events_stream_sequence_key").on(
      table.tenantId,
      table.timelineId,
      table.streamId,
      table.streamSequence,
    ),
    uniqueIndex("events_partition_sequence_key").on(
      table.tenantId,
      table.timelineId,
      table.partitionId,
      table.partitionSequence,
    ),
    index("events_append_lookup_idx").on(
      table.tenantId,
      table.timelineId,
      table.partitionId,
      table.journalPosition,
    ),
    // One-row seek for the latest clock policy change of a partition (0020).
    index("events_clock_policy_idx")
      .on(table.tenantId, table.timelineId, table.partitionId, table.partitionSequence)
      .where(sql`${table.eventType} = 'ClockPolicyChanged'`),
  ],
);

export const commandReceipts = clockgrove.table(
  "command_receipts",
  {
    tenantId: text("tenant_id").notNull(),
    commandId: text("command_id").notNull(),
    requestHash: text("request_hash").notNull(),
    commandBytes: bytea("command_bytes").notNull(),
    targetAddress: jsonb("target_address").notNull(),
    status: text("status").notNull(),
    canonicalEventIds: text("canonical_event_ids").array().notNull().default([]),
    result: jsonb("result"),
    provenance: text("provenance").notNull(),
    attribution: jsonb("attribution"),
    actionId: text("action_id"),
    correlationId: text("correlation_id"),
    causationId: text("causation_id"),
    expected: jsonb("expected"),
    authorityDecisionId: text("authority_decision_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    committedAt: timestamp("committed_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.commandId] })],
);

export const authorityDecisions = clockgrove.table(
  "authority_decisions",
  {
    tenantId: text("tenant_id").notNull(),
    authorityDecisionId: text("authority_decision_id").notNull(),
    commandId: text("command_id").notNull(),
    outcome: text("outcome").notNull(),
    worldId: text("world_id").notNull(),
    timelineId: text("timeline_id").notNull(),
    actionId: text("action_id").notNull(),
    attribution: jsonb("attribution").notNull(),
    inputs: jsonb("inputs").notNull(),
    reasonCode: text("reason_code"),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.authorityDecisionId] }),
    uniqueIndex("authority_decisions_tenant_id_command_id_key").on(table.tenantId, table.commandId),
  ],
);

/** One hashed partition-state document per partition, at the kernel revision it holds. */
export const partitionStates = clockgrove.table(
  "partition_states",
  {
    tenantId: text("tenant_id").notNull(),
    worldId: text("world_id").notNull(),
    timelineId: text("timeline_id").notNull(),
    partitionId: text("partition_id").notNull(),
    spaceId: text("space_id").notNull(),
    revision: bigint("revision", { mode: "bigint" }).notNull(),
    coveredHeadSequence: bigint("covered_head_sequence", { mode: "bigint" }).notNull(),
    simulationTime: bigint("simulation_time", { mode: "bigint" }).notNull(),
    documentVersion: integer("document_version").notNull(),
    document: jsonb("document").notNull(),
    documentHash: text("document_hash").notNull(),
    stateHash: text("state_hash").notNull(),
    clockPolicy: jsonb("clock_policy"),
    clockOwnerGeneration: bigint("clock_owner_generation", { mode: "bigint" }).notNull(),
    clockOwnerId: text("clock_owner_id"),
    catchUpRunId: text("catch_up_run_id"),
    catchUpOwnerGeneration: bigint("catch_up_owner_generation", { mode: "bigint" }),
    catchUpPolicyVersion: bigint("catch_up_policy_version", { mode: "bigint" }),
    catchUpWallTime: bigint("catch_up_wall_time", { mode: "bigint" }),
    catchUpStep: bigint("catch_up_step", { mode: "bigint" }),
    catchUpReconcileAttemptedAt: timestamp("catch_up_reconcile_attempted_at", {
      withTimezone: true,
    }),
    clockAdmittedHorizon: bigint("clock_admitted_horizon", { mode: "bigint" }).notNull(),
    continuation: jsonb("continuation"),
    continuationHash: text("continuation_hash"),
    continuationCommandId: text("continuation_command_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.timelineId, table.partitionId] })],
);

/** One row per scheduled occurrence of a partition; `pending` rows are the kernel's queue (§7.3). */
export const partitionSchedules = clockgrove.table(
  "partition_schedules",
  {
    tenantId: text("tenant_id").notNull(),
    worldId: text("world_id").notNull(),
    timelineId: text("timeline_id").notNull(),
    partitionId: text("partition_id").notNull(),
    spaceId: text("space_id").notNull(),
    scheduleId: text("schedule_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    ownerPartitionId: text("owner_partition_id").notNull(),
    dueAt: bigint("due_at", { mode: "bigint" }).notNull(),
    priority: bigint("priority", { mode: "bigint" }).notNull(),
    tieBreakKey: text("tie_break_key").notNull(),
    kind: text("kind").notNull(),
    payloadVersion: integer("payload_version").notNull(),
    catchUpClass: text("catch_up_class").notNull(),
    supersedes: text("supersedes"),
    item: jsonb("item").notNull(),
    itemHash: text("item_hash").notNull(),
    status: text("status").notNull(),
    scheduledByCommandId: text("scheduled_by_command_id").notNull(),
    completedByCommandId: text("completed_by_command_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.tenantId,
        table.timelineId,
        table.partitionId,
        table.scheduleId,
        table.idempotencyKey,
      ],
    }),
  ],
);

export const eventDispatches = clockgrove.table(
  "event_dispatches",
  {
    tenantId: text("tenant_id").notNull(),
    dispatchId: text("dispatch_id").notNull(),
    eventId: text("event_id").notNull(),
    channel: text("channel").notNull(),
    status: text("status").notNull(),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    consumedPrincipalId: text("consumed_principal_id"),
    leaseOwner: text("lease_owner"),
    lastErrorClass: text("last_error_class"),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.dispatchId] }),
    index("event_dispatches_pending_idx").on(table.channel, table.status, table.nextAttemptAt),
  ],
);

const management = pgSchema("clockgrove_management");
export const principals = management.table("principals", {
  principalId: text("principal_id").primaryKey(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});
export const identityLinks = management.table(
  "identity_links",
  {
    environment: text("environment").notNull(),
    subject: text("subject").notNull(),
    externalIdentityId: text("external_identity_id").notNull().unique(),
    principalId: text("principal_id").notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [primaryKey({ columns: [table.environment, table.subject] })],
);
export const workspaceMemberships = management.table(
  "workspace_memberships",
  {
    tenantId: text("tenant_id").notNull(),
    principalId: text("principal_id").notNull(),
    membershipId: text("membership_id").notNull().unique(),
    roles: text("roles").array().notNull(),
    grants: text("grants").array().notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.principalId] })],
);
export const worldMemberships = clockgrove.table(
  "world_memberships",
  {
    tenantId: text("tenant_id").notNull(),
    worldId: text("world_id").notNull(),
    timelineId: text("timeline_id").notNull(),
    spaceId: text("space_id").notNull(),
    principalId: text("principal_id").notNull(),
    membershipId: text("membership_id").notNull(),
    personaId: text("persona_id").notNull(),
    roles: text("roles").array().notNull(),
    grants: text("grants").array().notNull(),
    privacyCeiling: jsonb("privacy_ceiling").notNull(),
    committedAt: timestamp("committed_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.worldId, table.timelineId, table.spaceId, table.principalId],
    }),
  ],
);

/** Per-activation admission receipts, retired once no replay can reach them. */
export const clockAdmissions = clockgrove.table(
  "clock_admissions",
  {
    tenantId: text("tenant_id").notNull(),
    timelineId: text("timeline_id").notNull(),
    partitionId: text("partition_id").notNull(),
    activationId: text("activation_id").notNull(),
    policyVersion: bigint("policy_version", { mode: "bigint" }).notNull(),
    horizon: bigint("horizon", { mode: "bigint" }).notNull(),
    admitted: bigint("admitted", { mode: "bigint" }).notNull(),
    ownerGeneration: bigint("owner_generation", { mode: "bigint" }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.timelineId, table.partitionId, table.activationId],
    }),
  ],
);
