import type { CapabilityValue } from "./capabilities.js";

/**
 * The typed capability registry (Wave 5 RW-0506). A capability is a named, schema-checked thing an
 * actor may propose; a grant is what one actor holds of the registry for one turn. A proposal is
 * intent only: it never executes here, and it can never exceed its grant. Contract:
 * `docs/protocols/capabilities.md`.
 */
export type CapabilityEffect =
  | "read"
  | "world_command"
  /** Writes only the actor's own attention or cognition: never the world or an external system. */
  | "actor-write"
  | "world-write"
  | "external-write"
  | "destructive"
  | "network"
  | "cost";

export interface CapabilityUseContext {
  readonly destination?: string;
  readonly estimatedCostMicrousd?: number;
  readonly spentMicrousd?: number;
}

export interface CapabilityDefinition {
  readonly name: string;
  readonly description: string;
  /** Canonical bounded schema metadata; never an instruction or execution authority. */
  readonly inputSchema?: unknown;
  readonly effect: CapabilityEffect;
  /** For remote tools, reviewed binding policy supplies authority instead of a default grant. */
  readonly remoteMcp?: {
    readonly installationId: string;
    readonly candidateId: string;
    readonly protocolVersion: string;
    readonly schemaHash: string;
  };
  /** The runtime grant for default internal admission; remote definitions have no default grant. */
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
  /** Trusted composition supplies this additional narrowing check for remote grants. */
  readonly check?: (
    input: CapabilityValue,
    context: CapabilityUseContext,
  ) => CapabilityRefusal | undefined;
  readonly active?: () => boolean;
}

export type CapabilityRefusal =
  | "unknown_capability"
  | "not_granted"
  | "revoked"
  | "budget_exhausted"
  | "command_type_not_granted"
  | "invalid_input"
  | "constraint_refused";

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

/** One grant per capability and one call each: An actor proposes at most one command a turn. */
const DEFAULT_GRANTS: readonly CapabilityGrant[] = [
  { capability: "inspect", callsPerTurn: 1 },
  { capability: "why", callsPerTurn: 1 },
  { capability: "world.command", callsPerTurn: 1, commandTypes: ["resource.offer"] },
  { capability: "subscription.create", callsPerTurn: 1 },
  { capability: "subscription.revoke", callsPerTurn: 1 },
  { capability: "intention.schedule", callsPerTurn: 1 },
  { capability: "intention.cancel", callsPerTurn: 1 },
  { capability: "perception.list", callsPerTurn: 1 },
  { capability: "self.inspect", callsPerTurn: 1 },
  { capability: "document.write", callsPerTurn: 1 },
];

/** The capabilities an actor uses on its own attention (issue 322); the actor owner executes them. */
export const SELF_CAPABILITIES: ReadonlySet<string> = new Set([
  "subscription.create",
  "subscription.revoke",
  "intention.schedule",
  "intention.cancel",
  "perception.list",
  "self.inspect",
  "document.write",
]);

/** Decision (issue 322): an actor holds at most 4 standing subscriptions and intentions of its own. */
export const MAX_ACTOR_ACTIVATIONS = 4;
/** Decision (issue 322): an intention is due at most 30 days after the turn that scheduled it. */
export const MAX_INTENTION_DELAY_SECONDS = 2_592_000;

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
    return this.grants
      .filter((grant) => !this.revoked.has(grant.capability) && (grant.active?.() ?? true))
      .map((grant) => grant.capability);
  }

  availableDefinitions(): readonly CapabilityDefinition[] {
    return this.available().flatMap((name) => {
      const definition = this.registry.get(name);
      return definition === undefined ? [] : [definition];
    });
  }

  /**
   * Decides one proposal against the grants and the calls already made this turn. The input is
   * checked by the capability's own schema only after the grant allows it, and a world command's
   * type must be one the grant names.
   */
  authorize(
    proposal: { readonly capability: string; readonly input: unknown },
    callsMade: ReadonlyMap<string, number> = new Map(),
    context: CapabilityUseContext = {},
  ): CapabilityDecision {
    const definition = this.registry.get(proposal.capability);
    if (definition === undefined) return { accepted: false, code: "unknown_capability" };
    const grant = this.grants.find((candidate) => candidate.capability === definition.name);
    if (grant === undefined) return { accepted: false, code: "not_granted" };
    if (this.revoked.has(definition.name) || !(grant.active?.() ?? true))
      return { accepted: false, code: "revoked" };
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
    const refusal = grant.check?.(input, context);
    if (refusal !== undefined) return { accepted: false, code: refusal };
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

function bytes(value: unknown, min: number, max: number): string {
  if (typeof value !== "string") throw new CapabilityInputError("text refused");
  const length = new TextEncoder().encode(value).length;
  if (length < min || length > max || (min > 0 && value.trim() === ""))
    throw new CapabilityInputError("text refused");
  return value;
}

const NO_INPUT = { type: "object", properties: {}, additionalProperties: false } as const;
function exact(properties: Record<string, unknown>): unknown {
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}
const WAKE_INPUT = { type: "string", minLength: 1, maxLength: 1024 } as const;

function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value))
    throw new CapabilityInputError("identifier refused");
  return value;
}

