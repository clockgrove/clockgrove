import { DomainValidationError } from "../actor-process.js";
import { isPlainRecord } from "../spatial/parse.js";

export const RULE_SCHEMA_VERSION = 1 as const;

export const RULE_MAX_NODES = 256;
export const RULE_MAX_DEPTH = 16;
export const RULE_MAX_BINDINGS = 32;

export const THRESHOLD_QUANTITIES = ["needs.hunger", "needs.wetness", "resource.quantity"] as const;
export type ThresholdQuantity = (typeof THRESHOLD_QUANTITIES)[number];

export type RuleType = "integer" | "string" | "boolean";

export type RuleExpression =
  | Readonly<{ op: "literal"; type: "integer"; value: bigint }>
  | Readonly<{ op: "literal"; type: "string"; value: string }>
  | Readonly<{ op: "literal"; type: "boolean"; value: boolean }>
  | Readonly<{ op: "variable"; name: string }>
  | Readonly<{ op: "field"; name: string; type: RuleType }>
  | Readonly<{
      op: "add" | "sub" | "min" | "max" | "eq" | "ne" | "lt" | "le" | "gt" | "ge" | "and" | "or";
      left: RuleExpression;
      right: RuleExpression;
    }>
  | Readonly<{ op: "not"; operand: RuleExpression }>;

export type RuleTrigger =
  | Readonly<{ kind: "event"; eventType: string; eventVersion: number }>
  | Readonly<{ kind: "schedule"; everyMs: bigint; offsetMs: bigint }>
  | Readonly<{
      kind: "threshold";
      objectId: string | null;
      quantity: ThresholdQuantity;
      direction: "rising" | "falling";
      value: bigint;
    }>
  | Readonly<{
      kind: "geofence";
      regionId: string;
      transition: "entered" | "left";
      objectId: string | null;
    }>;

export interface RuleBinding {
  readonly name: string;
  readonly expression: RuleExpression;
}

export interface RuleIntent {
  readonly commandType: string;
  readonly commandVersion: number;
  readonly payload: Readonly<Record<string, RuleExpression>>;
}

export interface RuleBudget {
  readonly maxFanout: number;
  readonly maxDepth: number;
  readonly cooldownMs: bigint;
}

export interface RuleDefinition {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly version: number;
  readonly trigger: RuleTrigger;
  readonly bindings: readonly RuleBinding[];
  readonly condition: RuleExpression | null;
  readonly intents: readonly RuleIntent[];
  readonly budget: RuleBudget;
}

export interface RuleCommandCatalogEntry {
  readonly type: string;
  readonly version: number;
}

export class RuleValidationError extends DomainValidationError {
  readonly code: string;
  constructor(path: string, message: string, code = "rule.invalid") {
    super(path, message);
    this.name = "RuleValidationError";
    this.code = code;
  }
}

function fail(path: string, message: string, code?: string): never {
  throw new RuleValidationError(path, message, code);
}

const MAX_TIME = 1n << 53n;

function exactRecord(
  value: unknown,
  path: string,
  keys: readonly string[],
): Record<string, unknown> {
  if (!isPlainRecord(value)) return fail(path, "expected a record", "rule.type");
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) fail(`${path}.${key}`, "unknown field", "rule.unknown-field");
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, "missing field", "rule.missing-field");
  }
  return value;
}

function intInRange(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    return fail(path, `expected an integer from ${min} to ${max}`, "rule.range");
  return value;
}

function bigintValue(value: unknown, path: string, min: bigint): bigint {
  if (typeof value !== "bigint") return fail(path, "expected a bigint", "rule.type");
  if (value < min) return fail(path, `expected at least ${min}n`, "rule.range");
  if (value > MAX_TIME) return fail(path, "exceeds 2^53", "rule.range");
  return value;
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128)
    return fail(path, "expected a non-empty string of at most 128 characters", "rule.type");
  return value;
}

function nullableId(value: unknown, path: string): string | null {
  return value === null ? null : text(value, path);
}

function oneOf<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value))
    return fail(path, `expected one of ${allowed.join(", ")}`, "rule.enum");
  return value as T;
}

const RULE_ID = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
const NAME = /^[a-z][A-Za-z0-9]*$/;
const KEY = /^[a-z][A-Za-z0-9_]*$/;

