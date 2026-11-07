import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  assertPassingReceiptFacts,
  localRecoveryCommand,
  sameCommand,
} from "./canonical-commands.mjs";

import { nativeRecoveryReceipt } from "./native-recovery.mjs";

export const checklistItems = [
  "Repository layout and dependency rules are enforced.",
  "Toolchain and lockfile are reproducible from a clean checkout.",
  "Canonical commands are documented and noninteractive in CI.",
  "Branded IDs, execution context, command/event/attribution contracts are golden-tested.",
  "Kernel seam rejects ambient I/O/time/randomness.",
  "3D spatial and durable-ActorProcess pressure fixtures compile and validate.",
  "PostgreSQL migrations and command/event transaction skeleton pass duplicate/restart tests.",
  "Tenant isolation and provider-neutral authentication tests pass.",
  "Worker/DO composition route is deployed and correlated.",
  "Runtime-local state can be destroyed and rehydrated without changing canonical truth.",
  "Model/MCP/tool ports have deterministic test adapters and no mutation authority.",
  "Browser diagnostic shell has readiness, reconnect, renderer-neutral projection and text fallback.",
  "CI checks types, boundaries, contracts, migrations, security, supply chain and browser smoke tests.",
  "No secret/private deployment material exists in repository source.",
  "Development/staging/production environment and release-manifest contracts are defined.",
  "Clean Linux bootstrap and recovery qualification pass.",
  "Wave 0 evidence manifest is accepted before Wave 1 product work begins.",
];
const owners = [
  "W0-001",
  "W0-001",
  "W0-001",
  "W0-002",
  "W0-002",
  "W0-002",
  "W0-003",
  "W0-005",
  "W0-004",
  "W0-010",
  "W0-006",
  "W0-007",
  "W0-009",
  "W0-009",
  "W0-008",
  "W0-010",
  "W0-010",
];
export function checklist(candidate, execution, artifacts, results) {
  return checklistItems
    .map((item, index) => ({
      item,
      owner: owners[index],
      commit: candidate.commit,
      tree: candidate.tree,
      disposition: "pending",
      command: null,
      job: execution.provider === "github-actions" ? "Quality/quality" : null,
      artifact: null,
      digest: null,
      observed: null,
      pending:
        index === 8
          ? "Hosted correlated staging route"
          : index === 9
            ? "Current-candidate genuine native runtime-local storage loss; portable local/emulated recovery alone cannot qualify this item"
            : index === 12
              ? "Fresh exact published-head Quality/browser/artifact facts at final Objective review"
              : index === 16
                ? "Operator acceptance of full Wave 0 and independent exact-candidate focused review (needs-human); parent issue 311 remains open"
                : `Current-candidate focused capability evidence and acceptance for ${owners[index]}; historical commands alone are insufficient`,
    }))
    .map((entry) => {
      if (entry.item === checklistItems[9]) {
        const native = nativeRecoveryReceipt(candidate, artifacts, results);
        if (!native) return entry;
        return {
          ...entry,
          disposition: "passed",
          command: native.receipt.command,
          artifact: native.artifact.path,
          digest: native.artifact.digest,
          observed:
            "Native local Workers production authentication/DO adapters: actual persisted storage loss, complete unchanged PostgreSQL world/auth/Management rows, stable duplicate results and 1/1/1 counts. Hosted execution, successful Queue/webhook effects and whole-wave qualification remain pending.",
          pending: null,
        };
      }
      if (entry.item !== checklistItems[15]) return entry;
      const names = ["bootstrap.json", "local-recovery.json", "reproduction.json"];
      const proof = names.map((name) => artifacts.find((artifact) => artifact.path === name));
      const recovery = results.find((result) => sameCommand(result.command, localRecoveryCommand));
      if (recovery?.status === "passed") {
        assertPassingReceiptFacts(recovery, candidate, localRecoveryCommand);
        assert(
          artifacts.some(
            (artifact) =>
              artifact.path === "local-recovery.log" && artifact.digest === recovery.outputDigest,
          ),
          "recovery retained log digest mismatch",
        );
      }
      if (!candidate.clean || proof.some((value) => !value) || recovery?.status !== "passed")
        return {
          ...entry,
          pending:
            "Actual isolated disposal/bootstrap receipts, restored-history recovery and independent build comparison required; CI comparison and focused review remain pending",
        };
      return {
        ...entry,
        disposition: "passed",
        command: recovery.command,
        artifact: "local-recovery.json",
        digest: proof[1].digest,
        observed:
          "Named local capability only: isolated bootstrap/disposal, exact restored PostgreSQL history, portable local/emulated recovery, independent worker/web build inventories; external review and published CI comparison pending",
        pending: null,
      };
    });
}
export async function validateChecklist(manifest, root) {
  const plan = await readFile(
    path.join(root, "docs/waves/clockgrove-wave-0-project-foundation-implementation-plan.md"),
    "utf8",
  );
  const literal = plan
    .split("## 20. Exit checklist\n")[1]
    .split("\n---")[0]
    .match(/^- \[ \] (.+)$/gmu)
    .map((line) => line.slice(6));
  assert.deepEqual(literal, checklistItems, "literal section 20 checklist changed");
  assert.deepEqual(
    manifest.wave0Checklist.map((entry) => entry.item),
    checklistItems,
    "exactly one disposition per literal checklist item required",
  );
  for (const entry of manifest.wave0Checklist) {
    assert.equal(entry.commit, manifest.candidate.commit, "checklist commit mismatch");
    assert.equal(entry.tree, manifest.candidate.tree, "checklist tree mismatch");
    if (entry.disposition === "passed") {
      assert(
        entry.observed && !entry.pending && entry.command,
        "passed disposition requires observation and actual command",
      );
      assert(
        manifest.commands.some(
          (result) => result.status === "passed" && sameCommand(result.command, entry.command),
        ),
        "checklist command has no actual passing receipt",
      );
      assert(
        manifest.artifacts.some(
          (artifact) => artifact.path === entry.artifact && artifact.digest === entry.digest,
        ),
        "checklist safe artifact/hash missing",
      );
    } else assert(entry.pending && !entry.observed, "pending disposition requires named fact");
  }
  assert.deepEqual(
    manifest.wave0Checklist,
    checklist(manifest.candidate, manifest.execution, manifest.artifacts, manifest.commands),
    "checklist dispositions lack the current supported proof recipe",
  );
}
