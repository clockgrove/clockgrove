import { createHash } from "node:crypto";

import { canonicalBytes } from "@clockgrove/kernel";
import { expect, it } from "vitest";

import { computePayloadHash } from "../src/index.js";

it("hashes a payload as sha256: plus the hex SHA-256 of its kernel canonical bytes", () => {
  const payload = { b: [1n, "x"], a: null };
  const hex = createHash("sha256").update(canonicalBytes(payload)).digest("hex");
  expect(computePayloadHash(payload)).toBe(`sha256:${hex}`);
  expect(computePayloadHash({})).toBe(
    "sha256:c397d9f7a00ce77b990575793037189e47e20f7a9189cc42c36f61136e4db3f8",
  );
});
