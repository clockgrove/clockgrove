import { describe, expect, it } from "vitest";

import { RuleValidationError, validateRuleDefinition } from "../../src/index.js";

// Committed packs only hold valid rules. This keeps the bounds that protect the kernel from a hostile
// pack: node count, nesting depth, integer literal range and binding order.

const catalog = [{ type: "world.move", version: 1 }];
const lit = (value: bigint) => ({ op: "literal", type: "integer", value });
const ref = (name: string) => ({ op: "variable", name });

function base(overrides: Record<string, unknown> = {}): Record<string, any> {
  return {
    schemaVersion: 1,
    id: "pack.rule-one",
    version: 1,
    trigger: { kind: "event", eventType: "needs.changed", eventVersion: 1 },
    bindings: [],
    condition: null,
    intents: [{ commandType: "world.move", commandVersion: 1, payload: { x: lit(1n) } }],
    budget: { maxFanout: 2, maxDepth: 3, cooldownMs: 0n },
    ...overrides,
  };
}

function refusal(input: unknown): { code: string; path: string } {
  try {
    validateRuleDefinition(input, catalog);
  } catch (error) {
    expect(error).toBeInstanceOf(RuleValidationError);
    return { code: (error as RuleValidationError).code, path: (error as RuleValidationError).path };
  }
  throw new Error("expected refusal");
}

function chain(levels: number): unknown {
  let node: unknown = { op: "literal", type: "boolean", value: true };
  for (let i = 1; i < levels; i++) node = { op: "not", operand: node };
  return node;
}

describe("rule definition bounds", () => {
  it("accepts 256 nodes and depth 16, refusing one more at the offending node", () => {
    const withNodes = (count: number) => {
      const payload: Record<string, unknown> = {};
      for (let i = 0; i < count - 1; i++) payload[`k${i}`] = lit(1n);
      return base({
        condition: { op: "literal", type: "boolean", value: true },
        intents: [{ commandType: "world.move", commandVersion: 1, payload }],
      });
    };
    expect(() => validateRuleDefinition(withNodes(256), catalog)).not.toThrow();
    expect(refusal(withNodes(257)).path).toMatch(/^rule\.intents\[0\]\.payload\.k/);
    expect(() => validateRuleDefinition(base({ condition: chain(16) }), catalog)).not.toThrow();
    expect(refusal(base({ condition: chain(17) })).path).toBe(
      `rule.condition${".operand".repeat(16)}`,
    );
  });

  it("accepts integer literals at exactly +/-2^53 and refuses one beyond", () => {
    const limit = 2n ** 53n;
    const cond = (right: bigint) =>
      base({ condition: { op: "lt", left: ref("at"), right: lit(right) } });
    for (const ok of [limit, -limit])
      expect(() => validateRuleDefinition(cond(ok), catalog)).not.toThrow();
    for (const bad of [limit + 1n, -limit - 1n])
      expect(refusal(cond(bad))).toEqual({
        code: "rule.range",
        path: "rule.condition.right.value",
      });
  });

  it("refuses unknown and later binding references", () => {
    expect(refusal(base({ bindings: [{ name: "a", expression: ref("nope") }] })).path).toBe(
      "rule.bindings[0].expression",
    );
    const later = base({
      bindings: [
        { name: "a", expression: { op: "add", left: lit(1n), right: ref("b") } },
        { name: "b", expression: lit(1n) },
      ],
    });
    expect(refusal(later).path).toBe("rule.bindings[0].expression.right");
  });
});
