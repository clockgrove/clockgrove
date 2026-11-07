import { readFileSync } from "node:fs";
import { configDefaults, defineConfig } from "vitest/config";

// `pnpm test:db` runs the PostgreSQL files that scripts/database/test.mjs names, through this
// config. A bare `pnpm test:runtime` leaves exactly those files to it, so no file runs twice and a
// file test:db does not name still runs here. A run that names its files (test:db, the recovery
// journeys) excludes nothing. Such a run also runs its files in parallel: each file owns its
// disposable PostgreSQL cluster. Quality's test:runtime shards name the bare run's files with
// --no-file-parallelism, so they keep its serial order (scripts/ci/runtime-shards.mjs).
const databaseOwned = [
  ...readFileSync(new URL("../../scripts/database/test.mjs", import.meta.url), "utf8").matchAll(
    /"apps\/runtime\/(test\/[\w.-]+\.postgres\.test\.ts)"/gu,
  ),
].map((match) => match[1] as string);
if (databaseOwned.length === 0) throw new Error("scripts/database/test.mjs names no runtime files");
const namesFiles = process.argv.slice(2).some((argument) => argument.endsWith(".test.ts"));

export default defineConfig({
  root: import.meta.dirname,
  resolve: {
    alias: {
      "cloudflare:workers": `${import.meta.dirname}/test/cloudflare-native-fake.ts`,
      "cloudflare:workflows": `${import.meta.dirname}/test/cloudflare-native-fake.ts`,
    },
  },
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    expect: { poll: { timeout: 30_000 } },
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: [
      ...configDefaults.exclude,
      "test/**/*.long-run.test.ts",
      ...(namesFiles ? [] : databaseOwned),
    ],
    fileParallelism: namesFiles,
  },
});
