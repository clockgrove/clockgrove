import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkGitTreeSecrets, checkRepositorySecrets } from "../../scripts/check-secrets.mjs";

// Construct test values rather than committing secret-shaped bytes or exempting fixtures.
const credential = "ghp_" + "a".repeat(36);

describe("repository secret-value guard", () => {
  it("finds a credential in the committed tree, the index and untracked files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "clockgrove-secret-regression-"));
    try {
      execFileSync("git", ["init", "--quiet", root]);
      await writeFile(path.join(root, ".hidden"), credential);
      execFileSync("git", ["add", "--", ".hidden"], { cwd: root });
      const tree = execFileSync("git", ["write-tree"], { cwd: root }).toString().trim();
      expect(() => checkGitTreeSecrets(root, tree)).toThrow(
        ".hidden (committed tree): secret-shaped value detected",
      );
      await writeFile(path.join(root, ".hidden"), "safe replacement");
      await expect(checkRepositorySecrets(root)).rejects.toThrow(
        ".hidden (index): secret-shaped value detected",
      );
      execFileSync("git", ["add", "--", ".hidden"], { cwd: root });
      await checkRepositorySecrets(root);
      await writeFile(path.join(root, ".untracked"), "sk-" + "b".repeat(30));
      await expect(checkRepositorySecrets(root)).rejects.toThrow(
        ".untracked: secret-shaped value detected",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
