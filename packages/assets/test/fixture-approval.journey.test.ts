import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { repositoryRoot } from "../src/index.js";

// #399: for the fixture world, `check` judges the `review.approver` of the visual-golden captures'
// approval record, tests/visual/approved-captures.json, against the root approvers.json. The test
// runs the CLI on a copy of the checkout so it can rewrite that record.
it("checks the fixture captures' approval record and refuses one without a recognised approver", {
  timeout: 120_000,
}, () => {
  const root = fs.mkdtempSync(join(tmpdir(), "fixture-approval-"));
  const assetPackage = join(root, "packages/assets");
  const captures = join(root, "tests/visual/approved-captures.json");
  try {
    for (const path of [
      "approvers.json",
      "tests/visual/approved-captures.json",
      "worlds/fixture",
      "packages/contracts/test/fixtures/asset-manifest",
      "packages/assets/src",
      "packages/assets/bin",
    ])
      fs.cpSync(join(repositoryRoot, path), join(root, path), { recursive: true });
    fs.writeFileSync(join(assetPackage, "package.json"), '{"type":"module"}');
    fs.symlinkSync(
      join(repositoryRoot, "packages/assets/node_modules"),
      join(assetPackage, "node_modules"),
    );
    const record = JSON.parse(fs.readFileSync(captures, "utf8"));
    const check = (approver: unknown) => {
      fs.writeFileSync(
        captures,
        JSON.stringify({ ...record, review: { ...record.review, approver } }),
      );
      return spawnSync(
        process.execPath,
        [join(assetPackage, "bin/clockgrove-assets.mjs"), "check"],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 60_000,
        },
      );
    };

    const delegated = {
      kind: "agent",
      agent: "Claude agent",
      delegation: "kirk-2026-11-16-fixture-goldens",
    };
    const passed = check(delegated);
    expect(passed.status, passed.stderr).toBe(0);

    for (const [approver, code] of [
      [undefined, "GOLDEN_APPROVER_REQUIRED"],
      [{ kind: "person", login: "renovate[bot]" }, "GOLDEN_REVIEWER_NOT_HUMAN"],
      [{ kind: "person", login: "someone" }, "GOLDEN_APPROVER_UNRECOGNISED"],
      [{ ...delegated, delegation: "no-such-delegation" }, "GOLDEN_DELEGATION_UNRECOGNISED"],
    ] as const) {
      const refused = check(approver);
      expect(refused.status, code).toBe(1);
      expect(refused.stderr).toContain(`${code}: tests/visual/approved-captures.json:`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
