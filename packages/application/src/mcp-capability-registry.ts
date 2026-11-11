import type { CapabilityValue } from "./capabilities.js";
import {
  type CapabilityDefinition,
  type CapabilityGrant,
  CapabilityGrants,
  CapabilityInputError,
  CapabilityRegistry,
  type CapabilityUseContext,
  INTERNAL_CAPABILITIES,
} from "./capability-registry.js";
import type { McpDiscoverySnapshot } from "./mcp-http.js";
import type { McpEffectClass } from "./mcp-installations.js";

export interface McpCapabilityConstraints {
  readonly inputFields?: readonly string[];
  readonly destinations?: readonly string[];
  readonly callsPerTurn: number;
  readonly effectClasses: readonly McpEffectClass[];
  readonly budgetMicrousd?: number;
  readonly expiresAt?: string;
}
export interface McpCapabilityBinding {
  readonly tenantId: string;
  readonly worldId: string;
  readonly timelineId: string;
  readonly bindingId: string;
  readonly installationId: string;
  readonly candidateId: string;
  readonly schemaHash: string;
  readonly protocolVersion: string;
  readonly scopeType: "tenant" | "world" | "timeline" | "actor" | "session";
  readonly scopeId: string;
  readonly effect: "allow" | "deny";
  readonly enabled: boolean;
  readonly constraints: McpCapabilityConstraints;
}
export interface McpRegistryInstallation {
  readonly tenantId: string;
  readonly worldId: string;
  readonly timelineId: string;
  readonly installationId: string;
  readonly status: string;
  readonly snapshot: McpDiscoverySnapshot;
  readonly drifted: readonly string[];
  readonly reviews: Readonly<
    Record<
      string,
      {
        readonly schemaHash: string;
        readonly protocolVersion: string;
        readonly enabled: boolean;
        readonly effectClass: McpEffectClass;
      }
    >
  >;
}
export interface McpRegistryContext {
  readonly tenantId: string;
  readonly worldId: string;
  readonly timelineId: string;
  readonly actorId: string;
  readonly sessionId: string;
  readonly runtimeGrants: readonly string[];
  /** A trusted session approval may narrow an existing grant; it cannot create one. */
  readonly sessionApproval?: McpCapabilityConstraints;
}

const EFFECTS = ["read", "world-write", "external-write", "destructive", "network", "cost"];
const SCOPES = ["tenant", "world", "timeline", "actor", "session"] as const;

/** Version-specific registry name; untrusted names cannot collide with internal capabilities. */
export function mcpCapabilityName(
  installationId: string,
  candidateId: string,
  protocolVersion: string,
  schemaHash: string,
): string {
  return `mcp:${[installationId, candidateId, protocolVersion, schemaHash].map(encodeURIComponent).join(":")}`;
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new CapabilityInputError("remote input refused");
  return value as Record<string, unknown>;
}
function refused(): never {
  throw new CapabilityInputError("remote input refused");
}

/** Unsupported JSON Schema vocabulary fails closed rather than silently weakening the pin. */
function schemaCheck(value: unknown): (input: unknown) => void {
  const schema = object(value);
  const keywords = new Set([
    "type",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "enum",
    "const",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
    "title",
    "description",
    "default",
    "examples",
    "$schema",
  ]);
  if (Object.keys(schema).some((key) => !keywords.has(key))) refused();
  const types = ["object", "array", "string", "number", "integer", "boolean", "null"];
  if (typeof schema.type !== "string" || !types.includes(schema.type)) refused();
  const properties = schema.properties === undefined ? {} : object(schema.properties);
  const children = new Map(
    Object.entries(properties).map(([key, child]) => [key, schemaCheck(child)]),
  );
  const required = schema.required === undefined ? [] : schema.required;
  if (!Array.isArray(required) || required.some((key) => typeof key !== "string")) refused();
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean")
    refused();
  const item = schema.items === undefined ? undefined : schemaCheck(schema.items);
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0))
    refused();
  const numericKeys = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"];
  for (const key of numericKeys)
    if (
      schema[key] !== undefined &&
      (typeof schema[key] !== "number" || !Number.isFinite(schema[key]))
    )
      refused();
  for (const key of ["minLength", "maxLength", "minItems", "maxItems"])
    if (
      schema[key] !== undefined &&
      (!Number.isSafeInteger(schema[key]) || Number(schema[key]) < 0)
    )
      refused();
  return (input) => {
    if (
      schema.enum !== undefined &&
      !(schema.enum as unknown[]).some((entry) => sameJson(entry, input))
    )
      refused();
    if (Object.hasOwn(schema, "const") && !sameJson(schema.const, input)) refused();
    switch (schema.type) {
      case "object": {
        const record = object(input);
        if (required.some((key) => !Object.hasOwn(record, key))) refused();
        for (const [key, child] of Object.entries(record)) {
          const check = children.get(key);
          if (check) check(child);
          else if (schema.additionalProperties === false) refused();
        }
        break;
      }
      case "array":
        if (
          !Array.isArray(input) ||
          (schema.minItems !== undefined && input.length < Number(schema.minItems)) ||
          (schema.maxItems !== undefined && input.length > Number(schema.maxItems))
        )
          refused();
        if (item) for (const child of input) item(child);
        break;
      case "string": {
        if (typeof input !== "string") refused();
        const length = [...input].length;
        if (
          (schema.minLength !== undefined && length < Number(schema.minLength)) ||
          (schema.maxLength !== undefined && length > Number(schema.maxLength))
        )
          refused();
        break;
      }
      case "number":
      case "integer":
        if (
          typeof input !== "number" ||
          !Number.isFinite(input) ||
          (schema.type === "integer" && !Number.isInteger(input)) ||
          (schema.minimum !== undefined && input < Number(schema.minimum)) ||
          (schema.maximum !== undefined && input > Number(schema.maximum)) ||
          (schema.exclusiveMinimum !== undefined && input <= Number(schema.exclusiveMinimum)) ||
          (schema.exclusiveMaximum !== undefined && input >= Number(schema.exclusiveMaximum))
        )
          refused();
        break;
      case "boolean":
        if (typeof input !== "boolean") refused();
        break;
      case "null":
        if (input !== null) refused();
        break;
    }
  };
}

