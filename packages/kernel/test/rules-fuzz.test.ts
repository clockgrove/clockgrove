import { RuleValidationError, validateRuleDefinition } from "@clockgrove/domain";
import { describe, expect, it } from "vitest";
import { canonicalSerialize } from "../src/canonical.js";
import { evaluateRules } from "../src/index.js";
import { drawNamedRandomStream, initializeNamedRandomStreams } from "../src/random.js";

// Fuzz of bounded rule ASTs (plan §9.1 Fuzz, §5.8), seeded like executor-fuzz-v1: only the named
// stream `fuzz` drives it. Each variant's refusal code and path follow from its fault and
// packages/domain/docs/rules.md; `expected` derives evaluations from packages/kernel/docs/rules.md.
const ruleFuzzSeed = { version: 1, seed: "rule-ast-fuzz-v1" } as const;
// biome-ignore lint: generated rules and their values are deliberately loose
type Loose = Record<string, any>;
type Fault = [code: string, path: string];
const LIMIT = 2n ** 53n;
const catalog = [{ type: "fuzz.notify", version: 1 }];
const TYPE: Loose = { bigint: "integer", string: "string", boolean: "boolean" };
const [TYPES, KIDS] = [Object.values(TYPE), ["operand", "left", "right"]];
const lit = (value: unknown, type = TYPE[typeof value]): Loose => ({ op: "literal", type, value });
const chain = (levels: number): Loose =>
  levels === 1 ? lit(true) : { op: "not", operand: chain(levels - 1) };
/** Each operator's operand type, result type and documented value. */
const OPS: Record<string, [string, string, Loose[string]]> = {
  add: ["integer", "integer", (l: bigint, r: bigint) => l + r],
  sub: ["integer", "integer", (l: bigint, r: bigint) => l - r],
  min: ["integer", "integer", (l: bigint, r: bigint) => (l < r ? l : r)],
  max: ["integer", "integer", (l: bigint, r: bigint) => (l > r ? l : r)],
  lt: ["integer", "boolean", (l: bigint, r: bigint) => l < r],
  le: ["integer", "boolean", (l: bigint, r: bigint) => l <= r],
  gt: ["integer", "boolean", (l: bigint, r: bigint) => l > r],
  ge: ["integer", "boolean", (l: bigint, r: bigint) => l >= r],
  eq: ["same", "boolean", (l: unknown, r: unknown) => l === r],
  ne: ["same", "boolean", (l: unknown, r: unknown) => l !== r],
  and: ["boolean", "boolean", (l: boolean, r: boolean) => l && r],
  or: ["boolean", "boolean", (l: boolean, r: boolean) => l || r],
  not: ["boolean", "boolean", (operand: boolean) => !operand],
};
const TRIGGERS: Loose[] = [
  { kind: "event", eventType: "fuzz.tick", eventVersion: 1 },
  { kind: "schedule", everyMs: LIMIT, offsetMs: 50n },
  { kind: "threshold", objectId: null, quantity: "needs.hunger", direction: "rising", value: 0n },
  { kind: "geofence", objectId: "obj-a", regionId: "zone", transition: "entered" },
];
/** The firings `transition` causes, by time group, with each trigger's documented variables. */
const PAYLOADS = [{ n: -LIMIT, s: "b", f: true }, { n: 4, s: "obj-a", f: false }, {}, { s: 1 }];
const FIRINGS: Record<string, Loose[][]> = {
  event: [[0], [1, 2], [3]].map((group) =>
    group.map((i) => ({ at: [0n, 10n, 10n, 100n][i], payload: PAYLOADS[i] })),
  ),
  schedule: [[{ at: 50n, occurrence: 0n }]],
  threshold: [["obj-a", "obj-b"].map((subject) => ({ at: 100n, subject, value: 0n }))],
  geofence: [[{ at: 100n, subject: "obj-a" }]],
};
const SQUARE = { kind: "rectangle", min: [0n, 0n], max: [9n, 9n] };
const world = (hunger: bigint, at: bigint) => ({
  entities: ["obj-a", "obj-b"].map((objectId) => {
    return { objectId, needs: { hunger }, pose: { frameId: "f", coordinates: [at, at] } };
  }),
  spatialRegions: [{ regionId: "zone", version: 1, frameId: "f", frameVersion: 1, shape: SQUARE }],
});
const events = FIRINGS.event!.flat().map(({ at, payload }) => {
  return { type: "fuzz.tick", schemaVersion: 1, simulationTime: at, payload };
});
const transition = { from: 0n, to: 100n, before: world(-1n, 20n), after: world(0n, 5n), events };

