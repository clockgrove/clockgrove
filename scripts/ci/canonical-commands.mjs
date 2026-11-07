import assert from "node:assert/strict";

export const canonicalCommands = [
  ["install", ["pnpm", "install", "--frozen-lockfile", "--ignore-scripts"]],
  ["check", ["pnpm", "check"]],
  ["test", ["pnpm", "test"]],
  ["test-db", ["pnpm", "run", "test:db"]],
  ["test-replay", ["pnpm", "run", "test:replay"]],
  ["db-verify", ["pnpm", "run", "db:verify"]],
  ["test-runtime", ["pnpm", "run", "test:runtime"]],
  ["verify-docs", ["pnpm", "run", "verify:docs"]],
  ["infra-validate", ["pnpm", "run", "infra:validate"]],
  ["supply-chain", ["pnpm", "run", "verify:supply-chain"]],
];

export const browserCommand = [
  "node",
  "node_modules/vitest/vitest.mjs",
  "run",
  "--config",
  "tests/ci/vitest.browser.config.ts",
];
export const localRecoveryCommand = [
  "node",
  "node_modules/vitest/vitest.mjs",
  "run",
  "--config",
  "apps/runtime/vitest.runtime.config.ts",
  "apps/runtime/test/runtime.postgres.test.ts",
  "-t",
  "crosses Worker",
];
export const nativeRecoveryCommand = [
  "node",
  "node_modules/vitest/vitest.mjs",
  "run",
  "--config",
  "apps/runtime/vitest.runtime.config.ts",
  "apps/runtime/test/native.postgres.test.ts",
];
export const commandRoles = {
  tests: ["test", "test-db", "test-replay", "test-runtime"],
  migrations: ["test-db", "db-verify"],
  security: ["check", "supply-chain"],
};
export const sameCommand = (left, right) =>
  Array.isArray(left) &&
  Array.isArray(right) &&
  left.length === right.length &&
  left.every((part, index) => part === right[index]);
// Pure observed facts; filesystem consumers separately authenticate the retained log bytes.
export function assertPassingReceiptFacts(receipt, candidate, command) {
  assert.equal(receipt.commit, candidate.commit, "passing receipt candidate mismatch");
  assert.equal(receipt.tree, candidate.tree, "passing receipt tree mismatch");
  assert.deepEqual(receipt.command, command, "passing receipt command mismatch");
  assert.equal(receipt.exitCode, 0, "passing receipt requires observed exit zero");
  assert.equal(receipt.status, "passed", "passing receipt outcome mismatch");
  assert.equal(receipt.signal, null, "passing receipt signal must be absent");
  assert.equal(receipt.errorCode, null, "passing receipt error must be absent");
  return receipt;
}
