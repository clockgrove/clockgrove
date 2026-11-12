import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertNoSecretValues,
  checkGitTreeSecrets,
  checkRepositorySecrets,
} from "../../scripts/check-secrets.mjs";

// Construct test values rather than committing secret-shaped bytes or exempting fixtures.
const credential = "ghp_" + "a".repeat(36);

describe("repository secret-value guard", () => {
  it("classifies pinned scoped dependency versions without hiding credential bindings", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "clockgrove-dependency-regression-"));
    const packageName = ["@better-auth", "api-key"].join("/");
    const credentialField = ["pass", "word"].join("");
    const manifest = path.join(root, "package.json");
    try {
      execFileSync("git", ["init", "--quiet", root]);
      const groups = [
        "dependencies",
        "devDependencies",
        "optionalDependencies",
        "peerDependencies",
      ];
      const pinned = Object.fromEntries(
        groups.map((group) => [group, { [packageName]: "1.7.15" }]),
      );
      const valid = JSON.stringify(pinned, null, 2);
      await writeFile(manifest, valid);
      await checkRepositorySecrets(root);
      execFileSync("git", ["add", "--", "package.json"], { cwd: root });
      await checkRepositorySecrets(root);
      const tree = execFileSync("git", ["write-tree"], { cwd: root }).toString().trim();
      expect(() => checkGitTreeSecrets(root, tree)).not.toThrow();
      const refused = [
        JSON.stringify({ dependencies: { [packageName]: "private-material" } }),
        JSON.stringify({ dependencies: { [packageName]: "1.7.15-extra" } }),
        JSON.stringify({ dependencies: { [packageName]: "^1.7.15" } }),
        JSON.stringify({ dependencies: { [packageName]: credential } }),
        JSON.stringify({ dependencies: { [credentialField]: "1.7.15" } }),
        JSON.stringify({ ...pinned, [credentialField]: "private-material" }),
        JSON.stringify({ other: { [packageName]: "1.7.15" } }),
        JSON.stringify({ nested: { dependencies: { [packageName]: "1.7.15" } } }),
        JSON.stringify({ dependencies: [{ [packageName]: "1.7.15" }] }),
        valid.slice(0, -1),
        `{"dependencies":${JSON.stringify(pinned.dependencies)},"dependencies":{}}`,
      ];
      for (const source of refused) {
        await writeFile(manifest, source);
        await expect(checkRepositorySecrets(root)).rejects.toThrow(
          "package.json: secret-shaped value detected",
        );
      }
      await writeFile(manifest, valid);
      await writeFile(path.join(root, "other.json"), valid);
      await expect(checkRepositorySecrets(root)).rejects.toThrow(
        "other.json: secret-shaped value detected",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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

describe("error-code catalogs", () => {
  // better-auth's API-key plugin bundles a catalog like this one into the worker (issue 167). Entries are
  // built here, so this file never holds the scanned shape itself.
  const entry = (name, text) => `  ${name}: ${JSON.stringify(text)},`;
  const catalog = (...entries) =>
    `export const API_KEY_ERROR_CODES = {\n${entries.join("\n")}\n};\n`;

  it("accepts an API-key error code whose message is an English sentence", () => {
    const source = catalog(
      entry("INVALID_API_KEY", "Invalid API key."),
      entry("FAILED_TO_UPDATE_API_KEY", "Failed to update API key"),
      entry("INVALID_USER_ID_FROM_API_KEY", "The user id from the API key is invalid."),
    );
    expect(() => assertNoSecretValues(source, "worker/cloudflare-entry.js")).not.toThrow();
  });

  it("still refuses a token-shaped value under the same code", () => {
    const token = ["kQ9Zx", "P2mW7", "vR4tY", "6a8f3"].join("");
    const source = catalog(
      entry("INVALID_API_KEY", "Invalid API key."),
      entry("MISSING_API_KEY", token),
    );
    expect(() => assertNoSecretValues(source, "worker/cloudflare-entry.js")).toThrow(
      /secret-shaped value detected/u,
    );
  });

  it("still refuses a catalog value under a credential name or with fewer than three words", () => {
    for (const source of [
      catalog(
        entry("INVALID_API_KEY", "Invalid API key."),
        entry("STRIPE_API_KEY", "Live key for production"),
      ),
      catalog(entry("INVALID_API_KEY", "Invalid key")),
    ])
      expect(() => assertNoSecretValues(source, "worker/cloudflare-entry.js")).toThrow(
        /secret-shaped value detected/u,
      );
  });

  it("still refuses a sentence-shaped key outside a catalog", () => {
    const source = `const settings = {\n${entry("INVALID_API_KEY", "Invalid API key.")}\n  retries: 3,\n};\n`;
    expect(() => assertNoSecretValues(source, "settings.ts")).toThrow(
      /secret-shaped value detected/u,
    );
  });
});