function parseTrigger(value: unknown, path: string): RuleTrigger {
  if (!isPlainRecord(value)) return fail(path, "expected a record", "rule.type");
  const kind = oneOf(value["kind"], `${path}.kind`, [
    "event",
    "schedule",
    "threshold",
    "geofence",
  ] as const);
  switch (kind) {
    case "event": {
      const r = exactRecord(value, path, ["kind", "eventType", "eventVersion"]);
      return {
        kind,
        eventType: text(r["eventType"], `${path}.eventType`),
        eventVersion: intInRange(
          r["eventVersion"],
          `${path}.eventVersion`,
          1,
          Number.MAX_SAFE_INTEGER,
        ),
      };
    }
    case "schedule": {
      const r = exactRecord(value, path, ["kind", "everyMs", "offsetMs"]);
      const everyMs = bigintValue(r["everyMs"], `${path}.everyMs`, 1n);
      const offsetMs = bigintValue(r["offsetMs"], `${path}.offsetMs`, 0n);
      if (offsetMs >= everyMs) fail(`${path}.offsetMs`, "must be below everyMs", "rule.range");
      return { kind, everyMs, offsetMs };
    }
    case "threshold": {
      const r = exactRecord(value, path, ["kind", "objectId", "quantity", "direction", "value"]);
      const objectId = nullableId(r["objectId"], `${path}.objectId`);
      const quantity = oneOf(r["quantity"], `${path}.quantity`, THRESHOLD_QUANTITIES);
      const direction = oneOf(r["direction"], `${path}.direction`, ["rising", "falling"] as const);
      const v = r["value"];
      if (typeof v !== "bigint") return fail(`${path}.value`, "expected a bigint", "rule.type");
      if (v < -MAX_TIME || v > MAX_TIME) fail(`${path}.value`, "out of range", "rule.range");
      return { kind, objectId, quantity, direction, value: v };
    }
    case "geofence": {
      const r = exactRecord(value, path, ["kind", "regionId", "transition", "objectId"]);
      return {
        kind,
        regionId: text(r["regionId"], `${path}.regionId`),
        transition: oneOf(r["transition"], `${path}.transition`, ["entered", "left"] as const),
        objectId: nullableId(r["objectId"], `${path}.objectId`),
      };
    }
  }
}

function triggerVariables(trigger: RuleTrigger): Map<string, RuleType> {
  const vars = new Map<string, RuleType>([["at", "integer"]]);
  switch (trigger.kind) {
    case "schedule":
      vars.set("occurrence", "integer");
      break;
    case "threshold":
      vars.set("subject", "string");
      vars.set("value", "integer");
      break;
    case "geofence":
      vars.set("subject", "string");
      break;
    case "event":
      break;
  }
  return vars;
}

interface ExprContext {
  readonly scope: ReadonlyMap<string, RuleType>;
  readonly trigger: RuleTrigger;
  nodes: number;
}

const BINARY_RULES: Record<string, { operands: RuleType | "same"; result: RuleType | "operand" }> =
  {
    add: { operands: "integer", result: "integer" },
    sub: { operands: "integer", result: "integer" },
    min: { operands: "integer", result: "integer" },
    max: { operands: "integer", result: "integer" },
    lt: { operands: "integer", result: "boolean" },
    le: { operands: "integer", result: "boolean" },
    gt: { operands: "integer", result: "boolean" },
    ge: { operands: "integer", result: "boolean" },
    eq: { operands: "same", result: "boolean" },
    ne: { operands: "same", result: "boolean" },
    and: { operands: "boolean", result: "boolean" },
    or: { operands: "boolean", result: "boolean" },
  };

