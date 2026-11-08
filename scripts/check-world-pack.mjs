#!/usr/bin/env node
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const usage =
  "Usage: node scripts/check-world-pack.mjs --pack <pack-directory> --assets <asset-manifest-directory>";

let options;
try {
  const { values, tokens } = parseArgs({
    options: { pack: { type: "string" }, assets: { type: "string" } },
    strict: true,
    allowPositionals: false,
    tokens: true,
  });
  if (
    tokens.length !== 2 ||
    !values.pack ||
    !values.assets ||
    values.pack.startsWith("--") ||
    values.assets.startsWith("--")
  )
    throw new Error(usage);
  options = { pack: resolve(values.pack), assets: resolve(values.assets) };
  for (const directory of Object.values(options)) {
    if (!(await stat(directory)).isDirectory()) throw new Error(`Not a directory: ${directory}`);
  }
} catch (error) {
  console.error(`${error.message}\n${usage}`);
  process.exitCode = 2;
}

if (options && process.exitCode === undefined) {
  await import("../packages/simulator/cli/typescript-hooks.mjs");
  const { checkExternalPack } = await import("../packages/simulator/test/conformance/external.ts");
  const { ConformanceFailure } = await import("../packages/simulator/test/conformance/failure.ts");
  try {
    const reports = await checkExternalPack(options.pack, options.assets);
    console.info(JSON.stringify({ status: "ok", reports }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = error instanceof ConformanceFailure ? 1 : 70;
  }
}
