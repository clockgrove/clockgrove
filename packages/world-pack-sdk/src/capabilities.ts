import type { WorldPackIssue } from "./errors.js";
import type { CapabilityKind, DefinitionRef, ValidatedWorldPack } from "./manifest/types.js";

/** A command submitted through one actor's capability binding (`capability` is the bound id and version). */
export interface CapabilityCommandRequest {
  readonly actorId: string;
  readonly capability: DefinitionRef;
  readonly type: string;
  readonly version: number;
}

/** The binding an accepted command went through. */
export interface CapabilityGrant {
  readonly actorId: string;
  readonly id: string;
  readonly version: number;
  readonly kind: CapabilityKind;
}

export type CapabilityCommandResult =
  | { readonly ok: true; readonly value: CapabilityGrant }
  | { readonly ok: false; readonly error: WorldPackIssue };

const refusal = (code: string, path: string, message: string): CapabilityCommandResult => ({
  ok: false,
  error: Object.freeze({ code, path, message }),
});

/**
 * Pure: accepts a command submitted through a capability binding only when the pack's actor holds that
 * binding and the bound capability declares the command type and version. Refusal paths name the
 * request field: `capability` (`CAPABILITY_NOT_HELD`) or `type` (`CAPABILITY_COMMAND_UNDECLARED`).
 */
export function checkCapabilityCommand(
  pack: ValidatedWorldPack,
  request: CapabilityCommandRequest,
): CapabilityCommandResult {
  const { actorId, capability, type, version } = request;
  const same = (ref: DefinitionRef) =>
    ref.id === capability.id && ref.version === capability.version;
  const binding = `${capability.id}@${capability.version}`;
  const held = pack.definitions.actors.some(
    (actor) => actor.id === actorId && actor.capabilities.some(same),
  );
  const declared = held ? pack.capabilities.find(same) : undefined;
  if (declared === undefined)
    return refusal(
      "CAPABILITY_NOT_HELD",
      "capability",
      `actor ${actorId} holds no capability binding ${binding}`,
    );
  if (!declared.commands.some((command) => command.type === type && command.version === version))
    return refusal(
      "CAPABILITY_COMMAND_UNDECLARED",
      "type",
      `capability ${binding} does not declare ${type} version ${version}`,
    );
  return {
    ok: true,
    value: Object.freeze({
      actorId,
      id: declared.id,
      version: declared.version,
      kind: declared.kind,
    }),
  };
}
