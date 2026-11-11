import {
  type DeliveryTarget,
  type GovernedDeliveryPort,
  validateDeliveryConsent,
} from "@clockgrove/application";
import {
  ContractDecodeError,
  type DeliveryConsent,
  decodeBrowserScope,
} from "@clockgrove/contracts";

export type DeliveryStores = <T>(
  operation: (store: GovernedDeliveryPort) => Promise<T>,
) => Promise<T>;

function record(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new ContractDecodeError("delivery", "expected object");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== names.length || names.some((name) => !Object.hasOwn(row, name)))
    throw new ContractDecodeError("delivery", "unexpected fields");
  return row;
}

function id(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    new TextEncoder().encode(value).length > 1024
  )
    throw new ContractDecodeError("delivery", "invalid identifier");
  return value;
}

export function deliveryConsentCall(value: unknown): {
  readonly target: DeliveryTarget;
  readonly consent: Omit<DeliveryConsent, "version" | "reservedUnits">;
} {
  const body = record(value, [
    "version",
    "tenantId",
    "worldId",
    "timelineId",
    "spaceId",
    "actorId",
    "sessionId",
    "consent",
  ]);
  if (body.version !== 1) throw new ContractDecodeError("delivery.version", "expected 1");
  const { tenantId, worldId, timelineId, spaceId } = body;
  const scope = decodeBrowserScope({ tenantId, worldId, timelineId, spaceId });
  const consent = record(body.consent, ["enabled", "timezone", "quietHours", "budgetLimit"]);
  if (consent.quietHours !== null) record(consent.quietHours, ["startMinute", "endMinute"]);
  const input = consent as unknown as Omit<DeliveryConsent, "version" | "reservedUnits">;
  validateDeliveryConsent(input);
  return {
    target: { scope, actorId: id(body.actorId), sessionId: id(body.sessionId) },
    consent: input,
  };
}
