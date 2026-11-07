import { type ActorAddress, type ActorTargetBinding, decodeActorAddress } from "./actor-address.js";
import { uniqueIds } from "./execution-context.js";
import type {
  ActionId,
  AuthorityDecisionId,
  CausationId,
  CommandId,
  CorrelationId,
  EventId,
  GrantRef,
  PrincipalId,
  RoleId,
  TenantId,
  TimelineId,
  WorldId,
  WorldMembershipId,
  WorldPersonaId,
} from "./ids.js";
import { decodeOpaqueId } from "./ids.js";
import { decodePrivacyCeiling, type PrivacyCeiling } from "./privacy.js";
import type { CommandEnvelope } from "./protocol.js";
import { type AttributionIntent, decodeAttributionIntent, decodeExpected } from "./protocol.js";
import {
  array,
  ContractDecodeError,
  exactKeys,
  freeze,
  integer,
  literalVersion,
  optional,
  record,
  string,
} from "./validation.js";

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;

function isoTimestamp(value: unknown, path: string): string {
  const decoded = string(value, path);
  if (!ISO_TIMESTAMP.test(decoded) || Number.isNaN(Date.parse(decoded))) {
    throw new ContractDecodeError(path, "expected an ISO-8601 UTC timestamp");
  }
  return decoded;
}

function id<Name extends string>(
  input: Record<string, unknown>,
  key: string,
  name: Name,
  path: string,
) {
  return decodeOpaqueId(input[key], name, `${path}.${key}`);
}

function optionalId<Name extends string>(
  input: Record<string, unknown>,
  key: string,
  name: Name,
  path: string,
) {
  return optional(input, key, (item, itemPath) => decodeOpaqueId(item, name, itemPath), path);
}

type WithoutUndefined<T> = {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K];
} & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

function withDefined<T extends object>(fields: T): WithoutUndefined<T> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, item]) => item !== undefined),
  ) as WithoutUndefined<T>;
}

export interface AuthorityDecisionInputs {
  readonly principalId?: PrincipalId;
  readonly worldMembershipId?: WorldMembershipId;
  readonly personaId?: WorldPersonaId;
  readonly roles: readonly RoleId[];
  readonly grants: readonly GrantRef[];
  readonly privacyCeiling: PrivacyCeiling;
}

export interface AuthorityDecision {
  readonly version: 1;
  readonly authorityDecisionId: AuthorityDecisionId;
  readonly outcome: "allow" | "deny";
  readonly tenantId: TenantId;
  readonly worldId: WorldId;
  readonly timelineId: TimelineId;
  readonly commandId: CommandId;
  readonly actionId: ActionId;
  readonly attribution: AttributionIntent;
  readonly inputs: AuthorityDecisionInputs;
  readonly reasonCode?: string;
  readonly decidedAt: string;
}

function decodeDecisionInputs(value: unknown, path: string): AuthorityDecisionInputs {
  const input = record(value, path);
  exactKeys(
    input,
    ["roles", "grants", "privacyCeiling"],
    ["principalId", "worldMembershipId", "personaId"],
    path,
  );
  return freeze(
    withDefined({
      principalId: optionalId(input, "principalId", "PrincipalId", path),
      worldMembershipId: optionalId(input, "worldMembershipId", "WorldMembershipId", path),
      personaId: optionalId(input, "personaId", "WorldPersonaId", path),
      roles: uniqueIds(input.roles, "RoleId", `${path}.roles`),
      grants: uniqueIds(input.grants, "GrantRef", `${path}.grants`),
      privacyCeiling: decodePrivacyCeiling(input.privacyCeiling, `${path}.privacyCeiling`),
    }),
  );
}

