import type {
  ActorProcessId,
  PresenceId,
  SessionId,
  SpaceId,
  SubjectId,
  TenantId,
  TimelineId,
  WorldId,
} from "./ids.js";
import { decodeOpaqueId } from "./ids.js";
import { ContractDecodeError, exactKeys, freeze, literalVersion, record } from "./validation.js";

export interface ActorScope {
  readonly tenantId: TenantId;
  readonly worldId: WorldId;
  readonly timelineId: TimelineId;
}

export interface ActorAddressBase extends ActorScope {
  readonly version: 1;
}

export type ActorAddress = ActorAddressBase &
  (
    | { readonly kind: "world"; readonly id: WorldId }
    | { readonly kind: "space"; readonly id: SpaceId }
    | { readonly kind: "subject"; readonly id: SubjectId }
    | { readonly kind: "process"; readonly id: ActorProcessId }
    | { readonly kind: "session"; readonly id: SessionId }
    | { readonly kind: "presence"; readonly id: PresenceId }
  );

export type ActorTargetBinding = ActorScope &
  (
    | { readonly kind: "world"; readonly id: WorldId }
    | { readonly kind: "space"; readonly id: SpaceId }
    | { readonly kind: "subject"; readonly id: SubjectId }
    | { readonly kind: "process"; readonly id: ActorProcessId }
    | { readonly kind: "session"; readonly id: SessionId }
    | { readonly kind: "presence"; readonly id: PresenceId }
  );

const kinds = new Set(["world", "space", "subject", "process", "session", "presence"]);

export function decodeActorTargetBinding(
  value: unknown,
  path = "actorBinding",
): ActorTargetBinding {
  const input = record(value, path);
  exactKeys(input, ["tenantId", "worldId", "timelineId", "kind", "id"], [], path);
  if (typeof input.kind !== "string" || !kinds.has(input.kind)) {
    throw new ContractDecodeError(`${path}.kind`, "unknown actor kind");
  }
  const tenantId = decodeOpaqueId(input.tenantId, "TenantId", `${path}.tenantId`);
  const worldId = decodeOpaqueId(input.worldId, "WorldId", `${path}.worldId`);
  const timelineId = decodeOpaqueId(input.timelineId, "TimelineId", `${path}.timelineId`);
  const id = decodeOpaqueId(input.id, actorIdBrand(input.kind), `${path}.id`);
  if (input.kind === "world" && id !== worldId) {
    throw new ContractDecodeError(`${path}.id`, "world actor ID must equal world scope ID");
  }
  return freeze({ tenantId, worldId, timelineId, kind: input.kind, id }) as ActorTargetBinding;
}

export function constructActorAddress(binding: ActorTargetBinding): ActorAddress {
  const checked = decodeActorTargetBinding(binding);
  return freeze({ version: 1, ...checked }) as ActorAddress;
}

export function decodeActorAddress(
  value: unknown,
  binding: ActorTargetBinding,
  path = "actorAddress",
): ActorAddress {
  const checkedBinding = decodeActorTargetBinding(binding, "actorBinding");
  const input = record(value, path);
  exactKeys(input, ["version", "tenantId", "worldId", "timelineId", "kind", "id"], [], path);
  literalVersion(input.version, 1, `${path}.version`);
  const decodedBinding = decodeActorTargetBinding(
    {
      tenantId: input.tenantId,
      worldId: input.worldId,
      timelineId: input.timelineId,
      kind: input.kind,
      id: input.id,
    },
    path,
  );
  if (!sameActorBinding(decodedBinding, checkedBinding)) {
    throw new ContractDecodeError(path, "actor ID and tenant/world/timeline binding do not match");
  }
  return freeze({ version: 1, ...decodedBinding }) as ActorAddress;
}

function sameActorBinding(left: ActorTargetBinding, right: ActorTargetBinding): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.worldId === right.worldId &&
    left.timelineId === right.timelineId &&
    left.kind === right.kind &&
    left.id === right.id
  );
}

function actorIdBrand(kind: string): string {
  switch (kind) {
    case "world":
      return "WorldId";
    case "space":
      return "SpaceId";
    case "subject":
      return "SubjectId";
    case "process":
      return "ActorProcessId";
    case "session":
      return "SessionId";
    case "presence":
      return "PresenceId";
    default:
      throw new ContractDecodeError("actor.kind", "unknown actor kind");
  }
}
