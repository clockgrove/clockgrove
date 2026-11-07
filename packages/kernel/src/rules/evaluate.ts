import {
  currentWorldEventVersion,
  DomainValidationError,
  parseSpatialRegion,
  type RuleCommandCatalogEntry,
  type RuleDefinition,
  type RuleExpression,
  RuleValidationError,
  regionContains,
  type SpatialRegion,
  upcastEventRecord,
  validateRuleDefinition,
  type WorldState,
} from "@clockgrove/domain";

import { invalid, isRefusalSignal, type Refusal } from "../execute/refusal.js";
import { guardDomain } from "../spatial/boundary.js";
import { compareIds } from "../spatial/index-port.js";

export const RULE_INTENT_SCHEMA_VERSION = 1 as const;
/** Upper bound on firings traced by one evaluateRules call; the call stops at a group boundary. */
export const RULE_MAX_FIRINGS = 4096;

export type RuleValue = bigint | string | boolean;

export interface RuleTransitionEvent {
  readonly type: string;
  readonly schemaVersion: number;
  readonly simulationTime: bigint;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly [extra: string]: unknown;
}

export interface RuleTransition {
  readonly from: bigint;
  readonly to: bigint;
  readonly before: WorldState;
  readonly after: WorldState;
  readonly events: readonly RuleTransitionEvent[];
}

export interface RuleCooldownEntry {
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly lastFiredAt: bigint;
}

export interface EvaluateRulesInput {
  readonly rules: readonly unknown[];
  readonly catalog: readonly RuleCommandCatalogEntry[];
  readonly transition: RuleTransition;
  readonly cooldowns: readonly RuleCooldownEntry[];
  readonly depth: number;
  readonly continuation?: RuleContinuation;
  readonly holdEnd?: boolean;
  readonly heldGroup?: RuleHeldGroup;
}

export type RuleHeldGroup = {
  readonly schemaVersion: 1;
  readonly at: bigint;
  readonly schedules: boolean;
  readonly events: readonly RuleTransitionEvent[];
};

export interface RuleContinuation {
  readonly schemaVersion: 1;
  readonly evaluatedThrough: bigint;
}

export interface RuleCommandIntent {
  readonly schemaVersion: 1;
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly commandType: string;
  readonly commandVersion: number;
  readonly payload: Readonly<Record<string, RuleValue>>;
  readonly firedAt: bigint;
  readonly depth: number;
  readonly intentKey: string;
}

export const RULE_TRACE_OUTCOMES = Object.freeze([
  "emitted",
  "condition-false",
  "binding-failed",
  "fanout-exceeded",
  "depth-exceeded",
  "cooldown",
] as const);
export type RuleTraceOutcome = (typeof RULE_TRACE_OUTCOMES)[number];

export interface RuleTraceEntry {
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly firedAt: bigint;
  readonly outcome: RuleTraceOutcome;
}

export type EvaluateRulesResult = Readonly<
  {
    intents: readonly RuleCommandIntent[];
    trace: readonly RuleTraceEntry[];
    cooldowns: readonly RuleCooldownEntry[];
  } & (
    | { complete: true; heldGroup?: RuleHeldGroup }
    | { complete: false; continuation: RuleContinuation }
  )
>;

export type EvaluateRulesOutcome =
  | Readonly<{ ok: true; result: EvaluateRulesResult }>
  | Readonly<{ ok: false; error: Refusal }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The single integer convention: bigint unchanged, safe-integer number as the equal bigint. */
function normalizeInteger(value: unknown): bigint | undefined {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  return undefined;
}

function exact(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) return invalid(path);
  for (const key of Object.keys(value)) if (!keys.includes(key)) invalid(`${path}.${key}`);
  for (const key of keys) if (!Object.hasOwn(value, key)) invalid(`${path}.${key}`);
  return value;
}

function array(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) return invalid(path);
  return value;
}