export function decodeAuthorityDecision(
  value: unknown,
  path = "authorityDecision",
): AuthorityDecision {
  const input = record(value, path);
  exactKeys(
    input,
    [
      "version",
      "authorityDecisionId",
      "outcome",
      "tenantId",
      "worldId",
      "timelineId",
      "commandId",
      "actionId",
      "attribution",
      "inputs",
      "decidedAt",
    ],
    ["reasonCode"],
    path,
  );
  literalVersion(input.version, 1, `${path}.version`);
  const outcome = (["allow", "deny"] as const).find((candidate) => candidate === input.outcome);
  if (outcome === undefined)
    throw new ContractDecodeError(`${path}.outcome`, "expected allow or deny");
  const reasonCode = optional(input, "reasonCode", string, path);
  if (outcome === "deny" && reasonCode === undefined) {
    throw new ContractDecodeError(`${path}.reasonCode`, "required for deny");
  }
  if (outcome === "allow" && reasonCode !== undefined) {
    throw new ContractDecodeError(`${path}.reasonCode`, "forbidden for allow");
  }
  const actionId = id(input, "actionId", "ActionId", path);
  const attribution = decodeAttributionIntent(input.attribution, `${path}.attribution`);
  if (attribution.causalRootActionId !== actionId) {
    throw new ContractDecodeError(`${path}.actionId`, "must equal attribution.causalRootActionId");
  }
  return freeze(
    withDefined({
      version: 1 as const,
      authorityDecisionId: id(input, "authorityDecisionId", "AuthorityDecisionId", path),
      outcome,
      tenantId: id(input, "tenantId", "TenantId", path),
      worldId: id(input, "worldId", "WorldId", path),
      timelineId: id(input, "timelineId", "TimelineId", path),
      commandId: id(input, "commandId", "CommandId", path),
      actionId,
      attribution,
      inputs: decodeDecisionInputs(input.inputs, `${path}.inputs`),
      reasonCode,
      decidedAt: isoTimestamp(input.decidedAt, `${path}.decidedAt`),
    }),
  );
}

export const COMMAND_RECEIPT_STATUSES = ["pending", "committed", "rejected", "failed"] as const;
export type CommandReceiptStatus = (typeof COMMAND_RECEIPT_STATUSES)[number];
export type CommandReceiptProvenance = "attributed" | "legacy-wave0";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface CommandReceipt {
  readonly version: 1;
  readonly provenance: CommandReceiptProvenance;
  readonly tenantId: TenantId;
  readonly commandId: CommandId;
  readonly requestHash: string;
  readonly status: CommandReceiptStatus;
  readonly target: ActorAddress;
  readonly attribution?: AttributionIntent;
  readonly actionId?: ActionId;
  readonly correlationId: CorrelationId;
  readonly causationId?: CausationId;
  readonly expected: CommandEnvelope<string, unknown>["expected"];
  readonly authorityDecisionId?: AuthorityDecisionId;
  readonly committedEventIds: readonly EventId[];
  readonly result?: JsonValue;
  readonly createdAt: string;
  readonly committedAt?: string;
  readonly failedAt?: string;
}

/** Legal receipt transitions: pending moves to one terminal status; terminal statuses never change. */
export const COMMAND_RECEIPT_TRANSITIONS: Readonly<
  Record<CommandReceiptStatus, readonly CommandReceiptStatus[]>
> = freeze({
  pending: freeze(["committed", "rejected", "failed"] as const),
  committed: freeze([] as const),
  rejected: freeze([] as const),
  failed: freeze([] as const),
});

function jsonValue(value: unknown, path: string): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ContractDecodeError(path, "expected a finite number");
    return value;
  }
  if (Array.isArray(value)) return array(value, path, jsonValue);
  const input = record(value, path);
  return freeze(
    Object.fromEntries(
      Object.entries(input).map(([key, item]) => [key, jsonValue(item, `${path}.${key}`)]),
    ),
  );
}

function forbid(present: boolean, path: string, reason: string): void {
  if (present) throw new ContractDecodeError(path, reason);
}

function demand(present: boolean, path: string, reason: string): void {
  if (!present) throw new ContractDecodeError(path, reason);
}

