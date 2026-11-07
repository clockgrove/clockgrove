const productionSource =
  "^(?:apps|packages/(?!testkit(?:/|$))[^/]+/src(?:/|$)|tests/dependency-boundaries(?:/|$)|packages/(?:domain|kernel|world-pack-sdk)/test/negative-boundaries(?:/|$)|packages/simulator/test/negative-boundaries(?:/|$))";
const testkitSource = "^packages/testkit(?:/|$)";
const contractsSource = "^packages/contracts/src(?:/|$)";
const domainSource = "^packages/domain/src(?:/|$)";
const kernelSource = "^packages/kernel/src(?:/|$)";
const applicationSource = "^packages/application/src(?:/|$)";
const persistenceSource = "^packages/persistence/src(?:/|$)";
const applicationBoundarySource =
  "^(?:packages/application/src|tests/dependency-boundaries/forbidden-application-to-persistence\\.ts)(?:/|$)";
const persistenceBoundarySource =
  "^(?:packages/persistence/src|tests/dependency-boundaries/forbidden-persistence-outward\\.ts)(?:/|$)";
const domainBoundarySource = "^packages/domain/(?:src|test/negative-boundaries)(?:/|$)";
const kernelBoundarySource = "^packages/kernel/(?:src|test/negative-boundaries)(?:/|$)";
const worldPackSdkSource = "^packages/world-pack-sdk/src(?:/|$)";
const worldPackSdkBoundarySource =
  "^packages/world-pack-sdk/(?:src|test/negative-boundaries)(?:/|$)";
const simulatorSource = "^packages/simulator/src(?:/|$)";
const simulatorBoundarySource = "^packages/simulator/(?:src|test/negative-boundaries)(?:/|$)";
const cliSource =
  "^packages/simulator/(?:cli|test/negative-boundaries/forbidden-cli-imports\\.ts)(?:/|$)";
// Pure packages use only the public contracts entry: the trusted entrypoint and deep modules such as
// execution-context.ts (which exports the trusted brand and its cast) stay out of reach.
const contractsNonPublicModule = "^packages/contracts/src/(?!index\\.ts$)";
const ambientOrProviderModule =
  "^(?:node:|(?:fs|fs/promises|http|https|net|tls|dns|dgram|child_process|worker_threads|cluster|sqlite|crypto)$|cloudflare:|@cloudflare/|@anthropic-ai/|openai(?:/|$)|pg(?:/|$)|postgres(?:/|$)|@prisma/|drizzle-orm(?:/|$)|undici(?:/|$)|axios(?:/|$))";

// Only the declared pure schema package is an external domain dependency.
// Keep the package boundary explicit: lookalikes and other externals remain forbidden.
const domainZodDependency = "node_modules/(?:\\.pnpm/zod@4\\.6\\.6/node_modules/)?zod(?:/|$)";