/** Internal definitions; delivery.request is admitted only by the proactive producer. */
export const INTERNAL_CAPABILITIES: readonly CapabilityDefinition[] = [
  {
    name: "delivery.request",
    description: "Request governed private delivery of an authorized proactive actor reply.",
    effect: "external-write",
    requiredRuntimeGrant: "runtime:world-command",
    parse: (input) => {
      const value = record(input, ["urgency", "quietHoursBehavior"]);
      if (
        typeof value.urgency !== "string" ||
        !["normal", "urgent"].includes(value.urgency) ||
        typeof value.quietHoursBehavior !== "string" ||
        !["delay", "silent", "reject"].includes(value.quietHoursBehavior)
      )
        throw new CapabilityInputError("delivery intent refused");
      return {
        urgency: value.urgency,
        quietHoursBehavior: value.quietHoursBehavior,
      };
    },
  },
  {
    name: "inspect",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
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
    inputSchema: {
      type: "object",
      properties: { commandId: { type: "string" } },
      required: ["commandId"],
      additionalProperties: false,
    },
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
  {
    name: "subscription.create",
    inputSchema: exact({ eventType: { type: "string" }, input: WAKE_INPUT }),
    description: "Follow one journal event type: each such event wakes the actor with the input.",
    effect: "actor-write",
    requiredRuntimeGrant: "runtime:world-command",
    parse: (input) => {
      const value = record(input, ["eventType", "input"]);
      return { eventType: bytes(value.eventType, 1, 256), input: bytes(value.input, 1, 1024) };
    },
  },
  {
    name: "subscription.revoke",
    inputSchema: exact({ subscriptionId: { type: "string" } }),
    description: "Stop following events through one of the actor's own subscriptions.",
    effect: "actor-write",
    requiredRuntimeGrant: "runtime:world-command",
    parse: (input) => ({
      subscriptionId: identifier(record(input, ["subscriptionId"]).subscriptionId),
    }),
  },
  {
    name: "intention.schedule",
    inputSchema: exact({
      delaySeconds: { type: "integer", minimum: 1, maximum: MAX_INTENTION_DELAY_SECONDS },
      input: WAKE_INPUT,
    }),
    description: "Wake once, delaySeconds after this turn, with the input.",
    effect: "actor-write",
    requiredRuntimeGrant: "runtime:world-command",
    parse: (input) => {
      const value = record(input, ["delaySeconds", "input"]);
      const delay = value.delaySeconds;
      if (
        typeof delay !== "number" ||
        !Number.isSafeInteger(delay) ||
        delay < 1 ||
        delay > MAX_INTENTION_DELAY_SECONDS
      )
        throw new CapabilityInputError("delay refused");
      return { delaySeconds: delay, input: bytes(value.input, 1, 1024) };
    },
  },
  {
    name: "intention.cancel",
    inputSchema: exact({ intentionId: { type: "string" } }),
    description: "Cancel one of the actor's own intentions before it fires.",
    effect: "actor-write",
    requiredRuntimeGrant: "runtime:world-command",
    parse: (input) => ({ intentionId: identifier(record(input, ["intentionId"]).intentionId) }),
  },
  {
    name: "perception.list",
    inputSchema: NO_INPUT,
    description: "List the entities and routes the actor currently perceives.",
    effect: "read",
    requiredRuntimeGrant: "runtime:world-observe",
    parse: (input) => {
      record(input, []);
      return {};
    },
  },
  {
    name: "self.inspect",
    inputSchema: NO_INPUT,
    description: "Read the actor's own goals, remaining budgets and run state.",
    effect: "read",
    requiredRuntimeGrant: "runtime:world-observe",
    parse: (input) => {
      record(input, []);
      return {};
    },
  },
  {
    name: "document.write",
    inputSchema: exact({ path: { type: "string" }, content: { type: "string" } }),
    description:
      "Write the whole content of one of the actor's own actor-writable documents; it commits with the turn.",
    effect: "actor-write",
    requiredRuntimeGrant: "runtime:world-command",
    parse: (input) => {
      const value = record(input, ["path", "content"]);
      return { path: bytes(value.path, 1, 256), content: bytes(value.content, 0, 65_536) };
    },
  },
];

export const CAPABILITY_REGISTRY = new CapabilityRegistry(INTERNAL_CAPABILITIES);