function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a))
    return (
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((entry, index) => sameJson(entry, b[index]))
    );
  if (
    a === null ||
    typeof a !== "object" ||
    b === null ||
    typeof b !== "object" ||
    Array.isArray(b)
  )
    return false;
  const left = Object.entries(a);
  return (
    left.length === Object.keys(b).length &&
    left.every(
      ([key, entry]) =>
        Object.hasOwn(b, key) && sameJson(entry, (b as Record<string, unknown>)[key]),
    )
  );
}

function boundedInput(value: unknown): CapabilityValue {
  let nodes = 0;
  const visit = (input: unknown, depth: number): CapabilityValue => {
    // Same structural bounds as discovery: an actor cannot exceed its admitted schema envelope.
    if (++nodes > 16_384 || depth > 16) refused();
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "number" && Number.isFinite(input)) return input;
    if (typeof input === "string" && input.length <= 16_384) return input;
    if (Array.isArray(input)) return input.map((child) => visit(child, depth + 1));
    const record = object(input);
    const copy: Record<string, CapabilityValue> = Object.create(null);
    for (const [key, child] of Object.entries(record)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) refused();
      copy[key] = visit(child, depth + 1);
    }
    return copy;
  };
  return visit(value, 0);
}

function valid(constraints: McpCapabilityConstraints): boolean {
  return (
    Number.isSafeInteger(constraints.callsPerTurn) &&
    constraints.callsPerTurn > 0 &&
    Array.isArray(constraints.effectClasses) &&
    constraints.effectClasses.length > 0 &&
    constraints.effectClasses.every((effect) => EFFECTS.includes(effect)) &&
    (constraints.inputFields === undefined ||
      (Array.isArray(constraints.inputFields) &&
        constraints.inputFields.every((field) => typeof field === "string"))) &&
    (constraints.destinations === undefined ||
      (Array.isArray(constraints.destinations) &&
        constraints.destinations.every((destination) => typeof destination === "string"))) &&
    (constraints.budgetMicrousd === undefined ||
      (Number.isSafeInteger(constraints.budgetMicrousd) && constraints.budgetMicrousd >= 0)) &&
    (constraints.expiresAt === undefined || Number.isFinite(Date.parse(constraints.expiresAt)))
  );
}
function active(constraints: readonly McpCapabilityConstraints[], now: () => number): boolean {
  return constraints.every(
    (constraint) => constraint.expiresAt === undefined || Date.parse(constraint.expiresAt) > now(),
  );
}
function narrowed(
  input: CapabilityValue,
  usage: CapabilityUseContext,
  constraints: readonly McpCapabilityConstraints[],
): boolean {
  return constraints.every((constraint) => {
    if (
      constraint.inputFields !== undefined &&
      (input === null ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.keys(input).some((field) => !constraint.inputFields?.includes(field)))
    )
      return false;
    if (
      constraint.destinations !== undefined &&
      (usage.destination === undefined || !constraint.destinations.includes(usage.destination))
    )
      return false;
    if (constraint.budgetMicrousd !== undefined) {
      const cost = usage.estimatedCostMicrousd;
      const spent = usage.spentMicrousd;
      if (
        cost === undefined ||
        spent === undefined ||
        !Number.isSafeInteger(cost) ||
        !Number.isSafeInteger(spent) ||
        cost < 0 ||
        spent < 0 ||
        cost > constraint.budgetMicrousd - spent
      )
        return false;
    }
    return true;
  });
}