export const forbidden = [
  {
    name: "random-upstream-confined-to-adapter",
    severity: "error",
    from: { pathNot: "^packages/kernel/src/random\\.ts$" },
    to: { path: "(?:^|node_modules/)pure-rand(?:/|$)" },
  },
  {
    name: "random-adapter-depends-only-inward",
    severity: "error",
    from: { path: "^packages/kernel/src/random\\.ts$" },
    to: {
      pathNot:
        "^packages/(?:contracts|domain|kernel)/src/|pure-rand/generator/xoroshiro128plus$|pure-rand/lib/esm/generator/xoroshiro128plus\\.js$",
    },
  },

  {
    name: "postgres-driver-confined-to-runtime-adapter",
    severity: "error",
    from: {
      path: "^(?:packages/|apps/runtime/src/)",
      pathNot:
        "^apps/runtime/src/(?:hyperdrive-postgres|cloudflare-entry|better-auth-adapter)\\.ts$",
    },
    to: { path: "(?:^|node_modules/)(?:postgres|pg)(?:/|$)|(?:^|/)hyperdrive-postgres\\.ts$" },
  },
  {
    name: "authentication-sdk-confined-to-runtime-adapter",
    severity: "error",
    from: {
      path: "^(?:packages/|apps/runtime/src/)",
      pathNot: "^apps/runtime/src/better-auth-adapter\\.ts$",
    },
    to: {
      path: "(?:^|node_modules/)(?:better-auth|@better-auth|kysely|kysely-postgres-js)(?:/|$)",
    },
  },
  {
    name: "renderer-libraries-confined-to-web",
    severity: "error",
    comment:
      "Runtime and shared packages never import React or Phaser (Wave 4 plan §5); they belong to apps/web.",
    from: {
      path: "^(?:apps/runtime|packages)/|^tests/dependency-boundaries/forbidden-renderer-libraries\\.ts$",
    },
    to: { path: "(?:^|node_modules/)(?:@types/)?(?:react|react-dom|phaser)(?:/|$)" },
  },
  {
    name: "no-production-to-testkit",
    severity: "error",
    comment: "Production packages must not depend on the deterministic testkit.",
    from: { path: productionSource },
    to: { path: testkitSource },
  },
  {
    name: "domain-depends-only-inward",
    severity: "error",
    comment:
      "Domain may import domain, shared contracts, and the declared pure Zod schema dependency.",
    from: { path: domainBoundarySource },
    to: {
      pathNot: `^(?:${contractsSource.slice(1)}|${domainSource.slice(1)}|${domainZodDependency})`,
    },
  },
  {
    name: "kernel-depends-only-inward",
    severity: "error",
    comment: "Kernel production code may import only kernel, domain, and shared contracts.",
    from: { path: kernelBoundarySource, pathNot: "^packages/kernel/src/random\\.ts$" },
    to: {
      pathNot: `^(?:${contractsSource.slice(1)}|${domainSource.slice(1)}|${kernelSource.slice(1)})`,
    },
  },
  {
    name: "domain-kernel-have-no-io-or-provider-imports",
    severity: "error",
    comment: "Pure domain and kernel code cannot import I/O, database, model, or provider APIs.",
    from: {
      path: `^(?:${domainBoundarySource.slice(1)}|${kernelBoundarySource.slice(1)}|${worldPackSdkBoundarySource.slice(1)}|${simulatorBoundarySource.slice(1)})`,
    },
    to: { path: ambientOrProviderModule },
  },
  {
    name: "simulator-depends-only-inward",
    severity: "error",
    comment:
      "The simulator may import only itself, shared contracts, domain, kernel, and the world-pack SDK.",
    from: { path: simulatorBoundarySource },
    to: {
      pathNot: `^(?:${contractsSource.slice(1)}|${domainSource.slice(1)}|${kernelSource.slice(1)}|${worldPackSdkSource.slice(1)}|${simulatorSource.slice(1)})`,
    },
  },
  {
    name: "cli-depends-only-inward",
    severity: "error",
    comment:
      "The simulator CLI may import itself, shared contracts, domain, kernel, the world-pack SDK, the simulator sources, Node built-ins and the pinned root Wrangler; never testkit, application, persistence or apps.",
    from: { path: cliSource },
    to: {
      dependencyTypesNot: ["core"],
      pathNot: [
        contractsSource,
        domainSource,
        kernelSource,
        worldPackSdkSource,
        simulatorSource,
        "^packages/simulator/cli(?:/|$)",
        "node_modules/wrangler(?:/|$)",
        "node_modules/\\.pnpm/wrangler@",
      ],
    },
  },
  {
    name: "pure-packages-cannot-mint-trusted-context",
    severity: "error",
    comment:
      "Only trusted gateway/application composition constructs or narrows a TrustedExecutionContext (Wave 0 plan §7.2); domain, kernel, the world-pack SDK and the simulator (src and cli) import only the public @clockgrove/contracts entry, never @clockgrove/contracts/trusted or a deep packages/contracts/src module.",
    from: {
      path: `^(?:${domainBoundarySource.slice(1)}|${kernelBoundarySource.slice(1)}|${worldPackSdkBoundarySource.slice(1)}|${simulatorBoundarySource.slice(1)}|${cliSource.slice(1)})`,
    },
    to: { path: contractsNonPublicModule },
  },
  {
    name: "world-pack-sdk-depends-only-inward",
    severity: "error",
    comment: "The world-pack SDK may import only itself, domain, and shared contracts.",
    from: { path: worldPackSdkBoundarySource },
    to: {
      pathNot: `^(?:${contractsSource.slice(1)}|${domainSource.slice(1)}|${worldPackSdkSource.slice(1)})`,
    },
  },
  {
    name: "application-defines-persistence-ports",
    severity: "error",
    comment: "Application owns inward ports and cannot import persistence adapters.",
    from: { path: applicationBoundarySource },
    to: { path: persistenceSource },
  },
  {
    name: "application-depends-only-inward",
    severity: "error",
    comment: "Application orchestration may depend only on inward project-owned layers.",
    from: { path: applicationBoundarySource },
    to: {
      pathNot: `^(?:${contractsSource.slice(1)}|${domainSource.slice(1)}|${kernelSource.slice(1)}|${applicationSource.slice(1)})`,
    },
  },
  {
    name: "persistence-points-inward",
    severity: "error",
    comment: "Persistence adapters may not depend on runtime composition or other outward layers.",
    from: { path: persistenceBoundarySource },
    to: { path: "^(?:apps|packages/(?!contracts|application|persistence)[^/]+)(?:/|$)" },
  },
  {
    name: "no-factory-dependencies",
    severity: "error",
    comment: "Factory is external development tooling, never a product or build dependency.",
    from: {},
    to: { path: "(?:^|node_modules/)(?:@clockgrove/)?factory(?:-rebuild)?(?:/|$)" },
  },
  {
    name: "contracts-have-no-outward-dependencies",
    severity: "error",
    comment: "Contracts are pure protocol vocabulary and may import only their own source files.",
    from: { path: contractsSource },
    to: { pathNot: contractsSource },
  },
];

export default {
  forbidden,
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: {
      path: "(?:^|/)node_modules/|^packages/(?:domain|kernel|world-pack-sdk)/test/negative-boundaries/|^packages/simulator/test/negative-boundaries/",
    },
    tsConfig: { fileName: "tsconfig.base.json" },
  },
};
