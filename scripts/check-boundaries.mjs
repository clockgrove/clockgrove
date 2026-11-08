import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdir, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cruise } from "dependency-cruiser";
import ts from "typescript";
import { forbidden } from "../dependency-cruiser.config.mjs";
import { checkInfrastructure } from "../infra/check-configuration.mjs";
import { assertAuthProviderNeutral } from "./auth-boundaries.mjs";
import {
  assertCapabilityManifestNeutral,
  assertCapabilitySourceNeutral,
} from "./capability-boundaries.mjs";
import { checkBrowserTests } from "./check-browser-tests.mjs";
import { checkDocumentationLinks, documentationLinkProblems } from "./check-doc-links.mjs";
import {
  checkEnvironmentExamples,
  environmentExampleProblems,
  environmentExamples,
  runbookDescriptions,
} from "./check-env-examples.mjs";
import { checkFaultMatrix } from "./check-fault-matrix.mjs";
import { checkRetention } from "./check-retention.mjs";
import { checkRuntimeCommands } from "./check-runtime-commands.mjs";
import { checkRepositorySecrets } from "./check-secrets.mjs";
import { checkTestBudget } from "./check-test-budget.mjs";
import { checkTestTimeouts } from "./check-test-timeouts.mjs";
import { assertCloudflareBoundary } from "./cloudflare-boundaries.mjs";
import { checkContractDrift, contractBaseline } from "./contract-drift.mjs";
import { assertContractSteps } from "./database/contract-steps.mjs";
import {
  checkDependencyPolicy,
  checkProvenanceInventory,
  provenanceProblems,
} from "./supply-chain.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = "tests/dependency-boundaries/forbidden-product-to-testkit.ts";
const domainFixture = "packages/domain/test/negative-boundaries/forbidden-imports.ts";
const kernelFixture = "packages/kernel/test/negative-boundaries/forbidden-imports.ts";
const worldPackSdkFixture = "packages/world-pack-sdk/test/negative-boundaries/forbidden-imports.ts";
const simulatorFixture = "packages/simulator/test/negative-boundaries/forbidden-imports.ts";
const cliFixture = "packages/simulator/test/negative-boundaries/forbidden-cli-imports.ts";
const applicationFixture = "tests/dependency-boundaries/forbidden-application-to-persistence.ts";
const persistenceFixture = "tests/dependency-boundaries/forbidden-persistence-outward.ts";
const rendererFixture = "tests/dependency-boundaries/forbidden-renderer-libraries.ts";
const ambientFixture = "packages/kernel/test/negative-boundaries/ambient-globals.txt";
const factoryPackage = /^(?:@clockgrove\/)?factory(?:-rebuild)?$/u;
const dependencyFields = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

async function assertCompilerResolution() {
  const manifest = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
  assert.equal(manifest.devDependencies["@typescript/native"], "npm:typescript@7.0.2");
  assert.equal(manifest.devDependencies.typescript, "npm:@typescript/typescript6@6.0.2");
  const nativeRoot = path.dirname(
    fileURLToPath(import.meta.resolve("@typescript/native/package.json")),
  );
  const nativeManifest = JSON.parse(await readFile(path.join(nativeRoot, "package.json"), "utf8"));
  assert.equal(nativeManifest.name, "typescript");
  assert.equal(nativeManifest.version, "7.0.2");
  assert.deepEqual(Object.keys(nativeManifest.bin), ["tsc"]);
  const shimPath = path.join(repositoryRoot, "node_modules/.bin/tsc");
  const shim = await readFile(shimPath, "utf8");
  const target = shim.match(/^# cmd-shim-target=(.+)$/mu)?.[1];
  assert(target, "installed tsc shim must declare its executable target");
  assert.equal(
    await realpath(path.resolve(path.dirname(shimPath), target)),
    await realpath(path.resolve(nativeRoot, nativeManifest.bin.tsc)),
    "tsc must target the official native compiler",
  );
  const compiler = spawnSync(shimPath, ["--version"], { encoding: "utf8" });
  assert.equal(compiler.status, 0, compiler.stderr);
  assert.equal(compiler.stdout.trim(), "Version 7.0.2");
  const apiManifest = createRequire(import.meta.url)("typescript/package.json");
  assert.equal(apiManifest.name, "@typescript/typescript6");
  assert.equal(apiManifest.version, "6.0.2");
  assert.deepEqual(Object.keys(apiManifest.bin), ["tsc6"]);
  for (const consumer of [
    import.meta.url,
    new URL("../infra/check-configuration.mjs", import.meta.url),
    new URL("../tools/web-boundaries.mjs", import.meta.url),
    import.meta.resolve("dependency-cruiser"),
  ]) {
    const api = createRequire(consumer)("typescript");
    assert.equal(api, ts, `compiler API resolution differs for ${consumer}`);
    assert.equal(api.version, "6.0.3");
    for (const method of ["createSourceFile", "forEachChild", "transpileModule", "createProgram"])
      assert.equal(typeof api[method], "function", `${consumer}: missing compiler API ${method}`);
  }
  console.log("native tsc 7.0.2 target and shared compiler API 6.0.3 verified");
}

async function collectPackageManifests(directory) {
  const manifests = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return manifests;
    throw error;
  }

  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) manifests.push(...(await collectPackageManifests(entryPath)));
    if (entry.isFile() && entry.name === "package.json") manifests.push(entryPath);
  }
  return manifests;
}

async function assertNoFactoryDependencies() {
  const manifests = [
    path.join(repositoryRoot, "package.json"),
    ...(await collectPackageManifests(path.join(repositoryRoot, "apps"))),
    ...(await collectPackageManifests(path.join(repositoryRoot, "packages"))),
  ];

  for (const manifestPath of manifests) {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    for (const field of dependencyFields) {
      for (const dependency of Object.keys(manifest[field] ?? {})) {
        if (factoryPackage.test(dependency)) {
          throw new Error(
            `${path.relative(repositoryRoot, manifestPath)}: forbidden ${field} entry ${dependency}`,
          );
        }
      }
    }
  }
}