function parseExpression(
  value: unknown,
  path: string,
  ctx: ExprContext,
  depth: number,
  laterNames: ReadonlySet<string>,
): { node: RuleExpression; type: RuleType } {
  if (!isPlainRecord(value)) return fail(path, "expected an expression record", "rule.type");
  if (depth > RULE_MAX_DEPTH) fail(path, `nesting exceeds ${RULE_MAX_DEPTH}`, "rule.depth");
  ctx.nodes += 1;
  if (ctx.nodes > RULE_MAX_NODES) fail(path, `rule exceeds ${RULE_MAX_NODES} nodes`, "rule.size");
  const op = value["op"];
  if (typeof op !== "string") return fail(`${path}.op`, "expected an operator", "rule.type");
  if (op === "literal") {
    const r = exactRecord(value, path, ["op", "type", "value"]);
    const type = oneOf(r["type"], `${path}.type`, ["integer", "string", "boolean"] as const);
    const v = r["value"];
    if (type === "integer") {
      if (typeof v !== "bigint") return fail(`${path}.value`, "expected a bigint", "rule.type");
      if (v < -MAX_TIME || v > MAX_TIME) fail(`${path}.value`, "out of range", "rule.range");
      return { node: { op: "literal", type, value: v }, type };
    }
    if (type === "string") {
      if (typeof v !== "string") return fail(`${path}.value`, "expected a string", "rule.type");
      return { node: { op: "literal", type, value: v }, type };
    }
    if (typeof v !== "boolean") return fail(`${path}.value`, "expected a boolean", "rule.type");
    return { node: { op: "literal", type, value: v }, type };
  }
  if (op === "variable") {
    const r = exactRecord(value, path, ["op", "name"]);
    const name = r["name"];
    if (typeof name !== "string") return fail(`${path}.name`, "expected a name", "rule.type");
    const type = ctx.scope.get(name);
    if (type === undefined) {
      return fail(
        path,
        laterNames.has(name) ? `binding ${name} is declared later` : `unknown variable ${name}`,
        "rule.reference",
      );
    }
    return { node: { op: "variable", name }, type };
  }
  if (op === "field") {
    const r = exactRecord(value, path, ["op", "name", "type"]);
    if (ctx.trigger.kind !== "event")
      return fail(path, "field access requires an event trigger", "rule.reference");
    const name = r["name"];
    if (typeof name !== "string" || !KEY.test(name))
      return fail(`${path}.name`, "expected a field name", "rule.type");
    const type = oneOf(r["type"], `${path}.type`, ["integer", "string", "boolean"] as const);
    return { node: { op: "field", name, type }, type };
  }
  if (op === "not") {
    const r = exactRecord(value, path, ["op", "operand"]);
    const inner = parseExpression(r["operand"], `${path}.operand`, ctx, depth + 1, laterNames);
    if (inner.type !== "boolean")
      return fail(`${path}.operand`, "expected a boolean operand", "rule.type-mismatch");
    return { node: { op: "not", operand: inner.node }, type: "boolean" };
  }
  if (Object.hasOwn(BINARY_RULES, op)) {
    const rule = BINARY_RULES[op]!;
    const r = exactRecord(value, path, ["op", "left", "right"]);
    const left = parseExpression(r["left"], `${path}.left`, ctx, depth + 1, laterNames);
    const right = parseExpression(r["right"], `${path}.right`, ctx, depth + 1, laterNames);
    if (rule.operands === "same") {
      if (right.type !== left.type)
        return fail(`${path}.right`, `expected ${left.type} operand`, "rule.type-mismatch");
    } else {
      if (left.type !== rule.operands)
        return fail(`${path}.left`, `expected ${rule.operands} operand`, "rule.type-mismatch");
      if (right.type !== rule.operands)
        return fail(`${path}.right`, `expected ${rule.operands} operand`, "rule.type-mismatch");
    }
    return {
      node: { op: op as "add", left: left.node, right: right.node },
      type: rule.result as RuleType,
    };
  }
  return fail(path, `unknown operator ${op}`, "rule.operator");
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

export function validateRuleDefinition(
  value: unknown,
  catalog: readonly RuleCommandCatalogEntry[],
  path = "rule",
): RuleDefinition {
  const r = exactRecord(value, path, [
    "schemaVersion",
    "id",
    "version",
    "trigger",
    "bindings",
    "condition",
    "intents",
    "budget",
  ]);
  if (r["schemaVersion"] !== RULE_SCHEMA_VERSION)
    fail(`${path}.schemaVersion`, `expected ${RULE_SCHEMA_VERSION}`, "rule.schema-version");
  const id = r["id"];
  if (typeof id !== "string" || id.length > 128 || !RULE_ID.test(id))
    fail(`${path}.id`, "expected a namespaced dotted identifier", "rule.type");
  const version = intInRange(r["version"], `${path}.version`, 1, Number.MAX_SAFE_INTEGER);
  const trigger = parseTrigger(r["trigger"], `${path}.trigger`);

  const budgetRecord = exactRecord(r["budget"], `${path}.budget`, [
    "maxFanout",
    "maxDepth",
    "cooldownMs",
  ]);
  const cooldownRaw = budgetRecord["cooldownMs"];
  const budget: RuleBudget = {
    maxFanout: intInRange(budgetRecord["maxFanout"], `${path}.budget.maxFanout`, 1, 64),
    maxDepth: intInRange(budgetRecord["maxDepth"], `${path}.budget.maxDepth`, 1, 8),
    cooldownMs: bigintValue(cooldownRaw, `${path}.budget.cooldownMs`, 0n),
  };

  const bindingsRaw = r["bindings"];
  if (!Array.isArray(bindingsRaw))
    return fail(`${path}.bindings`, "expected an array", "rule.type");
  if (bindingsRaw.length > RULE_MAX_BINDINGS)
    fail(`${path}.bindings`, `at most ${RULE_MAX_BINDINGS} bindings`, "rule.range");
  const bindingNames = bindingsRaw.map((b) =>
    isPlainRecord(b) && typeof b["name"] === "string" ? b["name"] : "",
  );

  const scope = triggerVariables(trigger);
  const ctx: ExprContext = { scope, trigger, nodes: 0 };
  const bindings: RuleBinding[] = [];
  bindingsRaw.forEach((raw, i) => {
    const bp = `${path}.bindings[${i}]`;
    const b = exactRecord(raw, bp, ["name", "expression"]);
    const name = b["name"];
    if (typeof name !== "string" || !NAME.test(name))
      fail(`${bp}.name`, "expected a lower-camel binding name", "rule.type");
    if (scope.has(name)) fail(`${bp}.name`, "name already in scope", "rule.duplicate");
    const later = new Set(bindingNames.slice(i + 1));
    const expr = parseExpression(b["expression"], `${bp}.expression`, ctx, 1, later);
    scope.set(name, expr.type);
    bindings.push({ name, expression: expr.node });
  });

  const noLater: ReadonlySet<string> = new Set();
  let condition: RuleExpression | null = null;
  if (r["condition"] !== null) {
    const c = parseExpression(r["condition"], `${path}.condition`, ctx, 1, noLater);
    if (c.type !== "boolean")
      fail(`${path}.condition`, "condition must be boolean", "rule.type-mismatch");
    condition = c.node;
  }

  const intentsRaw = r["intents"];
  if (!Array.isArray(intentsRaw)) return fail(`${path}.intents`, "expected an array", "rule.type");
  if (intentsRaw.length < 1) fail(`${path}.intents`, "expected at least one intent", "rule.range");
  if (intentsRaw.length > budget.maxFanout)
    fail(`${path}.intents`, `more intents than maxFanout ${budget.maxFanout}`, "rule.fanout");
  const intents: RuleIntent[] = intentsRaw.map((raw, i) => {
    const ip = `${path}.intents[${i}]`;
    const o = exactRecord(raw, ip, ["commandType", "commandVersion", "payload"]);
    const commandType = text(o["commandType"], `${ip}.commandType`);
    if (commandType === "resource.offer")
      fail(
        `${ip}.commandType`,
        "closed worlds require a transfer from existing inventory",
        "rule.closed-world",
      );
    const commandVersion = intInRange(
      o["commandVersion"],
      `${ip}.commandVersion`,
      1,
      Number.MAX_SAFE_INTEGER,
    );
    if (!catalog.some((c) => c.type === commandType && c.version === commandVersion))
      fail(
        `${ip}.commandType`,
        `${commandType}@${commandVersion} is not in the command catalog`,
        "rule.command",
      );
    const payloadRaw = o["payload"];
    if (!isPlainRecord(payloadRaw)) return fail(`${ip}.payload`, "expected a record", "rule.type");
    const payload: Record<string, RuleExpression> = {};
    for (const key of Object.keys(payloadRaw)) {
      if (!KEY.test(key)) fail(`${ip}.payload.${key}`, "invalid payload key", "rule.type");
      payload[key] = parseExpression(payloadRaw[key], `${ip}.payload.${key}`, ctx, 1, noLater).node;
    }
    return { commandType, commandVersion, payload };
  });

  return deepFreeze({
    schemaVersion: RULE_SCHEMA_VERSION,
    id,
    version,
    trigger,
    bindings,
    condition,
    intents,
    budget,
  });
}