function nonNegBigint(value: unknown, path: string): bigint {
  if (typeof value !== "bigint" || value < 0n) return invalid(path);
  return value;
}

function validateState(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) return invalid(path);
  array(value["entities"], `${path}.entities`);
  if (value["spatialRegions"] !== undefined)
    array(value["spatialRegions"], `${path}.spatialRegions`).forEach((region, index) => {
      const at = `${path}.spatialRegions[${index}]`;
      const checked = guardDomain(() => parseSpatialRegion(region, at));
      if (!checked.ok) invalid(checked.error.path === "input" ? at : checked.error.path);
    });
  return value;
}

interface Parsed {
  readonly rules: readonly RuleDefinition[];
  readonly transition: {
    readonly from: bigint;
    readonly to: bigint;
    readonly before: Record<string, unknown>;
    readonly after: Record<string, unknown>;
    readonly events: readonly RuleTransitionEvent[];
  };
  readonly cooldowns: readonly RuleCooldownEntry[];
  readonly depth: number;
  readonly continuation: RuleContinuation | undefined;
  readonly holdEnd: boolean;
  readonly heldGroup: RuleHeldGroup | undefined;
}

function parseEvent(
  raw: unknown,
  p: string,
  accept: (time: bigint) => boolean,
): RuleTransitionEvent {
  if (!isRecord(raw)) return invalid(p);
  if (typeof raw["type"] !== "string") invalid(`${p}.type`);
  const sv = raw["schemaVersion"];
  if (typeof sv !== "number" || !Number.isSafeInteger(sv) || sv < 1) invalid(`${p}.schemaVersion`);
  const time = raw["simulationTime"];
  if (typeof time !== "bigint" || !accept(time)) invalid(`${p}.simulationTime`);
  if (!isRecord(raw["payload"])) invalid(`${p}.payload`);
  return {
    ...raw,
    type: raw["type"],
    schemaVersion: sv,
    simulationTime: time,
    payload: raw["payload"],
  };
}