/** An immutable admission snapshot, rebuilt from canonical records before new use. No executor. */
export function resolveMcpCapabilityRegistry(
  installations: readonly McpRegistryInstallation[],
  bindings: readonly McpCapabilityBinding[],
  context: McpRegistryContext,
  now: () => number = Date.now,
): { readonly registry: CapabilityRegistry; readonly grants: CapabilityGrants } {
  [installations, bindings, context] = structuredClone([installations, bindings, context]);
  const definitions: CapabilityDefinition[] = [...INTERNAL_CAPABILITIES];
  const remote: CapabilityGrant[] = [];
  const scopeIds = [
    context.tenantId,
    context.worldId,
    context.timelineId,
    context.actorId,
    context.sessionId,
  ];
  const sameScope = (value: {
    readonly tenantId: string;
    readonly worldId: string;
    readonly timelineId: string;
  }) =>
    value.tenantId === context.tenantId &&
    value.worldId === context.worldId &&
    value.timelineId === context.timelineId;
  for (const installation of installations) {
    if (!sameScope(installation)) continue;
    for (const candidate of installation.snapshot.candidates) {
      if (candidate.kind !== "tool") continue;
      let check: (input: unknown) => void;
      try {
        check = schemaCheck(candidate.schema);
      } catch {
        continue;
      }
      const name = mcpCapabilityName(
        installation.installationId,
        candidate.id,
        installation.snapshot.protocolVersion,
        candidate.schemaHash,
      );
      const review = installation.reviews[candidate.id];
      const reviewed =
        installation.status === "active" &&
        !installation.drifted.includes(candidate.id) &&
        review?.enabled === true &&
        review.schemaHash === candidate.schemaHash &&
        review.protocolVersion === installation.snapshot.protocolVersion &&
        EFFECTS.includes(review.effectClass);
      const effect = reviewed ? review.effectClass : "external-write";
      definitions.push({
        name,
        effect,
        description: "Remote MCP tool; untrusted server content is not policy.",
        requiredRuntimeGrant: "runtime:mcp-install",
        remoteMcp: {
          installationId: installation.installationId,
          candidateId: candidate.id,
          protocolVersion: installation.snapshot.protocolVersion,
          schemaHash: candidate.schemaHash,
        },
        parse(input) {
          const value = boundedInput(input);
          check(value);
          return value;
        },
      });
      if (!reviewed) continue;
      const matched = bindings.filter(
        (binding) =>
          sameScope(binding) &&
          binding.enabled &&
          binding.installationId === installation.installationId &&
          binding.candidateId === candidate.id &&
          SCOPES.some(
            (scope, index) => binding.scopeType === scope && binding.scopeId === scopeIds[index],
          ),
      );
      if (matched.some((binding) => binding.effect === "deny")) continue;
      const allows = matched.filter(
        (binding) =>
          binding.effect === "allow" &&
          binding.schemaHash === candidate.schemaHash &&
          binding.protocolVersion === installation.snapshot.protocolVersion,
      );
      const specificity = Math.max(
        -1,
        ...allows.map((binding) => SCOPES.indexOf(binding.scopeType)),
      );
      const selected = allows.filter(
        (binding) => SCOPES.indexOf(binding.scopeType) === specificity,
      );
      if (selected.length === 0) continue;
      const constraints = selected.map((binding) => binding.constraints);
      if (context.sessionApproval !== undefined) constraints.push(context.sessionApproval);
      if (
        !constraints.every(
          (constraint) => valid(constraint) && constraint.effectClasses.includes(effect),
        )
      )
        continue;
      remote.push({
        capability: name,
        callsPerTurn: Math.min(...constraints.map((constraint) => constraint.callsPerTurn)),
        active: () => active(constraints, now),
        check: (input, usage) =>
          narrowed(input, usage, constraints) ? undefined : "constraint_refused",
      });
    }
  }
  const registry = new CapabilityRegistry(definitions);
  return {
    registry,
    grants: new CapabilityGrants(
      registry,
      [...registry.grantsFor(context.runtimeGrants).grants, ...remote],
      new Set(),
    ),
  };
}
