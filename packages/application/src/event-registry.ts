import { createEventTypeRegistry } from "@clockgrove/contracts";
import { compareUtf16 } from "@clockgrove/domain";
import { worldRegistryIdentity } from "@clockgrove/kernel";

export const WORLD_GENESIS_CREATED = "WorldGenesisCreated";
export const WORLD_SEED_COMMAND_APPLIED = "WorldSeedCommandApplied";
export const WORLD_PROJECTION_VERIFIED = "WorldProjectionVerified";
export const WORLD_READY = "WorldReady";
export const CLOCK_POLICY_CHANGED = "ClockPolicyChanged";
export const RUNTIME_NO_OP_ACCEPTED = "RuntimeNoOpAccepted";
export const DECISION_SHADOW_RECORDED = "DecisionShadowRecorded";

/**
 * Every event type the Wave 1 world kernel emits, in UTF-16 order. Each is journaled as its own
 * event type (the kernel event's own version stays inside the payload) with privacy `public_scene`.
 */
export const WORLD_KERNEL_EVENT_TYPES: readonly string[] = Object.freeze(
  [...new Set(worldRegistryIdentity().events.map(([type]) => type))].sort(compareUtf16),
);

/** Every event type this repository appends today, all at the current schema version. */
export const JOURNAL_EVENT_REGISTRY = createEventTypeRegistry(
  [
    WORLD_GENESIS_CREATED,
    WORLD_SEED_COMMAND_APPLIED,
    WORLD_PROJECTION_VERIFIED,
    WORLD_READY,
    RUNTIME_NO_OP_ACCEPTED,
    DECISION_SHADOW_RECORDED,
    "WakeTriageRecorded",
    "McpInstallationChanged",
    CLOCK_POLICY_CHANGED,
    ...WORLD_KERNEL_EVENT_TYPES,
  ].map((type) => ({ type, schemaVersion: 2 })),
);