function parseInput(input: unknown): Parsed {
  const optional = ["continuation", "holdEnd", "heldGroup"] as const;
  let rootValue: unknown = input;
  const present: string[] = [];
  if (isRecord(input)) {
    for (const key of optional) {
      if (input[key] !== undefined) present.push(key);
      else if (Object.hasOwn(input, key))
        rootValue = omitKey(rootValue as Record<string, unknown>, key);
    }
  }
  const hasContinuation = present.includes("continuation");
  const root = exact(rootValue, "input", [
    "rules",
    "catalog",
    "transition",
    "cooldowns",
    "depth",
    ...present,
  ]);

  const catalogRaw = array(root["catalog"], "input.catalog");
  const catalog: RuleCommandCatalogEntry[] = catalogRaw.map((entry, i) => {
    const e = exact(entry, `input.catalog[${i}]`, ["type", "version"]);
    if (typeof e["type"] !== "string") invalid(`input.catalog[${i}].type`);
    if (typeof e["version"] !== "number" || !Number.isSafeInteger(e["version"]))
      invalid(`input.catalog[${i}].version`);
    return { type: e["type"], version: e["version"] };
  });

  const t = exact(root["transition"], "input.transition", [
    "from",
    "to",
    "before",
    "after",
    "events",
  ]);
  const from = nonNegBigint(t["from"], "input.transition.from");
  const to = nonNegBigint(t["to"], "input.transition.to");
  if (from > to) invalid("input.transition.from");
  const before = validateState(t["before"], "input.transition.before");
  const after = validateState(t["after"], "input.transition.after");
  const events = array(t["events"], "input.transition.events").map((raw, i) =>
    parseEvent(raw, `input.transition.events[${i}]`, (time) => time >= from && time <= to),
  );

  let holdEnd = false;
  if (present.includes("holdEnd")) {
    if (typeof root["holdEnd"] !== "boolean") invalid("input.holdEnd");
    holdEnd = root["holdEnd"] as boolean;
  }

  let heldGroup: RuleHeldGroup | undefined;
  if (present.includes("heldGroup")) {
    const h = exact(root["heldGroup"], "input.heldGroup", [
      "schemaVersion",
      "at",
      "schedules",
      "events",
    ]);
    if (h["schemaVersion"] !== 1) invalid("input.heldGroup.schemaVersion");
    if (typeof h["at"] !== "bigint" || h["at"] !== from) invalid("input.heldGroup.at");
    const at = h["at"];
    if (typeof h["schedules"] !== "boolean") invalid("input.heldGroup.schedules");
    const heldEvents = array(h["events"], "input.heldGroup.events").map((raw, i) =>
      parseEvent(raw, `input.heldGroup.events[${i}]`, (time) => time === at),
    );
    heldGroup = Object.freeze({
      schemaVersion: 1 as const,
      at,
      schedules: h["schedules"] as boolean,
      events: Object.freeze(heldEvents),
    });
  }

  let continuation: RuleContinuation | undefined;
  if (hasContinuation) {
    const c = exact(root["continuation"], "input.continuation", [
      "schemaVersion",
      "evaluatedThrough",
    ]);
    if (c["schemaVersion"] !== 1) invalid("input.continuation.schemaVersion");
    const through = c["evaluatedThrough"];
    if (typeof through !== "bigint" || through < from || through >= to)
      invalid("input.continuation.evaluatedThrough");
    continuation = Object.freeze({
      schemaVersion: 1 as const,
      evaluatedThrough: through as bigint,
    });
  }

  const depth = root["depth"];
  if (typeof depth !== "number" || !Number.isSafeInteger(depth) || depth < 0)
    invalid("input.depth");

  const cooldowns: RuleCooldownEntry[] = array(root["cooldowns"], "input.cooldowns").map(
    (raw, i) => {
      const p = `input.cooldowns[${i}]`;
      const e = exact(raw, p, ["ruleId", "ruleVersion", "lastFiredAt"]);
      if (typeof e["ruleId"] !== "string") invalid(`${p}.ruleId`);
      if (typeof e["ruleVersion"] !== "number" || !Number.isSafeInteger(e["ruleVersion"]))
        invalid(`${p}.ruleVersion`);
      return {
        ruleId: e["ruleId"],
        ruleVersion: e["ruleVersion"],
        lastFiredAt: nonNegBigint(e["lastFiredAt"], `${p}.lastFiredAt`),
      };
    },
  );
  for (let i = 1; i < cooldowns.length; i += 1) {
    const a = cooldowns[i - 1]!;
    const b = cooldowns[i]!;
    if (compareKey(a.ruleId, a.ruleVersion, b.ruleId, b.ruleVersion) >= 0)
      invalid(`input.cooldowns[${i}]`);
  }

  const rulesRaw = array(root["rules"], "input.rules");
  const seen = new Set<string>();
  const rules = rulesRaw.map((raw, i) => {
    let rule: RuleDefinition;
    try {
      rule = validateRuleDefinition(raw, catalog, "");
    } catch (error) {
      if (error instanceof RuleValidationError) return invalid(`input.rules[${i}]${error.path}`);
      throw error;
    }
    const key = `${rule.id}\u0000${rule.version}`;
    if (seen.has(key)) invalid(`input.rules[${i}]`);
    seen.add(key);
    return rule;
  });

  return {
    rules,
    transition: { from, to, before, after, events },
    cooldowns,
    depth,
    continuation,
    holdEnd,
    heldGroup,
  };
}

function omitKey(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const { [key]: _omitted, ...rest } = value;
  return rest;
}

function compareKey(aId: string, aVersion: number, bId: string, bVersion: number): number {
  return compareIds(aId, bId) || aVersion - bVersion;
}

// ---------------------------------------------------------------- expressions

class BindingFailed extends Error {}

type Env = Map<string, RuleValue>;

