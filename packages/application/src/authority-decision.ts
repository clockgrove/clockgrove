import type {
  AttributionIntent,
  AuthorityDecisionId,
  AuthorityDecisionInputs,
  CommandId,
  PrivacyCeiling,
  TenantId,
  TimelineId,
  WorldId,
} from "@clockgrove/contracts";
import { decodeOpaqueId } from "@clockgrove/contracts";

import type { JournalAuthorityDecision } from "./journal.js";

/**
 * The command's AuthorityDecisionId. Trusted code derives it from the command identity, so a retry
 * derives the same ID, it is unique per (tenant, command), and client input never chooses it.
 */
export function mintAuthorityDecisionId(commandId: CommandId): AuthorityDecisionId {
  return decodeOpaqueId(`authority:${commandId}`, "AuthorityDecisionId");
}

/**
 * Command and event IDs that start with this prefix are minted only by trusted application code
 * (world provisioning stages). Client-supplied IDs in this namespace are refused, so a client can
 * never take over a trusted command's receipt key or event ID.
 */
export const TRUSTED_ID_PREFIX = "trusted:";

export function isTrustedId(id: string): boolean {
  return id.startsWith(TRUSTED_ID_PREFIX);
}

/** The journal command ID of one world-provisioning stage. */
export function worldProvisioningCommandId(stageId: string): CommandId {
  return decodeOpaqueId(`${TRUSTED_ID_PREFIX}world-provisioning:${stageId}`, "CommandId");
}

/** A privacy ceiling that admits no category, for decisions made without resolved world authority. */
export const NO_PRIVACY_CEILING: PrivacyCeiling = Object.freeze({
  version: 1,
  allowedCategories: Object.freeze([]),
}) as PrivacyCeiling;

export interface AuthorityDecisionScope {
  readonly tenantId: TenantId;
  readonly worldId: WorldId;
  readonly timelineId: TimelineId;
  readonly commandId: CommandId;
  readonly attribution: AttributionIntent;
  readonly inputs: AuthorityDecisionInputs;
}

export function allowDecision(scope: AuthorityDecisionScope): JournalAuthorityDecision {
  return decision(scope, "allow");
}

export function denyDecision(
  scope: AuthorityDecisionScope,
  reasonCode: string,
): JournalAuthorityDecision {
  return { ...decision(scope, "deny"), reasonCode };
}

function decision(
  scope: AuthorityDecisionScope,
  outcome: "allow" | "deny",
): JournalAuthorityDecision {
  return {
    version: 1,
    authorityDecisionId: mintAuthorityDecisionId(scope.commandId),
    outcome,
    tenantId: scope.tenantId,
    worldId: scope.worldId,
    timelineId: scope.timelineId,
    commandId: scope.commandId,
    actionId: scope.attribution.causalRootActionId,
    attribution: scope.attribution,
    inputs: scope.inputs,
  };
}
