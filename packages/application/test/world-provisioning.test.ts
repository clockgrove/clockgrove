import { canonicalSerialize } from "@clockgrove/kernel";
import { expect, it } from "vitest";

import { decodeCanonicalNode, encodeCanonicalNode } from "../src/index.js";

it("round-trips every canonical node tag and matches the kernel encoding exactly", () => {
  const value = { b: [1, "x", null, true], a: 10n, m: new Map([["k", 2]]), s: new Set([3]) };
  const node = encodeCanonicalNode(value);
  expect(JSON.stringify(node)).toBe(
    '["record",[["a",["bigint","10"]],["b",["array",[["integer","1"],["string","x"],["null"],["boolean",true]]]],["m",["map",[[["string","k"],["integer","2"]]]]],["s",["set",[["integer","3"]]]]]]',
  );
  expect(canonicalSerialize(decodeCanonicalNode(node))).toBe(canonicalSerialize(value));
});