export function decodeCommandReceipt(
  value: unknown,
  binding: ActorTargetBinding,
  path = "commandReceipt",
): CommandReceipt {
  const input = record(value, path);
  exactKeys(
    input,
    [
      "version",
      "provenance",
      "tenantId",
      "commandId",
      "requestHash",
      "status",
      "target",
      "correlationId",
      "expected",
      "committedEventIds",
      "createdAt",
    ],
    [
      "attribution",
      "actionId",
      "causationId",
      "authorityDecisionId",
      "result",
      "committedAt",
      "failedAt",
    ],
    path,
  );
  literalVersion(input.version, 1, `${path}.version`);
  const provenance = (["attributed", "legacy-wave0"] as const).find(
    (candidate) => candidate === input.provenance,
  );
  if (provenance === undefined)
    throw new ContractDecodeError(`${path}.provenance`, "unknown provenance");
  const status = COMMAND_RECEIPT_STATUSES.find((candidate) => candidate === input.status);
  if (status === undefined) throw new ContractDecodeError(`${path}.status`, "unknown status");

  const tenantId = id(input, "tenantId", "TenantId", path);
  const target = decodeActorAddress(input.target, binding, `${path}.target`);
  if (target.tenantId !== tenantId) {
    throw new ContractDecodeError(`${path}.tenantId`, "must equal target tenant");
  }
  const attribution = optional(input, "attribution", decodeAttributionIntent, path);
  const actionId = optionalId(input, "actionId", "ActionId", path);
  const authorityDecisionId = optionalId(input, "authorityDecisionId", "AuthorityDecisionId", path);
  if (provenance === "attributed") {
    demand(attribution !== undefined, `${path}.attribution`, "required for attributed receipts");
    demand(actionId !== undefined, `${path}.actionId`, "required for attributed receipts");
    if (attribution?.causalRootActionId !== actionId) {
      throw new ContractDecodeError(
        `${path}.actionId`,
        "must equal attribution.causalRootActionId",
      );
    }
    demand(
      (status === "pending") === (authorityDecisionId === undefined),
      `${path}.authorityDecisionId`,
      "required exactly when the receipt is not pending",
    );
  } else {
    forbid(attribution !== undefined, `${path}.attribution`, "forbidden for legacy-wave0 receipts");
    forbid(actionId !== undefined, `${path}.actionId`, "forbidden for legacy-wave0 receipts");
    forbid(
      authorityDecisionId !== undefined,
      `${path}.authorityDecisionId`,
      "forbidden for legacy-wave0 receipts",
    );
  }

  const committedEventIds = uniqueIds(
    input.committedEventIds,
    "EventId",
    `${path}.committedEventIds`,
  );
  forbid(
    status !== "committed" && committedEventIds.length > 0,
    `${path}.committedEventIds`,
    "must be empty unless committed",
  );
  const hasResult = "result" in input;
  const hasResultStatus = status === "committed" || status === "rejected";
  demand(
    hasResult === hasResultStatus,
    `${path}.result`,
    "present exactly for committed and rejected",
  );
  const committedAt = optional(input, "committedAt", isoTimestamp, path);
  const failedAt = optional(input, "failedAt", isoTimestamp, path);
  demand(
    (committedAt !== undefined) === hasResultStatus,
    `${path}.committedAt`,
    "present exactly for committed and rejected",
  );
  demand(
    (failedAt !== undefined) === (status === "failed"),
    `${path}.failedAt`,
    "present exactly for failed",
  );

  return freeze(
    withDefined({
      version: 1 as const,
      provenance,
      tenantId,
      commandId: id(input, "commandId", "CommandId", path),
      requestHash: string(input.requestHash, `${path}.requestHash`),
      status,
      target,
      attribution,
      actionId,
      correlationId: id(input, "correlationId", "CorrelationId", path),
      causationId: optionalId(input, "causationId", "CausationId", path),
      expected: decodeExpected(input.expected, `${path}.expected`),
      authorityDecisionId,
      committedEventIds,
      result: hasResult ? jsonValue(input.result, `${path}.result`) : undefined,
      createdAt: isoTimestamp(input.createdAt, `${path}.createdAt`),
      committedAt,
      failedAt,
    }),
  );
}

export interface EventTypeEntry {
  readonly type: string;
  readonly schemaVersion: number;
}

export interface EventTypeRegistry {
  readonly entries: readonly EventTypeEntry[];
}

export type EventTypeResolutionReason = "unknown-type" | "unknown-version";

export class EventTypeResolutionError extends ContractDecodeError {
  constructor(
    path: string,
    readonly reason: EventTypeResolutionReason,
  ) {
    super(
      path,
      reason === "unknown-type"
        ? "event type is not registered"
        : "schema version is not registered",
    );
    this.name = "EventTypeResolutionError";
  }
}

export function createEventTypeRegistry(entries: readonly EventTypeEntry[]): EventTypeRegistry {
  const seen = new Set<string>();
  const decoded = array(entries, "eventTypeRegistry", (item, path) => {
    const input = record(item, path);
    exactKeys(input, ["type", "schemaVersion"], [], path);
    const type = string(input.type, `${path}.type`);
    const schemaVersion = integer(input.schemaVersion, `${path}.schemaVersion`);
    if (schemaVersion < 1) {
      throw new ContractDecodeError(`${path}.schemaVersion`, "expected a positive integer");
    }
    const key = JSON.stringify([type, schemaVersion]);
    if (seen.has(key)) throw new ContractDecodeError(path, "duplicate event type entry");
    seen.add(key);
    return freeze({ type, schemaVersion });
  });
  return freeze({ entries: decoded });
}

export function resolveEventType(
  registry: EventTypeRegistry,
  type: string,
  schemaVersion: number,
): EventTypeEntry {
  const sameType = registry.entries.filter((entry) => entry.type === type);
  if (sameType.length === 0) throw new EventTypeResolutionError("eventType", "unknown-type");
  const entry = sameType.find((candidate) => candidate.schemaVersion === schemaVersion);
  if (entry === undefined) throw new EventTypeResolutionError("schemaVersion", "unknown-version");
  return entry;
}
