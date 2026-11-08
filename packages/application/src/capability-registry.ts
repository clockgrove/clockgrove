import type { CapabilityValue } from "./capabilities.js";

/**
 * The typed capability registry (Wave 5 RW-0506). A capability is a named, schema-checked thing an
 * actor may propose; a grant is what one actor holds of the registry for one turn. A proposal is
 * intent only: it never executes here, and it can never exceed its grant. Contract:
 * `docs/protocols/capabilities.md`.
 */
export type CapabilityEffect = "read" | "world_command";

export interface CapabilityDefinition {
  readonly name: string;
  readonly description: string;
  readonly effect: CapabilityEffect;
  /** The runtime grant the acting member must hold; an actor never holds more than its member. */
  readonly requiredRuntimeGrant: string;
  /** Checks and normalizes an input; throws `CapabilityInputError` for any other shape. */
  parse(input: unknown): CapabilityValue;
}

export class CapabilityInputError extends Error {}

/** What an actor holds of one capability: how many calls a turn, and for a world command, which types. */
export interface CapabilityGrant {
  readonly capability: string;
  readonly callsPerTurn: number;
  readonly commandTypes?: readonly string[];
}

export type CapabilityRefusal =
  | "unknown_capability"
  | "not_granted"
  | "revoked"
  | "budget_exhausted"
  | "command_type_not_granted"
  | "invalid_input";

export type CapabilityDecision =
  | Readonly<{ accepted: true; definition: CapabilityDefinition; input: CapabilityValue }>
  | Readonly<{ accepted: false; code: CapabilityRefusal }>;

export class CapabilityRegistry {
  private readonly definitions: ReadonlyMap<string, CapabilityDefinition>;
  constructor(definitions: readonly CapabilityDefinition[]) {
    this.definitions = new Map(definitions.map((definition) => [definition.name, definition]));
  }
  get(name: string): CapabilityDefinition | undefined {
    return this.definitions.get(name);
  }
  names(): readonly string[] {
    return [...this.definitions.keys()].sort();
  }

  /**
   * The grants a member's runtime grants allow an actor: one per registered capability whose
   * required grant the member holds, with the default budget. Nothing is granted by name alone.
   */
  grantsFor(runtimeGrants: readonly string[]): CapabilityGrants {
    const held = new Set(runtimeGrants);
    return new CapabilityGrants(
      this,
      DEFAULT_GRANTS.filter((grant) => {
        const definition = this.definitions.get(grant.capability);
        return definition !== undefined && held.has(definition.requiredRuntimeGrant);
      }),
      new Set(),
    );
  }
}

/** One grant per capability and one call each: Stevie proposes at most one command a turn. */
const DEFAULT_GRANTS: readonly CapabilityGrant[] = [
  { capability: "inspect", callsPerTurn: 1 },
  { capability: "why", callsPerTurn: 1 },
  { capability: "world.command", callsPerTurn: 1, commandTypes: ["resource.offer"] },
];

/** The grants one actor holds for a turn, with the capabilities revoked since. Immutable. */
export class CapabilityGrants {
  constructor(
    private readonly registry: CapabilityRegistry,
    readonly grants: readonly CapabilityGrant[],
    private readonly revoked: ReadonlySet<string>,
  ) {}

  revoke(capability: string): CapabilityGrants {
    return new CapabilityGrants(this.registry, this.grants, new Set([...this.revoked, capability]));
  }

  /** What the actor may be told it can propose: granted and not revoked. */
  available(): readonly string[] {
    return this.grants.map((grant) => grant.capability).filter((name) => !this.revoked.has(name));
  }

  /**
   * Decides one proposal against the grants and the calls already made this turn. The input is
   * checked by the capability's own schema only after the grant allows it, and a world command's
   * type must be one the grant names.
   */
  authorize(
    proposal: { readonly capability: string; readonly input: unknown },
    callsMade: ReadonlyMap<string, number> = new Map(),
  ): CapabilityDecision {
    const definition = this.registry.get(proposal.capability);
    if (definition === undefined) return { accepted: false, code: "unknown_capability" };
    const grant = this.grants.find((candidate) => candidate.capability === definition.name);
    if (grant === undefined) return { accepted: false, code: "not_granted" };
    if (this.revoked.has(definition.name)) return { accepted: false, code: "revoked" };
    if ((callsMade.get(definition.name) ?? 0) >= grant.callsPerTurn)
      return { accepted: false, code: "budget_exhausted" };
    let input: CapabilityValue;
    try {
      input = definition.parse(proposal.input);
    } catch (error) {
      if (error instanceof CapabilityInputError) return { accepted: false, code: "invalid_input" };
      throw error;
    }
    if (
      definition.effect === "world_command" &&
      !(grant.commandTypes ?? []).includes((input as { type: string }).type)
    )
      return { accepted: false, code: "command_type_not_granted" };
    return { accepted: true, definition, input };
  }
}

function record(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    Object.keys(input).sort().join(",") !== [...keys].sort().join(",")
  )
    throw new CapabilityInputError("input shape refused");
  return input as Record<string, unknown>;
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value))
    throw new CapabilityInputError("identifier refused");
  return value;
}

/** `inspect`, `why` and `world.command`, the internal capabilities of the first cognitive checkpoint. */
export const INTERNAL_CAPABILITIES: readonly CapabilityDefinition[] = [
  {
    name: "inspect",
    description: "Read the authorized scene around the actor.",
    effect: "read",
    requiredRuntimeGrant: "runtime:world-observe",
    parse: (input) => {
      record(input, []);
      return {};
    },
  },
  {
    name: "why",
    description: "Read the recorded explanation of one command.",
    effect: "read",
    requiredRuntimeGrant: "runtime:world-observe",
    parse: (input) => ({ commandId: identifier(record(input, ["commandId"]).commandId) }),
  },
  {
    name: "world.command",
    description: "Propose one typed world command; the ordinary validator decides it.",
    effect: "world_command",
    requiredRuntimeGrant: "runtime:world-command",
    parse: (input) => {
      const value = record(input, ["type", "objectId", "kind"]);
      return {
        type: identifier(value.type),
        objectId: identifier(value.objectId),
        kind: identifier(value.kind),
      };
    },
  },
];

export const CAPABILITY_REGISTRY = new CapabilityRegistry(INTERNAL_CAPABILITIES);