function evalExpr(
  expr: RuleExpression,
  env: Env,
  payload: Readonly<Record<string, unknown>> | null,
): RuleValue {
  switch (expr.op) {
    case "literal":
      return expr.value;
    case "variable": {
      const v = env.get(expr.name);
      if (v === undefined) throw new BindingFailed();
      return v;
    }
    case "field": {
      if (payload === null || !Object.hasOwn(payload, expr.name)) throw new BindingFailed();
      const v = payload[expr.name];
      if (expr.type === "integer") {
        const n = normalizeInteger(v);
        if (n === undefined) throw new BindingFailed();
        return n;
      }
      const ok = expr.type === "string" ? typeof v === "string" : typeof v === "boolean";
      if (!ok) throw new BindingFailed();
      return v as RuleValue;
    }
    case "not": {
      const v = evalExpr(expr.operand, env, payload);
      if (typeof v !== "boolean") throw new BindingFailed();
      return !v;
    }
    default: {
      const l = evalExpr(expr.left, env, payload);
      const r = evalExpr(expr.right, env, payload);
      if (expr.op === "eq") return l === r;
      if (expr.op === "ne") return l !== r;
      if (expr.op === "and" || expr.op === "or") {
        if (typeof l !== "boolean" || typeof r !== "boolean") throw new BindingFailed();
        return expr.op === "and" ? l && r : l || r;
      }
      if (typeof l !== "bigint" || typeof r !== "bigint") throw new BindingFailed();
      switch (expr.op) {
        case "add":
          return l + r;
        case "sub":
          return l - r;
        case "min":
          return l < r ? l : r;
        case "max":
          return l > r ? l : r;
        case "lt":
          return l < r;
        case "le":
          return l <= r;
        case "gt":
          return l > r;
        default:
          return l >= r;
      }
    }
  }
}

// ---------------------------------------------------------------- firings

interface Firing {
  readonly at: bigint;
  readonly variables: ReadonlyMap<string, RuleValue>;
  readonly payload: Readonly<Record<string, unknown>> | null;
}

function entityMap(state: Record<string, unknown>): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  for (const entity of state["entities"] as readonly unknown[]) {
    if (isRecord(entity) && typeof entity["objectId"] === "string")
      map.set(entity["objectId"], entity);
  }
  return map;
}

function quantityOf(entity: Record<string, unknown>, quantity: string): bigint | undefined {
  const [component, field] = quantity.split(".") as [string, string];
  const holder = entity[component];
  if (!isRecord(holder)) return undefined;
  return normalizeInteger(holder[field]);
}

function subjects(
  objectId: string | null,
  before: Map<string, Record<string, unknown>>,
  after: Map<string, Record<string, unknown>>,
): string[] {
  if (objectId !== null) return before.has(objectId) && after.has(objectId) ? [objectId] : [];
  return [...before.keys()].filter((id) => after.has(id)).sort(compareIds);
}

function findRegion(state: Record<string, unknown>, regionId: string): SpatialRegion | undefined {
  const regions = state["spatialRegions"];
  if (!Array.isArray(regions)) return undefined;
  return (regions as unknown[]).find(
    (r): r is SpatialRegion => isRecord(r) && r["regionId"] === regionId,
  );
}

function inside(region: SpatialRegion, entity: Record<string, unknown>): boolean | undefined {
  const pose = entity["pose"];
  if (!isRecord(pose) || pose["frameId"] !== region.frameId) return undefined;
  const coordinates = pose["coordinates"];
  if (!Array.isArray(coordinates) || coordinates.some((c) => typeof c !== "bigint"))
    return undefined;
  try {
    return regionContains(region, coordinates as bigint[]);
  } catch (error) {
    if (error instanceof DomainValidationError) return undefined;
    throw error;
  }
}