function stream() {
  let state = initializeNamedRandomStreams(ruleFuzzSeed, ["fuzz"]);
  return <T>(values: readonly T[]): T => {
    const drawn = drawNamedRandomStream(state, "fuzz");
    state = drawn.randomState;
    return values[Number((drawn.draw.rawValue + 2147483648n) >> 8n) % values.length]!;
  };
}
type Pick = ReturnType<typeof stream>;
const times = <T>(count: number, make: (i: number) => T): T[] => [...Array(count).keys()].map(make);

/** Each expression node with its path, in the documented pre-order. */
function nodes(rule: Loose): [string, Loose][] {
  const out: [string, Loose][] = [];
  const walk = (p: string, e: Loose): void => {
    out.push([p, e]);
    for (const key of KIDS) if (key in e) walk(`${p}.${key}`, e[key]);
  };
  for (const [i, { expression }] of rule.bindings.entries())
    walk(`rule.bindings[${i}].expression`, expression);
  if (rule.condition) walk("rule.condition", rule.condition);
  for (const [i, { payload }] of rule.intents.entries())
    for (const [k, e] of Object.entries<Loose>(payload)) walk(`rule.intents[${i}].payload.${k}`, e);
  return out;
}

/** A well-typed expression of `type` over `g.scope`; `g.grow` bounds the operators of one rule. */
function expr(g: Loose, type: string, level = 1): Loose {
  const sub = (t: string) => expr(g, t, level + 1);
  if (type !== "string" && level < 16 && g.grow()) {
    const op = g.pick(Object.keys(OPS).filter((key) => OPS[key]![1] === type));
    const t = OPS[op]![0] === "same" ? g.pick(TYPES) : OPS[op]![0];
    return op === "not" ? { op, operand: sub(t) } : { op, left: sub(t), right: sub(t) };
  }
  const vars = Object.keys(g.scope).filter((name) => g.scope[name] === type);
  const fields = g.event
    ? [{ op: "field", name: { integer: "n", string: "s" }[type] ?? "f", type }]
    : [];
  const literal = lit(
    g.pick([0n, LIMIT, -LIMIT, "b", "obj-a", true, false].filter((v) => TYPE[typeof v] === type)),
  );
  return g.pick([literal, ...vars.map((name) => ({ op: "variable", name })), ...fields]);
}

function validRule(pick: Pick, index: number): Loose {
  let operators = 100; // keeps a rule within 256 nodes, even beside a 16-level condition
  const trigger = pick(TRIGGERS);
  const variables = Object.entries(FIRINGS[trigger.kind]![0]![0]!);
  const scope = Object.fromEntries(variables.map(([name, v]) => [name, TYPE[typeof v]]));
  const grow = () => operators-- > 0 && pick([0, 1, 2, 3, 4]) < 2;
  const g = { pick, grow, scope, event: trigger.kind === "event" };
  const bindings = times(pick([0, 1, 2, 3]), (i) => {
    const [name, type] = [`b${i}`, pick(TYPES)];
    const expression = expr(g, type);
    scope[name] = type;
    return { name, expression };
  });
  const condition = pick([null, chain(16), expr(g, "boolean")]);
  const intents = times(pick([1, 2, 3]), () => {
    const payload = times(pick([0, 1, 2]), (k) => [`k${k}`, expr(g, pick(TYPES))]);
    return { commandType: "fuzz.notify", commandVersion: 1, payload: Object.fromEntries(payload) };
  });
  const cooldownMs = pick([0n, 10n, LIMIT]);
  const budget = { maxFanout: pick([intents.length, 64]), maxDepth: pick([1, 8]), cooldownMs };
  const id = `fuzz.r${index}`;
  const rule = { schemaVersion: 1, id, version: 1, trigger, bindings, condition, intents, budget };
  if (pick([0, 1]) === 0) pad(rule, 256);
  return rule;
}

