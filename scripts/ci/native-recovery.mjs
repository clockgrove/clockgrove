import assert from "node:assert/strict";
import {
  assertPassingReceiptFacts,
  nativeRecoveryCommand,
  sameCommand,
} from "./canonical-commands.mjs";

export function validateNativeRecoveryProof(proof, candidate, lockfileDigest) {
  assert(proof && typeof proof === "object", "native recovery proof missing");
  assert(candidate.clean, "native recovery requires frozen clean candidate");
  assert.equal(proof.commit, candidate.commit, "native recovery candidate mismatch");
  assert.equal(proof.tree, candidate.tree, "native recovery tree mismatch");
  assert.equal(proof.surface, "native-local", "native recovery cannot prove hosted execution");
  assert.equal(proof.lockfileDigest, lockfileDigest, "native recovery lockfile mismatch");
  assert.deepEqual(
    proof.schemas,
    ["clockgrove", "clockgrove_auth", "clockgrove_management"],
    "complete canonical authority comparison required",
  );
  assert.equal(
    proof.comparison,
    "exact-all-world-auth-management-rows",
    "native recovery comparison scope mismatch",
  );
  for (const key of ["beforeDigest", "afterDigest", "bundleDigest"])
    assert(
      /^sha256:[a-f0-9]{64}$/u.test(proof[key]),
      "native recovery comparison identity missing",
    );
  assert.equal(
    proof.beforeDigest,
    proof.afterDigest,
    "native recovery canonical comparison changed",
  );
  assert.deepEqual(
    proof.tools,
    {
      node: "24.21.0",
      pnpm: "12.9.1",
      wrangler: "4.156.2",
      miniflare: "5.20261102.0-beta",
      workerdPackage: "1.20261102.1",
      workerd: "workerd 2026-11-02",
      postgres: proof.tools.postgres,
      pgvector: "0.8.7",
    },
    "native recovery unsupported runtime/tool identity",
  );
  assert(
    /\(PostgreSQL\) 18\.6(?:\s|$)/u.test(proof.tools.postgres),
    "native recovery PostgreSQL identity mismatch",
  );
  assert.deepEqual(
    proof.storageLoss,
    {
      persistedOwners: ["world", "space", "actor-agent"],
      persistedFiles: 3,
      removedFiles: 3,
      absentBeforeRestart: true,
    },
    "native recovery actual storage loss missing",
  );
  assert.equal(
    proof.duplicateCounts,
    "1|1|1|correlation-runtime",
    "native recovery duplicate outcome changed",
  );
  for (const fact of [
    "canonicalPreserved",
    "staleLocalReconciled",
    "missingReadyRouteRefused",
    "staleRequestEpochsRefused",
  ])
    assert.equal(proof[fact], true, `native recovery ${fact} missing`);
  assert.deepEqual(
    proof.pending,
    [
      "Actual missed/duplicate/reordered Queue or webhook effects",
      "Hosted qualification",
      "Independent exact-candidate review",
      "Full Wave 0 acceptance",
    ],
    "native recovery retained obligations changed",
  );
  assert.deepEqual(
    Object.keys(proof).sort(),
    [
      "commit",
      "tree",
      "surface",
      "lockfileDigest",
      "bundleDigest",
      "schemas",
      "tools",
      "storageLoss",
      "comparison",
      "beforeDigest",
      "afterDigest",
      "canonicalPreserved",
      "duplicateCounts",
      "staleLocalReconciled",
      "missingReadyRouteRefused",
      "staleRequestEpochsRefused",
      "pending",
    ].sort(),
    "unsupported native recovery claims",
  );
  return proof;
}

export function nativeRecoveryReceipt(candidate, artifacts, results) {
  const receipt = results.find((result) => sameCommand(result.command, nativeRecoveryCommand));
  const artifact = artifacts.find((artifact) => artifact.path === "native-recovery.json");
  if (receipt?.status !== "passed" || !artifact || !candidate.clean) return null;
  assertPassingReceiptFacts(receipt, candidate, nativeRecoveryCommand);
  assert(
    artifacts.some(
      (artifact) =>
        artifact.path === "native-recovery.log" && artifact.digest === receipt.outputDigest,
    ),
    "native recovery retained log mismatch",
  );
  return { receipt, artifact };
}