async function assertForbiddenFixtureIsRejected() {
  const result = await cruise(
    [fixture],
    {
      validate: true,
      ruleSet: { forbidden },
      tsConfig: { fileName: "tsconfig.base.json" },
    },
    undefined,
    undefined,
  );
  const violations = result.output.summary.violations;
  const expected = violations.some(
    (violation) => violation.rule.name === "no-production-to-testkit",
  );
  if (!expected) {
    throw new Error(`${fixture} was not rejected by the no-production-to-testkit rule`);
  }
}

async function assertPurePackageNegativeFixturesAreRejected() {
  const result = await cruise(
    [domainFixture, kernelFixture],
    {
      validate: true,
      ruleSet: { forbidden },
      tsConfig: { fileName: "tsconfig.base.json" },
    },
    undefined,
    undefined,
  );
  const ruleNames = new Set(
    result.output.summary.violations.map((violation) => violation.rule.name),
  );
  for (const expected of [
    "no-production-to-testkit",
    "domain-depends-only-inward",
    "kernel-depends-only-inward",
    "domain-kernel-have-no-io-or-provider-imports",
  ]) {
    if (!ruleNames.has(expected)) {
      throw new Error(`pure-package negative fixtures were not rejected by ${expected}`);
    }
  }
}

async function assertDomainZodExceptionIsNarrow() {
  const positive = "packages/domain/test/negative-boundaries/allowed-zod.ts";
  const external = "packages/domain/test/negative-boundaries/forbidden-schema-imports.ts";
  const kernelZod = "packages/kernel/test/negative-boundaries/forbidden-zod.ts";
  const result = await cruise(
    [positive, external, kernelZod, domainFixture, kernelFixture],
    {
      validate: true,
      ruleSet: { forbidden },
      doNotFollow: { path: "node_modules" },
      tsConfig: { fileName: "tsconfig.base.json" },
    },
    undefined,
    undefined,
  );
  const violations = result.output.summary.violations;
  const allowed = result.output.modules.find((module) => module.source === positive);
  assert.equal(allowed?.dependencies.length, 2, "both Zod imports must be inspected");
  for (const dependency of allowed.dependencies) {
    assert.equal(
      dependency.couldNotResolve,
      false,
      "Zod control must resolve the installed package",
    );
  }
  assert(
    !violations.some((violation) => violation.from === positive),
    "declared pure Zod imports must be allowed in domain",
  );
  for (const [from, target, rule] of [
    [external, /(?:^|\/)vitest(?:\/|$)/u, "domain-depends-only-inward"],
    [external, /^zod-extra$/u, "domain-depends-only-inward"],
    [external, /^@clockgrove\/factory$/u, "no-factory-dependencies"],
    [external, /^@clockgrove\/factory$/u, "domain-depends-only-inward"],
    [kernelZod, /(?:^|\/)zod(?:\/|$)/u, "kernel-depends-only-inward"],
    [domainFixture, /^packages\/kernel\/src\//u, "domain-depends-only-inward"],
    [domainFixture, /^packages\/testkit\/src\//u, "no-production-to-testkit"],
    [domainFixture, /^(?:node:)?fs$/u, "domain-kernel-have-no-io-or-provider-imports"],
    [kernelFixture, /^cloudflare:workers$/u, "domain-kernel-have-no-io-or-provider-imports"],
  ]) {
    assert(
      violations.some(
        (violation) =>
          violation.from === from && target.test(violation.to) && violation.rule.name === rule,
      ),
      `${from}: ${target} must be rejected by ${rule}`,
    );
  }
}

async function assertWorldPackSdkBoundaryIsNarrow() {
  const result = await cruise(
    [worldPackSdkFixture],
    {
      validate: true,
      ruleSet: { forbidden },
      doNotFollow: { path: "node_modules" },
      tsConfig: { fileName: "tsconfig.base.json" },
    },
    undefined,
    undefined,
  );
  const violations = result.output.summary.violations;
  for (const [target, rule] of [
    [/^packages\/kernel\/src\//u, "world-pack-sdk-depends-only-inward"],
    [/^packages\/testkit\/src\//u, "no-production-to-testkit"],
    [/^packages\/testkit\/src\//u, "world-pack-sdk-depends-only-inward"],
    [/^(?:node:)?fs$/u, "domain-kernel-have-no-io-or-provider-imports"],
  ]) {
    assert(
      violations.some(
        (violation) =>
          violation.from === worldPackSdkFixture &&
          target.test(violation.to) &&
          violation.rule.name === rule,
      ),
      `${worldPackSdkFixture}: ${target} must be rejected by ${rule}`,
    );
  }
}

async function assertSimulatorBoundaryIsNarrow() {
  const result = await cruise(
    [simulatorFixture],
    {
      validate: true,
      ruleSet: { forbidden },
      doNotFollow: { path: "node_modules" },
      tsConfig: { fileName: "tsconfig.base.json" },
    },
    undefined,
    undefined,
  );
  const violations = result.output.summary.violations;
  for (const [target, rule] of [
    [/^packages\/application\/src\//u, "simulator-depends-only-inward"],
    [/^packages\/testkit\/src\//u, "no-production-to-testkit"],
    [/^(?:node:)?fs$/u, "domain-kernel-have-no-io-or-provider-imports"],
  ]) {
    assert(
      violations.some(
        (violation) =>
          violation.from === simulatorFixture &&
          target.test(violation.to) &&
          violation.rule.name === rule,
      ),
      `${simulatorFixture}: ${target} must be rejected by ${rule}`,
    );
  }
}

async function assertCliBoundaryIsNarrow() {
  const result = await cruise(
    [cliFixture],
    {
      validate: true,
      ruleSet: { forbidden },
      doNotFollow: { path: "node_modules" },
      tsConfig: { fileName: "tsconfig.base.json" },
    },
    undefined,
    undefined,
  );
  const violations = result.output.summary.violations;
  for (const target of [
    /^packages\/testkit\/src\//u,
    /^packages\/application\/src\//u,
    /^packages\/persistence\/src\//u,
    /^apps\/runtime\/src\//u,
  ]) {
    assert(
      violations.some(
        (violation) =>
          violation.from === cliFixture &&
          target.test(violation.to) &&
          violation.rule.name === "cli-depends-only-inward",
      ),
      `${cliFixture}: ${target} must be rejected by cli-depends-only-inward`,
    );
  }
}

async function assertTrustedEntrypointIsConfined() {
  const rule = "pure-packages-cannot-mint-trusted-context";
  const trusted = "packages/contracts/src/trusted.ts";
  // Type-only imports are kept so a pure package cannot borrow the trusted brand with `import type`,
  // whether through the trusted entrypoint or a deep contracts module such as execution-context.ts.
  const result = await cruise(
    [
      "packages/domain/src",
      "packages/kernel/src",
      "packages/world-pack-sdk/src",
      "packages/simulator/src",
      "packages/simulator/cli",
      "apps/runtime/src",
      domainFixture,
      kernelFixture,
      worldPackSdkFixture,
      simulatorFixture,
      cliFixture,
    ],
    {
      validate: true,
      ruleSet: { forbidden },
      doNotFollow: { path: "node_modules" },
      tsPreCompilationDeps: true,
      tsConfig: { fileName: "tsconfig.base.json" },
    },
    undefined,
    undefined,
  );
  assert.deepEqual(
    result.output.summary.violations
      .filter((violation) => violation.rule.name === rule)
      .map((violation) => `${violation.from} -> ${violation.to}`)
      .sort(),
    [
      "packages/domain/test/negative-boundaries/forbidden-imports.ts -> packages/contracts/src/execution-context.ts",
      "packages/domain/test/negative-boundaries/forbidden-imports.ts -> packages/contracts/src/trusted.ts",
      "packages/kernel/test/negative-boundaries/forbidden-imports.ts -> packages/contracts/src/execution-context.ts",
      "packages/kernel/test/negative-boundaries/forbidden-imports.ts -> packages/contracts/src/trusted.ts",
      "packages/simulator/test/negative-boundaries/forbidden-cli-imports.ts -> packages/contracts/src/trusted.ts",
      "packages/simulator/test/negative-boundaries/forbidden-imports.ts -> packages/contracts/src/trusted.ts",
      "packages/world-pack-sdk/test/negative-boundaries/forbidden-imports.ts -> packages/contracts/src/trusted.ts",
    ],
    `exactly the pure-package negative fixtures' trusted and deep contracts imports must be rejected by ${rule}`,
  );
  const edge = (source, target = trusted) =>
    result.output.modules
      .find((module) => module.source === source)
      ?.dependencies.find((dependency) => dependency.resolved === target);
  assert.equal(
    edge(kernelFixture)?.dependencyTypes.includes("type-only"),
    true,
    `${kernelFixture} must reach the trusted entrypoint through a type-only import`,
  );
  assert.equal(
    edge(kernelFixture, "packages/contracts/src/execution-context.ts")?.dependencyTypes.includes(
      "type-only",
    ),
    true,
    `${kernelFixture} must reach execution-context.ts through a type-only import`,
  );
  assert.equal(
    edge("apps/runtime/src/trusted-composition.ts")?.dependencyTypes.includes("type-only"),
    false,
    "runtime composition must keep its value import of the trusted entrypoint",
  );
  const protocol = await readFile(
    path.join(repositoryRoot, "docs/protocols/shared-contracts.md"),
    "utf8",
  );
  assert(protocol.includes(`\`${rule}\``), `docs/protocols/shared-contracts.md must name ${rule}`);
}

async function assertContractsAreProviderNeutral() {
  const result = await cruise(
    ["packages/contracts/src"],
    {
      validate: true,
      ruleSet: { forbidden },
      tsConfig: { fileName: "tsconfig.base.json" },
    },
    undefined,
    undefined,
  );
  const violations = result.output.summary.violations.filter(
    (violation) => violation.rule.name === "contracts-have-no-outward-dependencies",
  );
  if (violations.length > 0) {
    throw new Error(
      "packages/contracts/src must not import I/O, provider, or other package authority",
    );
  }
}

async function assertAdapterDirectionNegativeFixturesAreRejected() {
  const result = await cruise(
    [applicationFixture, persistenceFixture],
    {
      validate: true,
      ruleSet: { forbidden },
      tsConfig: { fileName: "tsconfig.base.json" },
    },
    undefined,
    undefined,
  );
  const ruleNames = new Set(
    result.output.summary.violations.map((violation) => violation.rule.name),
  );
  for (const expected of [
    "application-defines-persistence-ports",
    "application-depends-only-inward",
    "persistence-points-inward",
  ]) {
    if (!ruleNames.has(expected)) {
      throw new Error(`adapter negative fixtures were not rejected by ${expected}`);
    }
  }
}

async function assertRendererLibrariesStayInWeb() {
  // The root depcruise run excludes node_modules, which drops resolved package edges; this one keeps
  // them (doNotFollow alone stops traversal) and adds apps/runtime and type-only imports.
  const rule = "renderer-libraries-confined-to-web";
  const result = await cruise(
    ["apps/runtime", "packages", rendererFixture],
    {
      validate: true,
      ruleSet: { forbidden },
      doNotFollow: { path: "node_modules" },
      tsPreCompilationDeps: true,
      tsConfig: { fileName: "tsconfig.base.json" },
    },
    undefined,
    undefined,
  );
  assert.deepEqual(
    result.output.summary.violations
      .filter((violation) => violation.rule.name === rule)
      .map(
        (violation) =>
          `${violation.from} -> ${violation.to.replace(/^node_modules\/\.pnpm\/[^/]+\/(node_modules\/(?:@types\/)?[^/]+\/).*$/u, "$1")}`,
      )
      .sort(),
    ["@types/react", "@types/three", "phaser", "react-dom", "three"].map(
      (target) => `${rendererFixture} -> node_modules/${target}/`,
    ),
    `exactly ${rendererFixture}'s imports must be rejected by ${rule}`,
  );
}

const ambientNondeterminism = [
  {
    name: "wall clock",
    pattern: /\b(?:Date\s*\.\s*now|new\s+Date\s*\(|performance\s*\.\s*now\s*\()/u,
  },
  {
    name: "process-global randomness",
    pattern: /\b(?:Math\s*\.\s*random|crypto\s*\.\s*(?:getRandomValues|randomUUID))\s*\(/u,
  },
  {
    name: "environment variables",
    pattern: /\b(?:process|Deno|Bun)\s*\.\s*env\b/u,
  },
  { name: "network fetch", pattern: /\bfetch\s*\(/u },
  {
    name: "network socket",
    pattern: /\b(?:WebSocket|WebSocketPair|XMLHttpRequest|EventSource)\s*\(/u,
  },
  {
    name: "ambient storage or filesystem",
    pattern:
      /\b(?:(?:localStorage|sessionStorage|indexedDB|caches)\s*\.|(?:Deno|Bun)\s*\.\s*(?:file|readFile|readTextFile|writeFile|writeTextFile)\s*\()/u,
  },
  { name: "ambient global", pattern: /\bglobalThis\s*\./u },
  { name: "dynamic import", pattern: /\bimport\s*\(/u },
];

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(entryPath)));
    if (entry.isFile() && /\.(?:[cm]?[jt]s|tsx)$/u.test(entry.name)) files.push(entryPath);
  }
  return files;
}

function detectedAmbientRules(source) {
  return ambientNondeterminism.filter(({ pattern }) => pattern.test(source));
}

async function assertPureSourcesHaveNoAmbientNondeterminism() {
  for (const packageName of ["domain", "kernel", "world-pack-sdk", "simulator"]) {
    const directory = path.join(repositoryRoot, "packages", packageName, "src");
    for (const sourcePath of await sourceFiles(directory)) {
      const source = await readFile(sourcePath, "utf8");
      const detections = detectedAmbientRules(source);
      if (detections.length > 0) {
        throw new Error(
          `${path.relative(repositoryRoot, sourcePath)}: forbidden ${detections
            .map(({ name }) => name)
            .join(", ")}`,
        );
      }
    }
  }
}

async function assertAmbientNegativeFixtureIsRejected() {
  const source = await readFile(path.join(repositoryRoot, ambientFixture), "utf8");
  const detected = new Set(detectedAmbientRules(source).map(({ name }) => name));
  for (const { name } of ambientNondeterminism.filter(({ name }) => name !== "dynamic import")) {
    if (!detected.has(name)) throw new Error(`${ambientFixture}: detector did not reject ${name}`);
  }
}

async function assertAuthenticationBoundaries() {
  const sdkModules = /^(?:better-auth|@better-auth\/[^/]+|kysely|kysely-postgres-js)(?:\/|$)/u;
  const adapterLocation = "apps/runtime/src/better-auth-adapter.ts";
  function assertReferenceAdapterBoundary(source, location) {
    if (location === adapterLocation) return;
    const file = ts.createSourceFile(location, source, ts.ScriptTarget.Latest, true);
    for (const reference of [...file.typeReferenceDirectives, ...file.referencedFiles]) {
      if (sdkModules.test(reference.fileName))
        throw new Error(`${location}: authentication SDK reference outside adapter`);
    }
    function visit(node) {
      if (
        (ts.isStringLiteralLike(node) && sdkModules.test(node.text)) ||
        (ts.isIdentifier(node) &&
          /^(?:BetterAuth\w*|DBAdapter|PostgresDialect|PostgresJSDialect)$/u.test(node.text))
      )
        throw new Error(`${location}: authentication SDK type or import outside adapter`);
      if (
        ts.isExportDeclaration(node) &&
        node.moduleSpecifier &&
        ts.isStringLiteralLike(node.moduleSpecifier) &&
        /(?:^|\/)better-auth-adapter(?:\.[cm]?[jt]s)?$/u.test(node.moduleSpecifier.text)
      )
        throw new Error(`${location}: authentication adapter re-export outside composition root`);
      ts.forEachChild(node, visit);
    }
    visit(file);
  }
  for (const directory of ["apps/runtime/src", "packages"]) {
    for (const sourcePath of await sourceFiles(path.join(repositoryRoot, directory))) {
      assertReferenceAdapterBoundary(
        await readFile(sourcePath, "utf8"),
        path.relative(repositoryRoot, sourcePath),
      );
    }
  }
  for (const manifestPath of await collectPackageManifests(path.join(repositoryRoot, "packages"))) {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    for (const field of dependencyFields) {
      for (const [name, version] of Object.entries(manifest[field] ?? {})) {
        if (sdkModules.test(name) || /^npm:(?:better-auth|@better-auth\/|kysely)/u.test(version))
          throw new Error(`${manifestPath}: authentication SDK dependency outside runtime adapter`);
      }
    }
  }
  for (const source of [
    'import type { User as Renamed } from "better-auth";',
    'type Renamed = import("better-auth").Session;',
    'const provider = await import("better-auth/minimal");',
    'const provider = require("@better-auth/core");',
    'import Renamed = require("better-auth");',
    'export * from "./better-auth-adapter.js";',
    '/// <reference types="better-auth" />',
    "type Renamed = BetterAuthOptions;",
  ]) {
    let rejected = false;
    try {
      assertReferenceAdapterBoundary(source, "packages/contracts/src/negative.ts");
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error("authentication SDK negative boundary fixture was accepted");
    assertReferenceAdapterBoundary(source, adapterLocation);
  }
  for (const packageName of ["contracts", "domain", "kernel"]) {
    for (const sourcePath of await sourceFiles(
      path.join(repositoryRoot, "packages", packageName, "src"),
    )) {
      assertAuthProviderNeutral(await readFile(sourcePath, "utf8"), sourcePath);
    }
  }
  for (const name of [
    "provider-subject.txt",
    "provider-type.txt",
    "provider-import.txt",
    "provider-subject-id.txt",
  ]) {
    const location = path.join(repositoryRoot, "tests/dependency-boundaries/authentication", name);
    const source = await readFile(location, "utf8");
    let rejected = false;
    try {
      assertAuthProviderNeutral(source, location);
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error(`${location}: authentication boundary fixture was not rejected`);
  }
  for (const sourcePath of await sourceFiles(path.join(repositoryRoot, "apps/runtime/src"))) {
    const source = await readFile(sourcePath, "utf8");
    if (
      /(?:from\s*|import\s*\(\s*|import\s*)["'][^"']*(?:test-auth|testkit|trusted-context|\/local\/)/u.test(
        source,
      )
    ) {
      throw new Error(`${sourcePath}: production runtime cannot import test authentication`);
    }
  }
}

async function assertDurableAuthorityComposition() {
  const readers = await readFile(
    path.join(repositoryRoot, "packages/persistence/src/authority-readers.ts"),
    "utf8",
  );
  const file = ts.createSourceFile("authority-readers.ts", readers, ts.ScriptTarget.Latest, true);
  function visit(node) {
    if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      assert(
        !/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP|GRANT|SECURITY DEFINER)\b/iu.test(
          node.text,
        ),
        "authority readers must not write or bypass schema authority",
      );
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert(
    readers.includes('"SET TRANSACTION READ ONLY"'),
    "authority lookups require read-only transactions",
  );
  assert(
    readers.includes("decodePrivacyCeiling"),
    "World authority must decode its privacy ceiling",
  );
  const entry = await readFile(
    path.join(repositoryRoot, "apps/runtime/src/cloudflare-entry.ts"),
    "utf8",
  );
  assert(
    entry.includes("defaultRuntimeComposition(env)"),
    "fresh isolates require default composition",
  );
  assert(
    !entry.includes("runtime composition has not been injected"),
    "deployed composition cannot require initialization",
  );
  const migrations = await readdir(path.join(repositoryRoot, "db/migrations"));
  const journal = JSON.parse(
    await readFile(path.join(repositoryRoot, "db/migrations/meta/_journal.json"), "utf8"),
  );
  assert.deepEqual(
    migrations.filter((name) => /^\d+.*\.sql$/u.test(name)).sort(),
    journal.entries.map((entry) => `${entry.tag}.sql`).sort(),
    "forward migration discovery/journal mismatch",
  );
  await assertContractSteps(
    path.join(repositoryRoot, "db/migrations"),
    migrations.filter((name) => /^\d+.*\.sql$/u.test(name)),
  );
}

async function assertCapabilityBoundaries() {
  for (const file of await sourceFiles(path.join(repositoryRoot, "packages/application/src"))) {
    assertCapabilitySourceNeutral(await readFile(file, "utf8"), file);
  }
  const manifestPath = path.join(repositoryRoot, "packages/application/package.json");
  assertCapabilityManifestNeutral(JSON.parse(await readFile(manifestPath, "utf8")), manifestPath);
  let aliasRejected = false;
  try {
    assertCapabilityManifestNeutral(
      { dependencies: { "@clockgrove/contracts": "npm:openai@0.0.0" } },
      "provider-alias",
    );
  } catch {
    aliasRejected = true;
  }
  if (!aliasRejected) throw new Error("provider SDK alias negative fixture was not rejected");
  const fixtureDirectory = path.join(repositoryRoot, "scripts/fixtures/capability-boundaries");
  for (const name of await readdir(fixtureDirectory)) {
    const source = await readFile(path.join(fixtureDirectory, name), "utf8");
    let rejected = false;
    try {
      assertCapabilitySourceNeutral(source, name);
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error(`${name}: provider boundary negative fixture was not rejected`);
  }
  for (const field of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "devDependencies",
  ]) {
    let rejected = false;
    try {
      assertCapabilityManifestNeutral({ [field]: { openai: "0.0.0" } }, field);
    } catch {
      rejected = true;
    }
    if (!rejected)
      throw new Error(`${field}: provider dependency negative fixture was not rejected`);
  }
}

async function assertCloudflareBoundaries() {
  const directories = ["apps/runtime/src"];
  for (const entry of await readdir(path.join(repositoryRoot, "packages"), {
    withFileTypes: true,
  })) {
    if (entry.isDirectory()) directories.push(`packages/${entry.name}`);
  }
  for (const directory of directories) {
    for (const file of await sourceFiles(path.join(repositoryRoot, directory))) {
      const location = path.relative(repositoryRoot, file);
      const source = await readFile(file, "utf8");
      if (location === kernelFixture) {
        let rejected = false;
        try {
          assertCloudflareBoundary(source, location);
        } catch {
          rejected = true;
        }
        if (!rejected)
          throw new Error(`${location}: committed Cloudflare fixture was not rejected`);
      } else {
        assertCloudflareBoundary(source, location);
      }
    }
  }
  const negativeSources = [
    'import type { DurableObjectState as State } from "cloudflare:workers";',
    'export type { WorkflowStep } from "./cloudflare-adapters.js";',
    'type Alias = import("@cloudflare/workers-types").Queue;',
    'import Native = require("cloudflare:workers");',
    'const provider = await import("cloudflare:workers");',
    'const provider = require("cloudflare:workers");',
    "interface DurableObjectNamespace<T> { get(id: string): T }",
    "type Input = MessageBatch<string>;",
    "type Event = WorkflowEvent<unknown>;",
    "type Step = WorkflowStep;",
    "interface Renamed { idFromName(name: string): unknown; get(id: unknown): unknown }",
    "interface ExecutionContext { waitUntil(task: Promise<unknown>): void }",
    "type Binding = QueueBinding;",
    "type State = CloudflareState;",
    'export * from "@clockgrove/runtime/cloudflare";',
    'export * from "./cloudflare-entry.js";',
    'declare module "cloudflare:workers" {}',
    '/// <reference types="@cloudflare/workers-types" />',
    '/// <reference path="./cloudflare-adapter-types.d.ts" />',
  ];
  for (const location of [
    "apps/runtime/src/worker.ts",
    "packages/application/src/port.ts",
    "packages/contracts/src/provider.ts",
  ]) {
    for (const source of negativeSources) {
      let rejected = false;
      try {
        assertCloudflareBoundary(source, location);
      } catch {
        rejected = true;
      }
      if (!rejected)
        throw new Error(`${location}: Cloudflare boundary regression was not rejected: ${source}`);
    }
    assertCloudflareBoundary("interface ExecutionContext { requestId: string }", location);
    assertCloudflareBoundary(
      "interface RuntimeLocalStorage { read(): Promise<unknown> } // DurableObjectState",
      location,
    );
  }
  for (const location of [
    "apps/runtime/src/cloudflare-entry.ts",
    "apps/runtime/src/cloudflare-adapters.ts",
    "apps/runtime/src/cloudflare-adapter-types.d.ts",
  ]) {
    for (const source of negativeSources) assertCloudflareBoundary(source, location);
  }
}

const postgresModules = /^(?:pg|postgres)(?:\/|$)|(?:^|\/)hyperdrive-postgres(?:\.[cm]?[jt]s)?$/u;
const postgresLocations = new Set([
  "apps/runtime/src/hyperdrive-postgres.ts",
  "apps/runtime/src/cloudflare-entry.ts",
  "apps/runtime/src/better-auth-adapter.ts",
]);

function assertPostgresBoundary(source, location) {
  if (postgresLocations.has(location)) return;
  const file = ts.createSourceFile(location, source, ts.ScriptTarget.Latest, true);
  for (const reference of [...file.typeReferenceDirectives, ...file.referencedFiles]) {
    if (postgresModules.test(reference.fileName))
      throw new Error(`${location}: PostgreSQL provider reference outside adapter`);
  }
  function visit(node) {
    if (
      (ts.isStringLiteralLike(node) && postgresModules.test(node.text)) ||
      (ts.isIdentifier(node) &&
        /^(?:Hyperdrive\w*|ReservedSql|PendingQuery|PostgresError)$/u.test(node.text))
    ) {
      throw new Error(`${location}: PostgreSQL driver or Hyperdrive type outside adapter`);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
}

async function assertPostgresBoundaries() {
  for (const manifestPath of await collectPackageManifests(path.join(repositoryRoot, "packages"))) {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    for (const field of dependencyFields) {
      for (const [name, version] of Object.entries(manifest[field] ?? {})) {
        if (/^(?:pg|postgres)(?:\/|$)/u.test(name) || /^npm:(?:pg|postgres)@/u.test(version)) {
          throw new Error(
            `${manifestPath}: PostgreSQL driver dependency belongs in the runtime adapter`,
          );
        }
      }
    }
  }
  for (const directory of ["apps/runtime/src", "packages"]) {
    for (const file of await sourceFiles(path.join(repositoryRoot, directory))) {
      assertPostgresBoundary(await readFile(file, "utf8"), path.relative(repositoryRoot, file));
    }
  }
  const negatives = [
    'import postgres from "postgres";',
    'export type { Sql } from "postgres";',
    'type Client = import("pg").Client;',
    'const driver = require("postgres");',
    'const driver = await import("postgres");',
    'import Driver = require("pg");',
    'export * from "./hyperdrive-postgres.js";',
    "type Binding = Hyperdrive;",
    "interface HyperdriveBinding { connectionString: string }",
    '/// <reference types="postgres" />',
  ];
  for (const location of [
    "apps/runtime/src/worker.ts",
    "packages/persistence/src/adapter.ts",
    "packages/testkit/src/fixture.ts",
  ]) {
    for (const source of negatives) {
      let rejected = false;
      try {
        assertPostgresBoundary(source, location);
      } catch {
        rejected = true;
      }
      if (!rejected) throw new Error(`${location}: PostgreSQL boundary negative fixture accepted`);
    }
  }
  for (const location of postgresLocations)
    for (const source of negatives) assertPostgresBoundary(source, location);
}

function assertRandomAdapterBoundary(source, location) {
  const file = ts.createSourceFile(location, source, ts.ScriptTarget.Latest, true);
  function visit(node) {
    if (ts.isStringLiteralLike(node) && /^(?:pure-rand)(?:\/|$)/u.test(node.text)) {
      assert.equal(
        location,
        "packages/kernel/src/random.ts",
        "random upstream belongs behind adapter",
      );
      assert(
        ts.isImportDeclaration(node.parent),
        "random upstream cannot be re-exported or dynamically accessed",
      );
      assert.equal(node.text, "pure-rand/generator/xoroshiro128plus");
      assert(!node.parent.importClause?.isTypeOnly, "upstream types are private");
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
}
async function assertRandomAdapterBoundaries() {
  for (const file of await sourceFiles(path.join(repositoryRoot, "packages"))) {
    assertRandomAdapterBoundary(await readFile(file, "utf8"), path.relative(repositoryRoot, file));
  }
  for (const source of [
    'import { xoroshiro128plus } from "pure-rand/generator/xoroshiro128plus";',
    'export * from "pure-rand/generator/xoroshiro128plus";',
    'type Alias = import("pure-rand/types/RandomGenerator").RandomGenerator;',
  ]) {
    assert.throws(() => assertRandomAdapterBoundary(source, "packages/domain/src/negative.ts"));
  }
  assert.throws(() =>
    assertRandomAdapterBoundary(
      'export * from "pure-rand/generator/xoroshiro128plus";',
      "packages/kernel/src/random.ts",
    ),
  );
}

function assertDocumentationLinkFixturesAreRejected() {
  const documents = new Map([
    [
      "docs/guide.md",
      [
        "# Guide",
        "",
        "See [the plan](plan.md#15-ci-and-supply-chain), [its second overview](plan.md#overview-2),",
        "[the command](plan.md#the-simulate-diff-a-b-command), [this guide](#guide), [docs](./)",
        "and [an external page](https://example.com/absent.md#nowhere).",
        "",
        "Headings: [a](plan.md#overview-1) [b](plan.md#_private-field) [c](plan.md#init-method)",
        "[d](plan.md#foo-_bar) [e](plan.md#a--b) [f](plan.md#foo--bar) [g](plan.md#quoted)",
        "[h](plan.md#listed) [i](plan.md#line-oneline-two) [j](plan.md#html-head) [k](plan.md?plain=1#L2)",
        "",
        "`[code span](absent.md)`",
        "",
        "```md",
        "[fenced](absent.md)",
        "```",
        "",
        "    [indented code](absent.md)",
        "",
        "[gone](absent.md), [moved](plan.md#removed-section) and [here](#nowhere).",
        "[a](plan.md#private-field) [b](plan.md#init_-method) [c](plan.md#a-amp-b) [d](plan.md#foo-bar)",
        "[e](plan.md?plain=1#L99)",
        "",
        "> [quoted reference][r]",
        ">",
        "> [r]: quoted-absent.md",
      ].join("\n"),
    ],
    [
      "docs/plan.md",
      [
        "# Plan",
        "",
        "## Overview 1",
        "",
        "## Overview",
        "",
        "## 15. CI and supply chain",
        "",
        "## The `simulate diff <a> <b>` command",
        "",
        "## Overview",
        "",
        "## _private field",
        "",
        "## __init__ method",
        "",
        "## foo \\_bar",
        "",
        "## A &amp; B",
        "",
        "## Foo ` bar`",
        "",
        "> ## Quoted",
        "",
        "- ## Listed",
        "",
        "line one",
        "line two",
        "---",
        "",
        "<h2>Html Head</h2>",
      ].join("\n"),
    ],
  ]);
  assert.deepEqual(
    documentationLinkProblems(new Set(documents.keys()), (file) => documents.get(file)),
    [
      'docs/guide.md:19: link "absent.md" points to docs/absent.md, which is not in the checkout',
      'docs/guide.md:19: link "plan.md#removed-section" names #removed-section, which matches no heading of docs/plan.md',
      'docs/guide.md:19: link "#nowhere" names #nowhere, which matches no heading of docs/guide.md',
      'docs/guide.md:20: link "plan.md#private-field" names #private-field, which matches no heading of docs/plan.md',
      'docs/guide.md:20: link "plan.md#init_-method" names #init_-method, which matches no heading of docs/plan.md',
      'docs/guide.md:20: link "plan.md#a-amp-b" names #a-amp-b, which matches no heading of docs/plan.md',
      'docs/guide.md:20: link "plan.md#foo-bar" names #foo-bar, which matches no heading of docs/plan.md',
      'docs/guide.md:21: link "plan.md?plain=1#L99" names #L99, which is not a line of docs/plan.md',
      'docs/guide.md:25: link "quoted-absent.md" points to docs/quoted-absent.md, which is not in the checkout',
    ],
    "documentation link check must refuse exactly the broken path and anchors of its fixture",
  );
}

function assertEnvironmentExampleFixturesAreRejected() {
  const expected = environmentExamples(
    { TOOL_ALPHA: "tools/alpha", WORKER_BRAVO: "runtime/bravo", WORKER_CHARLIE: "runtime/charlie" },
    ["WORKER_BRAVO", "WORKER_CHARLIE"],
    new Map([
      ["TOOL_ALPHA", "Alpha."],
      ["WORKER_BRAVO", "Bravo."],
      ["WORKER_CHARLIE", "Charlie."],
    ]),
  );
  const generated = (file) => expected.get(file).text;
  assert.deepEqual(environmentExampleProblems(expected, generated), []);
  const drifted = new Map([
    [".env.example", ["# operator", "TOOL_ALPHA=", "WORKER_BRAVO=", "TOOL_EXTRA="].join("\n")],
    [".dev.vars.example", ["# worker", "WORKER_CHARLIE=set", "not an entry"].join("\n")],
  ]);
  assert.deepEqual(
    environmentExampleProblems(expected, (file) => drifted.get(file)),
    [
      ".dev.vars.example:2: WORKER_CHARLIE has a value",
      ".dev.vars.example:3: neither a comment nor an empty NAME= entry",
      ".env.example: WORKER_BRAVO belongs in .dev.vars.example",
      ".env.example: TOOL_EXTRA is not in requiredSecrets",
    ],
    "example check must refuse exactly the value, malformed line, wrong file and extra name",
  );
  assert.deepEqual(
    environmentExampleProblems(expected, (file) =>
      file === ".env.example" ? undefined : generated(file).replace("WORKER_BRAVO=\n", ""),
    ),
    [".env.example: missing", ".dev.vars.example: WORKER_BRAVO is missing"],
    "example check must refuse a missing file and a missing name",
  );
  assert.deepEqual(
    environmentExampleProblems(expected, (file) => generated(file).replace("# runtime/", "# ")),
    [
      ".dev.vars.example: differs from the generated text; run node scripts/check-env-examples.mjs --write",
    ],
    "example check must refuse text that differs from the generated files",
  );
  const table = [
    "| Name | Consumer / source |",
    "| --- | --- |",
    "| `TOOL_ALPHA` | Alpha `a`; more. |",
  ];
  assert.deepEqual(
    [
      ...runbookDescriptions(
        [
          ...table,
          "",
          "| Variable | Meaning |",
          "| --- | --- |",
          "| `AUTH_ORIGIN` | Origin. |",
        ].join("\n"),
      ),
    ],
    [["TOOL_ALPHA", "Alpha a."]],
    "secret descriptions must come from the secret table only",
  );
  assert.throws(
    () => runbookDescriptions([...table, "| `TOOL_ALPHA` | Again. |"].join("\n")),
    /^Error: docs\/runbooks\/infrastructure\.md:4: secret table lists TOOL_ALPHA twice$/u,
    "secret table must refuse a duplicated name",
  );
}

function assertProvenanceInventoryFixturesAreRejected() {
  const files = ["scripts/supply-chain.mjs", "vendor/lib/index.js", "AGENTS.md"];
  const present = (name) => files.some((file) => file === name || file.startsWith(`${name}/`));
  const dependencies = { inventory: "sbom.json", producer: "scripts/supply-chain.mjs" };
  const entry = { path: "vendor/lib", source: "lib 1.0.0", license: "MIT", reason: "Vendored." };
  assert.deepEqual(provenanceProblems({ dependencies, entries: [] }, present), []);
  assert.deepEqual(
    provenanceProblems(
      {
        dependencies,
        entries: [entry, { ...entry, path: "AGENTS.md", license: "(MIT OR CC0-1.0)" }],
      },
      present,
    ),
    [],
  );
  assert.deepEqual(
    provenanceProblems(
      {
        dependencies,
        entries: [
          { ...entry, path: "vendor/removed.js" },
          { ...entry, source: " " },
          { path: "vendor/lib", reason: "Vendored." },
          { ...entry, license: "see upstream" },
          { ...entry, path: "../outside" },
          { ...entry, path: "vendor/lib/" },
        ],
      },
      present,
    ),
    [
      "provenance.json: entries[0]: vendor/removed.js is not in the checkout",
      "provenance.json: entries[1]: missing source",
      "provenance.json: entries[2]: missing source",
      "provenance.json: entries[2]: missing license",
      "provenance.json: entries[3]: license see upstream is not an SPDX expression",
      "provenance.json: entries[4]: ../outside is not a normalized repository-relative path",
      "provenance.json: entries[5]: vendor/lib/ is not a normalized repository-relative path",
    ],
    "provenance check must refuse exactly the missing path, source and license, the bad license and the bad paths",
  );
  assert.deepEqual(
    provenanceProblems({ dependencies: { producer: "scripts/removed.mjs" } }, present),
    [
      "provenance.json: dependencies.inventory must name the SBOM",
      "provenance.json: dependencies.producer scripts/removed.mjs is not in the checkout",
      "provenance.json: entries must be a list, empty when nothing is reused",
    ],
    "provenance check must refuse a missing SBOM pointer, a missing producer and missing entries",
  );
}

process.chdir(repositoryRoot);
await assertRandomAdapterBoundaries();
await assertCompilerResolution();
await checkDependencyPolicy(repositoryRoot);
await checkContractDrift(
  repositoryRoot,
  process.env.CONTRACT_BASE_COMMIT
    ? await contractBaseline(repositoryRoot, process.env.CONTRACT_BASE_COMMIT)
    : undefined,
);
await checkInfrastructure(repositoryRoot);
await checkTestBudget(repositoryRoot);
await checkRetention(repositoryRoot);
await checkFaultMatrix(repositoryRoot);
await checkRuntimeCommands(repositoryRoot);
await checkBrowserTests(repositoryRoot);
await checkTestTimeouts(repositoryRoot);
await checkRepositorySecrets(repositoryRoot);
assertDocumentationLinkFixturesAreRejected();
checkDocumentationLinks(repositoryRoot);
assertEnvironmentExampleFixturesAreRejected();
checkEnvironmentExamples(repositoryRoot);
assertProvenanceInventoryFixturesAreRejected();
checkProvenanceInventory(repositoryRoot);
await assertCloudflareBoundaries();
await assertPostgresBoundaries();
await assertAuthenticationBoundaries();
await assertDurableAuthorityComposition();
await assertCapabilityBoundaries();
await assertNoFactoryDependencies();
await assertForbiddenFixtureIsRejected();
await assertPurePackageNegativeFixturesAreRejected();
await assertDomainZodExceptionIsNarrow();
await assertWorldPackSdkBoundaryIsNarrow();
await assertSimulatorBoundaryIsNarrow();
await assertCliBoundaryIsNarrow();
await assertTrustedEntrypointIsConfined();
await assertContractsAreProviderNeutral();
await assertAdapterDirectionNegativeFixturesAreRejected();
await assertRendererLibrariesStayInWeb();
await assertPureSourcesHaveNoAmbientNondeterminism();
await assertAmbientNegativeFixtureIsRejected();
console.log("dependency boundaries and negative fixture verified");