/** Adds literal keys to the last intent until the rule has `total` nodes; returns the last key. */
function pad(rule: Loose, total: number): string {
  const payload = rule.intents.at(-1).payload;
  for (let n = nodes(rule).length; n < total; n += 1) payload[`z${n}`] = lit(1n);
  return `z${total - 1}`;
}
const set = (at: string, target: Loose, key: string, value: unknown, code: string): Fault => {
  target[key] = value;
  return [code, `${at}.${key}`];
};

/** One fault per variant; each returns the code and path the documented contract requires. */
const MUTATIONS: ((rule: Loose, pick: Pick) => Fault)[] = [
  (rule) => set("rule", rule, "extra", 1, "rule.unknown-field"),
  (rule) => set("rule.trigger", rule.trigger, "kind", "teleport", "rule.enum"),
  (rule, pick) => set("rule.budget", rule.budget, pick(["maxFanout", "maxDepth"]), 0, "rule.range"),
  (rule) => set("rule.budget", rule.budget, "cooldownMs", 1n + LIMIT, "rule.range"),
  (rule) => set("rule", rule, "intents", Array(rule.budget.maxFanout + 1).fill({}), "rule.fanout"),
  (rule) => set("rule.intents[0]", rule.intents[0], "commandType", "fuzz.other", "rule.command"),
  (rule) => ["rule.size", `rule.intents[${rule.intents.length - 1}].payload.${pad(rule, 257)}`],
  (rule) => {
    rule.condition = chain(17);
    return ["rule.depth", `rule.condition${".operand".repeat(16)}`];
  },
  (rule, pick) => {
    // A non-boolean condition, or an operator's wrong-typed operand (eq and ne: right after left).
    const [p, e] = pick([["rule", rule], ...nodes(rule).filter(([, n]) => n.op in OPS)]);
    const same = e.op === "eq" || e.op === "ne";
    if (same) e.left = lit("b");
    const key = e === rule ? "condition" : e.op === "not" ? "operand" : same ? "right" : "left";
    return set(p, e, key, OPS[e.op]?.[0] === "integer" ? lit(true) : lit(0n), "rule.type-mismatch");
  },
  (rule, pick) => {
    if (!nodes(rule).length) rule.condition = lit(true); // so that a node exists to fault
    const [p, node] = pick(nodes(rule));
    // A reference from an earlier binding to the last one, or to a name that is never in scope.
    const last = rule.bindings.length - 1;
    const earlier = Number(/^rule\.bindings\[(\d+)\]/.exec(p)?.[1] ?? last) < last;
    const [replacement, code, path] = pick<[Loose, ...Fault]>([
      [{ ...node, extra: 1 }, "rule.unknown-field", `${p}.extra`],
      [lit(1, "integer"), "rule.type", `${p}.value`],
      [lit(pick([LIMIT + 1n, -LIMIT - 1n])), "rule.range", `${p}.value`],
      [lit(1n, "float"), "rule.enum", `${p}.type`],
      [{ op: "mul" }, "rule.operator", p],
      [{ op: "variable" }, "rule.missing-field", `${p}.name`],
      [{ op: "variable", name: earlier ? `b${last}` : "never" }, "rule.reference", p],
    ]);
    for (const key of Object.keys(node)) delete node[key];
    Object.assign(node, replacement);
    return [code, path];
  },
];

/** The value packages/kernel/docs/rules.md gives `e`; a missing or mistyped field throws. */
function value(e: Loose, env: Loose): Loose[string] {
  if (e.op === "literal") return e.value;
  if (e.op === "variable") return env[e.name];
  const [op, v] = [OPS[e.op], env.payload?.[e.name]];
  if (op) return op[2](...KIDS.filter((key) => key in e).map((key) => value(e[key], env)));
  if (e.type === "integer" && Number.isSafeInteger(v)) return BigInt(v);
  if (TYPE[typeof v] === e.type) return v;
  throw new RangeError("binding-failed");
}