function firingsFor(rule: RuleDefinition, p: Parsed): Firing[] {
  const { to, before, after } = p.transition;
  const trigger = rule.trigger;
  const out: Firing[] = [];
  switch (trigger.kind) {
    case "event":
    case "schedule":
      return out;
    case "threshold": {
      const b = entityMap(before);
      const a = entityMap(after);
      for (const id of subjects(trigger.objectId, b, a)) {
        const bv = quantityOf(b.get(id)!, trigger.quantity);
        const av = quantityOf(a.get(id)!, trigger.quantity);
        if (bv === undefined || av === undefined) continue;
        const fires =
          trigger.direction === "rising"
            ? bv < trigger.value && av >= trigger.value
            : bv > trigger.value && av <= trigger.value;
        if (fires) {
          out.push({
            at: to,
            variables: new Map<string, RuleValue>([
              ["at", to],
              ["subject", id],
              ["value", av],
            ]),
            payload: null,
          });
        }
      }
      return out;
    }
    case "geofence": {
      const regionBefore = findRegion(before, trigger.regionId);
      const regionAfter = findRegion(after, trigger.regionId);
      if (regionBefore === undefined || regionAfter === undefined) return out;
      const b = entityMap(before);
      const a = entityMap(after);
      for (const id of subjects(trigger.objectId, b, a)) {
        const wasIn = inside(regionBefore, b.get(id)!);
        const isIn = inside(regionAfter, a.get(id)!);
        if (wasIn === undefined || isIn === undefined) continue;
        const fires = trigger.transition === "entered" ? !wasIn && isIn : wasIn && !isIn;
        if (fires) {
          out.push({
            at: to,
            variables: new Map<string, RuleValue>([
              ["at", to],
              ["subject", id],
            ]),
            payload: null,
          });
        }
      }
      return out;
    }
  }
}

// ---------------------------------------------------------------- evaluation

function ruleKey(rule: { id: string; version: number }): string {
  return `${rule.id}\u0000${rule.version}`;
}

/** Evaluates one rule's firings at one simulation time, threading cooldown through `lastBy`. */
function evaluateRule(
  rule: RuleDefinition,
  firings: readonly Firing[],
  depth: number,
  lastBy: Map<string, RuleCooldownEntry>,
  traceOut: RuleTraceEntry[],
  intentsOut: RuleCommandIntent[],
): void {
  if (firings.length === 0) return;
  const entry = (at: bigint, outcome: RuleTraceOutcome): RuleTraceEntry =>
    Object.freeze({ ruleId: rule.id, ruleVersion: rule.version, firedAt: at, outcome });

  if (depth >= rule.budget.maxDepth) {
    for (const f of firings) traceOut.push(entry(f.at, "depth-exceeded"));
    return;
  }

  const key = ruleKey(rule);
  const lastBefore = lastBy.get(key);
  const pending: RuleTraceEntry[] = [];
  const emitted: RuleCommandIntent[] = [];
  firings.forEach((firing, ordinal) => {
    const last = lastBy.get(key)?.lastFiredAt;
    if (last !== undefined && firing.at < last + rule.budget.cooldownMs) {
      pending.push(entry(firing.at, "cooldown"));
      return;
    }
    const env: Env = new Map(firing.variables);
    try {
      for (const binding of rule.bindings) {
        env.set(binding.name, evalExpr(binding.expression, env, firing.payload));
      }
      if (rule.condition !== null && evalExpr(rule.condition, env, firing.payload) !== true) {
        pending.push(entry(firing.at, "condition-false"));
        return;
      }
      const intents = rule.intents.map((intent, index) => {
        const payload: Record<string, RuleValue> = {};
        for (const key of Object.keys(intent.payload)) {
          payload[key] = evalExpr(intent.payload[key]!, env, firing.payload);
        }
        return Object.freeze({
          schemaVersion: RULE_INTENT_SCHEMA_VERSION,
          ruleId: rule.id,
          ruleVersion: rule.version,
          commandType: intent.commandType,
          commandVersion: intent.commandVersion,
          payload: Object.freeze(payload),
          firedAt: firing.at,
          depth: depth + 1,
          intentKey: `${rule.id}@${rule.version}/${firing.at}/${ordinal}/${index}`,
        });
      });
      emitted.push(...intents);
      pending.push(entry(firing.at, "emitted"));
      lastBy.set(
        key,
        Object.freeze({ ruleId: rule.id, ruleVersion: rule.version, lastFiredAt: firing.at }),
      );
    } catch (error) {
      if (!(error instanceof BindingFailed)) throw error;
      pending.push(entry(firing.at, "binding-failed"));
    }
  });

  if (emitted.length > rule.budget.maxFanout) {
    for (const t of pending) {
      traceOut.push(t.outcome === "emitted" ? entry(t.firedAt, "fanout-exceeded") : t);
    }
    if (lastBefore === undefined) lastBy.delete(key);
    else lastBy.set(key, lastBefore);
    return;
  }
  traceOut.push(...pending);
  intentsOut.push(...emitted);
}

