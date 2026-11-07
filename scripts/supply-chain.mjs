import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { checkRepositorySecrets } from "./check-secrets.mjs";

const allowedLicenses = new Set([
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "0BSD",
  "CC0-1.0",
  "CC-BY-4.0",
  "Python-2.0",
  "BlueOak-1.0.0",
  "Unlicense",
  "LGPL-3.0-or-later",
  "MPL-2.0",
]);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export async function checkDependencyPolicy(directory) {
  const manifests = ["package.json"];
  const { readdir } = await import("node:fs/promises");
  for (const parent of ["apps", "packages"]) {
    for (const entry of await readdir(path.join(directory, parent))) {
      const name = `${parent}/${entry}/package.json`;
      try {
        await readFile(path.join(directory, name));
        manifests.push(name);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
  for (const name of manifests) {
    const manifest = JSON.parse(await readFile(path.join(directory, name), "utf8"));
    for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
      for (const [dependency, version] of Object.entries(manifest[field] ?? {})) {
        assert(
          /^(?:workspace:\*|(?:npm:(?:@[^/]+\/)?[^@]+@)?\d+\.\d+\.\d+)$/u.test(version),
          `${name}: dependency policy requires exact stable version: ${dependency}`,
        );
      }
    }
  }
}
export function checkLicense(license, component) {
  assert(
    typeof license === "string" && license.length > 0,
    `${component}: missing dependency license`,
  );
  assert(licenseAllowed(license), `${component}: license outside allowlist: ${license}`);
}
// Evaluates an SPDX license expression (SPDX 2.3 Annex D) against the allowlist: OR is satisfied
// by any alternative, AND needs every operand, AND binds tighter than OR, parentheses group.
// `X WITH exception` is refused: the allowlist names no exceptions, so none is approved. Anything
// that does not parse (lowercase operators, unbalanced parentheses, prose) fails closed.
function licenseAllowed(license) {
  const tokens = license.match(/\(|\)|[^\s()]+/gu) ?? [];
  let at = 0;
  const or = () => {
    let allowed = and();
    while (tokens[at] === "OR") {
      at += 1;
      allowed = and() || allowed;
    }
    return allowed;
  };
  const and = () => {
    let allowed = term();
    while (tokens[at] === "AND") {
      at += 1;
      allowed = term() && allowed;
    }
    return allowed;
  };
  const term = () => {
    const token = tokens[at++];
    if (token === "(") {
      const allowed = or();
      if (tokens[at++] !== ")") throw new Error("unbalanced");
      return allowed;
    }
    if (token === undefined || token === ")" || spdxOperators.includes(token))
      throw new Error("operand expected");
    if (tokens[at] === "WITH") {
      at += 2;
      if (tokens[at - 1] === undefined) throw new Error("exception expected");
      return false;
    }
    return allowedLicenses.has(token);
  };
  try {
    return or() && at === tokens.length;
  } catch {
    return false;
  }
}
// The repository provenance inventory (parent plan §2.3, issue 845): every path that is not original
// Clockgrove work, with its source, SPDX license expression and reason. Third-party npm
// dependencies stay in the SBOM below, which `dependencies.producer` names.
const provenanceFile = "provenance.json";
const spdxOperators = ["AND", "OR", "WITH"];
// Identifiers joined by AND, OR or WITH; parentheses are not checked for balance.
function spdxExpression(license) {
  const tokens = license.replace(/[()]/gu, " ").split(/\s+/u).filter(Boolean);
  return (
    tokens.length % 2 === 1 &&
    tokens.every((token, index) =>
      index % 2
        ? spdxOperators.includes(token)
        : !spdxOperators.includes(token) && /^[A-Za-z0-9][A-Za-z0-9.+-]*$/u.test(token),
    )
  );
}

// Problems of `inventory`; `present(name)` says whether a repository-relative path is in the
// checkout (a file, or a directory holding one).
export function provenanceProblems(inventory, present) {
  const problems = [];
  const text = (value) => typeof value === "string" && value.trim().length > 0;
  const producer = inventory?.dependencies?.producer;
  if (!text(inventory?.dependencies?.inventory))
    problems.push(`${provenanceFile}: dependencies.inventory must name the SBOM`);
  if (!text(producer) || !present(producer))
    problems.push(`${provenanceFile}: dependencies.producer ${producer} is not in the checkout`);
  if (!Array.isArray(inventory?.entries)) {
    problems.push(`${provenanceFile}: entries must be a list, empty when nothing is reused`);
    return problems;
  }
  inventory.entries.forEach((entry, index) => {
    const at = `${provenanceFile}: entries[${index}]`;
    for (const field of ["path", "source", "license", "reason"])
      if (!text(entry?.[field])) problems.push(`${at}: missing ${field}`);
    const name = entry?.path;
    if (text(name)) {
      if (name !== path.posix.normalize(name) || /^(?:\/|\.\.?(?:\/|$))|\/$/u.test(name))
        problems.push(`${at}: ${name} is not a normalized repository-relative path`);
      else if (!present(name)) problems.push(`${at}: ${name} is not in the checkout`);
    }
    const license = entry?.license;
    if (text(license) && !spdxExpression(license))
      problems.push(`${at}: license ${license} is not an SPDX expression`);
  });
  return problems;
}

// Checks the inventory against the checkout: tracked or untracked, not ignored, and on disk.
export function checkProvenanceInventory(directory) {
  const listed = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: directory, maxBuffer: 32 * 1024 * 1024 },
  )
    .toString()
    .split("\0")
    .filter(Boolean);
  const present = (name) =>
    existsSync(path.join(directory, name)) &&
    listed.some((file) => file === name || file.startsWith(`${name}/`));
  const problems = provenanceProblems(
    JSON.parse(readFileSync(path.join(directory, provenanceFile), "utf8")),
    present,
  );
  if (problems.length) throw new Error(`provenance inventory:\n${problems.join("\n")}`);
}
const execute = promisify(execFile);
async function registry(url) {
  const result = await execute(
    "curl",
    ["--fail", "--silent", "--show-error", "--max-time", "60", "--retry", "2", url],
    { maxBuffer: 32 * 1024 * 1024 },
  );
  return JSON.parse(result.stdout);
}
export async function lockedComponents(directory) {
  const lock = await readFile(path.join(directory, "pnpm-lock.yaml"), "utf8");
  const section = lock.split("\npackages:\n").at(-1)?.split("\nsnapshots:\n")[0];
  assert(section, "workspace lockfile package inventory missing");
  const keys = [...section.matchAll(/^ {2}['"]?([^\s'"]+@[^\s'"]+)['"]?:\n/gmu)].map(
    (match) => match[1],
  );
  const components = [];
  for (let offset = 0; offset < keys.length; offset += 8) {
    const batch = await Promise.all(
      keys.slice(offset, offset + 8).map(async (key) => {
        const at = key.lastIndexOf("@");
        const name = key.slice(0, at);
        const version = key.slice(at + 1);
        const metadata = await registry(
          `https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`,
        );
        assert.equal(metadata.name, name);
        assert.equal(metadata.version, version);
        return {
          type: "library",
          "bom-ref": key,
          name,
          version,
          purl: `pkg:npm/${name.startsWith("@") ? `%40${name.slice(1)}` : name}@${version}`,
          licenses: metadata.license ? [{ expression: metadata.license }] : [],
        };
      }),
    );
    components.push(...batch);
  }
  assert(components.length > 0, "workspace dependency inventory is empty");
  return components;
}
export async function verifySupplyChain(directory = root, output = process.env.CI_EVIDENCE_DIR) {
  const failures = [];
  const run = async (name, operation) => {
    try {
      await operation();
      console.log(`${name}: passed`);
    } catch (error) {
      failures.push(name);
      console.error(`${name}: ${error.message}`);
    }
  };
  await run("dependency policy", () => checkDependencyPolicy(directory));
  await run("complete-tree secrets", () => checkRepositorySecrets(directory));
  await run("provenance inventory", () => checkProvenanceInventory(directory));
  await run("license allowlist and SBOM", async () => {
    const components = await lockedComponents(directory);
    const sbom = { bomFormat: "CycloneDX", specVersion: "1.6", version: 1, components };
    if (output) {
      await mkdir(output, { recursive: true });
      await writeFile(path.join(output, "sbom.json"), JSON.stringify(sbom, null, 2));
    }
    await run("license allowlist", async () => {
      const errors = [];
      for (const component of components) {
        try {
          checkLicense(component.licenses[0]?.expression, component["bom-ref"]);
        } catch (error) {
          errors.push(error.message);
        }
      }
      if (output)
        await writeFile(
          path.join(output, "licenses.json"),
          JSON.stringify({ allowed: [...allowedLicenses], errors }),
        );
      assert.equal(errors.length, 0, errors.join("; "));
    });
    const versions = {};
    for (const { name, version } of components) {
      versions[name] ??= [];
      versions[name].push(version);
    }
    const advisories = JSON.parse(
      execFileSync(
        "curl",
        [
          "--fail",
          "--silent",
          "--show-error",
          "--retry",
          "2",
          "--header",
          "Content-Type: application/json",
          "--data-binary",
          "@-",
          "https://registry.npmjs.org/-/npm/v1/security/advisories/bulk",
        ],
        { input: JSON.stringify(versions), maxBuffer: 32 * 1024 * 1024 },
      ).toString(),
    );
    if (output)
      await writeFile(
        path.join(output, "vulnerabilities.json"),
        JSON.stringify(advisories, null, 2),
      );
    assert.equal(
      Object.keys(advisories).length,
      0,
      "dependency vulnerability scan: advisories found; inspect vulnerabilities.json",
    );
    console.log(`dependency vulnerabilities: passed; ${components.length} locked components`);
  });
  if (output)
    await writeFile(
      path.join(output, "supply-chain.json"),
      JSON.stringify({
        failures,
        lockfileDigest: createHash("sha256")
          .update(await readFile(path.join(directory, "pnpm-lock.yaml")))
          .digest("hex"),
      }),
    );
  assert.equal(failures.length, 0, `supply-chain failures: ${failures.join(", ")}`);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await verifySupplyChain();