/** The trace and intents packages/kernel/docs/rules.md requires of `rule` at input `depth`. */
function expected(rule: Loose, depth: number): [Loose[], Loose[]] {
  const { maxFanout, maxDepth, cooldownMs } = rule.budget;
  const [trace, intents]: [Loose[], Loose[]] = [[], []];
  let last = -LIMIT; // no earlier firing: -2^53 + cooldownMs <= 0, so cooldown never applies
  for (const group of FIRINGS[rule.trigger.kind]!) {
    const [lastBefore, traced, emitted] = [last, trace.length, intents.length];
    for (let env of group) {
      const entry = [env.at, depth >= maxDepth ? "depth-exceeded" : "cooldown"];
      trace.push(entry);
      if (depth >= maxDepth || env.at < last + cooldownMs) continue;
      try {
        for (const b of rule.bindings) env = { ...env, [b.name]: value(b.expression, env) };
        entry[1] = "condition-false";
        if (rule.condition && !value(rule.condition, env)) continue;
        const payload = (i: Loose) =>
          Object.keys(i.payload).map((k) => [k, value(i.payload[k], env)]);
        intents.push(
          ...rule.intents.map((i: Loose) => [env.at, depth + 1, Object.fromEntries(payload(i))]),
        );
        [entry[1], last] = ["emitted", env.at];
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        entry[1] = "binding-failed";
      }
    }
    if (intents.length - emitted <= maxFanout) continue;
    [intents.length, last] = [emitted, lastBefore];
    for (const entry of trace.slice(traced))
      if (entry[1] === "emitted") entry[1] = "fanout-exceeded";
  }
  return [trace, intents];
}

function corpus() {
  const pick = stream();
  const valid = times(300, (index) => validRule(pick, index));
  const fault = (copy: Loose): [Loose, ...Fault] => [copy, ...pick(MUTATIONS)(copy, pick)];
  return { valid, invalid: valid.map((rule) => fault(structuredClone(rule))) };
}

describe(`rule AST fuzz (${ruleFuzzSeed.seed})`, () => {
  const { valid, invalid } = corpus();
  it("replays from its seed and reaches every declared bound and grammar form", () => {
    expect(canonicalSerialize(corpus())).toBe(canonicalSerialize({ valid, invalid }));
    const all = valid.flatMap((rule) => nodes(rule));
    const depth = Math.max(...all.map(([p]) => p.split(/\.(?:operand|left|right)/).length));
    const size = Math.max(...valid.map((rule) => nodes(rule).length));
    // 13 operators, 3 literal and 3 field types, the variables at, occurrence, subject, value and
    // b0-b2; 4 trigger kinds; 12 refusal codes.
    const forms = all.map(([, e]) => `${e.op} ${e.type ?? e.name ?? ""}`);
    const kinds = [forms, valid.map((rule) => rule.trigger.kind), invalid.map(([, code]) => code)];
    expect([size, depth, ...kinds.map((list) => new Set(list).size)]).toEqual([256, 16, 26, 4, 12]);
  });
  it("refuses every invalid AST with RuleValidationError at the faulted code and path", () => {
    for (const [rule, code, path] of invalid) {
      const validate = () => validateRuleDefinition(rule, catalog);
      expect(validate).toThrow(RuleValidationError);
      expect(validate).toThrow(expect.objectContaining({ code, path }));
    }
  });
  it("evaluates every valid AST as documented, identically on re-run", () => {
    const outcomes = new Set<string>();
    for (const rule of valid) {
      for (const depth of [rule.budget.maxDepth - 1, rule.budget.maxDepth]) {
        const run = () =>
          evaluateRules({ rules: [rule], catalog, transition, cooldowns: [], depth });
        const outcome = run();
        expect(canonicalSerialize(run())).toBe(canonicalSerialize(outcome));
        if (!outcome.ok) throw new Error(`${rule.id} refused at ${outcome.error.path}`);
        const { trace, intents, complete } = outcome.result;
        const traced = trace.map((t) => [t.firedAt, t.outcome]);
        const emitted = intents.map((i) => [i.firedAt, i.depth, i.payload]);
        expect([complete, traced, emitted]).toEqual([true, ...expected(rule, depth)]);
        for (const { outcome } of trace) outcomes.add(outcome);
      }
    }
    expect(outcomes.size).toBe(6); // every documented trace outcome occurs
  });
});