function triggerVersion(trigger: {
  readonly eventType: string;
  readonly eventVersion: number;
}): number {
  return currentWorldEventVersion(trigger.eventType, trigger.eventVersion) ?? trigger.eventVersion;
}

function scheduleOccurrence(everyMs: bigint, offsetMs: bigint, after: bigint): bigint {
  const k = after < offsetMs ? 0n : (after - offsetMs) / everyMs + 1n;
  return offsetMs + k * everyMs;
}

function run(input: unknown): EvaluateRulesResult {
  const p = parseInput(input);
  const { from, to } = p.transition;
  const rules = [...p.rules].sort((a, b) => compareKey(a.id, a.version, b.id, b.version));
  const lastBy = new Map<string, RuleCooldownEntry>();
  for (const c of p.cooldowns) lastBy.set(`${c.ruleId}\u0000${c.ruleVersion}`, c);
  const through = p.continuation?.evaluatedThrough;

  // Events by time, and the sorted distinct event times.
  const hold = p.holdEnd;
  const held = p.heldGroup;
  const eventsByTime = new Map<bigint, RuleTransitionEvent[]>();
  // Events are read at their current version, as replay reads them; the transition keeps the originals.
  for (const event of [...(held?.events ?? []), ...p.transition.events].map(upcastEventRecord)) {
    const list = eventsByTime.get(event.simulationTime);
    if (list === undefined) eventsByTime.set(event.simulationTime, [event]);
    else list.push(event);
  }
  const eventTimes = [...eventsByTime.keys()]
    .filter((t) => !(hold && t === to))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  let eventIndex = 0;

  // Threshold and geofence firings exist only at `to`.
  const endpoint = new Map<string, Firing[]>();
  for (const rule of rules) {
    if (rule.trigger.kind === "threshold" || rule.trigger.kind === "geofence") {
      const f = firingsFor(rule, p);
      if (f.length > 0) endpoint.set(ruleKey(rule), f);
    }
  }

  const firingsAt = (rule: RuleDefinition, at: bigint): Firing[] => {
    const trigger = rule.trigger;
    switch (trigger.kind) {
      case "event":
        if (hold && at === to) return [];
        return (
          (eventsByTime.get(at) ?? [])
            // A trigger on a historic version names the current version it upcasts to.
            .filter(
              (e) => e.type === trigger.eventType && e.schemaVersion === triggerVersion(trigger),
            )
            .map((e) => ({
              at,
              variables: new Map<string, RuleValue>([["at", at]]),
              payload: e.payload,
            }))
        );
      case "schedule": {
        const { everyMs, offsetMs } = trigger;
        if (hold && at === to) return [];
        if (at < from || (at === from && held?.schedules !== true)) return [];
        if (at > to || at < offsetMs || (at - offsetMs) % everyMs !== 0n) return [];
        return [
          {
            at,
            variables: new Map<string, RuleValue>([
              ["at", at],
              ["occurrence", (at - offsetMs) / everyMs],
            ]),
            payload: null,
          },
        ];
      }
      default:
        return at === to ? (endpoint.get(ruleKey(rule)) ?? []) : [];
    }
  };

  let cursor: bigint | undefined = through;
  const nextTime = (): bigint | undefined => {
    let best: bigint | undefined;
    const consider = (t: bigint): void => {
      if (t <= to && (best === undefined || t < best)) best = t;
    };
    const considerSchedule = (t: bigint): void => {
      if (!(hold && t === to)) consider(t);
    };
    while (
      eventIndex < eventTimes.length &&
      cursor !== undefined &&
      eventTimes[eventIndex]! <= cursor
    )
      eventIndex += 1;
    if (eventIndex < eventTimes.length) consider(eventTimes[eventIndex]!);
    const bound = cursor ?? from;
    for (const rule of rules) {
      if (rule.trigger.kind === "schedule") {
        const { everyMs, offsetMs } = rule.trigger;
        considerSchedule(scheduleOccurrence(everyMs, offsetMs, bound));
        if (
          cursor === undefined &&
          held?.schedules === true &&
          from >= offsetMs &&
          (from - offsetMs) % everyMs === 0n
        )
          considerSchedule(from);
      }
    }
    if (endpoint.size > 0 && (cursor === undefined || to > cursor)) consider(to);
    return best;
  };

  const intents: RuleCommandIntent[] = [];
  const trace: RuleTraceEntry[] = [];
  let complete = true;
  let evaluatedThrough: bigint | undefined;
  for (;;) {
    const at = nextTime();
    if (at === undefined) break;
    const groups = rules.map((rule) => ({ rule, firings: firingsAt(rule, at) }));
    const size = groups.reduce((sum, g) => sum + g.firings.length, 0);
    if (size > RULE_MAX_FIRINGS) invalid("input.transition");
    if (trace.length + size > RULE_MAX_FIRINGS) {
      complete = false;
      break;
    }
    for (const g of groups) evaluateRule(g.rule, g.firings, p.depth, lastBy, trace, intents);
    cursor = at;
    if (size > 0) evaluatedThrough = at;
  }

  const cooldowns = [...lastBy.values()]
    .map((c) =>
      Object.freeze({ ruleId: c.ruleId, ruleVersion: c.ruleVersion, lastFiredAt: c.lastFiredAt }),
    )
    .sort((a, b) => compareKey(a.ruleId, a.ruleVersion, b.ruleId, b.ruleVersion));
  const base = {
    intents: Object.freeze(intents),
    trace: Object.freeze(trace),
    cooldowns: Object.freeze(cooldowns),
  };
  if (complete && hold) {
    const heldAtTo = held !== undefined && held.at === to ? held.events : [];
    const heldGroup: RuleHeldGroup = Object.freeze({
      schemaVersion: 1 as const,
      at: to,
      schedules: to > from ? true : from === to && held !== undefined ? held.schedules : false,
      events: Object.freeze([
        ...heldAtTo,
        ...p.transition.events.filter((e) => e.simulationTime === to),
      ]),
    });
    return Object.freeze({ ...base, heldGroup, complete: true as const });
  }
  if (complete) return Object.freeze({ ...base, complete: true as const });
  return Object.freeze({
    ...base,
    complete: false as const,
    continuation: Object.freeze({ schemaVersion: 1 as const, evaluatedThrough: evaluatedThrough! }),
  });
}

/**
 * Pure: executes nothing and returns typed intents within the rule budgets. Invalid caller input is
 * refused; any other error is an internal defect and propagates.
 */
export function evaluateRules(input: unknown): EvaluateRulesOutcome {
  try {
    return Object.freeze({ ok: true, result: run(input) });
  } catch (error) {
    if (isRefusalSignal(error)) return Object.freeze({ ok: false, error: error.refusal });
    throw error;
  }
}
